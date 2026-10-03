import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ALERT_RECOVERY_MS,
  ALERT_RENOTIFY_MS,
  decideAlertStep,
  heldSeveritiesFor,
  heldSeverityFor,
  notificationKindFor,
  renotifyDue,
  type HeldReading,
  type OpenEpisode,
} from "./alertRules.ts";
import { ALERT_HOLD_MAX_GAP_MS, ALERT_HOLD_READINGS, PARAMETER_BOUNDS, thresholdsFor } from "./parameters.ts";

// Characterization of today's alert episode state machine (temperature, plus table-derived turbidity cases). Pure: no DB, no env, no wall
// clock. Temperature bands (BFAR): safe 20-30, critical 15-35.5 (strict < / > on both edges).
const T = new Date("2030-01-01T00:00:00Z");
const MIN_MS = 60 * 1000;
const at = (offsetMs: number) => new Date(T.getTime() + offsetMs);

const episode = (over: Partial<OpenEpisode> = {}): OpenEpisode => ({
  severity: "WARNING",
  lastValue: 18,
  lastRecordedAt: T,
  nominalSince: null,
  ...over,
});

const step = (open: OpenEpisode | null, value: number, recordedAt: Date = at(MIN_MS), pondType: string | null = null) =>
  decideAlertStep("temperature", pondType, open, { value, recordedAt });

describe("decideAlertStep — no open episode", () => {
  test("in-range reading does nothing", () => {
    assert.deepEqual(step(null, 28), { kind: "none" });
  });

  test("warning-range reading opens a WARNING episode", () => {
    assert.deepEqual(step(null, 18), { kind: "open", severity: "WARNING" });
  });

  test("critical-range reading opens a CRITICAL episode", () => {
    assert.deepEqual(step(null, 14), { kind: "open", severity: "CRITICAL" });
  });
});

describe("decideAlertStep — stale", () => {
  test("recordedAt equal to lastRecordedAt is stale", () => {
    assert.deepEqual(step(episode(), 14, T), { kind: "stale" });
  });

  test("recordedAt earlier than lastRecordedAt is stale", () => {
    assert.deepEqual(step(episode(), 14, at(-1)), { kind: "stale" });
  });

  test("stale wins even for an in-range reading", () => {
    assert.deepEqual(step(episode({ nominalSince: at(-ALERT_RECOVERY_MS) }), 28, T), { kind: "stale" });
  });
});

describe("decideAlertStep — abnormal", () => {
  test("WARNING episode, warning -> critical: escalated and worsened", () => {
    assert.deepEqual(step(episode({ severity: "WARNING", lastValue: 18 }), 14), {
      kind: "abnormal",
      severity: "CRITICAL",
      escalated: true,
      worsened: true,
    });
  });

  test("CRITICAL episode, critical -> critical: neither escalated nor worsened", () => {
    assert.deepEqual(step(episode({ severity: "CRITICAL", lastValue: 14 }), 13), {
      kind: "abnormal",
      severity: "CRITICAL",
      escalated: false,
      worsened: false,
    });
  });

  test("CRITICAL episode, nominal -> warning: worsened but not escalated", () => {
    assert.deepEqual(step(episode({ severity: "CRITICAL", lastValue: 28 }), 18), {
      kind: "abnormal",
      severity: "WARNING",
      escalated: false,
      worsened: true,
    });
  });

  test("CRITICAL episode, nominal -> critical: worsened but not escalated", () => {
    assert.deepEqual(step(episode({ severity: "CRITICAL", lastValue: 28 }), 14), {
      kind: "abnormal",
      severity: "CRITICAL",
      escalated: false,
      worsened: true,
    });
  });

  test("CRITICAL episode, critical -> warning: a step up, neither escalated nor worsened", () => {
    assert.deepEqual(step(episode({ severity: "CRITICAL", lastValue: 14 }), 18), {
      kind: "abnormal",
      severity: "WARNING",
      escalated: false,
      worsened: false,
    });
  });
});

