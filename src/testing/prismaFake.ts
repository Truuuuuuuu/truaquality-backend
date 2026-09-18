// Must come before ../lib/prisma.ts: importing that constructs the PrismaPg pool from DATABASE_URL,
// so the guard has to have refused a non-local one already.
import "./guardEnv.ts";
import type { TestContext } from "node:test";
import { prisma } from "../lib/prisma.ts";

// In-memory, call-recording stand-in for the parts of the Prisma client that the reading path touches
// (ingest.ts -> alerts.ts -> notify.ts). install(t) swaps the delegates on the real `prisma` singleton with
// t.mock.property, which restores them automatically when the test ends.
//
// No DB connection is ever made: every delegate the reading path uses is replaced before the call, and
// test.env points DATABASE_URL at 127.0.0.1:1 so anything left unmocked fails fast instead of reaching
// Supabase. notifyActiveUsers only ever receives this fake's transaction client, whose profile list is the
// fake's own ids — so no real user can be notified from a test.

export type FakeCall = { op: string; args: unknown };

export type FakeReading = {
  pondId: string;
  deviceId: string;
  parameter: string;
  value: number;
  recordedAt: Date;
  receivedAt?: Date;
};

export type FakeAlert = {
  id: string;
  pondId: string;
  parameter: string;
  severity: "WARNING" | "CRITICAL";
  openedAt: Date;
  lastValue: number;
  lastRecordedAt: Date;
  nominalSince: Date | null;
  resolvedAt: Date | null;
};

export type FakeNotification = {
  profileId: string;
  alertId?: string | null;
  kind: string;
  severity?: string | null;
  value?: number | null;
  recordedAt?: Date | null;
};

export type PrismaFakeOptions = {
  pondType?: string | null;
  activeProfileIds?: string[];
  // Throws before the callback runs (the transaction never started).
  failTransaction?: boolean;
  // Throws after the callback ran (a failure at commit): the work it did must be rolled back.
  failInTransaction?: boolean;
  createManyCount?: (rows: FakeReading[]) => number;
};

type Where = Record<string, unknown>;

// `orderBy: { <col>: "desc" }` in Postgres is DESC NULLS FIRST, so a null sorts ahead of every value —
// the opposite of treating it as -Infinity, which put it last and made the fake unable to reproduce the
// row real Prisma would have returned.
function newestBy<T>(items: T[], key: (item: T) => Date | null | undefined): T | null {
  let best: T | null = null;
  let bestTime = -Infinity;
  for (const item of items) {
    const time = key(item)?.getTime() ?? Infinity;
    if (best === null || time > bestTime) {
      best = item;
      bestTime = time;
    }
  }
  return best;
}

