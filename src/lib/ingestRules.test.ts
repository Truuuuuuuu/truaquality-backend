import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifySamples, deriveDeviceEvents, MAX_SAMPLE_AGE_MS, MAX_SAMPLE_SKEW_MS } from "./ingestRules.ts";

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

describe("deriveDeviceEvents", () => {
  const baseSample = [{ values: { temperature: 27 } }];
  const diag = (uptimeS: number, resetReason: "power_on" | "brownout" = "power_on") => ({
    rssi: -60,
    uptimeS,
    resetReason,
    freeHeap: 200000,
    queued: 0,
  });
  const prev = (overrides: Partial<{ firmwareVersion: string | null; uptimeS: number | null; sensorStatus: unknown }>) => ({
    firmwareVersion: null,
    uptimeS: null,
    sensorStatus: null,
    ...overrides,
  });

  test("uptime going backwards is a REBOOT carrying the reset reason", () => {
    const events = deriveDeviceEvents(prev({ uptimeS: 5000 }), { diag: diag(60, "brownout"), samples: baseSample });
    assert.deepEqual(events, [{ kind: "REBOOT", parameter: null, detail: "brownout" }]);
  });
  test("first diag ever (previous uptime null) is not a REBOOT", () => {
    assert.deepEqual(deriveDeviceEvents(prev({}), { diag: diag(60), samples: baseSample }), []);
  });
  test("increasing uptime is not a REBOOT", () => {
    assert.deepEqual(deriveDeviceEvents(prev({ uptimeS: 60 }), { diag: diag(120), samples: baseSample }), []);
  });

  test("firmware version change", () => {
    const events = deriveDeviceEvents(prev({ firmwareVersion: "0.5.0" }), { firmwareVersion: "0.6.0", samples: baseSample });
    assert.deepEqual(events, [{ kind: "FIRMWARE_CHANGED", parameter: null, detail: "0.5.0 → 0.6.0" }]);
  });
  test("no firmware event from null, the same version, or a message without a version", () => {
    assert.deepEqual(deriveDeviceEvents(prev({}), { firmwareVersion: "0.6.0", samples: baseSample }), []);
    assert.deepEqual(deriveDeviceEvents(prev({ firmwareVersion: "0.6.0" }), { firmwareVersion: "0.6.0", samples: baseSample }), []);
    assert.deepEqual(deriveDeviceEvents(prev({ firmwareVersion: "0.6.0" }), { samples: baseSample }), []);
  });

  test("ok -> not_found is a SENSOR_FAULT", () => {
    const events = deriveDeviceEvents(prev({ sensorStatus: { temperature: "ok" } }), {
      sensors: { temperature: "not_found" },
      samples: baseSample,
    });
    assert.deepEqual(events, [{ kind: "SENSOR_FAULT", parameter: "temperature", detail: "not_found" }]);
  });
  test("not_found -> ok is a SENSOR_RECOVERED", () => {
    const events = deriveDeviceEvents(prev({ sensorStatus: { temperature: "not_found" } }), {
      sensors: { temperature: "ok" },
      samples: baseSample,
    });
    assert.deepEqual(events, [{ kind: "SENSOR_RECOVERED", parameter: "temperature", detail: "ok" }]);
  });
  test("one fault changing to another is a new SENSOR_FAULT", () => {
    const events = deriveDeviceEvents(prev({ sensorStatus: { temperature: "not_found" } }), {
      sensors: { temperature: "disconnected" },
      samples: baseSample,
    });
    assert.deepEqual(events, [{ kind: "SENSOR_FAULT", parameter: "temperature", detail: "disconnected" }]);
  });
  test("the same fault twice records nothing", () => {
    const events = deriveDeviceEvents(prev({ sensorStatus: { temperature: "not_found" } }), {
      sensors: { temperature: "not_found" },
      samples: baseSample,
    });
    assert.deepEqual(events, []);
  });
  test("a fault on first report (missing key or null sensorStatus) is recorded; ok on first report is not", () => {
    for (const sensorStatus of [null, {}, { turbidity: "ok" }, "garbage", ["x"]]) {
      assert.deepEqual(deriveDeviceEvents(prev({ sensorStatus }), { sensors: { temperature: "not_found" }, samples: baseSample }), [
        { kind: "SENSOR_FAULT", parameter: "temperature", detail: "not_found" },
      ]);
      assert.deepEqual(deriveDeviceEvents(prev({ sensorStatus }), { sensors: { temperature: "ok" }, samples: baseSample }), []);
    }
  });
  test("a message without sensors derives no sensor events", () => {
    assert.deepEqual(deriveDeviceEvents(prev({ sensorStatus: { temperature: "ok" } }), { samples: baseSample }), []);
  });
  test("order: FIRMWARE_CHANGED, REBOOT, then sensors in message key order", () => {
    const events = deriveDeviceEvents(
      prev({ firmwareVersion: "0.5.0", uptimeS: 900, sensorStatus: { temperature: "ok", turbidity: "no_signal" } }),
      {
        firmwareVersion: "0.6.0",
        diag: diag(10),
        sensors: { turbidity: "ok", temperature: "disconnected" },
        samples: baseSample,
      },
    );
    assert.deepEqual(
      events.map((e) => [e.kind, e.parameter]),
      [
        ["FIRMWARE_CHANGED", null],
        ["REBOOT", null],
        ["SENSOR_RECOVERED", "turbidity"],
        ["SENSOR_FAULT", "temperature"],
      ],
    );
  });
});
