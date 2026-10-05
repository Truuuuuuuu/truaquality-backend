// Pure signal helpers for scripts/simulate-devices.ts — no Prisma, no env, no I/O. They live here rather than in the
// script because tests may not import scripts/* (the script connects to the broker at import time).
import { ALERT_RECOVERY_MS } from "./alertRules.ts";
import {
  ALERT_HOLD_MAX_GAP_MS,
  ALERT_HOLD_READINGS,
  PARAMETER_BOUNDS,
  isParameterId,
  type ParameterId,
} from "./parameters.ts";

// The simulated pond's pH follows a compressed day: dawn low (CO2 from overnight respiration) and afternoon high
// (photosynthesis), straddling both safe lines (6.5 / 9.5) so one cycle demos an acidic alert, its recovery, then
// an alkaline one (D-20). There is only one open alert per pond/parameter, so the in-range stretch between the two
// excursions (31.4% of a 6.2..9.8 sine) must outlast ALERT_RECOVERY_MS or the acidic episode never resolves and the
// alkaline excursion just continues it. 40 min leaves about 12.6 min in range; 30 min leaves 9.4 min and fails.
export const PH_CURVE = { low: 6.2, high: 9.8, dayMinutes: 40, noise: 0.05 } as const;

// Shares of one 6.2..9.8 sine cycle spent below 6.5 (and, symmetrically, above 9.5) and in each in-range stretch.
const BEYOND_LINE_SHARE = 0.186;
const IN_RANGE_SHARE = 0.314;

export function phCurveValue(
  elapsedMs: number,
  dayMs: number,
  unitOffset: number,
  noise: number = PH_CURVE.noise,
  random: () => number = Math.random,
): number {
  const mid = (PH_CURVE.low + PH_CURVE.high) / 2;
  const amp = (PH_CURVE.high - PH_CURVE.low) / 2;
  const curve = mid - amp * Math.cos(2 * Math.PI * (elapsedMs / dayMs + unitOffset));
  const noisy = curve + (random() * 2 - 1) * noise;
  const clamped = Math.min(PARAMETER_BOUNDS.ph.max, Math.max(PARAMETER_BOUNDS.ph.min, noisy));
  return Math.round(clamped * 100) / 100;
}

export type SpikeSpec = { parameter: ParameterId; value: number; everyN: number };

// `<param>=<value>:<everyN>`. Returns an error message instead of throwing so the script can print it and exit 1.
// An out-of-bounds value is refused here because ingest would drop it and the spike would prove nothing.
export function parseSpike(spec: string): SpikeSpec | string {
  const match = /^([a-zA-Z][a-zA-Z0-9]*)=([^:]+):([^:]+)$/.exec(spec);
  if (!match) return `expected <parameter>=<value>:<everyN>; got "${spec}"`;
  const [, parameter, rawValue, rawEveryN] = match;
  if (!isParameterId(parameter)) return `unknown parameter "${parameter}" in "${spec}"`;
  const value = Number(rawValue);
  const bounds = PARAMETER_BOUNDS[parameter];
  if (rawValue.trim() === "" || !Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    return `${parameter} spike value must be between ${bounds.min} and ${bounds.max}; got "${rawValue}"`;
  }
  const everyN = Number(rawEveryN);
  if (!/^\d+$/.test(rawEveryN) || !Number.isInteger(everyN) || everyN < 2) {
    return `everyN must be an integer >= 2; got "${rawEveryN}"`;
  }
  return { parameter, value, everyN };
}

// reportIndex is 1-based; when several specs match the same report, the last one wins.
export function spikeFor(spikes: readonly SpikeSpec[], parameter: string, reportIndex: number): number | undefined {
  let value: number | undefined;
  for (const spike of spikes) {
    if (spike.parameter === parameter && reportIndex % spike.everyN === 0) value = spike.value;
  }
  return value;
}

export function curveTimingWarnings(input: { dayMs: number; intervalMs: number }): string[] {
  const { dayMs, intervalMs } = input;
  const warnings: string[] = [];
  const gapS = ALERT_HOLD_MAX_GAP_MS / 1000;
  if (intervalMs > ALERT_HOLD_MAX_GAP_MS) {
    warnings.push(
      `--interval ${intervalMs / 1000}s is over ${gapS} s (ALERT_HOLD_MAX_GAP_MS): every gap breaks the held run, so ` +
        "no pH or turbidity alert will ever open.",
    );
  }
  const recoveryNeededMs = ALERT_RECOVERY_MS + 2 * intervalMs;
  if (dayMs * IN_RANGE_SHARE < recoveryNeededMs) {
    warnings.push(
      `--ph-day ${dayMs / 60_000} min leaves ${((dayMs * IN_RANGE_SHARE) / 60_000).toFixed(1)} min in range between ` +
        `excursions, under ALERT_RECOVERY_MS (${ALERT_RECOVERY_MS / 60_000} min) plus two reports: the acidic alert ` +
        "will not resolve before the alkaline excursion.",
    );
  }
  const holdNeededMs = (ALERT_HOLD_READINGS.ph + 1) * intervalMs;
  if (dayMs * BEYOND_LINE_SHARE < holdNeededMs) {
    warnings.push(
      `--ph-day ${dayMs / 60_000} min spends ${((dayMs * BEYOND_LINE_SHARE) / 60_000).toFixed(1)} min beyond each ` +
        `line, too short for ${ALERT_HOLD_READINGS.ph} held readings (ALERT_HOLD_READINGS.ph) at this interval.`,
    );
  }
  return warnings;
}

// D-17: pH arrives with firmware 0.7.0; a unit without pH looks like the shipping 0.6.1.
export function simulatedFirmwareVersion(reportsPh: boolean): "0.7.0" | "0.6.1" {
  return reportsPh ? "0.7.0" : "0.6.1";
}
