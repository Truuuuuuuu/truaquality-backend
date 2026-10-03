import { Router } from "express";
import type { z } from "zod";
import { Prisma, type AlertSeverity } from "../generated/prisma/client.ts";
import { deviceSummarySelect, reportedStatuses } from "../lib/devices.ts";
import { heldSeveritiesFor, type HeldReading } from "../lib/alertRules.ts";
import { ALERT_HOLD_READINGS, isParameterId, PARAMETER_IDS, type ParameterId, thresholdsFor } from "../lib/parameters.ts";
import { prisma } from "../lib/prisma.ts";
import { analyzePondRange, loadSeries } from "../lib/pondAnalysis.ts";
import { streamReadingsExport, validateExportRange } from "../lib/readingsExport.ts";
import { decodeReadingsCursor, encodeReadingsCursor, type ReadingsCursor } from "../lib/readingsCursor.ts";
import { readingsExportRateLimit } from "../middleware/loginRateLimit.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { validate } from "../middleware/validate.ts";
import { pondIdParams, readingsExportQuery, readingsPageQuery, seriesQuery } from "../schemas/ponds.ts";


export const pondsRouter = Router();

pondsRouter.use(requireAuth);

type LatestReading = { value: number; recordedAt: Date };
type RecentRow = LatestReading & { pondId: string; parameter: string };
type PondRecent = Partial<Record<ParameterId, HeldReading[]>>;

// The most recent ALERT_HOLD_READINGS[parameter] readings of every parameter for each pond (1 for temperature, 4
// for turbidity). A LATERAL ... LIMIT k.lim per (pond, parameter) walks the (pondId, parameter, recordedAt DESC)
// index straight to the newest rows, so it stays fast as history grows — unlike DISTINCT ON, which reads every row
// for the pond. The per-parameter limit rides in a second unnest array (`::int[]`) so the query count is unchanged.
async function recentReadingsByPond(pondIds: string[]) {
  const byPond = new Map<string, PondRecent>();
  if (pondIds.length === 0) return byPond;

  const limits = PARAMETER_IDS.map((id) => ALERT_HOLD_READINGS[id]);
  const rows = await prisma.$queryRaw<RecentRow[]>`
    SELECT p.id AS "pondId", k.parameter, r.value, r."recordedAt"
    FROM unnest(${pondIds}::uuid[]) AS p(id)
    CROSS JOIN unnest(${PARAMETER_IDS}::text[], ${limits}::int[]) AS k(parameter, lim)
    CROSS JOIN LATERAL (
      SELECT value, "recordedAt"
      FROM "Reading"
      WHERE "pondId" = p.id AND parameter = k.parameter
      ORDER BY "recordedAt" DESC
      LIMIT k.lim
    ) r
  `;

  for (const row of rows) {
    if (!isParameterId(row.parameter)) continue;
    const recent = byPond.get(row.pondId) ?? {};
    (recent[row.parameter] ??= []).push({ value: row.value, recordedAt: row.recordedAt });
    byPond.set(row.pondId, recent);
  }
  // LATERAL output order is not guaranteed, so put each group newest first before reading `latest` off it.
  for (const recent of byPond.values()) {
    for (const list of Object.values(recent)) list?.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
  }
  return byPond;
}

function latestOf(recent: PondRecent) {
  const latest: Record<string, LatestReading> = {};
  for (const [parameter, list] of Object.entries(recent)) {
    const newest = list?.[0];
    if (newest) latest[parameter] = { value: newest.value, recordedAt: newest.recordedAt };
  }
  return latest;
}

// The tile color must wait for the same hold the alerts use, so a turbidity spike shorter than the hold leaves the
// pond green exactly as it leaves no alert open. It is decided here, by the same heldSeveritiesFor, so the frontend
// never knows the hold count or the band. In `heldSeverity`, null = in range, or out of range but not yet held; keys
// are exactly the parameters present in `latest`.
function heldSeverityOf(pondType: string | null | undefined, recent: PondRecent) {
  const held: Record<string, AlertSeverity | null> = {};
  for (const [parameter, severity] of Object.entries(heldSeveritiesFor(pondType, recent))) {
    held[parameter] = severity ?? null;
  }
  return held;
}

// The pond payloads select the unit's raw sensorStatus column alongside its summary so the board can show why a
// single probe went silent (the unit's own last word on each sensor) on its normal 30 s poll, without a per-pond
// diagnostics fetch. The raw Json never reaches the client: it is stripped off `device` and re-exposed as a
// top-level `sensorStatus` of status tokens only (ok, uncalibrated, no_signal, over_range, ...). A sensor absent
// from the map was never reported by this unit; a pond with no device, or a unit that never reported, gets {}.
const pondDeviceSelect = { ...deviceSummarySelect, sensorStatus: true } satisfies Prisma.DeviceSelect;

type PondWithDevice = Prisma.PondGetPayload<{ include: { device: { select: typeof pondDeviceSelect } } }>;

function toPondPayload(pond: PondWithDevice, recent: PondRecent) {
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
  return {
    ...rest,
    device: summary,
    latest: latestOf(recent),
    thresholds: thresholdsFor(pond.pondType),
    heldSeverity: heldSeverityOf(pond.pondType, recent),
    sensorStatus,
  };
}

pondsRouter.get("/", async (_req, res) => {
  const ponds = await prisma.pond.findMany({
    orderBy: { name: "asc" },
    include: { device: { select: pondDeviceSelect } },
  });
  const recent = await recentReadingsByPond(ponds.map((pond) => pond.id));
  res.json({ ponds: ponds.map((pond) => toPondPayload(pond, recent.get(pond.id) ?? {})) });
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

  const recent = await recentReadingsByPond([id]);
  res.json({ pond: toPondPayload(pond, recent.get(id) ?? {}) });
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

    const result = await analyzePondRange({ pondId: id, pondType: pond.pondType, parameter, from, to: end, rolling: to === undefined });
    res.json(result);
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

    const pond = await prisma.pond.findUnique({ where: { id }, select: { id: true, name: true, pondType: true } });
    if (!pond) {
      return res.status(404).json({ error: "pond not found" });
    }

    const rangeError = validateExportRange(from, end, resolution);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    // The Summary sheet's analysis, worked out before any byte of the workbook is sent: once streaming starts
    // the status is 200 and an error could only truncate the file.
    const analysis = await analyzePondRange({
      pondId: pond.id,
      pondType: pond.pondType,
      parameter,
      from,
      to: end,
      rolling: to === undefined,
    });
    await streamReadingsExport(res, { pond, parameter, from, to: end, resolution, analysis });
  },
);
