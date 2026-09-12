// The DEX analyst: an agent that pays for everything it knows.
//
// Ask a liquidity question in plain words ("where can USDC earn the most fees
// against ETH?", "swap $5k USDC to ETH on the deepest chain"). It then
//
//   1. plans a query with an LLM                              paid per token  (llm)
//   2. reads pools from The Graph's standardized DEX subgraphs paid per pool   (dex-pools)
//   3. prices the trade with the Uniswap Trading API          paid per quote  (uniswap-quote)
//   4. reasons over the numbers with the LLM                  paid per token  (llm)
//
// Every step is an x402 payment through the MeterX402 SDK, so it is capped by
// the buyer's budget, metered by what it returned, and ends in a receipt. The
// report lists all of them next to the answer.
//
// The numbers the answer rests on (best pool, fee APR, route, price impact)
// are computed here, in code. The LLM only chooses what to look up and writes
// the prose around facts it was handed; without an LLM service the analyst
// still plans with rules and answers with those facts.

import type { CallResult, CallRequest, MeterX402 } from "../sdk/buyer.ts";
import { DEX_SOURCES, expandSymbol, type Pool, type PoolQuery } from "./standard.ts";

/** Chains the Uniswap Trading API quotes on that the standardized subgraphs also cover. */
export const UNISWAP_API_CHAINS = new Set([1, 10, 56, 137, 8453, 42161, 42220]);
const CHAIN_NAMES = [...new Set(DEX_SOURCES.map((s) => s.chain))];
const PROTOCOLS = [...new Set(DEX_SOURCES.map((s) => s.protocol))];
const STABLES = new Set(["USDC", "USDT", "DAI", "USDC.E", "USDBC"]);
const KNOWN = ["USDC", "USDT", "DAI", "WETH", "ETH", "WBTC", "CBBTC", "BTC", "ARB", "OP", "MATIC", "BNB", "UNI", "LINK"];
/** A placeholder swapper: quotes need an address, not a funded one. */
const QUOTE_SWAPPER = "0x000000000000000000000000000000000000dEaD";

export interface Trade {
  sell: string;
  buy: string;
  amount: number;
  amount_in: "usd" | "token";
}

export interface Plan {
  intent: string;
  pools: PoolQuery;
  trade: Trade | null;
}

export interface QuoteSummary {
  chain: string;
  chain_id: number;
  sell: string;
  buy: string;
  amount_in: number;
  amount_out: number;
  price: number;
  price_impact_percent: number | null;
  gas_usd: number | null;
  route: string | null;
  quote_id: string | null;
  /** CLASSIC (AMM route, swapper pays gas) or a UniswapX order type such as DUTCH_V2 (a filler pays gas). */
  routing: string | null;
  gasless: boolean;
  /** What the same trade would cost in gas on the classic route, when the API says. */
  classic_gas_usd: number | null;
}

export interface Spend {
  step: string;
  service: string;
  units: number | null;
  unit: string | null;
  amount: string | null;
  currency: string | null;
  network: string | null;
  tx: string | null;
}

export interface AnalystReport {
  question: string;
  planner: "llm" | "rules";
  plan: Plan;
  pools: Pool[];
  sources: { ok: number; total: number; failed: string[] };
  quote: QuoteSummary | null;
  facts: string[];
  answer: string;
  writer: "llm" | "facts";
  spend: Spend[];
  totals: Record<string, string>;
  skipped: string[];
}

export interface AnalystOptions {
  buyer: MeterX402;
  /** Service ids in the registry. Pass false to skip a step. */
  llm?: string | false;
  pools?: string;
  quote?: string | false;
  maxPools?: number;
  model?: string;
  onStep?: (step: string, detail?: unknown) => void;
}

// ── planning ──────────────────────────────────────────────────────────────

const canonical = (s: string) => (s.toUpperCase() === "ETH" ? "WETH" : s.toUpperCase() === "BTC" ? "WBTC" : s.toUpperCase());

