import { test } from "node:test";
import assert from "node:assert/strict";
import { DEX_SOURCES, expandSymbol, normalize, normalizeUniswapV3, parsePoolQuery, pickSources, queryPools, resetSourceHealth, sortPools, type Source } from "../src/graph/standard.ts";
import { LENDING_SOURCES, normalizeMarkets, parseMarketQuery, queryMarkets, sortMarkets } from "../src/graph/lending.ts";
import { checkGraphqlBody, countEntities, DEPLOYMENT_ID, SUBGRAPH_ID } from "../src/graph/subgraphs.ts";
import { CHAINS, USDC, decimalsFor, explorerTx } from "../src/chains.ts";
import { ERC20_TRANSFER, evmCredited, solanaCredited } from "../src/settlement/verify-chains.ts";

const now = Date.UTC(2026, 8, 13);
const day = Math.floor(now / 1000) - 3600;
const src: Source = { protocol: "uniswap-v3", chain: "base", chainId: 8453, id: "sub-base" };

const pool = (id: string, symbols: string[], tvl: number, volume: number, fee = 0.05, ts = day) => ({
  id, name: symbols.join("/"), totalValueLockedUSD: String(tvl), cumulativeVolumeUSD: "1",
  inputTokens: symbols.map((s, i) => ({ id: `0x${i}${id}`, symbol: s, decimals: 18, lastPriceUSD: "1" })),
  fees: [{ feePercentage: String(fee), feeType: "FIXED_TRADING_FEE" }, { feePercentage: "0", feeType: "FIXED_PROTOCOL_FEE" }],
  dailySnapshots: [{ dailyVolumeUSD: String(volume), timestamp: String(ts) }],
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

test("every source id is a base58 subgraph id, unique per protocol+chain, fallbacks included", () => {
  for (const list of [DEX_SOURCES, LENDING_SOURCES]) {
    const seen = new Set<string>();
    for (const s of list) {
      for (const x of [s, s.fallback].filter(Boolean) as Source[]) assert.match(x.id, SUBGRAPH_ID, `${x.protocol}/${x.chain}`);
      const k = `${s.protocol}:${s.chain}`;
      assert.ok(!seen.has(k), `duplicate ${k}`);
      seen.add(k);
    }
  }
  assert.ok(new Set(DEX_SOURCES.map((s) => s.chain)).size >= 7, "DEX data spans at least seven chains");
  assert.ok(new Set(LENDING_SOURCES.map((s) => s.protocol)).size >= 6, "lending spans at least six protocols");
  assert.ok(DEX_SOURCES.filter((s) => s.fallback).every((s) => s.fallback!.chain === s.chain && s.fallback!.kind === "uniswap-v3-official"));
});

test("pickSources narrows by chain and protocol prefix", () => {
  assert.equal(pickSources({}).length, DEX_SOURCES.length);
  assert.ok(pickSources({ protocols: ["uniswap"] }).every((s) => s.protocol.startsWith("uniswap")));
  const base = pickSources({ chains: ["base"], protocols: ["uniswap-v3"] });
  assert.equal(base.length, 1);
  assert.equal(base[0].chainId, 8453);
  assert.ok(pickSources({ protocols: ["aave"] }, LENDING_SOURCES).length >= 6);
});

test("symbol aliases: ETH finds WETH, USD finds the stables", () => {
  assert.deepEqual(expandSymbol("eth"), ["WETH", "ETH"]);
  assert.ok(expandSymbol("USD").includes("USDT"));
  assert.deepEqual(expandSymbol("ARB"), ["ARB"]);
});

test("normalize: shared shape, pair filter, fee APR, stale snapshots ignored", () => {
  const data = {
    matching: [
      pool("a", ["USDC", "WETH"], 1_000_000, 500_000, 0.05),
      pool("b", ["USDC", "DAI"], 2_000_000, 100_000, 0.01),
      pool("c", ["WETH", "USDC"], 400_000, 10_000, 0.3, day - 5 * 86400),
    ],
  };
  const rows = normalize(src, data, ["USDC", "ETH"], now);
  assert.deepEqual(rows.map((r) => r.pool), ["a", "c"]);
  const a = rows[0];
  assert.equal(a.chain_id, 8453);
  assert.equal(a.fee_percent, 0.05);
  // 500k × 0.05% × 365 / 1M = 9.125%
  assert.equal(a.fee_apr_percent, 9.13);
  assert.equal(rows[1].volume_24h_usd, null, "a five-day-old snapshot is not today's volume");
  assert.equal(rows[1].fee_apr_percent, null);
});

test("Uniswap's own v3 schema maps into the same shape", () => {
  const data = {
    bundle: { ethPriceUSD: "2500" },
    pools: [
      { id: "0xp", feeTier: "500", totalValueLockedUSD: "2000000", token0: { id: "0xusdc", symbol: "USDC", decimals: "6", derivedETH: "0.0004" }, token1: { id: "0xweth", symbol: "WETH", decimals: "18", derivedETH: "1" }, poolDayData: [{ date: day, volumeUSD: "1000000" }] },
      { id: "0xjunk", feeTier: "10000", totalValueLockedUSD: "4000000", token0: { id: "0x1", symbol: "COD", decimals: "18", derivedETH: "0" }, token1: { id: "0xweth", symbol: "WETH", decimals: "18", derivedETH: "1" }, poolDayData: [] },
    ],
  };
  const [p, ...rest] = normalizeUniswapV3(src, data, ["USDC", "ETH"], now);
  assert.equal(rest.length, 0, "the pool without USDC is dropped");
  assert.equal(p.fee_percent, 0.05, "feeTier 500 is 0.05%");
  assert.deepEqual(p.token_decimals, [6, 18]);
  assert.deepEqual(p.token_prices_usd, [1, 2500], "prices come from derivedETH × the bundle");
  assert.equal(p.volume_24h_usd, 1_000_000);
  assert.equal(p.fee_apr_percent, 9.13);
  assert.equal(p.name, "USDC/WETH 0.05%");
});

test("sortPools by tvl, volume, fee_apr (nulls last)", () => {
  const rows = normalize(src, { all: [pool("x", ["A", "B"], 10, 100, 1), pool("y", ["A", "B"], 1000, 1, 1), pool("z", ["A", "B"], 500, 50, 1, 0)] }, [], now);
  assert.deepEqual(sortPools(rows, "tvl").map((r) => r.pool), ["y", "z", "x"]);
  assert.deepEqual(sortPools(rows, "volume").map((r) => r.pool), ["x", "y", "z"]);
  assert.equal(sortPools(rows, "fee_apr").at(-1)!.pool, "z");
});

test("parsePoolQuery accepts pairs, lists and junk", () => {
  const q = parsePoolQuery({ pair: "USDC/ETH", chains: "base, arbitrum", first: "5", sort: "nope", min_tvl: "abc" });
  assert.deepEqual(q.tokens, ["USDC", "ETH"]);
  assert.deepEqual(q.chains, ["base", "arbitrum"]);
  assert.equal(q.first, 5);
  assert.equal(q.sort, "tvl");
  assert.equal(q.minTvlUsd, undefined);
  assert.deepEqual(parsePoolQuery({ tokens: ["WBTC"] }).tokens, ["WBTC"]);
});

test("queryPools: one document to many subgraphs, merged, sorted, failures reported", async () => {
  resetSourceHealth();
  const celo = DEX_SOURCES.find((s) => s.chain === "celo")!;
  const bodies: any[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push({ url, body, auth: init.headers.authorization });
    const id = url.split("/").pop()!;
    if (id === celo.id) return json({ errors: [{ message: "indexer unavailable" }] });
    if (body.query.includes("bundle(")) return json({ data: { bundle: { ethPriceUSD: "30" }, pools: [] } });
    return json({ data: { protocol: [{ schemaVersion: "4.0.1" }], matching: [pool(id.slice(0, 4), ["USDC", "WETH"], id.charCodeAt(0) * 1000, 10)] } });
  }) as unknown as typeof fetch;
  const r = await queryPools({ protocols: ["uniswap-v3"], tokens: ["USDC", "ETH"], first: 3 }, { apiKey: "k", fetch: fakeFetch, cacheMs: 0 });
  const asked = pickSources({ protocols: ["uniswap-v3"] });
  assert.equal(bodies.length, asked.length, "nothing failed that has a fallback, so one request per source");
  const standard = bodies.filter((b) => !b.body.query.includes("bundle("));
  assert.ok(standard.every((b) => b.body.query === standard[0].body.query), "the same query to every standardized subgraph");
  assert.ok(bodies.every((b) => b.auth === "Bearer k"));
  assert.equal(standard[0].body.variables.filter, true);
  assert.equal(r.pools.length, 3);
  assert.ok(r.pools[0].tvl_usd >= r.pools[1].tvl_usd);
  const failed = r.sources.find((s) => !s.ok)!;
  assert.equal(failed.chain, "celo");
  assert.match(failed.error!, /indexer unavailable/);
  assert.equal(r.sources.filter((s) => s.ok).length, asked.length - 1);
  assert.equal(r.sources.find((s) => s.chain === "avalanche")!.schema, "uniswap-v3-official");
});

test("a failing standardized subgraph falls back to Uniswap's own, and says so", async () => {
  resetSourceHealth();
  const base = DEX_SOURCES.find((s) => s.chain === "base" && s.protocol === "uniswap-v3")!;
  const asked: string[] = [];
  const fakeFetch = (async (url: string) => {
    const id = url.split("/").pop()!;
    asked.push(id);
    if (id === base.id) return json({ errors: [{ message: "bad indexers: Timeout" }] });
    return json({ data: { bundle: { ethPriceUSD: "2500" }, pools: [{ id: "0xp", feeTier: "3000", totalValueLockedUSD: "5000000", token0: { id: "0xa", symbol: "WETH", decimals: "18", derivedETH: "1" }, token1: { id: "0xb", symbol: "USDC", decimals: "6", derivedETH: "0.0004" }, poolDayData: [{ date: Math.floor(Date.now() / 1000) - 3600, volumeUSD: "200000" }] }] } });
  }) as unknown as typeof fetch;
  const r = await queryPools({ chains: ["base"], protocols: ["uniswap-v3"], tokens: ["USDC", "ETH"] }, { apiKey: "k", fetch: fakeFetch, cacheMs: 0 });
  assert.deepEqual(asked, [base.id, base.fallback!.id]);
  const s = r.sources[0];
  assert.equal(s.ok, true);
  assert.equal(s.via, "fallback");
  assert.equal(s.schema, "uniswap-v3-official");
  assert.match(s.primary_error!, /bad indexers/);
  assert.equal(r.pools.length, 1);
  assert.equal(r.pools[0].fee_percent, 0.3);
  assert.equal(r.pools[0].subgraph, base.fallback!.id);
});

const market = (id: string, symbol: string, over: Record<string, unknown> = {}) => ({
  id, name: `Aave ${symbol}`, isActive: true, canBorrowFrom: true, maximumLTV: "75",
  totalValueLockedUSD: "1000000", totalDepositBalanceUSD: "1000000", totalBorrowBalanceUSD: "800000",
  inputToken: { id: `0x${id}`, symbol, decimals: 6, lastPriceUSD: "1" },
  rates: [{ rate: "3.52", side: "LENDER", type: "VARIABLE" }, { rate: "4.28", side: "BORROWER", type: "VARIABLE" }, { rate: "0", side: "BORROWER", type: "STABLE" }],
  ...over,
});
const aave: Source = { protocol: "aave-v3", chain: "arbitrum", chainId: 42161, id: "sub-aave" };

test("normalizeMarkets: rates by side, utilization, frozen and off-token markets dropped", () => {
  const rows = normalizeMarkets(aave, {
    matching: [
      market("m1", "USDC"),
      market("m2", "USDC", { isActive: false }),
      market("m3", "WETH"),
      market("m4", "USDC.e", { canBorrowFrom: false, rates: [{ rate: "99999", side: "LENDER", type: "VARIABLE" }] }),
    ],
  }, ["USDC"]);
  assert.deepEqual(rows.map((m) => m.market), ["m1", "m4"]);
  const [m1, m4] = rows;
  assert.equal(m1.supply_apy_percent, 3.52);
  assert.equal(m1.borrow_apy_percent, 4.28);
  assert.equal(m1.stable_borrow_apy_percent, null, "a zero stable rate means stable borrowing is off");
  assert.equal(m1.utilization_percent, 80);
  assert.equal(m1.max_ltv_percent, 75);
  assert.equal(m4.borrow_apy_percent, null, "no borrow rate where borrowing is off");
  assert.equal(m4.supply_apy_percent, null, "an absurd rate is dropped, not reported");
  assert.equal(normalizeMarkets(aave, { matching: [market("m2", "USDC", { isActive: false })] }, [], false).length, 1, "frozen markets on request");
});

test("sortMarkets: best supply first, cheapest borrow first", () => {
  const rows = normalizeMarkets(aave, {
    all: [
      market("hi", "USDC", { rates: [{ rate: "9", side: "LENDER", type: "VARIABLE" }, { rate: "12", side: "BORROWER", type: "VARIABLE" }] }),
      market("lo", "USDC", { rates: [{ rate: "1", side: "LENDER", type: "VARIABLE" }, { rate: "2", side: "BORROWER", type: "VARIABLE" }] }),
      market("none", "USDC", { canBorrowFrom: false, rates: [{ rate: "5", side: "LENDER", type: "VARIABLE" }] }),
    ],
  });
  assert.deepEqual(sortMarkets(rows, "supply_apy").map((m) => m.market), ["hi", "none", "lo"]);
  assert.deepEqual(sortMarkets(rows, "borrow_apy").map((m) => m.market), ["lo", "hi", "none"]);
  const q = parseMarketQuery({ token: "USDC", sort: "borrow_apy", active: "false" });
  assert.deepEqual(q.tokens, ["USDC"]);
  assert.equal(q.sort, "borrow_apy");
  assert.equal(q.activeOnly, false);
  assert.equal(parseMarketQuery({}).sort, "supply_apy");
});

test("queryMarkets: one lending document everywhere, merged and sorted", async () => {
  resetSourceHealth();
  const queries = new Set<string>();
  let calls = 0;
  const fakeFetch = (async (url: string, init: any) => {
    calls++;
    queries.add(JSON.parse(init.body).query);
    const id = url.split("/").pop()!;
    const supply = String((id.charCodeAt(0) % 9) + 1);
    return json({ data: { protocol: [{ schemaVersion: "3.1.0" }], matching: [market(id.slice(0, 5), "USDC", { rates: [{ rate: supply, side: "LENDER", type: "VARIABLE" }] })] } });
  }) as unknown as typeof fetch;
  const r = await queryMarkets({ tokens: ["USDC"], first: 4 }, { apiKey: "k", fetch: fakeFetch, cacheMs: 0 });
  assert.equal(calls, LENDING_SOURCES.length);
  assert.equal(queries.size, 1, "the same query to every lending subgraph");
  assert.equal(r.markets.length, 4);
  assert.ok(r.markets.every((m, i, a) => i === 0 || (a[i - 1].supply_apy_percent ?? 0) >= (m.supply_apy_percent ?? 0)));
  assert.equal(r.sources.filter((s) => s.ok).length, LENDING_SOURCES.length);
});

test("countEntities counts every object in the answer", () => {
  assert.equal(countEntities({ pools: [{ id: "1", token0: { symbol: "A" } }, { id: "2", token0: { symbol: "B" } }], _meta: { block: { number: 1 } } }), 6);
  assert.equal(countEntities({ pools: [] }), 0);
  assert.equal(countEntities(null), 0);
});

test("checkGraphqlBody takes read-only queries of sane size", () => {
  assert.equal(checkGraphqlBody({}).ok, false);
  assert.equal(checkGraphqlBody({ query: "mutation { x }" }).ok, false);
  assert.equal(checkGraphqlBody({ query: "{ a }".repeat(5000) }).ok, false);
  const ok = checkGraphqlBody({ query: "query P($n: Int!) { pools(first: $n) { id } }", variables: { n: 3 }, operationName: "P" });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.payload, { query: "query P($n: Int!) { pools(first: $n) { id } }", variables: { n: 3 }, operationName: "P" });
  assert.match("QmTZ8ejXJxRo7vDBS4uwqBeGoxLSWbhaA7oXa1RvxunLy7", DEPLOYMENT_ID);
});

