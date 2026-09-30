import { PARAMETER_DISPLAY, type ParameterId, type Threshold } from "./parameters.ts";
import type { ParameterAnalysis } from "./seriesAnalysis.ts";

// Words one parameter's analysis as a short paragraph for staff who'd rather read "falling by about 0.3 °C per
// day" than decode the chart's stats row. Built here, next to the analysis it describes, so the wording is covered
// by the backend tests and can be reused by other outputs (export, notifications) without a second copy.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// BFAR Sorsogon is in one time zone; the daily /series buckets already use it.
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric" });
const TIME_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });

// "Sep 1" at midnight, "Sep 1, 11:00 AM" otherwise — same as the dashboard's range chip.
function formatDateTime(date: Date): string {
  const time = TIME_FORMAT.format(date);
  return time === "12:00 AM" ? DATE_FORMAT.format(date) : `${DATE_FORMAT.format(date)}, ${time}`;
}

// A rolling range's `from` is resolved off the client's clock, so its width is only approximately 24 h; round
// to the hour before naming it.
function spanPhrase(ms: number): string {
  const hours = Math.max(1, Math.round(ms / HOUR_MS));
  if (hours % 24 === 0) return hours === 24 ? "24 hours" : `${hours / 24} days`;
  return hours === 1 ? "hour" : `${hours} hours`;
}

export type SummaryRange = {
  from: Date;
  to: Date;
  // True when the caller asked for "the last N hours" (no `to`), so the summary says so rather than quoting dates.
  rolling: boolean;
};

function rangePhrase(range: SummaryRange): string {
  return range.rolling
    ? `In the last ${spanPhrase(range.to.getTime() - range.from.getTime())}`
    : `From ${formatDateTime(range.from)} to ${formatDateTime(range.to)}`;
}

function previousPhrase(range: SummaryRange): string {
  return range.rolling
    ? `the ${spanPhrase(range.to.getTime() - range.from.getTime())} before`
    : "the same length of time before";
}

function sharePhrase(share: number): string {
  return share < 0.01 ? "less than 1%" : `about ${Math.round(share * 100)}%`;
}

export function describeAnalysis(
  parameter: ParameterId,
  analysis: ParameterAnalysis & { previousAvg: number | null },
  threshold: Threshold,
  range: SummaryRange,
): string {
  const { label, unit, precision, approximate, sensorCeiling } = PARAMETER_DISPLAY[parameter];
  const atCeiling = (v: number) => sensorCeiling !== undefined && v >= sensorCeiling;
  const number = (v: number) => (atCeiling(v) ? `≥ ${sensorCeiling}` : v.toFixed(precision));
  // "≥ 3000" already says the value is a bound, so it drops the "≈".
  const value = (v: number) => `${approximate && !atCeiling(v) ? "≈ " : ""}${number(v)} ${unit}`;
  const amount = (v: number) => `${Math.abs(v).toFixed(precision)} ${unit}`;
  const name = label.toLowerCase();
  const sentences: string[] = [];

  sentences.push(
    analysis.min === analysis.max
      ? `${rangePhrase(range)}, ${name} held at ${value(analysis.avg)}.`
      : `${rangePhrase(range)}, ${name} averaged ${value(analysis.avg)} and ranged from ${number(analysis.min)} to ${value(analysis.max)}.`,
  );

  // A parameter whose safe and critical minimums coincide has no low-side band (turbidity: lower is clearer
  // water), so its safe range reads as a ceiling.
  const safeRange =
    threshold.safeMin === threshold.criticalMin
      ? `up to ${amount(threshold.safeMax)}`
      : `${threshold.safeMin.toFixed(precision)}–${amount(threshold.safeMax)}`;
  if (analysis.outOfRangeShare > 0) {
    sentences.push(
      `It was outside the safe range (${safeRange}) for ${sharePhrase(analysis.outOfRangeShare)} of readings, reaching ${analysis.worst} level at worst.`,
    );
  } else if (analysis.worst !== "nominal") {
    sentences.push(`It stayed within the safe range (${safeRange}) on average, but briefly reached ${analysis.worst} level.`);
  } else {
    sentences.push(`It stayed within the safe range (${safeRange}) the whole time.`);
  }

  const trend = analysis.trend;
  if (trend === null) {
    sentences.push("There aren't enough readings in this range to tell whether it is rising or falling.");
  } else if (trend.direction === "stable") {
    sentences.push("Overall it held steady.");
  } else {
    const rate = Math.abs(trend.rate).toFixed(precision);
    const per = trend.rateUnit === "hr" ? "hour" : "day";
    sentences.push(
      Number(rate) === 0
        ? `Overall it was ${trend.direction} slowly.`
        : `Overall it was ${trend.direction} by about ${rate} ${unit} per ${per}.`,
    );
  }

  if (analysis.previousAvg !== null) {
    const difference = analysis.avg - analysis.previousAvg;
    sentences.push(
      Number(Math.abs(difference).toFixed(precision)) === 0
        ? `Its average was about the same as in ${previousPhrase(range)}.`
        : `Its average was ${amount(difference)} ${difference > 0 ? "higher" : "lower"} than in ${previousPhrase(range)}.`,
    );
  }

  return sentences.join(" ");
}
