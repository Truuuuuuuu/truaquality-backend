import { connect } from "mqtt";
import { z } from "zod";
import { deviceIdFromTopic, isValidSignature, parseSignedMessage, READINGS_TOPIC_FILTER } from "./deviceMessages.ts";
import { deriveDeviceSecret } from "./deviceSecrets.ts";
import { ingestSamples } from "./ingest.ts";
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

// Units report about once a minute and send a buffered backlog in batches, so 30 messages a minute only trips on
// a firmware retry loop. Counted after signature verification, so spoofed messages can't use up a device's quota.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;
const recentMessages = new Map<string, number[]>();

function withinRateLimit(deviceId: string, now: number) {
  const times = (recentMessages.get(deviceId) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
  const allowed = times.length < RATE_LIMIT;
  if (allowed) times.push(now);
  recentMessages.set(deviceId, times);
  return allowed;
}

// Returns why a message was dropped, or null once it was handed to ingest.
async function handleReadingsMessage(topic: string, payload: Buffer): Promise<string | null> {
  const receivedAt = new Date();

  const deviceId = deviceIdFromTopic(topic);
  if (!deviceId) return "topic does not name a device";

  const signed = parseSignedMessage(payload);
  if (!signed) return "payload is not a signed message";

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return "unknown device";

  // Checked before anything else about the device is trusted or written — an unsigned message must not even
  // update lastSeenAt.
  if (!isValidSignature(deriveDeviceSecret(device.id, device.secretVersion), topic, signed.body, signed.signature)) {
    return "invalid signature (wrong or rotated secret?)";
  }
  if (device.status === "DISABLED") return "device is disabled";
  if (!withinRateLimit(device.id, receivedAt.getTime())) return "rate limited";

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
    handleReadingsMessage(topic, payload)
      .then((dropReason) => {
        if (dropReason) console.warn(`[mqtt] dropped message on ${topic}: ${dropReason}`);
      })
      .catch((err) => console.error(`[mqtt] failed to store message on ${topic}:`, err));
  });

  return client;
}
