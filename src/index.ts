import "dotenv/config";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { prisma } from "./lib/prisma.ts";
import { requireAuth } from "./middleware/requireAuth.ts";
import { adminRouter } from "./routes/admin.ts";
import { authRouter } from "./routes/auth.ts";
import { startReadingsSubscriber } from "./lib/readingsSubscriber.ts";
import { devicesRouter } from "./routes/devices.ts";
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
    res.status(500).json({ status: "error", message: (error as Error).message });
  }
});

app.use("/auth", authRouter);
app.use("/admin", adminRouter);
app.use("/ponds", pondsRouter);
app.use("/devices", devicesRouter);

app.get("/me", requireAuth, (req, res) => {
  res.json({ profile: req.profile });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
};
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

// Devices don't call the HTTP API: they publish signed readings to the MQTT broker, and this picks them up.
startReadingsSubscriber();
