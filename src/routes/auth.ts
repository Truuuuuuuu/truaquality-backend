import { Router } from "express";
import { supabase } from "../lib/supabase.ts";
import { validate } from "../middleware/validate.ts";
import { loginSchema } from "../schemas/auth.ts";

export const authRouter = Router();

authRouter.post("/login", validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(error.status ?? 401).json({ error: error.message });
  }

  res.json({ user: data.user, session: data.session });
});
