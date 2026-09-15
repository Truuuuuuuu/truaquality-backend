import { z } from "zod";

export const notificationIdParams = z.object({ id: z.uuid() });

export const notificationsPageQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unread: z.stringbool().default(false),
});
