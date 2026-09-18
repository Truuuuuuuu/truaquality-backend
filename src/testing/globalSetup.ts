import { assertLocalDatabase } from "./dbGuard.ts";

// Loaded by `node --test --test-global-setup=./src/testing/globalSetup.ts`. Runs once,
// in the parent process, before any test file loads. Throwing here aborts the whole
// run with a non-zero exit, so no test ever gets a chance to open a connection.
export async function globalSetup() {
  assertLocalDatabase(process.env);
}
