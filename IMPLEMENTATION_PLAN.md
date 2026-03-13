# HostIT v2 Backend — Implementation Plan

## Context

HostIT is a Web3 event ticketing platform targeting the Nigerian market. It enables organizers to create events, sell tickets (minted as NFTs on Lisk L2), verify attendance via QR codes, and receive automated payouts. The backend integrates with existing Diamond-pattern smart contracts deployed on Lisk L2.

We're building incrementally — one phase at a time, fully implemented and verified before moving to the next.

---

## Agreed Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Package manager | pnpm | Fast, disk-efficient, strict dependency resolution |
| User roles | Single switchable enum (BUYER → ORGANIZER) | Simple. ADMIN set manually. Organizer can still buy tickets. |
| NFT custody | Blockradar wallet per user at registration | Every user gets a blockchain address. NFTs minted there. |
| On-chain event creation | Triggered on publish | Organizer creates event as DRAFT (DB only), publish triggers on-chain `createTicket()` |
| Fiat minting | Platform wallet mints on behalf of buyer | Buyer pays NGN via Paystack/Monnify, backend mints NFT using platform private key |
| Blockchain operations | All via Bull queue (async, retryable) | Never block the user. Retry 3x with backoff. Track in BlockchainTransaction table. |
| Event days | Start/end time only | Smart contract handles per-day check-in calculation |
| Email verification | Skipped for now | Reduces friction. Add later with SendGrid. |
| Guest checkout | Yes | Buyers purchase with email/name/phone, no account required. buyerId nullable. |
| KYC | Tiered | Tier 1: BVN + bank via Paystack (free). Tier 2: ID + selfie via TBD provider for high-value payouts. |
| Organizer onboarding | BVN + bank verification required | Via Paystack BVN resolve + bank resolve APIs (free) |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Clients                              │
│   Web App (Next.js)  │  Mobile App (RN)  │  Admin Panel  │
└───────────┬──────────┴────────┬──────────┴───────┬──────┘
            │                   │                  │
            └───────────────────┼──────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   NestJS Backend API   │
                    │   (this project)       │
                    └───────────┬───────────┘
                                │
          ┌─────────┬───────────┼───────────┬──────────┐
          │         │           │           │          │
    ┌─────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌───▼───┐ ┌───▼────┐
    │PostgreSQL│ │ Redis  │ │Lisk L2 │ │Payment│ │Notif.  │
    │ (Prisma) │ │(Queue) │ │(Chain) │ │Provid.│ │Service │
    └─────────┘ └────────┘ └────────┘ └───────┘ └────────┘
                                         │
                            ┌────────────┼────────────┐
                            │            │            │
                        Paystack     Monnify    Blockradar
```

## Smart Contract ↔ Backend Integration

### Two Payment Paths

**Path A — Fiat (Paystack/Monnify):**
```
Buyer pays NGN → Webhook confirms → Backend queues mintTicket()
  → Platform wallet mints NFT to buyer's Blockradar address
  → Generate QR → Send notification → Ticket CONFIRMED
```

**Path B — Crypto (Blockradar):**
```
Buyer sends stablecoins to Blockradar address → deposit.success webhook
  → Backend confirms amount → Queue mintTicket()
  → Same as Path A from here
```

**Path C — Direct On-Chain:**
```
Buyer calls mintTicket() from their wallet → Contract emits TicketMinted
  → Backend event listener syncs to DB → Generate QR → Send notification
```

### Blockchain Service Architecture
```
BlockchainService (ethers.js)
├── ethers.JsonRpcProvider (Lisk RPC)
├── ethers.Wallet (platform private key)
├── ethers.Contract (Diamond ABI — FactoryFacet, MarketplaceFacet, CheckInFacet)
└── Event listeners (TicketMinted, CheckedIn)

Bull Queues (async, retryable)
├── event-publish    → FactoryFacet.createTicket()
├── ticket-mint      → MarketplaceFacet.mintTicket()
├── ticket-checkin   → CheckInFacet.checkIn()
├── event-fees       → MarketplaceFacet.setTicketFees()
└── payout           → MarketplaceFacet.withdrawTicketBalance()

BlockchainTransaction table tracks every job:
  PENDING → SUBMITTED (tx sent) → CONFIRMED (tx mined) | FAILED
