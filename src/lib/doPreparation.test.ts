import "../testing/guardEnv.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable, Writable } from "node:stream";
import type { Response } from "express";
import ExcelJS from "exceljs";
import { createDoLocalFixture } from "../testing/doLocalDatabase.ts";
import { syntheticDoResolver, syntheticDoReport, DO_TEST_SECRET } from "../testing/doFixtures.ts";
import { signMessage, parseSignedMessage, isValidSignature, readingsTopic } from "./deviceMessages.ts";
import { ingestSchema } from "../schemas/ingest.ts";
import { createIngestSamples, ingestSamples } from "./ingest.ts";
import { createEvaluatePondAlerts, evaluatePondAlerts } from "./alerts.ts";
import { analyzePondRange, loadSeries } from "./pondAnalysis.ts";
import { streamReadingsExport } from "./readingsExport.ts";
import { prisma } from "./prisma.ts";

test("real disposable SQL: dummy signed DO reaches storage, history and numeric XLSX; production remains pending", async () => {
  const f = await createDoLocalFixture();
  try {
    const time = new Date(Date.now()-120000);
    const body = JSON.stringify(syntheticDoReport(6, "ok", time));
    const topic = readingsTopic(f.device.id);
    const signed = parseSignedMessage(Buffer.from(signMessage(DO_TEST_SECRET, topic, body)))!;
    assert.ok(isValidSignature(DO_TEST_SECRET, topic, signed.body, signed.signature));
    assert.equal(isValidSignature(DO_TEST_SECRET, topic+"tampered", signed.body, signed.signature), false);
    assert.equal(isValidSignature(DO_TEST_SECRET, topic, signed.body+" ", signed.signature), false);
    const message = ingestSchema.parse(JSON.parse(signed.body));
    const production = await ingestSamples(f.device, message, time);
    assert.equal(production.status, "stored");
    assert.equal(await prisma.reading.count({where: {pondId: f.pond.id, parameter: "dissolvedOxygen"}}), 0);
    const ingest = createIngestSamples({policyResolver: syntheticDoResolver, evaluateAlerts: createEvaluatePondAlerts({policyResolver: syntheticDoResolver})});
    await ingest(f.device, message, time);
    await ingest(f.device, message, time);
    assert.equal(await prisma.reading.count({where: {pondId: f.pond.id, parameter: "dissolvedOxygen"}}), 1);
    const from = new Date(time.getTime()-60000), to = new Date(time.getTime()+60000);
    const series = await loadSeries(f.pond.id, "dissolvedOxygen", from, to);
    assert.equal(series.resolution, "raw"); assert.equal(series.points[0].avg, 6);
    const analysis = await analyzePondRange({pondId: f.pond.id, pondType: "BRACKISH", from, to, rolling: false});
    assert.equal(analysis.parameters.dissolvedOxygen.worst, null);
    const chunks: Buffer[] = [];
    const sink = new Writable({write(chunk, _enc, cb) {chunks.push(Buffer.from(chunk)); cb();}});
    await streamReadingsExport(Object.assign(sink, {setHeader: () => {}}) as unknown as Response, {pond: f.pond, from, to, resolution: "raw", parameter: "dissolvedOxygen", analysis});
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.read(Readable.from(chunks));
    let numeric = false;
    workbook.getWorksheet("Readings")!.eachRow(row => row.eachCell(cell => {if (cell.value === 6) {numeric = true; assert.match(cell.numFmt, /0\.00/);}}));
    assert.ok(numeric);
  } finally {await f.cleanup(); await prisma.$disconnect();}
});

