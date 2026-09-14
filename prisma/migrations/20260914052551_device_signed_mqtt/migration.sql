/*
  Warnings:

  - You are about to drop the column `apiKeyHash` on the `Device` table. All the data in the column will be lost.
  - You are about to drop the column `apiKeyPrefix` on the `Device` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Device_apiKeyHash_key";

-- AlterTable
ALTER TABLE "Device" DROP COLUMN "apiKeyHash",
DROP COLUMN "apiKeyPrefix",
ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "secretVersion" INTEGER NOT NULL DEFAULT 1;
