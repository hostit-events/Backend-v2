-- CreateEnum: async wallet provisioning state. Null until first
-- enqueue (admin users never enter the flow). FAILED rows surface to
-- the admin retry endpoint (see issue #64).
CREATE TYPE "WalletCreationStatus" AS ENUM ('PENDING', 'CREATED', 'FAILED');

-- AlterTable: users gains wallet-creation tracking fields.
-- wallet_creation_error holds the last error message for operator
-- triage when status = FAILED; cleared on successful retry.
ALTER TABLE "users"
  ADD COLUMN "wallet_creation_status" "WalletCreationStatus",
  ADD COLUMN "wallet_creation_error"  TEXT;
