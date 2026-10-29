import { thresholdProfileFor, type ThresholdProfile } from "./parameters.ts";

// Independent display reference; evidence and approximation limits live in DO_THRESHOLDS.md.
// This is neither an ingest bound nor an operational assessment policy.
export type NormalReference = Readonly<{
  kind: "lower";
  boundary: number;
  operator: "gt";
  unit: "mg/L";
  label: string;
}>;

export type ReferenceComparison = "within_reference" | "outside_reference";

const DO_REFERENCE: NormalReference = Object.freeze({
  kind: "lower", boundary: 5, operator: "gt", unit: "mg/L", label: "Normal: > 5 ppm",
});
const REFERENCES: Readonly<Record<ThresholdProfile, NormalReference>> = Object.freeze({
  FRESHWATER: DO_REFERENCE, BRACKISH: DO_REFERENCE, SALTWATER: DO_REFERENCE, UNSET: DO_REFERENCE,
});

export function normalReferenceFor(pondType?: string | null): NormalReference {
  return REFERENCES[thresholdProfileFor(pondType)];
}

export function compareNormalReference(value: unknown, reference?: NormalReference | null): ReferenceComparison | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !reference ||
    !["kind", "boundary", "operator", "unit", "label"].every(key => Object.hasOwn(reference, key)) ||
    reference.kind !== "lower" || reference.operator !== "gt" || reference.unit !== "mg/L" ||
    !Number.isFinite(reference.boundary)) return null;
  return value > reference.boundary ? "within_reference" : "outside_reference";
}
