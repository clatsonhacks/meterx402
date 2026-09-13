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

People start at a scroll-driven landing page with a live payment globe, then use the web app: a
marketplace whose hero replays a real settlement, Try it forms, a Playground and a seller dashboard.
Agents use the SDK, an MCP server with 12 tools, a REST connector with an OpenAPI spec, A2A, or the
included agent skill. Claude, ChatGPT and VS Code connect in a few guided steps, and each pays from
the user's own testnet account on their own machine, never from a shared wallet. Everything ships
as one npm package: `npx mx402`.

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
| Published package, end to end with brand-new wallets | `npx mx402` from an empty folder: new seller 0.0.10521862 received 13 payments (+0.0552 HBAR, mirror node) through publish, data, SDK, MCP and the connector; a new Base Sepolia address received 0.00048 USDC ([0x46e3c4b1…](https://sepolia.basescan.org/tx/0x46e3c4b1a96b9d65109798e46fb4b7e9026a13e029c65c5880a623f830d9587f)) |
| Analyst run: plan, pools, quote, answer for 0.017 HBAR | Hedera txs `0.0.7162784@1789247964.071079545`, `…975.321851525`, `…977.589209659`, `…982.127388281` |

## Demo video script

1. **Catchy intro.** "An AI agent asks for five words. It pays for five pages. Taxis don't charge
   you for the longest ride in town, so why do APIs? This is MeterX402, a meter for every API call."
   Landing page: the globe and the receipt card counting up.
2. **Deploy with npm.** `npx mx402 check` on Open-Meteo detects per-row pricing (24 rows, 48 rows,
   flat at the cap). `npx mx402 publish … --wallet` starts the gateway and lists it; `curl -i`
   shows `402 Payment Required` with `x-meter-amount`. `npx mx402 data cities.csv` sells a file
   per cell, with free schema and count.
3. **The web app and the technology.** Buy the weather just deployed: 24 rows for 0.0024 HBAR, the
   HashScan link, 48 rows for exactly double, a limit that asks first. Then under the hood: meter,
   hold, 402 committed to the body hash, x402 payment within budget, facilitator settlement checked
   independently on Hedera, Base and Solana, buyer-side re-metering and disputes, reputation from
   evidence. The Graph standardized DEX and lending subgraphs, any subgraph per entity, Uniswap quotes
   and the swap builder, and the DEX analyst with four receipts.
4. **Connect your AI.** "Use it from your AI": Claude Desktop with `npx mx402 mcp` quotes, asks,
   pays from the user's own account and shows the receipt in chat; ChatGPT and VS Code through
   `npx mx402 connector`. Close: "Pay per use, not per call. `npx mx402`."

## Links

- **Code:** <https://github.com/clatsonhacks/meterx402>
- **npm package:** [`mx402`](https://www.npmjs.com/package/mx402) (`npx mx402`), [package README](packages/mx402/README.md)
- **Agent skill:** [skills/meterx402-onchain-data/SKILL.md](skills/meterx402-onchain-data/SKILL.md)
- **Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md), [docs/architecture.png](docs/architecture.png)

## Team

- [clatsonhacks](https://github.com/clatsonhacks)
- [Anto-099-New-State](https://github.com/Anto-099-New-State)

## Pre-existing work

- **This repository's code.** It was written during the event: the first commit is 2026-09-11,
  and every commit is from 2026-09-11 to 2026-09-13.
- **GlassBox402** (<https://github.com/dhernz/Glassbox402>, open source, not ours). It was the
  reference for the one-command wrapper idea; MeterX402 replaces its flat price with metering.
- **Other open source.** The x402 packages, the facilitators, and The Graph and Uniswap APIs are
  used as published.
