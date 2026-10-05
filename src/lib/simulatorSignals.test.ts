import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PH_CURVE,
  curveTimingWarnings,
  parseSpike,
  phCurveValue,
  simulatedFirmwareVersion,
  spikeFor,
} from "./simulatorSignals.ts";

const MINUTE = 60_000;
const DAY = PH_CURVE.dayMinutes * MINUTE;

// Deterministic mulberry32 so the noisy sweep is the same on every run.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("phCurveValue", () => {
  test("t=0 is the dawn minimum and half a cycle is the afternoon maximum", () => {
    assert.equal(phCurveValue(0, DAY, 0, 0), 6.2);
    assert.equal(phCurveValue(DAY / 2, DAY, 0, 0), 9.8);
  });

  test("a unitOffset of 0.25 shifts the phase by a quarter cycle", () => {
    assert.equal(phCurveValue(0, DAY, 0.25, 0), phCurveValue(DAY / 4, DAY, 0, 0));
    assert.equal(phCurveValue(0, DAY, 0.25, 0), 8);
  });

  test("a noisy one-cycle sweep stays inside 0..14 on 0.01 steps", () => {
    const random = seeded(42);
    for (let t = 0; t <= DAY; t += 1000) {
      const v = phCurveValue(t, DAY, 0, 0.05, random);
      assert.ok(v >= 0 && v <= 14, `out of bounds: ${v}`);
      assert.ok(Math.abs(Math.round(v * 100) - v * 100) < 1e-6, `not on a 0.01 step: ${v}`);
    }
  });

  test("a noiseless cycle spends about 18.6% below 6.5 and 18.6% above 9.5", () => {
    let below = 0;
    let above = 0;
    let total = 0;
    for (let t = 0; t < DAY; t += 1000) {
      const v = phCurveValue(t, DAY, 0, 0);
      if (v < 6.5) below++;
      if (v > 9.5) above++;
      total++;
    }
    assert.ok(Math.abs(below / total - 0.186) <= 0.01, `below share ${below / total}`);
    assert.ok(Math.abs(above / total - 0.186) <= 0.01, `above share ${above / total}`);
  });

  test("the 40-minute default is pinned", () => {
    assert.equal(PH_CURVE.dayMinutes, 40);
  });
});

describe("curveTimingWarnings", () => {
  test("the defaults (40 min day, 60 s interval) give no warning", () => {
    assert.deepEqual(curveTimingWarnings({ dayMs: 40 * MINUTE, intervalMs: 60_000 }), []);
  });

  test("a 30 min day is too short for recovery between excursions", () => {
    const warnings = curveTimingWarnings({ dayMs: 30 * MINUTE, intervalMs: 60_000 });
    assert.ok(warnings.some((w) => w.includes("ALERT_RECOVERY_MS")), warnings.join("\n"));
  });

  test("an interval over 90 s warns that held runs never form", () => {
    const warnings = curveTimingWarnings({ dayMs: 40 * MINUTE, intervalMs: 120_000 });
    assert.ok(warnings.some((w) => w.includes("90 s")), warnings.join("\n"));
  });
});

describe("parseSpike", () => {
  test("parses ph and turbidity specs", () => {
    assert.deepEqual(parseSpike("ph=5.5:4"), { parameter: "ph", value: 5.5, everyN: 4 });
    assert.deepEqual(parseSpike("turbidity=135.8:3"), { parameter: "turbidity", value: 135.8, everyN: 3 });
  });

  test("refuses malformed, out-of-bounds or unknown specs with an error string", () => {
    for (const bad of ["ph=15:4", "ph=5.5:1", "ph=5.5:x", "co2=1:3", "ph5.5:4", "ph=:4", "ph=5.5:2.5"]) {
      assert.equal(typeof parseSpike(bad), "string", bad);
    }
  });
});

describe("spikeFor", () => {
  const spikes = [{ parameter: "ph" as const, value: 5.5, everyN: 4 }];

  test("fires on every Nth report (1-based) only for its parameter", () => {
    assert.equal(spikeFor(spikes, "ph", 4), 5.5);
    assert.equal(spikeFor(spikes, "ph", 8), 5.5);
    for (const i of [1, 2, 3, 5]) assert.equal(spikeFor(spikes, "ph", i), undefined);
    assert.equal(spikeFor(spikes, "turbidity", 4), undefined);
  });

  test("the last matching spec wins", () => {
    const two = [...spikes, { parameter: "ph" as const, value: 10.2, everyN: 2 }];
    assert.equal(spikeFor(two, "ph", 4), 10.2);
    assert.equal(spikeFor(two, "ph", 2), 10.2);
  });
});

describe("simulatedFirmwareVersion", () => {
  test("0.7.0 when pH is reported, 0.6.1 without", () => {
    assert.equal(simulatedFirmwareVersion(true), "0.7.0");
    assert.equal(simulatedFirmwareVersion(false), "0.6.1");
  });
});
