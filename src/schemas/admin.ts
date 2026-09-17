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

const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

// Keyset pagination for GET /admin/audit. `before` is an opaque cursor from a previous page's `nextCursor`.
// `action` and `targetType` are free strings rather than enums on purpose: the log holds history, including
// pre-refactor actions like `office.*` and `user.promote_super_admin` that no longer exist in the code.
export const auditPageQuery = z.object({
  action: z.string().trim().min(1).max(64).optional(),
  targetType: z.string().trim().min(1).max(64).optional(),
  actorId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
