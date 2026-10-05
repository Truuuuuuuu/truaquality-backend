import { decideAlertStep, notificationKindFor, renotifyDue, sideChangeIsNews } from "./alertRules.ts";
import { notifyActiveUsers } from "./notify.ts";
import { ALERT_HOLD_READINGS, type ParameterId } from "./parameters.ts";
import { prisma } from "./prisma.ts";

// The decision rules (open / escalate / renotify / resolve and their timing) live in alertRules.ts; this file
// is the transaction, lock, write and notify shell around them. Import the constants from there, not through
// here — this module pulls in prisma.ts's live pool and notify.ts.

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

    // The hold rule (ALERT_HOLD_READINGS, decided in alertRules.ts) needs the readings just before the latest:
    // N - 1 for the held window plus one more for the previous held severity, so N rows. A LIMIT walk of the
    // (pondId, parameter, recordedAt) index, never DISTINCT ON. Only a held parameter pays for the query, so
    // temperature (hold 1) issues exactly the statements it did before.
    const hold = ALERT_HOLD_READINGS[parameter];
    const earlier =
      hold > 1
        ? await tx.reading.findMany({
            where: { pondId, parameter, recordedAt: { lt: recordedAt } },
            orderBy: { recordedAt: "desc" },
            take: hold,
            select: { value: true, recordedAt: true },
          })
        : [];

    const open = await tx.alert.findFirst({ where: { pondId, parameter, resolvedAt: null } });

    const step = decideAlertStep(parameter, pondType, open, latest, earlier);

    switch (step.kind) {
      case "none":
      case "stale":
        return;

      case "open": {
        const { severity } = step;
        const alert = await tx.alert.create({
          data: { pondId, parameter, severity, openedAt: recordedAt, lastValue: value, lastRecordedAt: recordedAt },
        });
        await notifyActiveUsers(tx, { alertId: alert.id, kind: "ALERT_OPENED", severity, value, recordedAt });
        return;
      }

      case "abnormal": {
        // decideAlertStep only returns "abnormal" for an open episode, but nothing in AlertStep carries
        // that. Checking it here narrows `open` for the compiler instead of asserting past it with `!`,
        // and a future path that broke the invariant (say "open at CRITICAL immediately") would say so
        // rather than throwing "Cannot read properties of null" from inside the transaction.
        if (!open) throw new Error(`[alerts] "abnormal" step for ${pondId}/${parameter} without an open episode`);
        const episode = open;
        // An escalation always notifies. A worsened reading that isn't one is throttled against the episode's
        // last notification — looked up only here, so every other path skips the query. A two-sided parameter's
        // run that entered one side (sideEntered, pH only) is checked against the side of that same notification
        // and, if it changed, notifies unthrottled (alertRules.ts, "Two-sided parameters").
        let notify = step.escalated;
        const sideEntered = step.sideEntered;
        if (!step.escalated && (step.worsened || sideEntered)) {
          // Notification.recordedAt is DateTime? (it is null for DEVICE_* rows) and no constraint ties
          // "has an alertId" to "has a recordedAt", so the filter says so instead of a `!` asserting it.
          // It also removes a trap: Postgres orders DESC NULLS FIRST, so a null-recordedAt row for this
          // episode would have been the row this query returned.
          //
          // Deliberate, documented divergence from the pre-phase baseline, which did
          // `last.recordedAt!.getTime()` and threw a TypeError on such a row. That throw aborted the whole
          // transaction, so the episode's lastValue/lastRecordedAt/nominalSince were never written either
          // and ingest.ts swallowed it into a console.error — strictly worse than notifying. Unreachable
          // today; this makes the choice explicit rather than accidental.
          //
          // `value` is selected only when a side was entered, so every other lookup is the statement it was.
          const last: { recordedAt: Date | null; value?: number | null } | null = await tx.notification.findFirst({
            where: { alertId: episode.id, recordedAt: { not: null } },
            orderBy: { recordedAt: "desc" },
            select: sideEntered ? { recordedAt: true, value: true } : { recordedAt: true },
          });
          notify =
            (sideEntered !== undefined && sideChangeIsNews(parameter, pondType, last?.value, sideEntered)) ||
            (step.worsened && renotifyDue(last?.recordedAt ?? null, recordedAt));
        }

        await tx.alert.update({
          where: { id: episode.id },
          data: {
            lastValue: value,
            lastRecordedAt: recordedAt,
            nominalSince: null,
            ...(step.escalated ? { severity: step.severity } : {}),
          },
        });
        if (notify) {
          await notifyActiveUsers(tx, {
            kind: notificationKindFor(step.escalated),
            alertId: episode.id,
            severity: step.severity,
            value,
            recordedAt,
          });
        }
        return;
      }

      case "nominal": {
        if (!open) throw new Error(`[alerts] "nominal" step for ${pondId}/${parameter} without an open episode`);
        const episode = open;
        await tx.alert.update({
          where: { id: episode.id },
          data: {
            lastValue: value,
            lastRecordedAt: recordedAt,
            nominalSince: step.nominalSince,
            ...(step.resolved ? { resolvedAt: recordedAt } : {}),
          },
        });
        if (step.resolved) {
          await notifyActiveUsers(tx, {
            alertId: episode.id,
            kind: "ALERT_RESOLVED",
            severity: episode.severity,
            value,
            recordedAt,
          });
        }
        return;
      }

      case "unheld": {
        if (!open) throw new Error(`[alerts] "unheld" step for ${pondId}/${parameter} without an open episode`);
        // Recovery clock untouched and nobody notified, but lastRecordedAt must still advance: the stale guard
        // compares the next evaluation against it.
        await tx.alert.update({
          where: { id: open.id },
          data: { lastValue: value, lastRecordedAt: recordedAt },
        });
        return;
      }

      // A new AlertStep variant with no case here would otherwise fall off the end of this callback:
      // the transaction would commit having written nothing, no alert would open, escalate or resolve,
      // and nothing would log or throw. `never` turns that into a compile error, and the throw covers a
      // step that arrives at runtime from something TypeScript did not check.
      default: {
        const unexpected: never = step;
        throw new Error(`[alerts] unhandled alert step ${JSON.stringify(unexpected)}`);
      }
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
