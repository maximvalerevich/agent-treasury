# Agent Treasury

Autonomous spending layer for AI agents, built on [MultiHopper](https://dev-docs.multihopper.com/quickstart)
programmable routing on Solana. Submitted to the **MultiHopper Build & Route Challenge**
(Superteam Earn, `multihopper-build-and-route-challenge-up-to-dollar50000-revenue-share-1`).

## The problem this solves

Giving an agent a wallet is easy. Giving it a wallet it cannot misuse is not. Today
that means either a human approves every transfer (the agent is a script with extra
steps) or the agent holds the key (one bad prompt drains the treasury). MultiHopper
makes the *route* programmable but says nothing about *who is allowed to spend what*.

Agent Treasury sits in that gap: it is the gate between an agent's intent and the
routing layer, with the budget rules outside the model.

## How it works

```
agent  --(intent: pay X for Y)-->  policy gate  -->  MultiHopper route  -->  Solana
                                       |                    |
                                  ledger + webhooks  <-------+
```

1. **Policy gate** (`src/policy/policy.ts`) is a pure function of request, limits and
   ledger. The LLM never decides whether a payment is allowed: per-transaction limit,
   daily budget, recipient allowlist and an approval band are evaluated before any
   network call. Limits deny; only the approval band escalates to a human.
2. **Routing** (`src/multihopper/client.ts`) quotes, creates, prepares and confirms a
   multi-hop transfer with an idempotency key per intent, so a retried agent action
   cannot double-spend.
3. **Signing stays local** (`src/multihopper/signer.ts`). MultiHopper's lifecycle splits
   into API-managed and client-managed halves; the key never leaves the treasury
   process. Bundles are signed and broadcast in the required order
   (`keeperFundingTx` first with an immediate `confirm-broadcast`, then
   `routeInitTxs` → `orchestratorInitTx` → `sessionInitTxs`), preserving the server's
   partial signatures on the versioned bundles.
4. **Reconciliation** (`src/webhook/verify.ts`) verifies the HMAC-SHA256 signature over
   the raw body before trusting any event, then reacts to `transfer.completed`,
   `payout.completed` (integrator reward claim settled) and `transfer.recoverable`
   (funds locked in on-chain accounts and needing a rescue).
5. **Batch payouts** (`src/cli/batch-payout.ts`) pay up to 20 wallets from a single
   route. Hops dominate the cost, so extra destinations are nearly free: this is how
   contributor payouts, royalties and marketplace splits get cheap.

## Integrator revenue

Customers pay a 0.5% percentage fee on full-rate transfers and half of it is the
integrator share: **0.25% of full-fee volume, $2,500 for every $1,000,000 routed**,
paid independently of any prize. Both helpers are in the client and covered by tests
(`MultiHopperClient.integratorRevenueUsd`).

## Quickstart

```bash
cp .env.example .env          # fill MH_API_KEY, TREASURY_KEYPAIR_B58, MH_WEBHOOK_SECRET
npm install
npm run typecheck
npm test
RECIPIENT=<devnet-pubkey> npm run demo        # policy -> estimate -> routed transfer
npm run dev                                   # agent-facing HTTP API on :8787
```

Devnet and production are separate deployments: `mh_test_…` keys are minted on the
devnet dashboard (`devnet.multihopper.com/developer/dashboard`) and **do not work**
against mainnet, and vice versa. Start on devnet; devnet SOL is free.

### Agent-facing API

```bash
curl -s localhost:8787/spend -H 'content-type: application/json' -d '{
  "agentId": "research-agent",
  "recipient": "<pubkey>",
  "amountUsd": 40,
  "amountRaw": "100000000",
  "memo": "compute credits for 200 research tasks"
}'
```

Responses are `approved`, `needs_approval` (above the auto-approve threshold) or
`denied`, each with the reasons that produced the decision, so the agent can explain
itself in a trace instead of silently failing.

## Layout

| Path | Role |
| --- | --- |
| `src/policy/policy.ts` | Deterministic budget and allowlist rules |
| `src/multihopper/client.ts` | Typed REST client, idempotency, integrator maths |
| `src/multihopper/signer.ts` | Ordered signing and broadcast, keys stay local |
| `src/treasury/service.ts` | Intent → policy → route → ledger orchestration |
| `src/webhook/verify.ts` | HMAC verification, event catalogue |
| `src/agent/server.ts` | Agent HTTP API + webhook endpoint |
| `src/cli/*` | Runnable devnet demos |

## Evidence for the campaign

Every routed transfer is recorded in `ledger.jsonl` with agent id, USD notional,
timestamp and the MultiHopper `externalId`, and each transfer carries its mainnet
signature. That is the transaction export the campaign asks for, produced by the
product itself rather than assembled by hand.
