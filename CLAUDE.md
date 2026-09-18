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
- `/auth/login`, `/auth/refresh`, `/auth/logout`
- `/me` (protected): `GET` own profile, `DELETE` own account (password-confirmed, see "Identity model")
- `/ponds`, `/ponds/:id`, `/ponds/:id/readings` (paginated), `/ponds/:id/series`, `/ponds/:id/readings/export`
  (.xlsx), `/devices` (protected, any role)
- `/notifications` (protected, caller's own only): list (keyset-paginated, includes `unreadCount`),
  `POST /notifications/:id/read`, `POST /notifications/read-all`
- `/admin/*` (admin only): user invites, resend invite, user enable/disable; `/admin/ponds` (create, rename,
  archive); `/admin/devices` (register, assign to pond, disable, rotate secret); `/admin/audit`
  (keyset-paginated read of `AuditLog`, filterable by `action`/`targetType`/`actorId`/date range)
- **MQTT, not HTTP, for device data:** on startup the backend subscribes to
  `truaquality/v1/devices/+/readings` on HiveMQ Cloud (`src/lib/readingsSubscriber.ts`). ESP32 units publish
  signed readings there; there is no HTTP ingest route.

## Commands

- Start: `npm run start` (`node src/index.ts`)
- Dev with reload: `npm run dev` (`node --watch src/index.ts`)
- Typecheck: `npm run typecheck` (`tsc --noEmit -p tsconfig.json`; also typechecks test files)
- Tests: `npm test`
  - Runs `src/**/*.test.ts` with Node's native runner (`node --test`), so test files get the same `.ts`
    resolution and type stripping as production. Relative imports in tests still use `.ts`.
  - Env comes from the committed `test.env` (dummy values only — never put a real secret or non-local URL
    there).
  - **Variables exported in your shell OVERRIDE `test.env`.** `src/testing/globalSetup.ts` refuses the whole
    run ("refusing to run") unless `DATABASE_URL` (and `DIRECT_URL`/`SUPABASE_URL`, if set) point at
    `localhost`/`127.0.0.1`/`[::1]`, so a stray production URL in your shell stops the suite instead of
    reaching the real database.
  - A fresh clone needs `npx prisma generate` before the first `npm test` (the generated client is
    gitignored).
  - Single-file quick run:
    `node --env-file=test.env --test --test-global-setup=./src/testing/globalSetup.ts src/lib/<file>.test.ts`
  - Coverage: `npm run test:coverage`.
- Testing conventions:
  - Mock Prisma with `t.mock.property(prisma, "<delegate>", fake)`. Never `t.mock.method(prisma.<model>, …)`
    (Prisma 7 delegates are Proxies) and never `mock.module`.
  - Tests must never import `src/index.ts`, `readingsSubscriber.ts`, `supabaseAdmin.ts`, `routes/*`, or
    `scripts/*` — they read secrets/connect at import time.
  - Ingest/alert decisions live in the pure `src/lib/ingestRules.ts` and `src/lib/alertRules.ts`; the Prisma
    shells around them are covered by trace tests in `ingest.test.ts`/`alerts.test.ts` using
    `src/testing/prismaFake.ts`. Those traces are the behavior-preservation baseline — change them only when
    behavior is meant to change.
  - Auth tests mint ES256 JWTs (`src/testing/jwt.ts`) and stub the JWKS fetch; no Supabase network calls.
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
  - **This alone is not enough for `npm run dev` (`node --watch`).** Killing the port holder only kills the
    watch mode's *child* process; the parent watcher immediately respawns it. Check for stray watchers too:
    `ps aux | grep "node --watch src/index.ts"`, and kill those PIDs directly. A real incident: two leftover
    `npm run dev` processes from a previous session (started the day before, never stopped) plus a fresh one
    all held live MQTT connections using the same default `MQTT_CLIENT_ID` — HiveMQ kept disconnecting
    whichever one had connected longest every time another reconnected, producing a continuous
    `[mqtt] reconnecting` loop that looked like a HiveMQ or code problem but was just duplicate processes.

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
  - `status`: `INVITED` (invite sent, not accepted) → `ACTIVE` (first authenticated request) → `DISABLED`,
    or `DELETED`.
- **Account deletion is self-service and anonymizes, it doesn't remove the row.** `DELETE /me`
  (`src/routes/me.ts`) re-verifies the caller's password server-side (`verifyPassword` in
  `src/lib/supabase.ts`, behind `loginRateLimit`), deletes the Supabase login, then in one transaction
  deletes their notifications, sets `status: DELETED` + `deletedAt`, and replaces `fullName`/`email` with
  placeholders (the email becomes `deleted-<id>@deleted.invalid`, freeing the real one for a re-invite).
  Admin accounts can't be deleted. `requireAuth` rejects `DELETED` like `DISABLED`, `GET /admin/users` hides
  them, and the admin status route treats them as not found.
