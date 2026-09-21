import type { z } from "zod";
import type { Device } from "../generated/prisma/client.ts";
import type { ingestSchema } from "../schemas/ingest.ts";
import { evaluatePondAlerts } from "./alerts.ts";
import { classifySamples, type RejectedValue } from "./ingestRules.ts";
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
  // Recorded even for an unassigned device, so admins can see a freshly installed unit is online.
  await prisma.device.update({
    where: { id: device.id },
    data: {
      lastSeenAt: receivedAt,
      ...(message.firmwareVersion ? { firmwareVersion: message.firmwareVersion } : {}),
      ...(message.wifiSsid ? { wifiSsid: message.wifiSsid } : {}),
    },
  });

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
