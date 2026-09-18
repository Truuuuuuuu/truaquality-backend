import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PARAMETER_BOUNDS,
  PARAMETER_DISPLAY,
  PARAMETER_IDS,
  PARAMETER_THRESHOLDS,
  severityFor,
  thresholdProfileFor,
  thresholdsFor,
  type Threshold,
  type ThresholdProfile,
} from "./parameters.ts";

const PROFILES = Object.keys(PARAMETER_THRESHOLDS) as ThresholdProfile[];

describe("thresholdProfileFor", () => {
  test("null, undefined and an unknown type fall back to UNSET", () => {
    assert.equal(thresholdProfileFor(null), "UNSET");
    assert.equal(thresholdProfileFor(undefined), "UNSET");
    assert.equal(thresholdProfileFor("LAKE"), "UNSET");
  });

  test("the three named pond types map to themselves", () => {
    for (const t of ["FRESHWATER", "BRACKISH", "SALTWATER"] as const) {
      assert.equal(thresholdProfileFor(t), t);
    }
  });

  test("there are exactly four profiles", () => {
    assert.deepEqual([...PROFILES].sort(), ["BRACKISH", "FRESHWATER", "SALTWATER", "UNSET"]);
  });

  test("thresholdsFor resolves through the profile", () => {
    assert.equal(thresholdsFor("FRESHWATER"), PARAMETER_THRESHOLDS.FRESHWATER);
    assert.equal(thresholdsFor(null), PARAMETER_THRESHOLDS.UNSET);
  });
});

describe("severityFor — temperature edges (safe 26-31, critical 24-33)", () => {
  const cases: Array<[number, "WARNING" | "CRITICAL" | null]> = [
    [23.99, "CRITICAL"],
    [24, "WARNING"],
    [25.99, "WARNING"],
    [26, null],
    [28, null],
    [31, null],
    [31.01, "WARNING"],
    [33, "WARNING"],
    [33.01, "CRITICAL"],
  ];
  for (const [value, expected] of cases) {
    test(`${value} -> ${expected}`, () => {
      for (const pondType of [null, "FRESHWATER", "BRACKISH", "SALTWATER"]) {
        assert.equal(severityFor("temperature", value, pondType), expected);
      }
    });
  }
});

// The low side of the band ordering: criticalMin <= safeMin. Kept in its own helper because Phase 4 may make a
// parameter's bound one-sided (ALRT-03, e.g. turbidity has no meaningful "too low"), and will adjust this
// check rather than the high-side one.
function assertLowSideOrdered(label: string, t: Threshold) {
  assert.ok(t.criticalMin <= t.safeMin, `${label}: criticalMin ${t.criticalMin} > safeMin ${t.safeMin}`);
}

function assertHighSideOrdered(label: string, t: Threshold) {
  assert.ok(t.safeMin < t.safeMax, `${label}: safeMin ${t.safeMin} >= safeMax ${t.safeMax}`);
  assert.ok(t.safeMax <= t.criticalMax, `${label}: safeMax ${t.safeMax} > criticalMax ${t.criticalMax}`);
}

describe("threshold invariants over every parameter x profile", () => {
  for (const profile of PROFILES) {
    for (const id of PARAMETER_IDS) {
      test(`${profile}/${id}`, () => {
        const t = PARAMETER_THRESHOLDS[profile][id];
        assert.ok(t, `${profile} has no threshold for ${id}`);
        const label = `${profile}/${id}`;
        assertLowSideOrdered(label, t);
        assertHighSideOrdered(label, t);
        const bounds = PARAMETER_BOUNDS[id];
        assert.ok(t.safeMin >= bounds.min, `${label}: safe band below PARAMETER_BOUNDS.min`);
        assert.ok(t.safeMax <= bounds.max, `${label}: safe band above PARAMETER_BOUNDS.max`);
      });
    }
  }

  test("PARAMETER_DISPLAY has an entry per parameter id", () => {
    for (const id of PARAMETER_IDS) {
      const d = PARAMETER_DISPLAY[id];
      assert.ok(d, `no display entry for ${id}`);
      assert.equal(typeof d.label, "string");
      assert.equal(typeof d.unit, "string");
      assert.ok(Number.isInteger(d.precision));
    }
  });
});
