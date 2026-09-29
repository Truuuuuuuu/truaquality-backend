import { test } from "node:test";
import assert from "node:assert/strict";
import type { Device } from "../generated/prisma/client.ts";
import { createPrismaFake } from "../testing/prismaFake.ts";
import { ingestSamples } from "./ingest.ts";
import { thresholdsFor } from "./parameters.ts";

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
    rssi: null,
    uptimeS: null,
    resetReason: null,
    freeHeap: null,
    queuedSamples: null,
    sensorStatus: null,
    diagnosticsAt: null,
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

  const result = await ingestSamples(device(), simulatorBatch(18, minute(0)), minute(0));

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

  const result = await ingestSamples(device(), simulatorBatch(18, minute(0)), minute(0));

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

// Firmware 0.6.0 shape: diag + sensors ride along with the samples (key order irrelevant once parsed).
const diagMessage = (overrides: Partial<Message> = {}): Message => ({
  firmwareVersion: "0.6.0",
  diag: { rssi: -67, uptimeS: 60, resetReason: "brownout", freeHeap: 201344, queued: 3 },
  sensors: { temperature: "ok", turbidity: "no_signal" },
  samples: [{ recordedAt: minute(0), values: { temperature: 28 } }],
  ...overrides,
});

test("diag + sensors are stored on the device, and derived events are written right after device.update", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  const previous = device({ firmwareVersion: "0.5.0", uptimeS: 5000, sensorStatus: { temperature: "ok" } });
  const result = await ingestSamples(previous, diagMessage(), minute(0));

  assert.deepEqual(result, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });
  assert.deepEqual(fake.ops().slice(0, 3), ["device.update", "deviceEvent.createMany", "reading.createMany"]);

  const [update] = argsOf(fake, "device.update");
  assert.deepEqual(update.data, {
    lastSeenAt: minute(0),
    firmwareVersion: "0.6.0",
    rssi: -67,
    uptimeS: 60,
    resetReason: "brownout",
    freeHeap: 201344,
    queuedSamples: 3,
    sensorStatus: { temperature: "ok", turbidity: "no_signal" },
    diagnosticsAt: minute(0),
  });

  assert.deepEqual(fake.deviceEvents, [
    { deviceId: DEVICE_ID, kind: "FIRMWARE_CHANGED", parameter: null, detail: "0.5.0 → 0.6.0", createdAt: minute(0) },
    { deviceId: DEVICE_ID, kind: "REBOOT", parameter: null, detail: "brownout", createdAt: minute(0) },
    { deviceId: DEVICE_ID, kind: "SENSOR_FAULT", parameter: "turbidity", detail: "no_signal", createdAt: minute(0) },
  ]);
});

test("diag with no derivable events writes no deviceEvent rows", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  await ingestSamples(device(), diagMessage({ sensors: { temperature: "ok" } }), minute(0));

  assert.equal(fake.ops().includes("deviceEvent.createMany"), false);
  const [update] = argsOf(fake, "device.update");
  assert.equal(update.data.diagnosticsAt.getTime(), minute(0).getTime());
});

test("a deviceEvent write failure is logged and does not fail the ingest", async (t) => {
  const fake = createPrismaFake({ failDeviceEvents: true });
  fake.install(t);
  const errorMock = t.mock.method(console, "error", () => {});

  const result = await ingestSamples(device({ uptimeS: 5000 }), diagMessage(), minute(0));

  assert.deepEqual(result, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });
  assert.equal(fake.readings.length, 1);
  assert.equal(fake.deviceEvents.length, 0);
  const [message, err] = errorMock.mock.calls[0]!.arguments as [string, Error];
  assert.equal(message, `[device-events] write failed for device ${DEVICE_ID}:`);
  assert.equal(err.message, "fake deviceEvent failure");
});

test("unassigned device still gets diag fields and events (they are device-level)", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  const result = await ingestSamples(device({ pondId: null, uptimeS: 5000 }), diagMessage(), minute(0));

  assert.deepEqual(result, { status: "unassigned" });
  assert.deepEqual(fake.ops(), ["device.update", "deviceEvent.createMany"]);
  const [update] = argsOf(fake, "device.update");
  assert.equal(update.data.rssi, -67);
  assert.deepEqual(
    fake.deviceEvents.map((e) => e.kind),
    ["REBOOT", "SENSOR_FAULT"],
  );
});

// Turbidity rides beside temperature in the same sample (firmware 0.6.0+). Nominal values keep the trace short.
const NOMINAL_NTU = thresholdsFor(null).turbidity.safeMax - 10;
const mixedBatch = (temperature: number, turbidity: number, recordedAt: Date): Message => ({
  firmwareVersion: "simulator",
  samples: [{ recordedAt, values: { temperature, turbidity } }],
});

test("mixed temperature + turbidity batch: one createMany, one pond read, one alert transaction per parameter", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  const result = await ingestSamples(device(), mixedBatch(28, NOMINAL_NTU, minute(0)), minute(0));

  assert.deepEqual(result, { status: "stored", accepted: 2, duplicates: 0, rejected: [] });
  assert.deepEqual(fake.ops(), [
    "device.update",
    "reading.createMany",
    "pond.findUnique",
    "$transaction",
    "tx.$executeRaw",
    "tx.reading.findFirst",
    "tx.alert.findFirst",
    "$transaction",
    "tx.$executeRaw",
    "tx.reading.findFirst",
    "tx.alert.findFirst",
  ]);

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
    {
      pondId: "pond-1",
      deviceId: DEVICE_ID,
      parameter: "turbidity",
      value: NOMINAL_NTU,
      recordedAt: minute(0),
      receivedAt: minute(0),
    },
  ]);

  const locks = argsOf(fake, "tx.$executeRaw");
  assert.deepEqual(
    locks.map((l) => l.values[0]),
    ["alert:pond-1:temperature", "alert:pond-1:turbidity"],
  );
  for (const lock of locks) assert.match(lock.sql, /pg_advisory_xact_lock\(hashtext\(\?\)\)/);

  assert.deepEqual(argsOf(fake, "pond.findUnique"), [{ where: { id: "pond-1" }, select: { pondType: true } }]);
  assert.equal(fake.readings.length, 2);
  assert.equal(fake.alerts.length, 0);
  assert.equal(fake.notifications.length, 0);
});

test("duplicate turbidity redelivery: second delivery stores nothing and skips alert evaluation", async (t) => {
  const fake = createPrismaFake();
  fake.install(t);

  const turbidityBatch: Message = {
    firmwareVersion: "simulator",
    samples: [{ recordedAt: minute(0), values: { turbidity: NOMINAL_NTU } }],
  };
  const first = await ingestSamples(device(), turbidityBatch, minute(0));
  const second = await ingestSamples(device(), turbidityBatch, minute(1));

  assert.deepEqual(first, { status: "stored", accepted: 1, duplicates: 0, rejected: [] });
  assert.deepEqual(second, { status: "stored", accepted: 0, duplicates: 1, rejected: [] });
  assert.equal(fake.ops().filter((op) => op === "$transaction").length, 1);
  assert.deepEqual(fake.ops().slice(-2), ["device.update", "reading.createMany"]);
  assert.equal(fake.readings.length, 1);
  assert.equal(argsOf(fake, "tx.$executeRaw")[0]!.values[0], "alert:pond-1:turbidity");
});
