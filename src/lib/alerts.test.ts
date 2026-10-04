import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Device } from "../generated/prisma/client.ts";
import { createPrismaFake, type FakeAlert, type PrismaFakeOptions } from "../testing/prismaFake.ts";
import { ALERT_RECOVERY_MS } from "./alertRules.ts";
import { evaluatePondAlerts } from "./alerts.ts";
import { ingestSamples } from "./ingest.ts";
import { ALERT_HOLD_READINGS, thresholdsFor, type ParameterId } from "./parameters.ts";

// Shell-trace characterization of evaluatePondAlerts (and, in Part B, the full ingest -> alerts -> notify
// path) against the in-memory Prisma fake (TEST-01). Written against the UNMODIFIED alerts.ts before the pure
// core is extracted. Temperature thresholds (all profiles SHARED): safe 20..30, critical 15..35.5. Turbidity
// cases use values derived from thresholdsFor(null).turbidity, never a literal critical number.
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

function seedReading(fake: Fake, value: number, recordedAt: Date, parameter = "temperature") {
  fake.readings.push({ pondId: "pond-1", deviceId: DEVICE_ID, parameter, value, recordedAt });
}

function seedAlert(fake: Fake, overrides: Partial<FakeAlert>): FakeAlert {
  const alert: FakeAlert = {
    id: "alert-open",
    pondId: "pond-1",
    parameter: "temperature",
    severity: "WARNING",
    openedAt: minute(-10),
    lastValue: 18,
    lastRecordedAt: minute(0),
    nominalSince: null,
    resolvedAt: null,
    ...overrides,
  };
  fake.alerts.push(alert);
  return alert;
}

function seedNotification(fake: Fake, alertId: string, recordedAt: Date) {
  fake.notifications.push({ profileId: "p1", alertId, kind: "ALERT_OPENED", severity: "WARNING", value: 18, recordedAt });
}

const evaluate = (parameters: ParameterId[] = ["temperature"]) => evaluatePondAlerts("pond-1", parameters);

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
  seedReading(fake, 18, minute(0));

  await evaluate();

  assert.deepEqual(fake.ops(), [...PREFIX, "tx.alert.create", "tx.profile.findMany", "tx.notification.createMany"]);
  assert.deepEqual(fake.alerts, [
    {
      id: "alert-1",
      pondId: "pond-1",
      parameter: "temperature",
      severity: "WARNING",
      openedAt: minute(0),
      lastValue: 18,
      lastRecordedAt: minute(0),
      nominalSince: null,
      resolvedAt: null,
    },
  ]);
  assert.deepEqual(fake.notifications, [
    { profileId: "p1", alertId: "alert-1", kind: "ALERT_OPENED", severity: "WARNING", value: 18, recordedAt: minute(0) },
  ]);
  assert.deepEqual(fake.calls.find((c) => c.op === "tx.profile.findMany")?.args, {
    where: { status: "ACTIVE" },
    select: { id: true },
  });
});

test("no open alert + critical value: opens CRITICAL and notifies ALERT_OPENED CRITICAL", async (t) => {
  const fake = setup(t);
  seedReading(fake, 14, minute(0));

  await evaluate();

  assert.equal(fake.alerts.length, 1);
  assert.equal(fake.alerts[0].severity, "CRITICAL");
  assert.deepEqual(fake.notifications, [
    { profileId: "p1", alertId: "alert-1", kind: "ALERT_OPENED", severity: "CRITICAL", value: 14, recordedAt: minute(0) },
  ]);
});

test("stale: latest reading not newer than the open alert's lastRecordedAt is skipped", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "WARNING", lastValue: 18, lastRecordedAt: minute(0) });
  seedReading(fake, 14, minute(0));

  await evaluate();

  assert.deepEqual(fake.ops(), PREFIX);
  assert.equal(fake.alerts[0].severity, "WARNING");
  assert.equal(fake.notifications.length, 0);
});

