-- AlterTable: organizer_profiles gains provider subaccount identifiers.
-- Nullable so existing organizers don't break — they'll be backfilled
-- via a separate admin endpoint or on their next /become-organizer-style
-- KYC update.
ALTER TABLE "organizer_profiles"
  ADD COLUMN "paystack_subaccount_code" TEXT,
  ADD COLUMN "paystack_subaccount_id"   TEXT,
  ADD COLUMN "monnify_sub_account_code" TEXT;

-- AlterTable: transactions gains per-row invoice ledger fields.
-- All nullable: legacy rows have no split, and gateway_fee is only
-- populated once the settlement webhook reports it.
ALTER TABLE "transactions"
  ADD COLUMN "platform_fee"     DECIMAL,
  ADD COLUMN "organizer_amount" DECIMAL,
  ADD COLUMN "gateway_fee"      DECIMAL,
  ADD COLUMN "fee_bearer"       TEXT;
