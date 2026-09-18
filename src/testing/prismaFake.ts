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
  failTransaction?: boolean;
  createManyCount?: (rows: FakeReading[]) => number;
};

type Where = Record<string, unknown>;

function newestBy<T>(items: T[], key: (item: T) => Date | null | undefined): T | null {
  let best: T | null = null;
  let bestTime = -Infinity;
  for (const item of items) {
    const time = key(item)?.getTime() ?? -Infinity;
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

  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      record("tx.$executeRaw", { sql: strings.join("?"), values });
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
    alert: {
      findFirst: async (args: { where: Where }) => {
        record("tx.alert.findFirst", args);
        return (
          alerts.find(
            (a) => a.pondId === args.where.pondId && a.parameter === args.where.parameter && a.resolvedAt === null,
          ) ?? null
        );
      },
      create: async (args: { data: Omit<FakeAlert, "id" | "nominalSince" | "resolvedAt"> }) => {
        record("tx.alert.create", args);
        alertSeq++;
        const alert: FakeAlert = { id: `alert-${alertSeq}`, nominalSince: null, resolvedAt: null, ...args.data };
        alerts.push(alert);
        return alert;
      },
      update: async (args: { where: { id: string }; data: Partial<FakeAlert> }) => {
        record("tx.alert.update", args);
        const alert = alerts.find((a) => a.id === args.where.id);
        if (!alert) throw new Error(`fake: no alert ${args.where.id}`);
        Object.assign(alert, args.data);
        return alert;
      },
    },
    notification: {
      findFirst: async (args: { where: Where }) => {
        record("tx.notification.findFirst", args);
        const newest = newestBy(
          notifications.filter((n) => n.alertId === args.where.alertId),
          (n) => n.recordedAt,
        );
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
  };

  const $transaction = async (fn: (client: typeof tx) => Promise<unknown>) => {
    record("$transaction", null);
    if (opts.failTransaction) throw new Error("fake transaction failure");
    return fn(tx);
  };

  return {
    calls,
    readings,
    alerts,
    notifications,
    tx,
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
