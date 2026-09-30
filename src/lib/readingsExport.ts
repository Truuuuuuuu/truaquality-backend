import ExcelJS from "exceljs";
import type { Response } from "express";
import type { ReadingHourly } from "../generated/prisma/client.ts";
import { SUMMARY_HEADERS, summaryRows } from "./exportSummary.ts";
import { PARAMETER_DISPLAY, PARAMETER_IDS, type ParameterId } from "./parameters.ts";
import type { PondAnalysis } from "./pondAnalysis.ts";
import { prisma } from "./prisma.ts";
import { rawRetentionDays } from "./readingRollup.ts";

// Backs GET /ponds/:id/readings/export (routes/ponds.ts). Streams a formatted .xlsx workbook of a pond's
// readings — one column per parameter, one row per timestamp, bordered header/data cells, real numeric
// cells carrying a custom number format that shows the unit (e.g. "27.6 °C") without turning the value into
// text. Built with exceljs's streaming WorkbookWriter so a large export doesn't sit in memory.

const EXPORT_RAW_MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const EXPORT_HOURLY_MAX_RANGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const EXPORT_CHUNK_SIZE = 5000;

export type ExportResolution = "raw" | "hour";

// Checks the range against retention/size limits for the chosen resolution. Returns an error message for
// the route to answer with 400, or null once the range is fine to export.
export function validateExportRange(from: Date, to: Date, resolution: ExportResolution): string | null {
  const rangeMs = to.getTime() - from.getTime();
  if (resolution === "raw") {
    const rawCutoff = new Date(Date.now() - rawRetentionDays() * 24 * 60 * 60 * 1000);
    if (from < rawCutoff) {
      return `raw export only covers the last ${rawRetentionDays()} days; use resolution=hour for older data`;
    }
    if (rangeMs > EXPORT_RAW_MAX_RANGE_MS) {
      return "raw export is limited to 31 days; use resolution=hour for a longer range";
    }
    return null;
  }
  if (rangeMs > EXPORT_HOURLY_MAX_RANGE_MS) {
    return "export is limited to a 2 year range";
  }
  return null;
}

// Readable, sortable, and what Excel/Sheets parse back into a datetime without prompting for a format.
function formatManilaTimestamp(date: Date) {
  return date.toLocaleString("sv-SE", { timeZone: "Asia/Manila", hour12: false }).replace(" ", "T");
}

// An Excel custom number format showing the value with the parameter's own decimal precision plus its unit
// as a literal suffix (e.g. "27.6 °C") — the cell stays a real number (sortable, chartable), the unit is
// purely display. Only reachable through a real .xlsx cell format, not plain text: the non-ASCII "°" is
// safe here because XLSX stores it in proper OOXML/UTF-8, not bytes Excel might misguess the encoding of
// (the earlier, now-abandoned CSV export had to avoid it for exactly that reason).
function numFmtFor(parameterId: string) {
  const display = PARAMETER_DISPLAY[parameterId as ParameterId];
  if (!display) return undefined;
  return `0.${"0".repeat(display.precision)}" ${display.unit}"`;
}

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

type PivotSourceRow<TCursor> = {
  timeKey: string;
  parameter: string;
  value: number;
  cursor: TCursor;
};

// Streams a wide worksheet table (one column per parameter, one row per timestamp) from a source that's
// naturally long (one row per parameter *and* timestamp), fetched page by page via keyset pagination. A
// timestamp's row is only written once every parameter reading at that instant has been seen — which, since
// `fetchPage` orders by timestamp first, just means "the next row has a different timestamp" (or there are
// no more rows). This holds even when a timestamp's readings straddle two fetched pages.
async function streamPivotedXlsx<TCursor>(
  sheet: ExcelJS.Worksheet,
  columns: readonly string[],
  fetchPage: (cursor: TCursor | null) => Promise<PivotSourceRow<TCursor>[]>,
) {
  let pending = new Map<string, number>();
  let pendingTimeKey: string | null = null;
  let cursor: TCursor | null = null;

  const flush = () => {
    if (pendingTimeKey === null) return;
    const row = sheet.addRow([pendingTimeKey, ...columns.map((id) => pending.get(id) ?? null)]);
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.border = THIN_BORDER;
      if (colNumber > 1) {
        const fmt = numFmtFor(columns[colNumber - 2]!);
        if (fmt) cell.numFmt = fmt;
      }
    });
    row.commit();
    pending = new Map();
    pendingTimeKey = null;
  };

  for (;;) {
    const rows = await fetchPage(cursor);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (pendingTimeKey !== null && row.timeKey !== pendingTimeKey) flush();
      pendingTimeKey = row.timeKey;
      pending.set(row.parameter, row.value);
      cursor = row.cursor;
    }
    if (rows.length < EXPORT_CHUNK_SIZE) break;
  }
  flush();
}

export type ReadingsExportParams = {
  pond: { id: string; name: string };
  parameter?: ParameterId;
  from: Date;
  to: Date;
  resolution: ExportResolution;
  // The same analysis the dashboard's Trend summary shows (lib/pondAnalysis.ts), written as a "Summary" sheet
  // ahead of the readings. Computed by the route before streaming starts, so a failure there still answers JSON.
  analysis: PondAnalysis;
};

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };

