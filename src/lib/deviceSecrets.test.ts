import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deriveDeviceSecret, deviceCredentials } from "./deviceSecrets.ts";
import { readingsTopic } from "./deviceMessages.ts";

const ID_A = "00000000-0000-4000-8000-000000000001";
const ID_B = "00000000-0000-4000-8000-000000000002";

test("deriveDeviceSecret is deterministic", () => {
  assert.equal(deriveDeviceSecret(ID_A, 1), deriveDeviceSecret(ID_A, 1));
});

test("deriveDeviceSecret changes with secretVersion", () => {
  assert.notEqual(deriveDeviceSecret(ID_A, 1), deriveDeviceSecret(ID_A, 2));
});

test("deriveDeviceSecret changes with deviceId", () => {
  assert.notEqual(deriveDeviceSecret(ID_A, 1), deriveDeviceSecret(ID_B, 1));
});

test("deriveDeviceSecret output is a 43-char base64url string", () => {
  assert.match(deriveDeviceSecret(ID_A, 1), /^[A-Za-z0-9_-]{43}$/);
});

test("deriveDeviceSecret equals HMAC(master key, device-secret:<id>:<version>)", () => {
  // Computed from process.env rather than hardcoded, so a shell-exported key doesn't break the test.
  for (const [id, version] of [[ID_A, 1], [ID_B, 3]] as const) {
    const expected = createHmac("sha256", process.env.DEVICE_SECRET_MASTER_KEY!)
      .update(`device-secret:${id}:${version}`)
      .digest("base64url");
    assert.equal(deriveDeviceSecret(id, version), expected);
  }
});

test("deviceCredentials returns the device's readings topic and derived secret", () => {
  const creds = deviceCredentials({ id: ID_A, secretVersion: 2 });
  assert.equal(creds.deviceId, ID_A);
  assert.equal(creds.topic, readingsTopic(ID_A));
  assert.equal(creds.deviceSecret, deriveDeviceSecret(ID_A, 2));
});

test("importing deviceSecrets with a short master key fails", () => {
  const modulePath = fileURLToPath(new URL("./deviceSecrets.ts", import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, DEVICE_SECRET_MASTER_KEY: "short" };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(modulePath)})`], {
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEVICE_SECRET_MASTER_KEY must be set/);
});
