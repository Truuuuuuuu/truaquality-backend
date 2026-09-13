import { Router } from "express";
import { supabase } from "../lib/supabase.ts";

export const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "email and password are required" });
  }

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    return res.status(error.status ?? 400).json({ error: error.message });
  }

  res.status(201).json({ user: data.user, session: data.session });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "email and password are required" });
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(error.status ?? 401).json({ error: error.message });
  }

  res.json({ user: data.user, session: data.session });
});
