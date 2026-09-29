import type { Prisma } from "../generated/prisma/client.ts";

// Every device field safe to send to the frontend.
export const deviceSummarySelect = {
  id: true,
  serial: true,
  hardwareModel: true,
  label: true,
  secretVersion: true,
  status: true,
  pondId: true,
  assignedAt: true,
  firmwareVersion: true,
  wifiSsid: true,
  lastSeenAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DeviceSelect;

// sensorStatus is a Prisma Json column; only string values are real status tokens. Shared by the device
// diagnostics route and the pond payload, which both hand the unit's last word on each sensor to the frontend.
export function reportedStatuses(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
