import { assertLocalDatabase } from "../src/testing/dbGuard.ts";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import type { Response } from "express";

export async function generateReview(outDir: string, now = new Date()) {
  // Guard before importing any module that can construct a database client. Never load dotenv.
  assertLocalDatabase(process.env);
  const allowed = path.resolve(import.meta.dirname, "../../frontend/review/do/generated");
  const out = path.resolve(outDir);
  if (out !== allowed && !out.startsWith(allowed + path.sep)) throw new Error("output must stay within frontend/review/do/generated");
  // Existing symlink parents cannot redirect writes outside the dedicated generated directory.
  for (let current = out; current !== path.dirname(current); current = path.dirname(current)) {
    const canonical = await realpath(current).catch(() => null);
    if (canonical && canonical !== current) throw new Error("symlink output paths are refused");
  }
  const [{createReviewScenario, REVIEW_SCENARIOS}, {streamReadingsExport}, {prisma}] = await Promise.all([
    import("../src/testing/doReviewFixtures.ts"), import("../src/lib/readingsExport.ts"), import("../src/lib/prisma.ts")]);
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const forbidden = () => { throw new Error("review generation attempted database access"); };
  // Even an accidental fallback in the real exporter must fail before any connection is attempted.
  for (const key of ["reading", "readingHourly", "$queryRaw", "$executeRaw", "$transaction"]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(prisma, key));
    Object.defineProperty(prisma, key, {configurable: true, value: key.startsWith("$") ? forbidden : new Proxy({}, {get: forbidden})});
  }
  try {
    await mkdir(out, {recursive: true});
    const scenarios = [];
    for (const id of REVIEW_SCENARIOS) {
      const scenario = createReviewScenario(id, now);
      const workbooks = [];
      for (const resolution of ["raw", "hour"] as const) for (const parameter of [undefined, "dissolvedOxygen"] as const) {
        const stream = new PassThrough();
        const chunks: Buffer[] = [];
        stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
        let disposition = "";
        const res = Object.assign(stream, {setHeader(name: string, value: string) {if (name === "Content-Disposition") disposition = value;}});
        const points = scenario.points.filter(p => !parameter || p.parameter === parameter).sort((a,b) => a.t.getTime() - b.t.getTime());
        await streamReadingsExport(res as unknown as Response, {pond: scenario.pond, parameter,
          from: scenario.analyses.raw.from, to: now, resolution, analysis: scenario.analyses[resolution]}, {
          dataOrigin: "simulated", async *rawRows() {for (const p of points) yield {parameter: p.parameter, value: p.avg, recordedAt: p.t};},
          async *hourlyRows() {for (const p of points) {const index = scenario.points.indexOf(p); const count = Math.floor(index / (id === "never-reported" ? 3 : 4)) % 2 ? 1 : 9; yield {parameter: p.parameter, sum: p.avg * count, count, bucketStart: p.t};}},
        });
        const bytes = Buffer.concat(chunks);
        const filename = `${id}-${resolution}-${parameter ?? "all"}.xlsx`;
        await writeFile(path.join(out, filename), bytes);
        workbooks.push({file: filename, filename: /filename="([^"]+)"/.exec(disposition)![1], resolution, parameter: parameter ?? null,
          dataOrigin: "simulated", base64: bytes.toString("base64")});
      }
      scenarios.push({...scenario, workbooks});
    }
    const manifest = {version: 1, dataOrigin: "simulated", generatedAt: now.toISOString(),
      basis: {raw: "raw_samples", hour: "weighted_bucket_averages", day: "weighted_bucket_averages"}, scenarios};
    await writeFile(path.join(out, "fixtures.json"), JSON.stringify(manifest));
    return manifest;
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(prisma, key, descriptor); else Reflect.deleteProperty(prisma, key);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== "--out-dir") throw new Error("usage: create-do-review-fixtures.ts --out-dir <frontend/review/do/generated>");
  const result = await generateReview(process.argv[3]!);
  console.log(`[do-review] generated ${result.scenarios.length} simulated scenarios`);
}
