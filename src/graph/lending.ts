// The Graph, standardized, part two: lending markets.
//
// Messari's lending schema is shared by Aave, Compound, Spark, Venus, Benqi
// and Radiant, so "where does USDC earn the most, and where is it cheapest to
// borrow" is again one query and one sort. And because the DEX and lending
// schemas share their Token and USD conventions, the analyst can set a lending
// rate beside a pool's fee APR without converting anything: two standards
// composed, rather than a dozen protocol APIs stitched together.
//
// Ids: messari/subgraphs deployment.json (schema lending, status prod), each
// checked against The Graph gateway; Aave v3 on Base had no indexer
// allocations and is left out.

import { expandSymbol, fanOut, listParam, num, numParam, pickSources, round, type GraphOptions, type Source, type SourceReport } from "./standard.ts";

export const LENDING_SOURCES: Source[] = [
  { protocol: "aave-v3", chain: "ethereum", chainId: 1, id: "JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk" },
  { protocol: "aave-v3", chain: "arbitrum", chainId: 42161, id: "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf" },
  { protocol: "aave-v3", chain: "optimism", chainId: 10, id: "3RWFxWNstn4nP3dXiDfKi9GgBoHx7xzc7APkXs1MLEgi" },
  { protocol: "aave-v3", chain: "polygon", chainId: 137, id: "6yuf1C49aWEscgk5n9D1DekeG1BCk5Z9imJYJT3sVmAT" },
  { protocol: "aave-v3", chain: "avalanche", chainId: 43114, id: "72Cez54APnySAn6h8MswzYkwaL9KjvuuKnKArnPJ8yxb" },
  { protocol: "aave-v3", chain: "bsc", chainId: 56, id: "43jbGkvSw55sMvYyF6MZieksmJbajMu3hNGF8PN9ucuP" },
  { protocol: "aave-v3", chain: "gnosis", chainId: 100, id: "GiNMLDxT1Bdn2dQZxjQLmW24uwpc3geKUBW8RP6oEdg" },
  { protocol: "compound-v3", chain: "ethereum", chainId: 1, id: "AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9" },
  { protocol: "compound-v3", chain: "arbitrum", chainId: 42161, id: "5MjRndNWGhqvNX7chUYLQDnvEgc8DaH8eisEkcJt71SR" },
  { protocol: "compound-v3", chain: "polygon", chainId: 137, id: "5wfoWBpfYv59b99wDxJmyFiKBu9brXESeqJAzw8WP5Cz" },
  { protocol: "compound-v2", chain: "ethereum", chainId: 1, id: "4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a" },
  { protocol: "spark-lend", chain: "ethereum", chainId: 1, id: "GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si" },
  { protocol: "venus", chain: "bsc", chainId: 56, id: "CwswJ7sfENafqgAYU1upn3hQgoEV2CXXRZRJ7XtgJrKG" },
  { protocol: "benqi", chain: "avalanche", chainId: 43114, id: "8ZjJGsaKea7WwLJPJNdHXPGsvXDe3iq2231aRjgBPisi" },
  { protocol: "radiant", chain: "arbitrum", chainId: 42161, id: "5HTkKJNSm72tUGakwj8yroDGHxc6fBhmLaA5oJepZGL3" },
];

/** The one document every lending source answers. */
export const MARKETS_QUERY = `query Markets($first: Int!, $minTvl: BigDecimal!, $symbols: [String!]!, $filter: Boolean!) {
  protocol: lendingProtocols(first: 1) { name slug network schemaVersion }
  all: markets(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc, where: { totalValueLockedUSD_gte: $minTvl }) @skip(if: $filter) { ...M }
  matching: markets(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc, where: { totalValueLockedUSD_gte: $minTvl, inputToken_: { symbol_in: $symbols } }) @include(if: $filter) { ...M }
}
fragment M on Market {
  id name isActive canBorrowFrom canUseAsCollateral maximumLTV liquidationThreshold
  totalValueLockedUSD totalDepositBalanceUSD totalBorrowBalanceUSD
  inputToken { id symbol decimals lastPriceUSD }
  rates { rate side type }
}`;

export interface LendingMarket {
  protocol: string;
  chain: string;
  chain_id: number;
  market: string;
  name: string | null;
  token: string;
  token_address: string;
  token_decimals: number;
  token_price_usd: number | null;
  /** What a depositor earns, APY %. */
  supply_apy_percent: number | null;
  /** What a variable-rate borrower pays, APY %. Null where borrowing is off. */
  borrow_apy_percent: number | null;
  stable_borrow_apy_percent: number | null;
  tvl_usd: number;
  deposits_usd: number;
  borrows_usd: number;
  utilization_percent: number | null;
  max_ltv_percent: number | null;
  can_borrow: boolean;
  active: boolean;
  subgraph: string;
}

export interface MarketQuery {
  chains?: string[];
  protocols?: string[];
  /** Markets for ANY of these tokens. */
  tokens?: string[];
  minTvlUsd?: number;
  first?: number;
  sort?: "supply_apy" | "borrow_apy" | "tvl";
  /** Leave out frozen or deprecated markets (default true). */
  activeOnly?: boolean;
}

