// Opaque keyset-pagination cursor for GET /ponds/:id/readings. Encodes the last row's (recordedAt, id) so
// the next page can resume with `recordedAt < X OR (recordedAt = X AND id < idX)` — stable even when
// several parameters share the same recordedAt, unlike an offset that shifts as new readings arrive.
export type ReadingsCursor = { recordedAt: Date; id: bigint };

export function encodeReadingsCursor(cursor: ReadingsCursor): string {
  return Buffer.from(`${cursor.recordedAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeReadingsCursor(value: string): ReadingsCursor | null {
  try {
    const [iso, idString] = Buffer.from(value, "base64url").toString("utf8").split("|");
    const recordedAt = new Date(iso ?? "");
    if (!iso || Number.isNaN(recordedAt.getTime()) || !idString) return null;
    return { recordedAt, id: BigInt(idString) };
  } catch {
    return null;
  }
}
