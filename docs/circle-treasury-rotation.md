# Circle Treasury Wallet Rotation

The **treasury wallet** signs every platform-side on-chain operation HostIT performs: event publication, ticket minting, check-ins, and balance withdrawals. If it is ever compromised, misconfigured, or simply migrated to a new account type, follow the steps below to rotate it without losing on-chain admin access to the deployed Diamond.

## When to rotate

- Suspected compromise (entity secret leak, anomalous transactions)
- Upgrading account type (EOA → SCA, or SCA version upgrade)
- Migrating to a new wallet set (e.g. splitting mainnet vs testnet)
- Regulatory / compliance requirement

## Prerequisites

- Ability to execute a governance-level transaction on the deployed Diamond (`OwnableRoles.grantRoles` / `revokeRoles`) — this is the platform owner's private key, held outside Circle per the contract owner model.
- Current `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET`.
- Recovery file from `~/.circle/` if the entity secret itself is also being rotated.

## Rotation procedure

1. **Pause dependent queues.** Stop the Bull workers for `event-publish`, `ticket-mint`, `ticket-checkin`, `payout` so no signing traffic hits the old wallet mid-rotation.

2. **Record the old wallet.** Note `CIRCLE_TREASURY_WALLET_ID` and the on-chain address it holds. You will revoke its roles later.

3. **Create the new treasury wallet.**

   ```bash
   # Temporarily unset the old IDs so the bootstrap script creates fresh ones
   CIRCLE_TREASURY_WALLET_SET_ID= \
   CIRCLE_TREASURY_WALLET_ID= \
     pnpm circle:bootstrap-treasury
   ```

   Copy the two printed IDs into `.env`.

4. **Fund the new wallet.** Transfer a small USDC + ETH buffer to the new address. On Base testnet, use the Base Sepolia faucet + a Circle sandbox USDC faucet.

5. **Carry over admin roles for existing tickets.**

   Per-ticket `mainAdminRole` is auto-granted to whoever calls
   `createTicket`, so the **new** treasury becomes the main admin on
   any future tickets it creates with no extra step. For tickets that
   already exist (created by the **old** treasury), you have two
   options depending on what the new treasury needs to do:
   - **Check-ins only**: call `CheckInFacet.addTicketAdmins(ticketId, [NEW_TREASURY])`
     for each ticket — the new treasury joins the per-ticket admin set.
     Optionally revoke the old via `removeTicketAdmins` once verified.
   - **Full main-admin power** (set fees, withdraw ticket balance,
     manage admins): the old treasury keeps `mainAdminRole` on tickets
     it created — there's no in-contract handover. Either accept that
     legacy tickets stay administered by the old wallet (lowest risk)
     or, from the contract owner key, call OwnableRoles `grantRoles`
     directly to mint the per-ticket main-admin role to the new
     wallet. This requires the OwnableRoles ABI (not currently bundled
     in `src/blockchain/abis/`).

   For platform-level admin (`withdrawHostItBalance`), grant the
   top-level owner role from the contract-owner key if required.

6. **Restart the app.** Nest validates the new env and signs new transactions with the new wallet.

7. **Drain the old wallet.** Move any remaining USDC/ETH from the old treasury address to the new one via a Circle transfer from the old wallet ID.

8. **Revoke roles on the Diamond** from the old address:

   ```solidity
   diamond.revokeRoles(OLD_TREASURY_ADDRESS, mainAdminRoleForTicket(ticketId));
   diamond.revokeRoles(OLD_TREASURY_ADDRESS, ticketAdminRoleForTicket(ticketId));
   ```

9. **Audit.** Confirm on Basescan that role grants/revocations landed, and spot-check the Bull queues resume cleanly.

## Rotating the entity secret itself

If the **entity secret** is being rotated (not just the wallet), all wallets in the entity become temporarily unusable and must be re-created in new wallet sets under the new secret — there is no in-place entity-secret rotation on Circle. Treat that as a hard migration: stand up new sets for both `hostit-users` (#61) and `hostit-treasury` (this doc), backfill user wallet IDs in the `users` table, and grant roles to the new treasury on the Diamond before cutting over. Follow Circle's official entity-secret rotation docs for the registration step.

## Related

- Issue #61 — Circle SDK foundation
- Issue #63 — initial treasury wallet setup
- Issue #67 — Circle SCP Diamond import (consumes the treasury wallet for signing)
- hostit skill §3B — wallet provider architecture
