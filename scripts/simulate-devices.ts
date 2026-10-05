// DEV ONLY. Pretends to be one or more ESP32 units so the multi-pond UI can be exercised before real
// hardware is installed. Readings it produces are synthetic — never point it at a production broker.
//
//   npm run simulate:devices -- --device <deviceId>:<deviceSecret> [--device ...] [--interval 60]
//                               [--fault <parameter>=<status> ...] [--no-turbidity] [--turbidity <ntu>]
//                               [--temperature <°C>] [--no-ph] [--ph <pH>] [--ph-day <minutes>]
//                               [--spike <parameter>=<value>:<everyN> ...] [--dry-run <reports>]
//
// Each unit reports temperature, then turbidity, then pH — values and sensors keep that key order, which is signed
// bytes and mirrors firmware 0.7.0.
//
// Temperature drifts 18..37 °C across the BFAR lines; `--temperature <°C>` pins it (-5..60, the ingest bounds) to
// step through the bands on demand (e.g. 25 normal, 32 WARNING, 37 CRITICAL).
//
// Turbidity drifts 0..60 NTU (0.1 NTU steps) across the 25 NTU safe line so a WARNING episode can be demoed.
// `--turbidity <ntu>` pins it (0..3000, the firmware's clamp range) to demo a spike (e.g. 400) or the 3000 NTU
// ceiling. `--no-turbidity` drops the turbidity value and its sensors key, like firmware older than 0.4.0.
//
// pH follows a compressed daily curve: dawn low about 6.2, afternoon high about 9.8, one "day" every `--ph-day`
// minutes (default 40), plus a little noise, 0.01 steps. Each unit starts at a different point of the day. 40 min is
// the shortest day that demos the whole story in one cycle: the in-range stretch between the acidic and the
// alkaline excursion (about 12.6 min) must outlast the 10-min recovery (ALERT_RECOVERY_MS), or the acidic alert
// never resolves and the alkaline excursion just continues it; 30 min leaves 9.4 min and fails. Keep --interval at
// or under 90 s (ALERT_HOLD_MAX_GAP_MS): a longer gap breaks every held run and no pH/turbidity alert ever opens.
// The script warns at startup when the interval or the day length can't produce both alerts.
// `--ph <pH>` pins pH (0..14, PARAMETER_BOUNDS) instead of following the curve. `--no-ph` drops the pH value and
// its sensors key.
//
// Firmware version (D-17), sent as firmwareVersion:
//   - pH reported (the default, a pinned --ph, or a faulted pH)  -> "0.7.0"
//   - --no-ph                                                     -> "0.6.1" (the shipping firmware's shape)
//   - --no-turbidity alone stays "0.7.0" (a dev convenience; no real 0.7.0 unit lacks turbidity)
//   - --no-ph --no-turbidity is the 0.6.1 shape minus turbidity
// The first run after the old simulator version string logs one FIRMWARE_CHANGED event per device, and switching
// between --no-ph and pH logs another; that is expected.
//
// `--fault <parameter>=<status>` (repeatable) reports that sensor with that status and omits its value, the way
// the firmware does (e.g. `--fault ph=no_signal` to demo a SENSOR_FAULT; restart without it to see it recover).
//
// `--spike <parameter>=<value>:<everyN>` (repeatable) replaces that parameter's value on every Nth report (1-based)
// with a stray reading, for pH and turbidity alike — e.g. `--spike ph=5.5:4 --spike turbidity=135.8:4`. A single
// stray must not open an alert or reset an open episode's recovery (ALRT-05). The value must be inside
// PARAMETER_BOUNDS (an out-of-bounds value is dropped at ingest and proves nothing), everyN >= 2, and the parameter
// must be reported and not faulted.
//
// `--dry-run <reports>` prints that many unsigned report bodies (one JSON object per line) on a simulated clock
// (`--interval` apart) and exits without connecting — so a whole pH day can be inspected offline. It never prints
// a secret.
//
// Every message carries the firmware 0.6.x extras in wire order — diag (integer rssi, uptimeS, resetReason,
// freeHeap, queued) and a per-sensor status map — so the device diagnostics page can be demoed without hardware.
//
// Uses MQTT_URL / MQTT_USERNAME / MQTT_PASSWORD from backend/.env. Credentials come from registering a device
// (or rotating its secret) on the Devices page.
import "dotenv/config";
import { connectAsync, type MqttClient } from "mqtt";
import { parseArgs } from "node:util";
import { readingsTopic, signMessage } from "../src/lib/deviceMessages.ts";
import { PARAMETER_BOUNDS } from "../src/lib/parameters.ts";
import {
  PH_CURVE,
  curveTimingWarnings,
  parseSpike,
  phCurveValue,
  simulatedFirmwareVersion,
  spikeFor,
  type SpikeSpec,
} from "../src/lib/simulatorSignals.ts";
import { SENSOR_STATUSES, type SensorStatus } from "../src/schemas/ingest.ts";

