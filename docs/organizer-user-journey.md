# HostIT Organizer — User Journey

A designer-ready walkthrough of every state an organizer passes through, what they do, what they see, and what the system is doing behind the scenes. Based on what's built and what's on the roadmap — so the UI can be designed against real data and real states, not fiction.

---

## Stage 1 — Becoming an organizer

### 1.1 — Sign up (as a regular user first)
Every organizer starts as a buyer. Standard registration.

- **Inputs:** email, password, first name, last name
- **Result:** authenticated session (JWT)
- **UI needs:** simple registration form, email confirmation state (future), login screen

### 1.2 — Discover the "become an organizer" path
A signed-in buyer sees a CTA (e.g. in their profile or dashboard) — *"Host your own event."* Tapping it opens the KYC flow.

- **UI needs:** entry points from profile / dashboard / empty-state on "My events"
- **Designer note:** this is where you sell the offer — *"Keep 97% of every sale. Payouts direct to your bank."*

### 1.3 — KYC Tier 1 (BVN + bank)
Form capture. Three fields.

- **Inputs:** BVN (11 digits), bank (dropdown — a "list banks" endpoint will be needed eventually), account number (10 digits)
- **Happy path:** bank-name + account-name auto-resolved inline as they type the account number ("JANE DOE — GTBank") — confidence signal
- **What happens behind the scenes:** BVN verified → bank account verified → Paystack subaccount created → Monnify sub-account created → user role upgraded to ORGANIZER
- **Edge states the designer must cover:**
  - BVN mismatch ("The name on your BVN doesn't match…")
  - Account number can't be resolved
  - One provider's subaccount creation fails (user is still upgraded, a banner appears — "Payment routing partially set up — retry")
  - All succeed → success screen with a celebratory moment

### 1.4 — Onboarding complete
Organizer now has: `role = ORGANIZER`, verified bank, both provider subaccounts.

- **UI needs:** empty-state dashboard *"Create your first event"*

---

## Stage 2 — Creating an event

### 2.1 — Event creation form
A single form (can be multi-step if designed that way) capturing event + ticket types.

- **Inputs:**
  - Event: name, description, venue, location, category (enum), cover image upload, start time, end time, purchase-start time (when sales begin), isFree, isRefundable
  - Ticket types: array of `{ name, description, price, quantity, maxPerUser, salesStartDate?, salesEndDate? }` — 1 to 5 types
- **UI needs:**
  - Add/remove ticket type rows
  - Price input in NGN (free events: toggle "This event is free" → hides price)
  - Date/time pickers with clear ordering (purchase-start < event-start < event-end)
  - Live preview of what buyers will see
- **Status after save:** `DRAFT` — **not visible to buyers yet**

### 2.2 — Reviewing and editing a DRAFT event
Organizer can edit any field while in DRAFT. Once published, most fields lock.

- **UI needs:** clear "DRAFT" badge on the event card, *"Edit"* button, *"Publish"* primary CTA
- **Lock state:** the designer should consider showing which fields become read-only after publish so expectations are set

### 2.3 — Publishing
The big button. Moves status to `PUBLISHED` and triggers on-chain ticket creation on Lisk L2 (async, Bull queue).

- **What the user sees:** *"Publishing…"* (seconds) → *"Published — your event is now live"*
- **Behind the scenes:** `Event.status = PUBLISHED`, a `BlockchainTransaction` row is created with `type: CREATE_EVENT`, a worker picks it up, calls the Diamond contract, stores `onChainTicketId` back on the event
- **Edge state:** on-chain creation can fail — designer should plan for a subtle "On-chain registration pending" pill that resolves once confirmed
- **After publish:** shareable event URL (`/events/<slug>`)

### 2.4 — Cancelling an event
Soft delete — marks `status = CANCELLED`. Not destructive.

- **UI needs:** confirmation dialog with consequences spelled out *"Buyers will be refunded"* (refund flow is future scope)
- **After cancel:** event becomes hidden from browsing, listed in a "Cancelled" filter in the organizer's view

---

## Stage 3 — Running a live event

### 3.1 — "My events" dashboard
The organizer's home screen. List of their events with quick stats per card.

