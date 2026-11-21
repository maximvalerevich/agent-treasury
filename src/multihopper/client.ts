import { randomUUID } from 'node:crypto';
import type {
  BroadcastSignatures,
  CreateTransferRequest,
  EstimateRequest,
  EstimateResponse,
  PrepareResponse,
  PreparedTransactions,
  Transfer,
  TransferResponse,
} from './types.js';

/**
 * Formats a raw base-unit amount as a decimal token amount the API accepts.
 * The live API rejects `POST /transfers` without `amountTokens`
 * (`BAD_REQUEST: amountTokens: Required`), so the client fills it whenever a
 * caller leaves it out.
 */
export function formatTokenAmount(amountRaw: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`tokenDecimals must be a non-negative integer, got ${decimals}`);
  }
  const digits = BigInt(amountRaw).toString();
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

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
    // Content-Type is set only when there is a body: the API's Fastify layer
    // rejects a mutation that declares JSON but sends none
    // (`FST_ERR_CTP_EMPTY_JSON_BODY`), which is what `POST /prepare` looks like.
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      ...((init.headers ?? {}) as Record<string, string>),
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
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
    const payload: CreateTransferRequest = {
      ...req,
      amountTokens: req.amountTokens ?? formatTokenAmount(req.amountRaw, req.tokenDecimals),
    };
    const body = await this.request<unknown>('/transfers', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    });
    return normalizeTransfer(body);
  }

  async prepare(transferId: number, idempotencyKey: string = randomUUID()): Promise<PrepareResponse> {
    const body = await this.request<unknown>(`/transfers/${transferId}/prepare`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    const wrapped = body as { transfer?: Transfer; preparedTxs?: PreparedTransactions };
    const preparedTxs = wrapped.preparedTxs ?? (wrapped.transfer as { preparedTxs?: PreparedTransactions } | undefined)?.preparedTxs;
    if (!preparedTxs) {
      throw new MultiHopperError(`prepare returned no preparedTxs for transfer ${transferId}`, 200, body);
    }
    return { transfer: normalizeTransfer(body).transfer, preparedTxs };
  }

  /**
   * Records broadcast signatures against a transfer order-side. The docs
   * describe calling this twice (keeper funding first, then the rest), but the
   * live API rejects a body without `routeInitSignatures`
   * (`BAD_REQUEST: routeInitSignatures: Required`), so callers send every
   * signature in one call once the bundles are on chain.
   */
  async confirmBroadcast(
    transferId: number,
    signatures: BroadcastSignatures,
    idempotencyKey: string = randomUUID(),
  ): Promise<TransferResponse> {
    const body = await this.request<unknown>(`/transfers/${transferId}/confirm-broadcast`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(signatures),
    });
    return normalizeTransfer(body);
  }

  async getTransfer(transferId: number): Promise<TransferResponse> {
    const body = await this.request<unknown>(`/transfers/${transferId}`);
    return normalizeTransfer(body);
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

/**
 * The live API is inconsistent about envelopes: `POST /transfers` and
 * `GET /transfers/{id}` return the transfer object at the top level, while
 * `prepare` and `confirm-broadcast` wrap it as `{ transfer }`. Normalise both so
 * callers never have to care which endpoint they hit.
 */
export function normalizeTransfer(body: unknown): TransferResponse {
  const wrapped = body as { transfer?: Transfer } | null;
  if (wrapped && typeof wrapped === 'object' && wrapped.transfer) {
    return { transfer: wrapped.transfer };
  }
  return { transfer: body as Transfer };
}
