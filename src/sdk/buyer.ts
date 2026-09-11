// MeterX402 buyer SDK: the payment lifecycle as explicit, inspectable steps.
//
//   const mx = new MeterX402({ wallet, budget: "1 HBAR", registry: "http://localhost:4021" });
//   const q  = await mx.quote("weather-api", { query: { forecast_days: "2" } });  // metered, not paid
//   if (Number(q.quote.amount) < 0.01) { const r = await q.pay(); r.receipt; }
//   // or in one go:
//   const r = await mx.call("weather-api");
//
// Discover → quote → budget check → authorize → pay → settle → receipt →
// verify. The buyer never builds a chain transaction: the settlement route is
// chosen from the service's descriptor and the wallet's network, and the
// official x402 client signs within the buyer's own limits.
//
// After delivery it verifies what it paid for: the body must hash to what the
// quote committed to, and re-metering the body must give the quoted units. If
// either fails, a dispute is filed with the registry (and anchored on HCS).

import { createHash } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { createClientHederaSigner, ExactHederaScheme, type PrivateKey } from "@x402/hedera";
import { parseHederaKey } from "../hedera.ts";
import { makeMeter } from "../meters.ts";
import { fromAtomic, toAtomic } from "../pricing.ts";
import { selectRoute, type Route } from "../settlement/adapter.ts";
import {
  decodeHeader, PaymentQuote, PROTOCOL_VERSION, SettlementReceipt,
  type PaymentAuthorization, type ServiceDescriptor,
} from "../protocol/schemas.ts";
import type { Listing, SearchFilter } from "../registry/registry.ts";

export interface WalletConfig {
  accountId: string;
  privateKey: string | PrivateKey;
  network?: "hedera:testnet" | "hedera:mainnet";
}

export interface MeterX402Options {
  wallet: WalletConfig;
  /** Session budget, e.g. "1 HBAR" or 1. Enforced before anything is signed. */
  budget?: string | number;
  /** Refuse any single call above this. */
  maxPerCall?: string | number;
  /** The registry to discover services in (a MeterX402 hub). */
  registry?: string;
  /** File a dispute automatically when verification fails (default true). */
  autoDispute?: boolean;
}

export interface CallRequest {
  path?: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  maxUnits?: number;          // cap the work (clamps the upstream request)
  maxPrice?: string | number; // refuse this call above this amount
}

export interface Verification {
  bodyHash: boolean;           // the body hashes to what the quote committed to
  remetered: number | null;    // units counted from the delivered body, by the buyer
  unitsMatch: boolean | null;  // re-metering agrees with the quote (null = meter not re-computable, e.g. ms)
  method: "exact" | "self-reported" | "none";
}

export interface CallResult {
  ok: boolean;
  status: number;
  data: unknown;               // parsed JSON, or the text
  text: string;
  paid: boolean;
  quote: PaymentQuote | null;
  authorization: PaymentAuthorization | null;
  receipt: SettlementReceipt | null;
  verification: Verification | null;
  dispute?: { filed: boolean; reason?: string; error?: string };
}

export interface PendingQuote {
  quote: PaymentQuote;
  service: ServiceDescriptor;
  route: Route;
  /** Pay the quote (budget and caps are checked first). Must happen before quote.expires_at. */
  pay(): Promise<CallResult>;
}

export class BudgetError extends Error {
  constructor(message: string, readonly quote?: PaymentQuote) { super(message); this.name = "BudgetError"; }
}

/** "1.5 HBAR" → { amount: "1.5", currency: "HBAR" }; 1.5 → { amount: "1.5" }. */
export function parseAmount(v: string | number | undefined): { amount: string; currency?: string } | null {
  if (v == null || v === "") return null;
  const m = /^\s*([0-9.]+)\s*([A-Za-z]+)?\s*$/.exec(String(v));
  if (!m) throw new Error(`not an amount: ${v}`);
  return { amount: m[1], currency: m[2]?.toUpperCase() };
}

export class MeterX402 {
  readonly accountId: string;
  readonly network: "hedera:testnet" | "hedera:mainnet";
  private key: PrivateKey;
  private signer;
  private budget: { atomic: bigint; currency?: string } | null;
  private maxPerCall: { atomic: bigint; currency?: string } | null;
  private _spent = 0n;
  private reserved = 0n;
  readonly receipts: SettlementReceipt[] = [];
  private registryUrl?: string;
  private autoDispute: boolean;

  constructor(private opts: MeterX402Options) {
    this.accountId = opts.wallet.accountId;
    this.network = opts.wallet.network ?? "hedera:testnet";
    this.key = typeof opts.wallet.privateKey === "string" ? parseHederaKey(opts.wallet.privateKey) : opts.wallet.privateKey;
    this.signer = createClientHederaSigner(this.accountId, this.key, { network: this.network });
    const b = parseAmount(opts.budget), m = parseAmount(opts.maxPerCall);
    this.budget = b ? { atomic: toAtomic(b.amount), currency: b.currency } : null;
    this.maxPerCall = m ? { atomic: toAtomic(m.amount), currency: m.currency } : null;
    this.registryUrl = opts.registry?.replace(/\/+$/, "");
    this.autoDispute = opts.autoDispute ?? true;
  }

