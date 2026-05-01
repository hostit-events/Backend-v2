/**
 * Empty by design.
 *
 * Becoming an organizer no longer collects KYC upfront — anyone can
 * promote to ORGANIZER and start creating crypto-only events. KYC and
 * bank/subaccount setup happen later, per-fiat-provider, when the
 * organizer enables a provider via the OrganizerController endpoints
 * (POST /api/organizer/providers/paystack/enable, /monnify/enable, …).
 */
export class BecomeOrganizerDto {}
