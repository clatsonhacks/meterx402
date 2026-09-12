// The Graph, standardized: one query across many DEXes on many chains.
//
// Every subgraph below implements Messari's DEX AMM schema, so the same
// GraphQL document runs unchanged against Uniswap v3 on seven chains,
// SushiSwap, PancakeSwap, Curve, Balancer, Camelot and Velodrome. The only
// thing that varies per source is the subgraph id. Without the standard each
// protocol would need its own query and its own field mapping (Uniswap's
// `pools.feeTier`, Curve's `pools.fee`, Balancer's `swapFee`...); with it, a
// "best pool for USDC/WETH anywhere" question is one fan-out and one sort.
//
// Ids come from messari/subgraphs deployment/deployment.json (status: prod,
// services.decentralized-network.query-id).

export interface Source {
  protocol: string;
  chain: string;
  chainId: number;
  id: string;
}

export const DEX_SOURCES: Source[] = [
  { protocol: "uniswap-v3", chain: "ethereum", chainId: 1, id: "4cKy6QQMc5tpfdx8yxfYeb9TLZmgLQe44ddW1G7NwkA6" },
  { protocol: "uniswap-v3", chain: "arbitrum", chainId: 42161, id: "FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX" },
  { protocol: "uniswap-v3", chain: "base", chainId: 8453, id: "FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS" },
  { protocol: "uniswap-v3", chain: "optimism", chainId: 10, id: "EgnS9YE1avupkvCNj9fHnJxppfEmNNywYJtghqiu2pd9" },
  { protocol: "uniswap-v3", chain: "polygon", chainId: 137, id: "BvYimJ6vCLkk63oWZy7WB5cVDTVVMugUAF35RAUZpQXE" },
  { protocol: "uniswap-v3", chain: "bsc", chainId: 56, id: "8f1KyiuNYiNGrjagzEVpf6k6KkPG517prtjdrJihgHw" },
  { protocol: "uniswap-v3", chain: "celo", chainId: 42220, id: "8cLf29KxAedWLVaEqjV8qKomdwwXQxjptBZFrqWNH5u2" },
  { protocol: "sushiswap", chain: "ethereum", chainId: 1, id: "77jZ9KWeyi3CJ96zkkj5s1CojKPHt6XJKjLFzsDCd8Fd" },
  { protocol: "sushiswap", chain: "arbitrum", chainId: 42161, id: "9tSS5FaePZnjmnXnSKCCqKVLAqA6eGg6jA2oRojsXUbP" },
  { protocol: "sushiswap", chain: "polygon", chainId: 137, id: "B3Jt84tHJJjanE4W1YijyksTwtm7jqK8KcG5dcoc1ZNF" },
  { protocol: "pancakeswap-v3", chain: "bsc", chainId: 56, id: "A1BC1hzDsK4NTeXBpKQnDBphngpYZAwDUF7dEBfa3jHK" },
  { protocol: "curve-finance", chain: "ethereum", chainId: 1, id: "3fy93eAT56UJsRCEht8iFhfi6wjHWXtZ9dnnbQmvFopF" },
  { protocol: "balancer-v2", chain: "ethereum", chainId: 1, id: "794H6CNzdGF5YfBK9nPsUgGn7EBbdJSCTjgcKPEPyFnn" },
  { protocol: "camelot-v2", chain: "arbitrum", chainId: 42161, id: "E6J42xXvRQGsqcMEoWRkdeJjUTsWdcHL8khuFMY6CDAM" },
  { protocol: "velodrome-v2", chain: "optimism", chainId: 10, id: "A4Y1A82YhSLTn998BVVELC8eWzhi992k4ZitByvssxqA" },
];

/** The one document every source answers. Only standard-schema fields. */
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

/** Symbols people type, and what tokens actually call themselves onchain. */
const ALIASES: Record<string, string[]> = {
  ETH: ["WETH", "ETH"],
  WETH: ["WETH", "ETH"],
  BTC: ["WBTC", "CBBTC", "BTCB", "TBTC"],
  USDC: ["USDC", "USDC.E", "USDBC"],
  USD: ["USDC", "USDC.E", "USDBC", "USDT", "DAI"],
  MATIC: ["WMATIC", "MATIC", "POL", "WPOL"],
  BNB: ["WBNB", "BNB"],
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
  pools: number;
  schema_version?: string;
  error?: string;
}

export interface PoolsResult {
  query: Required<Pick<PoolQuery, "first" | "sort">> & PoolQuery;
  pools: Pool[];
  sources: SourceReport[];
}

/** Query string or JSON body → PoolQuery. Accepts "USDC/ETH" as a pair. */
export function parsePoolQuery(p: Record<string, unknown>): PoolQuery {
  const list = (v: unknown) =>
    (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[,/]/) : []).map((x) => x.trim()).filter(Boolean);
  const n = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const sort = String(p.sort ?? "tvl");
  return {
    chains: list(p.chains ?? p.chain),
    protocols: list(p.protocols ?? p.protocol),
    tokens: list(p.tokens ?? p.token ?? p.pair),
    minTvlUsd: n(p.min_tvl ?? p.minTvlUsd),
    first: n(p.first ?? p.limit),
    sort: (["tvl", "volume", "fee_apr"].includes(sort) ? sort : "tvl") as PoolQuery["sort"],
  };
}

