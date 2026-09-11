# MeterX402 (`mx402`): approach, build steps and results

> GlassBox402 turns any API into an x402 API, but every call costs the same **flat** price.
> MeterX402 keeps everything GlassBox402 does and fixes that one flaw: **buyers pay for what they
> use**. The seller sets a rate per unit (per token, per row, per KB, per ms), the buyer sets a
> limit, and each call settles on Hedera for exactly `units × rate`, never above the buyer's limit.

Status: **built, tested and proven on Hedera testnet** against real third-party APIs.
See §8 for results and §9–§10 for the two things added after the replication (Metered Tabs and
streaming).

---

## 1. The flaw in the original

In GlassBox402 (`core/src/x402ify.ts`) the price is fixed before the request runs:

```ts
accepts: { scheme: "exact", network: "hedera:testnet", payTo, price: priceForCtx }  // flat HBAR
```

A 5-token LLM answer and a 4,000-token one cost the same. A query for 1 row and one for 1,000
rows cost the same. The seller has to price at the worst case, so light users overpay and heavy
users are subsidised. Compute, inference and data are sold by consumption everywhere else.

Measured on the real thing: a 289-token answer costs **0.00289 HBAR** here, where flat pricing at
this lane's cap would charge **0.04 HBAR** for the same call — 14× more.

## 2. Why this is hard with x402 today

x402 settles with the **`exact`** scheme: the buyer signs for a fixed amount *before* the server
does the work, and the Hedera facilitator (blocky402) supports only that:

```
GET https://api.testnet.blocky402.com/supported
→ { scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.7162784" } }   (no "upto")
```

| Option | How it works | Problem |
|---|---|---|
| A. Ceiling + refund | charge the max, refund the difference | needs a hot key on the server to refund, two transactions, and refunds that can fail after the fact |
| B. Prepaid deposit | deposit, debit per call | the seller custodies the buyer's money; leftovers need refunding |
| C. `upto` scheme | sign for a max, settle the actual | no Hedera facilitator supports it |
| **D. Meter, then pay (chosen)** | run the call, count the units, **hold** the response, answer 402 with the **exact** price, release when paid | the seller does the work before being paid — bounded and mitigated, see §7 |

**D fits the protocol exactly.** A 402 means "this response costs X"; here X is the real metered
cost of *this* response. Standard `exact` scheme, unmodified facilitator, one transaction per
call, no refunds, and no private key on the resource server.

## 3. The flow

```
buyer (x402 client)                 mx402 gateway                       upstream API      facilitator → Hedera
  │  POST /chat  x-meter-max-units: 800    │                                  │                    │
  │ ──────────────────────────────────────▶│ clamp request to the cap         │                    │
  │                                        │ ────────────────────────────────▶│                    │
  │                                        │ ◀─────────── 200 + body ─────────│                    │
  │                                        │ meter: 612 tokens                 │                    │
  │                                        │ price = ceil(612 × rate) tinybar  │                    │
  │                                        │ HOLD body (sha256, TTL 120s)      │                    │
  │ ◀── 402 PAYMENT-REQUIRED ──────────────│  accepts[0].amount = exact price  │                    │
  │     extra.meter = {units, rate, cap,   │  extra.meter.quoteId, bodySha256  │                    │
  │                    bodySha256, quoteId}│                                   │                    │
  │ client checks amount ≤ maxPerCall,     │                                   │                    │
  │ spent+amount ≤ budget → signs transfer │                                   │                    │
  │ ── same request + PAYMENT-SIGNATURE ──▶│ match hold by quoteId+fingerprint │                    │
  │                                        │ verify ──────────────────────────────────────────────▶│
  │                                        │ settle ──────────────────────────────────────────────▶│ HBAR transfer
  │ ◀── 200 held body + PAYMENT-RESPONSE ──│ emit settled → hub → HCS receipt │                    │
  │ client re-hashes body == bodySha256 ✓  │                                   │                    │
```

The quote **commits to the response**: `bodySha256` travels inside the payment requirements the
buyer signs against, and the buyer's client re-hashes what arrives. The seller cannot quote one
response and deliver another.

## 4. Pricing model

Seller, per lane (`lanes.json` or CLI flags):

| Field | Meaning | Example |
|---|---|---|
| `meter` | what is counted: `tokens`, `tokens:output`, `rows`, `rows:<path>`, `bytes`, `ms`, `json:<path>`, `request` (flat, GlassBox-compatible) | `tokens` |
| `rate` / `per` | price per block of units | `0.01` per `1000` |
| `min` | minimum charge per paid call | `0.0001` |
| `free` | free units per call | `0` |
| `maxUnits` | seller cap per call | `4000` |