const { values } = parseArgs({
  options: {
    device: { type: "string", multiple: true },
    interval: { type: "string", default: "60" },
    fault: { type: "string", multiple: true },
    url: { type: "string", default: process.env.MQTT_URL },
    "no-turbidity": { type: "boolean", default: false },
    turbidity: { type: "string" },
    temperature: { type: "string" },
    ph: { type: "string" },
    "no-ph": { type: "boolean", default: false },
    "ph-day": { type: "string", default: String(PH_CURVE.dayMinutes) },
    spike: { type: "string", multiple: true },
    "dry-run": { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let dryRunReports: number | undefined;
if (values["dry-run"] !== undefined) {
  const n = Number(values["dry-run"]);
  if (!/^\d+$/.test(values["dry-run"]) || !Number.isInteger(n) || n < 1) {
    fail(`Expected --dry-run <reports> with a positive integer; got "${values["dry-run"]}"`);
  }
  dryRunReports = n;
}

const specs = values.device ?? [];
const intervalMs = Number(values.interval) * 1000;
if (specs.length === 0 || (dryRunReports === undefined && !values.url) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
  console.error(
    "Usage: npm run simulate:devices -- --device <deviceId>:<deviceSecret> [--device ...] [--interval <seconds>] [--fault <parameter>=<status> ...] [--no-turbidity] [--turbidity <ntu>] [--temperature <°C>] [--no-ph] [--ph <pH>] [--ph-day <minutes>] [--spike <parameter>=<value>:<everyN> ...] [--dry-run <reports>]",
  );
  console.error("--turbidity <ntu> holds turbidity at a fixed NTU (0..3000) to demo a spike or the 3000 NTU ceiling.");
  console.error("--temperature <°C> holds temperature at a fixed value (-5..60) to demo a WARNING or CRITICAL band.");
  console.error("--ph <pH> holds pH at a fixed value (0..14); --ph-day <minutes> sets the pH day length (default 40).");
  console.error("MQTT_URL, MQTT_USERNAME and MQTT_PASSWORD must be set in backend/.env (not needed with --dry-run).");
  process.exit(1);
}

// 0..3000 is the firmware's own clamp range (Phase 3 D-02), so a pinned value is always one a real unit could send.
let pinnedTurbidity: number | undefined;
if (values.turbidity !== undefined) {
  if (values["no-turbidity"]) fail("--turbidity cannot be combined with --no-turbidity.");
  const ntu = Number(values.turbidity);
  if (values.turbidity.trim() === "" || !Number.isFinite(ntu) || ntu < 0 || ntu > 3000) {
    fail(`Expected --turbidity <ntu> with ntu between 0 and 3000; got "${values.turbidity}"`);
  }
  pinnedTurbidity = ntu;
}

// -5..60 is PARAMETER_BOUNDS.temperature, so a pinned value is always stored rather than rejected at ingest.
let pinnedTemperature: number | undefined;
if (values.temperature !== undefined) {
  const celsius = Number(values.temperature);
  if (values.temperature.trim() === "" || !Number.isFinite(celsius) || celsius < -5 || celsius > 60) {
    fail(`Expected --temperature <°C> with a value between -5 and 60; got "${values.temperature}"`);
  }
  pinnedTemperature = celsius;
}

const phBounds = PARAMETER_BOUNDS.ph;
let pinnedPh: number | undefined;
if (values.ph !== undefined) {
  if (values["no-ph"]) fail("--ph cannot be combined with --no-ph.");
  const ph = Number(values.ph);
  if (values.ph.trim() === "" || !Number.isFinite(ph) || ph < phBounds.min || ph > phBounds.max) {
    fail(`Expected --ph <pH> with a value between ${phBounds.min} and ${phBounds.max}; got "${values.ph}"`);
  }
  pinnedPh = ph;
}

const phDayMinutes = Number(values["ph-day"]);
if (values["ph-day"].trim() === "" || !Number.isFinite(phDayMinutes) || phDayMinutes <= 0) {
  fail(`Expected --ph-day <minutes> with a positive number; got "${values["ph-day"]}"`);
}
const phDayMs = phDayMinutes * 60_000;

// The channels every unit reports, in wire order.
const reportedParameters = [
  "temperature",
  ...(values["no-turbidity"] ? [] : ["turbidity"]),
  ...(values["no-ph"] ? [] : ["ph"]),
];

const faults = new Map<string, SensorStatus>();
for (const spec of values.fault ?? []) {
  const [parameter, status] = spec.split("=");
  if (!parameter || !/^[a-z][a-zA-Z0-9]{0,31}$/.test(parameter) || !SENSOR_STATUSES.includes(status as SensorStatus)) {
    fail(`Expected --fault <parameter>=<status> with status one of ${SENSOR_STATUSES.join(", ")}; got "${spec}"`);
  }
  // A sensor dropped by --no-ph / --no-turbidity is absent from the firmware's sensors map, not faulted.
  if ((parameter === "ph" && values["no-ph"]) || (parameter === "turbidity" && values["no-turbidity"])) {
    fail(`--fault ${parameter} cannot be combined with --no-${parameter}.`);
  }
  faults.set(parameter, status as SensorStatus);
}

const spikes: SpikeSpec[] = [];
for (const spec of values.spike ?? []) {
  const parsed = parseSpike(spec);
  if (typeof parsed === "string") fail(`--spike: ${parsed}`);
  if (!reportedParameters.includes(parsed.parameter)) {
    fail(`--spike ${parsed.parameter}: that parameter is not reported (dropped by --no-${parsed.parameter}).`);
  }
  if (faults.has(parsed.parameter)) {
    fail(`--spike ${parsed.parameter}: that sensor is faulted by --fault, so it sends no value to replace.`);
  }
  spikes.push(parsed);
}

// `scale` is 1 / rounding step: 100 (0.01, the default) for temperature, 10 for turbidity to match the firmware's
// NTU_ROUND_STEP of 0.1.
type Drift = { value: number; volatility: number; min: number; max: number; scale?: number };
// pH is time-driven rather than a random walk: its value is a function of the (real or simulated) clock, so a
// discriminant keeps both kinds under one `satisfies` check instead of casting.
type Channel = ({ kind: "drift" } & Drift) | { kind: "phCurve"; offset: number; pinned?: number };

function drift(channel: Drift) {
  channel.value = Math.min(channel.max, Math.max(channel.min, channel.value + (Math.random() - 0.5) * channel.volatility));
  const scale = channel.scale ?? 100;
  return Math.round(channel.value * scale) / scale;
}

function channelValue(channel: Channel, elapsedMs: number): number {
  if (channel.kind === "drift") return drift(channel);
  return channel.pinned ?? phCurveValue(elapsedMs, phDayMs, channel.offset);
}

// Each simulated unit starts from slightly different conditions so ponds don't look identical.
const units = specs.map((spec, index) => {
  const separator = spec.indexOf(":");
  if (separator < 1) fail(`Expected <deviceId>:<deviceSecret>, got "${spec}"`);
  const channels = {
    // Key order is signed bytes and mirrors the firmware: temperature, turbidity, ph. min 0 keeps every turbidity
    // value inside PARAMETER_BOUNDS (a negative one would be rejected at ingest).
    // 18..37 straddles the BFAR safe lines (20/30 °C) and the high critical line (35.5 °C) so WARNING and
    // CRITICAL temperature episodes can be demoed.
    temperature:
      pinnedTemperature === undefined
        ? { kind: "drift", value: 27 + Math.random() * 3, volatility: 0.35, min: 18, max: 37 }
        : { kind: "drift", value: pinnedTemperature, volatility: 0, min: pinnedTemperature, max: pinnedTemperature },
    ...(values["no-turbidity"]
      ? {}
      : {
          turbidity:
            pinnedTurbidity === undefined
              ? { kind: "drift", value: 5 + Math.random() * 10, volatility: 4, min: 0, max: 60, scale: 10 }
              : {
                  kind: "drift",
                  value: pinnedTurbidity,
                  volatility: 0,
                  min: pinnedTurbidity,
                  max: pinnedTurbidity,
                  scale: 10,
                },
        }),
    // index / unitCount spreads the units evenly over the day (D-14), deterministically, so two ponds never
    // cross a line at the same moment.
    ...(values["no-ph"] ? {} : { ph: { kind: "phCurve", offset: index / specs.length, pinned: pinnedPh } }),
  } satisfies Record<string, Channel>;
  return {
    deviceId: spec.slice(0, separator),
    secret: spec.slice(separator + 1),
    rssi: { value: -60 - Math.random() * 10, volatility: 3, min: -80, max: -55 },
    channels,
  };
});

const startedAt = Date.now();

const timingWarnings = curveTimingWarnings({ dayMs: phDayMs, intervalMs });
const phOnCurve = !values["no-ph"] && pinnedPh === undefined && !faults.has("ph");
// The day-length warnings only matter while pH follows the curve; the interval one applies to every held parameter.
for (const warning of timingWarnings) {
  if (phOnCurve || warning.startsWith("--interval")) console.warn(`warning: ${warning}`);
}

// reportIndex is 1-based; elapsedMs is time since the run started (wall clock live, simulated in --dry-run).
function buildBody(unit: (typeof units)[number], reportIndex: number, elapsedMs: number) {
  // A faulted sensor's value is omitted, mirroring the firmware; everything else reports "ok". A spike replaces a
  // reported, non-faulted value on its schedule.
  const sampleValues = Object.fromEntries(
    Object.entries(unit.channels)
      .filter(([parameter]) => !faults.has(parameter))
      .map(([parameter, channel]) => {
        const value = channelValue(channel, elapsedMs);
        return [parameter, spikeFor(spikes, parameter, reportIndex) ?? value];
      }),
  );
  const sensors: Record<string, SensorStatus> = {};
  for (const parameter of Object.keys(unit.channels)) sensors[parameter] = faults.get(parameter) ?? "ok";
  for (const [parameter, status] of faults) sensors[parameter] = status;
  // Key order is signed bytes and mirrors the firmware: firmwareVersion, wifiSsid, diag, sensors, samples.
  // Every diag number is an integer (Math.round), as the wire format requires. A faulted pH still counts as
  // reported (sensors.ph is present), so it stays 0.7.0.
  return {
    firmwareVersion: simulatedFirmwareVersion("ph" in unit.channels),
    wifiSsid: "Simulated-WiFi",
    diag: {
      rssi: Math.round(drift(unit.rssi)),
      uptimeS: Math.round(elapsedMs / 1000),
      resetReason: "power_on",
      freeHeap: Math.round(200_000 + (Math.random() - 0.5) * 8_000),
      queued: 0,
    },
    sensors,
    samples: [{ recordedAt: new Date(startedAt + elapsedMs).toISOString(), values: sampleValues }],
  };
}

if (dryRunReports !== undefined) {
  // Unsigned bodies only: the secret never leaves the process, and nothing connects to a broker.
  for (let reportIndex = 1; reportIndex <= dryRunReports; reportIndex++) {
    const elapsedMs = (reportIndex - 1) * intervalMs;
    for (const unit of units) console.log(JSON.stringify(buildBody(unit, reportIndex, elapsedMs)));
  }
  process.exit(0);
}

const client: MqttClient = await connectAsync(values.url!, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  clientId: `truaquality-simulator-${process.pid}`,
});

let reportIndex = 0;

async function report(unit: (typeof units)[number], index: number) {
  const body = buildBody(unit, index, Date.now() - startedAt);
  const topic = readingsTopic(unit.deviceId);
  await client.publishAsync(topic, signMessage(unit.secret, topic, JSON.stringify(body)), { qos: 1 });
  console.log(
    `[${new Date().toLocaleTimeString()}] ${unit.deviceId.slice(0, 8)}… published ${JSON.stringify(body.samples[0].values)}`,
  );
}

async function tick() {
  reportIndex++;
  const index = reportIndex;
  await Promise.all(
    units.map((unit) => report(unit, index).catch((err) => console.error(unit.deviceId.slice(0, 8), err.message))),
  );
}

console.log(`Simulating ${units.length} device(s) against ${values.url} every ${intervalMs / 1000}s. Ctrl+C to stop.`);
console.log("The backend logs a reason for every message it drops (bad secret, unassigned device, ...).");
await tick();
setInterval(tick, intervalMs);
