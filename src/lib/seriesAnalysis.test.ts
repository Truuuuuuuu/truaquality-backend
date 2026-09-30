import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { analyzeSeries, linearTrend, previousRange, type SeriesPoint } from "./seriesAnalysis.ts";

const START = new Date("2030-01-01T00:00:00Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const after = (ms: number) => new Date(START.getTime() + ms);

// Raw-resolution temperature points, one a minute, value from `f(minute)`.
function rawTemperature(minutes: number, f: (i: number) => number): SeriesPoint[] {
  return Array.from({ length: minutes }, (_, i) => {
    const v = f(i);
    return { parameter: "temperature", t: after(i * MINUTE), avg: v, min: v, max: v, count: 1 };
  });
}

const TWO_HOURS = { from: START, to: after(2 * HOUR) };

describe("linearTrend", () => {
  test("recovers an exact slope", () => {
    const fit = linearTrend([
      { t: 0, v: 1 },
      { t: HOUR, v: 3 },
      { t: 2 * HOUR, v: 5 },
    ]);
    assert.ok(fit);
    assert.ok(Math.abs(fit.slopePerMs * HOUR - 2) < 1e-9);
    assert.ok(Math.abs(fit.fittedChange - 4) < 1e-9);
    assert.equal(fit.coveredMs, 2 * HOUR);
  });
  test("is null for one point or no time spread", () => {
    assert.equal(linearTrend([{ t: 0, v: 1 }]), null);
    assert.equal(
      linearTrend([
        { t: 5, v: 1 },
        { t: 5, v: 2 },
      ]),
      null,
    );
  });
  test("stays exact with epoch-millisecond timestamps", () => {
    const t0 = START.getTime();
    const fit = linearTrend(Array.from({ length: 120 }, (_, i) => ({ t: t0 + i * MINUTE, v: 25 + (i / 60) * 0.8 })));
    assert.ok(fit);
    assert.ok(Math.abs(fit.slopePerMs * HOUR - 0.8) < 1e-9);
  });
});

describe("analyzeSeries trend", () => {
  test("rising temperature over 2 h reports rising at +0.8 °C/hr", () => {
    const result = analyzeSeries(rawTemperature(120, (i) => 25 + (i / 60) * 0.8), TWO_HOURS, null);
    const trend = result.temperature.trend;
    assert.ok(trend);
    assert.equal(trend.direction, "rising");
    assert.equal(trend.rateUnit, "hr");
    assert.ok(Math.abs(trend.rate - 0.8) < 1e-9);
  });
  test("falling temperature reports falling with a negative rate", () => {
    const trend = analyzeSeries(rawTemperature(120, (i) => 25 - (i / 60) * 0.8), TWO_HOURS, null).temperature.trend;
    assert.equal(trend?.direction, "falling");
    assert.ok(trend && trend.rate < 0);
  });
  test("a change under 5% of the 20–30 °C safe band (0.5 °C) is stable", () => {
    // 0.4 °C over the range.
    const trend = analyzeSeries(rawTemperature(120, (i) => 25 + (i / 119) * 0.4), TWO_HOURS, null).temperature.trend;
    assert.equal(trend?.direction, "stable");
  });
  test("a change just over 0.5 °C is not stable", () => {
    const trend = analyzeSeries(rawTemperature(120, (i) => 25 + (i / 119) * 0.6), TWO_HOURS, null).temperature.trend;
    assert.equal(trend?.direction, "rising");
  });
  test("a 30-minute burst inside a 7-day range reports no trend", () => {
    const result = analyzeSeries(rawTemperature(30, (i) => 27 + i / 10), { from: START, to: after(7 * DAY) }, null);
    assert.equal(result.temperature.trend, null);
  });
  test("readings covering half the range are enough", () => {
    const result = analyzeSeries(rawTemperature(61, (i) => 25 + i / 60), TWO_HOURS, null);
    assert.equal(result.temperature.trend?.direction, "rising");
  });
  test("ranges over 48 h report a per-day rate", () => {
    const points: SeriesPoint[] = Array.from({ length: 168 }, (_, i) => ({
      parameter: "temperature",
      t: after(i * HOUR),
      avg: 25 + i / 24,
      min: 25 + i / 24,
      max: 25 + i / 24,
      count: 60,
    }));
    const trend = analyzeSeries(points, { from: START, to: after(7 * DAY) }, null).temperature.trend;
    assert.equal(trend?.rateUnit, "day");
    assert.ok(trend && Math.abs(trend.rate - 1) < 1e-9);
  });
});

describe("analyzeSeries stats", () => {
  test("raw readings: min, max, avg and out-of-range share", () => {
    // 25, 25, 32, 25 — 32 is above the 30 °C safe max.
    const values = [25, 25, 32, 25];
    const result = analyzeSeries(rawTemperature(4, (i) => values[i]), TWO_HOURS, null).temperature;
    assert.equal(result.min, 25);
    assert.equal(result.max, 32);
    assert.equal(result.avg, 26.75);
    assert.equal(result.outOfRangeShare, 0.25);
    assert.equal(result.worst, "warning");
  });
  test("hourly buckets: avg is weighted by reading count, min/max are the bucket extremes", () => {
    const points: SeriesPoint[] = [
      { parameter: "temperature", t: after(0), avg: 24, min: 23, max: 25, count: 60 },
      { parameter: "temperature", t: after(HOUR), avg: 28, min: 27, max: 29, count: 20 },
    ];
    const result = analyzeSeries(points, { from: START, to: after(3 * DAY) }, null).temperature;
    assert.equal(result.avg, 25);
    assert.equal(result.min, 23);
    assert.equal(result.max, 29);
  });
  test("a spike inside an in-range hour still sets worst", () => {
    const points: SeriesPoint[] = [
      { parameter: "temperature", t: after(0), avg: 26, min: 25, max: 37, count: 60 },
    ];
    const result = analyzeSeries(points, { from: START, to: after(3 * DAY) }, null).temperature;
    assert.equal(result.outOfRangeShare, 0);
    assert.equal(result.worst, "critical");
  });
  test("parameters without points and unknown parameter ids are omitted", () => {
    const points: SeriesPoint[] = [
      ...rawTemperature(2, () => 25),
      { parameter: "salinity", t: START, avg: 1, min: 1, max: 1, count: 1 },
    ];
    const result = analyzeSeries(points, TWO_HOURS, null);
    assert.deepEqual(Object.keys(result), ["temperature"]);
  });
});

describe("previousRange", () => {
  test("is the equal-length range ending where this one starts", () => {
    const previous = previousRange({ from: after(DAY), to: after(2 * DAY) });
    assert.deepEqual(previous, { from: START, to: after(DAY) });
  });
});
