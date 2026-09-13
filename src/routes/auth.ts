import { Router } from "express";
import { supabase } from "../lib/supabase.ts";
import { validateBody } from "../middleware/validate.ts";
import { loginSchema, signupSchema } from "../schemas/auth.ts";

export const authRouter = Router();

authRouter.post("/signup", validateBody(signupSchema), async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    return res.status(error.status ?? 400).json({ error: error.message });
  }

  res.status(201).json({ user: data.user, session: data.session });
});

authRouter.post("/login", validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(error.status ?? 401).json({ error: error.message });
  }

  res.json({ user: data.user, session: data.session });
});