- `AuditLog` records admin actions such as `user.invite`, `user.disable`, and `user.promote_admin`, plus
  `user.delete_self` (the one non-admin action; its metadata keeps the original email). Write it
  through `logAudit()` in `src/lib/audit.ts`, inside the same `$transaction` as the change it records. Older
  rows may still carry pre-refactor actions (`office.*`, `user.promote_super_admin`); they're history, leave
  them.
  - Read back through `GET /admin/audit`, which the frontend's `/audit` page renders. `actorId` deliberately
    has **no foreign key** so a row outlives the profile it names — which rules out an `include`, so the
    route resolves actor names in a second `profile.findMany({ where: { id: { in: ... } } })` and returns
    `actor: null` when the profile is gone. Don't "fix" this by adding the FK; it would take the history
    down with the user.

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
- `npm run simulate:devices -- --device <deviceId>:<deviceSecret> [--device ...] [--interval 60]`
  (`scripts/simulate-devices.ts`) is **dev only**: it publishes synthetic, correctly signed readings to the
  MQTT broker as if it were ESP32 units, so the multi-pond UI can be tested before hardware is installed. Never
  point it at a production broker.
- `npm run purge:parameters -- --parameter <id> [--parameter ...] [--apply]` (`scripts/purge-parameters.ts`)
  deletes the stored readings, hourly summaries, and alerts (plus their notifications) of a parameter that has
  been removed from `PARAMETER_BOUNDS`. Dry run unless `--apply`; refuses live parameter ids.
- `npm run generate:signing-vectors` (`scripts/generate-signing-vectors.ts`) is **dev only**: regenerates
  `src/lib/__fixtures__/signing-vectors.v1.json` from the real `signMessage`. The firmware mirrors these
  vectors byte-for-byte (Phase 2), so changing them means updating the firmware copy too.
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

### Ponds, devices, and readings

- `Pond`: one monitored fishpond. Archived (`status: ARCHIVED`), never deleted, so its history survives.
  A pond can't be archived while a device is assigned to it.
- `Device`: one ESP32 sensor unit, at most one per pond (`pondId` is `@unique`, nullable).
  - **The device never knows its pond.** Firmware only holds its device id and secret. Ingest resolves the
    pond from `Device.pondId`, so moving hardware between ponds is an admin reassignment, not a reflash.
- **Device authentication is per message, not per broker login.**
  - HiveMQ Cloud's free (Serverless) tier gives every MQTT credential access to all topics, and its credentials
    can only be created by hand in the console. So all units share one broker credential, and the broker
    proves nothing about who published.
  - Each message is `v1.<hex HMAC-SHA256>.<JSON body>`, with the HMAC over `<topic>\n<body>`
    (`src/lib/deviceMessages.ts`). The firmware (`firmware/lib/Uplink`) and the simulator must match it
    exactly.
  - **Secrets are derived, not stored** (`src/lib/deviceSecrets.ts`): HMAC(`DEVICE_SECRET_MASTER_KEY`,
    `device-secret:<id>:<secretVersion>`).
    - Rotating a device bumps `secretVersion`.
    - Changing the master key invalidates every unit at once, so every unit must be reflashed.
    - The API returns credentials only from `POST /admin/devices` and `POST /admin/devices/:id/rotate-secret`.
  - Order in `readingsSubscriber.ts`: parse the topic, look up the device, **verify the signature**, check it
    isn't disabled, rate limit (30 messages/min per device, counted only after verification), validate, then
    ingest. Nothing, not even `lastSeenAt`, is written for an unverified message. Dropped messages are logged
    with a reason.
  - Anyone with the shared broker credential can *read* every unit's readings (the topics aren't
    confidential), but can't forge them. Replaying a captured message is harmless: duplicates are skipped, and
    samples older than `Device.assignedAt` are refused.
