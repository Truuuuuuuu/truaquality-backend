import type { z } from "zod";
import type { Device } from "../generated/prisma/client.ts";
import type { ingestSchema } from "../schemas/ingest.ts";
import { evaluatePondAlerts } from "./alerts.ts";
import { classifySamples, deriveDeviceEvents, deviceStateUpdate, type RejectedValue } from "./ingestRules.ts";
import { prisma } from "./prisma.ts";

// The constants and RejectedValue live in ingestRules.ts (the pure decision logic). Import them from
// there: re-exporting them here would mean anything wanting a constant had to pull in prisma.ts's live
// pool and alerts.ts -> notify.ts, which is the whole thing the extraction was for.
export type IngestResult =
  | { status: "unassigned" }
  | { status: "stored"; accepted: number; duplicates: number; rejected: RejectedValue[] };

// Stores an already-authenticated device message. No audit rows: devices report every minute, which would bury
// the admin actions AuditLog exists for. Every accept/reject decision is made by classifySamples (ingestRules.ts);
// this function is only the I/O around it.
export async function ingestSamples(
  device: Device,
  message: z.infer<typeof ingestSchema>,
  receivedAt = new Date(),
): Promise<IngestResult> {
  const { diag, sensors } = message;
  const { lastSeenAt, newestSampleAt, applySelfReport } = deviceStateUpdate(device, message.samples, receivedAt);
  // Recorded even for an unassigned device, so admins can see a freshly installed unit is online. lastSeenAt is
  // the newest signed sample time and never moves backwards (see deviceStateUpdate): a replayed old message must
  // not make a dead unit look alive. The self-report fields are written only when this message is not older than
  // the stored state, and then only the fields the message carries, so a pre-0.6.0 message updates exactly what it
  // always did and an older unit keeps its last self-report. diagnosticsAt is in signed time too, for the same reason.
  await prisma.device.update({
    where: { id: device.id },
    data: {
      lastSeenAt,
      ...(applySelfReport
        ? {
            ...(message.firmwareVersion ? { firmwareVersion: message.firmwareVersion } : {}),
            ...(message.wifiSsid ? { wifiSsid: message.wifiSsid } : {}),
            ...(diag
              ? {
                  rssi: diag.rssi,
                  uptimeS: diag.uptimeS,
                  resetReason: diag.resetReason,
                  freeHeap: diag.freeHeap,
                  queuedSamples: diag.queued,
                }
              : {}),
            ...(sensors ? { sensorStatus: sensors } : {}),
            ...(diag || sensors ? { diagnosticsAt: newestSampleAt } : {}),
          }
        : {}),
    },
  });

  // Events are derived against `device`, the row the subscriber loaded just before this message (the pre-update
  // state), and are device-level, so they are written before the unassigned return. A message older than the stored
  // state (a replay, or an out-of-order backlog batch) derives none: comparing stale diagnostics with newer ones
  // would invent reboots and sensor faults. They deliberately do NOT share a transaction with the device.update
  // above: a failed statement aborts a Postgres transaction, so an event-write failure would take the lastSeenAt
  // write down with it — and an event must never fail ingest.
  const drafts = applySelfReport ? deriveDeviceEvents(device, message) : [];
  if (drafts.length > 0) {
    await prisma.deviceEvent
      .createMany({ data: drafts.map((draft) => ({ deviceId: device.id, ...draft, createdAt: receivedAt })) })
      .catch((err) => console.error(`[device-events] write failed for device ${device.id}:`, err));
  }

  if (!device.pondId) {
    return { status: "unassigned" };
  }

  const { rows, rejected, storedParameters } = classifySamples(
    { id: device.id, pondId: device.pondId, assignedAt: device.assignedAt },
    message.samples,
    receivedAt,
  );

  const { count } = await prisma.reading.createMany({ data: rows, skipDuplicates: true });

  // The readings are already stored at this point, so an alerting failure is logged rather than reported as a
  // failed ingest (which would only make the unit's retry a duplicate). All-duplicate batches change nothing.
  if (count > 0) {
    await evaluatePondAlerts(device.pondId, storedParameters).catch((err) =>
      console.error(`[alerts] evaluation failed for pond ${device.pondId}:`, err),
    );
  }
  return { status: "stored", accepted: count, duplicates: rows.length - count, rejected };
}
