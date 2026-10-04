import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { excelNumberFormat } from "./exportSummary.ts";
import {
  ALERT_HOLD_MAX_GAP_MS,
  ALERT_HOLD_READINGS,
  PARAMETER_BOUNDS,
  PARAMETER_DISPLAY,
  PARAMETER_IDS,
  PARAMETER_THRESHOLDS,
  PH_CRITICAL_MAX,
  PH_CRITICAL_MIN,
  severityFor,
  TURBIDITY_CRITICAL_MAX_NTU,
  thresholdProfileFor,
  thresholdsFor,
  type Threshold,
  type ThresholdProfile,
} from "./parameters.ts";

const PROFILES = Object.keys(PARAMETER_THRESHOLDS) as ThresholdProfile[];

describe("thresholdProfileFor", () => {
  test("null, undefined and an unknown type fall back to UNSET", () => {
    assert.equal(thresholdProfileFor(null), "UNSET");
    assert.equal(thresholdProfileFor(undefined), "UNSET");
    assert.equal(thresholdProfileFor("LAKE"), "UNSET");
  });

  test("the three named pond types map to themselves", () => {
    for (const t of ["FRESHWATER", "BRACKISH", "SALTWATER"] as const) {
      assert.equal(thresholdProfileFor(t), t);
    }
  });

  test("there are exactly four profiles", () => {
    assert.deepEqual([...PROFILES].sort(), ["BRACKISH", "FRESHWATER", "SALTWATER", "UNSET"]);
  });

  test("thresholdsFor resolves through the profile", () => {
    assert.equal(thresholdsFor("FRESHWATER"), PARAMETER_THRESHOLDS.FRESHWATER);
    assert.equal(thresholdsFor(null), PARAMETER_THRESHOLDS.UNSET);
  });
});

describe("severityFor — temperature edges (BFAR: safe 20-30, critical 15-35.5)", () => {
  const cases: Array<[number, "WARNING" | "CRITICAL" | null]> = [
    [14.99, "CRITICAL"],
    [15, "WARNING"],
    [19.99, "WARNING"],
    [20, null],
    [28, null],
    [30, null],
    [30.01, "WARNING"],
    [35.5, "WARNING"],
    [35.51, "CRITICAL"],
  ];
  for (const [value, expected] of cases) {
    test(`${value} -> ${expected}`, () => {
      for (const pondType of [null, "FRESHWATER", "BRACKISH", "SALTWATER"]) {
        assert.equal(severityFor("temperature", value, pondType), expected);
      }
    });
  }
});

// The low side of the band ordering: criticalMin <= safeMin. Turbidity's low side is 0/0 — one-sided by design
// (ALRT-03, clear water has no meaningful "too low") — and still satisfies this check, since 0 <= 0.
function assertLowSideOrdered(label: string, t: Threshold) {
  assert.ok(t.criticalMin <= t.safeMin, `${label}: criticalMin ${t.criticalMin} > safeMin ${t.safeMin}`);
}

function assertHighSideOrdered(label: string, t: Threshold) {
  assert.ok(t.safeMin < t.safeMax, `${label}: safeMin ${t.safeMin} >= safeMax ${t.safeMax}`);
  assert.ok(t.safeMax <= t.criticalMax, `${label}: safeMax ${t.safeMax} > criticalMax ${t.criticalMax}`);
}

describe("threshold invariants over every parameter x profile", () => {
  for (const profile of PROFILES) {
    for (const id of PARAMETER_IDS) {
      test(`${profile}/${id}`, () => {
        const t = PARAMETER_THRESHOLDS[profile][id];
        assert.ok(t, `${profile} has no threshold for ${id}`);
        const label = `${profile}/${id}`;
        assertLowSideOrdered(label, t);
        assertHighSideOrdered(label, t);
        const bounds = PARAMETER_BOUNDS[id];
        assert.ok(t.safeMin >= bounds.min, `${label}: safe band below PARAMETER_BOUNDS.min`);
        assert.ok(t.safeMax <= bounds.max, `${label}: safe band above PARAMETER_BOUNDS.max`);
      });
    }
  }

  test("PARAMETER_DISPLAY has an entry per parameter id", () => {
    for (const id of PARAMETER_IDS) {
      const d = PARAMETER_DISPLAY[id];
      assert.ok(d, `no display entry for ${id}`);
      assert.equal(typeof d.label, "string");
      assert.equal(typeof d.unit, "string");
      assert.ok(Number.isInteger(d.precision));
    }
  });
});

