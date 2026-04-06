-- CreateEnum
CREATE TYPE "AllianceSubscriptionPermission" AS ENUM ('ANYONE', 'MEMBERS');

-- CreateTable
CREATE TABLE "alliance" (
    "id" CHAR(3) NOT NULL,
    "owner" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "subscription_permission" "AllianceSubscriptionPermission" NOT NULL DEFAULT 'MEMBERS',
    "data" JSONB NOT NULL,

    CONSTRAINT "alliance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alliance_subscriptions" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "alliance_id" CHAR(3) NOT NULL,
    "subscribed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alliance_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alliance_owner_idx" ON "alliance"("owner");

-- CreateIndex
CREATE INDEX "alliance_deleted_at_idx" ON "alliance"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "alliance_subscriptions_user_id_alliance_id_key" ON "alliance_subscriptions"("user_id", "alliance_id");

-- CreateIndex
CREATE INDEX "alliance_subscriptions_alliance_id_idx" ON "alliance_subscriptions"("alliance_id");

-- CreateIndex
CREATE INDEX "alliance_subscriptions_user_id_idx" ON "alliance_subscriptions"("user_id");

-- AddForeignKey
ALTER TABLE "alliance_subscriptions" ADD CONSTRAINT "alliance_subscriptions_alliance_id_fkey" FOREIGN KEY ("alliance_id") REFERENCES "alliance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
