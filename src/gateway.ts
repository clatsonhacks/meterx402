// mx402: the one command. Wraps ANY API in x402 and charges for what each call
// actually consumes (tokens, rows, bytes, ms), not a flat price per call.
//
//   npx mx402 <upstream-url> --wallet 0.0.1234 --meter tokens --rate 0.01 --per 1000
//
// How it differs from GlassBox402's x402ify: the price can't be known until
// the upstream has answered, so this does not use paymentMiddleware (which
// needs the price before the handler runs). It drives the same official
// x402ResourceServer by hand, in this order:
//
//   1. unpaid request   → clamp to the buyer's cap → call upstream → METER →
//                         HOLD the response → 402 quoting the exact metered price
//   2. paid retry       → match the hold → facilitator verify → settle →
//                         release the held response + PAYMENT-RESPONSE
//
// Standard `exact` scheme, unmodified blocky402 facilitator, one transaction
// per call, no refunds, and still no private key on this server.

import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { loadEnv } from "./env.ts";
import { emit, mxe, HUB_URL, type MXEventType } from "./events.ts";
import { makeMeter } from "./meters.ts";
import { quote, fromAtomic, toAtomic, priceAtomic, bindingCap, describeRate, type RateCard, type Quote } from "./pricing.ts";
import { HoldStore, RateLimiter, fingerprint, sha256 } from "./holds.ts";
import { CHAINS, explorerTx, hederaTokenPreset, type ChainPreset } from "./chains.ts";
import { verifySessionToken } from "./world.ts";
import { TabBook, hederaTabLedger, mockTabLedger, type Tab, type TabLedger } from "./tabs.ts";
import { SubscriptionBook, subscriptionChallenge, type SubscriptionTerms } from "./subscriptions.ts";
import { parseHederaKey } from "./hedera.ts";
import { X402ExactAdapter } from "./settlement/x402-exact.ts";
import { PROTOCOL_VERSION, ServiceDescriptor, encodeHeader, type PaymentQuote, type SettlementReceipt } from "./protocol/schemas.ts";
import { inferAuth, inferCapabilities, inferType, plainDecimal, slug, type ServiceType } from "./protocol/describe.ts";
import { createAid, skillsFor, toHederaCaip10, UAID_REGISTRY } from "./protocol/hcs14.ts";
import { mountA2A } from "./adapters/a2a.ts";

export interface GatewayConfig {
  upstream: string;
  name: string;
  port: number;
  payTo: string;
  meter: string;               // meter spec, see meters.ts
  card: Omit<RateCard, "unit">;
  chain?: string;              // preset name (default hedera)
  asset?: string;              // settle in an HTS token id instead of native HBAR
  network?: string;            // override the preset's network id
  facilitator?: string;        // override the preset's facilitator
  headers?: Record<string, string>; // injected upstream auth headers (never shown to buyers)
  query?: Record<string, string>;   // injected upstream query params (e.g. apikey)
  sample?: string;
  sampleMethod?: string;
  sampleBody?: string;
  holdTtlSec?: number;         // how long a metered response waits for payment
  maxHolds?: number;           // unpaid quotes allowed per client at once
  maxHoldTotal?: number;
  maxHeldBytes?: number;
  rpm?: number;                // unpaid (work-triggering) requests per client per minute; 0 = off
  trustProxy?: boolean;        // read the client address from x-forwarded-for
  hub?: string | null;         // null = don't stream events
  quiet?: boolean;
  /** Metered Tabs (allowance-backed sessions). Hedera only. */
  tab?: { ledger: TabLedger; spender: string; flushAt?: number | string; flushEverySec?: number };
  /** Sell access by the period, paid by pre-signed scheduled transfers. */
  subscription?: { price: string; periodSec: number; maxPeriods?: number; includesUnits?: number };
  /** Allow streaming responses on a tab (default true). Never available on the
   *  pay-per-call path: there the price only exists once the response is done. */
  stream?: boolean;
  // ── how the service describes itself (ServiceDescriptor) ──
  serviceId?: string;          // registry id (default: slug of name)
  capabilities?: string[];     // what it does, e.g. weather_forecast (default: inferred)
  description?: string;
  type?: ServiceType;          // default: inferred from the meter and sample
  publicUrl?: string;          // where buyers reach it (default: http://localhost:<port>)
}

interface Held {
  iface: string;
  status: number;
  contentType: string;
  body: Uint8Array<ArrayBuffer>;
  q: Quote;
  bodySha256: string;
  path: string;
  method: string;
  tier: string;
  verified: boolean;
  multiplier: number;
  requirements?: PaymentRequirements;
  paymentRequiredHeader?: string;
}

type Policy = { humanVerifiedOnly?: boolean; botMultiplier?: number; blockBots?: boolean };

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,payment-signature,x-payment,x-meter-max-units,x-meter-tab,x-mx402-subscription,x-world-proof,x-mx402-interface,access-control-expose-headers",
  "access-control-expose-headers": "payment-required,payment-response,x-payment-response,x-meter-quote,x-meter-unit,x-meter-measured,x-meter-billable,x-meter-cap,x-meter-rate,x-meter-per,x-meter-amount,x-meter-currency,x-meter-body-sha256,x-meter-ceiling,x-mx402-quote,x-mx402-receipt",
  "access-control-allow-private-network": "true",
};

