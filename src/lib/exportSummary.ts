import { PARAMETER_DISPLAY, type ParameterId } from "./parameters.ts";
import type { PondParameterAnalysis } from "./pondAnalysis.ts";

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
  "Interpretation",
] as const;

// Same "value unit" format as the Readings sheet, so numbers stay real (sortable, chartable) and show their unit.
function valueFormat(parameter: ParameterId, suffix = "") {
  const { precision, unit } = PARAMETER_DISPLAY[parameter];
  const number = `0.${"0".repeat(precision)}`;
  return `${number}" ${unit}${suffix}"`;
}

// Signed: "+0.6 °C" / "-0.6 °C" / "0.0 °C", so a change reads as a change.
function signedFormat(parameter: ParameterId, suffix = "") {
  const plain = valueFormat(parameter, suffix);
  return `+${plain};-${plain};${plain}`;
}

const WORST_LABELS = { nominal: "Normal", warning: "Warning", critical: "Critical" } as const;
const TREND_LABELS = { rising: "Rising", falling: "Falling", stable: "Steady" } as const;

export function summaryRows(
  columns: readonly ParameterId[],
  parameters: Record<string, PondParameterAnalysis>,
): SummaryCell[][] {
  return columns.map((parameter) => {
    const label = { value: PARAMETER_DISPLAY[parameter].exportHeader };
    const result = parameters[parameter];
    if (!result) {
      return [label, ...Array.from({ length: 8 }, () => ({ value: null })), { value: "No readings in this range." }];
    }
    const trend = result.trend;
    const perUnit = trend?.rateUnit === "hr" ? "/hour" : "/day";
    return [
      label,
      { value: result.min, numFmt: valueFormat(parameter) },
      { value: result.max, numFmt: valueFormat(parameter) },
      { value: result.avg, numFmt: valueFormat(parameter) },
      { value: result.outOfRangeShare, numFmt: "0%" },
      { value: WORST_LABELS[result.worst] },
      { value: trend ? TREND_LABELS[trend.direction] : "Not enough data" },
      trend ? { value: trend.rate, numFmt: signedFormat(parameter, perUnit) } : { value: null },
      result.previousAvg === null
        ? { value: "No data before" }
        : { value: result.avg - result.previousAvg, numFmt: signedFormat(parameter) },
      { value: result.summary },
    ];
  });
}
