import "../testing/guardEnv.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./prisma.ts";
import { changeUserRole, changeUserStatus, deleteStaffAccount } from "./userRoles.ts";

type Row = { id: string; systemRole: "ADMIN" | "STAFF"; status: "ACTIVE" | "INVITED" | "DISABLED" | "DELETED"; email: string };
const row = (id: string, systemRole: Row["systemRole"] = "STAFF", status: Row["status"] = "ACTIVE"): Row =>
  ({ id, systemRole, status, email: `${id}@example.test` });

function install(t: TestContext, initial: Row[], failAudit = false) {
  const rows = new Map(initial.map((r) => [r.id, { ...r }]));
  const audit: Record<string, unknown>[] = [];
  let tail = Promise.resolve();
  const transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    let release: (() => void) | undefined;
    let snapshot: Map<string, Row> | undefined;
    let auditLength = audit.length;
    const tx = {
      $executeRaw: async () => {
        const before = tail;
        tail = new Promise<void>((resolve) => { release = resolve; });
        await before;
        snapshot = structuredClone(rows);
        auditLength = audit.length;
      },
      profile: {
        findUnique: async ({ where }: { where: { id: string } }) => structuredClone(rows.get(where.id) ?? null),
        count: async () => [...rows.values()].filter((r) => r.systemRole === "ADMIN" && r.status === "ACTIVE").length,
        update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const updated = { ...rows.get(where.id)!, ...data };
          rows.set(where.id, updated);
          return { ...updated };
        },
      },
      notification: { deleteMany: async () => ({ count: 0 }) },
      auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => {
        if (failAudit) throw new Error("audit failed");
        audit.push(data);
        return data;
      } },
    };
    try { return await fn(tx); }
    catch (err) {
      if (snapshot) {
        rows.clear();
        for (const [id, value] of snapshot) rows.set(id, value);
        audit.splice(auditLength);
      }
      throw err;
    } finally { release?.(); }
  };
  t.mock.property(prisma, "$transaction", transaction as never);
  return { rows, audit };
}

test("promotion and demotion preserve identity and record old/new roles", async (t) => {
  const db = install(t, [row("actor", "ADMIN"), row("target")]);
  await changeUserRole("actor", "target", "ADMIN");
  await changeUserRole("actor", "target", "STAFF");
  assert.equal(db.rows.get("target")?.systemRole, "STAFF");
  assert.deepEqual(db.audit.map((a) => [a.action, a.actorId, a.targetId, a.metadata]), [
    ["user.promote_admin", "actor", "target", { previousRole: "STAFF", newRole: "ADMIN" }],
    ["user.demote_admin", "actor", "target", { previousRole: "ADMIN", newRole: "STAFF" }],
  ]);
});

for (const status of ["INVITED", "DISABLED", "DELETED"] as const) {
  test(`rejects ${status} target without audit`, async (t) => {
    const db = install(t, [row("actor", "ADMIN"), row("target", "STAFF", status)]);
    await assert.rejects(changeUserRole("actor", "target", "ADMIN"), { status: status === "DELETED" ? 404 : 409 });
    assert.equal(db.audit.length, 0);
    assert.equal(db.rows.get("target")?.systemRole, "STAFF");
  });
}

test("rejects own role, absent target and unchanged role", async (t) => {
  const db = install(t, [row("actor", "ADMIN"), row("target")]);
  await assert.rejects(changeUserRole("actor", "actor", "STAFF"), { status: 400 });
  await assert.rejects(changeUserRole("actor", "missing", "ADMIN"), { status: 404 });
  await assert.rejects(changeUserRole("actor", "target", "STAFF"), { status: 409 });
  assert.equal(db.audit.length, 0);
});

for (const actor of [row("actor"), row("actor", "ADMIN", "DISABLED"), row("actor", "ADMIN", "INVITED")]) {
  test(`rejects unauthorized ${actor.systemRole}/${actor.status} actor`, async (t) => {
    const db = install(t, [actor, row("target", "ADMIN")]);
    await assert.rejects(changeUserRole("actor", "target", "STAFF"), { status: 403 });
    assert.equal(db.audit.length, 0);
  });
}