test("real disposable SQL: signed low, escalation, recovery, fault/missing, rejection and liveness chains", async () => {
  const f = await createDoLocalFixture();
  try {
    const active = await f.createProfile("ACTIVE");
    const inactive = await f.createProfile("DISABLED");
    const base = new Date(Date.now()-30*60000);
    const at = (seconds: number) => new Date(base.getTime()+seconds*1000);
    const ingest = createIngestSamples({policyResolver: syntheticDoResolver, evaluateAlerts: createEvaluatePondAlerts({policyResolver: syntheticDoResolver})});
    const send = async (value: number | undefined, seconds: number, status = "ok") => {
      const body = JSON.stringify(syntheticDoReport(value, status, at(seconds)));
      const topic = readingsTopic(f.device.id);
      const signed = parseSignedMessage(Buffer.from(signMessage(DO_TEST_SECRET, topic, body)))!;
      assert.ok(isValidSignature(DO_TEST_SECRET, topic, signed.body, signed.signature));
      const currentDevice = await prisma.device.findUniqueOrThrow({where: {id: f.device.id}});
      return ingest(currentDevice, ingestSchema.parse(JSON.parse(signed.body)), at(seconds));
    };
    await send(3, 0); await send(3, 30);
    const open = await prisma.alert.findFirstOrThrow({where: {pondId: f.pond.id, parameter: "dissolvedOxygen"}});
    assert.equal(open.severity, "WARNING");
    assert.equal(await prisma.notification.count({where: {alertId: open.id, profileId: active.id, kind: "ALERT_OPENED"}}), 1);
    assert.equal(await prisma.notification.count({where: {alertId: open.id, profileId: inactive.id}}), 0);
    await send(1, 60); await send(1, 90);
    assert.equal((await prisma.alert.findUniqueOrThrow({where: {id: open.id}})).severity, "CRITICAL");
    assert.equal(await prisma.notification.count({where: {alertId: open.id, profileId: active.id, kind: "ALERT_ESCALATED"}}), 1);
    await send(6, 120); await send(6, 150);
    // Pending default evaluator must preserve an already-running recovery and all notifications.
    const recovering = await prisma.alert.findUniqueOrThrow({where: {id: open.id}});
    assert.equal(recovering.nominalSince?.getTime(), at(120).getTime());
    const notified = await prisma.notification.count({where: {alertId: open.id}});
    await evaluatePondAlerts(f.pond.id, ["dissolvedOxygen"]);
    assert.deepEqual(await prisma.alert.findUniqueOrThrow({where: {id: open.id}}), recovering);
    assert.equal(await prisma.notification.count({where: {alertId: open.id}}), notified);
    await send(6, 180); await send(6, 210); await send(6, 240);
    const resolved = await prisma.alert.findUniqueOrThrow({where: {id: open.id}});
    assert.equal(resolved.resolvedAt?.getTime(), at(240).getTime());
    assert.equal(await prisma.notification.count({where: {alertId: open.id, profileId: active.id, kind: "ALERT_RESOLVED"}}), 1);
    assert.equal(await prisma.notification.count({where: {alertId: open.id, profileId: inactive.id}}), 0);
    const count = await prisma.reading.count({where: {pondId: f.pond.id, parameter: "dissolvedOxygen"}});
    await send(undefined, 270, "no_signal");
    const missing = {samples: [{recordedAt: at(300).toISOString(), values: {temperature: 25}}]};
    const current = await prisma.device.findUniqueOrThrow({where: {id: f.device.id}});
    await ingest(current, ingestSchema.parse(missing), at(300));
    assert.equal(await prisma.reading.count({where: {pondId: f.pond.id, parameter: "dissolvedOxygen"}}), count);
    const live = await prisma.device.findUniqueOrThrow({where: {id: f.device.id}});
    assert.equal(live.lastSeenAt?.getTime(), at(300).getTime());
    await send(6, 0); // Replayed old signed time cannot advance device liveness.
    assert.equal((await prisma.device.findUniqueOrThrow({where: {id: f.device.id}})).lastSeenAt?.getTime(), at(300).getTime());
    const tooOld = new Date(base.getTime()-8*86400000);
    const stale = await ingest(live, ingestSchema.parse({samples: [{recordedAt: tooOld.toISOString(), values: {dissolvedOxygen: 4}}]}), base);
    assert.ok(stale.status === "stored" && stale.rejected.length === 1);
    const future = new Date(Date.now()+6*60000);
    assert.equal(ingestSchema.safeParse(syntheticDoReport(6, "ok", future)).success, false);
    assert.equal(ingestSchema.safeParse({samples: [{recordedAt: "invalid", values: {dissolvedOxygen: 6}}]}).success, false);
    assert.equal(ingestSchema.safeParse({samples: [{recordedAt: at(300).toISOString(), values: {dissolvedOxygen: "6"}}]}).success, false);
    const invalidBounds = await send(21, 330);
    assert.ok(invalidBounds.status === "stored" && invalidBounds.rejected.some(r => r.parameter === "dissolvedOxygen"));
    assert.ok(await prisma.reading.count({where: {pondId: f.pond.id, parameter: "temperature"}}) > 0);
    await send(3, 400); await send(3, 600);
    assert.equal(await prisma.alert.count({where: {pondId: f.pond.id, parameter: "dissolvedOxygen", resolvedAt: null}}), 0, "gap breaks hold");
    await send(3, 630); await send(1, 660); await send(1, 690);
    const second = await prisma.alert.findFirstOrThrow({where: {pondId: f.pond.id, parameter: "dissolvedOxygen", resolvedAt: null}});
    await send(6, 720); await send(3, 750); await send(3, 780);
    assert.equal(await prisma.notification.count({where: {alertId: second.id, profileId: active.id, kind: "ALERT_OPENED"}}), 1, "repeat throttled before renotify interval");
    await send(6, 810); await send(3, 900); await send(3, 930);
    assert.equal(await prisma.notification.count({where: {alertId: second.id, profileId: active.id, kind: "ALERT_OPENED"}}), 2, "worsening after configured interval renotifies");
    assert.equal(await prisma.notification.count({where: {alertId: second.id, profileId: inactive.id}}), 0);
  } finally {await f.cleanup(); await prisma.$disconnect();}
});

