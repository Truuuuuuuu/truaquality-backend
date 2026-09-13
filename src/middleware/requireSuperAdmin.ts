import type { NextFunction, Request, Response } from "express";

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.profile?.systemRole !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "super admin access required" });
  }
  next();
}