describe("turbidity (NTU) — BFAR safeMax 25, criticalMax PENDING BFAR", () => {
  const TB = thresholdsFor(null).turbidity;
  const POND_TYPES = [null, "FRESHWATER", "BRACKISH", "SALTWATER", "LAKE"];

  test("PARAMETER_IDS is temperature, turbidity, then ph (export column order)", () => {
    assert.deepEqual(PARAMETER_IDS, ["temperature", "turbidity", "ph"]);
  });

  test("bounds accept every firmware value 0..3000 NTU with refit headroom", () => {
    assert.deepEqual(PARAMETER_BOUNDS.turbidity, { min: 0, max: 4000 });
    // 3000 here is the firmware's vendor-curve clamp ceiling (Phase 3 D-02), not a threshold.
    assert.ok(PARAMETER_BOUNDS.turbidity.max >= 3000);
  });

  test("safeMax is BFAR's 25 NTU (the one pinned threshold literal)", () => {
    assert.equal(thresholdsFor(null).turbidity.safeMax, 25);
  });

  test("criticalMax is the named PENDING BFAR constant, above safeMax and reachable within bounds", () => {
    assert.equal(TB.criticalMax, TURBIDITY_CRITICAL_MAX_NTU);
    assert.ok(TB.safeMax < TB.criticalMax);
    assert.ok(TB.criticalMax + 1 <= PARAMETER_BOUNDS.turbidity.max);
  });

  const edges: Array<[string, () => number, "WARNING" | "CRITICAL" | null]> = [
    ["bounds.min", () => PARAMETER_BOUNDS.turbidity.min, null],
    ["0 (clear water)", () => 0, null],
    ["safeMax", () => TB.safeMax, null],
    ["safeMax + 0.01", () => TB.safeMax + 0.01, "WARNING"],
    ["criticalMax", () => TB.criticalMax, "WARNING"],
    ["criticalMax + 0.01", () => TB.criticalMax + 0.01, "CRITICAL"],
  ];
  for (const [label, value, expected] of edges) {
    test(`${label} -> ${expected} for every pond type`, () => {
      for (const pondType of POND_TYPES) {
        assert.equal(severityFor("turbidity", value(), pondType), expected, `pondType ${pondType}`);
      }
    });
  }

  // The pending marker changes only what the dashboard draws, never the judgement: an in-bounds value above the
  // placeholder (possible after a bench refit of the curve) is still CRITICAL, so the frontend chart colors that
  // stretch red and shows the real number instead of "≥ 3000" (Phase 6 review WR-03).
  test("WR-03: every in-bounds value above the pending placeholder stays CRITICAL", () => {
    assert.equal(TB.criticalPending, true);
    for (const value of [TB.criticalMax + 0.1, 3500, PARAMETER_BOUNDS.turbidity.max]) {
      assert.ok(value <= PARAMETER_BOUNDS.turbidity.max, `${value} out of bounds`);
      for (const pondType of POND_TYPES) {
        assert.equal(severityFor("turbidity", value, pondType), "CRITICAL", `${value} pondType ${pondType}`);
      }
    }
  });

  test("ALRT-03: no accepted value can be low for any profile", () => {
    for (const profile of PROFILES) {
      const t = PARAMETER_THRESHOLDS[profile].turbidity;
      assert.ok(t.safeMin <= PARAMETER_BOUNDS.turbidity.min, `${profile}: safeMin above bounds.min`);
      assert.ok(t.criticalMin <= PARAMETER_BOUNDS.turbidity.min, `${profile}: criticalMin above bounds.min`);
    }
  });

  test("D-05: every profile resolves the same shared turbidity band", () => {
    for (const profile of PROFILES) {
      assert.deepEqual(PARAMETER_THRESHOLDS[profile].turbidity, PARAMETER_THRESHOLDS.UNSET.turbidity);
    }
  });

  test("display metadata is Turbidity / NTU / precision 1, approximate, 3000 NTU ceiling", () => {
    assert.deepEqual(PARAMETER_DISPLAY.turbidity, {
      label: "Turbidity",
      unit: "NTU",
      precision: 1,
      exportHeader: "Turbidity (NTU, approx.)",
      approximate: true,
      sensorCeiling: 3000,
    });
  });

  test("D-03: turbidity critical line is marked pending in every profile", () => {
    for (const profile of PROFILES) {
      assert.equal(PARAMETER_THRESHOLDS[profile].turbidity.criticalPending, true, `${profile}: not pending`);
    }
  });

  test("D-03: temperature carries no criticalPending key (JSON omits it)", () => {
    for (const profile of PROFILES) {
      assert.equal("criticalPending" in PARAMETER_THRESHOLDS[profile].temperature, false, `${profile}`);
    }
  });

  test("D-12: export header is Turbidity (NTU, approx.); label stays plain", () => {
    assert.equal(PARAMETER_DISPLAY.turbidity.exportHeader, "Turbidity (NTU, approx.)");
    assert.equal(PARAMETER_DISPLAY.temperature.exportHeader, "Temperature");
    assert.equal(PARAMETER_DISPLAY.turbidity.label, "Turbidity");
  });

  test("export-format guard: every precision >= 1, turbidity format is 0.0\" NTU\", pH is a bare 0.00", () => {
    // excelNumberFormat builds `0.` + precision zeros; precision 0 would leave a stray decimal point.
    for (const id of PARAMETER_IDS) {
      const precision = PARAMETER_DISPLAY[id].precision;
      assert.ok(Number.isInteger(precision) && precision >= 1, `${id}: precision ${precision} < 1`);
    }
    assert.equal(excelNumberFormat("turbidity"), '0.0" NTU"');
    assert.equal(excelNumberFormat("ph"), "0.00");
  });
});

