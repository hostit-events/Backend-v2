-- AlterEnum
ALTER TYPE "BlockchainTxType" ADD VALUE 'REFUND';

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "refund_tx_hash" TEXT,
ADD COLUMN     "refunded_at" TIMESTAMP(3);
