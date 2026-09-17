-- CreateEnum
CREATE TYPE "PondType" AS ENUM ('FRESHWATER', 'BRACKISH', 'SALTWATER');

-- AlterTable
ALTER TABLE "Pond" ADD COLUMN     "fishSpecies" TEXT,
ADD COLUMN     "pondType" "PondType";
