import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

// Every limiter here is keyed by IP unless it says otherwise (the default keyGenerator), which only works because
// index.ts sets `trust proxy` to the real hop count — without it a deployed backend sees the
// proxy's address on every request and one attacker's attempts would lock out the whole office.

// Keyed by IP since login attempts aren't authenticated yet — there's no user identity to key on
// until a login succeeds.
//
// Only failed attempts count. BFAR staff share one office NAT address, so counting successes would let
// ten ordinary morning sign-ins lock everyone out for 15 minutes. A wrong password from Supabase comes
// back as a 4xx, which is what still gets counted. DELETE /me shares this bucket; a successful delete
// removes the account anyway, and wrong-password guesses still count.
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many login attempts, please try again later" },
});

// /auth/refresh is the only unauthenticated write path, and a refresh token is as good as a
// password until it expires. Looser than login because a signed-in browser refreshes on its own
// timer and several tabs can legitimately refresh at once.
export const refreshRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many refresh attempts, please try again later" },
});

// Invite and resend-invite each send a real email through Supabase's SMTP. Without a cap they're an
// email-bomb primitive: one admin session can flood a mailbox and burn the sending domain's
// reputation, which for a government system is hard to undo.
export const inviteEmailRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many invite emails sent, please try again later" },
});

// GET /health/db is unauthenticated and runs a real query through the pgbouncer transaction pooler on
// every hit. Without a cap, a tight polling loop (a misconfigured monitor, or someone just probing the
// open endpoint) can exhaust the pooler's limited connection slots on a small Supabase plan, starving
// every other request in the system of a database connection. The limit is generous relative to any
// real monitoring cadence, which checks on the order of once every 10-60 seconds, not a tight loop.
export const healthCheckRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many health checks, please try again later" },
});

// Limiters for authenticated routes run after requireAuth, so the caller's identity is known. Keying on
// it instead of the IP matters because the whole office shares one public address: an IP bucket would let
// one person's exports use up everyone else's allowance. Falls back to the IP (via ipKeyGenerator, which
// folds IPv6 addresses into their /56 so a client can't dodge the limit by rotating within its own range)
// only if a limiter is ever mounted ahead of requireAuth.
function userKey(req: Request) {
  return req.profile?.id ?? ipKeyGenerator(req.ip ?? "");
}

// Coarse per-IP backstop for every route, registered in index.ts after the health checks. Each
// authenticated request costs a Supabase getClaims plus a Profile lookup through the pgbouncer pooler
// before its handler runs, so one valid token in a tight loop can otherwise starve the pooler. Sized for
// a whole office behind one NAT address: the dashboard polls (30 s data, 15 s notifications) and several
// staff can have it open at once, so this is far above real use and only stops scripts.
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests, please try again later" },
});

// The most expensive endpoint in the API: up to 31 days of raw readings or 2 years of hourly rows built
// into an .xlsx while holding a pooler connection for the whole stream. Range checks bound one request's
// size, not how many run at once. A human generating reports, not a poller.
export const readingsExportRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many exports, please try again later" },
});

// Logout calls Supabase's admin API on every hit, so an unbounded loop makes us pay for upstream calls.
export const logoutRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many logout requests, please try again later" },
});

// Every rotation invalidates the field unit's signing key until it is re-provisioned by hand. An admin
// UI retry loop or a double-fired request would silently knock devices offline.
export const rotateSecretRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many secret rotations, please try again later" },
});

// GET /health touches nothing, so this is only a backstop against a flood; well above any uptime monitor.
export const healthRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many health checks, please try again later" },
});
