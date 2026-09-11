# MeterX402 — project status

_Last updated 2026-09-11._ One page covering what is done, what is not, and what to watch out
for. The design is in [ARCHITECTURE.md](./ARCHITECTURE.md), and the reasoning behind the metering
model is in [APPROACH.md](./APPROACH.md).

**In one line:** a payment layer for APIs and AI agents. It does usage-based x402 payments on
Hedera, with a service registry, reputation, Metered Tabs, streaming, and SDK / A2A / MCP / CLI
interfaces. It works end to end on Hedera testnet against real third-party APIs, and **117
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

### Tooling
| Item | Status |
|---|---|
| `mx402 publish` (detect type, auth and meter → confirm → register → serve) | ✅ live (CoinGecko published) |
| `mx402 check` (dry run, price variants vs flat) | ✅ |
| `mx402 inspect`, `mx402 wallet new` | ✅ |
| Meter auto-detection, including nested lists (`rows:hourly.time`) | ✅ |
| npm package `mx402`: bundled SDK + CLI, zero dependencies, ~4s install | ✅ built, **not published** |
| Dashboard: income, price spread, lanes, test buyer, streaming demo, registry + reputation, payments, analytics | ✅ |
| Offline demo (mock upstream + signature-checking mock facilitator) | ✅ `npm run demo:offline` |
| Live demo against real APIs (Groq, Open-Meteo, Etherscan, CoinGecko) | ✅ `npm run demo` |

### Tests
| Suite | Count |
|---|---|
| Unit: pricing, meters, holds, tabs, detection, protocol, registry, reputation | 62 |
| End-to-end: engine, tabs + streaming, full lifecycle (SDK, A2A, MCP, disputes, publish CLI) | 55 |
| Live (manual): `npm run test:live`, `scripts/live-agent.ts` | pass on testnet |

---

## ⏳ Pending

In rough priority order.

| # | Item | Why it matters | Notes |
|---|---|---|---|
| 1 | **UI: User / Deployer modes, agent marketplace, playground** | humans need to find and try services; deployers need a home | in progress (next) |
| 2 | Publish the npm package | `npx mx402` for everyone | needs `npm login`; the LICENSE and repo URL are now in place |
| 3 | Hosted deployment (a public hub + gateways) | today everything is `localhost` | Dockerfile / Railway template, `--public-url` |
| 4 | USDC pricing on Hedera (HTS token) | budgets in a stable currency | the adapter supports assets; needs a funded USDC test account |
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
- **HBAR only.** Budgets and prices are in HBAR, so HBAR volatility over a long session is a real
  risk.
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
- The offline demo reuses the `BUYER_*` account id from `.env` on the mock ledger, which can
  look confusing next to live data.

---

## Running it

```bash
npm install
npm run demo:offline          # zero config, nothing leaves the machine
npm run demo                  # live: needs .env (WALLET, BUYER_*, HEDERA_* for tabs/HCS, API keys)
npm test                      # 117 tests
npm run test:live             # live settlement + mirror-node checks
npx tsx scripts/live-agent.ts # the whole lifecycle as an agent, live
```

Required `.env` for live mode: `WALLET`, `BUYER_ACCOUNT_ID`, `BUYER_PRIVATE_KEY`; optionally
`HEDERA_ACCOUNT_ID` / `HEDERA_PRIVATE_KEY` (tabs, HCS, account creation), `HEDERA_TOPIC_ID`,
`GROQ_API_KEY`, `ETHERSCAN_API_KEY`. See `.env.example`.
