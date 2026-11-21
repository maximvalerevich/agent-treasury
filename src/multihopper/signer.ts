import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  type TransactionSignature,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { BroadcastSignatures, PreparedTransactions, PreparedTx } from './types.js';

export function loadKeypair(base58Secret: string): Keypair {
  if (!base58Secret) throw new Error('TREASURY_KEYPAIR_B58 is empty');
  return Keypair.fromSecretKey(bs58.decode(base58Secret));
}

/**
 * The live API is not uniform: most bundles arrive as bare base64 strings, while
 * `routeInitTxs` items arrive as `{ base64 }` objects. Accept both.
 */
export function unwrapPreparedTx(tx: PreparedTx): string {
  if (typeof tx === 'string') return tx;
  if (tx && typeof tx === 'object' && typeof tx.base64 === 'string') return tx.base64;
  throw new Error(`Unrecognised prepared transaction shape: ${JSON.stringify(tx).slice(0, 60)}`);
}

/**
 * Signing order matters and is not optional:
 *   1. keeperFundingTx (v0)  - broadcast and confirm FIRST, then confirm-broadcast
 *   2. routeInitTxs[] (v0)
 *   3. orchestratorInitTx (legacy)
 *   4. sessionInitTxs[] (v0)
 * Any field that is null was already confirmed on a previous attempt: skip it.
 *
 * The server pre-signs the versioned bundles with ephemeral keypairs, so signing
 * must ADD our signature without wiping the existing ones.
 *
 * On live devnet `orchestratorInitTx` arrives as a versioned (v0) message even
 * though the documentation describes it as a legacy transaction, so the type is
 * detected at signing time instead of being assumed.
 */
export async function signAndBroadcast(
  connection: Connection,
  keypair: Keypair,
  prepared: PreparedTransactions,
): Promise<BroadcastSignatures> {
  const out: BroadcastSignatures = {};

  if (prepared.keeperFundingTx) {
    out.keeperFundingSignature = await signBroadcast(connection, keypair, unwrapPreparedTx(prepared.keeperFundingTx));
  }

  if (prepared.routeInitTxs?.length) {
    out.routeInitSignatures = [];
    for (const raw of prepared.routeInitTxs) {
      out.routeInitSignatures.push(await signBroadcast(connection, keypair, unwrapPreparedTx(raw)));
    }
  }

  if (prepared.orchestratorInitTx) {
    out.orchestratorInitSignature = await signBroadcast(
      connection,
      keypair,
      unwrapPreparedTx(prepared.orchestratorInitTx),
    );
  }

  if (prepared.sessionInitTxs?.length) {
    out.sessionInitSignatures = [];
    for (const raw of prepared.sessionInitTxs) {
      out.sessionInitSignatures.push(await signBroadcast(connection, keypair, unwrapPreparedTx(raw)));
    }
  }

  return out;
}

/** Signs a bundle as versioned when it parses as one, otherwise as a legacy tx. */
async function signBroadcast(
  connection: Connection,
  keypair: Keypair,
  base64Tx: string,
): Promise<TransactionSignature> {
  const bytes = Buffer.from(base64Tx, 'base64');
  try {
    const tx = VersionedTransaction.deserialize(bytes);
    // Adds our signature for our slot; server-side partial signatures are preserved.
    tx.sign([keypair]);
    return broadcast(connection, tx.serialize());
  } catch {
    const tx = Transaction.from(bytes);
    tx.partialSign(keypair);
    return broadcast(connection, tx.serialize());
  }
}

async function broadcast(
  connection: Connection,
  raw: Uint8Array | Buffer,
): Promise<TransactionSignature> {
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: true,
    maxRetries: 3,
  });
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  return signature;
}
