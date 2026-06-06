-- CreateEnum
CREATE TYPE "CryptoDepositStatus" AS ENUM ('PENDING', 'CONFIRMED', 'EXPIRED');

-- CreateTable
CREATE TABLE "crypto_deposits" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "chain" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "amount_usdc" DECIMAL NOT NULL,
    "usdc_address" TEXT NOT NULL,
    "status" "CryptoDepositStatus" NOT NULL DEFAULT 'PENDING',
    "circle_transaction_id" TEXT,
    "tx_hash" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crypto_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crypto_deposits_transaction_id_key" ON "crypto_deposits"("transaction_id");

-- CreateIndex
CREATE INDEX "crypto_deposits_wallet_id_status_idx" ON "crypto_deposits"("wallet_id", "status");

-- AddForeignKey
ALTER TABLE "crypto_deposits" ADD CONSTRAINT "crypto_deposits_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
