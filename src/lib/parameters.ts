// Sensor parameters a device may report. The bounds are physical sanity limits for rejecting garbage
// (a disconnected probe, a parsing bug) — not the safe/critical ranges the dashboard colors by.
export const PARAMETER_BOUNDS = {
  temperature: { min: -5, max: 60 },
  // The firmware clamps NTU to 0 at its clear-water reference and to 3000 where the vendor curve saturates, so
  // 0..3000 are all legitimate readings — including exactly 3000, because the firmware reports a sensor fault
  // by omitting the value, never by sending the ceiling. 4000 leaves headroom for a bench refit of the curve;
  // only negative or absurd values are garbage.
  turbidity: { min: 0, max: 4000 },
  // pH is defined on 0..14, so anything outside it is a probe or wiring fault, not water. Kept after turbidity on
  // purpose: the key order here is PARAMETER_IDS, which is also the export's column order.
  ph: { min: 0, max: 14 },
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
  // Set only while a parameter's critical line (low side, high side, or both) is a placeholder awaiting BFAR —
  // turbidity's high side and both of pH's sides today. criticalMin/criticalMax stay numeric so severityFor judges
  // exactly as before, but the dashboard reads this marker to draw no critical band and to keep its chart axis off
  // the placeholder instead of stretching it to a sensor ceiling or the edge of the pH scale. When BFAR's figures
  // replace the placeholder constants, drop the marker and the frontend band appears with no frontend edit.
  // Optional (absent, not false) so a parameter with a real critical line serializes as before.
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

// PENDING BFAR. BFAR will supply the pH critical lines; until then they equal PARAMETER_BOUNDS.ph, so with
// severityFor's strict "<"/">" no stored reading (ingest rejects anything outside 0..14) is ever CRITICAL — pH is
// warning-only in the field until supplied. Replace them with BFAR's figures and citation — never with a
// literature "acid/alkaline death point" value.
export const PH_CRITICAL_MIN = 0;
export const PH_CRITICAL_MAX = 14;

const SHARED: Record<ParameterId, Threshold> = {
  // Temperature (°C) — from BFAR Sorsogon, the client agency. BFAR's desirable range 20.0–30.0 °C is the safe band
  // (outside it = WARNING); its acceptable range 15.0–35.5 °C is the critical band (outside it = CRITICAL).
  // SHARED across pond types because BFAR gave one range for all of them.
  // Source: Abowei, 2010 as cited by Bantaya, 2016.
  temperature: { safeMin: 20, safeMax: 30, criticalMin: 15, criticalMax: 35.5 },
  // Turbidity (NTU) — 25 NTU warning line sourced from BFAR; critical line still pending BFAR.
  // - safeMax 25 NTU ("below 25 NTU is normal, above is above-normal"): from BFAR Sorsogon, the client agency.
  //   Source: BFAR Sorsogon (client agency), "Turbidity Aquaculture <25 NTU" reference (no title or year given).
  //   NTU-native; not derived from Secchi depth.
  // - criticalMax: PENDING BFAR — see TURBIDITY_CRITICAL_MAX_NTU (warning-only in the field until supplied).
  // - No low-side band (safeMin = criticalMin = 0 = bounds.min): clear water reads near 0 NTU and must never
  //   alert (ALRT-03); a low band above 0 would open an episode that could never resolve, as salinity once did.
  // - BFAR's ~0.5 m Secchi transparency guidance is a separate reference for pond managers, not a conversion
  //   source: no NTU number here comes from Secchi depth.
  // - Sensor caveat: NTU is a vendor-curve estimate (no reference turbidimeter yet). The clean-water noise floor is
  //   recorded on the bench (.planning/phases/03-turbidity-sensor-read-bench-characterization/03-BENCH-RECORD.md:
  //   that rig could not resolve 25 NTU in clear water) and on the unit (TURBIDITY_TEST_RESULTS.md §5e: 85 clean
  //   readings, none above 25 NTU, firmware 0.6.1). The 30-minute dashboard soak (§5f) did NOT hold: 7 of 58
  //   clean-water readings spiked above 25 NTU (max 135.8), and a run of 3 opened a false WARNING. The 25 NTU line
  //   stays; single spikes are absorbed by ALERT_HOLD_READINGS below instead, and the re-soak with that hold rule is
  //   TURBIDITY_TEST_RESULTS.md §5h.
  turbidity: { safeMin: 0, safeMax: 25, criticalMin: 0, criticalMax: TURBIDITY_CRITICAL_MAX_NTU, criticalPending: true },
  // pH — from BFAR Sorsogon, the client agency. BFAR's range 6.5–9.5 is the safe band (outside it = WARNING, on
  // either side). Critical lines PENDING BFAR — see PH_CRITICAL_MIN / PH_CRITICAL_MAX.
  // SHARED across pond types because BFAR gave one range for all of them.
  // Source: Abowei, 2010 as cited by Bantaya, 2016.
  ph: { safeMin: 6.5, safeMax: 9.5, criticalMin: PH_CRITICAL_MIN, criticalMax: PH_CRITICAL_MAX, criticalPending: true },
};

// How many consecutive out-of-range readings a parameter needs before it counts as out of range — for opening or
// worsening an alert (alertRules.heldSeverityFor) and for the dashboard color GET /ponds serves. Shared across pond
// types (not part of ThresholdProfile) and server-owned, so the frontend never knows the count.
// - turbidity 4: the §5f soak (TURBIDITY_TEST_RESULTS.md, 2026-10-03) saw 7 of 58 clean-water readings above 25 NTU
//   in short runs, the longest 3 in a row, and that run opened a false WARNING. N = 3 would still have opened it;
//   4 suppresses every clean-water run seen in the whole session, while real turbid water (cornstarch: runs of 11
//   and 24) still alerts. At the firmware's 30 s report interval that is about 2 minutes, and pond turbidity
//   changes over minutes to hours, so the delay costs nothing that matters.
// - temperature 1: the DS18B20 has shown no such spikes and a temperature alert must stay immediate.
// - ph 4: PROVISIONAL, same as turbidity — about 2 minutes at the firmware's 30 s interval, so a single noisy
//   analog read cannot open an alert. The real count comes from the Phase 10 soak (ALRT-06). It also sets how many
//   in-range readings in a row recovery ends on: an episode resolves only once ALERT_RECOVERY_MS has passed AND its
//   last N readings are all in range (alertRules.decideAlertStep), so it governs recovery tolerance too (D-06).
export const ALERT_HOLD_READINGS: Record<ParameterId, number> = { temperature: 1, turbidity: 4, ph: 4 };

// Two readings further apart than this break a held run. A sensor fault sends no value (no Reading row) and an
// offline unit sends nothing, so a fault or an outage shows up only as a gap in time; without this, four spikes
// spread over an hour would count as "consecutive". 90 s tolerates one lost report at the firmware's 30 s interval
// (and the simulator's default 60 s) and breaks on two or more. A backend constant: the backend never reads the
// firmware's REPORT_INTERVAL_MS.
export const ALERT_HOLD_MAX_GAP_MS = 90_000;

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
//
// approximate / sensorCeiling feed the analysis summary's wording (src/lib/analysisSummary.ts) and mirror the
// frontend PARAMETERS entry: an approximate value reads "≈ 12.0 NTU", and a value at the firmware's 3000 NTU clamp
// reads "≥ 3000" (at least this cloudy). Display only — never a threshold.
//
// An empty unit means the parameter is unitless (pH): the export number format and the analysis sentences then
// omit the unit suffix instead of leaving a stray space or an empty quoted literal. sentenceLabel keeps an acronym's
// casing mid-sentence ("pH averaged ...", not "ph averaged ..."); without it a sentence lowercases label. pH's
// precision 2 is the wire precision the firmware sends; the dashboard tile rounds it to 1 (Phase 12).
export const PARAMETER_DISPLAY: Record<
  ParameterId,
  {
    label: string;
    unit: string;
    precision: number;
    exportHeader: string;
    approximate?: true;
    sensorCeiling?: number;
    sentenceLabel?: string;
  }
> = {
  temperature: { label: "Temperature", unit: "°C", precision: 1, exportHeader: "Temperature" },
  turbidity: {
    label: "Turbidity",
    unit: "NTU",
    precision: 1,
    exportHeader: "Turbidity (NTU, approx.)",
    approximate: true,
    sensorCeiling: 3000,
  },
  ph: { label: "pH", unit: "", precision: 2, exportHeader: "pH", sentenceLabel: "pH" },
};
