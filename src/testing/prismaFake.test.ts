import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrismaFake, type FakeAlert } from "./prismaFake.ts";

// Tests OF the double, not with it. The trace tests in ingest.test.ts / alerts.test.ts are only worth
// what the fake's fidelity to Prisma is worth, so the properties they lean on are pinned here.
// Transactions are driven directly through fake.$transaction — no production call path involved.

const T0 = new Date("2030-01-01T00:00:00Z");

const seedAlert = (fake: ReturnType<typeof createPrismaFake>, overrides: Partial<FakeAlert> = {}) => {
  const alert: FakeAlert = {
    id: "alert-seed",
    pondId: "pond-1",
    parameter: "temperature",
    severity: "WARNING",
    openedAt: T0,
    lastValue: 25,
    lastRecordedAt: T0,
    nominalSince: null,
    resolvedAt: null,
    ...overrides,
  };
  fake.alerts.push(alert);
  return alert;
};

const OPEN_WHERE = { where: { pondId: "pond-1", parameter: "temperature", resolvedAt: null } };

test("tx.alert.findFirst returns a detached snapshot, not the stored row", async () => {
  const fake = createPrismaFake();
  const stored = seedAlert(fake);

  await fake.$transaction(async (tx) => {
    const open = await tx.alert.findFirst(OPEN_WHERE);
    assert.ok(open);
    assert.notEqual(open, stored, "must not be the very object held in fake.alerts");
    assert.equal(open.severity, "WARNING");

    await tx.alert.update({ where: { id: "alert-seed" }, data: { severity: "CRITICAL" } });

    // Real Prisma read this row before the update, so it still reads WARNING. Handing back the live
    // object would report CRITICAL here and hide every read-after-write bug in the shell — including
    // the one alerts.ts is one moved line away from (severity: episode.severity, read after update).
    assert.equal(open.severity, "WARNING");
    assert.equal(stored.severity, "CRITICAL", "the stored row is what the update changed");
  });
});

test("tx.alert.create returns a copy, so the caller cannot reach the stored row", async () => {
  const fake = createPrismaFake();

  await fake.$transaction(async (tx) => {
    const created = await tx.alert.create({
      data: {
        pondId: "pond-1",
        parameter: "temperature",
        severity: "WARNING",
        openedAt: T0,
        lastValue: 25,
        lastRecordedAt: T0,
      },
    });
    created.lastValue = -999;
  });

  assert.equal(fake.alerts[0]!.lastValue, 25);
});

test("tx.alert.update returns a copy, so mutating the result cannot corrupt the store", async () => {
  const fake = createPrismaFake();
  seedAlert(fake);

  await fake.$transaction(async (tx) => {
    const updated = await tx.alert.update({ where: { id: "alert-seed" }, data: { lastValue: 22 } });
    updated.lastValue = -999;
  });

  assert.equal(fake.alerts[0]!.lastValue, 22);
});

test("a throw inside the transaction rolls back every write made in it", async () => {
  const fake = createPrismaFake();
  seedAlert(fake);

  await assert.rejects(
    fake.$transaction(async (tx) => {
      await tx.alert.update({ where: { id: "alert-seed" }, data: { severity: "CRITICAL" } });
      await tx.notification.createMany({
        data: [{ profileId: "p1", alertId: "alert-seed", kind: "ALERT_ESCALATED", recordedAt: T0 }],
      });
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.equal(fake.alerts[0]!.severity, "WARNING", "the escalation must not survive the abort");
  assert.equal(fake.notifications.length, 0, "the notification rows must not survive the abort");
});

test("an alert created inside an aborted transaction is rolled back too", async () => {
  const fake = createPrismaFake();

  await assert.rejects(
    fake.$transaction(async (tx) => {
      await tx.alert.create({
        data: {
          pondId: "pond-1",
          parameter: "temperature",
          severity: "WARNING",
          openedAt: T0,
          lastValue: 25,
          lastRecordedAt: T0,
        },
      });
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.equal(fake.alerts.length, 0);
});

test("failInTransaction fails after the callback ran, and that work is rolled back", async () => {
  const fake = createPrismaFake({ failInTransaction: true });
  seedAlert(fake);
  let callbackFinished = false;

  await assert.rejects(
    fake.$transaction(async (tx) => {
      await tx.alert.update({ where: { id: "alert-seed" }, data: { severity: "CRITICAL" } });
      callbackFinished = true;
    }),
    /fake in-transaction failure/,
  );

  assert.equal(callbackFinished, true, "failInTransaction must model a failure at commit, not at start");
  assert.equal(fake.alerts[0]!.severity, "WARNING");
});

test("failTransaction still fails before the callback runs at all", async () => {
  const fake = createPrismaFake({ failTransaction: true });
  let ran = false;

  await assert.rejects(
    fake.$transaction(async () => {
      ran = true;
    }),
    /fake transaction failure/,
  );
  assert.equal(ran, false);
});

test("a committed transaction keeps its writes (the rollback is not unconditional)", async () => {
  const fake = createPrismaFake();
  seedAlert(fake);

  await fake.$transaction(async (tx) => {
    await tx.alert.update({ where: { id: "alert-seed" }, data: { severity: "CRITICAL" } });
    await tx.notification.createMany({
      data: [{ profileId: "p1", alertId: "alert-seed", kind: "ALERT_ESCALATED", recordedAt: T0 }],
    });
  });

  assert.equal(fake.alerts[0]!.severity, "CRITICAL");
  assert.equal(fake.notifications.length, 1);
});
