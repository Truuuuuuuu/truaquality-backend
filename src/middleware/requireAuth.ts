import type { NextFunction, Request, Response } from "express";
import type { JwtPayload } from "@supabase/supabase-js";
import type { Profile } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { supabase } from "../lib/supabase.ts";

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      profile?: Profile;
      token?: string;
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

  // Checked on every request so disabling a user takes effect before their JWT expires.
  let profile = await prisma.profile.findUnique({ where: { id: data.claims.sub } });
  if (!profile || profile.status === "DISABLED" || profile.status === "DELETED") {
    return res.status(403).json({ error: "account is not provisioned or has been disabled" });
  }

  if (profile.status === "INVITED") {
    profile = await prisma.profile.update({ where: { id: profile.id }, data: { status: "ACTIVE" } });
  }

  req.user = data.claims;
  req.profile = profile;
  req.token = token;
  next();
}
