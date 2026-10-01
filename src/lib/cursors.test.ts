import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { decodeAuditCursor, encodeAuditCursor } from "./auditCursor.ts";
import { decodeNotificationsCursor, encodeNotificationsCursor } from "./notificationsCursor.ts";

const createdAt = new Date("2030-01-01T00:00:00.000Z");
const raw = (text: string) => Buffer.from(text, "utf8").toString("base64url");

for (const [name, encode, decode] of [
  ["notifications", encodeNotificationsCursor, decodeNotificationsCursor],
  ["audit", encodeAuditCursor, decodeAuditCursor],
] as const) {
  describe(`${name} cursor`, () => {
    test("round-trips a real (createdAt, uuid) pair", () => {
      const id = randomUUID();
      assert.deepEqual(decode(encode({ createdAt, id })), { createdAt, id });
    });

    test("a non-UUID id is rejected (it would be a Postgres cast error, i.e. a 500)", () => {
      assert.equal(decode(raw(`${createdAt.toISOString()}|not-a-uuid`)), null);
      assert.equal(decode(raw(`${createdAt.toISOString()}|1' OR '1'='1`)), null);
    });

    test("garbage, a bad date, or a missing id is rejected", () => {
      assert.equal(decode("%%%"), null);
      assert.equal(decode(raw("not-a-date|00000000-0000-4000-8000-000000000001")), null);
      assert.equal(decode(raw(createdAt.toISOString())), null);
      assert.equal(decode(""), null);
    });
  });
}
