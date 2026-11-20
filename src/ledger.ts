import type { SpendLedgerEntry } from './policy/policy.js';

/**
 * Append-only spend ledger. Local JSONL is deliberate: the audit trail has to
 * survive a crash mid-transfer, and a file append is atomic enough for that.
 */
export class Ledger {
  private entries: SpendLedgerEntry[] = [];

  constructor(private readonly path?: string) {}

  async load(): Promise<void> {
    if (!this.path) return;
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      this.entries = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SpendLedgerEntry);
    } catch {
      this.entries = [];
    }
  }

  all(): SpendLedgerEntry[] {
    return [...this.entries];
  }

  async record(entry: SpendLedgerEntry): Promise<void> {
    this.entries.push(entry);
    if (!this.path) return;
    const fs = await import('node:fs/promises');
    await fs.appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}
