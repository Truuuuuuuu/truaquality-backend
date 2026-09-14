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
