// DEV ONLY. Pretends to be one or more ESP32 units so the multi-pond UI can be exercised before real
// hardware is installed. Readings it produces are synthetic — never point it at a production broker.
//
//   npm run simulate:devices -- --device <deviceId>:<deviceSecret> [--device ...] [--interval 60]
//                               [--fault <parameter>=<status> ...] [--no-turbidity]
//
// Each unit reports temperature then turbidity (0.1 NTU steps, drifting 0..60 NTU across the 25 NTU safe line so
// a WARNING episode can be demoed). `--no-turbidity` drops the turbidity value and its sensors key entirely, like
// firmware older than 0.4.0.
//
// Every message carries the firmware 0.6.0 extras in wire order — diag (integer rssi, uptimeS, resetReason,
// freeHeap, queued) and a per-sensor status map — so the device diagnostics page can be demoed without hardware.
// `--fault temperature=not_found` makes every unit report that sensor with that status and omit its value, the
// way the firmware does (e.g. to demo a SENSOR_FAULT event; drop the flag and restart to see it recover).
//
// Uses MQTT_URL / MQTT_USERNAME / MQTT_PASSWORD from backend/.env. Credentials come from registering a device
// (or rotating its secret) on the Devices page.
import "dotenv/config";
import { connectAsync } from "mqtt";
import { parseArgs } from "node:util";
import { readingsTopic, signMessage } from "../src/lib/deviceMessages.ts";
import { SENSOR_STATUSES, type SensorStatus } from "../src/schemas/ingest.ts";

const { values } = parseArgs({
  options: {
    device: { type: "string", multiple: true },
    interval: { type: "string", default: "60" },
    fault: { type: "string", multiple: true },
    url: { type: "string", default: process.env.MQTT_URL },
    "no-turbidity": { type: "boolean", default: false },
  },
});

const specs = values.device ?? [];
const intervalMs = Number(values.interval) * 1000;
if (specs.length === 0 || !values.url || !Number.isFinite(intervalMs) || intervalMs <= 0) {
  console.error(
    "Usage: npm run simulate:devices -- --device <deviceId>:<deviceSecret> [--device ...] [--interval <seconds>] [--fault <parameter>=<status> ...] [--no-turbidity]",
  );
  console.error("MQTT_URL, MQTT_USERNAME and MQTT_PASSWORD must be set in backend/.env.");
  process.exit(1);
}

const faults = new Map<string, SensorStatus>();
for (const spec of values.fault ?? []) {
  const [parameter, status] = spec.split("=");
  if (!parameter || !/^[a-z][a-zA-Z0-9]{0,31}$/.test(parameter) || !SENSOR_STATUSES.includes(status as SensorStatus)) {
    console.error(`Expected --fault <parameter>=<status> with status one of ${SENSOR_STATUSES.join(", ")}; got "${spec}"`);
    process.exit(1);
  }
  faults.set(parameter, status as SensorStatus);
}

// `scale` is 1 / rounding step: 100 (0.01, the default) for temperature, 10 for turbidity to match the firmware's
// NTU_ROUND_STEP of 0.1.
type Channel = { value: number; volatility: number; min: number; max: number; scale?: number };

function drift(channel: Channel) {
  channel.value = Math.min(channel.max, Math.max(channel.min, channel.value + (Math.random() - 0.5) * channel.volatility));
  const scale = channel.scale ?? 100;
  return Math.round(channel.value * scale) / scale;
}

// Each simulated unit starts from slightly different conditions so ponds don't look identical.
const units = specs.map((spec) => {
  const separator = spec.indexOf(":");
  if (separator < 1) {
    console.error(`Expected <deviceId>:<deviceSecret>, got "${spec}"`);
    process.exit(1);
  }
  return {
    deviceId: spec.slice(0, separator),
    secret: spec.slice(separator + 1),
    startedAt: Date.now(),
    rssi: { value: -60 - Math.random() * 10, volatility: 3, min: -80, max: -55 },
    channels: {
      // Key order is signed bytes and mirrors the firmware: temperature first, then turbidity. min 0 keeps every
      // turbidity value inside PARAMETER_BOUNDS (a negative one would be rejected at ingest).
      temperature: { value: 27 + Math.random() * 3, volatility: 0.35, min: 23, max: 34 },
      ...(values["no-turbidity"]
        ? {}
        : { turbidity: { value: 5 + Math.random() * 10, volatility: 4, min: 0, max: 60, scale: 10 } }),
    } satisfies Record<string, Channel>,
  };
});

const client = await connectAsync(values.url, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  clientId: `truaquality-simulator-${process.pid}`,
});

async function report(unit: (typeof units)[number]) {
  // A faulted sensor's value is omitted, mirroring the firmware; everything else reports "ok".
  const sampleValues = Object.fromEntries(
    Object.entries(unit.channels)
      .filter(([parameter]) => !faults.has(parameter))
      .map(([parameter, channel]) => [parameter, drift(channel)]),
  );
  const sensors: Record<string, SensorStatus> = {};
  for (const parameter of Object.keys(unit.channels)) sensors[parameter] = faults.get(parameter) ?? "ok";
  for (const [parameter, status] of faults) sensors[parameter] = status;
  const topic = readingsTopic(unit.deviceId);
  // Key order is signed bytes and mirrors the firmware: firmwareVersion, wifiSsid, diag, sensors, samples.
  // Every diag number is an integer (Math.round), as the wire format requires.
  const body = JSON.stringify({
    firmwareVersion: "simulator",
    wifiSsid: "Simulated-WiFi",
    diag: {
      rssi: Math.round(drift(unit.rssi)),
      uptimeS: Math.round((Date.now() - unit.startedAt) / 1000),
      resetReason: "power_on",
      freeHeap: Math.round(200_000 + (Math.random() - 0.5) * 8_000),
      queued: 0,
    },
    sensors,
    samples: [{ recordedAt: new Date().toISOString(), values: sampleValues }],
  });
  await client.publishAsync(topic, signMessage(unit.secret, topic, body), { qos: 1 });
  console.log(`[${new Date().toLocaleTimeString()}] ${unit.deviceId.slice(0, 8)}… published ${JSON.stringify(sampleValues)}`);
}

async function tick() {
  await Promise.all(units.map((unit) => report(unit).catch((err) => console.error(unit.deviceId.slice(0, 8), err.message))));
}

console.log(`Simulating ${units.length} device(s) against ${values.url} every ${intervalMs / 1000}s. Ctrl+C to stop.`);
console.log("The backend logs a reason for every message it drops (bad secret, unassigned device, ...).");
await tick();
setInterval(tick, intervalMs);
