# MeterX402: ETHOnline 2026 submission

## Project name

MeterX402

## Short description

Pay-per-use x402 for APIs and AI agents: priced per token, row or pool, on Hedera, Base and Solana

## Description

x402 lets an API charge per request, but a flat price per request is the wrong unit. A five-word
answer and a two-thousand-word answer cost the same, so sellers price for the worst case and light
users, especially AI agents making many small calls, overpay.

MeterX402 makes every call cost exactly what it returns. A gateway put in front of any API with
`npx mx402 <url>` runs the call and counts what the response consumed: tokens, rows, cells,
entities or bytes. It holds the body and answers `402` with the exact price of that response. The
buyer pays it inside a budget they set, and the body is released with a receipt. The buyer's SDK
then re-hashes and re-meters what arrived, and every settlement is checked on chain: the Hedera
mirror node, EVM receipt logs or Solana token balances.

Payments settle in HBAR or HTS tokens on Hedera, or in USDC on Base Sepolia and Solana devnet.
Hedera adds Metered Tabs (an on-chain allowance as the spending limit, with streaming), and
subscriptions as scheduled transactions. It also provides HCS receipts and HCS-14 agent identity.
A registry ranks services by a reputation score computed only from settlement evidence.

On top of that payment layer, MeterX402 sells live onchain data to agents:
- **DEX pools.** One standardized query across 15 Messari DEX subgraphs on The Graph, with
  Uniswap's own subgraphs as fallbacks.
- **Lending markets.** A second standard (Aave, Compound, Spark and more).
- **Any subgraph, billed per entity.** Buyers need no Graph API key, and a failed query costs
  nothing.
- **Uniswap Trading API quotes**, sold per call.

The **DEX analyst** ties it together: an agent that pays for each step of its own research. It buys
LLM tokens to plan, pools and lending rates from The Graph and a Uniswap quote, then answers only
with numbers it paid for. A grounding filter cuts any sentence that brings its own. It can also
build the swap for a real wallet: approval, Permit2 signature and calldata, never broadcast.

People use it through a web app: a marketplace whose hero replays a real settlement, Try it forms,
a Playground and a seller dashboard. Agents use the SDK, an MCP server with 12 tools, A2A, or the
included agent skill.

## How it's made

- **Language and runtime.** TypeScript on Node 22, run with tsx. The gateway is a Hono server; the
  hub is a plain Node HTTP and WebSocket server that also serves the web app. The web app is
  vanilla JS and CSS with no build step, light and dark themes, and a phone layout.
- **Payments.** x402 v2 through the official packages: `@x402/core`, `@x402/hedera`,
  `@x402/evm` (EIP-3009 `transferWithAuthorization`) and `@x402/svm` (SPL transfer, facilitator as
  fee payer). The gateway only talks to a `SettlementAdapter`, so all chains share one code path.
  Facilitators: blocky402 for Hedera testnet, x402.org for Base Sepolia and Solana devnet.
- **Meter-then-pay.** The piece x402 does not give you. The upstream call runs first, the response
  is metered and held with its `sha256` committed in the quote, and the `402` carries the exact
  integer atomic price, always rounded up. A buyer cap clamps the upstream request itself (for
  example `first:` in GraphQL, `max_tokens` for LLMs), so it limits the work, not only the bill.
- **Hedera** via `@hiero-ledger/sdk`:
  - HBAR allowances for tabs
  - HTS tokens with custom fractional fees
  - scheduled transactions (HIP-423) decoded from the mirror node for subscriptions
  - HCS for receipts and reputation anchors
  - HCS-14 UAIDs that match `@hashgraphonline/standards-sdk` byte for byte
- **The Graph**, through the gateway with a Subgraph Studio key held by a small data service:
  - Messari's DEX AMM and lending schemas, fanned out in parallel with per-source reports, caching
    and a circuit breaker that rests failing indexers
  - Uniswap's own v3 subgraphs, mapped into the same shape, as fallbacks
  - a `json:entities` meter for arbitrary GraphQL
- **Uniswap Trading API.** `/quote`, `/check_approval` and `/swap`, proxied as a metered lane.
  viem signs the Permit2 EIP-712 message for the swap builder.
- **The analyst.**
  - An LLM (gpt-oss-20b on Groq), itself bought through MeterX402's own metered `llm` lane, returns
    a JSON plan that is validated field by field against a rules planner.
  - Facts are computed in code.
  - The grounding filter parses every number in the model's prose, including k/M/B and
    million/billion, and keeps it only if it appears in the facts or rows it was given, within 2%.
- **Agents.** `@modelcontextprotocol/sdk` for the MCP server; an A2A adapter on every gateway;
  `SKILL.md` for agent frameworks.
- **Packaging.** esbuild bundles the CLI and SDK into the `mx402` npm package, with the EVM and
  Solana signers as optional dependencies loaded only when used.
- **Tests.** 219 with `node:test`: 164 unit and 55 end-to-end. The end-to-end suite signs real
  Hedera transactions against a mock facilitator that decodes and checks them. Live proof scripts
  settle on all three chains.

Notable hacks:
- holding the response so x402 can price what already exists
- a fallback layer that measures, in code, what a missing standard costs
- metering arbitrary GraphQL by counting objects so errors are free
- composing two standardized schemas (DEX and lending) into one comparison with no conversion step
- a grounding filter that makes an LLM's numbers auditable

## Partner prizes

### The Graph: Best AI Tooling or AI Use Case (and Composable or Standardized products)