export function createPrismaFake(opts: PrismaFakeOptions = {}) {
  const calls: FakeCall[] = [];
  const readings: FakeReading[] = [];
  const alerts: FakeAlert[] = [];
  const notifications: FakeNotification[] = [];
  let alertSeq = 0;

  const record = (op: string, args: unknown) => {
    calls.push({ op, args: structuredClone(args) });
  };

  const device = {
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      record("device.update", args);
      // A fresh object, not args.data itself, so a caller mutating the result cannot reach back into
      // the arguments it passed in.
      return { id: args.where.id, ...args.data };
    },
  };

  const reading = {
    createMany: async (args: { data: FakeReading[]; skipDuplicates?: boolean }) => {
      record("reading.createMany", args);
      let inserted = 0;
      for (const row of args.data) {
        // Mimics Reading @@unique([deviceId, parameter, recordedAt]) + skipDuplicates.
        const exists = readings.some(
          (r) =>
            r.deviceId === row.deviceId &&
            r.parameter === row.parameter &&
            r.recordedAt.getTime() === row.recordedAt.getTime(),
        );
        if (exists) continue;
        readings.push({ ...row });
        inserted++;
      }
      return { count: opts.createManyCount ? opts.createManyCount(args.data) : inserted };
    },
  };

  const pond = {
    findUnique: async (args: unknown) => {
      record("pond.findUnique", args);
      return { pondType: opts.pondType ?? null };
    },
  };

  // Transaction-scoped advisory locks, modelled rather than recorded. Asserting only that the SQL text
  // and the key string are right left the property the lock exists for — that two concurrently handled
  // MQTT messages cannot both see "no open alert" and each open one — untested, and the suite would have
  // stayed green with the lock line deleted. One FIFO queue per key, released when the transaction ends;
  // re-entrant within a transaction, as Postgres advisory locks are.
  const lockTails = new Map<string, Promise<void>>();

  async function acquireLock(key: string): Promise<() => void> {
    const waitFor = lockTails.get(key) ?? Promise.resolve();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    lockTails.set(
      key,
      waitFor.then(() => held),
    );
    await waitFor;
    return release;
  }

  // One client per transaction so it can track the locks that transaction holds.
  const createTx = (held: { keys: Set<string>; releases: Array<() => void> }) => ({
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      record("tx.$executeRaw", { sql, values });
      if (sql.includes("pg_advisory_xact_lock")) {
        const key = String(values[0]);
        if (!held.keys.has(key)) {
          held.keys.add(key);
          held.releases.push(await acquireLock(key));
        }
      }
      return 1;
    },
    reading: {
      findFirst: async (args: { where: Where }) => {
        record("tx.reading.findFirst", args);
        const matches = readings.filter(
          (r) => r.pondId === args.where.pondId && r.parameter === args.where.parameter,
        );
        const newest = newestBy(matches, (r) => r.recordedAt);
        return newest ? { value: newest.value, recordedAt: newest.recordedAt } : null;
      },
    },
    // Every delegate returns a DETACHED copy, because real Prisma returns a snapshot of the row as it
    // was read. Handing back the stored object instead made read-after-write bugs invisible: alerts.ts
    // reads episode.severity for the ALERT_RESOLVED notification *after* tx.alert.update, and with a
    // live object that read would see the new value under the fake and the old value in production.
    alert: {
      findFirst: async (args: { where: Where }) => {
        record("tx.alert.findFirst", args);
        const found = alerts.find(
          (a) => a.pondId === args.where.pondId && a.parameter === args.where.parameter && a.resolvedAt === null,
        );
        return found ? { ...found } : null;
      },
      create: async (args: { data: Omit<FakeAlert, "id" | "nominalSince" | "resolvedAt"> }) => {
        record("tx.alert.create", args);
        // "One open alert per (pond, parameter)" is what the advisory lock in alerts.ts protects. The
        // fake enforces it so a lost or deleted lock surfaces as a failure instead of two episodes.
        const alreadyOpen = alerts.some(
          (a) => a.pondId === args.data.pondId && a.parameter === args.data.parameter && a.resolvedAt === null,
        );
        if (alreadyOpen) {
          throw new Error(
            `fake: a second open alert for the same pond/parameter (${args.data.pondId}/${args.data.parameter}) — lost lock?`,
          );
        }
        alertSeq++;
        const alert: FakeAlert = { id: `alert-${alertSeq}`, nominalSince: null, resolvedAt: null, ...args.data };
        alerts.push(alert);
        return { ...alert };
      },
      update: async (args: { where: { id: string }; data: Partial<FakeAlert> }) => {
        record("tx.alert.update", args);
        const alert = alerts.find((a) => a.id === args.where.id);
        if (!alert) throw new Error(`fake: no alert ${args.where.id}`);
        Object.assign(alert, args.data);
        return { ...alert };
      },
    },
    notification: {
      findFirst: async (args: { where: Where }) => {
        record("tx.notification.findFirst", args);
        let rows = notifications.filter((n) => n.alertId === args.where.alertId);
        // Honour `recordedAt: { not: null }`. Without it the fake would silently widen the query and
        // hide the NULLS FIRST ordering the filter exists to avoid.
        const recordedAtFilter = args.where.recordedAt as { not?: unknown } | undefined;
        if (recordedAtFilter && recordedAtFilter.not === null) {
          rows = rows.filter((n) => n.recordedAt != null);
        }
        const newest = newestBy(rows, (n) => n.recordedAt);
        return newest ? { recordedAt: newest.recordedAt ?? null } : null;
      },
      createMany: async (args: { data: FakeNotification[] }) => {
        record("tx.notification.createMany", args);
        for (const row of args.data) notifications.push({ ...row });
        return { count: args.data.length };
      },
    },
    profile: {
      findMany: async (args: unknown) => {
        record("tx.profile.findMany", args);
        return (opts.activeProfileIds ?? ["p1"]).map((id) => ({ id }));
      },
    },
  });

  type FakeTx = ReturnType<typeof createTx>;

  // failTransaction models "the transaction could not start"; failInTransaction models the failure that
  // actually matters and had no way to be expressed before — a notification.createMany conflict, a lost
  // connection after tx.alert.update — i.e. work done inside the callback that must not survive.
  //
  // The rollback is what makes either one faithful: writes go straight into the arrays, so without a
  // snapshot an aborted transaction left partial state behind, the exact opposite of a real one. A
  // future bug where an alert is escalated but its notifications are not written would have passed.
  const $transaction = async (fn: (client: FakeTx) => Promise<unknown>) => {
    record("$transaction", null);
    if (opts.failTransaction) throw new Error("fake transaction failure");
    // alerts[] rows are mutated in place by update, so they need copying; notification rows are only
    // ever appended, so the array copy is enough. readings are never written inside a transaction.
    const snapshot = { alerts: alerts.map((a) => ({ ...a })), notifications: [...notifications] };
    const held = { keys: new Set<string>(), releases: [] as Array<() => void> };
    try {
      const result = await fn(createTx(held));
      if (opts.failInTransaction) throw new Error("fake in-transaction failure");
      return result;
    } catch (err) {
      alerts.splice(0, alerts.length, ...snapshot.alerts);
      notifications.splice(0, notifications.length, ...snapshot.notifications);
      throw err;
    } finally {
      // Advisory locks are transaction-scoped, so they go on commit AND on abort.
      for (const release of held.releases) release();
    }
  };

  return {
    calls,
    readings,
    alerts,
    notifications,
    // Exposed so tests OF the double (prismaFake.test.ts) can drive a transaction directly and
    // typed, without going through a production call path.
    $transaction,
    ops: () => calls.map((c) => c.op),
    install(t: TestContext) {
      t.mock.property(prisma, "device", device as never);
      t.mock.property(prisma, "reading", reading as never);
      t.mock.property(prisma, "pond", pond as never);
      t.mock.property(prisma, "$transaction", $transaction as never);
    },
  };
}

export type PrismaFake = ReturnType<typeof createPrismaFake>;