Buyer:

| Limit | Enforced by | How |
|---|---|---|
| `x-meter-max-units` (or `max_tokens` in the body) | the gateway | the upstream request is clamped (`max_tokens`, GraphQL `first:`) and billable = `min(measured, buyerCap, sellerCap)` |
| `maxPerCall` | the buyer's **own** x402 client | `setSpendControls({ allowedAssets: [{ asset: "0.0.0", maxAmountPerPayment }] })` — it refuses to sign |
| `budget` | the buyer's client | `onBeforePaymentCreation` aborts past the session total |
| the allowance | **Hedera itself** | Metered Tabs, §9 |

`amount = max(min, ceil((billable − free) × rate / per × multiplier × 10^8))` tinybar — integer
arithmetic, always rounded **up**, so float drift can never short the seller. `multiplier` is the
World ID tier carried over from GlassBox (bots pay N×, or are blocked).

## 5. Replication checklist (GlassBox402 → MeterX402)

| GlassBox402 | MeterX402 | |
|---|---|---|
| `x402ify` CLI wraps any API | `mx402` (`src/gateway.ts`, `bin/mx402.mjs`) | ✅ |
| header / Bearer / query-param auth, REST + GraphQL | same flags; the key never leaves the server (e2e-tested) | ✅ |
| chain presets (one flag) | `--chain hedera` (tested) + base / base-sepolia / solana presets | ✅ |
| blocky402 facilitator, no server key | unchanged; `verify` + `settle` driven directly at the metered amount | ✅ |
| hub: events → WebSocket → dashboard, tape + replay | `src/hub.ts`, plus units/rate/cap/savings on every event | ✅ |
| HCS receipt per payment | now includes `unit, units, measured, rate, amount, bodySha256` — live topic [0.0.10470327](https://hashscan.io/testnet/topic/0.0.10470327) | ✅ |
| account lazy-create from a 0x address | `/account` (mirror lookup + lazy-create) | ✅ |
| World ID human vs agent pricing | HMAC session token, `botMultiplier`, `blockBots` (e2e-tested) | ✅ |
| MCP `list_paid_apis` / `paid_fetch` | + `max_units` / `max_hbar` and a metering receipt in the answer | ✅ |
| `lanes.json` + supervisor | same three rules (wait for hub, skip keyless lanes, crash = restart all) | ✅ |
| dashboard | income, units, per-call price spread, saved-vs-flat, payments, analytics, policy, **live streaming demo** | ✅ |

## 6. Build order (as built)

1. Scaffold, TypeScript run by `tsx`, official `@x402` packages.
2. Pure core first, unit-tested: `pricing.ts`, `meters.ts`, `holds.ts`.
3. `gateway.ts`: drives `x402ResourceServer.buildPaymentRequirements / verifyPayment /
   settlePayment` by hand, because the price only exists *after* the handler has run.
4. `hub.ts` + `analytics.ts` + HCS receipts.
5. `paid-fetch.ts` buyer SDK (caps, budget, body-hash check), MCP server.
6. Mocks: a mock upstream (OpenAI-compatible, SSE, GraphQL) and a **mock facilitator that really
   verifies** — it decodes the signed Hedera transaction and checks payer, payTo, amount, fee
   payer, signature and replay against a ledger.
7. Supervisor, `lanes.json`, dashboard.
8. Then the new work: **Metered Tabs** (§9) and **streaming** (§10).

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Buyer walks away after the work is done | the cap bounds the work; max unpaid holds per client (`--max-holds`); unpaid requests per minute (`--rpm`); holds expire; World ID `blockBots` |
| Seller over-reports units | the quote shows units before signing, the client caps the price, `bodySha256` binds the body, and the HCS receipt publishes the reading |
| Hold lost on restart | the buyer's retry gets a fresh 402; nothing was paid, nothing lost |
| Double payment for one quote | the hold is locked while settling; Hedera rejects a replayed transaction id |
| Float rounding | integer tinybar, always rounded up, with a `min` floor |
| Tab buyer revokes mid-session | exposure is at most one unsettled batch (`--tab-flush`), then the tab freezes |

## 8. Testing — and what it proved

**80 automated tests at this stage** (117 after §12; `npm test`): 45 unit + 35 end-to-end.

| Layer | Covers |
|---|---|
| `test/unit.test.ts` | exact money math (rationals, tinybar, rounding up, min/free), every meter against real OpenAI/Anthropic/Ollama/Gemini/GraphQL/Etherscan shapes, request clamping, hold TTL/limits/locking, World tokens, analytics |
| `test/detect.test.ts` | auto-detection across real response shapes (LLM usage, nested lists, envelopes, big bodies), rate scaling, cap tethering, probe URL building, price variants |
| `test/tabs.test.ts` | tab opening (signature, allowance), debits, threshold flush, close, freeze on revoke, concurrent flushes settling once |
| `test/e2e.test.ts` | hub + 6 lanes + the **real** `@x402` client signing **real Hedera transfer transactions**: exact prices, buyer/seller caps, client refusal, budgets, tampering (two kinds), replay, expiry, insufficient funds, unpaid-quote limits, upstream errors free, key injection, concurrency, World tiers, analytics reconciling with the ledger, tape contents |
| `test/stream-tabs.test.ts` | tabs end to end (batching, allowance as a hard cap, revocation, forged tokens) and streaming (chunked delivery, receipt event, live cap cut-off, refusal on the pay-per-call path) |
| `test/live-hedera.ts` | the real thing: blocky402 → Hedera testnet, then **mirror-node verification** |

### Live on Hedera testnet

Pay-per-call, each verified on the mirror node to the tinybar:

| Call | Metered | Paid | Transaction |
|---|---|---|---|
| mock LLM, 20 words | 24 tokens | 0.00024 HBAR | [tx](https://hashscan.io/testnet/transaction/0.0.7162784-1789097575-295827752) |
| mock LLM, 600 words | 604 tokens | 0.00604 HBAR | [tx](https://hashscan.io/testnet/transaction/0.0.7162784-1789098206-305258912) |

Against **real third-party APIs** (the point of the whole thing):

| API | Call | Metered | Paid | Flat-at-cap would be |
|---|---|---|---|---|
| Open-Meteo (no key at all) | 1-day forecast | 24 rows | 0.0024 HBAR | 0.024 |
| Open-Meteo | 4-day forecast | 96 rows | 0.0096 HBAR | 0.024 |
| Etherscan v2 | 5 transactions | 5 rows | 0.005 HBAR | 1.0 |
| Groq `openai/gpt-oss-20b` | "hello in 5 words" | 289 tokens | 0.00289 HBAR | 0.04 |
| Groq `openai/gpt-oss-20b` | ~200-word explainer | 563 tokens | 0.00563 HBAR | 0.04 |

The token counts come from Groq's own `usage` block; the row counts from the actual arrays
returned. Every settlement also wrote an HCS receipt readable straight off the mirror node:

```bash
curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10470327/messages?limit=5&order=desc"
# {"mx402":"metered-settlement","lane":"llm","units":563,"rate":"0.01","per":"1000","amount":0.00563,...}
```

---

## 9. New idea #1: Metered Tabs — the buyer's limit lives on-chain

Settling every call costs a consensus round trip (~3–5s measured), which is wrong for an agent
making hundreds of small calls. And a buyer who wants a hard ceiling still has to trust the seller
to respect it.

**A Metered Tab makes the limit a native Hedera HBAR allowance.**

1. the buyer approves an allowance to the lane's spender account
   (`AccountAllowanceApproveTransaction`) — that amount *is* the limit, enforced by the ledger
2. they prove they own the account (sign a one-time challenge) and the gateway reads the
   allowance off the mirror node → a tab opens
3. calls go straight through: **no 402, no per-call wait**. Each is metered and debited
4. the gateway settles the total in **one approved transfer** per batch (`--tab-flush`) and on
   close: `addApprovedHbarTransfer(owner → payTo)`, signed by the spender

Nothing is deposited, so nothing needs refunding — unused allowance never leaves the buyer's
account, and they can revoke it at any moment. The remaining allowance also **caps the work**: a
call is clamped to what the buyer can still pay for, then refused (`tab_exhausted`).

Measured live: **9–15ms per call** versus ~5,000ms when each call settles on its own, and 3 calls
settled in a single transaction
([0.0.10452591@1789098907](https://hashscan.io/testnet/transaction/0.0.10452591-1789098907-439816798)).

| | pay-per-call | tab |
|---|---|---|
| trust | zero (nothing is released until paid) | seller carries at most one unsettled batch |
| latency | one consensus round trip per call | none, until a batch settles |
| transactions | 1 per call | 1 per batch |
| the buyer's limit | their client refuses to sign | Hedera refuses the pull |
| streaming | impossible (§10) | yes |

## 10. New idea #2: streaming — and why it only works on a tab

`stream: true` returns the answer **token by token** (SSE) rather than one JSON blob, metered as
the tokens pass and debited when the stream ends:

```
data: {"choices":[{"delta":{"content":" metered"}}]}   ← the answer, as it is generated
…
event: mx-receipt
data: {"billable":192,"amount":0.00192,"unit":"tokens","tab":"ajMCpW4oOzpa","owed":"0.00192"}
```

Why it cannot exist on the pay-per-call path: there, the price is only known once the response is
complete, and the body is precisely the thing being **withheld until payment**. Streaming it out
first would hand over the goods before anyone paid. On a tab the payment authority already exists
(the allowance was approved before the call), so the bytes can flow while being counted.

Mechanically (`streamMetered` in `src/gateway.ts`): the upstream is asked for a stream
(`stream_options.include_usage` where supported), each chunk is hashed, counted by a **streaming
meter** (`meters.ts`) and passed straight through; when the count crosses the buyer's cap the
gateway cancels the upstream, emits `mx-cap-reached` and bills exactly the cap; at the end it
debits the tab and appends `mx-receipt`, which is the only place a receipt can live once headers
are already on the wire.

Proven live with Groq `gpt-oss-20b`: 49 text chunks, 192 tokens metered from the live stream,
0.00192 HBAR, settled on-chain — and in the dashboard, text types out while the meter bar tracks
the spend (`?lane=llm&stream=llm`).

## 11. New idea #3: making it one command for the seller

Replicating GlassBox402's *product* is not enough if adopting it is harder than adopting
GlassBox402. Its whole wedge is `npx x402ify …`; ours started out as "clone the repo, install 336
packages, know what `--meter` means". Three changes closed that gap:

**A published, self-contained package.** `scripts/build-cli.mjs` bundles the CLI (esbuild, ESM,
with a `createRequire` banner because the Hedera SDK's CJS dependencies call `require` at load
time) into a single 4.6 MB file with **zero dependencies**: 716 KB packed, one package, **3.6s to
install** in a clean project, versus ~4 minutes for the workspace. One codebase still: the bundle
is built from the same `src/`, so the same tests cover it.

**Auto-detection (`src/detect.ts`).** With no `--meter`, the CLI calls the API once and reads the
response: token usage → `tokens`; the largest array anywhere in the body → `rows:<path>` (this is
what makes Open-Meteo's `hourly.time` and Etherscan's `result` work without being told); a large
body → `bytes`; otherwise `request`. It also suggests a rate, scaled by powers of ten so a typical
call lands near 0.01 HBAR, and a seller cap tethered to the observed size (4× the sample).

**`mx402 check`,** a dry run that charges nothing and needs no wallet. It prices the sampled call,
then re-probes with a *smaller* and a *larger* variant (`max_tokens`, GraphQL `first:`,
`offset`/`limit`/`forecast_days`) so the seller sees the price move, against what a flat price
would have to charge. It ends by printing the exact command to go live.

Proven end to end: `npm pack` → install in an empty directory → `npx mx402 <open-meteo-url>
--wallet 0.0.10454509` → it detected `rows:hourly.time` at 0.0002 HBAR/row and sold real calls,
settling on Hedera at 24 rows → 0.0048 HBAR and 72 rows → 0.0144 HBAR.

## 12. From wrapper to payment layer

The next stage turned this engine into a protocol-level payment layer: five protocol objects, a
SettlementAdapter the gateway now goes through, a service registry with a deterministic
reputation engine, buyer/seller/agent SDKs, A2A and MCP adapters, `mx402 publish`, and
buyer-side re-metering with disputes. It is documented, with live evidence, in
[ARCHITECTURE.md](./ARCHITECTURE.md). The test suite grew to 117.

## 13. Where this goes next

- **Mainnet + HTS stablecoin pricing** (HBAR volatility over a long session is a real risk).
- **Verifiable metering.** The reading is published and the body is hash-committed, so it is
  *disputable* — not yet *verifiable*. Client-side re-metering plus a dispute log on HCS, scored
  per lane, is the natural next step.
- **Tabs across lanes** (one allowance, many APIs) and a shared spender contract.
- **A budget-aware agent router**: pick the cheapest lane per unit that fits the caller's budget.
