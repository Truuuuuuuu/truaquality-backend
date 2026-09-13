import { z } from "zod";

const officeRole = z.enum(["MANAGER", "MEMBER"]);

export const createOfficeSchema = z.object({
  name: z.string().trim().min(1),
  code: z.string().trim().toUpperCase().min(1).max(32),
  region: z.string().trim().min(1).optional(),
});

export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  fullName: z.string().trim().min(1),
  officeId: z.uuid(),
  officeRole: officeRole.default("MEMBER"),
  systemRole: z.enum(["SUPER_ADMIN", "USER"]).default("USER"),
});

export const updateStatusSchema = z.object({
  status: z.enum(["ACTIVE", "DISABLED"]),
});

export const addMemberSchema = z.object({
  profileId: z.uuid(),
  role: officeRole.default("MEMBER"),
});

export const userIdParams = z.object({ id: z.uuid() });
export const officeIdParams = z.object({ officeId: z.uuid() });
export const memberParams = z.object({ officeId: z.uuid(), profileId: z.uuid() });