```

---

## Database Schema

### Enums

| Enum | Values |
|------|--------|
| UserRole | BUYER, ORGANIZER, ADMIN |
| EventStatus | DRAFT, PUBLISHED, CANCELLED, COMPLETED |
| EventCategory | CONCERT, CONFERENCE, WORKSHOP, PARTY, CORPORATE, SPORTS, OTHER |
| TicketStatus | PENDING, CONFIRMED, USED, CANCELLED, REFUNDED |
| DeliveryChannel | EMAIL, SMS, WHATSAPP |
| TransactionStatus | PENDING, SUCCESS, FAILED |
| PaymentProvider | PAYSTACK, MONNIFY, BLOCKRADAR, CRYPTO |
| PayoutStatus | PENDING, PROCESSING, COMPLETED, FAILED |
| BlockchainTxType | MINT, CREATE_EVENT, CHECKIN, WITHDRAW, SET_FEES |
| BlockchainTxStatus | PENDING, SUBMITTED, CONFIRMED, FAILED |
| NotificationChannel | EMAIL, SMS, WHATSAPP |
| NotificationStatus | PENDING, SENT, FAILED |
| KycTier | NONE, BASIC, ENHANCED |
| KycStatus | PENDING, VERIFIED, REJECTED |

### Models (9 total)

**User**
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK, auto-generated |
| email | String | unique |
| password | String | bcrypt hashed (10 rounds) |
| firstName | String | |
| lastName | String | |
| phone | String? | +234XXXXXXXXXX format |
| role | UserRole | default BUYER |
| walletAddress | String? | Blockradar blockchain address |
| blockradarAddressId | String? | Blockradar child address ID |
| passwordResetToken | String? | hashed reset token |
| passwordResetExpires | DateTime? | token expiry |
| createdAt | DateTime | auto |
| updatedAt | DateTime | auto |

**OrganizerProfile** (1:1 with User, created on role upgrade)
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| userId | UUID | FK → User (unique) |
| bvn | String? | encrypted at rest |
| bvnVerified | Boolean | default false |
| bankName | String? | resolved from Paystack |
| bankCode | String? | Nigerian bank code |
| accountNumber | String? | 10-digit NUBAN |
| accountName | String? | resolved from Paystack |
| bankVerified | Boolean | default false |
| kycTier | KycTier | default NONE |
| kycStatus | KycStatus | default PENDING |
| governmentIdUrl | String? | Tier 2 — uploaded ID |
| selfieUrl | String? | Tier 2 — liveness selfie |
| businessName | String? | optional |
| businessAddress | String? | optional |
| createdAt | DateTime | auto |
| updatedAt | DateTime | auto |

**Event**
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| organizerId | UUID | FK → User |
| name | String | max 100 chars |
| slug | String | unique, auto-generated from name |
| description | String | rich text (max 1000) |
| venue | String | max 200 chars |
| location | String | city/state |
| category | EventCategory | |
| coverImage | String? | URL to uploaded image |
| startTime | DateTime | must be > now + 24h |
| endTime | DateTime | must be >= startTime + 1 day |
| purchaseStartTime | DateTime | must be <= startTime - 1 day |
| status | EventStatus | default DRAFT |
| onChainTicketId | BigInt? | uint64 from smart contract |
| isFree | Boolean | default false |
| isRefundable | Boolean | default false |
| createdAt | DateTime | auto |
| updatedAt | DateTime | auto |

**TicketType** (1:N with Event, 1-5 per event)
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| eventId | UUID | FK → Event |
| name | String | "General", "VIP", "VVIP" |
| description | String? | |
| price | Decimal | NGN. 0 = free, otherwise min 500, max 500,000 |
| quantity | Int | 1 - 50,000 |
| maxPerUser | Int | default 5 |
| soldCount | Int | default 0, incremented on purchase |
| salesStartDate | DateTime? | optional override |
| salesEndDate | DateTime? | optional override |
| createdAt | DateTime | auto |
| updatedAt | DateTime | auto |

**Ticket** (individual purchased ticket)
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| ticketTypeId | UUID | FK → TicketType |
| eventId | UUID | FK → Event |
| buyerId | UUID? | FK → User (nullable for guest checkout) |
| buyerEmail | String | always captured |
| buyerName | String | always captured |
| buyerPhone | String? | +234 format |
| reference | String | unique, format: HOSTIT_TKT_XXXXXX |
| qrCode | String? | URL or encoded QR data |
| tokenId | Int? | NFT token ID from on-chain mint |
| status | TicketStatus | default PENDING |
| deliveryChannel | DeliveryChannel | EMAIL, SMS, or WHATSAPP |
| checkedInAt | DateTime? | set on check-in |
| createdAt | DateTime | auto |
| updatedAt | DateTime | auto |

**Transaction**
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| ticketId | UUID? | FK → Ticket |
| eventId | UUID | FK → Event |
| buyerEmail | String | |
| amount | Decimal | in NGN |
| currency | String | default "NGN" |
| provider | PaymentProvider | PAYSTACK, MONNIFY, BLOCKRADAR, CRYPTO |
| providerReference | String? | provider's transaction ref |
| status | TransactionStatus | default PENDING |
| metadata | Json? | provider-specific data |
| createdAt | DateTime | auto |
| updatedAt | DateTime | auto |

**Payout**
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| organizerId | UUID | FK → User |
| eventId | UUID | FK → Event |
| amount | Decimal | NGN |
| currency | String | default "NGN" |
| provider | PaymentProvider | |
| providerReference | String? | transfer ref |
| status | PayoutStatus | default PENDING |
| bankName | String? | from OrganizerProfile |
| bankCode | String? | |
| accountNumber | String? | |
| accountName | String? | |
| scheduledDate | DateTime | event end + 3 days (refund period) |
| processedAt | DateTime? | |
| createdAt | DateTime | auto |
| updatedAt | DateTime | auto |

**BlockchainTransaction**
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| ticketId | UUID? | FK → Ticket |
| eventId | UUID? | FK → Event |
| txHash | String? | null until tx submitted to chain |
| type | BlockchainTxType | MINT, CREATE_EVENT, CHECKIN, WITHDRAW, SET_FEES |
| status | BlockchainTxStatus | default PENDING |
| retries | Int | default 0, max 3 |
| error | String? | failure reason for debugging |
| createdAt | DateTime | auto |
| updatedAt | DateTime | auto |

**Notification**
| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| userId | UUID? | FK → User |
| ticketId | UUID? | FK → Ticket |
| channel | NotificationChannel | EMAIL, SMS, WHATSAPP |
| type | String | e.g. "ticket_confirmation", "payout_complete", "password_reset" |
| status | NotificationStatus | default PENDING |
| metadata | Json? | template variables, recipient info |
| sentAt | DateTime? | |
| createdAt | DateTime | auto |
| updatedAt | DateTime | auto |

### Key Relations
```
User 1:1 OrganizerProfile
User 1:N Event (as organizer)
User 1:N Ticket (as buyer)
User 1:N Payout
User 1:N Notification
Event 1:N TicketType
Event 1:N Ticket
Event 1:N Transaction
Event 1:N Payout
Event 1:N BlockchainTransaction
TicketType 1:N Ticket
Ticket 1:N Transaction
Ticket 1:N BlockchainTransaction
Ticket 1:N Notification
```

### Key Indexes
- User: email (unique)
- Event: slug (unique), organizerId
- Ticket: reference (unique), eventId + buyerEmail (composite)
- Transaction: providerReference, eventId
- BlockchainTransaction: txHash, eventId

---

## Fee Calculation

```
Ticket Price (per ticket): X
Quantity: N
Subtotal: X * N

