-- CreateEnum
CREATE TYPE "DeviceEventKind" AS ENUM ('OFFLINE', 'ONLINE', 'REBOOT', 'SENSOR_FAULT', 'SENSOR_RECOVERED', 'FIRMWARE_CHANGED');

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "diagnosticsAt" TIMESTAMP(3),
ADD COLUMN     "freeHeap" INTEGER,
ADD COLUMN     "queuedSamples" INTEGER,
ADD COLUMN     "resetReason" TEXT,
ADD COLUMN     "rssi" INTEGER,
ADD COLUMN     "sensorStatus" JSONB,
ADD COLUMN     "uptimeS" INTEGER;

-- CreateTable
CREATE TABLE "DeviceEvent" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "kind" "DeviceEventKind" NOT NULL,
    "parameter" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceEvent_deviceId_createdAt_idx" ON "DeviceEvent"("deviceId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "DeviceEvent" ADD CONSTRAINT "DeviceEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every public table gets RLS (backend/CLAUDE.md, "Every table in public must have RLS enabled"): with no
-- policies the Supabase Data API is denied; Prisma connects as the owner and bypasses it.
ALTER TABLE "DeviceEvent" ENABLE ROW LEVEL SECURITY;
