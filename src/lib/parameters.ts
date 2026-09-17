// Sensor parameters a device may report. The bounds are physical sanity limits for rejecting garbage
// (a disconnected probe, a parsing bug) — not the safe/critical ranges the dashboard colors by.
export const PARAMETER_BOUNDS = {
  temperature: { min: -5, max: 60 },
  dissolvedOxygen: { min: 0, max: 30 },
  salinity: { min: 0, max: 70 },
} as const;

export type ParameterId = keyof typeof PARAMETER_BOUNDS;

export const PARAMETER_IDS = Object.keys(PARAMETER_BOUNDS) as [ParameterId, ...ParameterId[]];

export function isParameterId(value: string): value is ParameterId {
  return Object.hasOwn(PARAMETER_BOUNDS, value);
}

export type Threshold = { safeMin: number; safeMax: number; criticalMin: number; criticalMax: number };

// A pond's thresholds depend on what it's stocked for, so they're keyed by Pond.pondType. UNSET covers a
// pond an admin hasn't classified yet.
//
// This used to be one global table, which made every freshwater pond permanently CRITICAL: fresh water sits
// near 0 ppt, well under the brackish criticalMin of 5, so the first reading opened an alert that could never
// resolve and notified every user about it.
export type ThresholdProfile = "FRESHWATER" | "BRACKISH" | "SALTWATER" | "UNSET";

// Temperature and dissolved oxygen are the same whatever the pond is stocked for; only salinity differs.
const SHARED = {
  temperature: { safeMin: 26, safeMax: 31, criticalMin: 24, criticalMax: 33 },
  dissolvedOxygen: { safeMin: 5, safeMax: 9, criticalMin: 3, criticalMax: 11 },
} satisfies Pick<Record<ParameterId, Threshold>, "temperature" | "dissolvedOxygen">;

// Safe/critical ranges that raise alerts (lib/alerts.ts). Unlike PARAMETER_BOUNDS, a value outside these is a
// real reading worth acting on, not garbage. The frontend no longer keeps a copy — it reads the resolved
// thresholds off each pond in GET /ponds, so these numbers only exist here.
//
// A criticalMin of 0 is deliberate for fresh water: severityFor tests `value < criticalMin`, so a true 0 ppt
// reading stays nominal rather than alarming.
export const PARAMETER_THRESHOLDS: Record<ThresholdProfile, Record<ParameterId, Threshold>> = {
  FRESHWATER: { ...SHARED, salinity: { safeMin: 0, safeMax: 2, criticalMin: 0, criticalMax: 5 } },
  BRACKISH: { ...SHARED, salinity: { safeMin: 10, safeMax: 25, criticalMin: 5, criticalMax: 32 } },
  SALTWATER: { ...SHARED, salinity: { safeMin: 30, safeMax: 35, criticalMin: 28, criticalMax: 38 } },
  // An unclassified pond gets a salinity range spanning all three types, so it can't false-alarm before an
  // admin has said what it's stocked for. Temperature and DO still alert normally.
  UNSET: { ...SHARED, salinity: { safeMin: 0, safeMax: 35, criticalMin: 0, criticalMax: 38 } },
};

// Pond.pondType is nullable; this is the one place that decision is made.
export function thresholdProfileFor(pondType: string | null | undefined): ThresholdProfile {
  return pondType === "FRESHWATER" || pondType === "BRACKISH" || pondType === "SALTWATER"
    ? pondType
    : "UNSET";
}

// The full set of thresholds for a pond, as GET /ponds returns them so the dashboard colors readings by the
// same numbers that raise the alerts.
export function thresholdsFor(pondType: string | null | undefined): Record<ParameterId, Threshold> {
  return PARAMETER_THRESHOLDS[thresholdProfileFor(pondType)];
}

// null means the value is within the safe range for this kind of pond.
export function severityFor(
  parameter: ParameterId,
  value: number,
  pondType: string | null | undefined,
): "WARNING" | "CRITICAL" | null {
  const { safeMin, safeMax, criticalMin, criticalMax } = thresholdsFor(pondType)[parameter];
  if (value < criticalMin || value > criticalMax) return "CRITICAL";
  if (value < safeMin || value > safeMax) return "WARNING";
  return null;
}

// Display metadata for report-facing output (currently just the .xlsx export in routes/ponds.ts) — the
// dashboard itself is rendered by the frontend, which keeps its own copy in src/lib/parameters.ts. Keep the
// label/unit/precision here and there in sync; a parameter id must exist in both.
//
// The real "°" is safe here: it's written into an Excel cell's number format inside a proper .xlsx (OOXML)
// file, not raw bytes in a plain-text CSV — the earlier "¬∞C" mojibake was specifically a CSV-in-Excel
// encoding problem (some Excel builds guessed Mac OS Roman instead of UTF-8) that doesn't exist for .xlsx.
export const PARAMETER_DISPLAY: Record<ParameterId, { label: string; unit: string; precision: number }> = {
  temperature: { label: "Temperature", unit: "°C", precision: 1 },
  dissolvedOxygen: { label: "Dissolved Oxygen", unit: "mg/L", precision: 2 },
  salinity: { label: "Salinity", unit: "ppt", precision: 1 },
};
