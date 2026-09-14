import { z } from "zod";
import { PARAMETER_IDS } from "../lib/parameters.ts";

export const pondIdParams = z.object({ id: z.uuid() });

export const createPondSchema = z.object({
  name: z.string().trim().min(1).max(80),
  notes: z.string().trim().max(500).optional(),
});

export const updatePondSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
});

const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

// Keyset pagination for /:id/readings: `before` is an opaque cursor from a previous page's `nextCursor`,
// not a raw timestamp, so a client can't be tempted to hand-craft one that skips the tie-breaking id.
export const readingsPageQuery = z.object({
  parameter: z.enum(PARAMETER_IDS).optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const seriesQuery = z.object({
  parameter: z.enum(PARAMETER_IDS).optional(),
  from: isoDate,
  to: isoDate.optional(),
});

export const readingsExportQuery = z.object({
  parameter: z.enum(PARAMETER_IDS).optional(),
  from: isoDate,
  to: isoDate.optional(),
  resolution: z.enum(["raw", "hour"]).default("hour"),
});
