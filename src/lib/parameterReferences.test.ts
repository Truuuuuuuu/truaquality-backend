import assert from "node:assert/strict";
import { test } from "node:test";
import { compareNormalReference, normalReferenceFor, type NormalReference } from "./parameterReferences.ts";

test("strict independent reference preserves equality, zero and finite values", () => {
  const reference = normalReferenceFor("BRACKISH");
  for (const value of [0, 4.99, 5]) assert.equal(compareNormalReference(value, reference), "outside_reference");
  assert.equal(compareNormalReference(5.01, reference), "within_reference");
  for (const value of [undefined, null, NaN, Infinity, -Infinity, "5.01"]) {
    assert.equal(compareNormalReference(value, reference), null);
  }
  assert.equal(compareNormalReference(6), null);
  assert.equal(compareNormalReference(6, null), null);
  assert.equal(compareNormalReference(6, { ...reference, boundary: NaN }), null);
  assert.equal(compareNormalReference(6, Object.create(reference) as NormalReference), null);
});

test("all profiles and unknown own-key names receive immutable public reference only", () => {
  for (const profile of ["FRESHWATER", "BRACKISH", "SALTWATER", "UNSET", null, undefined, "unknown", "__proto__", "constructor"]) {
    const reference = normalReferenceFor(profile);
    assert.deepEqual(reference, { kind: "lower", boundary: 5, operator: "gt", unit: "mg/L", label: "Normal: > 5 ppm" });
    assert.ok(Object.isFrozen(reference));
    assert.throws(() => Object.assign(reference, { boundary: 7 }), TypeError);
    assert.doesNotMatch(JSON.stringify(reference), /BFAR|PHILMINAQ|2007|applicability|critical|safeMin|holdReadings/);
  }
});
