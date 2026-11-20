import { randomUUID } from 'node:crypto';
import type {
  BroadcastSignatures,
  CreateTransferRequest,
  EstimateRequest,
  EstimateResponse,
  PrepareResponse,
  Transfer,
  TransferResponse,
} from './types.js';

export class MultiHopperError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'MultiHopperError';
  }
}

export interface MultiHopperClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Thin typed client over the MultiHopper REST API.
 * Auth is `x-api-key`; keys are bound to the environment that minted them.
 */
export class MultiHopperClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MultiHopperClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Percentage fee is 50 bps (0.5%) of the full-rate volume; half of it is the
   * integrator reward that this product earns on every routed transfer.
   */
  static integratorShare(percentFeeBps: number): number {
    return percentFeeBps / 2;
  }

  /**
   * Integrator revenue in token-denominated USD terms: 0.25% of full-fee volume,
   * i.e. $2,500 per $1,000,000 routed.
   */
  static integratorRevenueUsd(fullFeeVolumeUsd: number): number {
    return fullFeeVolumeUsd * 0.0025;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    const body: unknown = text ? safeJson(text) : undefined;
    if (!res.ok) {
      throw new MultiHopperError(`MultiHopper ${init.method ?? 'GET'} ${path} failed`, res.status, body);
    }
    return body as T;
  }

  estimate(req: EstimateRequest): Promise<EstimateResponse> {
    return this.request<EstimateResponse>('/transfers/estimate', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async createTransfer(req: CreateTransferRequest, idempotencyKey: string = randomUUID()): Promise<TransferResponse> {
    if (req.recipientWallet && req.destinations) {
      throw new Error('Send exactly one of recipientWallet or destinations, never both');
    }
    if (!req.recipientWallet && !req.destinations) {
      throw new Error('One of recipientWallet or destinations is required');
    }
    return this.request<TransferResponse>('/transfers', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(req),
    });
  }

  prepare(transferId: number): Promise<PrepareResponse> {
    return this.request<PrepareResponse>(`/transfers/${transferId}/prepare`, { method: 'POST' });
  }

  /**
   * Called TWICE per transfer: first right after keeperFundingTx is broadcast,
   * then after the remaining bundles, which activates the transfer.
   */
  confirmBroadcast(transferId: number, signatures: BroadcastSignatures): Promise<TransferResponse> {
    return this.request<TransferResponse>(`/transfers/${transferId}/confirm-broadcast`, {
      method: 'POST',
      body: JSON.stringify(signatures),
    });
  }

  getTransfer(transferId: number): Promise<TransferResponse> {
    return this.request<TransferResponse>(`/transfers/${transferId}`);
  }

  /** Polls until a terminal status is reached or the timeout elapses. */
  async waitForTerminal(transferId: number, timeoutMs = 300_000, intervalMs = 4_000): Promise<Transfer> {
    const terminal = new Set(['completed', 'failed', 'expired', 'refunded', 'rescued']);
    const deadline = Date.now() + timeoutMs;
    let last: Transfer | undefined;
    while (Date.now() < deadline) {
      last = (await this.getTransfer(transferId)).transfer;
      if (terminal.has(last.status)) return last;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (!last) throw new Error('Transfer never returned a status');
    return last;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
