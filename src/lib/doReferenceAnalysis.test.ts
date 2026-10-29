import "../testing/guardEnv.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "./prisma.ts";
import { analyzePondRange } from "./pondAnalysis.ts";

const DAY = 86400000;
const NOW = new Date("2030-06-01T00:00:00Z");
const parameter = "dissolvedOxygen";
const pondId = "00000000-0000-4000-8000-000000000018";

for (const resolution of ["raw", "hour", "day"] as const) {
  test(`pond analysis wires ${resolution} reference basis and numeric previous change`, async (t) => {
    t.mock.method(Date, "now", () => NOW.getTime());
    const width = resolution === "raw" ? DAY : resolution === "hour" ? 3 * DAY : 100 * DAY;
    const from = new Date(NOW.getTime() - width);
    const current = [{parameter, min: 1, max: 8, sum: 18, count: 3}, {parameter, min: 5, max: 5, sum: 5, count: 1}];
    const previous = [{parameter, min: 3, max: 3, sum: 3, count: 1}];
    let calls = 0;
    if (resolution === "raw") {
      t.mock.property(prisma, "reading", {findMany: async () => ++calls === 1
        ? [6, 5].map(value => ({parameter, value, recordedAt: from}))
        : [{parameter, value: 3, recordedAt: new Date(from.getTime() - DAY)}]} as never);
    } else if (resolution === "hour") {
      t.mock.property(prisma, "readingHourly", {findMany: async () => (++calls === 1 ? current : previous)
        .map(row => ({...row, bucketStart: from}))} as never);
    } else {
      t.mock.property(prisma, "$queryRaw", (async () => (++calls === 1 ? current : previous)
        .map(row => ({...row, bucket: from}))) as never);
    }
    const result = await analyzePondRange({pondId, pondType: "BRACKISH", parameter, from, to: NOW, rolling: true});
    const analysis = result.parameters[parameter];
    assert.ok("referenceComparison" in analysis);
    assert.equal(calls, 2);
    assert.equal(analysis.referenceComparison.basis, resolution === "raw" ? "raw_samples" : "weighted_bucket_averages");
    assert.equal(analysis.referenceComparison.outsideShare, resolution === "raw" ? 0.5 : 0.25);
    assert.equal(analysis.previousAvg, 3);
    assert.equal(analysis.previousChange, analysis.avg - 3);
    assert.equal(analysis.worst, null); assert.equal(analysis.outOfRangeShare, null); assert.equal(analysis.trend, null);
    assert.match(analysis.summary, /Outside normal range:/);
    assert.match(analysis.summary, /Lowest DO:/);
    assert.match(analysis.summary, /Change versus the previous period: \+\d\.\d{2} mg\/L/);
    if (resolution !== "raw") assert.ok(analysis.summary.includes(`Approximate, based on ${resolution === "hour" ? "hourly" : "daily"} averages`));
    assert.doesNotMatch(JSON.stringify(result), /PHILMINAQ|assume all|applicability|improving|worsening|stable|rising|falling/);
  });
}

test("raw current range and retained hourly previous range preserve null versus numeric comparisons", async (t) => {
  t.mock.method(Date, "now", () => NOW.getTime());
  const from = new Date(NOW.getTime() - 29.5 * DAY);
  const to = new Date(from.getTime() + DAY);
  t.mock.property(prisma, "reading", {findMany: async () => [{parameter, value: 0, recordedAt: from}]} as never);
  let hours = 0;
  t.mock.property(prisma, "readingHourly", {findMany: async () => {
    hours++;
    return hours === 1 ? [{parameter, min: 2, max: 4, sum: 10, count: 4, bucketStart: new Date(from.getTime() - DAY)}] : [];
  }} as never);
  const args = {pondId, pondType: null, parameter, from, to, rolling: false};
  const first = (await analyzePondRange(args)).parameters[parameter];
  assert.equal(hours, 1); assert.equal(first.previousAvg, 2.5); assert.equal(first.previousChange, -2.5);
  assert.ok("referenceComparison" in first); assert.equal(first.referenceComparison.approximate, false);
  const empty = (await analyzePondRange(args)).parameters[parameter];
  assert.equal(empty.avg, 0); assert.equal(empty.previousAvg, null); assert.equal(empty.previousChange, null);
  assert.doesNotMatch(empty.summary, /Change versus the previous period/);
});
