import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Device } from "../generated/prisma/client.ts";
import { createPrismaFake, type FakeAlert, type PrismaFakeOptions } from "../testing/prismaFake.ts";
import { evaluatePondAlerts } from "./alerts.ts";
import { ingestSamples } from "./ingest.ts";

// Shell-trace characterization of evaluatePondAlerts (and, in Part B, the full ingest -> alerts -> notify
// path) against the in-memory Prisma fake (TEST-01). Written against the UNMODIFIED alerts.ts before the pure
// core is extracted. Temperature thresholds (all profiles SHARED): safe 26..31, critical 24..33.
// Every timestamp derives from T0 — never the wall clock.

const T0 = new Date("2030-01-01T00:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const minute = (n: number) => new Date(T0.getTime() + n * MIN);
const at = (ms: number) => new Date(T0.getTime() + ms);

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";

type Fake = ReturnType<typeof createPrismaFake>;

function setup(t: TestContext, opts: PrismaFakeOptions = {}) {
  const fake = createPrismaFake(opts);
  fake.install(t);
  return fake;
}

function seedReading(fake: Fake, value: number, recordedAt: Date) {
  fake.readings.push({ pondId: "pond-1", deviceId: DEVICE_ID, parameter: "temperature", value, recordedAt });
}

function seedAlert(fake: Fake, overrides: Partial<FakeAlert>): FakeAlert {
  const alert: FakeAlert = {
    id: "alert-open",
    pondId: "pond-1",
    parameter: "temperature",
    severity: "WARNING",
    openedAt: minute(-10),
    lastValue: 25,
    lastRecordedAt: minute(0),
    nominalSince: null,
    resolvedAt: null,
    ...overrides,
  };
  fake.alerts.push(alert);
  return alert;
}

function seedNotification(fake: Fake, alertId: string, recordedAt: Date) {
  fake.notifications.push({ profileId: "p1", alertId, kind: "ALERT_OPENED", severity: "WARNING", value: 25, recordedAt });
}

const evaluate = () => evaluatePondAlerts("pond-1", ["temperature"]);

const argsOf = (fake: Fake, op: string) =>
  fake.calls.filter((c) => c.op === op).map((c) => c.args as { data: Record<string, unknown> });

const PREFIX = ["pond.findUnique", "$transaction", "tx.$executeRaw", "tx.reading.findFirst", "tx.alert.findFirst"];

// ---------------------------------------------------------------------------------------------------------
// Part A — evaluatePondAlerts driven directly against seeded state
// ---------------------------------------------------------------------------------------------------------

test("no open alert + nominal value: nothing created, nothing notified", async (t) => {
  const fake = setup(t);
  seedReading(fake, 28, minute(0));

  await evaluate();

  assert.deepEqual(fake.ops(), PREFIX);
  assert.equal(fake.alerts.length, 0);
  assert.equal(fake.notifications.length, 0);
});

test("no open alert + warning value: opens WARNING and notifies ALERT_OPENED", async (t) => {
  const fake = setup(t);
  seedReading(fake, 25, minute(0));

  await evaluate();

  assert.deepEqual(fake.ops(), [...PREFIX, "tx.alert.create", "tx.profile.findMany", "tx.notification.createMany"]);
  assert.deepEqual(fake.alerts, [
    {
      id: "alert-1",
      pondId: "pond-1",
      parameter: "temperature",
      severity: "WARNING",
      openedAt: minute(0),
      lastValue: 25,
      lastRecordedAt: minute(0),
      nominalSince: null,
      resolvedAt: null,
    },
  ]);
  assert.deepEqual(fake.notifications, [
    { profileId: "p1", alertId: "alert-1", kind: "ALERT_OPENED", severity: "WARNING", value: 25, recordedAt: minute(0) },
  ]);
  assert.deepEqual(fake.calls.find((c) => c.op === "tx.profile.findMany")?.args, {
    where: { status: "ACTIVE" },
    select: { id: true },
  });
});

test("no open alert + critical value: opens CRITICAL and notifies ALERT_OPENED CRITICAL", async (t) => {
  const fake = setup(t);
  seedReading(fake, 23, minute(0));

  await evaluate();

  assert.equal(fake.alerts.length, 1);
  assert.equal(fake.alerts[0].severity, "CRITICAL");
  assert.deepEqual(fake.notifications, [
    { profileId: "p1", alertId: "alert-1", kind: "ALERT_OPENED", severity: "CRITICAL", value: 23, recordedAt: minute(0) },
  ]);
});

test("stale: latest reading not newer than the open alert's lastRecordedAt is skipped", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "WARNING", lastValue: 25, lastRecordedAt: minute(0) });
  seedReading(fake, 23, minute(0));

  await evaluate();

  assert.deepEqual(fake.ops(), PREFIX);
  assert.equal(fake.alerts[0].severity, "WARNING");
  assert.equal(fake.notifications.length, 0);
});

