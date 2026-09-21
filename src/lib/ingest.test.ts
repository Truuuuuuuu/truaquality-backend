import { test } from "node:test";
import assert from "node:assert/strict";
import type { Device } from "../generated/prisma/client.ts";
import { createPrismaFake } from "../testing/prismaFake.ts";
import { ingestSamples } from "./ingest.ts";

// Shell-trace characterization of ingestSamples against the in-memory Prisma fake (TEST-01). Written against
// the UNMODIFIED ingest.ts before the pure core is extracted: any behavior change in the extraction fails here.
// Every timestamp derives from T0 — never the wall clock.

const T0 = new Date("2030-01-01T00:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const minute = (n: number) => new Date(T0.getTime() + n * MIN);
const at = (ms: number) => new Date(T0.getTime() + ms);

type Message = Parameters<typeof ingestSamples>[1];

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";

function device(overrides: Partial<Device> = {}): Device {
  return {
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
    ...overrides,
  } as Device;
}

// Simulator-shaped message: firmwareVersion "simulator", one sample per minute (scripts/simulate-devices.ts).
const simulatorBatch = (value: number, recordedAt: Date): Message => ({
  firmwareVersion: "simulator",
  samples: [{ recordedAt, values: { temperature: value } }],
});

const argsOf = (fake: ReturnType<typeof createPrismaFake>, op: string) =>
  fake.calls.filter((c) => c.op === op).map((c) => c.args as Record<string, any>);

test("nominal simulator batch: stored, device touched, alert evaluated with no alert opened", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  const result = await ingestSamples(device(), simulatorBatch(28, minute(0)), minute(0));

  assert.deepEqual(result, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });
  assert.deepEqual(fake.ops(), [
    "device.update",
    "reading.createMany",
    "pond.findUnique",
    "$transaction",
    "tx.$executeRaw",
    "tx.reading.findFirst",
    "tx.alert.findFirst",
  ]);

  const [update] = argsOf(fake, "device.update");
  assert.deepEqual(update, {
    where: { id: DEVICE_ID },
    data: { lastSeenAt: minute(0), firmwareVersion: "simulator" },
  });

  const [createMany] = argsOf(fake, "reading.createMany");
  assert.equal(createMany.skipDuplicates, true);
  assert.deepEqual(createMany.data, [
    {
      pondId: "pond-1",
      deviceId: DEVICE_ID,
      parameter: "temperature",
      value: 28,
      recordedAt: minute(0),
      receivedAt: minute(0),
    },
  ]);

  const [lock] = argsOf(fake, "tx.$executeRaw");
  assert.equal(lock.values[0], "alert:pond-1:temperature");
  assert.match(lock.sql, /pg_advisory_xact_lock\(hashtext\(\?\)\)/);

  assert.deepEqual(argsOf(fake, "pond.findUnique"), [{ where: { id: "pond-1" }, select: { pondType: true } }]);
  assert.equal(fake.alerts.length, 0);
  assert.equal(fake.notifications.length, 0);
});

test("duplicate redelivery: second delivery stores nothing and skips alert evaluation", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  const first = await ingestSamples(device(), simulatorBatch(28, minute(0)), minute(0));
  const txCountAfterFirst = fake.ops().filter((op) => op === "$transaction").length;
  const second = await ingestSamples(device(), simulatorBatch(28, minute(0)), minute(1));

  assert.deepEqual(first, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });
  assert.deepEqual(second, { status: "stored", accepted: 0, duplicates: 1, rejected: [] });
  assert.equal(txCountAfterFirst, 1);
  assert.equal(fake.ops().filter((op) => op === "$transaction").length, 1);
  // The duplicate still touches the device (lastSeenAt) and still reaches createMany.
  assert.deepEqual(fake.ops().slice(-2), ["device.update", "reading.createMany"]);
  assert.equal(fake.readings.length, 1);
});

test("unassigned device: only lastSeenAt is recorded", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  const result = await ingestSamples(device({ pondId: null }), simulatorBatch(28, minute(0)), minute(0));

  assert.deepEqual(result, { status: "unassigned" });
  assert.deepEqual(fake.ops(), ["device.update"]);
  assert.equal(fake.readings.length, 0);
});

test("alert evaluation failure is logged and does not fail the ingest", async (t) => {
  const fake = createPrismaFake({ failTransaction: true });
  fake.install(t);
  const errorMock = t.mock.method(console, "error", () => {});

  const result = await ingestSamples(device(), simulatorBatch(25, minute(0)), minute(0));

  assert.deepEqual(result, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });
  assert.equal(errorMock.mock.callCount(), 1);
  const [message, err] = errorMock.mock.calls[0].arguments as [string, Error];
  assert.equal(message, "[alerts] evaluation failed for pond pond-1:");
  assert.equal(err.message, "fake transaction failure");
  assert.deepEqual(fake.ops(), ["device.update", "reading.createMany", "pond.findUnique", "$transaction"]);
});