Provider Fee:
  Paystack: (Subtotal * 1.5%) + (NGN 100 * N), capped at NGN 2,000
  Monnify:  (Subtotal * 1.5%), capped at NGN 2,000

HostIt Platform Fee: Subtotal * 5%
  - 3% collected on-chain (smart contract, 300 BPS)
  - 2% collected off-chain (backend)

Organizer Receives: Subtotal - Provider Fee - HostIt Fee
Payout available: event endTime + 3 days (refund period)
```

---

## Implementation Phases

---

### PHASE 1 — Foundation
> Project setup, config, Docker, Prisma schema, common utilities. No business logic.

#### 1.1 Generate NestJS project
```bash
pnpm dlx @nestjs/cli new . --package-manager pnpm --skip-git
```

#### 1.2 Install dependencies
**Core:**
```
@nestjs/config @nestjs/passport @nestjs/jwt @nestjs/swagger
@nestjs/throttler @nestjs/terminus passport passport-jwt
@prisma/client ioredis @nestjs/bullmq bullmq bcrypt
class-validator class-transformer joi ethers uuid
```
**Dev:**
```
prisma @types/passport-jwt @types/bcrypt
```

#### 1.3 Environment + Config
- `.env.example` — all environment variables
- `src/config/` — 8 config files + Joi validation + barrel export
  - `app.config.ts` (PORT, NODE_ENV, API_PREFIX)
  - `auth.config.ts` (JWT_SECRET, JWT_EXPIRATION, BCRYPT_ROUNDS)
  - `database.config.ts` (DATABASE_URL)
  - `redis.config.ts` (REDIS_HOST, REDIS_PORT)
  - `paystack.config.ts` (PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY)
  - `monnify.config.ts` (MONNIFY_API_KEY, MONNIFY_SECRET_KEY, etc.)
  - `blockradar.config.ts` (BLOCKRADAR_API_KEY, BLOCKRADAR_MASTER_WALLET_ID)
  - `blockchain.config.ts` (BLOCKCHAIN_RPC_URL, DIAMOND_CONTRACT_ADDRESS, PRIVATE_KEY)
  - `env.validation.ts` — Joi schema for all vars

#### 1.4 Docker Compose
- PostgreSQL 16 (port 5432)
- Redis 7.2 (port 6379)

#### 1.5 Prisma
- Initialize Prisma, write full schema (all 9 models + 14 enums)
- PrismaModule (@Global) + PrismaService
- Run initial migration

#### 1.6 Common utilities (`src/common/`)
| File | Purpose |
|------|---------|
| `filters/http-exception.filter.ts` | Normalized error response format |
| `interceptors/logging.interceptor.ts` | Log method, URL, status, duration |
| `interceptors/transform.interceptor.ts` | Wrap responses: `{ success, data, timestamp }` |
| `decorators/current-user.decorator.ts` | `@CurrentUser()` extracts user from request |
| `decorators/roles.decorator.ts` | `@Roles(UserRole.ADMIN)` metadata setter |
| `decorators/public.decorator.ts` | `@Public()` skips JWT guard |
| `guards/roles.guard.ts` | Checks user role against `@Roles()` metadata |
| `dto/pagination.dto.ts` | Validated `page` + `limit` query params |
| `constants/index.ts` | NGN currency, +234 phone regex, defaults |

#### 1.7 Health check module
- `GET /api/health` — Prisma DB connectivity check via @nestjs/terminus

#### 1.8 main.ts + app.module.ts
- Global prefix: `api`
- Global ValidationPipe: `whitelist: true`, `transform: true`
- Swagger at `/api/docs`
- CORS enabled
- ConfigModule (global, Joi validation)
- ThrottlerModule (60 req/min)

#### Phase 1 File Tree
```
backend-v2/
├── docker-compose.yml
├── .env.example
├── .env
├── prisma/
│   └── schema.prisma
└── src/
    ├── main.ts
    ├── app.module.ts
    ├── config/
    │   ├── index.ts
    │   ├── app.config.ts
    │   ├── auth.config.ts
    │   ├── database.config.ts
    │   ├── redis.config.ts
    │   ├── paystack.config.ts
    │   ├── monnify.config.ts
    │   ├── blockradar.config.ts
    │   ├── blockchain.config.ts
    │   └── env.validation.ts
    ├── prisma/
    │   ├── prisma.module.ts
    │   └── prisma.service.ts
    ├── common/
    │   ├── constants/
    │   │   └── index.ts
    │   ├── decorators/
    │   │   ├── current-user.decorator.ts
    │   │   ├── roles.decorator.ts
    │   │   └── public.decorator.ts
    │   ├── dto/
    │   │   └── pagination.dto.ts
    │   ├── filters/
    │   │   └── http-exception.filter.ts
    │   ├── guards/
    │   │   └── roles.guard.ts
    │   └── interceptors/
    │       ├── logging.interceptor.ts
    │       └── transform.interceptor.ts
    └── health/
        ├── health.module.ts
        └── health.controller.ts