const parseCap = (v: string | undefined): number | undefined => {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

export async function startGateway(cfg: GatewayConfig): Promise<{ url: string; descriptor: ServiceDescriptor; close(): Promise<void>; server: ServerType }> {
  let chain: ChainPreset = CHAINS[cfg.chain ?? "hedera"] ?? (() => {
    throw new Error(`unknown chain "${cfg.chain}". try: ${Object.keys(CHAINS).join(", ")}`);
  })();
  const network = (cfg.network ?? chain.network) as `${string}:${string}`;
  // Settle in an HTS token: same scheme, same facilitator, different asset.
  // Decimals, symbol and any ledger-assessed fee come from the token itself.
  if (cfg.asset && cfg.asset !== "0.0.0") {
    if (chain.name !== "hedera") throw new Error("--asset is a Hedera (HTS) feature; drop --chain or use an HTS token id");
    chain = await hederaTokenPreset(cfg.asset, chain, network);
  }
  const explorer = { explorer: network === "hedera:mainnet" ? "hashscan-mainnet" as const : chain.explorer };
  const facilitatorUrl = cfg.facilitator ?? process.env.FACILITATOR_URL ?? chain.facilitator;
  const meter = makeMeter(cfg.meter);
  const card: RateCard = { unit: meter.unit, ...cfg.card };
  const hub = cfg.hub === undefined ? HUB_URL : cfg.hub;
  const lane = cfg.name;
  const holdTtlSec = cfg.holdTtlSec ?? 120;
  const maxHeldBytes = cfg.maxHeldBytes ?? 5 * 1024 * 1024;
  const log = (...a: unknown[]) => { if (!cfg.quiet) console.log(...a); };
  const send = (type: MXEventType, reqId: string, data: Record<string, unknown>) =>
    hub ? emit(mxe(type, lane, reqId, data), hub) : Promise.resolve();

  try { await chain.load(); }
  catch { throw new Error(`chain "${chain.name}" needs an extra package (npm i @x402/evm or @x402/svm), or use --chain hedera`); }

  // All money movement goes through a SettlementAdapter (src/settlement/): the
  // gateway never talks to a chain or a facilitator directly. Initialisation
  // (fetching the facilitator's fee payer) retries in the background; quotes
  // return 503 until it answers.
  const settlement = new X402ExactAdapter(chain, { network, facilitator: facilitatorUrl, tabs: !!cfg.tab });
  const initP = settlement.init();

  const holds = new HoldStore<Held>({ ttlMs: holdTtlSec * 1000, maxPerClient: cfg.maxHolds ?? 3, maxTotal: cfg.maxHoldTotal ?? 1000 });
  const limiter = new RateLimiter(cfg.rpm ?? 0);

  if (cfg.tab && chain.name !== "hedera") throw new Error(chain.asset !== "0.0.0"
    ? "--tab settles HBAR allowances, so it cannot be combined with --asset yet"
    : "--tab needs Hedera (allowances are a native Hedera feature)");
  // Subscriptions: the buyer pre-signs future transfers; we only ever read
  // them off the ledger. No key, no allowance, no trust in the buyer's word.
  const subTerms: SubscriptionTerms | null = cfg.subscription ? {
    price: plainDecimal(cfg.subscription.price),
    period_sec: cfg.subscription.periodSec,
    max_periods: cfg.subscription.maxPeriods ?? 12,
    includes_units: cfg.subscription.includesUnits ?? null,
    payTo: cfg.payTo, currency: chain.currency, network,
  } : null;
  const subs = subTerms ? new SubscriptionBook({
    lane, payTo: cfg.payTo, terms: subTerms, amountAtomic: toAtomic(subTerms.price, chain.decimals),
  }) : null;

  const tabFlushAt = toAtomic(cfg.tab?.flushAt ?? "0.01", chain.decimals);
  const tabs = cfg.tab ? new TabBook({
    lane, ledger: cfg.tab.ledger, spender: cfg.tab.spender, payTo: cfg.payTo, flushAt: tabFlushAt,
    flushEveryMs: (cfg.tab.flushEverySec ?? 15) * 1000,
    onFlush: (r) => {
      const amount = Number(fromAtomic(r.amount, chain.decimals));
      if (r.error) { void send("tab_flush", r.tabId, { tab: r.tabId, owner: r.owner, amount, calls: r.calls, error: r.error }); return; }
      const link = process.env.MX_OFFLINE === "1" || cfg.tab!.ledger.mode === "mock" ? null : explorerTx(explorer, r.txId!);
      const receipt: SettlementReceipt = {
        mx402: PROTOCOL_VERSION, receipt_id: crypto.randomUUID(), scheme: "tab", quote_id: null, tab_id: r.tabId,
        service_id: serviceId, buyer: r.owner, seller: cfg.payTo, metered_units: r.units, unit: card.unit,
        rate: plainDecimal(card.rate), per: Number(card.per ?? 1), amount: fromAtomic(r.amount, chain.decimals),
        amount_atomic: r.amount.toString(), currency: chain.currency, network, transaction_id: r.txId!,
        body_sha256: null, settled_at: Date.now(),
      };
      void send("tab_flush", r.tabId, { tab: r.tabId, owner: r.owner, from: r.owner, amount, calls: r.calls, units: r.units, txHash: r.txId, hashscan: link, payTo: cfg.payTo, currency: chain.currency, receipt });
      log(`[${lane}] 🧾 tab ${r.tabId}: settled ${amount} ${chain.currency} for ${r.calls} calls  tx ${r.txId}`);
    },
  }) : null;

  // Live pricing policy (World ID tiering), refreshed from the hub.
  let policy: Policy = {};
  const policyTimer = hub ? setInterval(async () => {
    try { policy = (await fetch(`${hub}/policy/${lane}`).then((r) => r.json())).policy ?? {}; } catch {}
  }, 2000) : null;

  const tierFor = (verified: boolean) => (policy.humanVerifiedOnly && !verified ? "bot" : verified ? "human" : "anon");
  const multiplierFor = (verified: boolean) => (policy.humanVerifiedOnly && !verified ? Number(policy.botMultiplier ?? 10) : 1);

  // The A2A adapter calls this gateway over loopback on behalf of a remote
  // agent; a per-process secret lets it pass that agent's address through, so
  // unpaid-quote limits still apply per real client.
  const internalToken = crypto.randomUUID();
  const clientKey = (c: Context): string => {
    if (c.req.header("x-mx402-internal") === internalToken) {
      const fwd = c.req.header("x-mx402-client");
      if (fwd) return fwd;
    }
    if (cfg.trustProxy) {
      const xff = c.req.header("x-forwarded-for");
      if (xff) return xff.split(",")[0].trim();
    }
    return (c.env as any)?.incoming?.socket?.remoteAddress ?? "unknown";
  };

  const IFACES = new Set(["rest", "graphql", "a2a", "mcp", "sdk"]);
  const ifaceOf = (c: Context) => { const v = (c.req.header("x-mx402-interface") ?? "rest").toLowerCase(); return IFACES.has(v) ? v : "rest"; };

  const upstreamUrl = (c: Context): URL => {
    const base = new URL(cfg.upstream);
    // "/" on the lane is the upstream URL itself (single-endpoint APIs: /query,
    // /graphql, /v2/api); any other path is appended to the upstream's base path
    // (https://api.openai.com/v1 + /chat/completions).
    const basePath = base.pathname.replace(/\/+$/, "");
    const url = new URL(c.req.path === "/" ? base.pathname : basePath + c.req.path, base.origin);
    for (const [k, v] of base.searchParams) url.searchParams.set(k, v);
    for (const [k, v] of new URL(c.req.url).searchParams) url.searchParams.set(k, v);
    for (const [k, v] of Object.entries(cfg.query ?? {})) url.searchParams.set(k, v); // our secret wins
    return url;
  };

  const meterHeaders = (h: Held, quoteId: string): Record<string, string> => ({
    "x-meter-quote": quoteId,
    "x-meter-unit": card.unit,
    "x-meter-measured": String(h.q.measured),
    "x-meter-billable": String(h.q.billable),
    "x-meter-cap": h.q.cap == null ? "" : String(h.q.cap),
    "x-meter-rate": String(card.rate),
    "x-meter-per": String(card.per ?? 1),
    "x-meter-amount": fromAtomic(h.q.amount, chain.decimals),
    "x-meter-ceiling": h.q.ceilingAmount == null ? "" : fromAtomic(h.q.ceilingAmount, chain.decimals),
    "x-meter-currency": chain.currency,
    "x-meter-body-sha256": h.bodySha256,
  });

  // ── ServiceDescriptor: what this service is, how it's priced and paid ──
  const serviceId = slug(cfg.serviceId ?? lane);
  const endpoint = (cfg.publicUrl ?? `http://127.0.0.1:${cfg.port}`).replace(/\/+$/, "");
  const serviceType = cfg.type ?? inferType(card.unit, cfg.sampleBody);
  const publishedAt = new Date().toISOString();
  // HCS-14 identity. Hashed over the six canonical fields only, so it survives
  // a move to a new host, a new price, even a new hub.
  const agentCapabilities = cfg.capabilities?.length ? cfg.capabilities : inferCapabilities(cfg.upstream, serviceType, cfg.sample);
  const uaid = (() => {
    try {
      return createAid({
        registry: UAID_REGISTRY,
        name: serviceId,
        version: PROTOCOL_VERSION,
        protocol: "a2a",
        nativeId: network.startsWith("hedera:") ? toHederaCaip10(network, cfg.payTo) : `${network}:${cfg.payTo}`,
        skills: skillsFor(agentCapabilities),
      }, { uid: serviceId, proto: "a2a" });
    } catch (e) {
      console.warn(`[${lane}] no UAID: ${String(e).split("\n")[0]}`);
      return undefined;
    }
  })();

  const descriptor = (): ServiceDescriptor => ServiceDescriptor.parse({
    mx402: PROTOCOL_VERSION,
    service_id: serviceId,
    name: cfg.name,
    description: cfg.description ?? `${cfg.name}, metered by ${card.unit} (${describeRate(card, chain.currency)})`,
    type: serviceType,
    endpoint,
    sample: { method: (cfg.sampleMethod ?? "GET").toUpperCase(), path: cfg.sample ?? "/", ...(cfg.sampleBody ? { body: cfg.sampleBody } : {}) },
    capabilities: agentCapabilities,
    ...(uaid ? { uaid } : {}),
    pricing: {
      meter: meter.spec, unit: card.unit, rate: plainDecimal(card.rate), per: Number(card.per ?? 1),
      min: plainDecimal(card.min ?? 0), free: card.free ?? 0, max_units: card.maxUnits ?? null, currency: chain.currency,
    },
    payment: {
      protocol: "x402", settlement: settlement.capabilities(),
      streaming: !!tabs && cfg.stream !== false && !!meter.stream,
      ...(subTerms ? {
        subscription: {
          price: subTerms.price, period_sec: subTerms.period_sec, max_periods: subTerms.max_periods,
          includes_units: subTerms.includes_units, open: `${endpoint}/.well-known/mx402/subscription`,
        },
      } : {}),
    },
    interfaces: serviceType === "graphql" ? ["graphql", "rest", "a2a", "mcp", "sdk"] : ["rest", "a2a", "mcp", "sdk"],
    auth: { type: inferAuth(cfg.headers, cfg.query), held_by: "seller" },
    owner: { account: cfg.payTo, network },
    links: {
      descriptor: `${endpoint}/.well-known/mx402`,
      a2a_card: `${endpoint}/.well-known/agent.json`,
      ...(tabs ? { tab: `${endpoint}/.well-known/mx402/tab` } : {}),
      ...(subs ? { subscription: `${endpoint}/.well-known/mx402/subscription` } : {}),
    },
    published_at: publishedAt,
  });
  descriptor(); // validate the configuration up front: a bad descriptor should fail at startup

  const app = new Hono();

  app.options("*", (c) => c.body(null, 204, CORS));
  app.get("/.well-known/mx402", (c) => c.json(descriptor(), 200, CORS));
  // Every service is also an A2A agent: an agent card plus JSON-RPC message/send,
  // with x402 payment carried in task metadata (src/adapters/a2a.ts).
  mountA2A(app, { descriptor, selfUrl: `http://127.0.0.1:${cfg.port}`, internalToken, cors: CORS, log });

  // Tabs: GET = terms + a one-time challenge; POST = open; DELETE = settle + close.
  app.get("/.well-known/mx402/tab", (c) => {
    if (!tabs) return c.json({ error: "tabs_not_enabled" }, 404, CORS);
    return c.json({
      lane, spender: cfg.tab!.spender, payTo: cfg.payTo, network, asset: "0.0.0",
      unit: card.unit, rate: String(card.rate), per: String(card.per ?? 1), min: String(card.min ?? 0),
      flushAt: fromAtomic(tabFlushAt, chain.decimals), ledger: cfg.tab!.ledger.mode, devLedger: cfg.tab!.ledger.devUrl,
      ...tabs.challenge(),
      how: "1) approve an HBAR allowance owner→spender (your limit)  2) sign `mx402-tab:<lane>:<owner>:<nonce>` with your account key  3) POST {owner, nonce, signature}",
    }, 200, CORS);
  });
  app.post("/.well-known/mx402/tab", async (c) => {
    if (!tabs) return c.json({ error: "tabs_not_enabled" }, 404, CORS);
    const { owner, nonce, signature } = await c.req.json().catch(() => ({} as any));
    if (!owner || !nonce || !signature) return c.json({ error: "owner, nonce, signature required" }, 400, CORS);
    const r = await tabs.open(String(owner), String(nonce), String(signature));
    if (!r.ok) return c.json({ error: r.error }, 402, CORS);
    await send("tab_open", r.tab.id, { tab: r.tab.id, owner, allowance: Number(fromAtomic(r.tab.allowanceAtOpen, chain.decimals)), spender: cfg.tab!.spender });
    log(`[${lane}] 🧾 tab ${r.tab.id} opened by ${owner}, allowance ${fromAtomic(r.tab.allowanceAtOpen, chain.decimals)} ${chain.currency}`);
    return c.json({ token: r.token, tab: r.tab.id, allowance: fromAtomic(r.tab.allowanceAtOpen, chain.decimals), flushAt: fromAtomic(tabFlushAt, chain.decimals) }, 200, CORS);
  });
  app.get("/.well-known/mx402/subscription", (c) => {
    if (!subs || !subTerms) return c.json({ error: "subscriptions_not_enabled" }, 404, CORS);
    return c.json({
      lane, payTo: cfg.payTo, network, asset: chain.asset, currency: chain.currency,
      price: subTerms.price, periodSec: subTerms.period_sec, maxPeriods: subTerms.max_periods,
      includesUnits: subTerms.includes_units,
      amountAtomic: toAtomic(subTerms.price, chain.decimals).toString(),
      ...subs.challenge(),
      how: "1) create one Hedera scheduled transfer per period (wait_for_expiry, paying payTo the exact amount)  2) sign `mx402-sub:<lane>:<buyer>:<nonce>` with your account key  3) POST {buyer, nonce, signature, schedules:[id,…]}",
      committed: fromAtomic(subs.committed().atomic, chain.decimals),
    }, 200, CORS);
  });
  app.post("/.well-known/mx402/subscription", async (c) => {
    if (!subs) return c.json({ error: "subscriptions_not_enabled" }, 404, CORS);
    const { buyer, nonce, signature, schedules } = await c.req.json().catch(() => ({} as any));
    if (!buyer || !nonce || !signature || !Array.isArray(schedules)) {
      return c.json({ error: "buyer, nonce, signature and schedules[] required" }, 400, CORS);
    }
    const r = await subs.open(String(buyer), String(nonce), String(signature), schedules.map(String));
    if (!r.ok) return c.json({ error: r.error }, 402, CORS);
    const committed = subs.committed();
    await send("subscription_open", r.sub.id, {
      subscription: r.sub.id, buyer: r.sub.buyer, periods: r.sub.periods.length,
      amount: fromAtomic(BigInt(r.sub.amount_atomic), chain.decimals), periodSec: r.sub.period_sec,
      committed: fromAtomic(committed.atomic, chain.decimals), schedules: r.sub.periods.map((p) => p.schedule_id),
    });
    log(`[${lane}] 📅 subscription ${r.sub.id}: ${r.sub.periods.length} periods × ${fromAtomic(BigInt(r.sub.amount_atomic), chain.decimals)} ${chain.currency} committed by ${buyer}`);
    return c.json({
      token: r.token, subscription: r.sub.id,
      periods: r.sub.periods.map((p) => ({ schedule_id: p.schedule_id, due_at: p.due_at, amount: fromAtomic(BigInt(p.amount_atomic), chain.decimals) })),
      includesUnits: r.sub.includes_units,
      committed: fromAtomic(committed.atomic, chain.decimals),
    }, 200, CORS);
  });
  /** What the seller can already count on. */
  app.get("/.well-known/mx402/subscriptions", async (c) => {
    if (!subs) return c.json({ error: "subscriptions_not_enabled" }, 404, CORS);
    await subs.refresh().catch(() => {});
    const committed = subs.committed();
    return c.json({
      lane, payTo: cfg.payTo, currency: chain.currency,
      committed: fromAtomic(committed.atomic, chain.decimals),
      periodsAhead: committed.periods, subscribers: committed.subscriptions,
      subscriptions: subs.all().map((s) => ({
        id: s.id, buyer: s.buyer, period_sec: s.period_sec, includes_units: s.includes_units, used: s.used,
        periods: s.periods.map((p) => ({ schedule_id: p.schedule_id, due_at: p.due_at, executed_at: p.executed_at, amount: fromAtomic(BigInt(p.amount_atomic), chain.decimals) })),
      })),
    }, 200, CORS);
  });
  app.delete("/.well-known/mx402/tab", async (c) => {
    const t = tabs?.get(c.req.header("x-meter-tab"));
    if (!t) return c.json({ error: "unknown_or_expired_tab" }, 404, CORS);
    const { settled, tab } = await tabs!.close(t);
    await send("tab_close", tab.id, { tab: tab.id, owner: tab.owner, calls: tab.calls, units: tab.units, pulled: Number(fromAtomic(tab.pulled, chain.decimals)), frozen: tab.frozen });
    return c.json({
      tab: tab.id, calls: tab.calls, units: tab.units, paid: fromAtomic(tab.pulled, chain.decimals), owedUnsettled: fromAtomic(tab.owed, chain.decimals),
      lastTx: settled?.txId ?? null, error: settled?.error ?? tab.frozen ?? null,
    }, settled?.error ? 402 : 200, CORS);
  });

  app.all("*", async (c) => {
    const reqId = crypto.randomUUID();
    const method = c.req.method;
    const u = new URL(c.req.url);
    const bodyText = method === "GET" || method === "HEAD" ? "" : await c.req.text();
    const fp = fingerprint(method, u.pathname + u.search, bodyText);
    const world = verifySessionToken(c.req.header("x-world-proof"));
    const paymentHeader = c.req.header("payment-signature") ?? c.req.header("x-payment");

    // "Block unverified bots entirely": refuse before any work is done.
    if (policy.humanVerifiedOnly && policy.blockBots && !world.ok) {
      await send("blocked", reqId, { reason: "human_verification_required", path: c.req.path });
      return c.json({ error: "human_verification_required", message: "This API only serves World ID verified humans." }, 403, CORS);
    }

    const subToken = c.req.header("x-mx402-subscription");
    if (subToken && subs) return subCall(c, reqId, bodyText, world.ok, subToken);
    const tabToken = c.req.header("x-meter-tab");
    if (tabToken && tabs) return tabCall(c, reqId, bodyText, world.ok, tabToken);
    if (paymentHeader) return settleHeld(c, reqId, fp, paymentHeader, bodyText, world.ok);
    return meterAndQuote(c, reqId, fp, bodyText, world.ok);
  });

  // ── phase 1: do the work, count it, hold it, quote it ───────────────────
  async function meterAndQuote(c: Context, reqId: string, fp: string, bodyText: string, verified: boolean, error = "payment_required"): Promise<Response> {
    const client = clientKey(c);
    const path = c.req.path;
    await send("request_in", reqId, { method: c.req.method, path });
    if (!settlement.ready) {
      await Promise.race([initP, new Promise((r) => setTimeout(r, 3000))]);
      if (!settlement.ready) return c.json({ error: "facilitator_unavailable", facilitator: facilitatorUrl }, 503, CORS);
    }

    // Check the limits BEFORE doing upstream work: this is what bounds the
    // cost of a caller who takes quotes and never pays.
    if (!limiter.hit(client)) {
      await send("rate_limited", reqId, { client, reason: "rpm" });
      return c.json({ error: "rate_limited", message: `more than ${cfg.rpm} unpaid requests per minute` }, 429, CORS);
    }
    if (holds.countFor(client) >= (cfg.maxHolds ?? 3)) {
      await send("rate_limited", reqId, { client, reason: "too_many_unpaid" });
      return c.json({ error: "too_many_unpaid_quotes", message: "pay or let your outstanding quotes expire first" }, 429, CORS);
    }

    const r = await runMetered(c, reqId, bodyText, verified);
    if ("response" in r) return r.response;
    return holdAndQuote(c, reqId, fp, r.held, r.common, error);
  }

  /** Hold a metered response and answer 402 with its exact price. */
  async function holdAndQuote(c: Context, reqId: string, fp: string, held: Held, common: Record<string, unknown>, error = "payment_required"): Promise<Response> {
    const { q, body, contentType } = held;

    // Nothing billable (free units, empty result): serve it, no payment.
    if (q.amount === 0n) {
      await send("free", reqId, common);
      return new Response(body, { status: held.status, headers: { ...CORS, "content-type": contentType, ...meterHeaders(held, "") } });
    }
    if (body.byteLength > maxHeldBytes) return c.json({ error: "response_too_large_to_meter", bytes: body.byteLength }, 502, CORS);

    const created = holds.create(clientKey(c), fp, held);
    if (!created.ok) return c.json({ error: created.reason }, 429, CORS);
    const quoteId = created.hold.id;
    const bodySha256 = held.bodySha256;

    let paymentRequired;
    try {
      const quoted = await settlement.quote({
        amountAtomic: q.amount,
        payTo: cfg.payTo,
        maxTimeoutSeconds: holdTtlSec,
        // The metering reading travels inside the payment requirements, so the
        // buyer's client sees units, rate and the body hash BEFORE it signs,
        // and quoteId ties the signed payment back to this exact response.
        extra: {
          meter: {
            quoteId, unit: card.unit, measured: q.measured, billable: q.billable, cap: q.cap,
            rate: String(card.rate), per: String(card.per ?? 1), multiplier: held.multiplier,
            amount: fromAtomic(q.amount, chain.decimals), currency: chain.currency,
            bodySha256, bodyBytes: body.byteLength, expiresAt: created.hold.expiresAt,
            meterSpec: meter.spec, serviceId,
          },
        },
        resource: { url: c.req.url, description: `${lane}: ${q.billable} ${card.unit} × ${describeRate(card, chain.currency)}`, mimeType: contentType },
        error,
      });
      held.requirements = quoted.requirements;
      paymentRequired = quoted.paymentRequired;
      held.paymentRequiredHeader = quoted.header;
    } catch (e) {
      holds.remove(quoteId);
      console.error(`[${lane}] could not build payment requirements:`, String(e).split("\n")[0]);
      return c.json({ error: "quote_failed", detail: String(e).split("\n")[0] }, 503, CORS);
    }

    const paymentQuote: PaymentQuote = {
      mx402: PROTOCOL_VERSION, quote_id: quoteId, service_id: serviceId, scheme: "exact",
      meter: meter.spec, unit: card.unit, units: q.billable, measured: q.measured, cap: q.cap,
      rate: plainDecimal(card.rate), per: Number(card.per ?? 1),
      amount: fromAtomic(q.amount, chain.decimals), amount_atomic: q.amount.toString(),
      currency: chain.currency, network, asset: held.requirements!.asset, pay_to: cfg.payTo,
      body_sha256: bodySha256, expires_at: created.hold.expiresAt,
    };
    await send("quote_402", reqId, { ...common, quoteId, expiresAt: created.hold.expiresAt, payTo: cfg.payTo, quote: paymentQuote });
    return c.json(
      {
        ...paymentRequired,
        quote: paymentQuote,
        meter: { quoteId, ...common, expiresAt: created.hold.expiresAt, note: "Metered: this is the exact price of this response. Pay it to receive the body." },
        ...(tabs ? { tab: { open: `${new URL(c.req.url).origin}/.well-known/mx402/tab`, note: "Or open a tab: approve a Hedera allowance once, then call without per-call payments." } } : {}),
      },
      402,
      { ...CORS, "payment-required": held.paymentRequiredHeader!, "x-mx402-quote": encodeHeader(paymentQuote), ...meterHeaders(held, quoteId) },
    );
  }

  /** Did the caller ask for a stream, and can this meter count one? */
  function wantsStream(c: Context, bodyText: string): boolean {
    if (cfg.stream === false || !meter.stream) return false;
    if ((c.req.header("accept") ?? "").includes("text/event-stream")) return true;
    try { return JSON.parse(bodyText || "{}")?.stream === true; } catch { return false; }
  }

  /** Stream the upstream response straight through, metering it as it passes,
   *  and debit the tab when it ends. The cap is enforced live: the stream stops
   *  at the cap rather than running up a bill the allowance can't cover. */
  async function streamMetered(c: Context, reqId: string, bodyText: string, verified: boolean, tab: Tab, affordableCap?: number): Promise<Response> {
    let reqJson: any;
    try { reqJson = JSON.parse(bodyText || "{}"); } catch {}
    const declared = parseCap(c.req.header("x-meter-max-units")) ?? meter.capFromRequest?.(reqJson);
    const buyerCap = affordableCap == null ? declared : Math.min(declared ?? Infinity, affordableCap);
    const cap = bindingCap({ buyerCap, sellerCap: card.maxUnits });

    // clamp to the cap, then put streaming back on (clamp turns it off for the
    // buffered path) and ask for usage in the final chunk where that is supported
    let upJson = cap != null && meter.clamp && reqJson !== undefined ? meter.clamp(reqJson, cap) : reqJson;
    if (upJson && typeof upJson === "object") {
      upJson = { ...upJson, stream: true };
      if (Array.isArray((upJson as any).messages)) (upJson as any).stream_options = { include_usage: true };
    }
    const headers: Record<string, string> = { accept: "text/event-stream", ...cfg.headers, "content-type": c.req.header("content-type") ?? "application/json" };

    const t0 = performance.now();
    let up: Response;
    try {
      up = await fetch(upstreamUrl(c), { method: c.req.method, headers, body: upJson === undefined ? bodyText || undefined : JSON.stringify(upJson) });
    } catch (e) {
      await send("upstream_error", reqId, { status: 502, error: String(e).split("\n")[0], path: c.req.path });
      return c.json({ error: "upstream_unreachable" }, 502, CORS);
    }
    if (!up.ok || !up.body) {
      const text = await up.text().catch(() => "");
      await send("upstream_error", reqId, { status: up.status, path: c.req.path });
      return new Response(text, { status: up.status, headers: { ...CORS, "content-type": up.headers.get("content-type") ?? "application/json", "x-meter-amount": "0" } });
    }

    const contentType = up.headers.get("content-type") ?? "text/event-stream";
    const isSse = contentType.includes("text/event-stream");
    const sm = meter.stream!(reqJson);
    const multiplier = multiplierFor(verified);
    const hash = createHash("sha256");
    const reader = up.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let closed = false, capReached = false, chunks = 0;

    const settleStream = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (closed) return;
      closed = true;
      const ms = performance.now() - t0;
      const q = quote(sm.units(), card, { buyerCap, multiplier, decimals: chain.decimals });
      const bodySha256 = hash.digest("hex");
      const common = {
        unit: card.unit, measured: q.measured, billable: q.billable, cap: q.cap, capped: q.capped || capReached,
        rate: card.rate, per: card.per ?? 1, multiplier, tier: tierFor(verified), streamed: true, chunks,
        amount: Number(fromAtomic(q.amount, chain.decimals)),
        ceilingAmount: q.ceilingAmount == null ? null : Number(fromAtomic(q.ceilingAmount, chain.decimals)),
        currency: chain.currency, bodySha256, ms: Math.round(ms), path: c.req.path,
      };
      await send("metered", reqId, common);
      let debited = true;
      if (q.amount > 0n) {
        const d = tabs!.debit(tab, q.amount, q.billable);
        debited = d.ok;
        if (d.ok) {
          await send("settled", reqId, { ...common, scheme: "tab", tab: tab.id, from: tab.owner, units: q.billable, amountAtomic: q.amount.toString(), payTo: cfg.payTo, network, txHash: null, verified, receipt: tabReceipt(tab.id, tab.owner, q.billable, q.amount, bodySha256) });
        } else {
          await send("payment_failed", reqId, { stage: "tab", reason: d.reason, tab: tab.id });
        }
      } else {
        await send("free", reqId, common);
      }
      if (isSse) {
        // the receipt can't be a header: it only exists once the stream has ended
        const receipt = { ...common, tab: tab.id, debited, owed: fromAtomic(tab.owed, chain.decimals), available: fromAtomic(tabs!.available(tab), chain.decimals), capReached };
        controller.enqueue(encoder.encode(`event: mx-receipt\ndata: ${JSON.stringify(receipt)}\n\n`));
      }
      controller.close();
    };

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) return settleStream(controller);
          chunks++;
          hash.update(value);
          sm.onChunk(decoder.decode(value, { stream: true }));
          controller.enqueue(value);
          // live cap: stop the stream rather than run past what the buyer allowed
          if (cap != null && sm.units() > cap) {
            capReached = true;
            await reader.cancel().catch(() => {});
            if (isSse) controller.enqueue(encoder.encode(`event: mx-cap-reached\ndata: ${JSON.stringify({ cap, unit: card.unit })}\n\n`));
            await settleStream(controller);
          }
        } catch {
          await settleStream(controller).catch(() => {});
        }
      },
      cancel: () => { void reader.cancel().catch(() => {}); },
    });

    log(`[${lane}] streaming on tab ${tab.id}${cap != null ? ` (cap ${cap} ${card.unit})` : ""}`);
    return new Response(stream, {
      status: 200,
      headers: {
        ...CORS, "content-type": contentType, "cache-control": "no-cache",
        "x-meter-stream": "1", "x-meter-unit": card.unit, "x-meter-rate": String(card.rate), "x-meter-per": String(card.per ?? 1),
        "x-meter-currency": chain.currency, "x-meter-cap": cap == null ? "" : String(cap), "x-meter-tab": tab.id,
      },
    });
  }

  /** The shared core: clamp to the cap, call upstream, count what came back. */
  async function runMetered(c: Context, reqId: string, bodyText: string, verified: boolean, affordableCap?: number):
    Promise<{ response: Response } | { held: Held; common: Record<string, unknown> }> {
    const path = c.req.path;
    let reqJson: unknown;
    if (bodyText) { try { reqJson = JSON.parse(bodyText); } catch {} }
    const declared = parseCap(c.req.header("x-meter-max-units")) ?? meter.capFromRequest?.(reqJson);
    // On a tab, what the remaining allowance can afford is a cap too.
    const buyerCap = affordableCap == null ? declared : Math.min(declared ?? Infinity, affordableCap);
    const cap = bindingCap({ buyerCap, sellerCap: card.maxUnits });
    // Clamp the upstream request so the cap limits the work, not just the bill.
    let upBody = bodyText || undefined;
    if (cap != null && meter.clamp && reqJson !== undefined) upBody = JSON.stringify(meter.clamp(reqJson, cap));

    const headers: Record<string, string> = { accept: c.req.header("accept") ?? "application/json", ...cfg.headers };
    if (upBody !== undefined) headers["content-type"] = c.req.header("content-type") ?? "application/json";

    let up: Response, body: Uint8Array<ArrayBuffer>, ms: number;
    const t0 = performance.now();
    try {
      up = await fetch(upstreamUrl(c), { method: c.req.method, headers, body: upBody });
      body = new Uint8Array(await up.arrayBuffer());
      ms = performance.now() - t0;
    } catch (e) {
      await send("upstream_error", reqId, { status: 502, error: String(e).split("\n")[0], path });
      return { response: c.json({ error: "upstream_unreachable" }, 502, CORS) };
    }
    const contentType = up.headers.get("content-type") ?? "application/json";

    // Upstream failed: pass it through, free. The buyer never pays for an error.
    if (up.status >= 400) {
      await send("upstream_error", reqId, { status: up.status, path });
      return { response: new Response(body, { status: up.status, headers: { ...CORS, "content-type": contentType, "x-meter-amount": "0" } }) };
    }

    const resText = new TextDecoder().decode(body);
    let resJson: unknown;
    try { resJson = JSON.parse(resText); } catch {}
    let measured: number;
    try {
      measured = meter.measure({ reqBody: reqJson, status: up.status, resText, resJson, bytes: body.byteLength, ms });
    } catch (e) {
      // A meter that can't read the response must not become a free lunch or a
      // surprise bill: charge the cap if there is one, else refuse.
      if (cap == null) return { response: c.json({ error: "metering_failed", detail: String(e) }, 502, CORS) };
      measured = cap;
    }

    const multiplier = multiplierFor(verified);
    const q = quote(measured, card, { buyerCap, multiplier, decimals: chain.decimals });
    const bodySha256 = sha256(body);
    const iface = ifaceOf(c);
    const held: Held = { iface, status: up.status, contentType, body, q, bodySha256, path, method: c.req.method, tier: tierFor(verified), verified, multiplier };
    const common = {
      unit: card.unit, measured: q.measured, billable: q.billable, cap: q.cap, capped: q.capped,
      rate: card.rate, per: card.per ?? 1, multiplier, tier: held.tier,
      amount: Number(fromAtomic(q.amount, chain.decimals)),
      ceilingAmount: q.ceilingAmount == null ? null : Number(fromAtomic(q.ceilingAmount, chain.decimals)),
      currency: chain.currency, bodySha256, bytes: body.byteLength, ms: Math.round(ms), path, interface: iface,
    };
    await send("metered", reqId, common);
    return { held, common };
  }

  /** A tab call's receipt: metered and debited now; transaction_id stays null
   *  until the batch it belongs to settles (see the tab_flush event). */
  function tabReceipt(tabId: string, owner: string, units: number, amount: bigint, bodySha256: string | null): SettlementReceipt {
    return {
      mx402: PROTOCOL_VERSION, receipt_id: crypto.randomUUID(), scheme: "tab", quote_id: null, tab_id: tabId,
      service_id: serviceId, buyer: owner, seller: cfg.payTo, metered_units: units, unit: card.unit,
      rate: plainDecimal(card.rate), per: Number(card.per ?? 1), amount: fromAtomic(amount, chain.decimals),
      amount_atomic: amount.toString(), currency: chain.currency, network, transaction_id: null,
      body_sha256: bodySha256, settled_at: Date.now(),
    };
  }

  // ── Subscriptions: pre-signed future transfers (src/subscriptions.ts) ───
  // The period's included units are spent first; once they run out the call
  // falls back to ordinary pay-per-call rather than being quietly given away.
  async function subCall(c: Context, reqId: string, bodyText: string, verified: boolean, token: string): Promise<Response> {
    const sub = subs!.fromToken(token);
    if (!sub) return c.json({ error: "unknown_or_expired_subscription" }, 402, CORS);
    await send("request_in", reqId, { method: c.req.method, path: c.req.path, subscription: sub.id });

    const r = await runMetered(c, reqId, bodyText, verified);
    if ("response" in r) return r.response;
    const { held, common } = r;
    const spend = subs!.spend(sub, held.q.billable);
    if (spend.excess > 0) {
      // not covered: hold it and quote for it like any other call
      return holdAndQuote(c, reqId, fingerprint(c.req.method, new URL(c.req.url).pathname + new URL(c.req.url).search, bodyText), held, common, "subscription_period_exhausted");
    }
    const receipt = subReceipt(sub, held.q.billable, held.bodySha256);
    await send("settled", reqId, {
      ...common, scheme: "subscription", subscription: sub.id, from: sub.buyer, units: held.q.billable,
      amountAtomic: "0", payTo: cfg.payTo, network, txHash: null, verified: held.verified, receipt,
      note: "covered by a pre-paid period",
    });
    return new Response(held.body, {
      status: held.status,
      headers: {
        ...CORS, "content-type": held.contentType, ...meterHeaders(held, ""),
        "x-mx402-subscription": sub.id,
        "x-mx402-sub-used": String(sub.used),
        "x-mx402-sub-included": sub.includes_units == null ? "unlimited" : String(sub.includes_units),
        "x-mx402-receipt": encodeHeader(receipt),
      },
    });
  }

  function subReceipt(sub: { id: string; buyer: string }, units: number, bodySha256: string): SettlementReceipt {
    return {
      mx402: PROTOCOL_VERSION, receipt_id: crypto.randomUUID(), scheme: "subscription", quote_id: null, tab_id: null,
      subscription_id: sub.id, service_id: serviceId, buyer: sub.buyer, seller: cfg.payTo,
      metered_units: units, unit: card.unit, rate: plainDecimal(card.rate), per: Number(card.per ?? 1),
      amount: "0", amount_atomic: "0", currency: chain.currency, network,
      transaction_id: null, body_sha256: bodySha256, settled_at: Date.now(),
    };
  }

  // ── Metered Tabs: allowance-backed, no per-call payment (src/tabs.ts) ────
  async function tabCall(c: Context, reqId: string, bodyText: string, verified: boolean, token: string): Promise<Response> {
    const tab = tabs!.get(token);
    if (!tab) return c.json({ error: "unknown_or_expired_tab" }, 402, CORS);
    await send("request_in", reqId, { method: c.req.method, path: c.req.path, tab: tab.id });
    // What the allowance can still pay for caps the work BEFORE it's done.
    const available = tabs!.available(tab);
    const unitPrice = priceAtomic(1, { rate: card.rate, per: card.per }, multiplierFor(verified), chain.decimals);
    const minAtomic = card.min != null ? toAtomic(card.min, chain.decimals) : 0n;
    const affordable = unitPrice > 0n ? Number(available / unitPrice) : Infinity;
    if (tab.frozen || available < minAtomic || affordable < 1) {
      await send("payment_failed", reqId, { stage: "tab", reason: tab.frozen ? "tab_frozen" : "tab_exhausted", tab: tab.id });
      return c.json({ error: tab.frozen ? "tab_frozen" : "tab_exhausted", detail: tab.frozen, available: fromAtomic(available, chain.decimals) }, 402, CORS);
    }
    const cappedAffordable = Number.isFinite(affordable) ? affordable : undefined;

    // Streaming lives here, and only here. A tab has payment authority BEFORE
    // the call (the allowance), so bytes can go straight out while being counted
    // on the way past. Pay-per-call cannot stream: its price only exists once the
    // response is complete, and the body is the very thing being held back until
    // it is paid for.
    if (wantsStream(c, bodyText)) return streamMetered(c, reqId, bodyText, verified, tab, cappedAffordable);

    const r = await runMetered(c, reqId, bodyText, verified, cappedAffordable);
    if ("response" in r) return r.response;
    const { held, common } = r;
    let receipt: SettlementReceipt | null = null;
    if (held.q.amount > 0n) {
      const d = tabs!.debit(tab, held.q.amount, held.q.billable);
      if (!d.ok) return c.json({ error: d.reason }, 402, CORS);
      receipt = tabReceipt(tab.id, tab.owner, held.q.billable, held.q.amount, held.bodySha256);
      await send("settled", reqId, {
        ...common, scheme: "tab", tab: tab.id, from: tab.owner, units: held.q.billable, amountAtomic: held.q.amount.toString(),
        payTo: cfg.payTo, network, txHash: null, verified: held.verified, receipt,
      });
    } else {
      await send("free", reqId, common);
    }
    return new Response(held.body, {
      status: held.status,
      headers: {
        ...CORS, "content-type": held.contentType, ...meterHeaders(held, ""),
        "x-meter-tab": tab.id,
        ...(receipt ? { "x-mx402-receipt": encodeHeader(receipt) } : {}),
        "x-meter-tab-owed": fromAtomic(tab.owed, chain.decimals),
        "x-meter-tab-available": fromAtomic(tabs!.available(tab), chain.decimals),
      },
    });
  }

  // ── phase 2: payment arrived, settle it, release the held response ──────
  async function settleHeld(c: Context, reqId: string, fp: string, header: string, bodyText: string, verified: boolean): Promise<Response> {
    let payload: PaymentPayload;
    try { payload = decodePaymentSignatureHeader(header); }
    catch { return c.json({ error: "invalid_payment_header" }, 400, CORS); }

    const quoteId = String((payload as any)?.accepted?.extra?.meter?.quoteId ?? "");
    const lock = holds.lock(quoteId, fp);
    if (!lock.ok) {
      if (lock.reason === "already_settling") return c.json({ error: "already_settling", quoteId }, 409, CORS);
      // Unknown or expired quote (or a restart lost it): nothing has been
      // charged, so meter again and quote afresh.
      await send(lock.reason === "not_found" ? "quote_expired" : "payment_failed", reqId, { quoteId, reason: lock.reason });
      return meterAndQuote(c, reqId, fp, bodyText, verified, lock.reason === "not_found" ? "quote_expired" : "payment_does_not_match_request");
    }
    const hold = lock.hold;
    const h = hold.data;
    const requirements = h.requirements!;
    const retry402 = (error: string, detail?: string) =>
      c.json({ error, detail, meter: { quoteId, amount: fromAtomic(h.q.amount, chain.decimals) } }, 402, {
        ...CORS, "payment-required": h.paymentRequiredHeader!, ...meterHeaders(h, quoteId),
      });

    // Authorise: the payload must be for THIS quote (same amount, payTo, network,
    // asset, meter reading) and valid at the facilitator. No money moves yet.
    const auth = await settlement.authorize(payload, requirements);
    if (!auth.ok) {
      holds.unlock(quoteId);
      const stage = auth.reason === "payment_does_not_match_quote" ? "match" : "verify";
      await send("payment_failed", reqId, { quoteId, stage, reason: auth.reason, from: auth.payer, detail: auth.detail });
      return retry402(auth.reason, auth.detail);
    }

    // Settle: move the money.
    const done = await settlement.settle(payload, requirements);
    if (!done.ok) {
      holds.unlock(quoteId);
      await send("payment_failed", reqId, { quoteId, stage: "settle", reason: done.reason, detail: done.detail });
      return retry402(done.reason, done.detail);
    }
    const settled = done.raw as Parameters<typeof encodePaymentResponseHeader>[0];
    holds.remove(quoteId);

    const amount = Number(fromAtomic(h.q.amount, chain.decimals));
    const meta = {
      from: settled.payer ?? "unknown", unit: card.unit, units: h.q.billable, measured: h.q.measured, cap: h.q.cap,
      rate: card.rate, per: card.per ?? 1, multiplier: h.multiplier, amount, amountAtomic: h.q.amount.toString(),
      ceilingAmount: h.q.ceilingAmount == null ? null : Number(fromAtomic(h.q.ceilingAmount, chain.decimals)),
      currency: chain.currency, payTo: cfg.payTo, path: h.path, tier: h.tier, verified: h.verified,
      txHash: settled.transaction, network, bodySha256: h.bodySha256, quoteId,
      scheme: "exact", interface: h.iface,
    };
    const receipt: SettlementReceipt = {
      mx402: PROTOCOL_VERSION, receipt_id: crypto.randomUUID(), scheme: "exact", quote_id: quoteId, tab_id: null,
      service_id: serviceId, buyer: meta.from, seller: cfg.payTo, metered_units: h.q.billable, unit: card.unit,
      rate: plainDecimal(card.rate), per: Number(card.per ?? 1), amount: fromAtomic(h.q.amount, chain.decimals),
      amount_atomic: h.q.amount.toString(), currency: chain.currency, network, transaction_id: settled.transaction,
      body_sha256: h.bodySha256, settled_at: Date.now(),
    };
    await send("settled", reqId, { ...meta, receipt });
    // (offline demo: the mock facilitator's tx ids never reach Hedera, so no explorer link)
    const link = process.env.MX_OFFLINE === "1" ? null : explorerTx(explorer, settled.transaction);
    if (link) await send("hedera_receipt", reqId, { hashscan: link, txId: settled.transaction });
    log(`[${lane}] 💸 ${h.q.billable} ${card.unit} → ${meta.amount} ${chain.currency} from ${meta.from}  tx ${settled.transaction}`);

    return new Response(h.body, {
      status: h.status,
      headers: {
        ...CORS,
        "content-type": h.contentType,
        "payment-response": encodePaymentResponseHeader(settled),
        "x-mx402-receipt": encodeHeader(receipt),
        ...meterHeaders(h, quoteId),
      },
    });
  }

  const lanePayload = () => ({
    upstream: new URL(cfg.upstream).origin + new URL(cfg.upstream).pathname,
    unit: card.unit, meter: meter.spec, rate: card.rate, per: card.per ?? 1, min: card.min ?? 0, free: card.free ?? 0,
    maxUnits: card.maxUnits ?? null, currency: chain.currency, rateLabel: describeRate(card, chain.currency),
    payTo: cfg.payTo, owner: cfg.payTo, port: cfg.port, chain: chain.name, network,
    sample: cfg.sample ?? "/", sampleMethod: (cfg.sampleMethod ?? "GET").toUpperCase(), sampleBody: cfg.sampleBody,
    holdTtlSec, maxHolds: cfg.maxHolds ?? 3, rpm: cfg.rpm ?? 0,
    tabs: tabs ? { spender: cfg.tab!.spender, flushAt: fromAtomic(tabFlushAt, chain.decimals), ledger: cfg.tab!.ledger.mode } : null,
    service_id: serviceId,
    descriptor: descriptor(),
  });

  return await new Promise((resolveStart) => {
    const server = serve({ fetch: app.fetch, port: cfg.port }, () => {
      void send("lane_up", crypto.randomUUID(), lanePayload());
      log(`💧 ${lane} is metered x402 [${chain.name}]: http://localhost:${cfg.port} → ${cfg.upstream}  (${describeRate(card, chain.currency)} → ${cfg.payTo})`);
      resolveStart({
        url: `http://127.0.0.1:${cfg.port}`,
        descriptor: descriptor(),
        server,
        close: () => new Promise<void>((r) => { if (policyTimer) clearInterval(policyTimer); clearInterval(beat); tabs?.stop(); server.close(() => r()); }),
      });
    });
    // Re-announce so a hub that restarts under a living lane finds it again
    // (the hub dedupes heartbeats; they never reach the tape).
    const beat = setInterval(() => { void send("lane_up", crypto.randomUUID(), { ...lanePayload(), heartbeat: true }); }, 15_000);
    beat.unref?.();
  });
}