test("WARNING -> critical value: escalates immediately with ALERT_ESCALATED, no renotify lookup", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "WARNING", lastValue: 18, lastRecordedAt: minute(0) });
  seedNotification(fake, "alert-open", minute(0));
  seedReading(fake, 14, minute(1));

  await evaluate();

  assert.deepEqual(fake.ops(), [...PREFIX, "tx.alert.update", "tx.profile.findMany", "tx.notification.createMany"]);
  assert.ok(!fake.ops().includes("tx.notification.findFirst"));
  assert.deepEqual(argsOf(fake, "tx.alert.update")[0].data, {
    lastValue: 14,
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
    value: 14,
    recordedAt: minute(1),
  });
});

test("CRITICAL stays critical: update only, no notification, no renotify lookup", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "CRITICAL", lastValue: 14, lastRecordedAt: minute(0) });
  seedReading(fake, 13, minute(1));

  await evaluate();

  assert.deepEqual(fake.ops(), [...PREFIX, "tx.alert.update"]);
  assert.deepEqual(argsOf(fake, "tx.alert.update")[0].data, {
    lastValue: 13,
    lastRecordedAt: minute(1),
    nominalSince: null,
  });
  assert.equal(fake.notifications.length, 0);
});

test("re-worsening after 30 min since last notification: renotifies ALERT_OPENED WARNING", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "CRITICAL", lastValue: 28, lastRecordedAt: minute(29), nominalSince: minute(25) });
  seedNotification(fake, "alert-open", minute(0));
  seedReading(fake, 18, minute(30));

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
    lastValue: 18,
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
    value: 18,
    recordedAt: minute(30),
  });
});

test("re-worsening just under 30 min since last notification: looked up, not renotified", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "CRITICAL", lastValue: 28, lastRecordedAt: minute(29), nominalSince: minute(25) });
  seedNotification(fake, "alert-open", minute(0));
  seedReading(fake, 18, at(30 * MIN - 1));

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
  seedReading(fake, 18, at(30 * MIN - 1));

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
  seedReading(fake, 14, minute(30));

  await evaluate();

  assert.ok(fake.ops().includes("tx.notification.findFirst"));
  assert.deepEqual(fake.notifications.at(-1), {
    profileId: "p1",
    alertId: "alert-open",
    kind: "ALERT_OPENED",
    severity: "CRITICAL",
    value: 14,
    recordedAt: minute(30),
  });
});

test("first nominal reading starts the recovery clock without resolving", async (t) => {
  const fake = setup(t);
  seedAlert(fake, { severity: "WARNING", lastValue: 18, lastRecordedAt: minute(0), nominalSince: null });
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
  seedAlert(fake, { severity: "WARNING", lastValue: 18, lastRecordedAt: minute(0), nominalSince: null });
  seedNotification(fake, "alert-open", minute(0));

  seedReading(fake, 28, minute(1));
  await evaluate();
  assert.deepEqual(fake.alerts[0].nominalSince, minute(1));

  seedReading(fake, 18, minute(2));
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
  seedReading(fake, 18, minute(0));

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
      seedReading(fake, 18, minute(0));
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
  seedReading(fake, 18, minute(0));

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

test("end-to-end: 28, 18, 14, then 11 minutes of 28 -> one episode opened, escalated, resolved", async (t) => {
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
    wifiSsid: null,
    lastSeenAt: null,
    offlineSince: null,
    createdAt: at(-2 * DAY),
    updatedAt: at(-2 * DAY),
  } as Device;

  const values = [28, 18, 14, ...Array.from({ length: 11 }, () => 28)];
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
      ["WARNING", 18, minute(1), "p1", "alert-1"],
      ["CRITICAL", 14, minute(2), "p1", "alert-1"],
      ["CRITICAL", 28, minute(13), "p1", "alert-1"],
    ],
  );
  assert.equal(fake.ops().filter((op) => op === "pond.findUnique").length, values.length);
});

// ---------------------------------------------------------------------------------------------------------
// Turbidity — table-derived values (criticalMax is PENDING BFAR)
// ---------------------------------------------------------------------------------------------------------

const TB = thresholdsFor(null).turbidity;
const NTU_NOMINAL = 0;
const NTU_WARNING = TB.safeMax + (TB.criticalMax - TB.safeMax) / 2;
const NTU_CRITICAL = TB.criticalMax + 1;

