// DEV ONLY. Pretends to be one or more ESP32 units so the multi-pond UI can be exercised before real
// hardware is installed. Readings it produces are synthetic — never point it at a production broker.
//
//   npm run simulate:devices -- --device <deviceId>:<deviceSecret> [--device ...] [--interval 60]
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
    url: { type: "string", default: process.env.MQTT_URL },
  },
});

const specs = values.device ?? [];
const intervalMs = Number(values.interval) * 1000;
if (specs.length === 0 || !values.url || !Number.isFinite(intervalMs) || intervalMs <= 0) {
  console.error("Usage: npm run simulate:devices -- --device <deviceId>:<deviceSecret> [--device ...] [--interval <seconds>]");
  console.error("MQTT_URL, MQTT_USERNAME and MQTT_PASSWORD must be set in backend/.env.");
  process.exit(1);
}

type Channel = { value: number; volatility: number; min: number; max: number };

function drift(channel: Channel) {
  channel.value = Math.min(channel.max, Math.max(channel.min, channel.value + (Math.random() - 0.5) * channel.volatility));
  return Math.round(channel.value * 100) / 100;
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
    channels: {
      temperature: { value: 27 + Math.random() * 3, volatility: 0.35, min: 23, max: 34 },
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
    wifiSsid: "Simulated-WiFi",
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
