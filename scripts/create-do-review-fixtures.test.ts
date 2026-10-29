import "../src/testing/guardEnv.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, realpath, symlink, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Socket } from "node:net";
import { spawnSync } from "node:child_process";
import ExcelJS from "exceljs";
import { generateReview } from "./create-do-review-fixtures.ts";

const frontend = path.resolve(import.meta.dirname, "../../frontend");
const output = path.join(frontend, "review/do/generated");

test("review generation refuses remote configuration before builder/client imports", () => {
  for (const extra of [{DATABASE_URL: "postgresql://not-real@remote.invalid/db"}, {MQTT_URL: "mqtts://remote.invalid"}]) {
    const result = spawnSync(process.execPath, ["--env-file=test.env", "scripts/create-do-review-fixtures.ts", "--out-dir", output], {
      cwd: path.resolve(import.meta.dirname, ".."), env: {...process.env, ...extra}, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test-guard.*refusing/);
  }
});

test("review output refuses traversal, external paths and symlink redirection", async () => {
  await assert.rejects(generateReview("/private/tmp/do-review-refused"), /output must stay/);
  await assert.rejects(generateReview(path.join(output, "../escaped")), /output must stay/);
  await mkdir(output, {recursive: true});
  const link = path.join(output, "refused-symlink");
  await symlink(await realpath("/private/tmp"), link);
  try { await assert.rejects(generateReview(path.join(link, "escape")), /symlink/); }
  finally { await rm(link); }
});

test("generated production-builder scenarios and real workbooks need no database or network", async t => {
  let networkCalls = 0;
  t.mock.method(Socket.prototype, "connect", () => {networkCalls++; throw new Error("forbidden network access");});
  t.mock.method(globalThis, "fetch", () => {networkCalls++; throw new Error("forbidden fetch");});
  const fixture = await generateReview(output, new Date());
  assert.equal(networkCalls, 0);
  assert.equal(fixture.dataOrigin, "simulated");
  assert.equal(fixture.scenarios.length, 23);
  assert.doesNotMatch(JSON.stringify(fixture), /PHILMINAQ|assume all|applicability/);
  for (const scenario of fixture.scenarios) {
    assert.equal(scenario.pond.parameterMetadata.dissolvedOxygen.ingest.state, "pending");
    assert.equal(scenario.pond.parameterMetadata.dissolvedOxygen.assessment.state, "pending");
    assert.equal(Object.hasOwn(scenario.pond.thresholds, "dissolvedOxygen"), false);
    assert.equal(Object.hasOwn(scenario.pond.heldSeverity, "dissolvedOxygen"), false);
    const analysis = scenario.analyses.hour.parameters.dissolvedOxygen;
    if (analysis) {
      assert.equal(analysis.worst, null); assert.equal(analysis.outOfRangeShare, null); assert.equal(analysis.trend, null);
      assert.ok("referenceComparison" in analysis); assert.equal(analysis.referenceComparison.approximate, true);
    }
    assert.equal(scenario.workbooks.length, 4);
  }
  const get = (id: string) => fixture.scenarios.find(s => s.id === id)!;
  assert.equal(get("equal").pond.referenceComparison.dissolvedOxygen!.result, "outside_reference");
  assert.equal(get("above").pond.referenceComparison.dissolvedOxygen!.result, "within_reference");
  assert.equal(Object.hasOwn(get("never-reported").pond.latest, "dissolvedOxygen"), false);
  assert.equal(Object.hasOwn(get("never-reported").pond.sensorStatus, "dissolvedOxygen"), false);
  assert.equal(get("previous-missing").analyses.raw.parameters.dissolvedOxygen!.previousAvg, null);
  for (const workbook of get("above").workbooks) {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(workbook.base64, "base64") as never);
    assert.ok(workbook.filename.startsWith("Simulated-data-"));
    assert.equal(book.worksheets.length, 2);
    for (const sheet of book.worksheets) assert.equal(sheet.getCell("A1").value, "Simulated data");
    const values: unknown[] = [];
    for (const row of book.getWorksheet("Readings")!.getRows(1, 100) ?? []) row.eachCell(cell => {if (cell.numFmt?.includes("mg/L")) values.push(cell.value);});
    assert.ok(values.includes(0)); assert.ok(values.includes(5)); assert.ok(values.includes(7.23));
    assert.ok(values.every(value => typeof value === "number"));
    assert.doesNotMatch(JSON.stringify(book.model), /PHILMINAQ|assume all|applicability/);
    const disk = await readFile(path.join(output, workbook.file));
    assert.ok(disk.equals(Buffer.from(workbook.base64, "base64")));
  }
});

test("review isolation configuration excludes environment loading, production entry changes and live adapters", async () => {
  const config = await readFile(path.join(frontend, "vite.do-review.config.ts"), "utf8");
  assert.match(config, /envDir: false/); assert.match(config, /envPrefix: \[\]/);
  assert.match(config, /host: "127.0.0.1"/); assert.match(config, /port: 5175/); assert.match(config, /strictPort: true/);
  assert.match(config, /hmr: false/); assert.doesNotMatch(config, /loadEnv|proxy:/);
  assert.match(config, /offline-review-dev-client/);
  for (const target of ["@/context/auth-context", "@/lib/api", "@/lib/supabase"]) assert.ok(config.includes(target));
  const main = await readFile(path.join(frontend, "review/do/main.tsx"), "utf8");
  assert.ok(main.includes('import "./style.css"'));
  const css = await readFile(path.join(frontend, "review/do/style.css"), "utf8");
  assert.ok(css.includes('@source "../../src"'));
  for (const text of ["Simulated data", "window.fetch", "window.XMLHttpRequest", "window.WebSocket", "window.EventSource", "navigator.sendBeacon"]) assert.ok(main.includes(text));
  const html = await readFile(path.join(frontend, "review/do/index.html"), "utf8");
  assert.ok(html.includes("connect-src 'none'"));
  for (const file of ["src/main.tsx", "src/App.tsx", "src/context/auth-context.tsx", "vite.config.ts"]) {
    assert.doesNotMatch(await readFile(path.join(frontend, file), "utf8"), /review\/do|do-review|Simulated data/);
  }
  const adapter = await readFile(path.join(frontend, "review/do/api.ts"), "utf8");
  assert.doesNotMatch(adapter, /fetch\(|localStorage|sessionStorage/);
  assert.match(adapter, /new Blob/);
  const production = await readFile(path.join(frontend, "src/lib/api.ts"), "utf8");
  for (const match of production.matchAll(/^export (?:async )?function (\w+)/gm)) {
    if (match[1] === "errorMessage") continue;
    assert.ok(adapter.includes(`export const ${match[1]}:`), `${match[1]} must have an explicit local override`);
  }
});
