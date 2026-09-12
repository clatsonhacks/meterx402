---
name: meterx402-onchain-data
description: Use when an agent needs live onchain DeFi data or a swap price — DEX pool liquidity, volume and fee yield across chains, lending supply and borrow rates, any subgraph on The Graph, or a Uniswap quote — and should pay for it per result with x402 through the MeterX402 MCP tools instead of holding API keys.
---

# MeterX402 onchain data

MeterX402 sells The Graph and Uniswap data to agents, priced by what each call
returns. You need no Graph or Uniswap API key; you pay per pool, per market,
per entity or per quote over x402, inside a budget the user set. Every paid
call ends in a receipt with the exact units, rate and transaction.

## Setup

The MCP server ships in the `mx402` package:

```json
{
  "mcpServers": {
    "meterx402": {
      "command": "npx",
      "args": ["-y", "mx402", "mcp"],
      "env": {
        "MX_HUB": "http://127.0.0.1:4021",
        "BUYER_ACCOUNT_ID": "0.0.…",
        "BUYER_PRIVATE_KEY": "…",
        "BUYER_BUDGET": "1 HBAR"
      }
    }
  }
}
```

## Pick the tool

| The user wants | Tool | Billed per |
|---|---|---|
| where a pair is deepest, busiest, or earns the most fees | `find_dex_pools` | pool |
| where a token earns the most, or is cheapest to borrow | `find_lending_markets` | market |
| data no other tool covers (a protocol's own entities, history, positions) | `query_subgraph` | entity (every object in the answer) |
| a plain-language DeFi question, with numbers and receipts | `ask_dex_analyst` | each step it buys |
| to discover what else is for sale | `list_services`, then `get_quote` / `call_service` | whatever the service meters |

Prefer the specific tools over `query_subgraph`: they ask many subgraphs at
once through one standardized schema and return one comparable shape.

## Spend carefully

- Ask for what you need: `first` (or `max_entities`) is what you pay for.
  Start with 5 to 10 rows and widen only if the answer needs it.
- A query that errors or returns nothing costs nothing, so a narrow first try
  is cheap.
- `get_quote` runs the call and shows the exact price before anything is paid.
  Use it when the size of the answer is hard to predict, which is typical for
  `query_subgraph`.
- Never loop a paid tool to paginate a large result without telling the user
  what it will cost.

## Read the results honestly

- **`sources`** lists every subgraph asked. `ok: false` means that chain or
  protocol is missing from the answer; say so instead of implying full
  coverage. `via: "fallback"` means Uniswap's own subgraph answered because the
  standardized one was failing.
- **`fee_apr_percent`** is 24h volume × fee, annualised over TVL. It is a
  signal, not a yield: it ignores impermanent loss and one busy day inflates
  it. Treat anything above 100% on under $250k TVL as noise.
- **`volume_24h_usd: null`** means no daily snapshot from the last two days;
  do not describe that pool's activity.
- **TVL above a few billion dollars** on an obscure pair is a mispriced token;
  the tools already drop pools over $5B.
- **Lending `active: false`** markets are frozen and are left out by default.
  `borrow_apy_percent: null` means borrowing is off for that market.
- **Uniswap quotes routed as UniswapX** (`DUTCH_V2`, `DUTCH_V3`, `PRIORITY`)
  are gasless for the swapper: a filler pays gas. There is no route string or
  price impact for them; do not invent one.

## Examples

"Where can I earn the most on USDC?"
→ `find_lending_markets { tokens: ["USDC"], sort: "supply_apy", first: 8 }`,
then `find_dex_pools { tokens: ["USDC", "ETH"], sort: "fee_apr", min_tvl_usd: 1000000, first: 8 }`
to compare lending with providing liquidity. State the risk difference.

"Top 5 Uniswap v3 pools on Ethereum right now"
→ `query_subgraph { subgraph_id: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV", query: "{ pools(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc, where: { totalValueLockedUSD_lt: \"5000000000\" }) { id feeTier totalValueLockedUSD token0 { symbol } token1 { symbol } } }", max_entities: 20 }`
(5 pools + 10 tokens = 15 entities).

"Should I swap $2,000 USDC to ETH now, and where?"
→ `ask_dex_analyst { question: "swap $2000 USDC to ETH where liquidity is deepest" }`.
Quote its facts; its answer only restates numbers from the data it bought.
