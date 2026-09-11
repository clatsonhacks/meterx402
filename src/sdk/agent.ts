// MeterX402 agent SDK: discover, evaluate, budget for and pay for services,
// without knowing anything about the chain underneath.
//
//   const agent = new MeterX402Agent({ wallet, budget: "5 HBAR", registry: HUB });
//   const [best] = await agent.discover({ capability: "weather_forecast", minReputation: 80 });
//   const r = await agent.call(best, { query: { forecast_days: "2" } }, { maxPrice: "0.05" });
//   // or just name the capability; the agent picks the best compatible service:
//   await agent.call("weather_forecast");
//   // pay another agent over A2A:
//   await agent.a2a("http://translator.example", "translate 'hello' to French");
//
// One budget covers every path: per-call exact payments, Metered Tabs (for
// repeated calls, when `useTabs` is on and the service offers them) and A2A.

import { MeterX402, BudgetError, parseAmount, type CallRequest, type CallResult, type MeterX402Options } from "./buyer.ts";
import { createMeteredBuyer, type TabSession } from "../paid-fetch.ts";
import { a2aCall, fetchAgentCard, type Message, type Task } from "../adapters/a2a.ts";
import { selectRoute } from "../settlement/adapter.ts";
import { decodeHeader, PaymentQuote, SettlementReceipt, type ServiceDescriptor } from "../protocol/schemas.ts";
import { fromAtomic, toAtomic } from "../pricing.ts";
import type { Listing, SearchFilter } from "../registry/registry.ts";

export interface AgentOptions extends MeterX402Options {
  /** Networks this agent can settle on (default: its wallet's). */
  chains?: string[];
  /** Open a Metered Tab per service for repeated calls, with this allowance. */
  useTabs?: false | { allowance: string | number };
}

export interface CallOptions { maxPrice?: string | number; maxUnits?: number; }

export interface A2AResult {
  task: Task;
  data: unknown;
  quote: PaymentQuote | null;
  receipt: SettlementReceipt | null;
  paid: boolean;
}

export class MeterX402Agent {
  readonly mx: MeterX402;
  private tabs = new Map<string, Promise<TabSession>>();
  private tabSpent = 0n;
  private a2aSpent = 0n;

  constructor(private o: AgentOptions) {
    this.mx = new MeterX402(o);
  }

  get spent() { return fromAtomic(toAtomic(this.mx.spent) + this.tabSpent + this.a2aSpent); }
  get remaining() {
    const b = parseAmount(this.o.budget);
    return b ? fromAtomic(toAtomic(b.amount) - toAtomic(this.spent)) : null;
  }
  get receipts() { return this.mx.receipts; }

  private get supports() {
    const b = parseAmount(this.o.budget);
    return (this.o.chains ?? [this.mx.network]).map((network) => ({ network, currencies: b?.currency ? [b.currency] : undefined }));
  }

  /** Services that do what's needed, that this agent can pay for, best first. */
  async discover(filter: SearchFilter = {}): Promise<Listing[]> {
    const found = await this.mx.discover(filter);
    return found.filter((l) => selectRoute(l.descriptor.payment.settlement, this.supports) != null);
  }

  /** Call a service by id, URL, listing — or by capability, picking the best. */
  async call(target: string | Listing | ServiceDescriptor, req: CallRequest = {}, opts: CallOptions = {}): Promise<CallResult & { service: string }> {
    const service = await this.pick(target);
    const remaining = this.remaining;
    const maxPrice = opts.maxPrice ?? req.maxPrice;
    // never let one call spend past the agent's whole budget
    const cap = remaining == null ? maxPrice : maxPrice == null ? remaining : String(Math.min(Number(parseAmount(maxPrice)!.amount), Number(remaining)));
    const wantTab = !!this.o.useTabs && service.payment.settlement.some((o) => o.schemes.includes("tab"));
    if (wantTab) return { ...(await this.callOnTab(service, { ...req, maxUnits: opts.maxUnits ?? req.maxUnits })), service: service.service_id };
    return { ...(await this.mx.call(service, { ...req, maxPrice: cap, maxUnits: opts.maxUnits ?? req.maxUnits })), service: service.service_id };
  }

