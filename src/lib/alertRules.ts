import type { AlertSeverity } from "../generated/prisma/client.ts";
import { severityFor, type ParameterId } from "./parameters.ts";

// The pure half of alert evaluation: given the open episode (if any) and the pond parameter's newest stored
// reading, decide what happens. No database, no notifications — the caller (lib/alerts.ts) owns the
// transaction, the advisory lock, the writes and the fan-out.

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

export type OpenEpisode = {
  severity: AlertSeverity;
  lastValue: number;
  lastRecordedAt: Date;
  nominalSince: Date | null;
};

export type AlertStep =
  | { kind: "none" }
  | { kind: "stale" }
  | { kind: "open"; severity: AlertSeverity }
  | { kind: "abnormal"; severity: AlertSeverity; escalated: boolean; worsened: boolean }
  | { kind: "nominal"; nominalSince: Date; resolved: boolean };

// One decision step. Whether a worsened-but-not-escalated reading actually notifies depends on the episode's
// last notification, which only the caller can look up — so "abnormal" reports worsened/escalated and the
// caller fetches that row only when it matters, then asks renotifyDue.
export function decideAlertStep(
  parameter: ParameterId,
  pondType: string | null | undefined,
  open: OpenEpisode | null,
  latest: { value: number; recordedAt: Date },
): AlertStep {
  const { value, recordedAt } = latest;
  const severity = severityFor(parameter, value, pondType);

  if (!open) return severity ? { kind: "open", severity } : { kind: "none" };

  // Already evaluated (a duplicate delivery, or a batch that only added older samples).
  if (recordedAt <= open.lastRecordedAt) return { kind: "stale" };

  if (severity) {
    // Alert.severity is the episode's worst, so it answers "has it ever been this bad?", not "was the last
    // reading this bad?". Re-scoring lastValue gives the previous reading's severity, which is what says
    // whether this one is a step down: nominal -> warning, nominal -> critical, warning -> critical.
    const previous = severityFor(parameter, open.lastValue, pondType);
    const worsened = SEVERITY_RANK[severity] > (previous ? SEVERITY_RANK[previous] : 0);
    const escalated = SEVERITY_RANK[severity] > SEVERITY_RANK[open.severity];
    return { kind: "abnormal", severity, escalated, worsened };
  }

  const nominalSince = open.nominalSince ?? recordedAt;
  const resolved = recordedAt.getTime() - nominalSince.getTime() >= ALERT_RECOVERY_MS;
  return { kind: "nominal", nominalSince, resolved };
}

// An episode used to notify only on its first abnormal reading and its first escalation, so a parameter that
// recovered and went bad again was never reported — and that is the common case, since the episode stays open
// through ALERT_RECOVERY_MS of in-range readings and a value crossing back is still news. A repeat is
// throttled by ALERT_RENOTIFY_MS since the episode's last notification.
export function renotifyDue(lastNotifiedAt: Date | null, recordedAt: Date): boolean {
  return !lastNotifiedAt || recordedAt.getTime() - lastNotifiedAt.getTime() >= ALERT_RENOTIFY_MS;
}

// ALERT_ESCALATED is reserved for the episode's one step past its worst severity so far; a repeat of a severity
// it has already reached reads as a fresh "too low/high", the wording it opened with.
export function notificationKindFor(escalated: boolean): "ALERT_ESCALATED" | "ALERT_OPENED" {
  return escalated ? "ALERT_ESCALATED" : "ALERT_OPENED";
}