```

#### Phase 1 Verification
```bash
docker compose up -d
pnpm dlx prisma migrate dev --name init
pnpm run start:dev
curl http://localhost:3000/api/health        # → { success: true, data: { status: "ok" } }
open http://localhost:3000/api/docs           # → Swagger UI loads
```

---

### PHASE 2 — Auth Module
> Register, login, password reset, JWT guards, organizer upgrade with KYC

#### Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | Public | Create user (BUYER default), create Blockradar wallet, return JWT |
| POST | `/api/auth/login` | Public | Validate credentials, return JWT (24h expiry) |
| POST | `/api/auth/forgot-password` | Public | Generate reset token, send email (log in dev) |
| POST | `/api/auth/reset-password` | Public | Validate token, update password |
| GET | `/api/auth/me` | JWT | Get current user profile + organizer profile if exists |
| PATCH | `/api/auth/me` | JWT | Update profile (firstName, lastName, phone) |
| POST | `/api/auth/become-organizer` | JWT | Upgrade BUYER → ORGANIZER with KYC Tier 1 |

#### Auth Implementation Details
- JWT payload: `{ sub: user.id, email: user.email, role: user.role }`
- JWT expiry: 24 hours
- Password hashing: bcrypt with 10 salt rounds
- Global `JwtAuthGuard` registered as APP_GUARD — all routes protected by default
- Global `RolesGuard` registered as APP_GUARD
- Routes opt out of auth with `@Public()` decorator
- On registration: queue Blockradar wallet creation (POST /wallets/{id}/addresses)

#### Become Organizer Flow (KYC Tier 1)
```
POST /api/auth/become-organizer
Body: { bvn: "12345678901", bankCode: "058", accountNumber: "0123456789" }