test("real disposable SQL: hourly and daily history retain weighted DO and pending XLSX summaries", async () => {
  const f = await createDoLocalFixture();
  try {
    const to = new Date(Date.now());
    const bucket = new Date(Math.floor((to.getTime()-3*86400000)/3600000)*3600000);
    await prisma.readingHourly.createMany({data: [
      {pondId: f.pond.id, parameter: "dissolvedOxygen", bucketStart: bucket, min: 1, max: 6, sum: 8, count: 2},
      {pondId: f.pond.id, parameter: "dissolvedOxygen", bucketStart: new Date(bucket.getTime()+3600000), min: 7, max: 7, sum: 7, count: 1},
      {pondId: f.pond.id, parameter: "dissolvedOxygen", bucketStart: new Date(bucket.getTime()-2*86400000), min: 3, max: 3, sum: 6, count: 2},
    ]});
    const from = new Date(to.getTime()-4*86400000);
    const hour = await loadSeries(f.pond.id, "dissolvedOxygen", from, to);
    assert.equal(hour.resolution, "hour"); assert.equal(hour.points.length, 2);
    const analysis = await analyzePondRange({pondId: f.pond.id, pondType: "BRACKISH", from, to, rolling: false});
    assert.equal(analysis.parameters.dissolvedOxygen.avg, 5);
    assert.equal(analysis.parameters.dissolvedOxygen.min, 1);
    assert.equal(analysis.parameters.dissolvedOxygen.previousAvg, 3);
    assert.equal(analysis.parameters.dissolvedOxygen.outOfRangeShare, null);
    const daily = await loadSeries(f.pond.id, "dissolvedOxygen", new Date(to.getTime()-100*86400000), to);
    assert.equal(daily.resolution, "day");
    assert.equal(daily.points.reduce((s,p) => s+p.avg*p.count, 0)/daily.points.reduce((s,p) => s+p.count,0), 4.2);
    const chunks: Buffer[] = [];
    const sink = new Writable({write(chunk, _enc, cb) {chunks.push(Buffer.from(chunk)); cb();}});
    await streamReadingsExport(Object.assign(sink, {setHeader: () => {}}) as unknown as Response,
      {pond: f.pond, from, to, resolution: "hour", parameter: "dissolvedOxygen", analysis});
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.read(Readable.from(chunks));
    let numeric = false, pending = false;
    workbook.getWorksheet("Readings")!.eachRow(row => row.eachCell(cell => {if (cell.value === 4 || cell.value === 7) {numeric = true; assert.match(cell.numFmt, /0\.00/);}}));
    workbook.getWorksheet("Summary")!.eachRow(row => {if (row.getCell(1).value === "Dissolved oxygen (mg/L)") {
      pending = true; assert.equal(row.getCell(5).value, null); assert.equal(row.getCell(6).value, "Pending BFAR thresholds");
      assert.equal(row.getCell(7).value, "Not assessed");
    }});
    assert.ok(numeric && pending);
  } finally {await f.cleanup(); await prisma.$disconnect();}
});
