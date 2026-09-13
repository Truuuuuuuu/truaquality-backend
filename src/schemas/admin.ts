import { z } from "zod";

export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  fullName: z.string().trim().min(1),
  systemRole: z.enum(["ADMIN", "USER"]).default("USER"),
});

export const updateStatusSchema = z.object({
  status: z.enum(["ACTIVE", "DISABLED"]),
});

export const userIdParams = z.object({ id: z.uuid() });
