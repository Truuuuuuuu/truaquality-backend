import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { analyzeSeries } from "./seriesAnalysis.ts";
import { excelNumberFormat, SUMMARY_HEADERS, summaryRows } from "./exportSummary.ts";
import type { PondParameterAnalysis } from "./pondAnalysis.ts";

const temperature: PondParameterAnalysis = {
  min: 27.9,
  max: 30,
  avg: 29,
  outOfRangeShare: 0.25,
  worst: "warning",
  trend: { direction: "rising", rate: 0.7, rateUnit: "day" },
  previousAvg: 31,
  summary: "In the last 7 days, temperature averaged 29.0 °C…",
};

describe("summaryRows", () => {
  test("headers end with the interpretation column", () => {
    assert.equal(SUMMARY_HEADERS.length, 14);
    assert.equal(SUMMARY_HEADERS.at(-1), "Interpretation");
  });

  test("a parameter with data: numbers keep their unit format, labels are plain words", () => {
    const [row] = summaryRows(["temperature"], { temperature });
    assert.deepEqual(row, [
      { value: "Temperature" },
      { value: 27.9, numFmt: '0.0" °C"' },
      { value: 30, numFmt: '0.0" °C"' },
      { value: 29, numFmt: '0.0" °C"' },
      { value: 0.25, numFmt: "0%" },
      { value: "Warning" },
      { value: "Rising" },
      { value: 0.7, numFmt: '+0.0" °C/day";-0.0" °C/day";0.0" °C/day"' },
      { value: -2, numFmt: '+0.0" °C";-0.0" °C";0.0" °C"' },
      { value: null, numFmt: "0%" },
      { value: null },
      { value: null, numFmt: '0.0" °C"' },
      { value: null },
      { value: "In the last 7 days, temperature averaged 29.0 °C…" },
    ]);
  });

  test("the interpretation is the same text the dashboard shows", () => {
    const [row] = summaryRows(["temperature"], { temperature });
    assert.equal(row?.[13]?.value, temperature.summary);
  });

  test("no trend and no previous data read as words, not blanks that look like zero", () => {
    const [row] = summaryRows(["temperature"], {
      temperature: { ...temperature, trend: null, previousAvg: null },
    });
    assert.deepEqual(row?.[6], { value: "Not enough data" });
    assert.deepEqual(row?.[7], { value: null });
    assert.deepEqual(row?.[8], { value: "No data before" });
  });

  test("an hourly rate is labelled per hour", () => {
    const [row] = summaryRows(["temperature"], {
      temperature: { ...temperature, trend: { direction: "falling", rate: -0.8, rateUnit: "hr" } },
    });
    assert.deepEqual(row?.[6], { value: "Falling" });
    assert.equal(row?.[7]?.numFmt, '+0.0" °C/hour";-0.0" °C/hour";0.0" °C/hour"');
  });

  test("a parameter with no readings still gets a row saying so", () => {
    const rows = summaryRows(["temperature", "turbidity"], { temperature });
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.[0]?.value, "Turbidity (NTU, approx.)");
    assert.equal(rows[1]?.[13]?.value, "No readings in this range.");
    assert.ok(rows[1]!.slice(1, 13).every((cell) => cell.value === null));
  });

  test("steady and critical use plain labels", () => {
    const [row] = summaryRows(["temperature"], {
      temperature: { ...temperature, worst: "critical", trend: { direction: "stable", rate: 0.01, rateUnit: "hr" } },
    });
    assert.deepEqual(row?.[5], { value: "Critical" });
    assert.deepEqual(row?.[6], { value: "Steady" });
  });
});

