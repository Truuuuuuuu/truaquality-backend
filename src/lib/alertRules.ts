import type { AlertSeverity } from "../generated/prisma/client.ts";
import { ALERT_HOLD_MAX_GAP_MS, ALERT_HOLD_READINGS, severityFor, type ParameterId } from "./parameters.ts";

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

export type HeldReading = { value: number; recordedAt: Date };

// The severity a parameter counts as having once the hold rule (ALERT_HOLD_READINGS) is applied. `recent` must be
// newest first. With hold 1 (temperature) this is exactly severityFor(latest). With hold N it is null unless the N
// newest readings are all out of range and no two neighbours are more than ALERT_HOLD_MAX_GAP_MS apart (a fault or
// an outage leaves a time gap, not a row), and then it is the LEAST severe of the N: four CRITICAL readings make
// CRITICAL, but C, C, C, W is still WARNING. See decideAlertStep for why CRITICAL is held too.
export function heldSeverityFor(
  parameter: ParameterId,
  pondType: string | null | undefined,
  recent: readonly HeldReading[],
): AlertSeverity | null {
  const hold = ALERT_HOLD_READINGS[parameter];
  if (recent.length === 0) return null;
  if (hold <= 1) return severityFor(parameter, recent[0].value, pondType);
  if (recent.length < hold) return null;

  let held: AlertSeverity | null = null;
  for (let i = 0; i < hold; i++) {
    const severity = severityFor(parameter, recent[i].value, pondType);
    if (!severity) return null;
    if (i > 0 && recent[i - 1].recordedAt.getTime() - recent[i].recordedAt.getTime() > ALERT_HOLD_MAX_GAP_MS) {
      return null;
    }
    if (!held || SEVERITY_RANK[severity] < SEVERITY_RANK[held]) held = severity;
  }
  return held;
}

// heldSeverityFor for several parameters at once — what GET /ponds serves so the dashboard colors a reading by the
// same held rule that raises the alert. Each list is sorted newest first here (callers may pass any order); a
// parameter with no readings is left out rather than reported as in range.
export function heldSeveritiesFor(
  pondType: string | null | undefined,
  recentByParameter: Partial<Record<ParameterId, readonly HeldReading[]>>,
): Partial<Record<ParameterId, AlertSeverity | null>> {
  const result: Partial<Record<ParameterId, AlertSeverity | null>> = {};
  for (const [parameter, recent] of Object.entries(recentByParameter) as Array<[ParameterId, readonly HeldReading[]]>) {
    if (!recent || recent.length === 0) continue;
    const newestFirst = [...recent].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
    result[parameter] = heldSeverityFor(parameter, pondType, newestFirst);
  }
  return result;
}

// One decision step. Whether a worsened-but-not-escalated reading actually notifies depends on the episode's
// last notification, which only the caller can look up — so "abnormal" reports worsened/escalated and the
// caller fetches that row only when it matters, then asks renotifyDue.
//
// `earlier` is the parameter's stored readings older than `latest`, newest first (the shell fetches
// ALERT_HOLD_READINGS of them, and none for a hold-1 parameter). The hold decides entering and worsening only:
// - The held severity is the window's least severe, so CRITICAL needs N consecutive CRITICAL readings too. The
//   hold exists because single turbidity spikes reach far above the line (135.8 NTU in clean water in the §5f soak,
//   the 3000 NTU ceiling with a floating sensor pin); if BFAR later sets a critical line below such values, an
//   unheld CRITICAL would bring the false alarm back at the more serious level. Turbidity changes over minutes to
//   hours, so about 2 minutes before CRITICAL is acceptable; temperature has hold 1 and stays immediate.
// - Inside an open episode, an out-of-range reading that is not yet held is not a recovery reading either: it
//   comes back as "abnormal" at the episode's own severity, neither escalated nor worsened, so the shell restarts
//   the recovery clock (nominalSince = null) and notifies nobody. Recovery is still ALERT_RECOVERY_MS of in-range
//   readings, never shortened by the hold.
export function decideAlertStep(
  parameter: ParameterId,
  pondType: string | null | undefined,
  open: OpenEpisode | null,
  latest: { value: number; recordedAt: Date },
  earlier: readonly HeldReading[] = [],
): AlertStep {
  const { value, recordedAt } = latest;
  const raw = severityFor(parameter, value, pondType);
  const severity = heldSeverityFor(parameter, pondType, [latest, ...earlier]);

  if (!open) return severity ? { kind: "open", severity } : { kind: "none" };

  // Already evaluated (a duplicate delivery, or a batch that only added older samples).
  if (recordedAt <= open.lastRecordedAt) return { kind: "stale" };

  if (severity) {
    // Alert.severity is the episode's worst, so it answers "has it ever been this bad?", not "was the last
    // reading this bad?". Re-scoring lastValue gives the previous reading's severity, which is what says
    // whether this one is a step down: nominal -> warning, nominal -> critical, warning -> critical. For a held
    // parameter the previous severity is the held one over the readings before this one; a hold-1 parameter
    // keeps re-scoring lastValue, so temperature decisions are unchanged.
    const previous =
      ALERT_HOLD_READINGS[parameter] <= 1
        ? severityFor(parameter, open.lastValue, pondType)
        : heldSeverityFor(parameter, pondType, earlier);
    const worsened = SEVERITY_RANK[severity] > (previous ? SEVERITY_RANK[previous] : 0);
    const escalated = SEVERITY_RANK[severity] > SEVERITY_RANK[open.severity];
    return { kind: "abnormal", severity, escalated, worsened };
  }

  if (raw) return { kind: "abnormal", severity: open.severity, escalated: false, worsened: false };

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