  private async pick(target: string | Listing | ServiceDescriptor): Promise<ServiceDescriptor> {
    if (typeof target !== "string") return "descriptor" in target ? target.descriptor : target;
    if (/^https?:\/\//.test(target)) return fetch(`${target.replace(/\/+$/, "")}/.well-known/mx402`).then((r) => r.json());
    try { return (await this.mx.service(target)).descriptor; } catch {}
    const [best] = await this.discover({ capability: target });
    if (!best) throw new Error(`no service in the registry for "${target}" that this agent can pay for`);
    return best.descriptor;
  }

  // ── Metered Tabs for repeated calls ─────────────────────────────────────

  private tabFor(service: ServiceDescriptor): Promise<TabSession> {
    let t = this.tabs.get(service.service_id);
    if (!t) {
      const allowance = (this.o.useTabs as { allowance: string | number }).allowance;
      const w = this.mx.wallet;
      t = createMeteredBuyer({ accountId: w.accountId, privateKey: w.privateKey, network: w.network })
        .openTab(service.endpoint, { allowance })
        .catch((e) => { this.tabs.delete(service.service_id); throw e; });
      this.tabs.set(service.service_id, t);
    }
    return t;
  }

  private async callOnTab(service: ServiceDescriptor, req: CallRequest): Promise<CallResult> {
    const tab = await this.tabFor(service);
    const sample = service.sample ?? { method: "GET", path: "/" };
    const method = (req.method ?? (req.body != null ? "POST" : sample.method)).toUpperCase();
    const body = req.body != null ? (typeof req.body === "string" ? req.body : JSON.stringify(req.body)) : method !== "GET" ? sample.body : undefined;
    const url = new URL(`${service.endpoint}${req.path ?? sample.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const r = await tab.buy(url.toString(), { method, body, headers: { "x-mx402-interface": "sdk", ...req.headers }, maxUnits: req.maxUnits });
    const receipt = decodeHeader(r.res.headers.get("x-mx402-receipt"), SettlementReceipt);
    if (receipt) { this.mx.receipts.push(receipt); this.tabSpent += BigInt(receipt.amount_atomic); }
    let data: unknown = r.body;
    try { data = JSON.parse(r.body); } catch {}
    return {
      ok: r.res.ok, status: r.status, data, text: r.body, paid: !!receipt, quote: null, authorization: null, receipt,
      verification: r.receipt ? { bodyHash: r.receipt.bodyVerified, remetered: null, unitsMatch: null, method: "none" } : null,
    };
  }

  // ── paying another agent over A2A ───────────────────────────────────────

  /** Send a task to an A2A agent and pay its metered quote, within budget. */
  async a2a(agentUrl: string, input: string | Record<string, unknown>, opts: CallOptions = {}): Promise<A2AResult> {
    const card = await fetchAgentCard(agentUrl);
    const message: Message = {
      kind: "message", role: "user", messageId: crypto.randomUUID(),
      parts: [typeof input === "string" ? { kind: "text", text: input } : { kind: "data", data: input }],
      ...(opts.maxUnits ? { metadata: { "mx402.max_units": opts.maxUnits } } : {}),
    };
    let task: Task = await a2aCall(card.url, "message/send", { message });
    let quote: PaymentQuote | null = null;
    let paid = false;

    if (task.status.state === "input-required" && task.metadata?.["x402.payment.status"] === "payment-required") {
      quote = PaymentQuote.parse(task.metadata["mx402.quote"]);
      const required = task.metadata["x402.payment.required"] as any;
      const amount = BigInt(quote.amount_atomic);
      const remaining = this.remaining;
      const maxPrice = parseAmount(opts.maxPrice);
      if (maxPrice && amount > toAtomic(maxPrice.amount)) throw new BudgetError(`${card.name} quoted ${quote.amount} ${quote.currency}, above ${maxPrice.amount}`, quote);
      if (remaining != null && amount > toAtomic(remaining)) throw new BudgetError(`${card.name} quoted ${quote.amount} ${quote.currency}; only ${remaining} left in budget`, quote);
      const payload = await this.mx.x402().createPaymentPayload(required);
      task = await a2aCall(card.url, "message/send", {
        message: {
          kind: "message", role: "user", messageId: crypto.randomUUID(), taskId: task.id, contextId: task.contextId,
          parts: [{ kind: "text", text: "payment attached" }],
          metadata: { "x402.payment.status": "payment-submitted", "x402.payment.payload": payload },
        },
      });
      paid = task.status.state === "completed";
      if (paid) this.a2aSpent += amount;
    }

    const receipt = task.metadata?.["mx402.receipt"] ? SettlementReceipt.parse(task.metadata["mx402.receipt"]) : null;
    if (receipt) this.mx.receipts.push(receipt);
    const part = task.artifacts?.[0]?.parts?.[0];
    const data = part ? (part.kind === "data" ? (part.data as any).result ?? part.data : part.text) : null;
    return { task, data, quote, receipt, paid };
  }

  /** Settle and close any open tabs. */
  async close(): Promise<void> {
    await Promise.all([...this.tabs.values()].map(async (t) => { try { await (await t).close(); } catch {} }));
    this.tabs.clear();
  }
}
