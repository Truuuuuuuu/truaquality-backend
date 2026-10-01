import { z } from "zod";

// Opaque keyset-pagination cursor for GET /admin/audit, same shape as notificationsCursor.ts: the last row's
// (createdAt, id), so a page resumes with `createdAt < X OR (createdAt = X AND id < idX)` even while new
// admin actions keep landing at the top.
export type AuditCursor = { createdAt: Date; id: string };

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

// Guarded like the other cursors: this arrives straight from a query string, so a malformed one has to read
// as "no cursor" (a 400 from the route) rather than throwing into a 500.
export function decodeAuditCursor(value: string): AuditCursor | null {
  try {
    const [iso, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
    const createdAt = new Date(iso ?? "");
    // The id column is @db.Uuid: a non-UUID id would reach Postgres as a failed ::uuid cast and surface as a 500,
    // so a tampered cursor is rejected here and the route answers 400.
    if (!iso || Number.isNaN(createdAt.getTime()) || !id || !z.uuid().safeParse(id).success) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
