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

// CR-01: pg-connection-string lets a `?host=`/`?hostaddr=` query parameter override the host parsed
// from the URL authority, so every one of these has a localhost `new URL(...).hostname` and would
// still have connected somewhere else. Verified against pg-connection-string 2.14: `?host=` replaces
// config.host outright and `?hostaddr=` sets the address pg dials.
const HOST_OVERRIDE_DATABASE_URLS = [
  "postgresql://u:p@127.0.0.1:1/db?host=db.prod.supabase.co",
  "postgresql://u:p@127.0.0.1:1/db?hostaddr=10.0.0.5",
  "postgresql://u:p@localhost:5432/db?sslmode=require&host=aws-0-ap-southeast-1.pooler.supabase.com",
  // Looks local, but a Cloud SQL socket is a proxy to a remote instance.
  "postgresql://u:p@127.0.0.1:1/db?host=/cloudsql/proj:region:inst",
];

for (const url of HOST_OVERRIDE_DATABASE_URLS) {
  const param = new URL(url).searchParams.has("hostaddr") ? "hostaddr" : "host";
  test(`refuses a DATABASE_URL that overrides the host via ?${param}= (${url.split("?")[1]})`, () => {
    // Sanity: the URL authority really is local, so only the override check can catch this.
    assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname));
    assert.throws(
      () => assertLocalDatabase({ DATABASE_URL: url }),
      new RegExp(`^Error: \\[test-guard\\] refusing to run: DATABASE_URL overrides the host via "\\?${param}="`),
    );
  });
}

test("host-override refusal does not leak the URL password", () => {
  const url = "postgresql://u:secretpw@127.0.0.1:1/db?host=db.prod.supabase.co";
  assert.throws(
    () => assertLocalDatabase({ DATABASE_URL: url }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes("secretpw"), "message must not contain the password");
      assert.ok(!err.message.includes(url), "message must not contain the full URL");
      return true;
    },
  );
});

test("a query string with no host-overriding parameter is still accepted", () => {
  assert.doesNotThrow(() =>
    assertLocalDatabase({ DATABASE_URL: "postgresql://test:test@127.0.0.1:1/db?pgbouncer=true&sslmode=disable" }),
  );
});

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

function runProbe(args: string[], databaseUrl: string) {
  // Under `node --test` this file runs in a child that carries NODE_TEST_CONTEXT. Passed on,
  // it makes the probe think it is a nested run and skip its files ("run() is being called
  // recursively"), so drop it to get a genuine top-level runner like `npm test`.
  const { NODE_TEST_CONTEXT: _nested, ...parentEnv } = process.env;
  const result = spawnSync(process.execPath, args, {
    cwd: BACKEND_ROOT,
    env: { ...parentEnv, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

// The wiring `npm test` actually uses.
const runGuardProbe = (databaseUrl: string) =>
  runProbe(
    [
      "--env-file=test.env",
      "--test",
      "--test-global-setup=./src/testing/globalSetup.ts",
      "src/testing/__fixtures__/guard-probe.fixture.ts",
    ],
    databaseUrl,
  );

// WR-01: a single-file run the way an IDE gutter action or a hand-typed command does it — no
// --test-global-setup and no --env-file. The only thing left standing is guardEnv.ts, which the
// fixture pulls in through prismaFake.ts.
const runUnguardedRunnerProbe = (databaseUrl: string) =>
  runProbe(["--test", "src/testing/__fixtures__/guard-import-probe.fixture.ts"], databaseUrl);

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

test("test runner refuses a shell-exported DATABASE_URL that overrides the host in its query string", () => {
  const { status, output } = runGuardProbe(
    "postgresql://u:secretpw@127.0.0.1:1/postgres?host=db.example.supabase.co",
  );
  assert.notEqual(status, 0);
  assert.match(output, /refusing to run: DATABASE_URL overrides the host/);
  assert.ok(!output.includes("secretpw"), "guard output must not contain the password");
  assert.doesNotMatch(output, /✔ guard probe ran/);
  assert.doesNotMatch(output, /ok \d+ - guard probe ran/);
});

test("test runner allows a shell-exported localhost DATABASE_URL", () => {
  const { status, output } = runGuardProbe("postgresql://test:test@127.0.0.1:1/x");
  assert.equal(status, 0, output);
  assert.match(output, /guard probe ran/);
});

test("a run without --test-global-setup or --env-file is still refused (guardEnv.ts on import)", () => {
  const { status, output } = runUnguardedRunnerProbe("postgres://u:secretpw@db.example.supabase.co:5432/postgres");
  assert.notEqual(status, 0);
  assert.match(output, /refusing to run: DATABASE_URL host is/);
  assert.ok(!output.includes("secretpw"), "guard output must not contain the password");
  assert.doesNotMatch(output, /✔ guard import probe ran/);
  assert.doesNotMatch(output, /ok \d+ - guard import probe ran/);
});

test("a run without --test-global-setup still proceeds on a localhost DATABASE_URL", () => {
  const { status, output } = runUnguardedRunnerProbe("postgresql://test:test@127.0.0.1:1/x");
  assert.equal(status, 0, output);
  assert.match(output, /guard import probe ran/);
});
