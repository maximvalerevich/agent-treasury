import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-multihopper-signature';

/**
 * MultiHopper signs webhook payloads with HMAC-SHA256 over the RAW body using
 * the endpoint secret. Verify against the raw bytes, never a re-serialised
 * object, or legitimate events will fail.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signature.trim().toLowerCase();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}

export function signWebhookPayload(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export const TRANSFER_EVENTS = [
  'transfer.quote_created',
  'transfer.deposit_confirmed',
  'transfer.processing',
  'transfer.phase_changed',
  'transfer.hop_complete',
  'transfer.completed',
  'transfer.failed',
  'transfer.expired',
  'transfer.refunded',
  'transfer.recoverable',
  'transfer.rescued',
  'transfer.rent_reclaimed',
  'payout.completed',
] as const;

export type TransferEventType = (typeof TRANSFER_EVENTS)[number];

export interface WebhookEnvelope {
  id?: string;
  type: TransferEventType;
  data?: {
    transferId?: number;
    externalId?: string;
    status?: string;
    amountRaw?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
