import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  type TransactionSignature,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { BroadcastSignatures, PreparedTransactions } from './types.js';

export function loadKeypair(base58Secret: string): Keypair {
  if (!base58Secret) throw new Error('TREASURY_KEYPAIR_B58 is empty');
  return Keypair.fromSecretKey(bs58.decode(base58Secret));
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
 */
export async function signAndBroadcast(
  connection: Connection,
  keypair: Keypair,
  prepared: PreparedTransactions,
): Promise<BroadcastSignatures> {
  const out: BroadcastSignatures = {};

  if (prepared.keeperFundingTx) {
    out.keeperFundingSignature = await signBroadcastV0(connection, keypair, prepared.keeperFundingTx);
  }

  if (prepared.routeInitTxs?.length) {
    out.routeInitSignatures = [];
    for (const raw of prepared.routeInitTxs) {
      out.routeInitSignatures.push(await signBroadcastV0(connection, keypair, raw));
    }
  }

  if (prepared.orchestratorInitTx) {
    out.orchestratorInitSignature = await signBroadcastLegacy(connection, keypair, prepared.orchestratorInitTx);
  }

  if (prepared.sessionInitTxs?.length) {
    out.sessionInitSignatures = [];
    for (const raw of prepared.sessionInitTxs) {
      out.sessionInitSignatures.push(await signBroadcastV0(connection, keypair, raw));
    }
  }

  return out;
}

async function signBroadcastV0(
  connection: Connection,
  keypair: Keypair,
  base64Tx: string,
): Promise<TransactionSignature> {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, 'base64'));
  // Adds our signature for our slot; server-side partial signatures are preserved.
  tx.sign([keypair]);
  return broadcast(connection, tx.serialize());
}

async function signBroadcastLegacy(
  connection: Connection,
  keypair: Keypair,
  base64Tx: string,
): Promise<TransactionSignature> {
  const tx = Transaction.from(Buffer.from(base64Tx, 'base64'));
  tx.partialSign(keypair);
  return broadcast(connection, tx.serialize());
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
