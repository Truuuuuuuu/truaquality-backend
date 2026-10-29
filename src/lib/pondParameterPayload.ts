import { heldSeveritiesFor, heldSeverityFor, type HeldReading } from "./alertRules.ts";
import { ALERT_HOLD_READINGS, KNOWN_PARAMETER_IDS, thresholdsFor, type KnownParameterId } from "./parameters.ts";
import { buildParameterMetadata, productionPolicyResolver, type ParameterPolicyResolver } from "./parameterPolicies.ts";
import { compareNormalReference, type ReferenceComparison } from "./parameterReferences.ts";

export function recentReadingLimits(pondType: string | null | undefined, resolver: ParameterPolicyResolver = productionPolicyResolver) {
  const metadata = buildParameterMetadata(pondType, resolver).dissolvedOxygen;
  const doLimit = metadata.ingest.state === "active" && metadata.assessment.state === "configured" ? metadata.assessment.holdReadings : 1;
  return { ids: [...KNOWN_PARAMETER_IDS], limits: KNOWN_PARAMETER_IDS.map(id => id === "dissolvedOxygen" ? Math.max(1, doLimit) : ALERT_HOLD_READINGS[id]) };
}

export function recentReadingQueryInputs(ponds: readonly {id: string; pondType: string | null}[], resolver: ParameterPolicyResolver = productionPolicyResolver) {
  const { ids, limits } = recentReadingLimits(null, resolver);
  return {pondIds: ponds.map(p => p.id), ids, limits,
    doLimits: ponds.map(p => recentReadingLimits(p.pondType, resolver).limits[3])};
}

export function buildPondParameterPayload(pondType: string | null | undefined,
  recent: Partial<Record<KnownParameterId, readonly HeldReading[]>>, resolver: ParameterPolicyResolver = productionPolicyResolver) {
  const { dissolvedOxygen, ...legacy } = recent;
  const heldSeverity: Partial<Record<KnownParameterId, "WARNING" | "CRITICAL" | null>> = heldSeveritiesFor(pondType, legacy);
  const parameterMetadata = buildParameterMetadata(pondType, resolver);
  const policy = parameterMetadata.dissolvedOxygen;
  if (policy.ingest.state === "active" && policy.assessment.state === "configured" && dissolvedOxygen?.length) {
    heldSeverity.dissolvedOxygen = heldSeverityFor("dissolvedOxygen", pondType,
      [...dissolvedOxygen].sort((a,b) => b.recordedAt.getTime()-a.recordedAt.getTime()), resolver);
  }
  const referenceComparison: Partial<Record<"dissolvedOxygen", { value: number; recordedAt: Date; result: ReferenceComparison }>> = {};
  const latest = Object.hasOwn(recent, "dissolvedOxygen")
    ? dissolvedOxygen?.filter(reading => Number.isFinite(reading.value) && Number.isFinite(reading.recordedAt.getTime()))
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())[0]
    : undefined;
  if (latest) {
    const result = compareNormalReference(latest.value, policy.normalReference);
    if (result !== null) referenceComparison.dissolvedOxygen = { value: latest.value, recordedAt: latest.recordedAt, result };
  }
  return { thresholds: thresholdsFor(pondType), heldSeverity, parameterMetadata, referenceComparison };
}
