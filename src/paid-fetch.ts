// The buyer side: a real x402 client that pays metered quotes, and only within
// the buyer's own limits. Used by the dashboard's test buyer, the MCP server,
// the tests, and anyone who imports it.
//
// Three limits, three enforcement points:
//   maxUnits   sent as `x-meter-max-units`: the gateway clamps the upstream
//              request and never bills above it
//   maxPerCall enforced by the official x402Client spend controls: the client
//              refuses to SIGN a payment above it, whatever the seller quotes
//   budget     a session total, enforced in a before-payment hook
//
// After paying, it re-hashes the body it received and compares it with the
// bodySha256 the quote committed to: proof it got the response it was billed for.

import { createHash } from "node:crypto";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { createClientHederaSigner, ExactHederaScheme, type PrivateKey } from "@x402/hedera";
import { toAtomic, fromAtomic } from "./pricing.ts";
import { parseHederaKey } from "./hedera.ts";
import { approveAllowance, challengeMessage } from "./tabs.ts";

export interface MeterReceipt {
  quoteId: string;
  unit: string;
  measured: number;
  billable: number;
  cap: number | null;
  rate: string;
  per: string;
  amount: string;        // what was charged, decimal
  ceiling: string | null; // what the call would have cost at its cap
  currency: string;
  bodySha256: string;
  bodyVerified: boolean; // received body hashes to what the quote committed to
  txHash?: string;
  payer?: string;
}

export interface BuyResult {
  res: Response;
  status: number;
  body: string;
  paid: boolean;
  receipt: MeterReceipt | null;
}

export class BuyerLimitError extends Error {
  constructor(message: string, readonly quote: Record<string, string | null>) { super(message); }
}

export interface BuyerOptions {
  accountId: string;
  privateKey: string | PrivateKey;
  network?: "hedera:testnet" | "hedera:mainnet";
  maxPerCall?: number | string; // HBAR
  budget?: number | string;     // HBAR, whole session
  maxUnits?: number;            // default per-request unit cap
  decimals?: number;
}

export interface BuyInit extends RequestInit { maxUnits?: number; maxPerCall?: number | string; }

export interface TabTerms {
  lane: string; spender: string; payTo: string; network: string; unit: string;
  rate: string; per: string; min: string; flushAt: string;
  ledger: "hedera" | "mock"; devLedger?: string; nonce: string; expiresAt: number;
}

export type StreamPart =
  | { type: "chunk"; text: string }
  | { type: "receipt"; receipt: Record<string, any> }
  | { type: "cap"; cap: number; unit: string }
  | { type: "error"; status: number; text: string };

export interface TabSession {
  token: string;
  tabId: string;
  lane: string;
  allowance: string;
  terms: TabTerms;
  /** A call on the tab: no per-call payment, debited from the allowance. */
  buy(url: string, init?: BuyInit): Promise<BuyResult>;
  /** A STREAMED call on the tab: chunks as they arrive, then the receipt. */
  stream(url: string, init?: BuyInit): AsyncGenerator<StreamPart>;
  /** Settle whatever is owed and end the tab. */
  close(): Promise<Record<string, any>>;
}

/** Tab calls carry the metering in headers (there is no x402 payload). */
function receiptFromHeaders(res: Response, sha: string): MeterReceipt | null {
  const unit = h(res, "x-meter-unit");
  if (!unit) return null;
  const bodySha256 = h(res, "x-meter-body-sha256") ?? "";
  return {
    quoteId: h(res, "x-meter-tab") ?? "", unit,
    measured: Number(h(res, "x-meter-measured") ?? 0),
    billable: Number(h(res, "x-meter-billable") ?? 0),
    cap: h(res, "x-meter-cap") ? Number(h(res, "x-meter-cap")) : null,
    rate: h(res, "x-meter-rate") ?? "", per: h(res, "x-meter-per") ?? "1",
    amount: h(res, "x-meter-amount") ?? "0", ceiling: h(res, "x-meter-ceiling") || null,
    currency: h(res, "x-meter-currency") ?? "HBAR",
    bodySha256, bodyVerified: bodySha256 === sha,
  };
}

const h = (r: Response, k: string) => r.headers.get(k);

