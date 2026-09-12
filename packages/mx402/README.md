# mx402

**Turn any API into an x402 API that charges for what each call actually returns**: per token,
row, cell, entity, KB or ms, instead of one flat price per call. Buyers, people or AI agents,
see the exact price before they sign, pay inside a budget, and get a receipt they can verify on
chain. Settles on **Hedera** (HBAR or HTS tokens), or in **USDC on Base or Solana**.

```bash
# 1. see what it would meter and what calls would cost: nothing is charged
npx mx402 check https://api.your-service.com/v1/things

# 2. go live (Hedera by default; --chain base-sepolia | solana-devnet for USDC)
npx mx402 https://api.your-service.com --wallet 0.0.1234
```

There is no `--meter` or `--rate` in that second command: mx402 calls your API once, reads the
shape of the response, and prices it accordingly. Override anything you disagree with.

## As a library

```ts
import { MeterX402Agent, MeterX402, wrap } from "mx402";

// sell: payment + metering around an API you already run (meter auto-detected)
await wrap({ upstream: "https://api.example.com", wallet: "0.0.1234", capabilities: ["weather_forecast"], registry: HUB });

// buy as an agent: discover → quote → budget → pay → receipt
const agent = new MeterX402Agent({ wallet, budget: "5 HBAR", registry: HUB });
const r = await agent.call("lending_rates");   // best compatible service, within budget
r.receipt; r.verification;                     // SettlementReceipt + re-metering check

// pay from an EVM or Solana wallet instead
const base = new MeterX402({ wallet: { privateKey: process.env.EVM_KEY, network: "eip155:84532" }, budget: "0.05 USDC", registry: HUB });
const sol  = new MeterX402({ wallet: { privateKey: process.env.SOLANA_SECRET, network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }, registry: HUB });
```

The EVM and Solana signers (`viem`, `@solana/kit`, `@x402/evm`, `@x402/svm`) are optional
dependencies, loaded only when a wallet on those chains is used.

## For AI agents

```json
{ "mcpServers": { "meterx402": { "command": "npx", "args": ["-y", "mx402", "mcp"],
  "env": { "MX_HUB": "http://127.0.0.1:4021", "BUYER_ACCOUNT_ID": "0.0.…", "BUYER_PRIVATE_KEY": "…", "BUYER_BUDGET": "1 HBAR" } } } }
```

The MCP server's tools:

| Kind | Tools |
|---|---|
| Discovery | `list_services`, `get_service`, `get_reputation` |
| Paying | `get_quote`, `pay_for_service`, `call_service` |
| The Graph data | `find_dex_pools`, `find_lending_markets` |
| Any subgraph, per entity, with no Graph key | `query_subgraph` |
| The DEX analyst | `ask_dex_analyst`: The Graph + Uniswap + an LLM, every step paid and receipted |

`mx402 analyst "<question>"` runs the same analyst from a terminal.

## What it detects

| Your API returns | Metered as | Typical price |
|---|---|---|
| `usage.total_tokens` / `eval_count` / `usageMetadata` (LLMs) | `tokens` | per 1K tokens |
| a list: GraphQL `data.…[]`, `{result:[…]}`, nested arrays | `rows` (with the exact path) | per row returned |
| a large body with neither | `bytes` | per KB |
| a small fixed object | `request` | flat, per call |

`mx402 data <file.csv>` sells a dataset the same way, priced per cell returned, with free
`/schema` and `/count`.

## How a buyer pays

1. **Per call.** The client gets a `402` with the *exact* metered price of the response that is
   waiting, pays it, and receives the body. The quote commits to `sha256(body)`, so what is paid
   for is what arrives.
2. **Metered Tabs** (`--tab`, Hedera). The buyer approves an HBAR **allowance** once: that
   allowance is the spending limit, enforced by the ledger and revocable at any time. Calls then
   run with no per-call payment, and streaming (SSE) works.
3. **Subscriptions** (`--subscribe`, Hedera). The buyer pre-signs one scheduled transfer per
   period; consensus executes them, and the buyer can cancel any period that has not run.

Buyers cap any call with `x-meter-max-units: 500` (or `max_tokens` in an LLM body); the request is
clamped upstream, so a cap limits the work done, not just the bill.

## Options

```
Pricing        --meter tokens|tokens:output|rows|rows:<path>|cells|bytes|ms|json:<path>|request
               --rate 0.01  --per 1000  --min 0.0001  --free 0  --max-units 4000
Lane           --wallet <0.0.x | 0x… | solana address>  --name  --port  --sample  --method  --body
               --header "K: V"  --query "k=v"   (your upstream key never reaches the buyer)
Chains         --chain hedera | base-sepolia | base | solana-devnet | solana
Tokens         --asset <HTS token id>          (Hedera; the token's own fee schedule applies)
Tabs           --tab  --tab-flush 0.01  --tab-every 15
Subscriptions  --subscribe 0.05  --period 604800  --sub-periods 12  --sub-units 500
Abuse limits   --hold-ttl 120  --max-holds 3  --rpm 0
Registry       --hub http://localhost:4021  --capability weather_forecast  --title  --description
```

`mx402 wallet new` creates a funded Hedera testnet account to be paid into, if you don't have one.

Full project, web app, diagrams and source: <https://github.com/clatsonhacks/meterx402>

MIT
