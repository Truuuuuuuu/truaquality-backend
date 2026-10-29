import {
  PARAMETER_BOUNDS,
  PARAMETER_DISPLAY,
  thresholdProfileFor,
  type KnownParameterId,
  type ThresholdProfile,
} from "./parameters.ts";
import { normalReferenceFor } from "./parameterReferences.ts";

export type IngestPolicy =
  | Readonly<{ state: "pending"; evidenceRef: string }>
  | Readonly<{ state: "active"; evidenceRef: string; bounds: Readonly<{ min: number; max: number }> }>;

export type PolicyProvenance = Readonly<{
  provider: string;
  suppliedAt: string;
  reference: string;
  applicability: string;
}>;

export type ConfiguredLowPolicy = Readonly<{
  state: "configured";
  kind: "low";
  evidenceRef: string;
  provenance: PolicyProvenance;
  safeMin: number;
  criticalMin: number;
  safeInclusive: boolean;
  criticalInclusive: boolean;
  holdReadings: number;
  maxGapMs: number;
  recoveryMs: number;
  renotifyMs: number;
}>;

export type AssessmentPolicy =
  | Readonly<{ state: "pending"; kind: "low"; evidenceRef: string }>
  | Readonly<{ state: "not_applicable"; kind: "low"; evidenceRef: string; provenance: PolicyProvenance }>
  | ConfiguredLowPolicy;

// Assessment here is the additive DO policy; legacy assessment stays in parameters.ts unchanged.
export type ParameterPolicyResolver = Readonly<{
  ingestPolicyFor: (parameter: KnownParameterId, pondType?: string | null) => IngestPolicy;
  assessmentPolicyFor: (parameter: "dissolvedOxygen", pondType?: string | null) => AssessmentPolicy;
}>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid parameter policy");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("invalid parameter policy fields");
  }
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("parameter policy evidence is required");
  return value;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("parameter policy must be finite");
  return value;
}

function positive(value: unknown): number {
  const result = finite(value);
  if (result <= 0) throw new Error("parameter policy timing/count must be positive");
  return result;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("parameter policy equality semantics are required");
  return value;
}

function provenanceFor(value: unknown): PolicyProvenance {
  const p = record(value);
  exactKeys(p, ["provider", "suppliedAt", "reference", "applicability"]);
  const suppliedAt = text(p.suppliedAt);
  const parsed = new Date(`${suppliedAt}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(suppliedAt) || !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== suppliedAt) throw new Error("invalid parameter policy supplied date");
  return Object.freeze({ provider: text(p.provider), suppliedAt, reference: text(p.reference), applicability: text(p.applicability) });
}

export function validateIngestPolicy(value: unknown): IngestPolicy {
  const p = record(value);
  const evidenceRef = text(p.evidenceRef);
  if (p.state === "pending") {
    exactKeys(p, ["state", "evidenceRef"]);
    return Object.freeze({ state: "pending", evidenceRef });
  }
  if (p.state !== "active") throw new Error("invalid ingest policy state");
  exactKeys(p, ["state", "evidenceRef", "bounds"]);
  const bounds = record(p.bounds);
  exactKeys(bounds, ["min", "max"]);
  const min = finite(bounds.min);
  const max = finite(bounds.max);
  if (min >= max) throw new Error("invalid ingest policy bounds");
  return Object.freeze({ state: "active", evidenceRef, bounds: Object.freeze({ min, max }) });
}

export function validateAssessmentPolicy(value: unknown): AssessmentPolicy {
  const p = record(value);
  if (p.kind !== "low") throw new Error("invalid assessment policy kind");
  const evidenceRef = text(p.evidenceRef);
  if (p.state === "pending") {
    exactKeys(p, ["state", "kind", "evidenceRef"]);
    return Object.freeze({ state: "pending", kind: "low", evidenceRef });
  }
  const provenance = provenanceFor(p.provenance);
  if (p.state === "not_applicable") {
    exactKeys(p, ["state", "kind", "evidenceRef", "provenance"]);
    return Object.freeze({ state: "not_applicable", kind: "low", evidenceRef, provenance });
  }
  if (p.state !== "configured") throw new Error("invalid assessment policy state");
  exactKeys(p, ["state", "kind", "evidenceRef", "provenance", "safeMin", "criticalMin", "safeInclusive",
    "criticalInclusive", "holdReadings", "maxGapMs", "recoveryMs", "renotifyMs"]);
  const safeMin = finite(p.safeMin);
  const criticalMin = finite(p.criticalMin);
  const holdReadings = positive(p.holdReadings);
  if (criticalMin >= safeMin || !Number.isSafeInteger(holdReadings)) throw new Error("invalid low assessment policy");
  return Object.freeze({
    state: "configured", kind: "low", evidenceRef, provenance, safeMin, criticalMin,
    safeInclusive: boolean(p.safeInclusive), criticalInclusive: boolean(p.criticalInclusive), holdReadings,
    maxGapMs: positive(p.maxGapMs), recoveryMs: positive(p.recoveryMs), renotifyMs: positive(p.renotifyMs),
  });
}

const DO_INGEST = validateIngestPolicy({ state: "pending", evidenceRef: "DO_THRESHOLDS.md#physical-bounds" });
const DO_ASSESSMENT: Readonly<Record<ThresholdProfile, AssessmentPolicy>> = Object.freeze({
  FRESHWATER: validateAssessmentPolicy({ state: "pending", kind: "low", evidenceRef: "DO_THRESHOLDS.md#freshwater" }),
  BRACKISH: validateAssessmentPolicy({ state: "pending", kind: "low", evidenceRef: "DO_THRESHOLDS.md#brackish" }),
  SALTWATER: validateAssessmentPolicy({ state: "pending", kind: "low", evidenceRef: "DO_THRESHOLDS.md#saltwater" }),
  UNSET: validateAssessmentPolicy({ state: "pending", kind: "low", evidenceRef: "DO_THRESHOLDS.md#unset" }),
});

export function ingestPolicyFor(parameter: KnownParameterId, _pondType?: string | null): IngestPolicy {
  if (parameter === "dissolvedOxygen") return DO_INGEST;
  return validateIngestPolicy({ state: "active", evidenceRef: `parameters.ts#${parameter}`, bounds: PARAMETER_BOUNDS[parameter] });
}

export function assessmentPolicyFor(_parameter: "dissolvedOxygen", pondType?: string | null): AssessmentPolicy {
  return DO_ASSESSMENT[thresholdProfileFor(pondType)];
}

export const productionPolicyResolver: ParameterPolicyResolver = Object.freeze({ ingestPolicyFor, assessmentPolicyFor });

// This pure builder is the explicit test seam. HTTP/production consumers use parameterMetadataFor instead.
export function buildParameterMetadata(pondType: string | null | undefined, resolver: ParameterPolicyResolver) {
  const { label, unit, precision } = PARAMETER_DISPLAY.dissolvedOxygen;
  return {
    dissolvedOxygen: {
      label, unit, precision,
      normalReference: normalReferenceFor(pondType),
      ingest: validateIngestPolicy(resolver.ingestPolicyFor("dissolvedOxygen", pondType)),
      assessment: validateAssessmentPolicy(resolver.assessmentPolicyFor("dissolvedOxygen", pondType)),
    },
  };
}

export function parameterMetadataFor(pondType: string | null | undefined) {
  return buildParameterMetadata(pondType, productionPolicyResolver);
}
