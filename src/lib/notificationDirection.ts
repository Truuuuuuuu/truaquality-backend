// Pure helper for GET /notifications' `direction` — no Prisma, no env — so it tests without a database.
import { isParameterId, thresholdsFor } from "./parameters.ts";

// Below the safe floor reads as "low", anything else as "high". An unknown parameter id (an older row from
// before a parameter was renamed) has no threshold to compare against, so it falls back to "high". Only
// meaningful for ALERT_* rows, which are the only ones with an alert and a value. For pH this gives "low" =
// acidic and "high" = alkaline; the words "acidic"/"alkaline" are rendered by the frontend (Phase 12).
export function notificationDirection(
  parameter: string,
  value: number,
  pondType: string | null | undefined,
): "low" | "high" {
  if (!isParameterId(parameter)) return "high";
  return value < thresholdsFor(pondType)[parameter].safeMin ? "low" : "high";
}