test("WARNING -> critical value: escalates immediately with ALERT_ESCALATED, no renotify lookup", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "WARNING", lastValue: 25, lastRecordedAt: minute(0) });
  seedNotification(fake, "alert-open", minute(0));
  seedReading(fake, 23, minute(1));

  await evaluate();

  assert.deepEqual(fake.ops(), [...PREFIX, "tx.alert.update", "tx.profile.findMany", "tx.notification.createMany"]);
  assert.ok(!fake.ops().includes("tx.notification.findFirst"));
  assert.deepEqual(argsOf(fake, "tx.alert.update")[0].data, {
    lastValue: 23,
    lastRecordedAt: minute(1),
    nominalSince: null,
    severity: "CRITICAL",
  });
  assert.equal(fake.alerts[0].severity, "CRITICAL");
  assert.deepEqual(fake.notifications.at(-1), {
    profileId: "p1",
    alertId: "alert-open",
    kind: "ALERT_ESCALATED",
    severity: "CRITICAL",
    value: 23,
    recordedAt: minute(1),
  });
});

test("CRITICAL stays critical: update only, no notification, no renotify lookup", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "CRITICAL", lastValue: 23, lastRecordedAt: minute(0) });
  seedReading(fake, 22, minute(1));

  await evaluate();

  assert.deepEqual(fake.ops(), [...PREFIX, "tx.alert.update"]);
  assert.deepEqual(argsOf(fake, "tx.alert.update")[0].data, {
    lastValue: 22,
    lastRecordedAt: minute(1),
    nominalSince: null,
  });
  assert.equal(fake.notifications.length, 0);
});

test("re-worsening after 30 min since last notification: renotifies ALERT_OPENED WARNING", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "CRITICAL", lastValue: 28, lastRecordedAt: minute(29), nominalSince: minute(25) });
  seedNotification(fake, "alert-open", minute(0));
  seedReading(fake, 25, minute(30));

  await evaluate();

  assert.deepEqual(fake.ops(), [
    ...PREFIX,
    "tx.notification.findFirst",
    "tx.alert.update",
    "tx.profile.findMany",
    "tx.notification.createMany",
  ]);
  // Any abnormal reading clears nominalSince; severity is the episode's worst, so it is not written back down.
  assert.deepEqual(argsOf(fake, "tx.alert.update")[0].data, {
    lastValue: 25,
    lastRecordedAt: minute(30),
    nominalSince: null,
  });
  assert.equal(fake.alerts[0].severity, "CRITICAL");
  assert.equal(fake.alerts[0].nominalSince, null);
  assert.deepEqual(fake.notifications.at(-1), {
    profileId: "p1",
    alertId: "alert-open",
    kind: "ALERT_OPENED",
    severity: "WARNING",
    value: 25,
    recordedAt: minute(30),
  });
});

test("re-worsening just under 30 min since last notification: looked up, not renotified", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "CRITICAL", lastValue: 28, lastRecordedAt: minute(29), nominalSince: minute(25) });
  seedNotification(fake, "alert-open", minute(0));
  seedReading(fake, 25, at(30 * MIN - 1));

  await evaluate();

  assert.deepEqual(fake.ops(), [...PREFIX, "tx.notification.findFirst", "tx.alert.update"]);
  assert.equal(fake.notifications.length, 1);
  assert.equal(fake.alerts[0].nominalSince, null);
});

test("a null-recordedAt notification for the episode is excluded from the renotify throttle", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "CRITICAL", lastValue: 28, lastRecordedAt: minute(29), nominalSince: minute(25) });
  seedNotification(fake, "alert-open", minute(0));
  // Notification.recordedAt is DateTime? — DEVICE_* rows leave it null — and no constraint ties
  // "has an alertId" to "has a recordedAt". Postgres orders DESC NULLS FIRST, so an unfiltered query
  // would return THIS row, not the minute-0 one.
  fake.notifications.push({ profileId: "p1", alertId: "alert-open", kind: "DEVICE_OFFLINE", recordedAt: null });
  seedReading(fake, 25, at(30 * MIN - 1));

  await evaluate();

  assert.deepEqual(argsOf(fake, "tx.notification.findFirst")[0], {
    where: { alertId: "alert-open", recordedAt: { not: null } },
    orderBy: { recordedAt: "desc" },
    select: { recordedAt: true },
  });
  // Throttled against the real last notification (minute 0), just under 30 minutes ago. Without the
  // filter this re-worsening would have notified instead.
  assert.deepEqual(fake.ops(), [...PREFIX, "tx.notification.findFirst", "tx.alert.update"]);
  assert.equal(fake.notifications.length, 2);
});

