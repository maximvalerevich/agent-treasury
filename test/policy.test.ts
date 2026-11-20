import { describe, expect, it } from 'vitest';
import { evaluateSpend, spentToday, type EffectivePolicy, type SpendLedgerEntry } from '../src/policy/policy.js';

const policy: EffectivePolicy = {
  perTxLimitUsd: 250,
  dailyLimitUsd: 1000,
  approvalThresholdUsd: 100,
  allowedRecipients: [],
};

const DAY = 24 * 60 * 60 * 1000;

describe('evaluateSpend', () => {
  it('approves a small payment inside every limit', () => {
    const d = evaluateSpend({ agentId: 'a', recipient: 'R1', amountUsd: 25 }, policy);
    expect(d.outcome).toBe('approved');
  });

  it('sends a payment above the approval threshold to a human, not to the chain', () => {
    const d = evaluateSpend({ agentId: 'a', recipient: 'R1', amountUsd: 150 }, policy);
    expect(d.outcome).toBe('needs_approval');
  });

  it('denies above the per-transaction limit instead of asking for approval', () => {
    const d = evaluateSpend({ agentId: 'a', recipient: 'R1', amountUsd: 400 }, policy);
    expect(d.outcome).toBe('denied');
    expect(d.reasons.join(' ')).toContain('per-transaction');
  });

  it('denies when the daily budget would be exceeded', () => {
    const ledger: SpendLedgerEntry[] = [{ agentId: 'a', amountUsd: 950, at: Date.now() }];
    const d = evaluateSpend({ agentId: 'a', recipient: 'R1', amountUsd: 95 }, policy, ledger);
    expect(d.outcome).toBe('denied');
    expect(d.reasons.join(' ')).toContain('daily budget');
  });

  it('ignores entries from other agents and from previous days', () => {
    const ledger: SpendLedgerEntry[] = [
      { agentId: 'b', amountUsd: 900, at: Date.now() },
      { agentId: 'a', amountUsd: 900, at: Date.now() - 2 * DAY },
    ];
    expect(spentToday(ledger, 'a')).toBe(0);
    expect(evaluateSpend({ agentId: 'a', recipient: 'R1', amountUsd: 50 }, policy, ledger).outcome).toBe('approved');
  });

  it('enforces the recipient allowlist when one is configured', () => {
    const strict = { ...policy, allowedRecipients: ['KNOWN'] };
    expect(evaluateSpend({ agentId: 'a', recipient: 'UNKNOWN', amountUsd: 10 }, strict).outcome).toBe('denied');
    expect(evaluateSpend({ agentId: 'a', recipient: 'KNOWN', amountUsd: 10 }, strict).outcome).toBe('approved');
  });

  it('rejects non-positive amounts', () => {
    expect(evaluateSpend({ agentId: 'a', recipient: 'R1', amountUsd: 0 }, policy).outcome).toBe('denied');
    expect(evaluateSpend({ agentId: 'a', recipient: 'R1', amountUsd: -5 }, policy).outcome).toBe('denied');
  });
});
