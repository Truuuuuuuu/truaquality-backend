import { test } from "node:test";
import assert from "node:assert/strict";
import { inviteUserSchema, updateRoleSchema } from "./admin.ts";

const invite = { email: "staff@example.test", fullName: "BFAR Staff" };

test("role changes require an explicit valid role", () => {
  for (const systemRole of ["ADMIN", "STAFF"]) {
    assert.equal(updateRoleSchema.parse({ systemRole }).systemRole, systemRole);
  }
  for (const systemRole of [undefined, null, "USER", "SUPER_ADMIN", "admin", ""]) {
    assert.equal(updateRoleSchema.safeParse({ systemRole }).success, false);
  }
});

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
