/**
 * End-to-end devnet demo: policy -> estimate -> routed transfer -> confirm.
 *
 *   pnpm demo                      # 1 SOL, 7 hops, to the recipient in .env
 *   RECIPIENT=<pubkey> pnpm demo   # explicit recipient
 *
 * Requires MH_API_KEY (mh_test_... from the devnet dashboard), TREASURY_KEYPAIR_B58
 * (devnet funded) and MH_BASE_URL pointing at devnet.
 */
import { Connection } from '@solana/web3.js';
import { loadMultiHopperConfig, loadPolicyConfig } from '../config.js';
import { Ledger } from '../ledger.js';
import { MultiHopperClient } from '../multihopper/client.js';
import { loadKeypair } from '../multihopper/signer.js';
import { AgentTreasury } from '../treasury/service.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function main() {
  const cfg = loadMultiHopperConfig();
  const policy = loadPolicyConfig();
  const keypair = loadKeypair(cfg.treasuryKeypairB58);
  const client = new MultiHopperClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  const connection = new Connection(cfg.rpcUrl, 'confirmed');

  const recipient = process.env.RECIPIENT;
  if (!recipient) throw new Error('Set RECIPIENT to the devnet wallet that should receive the transfer');

  const amountRaw = process.env.AMOUNT_RAW ?? '1000000000'; // 1 SOL in lamports
  const hops = Number(process.env.HOPS ?? 7);

  console.log(`treasury: ${keypair.publicKey.toBase58()}`);
  console.log(`balance : ${(await connection.getBalance(keypair.publicKey)) / 1e9} SOL`);

  const estimate = await client.estimate({
    tokenMint: SOL_MINT,
    amountRaw,
    tokenDecimals: 9,
    hops,
  });
  console.log('estimate:', JSON.stringify(estimate));

  const treasury = new AgentTreasury({
    client,
    connection,
    treasurySecretB58: cfg.treasuryKeypairB58,
    policy,
    ledger: new Ledger(),
  });

  // $1 of notional spend, so the policy gate is what the demo exercises.
  const result = await treasury.spend(
    { agentId: 'demo-agent', recipient, amountUsd: 1, memo: 'devnet end-to-end demo' },
    { tokenMint: SOL_MINT, tokenDecimals: 9, amountRaw, hops, arrivalSeconds: 300 },
  );

  console.log('decision:', result.decision.outcome, result.decision.reasons.join('; '));
  if (result.transfer) {
    console.log(`transfer #${result.transfer.id} status=${result.transfer.status}`);
    console.log('waiting for a terminal status...');
    const final = await client.waitForTerminal(result.transfer.id);
    console.log(`final status: ${final.status}`);
  }
}

main().catch((error) => {
  console.error('demo failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
