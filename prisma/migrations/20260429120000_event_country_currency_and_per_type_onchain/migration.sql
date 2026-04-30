-- Phase 0 multi-country foundations + per-ticket-type on-chain entries.
--
-- Three concerns folded into one migration:
--   1. Events gain country / currency / chain / acceptsCrypto so they
--      can scale beyond NG without each new country needing schema
--      changes. NOT NULL with NG/NGN/BASE-SEPOLIA defaults — every
--      existing event is implicitly Nigerian.
--   2. Each ticket type owns its own on-chain ticketId. The current
--      schema attached one onChainTicketId per Event, which conflicts
--      with N ticket types per Event each requiring its own
--      createTicket call. Move the column down and backfill from the
--      Event row onto its first ticket type (legacy events only ever
--      had one chain entry, so attaching it to the earliest type
--      preserves the relation for retroactive lookups).
--   3. Drop Event.onChainTicketId now that the data has moved.

-- AlterTable: events gain country / currency / chain / accepts_crypto
ALTER TABLE "events"
  ADD COLUMN "country"        TEXT    NOT NULL DEFAULT 'NG',
  ADD COLUMN "currency"       TEXT    NOT NULL DEFAULT 'NGN',
  ADD COLUMN "chain"          TEXT    NOT NULL DEFAULT 'BASE-SEPOLIA',
  ADD COLUMN "accepts_crypto" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: ticket_types gains its own on_chain_ticket_id
ALTER TABLE "ticket_types"
  ADD COLUMN "on_chain_ticket_id" BIGINT;

-- Backfill: copy events.on_chain_ticket_id onto the earliest
-- ticket_type for that event. Only events with a non-null value are
-- affected; events with multiple ticket types attach the existing
-- on-chain entry to the first one ordered by created_at.
UPDATE "ticket_types" tt
SET "on_chain_ticket_id" = e."on_chain_ticket_id"
FROM "events" e
WHERE tt."event_id" = e."id"
  AND e."on_chain_ticket_id" IS NOT NULL
  AND tt."id" = (
    SELECT inner_tt."id"
    FROM "ticket_types" inner_tt
    WHERE inner_tt."event_id" = e."id"
    ORDER BY inner_tt."created_at" ASC
    LIMIT 1
  );

-- DropColumn: events no longer carries on_chain_ticket_id
ALTER TABLE "events" DROP COLUMN "on_chain_ticket_id";

-- CreateIndex: each on_chain_ticket_id is unique across ticket_types.
-- Postgres allows multiple NULLs under a unique index by default, so
-- existing rows without an on-chain entry remain valid.
CREATE UNIQUE INDEX "ticket_types_on_chain_ticket_id_key"
  ON "ticket_types"("on_chain_ticket_id");
