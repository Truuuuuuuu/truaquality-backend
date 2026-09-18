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