- **Reading history: raw rows for a rolling window, hourly summaries forever.** `Reading` holds per-minute
  rows but is pruned past `RAW_RETENTION_DAYS` (env, default 30, floor `MAX_SAMPLE_AGE_MS`'s 7 days + 1 so
  nothing is pruned before it's had a chance to be finalized in a rollup). `ReadingHourly` holds one
  min/max/sum/count row per pond/parameter/hour and is never pruned.
  - `src/lib/readingRollup.ts`: `startReadingRollup()` runs `runReadingRollupCycle()` once on boot and then
    hourly (called from `app.listen()`'s callback in `src/index.ts`, same pattern as the MQTT subscriber; set
    `ROLLUP_ENABLED=false` to skip it). Each cycle re-aggregates the last 7 days of `Reading` into
    `ReadingHourly` (idempotent: `ON CONFLICT ... DO UPDATE`, so a late-arriving buffered sample just widens
    that hour next time), then deletes `Reading` rows older than the retention window in batches.
  - `pg_try_advisory_xact_lock` guards the rollup+prune pair so two backend instances (or a manual run
    overlapping the hourly one) never do it twice at once. It's a transaction-scoped lock precisely because
    `DATABASE_URL` is a pgbouncer transaction-mode pooler — a session-scoped lock wouldn't reliably hold
    across statements there.
- **Device-offline watchdog.** Alerting is otherwise entirely reading-driven (`evaluatePondAlerts()` only
  runs from ingest), so a device that just stops transmitting raises nothing on its own — no reading ever
  arrives to trigger it. `src/lib/deviceWatchdog.ts` is the one thing that actively looks at
  `Device.lastSeenAt`: `startDeviceWatchdog()` runs `runDeviceWatchdogCycle()` once on boot and then every
  minute (same `app.listen()`-callback pattern as the rollup job; set `WATCHDOG_ENABLED=false` to skip it).
  - A cycle finds every `ACTIVE`, pond-assigned device whose `lastSeenAt` is older than 5 minutes (kept in
    sync with the frontend's `STALE_AFTER_MS`) and not already flagged, sets `Device.offlineSince`, and
    notifies with `NotificationKind.DEVICE_OFFLINE`; then finds every flagged device whose `lastSeenAt` has
    become recent again, clears `offlineSince`, and notifies with `DEVICE_ONLINE`. `offlineSince` is the
    open/closed marker for the episode, the same role `Alert.resolvedAt` plays for a reading-driven one
    (just inverted: non-null here means open).
  - A device that has never reported (`lastSeenAt` null) is left alone — that's "not yet installed", not
    "offline" — and so is one that isn't assigned to a pond, since nothing is being monitored on it yet.
  - `Notification.alertId`/`deviceId` are both nullable and exactly one is ever set (a hand-added `CHECK`
    constraint in the `device_offline_watchdog` migration enforces it): `ALERT_*` kinds point at the episode
    and carry `value`/`recordedAt`; `DEVICE_*` kinds point at the device and leave both null. `notifyActiveUsers`
    (`src/lib/notify.ts`) is shared between `alerts.ts` and `deviceWatchdog.ts` for this reason.
  - `pg_try_advisory_xact_lock` guards the whole cycle the same way as the rollup job, so two backend
    instances never race the same device's offline/recovery transition.
  - `npm run rollup:readings` (`scripts/rollup-readings.ts`) runs one cycle manually and exits — useful for
    testing, or for driving the job from an external scheduler instead of the in-process interval.
  - `GET /ponds/:id/readings` is keyset-paginated (`before` cursor from `nextCursor`, encoded in
    `src/lib/readingsCursor.ts`), not `from`/`to` + `limit` — an offset or a full-range fetch doesn't scale
    once history spans months. `GET /ponds/:id/series` answers a chart over an arbitrary range and picks its
    own resolution (raw / hourly / daily) based on how wide the range is. `GET /ponds/:id/readings/export`
    streams a formatted `.xlsx` workbook of either (via `exceljs`'s streaming `WorkbookWriter`, so a large
    export doesn't sit in memory), for reporting outside the app — one column per parameter, one row per
    timestamp, bordered header/data cells, and real numeric cells carrying a custom number format that shows
    the unit (e.g. `27.6 °C`) without turning the value into text.
- `Reading`: **narrow table**, one row per parameter per sample (`parameter` is a string id).
  - Adding a sensor parameter needs no migration: add it to `PARAMETER_BOUNDS` in `src/lib/parameters.ts`
    (physical sanity limits for rejecting garbage), to `PARAMETER_DISPLAY` in the same file
    (label/unit/precision for the `.xlsx` export), to `SHARED` in the same file (alert ranges — or to each
    profile in `PARAMETER_THRESHOLDS` if its range depends on pond type), and to `PARAMETERS` in the frontend (label/unit/precision only — it holds no ranges).
  - `pondId` is copied at ingest time, so readings stay with the pond they were measured in after a device
    is reassigned.
  - `@@unique([deviceId, parameter, recordedAt])` + `createMany({ skipDuplicates: true })` makes device
    retries idempotent.
  - Ingest logic lives in `src/lib/ingest.ts`, separate from the MQTT transport.
    - Values that are out of bounds or unknown, recorded before the device's current `assignedAt`, or older
      than 7 days are dropped one at a time (and logged); the rest of the batch is still stored.
    - An unassigned device's readings are dropped, but its `lastSeenAt` is still updated so admins can see it's
      online.
    - Ingest writes no `AuditLog` rows (it's once a minute per device); admin pond/device changes do.
  - The subscriber speaks MQTT 3.1.1 (like the units) with a persistent session (`clean: false`), so the broker
    can hold QoS 1 readings while the backend restarts. `MQTT_CLIENT_ID` must be unique per running backend process.
- **Thresholds depend on the pond's type, and the backend owns them.** `PARAMETER_THRESHOLDS` in
  `src/lib/parameters.ts` is keyed by `FRESHWATER` / `BRACKISH` / `SALTWATER` / `UNSET` (for a pond whose
  `pondType` is still null), because a single global salinity range once made every freshwater pond
  permanently `CRITICAL`. Salinity (and dissolved oxygen) have since been removed — temperature is the only
  parameter, with turbidity next — so every profile currently points at the same `SHARED` table; a parameter
  whose safe range does depend on pond type overrides it per profile. Resolve with `thresholdsFor(pondType)`
  and judge with `severityFor(parameter, value, pondType)`.
  - **The frontend keeps no copy.** `GET /ponds` and `GET /ponds/:id` return a resolved `thresholds` map on
    each pond, next to `latest`, so the board colors a reading with the same numbers that raised its alert.
    `GET /notifications` likewise computes each row's `direction` (`"low"`/`"high"`) server-side. The one
    exception is `SIGNED_OUT_THRESHOLDS` in the frontend, illustrative bands for the signed-out range key on
    the auth pages, which have no pond and no token; nothing that judges a real reading may use it.
- **Alerts and notifications** (`src/lib/alerts.ts`). After ingest stores new readings, `evaluatePondAlerts()`
  reads the pond's `pondType` once, then re-checks each touched parameter against that type's thresholds.
  - An `Alert` is one out-of-range **episode** per pond/parameter, not one row per bad reading: opened by the first
    abnormal reading, escalated at most once (WARNING → CRITICAL; `Alert.severity` is the episode's worst and never
    steps back down), and resolved only after readings have stayed in range for `ALERT_RECOVERY_MS` (10 min), so a
    value hovering on a threshold doesn't flap. Each notified event fans out one `Notification` row per `ACTIVE`
    profile (per-user read state).
  - **An open episode notifies again every time the reading worsens**, not just on its first escalation. The
    previous reading's severity is recovered by re-scoring `Alert.lastValue`, so nominal → warning, nominal →
    critical and warning → critical all report even though the episode is still the same row. Without this, a
    parameter that briefly recovered (too briefly to resolve) and then went critical again was silently swallowed —
    the episode had already escalated, so nothing fired. A repeat is throttled by `ALERT_RENOTIFY_MS` (30 min since
    that alert's last notification) and carries `ALERT_OPENED`; only the one true escalation past the episode's
    worst severity is `ALERT_ESCALATED`, and it is never throttled.
  - It always evaluates the pond's **newest stored** reading, never the incoming batch, and skips anything not
    newer than `Alert.lastRecordedAt` — so duplicates and late backlog uploads can't reopen or resolve out of
    order.
  - Each evaluation runs in a transaction holding `pg_advisory_xact_lock(hashtext('alert:<pond>:<parameter>'))`,
    because MQTT messages are handled concurrently and two must not both open an alert.
  - A failure here is logged (`[alerts]`) and doesn't fail ingest; the readings are already stored.
- **Latest value per parameter** (`GET /ponds`, `GET /ponds/:id`) uses a raw `LATERAL ... LIMIT 1` per
  (pond, parameter) so it walks the `(pondId, parameter, recordedAt DESC)` index. Don't replace it with
  Prisma's `distinct`, which de-duplicates in memory, or `DISTINCT ON`, which reads every row for the pond.
- `adminPondsRouter` / `adminDevicesRouter` are mounted **inside** `adminRouter`, which already applies
  `requireAuth` + `requireAdmin`. Mounting them separately under `/admin` would run auth twice.
- `startReadingsSubscriber()` is called **inside** `app.listen()`'s success callback, not right after it
  unconditionally, and `server.on("error", ...)` exits the process on a failed bind (e.g. port already
  taken). Earlier this wasn't the case: a failed HTTP bind still let the MQTT subscriber start, so a second
  instance could sit there with no working API but a live, colliding MQTT connection — a subtler version of
  the duplicate-process problem described above under Commands.

### Request validation (Zod)

- Schemas live in `src/schemas/`.
- `validate(schema, source)` in `src/middleware/validate.ts` checks `req.body` (default), `req.params`, or
  `req.query` and returns `400` with field-level errors.
  - For `body`, it replaces `req.body` with the parsed data.
  - For `query`, the parsed data goes on `res.locals.query`, because Express 5's `req.query` is a read-only
    getter.
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
- `MQTT_URL`: the HiveMQ Cloud cluster, e.g. `mqtts://<cluster-id>.s1.eu.hivemq.cloud:8883`
- `MQTT_USERNAME`, `MQTT_PASSWORD`: a HiveMQ credential for the backend (console → Access Management).
  Create it separately from the credential the units share.
- `MQTT_CLIENT_ID` (optional, default `truaquality-backend`): must differ between local dev and a deployed
  backend.
- `DEVICE_SECRET_MASTER_KEY`: at least 32 random characters, **server-only**. Every device secret is derived
  from it. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
- `TRUST_PROXY_HOPS` (optional, default `0`): how many reverse proxies sit in front of the process, passed to
  Express's `trust proxy`. The rate limiters key on IP, so behind a PaaS router with this left at `0` every
  request looks like the proxy and the login limit becomes one shared bucket for the whole office. Set it to
  the real hop count — **never `true`**, which trusts the whole `X-Forwarded-For` chain and lets a client
  forge an address to skip the limiter.
- `MQTT_ENABLED` (optional, default effectively `true`): set to `"false"` to skip connecting to HiveMQ
  entirely — useful when working on UI/other features and you don't need live device data. The HTTP API
  still runs normally either way; only the MQTT subscriber is skipped.
  - **Requires a restart to take effect.** `dotenv` loads `.env` once at process startup; editing this value
    while a server is already running does nothing until you stop and start it again. The log line at
    startup (`[mqtt] disabled (MQTT_ENABLED=false)` vs `[mqtt] connected, subscribing to ...`) is the way to
    confirm which mode the currently-running process is actually in.
- `ROLLUP_ENABLED` (optional, default effectively `true`): set to `"false"` to skip the in-process hourly
  reading rollup/retention job (e.g. if it's driven by an external scheduler calling
  `npm run rollup:readings` instead). Same restart-to-take-effect caveat as `MQTT_ENABLED`.
- `RAW_RETENTION_DAYS` (optional, default `30`): how long raw `Reading` rows are kept before being pruned
  (they're summarized into `ReadingHourly` first, which is kept forever). Floored at 8 days regardless of
  what's set, since a lower value could prune a row before a device's buffered backlog upload for it arrives.
- `WATCHDOG_ENABLED` (optional, default effectively `true`): set to `"false"` to skip the in-process
  device-offline watchdog (e.g. if it's driven by an external scheduler calling `npm run watchdog:devices`
  instead). Same restart-to-take-effect caveat as `MQTT_ENABLED`.

**Email confirmation** is currently disabled in Supabase (Authentication → Providers → Email → "Confirm
email"). Invited users confirm their email by opening the invite link either way. Re-enable it before
production.

## Known follow-ups (not yet built)

- Finer-grained roles for pond/device management (today: any signed-in user reads, only `ADMIN` writes).
- No CI yet; `npm test` must be run locally.
- `readingsSubscriber.handleReadingsMessage` (signature-before-lastSeenAt ordering, rate limit) is not yet
  unit-tested; it needs extracting from the module that reads `MQTT_*` at import.
