import { rateLimit } from "express-rate-limit";

// Every limiter here is keyed by IP (the default keyGenerator), which only works because
// index.ts sets `trust proxy` to the real hop count — without it a deployed backend sees the
// proxy's address on every request and one attacker's attempts would lock out the whole office.

// Keyed by IP since login attempts aren't authenticated yet — there's no user identity to key on
// until a login succeeds.
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
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
