import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_RANGE_MESSAGE, MAX_RANGE_MS, seriesQuery } from "./ponds.ts";

// seriesQuery backs both /series and /analysis. The open-ended case reads Date.now(), so it freezes the clock.
const NOW = Date.parse("2030-01-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("seriesQuery range cap", () => {
  test("from 1970 with no `to` is rejected", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const result = seriesQuery.safeParse({ from: "1970-01-01T00:00:00Z" });
    assert.equal(result.success, false);
    assert.ok(result.error.issues.some((issue) => issue.message === MAX_RANGE_MESSAGE));
  });

  test("exactly 2 years is accepted", () => {
    assert.equal(seriesQuery.safeParse({ from: iso(NOW - MAX_RANGE_MS), to: iso(NOW) }).success, true);
  });

  test("2 years + 1 s is rejected", () => {
    assert.equal(seriesQuery.safeParse({ from: iso(NOW - MAX_RANGE_MS - 1000), to: iso(NOW) }).success, false);
  });

  test("a 24 h rolling window is accepted", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    assert.equal(seriesQuery.safeParse({ from: iso(NOW - 24 * 60 * 60 * 1000) }).success, true);
  });
});
