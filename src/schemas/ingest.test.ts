import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ingestSchema } from "./ingest.ts";

// The recordedAt refine reads Date.now() internally, so tests touching recordedAt freeze the clock with
// mock.timers instead of racing the wall clock.
const NOW = Date.parse("2030-01-01T00:00:00Z");
const SKEW_MS = 5 * 60 * 1000;

const sample = { values: { temperature: 27 } };
const samples = (n: number) => Array.from({ length: n }, () => sample);

describe("ingestSchema", () => {
  describe("sample count", () => {
    test("0 samples is rejected", () => {
      assert.equal(ingestSchema.safeParse({ samples: [] }).success, false);
    });
    for (const n of [1, 120]) {
      test(`${n} samples is accepted`, () => {
        assert.equal(ingestSchema.safeParse({ samples: samples(n) }).success, true);
      });
    }
    test("121 samples is rejected", () => {
      assert.equal(ingestSchema.safeParse({ samples: samples(121) }).success, false);
    });
  });

  describe("wifiSsid", () => {
    test("is optional and trimmed", () => {
      assert.equal(ingestSchema.safeParse({ samples: [sample] }).success, true);
      const parsed = ingestSchema.parse({ wifiSsid: "  Fish Farm  ", samples: [sample] });
      assert.equal(parsed.wifiSsid, "Fish Farm");
    });
    test("is capped at 32 characters", () => {
      assert.equal(ingestSchema.safeParse({ wifiSsid: "x".repeat(32), samples: [sample] }).success, true);
      assert.equal(ingestSchema.safeParse({ wifiSsid: "x".repeat(33), samples: [sample] }).success, false);
    });
  });

  describe("firmwareVersion", () => {
    test("is trimmed", () => {
      const parsed = ingestSchema.parse({ firmwareVersion: "  0.3.0  ", samples: [sample] });
      assert.equal(parsed.firmwareVersion, "0.3.0");
    });
    test("32 chars accepted, 33 rejected", () => {
      assert.equal(ingestSchema.safeParse({ firmwareVersion: "x".repeat(32), samples: [sample] }).success, true);
      assert.equal(ingestSchema.safeParse({ firmwareVersion: "x".repeat(33), samples: [sample] }).success, false);
    });
  });

  describe("values", () => {
    test("a string value rejects the whole message", () => {
      const result = ingestSchema.safeParse({
        samples: [sample, { values: { temperature: "27.5" } }],
      });
      assert.equal(result.success, false);
    });
    test("a null value is accepted", () => {
      const parsed = ingestSchema.parse({ samples: [{ values: { temperature: null } }] });
      assert.equal(parsed.samples[0]!.values.temperature, null);
    });
  });

  describe("recordedAt", () => {
    test("offset timestamp is accepted and parsed to the same instant", (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: NOW });
      const parsed = ingestSchema.parse({
        samples: [{ recordedAt: "2030-01-01T08:00:00+08:00", values: { temperature: 27 } }],
      });
      assert.equal(parsed.samples[0]!.recordedAt!.getTime(), NOW);
    });

    test("now + 5 min is accepted", (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: NOW });
      const recordedAt = new Date(NOW + SKEW_MS).toISOString();
      assert.equal(ingestSchema.safeParse({ samples: [{ recordedAt, values: { temperature: 27 } }] }).success, true);
    });

    test("now + 5 min + 1 s is rejected as in the future", (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: NOW });
      const recordedAt = new Date(NOW + SKEW_MS + 1000).toISOString();
      const result = ingestSchema.safeParse({ samples: [{ recordedAt, values: { temperature: 27 } }] });
      assert.equal(result.success, false);
      assert.ok(result.error.issues.some((issue) => issue.message === "recordedAt is in the future"));
    });
  });
});