/** Rules-only planner: the fallback, and the floor the LLM plan is checked against. */
export function rulePlan(question: string): Plan {
  const upper = question.toUpperCase();
  const lower = question.toLowerCase();
  // tokens in the order they are mentioned, ETH and WETH counted once
  const found = KNOWN
    .map((t) => ({ t, i: upper.search(new RegExp(`(^|[^A-Z])${t.replace(".", "\\.")}([^A-Z]|$)`)) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i)
    .map((x) => canonical(x.t));
  const tokens = [...new Set(found)].slice(0, 2);
  const chains = CHAIN_NAMES.filter((c) => lower.includes(c) || (c === "ethereum" && /\bmainnet\b|\bl1\b/.test(lower)) || (c === "bsc" && /\bbnb chain\b|\bbinance\b/.test(lower)));
  const protocols = PROTOCOLS.filter((p) => lower.includes(p.split("-")[0]));
  const sort: PoolQuery["sort"] = /yield|apr|apy|earn|fees?\b|farm|provide liquidity|\blp\b/.test(lower) ? "fee_apr" : /volume|busiest|most active|traded/.test(lower) ? "volume" : "tvl";
  const swap = /swap|trade|buy|sell|convert|exchange|route/.test(lower) && tokens.length === 2;
  let trade: Trade | null = null;
  if (swap) {
    const usd = lower.match(/\$\s*([\d,.]+)\s*(k|m)?|([\d,.]+)\s*(k|m)?\s*(usd|dollars)\b/);
    const tok = upper.match(new RegExp(`([\\d,.]+)\\s*(K|M)?\\s*(${KNOWN.join("|")})\\b`));
    const scale = (v: string, m?: string) => Number(v.replace(/,/g, "")) * (m?.toLowerCase() === "k" ? 1e3 : m?.toLowerCase() === "m" ? 1e6 : 1);
    if (usd) trade = { sell: tokens[0], buy: tokens[1], amount: scale(usd[1] ?? usd[3], usd[2] ?? usd[4]), amount_in: "usd" };
    else if (tok) trade = { sell: canonical(tok[3]), buy: tokens.find((t) => t !== canonical(tok[3])) ?? tokens[1], amount: scale(tok[1], tok[2]), amount_in: "token" };
    else trade = { sell: tokens[0], buy: tokens[1], amount: 1000, amount_in: "usd" };
    if (!(trade.amount > 0)) trade.amount = 1000;
  }
  return {
    intent: swap ? "swap" : sort === "fee_apr" ? "yield" : "liquidity",
    pools: { tokens, chains, protocols, sort, minTvlUsd: sort === "fee_apr" ? 250_000 : 50_000, first: 10 },
    trade,
  };
}

/** The LLM's JSON, checked field by field; anything off-menu falls back to the rules. */
export function mergePlan(raw: unknown, fallback: Plan): Plan {
  const j = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const strs = (v: unknown, allowed?: string[]) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter((s) => s && (!allowed || allowed.includes(s.toLowerCase()))) : null);
  const tokens = strs(j.tokens)?.map(canonical).filter((t) => /^[A-Z0-9.]{2,10}$/.test(t)).slice(0, 2);
  const chains = strs(j.chains, CHAIN_NAMES)?.map((s) => s.toLowerCase());
  const protocols = strs(j.protocols, PROTOCOLS)?.map((s) => s.toLowerCase());
  const sort = ["tvl", "volume", "fee_apr"].includes(j.sort) ? j.sort : fallback.pools.sort;
  const minTvl = Number(j.min_tvl_usd);
  const first = Number(j.first);
  const t = j.trade;
  const trade: Trade | null = t && typeof t === "object" && t.sell && t.buy && Number(t.amount) > 0
    ? { sell: canonical(String(t.sell)), buy: canonical(String(t.buy)), amount: Number(t.amount), amount_in: t.amount_in === "token" ? "token" : "usd" }
    : t === null ? null : fallback.trade;
  return {
    intent: typeof j.intent === "string" && j.intent.length < 40 ? j.intent : fallback.intent,
    pools: {
      tokens: tokens?.length ? tokens : fallback.pools.tokens,
      chains: chains ?? fallback.pools.chains,
      protocols: protocols ?? fallback.pools.protocols,
      sort,
      minTvlUsd: Number.isFinite(minTvl) && minTvl >= 0 ? minTvl : fallback.pools.minTvlUsd,
      first: Number.isFinite(first) && first > 0 ? Math.min(20, Math.floor(first)) : fallback.pools.first,
    },
    trade,
  };
}

/** First JSON object in a model's reply (they like to wrap it in prose or fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

// ── facts ─────────────────────────────────────────────────────────────────

const usd = (n: number | null | undefined) =>
  n == null ? "n/a" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(2)}`;
const pairOf = (p: Pool) => `${p.protocol}/${p.chain} ${p.tokens.join("-")}${p.fee_percent != null ? ` ${p.fee_percent}%` : ""}`;

/** What the answer is allowed to rest on. Deterministic, so it is tested. */
export function factsFor(plan: Plan, pools: Pool[], quote: QuoteSummary | null, sources: AnalystReport["sources"]): string[] {
  const facts: string[] = [];
  const chains = new Set(pools.map((p) => p.chain));
  facts.push(`${pools.length} pools from ${sources.ok}/${sources.total} standardized subgraphs (Messari DEX AMM schema) across ${chains.size} chain(s)${sources.failed.length ? `; unavailable: ${sources.failed.join(", ")}` : ""}.`);
  if (!pools.length) return facts;
  const byTvl = [...pools].sort((a, b) => b.tvl_usd - a.tvl_usd)[0];
  facts.push(`Deepest: ${pairOf(byTvl)} with ${usd(byTvl.tvl_usd)} TVL.`);
  // a yield claim needs depth behind it, whatever floor the plan asked for
  const floor = Math.max(plan.pools.minTvlUsd ?? 0, 100_000);
  const solid = pools.filter((p) => p.fee_apr_percent != null && p.tvl_usd >= floor);
  const bestApr = [...solid].sort((a, b) => (b.fee_apr_percent ?? 0) - (a.fee_apr_percent ?? 0))[0];
  if (bestApr) facts.push(`Highest fee APR with TVL ≥ ${usd(floor)}: ${pairOf(bestApr)} at ${bestApr.fee_apr_percent}% (24h volume ${usd(bestApr.volume_24h_usd)}, TVL ${usd(bestApr.tvl_usd)}).`);
  const busiest = [...pools].filter((p) => p.volume_24h_usd != null).sort((a, b) => (b.volume_24h_usd ?? 0) - (a.volume_24h_usd ?? 0))[0];
  if (busiest && busiest !== bestApr) facts.push(`Most traded today: ${pairOf(busiest)} with ${usd(busiest.volume_24h_usd)} in 24h.`);
  if (chains.size > 1) {
    // a chain whose best pool holds pocket change says nothing about depth there
    const perChain = [...chains].map((c) => pools.filter((p) => p.chain === c).sort((a, b) => b.tvl_usd - a.tvl_usd)[0]).filter((p) => p.tvl_usd >= 1000);
    if (perChain.length > 1) facts.push(`Best pool per chain by TVL: ${perChain.map((p) => `${p.chain} ${usd(p.tvl_usd)} (${p.protocol} ${p.fee_percent ?? "?"}%)`).join("; ")}.`);
  }
  const thin = pools.filter((p) => (p.fee_apr_percent ?? 0) > 100 && p.tvl_usd < 250_000);
  if (thin.length) facts.push(`Caution: ${thin.length} pool(s) show >100% fee APR on under $250k TVL, which usually means one day of unusual volume, not a lasting yield.`);
  const stale = pools.filter((p) => p.volume_24h_usd == null).length;
  if (stale) facts.push(`${stale} pool(s) have no daily snapshot from the last two days, so no volume or APR is claimed for them.`);
  if (quote) {
    // only what the API actually returned: a missing field is left out, never guessed
    const parts = [`${fmtNum(quote.amount_in)} ${quote.sell} → ${fmtNum(quote.amount_out)} ${quote.buy} (${fmtNum(quote.price)} ${quote.buy} per ${quote.sell})`];
    // hand the model the dollar price so it has no reason to estimate one
    const stableIn = STABLES.has(quote.sell.toUpperCase()), stableOut = STABLES.has(quote.buy.toUpperCase());
    if (stableIn && !stableOut && quote.amount_out > 0) parts.push(`implied ${quote.buy} price $${fmtNum(quote.amount_in / quote.amount_out)}`);
    if (stableOut && !stableIn && quote.amount_in > 0) parts.push(`implied ${quote.sell} price $${fmtNum(quote.amount_out / quote.amount_in)}`);
    if (quote.gasless) {
      parts.push(`routed as a gasless UniswapX order (${quote.routing}), so a filler pays gas${quote.classic_gas_usd != null ? `; the classic AMM route would cost about $${quote.classic_gas_usd.toFixed(4)} in gas` : ""}`);
    } else {
      if (quote.route) parts.push(`route ${quote.route}`);
      if (quote.price_impact_percent != null) parts.push(`price impact ${quote.price_impact_percent}%`);
      if (quote.gas_usd != null) parts.push(`gas about $${quote.gas_usd.toFixed(4)}`);
    }
    facts.push(`Uniswap Trading API on ${quote.chain}: ${parts.join("; ")}.`);
  }
  return facts;
}

const fmtNum = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : Number(n.toPrecision(6)).toString());

