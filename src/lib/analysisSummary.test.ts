import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeAnalysis, type SummaryRange } from "./analysisSummary.ts";
import { thresholdsFor } from "./parameters.ts";
import type { ParameterAnalysis } from "./seriesAnalysis.ts";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2030-01-10T03:00:00Z"); // 11:00 AM in Manila
const thresholds = thresholdsFor(null);

function rolling(ms: number): SummaryRange {
  return { from: new Date(NOW.getTime() - ms), to: NOW, rolling: true };
}

function analysis(overrides: Partial<ParameterAnalysis & { previousAvg: number | null }>) {
  return {
    min: 25,
    max: 27.9,
    avg: 26.3,
    outOfRangeShare: 0,
    worst: "nominal" as const,
    trend: null,
    previousAvg: null,
    ...overrides,
  };
}

describe("describeAnalysis", () => {
  test("custom range, out of range part of the time, falling per day, no previous data", () => {
    const text = describeAnalysis(
      "temperature",
      analysis({
        min: 26.875,
        max: 35.125,
        avg: 29.69,
        outOfRangeShare: 0.494,
        worst: "warning",
        trend: { direction: "falling", rate: -0.25, rateUnit: "day" },
      }),
      thresholds.temperature,
      { from: new Date("2029-12-01T03:00:00Z"), to: new Date("2029-12-28T03:00:00Z"), rolling: false },
    );
    assert.equal(
      text,
      "From Dec 1, 11:00 AM to Dec 28, 11:00 AM, temperature averaged 29.7 °C and ranged from 26.9 to 35.1 °C. " +
        "It was outside the safe range (20.0–30.0 °C) for about 49% of readings, reaching warning level at worst. " +
        "Overall it was falling by about 0.3 °C per day.",
    );
  });

  test("rolling 24 h, in range, rising per hour, higher than the previous period", () => {
    const text = describeAnalysis(
      "temperature",
      analysis({ trend: { direction: "rising", rate: 0.8, rateUnit: "hr" }, previousAvg: 25.7 }),
      thresholds.temperature,
      rolling(24 * HOUR + 1500),
    );
    assert.equal(
      text,
      "In the last 24 hours, temperature averaged 26.3 °C and ranged from 25.0 to 27.9 °C. " +
        "It stayed within the safe range (20.0–30.0 °C) the whole time. " +
        "Overall it was rising by about 0.8 °C per hour. " +
        "Its average was 0.6 °C higher than in the 24 hours before.",
    );
  });

  test("turbidity is approximate, has no low side, and caps at the sensor ceiling", () => {
    const text = describeAnalysis(
      "turbidity",
      analysis({ min: 3, max: 3000, avg: 12, outOfRangeShare: 0.004, worst: "warning", previousAvg: 12.02 }),
      thresholds.turbidity,
      rolling(2 * HOUR),
    );
    assert.equal(
      text,
      "In the last 2 hours, turbidity averaged ≈ 12.0 NTU and ranged from 3.0 to ≥ 3000 NTU. " +
        "It was outside the safe range (up to 25.0 NTU) for less than 1% of readings, reaching warning level at worst. " +
        "There aren't enough readings in this range to tell whether it is rising or falling. " +
        "Its average was about the same as in the 2 hours before.",
    );
  });

  test("a constant value over 7 days reads as held at, steady", () => {
    const text = describeAnalysis(
      "temperature",
      analysis({ min: 26, max: 26, avg: 26, trend: { direction: "stable", rate: 0.01, rateUnit: "hr" } }),
      thresholds.temperature,
      rolling(7 * 24 * HOUR),
    );
    assert.equal(
      text,
      "In the last 7 days, temperature held at 26.0 °C. It stayed within the safe range (20.0–30.0 °C) the whole time. " +
        "Overall it held steady.",
    );
  });

  test("a spike inside an in-range hour reads as briefly reached", () => {
    const text = describeAnalysis("temperature", analysis({ worst: "critical" }), thresholds.temperature, rolling(HOUR * 72));
    assert.match(text, /It stayed within the safe range \(20\.0–30\.0 °C\) on average, but briefly reached critical level\./);
    assert.match(text, /^In the last 3 days,/);
  });

  test("a trend whose rate rounds to zero reads as slowly; lower than before", () => {
    const text = describeAnalysis(
      "temperature",
      analysis({ trend: { direction: "rising", rate: 0.04, rateUnit: "day" }, previousAvg: 27 }),
      thresholds.temperature,
      { from: new Date("2029-12-01T16:00:00Z"), to: new Date("2029-12-08T16:00:00Z"), rolling: false },
    );
    assert.match(text, /^From Dec 2 to Dec 9,/);
    assert.match(text, /Overall it was rising slowly\./);
    assert.match(text, /Its average was 0\.7 °C lower than in the same length of time before\./);
  });
});