| Requirement | Where |
|---|---|
| The Graph is load-bearing | Every DEX pool, lending market and subgraph answer comes from the Graph gateway: [src/graph/standard.ts](src/graph/standard.ts), [lending.ts](src/graph/lending.ts), [subgraphs.ts](src/graph/subgraphs.ts). |
| Live data from a Graph provider | Subgraph Studio API key, `gateway.thegraph.com/api/subgraphs/id/…`; live outputs in the README's "Live on testnets" section. |
| Meaningful work with the data | The DEX analyst plans, computes best pools, fee APR against lending rates and liquidity warnings, prices the trade on Uniswap, builds the swap, and grounds the LLM's answer: [src/graph/analyst.ts](src/graph/analyst.ts). |
| Reusable tooling | x402 payment tooling for Graph data (pay per pool, market or entity with no Graph key), 4 MCP tools, and [SKILL.md](skills/meterx402-onchain-data/SKILL.md), all in the `mx402` npm package. |
| Standardized schemas, composed | One Messari DEX AMM query across 15 subgraphs and one lending query across 15. The two are composed into a single yield comparison. The README shows what the standard removes, measured against the Uniswap fallback. |

### Uniswap: Best Uniswap Stack Contribution

| Requirement | Where |
|---|---|
| Integrates the Uniswap stack | Trading API `/quote`, `/check_approval` and `/swap` as a metered lane ([lanes.json#L210](lanes.json#L210)); the analyst's trade step ([src/graph/analyst.ts#L307](src/graph/analyst.ts#L307)); the swap builder ([src/graph/swap.ts#L76](src/graph/swap.ts#L76)); Uniswap v3 subgraphs on seven chains. |
| Public repo, open source | <https://github.com/clatsonhacks/meterx402> (MIT) |
| FEEDBACK.md | [FEEDBACK.md](FEEDBACK.md) |
| README points to the code | The README's "Uniswap" section |
| Feedback form | to submit at <https://developers.uniswap.org/hackathon-feedback>, with the link to FEEDBACK.md |

### Hedera

Hedera is the default settlement layer: HBAR and HTS payments, Metered Tabs on allowances,
scheduled-transaction subscriptions, HCS receipts and reputation anchors, HCS-14 identity, and
mirror-node verification of every payment.

## Proof

| What | Evidence |
|---|---|
| Hedera payments | [HCS receipt topic 0.0.10470327](https://hashscan.io/testnet/topic/0.0.10470327) |
| Solana devnet, 0.00048 USDC | [Solscan](https://solscan.io/tx/34yVZcY96SnxgjfUh9T28yvDB96Aq5xJw5xv2BVm32LMD9zRuGd78io21FeVDyUVtEeXHB93ntyMsfxbdi7t3omH?cluster=devnet) |
| Base Sepolia, 0.0005 USDC | [BaseScan](https://sepolia.basescan.org/tx/0x4a2081cb8c497c635aff5211d970a66c2899361733e39693c5e61d2b4593b649) |
| Analyst run: plan, pools, quote, answer for 0.017 HBAR | Hedera txs `0.0.7162784@1789247964.071079545`, `…975.321851525`, `…977.589209659`, `…982.127388281` |

## Demo video script (about 3 minutes)

1. **0:00–0:20, the problem.** A flat x402 price charges a 5-word and a 200-word answer the same.
   Show the Explore bento: 289 tokens for 0.00289 HBAR against a flat 0.04.
2. **0:20–0:50, the hero.** Explore replays a real settlement: units count up, the 402 quote, paid,
   settled, and a HashScan link. Point at the live stats and the receipts ticker, and the three
   chains.
3. **0:50–1:20, Try it: lending rates.** Open "Lending Rates Everywhere", pick USDC and "Earn on a
   deposit". The price is shown before paying. Pay, then show the table and the coverage chips
   (15/15 subgraphs). Open "Any Subgraph, Per Entity": run a preset for 9 entities, then a broken
   query for nothing.
4. **1:20–2:10, the DEX analyst.** In the Playground, ask "Where should USDC earn the most right
   now: lending it, or providing liquidity against ETH?" Walk through the four paid steps with
   receipts, the facts (fee APR against lending rate), and the grounded answer. Click "Build this
   swap for my wallet": approval, Permit2 signed, calldata, nothing sent.
5. **2:10–2:35, agents.** Claude Desktop with `npx mx402 mcp`: `find_lending_markets`, then
   `query_subgraph`, each paid with a receipt. Mention SKILL.md.
6. **2:35–2:55, multichain.** `npx tsx scripts/live-chains.ts` pays in USDC on Solana devnet and
   Base Sepolia. Open the Solscan and BaseScan links; the seller was credited on chain.
7. **2:55–3:10, sellers.** `npx mx402 check <url>` shows the detected meter and flat against
   metered. The Deployer dashboard is violet, with the price spread chart.

## Links

- **Code:** <https://github.com/clatsonhacks/meterx402>
- **npm package:** `mx402` ([package README](packages/mx402/README.md))
- **Agent skill:** [skills/meterx402-onchain-data/SKILL.md](skills/meterx402-onchain-data/SKILL.md)
- **Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md), [docs/architecture.png](docs/architecture.png)

## Team

- [clatsonhacks](https://github.com/clatsonhacks)
- [Anto-099-New-State](https://github.com/Anto-099-New-State)

## Pre-existing work

- **This repository's code.** It was written during the event: the first commit is 2026-09-11,
  and all 62 commits are from 2026-09-11 to 2026-09-13.
- **GlassBox402** (<https://github.com/dhernz/Glassbox402>, open source, not ours). It was the
  reference for the one-command wrapper idea; MeterX402 replaces its flat price with metering.
- **Other open source.** The x402 packages, the facilitators, and The Graph and Uniswap APIs are
  used as published.
