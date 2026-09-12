// X402ExactAdapter: per-call settlement through an x402 facilitator.
//
// A thin, honest wrapper over the official x402ResourceServer. It exists so the
// gateway depends on the SettlementAdapter interface rather than on @x402
// internals, and so the same code path serves every chain preset.

import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { ChainPreset } from "../chains.ts";
import type { AdapterQuote, Authorization, Capability, QuoteRequest, Settlement, SettlementAdapter, Verification } from "./adapter.ts";

export class X402ExactAdapter implements SettlementAdapter {
  readonly name: string;
  private server: x402ResourceServer | null = null;
  private _ready = false;
  private initP: Promise<void> | null = null;

  constructor(
    private preset: ChainPreset,
    private opts: { network: `${string}:${string}`; facilitator: string; tabs?: boolean },
  ) {
    this.name = `x402-exact:${opts.network}`;
  }

  get ready() { return this._ready; }
  get facilitator() { return this.opts.facilitator; }
  get network() { return this.opts.network; }

  capabilities(): Capability[] {
    return [{
      network: this.opts.network,
      asset: this.preset.asset,
      currency: this.preset.currency,
      decimals: this.preset.decimals,
      // tabs are layered on by the gateway when a TabLedger is configured
      schemes: this.opts.tabs ? ["exact", "tab"] : ["exact"],
      facilitator: this.opts.facilitator,
      ...(this.preset.fee ? { fee: this.preset.fee } : {}),
    }];
  }

  /** Fetch the facilitator's supported kinds (for Hedera: its fee payer).
   *  Retries in the background; quotes wait for it briefly, then fail with 503. */
  init(): Promise<void> {
    this.initP ??= (async () => {
      const Scheme = await this.preset.load();
      this.server = new x402ResourceServer(new HTTPFacilitatorClient({ url: this.opts.facilitator }))
        .register(this.preset.register, new Scheme());
      for (let i = 0; !this._ready; i++) {
        try { await this.server.initialize(); this._ready = true; }
        catch (e) {
          if (i === 0) console.warn(`[${this.name}] facilitator ${this.opts.facilitator} not reachable yet: ${String(e).split("\n")[0]}`);
          await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** i)));
        }
      }
    })();
    return this.initP;
  }

  async quote(req: QuoteRequest): Promise<AdapterQuote> {
    if (!this.server || !this._ready) throw new Error("facilitator_unavailable");
    const [requirements] = await this.server.buildPaymentRequirements({
      scheme: "exact",
      network: this.opts.network,
      payTo: req.payTo,
      price: this.preset.price(req.amountAtomic),
      maxTimeoutSeconds: req.maxTimeoutSeconds,
      extra: req.extra,
    });
    const paymentRequired = await this.server.createPaymentRequiredResponse([requirements], req.resource, req.error ?? "payment_required");
    return { requirements, paymentRequired, header: encodePaymentRequiredHeader(paymentRequired) };
  }

  async authorize(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Authorization> {
    if (!this.server) return { ok: false, reason: "facilitator_unavailable" };
    // the payload must be for THIS quote: same amount, payTo, network, asset, meter reading
    if (!this.server.findMatchingRequirements([requirements], payload)) return { ok: false, reason: "payment_does_not_match_quote" };
    try {
      const v = await this.server.verifyPayment(payload, requirements);
      return v.isValid ? { ok: true, payer: v.payer } : { ok: false, reason: v.invalidReason ?? "invalid_payment", detail: v.invalidMessage, payer: v.payer };
    } catch (e: any) {
      // a 4xx from the facilitator arrives as a thrown VerifyError carrying the reason
      return { ok: false, reason: e?.invalidReason ?? "verify_failed", detail: e?.invalidMessage ?? String(e).split("\n")[0] };
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Settlement> {
    if (!this.server) return { ok: false, reason: "facilitator_unavailable" };
    try {
      const s = await this.server.settlePayment(payload, requirements);
      return s.success
        ? { ok: true, transaction: s.transaction, payer: s.payer, network: s.network, raw: s }
        : { ok: false, reason: s.errorReason ?? "settle_failed", detail: s.errorMessage };
    } catch (e: any) {
      return { ok: false, reason: e?.errorReason ?? "settle_failed", detail: e?.errorMessage ?? String(e).split("\n")[0] };
    }
  }

  async verify(transaction: string, payTo: string): Promise<Verification> {
    if (this.opts.network.startsWith("eip155:") || this.opts.network.startsWith("solana:")) {
      const { verifyEvmTransfer, verifySolanaTransfer } = await import("./verify-chains.ts");
      return this.opts.network.startsWith("eip155:")
        ? verifyEvmTransfer(this.opts.network, transaction, payTo)
        : verifySolanaTransfer(this.opts.network, transaction, payTo);
    }
    if (!this.opts.network.startsWith("hedera:")) return { verified: false, detail: `no independent verifier for ${this.opts.network} yet` };
    const { mirrorTransfer } = await import("../hedera.ts");
    const asset = this.preset.asset;
    const r = await mirrorTransfer(transaction, payTo, asset);
    if (!r.found) return { verified: false, detail: "not found on the mirror node" };
    const unit = asset === "0.0.0" ? "tinybar" : this.preset.currency;
    // With an inclusive custom fee the seller nets less than the buyer signed
    // for. Say so plainly rather than reporting a shortfall as a failure.
    const fees = r.assessedFees ?? [];
    const taken = fees.reduce((s, f) => s + f.amount, 0n);
    const feeNote = taken > 0n
      ? `; ledger took ${taken} ${unit} in custom fees (${fees.map((f) => f.collector).join(", ")}), seller nets ${r.tinybar}`
      : "";
    return {
      verified: r.result === "SUCCESS",
      credited: r.gross ?? r.tinybar,
      detail: `mirror node: ${r.result}, ${r.tinybar} ${unit} to ${payTo}${feeNote}`,
    };
  }
}
