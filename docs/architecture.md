# HostIT Backend — Architecture

A high-level system design for HostIT v2, written for someone joining the project cold.

## Table of contents

- [What HostIT is](#what-hostit-is)
- [The actors](#the-actors)
- [System diagram](#system-diagram)
- [Backend modules](#backend-modules)
- [Data layer](#data-layer)
- [Wallet infrastructure (Circle)](#wallet-infrastructure-circle)
- [Smart contracts](#smart-contracts)
- [End-to-end data flows](#end-to-end-data-flows)
- [External dependencies](#external-dependencies)
- [Key architectural decisions](#key-architectural-decisions)
- [What is not built yet](#what-is-not-built-yet)

---

## What HostIT is

HostIT is a Web3 event ticketing platform. Organizers create events, sell tickets that are minted as NFTs on an EVM-compatible chain, verify attendance via QR codes at the gate, and receive automated payouts. The platform targets the Nigerian market with Paystack and Monnify as fiat lanes and Circle USDC as the universal crypto lane, with an architecture that scales to multiple countries and chains as new providers come online.

## The actors

**Buyers** — register with an email and password. The backend automatically provisions a Circle SCA wallet on the event's chain. They browse events, pay via fiat (Paystack/Monnify) or crypto (USDC via Circle), and receive an NFT ticket on the event's chain. A signed QR code is delivered via email/SMS/WhatsApp.

**Organizers** — same registration as buyers, then opt in to organizer status via `/auth/become-organizer` (no friction, no upfront KYC). Crypto-only events can be created and published immediately. To accept fiat for an event, the organizer enables a fiat provider per country (`/api/organizer/providers/paystack/enable`, `/monnify/enable`) — that is the moment KYC and bank verification happen. Organizers run gate scanners that verify QR codes against the chain.

**Platform (HostIT)** — runs the backend, holds the entity secret for Circle, owns a per-chain treasury wallet that signs every platform-side blockchain action, and collects a 3% mint fee on every ticket.

## System diagram

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              HostIT Platform                               │
│                                                                            │
│   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐    │
│   │   Web (Next.js) │    │  Mobile (RN)    │    │  Mobile Scanner │    │
│   │   buyer + org   │    │  buyer + org    │    │  (organizer)    │    │
│   └────────┬────────┘    └────────┬────────┘    └────────┬────────┘    │
│            └──────────────────────┴──────────────────────┘              │
│                                   │                                       │
│                                   ▼  HTTPS REST                          │
│   ┌───────────────────────────────────────────────────────────────────┐  │
│   │                    NestJS Backend (this repo)                      │  │
│   │                                                                    │  │
│   │   Auth ─ Events ─ Tickets ─ Payments ─ Organizer ─ Wallets        │  │
│   │     │       │        │         │           │           │           │  │
│   │     ▼       ▼        ▼         ▼           ▼           ▼           │  │
│   │   ┌─────────────────────────────────────────────────────┐         │  │
│   │   │  Prisma ORM ─ PostgreSQL  │  BullMQ ─ Redis           │         │  │
│   │   └─────────────────────────────────────────────────────┘         │  │
│   │                                                                    │  │
│   │   Blockchain layer:                                                │  │
│   │     BlockchainReadService (ethers) ── chain registry              │  │
│   │     CircleContractService (writes)  ── treasury wallet            │  │
│   └───┬─────────────────────────┬──────────────────┬────────────────┬──┘  │
│       │                         │                  │                │     │
└───────┼─────────────────────────┼──────────────────┼────────────────┼─────┘
        │                         │                  │                │
        ▼                         ▼                  ▼                ▼
┌──────────────┐         ┌────────────────┐   ┌──────────────┐  ┌──────────────┐
│   Circle     │         │ Paystack/      │   │  Diamond     │  │  Blockradar  │
│   WaaS       │         │ Monnify        │   │  Contract    │  │  (NGN VA)    │
│              │         │                │   │              │  │              │
│ • Wallets    │         │ • Card         │   │ • createTkt  │  │ • Bank-to-   │
│ • SCP exec   │         │ • Bank xfer    │   │ • mintTicket │  │   cNGN       │
│ • USDC ops   │         │ • Subaccounts  │   │ • checkIn    │  │   ramp       │
│              │         │ • BVN lookup   │   │ • Diamond    │  │              │
│              │         │                │   │   pattern    │  │              │
└──────────────┘         └────────────────┘   └──────────────┘  └──────────────┘
                                                Base Sepolia
                                                Base mainnet
                                                (more chains later)
```

## Backend modules

| Module | Responsibility |
|---|---|
| **Auth** | Email/password registration, JWT login, password reset, role promotion. `/become-organizer` is now KYC-free. |
| **Users + Wallets** | User signup auto-creates a Circle SCA wallet on the default chain. Wallet table is keyed `(userId, chain, walletType)` so a user can have multiple wallets across chains. Wallet creation runs as a Bull job — async, retriable, admin-retryable. |
| **Organizer** | Per-provider fiat enablement (`/providers/paystack/enable`, `/monnify/enable`). KYC, bank verification, and provider subaccount creation happen here, not at signup. |
| **Events** | CRUD on events. Each event carries `country`, `currency`, `chain`, `acceptsCrypto` flags. Publish flow validates organizer has at least one fiat provider enabled OR `acceptsCrypto = true`, then enqueues one `event-publish` Bull job per ticket type. |
| **Tickets** | Purchase initiation, ticket records, planned QR verify + check-in. `QrCodeService` issues HMAC-SHA256-signed QR tokens (`htv1.<base64url>.<base64url>`). |
| **Payments** | Country-aware payment provider registry (`NG → [Paystack, Monnify]`). `listMethods(event)` returns the buyer-facing options filtered by both country eligibility and the organizer's enabled providers. `assertEligible` enforces the same at checkout. Crypto via Circle USDC is universal. |
| **Webhooks** | Provider webhook handlers (Paystack, Monnify, Blockradar). Circle webhook handler is deferred until an HTTPS deployment exists. |
| **Blockchain** | `BlockchainReadService` (ethers, multi-chain provider/contract cache). `CircleContractService` (writes via Circle SCP, treasury-signed). `EventPublishProcessor` (Bull worker that runs `createTicket` per ticket type). |
| **Circle** | SDK init, treasury wallet getters, health check. The SDK details live behind the [`circle:use-developer-controlled-wallets`](https://github.com/circlefin/skills) skill. |
| **Health** | Composite liveness — DB + Circle + per-chain RPC block height. |

## Data layer

**PostgreSQL** via Prisma (`prisma/schema.prisma`). Key models:

- **`User`** — auth identity
- **`UserWallet`** — Circle wallets, keyed `(userId, chain, walletType)` for multi-chain support
- **`OrganizerProfile`** — KYC, bank, per-provider subaccount codes
- **`Event`** — event metadata + `country`, `currency`, `chain`, `acceptsCrypto`
- **`TicketType`** — per-ticket-type pricing + `onChainTicketId` (one on-chain entry per type)
- **`Ticket`** — purchases (deprecated, migrating to `PurchaseIntent` with the contract pivot)
- **`Transaction`** — fiat/crypto payment record + invoice ledger (platform fee, organizer amount, gateway fee, fee bearer)
- **`Payout`** — organizer settlement record
- **`BlockchainTransaction`** — every Circle-submitted on-chain action, with `circleTransactionId` + `chain`
- **`Notification`** — multi-channel notification queue

Schema is multi-tenant ready: every `Event` carries `country` + `currency` + `chain`. Every `BlockchainTransaction` is chain-tagged. Every `UserWallet` is per-chain.

**Redis** runs BullMQ queues:

- `user-wallet-create` — provisions a Circle wallet at signup
- `event-publish` — runs `createTicket` on the Diamond per ticket type
- (planned) `ticket-mint`, `ticket-checkin`, `payout`

## Wallet infrastructure (Circle)

```
Entity Secret (one, in env)
    │
    ├── Wallet Set: "hostit-users"
    │   └── User wallets (one per user × chain, SCA)
    │
    └── Wallet Set: "hostit-treasury"
        └── Treasury wallet(s) (one per chain)
              ↑
              │ signs every platform-side on-chain action
              │
       (createTicket, mintTicket, checkIn, withdraw)
```

The treasury wallet is the only signer for Diamond writes. Buyer wallets exist but the treasury mints to them in the fiat path. In the direct-crypto path, buyers can sign their own `mintTicket` if Circle Gas Station policies are configured (deferred until needed).

The entity secret is registered once via `pnpm circle:register-secret`. Recovery files land in `~/.circle/` and must be backed up to a secrets manager — losing both the entity secret and the recovery file makes every wallet unrecoverable.

## Smart contracts

The Diamond (EIP-2535) lives in a sibling repo (`hostit-events/ticket`), deployed today on Base Sepolia at `0x4057170053DF6fA69C8579B71ce6288bd7cbA970`.

```
HostItTickets Diamond (EIP-2535)
  ├── DiamondCutFacet
  ├── DiamondLoupeFacet
  ├── OwnableRolesFacet
  ├── FactoryFacet       — createTicket, ticketData, all read views
  ├── MarketplaceFacet   — mintTicket (payable), getAllFees, withdrawTicketBalance, claimRefund
  └── CheckInFacet       — checkIn, addTicketAdmins, isCheckedIn

Each createTicket call clones a per-event ERC721 NFT contract (UpgradeableBeacon + CREATE2):

  Event Ticket Type ─┐
                     ├─→ ERC721 contract address (cloned)
                     │     └── tokens minted to buyers
```

The contract is mid-pivot: payment escrow logic is being trimmed to "platform 3% mint fee only" while organizer payment routing moves off-chain (Paystack split or direct USDC to organizer wallet). `createTicket` signature stays the same; `mintTicket` internal accounting changes.

Multi-chain registry (`src/blockchain/chains.config.ts`) supports adding chains via env + a config row. Active chains today: `BASE-SEPOLIA`. `BASE` mainnet redeploy planned.

## End-to-end data flows

### Flow 1: Organizer publishes an event

```
1. POST /api/events                       → DB writes Event + TicketTypes (status: DRAFT)
2. POST /api/events/:id/publish           → validates fiat-or-crypto coverage
                                          → updates status to PUBLISHED
                                          → creates 1 BlockchainTransaction per ticket type (PENDING)
                                          → enqueues 1 Bull job per ticket type

3. EventPublishProcessor (per ticket type):
   a. Calls CircleContractService.executeContract({ method: 'createTicket', chain, args, ... })
   b. Circle SCP submits the tx, returns a circleTransactionId
   c. Worker polls Circle until terminal state (pre-webhook fallback)
   d. On COMPLETE/CONFIRMED:
        - Pulls receipt via BlockchainReadService.getProvider(chain)
        - Parses TicketCreated event log → onChainTicketId
        - Writes onChainTicketId to TicketType row
   e. On final-attempt failure: marks BlockchainTransaction FAILED, reverts Event to DRAFT

After: each ticket type has its own on-chain entry on the chosen chain.
```

### Flow 2: Buyer purchases a ticket (fiat path)

```
1. GET /api/payments/methods?eventId=...  → returns eligible methods for the event:
                                            [Paystack, Monnify, Crypto] (filtered by organizer's enabled providers)

2. POST /api/tickets/purchase             → buyer chooses provider (e.g. Paystack)
                                          → assertEligible() enforces country + provider-enabled
                                          → creates Transaction (PENDING) + N Ticket rows (PENDING)
                                          → calls Paystack initialize with split (97% organizer, 3% platform)
                                          → returns checkoutUrl

3. Buyer pays at Paystack hosted checkout. Paystack handles 97/3 split server-side.

4. Paystack webhook → POST /webhooks/paystack:
   a. Verifies HMAC-SHA512 signature
   b. Marks Transaction SUCCESS
   c. Marks Ticket(s) CONFIRMED
   d. Enqueues a `ticket-mint` Bull job per ticket (planned)

5. TicketMintProcessor (planned):
   a. Calls CircleContractService.executeContract({ method: 'mintTicket', chain, args: [ticketId, feeType, buyerAddress] })
   b. Treasury wallet pays the on-chain platform fee
   c. Polls until terminal
   d. Writes tokenId back to Ticket row

After: buyer's NFT lives on-chain. QR is generated via QrCodeService and delivered.
```

## External dependencies

| Service | Used for | State |
|---|---|---|
| **Circle WaaS** | All wallet creation + on-chain writes | Live (Base Sepolia) |
| **Diamond contract** | NFT minting + check-in + admin roles | Live (Base Sepolia); Base mainnet redeploy planned |
| **Paystack** | NG fiat checkout, BVN/bank verify, subaccount split | Live |
| **Monnify** | NG fiat checkout, sub-account split | Live |
| **Blockradar** | NGN virtual accounts → cNGN (organizer-side, deferred) | Configured |
| **SendGrid** | Email notifications | Configured (notification module is stub) |
| **Twilio** | SMS + WhatsApp | Configured (stub) |
| **PostgreSQL 16** | Primary data store | Live |
| **Redis 7** | BullMQ queues | Live |

## Key architectural decisions

1. **Custodial wallets via Circle (developer-controlled).** Lower friction for the Nigerian mobile-first audience, invisible to buyers, and the treasury must be custodial regardless. Trade-off: HostIT becomes a custody honeypot — mitigated by entity secret hygiene + planned Gas Station policies.

2. **Off-chain payment routing, on-chain NFT registry.** Organizer's 97% share moves via Paystack split (or USDC transfer to their Circle wallet). Platform's 3% accumulates on-chain. The contract simplifies to "issue NFTs + collect platform fee" — far easier to audit than escrow logic.

3. **Multi-country, multi-chain, multi-currency from day one.** Schema-level support already shipped. Adding a country or chain is a config change, not a migration. Stripe / Polygon / Arbitrum drop in cleanly when needed.

4. **Just-in-time KYC.** Anyone can become an organizer instantly. KYC + bank verification only happens when an organizer enables a fiat provider for a country. Crypto-only events have zero compliance burden.

5. **Crypto as universal payment lane.** Even when no fiat provider serves a buyer's country, USDC always works. Removes the cold-start problem of country expansion — the architecture supports buyers in any country before HostIT supports their fiat.

6. **Circle SCP for writes (treasury-signed).** Backend never holds raw private keys for blockchain writes. Auditable, rotatable. Per-ticket admin grants on the Diamond happen automatically via `createTicket`'s self-grant — no manual role-assignment step needed at deploy time.

7. **Bull queues for every async on-chain action.** Retryable, observable, decoupled from request lifecycle. State machine: `BlockchainTransaction.status` mirrors Circle's lifecycle states (`PENDING / SUBMITTED / CONFIRMED / FAILED`).

## What is not built yet

- **Circle webhook handler** — blocked on having an HTTPS deployment to receive webhooks. Workers currently poll Circle until terminal. Temporary measure.
- **Ticket mint Bull queue** — gated on contract dev finalising the simplified `mintTicket` accounting.
- **Check-in Bull queue + verify-at-door endpoint** — planned, architecture-stable, ready to build.
- **Payout queue** — likely obsolete in the new architecture; payouts move off-chain via Paystack split + organizer Circle wallet transfer.
- **Circle Gateway** — for cross-chain USDC. Future when buyer-pays-direct-from-other-chain becomes a real use case.
- **Frontend** — Next.js web + React Native mobile live in sister repos.
- **Notification dispatch** — module skeleton exists; SendGrid/Twilio integrations are stubs.
- **Schema migration: `Ticket → PurchaseIntent`** — gated on contract dev decision.

## Related docs

- [`circle-treasury-rotation.md`](./circle-treasury-rotation.md) — runbook for rotating the platform treasury wallet
- [`circle-gas-station.md`](./circle-gas-station.md) — Gas Station policy for sponsoring buyer gas in direct-crypto checkout
- [`organizer-user-journey.md`](./organizer-user-journey.md) — organizer-side product walkthrough
- [`figma-audit-mobile-organizer.md`](./figma-audit-mobile-organizer.md) — design-vs-backend audit for the mobile organizer flow
