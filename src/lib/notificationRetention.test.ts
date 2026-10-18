// Must precede prisma: the test guard refuses non-local database URLs.
import "../testing/guardEnv.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { prisma } from "./prisma.ts";
import { runNotificationRetentionCycle, startNotificationRetention } from "./notificationRetention.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

type Row = { id: string; profileId: string; createdAt: Date; readAt: Date | null };

function installRetentionTx(t: TestContext, options: { locked?: boolean; rows?: Row[]; failOnce?: boolean } = {}) {
  const calls: { op: string; args?: unknown }[] = [];
  let rows = options.rows ?? [];
  let attempts = 0;
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ op: "lock", args: { sql: strings.join("?"), values } });
      return [{ locked: options.locked ?? true }];
    },
    notification: {
      deleteMany: async (args: { where: { createdAt: { lt: Date } } }) => {
        calls.push({ op: "delete", args });
        const before = rows.length;
        rows = rows.filter((row) => row.createdAt >= args.where.createdAt.lt);
        return { count: before - rows.length };
      },
    },
  };
  const transaction = async (fn: (client: typeof tx) => Promise<unknown>) => {
    attempts++;
    if (options.failOnce && attempts === 1) throw new Error("temporary database failure");
    return fn(tx);
  };
  t.mock.property(prisma, "$transaction", transaction as never);
  t.mock.method(Date, "now", () => NOW);
  return { calls, rows: () => rows, attempts: () => attempts };
}

test("retention deletes old read and unread notifications across profiles, preserving the exact cutoff and newer rows", async (t) => {
  const cutoff = NOW - SIXTY_DAYS_MS;
  const row = (id: string, offset: number, readAt: Date | null, profileId = "p1"): Row => ({
    id, profileId, createdAt: new Date(cutoff + offset), readAt,
  });
  const fake = installRetentionTx(t, { rows: [
    row("old-read", -1, new Date(NOW)),
    row("old-unread", -1000, null, "p2"),
    row("exact", 0, null),
    row("new", 1, new Date(NOW)),
  ] });

  assert.deepEqual(await runNotificationRetentionCycle(), { deleted: 2 });
  assert.deepEqual(fake.rows().map((entry) => entry.id), ["exact", "new"]);
  assert.deepEqual(fake.calls.map((call) => call.op), ["lock", "delete"]);
  assert.deepEqual(fake.calls[1]?.args, { where: { createdAt: { lt: new Date(cutoff) } } });
  const lock = fake.calls[0]?.args as { sql: string; values: unknown[] };
  assert.match(lock.sql, /pg_try_advisory_xact_lock/);
  assert.deepEqual(lock.values, [84_213_908n]);
});

test("retention skips deletion when another instance holds its transaction lock", async (t) => {
  const fake = installRetentionTx(t, { locked: false });
  assert.equal(await runNotificationRetentionCycle(), null);
  assert.deepEqual(fake.calls.map((call) => call.op), ["lock"]);
});

test("retention reports zero when there are no expired notifications", async (t) => {
  installRetentionTx(t);
  assert.deepEqual(await runNotificationRetentionCycle(), { deleted: 0 });
});

test("scheduler runs immediately and hourly, logs failures and recovers on the next cycle", async (t) => {
  const fake = installRetentionTx(t, { failOnce: true });
  const errors = t.mock.method(console, "error", () => {});
  let callback: (() => void) | undefined;
  let interval: number | undefined;
  const timer = {} as ReturnType<typeof setInterval>;
  t.mock.method(globalThis, "setInterval", ((fn: () => void, ms: number) => {
    callback = fn;
    interval = ms;
    return timer;
  }) as typeof setInterval);

  assert.equal(startNotificationRetention(), timer);
  await setImmediate();
  assert.equal(fake.attempts(), 1);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(errors.mock.calls[0]?.arguments[0], "[notification-retention] cycle failed:");
  assert.equal(interval, 60 * 60 * 1000);

  assert.ok(callback);
  callback();
  await setImmediate();
  assert.equal(fake.attempts(), 2);
  assert.deepEqual(fake.calls.map((call) => call.op), ["lock", "delete"]);
  assert.equal(errors.mock.callCount(), 1);
});
