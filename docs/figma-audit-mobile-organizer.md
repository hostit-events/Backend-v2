# HostIT Design Audit — Mobile Organizer Flow

**Source of truth:** the backend (this repository).
**Reviewed against Figma file:** `Hostit` (page: `Web-v2`).
**Scope:** mobile (393×852) screens covering the organizer flow only. Buyer flow + web are separate audits.

This document lists each design correction the UI/UX designer needs to apply so the screens reflect what the backend actually implements. Each entry names the affected frame and the specific change required. Where the design implies functionality the backend has explicitly *decided against*, the entry says so.

---

## Architectural decisions the design needs to absorb

These are settled product/engineering decisions. Several screens were drafted before they landed and now need updating:

| Decision | What it means for design |
|---|---|
| **JIT-KYC (no tiers)** | Becoming an organizer is friction-free — no BVN, no bank, no documents. KYC happens **per fiat provider** when the organizer chooses to accept fiat. Tier 1 / Tier 2 / Tier 3 do not exist. |
| **Multi-country, multi-currency** | Each event has its own `country` and `currency`. The design assumes Nigeria + USD throughout; both need to become dynamic. |
| **Multi-chain** | Each event's ticket NFTs live on **one blockchain** chosen by the organizer at creation time. Backend already supports it (`Event.chain`, registry of `ACTIVE_CHAINS`). The design has no chain picker — needs adding. |
| **Platform fee = 3%** | Not 5%. Three frames currently say 5% — change them all. |
| **Crypto is universal** | Every event accepts crypto by default. Fiat is opt-in per provider per organizer. The "Enable Paystack / Enable Monnify" pattern is how fiat shows up. |

---

## Per-screen corrections

### 🔴 `KYC-tier-1`  ·  id=`944:251`  ·  **delete this frame**

The backend no longer requires upfront KYC at organizer signup. This screen reflects an architecture that's been replaced.

**Replace with two new screens:**

1. **"Enable Paystack"** — the BVN + bank-code + account-number form, contextualised to Paystack
2. **"Enable Monnify"** — same shape, contextualised to Monnify

Each is reached from the Profile screen's "Payment providers" panel (see profile redesign below) or from event creation if the organizer wants to accept fiat without having enabled any provider.

The fields stay the same as today's KYC-tier-1:
- BVN (11 digits)
- Bank dropdown (Nigerian banks for NG)
- Account number (10-digit NUBAN for NG)

The headline changes from "Become an organizer" to "Enable Paystack" / "Enable Monnify".

---

### 🔴 `kyc-success`  ·  id=`944:274`  ·  **delete and replace**

The current copy ("Your identity is verified and your bank account is linked") conflates two events that no longer happen together.

**Replace with two screens:**

1. **"You're an organizer!"** — shown after `/auth/become-organizer`. No KYC mention. Body: "You can now create crypto-only events. Want to accept fiat too? Enable a provider to get started."
   CTAs: `Create your first event` · `Enable a fiat provider`

2. **"[Provider] enabled"** — shown after enable-paystack or enable-monnify completes. Body: "Paystack is now active. NGN events can use Paystack at checkout." (Substitute provider name and currency.)
   CTAs: `Back to dashboard` · `Enable another provider`

---

### 🟡 `create-event` (4 steps) — multiple corrections

#### Step 1 (BASIC INFO) · id=`944:287`

Existing fields are correct — categories chips (Conference, Concert, Sports, Other, Corporate, Party, Workshop) match the backend's `EventCategory` enum exactly. Form fields map cleanly.

**Add two new pickers** (either both in step 1 or split across step 1 and step 2):

1. **Currency picker** — supported currencies (`NGN`, `USD` today; more later). Default to `NGN` if the account country is `NG`. Drives every price display + the prefix in step 3.
2. **Blockchain picker** — supported chains. Drives where the ticket NFTs are minted. The frontend should fetch this list from the backend (live config) rather than hardcoding it, since chains can be added/removed in `chains.config.ts`. Suggested options today (subject to environment):
   - **Base Sepolia (testnet)** — for staging/dev
   - **Base** — for production
   The picker should be **disabled with a helpful tooltip after the event is published** (since the on-chain entry can't be moved between chains). Help text: "The blockchain where your ticket NFTs will be minted. This can't be changed once your event is published."

Both pickers are required to satisfy the multi-country + multi-chain decisions. Without them, every event is implicitly NGN + the default chain.

#### Step 2 (LOCATION & TIMING) · id=`944:440`

No changes. Validation hint matches backend exactly: "Event must start at least 24h from now. Sales must open at least 1 day before the event."

#### Step 3 (TICKET TYPES) · id=`944:389`

- **Price input prefix `$` → dynamic.** Show the currency selected in step 1's picker (₦ for NGN, $ for USD, etc.).
- **"Add ticket types (3 remaining)"** implies a 4-max cap. Backend doesn't enforce this. Either confirm the cap with product (and we'll add the constraint server-side) or change the copy to neutral (`Add ticket type` without a count).

