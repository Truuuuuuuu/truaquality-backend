import { Router } from "express";
import type { z } from "zod";
import { logAudit } from "../lib/audit.ts";
import { deviceCredentials } from "../lib/deviceSecrets.ts";
import { deviceSummarySelect } from "../lib/devices.ts";
import { prisma } from "../lib/prisma.ts";
import { validate } from "../middleware/validate.ts";
import { createDeviceSchema, deviceIdParams, updateDeviceSchema } from "../schemas/devices.ts";

// Mounted inside adminRouter, which already applies requireAuth + requireAdmin.
export const adminDevicesRouter = Router();

const deviceWithPondSelect = { ...deviceSummarySelect, pond: { select: { id: true, name: true } } };

// Returns an error message if the pond can't take `deviceId` (or a new device, when omitted).
async function checkPondAssignable(pondId: string, deviceId?: string) {
  const pond = await prisma.pond.findUnique({ where: { id: pondId }, include: { device: { select: { id: true } } } });
  if (!pond) return { status: 404, error: "pond not found" };
  if (pond.status === "ARCHIVED") return { status: 409, error: "cannot assign a device to an archived pond" };
  if (pond.device && pond.device.id !== deviceId) return { status: 409, error: "this pond already has a device" };
  return null;
}

adminDevicesRouter.post("/", validate(createDeviceSchema), async (req, res) => {
  const { serial, hardwareModel, label, pondId } = req.body as z.infer<typeof createDeviceSchema>;
  const actorId = req.profile!.id;

  const existing = await prisma.device.findUnique({ where: { serial } });
  if (existing) {
    return res.status(409).json({ error: "a device with this serial already exists" });
  }
  if (pondId) {
    const problem = await checkPondAssignable(pondId);
    if (problem) return res.status(problem.status).json({ error: problem.error });
  }

  const device = await prisma.$transaction(async (tx) => {
    const created = await tx.device.create({
      data: { serial, hardwareModel, label, pondId, assignedAt: pondId ? new Date() : null },
      select: deviceWithPondSelect,
    });
    await logAudit(
      { actorId, action: "device.register", targetType: "device", targetId: created.id, metadata: { serial, pondId } },
      tx,
    );
    return created;
  });

  // The secret is derivable, but only ever handed out here and on rotation.
  res.status(201).json({ device, credentials: deviceCredentials(device) });
});

adminDevicesRouter.patch(
  "/:id",
  validate(deviceIdParams, "params"),
  validate(updateDeviceSchema),
  async (req, res) => {
    const { id } = req.params as z.infer<typeof deviceIdParams>;
    const changes = req.body as z.infer<typeof updateDeviceSchema>;
    const actorId = req.profile!.id;

    const target = await prisma.device.findUnique({ where: { id } });
    if (!target) {
      return res.status(404).json({ error: "device not found" });
    }

    const pondChanged = changes.pondId !== undefined && changes.pondId !== target.pondId;
    if (pondChanged && changes.pondId) {
      const problem = await checkPondAssignable(changes.pondId, id);
      if (problem) return res.status(problem.status).json({ error: problem.error });
    }
    const statusChanged = changes.status !== undefined && changes.status !== target.status;

    const actions: string[] = [];
    if (pondChanged) actions.push(changes.pondId ? "device.assign" : "device.unassign");
    if (statusChanged) actions.push(changes.status === "DISABLED" ? "device.disable" : "device.enable");
    if (actions.length === 0) actions.push("device.update");

    const device = await prisma.$transaction(async (tx) => {
      const updated = await tx.device.update({
        where: { id },
        data: { ...changes, ...(pondChanged ? { assignedAt: changes.pondId ? new Date() : null } : {}) },
        select: deviceWithPondSelect,
      });
      for (const action of actions) {
        await logAudit(
          {
            actorId,
            action,
            targetType: "device",
            targetId: id,
            metadata: { ...changes, previousPondId: target.pondId },
          },
          tx,
        );
      }
      return updated;
    });

    res.json({ device });
  },
);

adminDevicesRouter.post("/:id/rotate-secret", validate(deviceIdParams, "params"), async (req, res) => {
  const { id } = req.params as z.infer<typeof deviceIdParams>;
  const actorId = req.profile!.id;

  const target = await prisma.device.findUnique({ where: { id }, select: { id: true } });
  if (!target) {
    return res.status(404).json({ error: "device not found" });
  }

  // Bumping the version changes the derived secret, so messages signed with the old one fail verification at once.
  const device = await prisma.$transaction(async (tx) => {
    const updated = await tx.device.update({
      where: { id },
      data: { secretVersion: { increment: 1 } },
      select: deviceWithPondSelect,
    });
    await logAudit(
      {
        actorId,
        action: "device.rotate_secret",
        targetType: "device",
        targetId: id,
        metadata: { secretVersion: updated.secretVersion },
      },
      tx,
    );
    return updated;
  });

  res.json({ device, credentials: deviceCredentials(device) });
});
