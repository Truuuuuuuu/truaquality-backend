-- Built CONCURRENTLY so these don't take a write lock on AuditLog/Reading/ReadingHourly while they're
-- built — all three tables take steady write traffic (audit rows, per-minute readings, hourly rollups).
-- Prisma detects CONCURRENTLY and runs this migration outside a transaction, since Postgres refuses
-- CREATE INDEX CONCURRENTLY inside one.

-- CreateIndex
CREATE INDEX CONCURRENTLY "AuditLog_createdAt_id_idx" ON "AuditLog"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX CONCURRENTLY "Reading_pondId_recordedAt_id_idx" ON "Reading"("pondId", "recordedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX CONCURRENTLY "ReadingHourly_pondId_bucketStart_idx" ON "ReadingHourly"("pondId", "bucketStart");
