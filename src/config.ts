import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Env var ${name} must be a number, got ${raw}`);
  return parsed;
}

export interface MultiHopperConfig {
  baseUrl: string;
  apiKey: string;
  rpcUrl: string;
  treasuryKeypairB58: string;
  webhookSecret: string;
}

export function loadMultiHopperConfig(): MultiHopperConfig {
  return {
    baseUrl: required('MH_BASE_URL', 'https://devnet.multihopper.com/api/v1').replace(/\/$/, ''),
    apiKey: required('MH_API_KEY'),
    rpcUrl: required('SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
    treasuryKeypairB58: process.env.TREASURY_KEYPAIR_B58 ?? '',
    webhookSecret: process.env.MH_WEBHOOK_SECRET ?? '',
  };
}

export function isDevnet(baseUrl: string): boolean {
  return baseUrl.includes('devnet');
}

export interface PolicyConfig {
  perTxLimitUsd: number;
  dailyLimitUsd: number;
  approvalThresholdUsd: number;
  allowedRecipients: string[];
}

export function loadPolicyConfig(): PolicyConfig {
  const allowed = (process.env.POLICY_ALLOWED_RECIPIENTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    perTxLimitUsd: num('POLICY_PER_TX_LIMIT_USD', 250),
    dailyLimitUsd: num('POLICY_DAILY_LIMIT_USD', 1000),
    approvalThresholdUsd: num('POLICY_APPROVAL_THRESHOLD_USD', 100),
    allowedRecipients: allowed,
  };
}
