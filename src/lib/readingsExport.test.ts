// Must come before ../lib/prisma.ts (see testing/guardEnv.ts).
import "../testing/guardEnv.ts";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import type { Response } from "express";
import { prisma } from "./prisma.ts";
import { streamReadingsExport } from "./readingsExport.ts";

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
