import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { reportedStatuses } from "./devices.ts";

describe("reportedStatuses (Device.sensorStatus Json -> status tokens)", () => {
  test("a non-object column value yields {}", () => {
    for (const value of [null, undefined, "garbage", ["x"], 42]) {
      assert.deepEqual(reportedStatuses(value), {}, `value ${JSON.stringify(value)}`);
    }
  });

  test("a map of string tokens passes through unchanged", () => {
    assert.deepEqual(reportedStatuses({ temperature: "ok", turbidity: "uncalibrated" }), {
      temperature: "ok",
      turbidity: "uncalibrated",
    });
  });

  test("non-string values are dropped, string tokens kept", () => {
    assert.deepEqual(reportedStatuses({ temperature: "ok", turbidity: 5, x: null, y: { a: 1 } }), {
      temperature: "ok",
    });
  });
});
