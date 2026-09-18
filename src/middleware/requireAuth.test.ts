import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "./requireAuth.ts";
import { b64urlJson, makeJwt, nowSec, otherPrivateKey, stubJwksFetch } from "../testing/jwt.ts";
import { fakeReq, run } from "../testing/http.ts";

// TEST-07: the real supabase.auth.getClaims runs its real expiry and ES256 signature checks against a
// JWKS served by the fetch stub; only prisma.profile is replaced. requireAuth.ts itself is untouched.

type Status = "INVITED" | "ACTIVE" | "DISABLED" | "DELETED";

const NOT_PROVISIONED = "account is not provisioned or has been disabled";
const INVALID = "invalid or expired token";
const MISSING = "missing bearer token";
const SUPABASE_ORIGIN = new URL(process.env.SUPABASE_URL!).origin;

function profile(status: Status, systemRole: "USER" | "ADMIN" = "USER") {
  return { id: "u1", email: "u1@example.test", fullName: "Test User", systemRole, status };
}

// Installs the JWKS stub and a fake prisma.profile for one test. `scenario` is what findUnique returns.
function setup(t: TestContext, scenario: ReturnType<typeof profile> | null) {
  const fetchMock = stubJwksFetch(t);
  const findUnique = t.mock.fn(async (_args: unknown) => scenario);
  const update = t.mock.fn(async (args: { data: Record<string, unknown> }) => ({ ...scenario, ...args.data }));
  t.mock.property(prisma, "profile", { findUnique, update } as never);
  return { fetchMock, findUnique, update };
}

// Every fetch the auth client made must have gone to the local stubbed Supabase URL, never elsewhere.
function assertOnlyLocalFetches(fetchMock: ReturnType<typeof stubJwksFetch>) {
  for (const call of fetchMock.mock.calls) {
    const arg = call.arguments[0] as string | URL | Request;
    const url = arg instanceof Request ? arg.url : String(arg);
    assert.equal(new URL(url).origin, SUPABASE_ORIGIN, `unexpected fetch to ${url}`);
  }
}

function validToken(extra: Record<string, unknown> = {}) {
  return makeJwt({ sub: "u1", role: "authenticated", exp: nowSec() + 3600, ...extra });
}