test("re-worsening to an already-reached CRITICAL: renotifies as ALERT_OPENED, not ESCALATED", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "CRITICAL", lastValue: 28, lastRecordedAt: minute(29), nominalSince: minute(25) });
  seedNotification(fake, "alert-open", minute(0));
  seedReading(fake, 23, minute(30));

  await evaluate();

  assert.ok(fake.ops().includes("tx.notification.findFirst"));
  assert.deepEqual(fake.notifications.at(-1), {
    profileId: "p1",
    alertId: "alert-open",
    kind: "ALERT_OPENED",
    severity: "CRITICAL",
    value: 23,
    recordedAt: minute(30),
  });
});

test("first nominal reading starts the recovery clock without resolving", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "WARNING", lastValue: 25, lastRecordedAt: minute(0), nominalSince: null });
  seedReading(fake, 28, minute(1));

  await evaluate();

  assert.deepEqual(fake.ops(), [...PREFIX, "tx.alert.update"]);
  assert.deepEqual(argsOf(fake, "tx.alert.update")[0].data, {
    lastValue: 28,
    lastRecordedAt: minute(1),
    nominalSince: minute(1),
  });
  assert.equal(fake.alerts[0].resolvedAt, null);
  assert.equal(fake.notifications.length, 0);
});

test("nominal for exactly 10 min resolves with ALERT_RESOLVED carrying the episode's worst severity", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "CRITICAL", lastValue: 28, lastRecordedAt: minute(9), nominalSince: minute(0) });
  seedReading(fake, 28, minute(10));

  await evaluate();

  assert.deepEqual(fake.ops(), [...PREFIX, "tx.alert.update", "tx.profile.findMany", "tx.notification.createMany"]);
  assert.deepEqual(argsOf(fake, "tx.alert.update")[0].data, {
    lastValue: 28,
    lastRecordedAt: minute(10),
    nominalSince: minute(0),
    resolvedAt: minute(10),
  });
  assert.deepEqual(fake.alerts[0].resolvedAt, minute(10));
  assert.deepEqual(fake.notifications, [
    {
      profileId: "p1",
      alertId: "alert-open",
      kind: "ALERT_RESOLVED",
      severity: "CRITICAL",
      value: 28,
      recordedAt: minute(10),
    },
  ]);
});

test("nominal for just under 10 min does not resolve", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "CRITICAL", lastValue: 28, lastRecordedAt: minute(9), nominalSince: minute(0) });
  seedReading(fake, 28, at(10 * MIN - 1));

  await evaluate();

  assert.deepEqual(fake.ops(), [...PREFIX, "tx.alert.update"]);
  assert.equal(fake.alerts[0].resolvedAt, null);
  assert.equal(fake.notifications.length, 0);
});

test("flap nominal -> abnormal -> nominal restarts the recovery clock", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "WARNING", lastValue: 25, lastRecordedAt: minute(0), nominalSince: null });
  seedNotification(fake, "alert-open", minute(0));

  seedReading(fake, 28, minute(1));
  await evaluate();
  assert.deepEqual(fake.alerts[0].nominalSince, minute(1));

  seedReading(fake, 25, minute(2));
  await evaluate();
  assert.equal(fake.alerts[0].nominalSince, null);

  seedReading(fake, 28, minute(3));
  await evaluate();
  assert.deepEqual(fake.alerts[0].nominalSince, minute(3));

  // 10 min after the FIRST nominal reading — would have resolved without the flap.
  seedReading(fake, 28, minute(11));
  await evaluate();
  assert.equal(fake.alerts[0].resolvedAt, null);

  seedReading(fake, 28, minute(13));
  await evaluate();
  assert.deepEqual(fake.alerts[0].resolvedAt, minute(13));
  // The re-worsening at minute 2 was within 30 min of the minute-0 notification, so it was not renotified.
  assert.deepEqual(
    fake.notifications.map((n) => n.kind),
    ["ALERT_OPENED", "ALERT_RESOLVED"],
  );
});

test("no active profiles: recipients looked up, no notification rows written", async (t) => {
  const fake = setup(t, { activeProfileIds: [] });
  seedReading(fake, 25, minute(0));

  await evaluate();

  assert.deepEqual(fake.ops(), [...PREFIX, "tx.alert.create", "tx.profile.findMany"]);
  assert.ok(!fake.ops().includes("tx.notification.createMany"));
  assert.equal(fake.alerts.length, 1);
  assert.equal(fake.notifications.length, 0);
});

