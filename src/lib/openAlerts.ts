import type { AlertSeverity } from "../generated/prisma/client.ts";
import { isParameterId, type ParameterId } from "./parameters.ts";
import { prisma } from "./prisma.ts";

export type OpenAlertRow = { pondId: string; parameter: string; severity: AlertSeverity };
export type PondOpenAlerts = Partial<Record<ParameterId, AlertSeverity>>;

// The pond card keeps the held verdict (`heldSeverity`) so a spike shorter than the hold never flickers it. The
// catch: an alert episode stays open until it recovers, so once the newest readings fall short of the hold again the
// card can be green while an episode is still unresolved — and the board would give no hint of it. The pond
// payloads therefore also carry the unresolved episodes, per parameter, worst severity first.
export function openAlertsByPond(rows: OpenAlertRow[]) {
  const byPond = new Map<string, PondOpenAlerts>();
  for (const row of rows) {
    if (!isParameterId(row.parameter)) continue;
    const open = byPond.get(row.pondId) ?? {};
    // At most one unresolved episode per pond/parameter is expected; if two ever exist, show the worse.
    if (open[row.parameter] !== "CRITICAL") open[row.parameter] = row.severity;
    byPond.set(row.pondId, open);
  }
  return byPond;
}

// One query for every pond on the page (no N+1), served by the (pondId, parameter, resolvedAt) index.
export async function loadOpenAlerts(pondIds: string[]) {
  if (pondIds.length === 0) return new Map<string, PondOpenAlerts>();
  const rows = await prisma.alert.findMany({
    where: { pondId: { in: pondIds }, resolvedAt: null },
    select: { pondId: true, parameter: true, severity: true },
  });
  return openAlertsByPond(rows);
}
