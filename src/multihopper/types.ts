/**
 * Wire types for the MultiHopper REST API (v1).
 * Source: https://dev-docs.multihopper.com/quickstart and /api-reference
 */

export interface Destination {
  wallet: string;
  /** Share of the transfer's amountRaw. All shares must sum to amountRaw exactly. */
  amountRaw: string;
}

export interface EstimateRequest {
  tokenMint: string;
  amountRaw: string;
  tokenDecimals: number;
  hops: number;
  destinationCount?: number;
}

export interface EstimateResponse {
  tier?: string;
  /** Percentage fee in basis points, e.g. 50 = 0.5% */
  percentFeeBps: number;
  totalFlatFeeLamports: number;
  usdEquivalent?: number;
  sol?: { breakdown?: { dispersionRentLamports?: number } };
}

export interface CreateTransferRequest {
  tokenMint: string;
  amountRaw: string;
  amountTokens?: string;
  tokenDecimals: number;
  tokenSymbol?: string;
  sourceOwner: string;
  /** Send exactly one of recipientWallet or destinations, never both. */
  recipientWallet?: string;
  destinations?: Destination[];
  hops: number;
  arrivalSeconds: number;
  externalId?: string;
}

/**
 * A prepared bundle as the live API returns it: most fields are base64 strings,
 * but `routeInitTxs` items come back as `{ base64 }` objects.
 */
export type PreparedTx = string | { base64: string };

export interface PreparedTransactions {
  routeInitTxs?: PreparedTx[] | null;
  orchestratorInitTx?: PreparedTx | null;
  sessionInitTxs?: PreparedTx[] | null;
  keeperFundingTx?: PreparedTx | null;
  dispersionInitTxs?: PreparedTx[] | null;
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
}

export interface Transfer {
  id: number;
  status: TransferStatus;
  amountRaw?: string;
  recipientReceivesRaw?: string;
  externalId?: string;
  signature?: string;
  [key: string]: unknown;
}

export type TransferStatus =
  | 'awaiting_signature'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'refunded'
  | 'recoverable'
  | 'rescued';

export interface TransferResponse {
  transfer: Transfer;
}

export interface PrepareResponse {
  transfer: Transfer;
  preparedTxs: PreparedTransactions;
}

export interface BroadcastSignatures {
  routeInitSignatures?: string[];
  orchestratorInitSignature?: string;
  sessionInitSignatures?: string[];
  keeperFundingSignature?: string;
}