Flow:
  1. Check user is BUYER (reject if already ORGANIZER/ADMIN)
  2. Verify BVN via Paystack → GET https://api.paystack.co/bank/resolve_bvn/:bvn
  3. Verify bank account via Paystack → GET https://api.paystack.co/bank/resolve?account_number=X&bank_code=Y
  4. Create OrganizerProfile record:
     - bvn (encrypted), bvnVerified=true
     - bankName, bankCode, accountNumber, accountName (from Paystack resolve)
     - bankVerified=true, kycTier=BASIC, kycStatus=VERIFIED
  5. Update User.role → ORGANIZER
  6. Return updated user + organizer profile
```

#### Phase 2 Files
```
src/auth/
├── auth.module.ts
├── auth.controller.ts
├── auth.service.ts
├── strategies/
│   └── jwt.strategy.ts
├── guards/
│   └── jwt-auth.guard.ts
└── dto/
    ├── register.dto.ts
    ├── login.dto.ts
    ├── forgot-password.dto.ts
    ├── reset-password.dto.ts
    ├── update-profile.dto.ts
    └── become-organizer.dto.ts
```

#### Phase 2 Verification
```bash
# Register
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@hostit.ng","password":"Test1234!","firstName":"Test","lastName":"User"}'
# → { success: true, data: { accessToken: "eyJ...", user: {...} } }

# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@hostit.ng","password":"Test1234!"}'
# → { success: true, data: { accessToken: "eyJ..." } }

# Get profile (with JWT)
curl http://localhost:3000/api/auth/me -H 'Authorization: Bearer eyJ...'

# Protected route without JWT → 401
curl http://localhost:3000/api/auth/me
# → { statusCode: 401, message: "Unauthorized" }
```

---

### PHASE 3 — Events Module
> CRUD operations, publish triggers on-chain event creation, slug generation

#### Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/events` | Public | Browse/search events (filter: category, location, date, free/paid, status) |
| GET | `/api/events/:slug` | Public | Event details with ticket types and availability |
| POST | `/api/events` | ORGANIZER | Create event as DRAFT with 1-5 ticket types |
| PUT | `/api/events/:id` | ORGANIZER (owner) | Update event (only if DRAFT status) |
| POST | `/api/events/:id/publish` | ORGANIZER (owner) | Publish event → queues on-chain createTicket() |
| DELETE | `/api/events/:id` | ORGANIZER (owner) | Cancel event → status CANCELLED (soft delete) |

#### Key Logic
- Auto-generate URL slug from event name (handle collisions with suffix)
- Validate time constraints:
  - `startTime` > now + 24 hours
  - `endTime` >= startTime + 1 day
  - `purchaseStartTime` <= startTime - 1 day
- Ticket types: 1-5 per event, price 0 (free) or 500-500,000 NGN, quantity 1-50,000
- Publish flow:
  1. Validate event is DRAFT and all fields complete
  2. Queue `BlockchainService.createTicket()` via Bull
  3. On success: store `onChainTicketId`, set status → PUBLISHED
  4. On failure: stay DRAFT, create failed BlockchainTransaction record

#### Phase 3 Files
```
src/events/
├── events.module.ts
├── events.controller.ts
├── events.service.ts
└── dto/
    ├── create-event.dto.ts
    ├── update-event.dto.ts
    └── query-events.dto.ts
```

---

### PHASE 4 — Tickets Module
> Purchase initialization, QR generation, ticket lookup, verification, check-in

#### Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/tickets/purchase` | Public or JWT | Initialize purchase → creates ticket + transaction, returns payment URL |
| GET | `/api/tickets/mine` | JWT | List authenticated user's tickets |
| GET | `/api/tickets/:reference` | Public | Get ticket details by reference (used in QR/email links) |
| POST | `/api/tickets/:reference/verify` | ORGANIZER/ADMIN | Verify ticket validity at the door (read-only check) |
| POST | `/api/tickets/:reference/checkin` | ORGANIZER/ADMIN | Mark ticket as USED → queues on-chain checkIn() |

