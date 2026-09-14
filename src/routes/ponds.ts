import { Router } from "express";
import type { z } from "zod";
import { Prisma } from "../generated/prisma/client.ts";
import { deviceSummarySelect } from "../lib/devices.ts";
import { PARAMETER_IDS } from "../lib/parameters.ts";
import { prisma } from "../lib/prisma.ts";
import { rawRetentionDays } from "../lib/readingRollup.ts";
import { streamReadingsExport, validateExportRange } from "../lib/readingsExport.ts";
import { decodeReadingsCursor, encodeReadingsCursor, type ReadingsCursor } from "../lib/readingsCursor.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { validate } from "../middleware/validate.ts";
import { pondIdParams, readingsExportQuery, readingsPageQuery, seriesQuery } from "../schemas/ponds.ts";

// Above this range, /series answers from raw Reading rows (below it, tiles/charts want per-minute
// resolution); beyond it, ReadingHourly rows are used instead — first at hourly grain, then daily once the
// range would otherwise mean thousands of hourly points.
const SERIES_RAW_MAX_RANGE_MS = 48 * 60 * 60 * 1000;
const SERIES_HOURLY_MAX_RANGE_MS = 92 * 24 * 60 * 60 * 1000;

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

pondsRouter.get("/", async (_req, res) => {
  const ponds = await prisma.pond.findMany({
    orderBy: { name: "asc" },
    include: { device: { select: deviceSummarySelect } },
  });
  const latest = await latestReadingsByPond(ponds.map((pond) => pond.id));
  res.json({ ponds: ponds.map((pond) => ({ ...pond, latest: latest.get(pond.id) ?? {} })) });
});

pondsRouter.get("/:id", validate(pondIdParams, "params"), async (req, res) => {
  const { id } = req.params as z.infer<typeof pondIdParams>;

  const pond = await prisma.pond.findUnique({
    where: { id },
    include: { device: { select: deviceSummarySelect } },
  });
  if (!pond) {
    return res.status(404).json({ error: "pond not found" });
  }

  const latest = await latestReadingsByPond([id]);
  res.json({ pond: { ...pond, latest: latest.get(id) ?? {} } });
});

// Newest-first, keyset-paginated log of raw readings (what the pond detail page's history table shows).
// `before`, from a previous page's `nextCursor`, resumes past that row; omit it for the first page. Only
// reaches back as far as raw retention goes — see /series and /readings/export for longer ranges.
pondsRouter.get(
  "/:id/readings",
  validate(pondIdParams, "params"),
  validate(readingsPageQuery, "query"),
  async (req, res) => {
    const { id } = req.params as z.infer<typeof pondIdParams>;
    const { parameter, before, limit } = res.locals.query as z.infer<typeof readingsPageQuery>;

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
// once it would mean too many hourly points.
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

    const rangeMs = end.getTime() - from.getTime();
    const rawCutoff = new Date(Date.now() - rawRetentionDays() * 24 * 60 * 60 * 1000);

    if (rangeMs <= SERIES_RAW_MAX_RANGE_MS && from >= rawCutoff) {
      const rows = await prisma.reading.findMany({
        where: { pondId: id, parameter, recordedAt: { gte: from, lte: end } },
        orderBy: { recordedAt: "asc" },
        select: { parameter: true, value: true, recordedAt: true },
      });
      return res.json({
        resolution: "raw",
        points: rows.map((row) => ({ parameter: row.parameter, t: row.recordedAt, avg: row.value, min: row.value, max: row.value })),
      });
    }

    if (rangeMs <= SERIES_HOURLY_MAX_RANGE_MS) {
      const rows = await prisma.readingHourly.findMany({
        where: { pondId: id, parameter, bucketStart: { gte: from, lte: end } },
        orderBy: { bucketStart: "asc" },
      });
      return res.json({
        resolution: "hour",
        points: rows.map((row) => ({ parameter: row.parameter, t: row.bucketStart, avg: row.sum / row.count, min: row.min, max: row.max })),
      });
    }

    const parameterFilter = parameter ? Prisma.sql`AND "parameter" = ${parameter}` : Prisma.empty;
    const rows = await prisma.$queryRaw<
      { parameter: string; bucket: Date; min: number; max: number; sum: number; count: number }[]
    >`
      SELECT "parameter", date_trunc('day', "bucketStart" AT TIME ZONE 'Asia/Manila') AS bucket,
             min("min") AS min, max("max") AS max, sum("sum") AS sum, sum("count")::int AS count
      FROM "ReadingHourly"
      WHERE "pondId" = ${id}::uuid AND "bucketStart" >= ${from} AND "bucketStart" <= ${end} ${parameterFilter}
      GROUP BY "parameter", bucket
      ORDER BY bucket ASC
    `;
    res.json({
      resolution: "day",
      points: rows.map((row) => ({ parameter: row.parameter, t: row.bucket, avg: row.sum / row.count, min: row.min, max: row.max })),
    });
  },
);

// Streams an .xlsx workbook of the same data /readings and /series draw from, for BFAR reporting outside
// the app. resolution=raw only reaches back as far as raw retention; resolution=hour (the default) reads
// ReadingHourly and can cover years. The actual workbook building lives in lib/readingsExport.ts, separate
// from routing/validation concerns.
pondsRouter.get(
  "/:id/readings/export",
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
