import { Router } from "express";
import type { z } from "zod";
import { uptimePercent } from "../lib/deviceDiagnosticsRules.ts";
import { deviceSummarySelect } from "../lib/devices.ts";
import { DEVICE_OFFLINE_AFTER_MS } from "../lib/deviceWatchdog.ts";
import { PARAMETER_IDS } from "../lib/parameters.ts";
import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { validate } from "../middleware/validate.ts";
import { deviceIdParams } from "../schemas/devices.ts";

export const devicesRouter = Router();

devicesRouter.use(requireAuth);

devicesRouter.get("/", async (_req, res) => {
  const devices = await prisma.device.findMany({
    orderBy: { serial: "asc" },
    select: { ...deviceSummarySelect, pond: { select: { id: true, name: true } } },
  });
  res.json({ devices });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DIAGNOSTICS_EVENT_LIMIT = 50;

type LatestRow = { parameter: string; value: number; recordedAt: Date };
type CompletenessRow = { parameter: string; readings: number; maxGapS: number | null; firstAt: Date; lastAt: Date };

// sensorStatus is a Prisma Json column; only string values are real status tokens.
function reportedStatuses(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

// Maintenance view of one unit for the device detail page: its latest self-report, per-sensor health over the
// last 24 h, availability, and its event timeline. Any signed-in user may read it, like the rest of /devices.
devicesRouter.get("/:id/diagnostics", validate(deviceIdParams, "params"), async (req, res) => {
  const { id } = req.params as z.infer<typeof deviceIdParams>;

  const device = await prisma.device.findUnique({
    where: { id },
    select: {
      rssi: true,
      uptimeS: true,
      resetReason: true,
      freeHeap: true,
      queuedSamples: true,
      sensorStatus: true,
      diagnosticsAt: true,
      offlineSince: true,
      lastSeenAt: true,
      createdAt: true,
    },
  });
  if (!device) {
    res.status(404).json({ error: "device not found" });
    return;
  }

  const now = new Date();
  const since = new Date(now.getTime() - DAY_MS);
  const statuses = reportedStatuses(device.sensorStatus);
  // A sensor the unit reports before it is a known parameter (e.g. new firmware ahead of the backend) is still
  // listed, so a fault on it is never hidden from the page.
  const known = new Set<string>(PARAMETER_IDS);
  const parameters = [...PARAMETER_IDS, ...Object.keys(statuses).filter((key) => !known.has(key)).sort()];

  const windowStart = new Date(Math.max(since.getTime(), device.createdAt.getTime()));

  const [latestRows, completenessRows, windowEvents, eventBeforeWindow, events] = await Promise.all([
    // Latest value per parameter: a LATERAL ... LIMIT 1 per parameter walks the (deviceId, parameter,
    // recordedAt) unique index straight to the newest row, instead of DISTINCT ON reading all of them.
    prisma.$queryRaw<LatestRow[]>`
      SELECT k.parameter, r.value, r."recordedAt"
      FROM unnest(${parameters}::text[]) AS k(parameter)
      CROSS JOIN LATERAL (
        SELECT value, "recordedAt"
        FROM "Reading"
        WHERE "deviceId" = ${id}::uuid AND parameter = k.parameter
        ORDER BY "recordedAt" DESC
        LIMIT 1
      ) r
    `,
    // 24 h completeness in one pass: count, plus the widest gap between consecutive readings of a parameter.
    // Epoch seconds are cast to int so no Decimal/BigInt reaches res.json. Date params, not SQL now(), because
    // recordedAt is timestamp without time zone.
    prisma.$queryRaw<CompletenessRow[]>`
      SELECT parameter,
             count(*)::int AS readings,
             floor(EXTRACT(EPOCH FROM max(gap)))::int AS "maxGapS",
             min("recordedAt") AS "firstAt",
             max("recordedAt") AS "lastAt"
      FROM (
        SELECT parameter, "recordedAt",
               "recordedAt" - lag("recordedAt") OVER (PARTITION BY parameter ORDER BY "recordedAt") AS gap
        FROM "Reading"
        WHERE "deviceId" = ${id}::uuid AND "recordedAt" >= ${since}
      ) g
      GROUP BY parameter
    `,
    prisma.deviceEvent.findMany({
      where: {
        deviceId: id,
        kind: { in: ["OFFLINE", "ONLINE"] },
        createdAt: { gte: windowStart, lte: now },
      },
      orderBy: { createdAt: "asc" },
      select: { kind: true, createdAt: true },
    }),
    prisma.deviceEvent.findFirst({
      where: { deviceId: id, kind: { in: ["OFFLINE", "ONLINE"] }, createdAt: { lt: windowStart } },
      orderBy: { createdAt: "desc" },
      select: { kind: true },
    }),
    prisma.deviceEvent.findMany({
      where: { deviceId: id },
      orderBy: { createdAt: "desc" },
      take: DIAGNOSTICS_EVENT_LIMIT,
      select: { id: true, kind: true, parameter: true, detail: true, createdAt: true },
    }),
  ]);

  const latest = new Map(latestRows.map((row) => [row.parameter, row]));
  const completeness = new Map(completenessRows.map((row) => [row.parameter, row]));

  const sensors = parameters.map((parameter) => {
    const last = latest.get(parameter);
    const stats = completeness.get(parameter);
    let longestGapMin24h = 24 * 60;
    if (stats) {
      // The edges count as gaps too: silence from the window start to the first reading, and from the last
      // reading until now.
      const gapMs = Math.max(
        (stats.maxGapS ?? 0) * 1000,
        stats.firstAt.getTime() - since.getTime(),
        now.getTime() - stats.lastAt.getTime(),
      );
      longestGapMin24h = Math.max(0, Math.floor(gapMs / 60_000));
    }
    return {
      parameter,
      lastReadingAt: last?.recordedAt ?? null,
      lastValue: last?.value ?? null,
      readings24h: stats?.readings ?? 0,
      longestGapMin24h,
      reportedStatus: statuses[parameter] ?? null,
    };
  });

  let uptime24h: number | null = null;
  if (device.lastSeenAt) {
    // A unit can't have been online after it last reported plus the watchdog's grace period, whatever the
    // event history says. DeviceEvent only exists since 0.6.0 diagnostics landed, and the watchdog doesn't
    // run while the backend is down, so an outage that began before either would otherwise read as 100%
    // uptime for a unit that has been silent for days.
    const silentFrom = new Date(device.lastSeenAt.getTime() + DEVICE_OFFLINE_AFTER_MS);
    const silentNow = silentFrom < now;
    const stateAtStart =
      silentNow && silentFrom <= windowStart
        ? "offline"
        : eventBeforeWindow
          ? eventBeforeWindow.kind === "OFFLINE"
            ? "offline"
            : "online"
          : device.offlineSince && device.offlineSince <= windowStart
            ? "offline"
            : "online";
    const transitions = windowEvents.map((event) => ({
      kind: event.kind as "OFFLINE" | "ONLINE",
      at: event.createdAt,
    }));
    if (silentNow) transitions.push({ kind: "OFFLINE", at: silentFrom });
    uptime24h = uptimePercent({ windowStart, now, stateAtStart, transitions });
  }

  res.json({
    health: {
      rssi: device.rssi,
      uptimeS: device.uptimeS,
      resetReason: device.resetReason,
      freeHeap: device.freeHeap,
      queuedSamples: device.queuedSamples,
      diagnosticsAt: device.diagnosticsAt,
      offlineSince: device.offlineSince,
    },
    sensors,
    uptime24h,
    events,
  });
});
