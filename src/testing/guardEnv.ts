import { assertLocalDatabase } from "./dbGuard.ts";

// The same fail-closed check as globalSetup.ts, but on an import instead of a runner flag.
//
// globalSetup only runs because `--test-global-setup=./src/testing/globalSetup.ts` is on the
// `test`/`test:coverage` command lines. `node --test src/lib/ingest.test.ts`, an IDE's "run test"
// gutter action, and any hand-typed `node --test src/**` skip it — and they skip
// `--env-file=test.env` with it, so DATABASE_URL falls back to whatever the developer's shell
// holds. That is exactly the threat model dbGuard.ts exists for, and documentation is not an
// enforcement mechanism.
//
// Importing this module runs the assertion, so every test that reaches a Prisma delegate, an HTTP
// fake or the JWT helpers is guarded however it was launched. dbGuard.ts itself stays pure (env is
// passed in), which is what keeps it unit-testable against literal env objects.
assertLocalDatabase(process.env);