describe("pH — BFAR 6.5–9.5, critical PENDING BFAR", () => {
  const POND_TYPES = [null, ...PROFILES, "LAKE"];

  test("bounds are the pH scale 0..14", () => {
    assert.deepEqual(PARAMETER_BOUNDS.ph, { min: 0, max: 14 });
  });

  const edges: Array<[number, "WARNING" | null]> = [
    [0, "WARNING"],
    [6.49, "WARNING"],
    [6.5, null],
    [7.5, null],
    [9.5, null],
    [9.51, "WARNING"],
    [14, "WARNING"],
  ];
  for (const [value, expected] of edges) {
    test(`TEST-10: ${value} -> ${expected} for every pond type`, () => {
      for (const pondType of POND_TYPES) {
        assert.equal(severityFor("ph", value, pondType), expected, `pondType ${pondType}`);
      }
    });
  }

  // The critical lines are placeholders equal to the bounds, so with severityFor's strict comparison no reading that
  // ingest can store is ever CRITICAL (T-09-02-02: no false critical alarms while BFAR's figures are pending).
  test("D-01: no stored value 0..14 is ever CRITICAL in any profile", () => {
    for (const pondType of POND_TYPES) {
      for (let i = 0; i <= 1400; i++) {
        const value = i / 100;
        assert.notEqual(severityFor("ph", value, pondType), "CRITICAL", `${value} pondType ${pondType}`);
      }
    }
  });

  test("D-01: every profile has ph with pending critical placeholders at the bounds", () => {
    assert.equal(PH_CRITICAL_MIN, PARAMETER_BOUNDS.ph.min);
    assert.equal(PH_CRITICAL_MAX, PARAMETER_BOUNDS.ph.max);
    for (const profile of PROFILES) {
      const t = thresholdsFor(profile).ph;
      assert.equal(t.safeMin, 6.5, `${profile}`);
      assert.equal(t.safeMax, 9.5, `${profile}`);
      assert.equal(t.criticalMin, PH_CRITICAL_MIN, `${profile}`);
      assert.equal(t.criticalMax, PH_CRITICAL_MAX, `${profile}`);
      assert.equal(t.criticalPending, true, `${profile}: not pending`);
    }
  });

  test("display metadata is pH, unitless, precision 2, sentence label keeps its casing", () => {
    assert.deepEqual(PARAMETER_DISPLAY.ph, {
      label: "pH",
      unit: "",
      precision: 2,
      exportHeader: "pH",
      sentenceLabel: "pH",
    });
  });
});

describe("alert hold (Phase 7 gap closure)", () => {
  test("P-22: ALERT_HOLD_READINGS has an integer >= 1 per parameter (temperature 1, turbidity 4); gap 90 s", () => {
    for (const id of PARAMETER_IDS) {
      const hold = ALERT_HOLD_READINGS[id];
      assert.ok(Number.isInteger(hold) && hold >= 1, `${id}: hold ${hold}`);
    }
    assert.deepEqual(Object.keys(ALERT_HOLD_READINGS).sort(), [...PARAMETER_IDS].sort());
    assert.equal(ALERT_HOLD_READINGS.temperature, 1);
    assert.equal(ALERT_HOLD_READINGS.turbidity, 4);
    // ph's count is PROVISIONAL (set by the Phase 10 soak, D-13), so only its shape is pinned here.
    assert.ok(Number.isInteger(ALERT_HOLD_READINGS.ph) && ALERT_HOLD_READINGS.ph >= 1, `ph: hold ${ALERT_HOLD_READINGS.ph}`);
    assert.equal(ALERT_HOLD_MAX_GAP_MS, 90_000);
  });
});
