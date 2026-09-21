import { z } from "zod";

// Allows for a device clock that is a little ahead of the server's.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const sampleSchema = z.object({
  recordedAt: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .refine((date) => date.getTime() <= Date.now() + MAX_CLOCK_SKEW_MS, "recordedAt is in the future")
    .optional(),
  // Nullable because a device may explicitly send `null` for a sensor that failed to read (equivalent to
  // just omitting the key) rather than a garbage number. Parameter ids and value bounds are checked per
  // value in the handler, so one bad or missing probe reading doesn't throw away the rest of the batch —
  // a non-numeric, non-null value (a string, a boolean, ...) still fails validation for the whole message,
  // since that indicates a malformed payload rather than a sensor with nothing to report.
  values: z.record(z.string(), z.number().nullable()),
});

export const ingestSchema = z.object({
  firmwareVersion: z.string().trim().max(32).optional(),
  // Network name the unit is connected to, sent per message (never per sample). 32 is the 802.11 SSID byte
  // limit; older firmware omits it, which leaves the stored value untouched.
  wifiSsid: z.string().trim().max(32).optional(),
  // Batched so a device can flush readings it buffered while offline.
  samples: z.array(sampleSchema).min(1).max(120),
});
