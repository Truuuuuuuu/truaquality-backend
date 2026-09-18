import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifySamples, MAX_SAMPLE_AGE_MS, MAX_SAMPLE_SKEW_MS } from "./ingestRules.ts";

// Characterization of today's (temperature-only) ingest decisions. Pure: no DB, no env, no wall clock — every
// timestamp is derived from a fixed receivedAt so the boundaries are exact.
const R = new Date("2030-01-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ASSIGNED_AT = new Date(R.getTime() - DAY_MS);
const device = { id: "d1", pondId: "p1", assignedAt: ASSIGNED_AT };
const unassignedClock = { id: "d1", pondId: "p1", assignedAt: null };

const at = (offsetMs: number) => new Date(R.getTime() + offsetMs);

describe("classifySamples", () => {
  test("recordedAt omitted falls back to receivedAt", () => {
    const { rows, rejected } = classifySamples(device, [{ values: { temperature: 27 } }], R);
    assert.equal(rejected.length, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.recordedAt.getTime(), R.getTime());
  });

  test("row shape and storedParameters", () => {
    const recordedAt = at(-60_000);
    const { rows, storedParameters } = classifySamples(device, [{ recordedAt, values: { temperature: 27.5 } }], R);
    assert.deepEqual(rows, [
      { pondId: "p1", deviceId: "d1", parameter: "temperature", value: 27.5, recordedAt, receivedAt: R },
    ]);
    assert.deepEqual([...storedParameters], ["temperature"]);
  });

  test("null value is dropped silently — neither a row nor a rejection", () => {
    const { rows, rejected, storedParameters } = classifySamples(device, [{ values: { temperature: null } }], R);
    assert.equal(rows.length, 0);
    assert.equal(rejected.length, 0);
    assert.equal(storedParameters.size, 0);
  });

  describe("assignedAt", () => {
    test("1 ms before assignedAt rejects every non-null value", () => {
      const recordedAt = new Date(ASSIGNED_AT.getTime() - 1);
      const { rows, rejected } = classifySamples(
        device,
        [{ recordedAt, values: { temperature: 27, ph: 7, other: null } }],
        R,
      );
      assert.equal(rows.length, 0);
      assert.deepEqual(rejected, [
        { recordedAt, parameter: "temperature", value: 27, reason: "recorded before the device was assigned to this pond" },
        { recordedAt, parameter: "ph", value: 7, reason: "recorded before the device was assigned to this pond" },
      ]);
    });

    test("exactly assignedAt is accepted", () => {
      const { rows, rejected } = classifySamples(
        device,
        [{ recordedAt: new Date(ASSIGNED_AT.getTime()), values: { temperature: 27 } }],
        R,
      );
      assert.equal(rejected.length, 0);
      assert.equal(rows.length, 1);
    });

    test("assignedAt null skips the check", () => {
      const { rows, rejected } = classifySamples(
        unassignedClock,
        [{ recordedAt: new Date(ASSIGNED_AT.getTime() - 1), values: { temperature: 27 } }],
        R,
      );
      assert.equal(rejected.length, 0);
      assert.equal(rows.length, 1);
    });
  });

  describe("age", () => {
    test("exactly MAX_SAMPLE_AGE_MS old is accepted", () => {
      const { rows, rejected } = classifySamples(
        unassignedClock,
        [{ recordedAt: at(-MAX_SAMPLE_AGE_MS), values: { temperature: 27 } }],
        R,
      );
      assert.equal(rejected.length, 0);
      assert.equal(rows.length, 1);
    });

    test("1 ms older is rejected", () => {
      const { rows, rejected } = classifySamples(
        unassignedClock,
        [{ recordedAt: at(-MAX_SAMPLE_AGE_MS - 1), values: { temperature: 27 } }],
        R,
      );
      assert.equal(rows.length, 0);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0]!.reason, "older than 7 days");
    });
  });

  describe("future skew", () => {
    test("exactly MAX_SAMPLE_SKEW_MS ahead is accepted", () => {
      const { rows, rejected } = classifySamples(
        device,
        [{ recordedAt: at(MAX_SAMPLE_SKEW_MS), values: { temperature: 27 } }],
        R,
      );
      assert.equal(rejected.length, 0);
      assert.equal(rows.length, 1);
    });

    test("1 ms further ahead is rejected", () => {
      const { rows, rejected } = classifySamples(
        device,
        [{ recordedAt: at(MAX_SAMPLE_SKEW_MS + 1), values: { temperature: 27 } }],
        R,
      );
      assert.equal(rows.length, 0);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0]!.reason, "recorded in the future (check the device clock)");
    });
  });

  test("precedence: before assignedAt AND older than 7 days reports the assignedAt reason", () => {
    const { rejected } = classifySamples(
      device,
      [{ recordedAt: at(-MAX_SAMPLE_AGE_MS - DAY_MS), values: { temperature: 27 } }],
      R,
    );
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.reason, "recorded before the device was assigned to this pond");
  });

  test("unknown parameter ids are rejected while a valid temperature in the same sample is stored", () => {
    const values = { ph: 7, Temperature: 27, toString: 1, temperature: 28 } as Record<string, number>;
    // "__proto__" as an own key, the way JSON.parse would produce it.
    Object.defineProperty(values, "__proto__", { value: 2, enumerable: true, configurable: true, writable: true });
    const { rows, rejected, storedParameters } = classifySamples(device, [{ values }], R);

    assert.deepEqual(
      rows.map((r) => [r.parameter, r.value]),
      [["temperature", 28]],
    );
    assert.deepEqual([...storedParameters], ["temperature"]);
    assert.deepEqual(
      rejected.map((r) => [r.parameter, r.reason]).sort(),
      [
        ["Temperature", "unknown parameter"],
        ["__proto__", "unknown parameter"],
        ["ph", "unknown parameter"],
        ["toString", "unknown parameter"],
      ],
    );
  });

  describe("bounds", () => {
    for (const value of [-5, 60]) {
      test(`${value} is accepted`, () => {
        const { rows, rejected } = classifySamples(device, [{ values: { temperature: value } }], R);
        assert.equal(rejected.length, 0);
        assert.equal(rows[0]!.value, value);
      });
    }
    for (const value of [-5.01, 60.01]) {
      test(`${value} is rejected`, () => {
        const { rows, rejected, storedParameters } = classifySamples(device, [{ values: { temperature: value } }], R);
        assert.equal(rows.length, 0);
        assert.equal(storedParameters.size, 0);
        assert.deepEqual(rejected, [{ recordedAt: R, parameter: "temperature", value, reason: "outside -5..60" }]);
      });
    }
  });

  test("two identical samples in one batch produce two rows (dedupe is the DB's job)", () => {
    const sample = { recordedAt: at(-60_000), values: { temperature: 27 } };
    const { rows } = classifySamples(device, [sample, { ...sample }], R);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], rows[1]);
  });
});