export function pickSources(q: Pick<PoolQuery, "chains" | "protocols">, all = DEX_SOURCES): Source[] {
  const want = (list: string[] | undefined, v: string) => !list?.length || list.some((x) => v.toLowerCase().startsWith(x.toLowerCase()));
  return all.filter((s) => want(q.chains, s.chain) && want(q.protocols, s.protocol));
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** One subgraph's answer → rows in the shared shape. Pure, so it is tested. */
export function normalize(source: Source, data: any, tokens: string[] = [], now = Date.now()): Pool[] {
  const raw: any[] = data?.matching ?? data?.all ?? [];
  const wanted = tokens.map(expandSymbol);
  return raw
    .map((p): Pool => {
      const symbols = (p.inputTokens ?? []).map((t: any) => String(t.symbol ?? "?"));
      const tvl = num(p.totalValueLockedUSD);
      const snap = p.dailySnapshots?.[0];
      // a snapshot older than two days says nothing about "today"
      const fresh = snap && now / 1000 - num(snap.timestamp) < 2 * 86400;
      const volume = fresh ? num(snap.dailyVolumeUSD) : null;
      const trading = (p.fees ?? []).find((f: any) => f.feeType === "FIXED_TRADING_FEE" || f.feeType === "DYNAMIC_TRADING_FEE");
      const fee = trading?.feePercentage != null ? num(trading.feePercentage) : null;
      const apr = volume != null && fee != null && tvl > 0 ? (volume * (fee / 100) * 365 * 100) / tvl : null;
      return {
        protocol: source.protocol,
        chain: source.chain,
        chain_id: source.chainId,
        pool: String(p.id),
        name: p.name ?? null,
        tokens: symbols,
        token_addresses: (p.inputTokens ?? []).map((t: any) => String(t.id)),
        token_decimals: (p.inputTokens ?? []).map((t: any) => Number(t.decimals ?? 18)),
        token_prices_usd: (p.inputTokens ?? []).map((t: any) => (t.lastPriceUSD == null ? null : num(t.lastPriceUSD))),
        tvl_usd: round(tvl, 2),
        volume_24h_usd: volume == null ? null : round(volume, 2),
        fee_percent: fee,
        fee_apr_percent: apr == null ? null : round(apr, 2),
        subgraph: source.id,
      };
    })
    // a pool "worth" more than $5B is a mispriced meme token, not liquidity
    .filter((p) => p.tvl_usd <= MAX_SANE_TVL && wanted.every((alts) => p.tokens.some((s) => alts.includes(s.toUpperCase()))));
}

const MAX_SANE_TVL = 5e9;

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

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

async function querySource(source: Source, vars: Record<string, unknown>, opts: GraphOptions) {
  const key = `${source.id}:${JSON.stringify(vars)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (opts.cacheMs ?? 60_000)) return hit.value;
  const report: SourceReport = { protocol: source.protocol, chain: source.chain, subgraph: source.id, ok: false, ms: 0, pools: 0 };
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
      body: JSON.stringify({ query: POOLS_QUERY, variables: vars }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    });
    const j: any = await r.json().catch(() => ({}));
    report.ms = Date.now() - started;
    if (!r.ok || j.errors?.length) return fail(String(j.errors?.[0]?.message ?? `HTTP ${r.status}`));
    health.delete(source.id);
    report.ok = true;
    report.schema_version = j.data?.protocol?.[0]?.schemaVersion;
    const value = { data: j.data, report };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    report.ms = Date.now() - started;
    return fail(String((e as Error)?.message ?? e));
  }
}

/** Ask every matching standardized subgraph the same question, in parallel. */
export async function queryPools(q: PoolQuery, opts: GraphOptions): Promise<PoolsResult> {
  const first = Math.max(1, Math.min(200, Math.floor(q.first ?? 20)));
  const sort = q.sort ?? "tvl";
  const tokens = (q.tokens ?? []).filter(Boolean);
  const symbols = [...new Set(tokens.flatMap(expandSymbol))];
  // with a token filter the server narrows to pools holding ANY of them; the
  // "all of them" check happens in normalize, so over-fetch a little
  const perSource = Math.min(100, tokens.length > 1 ? first * 4 : first);
  const vars = { first: perSource, minTvl: String(q.minTvlUsd ?? 10_000), symbols: symbols.length ? symbols : [""], filter: symbols.length > 0 };
  const sources = pickSources(q);
  const answers = await Promise.all(sources.map((s) => querySource(s, vars, opts)));
  const pools: Pool[] = [];
  answers.forEach(({ data, report }, i) => {
    if (!data) return;
    const rows = normalize(sources[i], data, tokens);
    report.pools = rows.length;
    pools.push(...rows);
  });
  return {
    query: { ...q, first, sort, tokens },
    pools: sortPools(pools, sort).slice(0, first),
    sources: answers.map((a) => a.report),
  };
}
