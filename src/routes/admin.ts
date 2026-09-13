import { Router } from "express";
import type { z } from "zod";
import { logAudit } from "../lib/audit.ts";
import { prisma } from "../lib/prisma.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin.ts";
import { validate } from "../middleware/validate.ts";
import {
  addMemberSchema,
  createOfficeSchema,
  inviteUserSchema,
  memberParams,
  officeIdParams,
  updateStatusSchema,
  userIdParams,
} from "../schemas/admin.ts";

const inviteRedirectUrl = process.env.INVITE_REDIRECT_URL;
if (!inviteRedirectUrl) {
  throw new Error("INVITE_REDIRECT_URL must be set");
}

export const adminRouter = Router();

adminRouter.use(requireAuth, requireSuperAdmin);

adminRouter.post("/offices", validate(createOfficeSchema), async (req, res) => {
  const actorId = req.profile!.id;

  const existing = await prisma.office.findUnique({ where: { code: req.body.code } });
  if (existing) {
    return res.status(409).json({ error: "office code already in use" });
  }

  const office = await prisma.$transaction(async (tx) => {
    const created = await tx.office.create({ data: req.body });
    await logAudit(
      { actorId, action: "office.create", targetType: "office", targetId: created.id, metadata: { code: created.code } },
      tx,
    );
    return created;
  });

  res.status(201).json({ office });
});

adminRouter.get("/offices", async (_req, res) => {
  const offices = await prisma.office.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { members: true } } },
  });
  res.json({ offices });
});

adminRouter.post("/users", validate(inviteUserSchema), async (req, res) => {
  const { email, fullName, officeId, officeRole, systemRole } = req.body;
  const actorId = req.profile!.id;

  const [existingProfile, office] = await Promise.all([
    prisma.profile.findUnique({ where: { email } }),
    prisma.office.findUnique({ where: { id: officeId } }),
  ]);
  if (existingProfile) {
    return res.status(409).json({ error: "a user with this email already exists" });
  }
  if (!office) {
    return res.status(404).json({ error: "office not found" });
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
        data: {
          id: authUserId,
          email,
          fullName,
          systemRole,
          invitedById: actorId,
          memberships: { create: { officeId, role: officeRole } },
        },
        include: { memberships: { include: { office: true } } },
      });
      await logAudit(
        {
          actorId,
          action: "user.invite",
          targetType: "profile",
          targetId: created.id,
          metadata: { email, officeId, officeRole, systemRole },
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
  const profiles = await prisma.profile.findMany({
    orderBy: { createdAt: "desc" },
    include: { memberships: { include: { office: true } } },
  });
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

adminRouter.post(
  "/offices/:officeId/members",
  validate(officeIdParams, "params"),
  validate(addMemberSchema),
  async (req, res) => {
    const { officeId } = req.params as z.infer<typeof officeIdParams>;
    const { profileId, role } = req.body;
    const actorId = req.profile!.id;

    const [office, profile, existing] = await Promise.all([
      prisma.office.findUnique({ where: { id: officeId } }),
      prisma.profile.findUnique({ where: { id: profileId } }),
      prisma.officeMember.findUnique({ where: { officeId_profileId: { officeId, profileId } } }),
    ]);
    if (!office) {
      return res.status(404).json({ error: "office not found" });
    }
    if (!profile) {
      return res.status(404).json({ error: "user not found" });
    }
    if (existing) {
      return res.status(409).json({ error: "user is already a member of this office" });
    }

    const membership = await prisma.$transaction(async (tx) => {
      const created = await tx.officeMember.create({ data: { officeId, profileId, role } });
      await logAudit(
        { actorId, action: "office.member.add", targetType: "office", targetId: officeId, metadata: { profileId, role } },
        tx,
      );
      return created;
    });

    res.status(201).json({ membership });
  },
);

adminRouter.delete(
  "/offices/:officeId/members/:profileId",
  validate(memberParams, "params"),
  async (req, res) => {
    const { officeId, profileId } = req.params as z.infer<typeof memberParams>;
    const actorId = req.profile!.id;

    const existing = await prisma.officeMember.findUnique({
      where: { officeId_profileId: { officeId, profileId } },
    });
    if (!existing) {
      return res.status(404).json({ error: "membership not found" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.officeMember.delete({ where: { officeId_profileId: { officeId, profileId } } });
      await logAudit(
        { actorId, action: "office.member.remove", targetType: "office", targetId: officeId, metadata: { profileId } },
        tx,
      );
    });

    res.status(204).end();
  },
);
