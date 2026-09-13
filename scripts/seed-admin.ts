import "dotenv/config";
import { parseArgs } from "node:util";
import { logAudit } from "../src/lib/audit.ts";
import { prisma } from "../src/lib/prisma.ts";
import { supabaseAdmin } from "../src/lib/supabaseAdmin.ts";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
  },
});

const email = values.email?.trim().toLowerCase();
const fullName = values.name?.trim();

if (!email || !fullName) {
  console.error('Usage: npm run seed:admin -- --email <email> --name "<full name>"');
  process.exit(1);
}

const existing = await prisma.profile.findUnique({ where: { email } });

if (existing) {
  await prisma.$transaction(async (tx) => {
    await tx.profile.update({ where: { id: existing.id }, data: { systemRole: "ADMIN" } });
    await logAudit(
      { actorId: null, action: "user.promote_admin", targetType: "profile", targetId: existing.id, metadata: { seed: true } },
      tx,
    );
  });
  console.log(`Promoted existing user ${email} to ADMIN.`);
} else {
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: process.env.INVITE_REDIRECT_URL,
    data: { fullName },
  });
  if (error || !data.user) {
    console.error(`Invite failed: ${error?.message ?? "no user returned"}`);
    process.exit(1);
  }
  const authUserId = data.user.id;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.profile.create({
        data: { id: authUserId, email, fullName, systemRole: "ADMIN" },
      });
      await logAudit(
        { actorId: null, action: "user.invite", targetType: "profile", targetId: authUserId, metadata: { email, systemRole: "ADMIN", seed: true } },
        tx,
      );
    });
  } catch (err) {
    await supabaseAdmin.auth.admin.deleteUser(authUserId);
    throw err;
  }
  console.log(`Invited ${email} as ADMIN. They must open the invite email to set a password.`);
}

await prisma.$disconnect();
