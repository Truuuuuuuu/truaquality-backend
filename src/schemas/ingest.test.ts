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

  describe("diag", () => {
    const diag = { rssi: -67, uptimeS: 86400, resetReason: "power_on", freeHeap: 201344, queued: 3 };
    const withDiag = (overrides: Record<string, unknown>) => ({ diag: { ...diag, ...overrides }, samples: [sample] });

    test("is optional (absent leaves no key)", () => {
      const parsed = ingestSchema.parse({ samples: [sample] });
      assert.equal("diag" in parsed, false);
    });
    test("a full valid diag is accepted", () => {
      const parsed = ingestSchema.parse({ diag, samples: [sample] });
      assert.deepEqual(parsed.diag, diag);
    });
    test("rssi -127 and 0 accepted; -128, 1 and -67.5 rejected", () => {
      assert.equal(ingestSchema.safeParse(withDiag({ rssi: -127 })).success, true);
      assert.equal(ingestSchema.safeParse(withDiag({ rssi: 0 })).success, true);
      assert.equal(ingestSchema.safeParse(withDiag({ rssi: -128 })).success, false);
      assert.equal(ingestSchema.safeParse(withDiag({ rssi: 1 })).success, false);
      assert.equal(ingestSchema.safeParse(withDiag({ rssi: -67.5 })).success, false);
    });
    test("queued 120 accepted, 121 rejected", () => {
      assert.equal(ingestSchema.safeParse(withDiag({ queued: 120 })).success, true);
      assert.equal(ingestSchema.safeParse(withDiag({ queued: 121 })).success, false);
    });
    test("uptimeS -1 rejected", () => {
      assert.equal(ingestSchema.safeParse(withDiag({ uptimeS: -1 })).success, false);
    });
    test("freeHeap 1.5 rejected", () => {
      assert.equal(ingestSchema.safeParse(withDiag({ freeHeap: 1.5 })).success, false);
    });
    test("resetReason must be a known token", () => {
      assert.equal(ingestSchema.safeParse(withDiag({ resetReason: "brownout" })).success, true);
      assert.equal(ingestSchema.safeParse(withDiag({ resetReason: "reboot" })).success, false);
    });
  });

  describe("sensors", () => {
    test("is optional (absent leaves no key)", () => {
      const parsed = ingestSchema.parse({ samples: [sample] });
      assert.equal("sensors" in parsed, false);
    });
    test("turbidity is accepted before it is a known parameter", () => {
      const parsed = ingestSchema.parse({ sensors: { temperature: "ok", turbidity: "no_signal" }, samples: [sample] });
      assert.deepEqual(parsed.sensors, { temperature: "ok", turbidity: "no_signal" });
    });
    test("an unknown status is rejected", () => {
      assert.equal(ingestSchema.safeParse({ sensors: { temperature: "broken" }, samples: [sample] }).success, false);
    });
    test("a malformed key is rejected", () => {
      assert.equal(ingestSchema.safeParse({ sensors: { "Bad Key": "ok" }, samples: [sample] }).success, false);
    });
    test("8 keys accepted, 9 rejected", () => {
      const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`sensor${i}`, "ok"]));
      assert.equal(ingestSchema.safeParse({ sensors: keys(8), samples: [sample] }).success, true);
      assert.equal(ingestSchema.safeParse({ sensors: keys(9), samples: [sample] }).success, false);
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