describe("DO reference summary columns", () => {
  const from = new Date("2030-01-01T00:00:00Z");
  for (const resolution of ["raw", "hour", "day"] as const) {
    test(`${resolution} preserves independent strict comparison and pending assessed cells`, () => {
      const result = analyzeSeries([0, 5, 7.23].map((value, i) => ({ parameter: "dissolvedOxygen", t: new Date(+from + i * 1000), avg: value, min: value, max: value, count: 1 })), { from, to: new Date(+from + 3000) }, null, undefined, resolution).dissolvedOxygen!;
      const [row] = summaryRows(["dissolvedOxygen"], { dissolvedOxygen: { ...result, previousAvg: null, previousChange: null, summary: "Alert assessment pending" } }, resolution);
      assert.equal(row!.length, SUMMARY_HEADERS.length);
      assert.equal(row![4]!.value, null);
      assert.equal(row![5]!.value, "Pending BFAR thresholds");
      assert.equal(row![6]!.value, "Not assessed");
      assert.equal(row![8]!.value, "No data before");
      assert.equal(row![9]!.value, 2 / 3);
      assert.equal(row![10]!.value, resolution === "raw" ? "Raw samples" : `Approximate, based on ${resolution === "hour" ? "hourly" : "daily"} averages (count-weighted)`);
      assert.deepEqual(row![11], { value: 0, numFmt: '0.00" mg/L"' });
      assert.equal(row![12]!.value, "Outside normal range");
    });
  }
  test("zero reference share and previous change stay numeric, missing reference stays blank", () => {
    const result = analyzeSeries([{ parameter: "dissolvedOxygen", t: from, avg: 7.23, min: 7.23, max: 7.23, count: 1 }], { from, to: new Date(+from + 1000) }, null, undefined, "raw").dissolvedOxygen!;
    const value = { ...result, previousAvg: 7.23, previousChange: 0, summary: "pending" };
    const [row] = summaryRows(["dissolvedOxygen"], { dissolvedOxygen: value });
    assert.equal(row![8]!.value, 0);
    assert.equal(row![9]!.value, 0);
    const [missing] = summaryRows(["dissolvedOxygen"], { dissolvedOxygen: { ...value, referenceComparison: { outsideShare: null, basis: "raw_samples", approximate: false, minimumResult: null } } });
    assert.equal(missing![9]!.value, null);
    assert.equal(missing![10]!.value, null);
  });
});

describe("excelNumberFormat", () => {
  test("temperature and turbidity keep their quoted unit suffix", () => {
    assert.equal(excelNumberFormat("temperature"), '0.0" °C"');
    assert.equal(excelNumberFormat("temperature", "/hour"), '0.0" °C/hour"');
    assert.equal(excelNumberFormat("turbidity"), '0.0" NTU"');
  });

  test("a unitless parameter gets a bare number format, and its rate is worded with the label", () => {
    assert.equal(excelNumberFormat("ph"), "0.00");
    assert.equal(excelNumberFormat("ph", "/hour"), '0.00" pH/hour"');
    assert.equal(excelNumberFormat("ph", "/day"), '0.00" pH/day"');
  });
});

describe("summaryRows — pH (unitless)", () => {
  const ph: PondParameterAnalysis = {
    min: 6.2,
    max: 9.8,
    avg: 7.84,
    outOfRangeShare: 0.1,
    worst: "warning",
    trend: { direction: "rising", rate: 0.12, rateUnit: "hr" },
    previousAvg: 7.5,
    summary: "In the last 24 hours, pH averaged 7.84…",
  };

  test("value cells have no unit suffix, rate reads pH/hour, change is a bare signed number", () => {
    const [row] = summaryRows(["ph"], { ph });
    assert.deepEqual(row, [
      { value: "pH" },
      { value: 6.2, numFmt: "0.00" },
      { value: 9.8, numFmt: "0.00" },
      { value: 7.84, numFmt: "0.00" },
      { value: 0.1, numFmt: "0%" },
      { value: "Warning" },
      { value: "Rising" },
      { value: 0.12, numFmt: '+0.00" pH/hour";-0.00" pH/hour";0.00" pH/hour"' },
      { value: 7.84 - 7.5, numFmt: "+0.00;-0.00;0.00" },
      { value: null, numFmt: "0%" },
      { value: null },
      { value: null, numFmt: "0.00" },
      { value: null },
      { value: "In the last 24 hours, pH averaged 7.84…" },
    ]);
  });
});
