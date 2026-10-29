import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalReferenceFor } from "./parameterReferences.ts";
import {
  assessmentPolicyFor,
  buildParameterMetadata,
  ingestPolicyFor,
  parameterMetadataFor,
  productionPolicyResolver,
  validateAssessmentPolicy,
  validateIngestPolicy,
  type AssessmentPolicy,
  type ParameterPolicyResolver,
} from "./parameterPolicies.ts";

// Synthetic policy exercises validation only; none of these values is a BFAR limit.
const provenance = { provider: "Synthetic test", suppliedAt: "2026-10-29", reference: "fixture", applicability: "tests only" };
const configured = {
  state: "configured", kind: "low", evidenceRef: "test-only", provenance,
  safeMin: 5, criticalMin: 2, safeInclusive: true, criticalInclusive: false,
  holdReadings: 3, maxGapMs: 1000, recoveryMs: 2000, renotifyMs: 3000,
} as const;

describe("production DO policies", () => {
  for (const profile of ["FRESHWATER", "BRACKISH", "SALTWATER", "UNSET", null, undefined, "unknown"]) {
    test(`${profile}: identity never enables ingest or assessment`, () => {
      const ingest = ingestPolicyFor("dissolvedOxygen", profile);
      const assessment = assessmentPolicyFor("dissolvedOxygen", profile);
      assert.equal(ingest.state, "pending");
      assert.equal(assessment.state, "pending");
      assert.deepEqual(Object.keys(ingest).sort(), ["evidenceRef", "state"]);
      assert.deepEqual(Object.keys(assessment).sort(), ["evidenceRef", "kind", "state"]);
      assert.ok(Object.isFrozen(ingest));
      assert.ok(Object.isFrozen(assessment));
      assert.match(ingest.evidenceRef, /^DO_THRESHOLDS.md#/);
      assert.match(assessment.evidenceRef, /^DO_THRESHOLDS.md#/);
      assert.deepEqual(parameterMetadataFor(profile).dissolvedOxygen, {
        label: "Dissolved oxygen", unit: "mg/L", precision: 2, ingest, assessment,
        normalReference: normalReferenceFor(profile),
      });
    });
  }
  test("production resolver is immutable and does not accept injected state", () => {
    assert.ok(Object.isFrozen(productionPolicyResolver));
    assert.throws(() => Object.assign(ingestPolicyFor("dissolvedOxygen"), { state: "active" }), TypeError);
    assert.equal(ingestPolicyFor("dissolvedOxygen").state, "pending");
  });
  test("legacy ingest bounds remain active and exact", () => {
    assert.deepEqual(ingestPolicyFor("temperature").state, "active");
    const policy = ingestPolicyFor("ph");
    assert.equal(policy.state, "active");
    if (policy.state === "active") assert.deepEqual(policy.bounds, { min: 0, max: 14 });
  });
});

describe("policy validation", () => {
  test("active bounds and configured low policy are accepted without fake upper bands", () => {
    assert.deepEqual(validateIngestPolicy({ state: "active", bounds: { min: 0, max: 12 }, evidenceRef: "synthetic" }),
      { state: "active", bounds: { min: 0, max: 12 }, evidenceRef: "synthetic" });
    assert.deepEqual(validateAssessmentPolicy(configured), configured);
  });
  for (const bounds of [{ min: 2, max: 2 }, { min: 3, max: 2 }, { min: NaN, max: 2 }, { min: 0, max: Infinity }]) {
    test(`reject invalid bounds ${JSON.stringify(bounds)}`, () => {
      assert.throws(() => validateIngestPolicy({ state: "active", evidenceRef: "fixture", bounds }));
    });
  }
  for (const override of [
    { criticalMin: 5 }, { criticalMin: 6 }, { safeMin: NaN }, { criticalMin: -Infinity },
    { holdReadings: 0 }, { holdReadings: 1.5 }, { maxGapMs: 0 }, { recoveryMs: -1 }, { renotifyMs: Infinity },
    { evidenceRef: " " }, { safeInclusive: "true" }, { criticalInclusive: null },
    { provenance: { ...provenance, provider: "" } }, { provenance: { ...provenance, reference: " " } },
    { provenance: { ...provenance, applicability: "" } }, { provenance: { ...provenance, suppliedAt: "" } },
    { provenance: { ...provenance, suppliedAt: "2026-02-30" } },
  ]) {
    test(`reject malformed configured policy ${JSON.stringify(override)}`, () => {
      assert.throws(() => validateAssessmentPolicy({ ...configured, ...override }));
    });
  }
  test("pending states cannot smuggle numeric policy fields", () => {
    assert.throws(() => validateIngestPolicy({ state: "pending", evidenceRef: "fixture", bounds: { min: 0, max: 12 } }));
    assert.throws(() => validateAssessmentPolicy({ state: "pending", kind: "low", evidenceRef: "fixture", safeMin: 5 }));
    assert.throws(() => validateIngestPolicy({ state: "active", bounds: { min: 0, max: 12 }, evidenceRef: "" }));
  });
  test("not applicable is explicit, evidenced, and carries no safe verdict or numbers", () => {
    const policy = validateAssessmentPolicy({ state: "not_applicable", kind: "low", evidenceRef: "fixture", provenance });
    assert.equal(policy.state, "not_applicable");
    assert.equal("safeMin" in policy, false);
    assert.throws(() => validateAssessmentPolicy({ state: "not_applicable", kind: "low", evidenceRef: "fixture" }));
  });
  test("injected metadata is isolated from default production metadata", () => {
    const resolver: ParameterPolicyResolver = {
      ingestPolicyFor: () => ({ state: "active", evidenceRef: "synthetic", bounds: { min: 0, max: 12 } }),
      assessmentPolicyFor: (): AssessmentPolicy => configured,
    };
    const metadata = buildParameterMetadata("BRACKISH", resolver).dissolvedOxygen;
    assert.equal(metadata.ingest.state, "active");
    assert.deepEqual(metadata.assessment, configured);
    assert.equal(parameterMetadataFor("BRACKISH").dissolvedOxygen.assessment.state, "pending");
  });
});
