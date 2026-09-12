# MeterX402 — a payment layer for APIs and AI agents

> **Discover → Quote → Budget → Execute → Meter → Settle → Receipt → Reputation**

MeterX402 started as a metered x402 wrapper for APIs (see [APPROACH.md](./APPROACH.md)). This
document describes how it grew into a **programmable payment layer**: a small set of protocol
objects, a settlement abstraction, a service registry with reputation, SDKs for buyers, sellers
and agents, and adapters for REST, GraphQL, A2A and MCP. All of it runs on the payment engine
already proven on Hedera testnet; nothing was rewritten.

Everything below is **built and tested**. §9 lists the live Hedera evidence, and §11 says
plainly what was left out.

---

## 1. The shape of it

```
 Agent / App ──────────┬───────────────┬──────────────┬─────────────┐
                       │ SDK           │ A2A          │ MCP         │ REST / GraphQL
                       ▼               ▼              ▼             ▼
                ┌──────────────────────────────────────────────────────────┐
                │  MeterX402 SDK   src/sdk/  (buyer · seller · agent)      │
                └──────────────────────────────────────────────────────────┘
                       │ ServiceDescriptor · PaymentQuote · PaymentAuthorization
                       │ SettlementReceipt · ReputationRecord · Dispute   (src/protocol/)
                ┌──────┴──────────┬──────────────────┬────────────────────┐
                │ Discovery       │ Pricing/Metering │ Payment/Receipts   │
                │ registry        │ meters, pricing, │ gateway: holds,    │
                │ (hub)           │ detect, budgets  │ quotes, receipts   │
                ├─────────────────┴──────────────────┴────────────────────┤
                │ Reputation engine (hub) — fed by every payment event    │
                └──────────────────────────────┬──────────────────────────┘
                                               ▼
                           Settlement adapters (src/settlement/)
                     X402ExactAdapter (Hedera ✓ · Base · Solana)   TabLedger (Hedera allowances)
                                               ▼
                    blocky402 → Hedera testnet  ·  HCS receipts  ·  mirror-node verification
```

API wrapping is one entry point into this layer, not the product.

## 2. Where each part of the spec lives

The spec suggested a multi-package monorepo. The layers are implemented one-to-one, as
directories in a single package, because splitting the proven engine into packages would have
changed nothing functionally and put 117 passing tests at risk. The published `mx402` package
bundles the SDK and the CLI from the same sources.

| Spec layer | Implemented in |
|---|---|
| `core/` pricing, metering, quotes, budgets, receipts | `src/pricing.ts`, `src/meters.ts`, `src/detect.ts`, `src/holds.ts`, `src/gateway.ts` |
| `protocol/` schemas | `src/protocol/schemas.ts` (zod), `src/protocol/describe.ts` |
| `sdk/` buyer · seller · agent | `src/sdk/buyer.ts`, `src/sdk/seller.ts`, `src/sdk/agent.ts`, `src/sdk/index.ts` |
| `settlement/` hedera · evm · solana | `src/settlement/adapter.ts`, `src/settlement/x402-exact.ts`, `src/tabs.ts` (TabLedger), `src/chains.ts` |
| `adapters/` mcp · a2a · rest · graphql | `src/mcp.ts`, `src/adapters/a2a.ts`, the gateway itself (REST + GraphQL) |
| `registry/` discovery · indexing · reputation | `src/registry/registry.ts`, `src/registry/reputation.ts`, routes in `src/hub.ts` |
| `cli/` publish · check · inspect | `src/cli.ts` |
| gateway · hub · dashboard | `src/gateway.ts` · `src/hub.ts` · `public/index.html` |

## 3. Protocol objects (`src/protocol/schemas.ts`, version `"1"`)

Every interface speaks the same five objects, validated with zod wherever data crosses a trust
boundary (registry publishes, gateway descriptors, A2A metadata, receipts):

| Object | What it carries | Where it appears |
|---|---|---|
| **ServiceDescriptor** | id, name, type (rest/graphql/llm), endpoint, sample call, capabilities, pricing (meter, unit, rate, per, min, free, cap, currency), payment (settlement options × schemes, streaming), interfaces, upstream auth type (held by the seller), owner, links | `GET /.well-known/mx402` on every gateway; the registry; lane_up events |
| **PaymentQuote** | quote id, service, meter, billable/measured units, cap, rate, **exact amount** (decimal + atomic), network, asset, pay-to, **body sha256**, expiry | the `402` body and the `x-mx402-quote` header; A2A `mx402.quote` |
| **PaymentAuthorization** | exact or tab; buyer; the constraints they approved (max per call, max units, budget, allowance, expiry); quote or tab id | returned by the SDK with each paid call |
| **SettlementReceipt** | scheme, quote/tab id, service, buyer, seller, metered units, rate, amount, network, transaction id (null for a tab call until its batch settles), body hash | the `x-mx402-receipt` header; `settled` / `tab_flush` events; `GET /registry/receipts`; A2A `mx402.receipt` |
| **ReputationRecord** | score 0–100 or null, confidence, sample size, six components, the weights, raw stats, HCS anchor | `GET /registry/services/:id/reputation`; every registry listing |
| **Dispute** (Phase 9) | quote/receipt, buyer, reason, claimed vs observed units and body hashes | `POST /registry/services/:id/disputes`; anchored on HCS |

