// DEV ONLY. Pretends to be one or more ESP32 units so the multi-pond UI can be exercised before real
// hardware is installed. Readings it produces are synthetic — never point it at a production broker.
//
//   npm run simulate:devices -- --device <deviceId>:<deviceSecret> [--device ...] [--interval 60]
//                              [--profile freshwater|brackish|saltwater]
//
// --profile picks the salinity band each unit drifts within, so a freshwater pond can be exercised against
// the freshwater thresholds instead of being fed brackish water. Repeat it to give each --device its own
// profile, in the same order; a single --profile applies to all of them, and the default is brackish.
//
// Uses MQTT_URL / MQTT_USERNAME / MQTT_PASSWORD from backend/.env. Credentials come from registering a device
// (or rotating its secret) on the Devices page.
import "dotenv/config";
import { connectAsync } from "mqtt";
import { parseArgs } from "node:util";
import { readingsTopic, signMessage } from "../src/lib/deviceMessages.ts";

const { values } = parseArgs({
  options: {
    device: { type: "string", multiple: true },
    interval: { type: "string", default: "60" },
    profile: { type: "string", multiple: true },
    url: { type: "string", default: process.env.MQTT_URL },
  },
});

const specs = values.device ?? [];
const intervalMs = Number(values.interval) * 1000;
if (specs.length === 0 || !values.url || !Number.isFinite(intervalMs) || intervalMs <= 0) {
  console.error("Usage: npm run simulate:devices -- --device <deviceId>:<deviceSecret> [--device ...] [--interval <seconds>] [--profile freshwater|brackish|saltwater]");
  console.error("MQTT_URL, MQTT_USERNAME and MQTT_PASSWORD must be set in backend/.env.");
  process.exit(1);
}

type Channel = { value: number; volatility: number; min: number; max: number };

// Salinity bands matching the pond types the backend keys its thresholds by (lib/parameters.ts). Each one
// drifts comfortably inside its own safe range, so a correctly-classified pond reads nominal and a
// mismatched one (a brackish unit on a freshwater pond) alarms — which is the point of being able to pick.
const SALINITY_PROFILES = {
  freshwater: { base: 0.2, spread: 0.6, min: 0, max: 2 },
  brackish: { base: 12, spread: 10, min: 4, max: 33 },
  saltwater: { base: 31, spread: 3, min: 28, max: 38 },
} satisfies Record<string, { base: number; spread: number; min: number; max: number }>;

type ProfileName = keyof typeof SALINITY_PROFILES;

const profileArgs = values.profile ?? [];
for (const name of profileArgs) {
  if (!Object.hasOwn(SALINITY_PROFILES, name)) {
    console.error(`Unknown --profile "${name}". Expected one of: ${Object.keys(SALINITY_PROFILES).join(", ")}`);
    process.exit(1);
  }
}
if (profileArgs.length > 1 && profileArgs.length !== specs.length) {
  console.error(`Got ${profileArgs.length} --profile values for ${specs.length} --device values. Pass one profile for all, or one per device.`);
  process.exit(1);
}

// One profile applies to every unit; several are matched to --device in order.
function profileForIndex(index: number): ProfileName {
  if (profileArgs.length === 0) return "brackish";
  return (profileArgs[profileArgs.length === 1 ? 0 : index] as ProfileName);
}

function drift(channel: Channel) {
  channel.value = Math.min(channel.max, Math.max(channel.min, channel.value + (Math.random() - 0.5) * channel.volatility));
  return Math.round(channel.value * 100) / 100;
}

// Each simulated unit starts from slightly different conditions so ponds don't look identical.
const units = specs.map((spec, index) => {
  const separator = spec.indexOf(":");
  if (separator < 1) {
    console.error(`Expected <deviceId>:<deviceSecret>, got "${spec}"`);
    process.exit(1);
  }
  const profile = profileForIndex(index);
  const salinity = SALINITY_PROFILES[profile];
  return {
    deviceId: spec.slice(0, separator),
    secret: spec.slice(separator + 1),
    profile,
    channels: {
      temperature: { value: 27 + Math.random() * 3, volatility: 0.35, min: 23, max: 34 },
      dissolvedOxygen: { value: 4.5 + Math.random() * 3, volatility: 0.3, min: 2.5, max: 11.5 },
      salinity: {
        value: salinity.base + Math.random() * salinity.spread,
        // Fresh water barely moves in absolute ppt, so a brackish-sized step would swing it out of range.
        volatility: profile === "freshwater" ? 0.1 : 0.6,
        min: salinity.min,
        max: salinity.max,
      },
    } satisfies Record<string, Channel>,
  };
});

const client = await connectAsync(values.url, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  clientId: `truaquality-simulator-${process.pid}`,
});

async function report(unit: (typeof units)[number]) {
  const sampleValues = Object.fromEntries(
    Object.entries(unit.channels).map(([parameter, channel]) => [parameter, drift(channel)]),
  );
  const topic = readingsTopic(unit.deviceId);
  const body = JSON.stringify({
    firmwareVersion: "simulator",
    samples: [{ recordedAt: new Date().toISOString(), values: sampleValues }],
  });
  await client.publishAsync(topic, signMessage(unit.secret, topic, body), { qos: 1 });
  console.log(`[${new Date().toLocaleTimeString()}] ${unit.deviceId.slice(0, 8)}… (${unit.profile}) published ${JSON.stringify(sampleValues)}`);
}

async function tick() {
  await Promise.all(units.map((unit) => report(unit).catch((err) => console.error(unit.deviceId.slice(0, 8), err.message))));
}

console.log(`Simulating ${units.length} device(s) against ${values.url} every ${intervalMs / 1000}s. Ctrl+C to stop.`);
console.log("The backend logs a reason for every message it drops (bad secret, unassigned device, ...).");
await tick();
setInterval(tick, intervalMs);
