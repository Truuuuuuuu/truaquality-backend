import "dotenv/config";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { prisma } from "./lib/prisma.ts";
import { requireAuth } from "./middleware/requireAuth.ts";
import { adminRouter } from "./routes/admin.ts";
import { authRouter } from "./routes/auth.ts";
import { startReadingRollup } from "./lib/readingRollup.ts";
import { startReadingsSubscriber } from "./lib/readingsSubscriber.ts";
import { devicesRouter } from "./routes/devices.ts";
import { notificationsRouter } from "./routes/notifications.ts";
import { pondsRouter } from "./routes/ponds.ts";

const app = express();
const port = process.env.PORT ?? 3000;

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
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/health/db", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch (error) {
    res
      .status(500)
      .json({ status: "error", message: (error as Error).message });
  }
});

app.use("/auth", authRouter);
app.use("/admin", adminRouter);
app.use("/ponds", pondsRouter);
app.use("/devices", devicesRouter);
app.use("/notifications", notificationsRouter);

app.get("/me", requireAuth, (req, res) => {
  res.json({ profile: req.profile });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
};
app.use(errorHandler);

const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);

  // Devices don't call the HTTP API: they publish signed readings to the MQTT broker, and this picks them up.
  // Set MQTT_ENABLED=false to skip this (e.g. doing UI-only work) without touching device/pond code.
  if (process.env.MQTT_ENABLED === "false") {
    console.log("[mqtt] disabled (MQTT_ENABLED=false)");
  } else {
    startReadingsSubscriber();
  }

  // Hourly rollup of raw readings into ReadingHourly, then prunes raw rows past the retention window.
  // Set ROLLUP_ENABLED=false to skip this (e.g. doing UI-only work against a database you don't want touched).
  if (process.env.ROLLUP_ENABLED === "false") {
    console.log("[rollup] disabled (ROLLUP_ENABLED=false)");
  } else {
    startReadingRollup();
  }
});

// Without this, a failed bind (e.g. another instance already on this port) leaves the process alive with no
// HTTP server but the MQTT subscriber would still start — a second silent client fighting the real one for the
// same broker session.
server.on("error", (err) => {
  console.error(`Failed to start server: ${(err as Error).message}`);
  process.exit(1);
});