test("turbidity: clear water (0 NTU) opens nothing and notifies nobody", async (t) => {
  const fake = setup(t);
  seedReading(fake, NTU_NOMINAL, minute(0), "turbidity");

  await evaluate(["turbidity"]);

  // Turbidity is held (ALERT_HOLD_READINGS 4), so its evaluation also looks back over the earlier readings.
  assert.deepEqual(fake.ops(), [...PREFIX.slice(0, 4), "tx.reading.findMany", ...PREFIX.slice(4)]);
  assert.equal(fake.alerts.length, 0);
  assert.equal(fake.notifications.length, 0);
});

// A simulator-shaped unit for the turbidity sequences below.
const turbidityDevice = () =>
  ({
    id: DEVICE_ID,
    serial: "SIM-0001",
    hardwareModel: null,
    label: null,
    secretVersion: 1,
    status: "ACTIVE",
    pondId: "pond-1",
    assignedAt: at(-DAY),
    firmwareVersion: null,
    wifiSsid: null,
    lastSeenAt: null,
    offlineSince: null,
    createdAt: at(-2 * DAY),
    updatedAt: at(-2 * DAY),
  }) as Device;

// Ingests one turbidity sample per entry, `stepMs` apart from T0, asserting each is stored.
async function ingestTurbidity(values: number[], stepMs: number, device = turbidityDevice()) {
  for (const [n, value] of values.entries()) {
    const recordedAt = at(n * stepMs);
    const result = await ingestSamples(
      device,
      { firmwareVersion: "simulator", samples: [{ recordedAt, values: { turbidity: value } }] },
      recordedAt,
    );
    assert.deepEqual(result, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });
  }
}

test("end-to-end turbidity: 0, 4 x warning, 4 x critical, then 11 minutes of 0 NTU -> held open, escalated, resolved", async (t) => {
  const fake = setup(t);

  // One reading per minute (inside ALERT_HOLD_MAX_GAP_MS). The 4th warning reading opens, the 4th critical one
  // escalates, and recovery still takes ALERT_RECOVERY_MS of clear water.
  const values = [
    NTU_NOMINAL,
    ...Array.from({ length: 4 }, () => NTU_WARNING),
    ...Array.from({ length: 4 }, () => NTU_CRITICAL),
    ...Array.from({ length: 11 }, () => NTU_NOMINAL),
  ];
  await ingestTurbidity(values, MIN);

  assert.equal(fake.alerts.length, 1);
  const [episode] = fake.alerts;
  assert.equal(episode.parameter, "turbidity");
  assert.equal(episode.severity, "CRITICAL");
  assert.deepEqual(episode.openedAt, minute(4));
  assert.deepEqual(episode.nominalSince, minute(9));
  assert.deepEqual(episode.resolvedAt, minute(19));

  assert.deepEqual(
    fake.notifications.map((n) => n.kind),
    ["ALERT_OPENED", "ALERT_ESCALATED", "ALERT_RESOLVED"],
  );
  assert.deepEqual(
    fake.notifications.map((n) => [n.severity, n.value, n.recordedAt, n.alertId]),
    [
      ["WARNING", NTU_WARNING, minute(4), "alert-1"],
      ["CRITICAL", NTU_CRITICAL, minute(8), "alert-1"],
      ["CRITICAL", NTU_NOMINAL, minute(19), "alert-1"],
    ],
  );
});

test("S-H1: three warning turbidity readings 30 s apart open nothing; the fourth opens WARNING", async (t) => {
  const fake = setup(t);

  await ingestTurbidity([NTU_WARNING, NTU_WARNING, NTU_WARNING], 30_000);
  assert.equal(fake.alerts.length, 0);
  assert.equal(fake.notifications.length, 0);

  const fourth = at(3 * 30_000);
  const result = await ingestSamples(
    turbidityDevice(),
    { firmwareVersion: "simulator", samples: [{ recordedAt: fourth, values: { turbidity: NTU_WARNING } }] },
    fourth,
  );
  assert.deepEqual(result, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });

  assert.equal(fake.alerts.length, 1);
  assert.equal(fake.alerts[0].severity, "WARNING");
  assert.deepEqual(fake.alerts[0].openedAt, fourth);
  assert.deepEqual(
    fake.notifications.map((n) => [n.kind, n.severity, n.recordedAt]),
    [["ALERT_OPENED", "WARNING", fourth]],
  );
});

