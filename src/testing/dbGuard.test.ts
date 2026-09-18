import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertLocalDatabase } from "./dbGuard.ts";

// Every case passes a literal env object — never process.env — so the table is
// independent of whatever the developer's shell or test.env happens to hold.

const ACCEPTED_DATABASE_URLS = [
  "postgresql://test:test@localhost:5432/truaquality_test",
  "postgresql://test:test@127.0.0.1:1/truaquality_test",
  "postgresql://test:test@[::1]:5432/truaquality_test",
  "postgresql://test:test@LOCALHOST:5432/truaquality_test",
];

for (const url of ACCEPTED_DATABASE_URLS) {
  test(`accepts local DATABASE_URL ${url}`, () => {
    assert.doesNotThrow(() => assertLocalDatabase({ DATABASE_URL: url }));
  });
}

const REMOTE_DATABASE_URLS = [
  "postgresql://postgres.abc:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
  "postgres://u:p@db.abc.supabase.co:5432/postgres",
  "postgres://u:p@10.0.0.5/db",
];

for (const url of REMOTE_DATABASE_URLS) {
  test(`refuses non-local DATABASE_URL ${new URL(url).hostname}`, () => {
    assert.throws(
      () => assertLocalDatabase({ DATABASE_URL: url }),
      /^Error: \[test-guard\] refusing to run: DATABASE_URL host is/,
    );
  });
}

test("refuses an empty DATABASE_URL (pg would fall back to PGHOST defaults)", () => {
  assert.throws(
    () => assertLocalDatabase({ DATABASE_URL: "" }),
    /^Error: \[test-guard\] DATABASE_URL must be set/,
  );
});

test("refuses a missing DATABASE_URL", () => {
  assert.throws(
    () => assertLocalDatabase({}),
    /^Error: \[test-guard\] DATABASE_URL must be set/,
  );
});

test("refuses an unparseable DATABASE_URL", () => {
  assert.throws(
    () => assertLocalDatabase({ DATABASE_URL: "not a url" }),
    /^Error: \[test-guard\] DATABASE_URL is not a valid URL/,
  );
});

const LOCAL_DB = "postgresql://test:test@127.0.0.1:1/truaquality_test";

for (const name of ["DIRECT_URL", "SUPABASE_URL"] as const) {
  test(`accepts an unset ${name}`, () => {
    assert.doesNotThrow(() => assertLocalDatabase({ DATABASE_URL: LOCAL_DB }));
  });

  test(`accepts a local ${name}`, () => {
    assert.doesNotThrow(() =>
      assertLocalDatabase({ DATABASE_URL: LOCAL_DB, [name]: "http://127.0.0.1:54321" }),
    );
  });

  test(`refuses a non-local ${name}`, () => {
    assert.throws(
      () =>
        assertLocalDatabase({
          DATABASE_URL: LOCAL_DB,
          [name]: "https://abcdefgh.supabase.co",
        }),
      new RegExp(`^Error: \\[test-guard\\] refusing to run: ${name} host is "abcdefgh\\.supabase\\.co"`),
    );
  });
}

test("refusal message names the host but never leaks the URL password", () => {
  const url = "postgres://u:secretpw@db.x.supabase.co/postgres";
  assert.throws(
    () => assertLocalDatabase({ DATABASE_URL: url }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /^\[test-guard\] refusing to run/);
      assert.match(err.message, /"db\.x\.supabase\.co"/);
      assert.ok(!err.message.includes("secretpw"), "message must not contain the password");
      assert.ok(!err.message.includes(url), "message must not contain the full URL");
      return true;
    },
  );
});

test("unparseable-URL message does not echo the raw value", () => {
  const raw = "postgres://u:secretpw@ bad host/postgres";
  assert.throws(
    () => assertLocalDatabase({ DATABASE_URL: raw }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /^\[test-guard\]/);
      assert.ok(!err.message.includes("secretpw"));
      return true;
    },
  );
});

// End-to-end proof that the real `npm test` wiring refuses a shell-exported remote
// DATABASE_URL. The child gets the same flags as the `test` script, but the override
// is passed through `env` exactly as a shell export would be — and shell exports win
// over --env-file. Targets a *.fixture.ts file so it never recurses into this suite.
const BACKEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function runGuardProbe(databaseUrl: string) {
  // Under `node --test` this file runs in a child that carries NODE_TEST_CONTEXT. Passed on,
  // it makes the probe think it is a nested run and skip its files ("run() is being called
  // recursively"), so drop it to get a genuine top-level runner like `npm test`.
  const { NODE_TEST_CONTEXT: _nested, ...parentEnv } = process.env;
  const result = spawnSync(
    process.execPath,
    [
      "--env-file=test.env",
      "--test",
      "--test-global-setup=./src/testing/globalSetup.ts",
      "src/testing/__fixtures__/guard-probe.fixture.ts",
    ],
    {
      cwd: BACKEND_ROOT,
      env: { ...parentEnv, DATABASE_URL: databaseUrl },
      encoding: "utf8",
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("test runner refuses a shell-exported remote DATABASE_URL before any test loads", () => {
  const { status, output } = runGuardProbe(
    "postgres://u:secretpw@db.example.supabase.co:5432/postgres",
  );
  assert.notEqual(status, 0);
  assert.match(output, /refusing to run/);
  assert.ok(!output.includes("secretpw"), "guard output must not contain the password");
  assert.doesNotMatch(output, /✔ guard probe ran/);
  assert.doesNotMatch(output, /ok \d+ - guard probe ran/);
});

test("test runner allows a shell-exported localhost DATABASE_URL", () => {
  const { status, output } = runGuardProbe("postgresql://test:test@127.0.0.1:1/x");
  assert.equal(status, 0, output);
  assert.match(output, /guard probe ran/);
});
