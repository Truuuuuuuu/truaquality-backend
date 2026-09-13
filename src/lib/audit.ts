import type { Prisma } from "../generated/prisma/client.ts";
import { prisma } from "./prisma.ts";

type AuditEntry = {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Prisma.InputJsonValue;
};

export function logAudit(entry: AuditEntry, db: Prisma.TransactionClient = prisma) {
  return db.auditLog.create({ data: entry });
}
