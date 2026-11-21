import { describe, expect, it, vi } from 'vitest';
import { MultiHopperClient, MultiHopperError, formatTokenAmount } from '../src/multihopper/client.js';

describe('formatTokenAmount', () => {
  it('renders lamports as SOL decimals', () => {
    expect(formatTokenAmount('100000000', 9)).toBe('0.1');
    expect(formatTokenAmount('1000000000', 9)).toBe('1');
    expect(formatTokenAmount('99502487', 9)).toBe('0.099502487');
  });

  it('handles integer-only and zero-decimal tokens', () => {
    expect(formatTokenAmount('2500000', 6)).toBe('2.5');
    expect(formatTokenAmount('7', 0)).toBe('7');
  });

  it('rejects a non-integer decimals value', () => {
    expect(() => formatTokenAmount('1', -1)).toThrow(/non-negative integer/);
  });
});

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

  it('always sends amountTokens, which the live API requires', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ transfer: { id: 8, status: 'quote' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl,
    });

    await client.createTransfer(
      {
        tokenMint: 'So11111111111111111111111111111111111111112',
        amountRaw: '100000000',
        tokenDecimals: 9,
        sourceOwner: 's',
        recipientWallet: 'r',
        hops: 3,
        arrivalSeconds: 300,
      },
      'idem-2',
    );

    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.amountTokens).toBe('0.1');
    expect(body.tokenDecimals).toBe(9);
  });

  it('respects an explicit amountTokens', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ transfer: { id: 9, status: 'quote' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl,
    });

    await client.createTransfer({
      tokenMint: 'm',
      amountRaw: '1000000',
      amountTokens: '1.000001',
      tokenDecimals: 6,
      sourceOwner: 's',
      recipientWallet: 'r',
      hops: 1,
      arrivalSeconds: 60,
    });

    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.amountTokens).toBe('1.000001');
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

describe('response envelopes', () => {
  const jsonFetch = (body: unknown, status = 200) =>
    vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;

  it('reads a flat create response (the live API shape)', async () => {
    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl: jsonFetch({ id: 1724, status: 'quote', recipientReceivesRaw: '99502487' }),
    });
    const res = await client.createTransfer({
      tokenMint: 'm',
      amountRaw: '100000000',
      tokenDecimals: 9,
      sourceOwner: 's',
      recipientWallet: 'r',
      hops: 3,
      arrivalSeconds: 300,
    });
    expect(res.transfer.id).toBe(1724);
    expect(res.transfer.recipientReceivesRaw).toBe('99502487');
  });

  it('reads a wrapped create response too', async () => {
    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl: jsonFetch({ transfer: { id: 5, status: 'quote' } }),
    });
    const res = await client.createTransfer({
      tokenMint: 'm',
      amountRaw: '1',
      tokenDecimals: 9,
      sourceOwner: 's',
      recipientWallet: 'r',
      hops: 1,
      arrivalSeconds: 60,
    });
    expect(res.transfer.id).toBe(5);
  });

  it('reads a flat transfer on getTransfer', async () => {
    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl: jsonFetch({ id: 1725, status: 'completed' }),
    });
    const res = await client.getTransfer(1725);
    expect(res.transfer.status).toBe('completed');
  });

  it('unwraps confirm-broadcast', async () => {
    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl: jsonFetch({ transfer: { id: 6, status: 'processing' } }),
    });
    const res = await client.confirmBroadcast(6, { keeperFundingSignature: 'sig' });
    expect(res.transfer.status).toBe('processing');
  });

  it('fails loudly when prepare returns no bundles', async () => {
    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl: jsonFetch({ transfer: { id: 7, status: 'quote' } }),
    });
    await expect(client.prepare(7)).rejects.toThrow(/no preparedTxs/);
  });

  it('returns preparedTxs alongside the transfer', async () => {
    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl: jsonFetch({
        transfer: { id: 8, status: 'awaiting_signature' },
        preparedTxs: { keeperFundingTx: 'b64', routeInitTxs: ['b64'] },
      }),
    });
    const res = await client.prepare(8);
    expect(res.preparedTxs.keeperFundingTx).toBe('b64');
    expect(res.preparedTxs.routeInitTxs).toEqual(['b64']);
  });

  it('sends an Idempotency-Key on prepare and confirm-broadcast (MH_070 otherwise)', async () => {
    const fetchImpl = jsonFetch({
      transfer: { id: 9, status: 'awaiting_signature' },
      preparedTxs: { keeperFundingTx: 'b64' },
    });
    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl,
    });
    await client.prepare(9, 'idem-prep');
    await client.confirmBroadcast(9, { keeperFundingSignature: 'sig' }, 'idem-confirm');

    const calls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect((calls[0]![1].headers as Record<string, string>)['Idempotency-Key']).toBe('idem-prep');
    expect((calls[1]![1].headers as Record<string, string>)['Idempotency-Key']).toBe('idem-confirm');
  });

  it('does not declare a JSON content-type on a bodyless mutation', async () => {
    const fetchImpl = jsonFetch({
      transfer: { id: 10, status: 'quote' },
      preparedTxs: { keeperFundingTx: 'b64' },
    });
    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl,
    });
    await client.prepare(10, 'idem-prep');

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://devnet.multihopper.com/api/v1/transfers/10/prepare');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('still declares JSON when sending a body', async () => {
    const fetchImpl = jsonFetch({ transfer: { id: 11, status: 'processing' } });
    const client = new MultiHopperClient({
      baseUrl: 'https://devnet.multihopper.com/api/v1',
      apiKey: 'k',
      fetchImpl,
    });
    await client.confirmBroadcast(11, { keeperFundingSignature: 'sig' }, 'idem-c');
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});
