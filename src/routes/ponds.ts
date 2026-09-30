import { Router } from "express";
import type { z } from "zod";
import { Prisma } from "../generated/prisma/client.ts";
import { deviceSummarySelect, reportedStatuses } from "../lib/devices.ts";
import { PARAMETER_IDS, thresholdsFor } from "../lib/parameters.ts";
import { prisma } from "../lib/prisma.ts";
import { rawRetentionDays } from "../lib/readingRollup.ts";
import { analyzeSeries, previousRange, type ParameterAnalysis, type SeriesPoint } from "../lib/seriesAnalysis.ts";
import { streamReadingsExport, validateExportRange } from "../lib/readingsExport.ts";
import { decodeReadingsCursor, encodeReadingsCursor, type ReadingsCursor } from "../lib/readingsCursor.ts";
import { readingsExportRateLimit } from "../middleware/loginRateLimit.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { validate } from "../middleware/validate.ts";
import { pondIdParams, readingsExportQuery, readingsPageQuery, seriesQuery } from "../schemas/ponds.ts";

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

export const pondsRouter = Router();

pondsRouter.use(requireAuth);

type LatestReading = { value: number; recordedAt: Date };
type LatestRow = LatestReading & { pondId: string; parameter: string };

// Latest value of every parameter for each pond. A LATERAL ... LIMIT 1 per (pond, parameter) walks the
// (pondId, parameter, recordedAt DESC) index straight to the newest row, so it stays fast as history grows
// — unlike DISTINCT ON, which reads every row for the pond.
async function latestReadingsByPond(pondIds: string[]) {
  const byPond = new Map<string, Record<string, LatestReading>>();
  if (pondIds.length === 0) return byPond;

  const rows = await prisma.$queryRaw<LatestRow[]>`
    SELECT p.id AS "pondId", k.parameter, r.value, r."recordedAt"
    FROM unnest(${pondIds}::uuid[]) AS p(id)
    CROSS JOIN unnest(${PARAMETER_IDS}::text[]) AS k(parameter)
    CROSS JOIN LATERAL (
      SELECT value, "recordedAt"
      FROM "Reading"
      WHERE "pondId" = p.id AND parameter = k.parameter
      ORDER BY "recordedAt" DESC
      LIMIT 1
    ) r
  `;

  for (const row of rows) {
    const latest = byPond.get(row.pondId) ?? {};
    latest[row.parameter] = { value: row.value, recordedAt: row.recordedAt };
    byPond.set(row.pondId, latest);
  }
  return byPond;
}

// The pond payloads select the unit's raw sensorStatus column alongside its summary so the board can show why a
// single probe went silent (the unit's own last word on each sensor) on its normal 30 s poll, without a per-pond
// diagnostics fetch. The raw Json never reaches the client: it is stripped off `device` and re-exposed as a
// top-level `sensorStatus` of status tokens only (ok, uncalibrated, no_signal, over_range, ...). A sensor absent
// from the map was never reported by this unit; a pond with no device, or a unit that never reported, gets {}.
const pondDeviceSelect = { ...deviceSummarySelect, sensorStatus: true } satisfies Prisma.DeviceSelect;

type PondWithDevice = Prisma.PondGetPayload<{ include: { device: { select: typeof pondDeviceSelect } } }>;

function toPondPayload(pond: PondWithDevice, latest: Record<string, LatestReading>) {
  const { device, ...rest } = pond;
  let summary: Omit<NonNullable<PondWithDevice["device"]>, "sensorStatus"> | null = null;
  let sensorStatus: Record<string, string> = {};
  if (device) {
    const { sensorStatus: raw, ...deviceSummary } = device;
    summary = deviceSummary;
    sensorStatus = reportedStatuses(raw);
  }
  // `thresholds` rides alongside `latest` so the dashboard colors a reading by the same numbers that raise
  // its alerts, instead of keeping a second hand-synced copy of them in the frontend.
  return { ...rest, device: summary, latest, thresholds: thresholdsFor(pond.pondType), sensorStatus };
}

pondsRouter.get("/", async (_req, res) => {
  const ponds = await prisma.pond.findMany({
    orderBy: { name: "asc" },
    include: { device: { select: pondDeviceSelect } },
  });
  const latest = await latestReadingsByPond(ponds.map((pond) => pond.id));
  res.json({ ponds: ponds.map((pond) => toPondPayload(pond, latest.get(pond.id) ?? {})) });
});

pondsRouter.get("/:id", validate(pondIdParams, "params"), async (req, res) => {
  const { id } = req.params as z.infer<typeof pondIdParams>;

  const pond = await prisma.pond.findUnique({
    where: { id },
    include: { device: { select: pondDeviceSelect } },
  });
  if (!pond) {
    return res.status(404).json({ error: "pond not found" });
  }

  const latest = await latestReadingsByPond([id]);
  res.json({ pond: toPondPayload(pond, latest.get(id) ?? {}) });
});

