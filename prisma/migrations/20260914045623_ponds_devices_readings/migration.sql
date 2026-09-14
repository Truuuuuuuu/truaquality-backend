-- CreateEnum
CREATE TYPE "PondStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "Pond" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "status" "PondStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pond_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "serial" TEXT NOT NULL,
    "hardwareModel" TEXT,
    "label" TEXT,
    "apiKeyHash" TEXT NOT NULL,
    "apiKeyPrefix" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "pondId" UUID,
    "firmwareVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reading" (
    "id" BIGSERIAL NOT NULL,
    "pondId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "parameter" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Pond_name_key" ON "Pond"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Device_serial_key" ON "Device"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "Device_apiKeyHash_key" ON "Device"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "Device_pondId_key" ON "Device"("pondId");

-- CreateIndex
CREATE INDEX "Reading_pondId_parameter_recordedAt_idx" ON "Reading"("pondId", "parameter", "recordedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Reading_deviceId_parameter_recordedAt_key" ON "Reading"("deviceId", "parameter", "recordedAt");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_pondId_fkey" FOREIGN KEY ("pondId") REFERENCES "Pond"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reading" ADD CONSTRAINT "Reading_pondId_fkey" FOREIGN KEY ("pondId") REFERENCES "Pond"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reading" ADD CONSTRAINT "Reading_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Supabase exposes "public" through its Data API; with RLS on and no policies, only the backend (table owner) can read these.
ALTER TABLE "Pond" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Device" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reading" ENABLE ROW LEVEL SECURITY;
