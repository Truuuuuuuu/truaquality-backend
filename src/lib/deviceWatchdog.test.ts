// Must come before ./prisma.ts: importing that constructs the PrismaPg pool from DATABASE_URL.
import "../testing/guardEnv.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./prisma.ts";
import { runDeviceWatchdogCycle } from "./deviceWatchdog.ts";

// Trace tests for the watchdog's one transaction. The tx is a hand-built recorder (the reading-path prismaFake
// doesn't model devices); it is handed to the callback through a mocked prisma.$transaction, so no DB is touched.

type Call = { op: string; args: unknown };

function installWatchdogTx(
  t: TestContext,
  opts: { locked?: boolean; offline?: string[]; online?: string[] },
) {
  const calls: Call[] = [];
  const record = (op: string, args: unknown) => calls.push({ op, args });
  const findManyResults = [opts.offline ?? [], opts.online ?? []];
  let findManyCall = 0;

  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      record("tx.$queryRaw", { sql: strings.join("?"), values });
      return [{ locked: opts.locked ?? true }];
    },
    device: {
      findMany: async (args: unknown) => {
        record("tx.device.findMany", args);
        return (findManyResults[findManyCall++] ?? []).map((id) => ({ id }));
      },
      update: async (args: unknown) => {
        record("tx.device.update", args);
        return {};
      },
    },
    deviceEvent: {
      create: async (args: unknown) => {
        record("tx.deviceEvent.create", args);
        return {};
      },
    },
    profile: {
      findMany: async (args: unknown) => {
        record("tx.profile.findMany", args);
        return [{ id: "p1" }];
      },
    },
    notification: {
      createMany: async (args: { data: unknown[] }) => {
        record("tx.notification.createMany", args);
        return { count: args.data.length };
      },
    },
  };

  const $transaction = async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx);
  t.mock.property(prisma, "$transaction", $transaction as never);
  return { calls, ops: () => calls.map((c) => c.op) };
}

const argsOf = (calls: Call[], op: string) => calls.filter((c) => c.op === op).map((c) => c.args as Record<string, any>);

test("a stale device is flagged offline, gets an OFFLINE event, and notifies", async (t) => {
  const fake = installWatchdogTx(t, { offline: ["dev-1"] });

  const result = await runDeviceWatchdogCycle();

  assert.deepEqual(result, { offline: 1, online: 0 });
  assert.deepEqual(fake.ops(), [
    "tx.$queryRaw",
    "tx.device.findMany",
    "tx.device.update",
    "tx.deviceEvent.create",
    "tx.profile.findMany",
    "tx.notification.createMany",
    "tx.device.findMany",
  ]);
  const [update] = argsOf(fake.calls, "tx.device.update");
  assert.equal(update.where.id, "dev-1");
  assert.ok(update.data.offlineSince instanceof Date);
  assert.deepEqual(argsOf(fake.calls, "tx.deviceEvent.create"), [{ data: { deviceId: "dev-1", kind: "OFFLINE" } }]);
  const [notify] = argsOf(fake.calls, "tx.notification.createMany");
  assert.deepEqual(notify.data, [{ profileId: "p1", deviceId: "dev-1", kind: "DEVICE_OFFLINE", severity: "CRITICAL" }]);
});

test("a recovered device is cleared, gets an ONLINE event, and notifies", async (t) => {
  const fake = installWatchdogTx(t, { online: ["dev-2"] });

  const result = await runDeviceWatchdogCycle();

  assert.deepEqual(result, { offline: 0, online: 1 });
  assert.deepEqual(fake.ops(), [
    "tx.$queryRaw",
    "tx.device.findMany",
    "tx.device.findMany",
    "tx.device.update",
    "tx.deviceEvent.create",
    "tx.profile.findMany",
    "tx.notification.createMany",
  ]);
  assert.deepEqual(argsOf(fake.calls, "tx.device.update"), [{ where: { id: "dev-2" }, data: { offlineSince: null } }]);
  assert.deepEqual(argsOf(fake.calls, "tx.deviceEvent.create"), [{ data: { deviceId: "dev-2", kind: "ONLINE" } }]);
  const [notify] = argsOf(fake.calls, "tx.notification.createMany");
  assert.deepEqual(notify.data, [{ profileId: "p1", deviceId: "dev-2", kind: "DEVICE_ONLINE", severity: "CRITICAL" }]);
});

test("lock not acquired: returns null and writes nothing", async (t) => {
  const fake = installWatchdogTx(t, { locked: false, offline: ["dev-1"], online: ["dev-2"] });

  const result = await runDeviceWatchdogCycle();

  assert.equal(result, null);
  assert.deepEqual(fake.ops(), ["tx.$queryRaw"]);
});
