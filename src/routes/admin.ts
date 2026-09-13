import { Router } from "express";
import type { z } from "zod";
import { logAudit } from "../lib/audit.ts";
import { prisma } from "../lib/prisma.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { requireAdmin } from "../middleware/requireAdmin.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { validate } from "../middleware/validate.ts";
import { inviteUserSchema, updateStatusSchema, userIdParams } from "../schemas/admin.ts";

const inviteRedirectUrl = process.env.INVITE_REDIRECT_URL;
if (!inviteRedirectUrl) {
  throw new Error("INVITE_REDIRECT_URL must be set");
}

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.post("/users", validate(inviteUserSchema), async (req, res) => {
  const { email, fullName, systemRole } = req.body;
  const actorId = req.profile!.id;

  const existingProfile = await prisma.profile.findUnique({ where: { email } });
  if (existingProfile) {
    return res.status(409).json({ error: "a user with this email already exists" });
  }

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: inviteRedirectUrl,
    data: { fullName },
  });
  if (error || !data.user) {
    return res.status(error?.status ?? 502).json({ error: error?.message ?? "failed to invite user" });
  }
  const authUserId = data.user.id;

  try {
    const profile = await prisma.$transaction(async (tx) => {
      const created = await tx.profile.create({
        data: { id: authUserId, email, fullName, systemRole, invitedById: actorId },
      });
      await logAudit(
        {
          actorId,
          action: "user.invite",
          targetType: "profile",
          targetId: created.id,
          metadata: { email, systemRole },
        },
        tx,
      );
      return created;
    });
    res.status(201).json({ profile });
  } catch (err) {
    // Roll back the Supabase user so a failed DB write doesn't leave an orphaned login.
    await supabaseAdmin.auth.admin.deleteUser(authUserId);
    throw err;
  }
});

adminRouter.get("/users", async (_req, res) => {
  const profiles = await prisma.profile.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ profiles });
});

adminRouter.patch(
  "/users/:id/status",
  validate(userIdParams, "params"),
  validate(updateStatusSchema),
  async (req, res) => {
    const { id } = req.params as z.infer<typeof userIdParams>;
    const { status } = req.body;
    const actorId = req.profile!.id;

    if (status === "DISABLED" && id === actorId) {
      return res.status(400).json({ error: "you cannot disable your own account" });
    }

    const target = await prisma.profile.findUnique({ where: { id } });
    if (!target) {
      return res.status(404).json({ error: "user not found" });
    }
    if (status === "ACTIVE" && target.status !== "DISABLED") {
      return res.status(409).json({ error: "only disabled users can be re-enabled" });
    }

    // DB first: requireAuth reads this, so the lockout is immediate even if the Supabase ban call fails.
    const profile = await prisma.$transaction(async (tx) => {
      const updated = await tx.profile.update({ where: { id }, data: { status } });
      await logAudit(
        {
          actorId,
          action: status === "DISABLED" ? "user.disable" : "user.enable",
          targetType: "profile",
          targetId: id,
        },
        tx,
      );
      return updated;
    });

    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      ban_duration: status === "DISABLED" ? "876000h" : "none",
    });
    if (error) {
      return res.status(error.status ?? 502).json({ error: error.message, profile });
    }

    res.json({ profile });
  },
);

adminRouter.post("/users/:id/resend-invite", validate(userIdParams, "params"), async (req, res) => {
  const { id } = req.params as z.infer<typeof userIdParams>;
  const actorId = req.profile!.id;

  const target = await prisma.profile.findUnique({ where: { id } });
  if (!target) {
    return res.status(404).json({ error: "user not found" });
  }
  if (target.status !== "INVITED") {
    return res.status(409).json({ error: "user has already accepted their invite" });
  }

  const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(target.email, {
    redirectTo: inviteRedirectUrl,
    data: { fullName: target.fullName },
  });
  if (error) {
    return res.status(error.status ?? 502).json({ error: error.message });
  }

  await logAudit({ actorId, action: "user.resend_invite", targetType: "profile", targetId: id });
  res.json({ ok: true });
});