describe("decideAlertStep — nominal / recovery", () => {
  test("first in-range reading starts the recovery clock at its recordedAt", () => {
    const recordedAt = at(MIN_MS);
    assert.deepEqual(step(episode({ nominalSince: null }), 28, recordedAt), {
      kind: "nominal",
      nominalSince: recordedAt,
      resolved: false,
    });
  });

  test("in range for exactly ALERT_RECOVERY_MS resolves", () => {
    const t0 = at(MIN_MS);
    assert.deepEqual(step(episode({ nominalSince: t0 }), 28, new Date(t0.getTime() + ALERT_RECOVERY_MS)), {
      kind: "nominal",
      nominalSince: t0,
      resolved: true,
    });
  });

  test("in range for ALERT_RECOVERY_MS - 1 ms does not resolve", () => {
    const t0 = at(MIN_MS);
    assert.deepEqual(step(episode({ nominalSince: t0 }), 28, new Date(t0.getTime() + ALERT_RECOVERY_MS - 1)), {
      kind: "nominal",
      nominalSince: t0,
      resolved: false,
    });
  });

  test("recovery constant is 10 minutes", () => {
    assert.equal(ALERT_RECOVERY_MS, 10 * MIN_MS);
  });
});

describe("renotifyDue", () => {
  test("no previous notification is always due", () => {
    assert.equal(renotifyDue(null, T), true);
  });

  test("exactly ALERT_RENOTIFY_MS after the last notification is due", () => {
    assert.equal(renotifyDue(T, new Date(T.getTime() + ALERT_RENOTIFY_MS)), true);
  });

  test("ALERT_RENOTIFY_MS - 1 ms after the last notification is not due", () => {
    assert.equal(renotifyDue(T, new Date(T.getTime() + ALERT_RENOTIFY_MS - 1)), false);
  });

  test("renotify constant is 30 minutes", () => {
    assert.equal(ALERT_RENOTIFY_MS, 30 * MIN_MS);
  });
});

describe("notificationKindFor", () => {
  test("escalation is ALERT_ESCALATED", () => {
    assert.equal(notificationKindFor(true), "ALERT_ESCALATED");
  });

  test("a repeat is ALERT_OPENED", () => {
    assert.equal(notificationKindFor(false), "ALERT_OPENED");
  });
});

describe("decideAlertStep — pond type", () => {
  // Every profile is SHARED today, so the pond's type must not change any decision. Phase 4 may make a
  // parameter differ per profile; this pins the current equivalence.
  const pondTypes = [null, undefined, "LAKE", "FRESHWATER", "BRACKISH", "SALTWATER"] as const;
  const cases: Array<[OpenEpisode | null, number, Date]> = [
    [null, 28, at(MIN_MS)],
    [null, 18, at(MIN_MS)],
    [null, 14, at(MIN_MS)],
    [episode(), 14, T],
    [episode({ severity: "WARNING", lastValue: 18 }), 14, at(MIN_MS)],
    [episode({ severity: "CRITICAL", lastValue: 28 }), 18, at(MIN_MS)],
    [episode({ nominalSince: T }), 28, at(ALERT_RECOVERY_MS)],
    [episode({ nominalSince: T }), 28, at(ALERT_RECOVERY_MS - 1)],
  ];

  for (const [i, [open, value, recordedAt]] of cases.entries()) {
    test(`case ${i}: identical step for every pond type`, () => {
      const baseline = decideAlertStep("temperature", null, open, { value, recordedAt });
      for (const pondType of pondTypes) {
        assert.deepEqual(decideAlertStep("temperature", pondType, open, { value, recordedAt }), baseline);
      }
    });
  }
});