#### Purchase Flow
```
1. Buyer selects event + ticket type + quantity + delivery channel
2. POST /api/tickets/purchase
   Body: {
     eventId, ticketTypeId, quantity,
     buyerEmail, buyerName, buyerPhone?,
     deliveryChannel: "EMAIL",
     paymentProvider: "PAYSTACK"
   }
3. Backend validates availability (soldCount + quantity <= total quantity)
4. Creates Ticket records (status: PENDING)
5. Creates Transaction record (status: PENDING)
6. Initializes payment with provider → gets checkout URL
7. Returns { checkoutUrl, reference }
8. Buyer pays on provider's checkout page
9. Provider sends webhook → Phase 5 handles confirmation
```

#### Verify vs Check-in
- **Verify**: Read-only. Returns ticket validity, buyer name, ticket type. No state change.
- **Check-in**: Marks ticket USED, sets checkedInAt, queues on-chain checkIn(). Irreversible.

#### Phase 4 Files
```
src/tickets/
├── tickets.module.ts
├── tickets.controller.ts
├── tickets.service.ts
└── dto/
    ├── purchase-ticket.dto.ts
    └── verify-ticket.dto.ts
```

---

### PHASE 5 — Payments + Webhooks
> Unified payment service, Paystack/Monnify/Blockradar providers, webhook handlers

#### Payment Provider Interface
```typescript
interface IPaymentProvider {
  initializePayment(data: InitPaymentDto): Promise<PaymentInitResult>;
  verifyPayment(reference: string): Promise<PaymentVerifyResult>;
  verifyWebhookSignature(body: any, signature: string): boolean;
}
```

#### Provider Details

| Feature | Paystack | Monnify | Blockradar |
|---------|----------|---------|------------|
| Auth | Bearer SECRET_KEY | OAuth 2.0 (1hr token) | x-api-key header |
| Amount unit | Kobo (÷100) | Naira | USD (stablecoins) |
| Initialize | POST /transaction/initialize | POST /api/v1/merchant/transactions/init-transaction | POST /wallets/{id}/addresses (deposit address) |
| Verify | GET /transaction/verify/:ref | GET /api/v2/transactions/:ref | Webhook-driven |
| Webhook sig | HMAC-SHA512 (x-paystack-signature) | SHA512(SECRET\|body) + IP whitelist | HMAC-SHA512 (x-blockradar-signature) |

#### Webhook Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/webhooks/paystack` | Signature verification | Handle charge.success, charge.failed |
| POST | `/webhooks/monnify` | Signature + IP whitelist | Handle SUCCESSFUL_TRANSACTION |
| POST | `/webhooks/blockradar` | Signature verification | Handle deposit.success |

#### Webhook Processing Flow
```
1. Receive webhook POST
2. Verify signature (reject 403 if invalid)
3. Find Transaction by providerReference
4. If payment successful:
   a. Update Transaction.status → SUCCESS
   b. Update Ticket.status → still PENDING (awaiting mint)
   c. Queue NFT mint job (Bull)
   d. Return 200 OK immediately
5. If payment failed:
   a. Update Transaction.status → FAILED
   b. Update Ticket.status → CANCELLED
   c. Return 200 OK
```

#### Phase 5 Files
```
src/payments/
├── payments.module.ts
├── payments.service.ts
├── interfaces/
│   └── payment-provider.interface.ts
├── providers/
│   ├── paystack.provider.ts
│   ├── monnify.provider.ts
│   └── blockradar.provider.ts
└── dto/
    └── initialize-payment.dto.ts

src/webhooks/
├── webhooks.module.ts
└── webhooks.controller.ts
```

---

### PHASE 6 — Blockchain Service
> ethers.js integration with Diamond contract on Lisk L2, Bull job queues

#### Service Methods
| Method | Contract Call | Bull Queue | Trigger |
|--------|-------------|------------|---------|
| createEvent() | FactoryFacet.createTicket(ticketData, feeTypes, prices) | event-publish | Organizer publishes event |
| mintTicket() | MarketplaceFacet.mintTicket(ticketId, feeType, buyer) | ticket-mint | Payment webhook confirmed |
| checkIn() | CheckInFacet.checkIn(ticketId, owner, tokenId) | ticket-checkin | Organizer scans QR |
| setFees() | MarketplaceFacet.setTicketFees(ticketId, feeTypes, fees) | event-fees | Organizer updates pricing |
| withdrawBalance() | MarketplaceFacet.withdrawTicketBalance(ticketId, feeType, to) | payout | Payout processed |

#### Queue Configuration
- Retry: 3 attempts with exponential backoff (5s, 30s, 120s)
- On final failure: update BlockchainTransaction.status → FAILED, alert admin
- Concurrency: 1 per queue (avoid nonce conflicts)

