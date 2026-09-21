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
