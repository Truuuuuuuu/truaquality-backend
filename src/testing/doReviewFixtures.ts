import { buildPondParameterPayload } from "../lib/pondParameterPayload.ts";
import { analyzeSeries, previousRange, type SeriesPoint } from "../lib/seriesAnalysis.ts";
import { describeAnalysis } from "../lib/analysisSummary.ts";
import { productionPolicyResolver } from "../lib/parameterPolicies.ts";
import { thresholdsFor } from "../lib/parameters.ts";
import type { PondAnalysis } from "../lib/pondAnalysis.ts";

// Display fixtures deliberately use production pending policies, never the configured test policy.
const IDS = ["temperature", "turbidity", "ph", "dissolvedOxygen"] as const;
export const REVIEW_SCENARIOS = [
  "above", "equal", "below", "zero", "never-reported", "value-only", "uncalibrated",
  "fault", "silent", "offline", "reassigned", "empty-range", "previous-missing",
  "unequal-hourly", "freshwater", "saltwater", "unset", "legacy-warning",
  "legacy-critical", "extreme", "flat", "loading", "error",
] as const;
export type ReviewScenarioId = typeof REVIEW_SCENARIOS[number];

export function createReviewScenario(id: ReviewScenarioId, now: Date) {
  const stamp = (ago: number) => new Date(now.getTime() - ago);
  const profile = id === "freshwater" ? "FRESHWATER" : id === "saltwater" ? "SALTWATER" : id === "unset" ? null : "BRACKISH";
  const value = id === "equal" ? 5 : id === "below" ? 4.99 : id === "zero" ? 0 : 7.23;
  const stale = ["silent", "offline", "fault", "reassigned"].includes(id);
  const readAt = stamp(stale ? 20 * 60000 : 30000);
  const assignedAt = stamp(id === "reassigned" ? 5 * 60000 : 86400000);
  const pondId = "00000000-0000-4000-8000-000000000018";
  const deviceId = "00000000-0000-4000-8000-000000000019";
  const latest = Object.fromEntries(IDS.filter(key => key !== "dissolvedOxygen" || id !== "never-reported")
    .map(key => [key, { value: key === "temperature" ? (id === "legacy-critical" ? 50 : id === "legacy-warning" ? 34 : 28) : key === "turbidity" ? 12 : key === "ph" ? 7.5 : value,
      recordedAt: key === "dissolvedOxygen" ? readAt : stamp(30000) }]));
  const statuses: Record<string, string> = { temperature: "ok", turbidity: "ok", ph: "ok" };
  if (!["never-reported", "value-only", "reassigned"].includes(id)) statuses.dissolvedOxygen = id === "uncalibrated" ? "uncalibrated" : id === "fault" ? "no_signal" : "ok";
  const recent = Object.fromEntries(Object.entries(latest).map(([key, row]) => [key, Array.from({length: 4}, (_, index) => ({...row, recordedAt: stamp(now.getTime() - row.recordedAt.getTime() + index * 60000)}))]));
  const payload = buildPondParameterPayload(profile, recent);
  const device = { id: deviceId, serial: "SIMULATED-DO-018", hardwareModel: "Illustrative ESP32", label: "Simulated sensor unit", secretVersion: 1,
    status: "ACTIVE", pondId, assignedAt, firmwareVersion: "0.8.0-do-contract", wifiSsid: "Simulated network",
    lastSeenAt: stamp(id === "offline" ? 15 * 60000 : 10000), createdAt: stamp(86400000), updatedAt: stamp(10000) };
  const pond = { id: pondId, name: `Simulated pond · ${id}`, notes: "Isolated software review", fishSpecies: "Review stock", pondType: profile,
    status: "ACTIVE", createdAt: stamp(86400000), updatedAt: stamp(10000), device, latest, sensorStatus: statuses, openAlerts: {}, ...payload };
  const points: SeriesPoint[] = [];
  if (id !== "empty-range") for (let i = 0; i < 12; i++) for (const key of IDS) {
    if (key === "dissolvedOxygen" && id === "never-reported") continue;
    const v = key === "dissolvedOxygen" ? id === "extreme" ? (i % 2 ? 1000 : -100) : id === "flat" ? value : i === 11 ? value : [7.23, 5, 4.99, 0, 6.4, 8.2][i % 6]! : latest[key]!.value;
    points.push({ parameter: key, t: stamp(((12 - i) * 5 + (key === "dissolvedOxygen" && stale ? 20 : 0)) * 60000), avg: v, min: v, max: v, count: 1 });
  }
  const range = { from: stamp(2 * 3600000), to: now };
  const analyses = Object.fromEntries((["raw", "hour", "day"] as const).map(resolution => {
    const series = points.map((p, i) => resolution === "raw" ? p : {...p, count: Math.floor(i / (id === "never-reported" ? 3 : 4)) % 2 ? 1 : 9,
      min: p.parameter === "dissolvedOxygen" ? Math.min(p.min, 0) : p.min});
    const results = analyzeSeries(series, range, profile, productionPolicyResolver, resolution);
    const before = id === "previous-missing" ? {} : analyzeSeries(series.map(p => ({...p, avg: p.avg - 0.25, min: p.min - 0.25, max: p.max - 0.25})), range, profile, productionPolicyResolver, resolution);
    const parameters: PondAnalysis["parameters"] = {};
    for (const key of IDS) {
      const result = results[key];
      if (!result) continue;
      const previousAvg = before[key]?.avg ?? null;
      const withPrevious = {...result, previousAvg, ...(key === "dissolvedOxygen" ? {previousChange: previousAvg === null ? null : result.avg - previousAvg} : {})};
      parameters[key] = {...withPrevious, summary: describeAnalysis(key, withPrevious,
        key === "dissolvedOxygen" ? productionPolicyResolver.assessmentPolicyFor(key, profile) : thresholdsFor(profile)[key]!, {...range, rolling: true, resolution})};
    }
    const previous = previousRange(range);
    return [resolution, {resolution, ...range, previousFrom: previous.from, previousTo: previous.to, parameters}];
  })) as Record<"raw" | "hour" | "day", PondAnalysis>;
  const diagnostics = { health: { rssi: -55, uptimeS: 7200, resetReason: "power_on", freeHeap: 120000, queuedSamples: 0,
    diagnosticsAt: stamp(10000), offlineSince: id === "offline" ? device.lastSeenAt : null },
    // Enumeration alone intentionally includes DO even for never-reported: UI must require evidence.
    sensors: IDS.map(parameter => ({parameter, lastReadingAt: latest[parameter]?.recordedAt ?? null,
      lastValue: latest[parameter]?.value ?? null, readings24h: latest[parameter] ? 12 : 0,
      longestGapMin24h: stale && parameter === "dissolvedOxygen" ? 20 : 1, reportedStatus: statuses[parameter] ?? null})), uptime24h: 0.98, events: [] };
  const notifications = [{id: "simulated-notification", kind: "ALERT_RESOLVED", severity: "WARNING", value: 7.23,
    recordedAt: stamp(60000), readAt: null, createdAt: stamp(60000), direction: "low",
    alert: { id: "simulated-historical-episode", parameter: "dissolvedOxygen", resolvedAt: stamp(60000), pond: {id: pondId, name: pond.name, pondType: profile} }, device: null}];
  return { id, dataOrigin: "simulated" as const, pond, device: {...device, pond: {id: pondId, name: pond.name}},
    points, analyses, diagnostics, notifications };
}
