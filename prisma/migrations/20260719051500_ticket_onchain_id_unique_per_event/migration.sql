-- on_chain_ticket_id is only unique per chain; an event is bound to one
-- chain, so scope uniqueness to (event_id, on_chain_ticket_id). The old
-- global unique collided across chains (e.g. Arc id 1 vs Base id 1).

-- DropIndex
DROP INDEX "ticket_types_on_chain_ticket_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "ticket_types_event_id_on_chain_ticket_id_key" ON "ticket_types"("event_id", "on_chain_ticket_id");
