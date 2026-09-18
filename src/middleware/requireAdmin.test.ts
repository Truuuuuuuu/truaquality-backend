import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { prisma } from "../lib/prisma.ts";
import { requireAdmin } from "./requireAdmin.ts";
import { requireAuth } from "./requireAuth.ts";
import { makeJwt, nowSec, stubJwksFetch } from "../testing/jwt.ts";
import { fakeReq, run } from "../testing/http.ts";

// TEST-07: requireAdmin allows only systemRole ADMIN. requireAdmin.ts is untouched.

const DENIED = "admin access required";

function withProfile(systemRole: "USER" | "ADMIN"): Request {
  const req = fakeReq();
  req.profile = { id: "u1", systemRole, status: "ACTIVE" } as unknown as Request["profile"];
  return req;
}

test("no profile on the request -> 403 admin access required", async () => {
  const r = await run(requireAdmin, fakeReq());
  assert.equal(r.statusCode, 403);
  assert.equal(r.body?.error, DENIED);
  assert.equal(r.nextCalls, 0);
});

test("USER profile -> 403 admin access required", async () => {
  const r = await run(requireAdmin, withProfile("USER"));
  assert.equal(r.statusCode, 403);
  assert.equal(r.body?.error, DENIED);
  assert.equal(r.nextCalls, 0);
});

test("ADMIN profile -> next()", async () => {
  const r = await run(requireAdmin, withProfile("ADMIN"));
  assert.equal(r.nextCalls, 1);
  assert.equal(r.nextError, undefined, "must call next() with no error");
  // undefined, not 200: an allowed request must leave the response untouched.
  assert.equal(r.statusCode, undefined);
  assert.equal(r.body, undefined);
});

test("chained: valid token for an ACTIVE USER passes requireAuth, then requireAdmin denies", async (t) => {
  stubJwksFetch(t);
  const user = { id: "u1", email: "u1@example.test", fullName: "Test User", systemRole: "USER", status: "ACTIVE" };
  const findUnique = t.mock.fn(async () => user);
  const update = t.mock.fn(async () => user);
  t.mock.property(prisma, "profile", { findUnique, update } as never);

  const token = makeJwt({ sub: "u1", role: "authenticated", exp: nowSec() + 3600 });
  const req = fakeReq({ Authorization: `Bearer ${token}` });

  const auth = await run(requireAuth, req);
  assert.equal(auth.nextCalls, 1, "a valid USER token must pass requireAuth");
  assert.equal(auth.nextError, undefined, "requireAuth must not forward an error here");

  const admin = await run(requireAdmin, req);
  assert.equal(admin.statusCode, 403);
  assert.equal(admin.body?.error, DENIED);
  assert.equal(admin.nextCalls, 0);
});
