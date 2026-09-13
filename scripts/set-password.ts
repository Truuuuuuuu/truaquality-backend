import "dotenv/config";
import { parseArgs } from "node:util";
import { prisma } from "../src/lib/prisma.ts";
import { supabaseAdmin } from "../src/lib/supabaseAdmin.ts";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    password: { type: "string" },
  },
});

const email = values.email?.trim().toLowerCase();
const password = values.password;

if (!email || !password) {
  console.error('Usage: npm run set-password -- --email <email> --password "<new password>"');
  process.exit(1);
}

const profile = await prisma.profile.findUnique({ where: { email } });

if (!profile) {
  console.error(`No profile found for ${email}.`);
  process.exit(1);
}

const { error } = await supabaseAdmin.auth.admin.updateUserById(profile.id, { password });

if (error) {
  console.error(`Failed to set password: ${error.message}`);
  process.exit(1);
}

console.log(`Password updated for ${email}. Log in with the new password.`);

await prisma.$disconnect();
