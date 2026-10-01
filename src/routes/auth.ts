import { Router } from "express";
import { supabase } from "../lib/supabase.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { loginRateLimit, logoutRateLimit, refreshRateLimit } from "../middleware/loginRateLimit.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { validate } from "../middleware/validate.ts";
import { loginSchema, refreshSchema } from "../schemas/auth.ts";

export const authRouter = Router();

// Supabase's error text and full user object never reach the client. The text varies with the cause (and with
// Supabase versions), which helps an attacker tell accounts and failure modes apart; the user object carries
// identities, metadata and timestamps the frontend never reads. The real error is logged server-side instead
// (message only — never a token or password). Upstream trouble (no status, 429 = Supabase's own rate limit on our
// project, or 5xx) is a 502 so the user sees "unavailable" rather than "wrong password"; every other failure is a
// plain 401, which is still a 4xx so loginRateLimit keeps counting it as a failed attempt.
function isUpstreamFailure(status: number | undefined) {
  return status === undefined || status === 429 || status >= 500;
}

function sessionBody(session: { access_token: string; refresh_token: string; expires_at?: number }) {
  return {
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    },
  };
}

authRouter.post("/login", loginRateLimit, validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error("[auth] login failed:", error.status, error.code, error.message);
    if (isUpstreamFailure(error.status)) {
      return res.status(502).json({ error: "authentication service unavailable" });
    }
    // A disabled account (admin.ts bans it in Supabase) keeps its own answer so the login page can tell the user
    // to contact an administrator instead of retyping a correct password.
    if (error.code === "user_banned") {
      return res.status(403).json({ error: "account disabled" });
    }
    return res.status(401).json({ error: "invalid email or password" });
  }

  res.json(sessionBody(data.session));
});

authRouter.post("/refresh", refreshRateLimit, validate(refreshSchema), async (req, res) => {
  const { refreshToken } = req.body;

  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    console.error("[auth] refresh failed:", error?.status, error?.code, error?.message ?? "no session returned");
    if (error && isUpstreamFailure(error.status)) {
      return res.status(502).json({ error: "authentication service unavailable" });
    }
    return res.status(401).json({ error: "invalid or expired session" });
  }

  res.json(sessionBody(data.session));
});

// Scope "global" revokes every refresh token for this user, signing them out on all devices, not
// just this one. Simpler semantics for a single-device capstone than tracking per-session scope.
authRouter.post("/logout", requireAuth, logoutRateLimit, async (req, res) => {
  const { error } = await supabaseAdmin.auth.admin.signOut(req.token!, "global");
  if (error) {
    console.error("[auth] sign-out failed:", error.status, error.code, error.message);
    return res.status(502).json({ error: "sign-out failed" });
  }
  res.status(204).end();
});
