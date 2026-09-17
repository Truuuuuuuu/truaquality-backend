import { Router } from "express";
import type { z } from "zod";
import { logAudit } from "../lib/audit.ts";
import { decodeAuditCursor, encodeAuditCursor } from "../lib/auditCursor.ts";
import { prisma } from "../lib/prisma.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { inviteEmailRateLimit } from "../middleware/loginRateLimit.ts";
import { requireAdmin } from "../middleware/requireAdmin.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { validate } from "../middleware/validate.ts";
import { auditPageQuery, inviteUserSchema, updateStatusSchema, userIdParams } from "../schemas/admin.ts";
import { adminDevicesRouter } from "./adminDevices.ts";
import { adminPondsRouter } from "./adminPonds.ts";

const inviteRedirectUrl = process.env.INVITE_REDIRECT_URL;
if (!inviteRedirectUrl) {
  throw new Error("INVITE_REDIRECT_URL must be set");
}

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.use("/ponds", adminPondsRouter);
adminRouter.use("/devices", adminDevicesRouter);

adminRouter.post("/users", inviteEmailRateLimit, validate(inviteUserSchema), async (req, res) => {
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
  const profiles = await prisma.profile.findMany({
    where: { status: { not: "DELETED" } },
    orderBy: { createdAt: "desc" },
  });
  res.json({ profiles });
});

// The trail of who changed what. Every admin action writes one of these (lib/audit.ts) and nothing read them
// until now, which for a government system left the accountability story half-finished.
adminRouter.get("/audit", validate(auditPageQuery, "query"), async (req, res) => {
  const { action, targetType, actorId, from, to, before, limit } = res.locals.query as z.infer<
    typeof auditPageQuery
  >;

  if (from && to && from > to) {
    return res.status(400).json({ error: "from must be before to" });
  }

  const cursor = before ? decodeAuditCursor(before) : null;
  if (before && !cursor) {
    return res.status(400).json({ error: "invalid cursor" });
  }

  // Shared by both queries below, but deliberately without the cursor condition: the count is of
  // everything the filters match, not just what's left after the current page.
  const filterWhere = {
    ...(action ? { action } : {}),
    ...(targetType ? { targetType } : {}),
    ...(actorId ? { actorId } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        ...filterWhere,
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    }),
    // Lets the frontend page by number ("12–22 of 33") with real Previous/Next controls, the same as
    // the Users/Ponds/Devices registries, instead of an unbounded "load more" feed.
    prisma.auditLog.count({ where: filterWhere }),
  ]);

  // AuditLog.actorId deliberately carries no foreign key, so that a row outlives the profile it names and the
  // history stays intact. That rules out an `include`, so names are resolved in a second lookup and an actor
  // whose profile is gone simply comes back null — the row still shows, with its raw actorId.
  const actorIds = [...new Set(rows.flatMap((row) => (row.actorId ? [row.actorId] : [])))];
  const actors = actorIds.length
    ? await prisma.profile.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));

  const last = rows.at(-1);
  const nextCursor = last && rows.length === limit ? encodeAuditCursor(last) : null;

  res.json({
    entries: rows.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata,
      createdAt: row.createdAt,
      actorId: row.actorId,
      actor: row.actorId ? (actorById.get(row.actorId) ?? null) : null,
    })),
    nextCursor,
    total,
  });
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
    // A deleted profile has no Supabase login left, so re-enabling it would revive an account nobody can use.
    if (!target || target.status === "DELETED") {
      return res.status(404).json({ error: "user not found" });
    }
    if (status === "DISABLED" && target.systemRole === "ADMIN") {
      return res.status(400).json({ error: "admins cannot be disabled" });
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

adminRouter.post(
  "/users/:id/resend-invite",
  inviteEmailRateLimit,
  validate(userIdParams, "params"),
  async (req, res) => {
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
  },
);
