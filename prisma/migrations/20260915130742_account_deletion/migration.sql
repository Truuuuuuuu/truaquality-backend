-- AlterEnum
ALTER TYPE "ProfileStatus" ADD VALUE 'DELETED';

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "deletedAt" TIMESTAMP(3);