describe("decideAlertStep — turbidity (table-derived, criticalMax PENDING BFAR)", () => {
  // Every turbidity value is derived from the threshold table, never a literal critical number (D-03), so
  // swapping in BFAR's real critical line needs no test edits.
  const TB = thresholdsFor(null).turbidity;
  const NOMINAL = 0;
  const WARNING = TB.safeMax + (TB.criticalMax - TB.safeMax) / 2;
  const CRITICAL = TB.criticalMax + 1;

  const turbStep = (
    open: OpenEpisode | null,
    value: number,
    recordedAt: Date = at(MIN_MS),
    pondType: string | null = null,
    earlier: readonly HeldReading[] = [],
  ) => decideAlertStep("turbidity", pondType, open, { value, recordedAt }, earlier);

  // Turbidity is held (ALERT_HOLD_READINGS.turbidity = 4), so a test that means "this reading opens / escalates"
  // passes the three same-band readings before it, 30 s apart (the firmware report interval), newest first.
  const before = (value: number, recordedAt: Date, count = ALERT_HOLD_READINGS.turbidity - 1): HeldReading[] =>
    Array.from({ length: count }, (_, i) => ({ value, recordedAt: new Date(recordedAt.getTime() - (i + 1) * 30_000) }));

  test("CRITICAL test value is still a physically valid reading", () => {
    assert.ok(CRITICAL <= PARAMETER_BOUNDS.turbidity.max);
  });

  test("clear water (0 NTU) with no open episode does nothing", () => {
    assert.deepEqual(turbStep(null, NOMINAL), { kind: "none" });
  });

  test("warning-range turbidity held for 4 readings opens a WARNING episode", () => {
    assert.deepEqual(turbStep(null, WARNING, at(MIN_MS), null, before(WARNING, at(MIN_MS))), {
      kind: "open",
      severity: "WARNING",
    });
  });

  test("critical-range turbidity held for 4 readings opens a CRITICAL episode", () => {
    assert.deepEqual(turbStep(null, CRITICAL, at(MIN_MS), null, before(CRITICAL, at(MIN_MS))), {
      kind: "open",
      severity: "CRITICAL",
    });
  });

  test("WARNING episode, warning -> critical held for 4 readings: escalated and worsened", () => {
    assert.deepEqual(turbStep(episode({ severity: "WARNING", lastValue: WARNING }), CRITICAL, at(MIN_MS), null, before(CRITICAL, at(MIN_MS))), {
      kind: "abnormal",
      severity: "CRITICAL",
      escalated: true,
      worsened: true,
    });
  });

  test("clear water starts the recovery clock on an open episode", () => {
    const recordedAt = at(MIN_MS);
    assert.deepEqual(turbStep(episode({ lastValue: WARNING, nominalSince: null }), NOMINAL, recordedAt), {
      kind: "nominal",
      nominalSince: recordedAt,
      resolved: false,
    });
  });

  test("clear water for ALERT_RECOVERY_MS resolves the episode (ALRT-03)", () => {
    const t0 = at(MIN_MS);
    assert.deepEqual(
      turbStep(episode({ lastValue: NOMINAL, nominalSince: t0 }), NOMINAL, new Date(t0.getTime() + ALERT_RECOVERY_MS)),
      { kind: "nominal", nominalSince: t0, resolved: true },
    );
  });

  // D-05: turbidity is SHARED, so the pond's type must not change any decision.
  for (const [name, value] of [
    ["NOMINAL", NOMINAL],
    ["WARNING", WARNING],
    ["CRITICAL", CRITICAL],
  ] as const) {
    test(`${name}: identical step for every pond type`, () => {
      const earlier = before(value, at(MIN_MS));
      const baseline = turbStep(null, value, at(MIN_MS), null, earlier);
      for (const pondType of [null, "FRESHWATER", "BRACKISH", "SALTWATER", "LAKE"]) {
        assert.deepEqual(turbStep(null, value, at(MIN_MS), pondType, earlier), baseline);
      }
    });
  }
});

