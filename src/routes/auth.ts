import { Router } from "express";
import { supabase } from "../lib/supabase.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { loginRateLimit, logoutRateLimit, refreshRateLimit } from "../middleware/loginRateLimit.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { validate } from "../middleware/validate.ts";
import { loginSchema, refreshSchema } from "../schemas/auth.ts";

export const authRouter = Router();

authRouter.post("/login", loginRateLimit, validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(error.status ?? 401).json({ error: error.message });
  }

  res.json({ user: data.user, session: data.session });
});

authRouter.post("/refresh", refreshRateLimit, validate(refreshSchema), async (req, res) => {
  const { refreshToken } = req.body;

  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (error) {
    return res.status(error.status ?? 401).json({ error: error.message });
  }

  res.json({ user: data.user, session: data.session });
});

// Scope "global" revokes every refresh token for this user, signing them out on all devices, not
// just this one. Simpler semantics for a single-device capstone than tracking per-session scope.
authRouter.post("/logout", requireAuth, logoutRateLimit, async (req, res) => {
  const { error } = await supabaseAdmin.auth.admin.signOut(req.token!, "global");
  if (error) {
    return res.status(error.status ?? 502).json({ error: error.message });
  }
  res.status(204).end();
});
