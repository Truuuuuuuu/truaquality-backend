import type { NextFunction, Request, Response } from "express";
import { z, type ZodType } from "zod";

export function validate<T>(schema: ZodType<T>, source: "body" | "params" = "body") {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        error: `invalid request ${source}`,
        details: z.flattenError(result.error).fieldErrors,
      });
    }
    if (source === "body") {
      req.body = result.data;
    }
    next();
  };
}
