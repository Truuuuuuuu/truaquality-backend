// Must come before ../lib/prisma.ts (see testing/guardEnv.ts).
import "../testing/guardEnv.ts";
import assert from "node:assert/strict";
import { Writable, Readable } from "node:stream";
import { test } from "node:test";
import type { Response } from "express";
import { prisma } from "./prisma.ts";
import { streamReadingsExport, type SimulatedReadingsSource } from "./readingsExport.ts";
import { analyzeSeries } from "./seriesAnalysis.ts";
import { SUMMARY_HEADERS } from "./exportSummary.ts";
import ExcelJS from "exceljs";

// P6: an export whose client disconnects mid-stream must stop querying the database. The response is a plain
// Writable dressed up with the few Response members the export touches; no DB is reached (findMany is faked).

function fakeResponse() {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return Object.assign(sink, { setHeader: () => {} }) as unknown as Response & Writable;
}

const FROM = new Date("2030-01-01T00:00:00Z");
const fullPage = (page: number) =>
  Array.from({ length: 5000 }, (_, i) => ({
    pondId: "pond-1",
    parameter: "temperature",
    bucketStart: new Date(FROM.getTime() + (page * 5000 + i) * 3_600_000),
    min: 27,
    max: 29,
    sum: 28,
    count: 1,
  }));

const params = {
  pond: { id: "pond-1", name: "Pond 1" },
  parameter: "temperature" as const,
  from: FROM,
  to: new Date(FROM.getTime() + 700 * 24 * 3_600_000),
  resolution: "hour" as const,
  analysis: { from: FROM, to: FROM, previousFrom: FROM, previousTo: FROM, parameters: {} } as never,
};

test("stops paging once the client disconnects, and does not commit the workbook", async (t) => {
  const res = fakeResponse();
  let calls = 0;
  t.mock.property(prisma, "readingHourly", {
    findMany: async () => {
      calls++;
      // The client goes away while the first page is being fetched.
      if (calls === 1) res.destroy();
      return fullPage(calls - 1);
    },
  } as never);
  const warn = t.mock.method(console, "warn", () => {});

  await streamReadingsExport(res, params);

  assert.equal(calls, 1, "no page is fetched after the disconnect");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /^\[export\] client disconnected, stopped after 1 pages/);
});

test("a connected client still gets every page", async (t) => {
  const res = fakeResponse();
  let calls = 0;
  t.mock.property(prisma, "readingHourly", {
    findMany: async () => {
      calls++;
      return calls < 3 ? fullPage(calls - 1) : [];
    },
  } as never);

  await streamReadingsExport(res, params);

  assert.equal(calls, 3);
  assert.equal(res.writableFinished, true);
});

for (const resolution of ["raw", "hour"] as const) for (const filtered of [true, false]) {
  test(`DO ${resolution} ${filtered ? "filtered" : "all"} XLSX has numeric mg/L and pending summary`, async (t) => {
    const chunks: Buffer[] = [];
    const sink = new Writable({write(chunk, _encoding, callback) {chunks.push(Buffer.from(chunk)); callback();}});
    const headers = new Map<string, string>();
    const res = Object.assign(sink, {setHeader: (key: string, value: string) => { headers.set(key, value); }}) as unknown as Response & Writable;
    const rows = resolution === "raw"
      ? [{id: 1n, parameter: "dissolvedOxygen", value: 4.25, recordedAt: FROM}]
      : [{parameter: "dissolvedOxygen", bucketStart: FROM, min: 4.25, max: 4.25, sum: 8.5, count: 2}];
    let calls = 0;
    t.mock.property(prisma, resolution === "raw" ? "reading" : "readingHourly", {findMany: async () => ++calls === 1 ? rows : []} as never);
    const pending = {min: 4.25, max: 4.25, avg: 4.25, thresholdState: "pending" as const, worst: null,
      referenceComparison: {outsideShare: 1, basis: "raw_samples" as const, approximate: false, minimumResult: "outside_reference" as const},
      outOfRangeShare: null, trend: null, previousAvg: null, summary: "BFAR dissolved oxygen thresholds are pending; water quality has not been assessed."};
    await streamReadingsExport(res, {...params, parameter: filtered ? "dissolvedOxygen" : undefined, resolution,
      analysis: {from: FROM, to: FROM, previousFrom: FROM, previousTo: FROM, parameters: {dissolvedOxygen: pending}}});
    const wb = new ExcelJS.Workbook();
    assert.doesNotMatch(headers.get("Content-Disposition")!, /simulated/i);
    await wb.xlsx.read(Readable.from(chunks));
    const sheet = wb.getWorksheet("Readings")!;
    let doColumn = 0;
    let numeric = false;
    sheet.eachRow(row => row.eachCell(cell => {
      if (cell.value === "Dissolved oxygen (mg/L)") doColumn = Number(cell.col);
      if (cell.value === 4.25) {numeric = true; assert.equal(typeof cell.value, "number"); assert.match(cell.numFmt, /0\.00/);}
    }));
    assert.ok(numeric); assert.equal(doColumn, filtered ? 2 : 5);
    const summary = wb.getWorksheet("Summary")!;
    for (const target of [sheet, summary]) target.eachRow(row => row.eachCell(cell => {
      assert.doesNotMatch(String(cell.value), /Simulated data|BFAR-PHILMINAQ|assume all types|applicability/i);
    }));
    let found = false;
    summary.eachRow(row => {if (row.getCell(1).value === "Dissolved oxygen (mg/L)") {
      found = true; assert.equal(row.getCell(5).value, null); assert.equal(row.getCell(6).value, "Pending BFAR thresholds"); assert.equal(row.getCell(7).value, "Not assessed");
    }});
    assert.ok(found);
  });
}

