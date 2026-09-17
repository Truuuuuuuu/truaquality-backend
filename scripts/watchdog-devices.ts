// Runs one device-offline-watchdog cycle and exits. Useful for testing the job manually, or for triggering
// it from an external scheduler instead of the in-process interval (set WATCHDOG_ENABLED=false on the
// server in that case, so the two don't double up).
//
//   npm run watchdog:devices
import "dotenv/config";
import { runDeviceWatchdogCycle } from "../src/lib/deviceWatchdog.ts";

const result = await runDeviceWatchdogCycle();
if (result === null) {
  console.log("[watchdog] another process already holds the watchdog lock; skipped");
} else {
  console.log(`[watchdog] ${result.offline} device(s) went offline, ${result.online} recovered`);
}
process.exit(0);
