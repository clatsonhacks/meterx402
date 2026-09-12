// A quote round: the buyer states the job and a ceiling, sellers answer, the
// buyer picks.
//
// Until now discovery was "rank the registry and call the winner" — the buyer
// took whatever price was advertised. A round inverts that: the requirement
// comes first, several sellers answer it at once, and the losers are recorded
// alongside the winner. That makes an existing claim honest rather than adding
// a new one, because "the agent negotiates" now means something you can read
// back: who was asked, who answered, what they offered, who won and why.
//
// Two kinds of answer:
//
//   estimate (default) — priced from the seller's published rate card and the
//     buyer's declared ceiling. Costs nobody anything, because no upstream work
//     is done. Asking five sellers for a real quote would mean five upstream
//     calls and four wasted ones, which is rude and does not scale.
//   binding — a real 402 from the seller: the work IS done, the body held, and
//     the price exact. Reserved for the shortlist the buyer actually cares
//     about, and opted into.

import { priceAtomic, fromAtomic, toAtomic } from "../pricing.ts";
import type { Listing } from "./registry.ts";
import type { PaymentQuote } from "../protocol/schemas.ts";

export type OfferStatus = "offered" | "declined" | "no_response";

export interface Offer {
  service_id: string;
  seller: string;
  endpoint: string;
  status: OfferStatus;
  /** why a seller is not in the running */
  reason?: string;
  unit: string;
  rate: string;
  per: number;
  currency: string;
  /** units the estimate was priced on */
  est_units: number | null;
  /** what the buyer would pay, as far as can be known without doing the work */
  est_amount: string | null;
  /** the most this seller could charge for one call */
  worst_case: string | null;
  reputation: number | null;
  median_latency_ms: number | null;
  /** how long the seller took to answer the round */
  ms: number;
  /** present only for binding offers: a real, payable quote */
  quote?: PaymentQuote;
  /** 0–1, higher is better; how the winner was chosen */
  rank: number;
}

export interface Rfq {
  rfq_id: string;
  buyer: string;
  capability?: string;
  service_ids?: string[];
  max_price?: string;
  max_units?: number;
  currency: string;
  binding: boolean;
  created_at: number;
}

export interface Round {
  rfq: Rfq;
  offers: Offer[];
  winner: string | null;
  why: string;
  decided_at: number;
}

/** How a round is scored. A ceiling was stated, so price carries more than it
 *  does in plain discovery; reputation still outweighs a few tinybar. */
export const RFQ_WEIGHTS = { price: 0.45, reputation: 0.4, latency: 0.15 };

const dec = (atomic: bigint, decimals: number) => fromAtomic(atomic, decimals);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** What this seller would charge, as far as is knowable without doing the work. */
export function estimate(l: Listing, maxUnits: number | undefined, decimals = 8): { units: number | null; amount: string | null; worst: string | null } {
  const p = l.descriptor.pricing;
  const card = { rate: p.rate, per: p.per, min: p.min };
  const cap = p.max_units ?? null;
  const worst = cap == null ? null : dec(priceAtomic(cap, card, 1, decimals), decimals);
  if (maxUnits != null) {
    const units = cap == null ? maxUnits : Math.min(maxUnits, cap);
    return { units, amount: dec(priceAtomic(units, card, 1, decimals), decimals), worst };
  }
  // no stated size: the typical charge if the hub has seen payments, else the cap
  if (l.price.typical_call != null) return { units: null, amount: String(l.price.typical_call), worst };
  return { units: cap, amount: worst, worst };
}

