import { z } from "zod";
import { PARAMETER_IDS } from "../lib/parameters.ts";

export const pondIdParams = z.object({ id: z.uuid() });

const pondType = z.enum(["FRESHWATER", "BRACKISH", "SALTWATER"]);

export const createPondSchema = z.object({
  name: z.string().trim().min(1).max(80),
  notes: z.string().trim().max(500).optional(),
  fishSpecies: z.string().trim().max(120).optional(),
  pondType: pondType.optional(),
});

export const updatePondSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  fishSpecies: z.string().trim().max(120).nullable().optional(),
  pondType: pondType.nullable().optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
});

const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

// Keyset pagination for /:id/readings: `before` is an opaque cursor from a previous page's `nextCursor`,
// not a raw timestamp, so a client can't be tempted to hand-craft one that skips the tie-breaking id.
// `from`/`to` narrow the scan to a date/time range; the cursor still walks within that range.
export const readingsPageQuery = z.object({
  parameter: z.enum(PARAMETER_IDS).optional(),
  before: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// The longest range /series, /analysis and the hourly export will cover. Without a cap, `from=1970-01-01` made
// /analysis aggregate the pond's whole history twice (the range and the equal-length period before it) on every
// request. Two years is the longest window the dashboard offers with room to spare. Lives here (Prisma-free) so
// readingsExport.ts can share it instead of keeping its own copy that could drift.
export const MAX_RANGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;
export const MAX_RANGE_MESSAGE = "range is limited to 2 years";

// /series and /analysis. `to` defaults to now, so an open-ended range is measured to now.
export const seriesQuery = z
  .object({
    parameter: z.enum(PARAMETER_IDS).optional(),
    from: isoDate,
    to: isoDate.optional(),
  })
  .refine((query) => (query.to ?? new Date()).getTime() - query.from.getTime() <= MAX_RANGE_MS, {
    message: MAX_RANGE_MESSAGE,
    path: ["from"],
  });

export const readingsExportQuery = z.object({
  parameter: z.enum(PARAMETER_IDS).optional(),
  from: isoDate,
  to: isoDate.optional(),
  resolution: z.enum(["raw", "hour"]).default("hour"),
});