  get spent() { return fromAtomic(this._spent); }
  get remaining() { return this.budget ? fromAtomic(this.budget.atomic - this._spent - this.reserved) : null; }
  get wallet() { return { accountId: this.accountId, privateKey: this.key, network: this.network }; }
  /** What this wallet can settle on, for route selection. */
  get supports() { return [{ network: this.network, currencies: this.budget?.currency ? [this.budget.currency] : undefined }]; }

  // ── discover ────────────────────────────────────────────────────────────

  async discover(filter: SearchFilter & { chains?: string[] } = {}): Promise<Listing[]> {
    const reg = this.needRegistry();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v != null && k !== "chains") q.set(k, String(v));
    const { services } = await fetch(`${reg}/registry/services?${q}`).then((r) => r.json());
    // only what this wallet can actually pay for
    return (services as Listing[]).filter((l) => selectRoute(l.descriptor.payment.settlement, this.supports) != null);
  }

  async service(id: string): Promise<Listing> {
    const r = await fetch(`${this.needRegistry()}/registry/services/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`service ${id} is not in the registry`);
    return r.json();
  }

  async reputation(id: string) {
    return fetch(`${this.needRegistry()}/registry/services/${encodeURIComponent(id)}/reputation`).then((r) => r.json());
  }

  private needRegistry() {
    if (!this.registryUrl) throw new Error("no registry configured: pass { registry: 'http://…' }");
    return this.registryUrl;
  }

  private async resolve(target: string | ServiceDescriptor | Listing): Promise<ServiceDescriptor> {
    if (typeof target !== "string") return "descriptor" in target ? target.descriptor : target;
    if (/^https?:\/\//.test(target)) {
      // a gateway URL: read its own descriptor, no registry needed
      const r = await fetch(`${target.replace(/\/+$/, "")}/.well-known/mx402`);
      if (!r.ok) throw new Error(`${target} does not serve a MeterX402 descriptor`);
      return r.json();
    }
    return (await this.service(target)).descriptor;
  }

  // ── quote ───────────────────────────────────────────────────────────────

  /** Run the call and get its exact metered price, without paying. The
   *  response is held by the service until the quote expires. */
  async quote(target: string | ServiceDescriptor | Listing, req: CallRequest = {}): Promise<PendingQuote | CallResult> {
    const service = await this.resolve(target);
    const route = selectRoute(service.payment.settlement, this.supports);
    if (!route) throw new BudgetError(`no compatible settlement route: ${service.service_id} settles on ${service.payment.settlement.map((o) => `${o.currency}@${o.network}`).join(", ")}, this wallet pays ${this.budget?.currency ?? "any"}@${this.network}`);

    const sample = service.sample ?? { method: "GET", path: "/" };
    const method = (req.method ?? (req.body != null ? "POST" : sample.method)).toUpperCase();
    const body = req.body != null ? (typeof req.body === "string" ? req.body : JSON.stringify(req.body)) : method !== "GET" ? sample.body : undefined;
    const url = new URL(`${service.endpoint}${req.path ?? sample.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { "x-mx402-interface": "sdk", ...req.headers };
    if (body != null) headers["content-type"] ??= "application/json";
    if (req.maxUnits) headers["x-meter-max-units"] = String(req.maxUnits);
    const init: RequestInit = { method, headers, body: method === "GET" ? undefined : body };

    const first = await fetch(url, init);
    if (first.status !== 402) return this.finish(first, null, null, null, body);
    const header = first.headers.get("payment-required");
    const quote = decodeHeader(first.headers.get("x-mx402-quote"), PaymentQuote);
    if (!header || !quote) throw new Error(`${service.service_id} answered 402 without a MeterX402 quote`);
    const paymentRequired = decodePaymentRequiredHeader(header);

    return { quote, service, route, pay: () => this.pay(url, init, body, quote, paymentRequired, req) };
  }

  /** Quote and pay in one step. */
  async call(target: string | ServiceDescriptor | Listing, req: CallRequest = {}): Promise<CallResult> {
    const q = await this.quote(target, req);
    return "pay" in q ? q.pay() : q;
  }

  // ── authorize + pay ─────────────────────────────────────────────────────

  private async pay(url: URL, init: RequestInit, body: string | undefined, quote: PaymentQuote, paymentRequired: PaymentRequired, req: CallRequest): Promise<CallResult> {
    const amount = BigInt(quote.amount_atomic);
    const maxPrice = parseAmount(req.maxPrice);
    if (maxPrice && amount > toAtomic(maxPrice.amount)) throw new BudgetError(`quote ${quote.amount} ${quote.currency} is above this call's limit of ${maxPrice.amount}`, quote);
    if (this.maxPerCall && amount > this.maxPerCall.atomic) throw new BudgetError(`quote ${quote.amount} ${quote.currency} is above maxPerCall ${fromAtomic(this.maxPerCall.atomic)}`, quote);
    if (this.budget && this._spent + this.reserved + amount > this.budget.atomic) {
      throw new BudgetError(`budget: ${this.spent} spent + ${quote.amount} would exceed ${fromAtomic(this.budget.atomic)} ${this.budget.currency ?? quote.currency}`, quote);
    }
    if (req.maxUnits && quote.units > req.maxUnits) throw new BudgetError(`quote bills ${quote.units} ${quote.unit}, above the cap of ${req.maxUnits}`, quote);
    if (Date.now() > quote.expires_at) throw new BudgetError("quote expired", quote);

    const authorization: PaymentAuthorization = {
      mx402: PROTOCOL_VERSION, kind: "exact", buyer: this.accountId, service_id: quote.service_id, network: quote.network as any,
      ...(this.maxPerCall ? { max_per_call: fromAtomic(this.maxPerCall.atomic) } : {}),
      ...(req.maxUnits ? { max_units: req.maxUnits } : {}),
      ...(this.budget ? { budget: fromAtomic(this.budget.atomic) } : {}),
      expires_at: quote.expires_at, quote_id: quote.quote_id, authorized_at: Date.now(),
    };

    this.reserved += amount;
    try {
      const payload = await this.x402().createPaymentPayload(paymentRequired);
      const headers = new Headers(init.headers);
      headers.set("PAYMENT-SIGNATURE", encodePaymentSignatureHeader(payload));
      const res = await fetch(url, { ...init, headers });
      const result = await this.finish(res, quote, authorization, paymentRequired, body);
      if (result.paid) this._spent += amount;
      return result;
    } finally {
      this.reserved -= amount;
    }
  }

  /** The x402 client, signing only within this buyer's per-call ceiling. */
  x402() {
    const client = new x402Client().register(this.network, new ExactHederaScheme(this.signer) as any);
    client.setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{ network: this.network, asset: "0.0.0", ...(this.maxPerCall ? { maxAmountPerPayment: this.maxPerCall.atomic.toString() } : {}) }],
    });
    return client;
  }

  // ── receipt + verification ──────────────────────────────────────────────

  private async finish(res: Response, quote: PaymentQuote | null, authorization: PaymentAuthorization | null, _pr: PaymentRequired | null, reqBody?: string): Promise<CallResult> {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let data: unknown = text;
    try { data = JSON.parse(text); } catch {}
    const receipt = decodeHeader(res.headers.get("x-mx402-receipt"), SettlementReceipt);
    const settle = res.headers.get("payment-response");
    const paid = res.ok && !!receipt && !!settle && (() => { try { return decodePaymentResponseHeader(settle).success; } catch { return false; } })();
    if (receipt) this.receipts.push(receipt);

    let verification: Verification | null = null;
    let dispute: CallResult["dispute"];
    if (quote && res.ok) {
      verification = verify(quote, bytes, text, data, reqBody);
      if (this.autoDispute && this.registryUrl && paid && (!verification.bodyHash || verification.unitsMatch === false)) {
        dispute = await this.fileDispute(quote, receipt, verification, bytes);
      }
    }
    return { ok: res.ok, status: res.status, data, text, paid, quote, authorization, receipt, verification, dispute };
  }

  private async fileDispute(quote: PaymentQuote, receipt: SettlementReceipt | null, v: Verification, bytes: Uint8Array): Promise<CallResult["dispute"]> {
    const reason = !v.bodyHash ? "body_hash_mismatch" : "units_mismatch";
    try {
      const r = await fetch(`${this.registryUrl}/registry/services/${quote.service_id}/disputes`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quote_id: quote.quote_id, receipt_id: receipt?.receipt_id ?? null, buyer: this.accountId, reason,
          claimed_units: quote.measured, observed_units: v.remetered,
          body_sha256_claimed: quote.body_sha256, body_sha256_observed: createHash("sha256").update(bytes).digest("hex"),
        }),
      }).then((x) => x.json());
      return r.ok ? { filed: true, reason } : { filed: false, reason, error: r.error };
    } catch (e) {
      return { filed: false, reason, error: String(e).split("\n")[0] };
    }
  }
}

/** The buyer's own check of what it received against what it was quoted. */
export function verify(quote: PaymentQuote, bytes: Uint8Array, text: string, json: unknown, reqBody?: string): Verification {
  const bodyHash = createHash("sha256").update(bytes).digest("hex") === quote.body_sha256;
  const kind = quote.meter.split(":")[0];
  if (kind === "ms") return { bodyHash, remetered: null, unitsMatch: null, method: "none" };
  let req: unknown;
  if (reqBody) { try { req = JSON.parse(reqBody); } catch {} }
  const remetered = makeMeter(quote.meter).measure({ reqBody: req, status: 200, resText: text, resJson: json === text ? undefined : json, bytes: bytes.byteLength, ms: 0 });
  // tokens are counted from the usage block the upstream itself reports, so a
  // match proves consistency with the body, not the model's true work
  return { bodyHash, remetered, unitsMatch: remetered === quote.measured, method: kind === "tokens" ? "self-reported" : "exact" };
}
