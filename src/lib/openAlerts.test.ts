// Must come before ./prisma.ts (see testing/guardEnv.ts).
import "../testing/guardEnv.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadOpenAlerts, openAlertsByPond } from "./openAlerts.ts";
import { prisma } from "./prisma.ts";

describe("openAlertsByPond (unresolved Alert rows -> per-pond map)", () => {
  test("no rows yields an empty map", () => {
    assert.deepEqual(openAlertsByPond([]), new Map());
  });

  test("rows for two ponds give one entry per pond, keyed by parameter", () => {
    const result = openAlertsByPond([
      { pondId: "a", parameter: "turbidity", severity: "WARNING" },
      { pondId: "a", parameter: "temperature", severity: "CRITICAL" },
      { pondId: "b", parameter: "ph", severity: "WARNING" },
    ]);
    assert.deepEqual(
      result,
      new Map([
        ["a", { turbidity: "WARNING", temperature: "CRITICAL" }],
        ["b", { ph: "WARNING" }],
      ]),
    );
  });

  test("a row for an unknown parameter is dropped", () => {
    const result = openAlertsByPond([
      { pondId: "a", parameter: "salinity", severity: "CRITICAL" },
      { pondId: "a", parameter: "turbidity", severity: "WARNING" },
      { pondId: "b", parameter: "dissolved_oxygen", severity: "WARNING" },
    ]);
    assert.deepEqual(result, new Map([["a", { turbidity: "WARNING" }]]));
  });

  test("duplicate unresolved rows keep CRITICAL over WARNING regardless of order", () => {
    const warningFirst = openAlertsByPond([
      { pondId: "a", parameter: "turbidity", severity: "WARNING" },
      { pondId: "a", parameter: "turbidity", severity: "CRITICAL" },
    ]);
    const criticalFirst = openAlertsByPond([
      { pondId: "a", parameter: "turbidity", severity: "CRITICAL" },
      { pondId: "a", parameter: "turbidity", severity: "WARNING" },
    ]);
    assert.deepEqual(warningFirst, new Map([["a", { turbidity: "CRITICAL" }]]));
    assert.deepEqual(criticalFirst, new Map([["a", { turbidity: "CRITICAL" }]]));
  });
});

describe("loadOpenAlerts (one batched query)", () => {
  test("no pond ids returns an empty map without querying", async (t) => {
    let calls = 0;
    t.mock.property(prisma, "alert", {
      findMany: async () => {
        calls++;
        return [];
      },
    } as never);

    assert.deepEqual(await loadOpenAlerts([]), new Map());
    assert.equal(calls, 0);
  });

  test("queries unresolved alerts for every pond at once and shapes the rows", async (t) => {
    const calls: unknown[] = [];
    t.mock.property(prisma, "alert", {
      findMany: async (args: unknown) => {
        calls.push(args);
        return [
          { pondId: "a", parameter: "turbidity", severity: "WARNING" },
          { pondId: "b", parameter: "temperature", severity: "CRITICAL" },
        ];
      },
    } as never);

    const result = await loadOpenAlerts(["a", "b"]);

    assert.deepEqual(calls, [
      {
        where: { pondId: { in: ["a", "b"] }, resolvedAt: null },
        select: { pondId: true, parameter: true, severity: true },
      },
    ]);
    assert.deepEqual(
      result,
      new Map([
        ["a", { turbidity: "WARNING" }],
        ["b", { temperature: "CRITICAL" }],
      ]),
    );
  });
});
