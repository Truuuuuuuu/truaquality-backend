-- Rename in place to preserve existing profiles and the enum-typed column default.
ALTER TYPE "SystemRole" RENAME VALUE 'USER' TO 'STAFF';
