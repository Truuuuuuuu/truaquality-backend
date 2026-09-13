-- The system serves only BFAR Sorsogon, so the multi-office layer is removed.
-- RENAME VALUE (not drop/recreate) keeps existing admin rows valid.
ALTER TYPE "SystemRole" RENAME VALUE 'SUPER_ADMIN' TO 'ADMIN';

DROP TABLE "OfficeMember";
DROP TABLE "Office";
DROP TYPE "OfficeRole";
