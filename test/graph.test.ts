import { test } from "node:test";
import assert from "node:assert/strict";
import { DEX_SOURCES, expandSymbol, normalize, parsePoolQuery, pickSources, queryPools, sortPools, type Source } from "../src/graph/standard.ts";
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

test("every source id is a base58 subgraph id, unique per protocol+chain", () => {
  const seen = new Set<string>();
  for (const s of DEX_SOURCES) {
    assert.match(s.id, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/, `${s.protocol}/${s.chain}`);
    const k = `${s.protocol}:${s.chain}`;
    assert.ok(!seen.has(k), `duplicate ${k}`);
    seen.add(k);
  }
  assert.ok(new Set(DEX_SOURCES.map((s) => s.chain)).size >= 6, "spans at least six chains");
});

test("pickSources narrows by chain and protocol prefix", () => {
  assert.equal(pickSources({}).length, DEX_SOURCES.length);
  assert.ok(pickSources({ protocols: ["uniswap"] }).every((s) => s.protocol.startsWith("uniswap")));
  const base = pickSources({ chains: ["base"], protocols: ["uniswap-v3"] });
  assert.equal(base.length, 1);
  assert.equal(base[0].chainId, 8453);
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
  const bodies: any[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push({ url, body, auth: init.headers.authorization });
    if (url.includes(DEX_SOURCES[1].id)) return new Response(JSON.stringify({ errors: [{ message: "indexer unavailable" }] }), { status: 200 });
    const id = url.split("/").pop()!;
    return new Response(JSON.stringify({ data: { protocol: [{ schemaVersion: "4.0.1" }], matching: [pool(id.slice(0, 4), ["USDC", "WETH"], id.charCodeAt(0) * 1000, 10)] } }));
  }) as unknown as typeof fetch;
  const r = await queryPools({ protocols: ["uniswap-v3"], tokens: ["USDC", "ETH"], first: 3 }, { apiKey: "k", fetch: fakeFetch, cacheMs: 0 });
  const asked = pickSources({ protocols: ["uniswap-v3"] });
  assert.equal(bodies.length, asked.length);
  assert.ok(bodies.every((b) => b.body.query === bodies[0].body.query), "the same query everywhere");
  assert.ok(bodies.every((b) => b.auth === "Bearer k"));
  assert.equal(bodies[0].body.variables.filter, true);
  assert.equal(r.pools.length, 3);
  assert.ok(r.pools[0].tvl_usd >= r.pools[1].tvl_usd);
  const failed = r.sources.find((s) => !s.ok)!;
  assert.equal(failed.chain, DEX_SOURCES[1].chain);
  assert.match(failed.error!, /indexer unavailable/);
  assert.equal(r.sources.filter((s) => s.ok).length, asked.length - 1);
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