- **Per event card (planned, issue #43):** name, date, status badge (DRAFT / PUBLISHED / CANCELLED / COMPLETED), tickets sold (`soldCount` / total `quantity`), revenue to date (sum of `organizerAmount` for SUCCESS transactions)
- **Filters:** status, date range
- **UI needs:** sort options, empty state, "Create new event" CTA

### 3.2 — Single event detail (organizer view)
Distinct from the public detail page. Dashboard-shaped.

- **Top:** event meta, status, shareable URL
- **Sales panel:** tickets sold, revenue, % sold per ticket type
- **Recent activity:** latest purchases (timestamp, email, ticket type, amount)
- **Actions:** Edit (if DRAFT), Publish (if DRAFT), Cancel (if PUBLISHED), View attendees, View analytics, Request payout

### 3.3 — Event analytics (#44)
A tab or sub-page on the event detail.

- **Charts:**
  - Revenue over time (daily line chart)
  - Ticket breakdown (stacked bar or donut: VIP / Regular / etc.)
  - Conversion-ish metrics later
- **Numbers:** gross revenue, platform fee, gateway fees, net to organizer
- **UI needs:** date range selector, provider filter (Paystack / Monnify), export button (CSV)

### 3.4 — Attendee list (#45)
Full list of everyone who bought a ticket.

- **Columns:** name, email, phone, ticket type, reference, status (PENDING / CONFIRMED / CHECKED-IN / CANCELLED), purchase date, amount
- **Actions:** resend confirmation email, download CSV, (future) invalidate a ticket
- **UI needs:** search, filters, pagination
- **Designer note:** this is the screen organizers will stare at on event day — prioritise scan-ability and checked-in %

### 3.5 — Check-in experience (#24)
Door-side view, likely mobile-first.

- **Flow:** scan QR on attendee's ticket → backend verifies → checkmark ✅ or red X ❌ with reason
- **States:** valid, already used, cancelled, wrong event, invalid
- **UI needs:** camera permissions prompt, big readable status, undo / manual lookup fallback

---

## Stage 4 — Getting paid

### 4.1 — How the money moves (context for the designer)
With provider-side split settlement:

- Buyer pays ₦10,000 via Paystack / Monnify
- Paystack deducts ~₦250 gateway fee from the organizer's share
- ₦300 (3%) lands in HostIT's account
- ₦9,450 lands in the **organizer's Paystack/Monnify subaccount** (not their bank yet)
- The provider's settlement cycle (T+1 for Paystack) moves it from the subaccount to the organizer's bank — **automatically, no action needed from the app**

### 4.2 — Payout history (#46)
Read-only view of settlements that have landed.

- **Per row:** date, amount, event, bank account, status (PENDING / PROCESSING / COMPLETED / FAILED)
- **UI needs:** status badges, receipt download, filter by event/date
- **Designer note:** this screen builds trust — it's how the organizer verifies they actually got paid

### 4.3 — Request a payout (#46) — manual path
For future flexibility (e.g. USDC payouts, or early settlement pre-T+1). On v1 this may be redundant since split settles automatically, but the endpoint is planned.

- **Inputs:** amount, destination (bank on file), reason (optional)
- **UI:** form with current balance displayed

### 4.4 — Update bank details (#47)
Change the bank account tied to the organizer profile.

- **Inputs:** new bank code, new account number
- **Behind the scenes:** Paystack + Monnify subaccounts are updated with the new bank (or new subaccounts are created and old ones deprecated — TBD)
- **UI needs:** warning about in-flight settlements, confirmation step, list of past bank accounts for audit

---

## Stage 5 — Recurring and long-term

### 5.1 — Repeat events
An organizer clones a past event or creates a new one. Same flow as the first event but pre-fills from their organizer profile (banking, business name, venue if repeating).

### 5.2 — Past / completed events
Event auto-moves to `COMPLETED` after `endTime` passes.

- **UI state:** grayed out, archived feel
- **Actions available:** view attendee list, view analytics, export CSV, duplicate

### 5.3 — Organizer profile / settings
Central place to update:

- Business name
- Business address
- Bank details
- Government ID / selfie (for KYC Tier 2 later — not yet built)
- Notification preferences

---

## State machine summary

Handy reference for the designer.

| Entity | States | Who triggers transition |
|---|---|---|
| **User role** | BUYER → ORGANIZER → ADMIN | BUYER → ORGANIZER: KYC completion |
| **KYC** | NONE → PENDING → VERIFIED / REJECTED | System (Paystack/Monnify responses) |
| **Event** | DRAFT → PUBLISHED → (CANCELLED or COMPLETED) | Organizer (draft/publish/cancel); System (completed) |
| **Ticket** | PENDING → CONFIRMED → USED / CANCELLED / REFUNDED | System (via payment webhook / check-in) |
| **Transaction** | PENDING → SUCCESS / FAILED | System (gateway webhook) |
| **Payout** | PENDING → PROCESSING → COMPLETED / FAILED | System (provider settlement webhook) |

---

## Cross-cutting UX notes for the designer

1. **Status is everything.** Badges should be immediately distinguishable at a glance (colour + shape + text, not colour alone — accessibility).
2. **Money UI must be trust-building.** Always show the breakdown: gross → gateway fee → platform fee → your net. Never surprise.
3. **Async states need affordances.** Publishing, on-chain creation, payout processing — all take seconds to minutes. Plan skeleton/loading/progress states for each.
4. **Empty states matter.** First-time organizer, first event, first sale, first payout — these are moments that either delight or frustrate.
5. **Mobile-first for check-in.** The door scanner is phone-only. Everything else can be desktop-primary.
6. **Guest purchases exist.** The attendee list will include people without accounts — design the list to handle both clearly.

---

## What's NOT in the journey (explicitly out of scope for v1)

So the designer doesn't design things the backend doesn't have:

- Refunds — scope TBD, won't exist for launch
- Organizer-to-organizer transfers
- Multi-organizer / team events (single owner only for now)
- Currency other than NGN
- Discount codes / promo codes
- Seat selection (all tickets are general admission)
- In-app chat / buyer support
- Crypto payments (Blockradar is parked for v1)
