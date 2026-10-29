import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPondParameterPayload, recentReadingLimits, recentReadingQueryInputs } from "./pondParameterPayload.ts";
import { productionPolicyResolver, validateAssessmentPolicy } from "./parameterPolicies.ts";
import { thresholdsFor } from "./parameters.ts";

test("latest finite DO reference comparison is separate from pending operational assessment for every profile", () => {
  for (const profile of ["FRESHWATER", "BRACKISH", "SALTWATER", "UNSET"]) {
    for (const value of [4.99, 5, 5.01, 0]) {
      const recordedAt = new Date("2026-10-29T09:00:00Z");
      const payload = buildPondParameterPayload(profile, { dissolvedOxygen: [
        { value: 9, recordedAt: new Date("2026-10-29T08:00:00Z") },
        { value, recordedAt },
        { value: NaN, recordedAt: new Date("2026-10-29T10:00:00Z") },
      ] });
      assert.deepEqual(payload.referenceComparison, { dissolvedOxygen: {
        value, recordedAt, result: value > 5 ? "within_reference" : "outside_reference",
      } });
      assert.equal(payload.parameterMetadata.dissolvedOxygen.ingest.state, "pending");
      assert.equal(payload.parameterMetadata.dissolvedOxygen.assessment.state, "pending");
      assert.equal(Object.hasOwn(payload.heldSeverity, "dissolvedOxygen"), false);
      assert.deepEqual(payload.thresholds, thresholdsFor(profile));
      assert.deepEqual(Object.keys(payload.thresholds), ["temperature", "turbidity", "ph"]);
      assert.doesNotMatch(JSON.stringify(payload), /PHILMINAQ|2007|all.type|applicability|user.directed/);
    }
  }
});

test("absent, inherited or nonfinite DO cannot produce a reference verdict; legacy payload stays exact", () => {
  for (const recent of [{}, { dissolvedOxygen: [] },
    { dissolvedOxygen: [{ value: Infinity, recordedAt: new Date() }] },
    { dissolvedOxygen: [{ value: 7, recordedAt: new Date(NaN) }] },
    Object.create({ dissolvedOxygen: [{ value: 7, recordedAt: new Date() }] })]) {
    assert.deepEqual(buildPondParameterPayload(null, recent).referenceComparison, {});
  }
  const recent = { temperature: [{ value: 50, recordedAt: new Date() }], ph: [{ value: 7, recordedAt: new Date() }] };
  const legacy = buildPondParameterPayload(null, recent);
  const withDO = buildPondParameterPayload(null, { ...recent, dissolvedOxygen: [{ value: 0, recordedAt: new Date() }] });
  assert.deepEqual(withDO.thresholds, legacy.thresholds);
  assert.deepEqual(withDO.heldSeverity, legacy.heldSeverity);
});
test("pending DO is explicit and numeric retrieval stays independent", () => {
  const payload = buildPondParameterPayload(null, { dissolvedOxygen: [{ value: 4, recordedAt: new Date() }] });
  assert.equal(payload.parameterMetadata.dissolvedOxygen.assessment.state, "pending");
  assert.equal(Object.hasOwn(payload.thresholds, "dissolvedOxygen"), false);
  assert.equal(Object.hasOwn(payload.heldSeverity, "dissolvedOxygen"), false);
  assert.deepEqual(recentReadingLimits(null), { ids: ["temperature", "turbidity", "ph", "dissolvedOxygen"], limits: [1, 4, 4, 1] });
});
test("batched lookup inputs align pond IDs with different configured profile holds", () => {
  const policy = validateAssessmentPolicy({state: "configured", kind: "low", evidenceRef: "synthetic", provenance: {provider: "test", suppliedAt: "2030-01-01", reference: "test", applicability: "test only"}, safeMin: 5, criticalMin: 2, safeInclusive: true, criticalInclusive: false, holdReadings: 2, maxGapMs: 60000, recoveryMs: 120000, renotifyMs: 180000});
  if (policy.state !== "configured") throw new Error("fixture");
  const resolver = {...productionPolicyResolver,
    ingestPolicyFor: () => ({state: "active" as const, evidenceRef: "synthetic", bounds: {min: 0, max: 20}}),
    assessmentPolicyFor: (_p: "dissolvedOxygen", type?: string | null) => ({...policy, holdReadings: type === "BRACKISH" ? 3 : 5})};
  const ponds = [{id: "salt", pondType: "SALTWATER"}, {id: "brackish", pondType: "BRACKISH"}];
  assert.deepEqual(recentReadingQueryInputs(ponds, resolver), {pondIds: ["salt", "brackish"], ids: ["temperature", "turbidity", "ph", "dissolvedOxygen"], limits: [1,4,4,5], doLimits: [5,3]});
  assert.deepEqual(recentReadingQueryInputs([...ponds].reverse(), resolver).doLimits, [3,5]);
  const recent = {dissolvedOxygen: [0,1,2].map(i => ({value: 1, recordedAt: new Date(120000-i*30000)}))};
  assert.equal(buildPondParameterPayload("BRACKISH", recent, resolver).heldSeverity.dissolvedOxygen, "CRITICAL");
  assert.equal(buildPondParameterPayload("SALTWATER", recent, resolver).heldSeverity.dissolvedOxygen, null);
});
test("active DO ingest with pending assessment still retrieves one and has no verdict", () => {
  const resolver = { ...productionPolicyResolver, ingestPolicyFor: () => ({state: "active" as const, evidenceRef: "synthetic", bounds: {min: 0, max: 20}}) };
  assert.equal(recentReadingLimits(null, resolver).limits[3], 1);
  assert.equal(Object.hasOwn(buildPondParameterPayload(null, {dissolvedOxygen: [{value: 4, recordedAt: new Date()}]}, resolver).heldSeverity, "dissolvedOxygen"), false);
});
test("configured synthetic DO retrieves its hold and returns held verdict", () => {
  const policy = validateAssessmentPolicy({state: "configured", kind: "low", evidenceRef: "synthetic", provenance: {provider: "test", suppliedAt: "2030-01-01", reference: "test", applicability: "test only"}, safeMin: 5, criticalMin: 2, safeInclusive: true, criticalInclusive: false, holdReadings: 2, maxGapMs: 60000, recoveryMs: 120000, renotifyMs: 180000});
  const resolver = { ...productionPolicyResolver, ingestPolicyFor: () => ({state: "active" as const, evidenceRef: "synthetic", bounds: {min: 0, max: 20}}), assessmentPolicyFor: () => policy };
  assert.equal(recentReadingLimits(null, resolver).limits[3], 2);
  assert.equal(buildPondParameterPayload(null, {dissolvedOxygen: [{value: 1, recordedAt: new Date(60000)}, {value: 1, recordedAt: new Date(0)}]}, resolver).heldSeverity.dissolvedOxygen, "CRITICAL");
});
