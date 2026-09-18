// Deletes every stored trace of a sensor parameter that has been removed from PARAMETER_BOUNDS: raw readings,
// hourly summaries, and alert episodes (their notifications cascade with them). Nothing else ever cleans these
// up — ingest just rejects the id from then on, so an alert left open for it would never resolve.
//
//   npm run purge:parameters -- --parameter <id> [--parameter ...] [--apply]
//
// Without --apply it only prints what would be deleted. Refuses any id that is still a live parameter.
import "dotenv/config";
import { parseArgs } from "node:util";
import { isParameterId } from "../src/lib/parameters.ts";
import { prisma } from "../src/lib/prisma.ts";

const { values } = parseArgs({
  options: {
    parameter: { type: "string", multiple: true },
    apply: { type: "boolean", default: false },
  },
});

const parameters = values.parameter ?? [];
if (parameters.length === 0) {
  console.error("Usage: npm run purge:parameters -- --parameter <id> [--parameter ...] [--apply]");
  process.exit(1);
}
const live = parameters.filter(isParameterId);
if (live.length > 0) {
  console.error(`Refusing to purge live parameter(s): ${live.join(", ")}. Remove them from PARAMETER_BOUNDS first.`);
  process.exit(1);
}

const where = { parameter: { in: parameters } };
const alertIds = { alert: where };

const counts = {
  readings: await prisma.reading.count({ where }),
  hourly: await prisma.readingHourly.count({ where }),
  alerts: await prisma.alert.count({ where }),
  openAlerts: await prisma.alert.count({ where: { ...where, resolvedAt: null } }),
  notifications: await prisma.notification.count({ where: alertIds }),
};
console.log(`Parameters: ${parameters.join(", ")}`);
console.log(counts);

if (!values.apply) {
  console.log("Dry run — pass --apply to delete.");
  process.exit(0);
}

const [readings, hourly, alerts] = await prisma.$transaction([
  prisma.reading.deleteMany({ where }),
  prisma.readingHourly.deleteMany({ where }),
  // Notifications go with their alert (onDelete: Cascade).
  prisma.alert.deleteMany({ where }),
]);
console.log(`Deleted ${readings.count} readings, ${hourly.count} hourly summaries, ${alerts.count} alerts.`);
process.exit(0);
