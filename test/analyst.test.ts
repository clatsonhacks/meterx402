import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, factsFor, mergePlan, quoteRequest, rulePlan, summarizeQuote, type Plan } from "../src/graph/analyst.ts";
import type { Pool } from "../src/graph/standard.ts";

const pool = (over: Partial<Pool>): Pool => ({
  protocol: "uniswap-v3", chain: "ethereum", chain_id: 1, pool: "0xpool", name: null,
  tokens: ["USDC", "WETH"], token_addresses: ["0xa0b8", "0xc02a"], token_decimals: [6, 18], token_prices_usd: [1, 2500],
  tvl_usd: 1_000_000, volume_24h_usd: 100_000, fee_percent: 0.05, fee_apr_percent: 1.83, subgraph: "sub",
  ...over,
});

test("rulePlan: a yield question", () => {
  const p = rulePlan("Where can USDC earn the most fees against ETH on Arbitrum?");
  assert.deepEqual(p.pools.tokens, ["USDC", "WETH"]);
  assert.deepEqual(p.pools.chains, ["arbitrum"]);
  assert.equal(p.pools.sort, "fee_apr");
  assert.equal(p.intent, "yield");
  assert.equal(p.trade, null);
});

test("rulePlan: a swap in dollars and a swap in tokens", () => {
  const usd = rulePlan("swap $5k USDC to ETH on base");
  assert.deepEqual(usd.trade, { sell: "USDC", buy: "WETH", amount: 5000, amount_in: "usd" });
  assert.deepEqual(usd.pools.chains, ["base"]);
  const tok = rulePlan("sell 2 ETH for USDC");
  assert.deepEqual(tok.trade, { sell: "WETH", buy: "USDC", amount: 2, amount_in: "token" });
});

test("mergePlan keeps what is on the menu and falls back for the rest", () => {
  const rules = rulePlan("swap $1000 USDC to ETH");
  const m = mergePlan({ tokens: ["eth", "usdc"], chains: ["Base", "mars"], protocols: [], sort: "volume", first: 99, trade: null }, rules);
  assert.deepEqual(m.pools.tokens, ["WETH", "USDC"]);
  assert.deepEqual(m.pools.chains, ["base"]);
  assert.equal(m.pools.sort, "volume");
  assert.equal(m.pools.first, 20, "an LLM cannot buy more than 20 rows");
  assert.equal(m.trade, null, "an explicit null trade is respected");
  const junk = mergePlan("not an object", rules);
  assert.deepEqual(junk.trade, rules.trade);
  assert.deepEqual(junk.pools.tokens, rules.pools.tokens);
});

test("extractJson finds the object inside prose and fences", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('x {"a":{"b":2}} y }'), { a: { b: 2 } });
  assert.equal(extractJson("no json here"), null);
});

test("factsFor: deepest, best APR above the floor, thin-liquidity warning, failed sources", () => {
  const plan: Plan = { intent: "yield", trade: null, pools: { tokens: ["USDC", "WETH"], sort: "fee_apr", minTvlUsd: 250_000, first: 10 } };
  const pools = [
    pool({ chain: "ethereum", tvl_usd: 100_000_000, volume_24h_usd: 150_000_000, fee_apr_percent: 27.38 }),
    pool({ chain: "arbitrum", chain_id: 42161, tvl_usd: 1_000_000, volume_24h_usd: 800_000, fee_apr_percent: 14.6 }),
    pool({ protocol: "sushiswap", chain: "polygon", chain_id: 137, tvl_usd: 100_000, volume_24h_usd: 50_000, fee_percent: 0.3, fee_apr_percent: 547.5 }),
  ];
  const facts = factsFor(plan, pools, null, { ok: 3, total: 4, failed: ["uniswap-v3/base"] });
  assert.match(facts[0], /3 pools from 3\/4 standardized subgraphs .* 3 chain\(s\); unavailable: uniswap-v3\/base/);
  assert.match(facts.join("\n"), /Deepest: uniswap-v3\/ethereum USDC-WETH 0\.05% with \$100\.00M TVL/);
  assert.match(facts.join("\n"), /Highest fee APR with TVL ≥ \$250\.0k: uniswap-v3\/ethereum .* 27\.38%/, "the 547% pool is below the TVL floor");
  assert.match(facts.join("\n"), /Caution: 1 pool\(s\) show >100% fee APR/);
  assert.match(facts.join("\n"), /Best pool per chain/);
});