test("no Authorization header -> 401 missing bearer token", async (t) => {
  const { fetchMock, findUnique } = setup(t, profile("ACTIVE"));
  const r = await run(requireAuth, fakeReq());
  assert.equal(r.statusCode, 401);
  assert.equal(r.body?.error, MISSING);
  assert.equal(r.nextCalls, 0);
  assert.equal(findUnique.mock.callCount(), 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("Basic scheme -> 401 missing bearer token", async (t) => {
  const { findUnique } = setup(t, profile("ACTIVE"));
  const r = await run(requireAuth, fakeReq({ Authorization: "Basic xyz" }));
  assert.equal(r.statusCode, 401);
  assert.equal(r.body?.error, MISSING);
  assert.equal(r.nextCalls, 0);
  assert.equal(findUnique.mock.callCount(), 0);
});

test("empty Bearer token -> 401 missing bearer token", async (t) => {
  const { findUnique } = setup(t, profile("ACTIVE"));
  const r = await run(requireAuth, fakeReq({ Authorization: "Bearer " }));
  assert.equal(r.statusCode, 401);
  assert.equal(r.body?.error, MISSING);
  assert.equal(r.nextCalls, 0);
  assert.equal(findUnique.mock.callCount(), 0);
});

test("valid token for an ACTIVE profile -> next() with user, profile, token attached", async (t) => {
  const { fetchMock, findUnique, update } = setup(t, profile("ACTIVE"));
  const token = validToken();
  const r = await run(requireAuth, fakeReq({ Authorization: `Bearer ${token}` }));
  assert.equal(r.nextCalls, 1);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, undefined);
  assert.equal(r.req.user?.sub, "u1");
  assert.equal(r.req.profile?.id, "u1");
  assert.equal(r.req.token, token);
  assert.equal(findUnique.mock.callCount(), 1);
  assert.deepEqual(findUnique.mock.calls[0]!.arguments[0], { where: { id: "u1" } });
  assert.equal(update.mock.callCount(), 0);
  assertOnlyLocalFetches(fetchMock);
});

test("valid token for an INVITED profile -> promoted to ACTIVE exactly once and allowed", async (t) => {
  const { fetchMock, update } = setup(t, profile("INVITED"));
  const r = await run(requireAuth, fakeReq({ Authorization: `Bearer ${validToken()}` }));
  assert.equal(r.nextCalls, 1);
  assert.equal(update.mock.callCount(), 1);
  assert.deepEqual(update.mock.calls[0]!.arguments[0], { where: { id: "u1" }, data: { status: "ACTIVE" } });
  assert.equal(r.req.profile?.status, "ACTIVE");
  assertOnlyLocalFetches(fetchMock);
});

test("expired token -> 401 invalid or expired token, profile never queried", async (t) => {
  const { fetchMock, findUnique } = setup(t, profile("ACTIVE"));
  const token = validToken({ exp: nowSec() - 10 });
  const r = await run(requireAuth, fakeReq({ Authorization: `Bearer ${token}` }));
  assert.equal(r.statusCode, 401);
  assert.equal(r.body?.error, INVALID);
  assert.equal(r.nextCalls, 0);
  assert.equal(findUnique.mock.callCount(), 0);
  assertOnlyLocalFetches(fetchMock);
});

test("wrong signing key (same kid) -> 401, profile never queried", async (t) => {
  const { fetchMock, findUnique } = setup(t, profile("ACTIVE"));
  const token = makeJwt({ sub: "u1", role: "authenticated", exp: nowSec() + 3600 }, { key: otherPrivateKey });
  const r = await run(requireAuth, fakeReq({ Authorization: `Bearer ${token}` }));
  assert.equal(r.statusCode, 401);
  assert.equal(r.body?.error, INVALID);
  assert.equal(r.nextCalls, 0);
  assert.equal(findUnique.mock.callCount(), 0);
  assertOnlyLocalFetches(fetchMock);
});

test("tampered payload with original signature -> 401, profile never queried", async (t) => {
  const { fetchMock, findUnique } = setup(t, profile("ACTIVE", "ADMIN"));
  const [header, , signature] = validToken().split(".");
  const forged = `${header}.${b64urlJson({ sub: "admin", role: "authenticated", exp: nowSec() + 3600 })}.${signature}`;
  const r = await run(requireAuth, fakeReq({ Authorization: `Bearer ${forged}` }));
  assert.equal(r.statusCode, 401);
  assert.equal(r.body?.error, INVALID);
  assert.equal(r.nextCalls, 0);
  assert.equal(findUnique.mock.callCount(), 0);
  assertOnlyLocalFetches(fetchMock);
});

test("malformed token -> 401 invalid or expired token", async (t) => {
  const { fetchMock, findUnique } = setup(t, profile("ACTIVE"));
  const r = await run(requireAuth, fakeReq({ Authorization: "Bearer not-a-jwt" }));
  assert.equal(r.statusCode, 401);
  assert.equal(r.body?.error, INVALID);
  assert.equal(r.nextCalls, 0);
  assert.equal(findUnique.mock.callCount(), 0);
  assertOnlyLocalFetches(fetchMock);
});

test("HS256 token with no kid -> 401 (no symmetric-token acceptance without the Auth server)", async (t) => {
  // getClaims falls back to getUser(token) for HS256/no-kid tokens; that hits the stub's 500 for any
  // non-JWKS URL, so this pins that such a token is never accepted locally.
  const { fetchMock, findUnique } = setup(t, profile("ACTIVE"));
  const token = makeJwt({ sub: "u1", role: "authenticated", exp: nowSec() + 3600 }, { alg: "HS256", kid: null });
  const r = await run(requireAuth, fakeReq({ Authorization: `Bearer ${token}` }));
  assert.equal(r.statusCode, 401);
  assert.equal(r.body?.error, INVALID);
  assert.equal(r.nextCalls, 0);
  assert.equal(findUnique.mock.callCount(), 0);
  assertOnlyLocalFetches(fetchMock);
});

test("valid token but no profile -> 403 not provisioned", async (t) => {
  const { update } = setup(t, null);
  const r = await run(requireAuth, fakeReq({ Authorization: `Bearer ${validToken()}` }));
  assert.equal(r.statusCode, 403);
  assert.equal(r.body?.error, NOT_PROVISIONED);
  assert.equal(r.nextCalls, 0);
  assert.equal(update.mock.callCount(), 0);
});

test("valid token for a DISABLED profile -> 403", async (t) => {
  const { update } = setup(t, profile("DISABLED"));
  const r = await run(requireAuth, fakeReq({ Authorization: `Bearer ${validToken()}` }));
  assert.equal(r.statusCode, 403);
  assert.equal(r.body?.error, NOT_PROVISIONED);
  assert.equal(r.nextCalls, 0);
  assert.equal(update.mock.callCount(), 0);
  assert.equal(r.req.profile, undefined);
});

test("valid token for a DELETED profile -> 403", async (t) => {
  const { update } = setup(t, profile("DELETED"));
  const r = await run(requireAuth, fakeReq({ Authorization: `Bearer ${validToken()}` }));
  assert.equal(r.statusCode, 403);
  assert.equal(r.body?.error, NOT_PROVISIONED);
  assert.equal(r.nextCalls, 0);
  assert.equal(update.mock.callCount(), 0);
});