// ── CLI ───────────────────────────────────────────────────────────────────

export const GATEWAY_HELP = `
mx402: wrap any API in x402 and charge for what each call consumes.

  mx402 <api-url> --wallet <account> --meter tokens --rate 0.01 --per 1000

Pricing (seller):
  --meter <spec>      tokens | tokens:output | rows | rows:<path> | bytes | ms | json:<path> | request   [request]
  --rate <n>          price per --per units, in HBAR (hedera) or USDC (base/solana)                   [0.01]
  --per <n>           unit block the rate applies to (e.g. 1000 → per 1K tokens)                        [1]
  --min <n>           minimum charge for a paid call                                                     [0]
  --free <n>          free units per call                                                                [0]
  --max-units <n>     seller cap per call; nobody is billed above it                                     [none]

Buyers cap a call with the header  x-meter-max-units: <n>  (or max_tokens in an LLM body).

Lane:
  --wallet <acct>     payout account (Hedera 0.0.x or 0x…)                                               [required]
  --name <label>      lane name                                                        [derived from host]
  --port <n>          local port                                                                         [4030]
  --asset <token-id>  settle in an HTS token instead of HBAR (decimals and any
                      ledger-assessed fee are read from the token)            [0.0.0 = HBAR]
  --chain <name>      hedera | base | base-sepolia | solana                                              [hedera]
  --network <id>      override the network id (e.g. hedera:mainnet)
  --facilitator <url> override the facilitator (default blocky402 for hedera)
  --header "K: V"     upstream auth header, repeatable (never shown to buyers)
  --query "k=v"       upstream query param, repeatable (e.g. apikey=…)
  --sample <path>     a valid path, advertised to dashboards/agents                                      [/]
  --method <m>        how dashboards/agents should call it                                               [GET]
  --body <json>       sample request body (e.g. a GraphQL query)
  --hub <url>         stream events to a MeterX402 hub (use --hub none to disable)       [http://127.0.0.1:4021]

Service descriptor (what agents discover in the registry):
  --service-id <id>   registry id                                                          [slug of --name]
  --capability <c>    what it does, repeatable (e.g. weather_forecast)                      [inferred]
  --description <s>   one line for humans and agents
  --type <t>          rest | graphql | llm                                                  [inferred]
  --public-url <url>  where buyers reach this gateway                        [http://127.0.0.1:<port>]

Abuse limits (the seller does the work before being paid, so these bound it):
  --hold-ttl <sec>    how long a metered response waits for payment                                      [120]
  --max-holds <n>     unpaid quotes per client at once                                                   [3]
  --rpm <n>           unpaid requests per client per minute (0 = off)                                    [0]
  --trust-proxy       take the client address from x-forwarded-for

Subscriptions (Hedera scheduled transactions): the buyer pre-signs one transfer
per period, so the seller can count the revenue before it lands.
  --subscribe <price> sell access by the period at this price per period
  --period <sec>      how long a period is                                    [604800 = 7 days]
  --sub-periods <n>   most periods a buyer may commit to at once              [12]
  --sub-units <n>     metered units included per period (default: unlimited)

Metered Tabs (Hedera): buyers approve an HBAR allowance once (their limit, enforced
on-chain), then call with no per-call payment; the gateway settles usage in batches.
  --tab               enable tabs; spender = TAB_SPENDER_ID/KEY (or HEDERA_ACCOUNT_ID/KEY)
  --tab-flush <n>     settle when this much is owed                                      [0.01]
  --tab-every <sec>   …or this often                                                     [15]
`;