test("S-H2: the §5f-like pattern 0, W, 0, W, W, W, 0 at 30 s opens nothing", async (t) => {
  const fake = setup(t);

  await ingestTurbidity(
    [NTU_NOMINAL, NTU_WARNING, NTU_NOMINAL, NTU_WARNING, NTU_WARNING, NTU_WARNING, NTU_NOMINAL],
    30_000,
  );

  assert.equal(fake.alerts.length, 0);
  assert.equal(fake.notifications.length, 0);
});

test("S-H3: an open turbidity episode in recovery, one unheld warning reading keeps nominalSince and notifies nobody", async (t) => {
  const fake = setup(t);
  seedAlert(fake, {
    parameter: "turbidity",
    severity: "WARNING",
    lastValue: NTU_NOMINAL,
    lastRecordedAt: minute(0),
    nominalSince: minute(-3),
  });
  for (let i = 6; i >= 0; i--) seedReading(fake, NTU_NOMINAL, at(-i * 30_000), "turbidity");
  seedReading(fake, NTU_WARNING, at(30_000), "turbidity");

  await evaluate(["turbidity"]);

  assert.deepEqual(fake.ops(), [...PREFIX.slice(0, 4), "tx.reading.findMany", ...PREFIX.slice(4), "tx.alert.update"]);
  assert.deepEqual(argsOf(fake, "tx.alert.update")[0].data, {
    lastValue: NTU_WARNING,
    lastRecordedAt: at(30_000),
  });
  assert.deepEqual(fake.alerts[0].nominalSince, minute(-3));
  assert.equal(fake.alerts[0].severity, "WARNING");
  assert.equal(fake.alerts[0].resolvedAt, null);
  assert.equal(fake.notifications.length, 0);
});

test("S-H4: a temperature evaluation never looks back (hold 1, no tx.reading.findMany)", async (t) => {
  const fake = setup(t);
  for (const n of [0, 1, 2, 3]) seedReading(fake, 18, minute(n));

  await evaluate(["temperature"]);
  assert.ok(!fake.ops().includes("tx.reading.findMany"));
  assert.deepEqual(fake.ops(), [...PREFIX, "tx.alert.create", "tx.profile.findMany", "tx.notification.createMany"]);
  assert.equal(fake.alerts[0].severity, "WARNING");
  assert.deepEqual(fake.alerts[0].openedAt, minute(3));
});

// ---------------------------------------------------------------------------------------------------------
// pH (Phase 9) — two-sided, held (ALERT_HOLD_READINGS.ph), critical lines PENDING BFAR (equal to the bounds)
// ---------------------------------------------------------------------------------------------------------

const PH = thresholdsFor(null).ph;
const PH_HOLD = ALERT_HOLD_READINGS.ph;
const PH_ACID = PH.safeMin - 0.5;
const PH_ALKALI = PH.safeMax + 0.3;
const PH_NEUTRAL = PH.safeMin + 0.5;
const RECOVERY_MIN = ALERT_RECOVERY_MS / MIN;

// Ingests one pH sample per entry, `stepMs` apart from T0, asserting each is stored.
async function ingestPh(values: number[], stepMs: number, device = turbidityDevice()) {
  for (const [n, value] of values.entries()) {
    const recordedAt = at(n * stepMs);
    const result = await ingestSamples(
      device,
      { firmwareVersion: "0.7.0", samples: [{ recordedAt, values: { ph: value } }] },
      recordedAt,
    );
    assert.deepEqual(result, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });
  }
}

