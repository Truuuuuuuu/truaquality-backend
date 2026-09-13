# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

## Project state

Express 5 + TypeScript backend for a **government** water-quality monitoring system. Prisma is the ORM, talking
to a Supabase-hosted Postgres database. Supabase Auth owns credentials and JWTs.

**Scope: BFAR Sorsogon only.** This is a single-organization system: every user, and later every pond and
IoT device, belongs to BFAR Sorsogon. There is intentionally no office, region, or tenant model — don't add
one.

**Account creation is invite-only.** There is no public signup. Only admins create accounts, through
`/admin/*`, and new users set their password from an emailed invite link.

Current surface area:
- `/health`, `/health/db`
- `/auth/login`
- `/me` (protected)
- `/admin/*` (admin only): user invites, resend invite, user enable/disable

## Commands

- Start: `npm run start` (`node src/index.ts`)
- Dev with reload: `npm run dev` (`node --watch src/index.ts`)
- Typecheck: `npx tsc --noEmit -p tsconfig.json` (there is no `test`/`typecheck` npm script yet)
- Create the first admin (or promote an existing user):
  `npm run seed:admin -- --email <email> --name "<full name>"`
- Generate Prisma client after any schema change: `npx prisma generate`.
  - **`prisma migrate dev` does NOT reliably regenerate the client in this setup.** Always run
    `prisma generate` explicitly afterward.
  - Before assuming `prisma.<model>` will work, confirm the model actually shows up
    (e.g. `grep -n "Profile" src/generated/prisma/models.ts`).
- Create a migration: `npx prisma migrate dev --create-only --name <description>`. Add the RLS lines (see
  below) to the generated SQL, then apply it with `npx prisma migrate dev`.
  - **Renaming an enum value:** Prisma generates a drop-and-recreate of the enum, which fails or corrupts
    existing rows using the old value. Hand-edit the SQL to `ALTER TYPE "<Enum>" RENAME VALUE 'OLD' TO 'NEW';`
    instead (see `20260913170000_single_org_admin_role`, which renamed `SUPER_ADMIN` → `ADMIN` and dropped the
    old `Office`/`OfficeMember` tables).
- Prisma CLI config lives in `prisma7.config.ts`, not `schema.prisma`. That's where `DIRECT_URL` is wired up for
  the CLI (migrate/introspect/studio).
- Before starting the server for a manual test, kill anything already on port 3000
  (`lsof -ti:3000 | xargs kill -9`). Background servers from earlier test runs keep stale `.env` values and
  silently answer requests instead of the new process.

## Architecture

### Runtime: no build step, Node runs TypeScript natively

`tsconfig.json` has `noEmit: true`. There is no compile step. Node 26's built-in TypeScript type-stripping
runs `.ts` files directly (`node src/index.ts`). That means Node's own ESM resolver is in play, not the looser
resolution of `tsc`/`tsx`/`ts-node`:

- **Relative imports must use the real `.ts` extension** (`import { prisma } from "./lib/prisma.ts"`), not
  `.js`. Node does not rewrite `.js` specifiers to `.ts` files the way bundlers or `tsx` do. A `.js` import
  throws `ERR_MODULE_NOT_FOUND` at runtime, and `tsc --noEmit` won't catch it.
- `rewriteRelativeImportExtensions` in `tsconfig.json` is what permits `.ts` extensions in imports without a
  TS error. It doesn't affect how Node resolves them at runtime, but the pattern above needs it to typecheck.
- If a build step is ever introduced (bundling for deployment, etc.), revisit this. A bundler will want the
  conventional `.js` extensions instead.

### Database & ORM (Prisma 7 + Supabase Postgres)

- **Pin `prisma` and `@prisma/client` to the same explicit version.**
  - npm's `latest` dist-tag for the `prisma` CLI has pointed at pre-release versions before (e.g.
    `8.0.0-rc.x`), while `@prisma/client`'s `latest` stayed on a stable prior major.
  - Installing both at `latest` silently mixes incompatible majors, and the RC CLI has a different
    `init`/config flow.
  - Check `npm view prisma dist-tags` and `npm view @prisma/client dist-tags` before bumping.
- Prisma 7's `prisma-client` generator requires a **driver adapter**. There's no `datasourceUrl` shorthand on
  `PrismaClient` anymore. This project uses `@prisma/adapter-pg` (`PrismaPg`) in `src/lib/prisma.ts`.
- Supabase connection strings (both are needed):
  - `DATABASE_URL`: the **transaction-mode pooler** (port `6543`, `?pgbouncer=true`), used by the app at runtime.
  - `DIRECT_URL`: the **session-mode pooler** (port `5432`), used by the Prisma CLI. Supabase's plain "Direct
    connection" needs a paid IPv4 add-on; the session pooler avoids that.
- A DB password containing `@`, `:`, `/`, or `#` must be percent-encoded in the connection string (`@` →
  `%40`). Otherwise URL parsing fails with an opaque "Invalid URL" error.
