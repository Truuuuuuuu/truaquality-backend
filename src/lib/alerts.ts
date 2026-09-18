import type { AlertSeverity } from "../generated/prisma/client.ts";
import { notifyActiveUsers } from "./notify.ts";
import { severityFor, type ParameterId } from "./parameters.ts";
import { prisma } from "./prisma.ts";

// How long a parameter has to stay back in range before its alert resolves. Without it, a value hovering on a
// threshold would open and resolve an alert — and notify everyone — every other minute.
export const ALERT_RECOVERY_MS = 10 * 60 * 1000;

// How long after an episode's last notification it may notify again when the parameter gets worse a second
// time — e.g. it dips back into the critical range after a short recovery that wasn't long enough to resolve
// the alert. A value sitting on a threshold crosses it every few minutes, so re-notifying needs a floor;
// without one the flapping ALERT_RECOVERY_MS exists to absorb would come back as a toast every other minute.
// The episode's first escalation ignores this: it happens at most once, and it's the one thing nobody should
// hear about half an hour late.
export const ALERT_RENOTIFY_MS = 30 * 60 * 1000;

const SEVERITY_RANK: Record<AlertSeverity, number> = { WARNING: 1, CRITICAL: 2 };

// Re-evaluates one pond parameter's alert against its newest stored reading — not the incoming batch, so a
// buffered backlog of older samples can never open or resolve an alert out of order. `pondType` decides which
// threshold set applies.
async function evaluateParameter(pondId: string, parameter: ParameterId, pondType: string | null) {
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
    const severity = severityFor(parameter, value, pondType);

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
      // Alert.severity is the episode's worst, so it answers "has it ever been this bad?", not "was the last
      // reading this bad?". Re-scoring lastValue gives the previous reading's severity, which is what says
      // whether this one is a step down: nominal -> warning, nominal -> critical, warning -> critical.
      const previous = severityFor(parameter, open.lastValue, pondType);
      const worsened = SEVERITY_RANK[severity] > (previous ? SEVERITY_RANK[previous] : 0);
      const escalated = SEVERITY_RANK[severity] > SEVERITY_RANK[open.severity];

      // An episode used to notify only on its first abnormal reading and its first escalation, so a parameter
      // that recovered and went bad again was never reported — and that is the common case, since the episode
      // stays open through ALERT_RECOVERY_MS of in-range readings and a value crossing back is still news.
      let notify = escalated;
      if (worsened && !escalated) {
        const last = await tx.notification.findFirst({
          where: { alertId: open.id },
          orderBy: { recordedAt: "desc" },
          select: { recordedAt: true },
        });
        // recordedAt is only nullable for DEVICE_* notifications; every ALERT_* row this scope's `alertId`
        // filter can match set it.
        notify = !last || recordedAt.getTime() - last.recordedAt!.getTime() >= ALERT_RENOTIFY_MS;
      }

      await tx.alert.update({
        where: { id: open.id },
        data: { lastValue: value, lastRecordedAt: recordedAt, nominalSince: null, ...(escalated ? { severity } : {}) },
      });
      if (notify) {
        await notifyActiveUsers(tx, {
          // ALERT_ESCALATED is reserved for the episode's one step past its worst severity so far; a repeat of
          // a severity it has already reached reads as a fresh "too low/high", the wording it opened with.
          kind: escalated ? "ALERT_ESCALATED" : "ALERT_OPENED",
          alertId: open.id,
          severity,
          value,
          recordedAt,
        });
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
  // Read once here rather than inside each per-parameter transaction: the pond's type is the same for all of
  // them, and this runs on every ingested batch.
  const pond = await prisma.pond.findUnique({ where: { id: pondId }, select: { pondType: true } });
  for (const parameter of parameters) {
    await evaluateParameter(pondId, parameter, pond?.pondType ?? null);
  }
}
