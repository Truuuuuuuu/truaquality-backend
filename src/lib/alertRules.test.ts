import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ALERT_RECOVERY_MS,
  ALERT_RENOTIFY_MS,
  decideAlertStep,
  notificationKindFor,
  renotifyDue,
  type OpenEpisode,
} from "./alertRules.ts";

// Characterization of today's (temperature-only) alert episode state machine. Pure: no DB, no env, no wall
// clock. Temperature bands: safe 26-31, critical 24-33 (strict < / > on both edges).
const T = new Date("2030-01-01T00:00:00Z");
const MIN_MS = 60 * 1000;
const at = (offsetMs: number) => new Date(T.getTime() + offsetMs);

const episode = (over: Partial<OpenEpisode> = {}): OpenEpisode => ({
  severity: "WARNING",
  lastValue: 25,
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
    assert.deepEqual(step(null, 25), { kind: "open", severity: "WARNING" });
  });

  test("critical-range reading opens a CRITICAL episode", () => {
    assert.deepEqual(step(null, 23), { kind: "open", severity: "CRITICAL" });
  });
});

describe("decideAlertStep — stale", () => {
  test("recordedAt equal to lastRecordedAt is stale", () => {
    assert.deepEqual(step(episode(), 23, T), { kind: "stale" });
  });

  test("recordedAt earlier than lastRecordedAt is stale", () => {
    assert.deepEqual(step(episode(), 23, at(-1)), { kind: "stale" });
  });

  test("stale wins even for an in-range reading", () => {
    assert.deepEqual(step(episode({ nominalSince: at(-ALERT_RECOVERY_MS) }), 28, T), { kind: "stale" });
  });
});

describe("decideAlertStep — abnormal", () => {
  test("WARNING episode, warning -> critical: escalated and worsened", () => {
    assert.deepEqual(step(episode({ severity: "WARNING", lastValue: 25 }), 23), {
      kind: "abnormal",
      severity: "CRITICAL",
      escalated: true,
      worsened: true,
    });
  });

  test("CRITICAL episode, critical -> critical: neither escalated nor worsened", () => {
    assert.deepEqual(step(episode({ severity: "CRITICAL", lastValue: 23 }), 22), {
      kind: "abnormal",
      severity: "CRITICAL",
      escalated: false,
      worsened: false,
    });
  });

  test("CRITICAL episode, nominal -> warning: worsened but not escalated", () => {
    assert.deepEqual(step(episode({ severity: "CRITICAL", lastValue: 28 }), 25), {
      kind: "abnormal",
      severity: "WARNING",
      escalated: false,
      worsened: true,
    });
  });

  test("CRITICAL episode, nominal -> critical: worsened but not escalated", () => {
    assert.deepEqual(step(episode({ severity: "CRITICAL", lastValue: 28 }), 23), {
      kind: "abnormal",
      severity: "CRITICAL",
      escalated: false,
      worsened: true,
    });
  });

  test("CRITICAL episode, critical -> warning: a step up, neither escalated nor worsened", () => {
    assert.deepEqual(step(episode({ severity: "CRITICAL", lastValue: 23 }), 25), {
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
    [null, 25, at(MIN_MS)],
    [null, 23, at(MIN_MS)],
    [episode(), 23, T],
    [episode({ severity: "WARNING", lastValue: 25 }), 23, at(MIN_MS)],
    [episode({ severity: "CRITICAL", lastValue: 28 }), 25, at(MIN_MS)],
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