test("chain presets: Base Sepolia and Solana devnet settle in 6-decimal USDC", () => {
  assert.equal(CHAINS["base-sepolia"].network, "eip155:84532");
  assert.equal(CHAINS["solana-devnet"].network, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  assert.equal(decimalsFor("eip155:84532"), 6);
  assert.equal(decimalsFor("hedera:testnet"), 8);
  assert.ok(USDC["eip155:84532"].startsWith("0x"));
  assert.equal(explorerTx(CHAINS["solana-devnet"], "sig"), "https://solscan.io/tx/sig?cluster=devnet");
  assert.equal(explorerTx(CHAINS["base-sepolia"], "0xabc"), "https://sepolia.basescan.org/tx/0xabc");
});

test("EVM verification counts only USDC Transfer logs to the seller", () => {
  const payTo = "0x1111111111111111111111111111111111111111";
  const topicTo = "0x" + payTo.slice(2).padStart(64, "0");
  const usdc = USDC["eip155:84532"];
  const receipt = {
    logs: [
      { address: usdc, topics: [ERC20_TRANSFER, "0x" + "2".repeat(64), topicTo], data: "0x" + (1234).toString(16) },
      { address: "0xdeadbeef00000000000000000000000000000000", topics: [ERC20_TRANSFER, "0x" + "2".repeat(64), topicTo], data: "0x99" },
      { address: usdc, topics: [ERC20_TRANSFER, "0x" + "2".repeat(64), "0x" + "3".repeat(64)], data: "0x99" },
    ],
  };
  assert.equal(evmCredited(receipt, payTo, usdc), 1234n);
});

test("Solana verification is the seller's USDC balance change", () => {
  const mint = USDC["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"];
  const tx = {
    meta: {
      preTokenBalances: [{ owner: "seller", mint, uiTokenAmount: { amount: "1000" } }, { owner: "buyer", mint, uiTokenAmount: { amount: "9000" } }],
      postTokenBalances: [{ owner: "seller", mint, uiTokenAmount: { amount: "1500" } }, { owner: "buyer", mint, uiTokenAmount: { amount: "8500" } }],
    },
  };
  assert.equal(solanaCredited(tx, "seller", mint), 500n);
  assert.equal(solanaCredited(tx, "buyer", mint), -500n);
});
