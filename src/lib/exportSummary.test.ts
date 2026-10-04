import assert from "node:assert/strict";
import { describe, test } from "node:test";
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
    assert.equal(SUMMARY_HEADERS.length, 10);
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
      { value: "In the last 7 days, temperature averaged 29.0 °C…" },
    ]);
  });

  test("the interpretation is the same text the dashboard shows", () => {
    const [row] = summaryRows(["temperature"], { temperature });
    assert.equal(row?.[9]?.value, temperature.summary);
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
    assert.equal(rows[1]?.[9]?.value, "No readings in this range.");
    assert.ok(rows[1]!.slice(1, 9).every((cell) => cell.value === null));
  });

  test("steady and critical use plain labels", () => {
    const [row] = summaryRows(["temperature"], {
      temperature: { ...temperature, worst: "critical", trend: { direction: "stable", rate: 0.01, rateUnit: "hr" } },
    });
    assert.deepEqual(row?.[5], { value: "Critical" });
    assert.deepEqual(row?.[6], { value: "Steady" });
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
      { value: "In the last 24 hours, pH averaged 7.84…" },
    ]);
  });
});
