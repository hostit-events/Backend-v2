-- AlterTable: tickets gains transaction_id (nullable for legacy rows + free events)
ALTER TABLE "tickets" ADD COLUMN "transaction_id" UUID;

-- AlterTable: transactions gains reference (unique) + quantity
-- Backfill `reference` from id::text for any existing rows so the NOT NULL
-- constraint can apply, then enforce it.
ALTER TABLE "transactions" ADD COLUMN "reference" TEXT;
UPDATE "transactions" SET "reference" = "id"::text WHERE "reference" IS NULL;
ALTER TABLE "transactions" ALTER COLUMN "reference" SET NOT NULL;

ALTER TABLE "transactions" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reference_key" ON "transactions"("reference");
CREATE INDEX "tickets_transaction_id_idx" ON "tickets"("transaction_id");

-- AddForeignKey
ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_transaction_id_fkey"
  FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
