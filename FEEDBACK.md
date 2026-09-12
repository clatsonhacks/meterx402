# Uniswap developer feedback

From building MeterX402's Uniswap integration during ETHOnline 2026: a metered
x402 lane in front of the Uniswap Trading API (`uniswap-quote`) and a DEX
analyst agent that buys an executable quote after reading pools from The
Graph. Where the code lives is in the README section "Uniswap".

## What we used

- **Uniswap Trading API**, `POST https://trade-api.gateway.uniswap.org/v1/quote`
  with `x-api-key`, `type: EXACT_INPUT`, `routingPreference: BEST_PRICE`, on
  Base (8453) and Ethereum (1). The response fields we rely on are
  `quote.output.amount`, `quote.priceImpact`, `quote.gasFeeUSD`,
  `quote.routeString` and `quote.quoteId`.
- **Uniswap v3 data through The Graph**: the Messari standardized Uniswap v3
  subgraphs on seven chains, plus the official Uniswap v3 subgraph in the
  `uniswap-data` lane.

## What worked well

- One request returns everything an agent needs to explain a trade.
  `routeString` (for example `[v3] 100.00% = [0.01%] 0xb4CB…00e5`) made the
  route readable to a person without decoding the `route` array. `gasFeeUSD`
  and `priceImpact` are exactly the two numbers a buyer asks about next.
- `quoteId` gave us a stable reference to put in our receipts.
- The supported-chains page is clear that Base Sepolia, Sepolia and Unichain
  Sepolia work through the API even though the web app only shows two
  testnets. That is useful for hackathon builders.
- `llms.mdx` versions of the docs pages are a good idea for agent builders.

## Friction we hit

1. **Base URL and auth header were hard to find.** The overview and
   getting-started pages we fetched (including their `llms.mdx` versions)
   describe the `/quote` → `/swap` flow but do not state the base URL, the
   header name or the request body schema. We confirmed
   `trade-api.gateway.uniswap.org/v1` + `x-api-key` by trial. A copy-paste
   `curl` at the top of getting-started would remove the guesswork.
2. **A valid key can still get a 403 that looks like an auth failure.** Our
   first probe used Python's `urllib`, and the response was Cloudflare
   `error 1010: browser_signature_banned` with HTTP 403. The same request from
   Node's `fetch` returned 200. It is easy to conclude the key is wrong.
   Either allow common HTTP clients or document the requirement (a
   `User-Agent`) next to the auth section.
3. **`swapper` is required even for a price check.** An agent that only wants
   an indicative price has to invent an address. We use `0x…dEaD`. An
   explicit "indicative quote, no swapper" mode, or documenting that any
   address works for quoting, would help agent and analytics use cases.
4. **Amounts are atomic strings, but decimals live elsewhere.** Correct, but
   every client needs a token-decimals lookup before its first quote. Echoing
   `decimals` for `tokenIn` and `tokenOut` in the response would make
   responses self-describing.
5. **Rate limits were not on the pages we read.** For a paid API that resells
   quotes (our case), knowing the per-key limit up front decides how much to
   cache.
6. **Standardized Uniswap v3 subgraph quality varies by chain.** This is
   ecosystem data rather than the Trading API: through the Messari schema the
   Ethereum deployment returned sensible TVL and volume; Arbitrum and Polygon
   returned pools with stale or zero `totalValueLockedUSD`, and Base and
   Optimism timed out at the indexer during our tests. Our analyst reports
   unavailable sources rather than hiding them, and prefers the Trading API
   quote for anything executable.

## What we would like next

- An official "quote explainer" field: the effective price, fee paid in USD
  and the pools used, already normalised. Agents repeat this computation.
- A documented x402 or pay-per-call option for the Trading API. We wrap it
  with x402 today; native support would let agents without a key buy quotes
  directly.
