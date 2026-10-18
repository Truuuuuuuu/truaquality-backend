import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeviceSchema, updateDeviceSchema } from "./devices.ts";

test("device registration defaults omitted hardware to ESP32D", () => {
  assert.equal(createDeviceSchema.parse({ serial: "BFAR-001" }).hardwareModel, "ESP32D");
});

test("device registration preserves an explicitly supplied hardware model", () => {
  assert.equal(createDeviceSchema.parse({ serial: "BFAR-001", hardwareModel: "Legacy unit" }).hardwareModel, "Legacy unit");
});

test("editing other device fields does not supply a hardware model", () => {
  assert.deepEqual(updateDeviceSchema.parse({ label: "Pond sensor" }), { label: "Pond sensor" });
});
