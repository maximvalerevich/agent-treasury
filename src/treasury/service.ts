import { Connection, type TransactionSignature } from '@solana/web3.js';
import { MultiHopperClient } from '../multihopper/client.js';
import { loadKeypair, signAndBroadcast } from '../multihopper/signer.js';
import type { CreateTransferRequest, Destination, Transfer } from '../multihopper/types.js';
import { Ledger } from '../ledger.js';
import {
  evaluateSpend,
  spentToday,
  type Decision,
  type EffectivePolicy,
  type SpendRequest,
} from '../policy/policy.js';

export interface TreasuryOptions {
  client: MultiHopperClient;
  connection: Connection;
  treasurySecretB58: string;
  policy: EffectivePolicy;
  ledger?: Ledger;
}

export interface SpendResult {
  decision: Decision;
  transfer?: Transfer;
  signatures?: TransactionSignature[];
  externalId?: string;
}

/**
 * The product: an AI agent asks to spend, policy decides, MultiHopper routes,
 * the ledger records. The agent never touches a private key and never picks the
 * route; it only states intent.
 */
export class AgentTreasury {
  private readonly connection: Connection;
  private readonly client: MultiHopperClient;
  private readonly policy: EffectivePolicy;
  private readonly ledger: Ledger;
  private readonly secret: string;

  constructor(options: TreasuryOptions) {
    this.client = options.client;
    this.connection = options.connection;
    this.policy = options.policy;
    this.ledger = options.ledger ?? new Ledger();
    this.secret = options.treasurySecretB58;
  }

  /** Dry-run: what would happen to this request, right now. */
  preflight(request: SpendRequest): Decision {
    return evaluateSpend(request, this.policy, this.ledger.all());
  }

  budgetSnapshot(agentId: string): { spentTodayUsd: number; remainingUsd: number } {
    const spent = spentToday(this.ledger.all(), agentId);
    return { spentTodayUsd: spent, remainingUsd: Math.max(0, this.policy.dailyLimitUsd - spent) };
  }

  async spend(
    request: SpendRequest,
    route: { tokenMint: string; tokenDecimals: number; amountRaw: string; hops: number; arrivalSeconds: number },
  ): Promise<SpendResult> {
    const decision = this.preflight(request);
    if (decision.outcome !== 'approved') {
      return { decision };
    }

    const keypair = loadKeypair(this.secret);
    const externalId = `at-${request.agentId}-${Date.now()}`;

    const createReq: CreateTransferRequest = {
      tokenMint: route.tokenMint,
      amountRaw: route.amountRaw,
      tokenDecimals: route.tokenDecimals,
      sourceOwner: keypair.publicKey.toBase58(),
      recipientWallet: request.recipient,
      hops: route.hops,
      arrivalSeconds: route.arrivalSeconds,
      externalId,
    };

    const created = await this.client.createTransfer(createReq, externalId);
    const transferId = created.transfer.id;

    const prepared = await this.client.prepare(transferId);
    const signatures = await signAndBroadcast(this.connection, keypair, prepared.preparedTxs);

    // First confirm-broadcast right after keeperFundingTx, then the rest.
    await this.client.confirmBroadcast(transferId, { keeperFundingSignature: signatures.keeperFundingSignature });
    const activated = await this.client.confirmBroadcast(transferId, {
      routeInitSignatures: signatures.routeInitSignatures,
      orchestratorInitSignature: signatures.orchestratorInitSignature,
      sessionInitSignatures: signatures.sessionInitSignatures,
    });

    await this.ledger.record({
      agentId: request.agentId,
      amountUsd: request.amountUsd,
      at: Date.now(),
      externalId,
    });

    return {
      decision,
      transfer: activated.transfer,
      signatures: collect(signatures),
      externalId,
    };
  }

  /**
   * Batch payout: one route pays up to 20 wallets, which is where the cost
   * advantage lives (hops dominate, destinations are cheap).
   */
  async payContributors(
    agentId: string,
    destinations: Destination[],
    route: { tokenMint: string; tokenDecimals: number; amountRaw: string; hops: number; arrivalSeconds: number },
  ): Promise<Transfer> {
    if (destinations.length === 0 || destinations.length > 20) {
      throw new Error('destinations must contain between 1 and 20 wallets');
    }
    const total = destinations.reduce((sum, d) => sum + BigInt(d.amountRaw), 0n);
    if (total !== BigInt(route.amountRaw)) {
      throw new Error(
        `destination shares (${total}) must sum exactly to amountRaw (${route.amountRaw})`,
      );
    }

    const keypair = loadKeypair(this.secret);
    const externalId = `at-batch-${agentId}-${Date.now()}`;
    const created = await this.client.createTransfer(
      {
        tokenMint: route.tokenMint,
        amountRaw: route.amountRaw,
        tokenDecimals: route.tokenDecimals,
        sourceOwner: keypair.publicKey.toBase58(),
        destinations,
        hops: route.hops,
        arrivalSeconds: route.arrivalSeconds,
        externalId,
      },
      externalId,
    );

    const prepared = await this.client.prepare(created.transfer.id);
    const signatures = await signAndBroadcast(this.connection, keypair, prepared.preparedTxs);
    await this.client.confirmBroadcast(created.transfer.id, {
      keeperFundingSignature: signatures.keeperFundingSignature,
    });
    const activated = await this.client.confirmBroadcast(created.transfer.id, {
      routeInitSignatures: signatures.routeInitSignatures,
      orchestratorInitSignature: signatures.orchestratorInitSignature,
      sessionInitSignatures: signatures.sessionInitSignatures,
    });
    return activated.transfer;
  }
}

function collect(s: {
  keeperFundingSignature?: string;
  routeInitSignatures?: string[];
  orchestratorInitSignature?: string;
  sessionInitSignatures?: string[];
}): TransactionSignature[] {
  return [
    s.keeperFundingSignature,
    ...(s.routeInitSignatures ?? []),
    s.orchestratorInitSignature,
    ...(s.sessionInitSignatures ?? []),
  ].filter((x): x is string => Boolean(x)) as TransactionSignature[];
}
