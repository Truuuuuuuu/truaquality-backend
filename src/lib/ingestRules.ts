import type { z } from "zod";
import type { ingestSchema } from "../schemas/ingest.ts";
import { PARAMETER_BOUNDS, isParameterId, type ParameterId } from "./parameters.ts";

// A unit buffers at most a couple of hours offline; anything much older is a broken clock or a replay.
// Exported so the rollup job (readingRollup.ts) knows how far back a "final" hour has to be.
export const MAX_SAMPLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Units stamp samples from their own NTP-synced clock, so a little skew against ours is normal and a
// lot of it is a broken clock. A future timestamp is far more damaging than an old one: it becomes
// the pond's permanent "latest" reading, makes the dashboard's staleness check (now - recordedAt)
// negative so the value never looks old, and parks Alert.lastRecordedAt in the future — after which
// alert evaluation skips every real reading as "not newer" and that parameter's alerting never fires again.
export const MAX_SAMPLE_SKEW_MS = 5 * 60 * 1000;

export type RejectedValue = { recordedAt: Date; parameter: string; value: number; reason: string };

export type ReadingRow = {
  pondId: string;
  deviceId: string;
  parameter: ParameterId;
  value: number;
  recordedAt: Date;
  receivedAt: Date;
};

// Every ingest decision (null drop, assignedAt/age/skew checks, unknown parameter, physical bounds) lives here,
// pure — no Prisma, no env — so it can be tested without a database. ingestSamples (ingest.ts) is the I/O shell
// around it. Duplicate detection deliberately stays in the DB (@@unique([deviceId, parameter, recordedAt]) +
// createMany skipDuplicates), so two identical samples in one batch both come back as rows.
export function classifySamples(
  device: { id: string; pondId: string; assignedAt: Date | null },
  samples: z.infer<typeof ingestSchema>["samples"],
  receivedAt: Date,
): { rows: ReadingRow[]; rejected: RejectedValue[]; storedParameters: Set<ParameterId> } {
  const rows: ReadingRow[] = [];
  const rejected: RejectedValue[] = [];
  const storedParameters = new Set<ParameterId>();
  for (const sample of samples) {
    const { recordedAt } = sample;
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
    } else if (recordedAt.getTime() - receivedAt.getTime() > MAX_SAMPLE_SKEW_MS) {
      sampleProblem = "recorded in the future (check the device clock)";
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
      storedParameters.add(parameter);
    }
  }
  return { rows, rejected, storedParameters };
}

// How one message may change the device row's liveness and self-report fields. Liveness comes from the newest
// SIGNED sample time, never from when we happened to receive the message: anyone holding the shared HiveMQ
// credential can re-publish (replay) an old captured message, and its signature still verifies. Driving lastSeenAt
// from receive time let such a replay keep a dead unit looking online so the watchdog never flagged it.
// - lastSeenAt only moves forward (max of stored and newest), so a replay or an old backlog batch cannot regress it.
// - The newest time is clamped to receivedAt: the schema tolerates a few minutes of device clock skew, and a
//   future lastSeenAt would keep the unit "online" for that long after it actually died.
// - The self-report (firmware, SSID, diag, sensor status) and the device events derived from it describe the unit
//   at the newest sample, so they are applied only when that sample is not older than what is already stored —
//   otherwise a replay would roll the diagnostics back and log bogus REBOOT/SENSOR events.
export function deviceStateUpdate(
  previous: { lastSeenAt: Date | null },
  samples: z.infer<typeof ingestSchema>["samples"],
  receivedAt: Date,
): { lastSeenAt: Date; newestSampleAt: Date; applySelfReport: boolean } {
  let newest = -Infinity;
  for (const sample of samples) newest = Math.max(newest, sample.recordedAt.getTime());
  const newestSampleAt = new Date(Math.min(newest, receivedAt.getTime()));
  const stored = previous.lastSeenAt;
  if (stored !== null && newestSampleAt.getTime() < stored.getTime()) {
    return { lastSeenAt: stored, newestSampleAt, applySelfReport: false };
  }
  return { lastSeenAt: newestSampleAt, newestSampleAt, applySelfReport: true };
}

// String union rather than the generated DeviceEventKind enum, so this module stays Prisma-free. OFFLINE/ONLINE
// are not here: only the watchdog can see a unit that stopped talking.
export type DeviceEventDraft = {
  kind: "REBOOT" | "SENSOR_FAULT" | "SENSOR_RECOVERED" | "FIRMWARE_CHANGED";
  parameter: string | null;
  detail: string | null;
};

// sensorStatus is a Prisma Json column, so anything could be in it; only string values count.
function readSensorStatus(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const statuses: Record<string, string> = {};
  for (const [key, status] of Object.entries(value as Record<string, unknown>)) {
    if (typeof status === "string") statuses[key] = status;
  }
  return statuses;
}

// Compares one message against the device row as it was BEFORE this message was applied. A first-ever report
// (null previous value) is a baseline, not a change — except a sensor that is already faulted on its first
// report, which is exactly what someone installing the unit needs to see in the timeline.
// Order: FIRMWARE_CHANGED, REBOOT, then sensor events in the message's `sensors` key order.
export function deriveDeviceEvents(
  previous: { firmwareVersion: string | null; uptimeS: number | null; sensorStatus: unknown },
  message: z.infer<typeof ingestSchema>,
): DeviceEventDraft[] {
  const events: DeviceEventDraft[] = [];

  if (message.firmwareVersion && previous.firmwareVersion && message.firmwareVersion !== previous.firmwareVersion) {
    events.push({
      kind: "FIRMWARE_CHANGED",
      parameter: null,
      detail: `${previous.firmwareVersion} → ${message.firmwareVersion}`,
    });
  }

  // Uptime going backwards means the unit restarted since its last report.
  if (message.diag && previous.uptimeS !== null && message.diag.uptimeS < previous.uptimeS) {
    events.push({ kind: "REBOOT", parameter: null, detail: message.diag.resetReason });
  }

  if (message.sensors) {
    const before = readSensorStatus(previous.sensorStatus);
    for (const [parameter, status] of Object.entries(message.sensors)) {
      const prior = before[parameter];
      if (status === prior) continue;
      if (status === "ok") {
        // Unknown -> ok is the baseline case; only a real fault clearing is a recovery.
        if (prior !== undefined) events.push({ kind: "SENSOR_RECOVERED", parameter, detail: status });
      } else {
        events.push({ kind: "SENSOR_FAULT", parameter, detail: status });
      }
    }
  }

  return events;
}
