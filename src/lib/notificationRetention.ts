import { prisma } from "./prisma.ts";

const NOTIFICATION_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
// Distinct from the watchdog and reading rollup locks; transaction-scoped for the pooler.
const RETENTION_LOCK_KEY = 84_213_908n;

export async function runNotificationRetentionCycle() {
  return prisma.$transaction(async (tx) => {
    const [{ locked }] = await tx.$queryRaw<[{ locked: boolean }]>`
      SELECT pg_try_advisory_xact_lock(${RETENTION_LOCK_KEY}) AS locked
    `;
    if (!locked) return null;

    // Retention applies to every notification, including unread ones. Only the per-user
    // notification is removed: the underlying alert and device history remain intact.
    const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_MS);
    const result = await tx.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return { deleted: result.count };
  });
}

export function startNotificationRetention() {
  const runAndLog = () => {
    runNotificationRetentionCycle()
      .then((result) => {
        if (result && result.deleted > 0) {
          console.log(`[notification-retention] deleted ${result.deleted} expired notification(s)`);
        }
      })
      .catch((err) => console.error("[notification-retention] cycle failed:", err));
  };
  runAndLog();
  return setInterval(runAndLog, RETENTION_INTERVAL_MS);
}
