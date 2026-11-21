# Agent Treasury

Policy-gated spending layer for AI agents, built on [MultiHopper](https://dev-docs.multihopper.com/quickstart)
programmable routing on Solana. Submitted to the **MultiHopper Build & Route Challenge**
(Superteam Earn, `multihopper-build-and-route-challenge-up-to-dollar50000-revenue-share-1`).

TypeScript, no framework lock-in, 34 tests, verified end to end on Solana devnet.

## The problem this solves

Giving an agent a wallet is easy. Giving it a wallet it cannot misuse is not. Today
that means either a human approves every transfer (the agent is a script with extra
steps) or the agent holds the key (one bad prompt drains the treasury). MultiHopper
makes the *route* programmable but says nothing about *who is allowed to spend what*.

Agent Treasury sits in that gap: it is the gate between an agent's intent and the
routing layer, with the budget rules outside the model.

## What a team gets

- An HTTP endpoint an agent calls to pay for things, with per-transaction, daily and
  recipient rules enforced before any network call.
- A deterministic answer to "was this spend allowed, and why", returned with every
  decision so the agent can explain itself in a trace.
- One code path for single transfers and for batch payouts to up to 20 wallets, where
  hops dominate cost and extra destinations are nearly free.
- Local key custody: the treasury secret never leaves the process and the routing
  provider never sees it.
- A ledger and a webhook loop that survive retries, restarts and re-delivered events.

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
   process. Bundles are signed and broadcast in the required order (`keeperFundingTx`
   first, then `routeInitTxs`, then `orchestratorInitTx`, then `sessionInitTxs`),
   preserving the server's partial signatures on the versioned bundles.
4. **Reconciliation** (`src/webhook/verify.ts`) verifies the HMAC-SHA256 signature over
   the raw body before trusting any event, then reacts to `transfer.completed`,
   `payout.completed` (integrator reward claim settled) and `transfer.recoverable`
   (funds locked in on-chain accounts and needing a rescue).
5. **Batch payouts** (`src/cli/batch-payout.ts`) pay up to 20 wallets from a single
   route. Hops dominate the cost, so extra destinations are nearly free: this is how
   contributor payouts, royalties and marketplace splits get cheap.

## Verified on devnet

Runs are real, not illustrative. The numbers below come from live executions of this
code path against `https://devnet.multihopper.com/api/v1`.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` | 34 passed |
| `npm run demo` (0.1 SOL, 3 hops, policy approved) | transfer `1738` reached `completed`, decision `approved within per-transaction and daily limits` |
| Quote accuracy | that route delivered exactly `99502487` lamports (`0.099502487 SOL`) to the recipient, matching the quote to the lamport |
| Integrator share credited on chain | `248756` lamports per route, `995024` lamports total over four completed routes, `totalPayouts: 4` in `GET /usage` |
| Time to terminal status | about five minutes for a three-hop devnet route (`processing`, then `active`, then `completed`) |
| On-chain settlement | route-init and hop transactions finalized with no error (slots 524777364 to 524777648, fees 10400 / 10400 / 5400 lamports) |

Devnet and production are separate deployments, so these numbers come from devnet and
do not count toward the campaign's production volume.

## API quirks this code handles

The live API differs from its documentation in several places that break naive clients.
Each one is encoded as a regression test.

1. `amountTokens` is required by `POST /transfers` (`BAD_REQUEST: amountTokens: Required`)
   even though it reads as optional, so the client derives it from `amountRaw` and
   `tokenDecimals`.
2. Every mutation needs an `Idempotency-Key`, including `POST /transfers/{id}/prepare`
   (`MH_070` otherwise).
3. A mutation that declares `Content-Type: application/json` but sends no body is
   rejected by the API's Fastify layer (`FST_ERR_CTP_EMPTY_JSON_BODY`), which is exactly
   what `prepare` looks like.
4. `confirm-broadcast` requires `routeInitSignatures` even in the first call, so this
   client sends every signature once the bundles are on chain instead of splitting the
   confirmation in two.
5. Response envelopes are not uniform: `POST /transfers` and `GET /transfers/{id}`
   return the transfer at the top level while `prepare` and `confirm-broadcast` wrap it
   as `{ transfer }`, and `routeInitTxs` arrives as `{ base64 }` objects rather than
   plain strings. The client normalises all of it.
6. `orchestratorInitTx` arrives as a versioned (v0) message on live devnet although the
   docs describe a legacy transaction, so the signer detects the type instead of
   assuming it.

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

Devnet keys are minted on the devnet dashboard
(`devnet.multihopper.com/developer/dashboard`) and **do not work** against mainnet, and
vice versa. Start on devnet; devnet SOL is free.

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
| `src/multihopper/client.ts` | Typed REST client, idempotency, envelope normalisation, integrator maths |
| `src/multihopper/signer.ts` | Ordered signing and broadcast, keys stay local |
| `src/treasury/service.ts` | Intent to policy to route to ledger orchestration |
| `src/webhook/verify.ts` | HMAC verification, event catalogue |
| `src/agent/server.ts` | Agent HTTP API and webhook endpoint |
| `src/cli/*` | Runnable devnet demos |

## Security notes

- The treasury secret is read from `TREASURY_KEYPAIR_B58` and never logged; `.env` is
  gitignored, with `.env.example` as the only committed template.
- Webhook payloads are trusted only after the HMAC-SHA256 signature over the raw body
  verifies.
- Policy decisions are pure functions of request, config and ledger, so they are unit
  tested without touching the network (`test/policy.test.ts`).

## Evidence for the campaign

Every routed transfer is recorded in `ledger.jsonl` with agent id, USD notional,
timestamp and the MultiHopper `externalId`, and each transfer carries its on-chain
signature. That is the transaction export the campaign asks for, produced by the
product itself rather than assembled by hand.

## License

MIT, see `LICENSE`.
