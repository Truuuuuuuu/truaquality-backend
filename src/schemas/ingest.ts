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

// Tokens firmware >= 0.6.0 maps esp_reset_reason() onto.
export const RESET_REASONS = [
  "power_on",
  "software",
  "panic",
  "int_wdt",
  "task_wdt",
  "wdt",
  "brownout",
  "deep_sleep",
  "external",
  "unknown",
] as const;
export type ResetReason = (typeof RESET_REASONS)[number];

// One shared set for every sensor: temperature reports ok/not_found/disconnected/power_on_value, turbidity
// reports ok/no_signal/uncalibrated/over_range. A parameter's sample value is omitted whenever it isn't "ok".
export const SENSOR_STATUSES = [
  "ok",
  "not_found",
  "disconnected",
  "power_on_value",
  "no_signal",
  "uncalibrated",
  "over_range",
] as const;
export type SensorStatus = (typeof SENSOR_STATUSES)[number];

const INT32_MAX = 2147483647;
const MAX_SAMPLES = 120;
const MAX_SENSOR_KEYS = 8;

// Every number is an integer on purpose: ArduinoJson and JSON.stringify print integers identically, while
// floats can differ in the last digit — and these bytes are signed. Upper bounds are Postgres Int (int32)
// because each field lands in an Int column on Device.
const diagSchema = z.object({
  rssi: z.int().min(-127).max(0),
  uptimeS: z.int().min(0).max(INT32_MAX),
  resetReason: z.enum(RESET_REASONS),
  freeHeap: z.int().min(0).max(INT32_MAX),
  queued: z.int().min(0).max(MAX_SAMPLES),
});

// The approved design said z.record(parameterId, statusEnum), but Zod 4's z.record with an enum key is
// exhaustive (every key required), and PARAMETER_BOUNDS doesn't list turbidity yet even though 0.6.0 firmware
// reports it. So the key is a bounded id string instead: one unknown or extra sensor must never reject the whole
// signed message, because its readings would be lost with it.
const sensorsSchema = z
  .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/), z.enum(SENSOR_STATUSES))
  .refine((sensors) => Object.keys(sensors).length <= MAX_SENSOR_KEYS, `at most ${MAX_SENSOR_KEYS} sensors`);

// Keys are declared in wire order (firmwareVersion, wifiSsid, diag, sensors, samples) to mirror the signed body;
// parse order itself doesn't matter.
export const ingestSchema = z.object({
  firmwareVersion: z.string().trim().max(32).optional(),
  // Network name the unit is connected to, sent per message (never per sample). 32 is the 802.11 SSID byte
  // limit; older firmware omits it, which leaves the stored value untouched.
  wifiSsid: z.string().trim().max(32).optional(),
  // Unit self-report (firmware >= 0.6.0). Absent on older firmware, which leaves the stored values untouched.
  diag: diagSchema.optional(),
  // Per-sensor status at the newest sample in the batch (firmware >= 0.6.0).
  sensors: sensorsSchema.optional(),
  // Batched so a device can flush readings it buffered while offline.
  samples: z.array(sampleSchema).min(1).max(MAX_SAMPLES),
});
