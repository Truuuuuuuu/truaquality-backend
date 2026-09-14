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

export const readingsQuery = z.object({
  parameter: z.enum(PARAMETER_IDS).optional(),
  from: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  to: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
});
