// Settlement adapters: the only layer that knows how money actually moves.
//
// Everything above this (gateway, registry, SDKs, MCP, A2A) asks an adapter for
// capabilities and quotes instead of hardcoding chain behaviour. Two adapter
// families exist today:
//
//   X402ExactAdapter  per-call "exact" settlement through any x402 facilitator.
//                     x402 is chain-agnostic, so this one class serves Hedera
//                     (tested, blocky402), Base and Solana (presets).
//   TabLedger         bounded-allowance sessions (Metered Tabs). Hedera only:
//                     it is built on native HBAR allowances (src/tabs.ts).
//
// A service advertises the union of its adapters' capabilities in its
// ServiceDescriptor; a buyer's SDK intersects that with what its wallet can do
// (selectRoute) and never touches chain-specific code.

import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { SettlementOption } from "../protocol/schemas.ts";

export type Capability = SettlementOption;

export interface QuoteRequest {
  amountAtomic: bigint;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
  resource: { url: string; description: string; mimeType: string };
  error?: string;
}

export interface AdapterQuote {
  requirements: PaymentRequirements;
  paymentRequired: PaymentRequired;
  header: string; // PAYMENT-REQUIRED, encoded
}

export type Authorization = { ok: true; payer?: string } | { ok: false; reason: string; detail?: string; payer?: string };
export type Settlement =
  | { ok: true; transaction: string; payer?: string; network: string; raw: unknown }
  | { ok: false; reason: string; detail?: string };
export type Verification = { verified: boolean; credited?: bigint; detail: string };

export interface SettlementAdapter {
  readonly name: string;
  capabilities(): Capability[];
  /** Become able to quote (e.g. fetch the facilitator's fee payer). */
  init(): Promise<void>;
  readonly ready: boolean;
  /** Turn an exact metered amount into payment requirements a buyer can sign. */
  quote(req: QuoteRequest): Promise<AdapterQuote>;
  /** Is this signed payment valid for these requirements? No money moves. */
  authorize(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Authorization>;
  /** Move the money. */
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Settlement>;
  /** Independently confirm a settlement landed (e.g. read the mirror node). */
  verify(transaction: string, payTo: string): Promise<Verification>;
}

// ── route selection ───────────────────────────────────────────────────────

export interface WalletSupport {
  network: string;             // "hedera:testnet"
  currencies?: string[];       // ["HBAR"]; omit = any currency on that network
}

export interface Route { option: Capability; scheme: "exact" | "tab"; }

/** The first settlement option both sides support. Prefers a tab when the
 *  buyer asked for one and the service offers it, since that is the cheaper,
 *  faster path for repeated calls; otherwise per-call exact settlement. */
export function selectRoute(accepts: Capability[], wallet: WalletSupport[], prefer: "exact" | "tab" = "exact"): Route | null {
  const compatible = accepts.filter((o) =>
    wallet.some((w) => w.network === o.network && (!w.currencies || w.currencies.map((c) => c.toUpperCase()).includes(o.currency.toUpperCase()))));
  if (!compatible.length) return null;
  const withPreferred = compatible.find((o) => o.schemes.includes(prefer));
  if (withPreferred) return { option: withPreferred, scheme: prefer };
  const exact = compatible.find((o) => o.schemes.includes("exact"));
  return exact ? { option: exact, scheme: "exact" } : { option: compatible[0], scheme: compatible[0].schemes[0] };
}
