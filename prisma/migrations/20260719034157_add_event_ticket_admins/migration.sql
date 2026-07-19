-- CreateEnum
CREATE TYPE "TicketAdminStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterEnum
ALTER TYPE "BlockchainTxType" ADD VALUE 'SET_ADMINS';

-- CreateTable
CREATE TABLE "event_ticket_admins" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "status" "TicketAdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_ticket_admins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_ticket_admins_event_id_idx" ON "event_ticket_admins"("event_id");

-- CreateIndex
CREATE INDEX "event_ticket_admins_user_id_idx" ON "event_ticket_admins"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_ticket_admins_event_id_user_id_key" ON "event_ticket_admins"("event_id", "user_id");

-- AddForeignKey
ALTER TABLE "event_ticket_admins" ADD CONSTRAINT "event_ticket_admins_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_ticket_admins" ADD CONSTRAINT "event_ticket_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