for (const [side, value] of [
  ["acidic", PH_ACID],
  ["alkaline", PH_ALKALI],
] as const) {
  test(`ALRT-04 end-to-end pH ${side}: a held run opens WARNING, in-range readings resolve after ALERT_RECOVERY_MS`, async (t) => {
    const fake = setup(t);

    await ingestPh(
      [...Array.from({ length: PH_HOLD }, () => value), ...Array.from({ length: RECOVERY_MIN + 1 }, () => PH_NEUTRAL)],
      MIN,
    );

    assert.equal(fake.alerts.length, 1);
    const [episode] = fake.alerts;
    assert.equal(episode.parameter, "ph");
    assert.equal(episode.severity, "WARNING");
    assert.deepEqual(episode.openedAt, minute(PH_HOLD - 1));
    assert.deepEqual(episode.nominalSince, minute(PH_HOLD));
    assert.deepEqual(episode.resolvedAt, minute(PH_HOLD + RECOVERY_MIN));
    assert.deepEqual(
      fake.notifications.map((n) => [n.kind, n.severity, n.value, n.recordedAt]),
      [
        ["ALERT_OPENED", "WARNING", value, minute(PH_HOLD - 1)],
        ["ALERT_RESOLVED", "WARNING", PH_NEUTRAL, minute(PH_HOLD + RECOVERY_MIN)],
      ],
    );
  });
}

test("ALRT-05 pH: an open pH episode in recovery, one unheld acidic reading keeps nominalSince and notifies nobody", async (t) => {
  const fake = setup(t);
  seedAlert(fake, {
    parameter: "ph",
    severity: "WARNING",
    lastValue: PH_NEUTRAL,
    lastRecordedAt: minute(0),
    nominalSince: minute(-3),
  });
  for (let i = 6; i >= 0; i--) seedReading(fake, PH_NEUTRAL, at(-i * 30_000), "ph");
  seedReading(fake, PH_ACID, at(30_000), "ph");

  await evaluate(["ph"]);

  assert.deepEqual(fake.ops(), [...PREFIX.slice(0, 4), "tx.reading.findMany", ...PREFIX.slice(4), "tx.alert.update"]);
  assert.deepEqual(argsOf(fake, "tx.alert.update")[0].data, {
    lastValue: PH_ACID,
    lastRecordedAt: at(30_000),
  });
  assert.deepEqual(fake.alerts[0].nominalSince, minute(-3));
  assert.equal(fake.alerts[0].severity, "WARNING");
  assert.equal(fake.alerts[0].resolvedAt, null);
  assert.equal(fake.notifications.length, 0);
});

// ---------------------------------------------------------------------------------------------------------
// ALRT-05 — the hold applies to recovery-breaking readings (pH and turbidity; temperature unchanged)
// ---------------------------------------------------------------------------------------------------------

// HOLD out-of-range readings, then RECOVERY_MIN + 1 in-range readings one minute apart where every 4th one is
// replaced by a lone `stray`. The first recovery reading and the resolving one are always in range.
function recoveryWithStrays(open: number, inRange: number, stray: number, hold: number) {
  const recovery = Array.from({ length: RECOVERY_MIN + 1 }, (_, k) => ((k + 1) % 4 === 0 ? stray : inRange));
  assert.notEqual(recovery[0], stray);
  assert.notEqual(recovery[recovery.length - 1], stray);
  return [...Array.from({ length: hold }, () => open), ...recovery];
}

test("ALRT-05 end-to-end pH: lone acidic strays during recovery no longer keep the episode open", async (t) => {
  const fake = setup(t);

  await ingestPh(recoveryWithStrays(PH_ACID, PH_NEUTRAL, PH_ACID, PH_HOLD), MIN);

  assert.equal(fake.alerts.length, 1);
  const [episode] = fake.alerts;
  assert.equal(episode.severity, "WARNING");
  assert.deepEqual(episode.nominalSince, minute(PH_HOLD));
  assert.deepEqual(episode.resolvedAt, minute(PH_HOLD + RECOVERY_MIN));
  assert.equal(episode.lastValue, PH_NEUTRAL);
  assert.deepEqual(
    fake.notifications.map((n) => n.kind),
    ["ALERT_OPENED", "ALERT_RESOLVED"],
  );
  assert.equal(fake.notifications[1].value, PH_NEUTRAL);
});

