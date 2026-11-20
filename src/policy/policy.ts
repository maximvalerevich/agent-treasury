/**
 * Spending policy for an autonomous agent.
 *
 * The point of this file: an agent that can move money needs a deterministic
 * gate in front of the wallet that it cannot talk its way past. Every decision
 * is a pure function of (request, policy, ledger) so it is testable and
 * auditable — the model never decides whether a payment is allowed.
 */

export interface SpendRequest {
  /** Who is asking, e.g. "research-agent". */
  agentId: string;
  recipient: string;
  amountUsd: number;
  /** Free-form purpose, stored for the audit trail. */
  memo?: string;
}

export interface SpendLedgerEntry {
  agentId: string;
  amountUsd: number;
  at: number;
  externalId?: string;
}

export interface EffectivePolicy {
  perTxLimitUsd: number;
  dailyLimitUsd: number;
  approvalThresholdUsd: number;
  allowedRecipients: string[];
}

export type Decision =
  | { outcome: 'approved'; reasons: string[] }
  | { outcome: 'needs_approval'; reasons: string[] }
  | { outcome: 'denied'; reasons: string[] };

const DAY_MS = 24 * 60 * 60 * 1000;

export function spentToday(ledger: SpendLedgerEntry[], agentId: string, now = Date.now()): number {
  return ledger
    .filter((e) => e.agentId === agentId && now - e.at < DAY_MS)
    .reduce((sum, e) => sum + e.amountUsd, 0);
}

/**
 * Hard rules first, then the approval band. A denial is never downgraded to
 * "needs approval" — limits are limits.
 */
export function evaluateSpend(
  request: SpendRequest,
  policy: EffectivePolicy,
  ledger: SpendLedgerEntry[] = [],
  now = Date.now(),
): Decision {
  const reasons: string[] = [];

  if (!Number.isFinite(request.amountUsd) || request.amountUsd <= 0) {
    return { outcome: 'denied', reasons: ['amount must be a positive number'] };
  }

  if (
    policy.allowedRecipients.length > 0 &&
    !policy.allowedRecipients.includes(request.recipient)
  ) {
    return {
      outcome: 'denied',
      reasons: [`recipient ${request.recipient} is not on the allowlist`],
    };
  }

  if (request.amountUsd > policy.perTxLimitUsd) {
    return {
      outcome: 'denied',
      reasons: [
        `amount ${request.amountUsd} exceeds the per-transaction limit ${policy.perTxLimitUsd}`,
      ],
    };
  }

  const already = spentToday(ledger, request.agentId, now);
  if (already + request.amountUsd > policy.dailyLimitUsd) {
    return {
      outcome: 'denied',
      reasons: [
        `daily budget exceeded: ${already} spent + ${request.amountUsd} requested > ${policy.dailyLimitUsd}`,
      ],
    };
  }

  if (request.amountUsd > policy.approvalThresholdUsd) {
    reasons.push(
      `amount ${request.amountUsd} is above the auto-approve threshold ${policy.approvalThresholdUsd}`,
    );
    return { outcome: 'needs_approval', reasons };
  }

  reasons.push('within per-transaction and daily limits');
  return { outcome: 'approved', reasons };
}
