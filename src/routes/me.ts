import { Router } from "express";
import { logAudit } from "../lib/audit.ts";
import { prisma } from "../lib/prisma.ts";
import { verifyPassword } from "../lib/supabase.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { loginRateLimit } from "../middleware/loginRateLimit.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { validate } from "../middleware/validate.ts";
import { deleteAccountSchema } from "../schemas/me.ts";

export const meRouter = Router();

meRouter.use(requireAuth);

meRouter.get("/", (req, res) => {
  res.json({ profile: req.profile });
});

// Anonymizes the profile instead of deleting the row, so audit history and invitedBy links still resolve.
// The shared login rate limit caps password guesses from someone holding a stolen access token.
meRouter.delete("/", loginRateLimit, validate(deleteAccountSchema), async (req, res) => {
  const { id, email, systemRole } = req.profile!;
  const { password } = req.body;

  if (systemRole === "ADMIN") {
    return res.status(403).json({ error: "admin accounts cannot be deleted" });
  }

  // 400, not 401: the frontend treats a 401 as an expired token and would refresh and retry.
  if (!(await verifyPassword(id, email, password))) {
    return res.status(400).json({ error: "incorrect password" });
  }

  // Supabase first: if this fails nothing has changed yet, so the user can simply retry.
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
  if (error) {
    return res.status(error.status ?? 502).json({ error: error.message });
  }

  await prisma.$transaction(async (tx) => {
    await tx.notification.deleteMany({ where: { profileId: id } });
    await tx.profile.update({
      where: { id },
      data: {
        status: "DELETED",
        deletedAt: new Date(),
        fullName: "Deleted user",
        // Must stay unique; freeing the real address lets an admin re-invite this person later.
        email: `deleted-${id}@deleted.invalid`,
      },
    });
    await logAudit(
      { actorId: id, action: "user.delete_self", targetType: "profile", targetId: id, metadata: { email } },
      tx,
    );
  });

  res.status(204).end();
});
