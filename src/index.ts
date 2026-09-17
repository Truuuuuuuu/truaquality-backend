import "dotenv/config";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { prisma } from "./lib/prisma.ts";
import { healthCheckRateLimit } from "./middleware/loginRateLimit.ts";
import { adminRouter } from "./routes/admin.ts";
import { authRouter } from "./routes/auth.ts";
import { meRouter } from "./routes/me.ts";
import { startDeviceWatchdog } from "./lib/deviceWatchdog.ts";
import { startReadingRollup } from "./lib/readingRollup.ts";
import { startReadingsSubscriber } from "./lib/readingsSubscriber.ts";
import { devicesRouter } from "./routes/devices.ts";
import { notificationsRouter } from "./routes/notifications.ts";
import { pondsRouter } from "./routes/ponds.ts";

const app = express();
const port = process.env.PORT ?? 3000;

// How many reverse proxies sit in front of this process, so express-rate-limit keys on the client's
// real address instead of the proxy's. Without it every request behind a PaaS router looks like one
// IP and the login limiter locks out the whole office at once. Never set this to `true` — that
// trusts the whole X-Forwarded-For chain, letting a client forge an address and skip the limiter
// entirely. 0 (the default here) is correct for running directly on localhost.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 0));

// Baseline security headers (nosniff, HSTS, frame-ancestors, referrer policy) and, importantly,
// removes Express's X-Powered-By. This is a JSON API with no HTML of its own, so helmet's defaults
// need no relaxing.
app.use(helmet());

// Comma-separated list of allowed browser origins, e.g. "http://localhost:5173,https://app.example.com".
const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    allowedHeaders: ["Content-Type", "Authorization"],
    // Without this, the browser blocks script access to this header on a cross-origin response (it's not
    // one of the CORS-safelisted ones) — the frontend's readings-export download would silently fall back
    // to a generic filename instead of the one the server names in Content-Disposition.
    exposedHeaders: ["Content-Disposition"],
  }),
);
// Explicit rather than relying on body-parser's default, so the ceiling is visible and can't drift
// underneath us. Nothing this API accepts comes close to it.
app.use(express.json({ limit: "100kb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/health/db", healthCheckRateLimit, async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch (error) {
    // This endpoint is unauthenticated, and a Prisma/pg connection failure spells out the pooler
    // host, database name and role it was trying to use. Keep the detail in the server log.
    console.error("[health] database check failed:", error);
    res.status(500).json({ status: "error" });
  }
});

app.use("/auth", authRouter);
app.use("/admin", adminRouter);
app.use("/ponds", pondsRouter);
app.use("/devices", devicesRouter);
app.use("/notifications", notificationsRouter);
app.use("/me", meRouter);

// Every client of this API parses responses as JSON, so an unknown path has to answer in JSON too
// rather than falling through to Express's default HTML page.
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  console.error(err);
  // The .xlsx export streams, so it has already flushed headers by the time a mid-stream failure
  // lands here. Writing a JSON body on top of that throws ERR_HTTP_HEADERS_SENT inside this
  // handler; Express's own finalhandler knows to just destroy the socket instead.
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: "internal server error" });
};
app.use(errorHandler);

// Held so shutdown can close them. Before this, both handles were dropped on the floor, which meant
// a SIGTERM (every rolling deploy) killed the process with its MQTT session still established —
// exactly the duplicate-client collision that makes HiveMQ disconnect the old and new instance in
// turn.
let mqttClient: ReturnType<typeof startReadingsSubscriber> | null = null;
let rollupTimer: ReturnType<typeof startReadingRollup> | null = null;
let watchdogTimer: ReturnType<typeof startDeviceWatchdog> | null = null;

const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);

  // Devices don't call the HTTP API: they publish signed readings to the MQTT broker, and this picks them up.
  // Set MQTT_ENABLED=false to skip this (e.g. doing UI-only work) without touching device/pond code.
  if (process.env.MQTT_ENABLED === "false") {
    console.log("[mqtt] disabled (MQTT_ENABLED=false)");
  } else {
    mqttClient = startReadingsSubscriber();
  }

  // Hourly rollup of raw readings into ReadingHourly, then prunes raw rows past the retention window.
  // Set ROLLUP_ENABLED=false to skip this (e.g. doing UI-only work against a database you don't want touched).
  if (process.env.ROLLUP_ENABLED === "false") {
    console.log("[rollup] disabled (ROLLUP_ENABLED=false)");
  } else {
    rollupTimer = startReadingRollup();
  }

  // Watches Device.lastSeenAt for units that have gone quiet and notifies when one goes offline or recovers.
  // Set WATCHDOG_ENABLED=false to skip this (e.g. doing UI-only work against a database you don't want touched).
  if (process.env.WATCHDOG_ENABLED === "false") {
    console.log("[watchdog] disabled (WATCHDOG_ENABLED=false)");
  } else {
    watchdogTimer = startDeviceWatchdog();
  }
});

// Without this, a failed bind (e.g. another instance already on this port) leaves the process alive with no
// HTTP server but the MQTT subscriber would still start — a second silent client fighting the real one for the
// same broker session.
server.on("error", (err) => {
  console.error(`Failed to start server: ${(err as Error).message}`);
  process.exit(1);
});

// Stop accepting requests, hand the broker a clean DISCONNECT, and let go of the pooler connection.
// The MQTT session is the part that matters: dying with it open leaves the broker holding a session
// under this MQTT_CLIENT_ID, so the replacement instance and the corpse fight over it.
const SHUTDOWN_GRACE_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  // A second Ctrl-C should end it now rather than restart the wind-down.
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, closing down`);

  // Backstop: if a hung in-flight request or broker never lets go, exit anyway rather than sit
  // there until the platform SIGKILLs us.
  const failsafe = setTimeout(() => {
    console.error("[shutdown] took too long, exiting anyway");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  failsafe.unref();

  if (rollupTimer) clearInterval(rollupTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  // `false` means "send DISCONNECT properly" rather than yanking the socket.
  if (mqttClient) await mqttClient.endAsync(false);
  await prisma.$disconnect();

  clearTimeout(failsafe);
  console.log("[shutdown] done");
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal).catch((err) => {
      console.error("[shutdown] failed:", err);
      process.exit(1);
    });
  });
}
