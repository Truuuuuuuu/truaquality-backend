import type { AlertSeverity, NotificationKind, Prisma } from "../generated/prisma/client.ts";
import { severityFor, type ParameterId } from "./parameters.ts";
import { prisma } from "./prisma.ts";

// How long a parameter has to stay back in range before its alert resolves. Without it, a value hovering on a
// threshold would open and resolve an alert — and notify everyone — every other minute.
export const ALERT_RECOVERY_MS = 10 * 60 * 1000;

const SEVERITY_RANK: Record<AlertSeverity, number> = { WARNING: 1, CRITICAL: 2 };

type AlertEvent = {
  alertId: string;
  kind: NotificationKind;
  severity: AlertSeverity;
  value: number;
  recordedAt: Date;
};

// Fans an event out to every active user. Single org and a handful of staff, so a row per recipient is cheap and
// gives each of them their own read state. Invited users who haven't signed in yet start with a clean inbox.
async function notifyActiveUsers(tx: Prisma.TransactionClient, event: AlertEvent) {
  const recipients = await tx.profile.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  if (recipients.length === 0) return;
  await tx.notification.createMany({ data: recipients.map(({ id }) => ({ profileId: id, ...event })) });
}

// Re-evaluates one pond parameter's alert against its newest stored reading — not the incoming batch, so a
// buffered backlog of older samples can never open or resolve an alert out of order.
async function evaluateParameter(pondId: string, parameter: ParameterId) {
  await prisma.$transaction(async (tx) => {
    // MQTT messages are handled concurrently; two of them must not both see "no open alert" and open one each.
    // Transaction-scoped for the same pgbouncer reason as the rollup job's lock (readingRollup.ts).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`alert:${pondId}:${parameter}`}))`;

    const latest = await tx.reading.findFirst({
      where: { pondId, parameter },
      orderBy: { recordedAt: "desc" },
      select: { value: true, recordedAt: true },
    });
    if (!latest) return;
    const { value, recordedAt } = latest;
    const severity = severityFor(parameter, value);

    const open = await tx.alert.findFirst({ where: { pondId, parameter, resolvedAt: null } });

    if (!open) {
      if (!severity) return;
      const alert = await tx.alert.create({
        data: { pondId, parameter, severity, openedAt: recordedAt, lastValue: value, lastRecordedAt: recordedAt },
      });
      await notifyActiveUsers(tx, { alertId: alert.id, kind: "ALERT_OPENED", severity, value, recordedAt });
      return;
    }

    // Already evaluated (a duplicate delivery, or a batch that only added older samples).
    if (recordedAt <= open.lastRecordedAt) return;

    if (severity) {
      const escalated = SEVERITY_RANK[severity] > SEVERITY_RANK[open.severity];
      await tx.alert.update({
        where: { id: open.id },
        data: { lastValue: value, lastRecordedAt: recordedAt, nominalSince: null, ...(escalated ? { severity } : {}) },
      });
      if (escalated) {
        await notifyActiveUsers(tx, { alertId: open.id, kind: "ALERT_ESCALATED", severity, value, recordedAt });
      }
      return;
    }

    const nominalSince = open.nominalSince ?? recordedAt;
    const recovered = recordedAt.getTime() - nominalSince.getTime() >= ALERT_RECOVERY_MS;
    await tx.alert.update({
      where: { id: open.id },
      data: { lastValue: value, lastRecordedAt: recordedAt, nominalSince, ...(recovered ? { resolvedAt: recordedAt } : {}) },
    });
    if (recovered) {
      await notifyActiveUsers(tx, {
        alertId: open.id,
        kind: "ALERT_RESOLVED",
        severity: open.severity,
        value,
        recordedAt,
      });
    }
  });
}

// Opens, escalates, or resolves alerts for the parameters a pond just stored readings for. One transaction per
// parameter, so a failure on one doesn't hold back the others.
export async function evaluatePondAlerts(pondId: string, parameters: Iterable<ParameterId>) {
  for (const parameter of parameters) {
    await evaluateParameter(pondId, parameter);
  }
}
