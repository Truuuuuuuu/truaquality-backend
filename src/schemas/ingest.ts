import { z } from "zod";

// Allows for a device clock that is a little ahead of the server's.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const sampleSchema = z.object({
  recordedAt: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .refine((date) => date.getTime() <= Date.now() + MAX_CLOCK_SKEW_MS, "recordedAt is in the future")
    .optional(),
  // Parameter ids and value bounds are checked per value in the handler, so one bad probe reading
  // doesn't throw away the rest of the batch.
  values: z.record(z.string(), z.number()),
});

export const ingestSchema = z.object({
  firmwareVersion: z.string().trim().max(32).optional(),
  // Batched so a device can flush readings it buffered while offline.
  samples: z.array(sampleSchema).min(1).max(120),
});
