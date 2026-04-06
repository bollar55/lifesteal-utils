-- CreateEnum
CREATE TYPE "CurrencyType" AS ENUM ('COINS');

-- CreateTable
CREATE TABLE "currency_submissions" (
    "id" TEXT NOT NULL,
    "submitterName" TEXT NOT NULL,
    "submitterUuid" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modVersion" TEXT NOT NULL,

    CONSTRAINT "currency_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency_records" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "currencyType" "CurrencyType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "submissionId" TEXT NOT NULL,

    CONSTRAINT "currency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "currency_records_uuid_idx" ON "currency_records"("uuid");

-- CreateIndex
CREATE INDEX "currency_records_submissionId_idx" ON "currency_records"("submissionId");

-- AddForeignKey
ALTER TABLE "currency_records" ADD CONSTRAINT "currency_records_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "currency_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
