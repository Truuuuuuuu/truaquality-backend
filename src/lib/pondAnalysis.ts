import { Prisma } from "../generated/prisma/client.ts";
import { describeAnalysis } from "./analysisSummary.ts";
import { isParameterId, thresholdsFor } from "./parameters.ts";
import { prisma } from "./prisma.ts";
import { rawRetentionDays } from "./readingRollup.ts";
import { analyzeSeries, previousRange, type ParameterAnalysis, type SeriesPoint } from "./seriesAnalysis.ts";

// The data and analysis behind GET /ponds/:id/series, GET /ponds/:id/analysis and the export's Summary sheet,
// in one place so the dashboard and the exported report can never show different numbers or sentences.

// Above this range, /series answers from raw Reading rows (below it, tiles/charts want per-minute
// resolution); beyond it, ReadingHourly rows are used instead — first at hourly grain, then daily once the
// range would otherwise mean thousands of hourly points.
const SERIES_RAW_MAX_RANGE_MS = 48 * 60 * 60 * 1000;
const SERIES_HOURLY_MAX_RANGE_MS = 92 * 24 * 60 * 60 * 1000;

// A hard ceiling on rows per response, independent of the range checks above. Those bound the
// *window*, not the row count: at a 30 s sampling interval with `parameter` omitted, 48 h of raw
// readings is already ~17k rows materialized in memory and serialized to JSON. 20k leaves headroom
// over every legitimate query while stopping one request from trying to page the whole table.
const SERIES_MAX_POINTS = 20_000;

// The day-resolution query had no row cap at all. The routes now refuse ranges over 2 years (schemas/ponds.ts),
// which is at most ~731 days x a handful of parameters; 5000 is a backstop above that for any other caller.
const SERIES_DAY_MAX_ROWS = 5000;

// A chart-ready series over an arbitrary range. Picks its own resolution — raw for a short, recent range;
// hourly (ReadingHourly) once the range would mean too many raw points or reaches past raw retention; daily
// once it would mean too many hourly points. Shared by /series, /analysis and the export so all read the same points.
export async function loadSeries(
  pondId: string,
  parameter: string | undefined,
  from: Date,
  end: Date,
): Promise<{ resolution: "raw" | "hour" | "day"; points: SeriesPoint[] }> {
  const rangeMs = end.getTime() - from.getTime();
  const rawCutoff = new Date(Date.now() - rawRetentionDays() * 24 * 60 * 60 * 1000);

  if (rangeMs <= SERIES_RAW_MAX_RANGE_MS && from >= rawCutoff) {
    // Ordered newest-first so that if the range holds more than SERIES_MAX_POINTS rows, `take` keeps
    // the most recent ones (what every caller of this endpoint actually wants — a recent-trend chart's
    // right edge, "now") instead of silently dropping them and keeping only the oldest, stalest points.
    const rows = await prisma.reading.findMany({
      where: { pondId, parameter, recordedAt: { gte: from, lte: end } },
      orderBy: { recordedAt: "desc" },
      take: SERIES_MAX_POINTS,
      select: { parameter: true, value: true, recordedAt: true },
    });
    rows.reverse();
    return {
      resolution: "raw",
      points: rows.map((row) => ({
        parameter: row.parameter,
        t: row.recordedAt,
        avg: row.value,
        min: row.value,
        max: row.value,
        count: 1,
      })),
    };
  }

  if (rangeMs <= SERIES_HOURLY_MAX_RANGE_MS) {
    const rows = await prisma.readingHourly.findMany({
      where: { pondId, parameter, bucketStart: { gte: from, lte: end } },
      orderBy: { bucketStart: "asc" },
      take: SERIES_MAX_POINTS,
      select: { parameter: true, bucketStart: true, min: true, max: true, sum: true, count: true },
    });
    return {
      resolution: "hour",
      points: rows.map((row) => ({
        parameter: row.parameter,
        t: row.bucketStart,
        avg: row.sum / row.count,
        min: row.min,
        max: row.max,
        count: row.count,
      })),
    };
  }

  const parameterFilter = parameter ? Prisma.sql`AND "parameter" = ${parameter}` : Prisma.empty;
  const rows = await prisma.$queryRaw<
    { parameter: string; bucket: Date; min: number; max: number; sum: number; count: number }[]
  >`
    SELECT "parameter", date_trunc('day', "bucketStart" AT TIME ZONE 'Asia/Manila') AS bucket,
           min("min") AS min, max("max") AS max, sum("sum") AS sum, sum("count")::int AS count
    FROM "ReadingHourly"
    WHERE "pondId" = ${pondId}::uuid AND "bucketStart" >= ${from} AND "bucketStart" <= ${end} ${parameterFilter}
    GROUP BY "parameter", bucket
    ORDER BY bucket ASC
    LIMIT ${SERIES_DAY_MAX_ROWS}
  `;
  return {
    resolution: "day",
    points: rows.map((row) => ({
      parameter: row.parameter,
      t: row.bucket,
      avg: row.sum / row.count,
      min: row.min,
      max: row.max,
      count: row.count,
    })),
  };
}

export type PondParameterAnalysis = ParameterAnalysis & { previousAvg: number | null; summary: string };

export type PondAnalysis = {
  from: Date;
  to: Date;
  previousFrom: Date;
  previousTo: Date;
  parameters: Record<string, PondParameterAnalysis>;
};

// Analysis of a range plus the equal-length period just before, judged against the pond's own thresholds
// (src/lib/seriesAnalysis.ts), each parameter also worded as sentences (src/lib/analysisSummary.ts). `rolling`
// is a "last N hours" window (the caller gave no end), so the summary names it that way instead of quoting dates.
export async function analyzePondRange({
  pondId,
  pondType,
  parameter,
  from,
  to,
  rolling,
}: {
  pondId: string;
  pondType: string | null;
  parameter?: string;
  from: Date;
  to: Date;
  rolling: boolean;
}): Promise<PondAnalysis> {
  const range = { from, to };
  const previous = previousRange(range);
  const [current, before] = await Promise.all([
    loadSeries(pondId, parameter, range.from, range.to),
    loadSeries(pondId, parameter, previous.from, previous.to),
  ]);
  const analysis = analyzeSeries(current.points, range, pondType);
  const previousAnalysis = analyzeSeries(before.points, previous, pondType);

  const thresholds = thresholdsFor(pondType);
  const parameters: Record<string, PondParameterAnalysis> = {};
  for (const [parameterId, result] of Object.entries(analysis)) {
    if (!isParameterId(parameterId)) continue;
    const withPrevious = { ...result, previousAvg: previousAnalysis[parameterId]?.avg ?? null };
    parameters[parameterId] = {
      ...withPrevious,
      summary: describeAnalysis(parameterId, withPrevious, thresholds[parameterId], { ...range, rolling }),
    };
  }
  return { from: range.from, to: range.to, previousFrom: previous.from, previousTo: previous.to, parameters };
}
