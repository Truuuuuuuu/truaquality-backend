import { rateLimit } from "express-rate-limit";

// Keyed by IP (the default keyGenerator) since login attempts aren't authenticated yet — there's
// no user identity to key on until a login succeeds.
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many login attempts, please try again later" },
});
