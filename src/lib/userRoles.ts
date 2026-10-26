import type { Prisma } from "../generated/prisma/client.ts";
import { logAudit } from "./audit.ts";
import { prisma } from "./prisma.ts";

export class AccountPolicyError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Role, disable and self-delete writers share this transaction-scoped lock. Checks made by
// HTTP middleware can be stale by the time a waiting mutation runs (including cross-demotions).
async function lockAccounts(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"account-administration"}, 0))`;
}

async function requireActiveAdmin(tx: Prisma.TransactionClient, actorId: string) {
  const actor = await tx.profile.findUnique({ where: { id: actorId } });
  if (!actor || actor.status !== "ACTIVE" || actor.systemRole !== "ADMIN") {
    throw new AccountPolicyError(403, "active admin access required");
  }
}

export function changeUserRole(actorId: string, id: string, systemRole: "ADMIN" | "STAFF") {
  return prisma.$transaction(async (tx) => {
    await lockAccounts(tx);
    await requireActiveAdmin(tx, actorId);
    if (id === actorId) throw new AccountPolicyError(400, "you cannot change your own role");
    const target = await tx.profile.findUnique({ where: { id } });
    if (!target || target.status === "DELETED") throw new AccountPolicyError(404, "user not found");
    if (target.status !== "ACTIVE") throw new AccountPolicyError(409, "only active users can change roles");
    if (target.systemRole === systemRole) throw new AccountPolicyError(409, "user already has this role");
    if (systemRole === "STAFF") {
      const activeAdmins = await tx.profile.count({ where: { systemRole: "ADMIN", status: "ACTIVE" } });
      if (activeAdmins <= 1) throw new AccountPolicyError(409, "at least one active admin must remain");
    }
    const profile = await tx.profile.update({ where: { id }, data: { systemRole } });
    await logAudit({
      actorId,
      action: systemRole === "ADMIN" ? "user.promote_admin" : "user.demote_admin",
      targetType: "profile",
      targetId: id,
      metadata: { previousRole: target.systemRole, newRole: systemRole },
    }, tx);
    return profile;
  });
}

export function changeUserStatus(
  actorId: string, id: string, status: "ACTIVE" | "DISABLED", syncAuth: () => Promise<void> = async () => {},
) {
  return prisma.$transaction(async (tx) => {
    await lockAccounts(tx);
    await requireActiveAdmin(tx, actorId);
    if (status === "DISABLED" && id === actorId) {
      throw new AccountPolicyError(400, "you cannot disable your own account");
    }
    const target = await tx.profile.findUnique({ where: { id } });
    if (!target || target.status === "DELETED") throw new AccountPolicyError(404, "user not found");
    if (status === "DISABLED" && target.systemRole === "ADMIN") {
      throw new AccountPolicyError(400, "admins cannot be disabled");
    }
    if (status === "ACTIVE" && target.status !== "DISABLED") {
      throw new AccountPolicyError(409, "only disabled users can be re-enabled");
    }
    const profile = await tx.profile.update({ where: { id }, data: { status } });
    await logAudit({ actorId, action: status === "DISABLED" ? "user.disable" : "user.enable",
      targetType: "profile", targetId: id }, tx);
    // Keep external ban/unban ordered with role changes as well. The caller captures upstream
    // failures without throwing so the DB status still commits and enforces the lockout.
    await syncAuth();
    return profile;
  }, { timeout: 15_000 });
}

export function deleteStaffAccount(id: string, deleteAuthUser: () => Promise<void>) {
  return prisma.$transaction(async (tx) => {
    await lockAccounts(tx);
    const target = await tx.profile.findUnique({ where: { id } });
    if (!target || target.status !== "ACTIVE") throw new AccountPolicyError(403, "active account required");
    if (target.systemRole === "ADMIN") throw new AccountPolicyError(403, "admin accounts cannot be deleted");
    // Keep the lock across auth deletion so a promotion cannot slip between the role check and
    // removal of the login. Supabase still goes first: an upstream failure leaves the profile intact.
    await deleteAuthUser();
    await tx.notification.deleteMany({ where: { profileId: id } });
    await tx.profile.update({ where: { id }, data: {
      status: "DELETED", deletedAt: new Date(), fullName: "Deleted user", email: `deleted-${id}@deleted.invalid`,
    } });
    // Preserve the real address in the audit trail after anonymizing the profile.
    await logAudit({ actorId: id, action: "user.delete_self", targetType: "profile", targetId: id,
      metadata: { email: target.email } }, tx);
  }, { timeout: 15_000 });
}
