import "dotenv/config";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { prisma } from "../src/lib/prisma.ts";
import { supabaseAdmin } from "../src/lib/supabaseAdmin.ts";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
  },
});

const email = values.email?.trim().toLowerCase();

if (!email) {
  console.error("Usage: npm run set-password -- --email <email>");
  console.error('The new password is read from stdin: printf \'%s\' "$NEW_PASSWORD" | npm run set-password -- --email <email>');
  process.exit(1);
}

// The password is taken from stdin rather than argv. As a flag it landed in the operator's shell history
// and was visible in `ps` to every other local user on the machine for as long as the script ran. On a
// terminal the typed characters must not be echoed either, or the password simply sits on screen instead.
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      chunks.push(String(chunk));
    }
    // Only the first line is the password, and it is not trimmed: a password may legitimately begin or end
    // with a space, and trimming would silently set something other than what was piped in.
    const firstLine = chunks.join("").split("\n", 1)[0] ?? "";
    return firstLine.endsWith("\r") ? firstLine.slice(0, -1) : firstLine;
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // Prompt on stderr so a future `... | something` pipeline stays clean. The question() promise is started
  // first so the prompt itself is written, then the interface's private writer is muted so the characters
  // that follow never reach the terminal.
  const answer = rl.question("New password: ");
  (rl as unknown as { _writeToOutput(s: string): void })._writeToOutput = () => {};
  const password = await answer;
  process.stderr.write("\n");
  rl.close();
  return password;
}

const password = await readPassword();

// Checked before any Prisma or Supabase call, so an accidentally empty pipe cannot even reach the database.
if (password.length === 0) {
  console.error("No password received on stdin. Aborting.");
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