test("pondType BRACKISH and null produce identical outcomes today", async (t) => {
  // Characterization, not endorsement: every threshold profile is SHARED right now, so pond type changes
  // nothing. Phase 4 may make them diverge — this pin will then need updating deliberately.
  const outcomes: unknown[] = [];
  for (const pondType of ["BRACKISH", null]) {
    await t.test(`pondType ${pondType}`, async (st) => {
      const fake = setup(st, { pondType });
      seedReading(fake, 25, minute(0));
      await evaluate();
      outcomes.push({ ops: fake.ops(), alerts: fake.alerts, notifications: fake.notifications });
    });
  }
  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test("two concurrent evaluations open exactly one episode (the advisory lock serializes them)", async (t) => {
  // The property the lock in alerts.ts exists for: two MQTT messages handled concurrently must not both
  // see "no open alert" and each open one. The fake models pg_advisory_xact_lock as a real per-key
  // mutex and refuses a second open alert for the same (pond, parameter), so deleting the lock line
  // fails this test instead of leaving the suite green.
  const fake = setup(t);
  seedReading(fake, 25, minute(0));

  await Promise.all([evaluate(), evaluate()]);

  assert.equal(fake.alerts.length, 1);
  assert.equal(fake.alerts[0].severity, "WARNING");
  // The second evaluation ran after the first committed, so it saw the episode and found its reading
  // already accounted for (stale) — one notification, not two.
  assert.deepEqual(
    fake.notifications.map((n) => n.kind),
    ["ALERT_OPENED"],
  );
  assert.equal(fake.ops().filter((op) => op === "tx.alert.create").length, 1);
});

test("pond.findUnique runs exactly once per evaluatePondAlerts call, one transaction per parameter", async (t) => {
  const fake = setup(t);
  seedReading(fake, 28, minute(0));

  // Characterization: a repeated parameter is evaluated twice (no dedupe inside evaluatePondAlerts).
  await evaluatePondAlerts("pond-1", ["temperature", "temperature"]);

  assert.equal(fake.ops().filter((op) => op === "pond.findUnique").length, 1);
  assert.equal(fake.ops().filter((op) => op === "$transaction").length, 2);

  await evaluate();
  assert.equal(fake.ops().filter((op) => op === "pond.findUnique").length, 2);
});

// ---------------------------------------------------------------------------------------------------------
// Part B — simulator-shaped minute-by-minute sequence through the real ingestSamples
// ---------------------------------------------------------------------------------------------------------

test("end-to-end: 28, 25, 23, then 11 minutes of 28 -> one episode opened, escalated, resolved", async (t) => {
  const fake = setup(t);
  const device = {
    id: DEVICE_ID,
    serial: "SIM-0001",
    hardwareModel: null,
    label: null,
    secretVersion: 1,
    status: "ACTIVE",
    pondId: "pond-1",
    assignedAt: at(-DAY),
    firmwareVersion: null,
    lastSeenAt: null,
    offlineSince: null,
    createdAt: at(-2 * DAY),
    updatedAt: at(-2 * DAY),
  } as Device;

  const values = [28, 25, 23, ...Array.from({ length: 11 }, () => 28)];
  for (const [n, value] of values.entries()) {
    const result = await ingestSamples(
      device,
      { firmwareVersion: "simulator", samples: [{ recordedAt: minute(n), values: { temperature: value } }] },
      minute(n),
    );
    assert.deepEqual(result, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });
  }

  assert.equal(fake.alerts.length, 1);
  const [episode] = fake.alerts;
  assert.equal(episode.severity, "CRITICAL");
  assert.deepEqual(episode.openedAt, minute(1));
  assert.deepEqual(episode.nominalSince, minute(3));
  assert.deepEqual(episode.resolvedAt, minute(13));

  assert.deepEqual(
    fake.notifications.map((n) => n.kind),
    ["ALERT_OPENED", "ALERT_ESCALATED", "ALERT_RESOLVED"],
  );
  assert.deepEqual(
    fake.notifications.map((n) => [n.severity, n.value, n.recordedAt, n.profileId, n.alertId]),
    [
      ["WARNING", 25, minute(1), "p1", "alert-1"],
      ["CRITICAL", 23, minute(2), "p1", "alert-1"],
      ["CRITICAL", 28, minute(13), "p1", "alert-1"],
    ],
  );
  assert.equal(fake.ops().filter((op) => op === "pond.findUnique").length, values.length);
});
