import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from '../src/webhook/verify.js';

const secret = 'whsec_test_secret';

describe('webhook signature', () => {
  const body = JSON.stringify({ type: 'transfer.completed', data: { transferId: 42, externalId: 'at-demo-1' } });

  it('accepts a payload signed with the endpoint secret', () => {
    expect(verifyWebhookSignature(body, signWebhookPayload(body, secret), secret)).toBe(true);
  });

  it('rejects a missing or wrong secret', () => {
    expect(verifyWebhookSignature(body, signWebhookPayload(body, secret), 'wrong')).toBe(false);
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const signature = signWebhookPayload(body, secret);
    const tampered = body.replace('42', '43');
    expect(verifyWebhookSignature(tampered, signature, secret)).toBe(false);
  });

  it('works on raw buffers, which is what the server passes', () => {
    const raw = Buffer.from(body, 'utf8');
    expect(verifyWebhookSignature(raw, signWebhookPayload(raw, secret), secret)).toBe(true);
  });
});