// ── quoting ───────────────────────────────────────────────────────────────

/** The trade as a Uniswap Trading API /quote body, on the best chain the pools found. */
export function quoteRequest(trade: Trade, pools: Pool[]): { body: Record<string, unknown>; chain: string; chainId: number; decimalsOut: number; amountIn: number } | null {
  const sells = expandSymbol(trade.sell), buys = expandSymbol(trade.buy);
  const idx = (p: Pool, alts: string[]) => p.tokens.findIndex((s) => alts.includes(s.toUpperCase()));
  const candidates = pools
    .filter((p) => UNISWAP_API_CHAINS.has(p.chain_id) && idx(p, sells) >= 0 && idx(p, buys) >= 0)
    .sort((a, b) => b.tvl_usd - a.tvl_usd);
  const pool = candidates[0];
  if (!pool) return null;
  const i = idx(pool, sells), o = idx(pool, buys);
  const decIn = pool.token_decimals?.[i], decOut = pool.token_decimals?.[o];
  if (decIn == null || decOut == null) return null;
  const priceIn = pool.token_prices_usd?.[i] ?? (STABLES.has(pool.tokens[i].toUpperCase()) ? 1 : null);
  const amountIn = trade.amount_in === "token" ? trade.amount : priceIn ? trade.amount / priceIn : null;
  if (amountIn == null || !(amountIn > 0)) return null;
  const atomic = BigInt(Math.floor(amountIn * 10 ** Math.min(decIn, 12))) * 10n ** BigInt(Math.max(0, decIn - 12));
  return {
    chain: pool.chain,
    chainId: pool.chain_id,
    decimalsOut: decOut,
    amountIn,
    body: {
      type: "EXACT_INPUT", amount: atomic.toString(),
      tokenInChainId: pool.chain_id, tokenOutChainId: pool.chain_id,
      tokenIn: pool.token_addresses[i], tokenOut: pool.token_addresses[o],
      swapper: QUOTE_SWAPPER, slippageTolerance: 0.5, routingPreference: "BEST_PRICE",
    },
  };
}