test("quoteRequest: deepest pool on a chain Uniswap's API serves, exact atomic amount", () => {
  const pools = [
    pool({ chain: "somewhere", chain_id: 999, tvl_usd: 9e8 }),
    pool({ chain: "arbitrum", chain_id: 42161, tvl_usd: 2e6 }),
    pool({ chain: "ethereum", chain_id: 1, tvl_usd: 1e8 }),
  ];
  const usd = quoteRequest({ sell: "USDC", buy: "WETH", amount: 5000, amount_in: "usd" }, pools)!;
  assert.equal(usd.chainId, 1);
  assert.equal(usd.body.amount, "5000000000");
  assert.equal(usd.body.tokenIn, "0xa0b8");
  assert.equal(usd.body.tokenOut, "0xc02a");
  assert.equal(usd.decimalsOut, 18);
  const tok = quoteRequest({ sell: "ETH", buy: "USDC", amount: 2, amount_in: "token" }, pools)!;
  assert.equal(tok.body.amount, "2000000000000000000");
  assert.equal(tok.body.tokenIn, "0xc02a");
  const noPrice = quoteRequest({ sell: "USDC", buy: "WETH", amount: 100, amount_in: "usd" }, [pool({ token_prices_usd: [null, null] })])!;
  assert.equal(noPrice.body.amount, "100000000", "a stablecoin is worth a dollar when the subgraph has no price");
  assert.equal(quoteRequest({ sell: "ARB", buy: "WETH", amount: 1, amount_in: "token" }, pools), null);
});

test("summarizeQuote turns the API's atomic output into a price", () => {
  const pools = [pool({})];
  const trade = { sell: "USDC", buy: "WETH", amount: 5000, amount_in: "usd" as const };
  const req = quoteRequest(trade, pools)!;
  const s = summarizeQuote({ quote: { output: { amount: "2000000000000000000" }, priceImpact: 0.04, gasFeeUSD: "0.0026", routeString: "[v3] 100.00% = [0.05%] 0xpool", quoteId: "q1" } }, req, trade)!;
  assert.equal(s.amount_out, 2);
  assert.equal(s.price, 0.0004);
  assert.equal(s.price_impact_percent, 0.04);
  assert.equal(s.gas_usd, 0.0026);
  assert.equal(s.quote_id, "q1");
  assert.equal(s.gasless, false);
  assert.equal(summarizeQuote({ error: "nope" }, req, trade), null);
});

test("a UniswapX quote is gasless and says so, without inventing a route or impact", () => {
  const pools = [pool({})];
  const trade = { sell: "USDC", buy: "WETH", amount: 2000, amount_in: "usd" as const };
  const req = quoteRequest(trade, pools)!;
  const s = summarizeQuote({ routing: "DUTCH_V2", quote: { output: { amount: "792207843000000000" }, classicGasUseEstimateUSD: "0.0315", quoteId: "x" } }, req, trade)!;
  assert.equal(s.routing, "DUTCH_V2");
  assert.equal(s.gasless, true);
  assert.equal(s.gas_usd, 0);
  assert.equal(s.classic_gas_usd, 0.0315);
  assert.equal(s.route, null);
  const plan: Plan = { intent: "swap", trade, pools: { tokens: ["USDC", "WETH"], sort: "tvl", minTvlUsd: 0 } };
  const line = factsFor(plan, pools, s, { ok: 1, total: 1, failed: [] }).at(-1)!;
  assert.match(line, /gasless UniswapX order \(DUTCH_V2\)/);
  assert.match(line, /about \$0\.0315 in gas/);
  assert.doesNotMatch(line, /n\/a|price impact/);
});
