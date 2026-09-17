// Opaque keyset-pagination cursor for GET /notifications, same idea as readingsCursor.ts: the last row's
// (createdAt, id), so a page resumes with `createdAt < X OR (createdAt = X AND id < idX)` even while new
// notifications keep arriving at the top.
export type NotificationsCursor = { createdAt: Date; id: string };

export function encodeNotificationsCursor(cursor: NotificationsCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

// Guarded like readingsCursor.ts: the cursor arrives straight from a query string, so a malformed
// one has to read as "no cursor" (a 400 from the route) rather than throwing into a 500.
export function decodeNotificationsCursor(value: string): NotificationsCursor | null {
  try {
    const [iso, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
    const createdAt = new Date(iso ?? "");
    if (!iso || Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