test("concurrent cross-demotions retain one admin and reauthorize the waiting actor", async (t) => {
  const db = install(t, [row("a", "ADMIN"), row("b", "ADMIN")]);
  const results = await Promise.allSettled([changeUserRole("a", "b", "STAFF"), changeUserRole("b", "a", "STAFF")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal([...db.rows.values()].filter((r) => r.systemRole === "ADMIN").length, 1);
  assert.equal(db.audit.length, 1);
});

test("audit failure rolls back role mutation", async (t) => {
  const db = install(t, [row("actor", "ADMIN"), row("target")], true);
  await assert.rejects(changeUserRole("actor", "target", "ADMIN"), /audit failed/);
  assert.equal(db.rows.get("target")?.systemRole, "STAFF");
  assert.equal(db.audit.length, 0);
});

test("promotion racing disable cannot leave a disabled admin", async (t) => {
  const db = install(t, [row("actor", "ADMIN"), row("target")]);
  const results = await Promise.allSettled([changeUserRole("actor", "target", "ADMIN"), changeUserStatus("actor", "target", "DISABLED")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(db.rows.get("target")?.status, "ACTIVE");
});

test("disable racing promotion cannot promote disabled staff", async (t) => {
  const db = install(t, [row("actor", "ADMIN"), row("target")]);
  const results = await Promise.allSettled([changeUserStatus("actor", "target", "DISABLED"), changeUserRole("actor", "target", "ADMIN")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(db.rows.get("target")?.systemRole, "STAFF");
});

test("promotion racing self-delete never deletes an admin login", async (t) => {
  const db = install(t, [row("actor", "ADMIN"), row("target")]);
  let deleted = false;
  const results = await Promise.allSettled([changeUserRole("actor", "target", "ADMIN"), deleteStaffAccount("target", async () => { deleted = true; })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(deleted, false);
  assert.equal(db.rows.get("target")?.status, "ACTIVE");
});

test("self-delete racing promotion cannot promote a deleted login", async (t) => {
  const db = install(t, [row("actor", "ADMIN"), row("target")]);
  let deleted = false;
  const results = await Promise.allSettled([deleteStaffAccount("target", async () => { deleted = true; }), changeUserRole("actor", "target", "ADMIN")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(deleted, true);
  assert.equal(db.rows.get("target")?.status, "DELETED");
});

test("failed auth deletion leaves profile and audit untouched", async (t) => {
  const db = install(t, [row("target")]);
  await assert.rejects(deleteStaffAccount("target", async () => { throw new Error("upstream failed"); }), /upstream failed/);
  assert.equal(db.rows.get("target")?.status, "ACTIVE");
  assert.equal(db.audit.length, 0);
});

test("status changes retain own-account, admin and deleted-account protections", async (t) => {
  const db = install(t, [row("actor", "ADMIN"), row("admin", "ADMIN"), row("deleted", "STAFF", "DELETED")]);
  await assert.rejects(changeUserStatus("actor", "actor", "DISABLED"), { status: 400 });
  await assert.rejects(changeUserStatus("actor", "admin", "DISABLED"), { status: 400 });
  await assert.rejects(changeUserStatus("actor", "deleted", "ACTIVE"), { status: 404 });
  assert.equal(db.audit.length, 0);
});

test("ban finishes before re-enable and promotion can proceed", async (t) => {
  const db = install(t, [row("actor", "ADMIN"), row("target")]);
  const events: string[] = [];
  let releaseBan!: () => void;
  let banStarted!: () => void;
  const started = new Promise<void>((resolve) => { banStarted = resolve; });
  const pendingBan = new Promise<void>((resolve) => { releaseBan = resolve; });
  const disable = changeUserStatus("actor", "target", "DISABLED", async () => {
    banStarted();
    await pendingBan;
    events.push("ban");
  });
  await started;
  const enable = changeUserStatus("actor", "target", "ACTIVE", async () => { events.push("unban"); });
  const promote = changeUserRole("actor", "target", "ADMIN");
  releaseBan();
  await Promise.all([disable, enable, promote]);
  assert.deepEqual(events, ["ban", "unban"]);
  assert.equal(db.rows.get("target")?.systemRole, "ADMIN");
  assert.equal(db.rows.get("target")?.status, "ACTIVE");
});
