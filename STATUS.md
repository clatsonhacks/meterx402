# MeterX402 — project status

_Last updated 2026-09-12._ One page covering what is done, what is not, and what to watch out
for. The design is in [ARCHITECTURE.md](./ARCHITECTURE.md), and the reasoning behind the metering
model is in [APPROACH.md](./APPROACH.md).

**In one line:** a payment layer for APIs and AI agents. It does usage-based x402 payments on
Hedera, with a service registry, reputation, Metered Tabs, streaming, and SDK / A2A / MCP / CLI
interfaces. It works end to end on Hedera testnet against real third-party APIs, and **161
automated tests pass**.

---

## ✅ Completed

### Payment engine
| Feature | Status | Evidence |
|---|---|---|
| Meter-then-pay x402: run the call, meter it, hold the body, return a `402` with the exact price, settle | ✅ live on testnet | mirror-node-verified to the tinybar (APPROACH §8) |
| Meters: `tokens`, `tokens:output`, `rows`, `rows:<path>`, `bytes`, `ms`, `json:<path>`, `request` | ✅ | unit tests on real OpenAI/Anthropic/Ollama/Gemini/GraphQL/Etherscan shapes |
| Exact integer pricing (tinybar), always rounded up, min / free / caps | ✅ | unit tests |
| Buyer caps: `x-meter-max-units` clamps the upstream request; seller cap | ✅ | e2e |
| Body-hash commitment in every quote | ✅ | e2e (tampering, replay) |
| Abuse limits: hold TTL, unpaid quotes per client, requests per minute | ✅ | e2e |
| Metered Tabs on Hedera HBAR allowances, batch settlement, revoke → freeze | ✅ live on testnet | 3–4 calls settled in one approved transfer |
| Streaming (SSE, token by token) on tabs, with a live cap cut-off | ✅ live with Groq | 49 chunks, 192 tokens metered |
| HCS receipt per settled payment | ✅ live | topic `0.0.10470327` |
| World ID human vs bot pricing (simulated mode) | ✅ | e2e |

### Payment layer (architecture doc phases)
| Phase | Status | Where |
|---|---|---|
| 2 · Protocol objects: ServiceDescriptor, PaymentQuote, PaymentAuthorization, SettlementReceipt, ReputationRecord, Dispute | ✅ | `src/protocol/` |
| 7 · SettlementAdapter (quote / authorize / settle / verify) + route selection | ✅ Hedera tested; EVM/Solana declared | `src/settlement/` |
| 4 · Service registry: publish, lookup, filter, rank, liveness | ✅ | `src/registry/`, hub `/registry/*` |
| 5 · Reputation: deterministic, weighted, confidence levels, HCS-anchored | ✅ live | anchored snapshot tx on testnet |
| 3 · SDKs: buyer `MeterX402`, seller `wrap()`, agent `MeterX402Agent` | ✅ | `src/sdk/` |
| 6 · MCP adapter: list_services, get_service, get_quote, pay_for_service, call_service, get_reputation | ✅ | `src/mcp.ts` |
| 6 · A2A adapter: agent card + JSON-RPC, x402 payment in task metadata | ✅ live | an agent paid the Groq agent over A2A |
| 8 · Ranking by reputation, price and latency | ✅ (simple form) | `rank()` |
| 9 · Buyer-side re-metering + automatic disputes | ✅ (minimal) | e2e with a dishonest seller |

### Hedera-native extras
| Feature | What it does | Status |
|---|---|---|
| **HCS-14 Universal Agent ID** | Every service carries a `uaid:aid:…` derived from six canonical fields (registry, name, version, protocol, Hedera account as CAIP-10, HCS-11 skills). Endpoints and prices are excluded, so identity survives a move or a price change. Rides on the descriptor, the A2A card and `x-mx402`. | ✅ live |
| **The registry as a resolver** | `GET /registry/agents/:uaid` re-derives the hash from the descriptor and reports whether the claimed identity is genuine; `?uaid=` filters discovery. Nobody has to be trusted: for `uaid:aid` the id *is* the hash. | ✅ live |
| **HTS settlement** | `--asset <token-id>` sells an API in an HTS token instead of HBAR. Same exact scheme, same facilitator; decimals, symbol and fee schedule are read from the token itself. | ✅ live (MXC `0.0.10501361`) |
| **A protocol fee consensus collects** | The cut lives in the token's custom fee schedule, so the ledger routes it on every transfer. No fee-collection code, no contract, no way for a seller to route around it. Inclusive, so the buyer signs exactly the quote and the seller nets the rest — disclosed up front in `SettlementOption.fee`. | ✅ live (2% → `0.0.10452591`) |
| **Subscriptions** | The buyer pre-signs one scheduled transfer per period (HIP-423, `wait_for_expiry`), so the seller can count committed revenue before it lands. The gateway decodes each schedule off the mirror node and refuses anything that is not the buyer's own money. The buyer keeps the admin key and can cancel unexecuted periods. | ✅ live |
| **Quote rounds** | `POST /rfq`: state a capability, a size and a ceiling; every live seller answers at once, ranked by price 0.45 / reputation 0.4 / latency 0.15 as ratios to the best. Losers and their reasons are part of the record and of the reputation evidence. | ✅ live |

