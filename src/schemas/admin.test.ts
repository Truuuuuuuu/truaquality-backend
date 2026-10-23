import { test } from "node:test";
import assert from "node:assert/strict";
import { inviteUserSchema } from "./admin.ts";

const invite = { email: "staff@example.test", fullName: "BFAR Staff" };

for (const systemRole of ["STAFF", "ADMIN"] as const) {
  test(`invitation accepts ${systemRole}`, () => {
    assert.equal(inviteUserSchema.parse({ ...invite, systemRole }).systemRole, systemRole);
  });
}

test("invitation defaults to STAFF when role is omitted", () => {
  assert.equal(inviteUserSchema.parse(invite).systemRole, "STAFF");
});

for (const systemRole of ["USER", "SUPER_ADMIN", "staff", "", null]) {
  test(`invitation rejects invalid role ${JSON.stringify(systemRole)}`, () => {
    assert.equal(inviteUserSchema.safeParse({ ...invite, systemRole }).success, false);
  });
}
