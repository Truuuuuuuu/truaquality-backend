import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uptimePercent } from "./deviceDiagnosticsRules.ts";

const START = new Date("2030-01-01T00:00:00Z");
const HOUR = 60 * 60 * 1000;
const NOW = new Date(START.getTime() + 24 * HOUR);
const at = (fraction: number) => new Date(START.getTime() + fraction * 24 * HOUR);

describe("uptimePercent", () => {
  test("no transitions and online at start is 100", () => {
    assert.equal(uptimePercent({ windowStart: START, now: NOW, stateAtStart: "online", transitions: [] }), 100);
  });
  test("offline at start, ONLINE mid-window is 50", () => {
    const transitions = [{ kind: "ONLINE" as const, at: at(0.5) }];
    assert.equal(uptimePercent({ windowStart: START, now: NOW, stateAtStart: "offline", transitions }), 50);
  });
  test("OFFLINE at 25% and ONLINE at 75% is 50", () => {
    const transitions = [
      { kind: "ONLINE" as const, at: at(0.75) },
      { kind: "OFFLINE" as const, at: at(0.25) },
    ];
    assert.equal(uptimePercent({ windowStart: START, now: NOW, stateAtStart: "online", transitions }), 50);
  });
  test("OFFLINE with no later ONLINE counts online time up to the OFFLINE", () => {
    const transitions = [{ kind: "OFFLINE" as const, at: at(0.9) }];
    assert.equal(uptimePercent({ windowStart: START, now: NOW, stateAtStart: "online", transitions }), 90);
  });
  test("a repeated OFFLINE while already offline is ignored", () => {
    const transitions = [
      { kind: "OFFLINE" as const, at: at(0.25) },
      { kind: "OFFLINE" as const, at: at(0.5) },
      { kind: "ONLINE" as const, at: at(0.75) },
    ];
    assert.equal(uptimePercent({ windowStart: START, now: NOW, stateAtStart: "online", transitions }), 50);
  });
  test("rounded to one decimal", () => {
    const transitions = [{ kind: "OFFLINE" as const, at: at(2 / 3) }];
    assert.equal(uptimePercent({ windowStart: START, now: NOW, stateAtStart: "online", transitions }), 66.7);
  });
  test("a zero-length window is null", () => {
    assert.equal(uptimePercent({ windowStart: START, now: START, stateAtStart: "online", transitions: [] }), null);
  });
});