// Sets the response headers, builds the workbook, and streams every row — call only after
// validateExportRange() has passed. Resolves once the workbook (and so the response) is fully written.
export async function streamReadingsExport(
  res: Response,
  { pond, parameter, from, to, resolution, analysis }: ReadingsExportParams,
) {
  const filenameStem = pond.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "pond";
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filenameStem}-readings-${resolution}.xlsx"`);

  // useStyles: borders/fills/bold would otherwise be silently ignored — style info costs some performance,
  // which is exactly why the writer defaults it off.
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const columns = parameter ? [parameter] : PARAMETER_IDS;
  const generated = formatManilaTimestamp(new Date());

  // A short report header (what/who/when this covers), then a blank row before the table — reads like a
  // report exported from any reporting tool, and re-states the filter a filename alone can't (the exact range
  // and, if set, which single parameter). Both sheets carry it, so either one printed alone still says what it is.
  const writeReportHeader = (target: ExcelJS.Worksheet, extra: [string, string][] = []) => {
    target.addRow(["Pond", pond.name]).commit();
    target.addRow(["Date range (Asia/Manila)", `${formatManilaTimestamp(from)} to ${formatManilaTimestamp(to)}`]).commit();
    target.addRow(["Resolution", resolution === "raw" ? "Raw (per-minute)" : "Hourly average"]).commit();
    target.addRow(["Parameter", parameter ? PARAMETER_DISPLAY[parameter].label : "All parameters"]).commit();
    target.addRow(["Generated", generated]).commit();
    for (const row of extra) target.addRow(row).commit();
    target.addRow([]).commit();
  };

  // First sheet, so the conclusion is the first thing a reader sees: one row per parameter with the numbers
  // and, in plain words, what they mean.
  const summarySheet = workbook.addWorksheet("Summary");
  // Column widths must be set before the first row is committed: the streaming writer emits them with the
  // sheet's first bytes, and a width set later is silently dropped.
  [26, 12, 12, 12, 14, 12, 16, 18, 18, 90].forEach((width, index) => {
    summarySheet.getColumn(index + 1).width = width;
  });
  writeReportHeader(summarySheet, [
    [
      "Note",
      "Calculated the same way as the dashboard's Trend summary, from the chart data for this range; may differ " +
        "slightly from averages worked out on the Readings sheet.",
    ],
  ]);
  const summaryHeader = summarySheet.addRow([...SUMMARY_HEADERS]);
  summaryHeader.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.border = THIN_BORDER;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  summaryHeader.commit();
  for (const cells of summaryRows(columns, analysis.parameters)) {
    const row = summarySheet.addRow(cells.map((cell) => cell.value));
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const source = cells[colNumber - 1];
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: "top", wrapText: colNumber === SUMMARY_HEADERS.length };
      if (source?.numFmt) cell.numFmt = source.numFmt;
    });
    row.commit();
  }
  summarySheet.commit();

  const sheet = workbook.addWorksheet("Readings");
  // Before any row, for the same reason as the Summary sheet (these widths were previously set after the header
  // row and never reached the file).
  sheet.getColumn(1).width = 22;
  columns.forEach((colId, index) => {
    sheet.getColumn(index + 2).width = Math.max(14, PARAMETER_DISPLAY[colId].exportHeader.length + 4);
  });
  writeReportHeader(sheet);

  // One column per parameter (each cell holding a real number formatted as "value unit", e.g. "27.6 °C")
  // rather than one row per parameter per timestamp — reads as a normal wide table instead of a long,
  // repetitive log once more than one parameter is involved.
  const headerRow = sheet.addRow(["Time (Asia/Manila)", ...columns.map((colId) => PARAMETER_DISPLAY[colId].exportHeader)]);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.border = THIN_BORDER;
    cell.alignment = { horizontal: "center" };
  });
  headerRow.commit();

  if (resolution === "raw") {
    await streamPivotedXlsx<{ recordedAt: Date; id: bigint }>(sheet, columns, async (cursor) => {
      const rows = await prisma.reading.findMany({
        where: {
          pondId: pond.id,
          parameter,
          recordedAt: { gte: from, lte: to },
          ...(cursor
            ? { OR: [{ recordedAt: { gt: cursor.recordedAt } }, { recordedAt: cursor.recordedAt, id: { gt: cursor.id } }] }
            : {}),
        },
        orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
        take: EXPORT_CHUNK_SIZE,
        select: { id: true, parameter: true, value: true, recordedAt: true },
      });
      return rows.map((row) => ({
        timeKey: formatManilaTimestamp(row.recordedAt),
        parameter: row.parameter,
        value: row.value,
        cursor: { recordedAt: row.recordedAt, id: row.id },
      }));
    });
  } else {
    await streamPivotedXlsx<{ bucketStart: Date; parameter: string }>(sheet, columns, async (cursor) => {
      const rows: ReadingHourly[] = await prisma.readingHourly.findMany({
        where: {
          pondId: pond.id,
          parameter,
          bucketStart: { gte: from, lte: to },
          ...(cursor
            ? { OR: [{ bucketStart: { gt: cursor.bucketStart } }, { bucketStart: cursor.bucketStart, parameter: { gt: cursor.parameter } }] }
            : {}),
        },
        orderBy: [{ bucketStart: "asc" }, { parameter: "asc" }],
        take: EXPORT_CHUNK_SIZE,
      });
      return rows.map((row) => ({
        timeKey: formatManilaTimestamp(row.bucketStart),
        parameter: row.parameter,
        value: row.sum / row.count,
        cursor: { bucketStart: row.bucketStart, parameter: row.parameter },
      }));
    });
  }

  sheet.commit();
  await workbook.commit();
}
