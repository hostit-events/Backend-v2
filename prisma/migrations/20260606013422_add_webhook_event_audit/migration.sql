-- CreateEnum
CREATE TYPE "WebhookSource" AS ENUM ('CIRCLE', 'PAYSTACK', 'MONNIFY');

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "source" "WebhookSource" NOT NULL,
    "notification_id" TEXT,
    "type" TEXT,
    "payload" JSONB NOT NULL,
    "signature_valid" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_events_created_at_idx" ON "webhook_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_source_notification_id_key" ON "webhook_events"("source", "notification_id");
