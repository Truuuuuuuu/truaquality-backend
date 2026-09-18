import "./guardEnv.ts";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { TestContext } from "node:test";

// Test-only ES256 signing material. Real tokens are minted with this key and verified by the real
// supabase.auth.getClaims, which fetches the matching JWKS through the stubbed globalThis.fetch below.
export const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

export const KID = "test-kid";

export const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };

// A second keypair for the wrong-key case: signed under the same kid, so only the signature differs.
export const otherPrivateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function makeJwt(
  claims: Record<string, unknown>,
  opts: { kid?: string | null; key?: KeyObject; alg?: string } = {},
): string {
  const header: Record<string, unknown> = { alg: opts.alg ?? "ES256", typ: "JWT" };
  if (opts.kid !== null) {
    header.kid = opts.kid ?? KID;
  }
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: opts.key ?? privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function b64urlJson(value: unknown): string {
  return b64url(value);
}

// Install in EVERY test, not once per file: auth-js caches the JWKS process-globally after the first
// fetch, and t.mock auto-restores fetch after each test, so a test relying on an earlier test's stub
// would silently depend on ordering (Pitfall 7). Any URL other than the JWKS endpoint gets a 500, so
// nothing ever reaches the real network (including getUser's fallback for HS256/no-kid tokens).
export function stubJwksFetch(t: TestContext) {
  return t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url instanceof Request ? url.url : url).endsWith("/.well-known/jwks.json")) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  });
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