// Newest-first, keyset-paginated log of raw readings (what the pond detail page's history table shows).
// `before`, from a previous page's `nextCursor`, resumes past that row; omit it for the first page. Only
// reaches back as far as raw retention goes — see /series and /readings/export for longer ranges. `from`/`to`
// narrow the scan to a date/time range; the cursor still walks page to page within that range.
pondsRouter.get(
  "/:id/readings",
  validate(pondIdParams, "params"),
  validate(readingsPageQuery, "query"),
  async (req, res) => {
    const { id } = req.params as z.infer<typeof pondIdParams>;
    const { parameter, before, limit, from, to } = res.locals.query as z.infer<typeof readingsPageQuery>;

    if (from && to && from > to) {
      return res.status(400).json({ error: "from must be before to" });
    }

    const pond = await prisma.pond.findUnique({ where: { id }, select: { id: true } });
    if (!pond) {
      return res.status(404).json({ error: "pond not found" });
    }

    let cursor: ReadingsCursor | null = null;
    if (before) {
      cursor = decodeReadingsCursor(before);
      if (!cursor) return res.status(400).json({ error: "invalid cursor" });
    }

    const rows = await prisma.reading.findMany({
      where: {
        pondId: id,
        parameter,
        ...(from || to ? { recordedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(cursor
          ? {
              OR: [
                { recordedAt: { lt: cursor.recordedAt } },
                { recordedAt: cursor.recordedAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: { id: true, parameter: true, value: true, recordedAt: true },
    });

    const last = rows.at(-1);
    const nextCursor = last && rows.length === limit ? encodeReadingsCursor({ recordedAt: last.recordedAt, id: last.id }) : null;

    res.json({
      readings: rows.map(({ parameter, value, recordedAt }) => ({ parameter, value, recordedAt })),
      nextCursor,
    });
  },
);

// A chart-ready series over an arbitrary range. Picks its own resolution — raw for a short, recent range;
// hourly (ReadingHourly) once the range would mean too many raw points or reaches past raw retention; daily
// once it would mean too many hourly points. Shared by /series and /analysis so both read the same points.
async function loadSeries(
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

pondsRouter.get(
  "/:id/series",
  validate(pondIdParams, "params"),
  validate(seriesQuery, "query"),
  async (req, res) => {
    const { id } = req.params as z.infer<typeof pondIdParams>;
    const { parameter, from, to } = res.locals.query as z.infer<typeof seriesQuery>;
    const end = to ?? new Date();
    if (from > end) {
      return res.status(400).json({ error: "from must be before to" });
    }

    const pond = await prisma.pond.findUnique({ where: { id }, select: { id: true } });
    if (!pond) {
      return res.status(404).json({ error: "pond not found" });
    }

    const { resolution, points } = await loadSeries(id, parameter, from, end);
    res.json({
      resolution,
      points: points.map(({ parameter, t, avg, min, max }) => ({ parameter, t, avg, min, max })),
    });
  },
);

// Historical analysis of a range, per parameter: min/max/avg, share of readings out of the safe range,
// worst severity, least-squares trend, and the average of the equal-length period just before — so a staff
// member reads "rising 0.8 °C/hr, 0.6 °C warmer than the previous 24 h" instead of eyeballing the chart.
// Judged here, against the pond's own thresholds, for the same reason alerts are: the frontend never
// decides what's abnormal. The rules are in src/lib/seriesAnalysis.ts.
pondsRouter.get(
  "/:id/analysis",
  validate(pondIdParams, "params"),
  validate(seriesQuery, "query"),
  async (req, res) => {
    const { id } = req.params as z.infer<typeof pondIdParams>;
    const { parameter, from, to } = res.locals.query as z.infer<typeof seriesQuery>;
    const end = to ?? new Date();
    if (from > end) {
      return res.status(400).json({ error: "from must be before to" });
    }

    const pond = await prisma.pond.findUnique({ where: { id }, select: { id: true, pondType: true } });
    if (!pond) {
      return res.status(404).json({ error: "pond not found" });
    }

    const range = { from, to: end };
    const previous = previousRange(range);
    const [current, before] = await Promise.all([
      loadSeries(id, parameter, range.from, range.to),
      loadSeries(id, parameter, previous.from, previous.to),
    ]);
    const analysis = analyzeSeries(current.points, range, pond.pondType);
    const previousAnalysis = analyzeSeries(before.points, previous, pond.pondType);

    const parameters: Record<string, ParameterAnalysis & { previousAvg: number | null }> = {};
    for (const [parameterId, result] of Object.entries(analysis)) {
      parameters[parameterId] = { ...result, previousAvg: previousAnalysis[parameterId]?.avg ?? null };
    }
    res.json({ from: range.from, to: range.to, previousFrom: previous.from, previousTo: previous.to, parameters });
  },
);

// Streams an .xlsx workbook of the same data /readings and /series draw from, for BFAR reporting outside
// the app. resolution=raw only reaches back as far as raw retention; resolution=hour (the default) reads
// ReadingHourly and can cover years. The actual workbook building lives in lib/readingsExport.ts, separate
// from routing/validation concerns.
pondsRouter.get(
  "/:id/readings/export",
  readingsExportRateLimit,
  validate(pondIdParams, "params"),
  validate(readingsExportQuery, "query"),
  async (req, res) => {
    const { id } = req.params as z.infer<typeof pondIdParams>;
    const { parameter, from, to, resolution } = res.locals.query as z.infer<typeof readingsExportQuery>;
    const end = to ?? new Date();
    if (from > end) {
      return res.status(400).json({ error: "from must be before to" });
    }

    const pond = await prisma.pond.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!pond) {
      return res.status(404).json({ error: "pond not found" });
    }

    const rangeError = validateExportRange(from, end, resolution);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    await streamReadingsExport(res, { pond, parameter, from, to: end, resolution });
  },
);
