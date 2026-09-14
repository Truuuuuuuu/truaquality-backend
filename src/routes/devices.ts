import { Router } from "express";
import { deviceSummarySelect } from "../lib/devices.ts";
import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/requireAuth.ts";

export const devicesRouter = Router();

devicesRouter.use(requireAuth);

devicesRouter.get("/", async (_req, res) => {
  const devices = await prisma.device.findMany({
    orderBy: { serial: "asc" },
    select: { ...deviceSummarySelect, pond: { select: { id: true, name: true } } },
  });
  res.json({ devices });
});