export interface MarketsResult {
  query: Required<Pick<MarketQuery, "first" | "sort">> & MarketQuery;
  markets: LendingMarket[];
  sources: SourceReport[];
}

/** Rates above this are a broken oracle or an empty market, not an offer. */
const MAX_SANE_RATE = 1000;

/** One subgraph's markets → rows in the shared shape. Pure, so it is tested. */
export function normalizeMarkets(source: Source, data: any, tokens: string[] = [], activeOnly = true): LendingMarket[] {
  const raw: any[] = data?.matching ?? data?.all ?? [];
  const wanted = new Set(tokens.flatMap(expandSymbol));
  return raw
    .map((m): LendingMarket => {
      const rate = (side: string, type?: string) => {
        const r = (m.rates ?? []).find((x: any) => x.side === side && (!type || x.type === type));
        const v = r == null ? NaN : Number(r.rate);
        return Number.isFinite(v) && v >= 0 && v <= MAX_SANE_RATE ? round(v, 2) : null;
      };
      const deposits = num(m.totalDepositBalanceUSD), borrows = num(m.totalBorrowBalanceUSD);
      const t = m.inputToken ?? {};
      const stable = rate("BORROWER", "STABLE");
      return {
        protocol: source.protocol,
        chain: source.chain,
        chain_id: source.chainId,
        market: String(m.id),
        name: m.name ?? null,
        token: String(t.symbol ?? "?"),
        token_address: String(t.id ?? ""),
        token_decimals: Number(t.decimals ?? 18),
        token_price_usd: t.lastPriceUSD == null ? null : num(t.lastPriceUSD),
        supply_apy_percent: rate("LENDER", "VARIABLE") ?? rate("LENDER"),
        borrow_apy_percent: m.canBorrowFrom === false ? null : rate("BORROWER", "VARIABLE"),
        // Aave v3 keeps a stable-rate entry at 0 after disabling stable borrowing
        stable_borrow_apy_percent: stable && stable > 0 ? stable : null,
        tvl_usd: round(num(m.totalValueLockedUSD), 2),
        deposits_usd: round(deposits, 2),
        borrows_usd: round(borrows, 2),
        utilization_percent: deposits > 0 ? round((borrows / deposits) * 100, 2) : null,
        max_ltv_percent: m.maximumLTV == null ? null : num(m.maximumLTV),
        can_borrow: m.canBorrowFrom !== false,
        active: m.isActive !== false,
        subgraph: source.id,
      };
    })
    .filter((m) => (!activeOnly || m.active) && m.tvl_usd <= 1e11 && (!wanted.size || wanted.has(m.token.toUpperCase())));
}

export function sortMarkets(markets: LendingMarket[], sort: MarketQuery["sort"] = "supply_apy"): LendingMarket[] {
  const rows = [...markets];
  if (sort === "tvl") return rows.sort((a, b) => b.tvl_usd - a.tvl_usd);
  if (sort === "borrow_apy") return rows.sort((a, b) => (a.borrow_apy_percent ?? Infinity) - (b.borrow_apy_percent ?? Infinity));
  return rows.sort((a, b) => (b.supply_apy_percent ?? -1) - (a.supply_apy_percent ?? -1));
}

export function parseMarketQuery(p: Record<string, unknown>): MarketQuery {
  const sort = String(p.sort ?? "supply_apy");
  return {
    chains: listParam(p.chains ?? p.chain),
    protocols: listParam(p.protocols ?? p.protocol),
    tokens: listParam(p.tokens ?? p.token),
    minTvlUsd: numParam(p.min_tvl ?? p.minTvlUsd),
    first: numParam(p.first ?? p.limit),
    sort: (["supply_apy", "borrow_apy", "tvl"].includes(sort) ? sort : "supply_apy") as MarketQuery["sort"],
    activeOnly: String(p.active ?? "true") !== "false",
  };
}

/** Ask every matching lending subgraph the same question, in parallel. */
export async function queryMarkets(q: MarketQuery, opts: GraphOptions): Promise<MarketsResult> {
  const first = Math.max(1, Math.min(100, Math.floor(q.first ?? 20)));
  const sort = q.sort ?? "supply_apy";
  const tokens = (q.tokens ?? []).filter(Boolean);
  const symbols = [...new Set(tokens.flatMap(expandSymbol))];
  const vars = { first: Math.min(50, first * 2), minTvl: String(q.minTvlUsd ?? 100_000), symbols: symbols.length ? symbols : [""], filter: symbols.length > 0 };
  const { rows, sources } = await fanOut<LendingMarket>(pickSources(q, LENDING_SOURCES), (s) => ({
    document: MARKETS_QUERY, vars, normalize: (d) => normalizeMarkets(s, d, tokens, q.activeOnly !== false),
  }), opts);
  return { query: { ...q, first, sort, tokens }, markets: sortMarkets(rows, sort).slice(0, first), sources };
}
