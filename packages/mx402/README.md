# mx402

**Turn any API into an x402 API that charges for what each call actually uses** — per token, per
row, per KB, per ms — instead of one flat price per call. Settles on Hedera through the public
blocky402 facilitator. No private key on your server, no metering stack to build.

```bash
# 1. see what it would meter and what calls would cost — nothing is charged
npx mx402 check https://api.your-service.com/v1/things

# 2. go live
npx mx402 https://api.your-service.com --wallet 0.0.1234
```

There is no `--meter` or `--rate` in that second command: mx402 calls your API once, reads the
shape of the response, and prices it accordingly. Override anything you disagree with.

## As a library

```ts
import { MeterX402Agent, MeterX402, wrap } from "mx402";

// sell: payment + metering around an API you already run (meter auto-detected)
await wrap({ upstream: "https://api.example.com", wallet: "0.0.1234", capabilities: ["weather_forecast"], registry: HUB });

// buy: discover → quote → budget → pay → receipt, as an agent
const agent = new MeterX402Agent({ wallet, budget: "5 HBAR", registry: HUB });
const r = await agent.call("weather_forecast");   // best compatible service, within budget
r.receipt; r.verification;                        // SettlementReceipt + re-metering check

// or one step at a time
const q = await new MeterX402({ wallet, budget: "1 HBAR", registry: HUB }).quote("weather-api");
if ("pay" in q && Number(q.quote.amount) < 0.01) await q.pay();
```

`mx402 publish <url> --wallet <acct>` registers a service for discovery; `mx402 inspect <id>`
shows its descriptor, pricing and reputation. Every service is also an A2A agent
(`/.well-known/agent.json`) and is listed by the MeterX402 MCP server.

## What it detects

| Your API returns | Metered as | Typical price |
|---|---|---|
| `usage.total_tokens` / `eval_count` / `usageMetadata` (LLMs) | `tokens` | 0.01 HBAR / 1K tokens |
| a list — GraphQL `data.…[]`, `{result:[…]}`, nested arrays | `rows` (with the exact path) | per row returned |
| a large body with neither | `bytes` | per KB |
| a small fixed object | `request` | flat, per call |

`mx402 check` prints the price of a small call, a large call, and what a flat price would have to
charge to cover the worst case:

```
What calls would cost
  this call             48 rows          0.0096 HBAR
  forecast_days=1       24 rows          0.0048 HBAR
  forecast_days=4       96 rows          0.0192 HBAR
  ↳ same API, different work, different price. A flat price has to cover the worst case:
  flat, at the cap     192 rows          0.0384 HBAR   ← what every call would cost without metering
```

## How a buyer pays

1. **Pay per call.** Their client gets `402` with the *exact* metered price of the response that
   is waiting for them, pays it, and receives the body. One Hedera transaction per call, no
   deposits, no refunds. The quote commits to `sha256(body)`, so what they pay for is what they get.
2. **Metered Tabs** (`--tab`). They approve a Hedera HBAR **allowance** once — that allowance is
   their spending limit, enforced by the ledger and revocable at any time — then call with no
   per-call payment (~10ms instead of a consensus round trip). You settle the total in one
   approved transfer per batch. Streaming responses (SSE, token by token) work on a tab.

Buyers cap any call with `x-meter-max-units: 500` (or `max_tokens` in an LLM body); the request is
clamped upstream, so a cap limits the work done, not just the bill.

## Options

```
Pricing        --meter tokens|tokens:output|rows|rows:<path>|bytes|ms|json:<path>|request
               --rate 0.01  --per 1000  --min 0.0001  --free 0  --max-units 4000
Lane           --wallet <0.0.x or 0x…>  --name  --port  --sample  --method  --body
               --header "K: V"  --query "k=v"   (your upstream key never reaches the buyer)
Chains         --chain hedera | base | base-sepolia | solana      (hedera is the tested path)
Tabs           --tab  --tab-flush 0.01  --tab-every 15
Abuse limits   --hold-ttl 120  --max-holds 3  --rpm 0
Dashboard      --hub http://localhost:4021    (stream events into a MeterX402 dashboard)
```

`mx402 wallet new` creates a funded Hedera testnet account to be paid into, if you don't have one.

Full project, dashboard and source: <https://github.com/clatsonhacks/meterx402>

MIT
