import type { NextFunction, Request, Response } from "express";

// Minimal Express req/res fakes for exercising middleware directly, without an HTTP server.

export function fakeReq(headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lower[key.toLowerCase()] = value;
  }
  return {
    headers: lower,
    header(name: string) {
      return lower[name.toLowerCase()];
    },
  } as unknown as Request;
}

export function fakeRes() {
  const out = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.statusCode = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, out };
}

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

export async function run(mw: Middleware, req: Request) {
  const { res, out } = fakeRes();
  let nextCalls = 0;
  const next: NextFunction = () => {
    nextCalls += 1;
  };
  await mw(req, res, next);
  return { statusCode: out.statusCode, body: out.body as { error?: string } | undefined, nextCalls, req };
}
