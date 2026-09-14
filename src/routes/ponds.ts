import { Router } from "express";
import type { z } from "zod";
import { deviceSummarySelect } from "../lib/devices.ts";
import { PARAMETER_IDS } from "../lib/parameters.ts";
import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { validate } from "../middleware/validate.ts";
import { pondIdParams, readingsQuery } from "../schemas/ponds.ts";

const DEFAULT_HISTORY_MS = 2 * 60 * 60 * 1000;

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

pondsRouter.get(
  "/:id/readings",
  validate(pondIdParams, "params"),
  validate(readingsQuery, "query"),
  async (req, res) => {
    const { id } = req.params as z.infer<typeof pondIdParams>;
    const { parameter, from, to, limit } = res.locals.query as z.infer<typeof readingsQuery>;

    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - DEFAULT_HISTORY_MS);
    if (start > end) {
      return res.status(400).json({ error: "from must be before to" });
    }

    const pond = await prisma.pond.findUnique({ where: { id }, select: { id: true } });
    if (!pond) {
      return res.status(404).json({ error: "pond not found" });
    }

    // Newest `limit` rows in the window, returned oldest-first for charting.
    const readings = await prisma.reading.findMany({
      where: { pondId: id, parameter, recordedAt: { gte: start, lte: end } },
      orderBy: { recordedAt: "desc" },
      take: limit,
      select: { parameter: true, value: true, recordedAt: true },
    });
    readings.reverse();

    res.json({ from: start, to: end, readings });
  },
);
