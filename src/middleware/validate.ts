import type { NextFunction, Request, Response } from "express";
import { z, type ZodType } from "zod";

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "invalid request body",
        details: z.flattenError(result.error).fieldErrors,
      });
    }
    req.body = result.data;
    next();
  };
}
