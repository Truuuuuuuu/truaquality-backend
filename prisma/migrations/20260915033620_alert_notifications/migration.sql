-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('ALERT_OPENED', 'ALERT_ESCALATED', 'ALERT_RESOLVED');

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "pondId" UUID NOT NULL,
    "parameter" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "lastValue" DOUBLE PRECISION NOT NULL,
    "lastRecordedAt" TIMESTAMP(3) NOT NULL,
    "nominalSince" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "alertId" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Alert_pondId_parameter_resolvedAt_idx" ON "Alert"("pondId", "parameter", "resolvedAt");

-- CreateIndex
CREATE INDEX "Notification_profileId_createdAt_id_idx" ON "Notification"("profileId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Notification_profileId_readAt_idx" ON "Notification"("profileId", "readAt");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_pondId_fkey" FOREIGN KEY ("pondId") REFERENCES "Pond"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Supabase exposes "public" through its Data API; with RLS on and no policies, only the backend (table owner) can read these.
ALTER TABLE "Alert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
