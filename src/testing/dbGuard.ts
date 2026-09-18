// Fail-closed guard that keeps the test suite away from any non-local database.
//
// Pure on purpose: no environment reads or env-file loading, no src/lib imports. The caller
// (globalSetup.ts) passes the environment in, which keeps this unit-testable with
// literal env objects.

// `postgres:` is a non-special URL scheme, so Node's URL parser keeps the host's
// original case and keeps the brackets around IPv6 literals. Compare lowercased
// against the bracketed form.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Checks one URL-valued variable. An unset/empty value is refused only when
// `required`: an empty DATABASE_URL is not "no database", because pg then falls
// back to PGHOST and its other defaults. Errors name the variable and at most the
// hostname — never `raw`, which carries the database password.
export function assertLocalUrl(name: string, raw: string | undefined, required: boolean): void {
  if (!raw) {
    if (required) throw new Error(`[test-guard] ${name} must be set to a localhost database`);
    return;
  }

  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    throw new Error(`[test-guard] ${name} is not a valid URL`);
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`[test-guard] refusing to run: ${name} host is "${host}", not localhost/127.0.0.1`);
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
export function assertLocalDatabase(env: NodeJS.ProcessEnv): void {
  assertLocalUrl("DATABASE_URL", env.DATABASE_URL, true);
  assertLocalUrl("DIRECT_URL", env.DIRECT_URL, false);
  assertLocalUrl("SUPABASE_URL", env.SUPABASE_URL, false);
}
