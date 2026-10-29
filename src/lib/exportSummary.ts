import { PARAMETER_DISPLAY, type KnownParameterId } from "./parameters.ts";
import type { PondParameterAnalysis } from "./pondAnalysis.ts";
import type { ReferenceResolution } from "./seriesAnalysis.ts";

// The rows of the export's "Summary" sheet (written by src/lib/readingsExport.ts): one row per exported
// parameter with the same analysis and interpretation the dashboard's Trend summary shows. Kept free of exceljs
// so the content can be tested as plain data; each cell carries its own Excel number format.

export type SummaryCell = { value: string | number | null; numFmt?: string };

export const SUMMARY_HEADERS = [
  "Parameter",
  "Min",
  "Max",
  "Average",
  "Out of safe range",
  "Worst level",
  "Trend",
  "Rate of change",
  "Change vs previous period",
  "Outside normal range",
  "Reference calculation basis",
  "Lowest DO",
  "Lowest DO reference result",
  "Interpretation",
] as const;

// The Excel number format for a parameter's cells, shared with the Readings sheet (readingsExport.numFmtFor), so
// numbers stay real (sortable, chartable) and show their unit as a quoted literal. A unitless parameter (pH) gets
// the bare number format: an empty quoted suffix used to leave a trailing space after every value. A rate still
// needs a word, so a unitless rate falls back to the label ("pH/hour").
export function excelNumberFormat(parameter: KnownParameterId, suffix = "") {
  const { precision, unit, label } = PARAMETER_DISPLAY[parameter];
  const number = `0.${"0".repeat(precision)}`;
  const text = unit ? unit + suffix : suffix ? label + suffix : "";
  return text ? `${number}" ${text}"` : number;
}

function valueFormat(parameter: KnownParameterId, suffix = "") {
  return excelNumberFormat(parameter, suffix);
}

// Signed: "+0.6 °C" / "-0.6 °C" / "0.0 °C", so a change reads as a change.
function signedFormat(parameter: KnownParameterId, suffix = "") {
  const plain = valueFormat(parameter, suffix);
  return `+${plain};-${plain};${plain}`;
}

const WORST_LABELS = { nominal: "Normal", warning: "Warning", critical: "Critical" } as const;
const TREND_LABELS = { rising: "Rising", falling: "Falling", stable: "Steady" } as const;

export function summaryRows(
  columns: readonly KnownParameterId[],
  parameters: Record<string, PondParameterAnalysis>,
  resolution?: ReferenceResolution,
): SummaryCell[][] {
  return columns.map((parameter) => {
    const label = { value: PARAMETER_DISPLAY[parameter].exportHeader };
    const result = parameters[parameter];
    if (!result) {
      return [label, ...Array.from({ length: SUMMARY_HEADERS.length - 2 }, () => ({ value: null })), { value: "No readings in this range." }];
    }
    const trend = result.trend;
    const perUnit = trend?.rateUnit === "hr" ? "/hour" : "/day";
    const reference = parameter === "dissolvedOxygen" && "referenceComparison" in result ? result.referenceComparison : null;
    const basis = reference?.outsideShare == null ? null : reference.approximate
      ? `Approximate, based on ${resolution === "day" ? "daily" : resolution === "hour" ? "hourly" : "bucket"} averages (count-weighted)`
      : "Raw samples";
    return [
      label,
      { value: result.min, numFmt: valueFormat(parameter) },
      { value: result.max, numFmt: valueFormat(parameter) },
      { value: result.avg, numFmt: valueFormat(parameter) },
      { value: result.outOfRangeShare, numFmt: "0%" },
      { value: result.worst === null ? ("thresholdState" in result && result.thresholdState === "not_applicable" ? "Not applicable" : "Pending BFAR thresholds") : WORST_LABELS[result.worst] },
      { value: trend ? TREND_LABELS[trend.direction] : parameter === "dissolvedOxygen" ? "Not assessed" : "Not enough data" },
      trend ? { value: trend.rate, numFmt: signedFormat(parameter, perUnit) } : { value: null },
      result.previousAvg === null
        ? { value: "No data before" }
        : { value: result.avg - result.previousAvg, numFmt: signedFormat(parameter) },
      { value: reference?.outsideShare ?? null, numFmt: "0%" },
      { value: basis },
      { value: parameter === "dissolvedOxygen" ? result.min : null, numFmt: valueFormat(parameter) },
      { value: reference?.minimumResult === "within_reference" ? "Within normal range"
        : reference?.minimumResult === "outside_reference" ? "Outside normal range" : null },
      { value: result.summary },
    ];
  });
}
