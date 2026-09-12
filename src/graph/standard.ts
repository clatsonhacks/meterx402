// The Graph, standardized: one query across many DEXes on many chains.
//
// The sources below implement Messari's DEX AMM schema, so the same GraphQL
// document runs unchanged against Uniswap v3 on seven chains, SushiSwap,
// PancakeSwap, Curve, Balancer, Camelot and Velodrome. The only thing that
// varies per source is the subgraph id. Without the standard each protocol
// would need its own query and its own field mapping (Uniswap's
// `pools.feeTier`, Curve's `pools.fee`, Balancer's `swapFee`...); with it, a
// "best pool for USDC/WETH anywhere" question is one fan-out and one sort.
//
// When a standardized subgraph is failing (indexers behind, no allocations),
// a Uniswap source falls back to Uniswap's own v3 subgraph for that chain.
// That one speaks a different schema, so it has its own query and is mapped
// into the same Pool shape, and the source report says so (`via: "fallback"`):
// a hand-mapped schema is exactly the work the standard exists to remove.
//
// Ids: messari/subgraphs deployment/deployment.json (status prod,
// decentralized-network query-id) and Uniswap's v3 subgraphs, each checked
// against The Graph gateway before it went in.

export type SchemaKind = "messari" | "uniswap-v3-official";

export interface Source {
  protocol: string;
  chain: string;
  chainId: number;
  id: string;
  /** Default: Messari's standardized schema. */
  kind?: SchemaKind;
  /** Asked only when this source fails. */
  fallback?: Source;
}

const uniswapOwn = (chain: string, chainId: number, id: string): Source => ({ protocol: "uniswap-v3", chain, chainId, id, kind: "uniswap-v3-official" });

export const DEX_SOURCES: Source[] = [
  { protocol: "uniswap-v3", chain: "ethereum", chainId: 1, id: "4cKy6QQMc5tpfdx8yxfYeb9TLZmgLQe44ddW1G7NwkA6", fallback: uniswapOwn("ethereum", 1, "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV") },
  { protocol: "uniswap-v3", chain: "arbitrum", chainId: 42161, id: "FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX", fallback: uniswapOwn("arbitrum", 42161, "FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM") },
  { protocol: "uniswap-v3", chain: "base", chainId: 8453, id: "FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS", fallback: uniswapOwn("base", 8453, "43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG") },
  { protocol: "uniswap-v3", chain: "optimism", chainId: 10, id: "EgnS9YE1avupkvCNj9fHnJxppfEmNNywYJtghqiu2pd9", fallback: uniswapOwn("optimism", 10, "Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj") },
  { protocol: "uniswap-v3", chain: "polygon", chainId: 137, id: "BvYimJ6vCLkk63oWZy7WB5cVDTVVMugUAF35RAUZpQXE", fallback: uniswapOwn("polygon", 137, "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm") },
  { protocol: "uniswap-v3", chain: "bsc", chainId: 56, id: "8f1KyiuNYiNGrjagzEVpf6k6KkPG517prtjdrJihgHw", fallback: uniswapOwn("bsc", 56, "F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2") },
  { protocol: "uniswap-v3", chain: "celo", chainId: 42220, id: "8cLf29KxAedWLVaEqjV8qKomdwwXQxjptBZFrqWNH5u2" },
  // no standardized deployment here: Uniswap's own subgraph, mapped
  uniswapOwn("avalanche", 43114, "GVH9h9KZ9CqheUEL93qMbq7QwgoBu32QXQDPR6bev4Eo"),
  { protocol: "sushiswap", chain: "ethereum", chainId: 1, id: "77jZ9KWeyi3CJ96zkkj5s1CojKPHt6XJKjLFzsDCd8Fd" },
  { protocol: "sushiswap", chain: "arbitrum", chainId: 42161, id: "9tSS5FaePZnjmnXnSKCCqKVLAqA6eGg6jA2oRojsXUbP" },
  { protocol: "sushiswap", chain: "polygon", chainId: 137, id: "B3Jt84tHJJjanE4W1YijyksTwtm7jqK8KcG5dcoc1ZNF" },
  { protocol: "pancakeswap-v3", chain: "bsc", chainId: 56, id: "A1BC1hzDsK4NTeXBpKQnDBphngpYZAwDUF7dEBfa3jHK" },
  { protocol: "curve-finance", chain: "ethereum", chainId: 1, id: "3fy93eAT56UJsRCEht8iFhfi6wjHWXtZ9dnnbQmvFopF" },
  { protocol: "balancer-v2", chain: "ethereum", chainId: 1, id: "794H6CNzdGF5YfBK9nPsUgGn7EBbdJSCTjgcKPEPyFnn" },
  { protocol: "camelot-v2", chain: "arbitrum", chainId: 42161, id: "E6J42xXvRQGsqcMEoWRkdeJjUTsWdcHL8khuFMY6CDAM" },
  { protocol: "velodrome-v2", chain: "optimism", chainId: 10, id: "A4Y1A82YhSLTn998BVVELC8eWzhi992k4ZitByvssxqA" },
];

