import type { NextFunction, Request, Response } from "express";
import { z, type ZodType } from "zod";

export function validate<T>(schema: ZodType<T>, source: "body" | "params" | "query" = "body") {
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
    // Express 5 makes req.query a read-only getter, so the parsed (coerced, defaulted) query goes here.
    if (source === "query") {
      res.locals.query = result.data;
    }
    next();
  };
}