export function createMeteredBuyer(opts: BuyerOptions) {
  const network = opts.network ?? "hedera:testnet";
  const decimals = opts.decimals ?? 8;
  const key = typeof opts.privateKey === "string" ? parseHederaKey(opts.privateKey) : opts.privateKey;
  const signer = createClientHederaSigner(opts.accountId, key, { network });
  const budget = opts.budget != null ? toAtomic(opts.budget, decimals) : null;
  let spent = 0n;
  let reserved = 0n;

  async function buy(url: string, init: BuyInit = {}): Promise<BuyResult> {
    const { maxUnits = opts.maxUnits, maxPerCall = opts.maxPerCall, ...reqInit } = init;
    const client = new x402Client().register(network, new ExactHederaScheme(signer) as any);
    // HBAR isn't one of the SDK's default (USD-pegged) assets, so it must be
    // allowed explicitly, and this is where the per-call ceiling lives.
    client.setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{ network, asset: "0.0.0", ...(maxPerCall != null ? { maxAmountPerPayment: toAtomic(maxPerCall, decimals).toString() } : {}) }],
    });

    let quote: Record<string, any> | undefined;
    let reservation = 0n;
    client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const amount = BigInt(selectedRequirements.amount);
      const m = (selectedRequirements.extra as any)?.meter;
      if (maxUnits != null && m?.billable != null && m.billable > maxUnits) {
        return { abort: true as const, reason: `quote bills ${m.billable} ${m.unit}, above your cap of ${maxUnits}` };
      }
      if (budget != null && spent + reserved + amount > budget) {
        return { abort: true as const, reason: `budget: ${fromAtomic(spent + reserved, decimals)} spent/reserved + ${fromAtomic(amount, decimals)} > ${fromAtomic(budget, decimals)}` };
      }
      reservation = amount;
      reserved += amount;
    });
    client.onAfterPaymentCreation(async ({ selectedRequirements }) => { quote = (selectedRequirements.extra as any)?.meter; });

    // Sniff the unpaid 402 so a refusal can still say what was quoted.
    let first402: Record<string, string | null> = {};
    const sniff: typeof fetch = async (input, i) => {
      const r = await fetch(input, i);
      if (r.status === 402 && !first402.amount) {
        first402 = { amount: h(r, "x-meter-amount"), unit: h(r, "x-meter-unit"), billable: h(r, "x-meter-billable"), currency: h(r, "x-meter-currency"), quoteId: h(r, "x-meter-quote") };
      }
      return r;
    };
    const paidFetch = wrapFetchWithPayment(sniff, client);

    const headers = new Headers(reqInit.headers);
    if (maxUnits != null) headers.set("x-meter-max-units", String(maxUnits));
    if (reqInit.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");

    let res: Response;
    try {
      res = await paidFetch(url, { ...reqInit, headers });
    } catch (e) {
      reserved -= reservation;
      const msg = String((e as Error)?.message ?? e);
      if (/spend|aborted|No payment requirements|exceed/i.test(msg)) {
        throw new BuyerLimitError(`refused to pay ${first402.amount ?? "?"} ${first402.currency ?? ""} for ${first402.billable ?? "?"} ${first402.unit ?? "units"}: ${msg}`, first402);
      }
      throw e;
    }
    reserved -= reservation;

    const bytes = new Uint8Array(await res.arrayBuffer());
    const body = new TextDecoder().decode(bytes);
    const pr = h(res, "payment-response") ?? h(res, "x-payment-response");
    let settled: any;
    if (pr) { try { settled = decodePaymentResponseHeader(pr); } catch {} }
    const paid = !!settled?.success && res.ok;
    if (paid && quote) spent += toAtomic(quote.amount, decimals);

    const sha = createHash("sha256").update(bytes).digest("hex");
    const receipt: MeterReceipt | null = quote
      ? {
          quoteId: quote.quoteId, unit: quote.unit, measured: quote.measured, billable: quote.billable, cap: quote.cap,
          rate: quote.rate, per: quote.per, amount: quote.amount, ceiling: h(res, "x-meter-ceiling") || null, currency: quote.currency,
          bodySha256: quote.bodySha256, bodyVerified: quote.bodySha256 === sha, txHash: settled?.transaction, payer: settled?.payer,
        }
      : null;
    return { res, status: res.status, body, paid, receipt };
  }

  // ── Metered Tabs: approve an allowance once, then call without paying per call ──

  /** Open a tab on a lane: approve `allowance` HBAR to the lane's spender (that
   *  is your limit, enforced by Hedera), prove you own the account, and get a
   *  tab token. Unused allowance is never moved and needs no refund. */
  async function openTab(laneUrl: string, o: { allowance: number | string; revokeOnClose?: boolean }): Promise<TabSession> {
    const origin = new URL(laneUrl).origin;
    const terms: TabTerms = await fetch(`${origin}/.well-known/mx402/tab`).then((r) => r.json());
    if (!terms?.spender || !terms?.nonce) throw new Error(`this lane does not offer tabs (${JSON.stringify(terms).slice(0, 120)})`);
    const amount = toAtomic(o.allowance, decimals);
    await approveAllowance({ ledger: { mode: terms.ledger, devUrl: terms.devLedger }, owner: opts.accountId, ownerKey: key, spender: terms.spender, amount, network });
    const signature = Buffer.from(key.sign(Buffer.from(challengeMessage(terms.lane, opts.accountId, terms.nonce)))).toString("hex");
    const opened = await fetch(`${origin}/.well-known/mx402/tab`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: opts.accountId, nonce: terms.nonce, signature }),
    }).then((r) => r.json());
    if (!opened?.token) throw new Error(`tab refused: ${opened?.error ?? "unknown"}`);

    const withTab = (init: BuyInit): RequestInit & { headers: Headers } => {
      const headers = new Headers(init.headers);
      headers.set("x-meter-tab", opened.token);
      if (init.maxUnits ?? opts.maxUnits) headers.set("x-meter-max-units", String(init.maxUnits ?? opts.maxUnits));
      if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
      const { maxUnits, maxPerCall, ...rest } = init;
      return { ...rest, headers };
    };

    const session: TabSession = {
      token: opened.token,
      tabId: opened.tab,
      lane: terms.lane,
      allowance: opened.allowance,
      terms,
      async buy(url, init = {}) {
        const res = await fetch(url, withTab(init));
        const bytes = new Uint8Array(await res.arrayBuffer());
        const body = new TextDecoder().decode(bytes);
        const receipt = receiptFromHeaders(res, createHash("sha256").update(bytes).digest("hex"));
        return { res, status: res.status, body, paid: res.ok && !!receipt && Number(receipt.amount) >= 0, receipt };
      },
      async *stream(url, init = {}) {
        const i = withTab(init);
        i.headers.set("accept", "text/event-stream");
        const res = await fetch(url, i);
        if (!res.ok || !res.body) { yield { type: "error", status: res.status, text: await res.text() }; return; }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "", event = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split(/\r?\n/);
          buf = parts.pop() ?? "";
          for (const line of parts) {
            const t = line.trim();
            if (t.startsWith("event:")) { event = t.slice(6).trim(); continue; }
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (payload === "[DONE]") continue;
            let j: any;
            try { j = JSON.parse(payload); } catch { continue; }
            if (event === "mx-receipt") { yield { type: "receipt", receipt: j }; event = ""; continue; }
            if (event === "mx-cap-reached") { yield { type: "cap", cap: j.cap, unit: j.unit }; event = ""; continue; }
            const text = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.text;
            if (typeof text === "string") yield { type: "chunk", text };
          }
        }
      },
      async close() {
        const r = await fetch(`${new URL(laneUrl).origin}/.well-known/mx402/tab`, { method: "DELETE", headers: { "x-meter-tab": opened.token } }).then((x) => x.json());
        if (o.revokeOnClose) {
          await approveAllowance({ ledger: { mode: terms.ledger, devUrl: terms.devLedger }, owner: opts.accountId, ownerKey: key, spender: terms.spender, amount: 0n, network }).catch(() => {});
        }
        return r;
      },
    };
    return session;
  }

  return {
    buy,
    openTab,
    accountId: opts.accountId,
    /** DER public key: what a ledger checks signatures against. */
    publicKeyDer: key.publicKey.toStringDer(),
    spent: () => fromAtomic(spent, decimals),
    remaining: () => (budget == null ? null : fromAtomic(budget - spent, decimals)),
  };
}

export type MeteredBuyer = ReturnType<typeof createMeteredBuyer>;

/** The buyer configured in the environment: BUYER_* (an agent's wallet), else
 *  the operator's HEDERA_* account, like GlassBox402's test buyer. */
export function buyerFromEnv(extra: Partial<BuyerOptions> = {}): MeteredBuyer | null {
  const accountId = process.env.BUYER_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.BUYER_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY;
  if (!accountId || !privateKey) return null;
  return createMeteredBuyer({
    accountId, privateKey,
    network: (process.env.HEDERA_NETWORK as any) ?? "hedera:testnet",
    maxPerCall: process.env.BUYER_MAX_PER_CALL,
    budget: process.env.BUYER_BUDGET,
    ...extra,
  });
}
