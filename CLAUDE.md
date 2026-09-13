# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

## Project state

Express 5 + TypeScript backend. Prisma is the ORM, talking to a Supabase-hosted Postgres database. Auth is
handled entirely by Supabase Auth (not a hand-rolled user table/JWT system — that was built once, then
deliberately removed in favor of Supabase Auth; see "Auth" below for why). Current surface area: `/health`,
`/health/db`, and `/auth/signup` + `/auth/login`.

## Commands

- Start: `npm run start` (`node src/index.ts`)
- Dev with reload: `npm run dev` (`node --watch src/index.ts`)
- Typecheck: `npx tsc --noEmit -p tsconfig.json` (there is no `test`/`typecheck` npm script yet)
- Generate Prisma client after any schema change: `npx prisma generate` — **`prisma migrate dev` does NOT
  reliably regenerate the client in this setup; always run `prisma generate` explicitly afterward and
  confirm the model actually shows up (e.g. `grep -n "User" src/generated/prisma/models.ts`) before assuming
  `prisma.<model>` will work.**
- Create + apply a migration: `npx prisma migrate dev --name <description>`
- Prisma CLI config lives in `prisma7.config.ts`, not `schema.prisma` — that's where `DIRECT_URL` is wired up
  for the CLI (migrate/introspect/studio).

## Architecture

### Runtime: no build step, Node runs TypeScript natively

`tsconfig.json` has `noEmit: true`. There is no compile step — Node 26's built-in TypeScript type-stripping
runs `.ts` files directly (`node src/index.ts`). This means Node's own ESM resolver is in play, not
`tsc`/`tsx`/`ts-node`'s looser resolution:

- **Relative imports must use the real `.ts` extension** (`import { prisma } from "./lib/prisma.ts"`), not
  `.js`. Node does not rewrite `.js` specifiers to `.ts` files the way bundlers or `tsx` do — using `.js`
  here throws `ERR_MODULE_NOT_FOUND` at runtime even though `tsc --noEmit` won't catch it.
- `rewriteRelativeImportExtensions` in `tsconfig.json` is what permits writing `.ts` extensions in imports
  without a TS error; it's irrelevant to how Node resolves them at runtime, but required for the above
  pattern to typecheck.
- If a build step is ever introduced (bundling for deployment, etc.), revisit this — a bundler will want the
  conventional `.js` extensions instead.

### Database & ORM (Prisma 7 + Supabase Postgres)

- **Pin `prisma` and `@prisma/client` to the same explicit version.** npm's `latest` dist-tag for the
  `prisma` CLI package has pointed at pre-release/RC versions before (e.g. `8.0.0-rc.x`) while
  `@prisma/client`'s `latest` stayed on a stable prior major — installing both as `^latest` silently mixes
  incompatible majors and pulls in a CLI with a different `init`/config flow than what's documented for the
  stable line. Check `npm view prisma dist-tags` / `npm view @prisma/client dist-tags` before bumping.
- Prisma 7's `prisma-client` generator (in `schema.prisma`'s `generator client` block) requires a **driver
  adapter** — there's no more built-in `datasourceUrl`/`datasources.url` shorthand on `PrismaClient`. This
  project uses `@prisma/adapter-pg` (`PrismaPg`), wired up in `src/lib/prisma.ts`.
- Supabase gives you two connection strings; both are needed and serve different purposes:
  - `DATABASE_URL` — the **transaction-mode pooler** (port `6543`, `?pgbouncer=true`) — used by the app at
    runtime via the driver adapter.
  - `DIRECT_URL` — the **session-mode pooler** (port `5432`) — used by the Prisma CLI for
    migrate/introspect/studio. (Supabase's plain "Direct connection" option requires a paid IPv4 add-on now
    that direct connections are IPv6-only by default; the session pooler is the IPv4-compatible workaround
    that avoids that entirely and needs no extra Supabase config.)
- If a Supabase DB password contains a character like `@`, `:`, `/`, or `#`, it must be percent-encoded in
  the connection string (`@` → `%40`) or URL parsing breaks with an opaque "Invalid URL" error.
- `prisma init` (in the CLI versions around 7.10/8-rc) also scaffolds "AI agent skills" docs into
  `.claude/skills/`, `.agents/`, `.windsurf/skills/`, and `skills-lock.json` by default — unrelated project
  clutter, safe to delete (`--skills=none` on `prisma init` avoids it next time).

### Auth: Supabase Auth, not custom

Signup/login (`src/routes/auth.ts`) call `supabase.auth.signUp` / `signInWithPassword` via
`src/lib/supabase.ts` (built from `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` — Supabase's newer naming for
what used to be called the "anon" key). Supabase owns the user table (`auth.users`), password hashing, and
session/JWT issuance — none of that is reimplemented here.

A custom `User` Prisma model + bcrypt hashing + self-signed JWTs was built first, then intentionally dropped
once the decision was made to use Supabase Auth instead, to avoid a duplicate/conflicting identity system.
If app-specific user data is needed later (profile fields, roles, etc.), model it as a separate table (e.g.
`Profile`) keyed on Supabase's `auth.users.id`, rather than reintroducing a credentials table.

**Email confirmation is currently disabled** in the Supabase project (Authentication → Providers → Email →
"Confirm email") for frictionless local dev — signup returns a usable `session` immediately instead of
`session: null`. Re-enable it before any real users can reach these endpoints.

### Environment variables (`.env`, gitignored)

- `DATABASE_URL`, `DIRECT_URL` — see above
- `PORT` — defaults to 3000 if unset
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` — from Supabase dashboard → Project Settings → API

## Known follow-ups (not yet built)

- No middleware verifies a request's Supabase `access_token` (e.g. via `supabase.auth.getUser(token)`) to
  protect routes — every route is currently unauthenticated.
- No app-specific data models beyond auth.
