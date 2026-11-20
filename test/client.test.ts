import { describe, expect, it, vi } from 'vitest';
import { MultiHopperClient, MultiHopperError } from '../src/multihopper/client.js';

describe('integrator economics', () => {
  it('either half of the 0.5% full-rate fee is the integrator share', () => {
    expect(MultiHopperClient.integratorShare(50)).toBe(25);
  });

  it('pays $2,500 per $1,000,000 routed', () => {
    expect(MultiHopperClient.integratorRevenueUsd(1_000_000)).toBe(2500);
    expect(MultiHopperClient.integratorRevenueUsd(100_000)).toBe(250);
  });
});

describe('createTransfer', () => {
  it('refuses both recipientWallet and destinations', async () => {
    const client = new MultiHopperClient({ baseUrl: 'https://devnet.multihopper.com/api/v1', apiKey: 'k' });
    await expect(
      client.createTransfer({
        tokenMint: 'm',
        amountRaw: '1',
        tokenDecimals: 9,
        sourceOwner: 's',
        recipientWallet: 'r',
        destinations: [{ wallet: 'r', amountRaw: '1' }],
        hops: 3,
        arrivalSeconds: 60,
      }),
    ).rejects.toThrow(/exactly one of recipientWallet or destinations/);
  });

  it('refuses neither', async () => {
    const client = new MultiHopperClient({ baseUrl: 'https://devnet.multihopper.com/api/v1', apiKey: 'k' });
    await expect(
      client.createTransfer({
        tokenMint: 'm',
        amountRaw: '1',
        tokenDecimals: 9,
        sourceOwner: 's',
        hops: 3,
        arrivalSeconds: 60,
      }),
    ).rejects.toThrow(/required/);
  });

  it('sends the api key and an idempotency key', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ transfer: { id: 7, status: 'awaiting_signature' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'mh_test_abc',
      fetchImpl,
    });

    const res = await client.createTransfer(
      {
        tokenMint: 'm',
        amountRaw: '1000',
        tokenDecimals: 9,
        sourceOwner: 's',
        recipientWallet: 'r',
        hops: 3,
        arrivalSeconds: 60,
      },
      'idem-1',
    );

    expect(res.transfer.id).toBe(7);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://devnet.multihopper.com/api/v1/transfers');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('mh_test_abc');
    expect(headers['Idempotency-Key']).toBe('idem-1');
  });

  it('raises a typed error on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'insufficient funds' }), { status: 402 }),
    ) as unknown as typeof fetch;

    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl,
    });

    await expect(client.getTransfer(1)).rejects.toBeInstanceOf(MultiHopperError);
  });
});
