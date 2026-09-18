import type { Prisma } from "../generated/prisma/client.ts";
// From ingestRules.ts, not ingest.ts: the constant is all this module needs, and ingest.ts drags in
// prisma.ts (a live PrismaPg pool) and alerts.ts -> notify.ts with it.
import { MAX_SAMPLE_AGE_MS } from "./ingestRules.ts";
import { prisma } from "./prisma.ts";

// Keeps raw per-minute Reading rows small enough for Supabase's free-tier storage while ReadingHourly
// summaries (min/max/avg/count) are kept forever. Runs hourly from startReadingRollup(); can also be run
// once via `npm run rollup:readings` for a manual pass or a cron-based deploy.

// Below this, a device could still be mid-upload of a buffered backlog (MAX_SAMPLE_AGE_MS), so its hours
// wouldn't be "final" yet, and raw rows a report might still want to page through would already be gone.
const MIN_RAW_RETENTION_DAYS = Math.ceil(MAX_SAMPLE_AGE_MS / (24 * 60 * 60 * 1000)) + 1;

export function rawRetentionDays() {
  const configured = Number(process.env.RAW_RETENTION_DAYS ?? 30);
  return Number.isFinite(configured) ? Math.max(MIN_RAW_RETENTION_DAYS, configured) : 30;
}

// One fixed key identifying "the reading rollup job" for pg_try_advisory_xact_lock, so two backend
// instances (or an overlapping manual + scheduled run) never roll up the same hours at once.
const ROLLUP_LOCK_KEY = 72635201n;

const DELETE_BATCH_SIZE = 10_000;

// Aggregates every Reading row from the last MAX_SAMPLE_AGE_MS down to (but not including) the current,
// still-open hour into ReadingHourly. Idempotent: re-running it recomputes and upserts the same recent
// hours, so a late-arriving buffered sample just widens that hour's min/max next time this runs.
async function rollupRecentHours(tx: Prisma.TransactionClient) {
  const since = new Date(Date.now() - MAX_SAMPLE_AGE_MS);
  const result = await tx.$executeRaw`
    INSERT INTO "ReadingHourly" ("pondId", "parameter", "bucketStart", "min", "max", "sum", "count")
    SELECT "pondId", "parameter", date_trunc('hour', "recordedAt"), min("value"), max("value"), sum("value"), count(*)
    FROM "Reading"
    WHERE "recordedAt" >= ${since} AND "recordedAt" < date_trunc('hour', now())
    GROUP BY "pondId", "parameter", date_trunc('hour', "recordedAt")
    ON CONFLICT ("pondId", "parameter", "bucketStart")
    DO UPDATE SET "min" = EXCLUDED."min", "max" = EXCLUDED."max", "sum" = EXCLUDED."sum", "count" = EXCLUDED."count"
  `;
  return result;
}

// Deletes raw Reading rows older than the retention window, in batches so no single statement holds a
// long-running transaction. Safe to call any time rollupRecentHours() has already run in this cycle: the
// cutoff is always well past MAX_SAMPLE_AGE_MS, so every row being deleted is already summarized.
//
// Re-checks the same advisory lock rollupRecentHours() took, because that one is released the moment its
// transaction commits — it does not stay held across this function, which runs afterward as its own
// series of statements (deliberately not one long transaction; see the batching loop below). Without
// this, two overlapping cycles (the hourly in-process timer racing a manual `npm run rollup:readings`)
// could both reach this loop at once. This only narrows the race to the gap between the two lock checks,
// rather than eliminating it outright: a session-scoped lock held across the whole loop isn't reliable
// under this project's pgbouncer transaction-mode pooler (the same reason rollupRecentHours uses a
// transaction-scoped lock instead of a plain session one). A residual double-run just means duplicate,
// idempotent deletes, not incorrect data.
async function pruneRawReadings() {
  const [{ locked }] = await prisma.$transaction(
    (tx) => tx.$queryRaw<[{ locked: boolean }]>`SELECT pg_try_advisory_xact_lock(${ROLLUP_LOCK_KEY}) AS locked`,
  );
  if (!locked) return 0;

  const cutoff = new Date(Date.now() - rawRetentionDays() * 24 * 60 * 60 * 1000);
  let totalDeleted = 0;
  for (;;) {
    const deleted = await prisma.$executeRaw`
      DELETE FROM "Reading" WHERE "id" IN (
        SELECT "id" FROM "Reading" WHERE "recordedAt" < ${cutoff} LIMIT ${DELETE_BATCH_SIZE}
      )
    `;
    totalDeleted += deleted;
    if (deleted < DELETE_BATCH_SIZE) break;
  }
  return totalDeleted;
}

// One rollup + prune cycle. Returns null if another process already held the lock (nothing was done).
export async function runReadingRollupCycle() {
  const ran = await prisma.$transaction(async (tx) => {
    const [{ locked }] = await tx.$queryRaw<[{ locked: boolean }]>`
      SELECT pg_try_advisory_xact_lock(${ROLLUP_LOCK_KEY}) AS locked
    `;
    if (!locked) return false;
    await rollupRecentHours(tx);
    return true;
  });
  if (!ran) return null;

  const deleted = await pruneRawReadings();
  return { deletedRawReadings: deleted };
}

const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;

export function startReadingRollup() {
  const runAndLog = () => {
    runReadingRollupCycle()
      .then((result) => {
        if (result) console.log(`[rollup] summarized recent hours, pruned ${result.deletedRawReadings} raw readings`);
      })
      .catch((err) => console.error("[rollup] cycle failed:", err));
  };
  runAndLog();
  return setInterval(runAndLog, ROLLUP_INTERVAL_MS);
}