/** The one document every standardized source answers. Only standard-schema fields. */
export const POOLS_QUERY = `query Pools($first: Int!, $minTvl: BigDecimal!, $symbols: [String!]!, $filter: Boolean!) {
  protocol: dexAmmProtocols(first: 1) { name slug network schemaVersion }
  all: liquidityPools(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc, where: { totalValueLockedUSD_gte: $minTvl }) @skip(if: $filter) { ...P }
  matching: liquidityPools(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc, where: { totalValueLockedUSD_gte: $minTvl, inputTokens_: { symbol_in: $symbols } }) @include(if: $filter) { ...P }
}
fragment P on LiquidityPool {
  id name totalValueLockedUSD cumulativeVolumeUSD
  inputTokens { id symbol decimals lastPriceUSD }
  fees { feePercentage feeType }
  dailySnapshots(first: 1, orderBy: timestamp, orderDirection: desc) { dailyVolumeUSD timestamp }
}`;

/** Uniswap's own v3 schema. It cannot filter by token symbol cheaply (nested
 *  filters time out and `or` cannot sit beside column filters), so it returns
 *  the top pools by TVL and the token check happens in code. */
export const UNISWAP_V3_POOLS_QUERY = `query Pools($first: Int!, $minTvl: BigDecimal!) {
  bundle(id: "1") { ethPriceUSD }
  pools(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc, where: { totalValueLockedUSD_gte: $minTvl, totalValueLockedUSD_lt: "5000000000" }) {
    id feeTier totalValueLockedUSD
    token0 { id symbol decimals derivedETH }
    token1 { id symbol decimals derivedETH }
    poolDayData(first: 1, orderBy: date, orderDirection: desc) { date volumeUSD }
  }
}`;

/** Symbols people type, and what tokens actually call themselves onchain. */
const ALIASES: Record<string, string[]> = {
  ETH: ["WETH", "ETH"],
  WETH: ["WETH", "ETH"],
  BTC: ["WBTC", "CBBTC", "BTCB", "TBTC"],
  USDC: ["USDC", "USDC.E", "USDBC"],
  USD: ["USDC", "USDC.E", "USDBC", "USDT", "DAI"],
  MATIC: ["WMATIC", "MATIC", "POL", "WPOL"],
  BNB: ["WBNB", "BNB"],
  AVAX: ["WAVAX", "AVAX"],
};
export const expandSymbol = (s: string): string[] => ALIASES[s.toUpperCase()] ?? [s.toUpperCase()];

export interface PoolQuery {
  chains?: string[];
  protocols?: string[];
  /** Every token in the list must be in the pool, e.g. ["USDC", "ETH"]. */
  tokens?: string[];
  minTvlUsd?: number;
  /** Rows returned overall, after the cross-source sort. */
  first?: number;
  sort?: "tvl" | "volume" | "fee_apr";
}

