import type { Prisma } from "../generated/prisma/client.ts";

// Fans an event (an alert episode update or a device going offline/online) out to every active user. Single
// org and a handful of staff, so a row per recipient is cheap and gives each of them their own read state.
// Invited users who haven't signed in yet start with a clean inbox.
export async function notifyActiveUsers(
  tx: Prisma.TransactionClient,
  event: Omit<Prisma.NotificationCreateManyInput, "profileId">,
) {
  const recipients = await tx.profile.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  if (recipients.length === 0) return;
  await tx.notification.createMany({ data: recipients.map(({ id }) => ({ profileId: id, ...event })) });
}