### Tooling
| Item | Status |
|---|---|
| `mx402 publish` (detect type, auth and meter → confirm → register → serve) | ✅ live (CoinGecko published) |
| `mx402 check` (dry run, price variants vs flat) | ✅ |
| `mx402 inspect`, `mx402 wallet new` | ✅ |
| Meter auto-detection, including nested lists (`rows:hourly.time`) | ✅ |
| npm package `mx402`: bundled SDK + CLI, zero dependencies, ~4s install | ✅ built, **not published** |
| Dashboard: income, price spread, lanes, test buyer, streaming demo, registry + reputation, payments, analytics | ✅ (now the Deployer view) |
| Offline demo (mock upstream + signature-checking mock facilitator) | ✅ `npm run demo:offline` |
| Live demo against real APIs (Groq, Open-Meteo, Etherscan, CoinGecko) | ✅ `npm run demo` |

### Web UI (hub at `http://127.0.0.1:4021`)
| Area | What it does | Status |
|---|---|---|
| **User / Deployer switch** | Two modes, like ChatGPT's Chat / Work. Remembered per browser; deep links `#user`, `#user/playground`, `#deployer` | ✅ |
| **User → Marketplace** | Service cards: description, live dot, price per unit, typical call, reputation score, interfaces (REST · A2A · MCP · SDK · STREAMING · TABS). Search, capability chips, sort (best / cheapest / reputation / fastest), "rated only" | ✅ |
| **For AI agents** | A collapsible panel with the machine paths to the same data: registry `curl`, MCP config (`npx -y mx402 mcp`), SDK `discover()`, A2A agent card | ✅ |
| **Service drawer** | *Overview* (descriptor, reputation breakdown by component, recent receipts), *Try it* (the full lifecycle, step by step: discover → quote → budget check → pay / don't pay with a hold countdown → verify → receipt; streaming on tab lanes), *Integrate* | ✅ live-settled on testnet |
| **User → Playground** | Pick a service and an integration: Buyer SDK, Agent SDK, MCP connector (Claude Code / `.mcp.json` / Claude Desktop / prompt), A2A, raw HTTP + x402, CLI. Code is generated from the live descriptor, and **Run** performs the same call with real settlement | ✅ |
| **Deployer → Publish an API** | URL + sample + auth → *Check* (free dry run: type, meter, suggested rate, price variants vs flat) → *Publish* (starts a payment endpoint in the hub, registers it). Shows the equivalent `npx mx402 publish` command | ✅ live (CoinGecko) |
| **Deployer → dashboard** | The existing income / charges / lanes / registry / payments / analytics views, with per-lane stream and test buyer | ✅ |

UI endpoints on the hub (loopback only): `POST /deploy/check`, `POST /deploy/publish`,
`GET /deploy/published`, `DELETE /deploy/published/:id`, `POST /playground/quote`,
`POST /playground/pay`, `POST /playground/a2a`. The playground signs with the hub's buyer account
from `.env` (or a mock account offline). It is a demo wallet, not the visitor's.

### Tests
| Suite | Count |
|---|---|
| Unit: pricing, meters, holds, tabs, detection, protocol, registry, reputation | 62 |
| Unit: HCS-14 identity (incl. byte-for-byte against the Standards SDK) | 11 |
| Unit: HTS settlement and the ledger fee | 9 |
| Unit: subscriptions and schedule verification | 13 |
| Unit: quote rounds | 11 |
| End-to-end: engine, tabs + streaming, full lifecycle (SDK, A2A, MCP, disputes, publish CLI) | 55 |
| Live (manual): `npm run test:live`, `scripts/live-agent.ts` | pass on testnet |

---

### Base, Solana, The Graph and Uniswap (2026-09-13)
- **Base Sepolia and Solana devnet settlement.**
  - Chain presets, per-chain buyer signing (viem, `@solana/kit`), and chain-side verification (EVM receipt logs, Solana balance deltas).
  - Lanes `dex-pools-base` and `weather-solana`, and a wallet generator (`scripts/new-chain-wallets.ts`).
  - Verified live: both gateways issue correct 402s, and the x402.org facilitator checks the signatures (refusal reasons: EVM `transfer amount exceeds balance`, Solana simulation of an unfunded token account).
  - Real settlement waits on testnet USDC in the buyer wallets.
- **The Graph.**
  - `dex-pools` lane over 15 Messari standardized DEX subgraphs with one query.
  - Per-source reports and a circuit breaker; `src/graph/server.ts` is started by `serve.ts` when `GRAPH_API_KEY` is set.
  - Live: 8 to 9 of 15 sources answer; Base, Optimism and BSC Uniswap v3 time out or have bad indexers.
- **Uniswap.**
  - `uniswap-quote` lane over the Trading API, verified live on Base and Ethereum.
  - The analyst's quote step understands CLASSIC and UniswapX routing. `FEEDBACK.md` is written.
- **DEX analyst.**
  - `mx402 analyst`, MCP `find_dex_pools` / `ask_dex_analyst`, a Playground panel, and `POST /playground/analyst`.
  - Live runs paid 4 Hedera transactions each (0.016 and 0.017 HBAR).
- **UI.** Prices, the pay sheet and receipts show the service's own currency and chain; USDC services skip the HBAR limits and ask first.

## ⏳ Pending

- Fund the Base Sepolia and Solana devnet buyer wallets with testnet USDC, then run `scripts/live-chains.ts` for real settlements.
- Submit the Uniswap developer feedback form with the link to FEEDBACK.md.

In rough priority order.

| # | Item | Why it matters | Notes |
|---|---|---|---|
| 1 | Publish the npm package | `npx mx402` for everyone; the UI's MCP and CLI snippets assume it | needs `npm login`; the LICENSE and repo URL are in place |
| 2 | Visitor wallets in the UI | today the playground pays from the hub's demo buyer | HashPack / WalletConnect signing in the browser |
| 3 | Hosted deployment (a public hub + gateways) | today everything is `localhost` | Dockerfile / Railway template, `--public-url` |
| 4 | Tabs and subscriptions in an HTS token | today both settle HBAR only | token allowances, and a token transfer inside a schedule |
| 5 | Live test of the EVM / Solana adapters | multi-chain is declared, not proven | needs `@x402/evm` / `@x402/svm` and funded wallets |
| 6 | Owner-signed registry publishing | today: loopback or a shared token | sign descriptors with the payout account's key |
| 7 | Federated / replicated registry | a single hub is a single point of failure | e.g. registry entries mirrored to an HCS topic |
| 8 | Stronger token re-metering | token counts are self-reported by the upstream | tokenizer-based estimate + tolerance, or provider attestations |
| 9 | Streaming on non-SSE bodies and more meters | only `tokens` / `bytes` stream today | rows streaming for NDJSON |
| 10 | Python SDK | many agents are Python | the protocol is plain HTTP + JSON; a thin client is small |
| 11 | Persistent analytics / receipts store | today it is memory + a JSONL tape | SQLite would do |
| 12 | Price-change history on descriptors | agents may want to know a price is stable | versioned descriptors |

---

## ⚠️ Limitations

### By design
- **Pay-per-call cannot stream.** The price exists only once the response is complete, and the
  body is what is held until payment. Streaming lives on tabs.
- **The seller does the work before being paid** (meter-then-pay). This is bounded by caps, hold
  TTLs, per-client unpaid-quote limits and rate limits, but not eliminated.
- **A tab's exposure is one unsettled batch.** If a buyer revokes mid-batch, the seller can lose
  up to `--tab-flush` (default 0.01 HBAR).

### Technical
- **Testnet only.** Nothing has run on mainnet.
- **HBAR or one HTS token.** Pay-per-call settles in either; **tabs and subscriptions are HBAR
  only** (allowances and the scheduled transfers we build are native-HBAR transfers). A buyer must
  opt into a token explicitly (`assets: […]`) before the SDK will sign it.
- **An HTS payout account must be associated with the token** before it can be paid, which is a
  one-off the seller does themselves; x402's preflight reports `pay_to_not_associated` otherwise.
- **Subscriptions reach ~62 days ahead** (HIP-423 caps how far a schedule may sit), so longer
  commitments mean re-scheduling. A cancelled period is gone from the ledger, not refunded —
  nothing was ever deposited.
- **A quote round's estimates are estimates.** They come from the published rate card, because
  asking every seller for a real quote would make them all do the work; only `binding: true`
  produces exact prices, and only for the shortlist.
- **Tokens are self-reported.** Re-metering proves a token count matches the body's own `usage`
  block, not the model's true work. Rows and bytes are verified exactly.
- **The registry is a single process** with a JSON file. Reputation evidence is off-chain, and
  only its snapshots are anchored on HCS.
- **Registry publishing** is open on loopback or with `MX_REGISTRY_TOKEN`. It is not signed by the
  service owner.
- **Reputation needs volume.** Below 5 samples a service is unrated, and the weights are the
  architecture doc's starting model.
- **Liveness is probed from the hub**, so uptime means "reachable from the hub".
- **The A2A adapter** follows the shape of the a2a-x402 extension (payment in task metadata) but
  is not certified against another implementation. It supports `message/send` and `tasks/get`, not
  streaming or push notifications.
- **Upstream 4xx errors are passed through free** and do not count against reputation, which a
  seller could in theory abuse to hide failures.
- **Services published from the dashboard run inside the hub process.** They stop when the hub
  stops and show as down in the marketplace until republished. Use `mx402 publish` for a
  long-lived gateway.
- **The UI is a local tool.** Its deploy and playground endpoints only answer on loopback, and it
  has no accounts. Anyone at the machine can publish and spend the demo buyer's testnet HBAR.
- **Windows / Git Bash** rewrites `--sample /path` into a Windows path. The CLI detects and undoes
  this, but `MSYS_NO_PATHCONV=1` avoids it.

### Security notes
- The resource server holds **no settlement key** for exact payments. Tabs need a spender key,
  bounded by each buyer's allowance.
- Upstream API keys stay on the gateway and are never forwarded to buyers (e2e-tested).
- `WORLD_TOKEN_SECRET` and `MX_TAB_SECRET` fall back to dev values if unset. Set them in any
  shared deployment.
- `.env` holds testnet keys and is git-ignored. Never commit it.

---

## 🐞 Known issues
- A tab's `close()` can return `lastTx: null` when the 15s timer already settled everything; the
  `paid` total is still correct. The fix is to return the last flush's transaction.
- The dashboard's "Units sold" shows "mixed" across units by design, and only sums per API.
- After a hub restart, gateways that were already running re-register on their next heartbeat
  (up to 15s). Until then the registry shows their last-saved descriptor.
- Quote-round evidence (`quote_rounds`, `quotes_offered`, `quote_rounds_won`) is reported in the
  reputation record but deliberately not folded into the weighted score, so existing scores keep
  their meaning.
- The offline demo reuses the `BUYER_*` account id from `.env` on the mock ledger, which can
  look confusing next to live data.

---

## Running it

```bash
npm install
npm run demo:offline          # zero config, nothing leaves the machine
npm run demo                  # live: open http://127.0.0.1:4021 (User / Deployer)
                              # needs .env (WALLET, BUYER_*, HEDERA_* for tabs/HCS, API keys)
npm test                      # 117 tests
npm run test:live             # live settlement + mirror-node checks
npx tsx scripts/live-agent.ts # the whole lifecycle as an agent, live
npx tsx scripts/new-token.ts        # once: the MXC credit token + its accounts
npx tsx scripts/live-hts.ts         # settle in credits, with the ledger taking its cut
npx tsx scripts/live-subscription.ts # pre-signed periods, executed by consensus
npx tsx scripts/live-rfq.ts         # a competitive quote round
```

Required `.env` for live mode: `WALLET`, `BUYER_ACCOUNT_ID`, `BUYER_PRIVATE_KEY`; optionally
`HEDERA_ACCOUNT_ID` / `HEDERA_PRIVATE_KEY` (tabs, HCS, account creation), `HEDERA_TOPIC_ID`,
`GROQ_API_KEY`, `ETHERSCAN_API_KEY`. See `.env.example`.
