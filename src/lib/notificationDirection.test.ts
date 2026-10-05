import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { notificationDirection } from "./notificationDirection.ts";
import { PARAMETER_THRESHOLDS, thresholdsFor } from "./parameters.ts";

describe("notificationDirection", () => {
  test("pH just below the 6.5 safe floor is low (acidic)", () => {
    assert.equal(notificationDirection("ph", 6.49, null), "low");
  });
  test("pH just above the 9.5 safe ceiling is high (alkaline)", () => {
    assert.equal(notificationDirection("ph", 9.51, null), "high");
  });
  test("pH at the 0 and 14 bounds", () => {
    assert.equal(notificationDirection("ph", 0, null), "low");
    assert.equal(notificationDirection("ph", 14, null), "high");
  });
  test("temperature below its safe floor is low", () => {
    assert.equal(notificationDirection("temperature", thresholdsFor(null).temperature.safeMin - 1, null), "low");
  });
  test("turbidity above its safe ceiling is high", () => {
    assert.equal(notificationDirection("turbidity", thresholdsFor(null).turbidity.safeMax + 1, null), "high");
  });
  test("an unknown parameter id falls back to high", () => {
    assert.equal(notificationDirection("dissolvedOxygen", 1, null), "high");
  });
  test("pH direction is the same for every pond-type profile", () => {
    for (const profile of Object.keys(PARAMETER_THRESHOLDS)) {
      assert.equal(notificationDirection("ph", 6.49, profile), "low", profile);
      assert.equal(notificationDirection("ph", 9.51, profile), "high", profile);
    }
  });
});
