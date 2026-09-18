import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { fakeReq, run } from "./http.ts";

// Tests OF the middleware harness. Every auth test's verdict is whatever run() reports, so the three
// outcomes it has to keep apart — allowed, rejected with a response, rejected via next(err) — are
// pinned here rather than assumed.

test("a middleware that only calls next() reports no response at all", async () => {
  const r = await run((_req, _res, next) => next(), fakeReq());
  assert.equal(r.nextCalls, 1);
  assert.equal(r.nextError, undefined);
  // Not 200: nothing was sent. The helper used to seed 200, which made the two indistinguishable.
  assert.equal(r.statusCode, undefined);
  assert.equal(r.body, undefined);
});

test("a middleware that responds 200 is distinguishable from one that responds nothing", async () => {
  const r = await run((_req, res) => res.status(200).json({ ok: true }), fakeReq());
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(r.nextCalls, 0);
});

test("res.json() without a status still counts as a response", async () => {
  const r = await run((_req, res) => res.json({ ok: true }), fakeReq());
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true });
});

test("next(err) is reported as an error, not scored the same as next()", async () => {
  const boom = new Error("denied");
  const r = await run((_req, _res, next) => next(boom), fakeReq());
  assert.equal(r.nextCalls, 1);
  // Without this, a requireAuth that switched to next(new UnauthorizedError()) would keep every
  // `assert.equal(r.nextCalls, 1)` green while denying the request.
  assert.equal(r.nextError, boom);
  assert.equal(r.statusCode, undefined);
});

test("a rejecting middleware sends the response it wrote and reports its status", async () => {
  const r = await run((_req, res) => res.status(403).json({ error: "nope" }), fakeReq());
  assert.equal(r.statusCode, 403);
  assert.deepEqual(r.body, { error: "nope" });
  assert.equal(r.nextCalls, 0);
  assert.equal(r.nextError, undefined);
});

test("an async middleware is awaited before the result is read", async () => {
  const mw = async (_req: Request, res: Response, _next: NextFunction) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    res.status(401).json({ error: "late" });
  };
  const r = await run(mw, fakeReq());
  assert.equal(r.statusCode, 401);
});

test("fakeReq lowercases header names for req.header()", () => {
  const req = fakeReq({ Authorization: "Bearer x" });
  assert.equal(req.header("authorization"), "Bearer x");
  assert.equal(req.header("AUTHORIZATION"), "Bearer x");
});
