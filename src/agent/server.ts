import express, { type Request, type Response } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { loadMultiHopperConfig, loadPolicyConfig } from '../config.js';
import { Ledger } from '../ledger.js';
import { MultiHopperClient } from '../multihopper/client.js';
import { AgentTreasury } from '../treasury/service.js';
import { SIGNATURE_HEADER, verifyWebhookSignature, type WebhookEnvelope } from '../webhook/verify.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const spendSchema = z.object({
  agentId: z.string().min(1),
  recipient: z.string().min(32),
  amountUsd: z.number().positive(),
  memo: z.string().max(280).optional(),
  tokenMint: z.string().default(SOL_MINT),
  tokenDecimals: z.number().int().min(0).max(9).default(9),
  amountRaw: z.string().regex(/^\d+$/, 'amountRaw must be an integer string in base units'),
  hops: z.number().int().min(1).max(20).default(5),
  arrivalSeconds: z.number().int().min(0).max(86_400).default(300),
});

export function buildApp() {
  const cfg = loadMultiHopperConfig();
  const policy = loadPolicyConfig();
  const ledger = new Ledger(process.env.LEDGER_PATH ?? 'ledger.jsonl');
  const client = new MultiHopperClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  const connection = new Connection(cfg.rpcUrl, 'confirmed');
  const treasury = new AgentTreasury({
    client,
    connection,
    treasurySecretB58: cfg.treasuryKeypairB58,
    policy,
    ledger,
  });

  const app = express();

  // Raw body is required for HMAC verification; parse JSON only after.
  app.use('/webhooks/multihopper', express.raw({ type: '*/*' }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, environment: cfg.baseUrl });
  });

  app.get('/budget/:agentId', (req, res) => {
    res.json(treasury.budgetSnapshot(req.params.agentId));
  });

  /** The agent-facing endpoint. Returns a decision, never a private key. */
  app.post('/spend', async (req: Request, res: Response) => {
    const parsed = spendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', issues: parsed.error.issues });
      return;
    }
    const input = parsed.data;
    try {
      const result = await treasury.spend(
        {
          agentId: input.agentId,
          recipient: input.recipient,
          amountUsd: input.amountUsd,
          memo: input.memo,
        },
        {
          tokenMint: input.tokenMint,
          tokenDecimals: input.tokenDecimals,
          amountRaw: input.amountRaw,
          hops: input.hops,
          arrivalSeconds: input.arrivalSeconds,
        },
      );
      const status = result.decision.outcome === 'approved' ? 200 : 202;
      res.status(status).json({
        outcome: result.decision.outcome,
        reasons: result.decision.reasons,
        transferId: result.transfer?.id,
        transferStatus: result.transfer?.status,
        externalId: result.externalId,
        explorer: result.signatures?.[0]
          ? `https://explorer.solana.com/tx/${result.signatures[0]}?cluster=devnet`
          : undefined,
      });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** MultiHopper webhooks: verify the HMAC over the raw body, then reconcile. */
  app.post('/webhooks/multihopper', async (req: Request, res: Response) => {
    const raw = req.body as Buffer;
    const signature = req.header(SIGNATURE_HEADER);
    if (!verifyWebhookSignature(raw, signature, cfg.webhookSecret)) {
      res.status(401).json({ error: 'bad signature' });
      return;
    }
    let event: WebhookEnvelope;
    try {
      event = JSON.parse(raw.toString('utf8')) as WebhookEnvelope;
    } catch {
      res.status(400).json({ error: 'invalid json' });
      return;
    }
    // Ack fast: MultiHopper retries on any non-2xx, five attempts max.
    res.status(200).json({ received: true, type: event.type });
    if (event.type === 'transfer.completed') {
      const externalId = event.data?.externalId;
      console.log(`[webhook] transfer.completed externalId=${externalId ?? 'n/a'} id=${event.data?.transferId ?? 'n/a'}`);
    }
    if (event.type === 'payout.completed') {
      console.log('[webhook] integrator reward claim settled');
    }
    if (event.type === 'transfer.recoverable') {
      console.warn(`[webhook] funds locked, needs a rescue: ${JSON.stringify(event.data ?? {})}`);
    }
  });

  return { app, treasury, client, connection };
}

export function assertRecipient(address: string): string {
  return new PublicKey(address).toBase58();
}

const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  const { app } = buildApp();
  const port = Number(process.env.PORT ?? 8787);
  app.listen(port, () => console.log(`agent-treasury listening on http://127.0.0.1:${port}`));
}
