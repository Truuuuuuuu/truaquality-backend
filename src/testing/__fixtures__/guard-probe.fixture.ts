import { test } from "node:test";

// Named *.fixture.ts so the main `src/**/*.test.ts` glob never picks it up. It exists
// only as the target of the subprocess check in dbGuard.test.ts: if the global-setup
// guard refuses the run, this test must never execute.
test("guard probe ran", () => {});
