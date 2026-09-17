-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'DEVICE_OFFLINE';
ALTER TYPE "NotificationKind" ADD VALUE 'DEVICE_ONLINE';

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "offlineSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "deviceId" UUID,
ALTER COLUMN "alertId" DROP NOT NULL,
ALTER COLUMN "value" DROP NOT NULL,
ALTER COLUMN "recordedAt" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one of alertId/deviceId identifies what a Notification is about: ALERT_* kinds reference the
-- episode, DEVICE_* kinds reference the device. Guards against a future insert path leaving both null (an
-- orphaned notification nothing can render) or both set (ambiguous).
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_alert_or_device_check"
  CHECK ((("alertId" IS NOT NULL) AND ("deviceId" IS NULL)) OR (("alertId" IS NULL) AND ("deviceId" IS NOT NULL)));
