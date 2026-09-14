import type { z } from "zod";
import type { Device, Prisma } from "../generated/prisma/client.ts";
import type { ingestSchema } from "../schemas/ingest.ts";
import { PARAMETER_BOUNDS, isParameterId } from "./parameters.ts";
import { prisma } from "./prisma.ts";

// A unit buffers at most a couple of hours offline; anything much older is a broken clock or a replay.
// Exported so the rollup job (readingRollup.ts) knows how far back a "final" hour has to be.
export const MAX_SAMPLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type RejectedValue = { recordedAt: Date; parameter: string; value: number; reason: string };

export type IngestResult =
  | { status: "unassigned" }
  | { status: "stored"; accepted: number; duplicates: number; rejected: RejectedValue[] };

// Stores an already-authenticated device message. No audit rows: devices report every minute, which would bury
// the admin actions AuditLog exists for.
export async function ingestSamples(
  device: Device,
  message: z.infer<typeof ingestSchema>,
  receivedAt = new Date(),
): Promise<IngestResult> {
  // Recorded even for an unassigned device, so admins can see a freshly installed unit is online.
  await prisma.device.update({
    where: { id: device.id },
    data: { lastSeenAt: receivedAt, ...(message.firmwareVersion ? { firmwareVersion: message.firmwareVersion } : {}) },
  });

  if (!device.pondId) {
    return { status: "unassigned" };
  }

  const rows: Prisma.ReadingCreateManyInput[] = [];
  const rejected: RejectedValue[] = [];
  for (const sample of message.samples) {
    const recordedAt = sample.recordedAt ?? receivedAt;
    // A null value means "this sensor had nothing to report" — the same thing an omitted key means. It's
    // silently dropped, not treated as a rejected/invalid reading.
    const values = Object.entries(sample.values).filter(
      (entry): entry is [string, number] => entry[1] !== null,
    );

    let sampleProblem: string | null = null;
    if (device.assignedAt && recordedAt < device.assignedAt) {
      sampleProblem = "recorded before the device was assigned to this pond";
    } else if (receivedAt.getTime() - recordedAt.getTime() > MAX_SAMPLE_AGE_MS) {
      sampleProblem = "older than 7 days";
    }
    if (sampleProblem) {
      for (const [parameter, value] of values) rejected.push({ recordedAt, parameter, value, reason: sampleProblem });
      continue;
    }

    for (const [parameter, value] of values) {
      if (!isParameterId(parameter)) {
        rejected.push({ recordedAt, parameter, value, reason: "unknown parameter" });
        continue;
      }
      const { min, max } = PARAMETER_BOUNDS[parameter];
      if (value < min || value > max) {
        rejected.push({ recordedAt, parameter, value, reason: `outside ${min}..${max}` });
        continue;
      }
      rows.push({ pondId: device.pondId, deviceId: device.id, parameter, value, recordedAt, receivedAt });
    }
  }

  const { count } = await prisma.reading.createMany({ data: rows, skipDuplicates: true });
  return { status: "stored", accepted: count, duplicates: rows.length - count, rejected };
}
