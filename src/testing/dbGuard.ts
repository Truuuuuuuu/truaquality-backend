// Fail-closed guard that keeps the test suite away from any non-local database.
//
// Pure on purpose: no environment reads or env-file loading, no src/lib imports. The caller
// (globalSetup.ts) passes the environment in, which keeps this unit-testable with
// literal env objects.

// `postgres:` is a non-special URL scheme, so Node's URL parser keeps the host's
// original case and keeps the brackets around IPv6 literals. Compare lowercased
// against the bracketed form.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// `@prisma/adapter-pg` builds its pool through `pg` -> `pg-connection-string`, which folds the
// connection string's query parameters into the connection config — and `host`/`hostaddr` there
// OVERRIDE the host parsed from the URL authority. So
// `postgresql://u:p@127.0.0.1:1/db?host=db.prod.supabase.co` has a localhost `hostname` and still
// connects to production. Checking `new URL(raw).hostname` alone therefore fails OPEN.
//
// These are rejected outright rather than resolved: a `?host=/cloudsql/project:region:instance`
// unix socket looks local but is a proxy to a remote instance, so "the override is a path" is not
// proof of locality. Nothing in this suite needs a socket connection, and a guard whose whole job is
// to fail closed should not carry an exception it cannot verify.
const HOST_OVERRIDING_PARAMS = ["host", "hostaddr"];

// Checks one URL-valued variable. An unset/empty value is refused only when
// `required`: an empty DATABASE_URL is not "no database", because pg then falls
// back to PGHOST and its other defaults. Errors name the variable and at most the
// hostname — never `raw`, which carries the database password.
export function assertLocalUrl(name: string, raw: string | undefined, required: boolean): void {
  if (!raw) {
    if (required) throw new Error(`[test-guard] ${name} must be set to a localhost database`);
    return;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`[test-guard] ${name} is not a valid URL`);
  }

  for (const param of HOST_OVERRIDING_PARAMS) {
    if (url.searchParams.has(param)) {
      throw new Error(`[test-guard] refusing to run: ${name} overrides the host via "?${param}="`);
    }
  }

  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`[test-guard] refusing to run: ${name} host is "${host}", not localhost/127.0.0.1`);
  }
}

// Credentials that must not exist in a test process at all. test.env leaves them out on purpose so an
// accidental import of readingsSubscriber.ts or supabaseAdmin.ts fails loudly — but --env-file never
// overwrites an existing variable, so a developer who sourced .env or exported these for a manual run
// gets the real ones instead. That means a live MQTT_URL/MQTT_PASSWORD (a second connection on the
// backend's client id, which disconnects the real subscriber) or a SUPABASE_SECRET_KEY that hands a
// test an admin client able to ban and delete real users. Absence has to be checked, not assumed.
const MUST_BE_ABSENT = ["SUPABASE_SECRET_KEY", "MQTT_URL", "MQTT_USERNAME", "MQTT_PASSWORD"];

// Names the variable and never its value.
export function assertAbsent(name: string, value: string | undefined): void {
  if (value) {
    throw new Error(`[test-guard] refusing to run: ${name} must not be set for tests (unset it in this shell)`);
  }
}

// Variables exported in the developer's shell override the ones in test.env
// (`--env-file` never overwrites an existing variable), so a shell holding the real
// Supabase DATABASE_URL would otherwise point the tests at production. This checks
// the effective environment, whatever its source.
// - DATABASE_URL: required, must be local.
// - DIRECT_URL: optional; a future migrate-based integration test would use it.
// - SUPABASE_URL: optional; refusing a remote one stops auth tests from fetching a
//   real JWKS if a fetch stub is ever forgotten.
// - SUPABASE_SECRET_KEY / MQTT_*: must be absent entirely (see MUST_BE_ABSENT above).
export function assertLocalDatabase(env: NodeJS.ProcessEnv): void {
  assertLocalUrl("DATABASE_URL", env.DATABASE_URL, true);
  assertLocalUrl("DIRECT_URL", env.DIRECT_URL, false);
  assertLocalUrl("SUPABASE_URL", env.SUPABASE_URL, false);
  for (const name of MUST_BE_ABSENT) {
    assertAbsent(name, env[name]);
  }
}