describe("hold rule (Phase 7 gap closure)", () => {
  // Turbidity counts as out of range only after ALERT_HOLD_READINGS.turbidity (4) consecutive out-of-range readings
  // no more than ALERT_HOLD_MAX_GAP_MS apart; temperature keeps hold 1. Values are table-derived, never a literal
  // critical number (D-03).
  const TB = thresholdsFor(null).turbidity;
  const W = TB.safeMax + (TB.criticalMax - TB.safeMax) / 2;
  const C = TB.criticalMax + 1;
  const STEP = 30_000;
  const HOLD = ALERT_HOLD_READINGS.turbidity;

  // newest first: values[0] is the latest reading at `end`, each next one STEP earlier.
  const series = (values: number[], end: Date = at(MIN_MS), gap = STEP): HeldReading[] =>
    values.map((value, i) => ({ value, recordedAt: new Date(end.getTime() - i * gap) }));
  const decide = (open: OpenEpisode | null, recent: HeldReading[], parameter: "turbidity" | "temperature" = "turbidity") =>
    decideAlertStep(parameter, null, open, recent[0], recent.slice(1));
  const held = (recent: readonly HeldReading[]) => heldSeverityFor("turbidity", null, recent);

  // §5f readings copied from .planning/phases/07-end-to-end-validation-documentation/evidence/5f-db-extract.md
  // (query 2, Reading rows of TRUAQUALITY-DEVICE001, recorded_pht in Asia/Manila). pht() turns them into UTC by
  // subtracting 8 h. The stored milliseconds are not in the extract; whole seconds keep the same ~30.5 s spacing.
  const pht = (date: string, time: string) => new Date(`${date}T${time}+08:00`);
  // Soak attempt 2 (undisturbed clean water), 2026-10-03 23:29 to 23:59 PHT: 58 readings, 7 over 25 NTU, longest
  // run 3 (23:50:28-23:51:29). It opened one false WARNING under the unheld rule.
  const SOAK: Array<[string, number]> = [
    ["23:29:29", 0], ["23:29:59", 0], ["23:30:30", 0], ["23:31:01", 0], ["23:31:31", 0], ["23:32:02", 0],
    ["23:32:33", 0], ["23:33:04", 0], ["23:33:34", 0], ["23:34:05", 0], ["23:34:36", 0], ["23:35:06", 0],
    ["23:35:37", 0], ["23:36:08", 0], ["23:36:39", 0], ["23:37:09", 0], ["23:37:40", 0], ["23:38:11", 0],
    ["23:38:41", 0], ["23:39:12", 0], ["23:39:43", 0], ["23:40:14", 0], ["23:40:44", 63.7], ["23:41:15", 0],
    ["23:41:46", 0], ["23:42:16", 0], ["23:42:47", 0], ["23:43:18", 0], ["23:43:48", 0], ["23:44:19", 99.5],
    ["23:44:50", 0], ["23:45:21", 104.1], ["23:45:51", 0], ["23:46:22", 0], ["23:46:53", 0], ["23:47:23", 0],
    ["23:47:54", 0], ["23:48:25", 0], ["23:48:56", 0], ["23:49:26", 0], ["23:49:57", 0], ["23:50:28", 122.8],
    ["23:50:58", 135.8], ["23:51:29", 131.2], ["23:52:00", 0], ["23:52:30", 0], ["23:53:01", 0], ["23:53:32", 0],
    ["23:54:03", 0], ["23:54:33", 0], ["23:55:04", 0], ["23:55:35", 0], ["23:56:05", 0], ["23:56:36", 0],
    ["23:57:07", 0], ["23:57:38", 0], ["23:58:08", 0], ["23:58:39", 38.1],
  ];
  // Cornstarch dosing, 2026-10-04 PHT: two clean readings and the lone 00:32:26 spike before it, then real turbid
  // water from 00:33:27.
  const CORNSTARCH: Array<[string, number]> = [
    ["00:31:55", 0], ["00:32:26", 141.3], ["00:32:56", 0], ["00:33:27", 291.5], ["00:33:58", 174],
    ["00:34:28", 119.6], ["00:34:59", 76.6], ["00:35:30", 498.4], ["00:36:01", 481.2], ["00:36:31", 47.3],
    ["00:37:02", 413.6], ["00:37:33", 475.8],
  ];
  // Newest-first window ending at each reading, oldest reading first in the result list.
  const replay = (date: string, rows: Array<[string, number]>) => {
    const readings = rows.map(([time, value]) => ({ value, recordedAt: pht(date, time) }));
    return readings.map((r, i) => ({ at: r.recordedAt, held: held(readings.slice(0, i + 1).reverse()) }));
  };

  test("H-01: one turbidity reading above 25 NTU with nothing earlier opens nothing", () => {
    assert.equal(held(series([W])), null);
    assert.deepEqual(decide(null, series([W])), { kind: "none" });
  });

  test("H-02: three consecutive warning-range readings 30 s apart open nothing", () => {
    assert.equal(held(series([W, W, W])), null);
    assert.deepEqual(decide(null, series([W, W, W])), { kind: "none" });
  });

  test("H-03: four consecutive warning-range readings 30 s apart open WARNING", () => {
    assert.equal(held(series([W, W, W, W])), "WARNING");
    assert.deepEqual(decide(null, series([W, W, W, W])), { kind: "open", severity: "WARNING" });
  });

  test("H-04: one in-range reading inside the run breaks it", () => {
    assert.equal(held(series([W, W, W, 0, W])), null);
    assert.deepEqual(decide(null, series([W, W, W, 0, W])), { kind: "none" });
  });

  test("H-05: a gap over ALERT_HOLD_MAX_GAP_MS breaks the run; exactly the limit is still consecutive", () => {
    const end = at(10 * MIN_MS);
    const withGap = (gap: number): HeldReading[] => [
      { value: W, recordedAt: end },
      { value: W, recordedAt: new Date(end.getTime() - STEP) },
      { value: W, recordedAt: new Date(end.getTime() - STEP - gap) },
      { value: W, recordedAt: new Date(end.getTime() - 2 * STEP - gap) },
    ];
    assert.equal(held(withGap(ALERT_HOLD_MAX_GAP_MS + 1)), null);
    assert.equal(held(withGap(ALERT_HOLD_MAX_GAP_MS)), "WARNING");
    assert.deepEqual(decide(null, withGap(ALERT_HOLD_MAX_GAP_MS + 1)), { kind: "none" });
  });

  test("H-06: the held severity is the least severe in the window", () => {
    assert.ok(C <= PARAMETER_BOUNDS.turbidity.max);
    assert.equal(held(series([C, C, C, W])), "WARNING");
    assert.equal(held(series([C, C, C, C])), "CRITICAL");
    assert.deepEqual(decide(null, series([C, C, C, W])), { kind: "open", severity: "WARNING" });
  });

  test("H-07: open WARNING episode, four C readings escalate; three C after a W do not", () => {
    const open = episode({ severity: "WARNING", lastValue: C, lastRecordedAt: at(0) });
    assert.deepEqual(decide(open, series([C, C, C, C, W])), {
      kind: "abnormal",
      severity: "CRITICAL",
      escalated: true,
      worsened: true,
    });
    assert.deepEqual(decide(open, series([C, C, C, W, W])), {
      kind: "abnormal",
      severity: "WARNING",
      escalated: false,
      worsened: false,
    });
  });

  test("H-08: open episode in recovery, one raw out-of-range reading not yet held: abnormal at the episode's severity, nobody notified", () => {
    const open = episode({ severity: "WARNING", lastValue: 0, lastRecordedAt: at(0), nominalSince: at(-5 * MIN_MS) });
    assert.deepEqual(decide(open, series([W, 0, 0, 0, 0])), {
      kind: "abnormal",
      severity: "WARNING",
      escalated: false,
      worsened: false,
    });
    const critical = episode({ severity: "CRITICAL", lastValue: 0, lastRecordedAt: at(0), nominalSince: at(-MIN_MS) });
    assert.deepEqual(decide(critical, series([C, 0, 0, 0, 0])), {
      kind: "abnormal",
      severity: "CRITICAL",
      escalated: false,
      worsened: false,
    });
  });

  test("H-09: open episode, in-range reading: recovery clock starts, resolves at ALERT_RECOVERY_MS", () => {
    const start = at(MIN_MS);
    assert.deepEqual(decide(episode({ lastValue: W, lastRecordedAt: at(0) }), series([0, W, W, W, W], start)), {
      kind: "nominal",
      nominalSince: start,
      resolved: false,
    });
    const end = new Date(start.getTime() + ALERT_RECOVERY_MS);
    assert.deepEqual(decide(episode({ lastValue: 0, lastRecordedAt: at(0), nominalSince: start }), series([0, 0, 0, 0, 0], end)), {
      kind: "nominal",
      nominalSince: start,
      resolved: true,
    });
  });

  test("H-10: temperature hold is 1, and earlier readings never change a temperature decision", () => {
    assert.equal(ALERT_HOLD_READINGS.temperature, 1);
    assert.equal(heldSeverityFor("temperature", null, [{ value: 18, recordedAt: at(MIN_MS) }]), "WARNING");
    assert.deepEqual(decideAlertStep("temperature", null, null, { value: 18, recordedAt: at(MIN_MS) }), {
      kind: "open",
      severity: "WARNING",
    });
    const histories: HeldReading[][] = [[], series([28, 28, 28], at(0)), series([18, 18, 18], at(0)), series([14, 14], at(0))];
    const cases: Array<[OpenEpisode | null, number]> = [
      [null, 28],
      [null, 18],
      [null, 14],
      [episode({ severity: "WARNING", lastValue: 18 }), 14],
      [episode({ severity: "CRITICAL", lastValue: 28 }), 18],
      [episode({ severity: "CRITICAL", lastValue: 14 }), 13],
      [episode({ nominalSince: T }), 28],
    ];
    for (const [open, value] of cases) {
      const latest = { value, recordedAt: at(MIN_MS) };
      const baseline = decideAlertStep("temperature", null, open, latest);
      for (const earlier of histories) {
        assert.deepEqual(decideAlertStep("temperature", null, open, latest, earlier), baseline);
      }
    }
  });

  test("H-11: replaying the real §5f clean-water soak never yields WARNING", () => {
    assert.equal(SOAK.length, 58);
    assert.equal(SOAK.filter(([, v]) => v > TB.safeMax).length, 7);
    for (const step of replay("2026-10-03", SOAK)) {
      assert.equal(step.held, null, `held ${step.held} at ${step.at.toISOString()}`);
    }
  });

  test("H-12: replaying the §5f cornstarch readings yields WARNING at the 4th turbid reading (00:34:59)", () => {
    const steps = replay("2026-10-04", CORNSTARCH);
    const firstTurbid = CORNSTARCH.findIndex(([time]) => time === "00:33:27");
    for (const step of steps.slice(0, firstTurbid + 3)) assert.equal(step.held, null, step.at.toISOString());
    assert.deepEqual(steps[firstTurbid + 3], { at: pht("2026-10-04", "00:34:59"), held: "WARNING" });
    for (const step of steps.slice(firstTurbid + 3)) assert.equal(step.held, "WARNING", step.at.toISOString());
  });

  test("H-13: heldSeveritiesFor sorts newest-first, omits empty lists, null for in range", () => {
    const oldestFirst = series([W, W, W, W]).reverse();
    assert.deepEqual(heldSeveritiesFor(null, { turbidity: oldestFirst, temperature: [] }), { turbidity: "WARNING" });
    assert.deepEqual(heldSeveritiesFor(null, { turbidity: series([0, W, W, W]), temperature: series([28]) }), {
      turbidity: null,
      temperature: null,
    });
    assert.deepEqual(heldSeveritiesFor(null, { turbidity: series([0, W, W, W, W]).reverse(), temperature: series([18]) }), {
      turbidity: null,
      temperature: "WARNING",
    });
    assert.deepEqual(heldSeveritiesFor(null, {}), {});
    assert.equal(HOLD, 4);
  });
});