export function summarizeQuote(data: any, req: NonNullable<ReturnType<typeof quoteRequest>>, trade: Trade): QuoteSummary | null {
  const q = data?.quote;
  if (!q?.output?.amount) return null;
  const out = Number(q.output.amount) / 10 ** req.decimalsOut;
  const routing = typeof data?.routing === "string" ? data.routing : null;
  // UniswapX orders (DUTCH_V2, DUTCH_V3, PRIORITY…) are filled by a solver who pays gas
  const gasless = routing != null && routing !== "CLASSIC";
  return {
    chain: req.chain, chain_id: req.chainId, sell: trade.sell, buy: trade.buy,
    amount_in: req.amountIn, amount_out: out, price: out / req.amountIn,
    price_impact_percent: q.priceImpact == null ? null : Number(q.priceImpact),
    gas_usd: gasless ? 0 : q.gasFeeUSD == null ? null : Number(q.gasFeeUSD),
    route: q.routeString ?? null, quote_id: q.quoteId ?? null,
    routing, gasless,
    classic_gas_usd: q.classicGasUseEstimateUSD == null ? null : Number(q.classicGasUseEstimateUSD),
  };
}

// ── the run ───────────────────────────────────────────────────────────────

function spendOf(step: string, service: string, r: CallResult): Spend {
  const rc = r.receipt;
  return {
    step, service,
    units: rc?.metered_units ?? null, unit: rc?.unit ?? null,
    amount: rc?.amount ?? null, currency: rc?.currency ?? null,
    network: rc?.network ?? null, tx: rc?.transaction_id ?? null,
  };
}