/** Collect offers, score them, and say who won. */
export function runRound(
  rfq: Rfq,
  candidates: Listing[],
  opts: { decimals?: number; now?: number } = {},
): Round {
  const decimals = opts.decimals ?? 8;
  const now = opts.now ?? Date.now();
  const ceiling = rfq.max_price ? toAtomic(rfq.max_price, decimals) : null;

  const offers: Offer[] = candidates.map((l) => {
    const started = now;
    const p = l.descriptor.pricing;
    const est = estimate(l, rfq.max_units, decimals);
    const base: Offer = {
      service_id: l.service_id,
      seller: l.descriptor.owner.account,
      endpoint: l.descriptor.endpoint,
      status: "offered",
      unit: p.unit, rate: p.rate, per: p.per, currency: p.currency,
      est_units: est.units, est_amount: est.amount, worst_case: est.worst,
      reputation: l.reputation.score,
      median_latency_ms: l.reputation.stats.median_latency_ms ?? null,
      ms: Math.max(0, (opts.now ?? Date.now()) - started),
      rank: 0,
    };
    if (!l.live) return { ...base, status: "no_response", reason: "not answering liveness probes" };
    if (p.currency !== rfq.currency) return { ...base, status: "declined", reason: `settles in ${p.currency}, the round is in ${rfq.currency}` };
    if (ceiling != null && est.amount != null && toAtomic(est.amount, decimals) > ceiling) {
      return { ...base, status: "declined", reason: `${est.amount} ${p.currency} is above the ceiling of ${rfq.max_price}` };
    }
    if (ceiling != null && rfq.max_units == null && est.worst != null && toAtomic(est.worst, decimals) > ceiling) {
      // it might fit, but it could also blow the ceiling: say so rather than pretend
      return { ...base, reason: `could reach ${est.worst} ${p.currency} at its cap, above the ceiling`, rank: 0 };
    }
    return base;
  });

  // Score the ones still standing. Price and latency are scored as RATIOS to
  // the best in the round, not stretched across its range: twice the price is
  // half the score, whoever else turned up. Min-max normalising would make a
  // 20% price gap look like the whole spectrum whenever the field is tight,
  // and let a cheap, badly rated seller beat a good one on rounding.
  const live = offers.filter((o) => o.status === "offered");
  const prices = live.map((o) => (o.est_amount == null ? Infinity : Number(o.est_amount))).filter((n) => Number.isFinite(n) && n > 0);
  const cheapest = Math.min(...prices, Infinity);
  const lats = live.map((o) => o.median_latency_ms ?? Infinity).filter((n) => Number.isFinite(n) && n > 0) as number[];
  const fastest = Math.min(...lats, Infinity);

  for (const o of live) {
    const amount = o.est_amount == null ? null : Number(o.est_amount);
    const price = amount == null || !Number.isFinite(cheapest) ? 0.5
      : amount <= 0 ? 1
      : clamp01(cheapest / amount);
    // an unrated service is not assumed bad, but it does not beat a proven one
    const rep = o.reputation == null ? 0.5 : clamp01(o.reputation / 100);
    const lat = o.median_latency_ms == null || !Number.isFinite(fastest) ? 0.5
      : clamp01(fastest / Math.max(1, o.median_latency_ms));
    o.rank = Math.round((RFQ_WEIGHTS.price * price + RFQ_WEIGHTS.reputation * rep + RFQ_WEIGHTS.latency * lat) * 1000) / 1000;
  }

  live.sort((a, b) => b.rank - a.rank);
  const winner = live[0] ?? null;
  const why = !winner
    ? offers.length ? "every seller declined or was unreachable" : "no service offers that capability"
    : live.length === 1
      ? `only ${winner.service_id} could take it`
      : `${winner.service_id} at ${winner.est_amount} ${winner.currency}` +
        `${winner.reputation != null ? `, reputation ${winner.reputation}` : ", unrated"}` +
        ` — beat ${live.length - 1} other${live.length === 2 ? "" : "s"} on price ${RFQ_WEIGHTS.price}, reputation ${RFQ_WEIGHTS.reputation}, latency ${RFQ_WEIGHTS.latency}`;

  // declined and unreachable sellers stay in the record, after the ranked ones
  const rest = offers.filter((o) => o.status !== "offered");
  return { rfq, offers: [...live, ...rest], winner: winner?.service_id ?? null, why, decided_at: now };
}
