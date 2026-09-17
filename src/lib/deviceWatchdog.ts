import { notifyActiveUsers } from "./notify.ts";
import { prisma } from "./prisma.ts";

// Ingest never notices a device that stops transmitting — evaluatePondAlerts() only runs from ingest, so a
// dead unit raises no reading and therefore no alert. This job is the only thing that actively looks at
// Device.lastSeenAt and turns silence itself into a notification. Runs from startDeviceWatchdog(); can also
// be run once via `npm run watchdog:devices` for a manual pass or a cron-based deploy.

// Keep in sync with frontend/src/lib/parameters.ts STALE_AFTER_MS — that's what the dashboard already calls
// "Offline" for a pond's device, and this is what turns the same threshold into a real notification.
const DEVICE_OFFLINE_AFTER_MS = 5 * 60 * 1000;

// One fixed key identifying "the device watchdog job" for pg_try_advisory_xact_lock, so two backend
// instances never race the same offline/recovery transition for a device.
const WATCHDOG_LOCK_KEY = 84_213_907n;

// Devices report roughly once a minute, so a cycle this frequent still catches an outage close to
// DEVICE_OFFLINE_AFTER_MS instead of adding much extra delay on top of it.
const WATCHDOG_INTERVAL_MS = 60 * 1000;

// One offline/recovery pass. Only devices assigned to a pond are watched — an unassigned unit sitting in
// storage isn't monitoring anything, so nobody needs paged when it's quiet — and only ACTIVE ones, since a
// DISABLED device was taken offline on purpose. A device that has never reported (lastSeenAt null) is "not
// yet installed", not "offline", so it's left alone too. Returns null if another process already held the
// lock (nothing was done).
export async function runDeviceWatchdogCycle() {
  return prisma.$transaction(async (tx) => {
    const [{ locked }] = await tx.$queryRaw<[{ locked: boolean }]>`
      SELECT pg_try_advisory_xact_lock(${WATCHDOG_LOCK_KEY}) AS locked
    `;
    if (!locked) return null;

    const cutoff = new Date(Date.now() - DEVICE_OFFLINE_AFTER_MS);

    const wentOffline = await tx.device.findMany({
      where: { status: "ACTIVE", pondId: { not: null }, offlineSince: null, lastSeenAt: { lt: cutoff } },
      select: { id: true },
    });
    for (const device of wentOffline) {
      await tx.device.update({ where: { id: device.id }, data: { offlineSince: new Date() } });
      await notifyActiveUsers(tx, { deviceId: device.id, kind: "DEVICE_OFFLINE", severity: "CRITICAL" });
    }

    const cameBackOnline = await tx.device.findMany({
      where: { status: "ACTIVE", offlineSince: { not: null }, lastSeenAt: { gte: cutoff } },
      select: { id: true },
    });
    for (const device of cameBackOnline) {
      await tx.device.update({ where: { id: device.id }, data: { offlineSince: null } });
      await notifyActiveUsers(tx, { deviceId: device.id, kind: "DEVICE_ONLINE", severity: "CRITICAL" });
    }

    return { offline: wentOffline.length, online: cameBackOnline.length };
  });
}

export function startDeviceWatchdog() {
  const runAndLog = () => {
    runDeviceWatchdogCycle()
      .then((result) => {
        if (result && (result.offline > 0 || result.online > 0)) {
          console.log(`[watchdog] ${result.offline} device(s) went offline, ${result.online} recovered`);
        }
      })
      .catch((err) => console.error("[watchdog] cycle failed:", err));
  };
  runAndLog();
  return setInterval(runAndLog, WATCHDOG_INTERVAL_MS);
}
