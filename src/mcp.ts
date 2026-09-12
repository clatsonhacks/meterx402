// MeterX402 MCP adapter: any AI agent becomes a paying customer, with limits.
//
//   list_services     discover by capability, price, reputation
//   get_service       one service: descriptor, price, reputation
//   get_reputation    the ReputationRecord and the evidence behind it
//   get_quote         run the call and get its EXACT metered price — nothing paid yet
//   pay_for_service   pay a quote from get_quote (within budget) and get the result
//   call_service      quote + pay in one step
//
// MCP is an interface, not the payment protocol: every tool is a thin call into
// the MeterX402 SDK, so an MCP agent gets the same quotes, budgets, receipts and
// verification as any other client. (list_paid_apis / paid_fetch remain as
// aliases for older prompts.)
//
// Payments are signed by BUYER_* (or HEDERA_*) from .env, within BUYER_BUDGET.
// In the offline demo a throwaway key is registered with the mock facilitator.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadEnv } from "./env.ts";

loadEnv(); // Claude launches this process itself, so it never inherits a shell env

const { HUB_URL } = await import("./events.ts");
const { MeterX402, BudgetError } = await import("./sdk/buyer.ts");
type PendingQuote = import("./sdk/buyer.ts").PendingQuote;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));

// ── the buyer this MCP server pays as ─────────────────────────────────────
let mxP: Promise<InstanceType<typeof MeterX402> | null> | null = null;
async function makeBuyer() {
  const status = await fetch(`${HUB_URL}/status`).then((r) => r.json()).catch(() => null);
  let accountId = process.env.BUYER_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID;
  let privateKey: any = process.env.BUYER_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY;
  if (status?.mode === "offline") {
    const { PrivateKey } = await import("@hiero-ledger/sdk");
    const key = accountId && privateKey ? (await import("./hedera.ts")).parseHederaKey(privateKey) : PrivateKey.generateECDSA();
    accountId ??= "0.0.5002";
    privateKey = key;
    await fetch(`${status.facilitator}/accounts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId, publicKey: key.publicKey.toStringDer(), balance: String(100n * 100_000_000n) }),
    }).catch(() => {});
  }
  if (!accountId || !privateKey) return null;
  return new MeterX402({
    wallet: { accountId, privateKey },
    registry: HUB_URL,
    budget: process.env.BUYER_BUDGET ?? "1 HBAR",
    maxPerCall: process.env.BUYER_MAX_PER_CALL,
  });
}
const buyer = async () => { mxP ??= makeBuyer(); return mxP; };
const noWallet = () => text("Cannot pay: no buyer wallet. Set BUYER_ACCOUNT_ID and BUYER_PRIVATE_KEY (or HEDERA_*) in .env.", true);

// quotes waiting to be paid (they expire with the service's hold)
const pending = new Map<string, PendingQuote>();

const reqShape = {
  path: z.string().optional().describe("Path on the service (default: its sample path)"),
  method: z.string().optional().describe("GET or POST (default: the service's sample method)"),
  body: z.string().optional().describe("Request body for POST, as JSON text (default: the service's sample body)"),
  query: z.record(z.string(), z.string()).optional().describe("Query parameters"),
  max_units: z.number().int().positive().optional().describe("Cap the work: max billable units (tokens, rows, …)"),
};
const toReq = (a: { path?: string; method?: string; body?: string; query?: Record<string, string>; max_units?: number }, maxPrice?: number) =>
  ({ path: a.path, method: a.method, body: a.body, query: a.query, maxUnits: a.max_units, maxPrice });

function summarize(r: import("./sdk/buyer.ts").CallResult) {
  const lines: string[] = [];
  if (r.receipt) {
    lines.push(`PAID ${r.receipt.amount} ${r.receipt.currency} for ${r.receipt.metered_units} ${r.receipt.unit} (${r.receipt.rate} per ${r.receipt.per}) — ${r.receipt.scheme} settlement on ${r.receipt.network}${r.receipt.transaction_id ? `, tx ${r.receipt.transaction_id}` : ""}`);
  } else if (r.ok) lines.push("Served free (nothing billable).");
  if (r.verification) {
    lines.push(`verified: body hash ${r.verification.bodyHash ? "matches the quote" : "DOES NOT match"}; re-metered ${r.verification.remetered ?? "n/a"} (${r.verification.unitsMatch === false ? "MISMATCH" : r.verification.method})`);
  }
  if (r.dispute?.filed) lines.push(`⚠ dispute filed (${r.dispute.reason})`);
  lines.push(`HTTP ${r.status}`, (typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2)).slice(0, 3500));
  return lines.join("\n");
}

const server = new McpServer({ name: "meterx402", version: "0.2.0" });

// ── The Graph + Uniswap: paid onchain data for agents ──────────────────────
server.tool(
  "find_dex_pools",
  "Liquidity pools across DEXes and chains from The Graph's standardized (Messari DEX AMM) subgraphs: Uniswap v3 on Ethereum, Arbitrum, Base, Optimism, Polygon, BSC and Celo, plus SushiSwap, PancakeSwap, Curve, Balancer, Camelot and Velodrome, in one shape (TVL, 24h volume, fee, fee APR). Paid per pool returned via x402, within the budget. Use it to find where a pair is deepest or where liquidity earns the most fees.",
  {
    tokens: z.array(z.string()).max(2).optional().describe("Pool must hold all of these, e.g. [\"USDC\",\"ETH\"]"),
    chains: z.array(z.string()).optional().describe("e.g. [\"base\",\"arbitrum\"]; empty = all"),
    protocols: z.array(z.string()).optional().describe("e.g. [\"uniswap-v3\",\"curve-finance\"]; empty = all"),
    sort: z.enum(["tvl", "volume", "fee_apr"]).optional(),
    min_tvl_usd: z.number().nonnegative().optional(),
    first: z.number().int().min(1).max(50).optional().describe("Rows to buy (each is billed)"),
  },
  async ({ tokens, chains, protocols, sort, min_tvl_usd, first }) => {
    const mx = await buyer();
    if (!mx) return noWallet();
    const query: Record<string, string> = { sort: sort ?? "tvl", first: String(first ?? 10) };
    if (tokens?.length) query.tokens = tokens.join(",");
    if (chains?.length) query.chains = chains.join(",");
    if (protocols?.length) query.protocols = protocols.join(",");
    if (min_tvl_usd != null) query.min_tvl = String(min_tvl_usd);
    try {
      return text(summarize(await mx.call("dex-pools", { path: "/pools", method: "GET", query, maxUnits: first ?? 10 })));
    } catch (e) {
      return text(e instanceof BudgetError ? `Not paid: ${e.message}` : `Failed: ${String((e as Error)?.message ?? e)}`, true);
    }
  },
);

server.tool(
  "ask_dex_analyst",
  "Ask a DeFi liquidity question in plain words, e.g. \"where can USDC earn the most fees against ETH?\" or \"swap $5k USDC to ETH on the deepest chain\". An agent pays for each step with x402: LLM tokens to plan, The Graph standardized DEX subgraphs per pool, the Uniswap Trading API per quote, LLM tokens to write the answer. Returns the answer, the computed facts it rests on, and every receipt.",
  {
    question: z.string().min(3),
    max_pools: z.number().int().min(1).max(20).optional().describe("Cap on pools bought (default 10)"),
    with_quote: z.boolean().optional().describe("Allow the Uniswap quote step (default true)"),
  },
  async ({ question, max_pools, with_quote }) => {
    const mx = await buyer();
    if (!mx) return noWallet();
    try {
      const { analyze, renderReport } = await import("./graph/analyst.ts");
      const r = await analyze(question, { buyer: mx, maxPools: max_pools, quote: with_quote === false ? false : undefined });
      return text(renderReport(r));
    } catch (e) {
      return text(String((e as Error)?.message ?? e), true);
    }
  },
);

server.tool(
  "list_services",
  "Discover paid services on MeterX402 by what they do. Services are priced by what a call consumes (tokens, rows, bytes…), carry a reputation score computed from their settlement and performance history, and are ranked best-first. Use get_quote or call_service next.",
  {
    capability: z.string().optional().describe("e.g. weather_forecast, text_generation, blockchain_data"),
    query: z.string().optional().describe("free text over names, descriptions and capabilities"),
    max_price: z.number().positive().optional().describe("max price of a typical call"),
    min_reputation: z.number().min(0).max(100).optional(),
  },
  async ({ capability, query, max_price, min_reputation }) => {
    const q = new URLSearchParams();
    if (capability) q.set("capability", capability);
    if (query) q.set("q", query);
    if (max_price != null) q.set("maxPrice", String(max_price));
    if (min_reputation != null) q.set("minReputation", String(min_reputation));
    const { services } = await fetch(`${HUB_URL}/registry/services?${q}`).then((r) => r.json()).catch(() => ({ services: [] }));
    if (!services.length) return text("No matching services are live right now. Start some with `npm run demo` (or demo:offline), or relax the filters.");
    return json(services.map((l: any) => ({
      service_id: l.service_id,
      name: l.descriptor.name,
      capabilities: l.descriptor.capabilities,
      pricing: `${l.price.rate} ${l.price.currency} per ${l.price.per === 1 ? "" : l.price.per + " "}${l.price.unit}`,
      typical_call: l.price.typical_call,
      reputation: l.reputation.score ?? `unrated (${l.reputation.sample_size} samples)`,
      interfaces: l.descriptor.interfaces,
      sample: l.descriptor.sample,
    })));
  },
);

server.tool(
  "get_service",
  "Full details of one service: its ServiceDescriptor (pricing, settlement options, interfaces, sample request), price estimates and reputation.",
  { service_id: z.string() },
  async ({ service_id }) => {
    const r = await fetch(`${HUB_URL}/registry/services/${encodeURIComponent(service_id)}`);
    return r.ok ? json(await r.json()) : text(`No service "${service_id}" in the registry.`, true);
  },
);

server.tool(
  "get_reputation",
  "A service's ReputationRecord: a deterministic 0–100 score from settlement and performance evidence (execution, response success, latency, disputes, uptime, payment reliability), with the weights and raw stats.",
  { service_id: z.string() },
  async ({ service_id }) => {
    const r = await fetch(`${HUB_URL}/registry/services/${encodeURIComponent(service_id)}/reputation`);
    return r.ok ? json(await r.json()) : text(`No service "${service_id}".`, true);
  },
);

server.tool(
  "get_quote",
  "Run a call on a service and get its EXACT metered price, without paying. The service holds the response until the quote expires (about 2 minutes). Pay it with pay_for_service.",
  { service_id: z.string(), ...reqShape },
  async (a) => {
    const mx = await buyer();
    if (!mx) return noWallet();
    try {
      const q = await mx.quote(a.service_id, toReq(a));
      if (!("pay" in q)) return text(`No payment needed.\n${summarize(q)}`);
      pending.set(q.quote.quote_id, q);
      setTimeout(() => pending.delete(q.quote.quote_id), Math.max(0, q.quote.expires_at - Date.now()) + 1000).unref?.();
      return json({
        quote_id: q.quote.quote_id,
        price: `${q.quote.amount} ${q.quote.currency}`,
        metered: `${q.quote.units} ${q.quote.unit} (measured ${q.quote.measured}${q.quote.cap ? `, cap ${q.quote.cap}` : ""})`,
        expires_in_s: Math.round((q.quote.expires_at - Date.now()) / 1000),
        budget_remaining: mx.remaining,
        quote: q.quote,
      });
    } catch (e: any) {
      return text(`Could not quote: ${String(e?.message ?? e).split("\n")[0]}`, true);
    }
  },
);

server.tool(
  "pay_for_service",
  "Pay a quote returned by get_quote and receive the result, a SettlementReceipt and the buyer-side verification. Refused if it would exceed max_price or the session budget.",
  { quote_id: z.string(), max_price: z.number().positive().optional() },
  async ({ quote_id, max_price }) => {
    const q = pending.get(quote_id);
    if (!q) return text("Unknown or expired quote_id: call get_quote again.", true);
    if (max_price != null && Number(q.quote.amount) > max_price) return text(`Not paid: the quote is ${q.quote.amount} ${q.quote.currency}, above max_price ${max_price}.`, true);
    try {
      const r = await q.pay();
      pending.delete(quote_id);
      return text(summarize(r));
    } catch (e: any) {
      return text(`Not paid: ${String(e?.message ?? e).split("\n")[0]}`, true);
    }
  },
);

const callService = async (a: any) => {
  const mx = await buyer();
  if (!mx) return noWallet();
  try {
    return text(summarize(await mx.call(a.service_id, toReq(a, a.max_price))));
  } catch (e: any) {
    return text(`${e instanceof BudgetError ? "Not paid" : "Failed"}: ${String(e?.message ?? e).split("\n")[0]}`, true);
  }
};

server.tool(
  "call_service",
  "Call a service and pay exactly for what the call consumed, in one step. Set max_units to cap the work and max_price to cap the cost — the payment is refused rather than exceeding them.",
  { service_id: z.string(), ...reqShape, max_price: z.number().positive().optional() },
  callService,
);

// ── older names ───────────────────────────────────────────────────────────
server.tool("list_paid_apis", "Alias of list_services.", {}, async () => {
  const { services } = await fetch(`${HUB_URL}/registry/services`).then((r) => r.json()).catch(() => ({ services: [] }));
  return json(services.map((l: any) => ({ service_id: l.service_id, pricing: `${l.price.rate} ${l.price.currency} / ${l.price.unit}`, url: `${l.descriptor.endpoint}${l.descriptor.sample?.path ?? "/"}` })));
});
server.tool(
  "paid_fetch",
  "Alias of call_service taking a full URL.",
  { url: z.string(), method: z.string().optional(), body: z.string().optional(), max_units: z.number().int().positive().optional(), max_hbar: z.number().positive().optional() },
  async ({ url, method, body, max_units, max_hbar }) => {
    const u = new URL(url);
    const mx = await buyer();
    if (!mx) return noWallet();
    try {
      const r = await mx.call(u.origin, { path: u.pathname, method, body, maxUnits: max_units, maxPrice: max_hbar, query: Object.fromEntries(u.searchParams) });
      return text(summarize(r));
    } catch (e: any) {
      return text(`Not paid: ${String(e?.message ?? e).split("\n")[0]}`, true);
    }
  },
);

await server.connect(new StdioServerTransport());