## 4. The lifecycle, and what enforces each step

| Step | Mechanism | Enforced by |
|---|---|---|
| **Publish** | `mx402 publish <url>` or `wrap()`: detect type, auth and meter; confirm pricing; start the gateway; it registers itself | CLI / seller SDK; registry validates the descriptor |
| **Discover** | `GET /registry/services?capability=&maxPrice=&minReputation=…`; ranked | registry; SDK filters to **settlement routes the wallet can actually pay** (`selectRoute`) |
| **Quote** | the gateway runs the call, meters it, **holds** the response, answers `402` with a PaymentQuote | gateway (`holds.ts`: TTL, per-client caps, one settlement per quote) |
| **Budget** | max price, max per call, max units, session budget, all checked **before signing** | buyer SDK + the official x402 client's spend controls; for tabs, **Hedera's allowance** |
| **Authorize** | signed x402 payload matched to the quote and verified by the facilitator | `SettlementAdapter.authorize` |
| **Execute / Meter** | already done at quote time (meter-then-pay), or live while streaming on a tab | gateway + meters |
| **Settle** | exact: facilitator settles the signed transfer. Tab: one approved transfer per batch | `SettlementAdapter.settle` / `TabLedger.pull` |
| **Receipt** | SettlementReceipt to the buyer; HCS receipt per payment; mirror-node verification available | gateway, hub, `SettlementAdapter.verify` |
| **Verify** | buyer re-hashes the body and **re-meters** it with the quoted meter spec | buyer SDK (`verify()`); mismatch → automatic dispute |
| **Reputation** | every event updates a deterministic score; snapshots anchored on HCS | hub reputation engine |

## 5. Settlement abstraction (`src/settlement/`)

```ts
interface SettlementAdapter {
  capabilities(): Capability[];            // network, asset, currency, decimals, schemes[exact|tab]
  quote(req): Promise<AdapterQuote>;       // exact amount → x402 payment requirements
  authorize(payload, reqs): Promise<Authorization>;
  settle(payload, reqs): Promise<Settlement>;
  verify(tx, payTo): Promise<Verification>; // independent check (Hedera: mirror node)
}
```

- **`X402ExactAdapter`** is the only way the gateway moves money now (the gateway has no direct
  `@x402` calls left). x402 is chain-agnostic, so the same class serves the Hedera preset
  (tested, blocky402) and the Base / Base-Sepolia / Solana presets (declared, untested).
- **`TabLedger`** (`src/tabs.ts`) is the tab settlement interface: `publicKeyOf` (ownership),
  `allowance` (authorization), `pull` (settlement). `hederaTabLedger` uses native HBAR
  allowances; `mockTabLedger` is the offline ledger.
- **`selectRoute(serviceAccepts, walletSupports, prefer)`** intersects a descriptor's settlement
  options with a wallet's networks and currencies. The SDK and agents never pick a chain
  themselves, and a wallet that can't pay a service never sees it in discovery.

**Hedera's role**: Hedera is the strongest implemented backend, not the protocol. It provides
value settlement (HBAR via blocky402), bounded authorization (allowances → Metered Tabs),
auditability (HCS receipts, dispute records and reputation snapshots) and independent
verification (mirror node).

## 6. Registry and reputation

**Registry** (`src/registry/registry.ts`, served by the hub, persisted to `registry.json`):
gateways register on start and re-announce every 15s. `mx402 publish` / `POST /registry/services`
registers explicitly (open on loopback, or with `MX_REGISTRY_TOKEN`). The hub probes every
service's descriptor URL every 10s; a dead service drops out of discovery. Filters: capability,
free text, unit, interface, network, currency, `maxPrice` (against the median charge actually
paid, else the worst case at the cap), `minReputation`.

**Ranking** (Phase 8, simplest honest form): `0.6 × reputation + 0.25 × price + 0.15 × latency`.
Reputation dominates, so a 10× cheaper but badly rated service does not beat a well-rated one.

**Reputation** (`src/registry/reputation.ts`) is a pure function of recorded events, using the
spec's starting weights:

