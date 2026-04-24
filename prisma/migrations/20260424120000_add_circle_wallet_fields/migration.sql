-- CreateEnum: wallet custody model. Default DEVELOPER_CONTROLLED —
-- platform holds keys for buyers + organizers (see hostit skill §3B.2).
CREATE TYPE "WalletType" AS ENUM ('DEVELOPER_CONTROLLED', 'USER_CONTROLLED', 'MODULAR');

-- AlterTable: users gains Circle wallet fields. All nullable (backfill
-- happens as users transact — #64). wallet_type defaults to
-- DEVELOPER_CONTROLLED so existing rows carry the same assumption.
ALTER TABLE "users"
  ADD COLUMN "circle_wallet_id"      TEXT,
  ADD COLUMN "circle_wallet_address" TEXT,
  ADD COLUMN "circle_wallet_set_id"  TEXT,
  ADD COLUMN "wallet_type"           "WalletType" NOT NULL DEFAULT 'DEVELOPER_CONTROLLED';

-- AlterTable: blockchain_transactions gains Circle reconciliation fields.
-- circle_transaction_id matches against webhook payloads (#65);
-- chain disambiguates rows during the Lisk → Base migration.
ALTER TABLE "blockchain_transactions"
  ADD COLUMN "circle_transaction_id" TEXT,
  ADD COLUMN "circle_wallet_id"      TEXT,
  ADD COLUMN "chain"                 TEXT;

-- CreateIndex: unique constraints on Circle identifiers. Nullable
-- columns allow multiple NULLs under the constraint (PostgreSQL
-- default), so existing rows are unaffected.
CREATE UNIQUE INDEX "users_circle_wallet_id_key" ON "users"("circle_wallet_id");
CREATE UNIQUE INDEX "blockchain_transactions_circle_transaction_id_key" ON "blockchain_transactions"("circle_transaction_id");
