import { isParameterId, severityFor, thresholdsFor } from "./parameters.ts";

// One chart point as /series builds it. `count` is how many readings the point summarizes: 1 at raw
// resolution, the bucket's reading count for hourly/daily points, so averages can be weighted by it.
export type SeriesPoint = { parameter: string; t: Date; avg: number; min: number; max: number; count: number };

export type TrendDirection = "rising" | "falling" | "stable";

export type Trend = {
  direction: TrendDirection;
  // Signed rate in the parameter's own unit per `rateUnit`.
  rate: number;
  rateUnit: "hr" | "day";
};

export type ParameterAnalysis = {
  min: number;
  max: number;
  avg: number;
  outOfRangeShare: number;
  worst: "nominal" | "warning" | "critical";
  trend: Trend | null;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A change smaller than this share of the safe band's width counts as "stable". Tying the deadband to the
// pond's safe band (rather than a fixed per-parameter number) scales it with how much movement actually
// matters for that parameter: 0.5 °C on a 20–30 °C band, 1.25 NTU on a 0–25 NTU band.
export const STABLE_SHARE_OF_SAFE_BAND = 0.05;

// A fit through a short burst of readings says nothing about the range around it: 30 minutes of warm-up
// inside a 7-day window extrapolated to "+55 °C/day" on the dashboard. So a trend is only reported when the
// readings span at least this share of the requested range.
export const MIN_TREND_COVERAGE = 0.5;

// Per hour reads naturally up to a two-day range; past that, hourly rates get too small to show at a
// parameter's display precision, so the rate switches to per day. Same 48 h edge as /series' raw resolution.
const HOURLY_RATE_MAX_RANGE_MS = 2 * DAY_MS;

// Ordinary least-squares line through (t, v). Time is centered on its mean first: epoch milliseconds
// squared lose precision in a double, which would turn the slope into noise.
export function linearTrend(
  points: { t: number; v: number }[],
): { slopePerMs: number; fittedChange: number; coveredMs: number } | null {
  const n = points.length;
  if (n < 2) return null;
  let tSum = 0;
  let vSum = 0;
  for (const { t, v } of points) {
    tSum += t;
    vSum += v;
  }
  const tMean = tSum / n;
  const vMean = vSum / n;
  let sxy = 0;
  let sxx = 0;
  let tFirst = Infinity;
  let tLast = -Infinity;
  for (const { t, v } of points) {
    const dt = t - tMean;
    sxy += dt * (v - vMean);
    sxx += dt * dt;
    tFirst = Math.min(tFirst, t);
    tLast = Math.max(tLast, t);
  }
  if (sxx === 0) return null;
  const slopePerMs = sxy / sxx;
  const coveredMs = tLast - tFirst;
  return { slopePerMs, fittedChange: slopePerMs * coveredMs, coveredMs };
}

function trendFor(
  points: { t: number; v: number }[],
  rangeMs: number,
  safeBand: { safeMin: number; safeMax: number },
): Trend | null {
  const fit = linearTrend(points);
  if (fit === null || fit.coveredMs < rangeMs * MIN_TREND_COVERAGE) return null;
  const deadband = (safeBand.safeMax - safeBand.safeMin) * STABLE_SHARE_OF_SAFE_BAND;
  const direction: TrendDirection =
    Math.abs(fit.fittedChange) < deadband ? "stable" : fit.fittedChange > 0 ? "rising" : "falling";
  const rateUnit = rangeMs <= HOURLY_RATE_MAX_RANGE_MS ? "hr" : "day";
  return { direction, rate: fit.slopePerMs * (rateUnit === "hr" ? HOUR_MS : DAY_MS), rateUnit };
}

function worseOf(a: ParameterAnalysis["worst"], b: "WARNING" | "CRITICAL" | null): ParameterAnalysis["worst"] {
  if (a === "critical" || b === "CRITICAL") return "critical";
  if (a === "warning" || b === "WARNING") return "warning";
  return "nominal";
}

// Summary of each parameter over a range, judged against the pond's own thresholds.
//
// - min/max are the true extremes (a bucket's own min/max), not the extremes of its average.
// - avg is weighted by each point's reading count, so an hourly bucket holding 60 readings outweighs one
//   holding 5 — the average of the readings, not of the plotted points.
// - outOfRangeShare is the share of readings whose point average left the safe band: exact at raw
//   resolution, approximate for hourly/daily buckets (an hour averaging in range may still hold a spike).
// - worst also counts a bucket's min/max, so a spike inside an hour still reaches it.
// - trend is fitted through the plotted averages.
export function analyzeSeries(
  points: SeriesPoint[],
  range: { from: Date; to: Date },
  pondType: string | null | undefined,
): Record<string, ParameterAnalysis> {
  const byParameter = new Map<string, SeriesPoint[]>();
  for (const point of points) {
    const list = byParameter.get(point.parameter) ?? [];
    list.push(point);
    byParameter.set(point.parameter, list);
  }

  const thresholds = thresholdsFor(pondType);
  const rangeMs = range.to.getTime() - range.from.getTime();
  const result: Record<string, ParameterAnalysis> = {};
  for (const [parameter, list] of byParameter) {
    if (!isParameterId(parameter)) continue;
    let min = Infinity;
    let max = -Infinity;
    let weightedSum = 0;
    let readings = 0;
    let outOfRange = 0;
    let worst: ParameterAnalysis["worst"] = "nominal";
    for (const point of list) {
      min = Math.min(min, point.min);
      max = Math.max(max, point.max);
      weightedSum += point.avg * point.count;
      readings += point.count;
      if (severityFor(parameter, point.avg, pondType) !== null) outOfRange += point.count;
      worst = worseOf(worst, severityFor(parameter, point.min, pondType));
      worst = worseOf(worst, severityFor(parameter, point.max, pondType));
    }
    if (readings === 0) continue;
    result[parameter] = {
      min,
      max,
      avg: weightedSum / readings,
      outOfRangeShare: outOfRange / readings,
      worst,
      trend: trendFor(
        list.map((point) => ({ t: point.t.getTime(), v: point.avg })),
        rangeMs,
        thresholds[parameter],
      ),
    };
  }
  return result;
}

// The equal-length range just before `range`. Same width means /series' resolution rule picks the same
// grain for both, so their averages compare like with like.
export function previousRange(range: { from: Date; to: Date }): { from: Date; to: Date } {
  const width = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - width), to: range.from };
}