| Component | Weight | Evidence | 1.0 means |
|---|---|---|---|
| execution | 30% | paid calls ÷ (paid + seller-caused failures) | every paid call delivered |
| response_success | 20% | upstream 2xx ÷ upstream calls | the API never failed |
| latency | 15% | median upstream ms | ≤ 300 ms (0 at ≥ 3 s) |
| disputes | 15% | 1 − 10 × disputes ÷ paid calls | no disputes (0 at ≥ 10%) |
| uptime | 10% | liveness probes answered | always reachable |
| payment_reliability | 10% | settlements succeeded ÷ attempted | every valid payment settled |

A buyer's own mistakes (empty wallet, bad signature, 4xx requests) never count against a seller.
Below 5 samples a service is **unrated** (`score: null`) and cannot pass a `minReputation` filter.
The weights travel inside every record, so anyone can recompute a score.
`POST /registry/reputation/anchor` writes a digest of every score to HCS.

**Disputes (Phase 9, minimal)**: after paying, the buyer SDK re-hashes the body and re-meters it
with the quote's meter spec. On a mismatch it files a Dispute automatically. The hub accepts it
only from the buyer who actually paid for that quote, once per quote, anchors it on HCS, and it
costs the seller reputation. Honest limit: token counts come from the upstream's own `usage`
block, so re-metering proves consistency with the body, not the model's true work. Rows and
bytes are re-metered exactly.

## 7. SDKs (`src/sdk/`, published as `mx402`)

```ts
import { MeterX402, MeterX402Agent, wrap } from "mx402";

// seller: payment + metering around an API you already run
const svc = await wrap({ upstream: "https://api.example.com", wallet: "0.0.1234",
                         capabilities: ["weather_forecast"], registry: HUB });   // meter auto-detected

// buyer: the lifecycle as explicit steps
const mx = new MeterX402({ wallet, budget: "1 HBAR", registry: HUB });
const q = await mx.quote("weather-api", { query: { forecast_days: "2" } });      // metered, not paid
const r = await q.pay();          // r.receipt, r.authorization, r.verification

// agent: capability in, result out, one budget across every path
const agent = new MeterX402Agent({ wallet, budget: "5 HBAR", registry: HUB, useTabs: { allowance: "0.05" } });
await agent.discover({ capability: "weather_forecast", minReputation: 90, maxPrice: 0.05 });
await agent.call("weather_forecast");                         // picks the best compatible service
await agent.a2a("http://translator.example", "…");            // pays another agent over A2A
await agent.close();                                          // settles open tabs
```

## 8. Interfaces

- **REST / GraphQL**: the gateway (meter-then-pay x402, tabs, streaming on tabs).
- **A2A** (`src/adapters/a2a.ts`): every service serves an agent card at
  `/.well-known/agent.json` (skills = capabilities, pricing in `x-mx402`, the a2a-x402 extension
  declared) and JSON-RPC `message/send` / `tasks/get` at `/a2a`. Payment follows the a2a-x402
  extension's shape: `input-required` + `x402.payment.required` → `x402.payment.payload` →
  `completed` + `x402.payment.receipts` / `mx402.receipt`. The adapter holds no payment logic; it
  calls the gateway's own REST path over loopback, tagged as A2A, with a per-process secret so
  per-client limits still apply to the real remote agent.
- **MCP** (`src/mcp.ts`): `list_services`, `get_service`, `get_reputation`, `get_quote`,
  `pay_for_service`, `call_service` (plus the old `list_paid_apis` / `paid_fetch` aliases), each
  a thin call into the buyer SDK.
- **CLI**: `mx402 publish`, `mx402 check`, `mx402 inspect`, `mx402 wallet new`, `mx402 <url>`.

## 9. Evidence

**117 automated tests** (`npm test`): 62 unit + 55 end-to-end. The new
`test/lifecycle.test.ts` runs the whole lifecycle through every interface against real
gateways, with real ECDSA-signed Hedera transfers checked by a signature-verifying mock ledger:
registration and valid descriptors, meter auto-detection, capability discovery and ranking,
route rejection for incompatible wallets, quote → pay → receipt → re-metering, budget refusals
before signing, receipts by service/buyer, agent capability calls, tabs settling in one batch,
A2A cards and paid A2A tasks, A2A budget refusal, automatic dispute from a dishonest seller,
dispute authorization (payer-only, once), reputation ranking an honest seller above a disputed
one, HCS snapshot digests, MCP discover → quote → pay → reputation, and `mx402 publish`
end to end.

**Live on Hedera testnet** (`scripts/live-agent.ts`, 2026-09-11):

