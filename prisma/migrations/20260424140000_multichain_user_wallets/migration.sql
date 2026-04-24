-- Refactor wallet model to N wallets per user, keyed by (user, chain,
-- wallet type). See hostit skill §3B and issue #64 addendum.
--
-- Steps:
--   1. Create user_wallets with its constraints/indexes.
--   2. Backfill existing Circle wallets from users.* into user_wallets,
--      marking them isPrimary=true and chain=BASE-SEPOLIA (the only
--      chain any existing row could have been created against).
--   3. Drop the now-redundant columns from users, including the
--      Blockradar-specific ones (scope moved to NGN virtual accounts
--      in #29 — that flow links against user_wallets.address, not a
--      dedicated column on users).

-- CreateTable
CREATE TABLE "user_wallets" (
  "id"                    UUID                   NOT NULL,
  "user_id"               UUID                   NOT NULL,
  "circle_wallet_id"      TEXT,
  "circle_wallet_set_id"  TEXT,
  "address"               TEXT,
  "chain"                 TEXT                   NOT NULL,
  "wallet_type"           "WalletType"           NOT NULL DEFAULT 'DEVELOPER_CONTROLLED',
  "is_primary"            BOOLEAN                NOT NULL DEFAULT false,
  "creation_status"       "WalletCreationStatus",
  "creation_error"        TEXT,
  "created_at"            TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3)           NOT NULL,

  CONSTRAINT "user_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_wallets_circle_wallet_id_key"
  ON "user_wallets"("circle_wallet_id");
CREATE UNIQUE INDEX "user_wallets_user_id_chain_wallet_type_key"
  ON "user_wallets"("user_id", "chain", "wallet_type");
CREATE INDEX "user_wallets_user_id_idx" ON "user_wallets"("user_id");
CREATE INDEX "user_wallets_address_idx" ON "user_wallets"("address");

-- AddForeignKey
ALTER TABLE "user_wallets"
  ADD CONSTRAINT "user_wallets_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: every existing user row with a Circle wallet becomes one
-- user_wallets row. chain is hardcoded because the service only ever
-- created BASE-SEPOLIA wallets before this migration.
INSERT INTO "user_wallets" (
  "id", "user_id", "circle_wallet_id", "circle_wallet_set_id",
  "address", "chain", "wallet_type", "is_primary",
  "creation_status", "creation_error",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  "id",
  "circle_wallet_id",
  "circle_wallet_set_id",
  "circle_wallet_address",
  'BASE-SEPOLIA',
  "wallet_type",
  true,
  "wallet_creation_status",
  "wallet_creation_error",
  NOW(),
  NOW()
FROM "users"
WHERE "circle_wallet_id" IS NOT NULL;

-- DropColumn: remove inline Circle + Blockradar + legacy address fields
-- from users. They now live on user_wallets (or are gone entirely, for
-- the Blockradar columns which were unused since #29 rescope).
ALTER TABLE "users"
  DROP COLUMN "wallet_address",
  DROP COLUMN "blockradar_address_id",
  DROP COLUMN "circle_wallet_id",
  DROP COLUMN "circle_wallet_address",
  DROP COLUMN "circle_wallet_set_id",
  DROP COLUMN "wallet_type",
  DROP COLUMN "wallet_creation_status",
  DROP COLUMN "wallet_creation_error";
