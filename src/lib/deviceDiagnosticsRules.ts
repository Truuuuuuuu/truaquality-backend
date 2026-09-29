// Pure helpers for GET /devices/:id/diagnostics — no Prisma, no env — so they test without a database.

export type UptimeTransition = { kind: "OFFLINE" | "ONLINE"; at: Date };

// Share of [windowStart, now] the unit was NOT inside an OFFLINE→ONLINE episode, as a percentage rounded to one
// decimal. Transitions come from DeviceEvent (written by the watchdog), so an OFFLINE while already offline (or
// ONLINE while online) is a no-op rather than a new episode. Null for an empty window (nothing to measure).
export function uptimePercent(input: {
  windowStart: Date;
  now: Date;
  stateAtStart: "online" | "offline";
  transitions: UptimeTransition[];
}): number | null {
  const start = input.windowStart.getTime();
  const end = input.now.getTime();
  const windowMs = end - start;
  if (windowMs <= 0) return null;

  const sorted = [...input.transitions].sort((a, b) => a.at.getTime() - b.at.getTime());
  let offline = input.stateAtStart === "offline";
  let offlineFrom = start;
  let offlineMs = 0;

  for (const transition of sorted) {
    const at = Math.min(Math.max(transition.at.getTime(), start), end);
    if (transition.kind === "OFFLINE" && !offline) {
      offline = true;
      offlineFrom = at;
    } else if (transition.kind === "ONLINE" && offline) {
      offline = false;
      offlineMs += at - offlineFrom;
    }
  }
  if (offline) offlineMs += end - offlineFrom;

  return Math.round(((windowMs - offlineMs) / windowMs) * 1000) / 10;
}