test("daily analysis basis survives an hourly export's parsed workbook", async () => {
  const { res, chunks } = collectedResponse();
  const result = analyzeSeries([{ parameter: "dissolvedOxygen", t: FROM, avg: 5, min: 5, max: 5, count: 24 }], { from: FROM, to: new Date(+FROM + 86400000) }, null, undefined, "day").dissolvedOxygen!;
  await streamReadingsExport(res, { ...params, parameter: "dissolvedOxygen", analysis: {
    from: FROM, to: FROM, previousFrom: FROM, previousTo: FROM, resolution: "day",
    parameters: { dissolvedOxygen: { ...result, previousAvg: 5, previousChange: 0, summary: "Alert assessment pending" } },
  } }, { dataOrigin: "simulated", async *rawRows() {}, async *hourlyRows() { yield { parameter: "dissolvedOxygen", sum: 10, count: 2, bucketStart: FROM }; } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.read(Readable.from(chunks));
  wb.getWorksheet("Summary")!.eachRow(row => {
    if (row.getCell(1).value !== "Dissolved oxygen (mg/L)") return;
    assert.equal(row.getCell(9).value, 0);
    assert.equal(row.getCell(10).value, 1);
    assert.equal(row.getCell(11).value, "Approximate, based on daily averages (count-weighted)");
    assert.equal(row.getCell(12).value, 5);
    assert.equal(row.getCell(13).value, "Outside normal range");
  });
});

test("simulated source consumption has a hard bound even for filtered-out rows", async () => {
  const { res } = collectedResponse();
  let reads = 0;
  let closed = false;
  try {
    await assert.rejects(streamReadingsExport(res, { ...params, parameter: "dissolvedOxygen", resolution: "raw" }, {
      dataOrigin: "simulated", async *rawRows() {
        try {
          for (;;) { reads++; yield { parameter: "temperature", value: 28, recordedAt: FROM }; }
        } finally { closed = true; }
      }, async *hourlyRows() {},
    }), /source exceeds row limit/);
    assert.equal(reads, 100_001);
    assert.equal(closed, true);
  } finally { res.destroy(); }
});

function collectedResponse() {
  const chunks: Buffer[] = [];
  const headers = new Map<string, string>();
  const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  const res = Object.assign(sink, { setHeader: (key: string, value: string) => { headers.set(key, value); } }) as unknown as Response & Writable;
  return { res, chunks, headers };
}

for (const resolution of ["raw", "hour"] as const) for (const filtered of [true, false]) {
  test(`simulated ${resolution} ${filtered ? "DO only" : "all parameters"} roundtrip preserves numbers, reference basis and both sheet labels`, async (t) => {
    for (const delegate of ["reading", "readingHourly"] as const) t.mock.property(prisma, delegate, {
      findMany: () => { throw new Error("review must not query database"); },
    } as never);
    const values = [0, 5, 7.23];
    const dates = values.map((_, i) => new Date(+FROM + i * 3_600_000));
    const result = analyzeSeries(values.map((value, i) => ({ parameter: "dissolvedOxygen", t: dates[i]!, avg: value, min: value, max: value, count: 1 })), { from: FROM, to: dates[2]! }, null, undefined, resolution).dissolvedOxygen!;
    const source: SimulatedReadingsSource = {
      dataOrigin: "simulated",
      async *rawRows() { for (let i = 0; i < values.length; i++) {
        yield { parameter: "temperature", value: 28, recordedAt: dates[i]! };
        yield { parameter: "dissolvedOxygen", value: values[i]!, recordedAt: dates[i]! };
      } },
      async *hourlyRows() { for (let i = 0; i < values.length; i++) {
        yield { parameter: "temperature", sum: 56, count: 2, bucketStart: dates[i]! };
        yield { parameter: "dissolvedOxygen", sum: values[i]! * 2, count: 2, bucketStart: dates[i]! };
      } },
    };
    const { res, chunks, headers } = collectedResponse();
    await streamReadingsExport(res, { ...params, parameter: filtered ? "dissolvedOxygen" : undefined, resolution,
      analysis: { from: FROM, to: dates[2]!, previousFrom: FROM, previousTo: FROM, resolution,
        parameters: { dissolvedOxygen: { ...result, previousAvg: null, previousChange: null, summary: "Alert assessment pending" } } } }, source);
    assert.match(headers.get("Content-Disposition")!, /filename="Simulated-data-Pond-1-readings/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.read(Readable.from(chunks));
    for (const sheetName of ["Summary", "Readings"]) {
      const sheet = wb.getWorksheet(sheetName)!;
      assert.equal(sheet.getCell("A1").value, "Simulated data");
      sheet.eachRow(row => row.eachCell(cell => assert.doesNotMatch(String(cell.value), /BFAR-PHILMINAQ|2007|assume all types|applicability|provenance/i)));
    }
    const readings = wb.getWorksheet("Readings")!;
    let headerRow = 0;
    readings.eachRow(row => { if (row.getCell(1).value === "Time (Asia/Manila)") headerRow = row.number; });
    assert.ok(headerRow);
    assert.equal(readings.getRow(headerRow).cellCount, filtered ? 2 : 5);
    for (let i = 0; i < values.length; i++) {
      const cell = readings.getRow(headerRow + i + 1).getCell(filtered ? 2 : 5);
      assert.equal(cell.value, values[i]);
      assert.equal(cell.type, ExcelJS.ValueType.Number);
      assert.equal(cell.numFmt, '0.00" mg/L"');
    }
    const summary = wb.getWorksheet("Summary")!;
    let found = false;
    summary.eachRow(row => {
      if (row.getCell(1).value !== "Dissolved oxygen (mg/L)") return;
      found = true;
      assert.equal(row.cellCount, SUMMARY_HEADERS.length);
      assert.equal(row.getCell(5).value, null);
      assert.equal(row.getCell(6).value, "Pending BFAR thresholds");
      assert.equal(row.getCell(7).value, "Not assessed");
      assert.equal(row.getCell(9).value, "No data before");
      assert.equal(row.getCell(10).value, 2 / 3);
      assert.equal(row.getCell(10).numFmt, "0%");
      assert.equal(row.getCell(11).value, resolution === "raw" ? "Raw samples" : "Approximate, based on hourly averages (count-weighted)");
      assert.equal(row.getCell(12).value, 0);
      assert.equal(row.getCell(12).numFmt, '0.00" mg/L"');
      assert.equal(row.getCell(13).value, "Outside normal range");
    });
    assert.ok(found);
  });
}

for (const resolution of ["raw", "hour"] as const) {
  test(`empty simulated ${resolution} workbook has blank comparison rather than zero`, async () => {
    const { res, chunks } = collectedResponse();
    await streamReadingsExport(res, { ...params, parameter: "dissolvedOxygen", resolution }, {
      dataOrigin: "simulated", async *rawRows() {}, async *hourlyRows() {},
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.read(Readable.from(chunks));
    wb.getWorksheet("Summary")!.eachRow(row => {
      if (row.getCell(1).value !== "Dissolved oxygen (mg/L)") return;
      assert.equal(row.getCell(10).value, null);
      assert.equal(row.getCell(12).value, null);
      assert.equal(row.getCell(14).value, "No readings in this range.");
    });
  });
  test(`simulated ${resolution} iterator stops on disconnect and releases source`, async (t) => {
    const { res } = collectedResponse();
    let read = 0;
    let closed = false;
    async function* rows() {
      try {
        for (let i = 0; i < 10_000; i++) {
          read++;
          if (read === 2) res.destroy();
          yield { parameter: "dissolvedOxygen", value: 5, recordedAt: FROM, sum: 10, count: 2, bucketStart: FROM };
        }
      } finally { closed = true; }
    }
    t.mock.method(console, "warn", () => {});
    await streamReadingsExport(res, { ...params, parameter: "dissolvedOxygen", resolution }, {
      dataOrigin: "simulated", rawRows: rows, hourlyRows: rows,
    });
    assert.equal(read, 2);
    assert.equal(closed, true);
    assert.equal(res.writableFinished, false);
  });
}