test("a failure INSIDE the alert transaction is logged, and its partial writes are rolled back", async (t) => {
  // The other failure case models "the transaction could not start", which never reaches the alert
  // writes. This one is the case that actually matters: the callback opened an alert and queued its
  // notifications, then the commit failed — none of it may survive, and ingest must still succeed.
  const fake = createPrismaFake({ failInTransaction: true });
  fake.install(t);
  const errorMock = t.mock.method(console, "error", () => {});

  const result = await ingestSamples(device(), simulatorBatch(25, minute(0)), minute(0));

  assert.deepEqual(result, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });
  assert.equal(errorMock.mock.callCount(), 1);
  const [message, err] = errorMock.mock.calls[0].arguments as [string, Error];
  assert.equal(message, "[alerts] evaluation failed for pond pond-1:");
  assert.equal(err.message, "fake in-transaction failure");
  // The callback ran all the way through — the alert and its notification were written, then undone.
  assert.deepEqual(fake.ops(), [
    "device.update",
    "reading.createMany",
    "pond.findUnique",
    "$transaction",
    "tx.$executeRaw",
    "tx.reading.findFirst",
    "tx.alert.findFirst",
    "tx.alert.create",
    "tx.profile.findMany",
    "tx.notification.createMany",
  ]);
  assert.equal(fake.alerts.length, 0, "the opened alert must not survive the abort");
  assert.equal(fake.notifications.length, 0, "its notifications must not survive the abort");
  assert.equal(fake.readings.length, 1, "the readings were committed before the alert transaction");
});

test("firmwareVersion absent or empty is not written to the device", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  await ingestSamples(device(), { samples: [{ recordedAt: minute(0), values: { temperature: 28 } }] }, minute(0));
  // ingestSchema trims, so a whitespace-only version arrives as "" — falsy, so it is omitted too.
  await ingestSamples(
    device(),
    { firmwareVersion: "", samples: [{ recordedAt: minute(1), values: { temperature: 28 } }] },
    minute(1),
  );

  const updates = argsOf(fake, "device.update");
  assert.equal(updates.length, 2);
  for (const update of updates) {
    assert.equal(Object.hasOwn(update.data, "firmwareVersion"), false);
    assert.ok(update.data.lastSeenAt instanceof Date);
  }
});

test("wifiSsid is written to the device when present", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  await ingestSamples(
    device(),
    { wifiSsid: "Fish Farm", samples: [{ recordedAt: minute(0), values: { temperature: 28 } }] },
    minute(0),
  );

  const [update] = argsOf(fake, "device.update");
  assert.equal(update.data.wifiSsid, "Fish Farm");
});

test("wifiSsid absent or empty is not written to the device", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  await ingestSamples(device(), { samples: [{ recordedAt: minute(0), values: { temperature: 28 } }] }, minute(0));
  await ingestSamples(
    device(),
    { wifiSsid: "", samples: [{ recordedAt: minute(1), values: { temperature: 28 } }] },
    minute(1),
  );

  const updates = argsOf(fake, "device.update");
  assert.equal(updates.length, 2);
  for (const update of updates) assert.equal(Object.hasOwn(update.data, "wifiSsid"), false);
});

test("mixed-rejection batch: reasons pinned in sample order, only accepted rows reach createMany", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  const assignedAt = at(-30 * DAY);
  const preAssignment = at(-30 * DAY - 1);
  const tooOld = at(-7 * DAY - 1);
  const future = at(5 * MIN + 1);

  const result = await ingestSamples(
    device({ assignedAt }),
    {
      firmwareVersion: "simulator",
      samples: [
        { recordedAt: minute(-1), values: { temperature: 60.01 } },
        { recordedAt: minute(-2), values: { ph: 7 } },
        { recordedAt: preAssignment, values: { temperature: 28 } },
        { recordedAt: tooOld, values: { temperature: 28 } },
        { recordedAt: future, values: { temperature: 28 } },
        { recordedAt: minute(-3), values: { temperature: null } },
        { recordedAt: minute(-4), values: { temperature: 28 } },
      ],
    },
    minute(0),
  );

  assert.deepEqual(result, {
    status: "stored",
    accepted: 1,
    duplicates: 0,
    rejected: [
      { recordedAt: minute(-1), parameter: "temperature", value: 60.01, reason: "outside -5..60" },
      { recordedAt: minute(-2), parameter: "ph", value: 7, reason: "unknown parameter" },
      {
        recordedAt: preAssignment,
        parameter: "temperature",
        value: 28,
        reason: "recorded before the device was assigned to this pond",
      },
      { recordedAt: tooOld, parameter: "temperature", value: 28, reason: "older than 7 days" },
      {
        recordedAt: future,
        parameter: "temperature",
        value: 28,
        reason: "recorded in the future (check the device clock)",
      },
    ],
  });

  const [createMany] = argsOf(fake, "reading.createMany");
  assert.deepEqual(createMany.data, [
    {
      pondId: "pond-1",
      deviceId: DEVICE_ID,
      parameter: "temperature",
      value: 28,
      recordedAt: minute(-4),
      receivedAt: minute(0),
    },
  ]);
});

test("in-batch identical samples: both rows sent, the DB-level dedupe counts one as duplicate", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  const result = await ingestSamples(
    device(),
    {
      firmwareVersion: "simulator",
      samples: [
        { recordedAt: minute(0), values: { temperature: 28 } },
        { recordedAt: minute(0), values: { temperature: 28 } },
      ],
    },
    minute(0),
  );

  // Characterization, not endorsement: ingest does no in-batch dedupe — it relies on the @@unique +
  // skipDuplicates in the database, so an identical pair surfaces as one accepted + one duplicate.
  const [createMany] = argsOf(fake, "reading.createMany");
  assert.equal(createMany.data.length, 2);
  assert.deepEqual(result, { status: "stored", accepted: 1, duplicates: 1, rejected: [] });
});
