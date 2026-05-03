# HostIT v2 Backend

A Web3 event ticketing platform — organizers create events, sell tickets that mint as NFTs on an EVM-compatible chain, verify attendance via signed QR codes at the gate, and receive automated payouts.

Built on NestJS + Prisma + PostgreSQL + Redis. Custodial wallets via Circle, on-chain operations via Circle SCP signed by a platform treasury wallet, fiat checkout via Paystack/Monnify (Nigeria today, more countries next), crypto checkout via Circle USDC universally.

## Architecture at a glance

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

For a full system design — modules, data flows, key decisions — see [`docs/architecture.md`](./docs/architecture.md).

## Prerequisites

- **Node.js** 20+
- **pnpm** 10+ (`npm install -g pnpm`)
- **Docker + Docker Compose** (for local PostgreSQL + Redis)
- **Circle developer account** at [console.circle.com](https://console.circle.com) — sandbox is fine for development
- (Optional) **OpenSSL** for generating signing secrets

## Quick start

### 1. Install dependencies

```bash
git clone <this-repo>
cd backend-v2
pnpm install
```

### 2. Start local PostgreSQL + Redis

```bash
pnpm docker:up
```

This boots Postgres on `localhost:5432` and Redis on `localhost:6379` per `docker-compose.yml`.

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in the required values. The `.env.example` is annotated with what each variable is for. You will need:

- **Database / Redis** — already pre-filled for local Docker
- **JWT secret** — any 32+ byte random string
- **Paystack + Monnify keys** — from your Paystack/Monnify dashboards (sandbox keys for dev)
- **Circle API key** — from console.circle.com (see [Circle bootstrap](#4-circle-bootstrap) below for the rest)
- **`TICKET_QR_SIGNING_SECRET`** — generate with `openssl rand -hex 32`
- **`ACTIVE_CHAINS`** + per-chain RPC + Diamond addresses — defaults to `BASE-SEPOLIA` with the deployed Diamond
- **SendGrid + Twilio** — placeholder values are fine for dev (notification dispatch is currently a stub)

### 4. Circle bootstrap

The Circle integration requires a one-time setup ritual — generating an entity secret, registering it with Circle, and creating a wallet set + treasury wallet. Run these in order:

```bash
# Generate the 32-byte entity secret. Copy the printed hex into .env as CIRCLE_ENTITY_SECRET.
pnpm circle:generate-secret

# Register the ciphertext with Circle. Writes a recovery file to ~/.circle/recovery-file.json.
# Back this file up to a secrets manager — losing it makes every wallet unrecoverable.
pnpm circle:register-secret

# Create the user wallet set. Copy the printed UUID into .env as CIRCLE_WALLET_SET_ID.
pnpm circle:bootstrap-wallet-set

# Create the platform treasury wallet. Copy both printed UUIDs into .env.
pnpm circle:bootstrap-treasury
```

Each script is idempotent — safe to re-run. After the four steps, your `.env` should have all five `CIRCLE_*` IDs populated.

> 📖 More: [`docs/circle-treasury-rotation.md`](./docs/circle-treasury-rotation.md) covers rotating the treasury wallet later.

### 5. Run database migrations + generate Prisma client

```bash
pnpm prisma:generate
pnpm prisma:migrate     # or `npx prisma migrate deploy` for non-interactive
```

### 6. Start the dev server

```bash
pnpm start:dev
```

Backend serves at `http://localhost:3000/api`. Swagger docs at `http://localhost:3000/api/docs`. Hit `/api/health` to verify DB + Circle + blockchain RPC are all reachable.

## Useful scripts

```bash
# Build for production
pnpm build

# Run prod build
pnpm start:prod

# Tests
pnpm test                    # unit tests
pnpm test:e2e                # end-to-end
pnpm test:cov                # coverage

# Linting + formatting
pnpm lint                    # eslint --fix
pnpm format                  # prettier --write

# Prisma
pnpm prisma:generate         # regenerate client
pnpm prisma:migrate          # create + apply a new migration
pnpm prisma:studio           # browse the DB visually

# Blockchain smoke tests (live — uses your .env)
pnpm blockchain:smoke           # read-only Diamond ping
pnpm blockchain:smoke-execute   # estimate fee for a Diamond write (no broadcast)
pnpm blockchain:inspect <addr>  # inspect a specific buyer's wallet vs latest ticket
pnpm blockchain:buy-ticket <ticketId> <buyerWalletId>   # end-to-end: buyer wallet mints a ticket on Base Sepolia
```

## Project layout

```
src/
  auth/             # registration, login, role promotion (no KYC at signup)
  organizer/        # per-provider fiat enablement (Paystack, Monnify)
  events/           # event CRUD + on-chain publish flow
  tickets/          # purchase, QR generation, planned verify + checkin
  payments/         # country-aware provider registry + dispatch
  webhooks/         # Paystack / Monnify / Blockradar webhook handlers
  wallets/          # Circle wallet creation + admin retry
  circle/           # Circle SDK wrapper + health
  blockchain/       # ethers reads, Circle SCP writes, multi-chain registry
  prisma/           # PrismaService (global)
  health/           # composite /health endpoint
  common/           # shared decorators, guards, filters

prisma/             # schema + migrations
scripts/
  circle/           # one-shot Circle bootstrap scripts
  blockchain/       # smoke tests + inspection scripts

docs/               # architecture + runbooks
test/               # e2e test suite
```

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — full system design
- [`docs/circle-treasury-rotation.md`](./docs/circle-treasury-rotation.md) — rotating the platform treasury wallet
- [`docs/circle-gas-station.md`](./docs/circle-gas-station.md) — sponsoring buyer gas via Circle Gas Station
- [`docs/organizer-user-journey.md`](./docs/organizer-user-journey.md) — organizer-side product walkthrough
- [`docs/figma-audit-mobile-organizer.md`](./docs/figma-audit-mobile-organizer.md) — design-vs-backend audit (mobile organizer flow)

## Sister repos

- **`hostit-events/ticket`** — Solidity smart contracts (Foundry, Diamond pattern). Deployed on Base Sepolia today.
- **Frontend** — Next.js web app + React Native mobile app live in their own repositories.

## License

UNLICENSED — internal project.