#### Step 4 (Preview & publish) · id=`952:285`

- **All `$` → currency-aware**, same as step 3.
- **"Fee breakdown (per ticket): 5%" → "3%"**. The backend's `PLATFORM_FEE_RATE` is `0.03` (3%). Update copy + recompute the example numbers throughout the preview.
- **Surface the chosen blockchain** in the preview. Add a row alongside the existing "Refundable: Yes" — e.g. "Blockchain: Base Sepolia". Lets the organizer confirm where their NFTs will live before publishing.

---

### 🟡 `Event` (events list) · id=`952:335`  +  `Active-nav` · id=`952:411`

These are the same screen with different active-nav states. Same corrections apply to both.

#### Status badges

The design's `LIVE` / `UPCOMING` / `PAST` labels are display-only — they're derived from the backend's `EventStatus` + timing. Confirm the mapping with the frontend team:

| Design badge | Backend state |
|---|---|
| `LIVE` | `PUBLISHED` AND now is between `startTime` and `endTime` |
| `UPCOMING` | `PUBLISHED` AND now is before `startTime` |
| `PAST` | `PUBLISHED` AND now is after `endTime`, OR `COMPLETED` |
| (Drafts tab filter) | `DRAFT` |
| **(missing)** | `CANCELLED` — design has no representation |

**Add a representation for cancelled events.** Either a separate "Cancelled" tab next to "Past", or a badge that surfaces alongside cancelled cards. Right now cancelled events would just disappear.

#### Currency on revenue cards

`REVENUE $1000` → currency-aware per event. Different events in the list may have different currencies; each card shows its event's symbol.

---

### 🟡 `Event-detail` (Overview tab) · id=`952:470`

#### Stats grid

- `REVENUE $5k (after fees: $4.8k)` — recompute the example using **3% platform fee + ~1.5% processing fee**. The current numbers reflect 4% gap, which doesn't match either rate.
- All `$` → currency-aware.

Other stats (TICKET SOLD, DAYS LEFT, CHECKED IN) are derived/calculated correctly — no change needed.

#### Add: chain badge

Surface the event's blockchain somewhere in the header area (e.g. next to "LIVE" status). A small chip like `Base Sepolia` or `Base` lets the organizer see at a glance which chain their NFTs are on. Important when they have events on different chains.

---

### 🟡 `Event-detail-attendee` (Attendee tab) · id=`952:534`

No design corrections. The fields shown (avatar initials, ticket type, email, name, check-in time / "NOT ARRIVED") all map cleanly to the backend's `Ticket` model. Search bar is a frontend concern.

---

### 🟡 `Event-detail-attendee` (Analytic tab) · id=`952:646`

#### Payout summary

Backend platform fee is **3%**, not 5%:

| Current design | Change to |
|---|---|
| `Total revenue: $44300` | (currency-aware) |
| `Platform fee (5%): -$2150` | `Platform fee (3%): -$1329` |
| `Processing fee: -$150` | (keep — depends on the fiat provider's fee structure) |
| `Net payout: $42000` | recompute: `$44300 - $1329 - $150 = $42821` |

Currency symbol throughout — dynamic.

---

### 🟡 `Payout` · id=`952:713`

#### Status terminology

Align design labels with backend `PayoutStatus` enum (`PENDING / PROCESSING / COMPLETED / FAILED`):

| Design label | Backend state |
|---|---|
| `Completed` | `COMPLETED` ✅ |
| `Failed` | `FAILED` ✅ |
| `Scheduled` | `PENDING` |
| (missing) | `PROCESSING` — add a "Processing" or "In progress" label for in-flight payouts |

#### Currency

`AVAILABLE BALANCE $100,000` → currency-aware. If an organizer has events across multiple currencies, the screen needs to either:
- Show a balance per currency (one row per currency), or
- Pick a primary display currency and show it

Confirm with product which model — recommend per-currency rows for clarity.

#### "Request payout" CTA — pending product decision

Backend supports both patterns (organizer-initiated vs scheduled cron). Confirm with product before designing the action. If auto-cron is the answer, replace the CTA with a passive "Next payout: [date]" indicator instead of "Request payout".

---

### 🟢 `Scan` · id=`952:759`

No design corrections. The flow maps to backend's planned QR verify + checkin endpoints.

---

### 🟢 `Scan-success` · id=`952:239`

The example reference `HOSTIT_TKT_W3L2741` is just placeholder text. Confirm the actual format with the backend reference utility (`src/tickets/utils/reference.ts`) and update the example. Real format may be `HOSTIT_TKT_<short-uuid>` or similar.

---

### 🟡 `Scan-failed` · id=`952:261`

The "Report issue" action has no backend endpoint. Two options:
1. Remove the button until backend has a `/api/tickets/:ref/report-issue` route
2. Keep it as a frontend-only modal that emails support

Recommend option 2 for now — better UX, low backend cost.

---

### 🔴 `profile` · id=`952:773`  ·  **major restructure**

This is the screen most affected by the JIT-KYC decision. The whole tier system needs to come out.

#### Remove

- "BASIC" tier badge at the top
- "TIER 1 - BASIC" section header
- Verification checklist (BVN verified, Bank account verified, Government ID verification, Selfie / liveness check)
- "Upgrade to Tier 2" CTA

#### Replace with: "Payment providers" panel

```
PAYMENT PROVIDERS
─────────────────────────────────────
✓ Paystack — Enabled
  BVN verified · Bank linked
  GTBank •••• 6789                 [Disable]

  Monnify — Not enabled
  Accept NGN payments via Monnify  [Enable]

+ Add another fiat provider
```

State transitions:
- "Not enabled" → tap `[Enable]` → goes to the provider-specific enable form (replaces today's KYC-tier-1)
- "Enabled" → tap `[Disable]` → confirmation modal, then unlinks (no backend endpoint yet, design ahead of it — fine)

#### Keep (no changes)

- Avatar + name + email
- Settings section (Edit Profile, Bank Details, Notification, Help & support, Change password, Log Out)

Bank Details settings row stays — it's the consolidated bank info across all enabled providers.

---

### 🟢 `share-event` · id=`952:859`

No backend corrections. The share modal is frontend-only (constructs the share URL from the event's slug). The QR code option can encode the event URL — no signature needed (unlike ticket QRs, which are signed).

---

## Consolidated change checklist

For the designer to track progress:

- [ ] **Profile**: remove tier system, replace with payment-providers panel
- [ ] **KYC-tier-1**: delete; create per-provider enable screens (×2: Paystack, Monnify)
- [ ] **kyc-success**: delete; create two separate success screens (organizer-promoted vs provider-enabled)
- [ ] **create-event step 1 or 2**: add currency picker
- [ ] **create-event step 1 or 2**: add blockchain picker (locked after publish)
- [ ] **create-event step 3**: dynamic price prefix
- [ ] **create-event step 3**: confirm 4-cap on ticket types or remove the count
- [ ] **create-event step 4**: change "5%" to "3%" + recompute example numbers + dynamic currency
- [ ] **create-event step 4**: surface the chosen blockchain in the preview row list
- [ ] **Event list**: add representation for `CANCELLED` status; dynamic currency on revenue
- [ ] **Event-detail Overview**: dynamic currency; recompute revenue example using 3%; add chain badge
- [ ] **Event-detail Analytic**: change "5%" to "3%" + recompute payout summary; dynamic currency
- [ ] **Payout**: align status labels with backend enum; add "Processing" state; dynamic currency; confirm payout-request model with product
- [ ] **Scan-success**: update reference example to match real format
- [ ] **Scan-failed**: keep "Report issue" as frontend-only or remove
- [ ] **All screens**: any `$` symbol becomes dynamic per `event.currency`

---

## Out of scope for this audit

- **Web (desktop) screens** — separate audit pass
- **Mobile buyer flow** — separate audit pass
- **Notifications preferences screen** — backend doesn't have the model yet, design is fine as a mock
- **Help & support / Change password screens** — minor, address with the buyer audit

---

*Audit produced 2026-05-03 against Figma file `UuDbEUYeKyIzCXMHuADtBf`, page `Web-v2`. Frame IDs cited above can be opened directly in Figma — paste them into the URL after `?node-id=` (replacing `:` with `-`).*
