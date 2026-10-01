import { connect } from "mqtt";
import { z } from "zod";
import { deviceIdFromTopic, isValidSignature, parseSignedMessage, READINGS_TOPIC_FILTER } from "./deviceMessages.ts";
import { deriveDeviceSecret } from "./deviceSecrets.ts";
import { ingestSamples } from "./ingest.ts";
import { createMessageQueue } from "./messageQueue.ts";
import { prisma } from "./prisma.ts";
import { ingestSchema } from "../schemas/ingest.ts";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

const mqttUrl = requireEnv("MQTT_URL");
const mqttUsername = requireEnv("MQTT_USERNAME");
const mqttPassword = requireEnv("MQTT_PASSWORD");

// Units report about once a minute, so 30 live messages a minute only trips on a firmware retry loop (or someone
// re-publishing a unit's current message over and over). Counted after signature verification, so spoofed
// messages can't use up a device's quota. Only LIVE messages count — ones whose newest signed sample is recent. A
// backlog batch (the unit flushing what it buffered offline, or the broker redelivering what it held while the
// backend was down) is older than that by definition, and counting it is exactly what used to throw away most of a
// legitimate backlog after an outage. Old messages cost little anyway: they are processed one at a time per device
// (messageQueue.ts), duplicates are skipped by the readings unique key, and they can no longer move lastSeenAt.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;
const LIVE_MESSAGE_MAX_AGE_MS = 5 * 60 * 1000;
const recentMessages = new Map<string, number[]>();

function withinRateLimit(deviceId: string, now: number) {
  const times = (recentMessages.get(deviceId) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
  const allowed = times.length < RATE_LIMIT;
  if (allowed) times.push(now);
  recentMessages.set(deviceId, times);
  return allowed;
}

// All field units share one HiveMQ credential (the free tier can't scope logins to a topic), so anyone holding it
// can publish to any device's topic, including nonexistent or enumerated device ids, and every such message costs a
// prisma.device.findUnique(). This used to be a wall-clock cap of 300 messages a minute that DROPPED the overflow —
// which also dropped the legitimate burst the broker delivers when the backend reconnects. Now every message waits
// in a bounded queue instead: 4 workers bound concurrent database load (garbage traffic included, since it runs
// before any database work), and 5000 waiting messages bound memory. A reconnect backlog is about one message per
// unit per minute of downtime (each up to 120 samples), so 5000 covers hours of outage for a pond-scale fleet;
// only past that cap is a message dropped, and that is logged.
const INGEST_CONCURRENCY = 4;
const INGEST_MAX_QUEUED = 5000;
const ingestQueue = createMessageQueue({ concurrency: INGEST_CONCURRENCY, maxQueued: INGEST_MAX_QUEUED });

// Returns why a message was dropped, or null once it was handed to ingest.
// receivedAt is taken when the message arrived, not when the queue got to it, so a queued message isn't judged
// against a later clock.
async function handleReadingsMessage(
  topic: string,
  deviceId: string,
  signed: { signature: string; body: string },
  receivedAt: Date,
): Promise<string | null> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return "unknown device";

  // Checked before anything else about the device is trusted or written — an unsigned message must not even
  // update lastSeenAt.
  if (!isValidSignature(deriveDeviceSecret(device.id, device.secretVersion), topic, signed.body, signed.signature)) {
    return "invalid signature (wrong or rotated secret?)";
  }
  if (device.status === "DISABLED") return "device is disabled";

  let json: unknown;
  try {
    json = JSON.parse(signed.body);
  } catch {
    return "body is not valid JSON";
  }
  const parsed = ingestSchema.safeParse(json);
  if (!parsed.success) {
    return `invalid body: ${JSON.stringify(z.flattenError(parsed.error).fieldErrors)}`;
  }

  const newestSampleMs = Math.max(...parsed.data.samples.map((sample) => sample.recordedAt.getTime()));
  const isLive = receivedAt.getTime() - newestSampleMs <= LIVE_MESSAGE_MAX_AGE_MS;
  if (isLive && !withinRateLimit(device.id, receivedAt.getTime())) return "rate limited";

  const result = await ingestSamples(device, parsed.data, receivedAt);
  if (result.status === "unassigned") return "device is not assigned to a pond";
  if (result.rejected.length > 0) {
    console.warn(`[mqtt] ${device.serial}: stored ${result.accepted}, rejected ${result.rejected.length}`, result.rejected);
  }
  return null;
}

export function startReadingsSubscriber() {
  const client = connect(mqttUrl, {
    username: mqttUsername,
    password: mqttPassword,
    // Must be unique per running backend: two processes sharing an id keep disconnecting each other.
    clientId: process.env.MQTT_CLIENT_ID ?? "truaquality-backend",
    // A persistent session asks the broker to hold QoS 1 readings published while the backend is restarting (how
    // long it keeps them is the broker's call). MQTT 3.1.1, same as the units.
    clean: false,
    reconnectPeriod: 5000,
  });

  client.on("connect", () => {
    console.log(`[mqtt] connected, subscribing to ${READINGS_TOPIC_FILTER}`);
    client.subscribe(READINGS_TOPIC_FILTER, { qos: 1 }, (err) => {
      if (err) console.error("[mqtt] subscribe failed:", err.message);
    });
  });
  client.on("reconnect", () => console.log("[mqtt] reconnecting"));
  client.on("error", (err) => console.error("[mqtt] error:", err.message));
  client.on("message", (topic, payload) => {
    const receivedAt = new Date();
    // The cheap, synchronous checks run before queueing, so malformed traffic never takes a queue slot.
    const deviceId = deviceIdFromTopic(topic);
    if (!deviceId) {
      console.warn(`[mqtt] dropped message on ${topic}: topic does not name a device`);
      return;
    }
    const signed = parseSignedMessage(payload);
    if (!signed) {
      console.warn(`[mqtt] dropped message on ${topic}: payload is not a signed message`);
      return;
    }

    const queued = ingestQueue.enqueue(deviceId, () =>
      handleReadingsMessage(topic, deviceId, signed, receivedAt)
        .then((dropReason) => {
          if (dropReason) console.warn(`[mqtt] dropped message on ${topic}: ${dropReason}`);
        })
        .catch((err) => console.error(`[mqtt] failed to store message on ${topic}:`, err)),
    );
    if (!queued) console.warn(`[mqtt] dropped message on ${topic}: ingest queue full (${INGEST_MAX_QUEUED} waiting)`);
  });

  return client;
}