export function parseArgs(argv: string[]): GatewayConfig {
  const flag = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const flagAll = (n: string) => argv.reduce<string[]>((acc, a, i) => (a === `--${n}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
  const valueFlags = new Set(["wallet", "pay-to", "rate", "per", "min", "free", "max-units", "meter", "name", "port", "chain", "asset", "network", "facilitator", "header", "query", "sample", "method", "body", "hub", "hold-ttl", "max-holds", "rpm", "tab-flush", "tab-every", "subscribe", "period", "sub-periods", "sub-units", "service-id", "capability", "description", "type", "public-url", "registry"]);
  const upstream = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && valueFlags.has(argv[i - 1].slice(2))));
  if (!upstream || argv.includes("--help")) { console.log(GATEWAY_HELP); process.exit(upstream ? 0 : 1); }
  const payTo = flag("wallet") ?? flag("pay-to");
  if (!payTo) { console.error("--wallet <your payout account> is required (payments settle there)"); process.exit(1); }
  const headers: Record<string, string> = {};
  for (const h of flagAll("header")) { const i = h.indexOf(":"); if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
  const query: Record<string, string> = {};
  for (const q of flagAll("query")) { const i = q.indexOf("="); if (i > 0) query[q.slice(0, i).trim()] = q.slice(i + 1).trim(); }
  const optNum = (n: string) => (flag(n) != null ? Number(flag(n)) : undefined);
  const hubFlag = flag("hub");
  return {
    upstream,
    payTo,
    name: flag("name", new URL(upstream).hostname.replace(/^api\./, "").split(".")[0])!,
    port: Number(flag("port", "4030")),
    meter: flag("meter", "request")!,
    card: { rate: flag("rate", "0.01")!, per: flag("per", "1")!, min: flag("min", "0")!, free: optNum("free"), maxUnits: optNum("max-units") },
    chain: flag("chain", "hedera"),
    asset: flag("asset"),
    network: flag("network"),
    facilitator: flag("facilitator"),
    headers,
    query,
    sample: flag("sample", "/"),
    sampleMethod: flag("method", "GET"),
    sampleBody: flag("body"),
    holdTtlSec: optNum("hold-ttl"),
    maxHolds: optNum("max-holds"),
    rpm: optNum("rpm"),
    trustProxy: argv.includes("--trust-proxy"),
    hub: hubFlag === "none" ? null : hubFlag,
    tab: argv.includes("--tab") ? tabFromEnv(flag("tab-flush"), optNum("tab-every")) : undefined,
    subscription: flag("subscribe") ? {
      price: flag("subscribe")!,
      periodSec: optNum("period") ?? 604800,
      maxPeriods: optNum("sub-periods"),
      includesUnits: optNum("sub-units"),
    } : undefined,
    serviceId: flag("service-id"),
    capabilities: flagAll("capability"),
    description: flag("description"),
    type: flag("type") as ServiceType | undefined,
    publicUrl: flag("public-url"),
  };
}

/** Tab spender from the environment: a real Hedera account, or (offline demo)
 *  an account registered with the mock facilitator. */
function tabFromEnv(flushAt?: string, flushEverySec?: number): GatewayConfig["tab"] {
  const id = process.env.TAB_SPENDER_ID ?? process.env.HEDERA_ACCOUNT_ID;
  const key = process.env.TAB_SPENDER_KEY ?? process.env.HEDERA_PRIVATE_KEY;
  if (!id || !key) { console.error("--tab needs a spender account: set TAB_SPENDER_ID/TAB_SPENDER_KEY (or HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY)"); process.exit(1); }
  const ledger = process.env.MX_OFFLINE === "1" && process.env.FACILITATOR_URL
    ? mockTabLedger(process.env.FACILITATOR_URL, id, parseHederaKey(key))
    : hederaTabLedger(id, key);
  return { ledger, spender: id, flushAt, flushEverySec };
}


