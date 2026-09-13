import type { NextFunction, Request, Response } from "express";
import type { JwtPayload } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase.ts";

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

  if (!token) {
    return res.status(401).json({ error: "missing bearer token" });
  }

  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data) {
    return res.status(401).json({ error: "invalid or expired token" });
  }

  req.user = data.claims;
  next();
}
