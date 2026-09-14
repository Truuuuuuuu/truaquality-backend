import { z } from "zod";

export const deviceIdParams = z.object({ id: z.uuid() });

export const createDeviceSchema = z.object({
  serial: z.string().trim().min(1).max(64),
  hardwareModel: z.string().trim().max(80).optional(),
  label: z.string().trim().max(80).optional(),
  pondId: z.uuid().optional(),
});

export const updateDeviceSchema = z.object({
  hardwareModel: z.string().trim().max(80).nullable().optional(),
  label: z.string().trim().max(80).nullable().optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  // null unassigns the device from its pond.
  pondId: z.uuid().nullable().optional(),
});
