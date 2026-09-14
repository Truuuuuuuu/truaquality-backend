import { createHmac } from "node:crypto";
import { readingsTopic } from "./deviceMessages.ts";

function requireMasterKey() {
  const key = process.env.DEVICE_SECRET_MASTER_KEY;
  if (!key || key.length < 32) {
    throw new Error("DEVICE_SECRET_MASTER_KEY must be set to at least 32 random characters");
  }
  return key;
}

const masterKey = requireMasterKey();

// Device secrets are derived, never stored: HMAC(master key, device id + version). A leaked database reveals no
// secret, rotating a device just bumps its secretVersion, and changing the master key invalidates every unit.
export function deriveDeviceSecret(deviceId: string, secretVersion: number) {
  return createHmac("sha256", masterKey).update(`device-secret:${deviceId}:${secretVersion}`).digest("base64url");
}

// What an admin enters on the unit's setup portal (no reflash — see firmware/CLAUDE.md's "Field
// provisioning"). Only returned when a device is registered or its secret is rotated.
export function deviceCredentials(device: { id: string; secretVersion: number }) {
  return {
    deviceId: device.id,
    deviceSecret: deriveDeviceSecret(device.id, device.secretVersion),
    topic: readingsTopic(device.id),
  };
}
