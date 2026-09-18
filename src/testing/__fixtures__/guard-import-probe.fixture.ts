import { test } from "node:test";
// Importing the shared fake is the whole point: it pulls in guardEnv.ts, which asserts on import.
// If the guard is doing its job this file never gets as far as registering the test below.
import "../prismaFake.ts";

// Named *.fixture.ts so the main `src/**/*.test.ts` glob never picks it up. Target of the
// no-global-setup subprocess check in dbGuard.test.ts (WR-01).
test("guard import probe ran", () => {});
