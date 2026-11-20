/**
 * Multi-destination payout demo: one route pays several wallets, which is the
 * cheap shape (hops dominate the cost, extra destinations do not).
 *
 *   PAYOUTS="<pubkey>=400000000,<pubkey>=600000000" pnpm batch
 *
 * Shares must sum exactly to AMOUNT_RAW (default 1 SOL in lamports).
 */
import { Connection } from '@solana/web3.js';
import { loadMultiHopperConfig } from '../config.js';
import { MultiHopperClient } from '../multihopper/client.js';
import { loadKeypair } from '../multihopper/signer.js';
import type { Destination } from '../multihopper/types.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function parsePayouts(raw: string): Destination[] {
  return raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [wallet, amountRaw] = pair.split('=');
      if (!wallet || !amountRaw) throw new Error(`bad PAYOUTS entry: ${pair}`);
      return { wallet, amountRaw };
    });
}

async function main() {
  const cfg = loadMultiHopperConfig();
  const client = new MultiHopperClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  const keypair = loadKeypair(cfg.treasuryKeypairB58);

  const raw = process.env.PAYOUTS;
  if (!raw) throw new Error('Set PAYOUTS="<pubkey>=<amountRaw>,<pubkey>=<amountRaw>"');

  const destinations = parsePayouts(raw);
  const amountRaw = destinations.reduce((sum, d) => sum + BigInt(d.amountRaw), 0n).toString();

  const estimate = await client.estimate({
    tokenMint: SOL_MINT,
    amountRaw,
    tokenDecimals: 9,
    hops: Number(process.env.HOPS ?? 3),
    destinationCount: destinations.length,
  });
  console.log(`paying ${destinations.length} wallets, total ${amountRaw} lamports`);
  console.log('estimate:', JSON.stringify(estimate));

  const created = await client.createTransfer({
    tokenMint: SOL_MINT,
    amountRaw,
    tokenDecimals: 9,
    sourceOwner: keypair.publicKey.toBase58(),
    destinations,
    hops: Number(process.env.HOPS ?? 3),
    arrivalSeconds: Number(process.env.ARRIVAL_SECONDS ?? 600),
    externalId: `at-batch-${Date.now()}`,
  });
  console.log(`transfer #${created.transfer.id} status=${created.transfer.status}`);
}

main().catch((error) => {
  console.error('batch payout failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
