import "./guardEnv.ts";
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
  // `responded` is what separates "sent 200" from "sent nothing". Seeding statusCode to 200 made those
  // two indistinguishable, so `assert.equal(r.statusCode, 200)` passed for a middleware that never
  // touched the response at all.
  const out = { statusCode: 200, body: undefined as unknown, responded: false };
  const res = {
    status(code: number) {
      out.statusCode = code;
      out.responded = true;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      out.responded = true;
      return res;
    },
  };
  return { res: res as unknown as Response, out };
}

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

export async function run(mw: Middleware, req: Request) {
  const { res, out } = fakeRes();
  let nextCalls = 0;
  let nextError: unknown;
  // next(err) is the Express idiom for "reject this request". Discarding the argument scored it the
  // same as a plain next(), so a requireAuth that switched to next(new UnauthorizedError()) would keep
  // `assert.equal(r.nextCalls, 1)` green while denying every request. Happy paths assert
  // nextError === undefined.
  const next: NextFunction = (err?: unknown) => {
    nextCalls += 1;
    if (err) nextError = err;
  };
  await mw(req, res, next);
  return {
    statusCode: out.responded ? out.statusCode : undefined,
    body: out.body as { error?: string } | undefined,
    nextCalls,
    nextError,
    req,
  };
}