- **Every table in `public` must have RLS enabled.**
  - Why: Supabase exposes the `public` schema through its Data API to anyone holding the publishable key.
  - How: add `ALTER TABLE "<Table>" ENABLE ROW LEVEL SECURITY;` to each migration that creates a table.
    Policies aren't needed: with none, the Data API is denied. The backend connects as the table owner, so
    Prisma bypasses RLS.
- `prisma init` (CLI ~7.10/8-rc) also scaffolds "AI agent skills" into `.claude/skills/`, `.agents/`,
  `.windsurf/skills/`, and `skills-lock.json`. That's unrelated clutter and safe to delete; `--skills=none`
  avoids it.

### Identity model

- `Profile`: one row per provisioned user.
  - `id` equals Supabase's `auth.users.id`. There are no password fields; Supabase Auth keeps credentials.
  - `systemRole`: `ADMIN` | `USER`.
  - `status`: `INVITED` (invite sent, not accepted) → `ACTIVE` (first authenticated request) → `DISABLED`.
- `AuditLog` records admin actions such as `user.invite`, `user.disable`, and `user.promote_admin`. Write it
  through `logAudit()` in `src/lib/audit.ts`, inside the same `$transaction` as the change it records. Older
  rows may still carry pre-refactor actions (`office.*`, `user.promote_super_admin`); they're history, leave
  them.

### Auth and account creation

- **Public signup is closed.** There is no signup route, and the Supabase dashboard must keep **"Allow new
  users to sign up" off**. Removing the route alone isn't enough, because anyone with the publishable key
  could call Supabase's `signUp` directly.
- Two Supabase clients:
  - `src/lib/supabase.ts` (publishable key): login and JWT verification.
  - `src/lib/supabaseAdmin.ts` (`SUPABASE_SECRET_KEY`): user management (invite, ban, delete). This key
    bypasses RLS and must never reach the frontend or firmware.
- **Invite flow** (`POST /admin/users`):
  1. Call `supabaseAdmin.auth.admin.inviteUserByEmail`.
  2. Create the `Profile` and `AuditLog` rows in one transaction.
  3. If the DB write fails, delete the Supabase user so no orphaned login remains.
  The invite link lands on `INVITE_REDIRECT_URL` (a frontend page where the user sets a password). That URL
  must be in Supabase's allowed redirect URLs.
- `npm run seed:admin` (`scripts/seed-admin.ts`) bootstraps the first admin the same way. It is
  idempotent: an existing profile just gets promoted.
- Inviting real users requires **custom SMTP** in Supabase. The built-in mailer is heavily rate-limited.

### Route protection (`requireAuth`, `requireAdmin`)

`src/middleware/requireAuth.ts`:
1. Reads `Authorization: Bearer <token>`.
2. Verifies the token with `supabase.auth.getClaims(token)`. Supabase signs tokens with ES256, so this checks
   the signature locally against cached JWKS, with no Auth-server round trip. The lower-level `getUser(token)`
   always calls the server.
3. Loads the caller's `Profile`. No profile, or `DISABLED`, returns `403`. A valid
   Supabase user who was never provisioned gets no access.
4. Promotes `INVITED` to `ACTIVE`.
5. Attaches `req.user` (claims) and `req.profile`, typed via declaration merging in the same file.

Because the profile is checked on every request, **disabling a user locks them out immediately**, even though
their JWT stays valid for up to an hour. `PATCH /admin/users/:id/status` also sets a Supabase ban, which blocks
new logins and token refresh.

`src/middleware/requireAdmin.ts` returns `403` unless `req.profile.systemRole === "ADMIN"`. It's applied to
the whole `adminRouter` via `adminRouter.use(requireAuth, requireAdmin)`.

### Request validation (Zod)

- Schemas live in `src/schemas/`.
- `validate(schema, source)` in `src/middleware/validate.ts` checks `req.body` (default) or `req.params` and
  returns `400` with field-level errors.
  - For `body`, it replaces `req.body` with the parsed data.
  - Validate uuid route params with `validate(userIdParams, "params")`.
- This project is on **Zod v4**:
  - Use `z.flattenError(err)`, not the deprecated `.flatten()` method.
  - Use `z.email()` / `z.uuid()`, e.g. `z.string().trim().toLowerCase().pipe(z.email())`, not the deprecated
    `z.string().email()`.

### Environment variables (`.env`, gitignored)

- `DATABASE_URL`, `DIRECT_URL`: see above
- `PORT`: defaults to 3000 if unset
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`: Supabase dashboard → Project Settings → API Keys
- `SUPABASE_SECRET_KEY`: same page, "Secret keys". **Server-only.**
- `INVITE_REDIRECT_URL`: frontend page the invite email links to

**Email confirmation** is currently disabled in Supabase (Authentication → Providers → Email → "Confirm
email"). Invited users confirm their email by opening the invite link either way. Re-enable it before
production.

## Known follow-ups (not yet built)

- Ponds, IoT devices, and sensor readings (all belonging to BFAR Sorsogon), with role-based permissions.
- Frontend accept-invite page (at `INVITE_REDIRECT_URL`) that sets the password via `supabase.auth.updateUser`.
- Logout / refresh-token endpoints, CORS for the frontend origin, and rate limiting on `/auth/login`.