#### Event Listener
- Subscribe to Diamond contract events (TicketMinted, CheckedIn)
- Sync direct on-chain actions to database
- Handle events from buyers who mint directly (Path C)

#### Phase 6 Files
```
src/blockchain/
├── blockchain.module.ts
├── blockchain.service.ts
├── processors/
│   ├── event-publish.processor.ts
│   ├── ticket-mint.processor.ts
│   ├── ticket-checkin.processor.ts
│   └── payout.processor.ts
└── abis/
    ├── factory-facet.abi.json
    ├── marketplace-facet.abi.json
    └── checkin-facet.abi.json
```

---

### PHASE 7 — Notifications
> Email (SendGrid), SMS (Twilio), WhatsApp (Twilio)

#### Notification Triggers
| Event | Channels | Content |
|-------|----------|---------|
| Ticket confirmed (NFT minted) | Email + buyer's chosen channel | Ticket details, QR code, event info |
| Payment failed | Email | Failure notice, retry link |
| Event published | Email (to organizer) | Confirmation, dashboard link |
| Password reset | Email | Reset link with token |
| Payout completed | Email (to organizer) | Amount, bank details, tx reference |
| Payout failed | Email (to organizer) | Failure reason, retry info |

#### Phase 7 Files
```
src/notifications/
├── notifications.module.ts
├── notifications.service.ts
├── processors/
│   └── notification.processor.ts
└── providers/
    ├── sendgrid.provider.ts
    ├── twilio-sms.provider.ts
    └── twilio-whatsapp.provider.ts
```

---

### PHASE 8 — Organizer Dashboard + Admin
> Analytics, attendee management, payouts, platform administration

#### Organizer Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/organizer/events` | ORGANIZER | My events with sales stats |
| GET | `/api/organizer/events/:id/analytics` | ORGANIZER (owner) | Revenue chart, ticket type breakdown, daily sales |
| GET | `/api/organizer/events/:id/attendees` | ORGANIZER (owner) | Attendee list with check-in status, CSV export |
| POST | `/api/organizer/payouts/request` | ORGANIZER | Request payout for an event (after refund period) |
| GET | `/api/organizer/payouts` | ORGANIZER | Payout history |
| PUT | `/api/organizer/bank-details` | ORGANIZER | Update bank account info |

#### Admin Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/dashboard` | ADMIN | Platform stats: total revenue, events, users, active events |
| GET | `/api/admin/events` | ADMIN | All events with moderation actions |
| GET | `/api/admin/users` | ADMIN | User list, role management |
| GET | `/api/admin/transactions` | ADMIN | All transactions across providers |
| GET | `/api/admin/payouts` | ADMIN | All payouts, status filtering |
| POST | `/api/admin/payouts/:id/process` | ADMIN | Manually trigger payout processing |

#### Phase 8 Files
```
src/organizer/
├── organizer.module.ts
├── organizer.controller.ts
└── organizer.service.ts

src/admin/
├── admin.module.ts
├── admin.controller.ts
└── admin.service.ts
```

---

## Complete File Tree