test("ALRT-05 end-to-end turbidity: lone warning strays during recovery no longer keep the episode open", async (t) => {
  const fake = setup(t);
  const hold = ALERT_HOLD_READINGS.turbidity;

  await ingestTurbidity(recoveryWithStrays(NTU_WARNING, NTU_NOMINAL, NTU_WARNING, hold), MIN);

  assert.equal(fake.alerts.length, 1);
  const [episode] = fake.alerts;
  assert.equal(episode.severity, "WARNING");
  assert.deepEqual(episode.nominalSince, minute(hold));
  assert.deepEqual(episode.resolvedAt, minute(hold + RECOVERY_MIN));
  assert.deepEqual(
    fake.notifications.map((n) => n.kind),
    ["ALERT_OPENED", "ALERT_RESOLVED"],
  );
  assert.equal(fake.notifications[1].value, NTU_NOMINAL);
});

test("ALRT-05 turbidity: a lone CRITICAL stray during recovery is ignored; the WARNING episode resolves on time", async (t) => {
  const fake = setup(t);
  const hold = ALERT_HOLD_READINGS.turbidity;
  const values = [
    ...Array.from({ length: hold }, () => NTU_WARNING),
    ...Array.from({ length: RECOVERY_MIN + 1 }, (_, k) => (k === 5 ? NTU_CRITICAL : NTU_NOMINAL)),
  ];

  await ingestTurbidity(values, MIN);

  assert.equal(fake.alerts.length, 1);
  assert.equal(fake.alerts[0].severity, "WARNING");
  assert.deepEqual(fake.alerts[0].nominalSince, minute(hold));
  assert.deepEqual(fake.alerts[0].resolvedAt, minute(hold + RECOVERY_MIN));
  assert.deepEqual(
    fake.notifications.map((n) => [n.kind, n.severity]),
    [
      ["ALERT_OPENED", "WARNING"],
      ["ALERT_RESOLVED", "WARNING"],
    ],
  );
});

test("ALRT-05 pH: a held run during recovery still restarts the recovery clock", async (t) => {
  const fake = setup(t);

  await ingestPh(
    [
      ...Array.from({ length: PH_HOLD }, () => PH_ACID),
      ...Array.from({ length: 3 }, () => PH_NEUTRAL),
      ...Array.from({ length: PH_HOLD - 1 }, () => PH_ACID),
    ],
    MIN,
  );
  // One short of a held run: still unheld, the clock from the first in-range reading is kept.
  assert.deepEqual(fake.alerts[0].nominalSince, minute(PH_HOLD));

  const nth = at((2 * PH_HOLD + 2) * MIN);
  const result = await ingestSamples(
    turbidityDevice(),
    { firmwareVersion: "0.7.0", samples: [{ recordedAt: nth, values: { ph: PH_ACID } }] },
    nth,
  );
  assert.deepEqual(result, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });
  assert.equal(fake.alerts[0].nominalSince, null);
  assert.equal(fake.alerts[0].resolvedAt, null);
  // Worse than the readings before it, but within ALERT_RENOTIFY_MS of the opening notification.
  assert.deepEqual(
    fake.notifications.map((n) => n.kind),
    ["ALERT_OPENED"],
  );
});

test("ALRT-05 pH: nominalSince null + unheld reading stays null (the clock starts only on an in-range reading)", async (t) => {
  const fake = setup(t);
  // A held acidic run, then an outage longer than ALERT_HOLD_MAX_GAP_MS: the reading after it is out of range but
  // the gap breaks the run, so it is unheld while no in-range reading has started the clock yet.
  seedAlert(fake, { parameter: "ph", severity: "WARNING", lastValue: PH_ACID, lastRecordedAt: minute(-5), nominalSince: null });
  for (let i = 6; i >= 0; i--) seedReading(fake, PH_ACID, at(-5 * MIN - i * 30_000), "ph");
  seedReading(fake, PH_ALKALI, at(30_000), "ph");

  await evaluate(["ph"]);

  assert.deepEqual(argsOf(fake, "tx.alert.update")[0].data, { lastValue: PH_ALKALI, lastRecordedAt: at(30_000) });
  assert.equal(fake.alerts[0].nominalSince, null);
  assert.equal(fake.alerts[0].resolvedAt, null);
  assert.equal(fake.notifications.length, 0);
});
