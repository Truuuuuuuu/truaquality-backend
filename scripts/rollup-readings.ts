// Runs one reading-rollup + retention-prune cycle and exits. Useful for testing the job manually, or for
// triggering it from an external scheduler instead of the in-process hourly interval (set
// ROLLUP_ENABLED=false on the server in that case, so the two don't double up).
//
//   npm run rollup:readings
import "dotenv/config";
import { runReadingRollupCycle } from "../src/lib/readingRollup.ts";

const result = await runReadingRollupCycle();
if (result === null) {
  console.log("[rollup] another process already holds the rollup lock; skipped");
} else {
  console.log(`[rollup] summarized recent hours, pruned ${result.deletedRawReadings} raw readings`);
}
process.exit(0);