```
backend-v2/
├── IMPLEMENTATION_PLAN.md
├── docker-compose.yml
├── .env.example
├── .env
├── .gitignore
├── nest-cli.json
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── prisma/
│   └── schema.prisma
└── src/
    ├── main.ts
    ├── app.module.ts
    │
    ├── config/
    │   ├── index.ts
    │   ├── app.config.ts
    │   ├── auth.config.ts
    │   ├── database.config.ts
    │   ├── redis.config.ts
    │   ├── paystack.config.ts
    │   ├── monnify.config.ts
    │   ├── blockradar.config.ts
    │   ├── blockchain.config.ts
    │   └── env.validation.ts
    │
    ├── prisma/
    │   ├── prisma.module.ts
    │   └── prisma.service.ts
    │
    ├── common/
    │   ├── constants/
    │   │   └── index.ts
    │   ├── decorators/
    │   │   ├── current-user.decorator.ts
    │   │   ├── roles.decorator.ts
    │   │   └── public.decorator.ts
    │   ├── dto/
    │   │   └── pagination.dto.ts
    │   ├── filters/
    │   │   └── http-exception.filter.ts
    │   ├── guards/
    │   │   └── roles.guard.ts
    │   └── interceptors/
    │       ├── logging.interceptor.ts
    │       └── transform.interceptor.ts
    │
    ├── health/
    │   ├── health.module.ts
    │   └── health.controller.ts
    │
    ├── auth/
    │   ├── auth.module.ts
    │   ├── auth.controller.ts
    │   ├── auth.service.ts
    │   ├── strategies/
    │   │   └── jwt.strategy.ts
    │   ├── guards/
    │   │   └── jwt-auth.guard.ts
    │   └── dto/
    │       ├── register.dto.ts
    │       ├── login.dto.ts
    │       ├── forgot-password.dto.ts
    │       ├── reset-password.dto.ts
    │       ├── update-profile.dto.ts
    │       └── become-organizer.dto.ts
    │
    ├── events/
    │   ├── events.module.ts
    │   ├── events.controller.ts
    │   ├── events.service.ts
    │   └── dto/
    │       ├── create-event.dto.ts
    │       ├── update-event.dto.ts
    │       └── query-events.dto.ts
    │
    ├── tickets/
    │   ├── tickets.module.ts
    │   ├── tickets.controller.ts
    │   ├── tickets.service.ts
    │   └── dto/
    │       ├── purchase-ticket.dto.ts
    │       └── verify-ticket.dto.ts
    │
    ├── payments/
    │   ├── payments.module.ts
    │   ├── payments.service.ts
    │   ├── interfaces/
    │   │   └── payment-provider.interface.ts
    │   ├── providers/
    │   │   ├── paystack.provider.ts
    │   │   ├── monnify.provider.ts
    │   │   └── blockradar.provider.ts
    │   └── dto/
    │       └── initialize-payment.dto.ts
    │
    ├── webhooks/
    │   ├── webhooks.module.ts
    │   └── webhooks.controller.ts
    │
    ├── blockchain/
    │   ├── blockchain.module.ts
    │   ├── blockchain.service.ts
    │   ├── processors/
    │   │   ├── event-publish.processor.ts
    │   │   ├── ticket-mint.processor.ts
    │   │   ├── ticket-checkin.processor.ts
    │   │   └── payout.processor.ts
    │   └── abis/
    │       ├── factory-facet.abi.json
    │       ├── marketplace-facet.abi.json
    │       └── checkin-facet.abi.json
    │
    ├── notifications/
    │   ├── notifications.module.ts
    │   ├── notifications.service.ts
    │   ├── processors/
    │   │   └── notification.processor.ts
    │   └── providers/
    │       ├── sendgrid.provider.ts
    │       ├── twilio-sms.provider.ts
    │       └── twilio-whatsapp.provider.ts
    │
    ├── organizer/
    │   ├── organizer.module.ts
    │   ├── organizer.controller.ts
    │   └── organizer.service.ts
    │
    └── admin/
        ├── admin.module.ts
        ├── admin.controller.ts
        └── admin.service.ts
```

---

## Environment Variables

```env
# App
NODE_ENV=development
PORT=3000
API_PREFIX=api

# Database
DATABASE_URL=postgresql://hostit:hostit@localhost:5432/hostit_v2?schema=public

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Auth
JWT_SECRET=change-me-in-production
JWT_EXPIRATION=24h
BCRYPT_ROUNDS=10

# Paystack
PAYSTACK_SECRET_KEY=sk_test_xxx
PAYSTACK_PUBLIC_KEY=pk_test_xxx

# Monnify
MONNIFY_API_KEY=MK_TEST_xxx
MONNIFY_SECRET_KEY=xxx
MONNIFY_CONTRACT_CODE=xxx
MONNIFY_WALLET_ACCOUNT=xxx
MONNIFY_BASE_URL=https://sandbox.monnify.com

# Blockradar
BLOCKRADAR_API_KEY=br_test_xxx
BLOCKRADAR_MASTER_WALLET_ID=wal_xxx
BLOCKRADAR_BASE_URL=https://api.blockradar.co/v1

# Blockchain (Lisk L2)
BLOCKCHAIN_RPC_URL=https://rpc.sepolia-api.lisk.com
DIAMOND_CONTRACT_ADDRESS=0x...
PRIVATE_KEY=0x...

# SendGrid
SENDGRID_API_KEY=SG.xxx
SENDGRID_FROM_EMAIL=tickets@hostit.ng

# Twilio
TWILIO_ACCOUNT_SID=AC_xxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_PHONE_NUMBER=+234xxx

# Storage (for cover images, QR codes)
S3_BUCKET_NAME=hostit-assets
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx
AWS_REGION=eu-west-1
```

---

## Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| API response time | < 500ms (P95) |
| Concurrent ticket purchases | 1,000 |
| QR scans per hour | 10,000 |
| Uptime | 99.5% |
| Rate limiting | 60 req/min/IP (general), 100 req/min/IP (auth) |
| Password security | bcrypt 10 rounds |
| Transport | HTTPS everywhere |
| Blockchain fallback | If chain is down, tickets work via DB |
