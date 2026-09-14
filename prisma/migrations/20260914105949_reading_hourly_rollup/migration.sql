-- CreateTable
CREATE TABLE "ReadingHourly" (
    "pondId" UUID NOT NULL,
    "parameter" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "min" DOUBLE PRECISION NOT NULL,
    "max" DOUBLE PRECISION NOT NULL,
    "sum" DOUBLE PRECISION NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "ReadingHourly_pkey" PRIMARY KEY ("pondId","parameter","bucketStart")
);

-- CreateIndex
CREATE INDEX "Reading_recordedAt_idx" ON "Reading"("recordedAt");

-- AddForeignKey
ALTER TABLE "ReadingHourly" ADD CONSTRAINT "ReadingHourly_pondId_fkey" FOREIGN KEY ("pondId") REFERENCES "Pond"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Supabase exposes "public" through its Data API; with RLS on and no policies, only the backend (table owner) can read these.
ALTER TABLE "ReadingHourly" ENABLE ROW LEVEL SECURITY;