| Step | Result |
|---|---|
| Publish | `mx402 publish https://api.coingecko.com/api/v3/coins/markets …` → detected `rows`, 0.002 HBAR/row, capability `market_data`, registered |
| Discover | 4 live services by capability (3 self-registered lanes + the published one) |
| Quote → pay | 5 coins → quote 0.01 HBAR → paid → body hash ✓, re-metered 5 ✓ → mirror node: SUCCESS, 1,000,000 tinybar ✓ ([tx](https://hashscan.io/testnet/transaction/0.0.7162784-1789148274-741383676)) |
| Agent by capability | `weather_forecast`: 24 rows → 0.0024 HBAR, 72 rows → 0.0072 HBAR, re-metered ✓ ([tx](https://hashscan.io/testnet/transaction/0.0.7162784-1789148291-683196326)) |
| A2A | agent → Groq `gpt-oss-20b` agent: task completed, 207 tokens = 0.00207 HBAR ([tx](https://hashscan.io/testnet/transaction/0.0.7162784-1789148295-307408743)) |
| Metered Tab | 4 calls on one allowance, settled in one approved transfer on close (0.0144 HBAR) |
| Budget | a 0.0232 HBAR quote refused against a 0.0005 budget, before signing |
| Reputation | weather 99.6, llm 96.4; snapshot anchored on HCS ([tx](https://hashscan.io/testnet/transaction/0.0.10452591-1789148315-773898696)) |

## 10. Security boundaries

| Boundary | How it's held |
|---|---|
| Seller keys | the gateway holds no settlement key for exact payments; upstream API keys stay server-side (e2e-tested); tabs need only a spender key, bounded by each buyer's allowance |
| Buyer budget | max per call (the x402 client refuses to sign), max units (the upstream request is clamped), session budget, tab allowance (Hedera), quote expiry |
| Response integrity | the quote commits to `sha256(body)`; the buyer re-hashes and re-meters |
| Replay | one settlement per quote (hold lock); Hedera rejects replayed transaction ids; one dispute per quote |
| Expiry | holds and quotes default to 120s; tab tokens are HMAC-signed and expire |
| Registry writes | loopback or `MX_REGISTRY_TOKEN`; descriptors validated; disputes only from the paying buyer |
| Observability ≠ truth | the dashboard and registry are observability; settlement truth is the facilitator, the mirror node and HCS |

## 11. Deliberately not built (per the spec's "not first" list), and known gaps

- no token, no governance, no on-chain reputation contracts, no marketplace UI, no custom
  per-chain payment protocols, no new x402 implementation
- **multi-chain**: Base/Solana presets exist behind the adapter but were not tested live; USDC
  pricing on Hedera (HTS) is not implemented, so budgets are in HBAR
- **cross-chain routing** is route *selection* only (no liquidity movement)
- **registry** is a single hub (JSON file), not federated; publish auth is a shared token, not
  owner signatures
- **reputation** is off-chain, with evidence anchored on HCS; weights are the spec's starting
  model
- **streaming** is available only on tabs, by design (§10 of APPROACH.md)
- the npm package is **not published yet** (planned once the project is final)

## 12. Multichain settlement and onchain data

![architecture](docs/architecture.png)

**Chains.** A `ChainPreset` (`src/chains.ts`) is a facilitator, a scheme and a network id; the gateway
builds one `X402ExactAdapter` from it and never touches a chain directly.

| Preset | Asset | Facilitator |
|---|---|---|
| `hedera` | HBAR or an HTS token | blocky402 |
| `base-sepolia` | USDC via EIP-3009 | x402.org |
| `solana-devnet` | USDC via SPL transfer | x402.org |

The buyer SDK picks its signer from the wallet's CAIP-2 network and loads viem or `@solana/kit`
only when needed. `SettlementAdapter.verify()` checks a settlement where it happened:

| Chain | Checked against |
|---|---|
| Hedera | the mirror node |
| EVM | USDC `Transfer` logs from an RPC |
| Solana | token balance deltas from an RPC |

**The Graph data service** (`src/graph/server.ts`) is an ordinary upstream behind three lanes.

| Lane | Meter | Source |
|---|---|---|
| `dex-pools` | `rows:pools` | Messari DEX AMM, 15 subgraphs; Uniswap v3 fallbacks |
| `lending-markets` | `rows:markets` | Messari lending, 15 subgraphs |
| `subgraph-gateway` | `json:entities` | any subgraph or deployment |

`fanOut()` (`src/graph/standard.ts`) asks every source in parallel, with a cache and a circuit
breaker per subgraph. A failing source with a fallback asks that instead, and every source returns
a report: `ok`, `schema`, `via`, `rows`, `ms`, errors.

**The DEX analyst** (`src/graph/analyst.ts`) is a buyer, not a service. It spends through the SDK
like any agent:

1. plan (`llm`)
2. pools (`dex-pools`) and lending (`lending-markets`)
3. quote (`uniswap-quote`)
4. answer (`llm`)

Facts are computed in code, the LLM's JSON plan is validated against a rules plan, and
`groundProse()` removes any sentence whose numbers are not in the paid data.
`prepareSwap()` (`src/graph/swap.ts`) turns a quote into unsigned transactions for a wallet
(approval, Permit2 signature, `/swap` calldata) and never broadcasts.
