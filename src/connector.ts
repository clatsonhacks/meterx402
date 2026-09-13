// MeterX402 connector: a small HTTP API with an OpenAPI spec, for tools that
// speak REST instead of MCP (ChatGPT Custom GPT Actions, the VS Code extension,
// any function-calling LLM).
//
//   npx mx402 connector [--port 3402]
//
// It runs on the buyer's own machine and signs every payment with the buyer's
// own testnet key (BUYER_* from the environment or .env), inside BUYER_BUDGET.
// It never pays from a hub's demo wallet. Because a tunnel makes it reachable
// from the internet, every call except /health and /openapi.json needs the
// bearer token printed at start (CONNECTOR_TOKEN, generated when unset).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { loadEnv } from "./env.ts";

loadEnv();

const { HUB_URL } = await import("./events.ts");
const { MeterX402, BudgetError } = await import("./sdk/buyer.ts");
type Buyer = InstanceType<typeof MeterX402>;
type PendingQuote = import("./sdk/buyer.ts").PendingQuote;
type CallResult = import("./sdk/buyer.ts").CallResult;

export interface ConnectorOptions {
  port?: number;
  token?: string;
  registry?: string;
}

/** One wallet per settlement family, created on first use. */
function wallets(registry: string) {
  const made = new Map<string, Promise<Buyer | null>>();
  const make = async (family: "hedera" | "evm" | "solana", network?: string): Promise<Buyer | null> => {
    if (family === "evm" || family === "solana") {
      const key = family === "evm" ? process.env.BUYER_EVM_PRIVATE_KEY : process.env.BUYER_SOLANA_SECRET_KEY;
      if (!key) return null;
      return new MeterX402({ wallet: { privateKey: key, network }, registry, budget: process.env.BUYER_USDC_BUDGET, maxPerCall: process.env.BUYER_USDC_MAX_PER_CALL });
    }
    const accountId = process.env.BUYER_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID;
    const privateKey = process.env.BUYER_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY;
    if (!accountId || !privateKey) return null;
    return new MeterX402({ wallet: { accountId, privateKey }, registry, budget: process.env.BUYER_BUDGET ?? "1 HBAR", maxPerCall: process.env.BUYER_MAX_PER_CALL });
  };
  return {
    async forService(serviceId: string): Promise<{ buyer: Buyer | null; family: string }> {
      const listing = await fetch(`${registry}/registry/services/${encodeURIComponent(serviceId)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const network: string | undefined = listing?.descriptor?.payment?.settlement?.[0]?.network;
      const family = network?.startsWith("eip155:") ? "evm" : network?.startsWith("solana:") ? "solana" : "hedera";
      const key = `${family}:${family === "hedera" ? "" : network}`;
      if (!made.has(key)) made.set(key, make(family, network).catch(() => null));
      return { buyer: await made.get(key)!, family };
    },
    hedera: () => {
      if (!made.has("hedera:")) made.set("hedera:", make("hedera").catch(() => null));
      return made.get("hedera:")!;
    },
  };
}

const NO_WALLET: Record<string, string> = {
  hedera: "No buyer wallet: set BUYER_ACCOUNT_ID and BUYER_PRIVATE_KEY (your own Hedera testnet account) where the connector runs.",
  evm: "This service settles on an EVM chain: set BUYER_EVM_PRIVATE_KEY (your own Base Sepolia key) where the connector runs.",
  solana: "This service settles on Solana: set BUYER_SOLANA_SECRET_KEY (your own devnet keypair) where the connector runs.",
};

function receiptOf(r: CallResult) {
  return r.receipt ? {
    amount: r.receipt.amount, currency: r.receipt.currency, units: r.receipt.metered_units, unit: r.receipt.unit,
    network: r.receipt.network, transaction_id: r.receipt.transaction_id ?? null,
  } : null;
}
/** why a call did not go through, from the service or facilitator answer */
const whyNot = (r: CallResult) => (r.ok ? undefined : String((r.data as any)?.detail ?? (r.data as any)?.error ?? (r.data as any)?.message ?? `HTTP ${r.status}`).slice(0, 500));
const clip = (d: unknown) => (typeof d === "string" ? d.slice(0, 20_000) : d);

function spec(baseUrl: string) {
  const req = {
    service_id: { type: "string", description: "From listServices" },
    method: { type: "string", enum: ["GET", "POST"], description: "Default: the service's sample method" },
    path: { type: "string", description: "Path on the service, e.g. /pools. Default: the service's sample path" },
    query: { type: "object", additionalProperties: { type: "string" }, description: "Query parameters" },
    body: { type: "object", description: "JSON body for POST" },
    max_units: { type: "integer", description: "Cap the billable units (tokens, rows, entities)" },
  };
  const ok = (description: string) => ({ "200": { description, content: { "application/json": { schema: { type: "object" } } } } });
  return {
    openapi: "3.1.0",
    info: {
      title: "MeterX402",
      version: "0.4.0",
      description: "Pay-per-use APIs and onchain data. Every call is metered, priced exactly, and paid over x402 from the user's own testnet wallet inside their budget. Quote first when the price matters.",
    },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, schemas: {} },
    security: [{ bearer: [] }],
    paths: {
      "/services": {
        get: {
          operationId: "listServices", summary: "Find paid services by what they do, best reputation first",
          parameters: [
            { name: "capability", in: "query", schema: { type: "string" }, description: "e.g. weather_forecast, dex_pools, lending_rates, text_generation" },
            { name: "q", in: "query", schema: { type: "string" }, description: "Free text" },
          ],
          responses: ok("Matching services with price and reputation"),
        },
      },
      "/services/{service_id}": {
        get: {
          operationId: "getService", summary: "One service: pricing, sample request, reputation",
          parameters: [{ name: "service_id", in: "path", required: true, schema: { type: "string" } }],
          responses: ok("The service"),
        },
      },
      "/quote": {
        post: {
          operationId: "getQuote", summary: "Run a call and get its exact price without paying",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service_id"], properties: req } } } },
          responses: ok("quote_id, price, what was metered"),
        },
      },
      "/pay": {
        post: {
          operationId: "payQuote", summary: "Pay a quote from getQuote and get the result with its receipt",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["quote_id"], properties: { quote_id: { type: "string" }, max_price: { type: "number" } } } } } },
          responses: ok("The result, the receipt and the verification"),
        },
      },
      "/call": {
        post: {
          operationId: "callService", summary: "Quote and pay in one step, refused above max_price or the budget",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["service_id"], properties: { ...req, max_price: { type: "number", description: "Refuse to pay more than this" } } } } } },
          responses: ok("The result, the receipt and the verification"),
        },
      },
      "/wallet": {
        get: { operationId: "getWallet", summary: "The paying account and the budget left (never the key)", responses: ok("Account and budget") },
      },
    },
  };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 1_000_000) throw new Error("body too large"); chunks.push(c as Buffer); }
  const t = Buffer.concat(chunks).toString("utf8");
  return t ? JSON.parse(t) : {};
}

export function startConnector(opts: ConnectorOptions = {}) {
  const port = opts.port ?? Number(process.env.CONNECTOR_PORT ?? 3402);
  const registry = (opts.registry ?? HUB_URL).replace(/\/+$/, "");
  const token = opts.token ?? process.env.CONNECTOR_TOKEN ?? randomBytes(24).toString("base64url");
  const w = wallets(registry);
  const pending = new Map<string, PendingQuote>();

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type" });
    res.end(JSON.stringify(body));
  };
  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const toReq = (b: any, maxPrice?: unknown) => ({
    path: b.path, method: b.method, query: b.query, maxUnits: b.max_units,
    body: b.body === undefined ? undefined : typeof b.body === "string" ? b.body : JSON.stringify(b.body),
    // decimal text, never exponent form (0.0000001 must not become "1e-7")
    maxPrice: maxPrice == null || maxPrice === "" ? undefined : Number(maxPrice).toFixed(12).replace(/\.?0+$/, ""),
  });
  const failure = (res: ServerResponse, e: unknown) =>
    send(res, e instanceof BudgetError ? 402 : 502, { ok: false, paid: false, error: String((e as Error)?.message ?? e).split("\n")[0] });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://connector");
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST" }); return res.end(); }
      if (url.pathname === "/health") return send(res, 200, { ok: true, service: "meterx402-connector", registry });
      if (url.pathname === "/openapi.json") {
        const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? `localhost:${port}`);
        const proto = String(req.headers["x-forwarded-proto"] ?? (/^(localhost|127\.)/.test(host) ? "http" : "https"));
        return send(res, 200, spec(process.env.CONNECTOR_PUBLIC_URL ?? `${proto}://${host}`));
      }
      if (!authorized(req)) return send(res, 401, { ok: false, error: "missing or wrong bearer token (printed when the connector started)" });

      if (req.method === "GET" && url.pathname === "/wallet") {
        const mx = await w.hedera();
        return send(res, 200, mx
          ? { ok: true, account: process.env.BUYER_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID, budget_remaining: mx.remaining, evm: !!process.env.BUYER_EVM_PRIVATE_KEY, solana: !!process.env.BUYER_SOLANA_SECRET_KEY }
          : { ok: false, error: NO_WALLET.hedera });
      }
      if (req.method === "GET" && url.pathname === "/services") {
        const q = new URLSearchParams();
        for (const k of ["capability", "q"]) { const v = url.searchParams.get(k); if (v) q.set(k, v); }
        const { services = [] } = await fetch(`${registry}/registry/services?${q}`).then((r) => r.json()).catch(() => ({}));
        return send(res, 200, {
          services: services.map((l: any) => ({
            service_id: l.service_id,
            name: l.descriptor?.title ?? l.descriptor?.name,
            capabilities: l.descriptor?.capabilities,
            price: l.price ? `${l.price.rate} ${l.price.currency} per ${l.price.per === 1 ? String(l.descriptor?.pricing?.unit_label ?? l.price.unit).replace(/s$/, "") : `${l.price.per} ${l.price.unit}`}` : null,
            typical_call: l.price?.typical_call ?? null,
            network: l.descriptor?.payment?.settlement?.[0]?.network,
            reputation: l.reputation?.score ?? null,
            sample: l.descriptor?.sample,
          })),
        });
      }
      const one = /^\/services\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && one) {
        const r = await fetch(`${registry}/registry/services/${one[1]}`);
        return send(res, r.status, await r.json().catch(() => ({ error: "not found" })));
      }
      if (req.method === "POST" && (url.pathname === "/quote" || url.pathname === "/call")) {
        const b = await readJson(req);
        if (!b.service_id) return send(res, 400, { ok: false, error: "service_id is required" });
        const { buyer, family } = await w.forService(String(b.service_id));
        if (!buyer) return send(res, 400, { ok: false, error: NO_WALLET[family] });
        try {
          if (url.pathname === "/call") {
            const r = await buyer.call(String(b.service_id), toReq(b, b.max_price));
            return send(res, 200, { ok: r.ok, paid: r.paid, status: r.status, data: clip(r.data), error: whyNot(r), receipt: receiptOf(r), verification: r.verification, budget_remaining: buyer.remaining });
          }
          const q = await buyer.quote(String(b.service_id), toReq(b));
          if (!("pay" in q)) return send(res, 200, { ok: q.ok, free: true, data: clip(q.data) });
          pending.set(q.quote.quote_id, q);
          setTimeout(() => pending.delete(q.quote.quote_id), Math.max(0, q.quote.expires_at - Date.now()) + 1000).unref?.();
          return send(res, 200, { ok: true, quote_id: q.quote.quote_id, price: `${q.quote.amount} ${q.quote.currency}`, amount: q.quote.amount, currency: q.quote.currency, units: q.quote.units, unit: q.quote.unit, expires_in_s: Math.round((q.quote.expires_at - Date.now()) / 1000), budget_remaining: buyer.remaining });
        } catch (e) { return failure(res, e); }
      }
      if (req.method === "POST" && url.pathname === "/pay") {
        const b = await readJson(req);
        const q = pending.get(String(b.quote_id));
        if (!q) return send(res, 404, { ok: false, error: "unknown or expired quote_id: get a new quote" });
        if (b.max_price != null && Number(q.quote.amount) > Number(b.max_price)) return send(res, 402, { ok: false, paid: false, error: `quote ${q.quote.amount} ${q.quote.currency} is above max_price ${b.max_price}` });
        try {
          const r = await q.pay();
          pending.delete(String(b.quote_id));
          return send(res, 200, { ok: r.ok, paid: r.paid, status: r.status, data: clip(r.data), error: whyNot(r), receipt: receiptOf(r), verification: r.verification });
        } catch (e) { return failure(res, e); }
      }
      return send(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      return send(res, 500, { ok: false, error: String((e as Error)?.message ?? e) });
    }
  });

  return new Promise<{ port: number; token: string; close: () => void }>((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : port, token, close: () => server.close() });
    });
  });
}
