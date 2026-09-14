import { createHmac, timingSafeEqual } from "node:crypto";

// HiveMQ Cloud's free tier can't restrict a login to particular topics, so the broker proves nothing about who
// published a message. Each message is therefore signed by the device itself.
//
// Wire format: `v1.<hex HMAC-SHA256>.<JSON body>`. The HMAC covers `<topic>\n<body>`, so a signed body can't be
// moved onto another device's topic. The signature lives in the payload because MQTT 3.1.1 (what the ESP32
// client speaks) has no message properties. Firmware (`lib/Uplink`) must produce exactly this format.

const VERSION_PREFIX = "v1.";
const SIGNATURE_HEX_LENGTH = 64;
const TOPIC_PREFIX = "truaquality/v1/devices/";
const TOPIC_SUFFIX = "/readings";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const READINGS_TOPIC_FILTER = `${TOPIC_PREFIX}+${TOPIC_SUFFIX}`;

export function readingsTopic(deviceId: string) {
  return `${TOPIC_PREFIX}${deviceId}${TOPIC_SUFFIX}`;
}

export function deviceIdFromTopic(topic: string) {
  if (!topic.startsWith(TOPIC_PREFIX) || !topic.endsWith(TOPIC_SUFFIX)) return null;
  const deviceId = topic.slice(TOPIC_PREFIX.length, -TOPIC_SUFFIX.length);
  return UUID_PATTERN.test(deviceId) ? deviceId.toLowerCase() : null;
}

function hmacHex(secret: string, topic: string, body: string) {
  return createHmac("sha256", secret).update(`${topic}\n${body}`).digest("hex");
}

export function signMessage(secret: string, topic: string, body: string) {
  return `${VERSION_PREFIX}${hmacHex(secret, topic, body)}.${body}`;
}

export function parseSignedMessage(payload: Buffer) {
  const text = payload.toString("utf8");
  const separatorIndex = VERSION_PREFIX.length + SIGNATURE_HEX_LENGTH;
  if (!text.startsWith(VERSION_PREFIX) || text[separatorIndex] !== ".") return null;
  return { signature: text.slice(VERSION_PREFIX.length, separatorIndex), body: text.slice(separatorIndex + 1) };
}

export function isValidSignature(secret: string, topic: string, body: string, signature: string) {
  const expected = Buffer.from(hmacHex(secret, topic, body), "hex");
  const actual = Buffer.from(signature, "hex");
  // Buffer.from stops at the first non-hex character, so malformed signatures fail the length check.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
