import { test } from "node:test";
import assert from "node:assert/strict";
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
