import type { NextFunction, Request, Response } from "express";

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.profile?.systemRole !== "ADMIN") {
    return res.status(403).json({ error: "admin access required" });
  }
  next();
}
