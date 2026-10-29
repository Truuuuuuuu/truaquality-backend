import "../testing/guardEnv.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDoLocalFixture } from "../testing/doLocalDatabase.ts";
import { prisma } from "./prisma.ts";
import { runReadingRollupCycle } from "./readingRollup.ts";

test("real disposable SQL: DO rollup aggregates, recomputes late arrivals and excludes current hour", async () => {
  const f = await createDoLocalFixture();
  try {
    const hour = new Date(Math.floor(Date.now()/3600000)*3600000);
    const bucket = new Date(hour.getTime()-3600000);
    const row = (parameter: string, value: number, offset: number) => ({pondId: f.pond.id, deviceId: f.device.id, parameter, value, recordedAt: new Date(bucket.getTime()+offset)});
    await prisma.reading.createMany({data: [row("dissolvedOxygen", 2, 1000), row("dissolvedOxygen", 6, 2000), row("temperature", 25, 1000), row("dissolvedOxygen", 9, 3601000)]});
    await runReadingRollupCycle();
    const lookup = () => prisma.readingHourly.findFirstOrThrow({where: {pondId: f.pond.id, parameter: "dissolvedOxygen", bucketStart: bucket}});
    const initial = await lookup();
    assert.deepEqual({sum: initial.sum, count: initial.count, min: initial.min, max: initial.max}, {sum: 8, count: 2, min: 2, max: 6});
    await runReadingRollupCycle(); assert.deepEqual(await lookup(), initial);
    await prisma.reading.create({data: row("dissolvedOxygen", 1, 3000)});
    await runReadingRollupCycle();
    const late = await lookup(); assert.equal(late.sum, 9); assert.equal(late.count, 3); assert.equal(late.min, 1);
    assert.equal(await prisma.readingHourly.count({where: {pondId: f.pond.id, bucketStart: hour}}), 0);
    assert.equal(await prisma.readingHourly.count({where: {pondId: f.pond.id, parameter: "temperature"}}), 1);
  } finally {await f.cleanup(); await prisma.$disconnect();}
});
