import "./guardEnv.ts";
import { productionPolicyResolver, validateAssessmentPolicy, validateIngestPolicy, type ParameterPolicyResolver } from "../lib/parameterPolicies.ts";

// Synthetic fixtures only: these numbers carry no BFAR or hardware evidence.
export const syntheticDoPolicy = {
  ingest: validateIngestPolicy({state: "active", evidenceRef: "synthetic-only", bounds: {min: 0, max: 20}}),
  assessment: validateAssessmentPolicy({state: "configured", kind: "low", evidenceRef: "synthetic-only",
    provenance: {provider: "test", suppliedAt: "2030-01-01", reference: "test", applicability: "test only"},
    safeMin: 5, criticalMin: 2, safeInclusive: true, criticalInclusive: false, holdReadings: 2,
    maxGapMs: 90000, recoveryMs: 120000, renotifyMs: 180000}),
};
export const syntheticDoResolver: ParameterPolicyResolver = {
  ...productionPolicyResolver,
  ingestPolicyFor: (p, type) => p === "dissolvedOxygen" ? syntheticDoPolicy.ingest : productionPolicyResolver.ingestPolicyFor(p, type),
  assessmentPolicyFor: () => syntheticDoPolicy.assessment,
};
export const DO_TEST_TIME = new Date("2030-01-01T00:00:00Z");
export const DO_TEST_DEVICE_ID = "00000000-0000-4000-8000-000000001515";
export const DO_TEST_SECRET = "not-real-do-test-secret";
export function syntheticDoReport(value?: number, status?: string, recordedAt = DO_TEST_TIME) {
  return {firmwareVersion: "0.8.0-do-contract", sensors: status ? {dissolvedOxygen: status} : {},
    samples: [{recordedAt: recordedAt.toISOString(), values: {temperature: 25, ...(value === undefined ? {} : {dissolvedOxygen: value})}}]};
}