export interface Pool {
  protocol: string;
  chain: string;
  chain_id: number;
  pool: string;
  name: string | null;
  tokens: string[];
  token_addresses: string[];
  token_decimals: number[];
  token_prices_usd: (number | null)[];
  tvl_usd: number;
  volume_24h_usd: number | null;
  fee_percent: number | null;
  /** 24h volume × trading fee, annualised over TVL. A rough yield signal, not a promise. */
  fee_apr_percent: number | null;
  subgraph: string;
}

export interface SourceReport {
  protocol: string;
  chain: string;
  subgraph: string;
  ok: boolean;
  ms: number;
  rows: number;
  /** "messari" (standardized) or the protocol's own schema, mapped. */
  schema: SchemaKind;
  schema_version?: string;
  /** "fallback" when the standardized subgraph failed and the protocol's own answered. */
  via?: "fallback";
  primary_error?: string;
  error?: string;
}

export interface PoolsResult {
  query: Required<Pick<PoolQuery, "first" | "sort">> & PoolQuery;
  pools: Pool[];
  sources: SourceReport[];
}

/** Query string or JSON body → a list, accepting "USDC/ETH" and "a,b". */
export const listParam = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[,/]/) : []).map((x) => x.trim()).filter(Boolean);
export const numParam = (v: unknown): number | undefined => (v == null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

/** Query string or JSON body → PoolQuery. Accepts "USDC/ETH" as a pair. */
export function parsePoolQuery(p: Record<string, unknown>): PoolQuery {
  const sort = String(p.sort ?? "tvl");
  return {
    chains: listParam(p.chains ?? p.chain),
    protocols: listParam(p.protocols ?? p.protocol),
    tokens: listParam(p.tokens ?? p.token ?? p.pair),
    minTvlUsd: numParam(p.min_tvl ?? p.minTvlUsd),
    first: numParam(p.first ?? p.limit),
    sort: (["tvl", "volume", "fee_apr"].includes(sort) ? sort : "tvl") as PoolQuery["sort"],
  };
}

export function pickSources(q: { chains?: string[]; protocols?: string[] }, all = DEX_SOURCES): Source[] {
  const want = (list: string[] | undefined, v: string) => !list?.length || list.some((x) => v.toLowerCase().startsWith(x.toLowerCase()));
  return all.filter((s) => want(q.chains, s.chain) && want(q.protocols, s.protocol));
}

export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** A pool "worth" more than $5B is a mispriced meme token, not liquidity. */
const MAX_SANE_TVL = 5e9;
const TWO_DAYS = 2 * 86400;

function poolRow(source: Source, p: {
  id: unknown; name: string | null; tokens: any[]; prices: (number | null)[];
  tvl: number; volume: number | null; fee: number | null;
}): Pool {
  const apr = p.volume != null && p.fee != null && p.tvl > 0 ? (p.volume * (p.fee / 100) * 365 * 100) / p.tvl : null;
  return {
    protocol: source.protocol,
    chain: source.chain,
    chain_id: source.chainId,
    pool: String(p.id),
    name: p.name,
    tokens: p.tokens.map((t) => String(t.symbol ?? "?")),
    token_addresses: p.tokens.map((t) => String(t.id)),
    token_decimals: p.tokens.map((t) => Number(t.decimals ?? 18)),
    token_prices_usd: p.prices,
    tvl_usd: round(p.tvl, 2),
    volume_24h_usd: p.volume == null ? null : round(p.volume, 2),
    fee_percent: p.fee,
    fee_apr_percent: apr == null ? null : round(apr, 2),
    subgraph: source.id,
  };
}

const keepPools = (pools: Pool[], tokens: string[]) => {
  const wanted = tokens.map(expandSymbol);
  return pools.filter((p) => p.tvl_usd <= MAX_SANE_TVL && wanted.every((alts) => p.tokens.some((s) => alts.includes(s.toUpperCase()))));
};

/** A standardized subgraph's answer → rows in the shared shape. Pure, so it is tested. */
export function normalize(source: Source, data: any, tokens: string[] = [], now = Date.now()): Pool[] {
  const raw: any[] = data?.matching ?? data?.all ?? [];
  return keepPools(raw.map((p) => {
    const snap = p.dailySnapshots?.[0];
    // a snapshot older than two days says nothing about "today"
    const fresh = snap && now / 1000 - num(snap.timestamp) < TWO_DAYS;
    const trading = (p.fees ?? []).find((f: any) => f.feeType === "FIXED_TRADING_FEE" || f.feeType === "DYNAMIC_TRADING_FEE");
    const inputs = p.inputTokens ?? [];
    return poolRow(source, {
      id: p.id, name: p.name ?? null, tokens: inputs,
      prices: inputs.map((t: any) => (t.lastPriceUSD == null ? null : num(t.lastPriceUSD))),
      tvl: num(p.totalValueLockedUSD), volume: fresh ? num(snap.dailyVolumeUSD) : null,
      fee: trading?.feePercentage != null ? num(trading.feePercentage) : null,
    });
  }), tokens);
}

/** Uniswap's own v3 subgraph → the same shape: feeTier is in hundredths of a
 *  basis point, prices are in ETH and converted with the subgraph's bundle. */
export function normalizeUniswapV3(source: Source, data: any, tokens: string[] = [], now = Date.now()): Pool[] {
  const native = num(data?.bundle?.ethPriceUSD);
  return keepPools((data?.pools ?? []).map((p: any) => {
    const pair = [p.token0 ?? {}, p.token1 ?? {}];
    const day = p.poolDayData?.[0];
    const fresh = day && now / 1000 - num(day.date) < TWO_DAYS;
    const fee = p.feeTier == null ? null : num(p.feeTier) / 10_000;
    return poolRow(source, {
      id: p.id, name: `${pair[0].symbol ?? "?"}/${pair[1].symbol ?? "?"}${fee != null ? ` ${fee}%` : ""}`, tokens: pair,
      prices: pair.map((t) => (native > 0 && t.derivedETH != null ? round(num(t.derivedETH) * native, 6) : null)),
      tvl: num(p.totalValueLockedUSD), volume: fresh ? num(day.volumeUSD) : null, fee,
    });
  }), tokens);
}

export function sortPools(pools: Pool[], sort: PoolQuery["sort"] = "tvl"): Pool[] {
  const key = (p: Pool) => (sort === "volume" ? p.volume_24h_usd ?? -1 : sort === "fee_apr" ? p.fee_apr_percent ?? -1 : p.tvl_usd);
  return [...pools].sort((a, b) => key(b) - key(a));
}

export interface GraphOptions {
  apiKey: string;
  gateway?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  cacheMs?: number;
}

const cache = new Map<string, { at: number; value: { data: any; report: SourceReport } }>();
/** Sources that keep failing (indexers behind, no allocations) are rested so
 *  one sick subgraph does not make every paid query wait out its timeout. */
const health = new Map<string, { failures: number; until: number }>();
export const resetSourceHealth = () => { health.clear(); cache.clear(); };

async function querySource(source: Source, document: string, vars: Record<string, unknown>, opts: GraphOptions): Promise<{ data: any; report: SourceReport }> {
  const key = `${source.id}:${document.length}:${document.slice(0, 48)}:${JSON.stringify(vars)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (opts.cacheMs ?? 60_000)) return { data: hit.value.data, report: { ...hit.value.report } };
  const report: SourceReport = { protocol: source.protocol, chain: source.chain, subgraph: source.id, ok: false, ms: 0, rows: 0, schema: source.kind ?? "messari" };
  const sick = health.get(source.id);
  if (sick && Date.now() < sick.until) {
    report.error = `resting after ${sick.failures} failures, retry in ${Math.ceil((sick.until - Date.now()) / 1000)}s`;
    return { data: null, report };
  }
  const fail = (message: string) => {
    report.error = message.slice(0, 200);
    const failures = (sick?.failures ?? 0) + 1;
    // one miss is noise; from the second, back off 1, 2, 4… up to 10 minutes
    health.set(source.id, { failures, until: failures >= 2 ? Date.now() + Math.min(600_000, 60_000 * 2 ** (failures - 2)) : 0 });
    return { data: null, report };
  };
  const url = `${(opts.gateway ?? "https://gateway.thegraph.com").replace(/\/+$/, "")}/api/subgraphs/id/${source.id}`;
  const started = Date.now();
  try {
    const r = await (opts.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ query: document, variables: vars }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    });
    const j: any = await r.json().catch(() => ({}));
    report.ms = Date.now() - started;
    if (!r.ok || j.errors?.length) return fail(String(j.errors?.[0]?.message ?? `HTTP ${r.status}`));
    health.delete(source.id);
    report.ok = true;
    report.schema_version = j.data?.protocol?.[0]?.schemaVersion;
    cache.set(key, { at: Date.now(), value: { data: j.data, report: { ...report } } });
    return { data: j.data, report };
  } catch (e) {
    report.ms = Date.now() - started;
    return fail(String((e as Error)?.message ?? e));
  }
}

export interface SourcePlan<T> {
  document: string;
  vars: Record<string, unknown>;
  normalize: (data: any) => T[];
}

/** Ask every source its question in parallel; a failing source with a
 *  fallback asks that instead. One report per source, successes and failures alike. */
export async function fanOut<T>(sources: Source[], plan: (s: Source) => SourcePlan<T>, opts: GraphOptions): Promise<{ rows: T[]; sources: SourceReport[] }> {
  const results = await Promise.all(sources.map(async (s) => {
    const p = plan(s);
    const first = await querySource(s, p.document, p.vars, opts);
    if (first.data) {
      const rows = p.normalize(first.data);
      return { rows, report: { ...first.report, rows: rows.length } };
    }
    if (!s.fallback) return { rows: [] as T[], report: first.report };
    const fp = plan(s.fallback);
    const second = await querySource(s.fallback, fp.document, fp.vars, opts);
    if (!second.data) return { rows: [] as T[], report: { ...first.report, error: `${first.report.error}; fallback: ${second.report.error}` } };
    const rows = fp.normalize(second.data);
    return {
      rows,
      report: { ...second.report, protocol: s.protocol, chain: s.chain, rows: rows.length, via: "fallback" as const, primary_error: first.report.error, ms: first.report.ms + second.report.ms },
    };
  }));
  return { rows: results.flatMap((r) => r.rows), sources: results.map((r) => r.report) };
}

/** Ask every matching DEX subgraph the same question, in parallel. */
export async function queryPools(q: PoolQuery, opts: GraphOptions): Promise<PoolsResult> {
  const first = Math.max(1, Math.min(200, Math.floor(q.first ?? 20)));
  const sort = q.sort ?? "tvl";
  const tokens = (q.tokens ?? []).filter(Boolean);
  const symbols = [...new Set(tokens.flatMap(expandSymbol))];
  const minTvl = String(q.minTvlUsd ?? 10_000);
  // with a token filter the server narrows to pools holding ANY of them; the
  // "all of them" check happens in normalize, so over-fetch a little
  const standardVars = { first: Math.min(100, tokens.length > 1 ? first * 4 : first), minTvl, symbols: symbols.length ? symbols : [""], filter: symbols.length > 0 };
  const ownVars = { first: 100, minTvl };
  const { rows, sources } = await fanOut<Pool>(pickSources(q), (s) => s.kind === "uniswap-v3-official"
    ? { document: UNISWAP_V3_POOLS_QUERY, vars: ownVars, normalize: (d) => normalizeUniswapV3(s, d, tokens) }
    : { document: POOLS_QUERY, vars: standardVars, normalize: (d) => normalize(s, d, tokens) }, opts);
  return { query: { ...q, first, sort, tokens }, pools: sortPools(rows, sort).slice(0, first), sources };
}
