# MeterX402 (`mx402`)

> **A payment layer for APIs and AI agents.**
> Discover → Quote → Budget → Execute → Meter → Settle → Receipt → Reputation

Any API, A2A agent or MCP tool becomes something an agent can **find, price, budget for, pay
and rate** without knowing anything about the chain underneath. Payment is usage-based — a rate
per token, per row, per KB — settled on Hedera through x402, with a service registry, a
deterministic reputation score, Metered Tabs for repeated calls, and adapters for REST, GraphQL,
A2A and MCP. The architecture is in [ARCHITECTURE.md](./ARCHITECTURE.md).

```ts
import { MeterX402Agent } from "mx402";
const agent = new MeterX402Agent({ wallet, budget: "5 HBAR", registry: "http://localhost:4021" });
const [best] = await agent.discover({ capability: "weather_forecast", minReputation: 90 });
const r = await agent.call(best, { query: { forecast_days: "2" } });  // quote → budget → pay → receipt
r.receipt;        // SettlementReceipt: 48 rows × 0.0002 = 0.0096 HBAR, Hedera tx …
r.verification;   // the body hashes to what was quoted, and re-meters to the same 48 rows
```

## Where it started: fixing GlassBox402's flat price

MeterX402 is a rebuild of [GlassBox402](https://github.com/dhernz/Glassbox402) with its one
flaw fixed. GlassBox402 wraps any API in x402 in a single command, but every call costs the same:
a 5-token answer and a 4,000-token answer are billed identically, so the seller has to price for
the worst case and light users pay for heavy ones. Here the seller sets a **rate per unit**, the
buyer sets a **limit**, and each call settles on Hedera for exactly `units × rate`.

```bash
# 1. what would it meter, and what would calls cost? (calls your API once, charges nothing)
npx mx402 check https://api.your-service.com/v1/things

# 2. go live — no pricing flags: the meter and a starting rate come from your API's own response
npx mx402 https://api.your-service.com --wallet 0.0.1234
```

One package, ~4s to install, nothing to configure. `mx402 check` prints the price of a small call,
a large call, and what a flat price would have to charge to cover the worst case.

Verified on Hedera testnet through the public **blocky402** facilitator, against real APIs, with
every settlement checked on the mirror node to the tinybar:

| API | one call | metered | paid | a flat price would charge |
|---|---|---|---|---|
| Groq `openai/gpt-oss-20b` | "say hello in 5 words" | 289 tokens | **0.00289 HBAR** | 0.04 |
| Groq `openai/gpt-oss-20b` | ~200-word explainer | 563 tokens | **0.00563 HBAR** | 0.04 |
| Open-Meteo (no API key) | 1-day forecast | 24 rows | **0.0024 HBAR** | 0.024 |
| Open-Meteo | 4-day forecast | 96 rows | **0.0096 HBAR** | 0.024 |
| Etherscan v2 | 5 transactions | 5 rows | **0.005 HBAR** | 1.0 |

Token counts come from the provider's own `usage` block; row counts from the arrays actually
returned. Each payment also writes a public HCS receipt
([topic 0.0.10470327](https://hashscan.io/testnet/topic/0.0.10470327)) that anyone can reconcile
against the dashboard.

---

## Two ways to pay

### 1. Meter, then pay — exact, per call, no custody

The price of a response can't be known before the response exists. So the gateway runs the call,
counts the units, **holds** the body, and answers `402` with the exact price of *that* response:

```
buyer ── request (x-meter-max-units: 800) ─▶ mx402 ── clamp to cap ─▶ your API
      ◀─ 402: 612 tokens × 0.01/1000 = 0.00612 HBAR ──┤ (response held, hash committed)
      ── same request + PAYMENT-SIGNATURE ───────────▶│ verify + settle via blocky402 → Hedera
      ◀─ 200 + the held response ─────────────────────┘ (one transaction, exact amount)
```

The buyer sees the unit count and the price **before** signing, and the official `@x402` client
refuses to sign above their cap. No refunds, no deposits, and no private key on the resource
server — the buyer's wallet and the facilitator do the signing.

### 2. Metered Tabs — the limit lives on-chain, and streaming works

One settlement per call costs a consensus round trip (~3–5s), which is wrong for an agent making
hundreds of small calls. So a buyer can approve a **native Hedera HBAR allowance** to the lane's
spender account instead. That allowance *is* their spending limit, enforced by the ledger:

```bash
# the buyer approves 0.05 HBAR once; calls then run at ~10ms
tab = await buyer.openTab(lane, { allowance: "0.05" })
```

- calls go straight through: **no 402, no per-call wait** (measured: 9–15ms vs ~5,000ms)
- each is metered and debited; the gateway settles the total in **one approved transfer** per
  batch (`--tab-flush`, default 0.01 HBAR) and on close
- the remaining allowance caps the work: a call is clamped to what the buyer can still pay for,
  then refused
- the buyer can **revoke** at any time; the seller's exposure is at most one unsettled batch
- nothing is deposited, so nothing needs refunding

### Streaming (why it needs a tab)

`stream: true` returns the answer **token by token** (SSE) instead of one JSON blob, metered as
the tokens go past and debited when the stream ends:

```
data: {"choices":[{"delta":{"content":" metered"}}]}     ← the answer, as it is generated
…
event: mx-receipt
data: {"billable":84,"amount":0.00084,"unit":"tokens","tab":"hB2Ao…","owed":"0.00162"}
```

Streaming is available **only on a tab**, and that is not an implementation shortcut:

| | pay-per-call | on a tab |
|---|---|---|
| when payment authority exists | *after* the response is priced | *before* the call (the allowance) |
| so the body must be… | held back until paid — streaming it would hand over the goods first | free to flow, because payment is already authorised |
| the price is known… | only once the response is complete | the same, but it can be debited afterwards |

The buyer's cap is enforced **live**: when the stream crosses it, the gateway cancels the upstream,
sends an `mx-cap-reached` event, and bills exactly the cap — never more.

---

## Run it

```bash
npm install
npm run demo:offline     # zero config: mock LLM + mock facilitator, nothing leaves your machine
```

Open <http://localhost:4021>. The top switch has two modes:

- **User**, for people consuming services.
  - **Marketplace**: every registered service with its description, per-unit price, typical
    call, reputation score and interfaces. You can search, filter by capability and sort. Open a
    card to see the reputation breakdown and recent receipts, or to **Try it**: the whole
    lifecycle runs step by step (quote → budget check → pay / don't pay → verify → receipt), with
    real settlement.
  - **Playground**: pick a service and a way in (Buyer SDK, Agent SDK, **MCP connector**, A2A,
    raw HTTP + x402, CLI). You get ready-to-paste code generated from the service's live
    descriptor, and **Run** performs the same call.
  - AI agents don't need the page. The "Building an AI agent?" panel shows the registry,
    MCP, SDK and A2A entry points to the same data.
- **Deployer**, for people selling services.
  - **＋ Publish an API**: paste a URL, *Check* it for free (detected meter, suggested rate,
    price variants versus flat), then *Publish* it into the registry.
  - The dashboard: income, the per-call price spread, savings versus flat pricing, lanes with a
    test buyer and a **Stream** button on tab lanes, the registry and reputation, and live
    payments.

Deep links: `#user/playground`, `?service=llm&integ=mcp`, `?open=weather&tab=try`, `#deployer`,
`?lane=llm&stream=llm`.

For real settlement on Hedera testnet:

```bash
cp .env.example .env     # WALLET (payout) + BUYER_ACCOUNT_ID/BUYER_PRIVATE_KEY (a funded testnet account)
npx tsx scripts/new-buyer.ts   # optional: creates a funded buyer account with your operator key
npm run demo             # hub + every lane in lanes.json, settling through blocky402
npm run test:live        # proves it on-chain, then verifies each settlement on the mirror node
```

## Publishing a service (sellers)

```bash
npx mx402 publish https://api.coingecko.com/api/v3/coins/markets --sample '/?vs_currency=usd&per_page=10' --wallet 0.0.1234
```
```
✓ API detected: REST, 200 in 1941ms
✓ Authentication: none needed
✓ Meter detected: rows (the response carries a list of 10 items at the top level)
✓ Suggested rate: 0.002 HBAR / row (this call: 0.02 HBAR; flat at the cap of 40: 0.08 HBAR)
✓ Settlement: Hedera: HBAR per call (x402 exact via blocky402)
✓ Service registered in http://127.0.0.1:4021 (capabilities: market_data)

  Service ID        crypto-markets
  Payment endpoint  http://127.0.0.1:4111/?vs_currency=usd&per_page=10&page=1
  Descriptor        http://127.0.0.1:4111/.well-known/mx402
  A2A agent card    http://127.0.0.1:4111/.well-known/agent.json
  MCP               listed by the MeterX402 MCP server (list_services, call_service)
```

That is real output from a live run. Or from code: `await wrap({ upstream, wallet, capabilities })`.
Every service then serves a **ServiceDescriptor** (`/.well-known/mx402`), an **A2A agent card**,
and appears in the registry and the MCP server's `list_services`.

## Buying (agents and apps)

| Interface | How |
|---|---|
| SDK | `new MeterX402({ wallet, budget, registry })` → `discover` · `quote` · `pay` · `call`; `MeterX402Agent` adds capability-based calls, tabs and A2A |
| A2A | `POST /a2a` `message/send` → `input-required` with an x402 quote → pay in task metadata → `completed` with a receipt |
| MCP | `list_services` · `get_service` · `get_quote` · `pay_for_service` · `call_service` · `get_reputation` |
| HTTP | plain x402: call the endpoint, pay the `402` |

Budgets are checked before anything is signed: per call, per session, max units, and for tabs
the on-chain allowance. After paying, the SDK re-hashes the body and re-meters it; if either
disagrees with the quote it files a **dispute**, which is anchored on HCS and costs the seller
reputation.

## Four things only Hedera makes easy

**A portable agent identity (HCS-14).** Every service carries a Universal Agent ID:

```
uaid:aid:7JmaYYEJk7WfPKyQ1Tjpgd…;uid=weather;registry=meterx402;nativeId=hedera:testnet:0.0.10454509
```

It is a SHA-384 hash of six canonical fields — registry, name, version, protocol, the payout
account as CAIP-10, and HCS-11 skill numbers — and deliberately *not* of the endpoint or the
price, so the identity survives a move to a new host or a change of rate. The registry resolves
it and **re-derives the hash to check the claim**: `GET /registry/agents/:uaid` answers
`verified: true` only if the agent really is who it says. Nobody is trusted for that, because
the id *is* the hash. (Ours matches `@hashgraphonline/standards-sdk` byte for byte; that is a
test, not a hope.)

**Settle in a token, and let consensus take the fee.**

```bash
npx tsx scripts/new-token.ts                  # creates MXC with a 2% fee in its schedule
mx402 <api> --wallet <acct> --asset 0.0.10501361 --rate 0.01
```

The payment path does not change — same exact scheme, same facilitator — only the asset. The
protocol's cut lives in the **token's custom fee schedule**, so the ledger routes it on every
transfer: no fee-collection code in this repo, no contract, and no way for a seller to route
around it. Live: a 0.24 MXC call credited the seller 0.2352 and the treasury 0.0048.

**Subscriptions the seller can count before they land.** A tab is an allowance — permission,
revocable, promising nothing. A subscription is the opposite: the buyer pre-signs every future
payment as a Hedera scheduled transaction (`wait_for_expiry`), one per period.

```bash
mx402 <api> --wallet <acct> --subscribe 0.05 --period 604800 --sub-units 500
```

Consensus executes them unattended — measured at 0.1s after the due timestamp, with nothing of
ours running. The gateway decodes each schedule off the mirror node and refuses anything that is
not the buyer's own money; the buyer keeps the admin key and can cancel any period that has not
run.

**Quote rounds.** State the job and a ceiling instead of picking a service:

```ts
const round = await agent.rfq({ capability: "weather_forecast", maxUnits: 24, maxPrice: "0.05" });
// every live seller answers; losers and their reasons are part of the record
const r = await round.accept();
```

Estimates are free (nothing upstream runs); `binding: true` asks the shortlist for real 402s.
Scored by ratio to the best in the round — price 0.45, reputation 0.4, latency 0.15 — so twice
the price is half the score. Live, a proven seller beat an unrated rival at **half** the price,
and a ceiling nobody could meet declined the whole field with its reasons.

## Registry and reputation

`GET /registry/services?capability=weather_forecast&minReputation=90&maxPrice=0.05` returns
services ranked by reputation, price and latency. Reputation is a deterministic score from
payment events (execution 30%, response success 20%, latency 15%, disputes 15%, uptime 10%,
payment reliability 10%). A buyer's own mistakes never count against a seller, and a service is
unrated until it has 5 samples. `POST /registry/reputation/anchor` writes every score's digest
to HCS. `mx402 inspect <service>` shows it all from the command line.

## Setting it up (as an API provider)

```bash
npx mx402 check https://api.open-meteo.com/v1/forecast --sample '/?latitude=13&longitude=80&hourly=temperature_2m&forecast_days=2'
```
```
✓ 200 in 960ms, 1.4 KB back

What it should be metered on
  meter      rows:hourly.time   the response carries a list of 48 items at hourly.time
  rate       0.0002 HBAR / row   (minimum 0.0005 per paid call)
  seller cap 192 rows per call

What calls would cost
  this call             48 rows          0.0096 HBAR
  forecast_days=1       24 rows          0.0048 HBAR
  forecast_days=4       96 rows          0.0192 HBAR
  ↳ same API, different work, different price. A flat price has to cover the worst case:
  flat, at the cap     192 rows          0.0384 HBAR   ← what every call would cost without metering
```

What it detects, from one real response:

| Your API returns | Metered as |
|---|---|
| `usage.total_tokens` / `eval_count` / `usageMetadata` | `tokens` |
| any list, however nested (`data.pools`, `result`, `hourly.time`) | `rows:<path>` |
| a large body with neither | `bytes` |
| a small fixed object | `request` (flat) |

Then `npx mx402 <url> --wallet <account>` serves it. Every detected value is just a starting
point — `--meter`, `--rate`, `--per`, `--min`, `--max-units` override it. No Hedera account yet?
`mx402 wallet new` creates a funded testnet one.

## Pricing

| Seller (`lanes.json` / CLI) | |
|---|---|
| `--meter` | `tokens`, `tokens:output`, `rows`, `rows:<path>`, `bytes`, `ms`, `json:<path>`, `request` (flat, GlassBox-compatible) |
| `--rate` / `--per` | price per block of units, e.g. `0.01` per `1000` tokens |
| `--min` | minimum charge per paid call |
| `--free` | free units per call |
| `--max-units` | seller cap: nobody is billed above it |
| `--tab` | offer Metered Tabs (needs `TAB_SPENDER_ID/KEY`, or the operator account) |

| Buyer | enforced by |
|---|---|
| `x-meter-max-units` (or `max_tokens` in the body) | the gateway: the upstream request is clamped, and billing stops at the cap |
| `maxPerCall` | the buyer's own x402 client — it refuses to **sign** above it |
| `budget` | the buyer's client, across a session |
| the allowance | **Hedera**, for tabs |

Every quote commits to `sha256(body)`, and the buyer's SDK re-hashes what it received: the seller
cannot quote one response and deliver another.

## What's inside

```
src/protocol/      ServiceDescriptor, PaymentQuote, PaymentAuthorization, SettlementReceipt, ReputationRecord, Dispute
src/settlement/    the SettlementAdapter interface, X402ExactAdapter, route selection
src/registry/      the service registry and the reputation engine (served by the hub)
src/sdk/           buyer (MeterX402), seller (wrap), agent (MeterX402Agent)
src/adapters/a2a.ts   every service as an A2A agent, x402 payment in task metadata
src/cli.ts         the command line: publish, check, inspect, wallet new, serve
src/detect.ts      auto-detection: probe an API once, decide what to meter and what to charge
src/gateway.ts     the mx402 gateway: meter → hold → 402 → settle, plus tabs and streaming
src/meters.ts      what a response consumed (incl. streaming counters)
src/pricing.ts     units → billable → exact atomic amount (integer, always rounded up)
src/tabs.ts        allowance-backed tabs: open, debit, batch-settle, freeze
src/holds.ts       held responses: TTL, per-client caps, one settlement per quote
src/hub.ts         events, websocket, tape, analytics, policy, HCS receipts, dashboard
src/paid-fetch.ts  the buyer SDK: caps, budget, tabs, streaming, body verification
src/mcp.ts         MCP server: any agent becomes a paying customer, with limits
src/mock/          mock upstream + a mock facilitator that really checks signatures
public/            the web UI, no build step: index.html (shell + User/Deployer switch),
                   user.js (marketplace + service drawer), playground.js (integration code + Run),
                   deployer.js (seller dashboard), app.js (modes, publish panel, deep links)
lanes.json         every API being sold; one entry per lane (with description + capabilities)
STATUS.md          what is done, what is pending, limitations, known issues
packages/mx402/    the npm package: bundled SDK (import "mx402") + CLI (npx mx402), zero dependencies
```

## Testing

```bash
npm test         # 117 tests: engine, protocol, registry, reputation + end-to-end incl. the full lifecycle
npm run test:live   # real Hedera testnet, mirror-node verified
npx tsx scripts/live-agent.ts   # the whole lifecycle live, as an agent (needs `npm run demo` running)
```

`npm run build:cli` bundles the CLI into `packages/mx402/dist/mx402.mjs` (one file, no runtime
dependencies, 716 KB packed) — that is what `npx mx402` installs.

The offline end-to-end suite is not mocked at the protocol level: it signs **real Hedera transfer
transactions** with the official `@x402` client and settles them against a mock facilitator that
decodes each transaction and checks payer, payTo, amount, fee payer, signature and replay against
a ledger. It covers tampering, replay, expiry, insufficient funds, caps, budgets, World ID tiers,
tab batching, revocation and streaming.

See [APPROACH.md](./APPROACH.md) for the design, the trade-offs and the test plan.

## Carried over from GlassBox402

One-command wrapping, header/Bearer/query-param upstream auth (your key never leaves the server),
REST + GraphQL, chain presets (`--chain hedera|base|base-sepolia|solana`), the hub + live
dashboard + event tape, HCS receipts, account lazy-create from a MetaMask address, World ID human
vs agent pricing, the MCP server, and `lanes.json` + supervisor.

## License

MIT
