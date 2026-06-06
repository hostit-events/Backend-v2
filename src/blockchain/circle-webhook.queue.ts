/**
 * Bull queue for async processing of verified Circle webhooks. The
 * controller persists the raw delivery to `WebhookEvent` (audit) and
 * enqueues a job carrying only that row's id — the processor loads the
 * payload from the audit row, so we never push large payloads through
 * Redis and the audit table stays the single source of truth.
 */
export const CIRCLE_WEBHOOK_QUEUE = 'circle-webhook';
export const CIRCLE_WEBHOOK_JOB = 'process';

export interface CircleWebhookJobData {
  /** WebhookEvent.id of the persisted (audit) delivery to process. */
  webhookEventId: string;
}
