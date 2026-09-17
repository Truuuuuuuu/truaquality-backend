import { Router } from "express";
import type { z } from "zod";
import { logAudit } from "../lib/audit.ts";
import { prisma } from "../lib/prisma.ts";
import { validate } from "../middleware/validate.ts";
import { createPondSchema, pondIdParams, updatePondSchema } from "../schemas/ponds.ts";

// Mounted inside adminRouter, which already applies requireAuth + requireAdmin.
export const adminPondsRouter = Router();

adminPondsRouter.post("/", validate(createPondSchema), async (req, res) => {
  const { name, notes, fishSpecies, pondType } = req.body as z.infer<typeof createPondSchema>;
  const actorId = req.profile!.id;

  const existing = await prisma.pond.findUnique({ where: { name } });
  if (existing) {
    return res.status(409).json({ error: "a pond with this name already exists" });
  }

  const pond = await prisma.$transaction(async (tx) => {
    const created = await tx.pond.create({ data: { name, notes, fishSpecies, pondType } });
    await logAudit(
      { actorId, action: "pond.create", targetType: "pond", targetId: created.id, metadata: { name } },
      tx,
    );
    return created;
  });

  res.status(201).json({ pond });
});

adminPondsRouter.patch(
  "/:id",
  validate(pondIdParams, "params"),
  validate(updatePondSchema),
  async (req, res) => {
    const { id } = req.params as z.infer<typeof pondIdParams>;
    const changes = req.body as z.infer<typeof updatePondSchema>;
    const actorId = req.profile!.id;

    const target = await prisma.pond.findUnique({ where: { id }, include: { device: { select: { id: true } } } });
    if (!target) {
      return res.status(404).json({ error: "pond not found" });
    }
    if (changes.name && changes.name !== target.name) {
      const clash = await prisma.pond.findUnique({ where: { name: changes.name } });
      if (clash) {
        return res.status(409).json({ error: "a pond with this name already exists" });
      }
    }
    // An archived pond must not keep receiving readings, so its device has to be moved off it first.
    if (changes.status === "ARCHIVED" && target.device) {
      return res.status(409).json({ error: "unassign this pond's device before archiving it" });
    }

    const statusChanged = changes.status !== undefined && changes.status !== target.status;
    const pond = await prisma.$transaction(async (tx) => {
      const updated = await tx.pond.update({ where: { id }, data: changes });
      await logAudit(
        {
          actorId,
          action: statusChanged ? (changes.status === "ARCHIVED" ? "pond.archive" : "pond.restore") : "pond.update",
          targetType: "pond",
          targetId: id,
          metadata: changes,
        },
        tx,
      );
      return updated;
    });

    res.json({ pond });
  },
);
