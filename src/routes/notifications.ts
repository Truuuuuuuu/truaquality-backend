import { Router } from "express";
import type { z } from "zod";
import { decodeNotificationsCursor, encodeNotificationsCursor } from "../lib/notificationsCursor.ts";
import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { validate } from "../middleware/validate.ts";
import { notificationIdParams, notificationsPageQuery } from "../schemas/notifications.ts";

// A user only ever sees and changes their own notifications; there is no admin view of someone else's inbox.
export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

// Newest-first, keyset-paginated. Also returns the caller's total unread count, so the frontend's bell badge and
// its dropdown share one poll. `unread=true` leaves out notifications already read.
notificationsRouter.get("/", validate(notificationsPageQuery, "query"), async (req, res) => {
  const profileId = req.profile!.id;
  const { before, limit, unread } = res.locals.query as z.infer<typeof notificationsPageQuery>;

  const cursor = before ? decodeNotificationsCursor(before) : null;
  if (before && !cursor) {
    return res.status(400).json({ error: "invalid cursor" });
  }

  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: {
        profileId,
        ...(unread ? { readAt: null } : {}),
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        kind: true,
        severity: true,
        value: true,
        recordedAt: true,
        readAt: true,
        createdAt: true,
        alert: {
          select: { id: true, parameter: true, resolvedAt: true, pond: { select: { id: true, name: true } } },
        },
      },
    }),
    prisma.notification.count({ where: { profileId, readAt: null } }),
  ]);

  const last = rows.at(-1);
  const nextCursor = last && rows.length === limit ? encodeNotificationsCursor(last) : null;

  res.json({ notifications: rows, unreadCount, nextCursor });
});

notificationsRouter.post("/read-all", async (req, res) => {
  const { count } = await prisma.notification.updateMany({
    where: { profileId: req.profile!.id, readAt: null },
    data: { readAt: new Date() },
  });
  res.json({ updated: count });
});

notificationsRouter.post("/:id/read", validate(notificationIdParams, "params"), async (req, res) => {
  const { id } = req.params as z.infer<typeof notificationIdParams>;
  const profileId = req.profile!.id;

  // Scoped to the caller, so someone else's notification id reads as not found rather than being marked.
  const { count } = await prisma.notification.updateMany({
    where: { id, profileId, readAt: null },
    data: { readAt: new Date() },
  });
  if (count === 0 && (await prisma.notification.count({ where: { id, profileId } })) === 0) {
    return res.status(404).json({ error: "notification not found" });
  }
  res.json({ ok: true });
});
