// Sensor parameters a device may report. The bounds are physical sanity limits for rejecting garbage
// (a disconnected probe, a parsing bug) — not the safe/critical ranges the dashboard colors by.
export const PARAMETER_BOUNDS = {
  temperature: { min: -5, max: 60 },
  // The firmware clamps NTU to 0 at its clear-water reference and to 3000 where the vendor curve saturates, so
  // 0..3000 are all legitimate readings — including exactly 3000, because the firmware reports a sensor fault
  // by omitting the value, never by sending the ceiling. 4000 leaves headroom for a bench refit of the curve;
  // only negative or absurd values are garbage.
  turbidity: { min: 0, max: 4000 },
} as const;

export type ParameterId = keyof typeof PARAMETER_BOUNDS;

export const PARAMETER_IDS = Object.keys(PARAMETER_BOUNDS) as [ParameterId, ...ParameterId[]];

export function isParameterId(value: string): value is ParameterId {
  return Object.hasOwn(PARAMETER_BOUNDS, value);
}

export type Threshold = {
  safeMin: number;
  safeMax: number;
  criticalMin: number;
  criticalMax: number;
  // Set only while a parameter's critical line is a placeholder awaiting BFAR (turbidity today). criticalMax stays
  // numeric so severityFor judges exactly as before, but the dashboard reads this marker to draw no critical band
  // and to keep its chart axis off the placeholder instead of stretching it to the 3000 NTU sensor ceiling. When
  // BFAR's figure replaces TURBIDITY_CRITICAL_MAX_NTU, drop the marker and the frontend band appears with no
  // frontend edit. Optional (absent, not false) so a parameter with a real critical line serializes as before.
  criticalPending?: true;
};

// A pond's thresholds may depend on what it's stocked for, so they're keyed by Pond.pondType. UNSET covers a
// pond an admin hasn't classified yet.
//
// This used to be one global table, which made every freshwater pond permanently CRITICAL on the (since
// removed) salinity parameter: fresh water sits near 0 ppt, well under the brackish critical minimum, so the
// first reading opened an alert that could never resolve. No current parameter differs by pond type, so every
// profile is SHARED for now — a parameter that does differ overrides it per profile. Turbidity is SHARED on
// purpose (Phase 4 D-05): no source gives pond-type-specific NTU numbers.
export type ThresholdProfile = "FRESHWATER" | "BRACKISH" | "SALTWATER" | "UNSET";

// PENDING BFAR. BFAR will supply the turbidity critical line; until then this equals the firmware's 3000 NTU
// ceiling, so with severityFor's strict ">" no field reading is ever CRITICAL (turbidity is warning-only), while
// tests can still drive escalation with an in-bounds value above it. Replace it with the BFAR figure and its
// citation — never with a number converted from Secchi depth.
export const TURBIDITY_CRITICAL_MAX_NTU = 3000;

const SHARED: Record<ParameterId, Threshold> = {
  // Temperature (°C) — from BFAR Sorsogon, the client agency. BFAR's desirable range 20.0–30.0 °C is the safe band
  // (outside it = WARNING); its acceptable range 15.0–35.5 °C is the critical band (outside it = CRITICAL).
  // SHARED across pond types because BFAR gave one range for all of them.
  temperature: { safeMin: 20, safeMax: 30, criticalMin: 15, criticalMax: 35.5 },
  // Turbidity (NTU) — PROVISIONAL, pending BFAR review.
  // - safeMax 25 NTU ("below 25 NTU is normal, above is above-normal"): [BFAR document — citation to be supplied].
  //   NTU-native; not derived from Secchi depth.
  // - criticalMax: PENDING BFAR — see TURBIDITY_CRITICAL_MAX_NTU (warning-only in the field until supplied).
  // - No low-side band (safeMin = criticalMin = 0 = bounds.min): clear water reads near 0 NTU and must never
  //   alert (ALRT-03); a low band above 0 would open an episode that could never resolve, as salinity once did.
  // - BFAR's ~0.5 m Secchi transparency guidance is a separate reference for pond managers, not a conversion
  //   source: no NTU number here comes from Secchi depth.
  // - Sensor caveat: NTU is a vendor-curve estimate (no reference turbidimeter yet); the bench noise-floor check
  //   against 25 NTU is pending (see .planning/phases/04-backend-turbidity-ingest-alerts/04-TURBIDITY-THRESHOLDS.md).
  turbidity: { safeMin: 0, safeMax: 25, criticalMin: 0, criticalMax: TURBIDITY_CRITICAL_MAX_NTU, criticalPending: true },
};

// Safe/critical ranges that raise alerts (lib/alerts.ts). Unlike PARAMETER_BOUNDS, a value outside these is a
// real reading worth acting on, not garbage. The frontend no longer keeps a copy — it reads the resolved
// thresholds off each pond in GET /ponds, so these numbers only exist here.
export const PARAMETER_THRESHOLDS: Record<ThresholdProfile, Record<ParameterId, Threshold>> = {
  FRESHWATER: SHARED,
  BRACKISH: SHARED,
  SALTWATER: SHARED,
  UNSET: SHARED,
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
// label/unit/precision here and there in sync; a parameter id must exist in both (turbidity reaches the
// frontend PARAMETERS in Phase 6 and must match this entry).
//
// precision must stay >= 1: readingsExport.numFmtFor builds `0.` followed by `precision` zeros, so 0 would emit
// a malformed format with a stray decimal point. Turbidity uses 1, matching the firmware's 0.1 NTU rounding.
//
// The real "°" is safe here: it's written into an Excel cell's number format inside a proper .xlsx (OOXML)
// file, not raw bytes in a plain-text CSV — the earlier "¬∞C" mojibake was specifically a CSV-in-Excel
// encoding problem (some Excel builds guessed Mac OS Roman instead of UTF-8) that doesn't exist for .xlsx.
//
// exportHeader is the data table's column heading. Turbidity's says "approx." because the NTU value is a low-cost
// optical estimate off a vendor curve, not a reference turbidimeter reading; the cells stay real numbers so the
// sheet can still be charted and averaged. label stays plain because the report's "Parameter" row and filenames
// use it.
export const PARAMETER_DISPLAY: Record<
  ParameterId,
  { label: string; unit: string; precision: number; exportHeader: string }
> = {
  temperature: { label: "Temperature", unit: "°C", precision: 1, exportHeader: "Temperature" },
  turbidity: { label: "Turbidity", unit: "NTU", precision: 1, exportHeader: "Turbidity (NTU, approx.)" },
};