export async function analyze(question: string, opts: AnalystOptions): Promise<AnalystReport> {
  const q = question.trim();
  if (!q) throw new Error("ask a question, e.g. \"where can USDC earn the most fees against ETH?\"");
  const mx = opts.buyer;
  const llm = opts.llm === false ? null : opts.llm ?? "llm";
  const poolsService = opts.pools ?? "dex-pools";
  const quoteService = opts.quote === false ? null : opts.quote ?? "uniswap-quote";
  const model = opts.model ?? process.env.LLM_MODEL ?? "openai/gpt-oss-20b";
  const step = opts.onStep ?? (() => {});
  const spend: Spend[] = [];
  const skipped: string[] = [];

  const paid = async (name: string, service: string, req: CallRequest): Promise<CallResult | null> => {
    step(name);
    try {
      const r = await mx.call(service, req);
      spend.push(spendOf(name, service, r));
      if (!r.ok) { skipped.push(`${name}: ${service} answered HTTP ${r.status}`); return null; }
      return r;
    } catch (e) {
      skipped.push(`${name}: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
      return null;
    }
  };
  const chat = async (name: string, system: string, user: string, maxTokens: number) => {
    if (!llm) return null;
    const r = await paid(name, llm, {
      path: "/chat/completions", method: "POST",
      body: { model, temperature: 0.1, max_tokens: maxTokens, reasoning_effort: "low", messages: [{ role: "system", content: system }, { role: "user", content: user }] },
    });
    const content = (r?.data as any)?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content : null;
  };

  // 1. plan
  const rules = rulePlan(q);
  let plan = rules;
  let planner: AnalystReport["planner"] = "rules";
  const planText = await chat("plan", [
    "You turn a DeFi liquidity question into a data request. Reply with ONLY a JSON object:",
    `{"intent": "yield|swap|liquidity|compare", "tokens": [up to 2 token symbols], "chains": [subset of ${JSON.stringify(CHAIN_NAMES)}] or [], "protocols": [subset of ${JSON.stringify(PROTOCOLS)}] or [], "sort": "tvl|volume|fee_apr", "min_tvl_usd": number, "first": number (max 20), "trade": null or {"sell": symbol, "buy": symbol, "amount": number, "amount_in": "usd|token"}}`,
    "Empty chains/protocols means all. Use trade only when the user wants to swap or price a swap.",
  ].join("\n"), q, 400);
  const parsed = planText ? extractJson(planText) : null;
  if (parsed) { plan = mergePlan(parsed, rules); planner = "llm"; }
  if (opts.maxPools) plan.pools.first = Math.min(plan.pools.first ?? 10, opts.maxPools);

  // 2. data: one standardized query across every matching subgraph
  const query: Record<string, string> = { sort: plan.pools.sort ?? "tvl", first: String(plan.pools.first ?? 10), min_tvl: String(plan.pools.minTvlUsd ?? 50_000) };
  if (plan.pools.tokens?.length) query.tokens = plan.pools.tokens.join(",");
  if (plan.pools.chains?.length) query.chains = plan.pools.chains.join(",");
  if (plan.pools.protocols?.length) query.protocols = plan.pools.protocols.join(",");
  const data = await paid("pools", poolsService, { path: "/pools", method: "GET", query, maxUnits: plan.pools.first });
  const body = (data?.data ?? {}) as { pools?: Pool[]; sources?: { ok: boolean; protocol: string; chain: string }[] };
  const pools = Array.isArray(body.pools) ? body.pools : [];
  const reports = Array.isArray(body.sources) ? body.sources : [];
  const sources = { ok: reports.filter((s) => s.ok).length, total: reports.length, failed: reports.filter((s) => !s.ok).map((s) => `${s.protocol}/${s.chain}`) };

  // 3. act: an executable quote for the trade, on the deepest chain Uniswap's API serves
  let quote: QuoteSummary | null = null;
  if (plan.trade && quoteService) {
    const req = quoteRequest(plan.trade, pools);
    if (!req) skipped.push("quote: no pool with both tokens on a chain the Uniswap Trading API serves");
    else {
      const r = await paid("quote", quoteService, { path: "/quote", method: "POST", body: req.body });
      if (r) quote = summarizeQuote(r.data, req, plan.trade);
    }
  }

  // 4. reason: prose around facts computed above
  const facts = factsFor(plan, pools, quote, sources);
  const table = pools.slice(0, 12).map((p) => `${p.protocol},${p.chain},${p.tokens.join("-")},fee ${p.fee_percent ?? "?"}%,tvl ${Math.round(p.tvl_usd)},vol24h ${p.volume_24h_usd ?? "?"},apr ${p.fee_apr_percent ?? "?"}%`).join("\n");
  const prose = pools.length
    ? await chat("answer", "You are a concise DeFi analyst. Use ONLY the facts and rows given. Never compute, convert or estimate a number that is not written in them: no USD conversions of your own, no guesses about slippage or prices. Name pools as protocol/chain pair fee. Give a direct answer, one recommendation and one risk, in under 140 words. No markdown tables.", `Question: ${q}\n\nFacts:\n- ${facts.join("\n- ")}\n\nRows (protocol,chain,pair,fee,tvl,vol24h,apr):\n${table}`, 500)
    : null;

  const totals: Record<string, number> = {};
  for (const s of spend) if (s.amount && s.currency) totals[s.currency] = (totals[s.currency] ?? 0) + Number(s.amount);
  return {
    question: q, planner, plan, pools, sources, quote, facts,
    answer: prose ?? facts.join(" "), writer: prose ? "llm" : "facts",
    spend, skipped,
    totals: Object.fromEntries(Object.entries(totals).map(([c, v]) => [c, String(Number(v.toFixed(8)))])),
  };
}

/** Plain-text report for terminals and MCP clients. */
export function renderReport(r: AnalystReport): string {
  const lines = [
    r.answer, "",
    "Facts (computed from paid data):", ...r.facts.map((f) => `  • ${f}`), "",
    `Plan (${r.planner}): ${JSON.stringify(r.plan.pools)}${r.plan.trade ? ` trade ${JSON.stringify(r.plan.trade)}` : ""}`,
    "",
    "Paid:",
    ...r.spend.map((s) => `  ${s.step.padEnd(7)} ${s.service.padEnd(14)} ${s.units ?? "-"} ${s.unit ?? ""} → ${s.amount ?? "free"} ${s.currency ?? ""}${s.tx ? `  tx ${s.tx}` : ""}`),
    `  total: ${Object.entries(r.totals).map(([c, v]) => `${v} ${c}`).join(", ") || "nothing"}`,
  ];
  if (r.skipped.length) lines.push("", "Skipped:", ...r.skipped.map((s) => `  - ${s}`));
  return lines.join("\n");
}
