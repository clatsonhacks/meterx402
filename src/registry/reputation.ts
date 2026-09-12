// Reputation: a deterministic score built from what services actually did.
//
// No ratings, no votes: every input is an event the payment layer already
// records (and, for settlements and disputes, anchors on HCS):
//
//   component            weight   evidence                                            1.0 means
//   execution             30%     paid calls ÷ (paid calls + seller-caused failures)  every paid call delivered
//   response_success      20%     upstream 2xx ÷ upstream calls                      the API never errored
//   latency               15%     median upstream time                                ≤ 300 ms (0 at ≥ 3 s)
//   disputes              15%     1 − 10 × (disputes ÷ paid calls)                     no disputes (0 at ≥ 10%)
//   uptime                10%     liveness probes answered ÷ probes                   always reachable
//   payment_reliability   10%     settlements succeeded ÷ settlement attempts         every valid payment settled
//
// Seller-caused failures are the ones a buyer can't cause: upstream 5xx or
// unreachable, quotes that couldn't be built, settlements that failed after the
// buyer's payment verified. A buyer's bad signature or empty wallet never
// lowers a seller's score.
//
// The weights are the starting model from the architecture doc, not a law; they
// are published inside every ReputationRecord so anyone can recompute a score.
// Below 5 samples a service is "unrated" (score null) rather than ranked on noise.

import type { MXEvent } from "../events.ts";
import { PROTOCOL_VERSION, type ReputationComponents, type ReputationRecord } from "../protocol/schemas.ts";

export const WEIGHTS: ReputationComponents = {
  execution: 0.3,
  response_success: 0.2,
  latency: 0.15,
  disputes: 0.15,
  uptime: 0.1,
  payment_reliability: 0.1,
};

interface Stats {
  calls: number;
  paid: number;
  revenue: number;
  upstreamCalls: number;
  upstreamErrors: number;
  sellerFailures: number;
  settleAttempts: number;
  settleFailures: number;
  disputes: number;
  latencies: number[];
  probesUp: number;
  probes: number;
  // quote rounds: asked, answered, won. Evidence about whether a seller shows
  // up to compete, which is not the same as whether it delivers once paid, so
  // it is reported rather than folded into the weighted score.
  rfqAsked: number;
  rfqOffered: number;
  rfqWon: number;
}

const blank = (): Stats => ({
  calls: 0, paid: 0, revenue: 0, upstreamCalls: 0, upstreamErrors: 0, sellerFailures: 0,
  settleAttempts: 0, settleFailures: 0, disputes: 0, latencies: [], probesUp: 0, probes: 0,
  rfqAsked: 0, rfqOffered: 0, rfqWon: 0,
});

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ratio = (num: number, den: number, empty = 1) => (den > 0 ? clamp01(num / den) : empty);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

// failures that are the buyer's doing, and so never count against a seller
const BUYER_REASONS = new Set([
  "insufficient_funds", "invalid_payer_signature", "amount_mismatch", "payment_does_not_match_quote",
  "payment_does_not_match_request", "payer_not_found", "transaction_already_used", "fee_payer_mismatch",
  "expected_single_payer", "not_a_transfer", "invalid_transaction_bytes", "tab_exhausted", "tab_frozen",
]);

export class ReputationEngine {
  private stats = new Map<string, Stats>();
  private anchors = new Map<string, ReputationRecord["anchor"]>();

  private s(id: string): Stats {
    let st = this.stats.get(id);
    if (!st) this.stats.set(id, (st = blank()));
    return st;
  }

  services(): string[] { return [...this.stats.keys()]; }

  /** Fold one payment-layer event into the service's evidence. */
  ingest(serviceId: string, ev: Pick<MXEvent, "type" | "data">): void {
    const st = this.s(serviceId);
    const d = ev.data ?? {};
    switch (ev.type) {
      case "request_in":
        st.calls++;
        break;
      case "metered":
        st.upstreamCalls++;
        if (typeof d.ms === "number") { st.latencies.push(d.ms); if (st.latencies.length > 1000) st.latencies.shift(); }
        break;
      case "upstream_error": {
        const status = Number(d.status ?? 502);
        // a 4xx is almost always the caller's request (bad path, bad params); only
        // server-side failures and unreachable upstreams count against the seller
        if (status >= 500 || status === 0) { st.upstreamCalls++; st.upstreamErrors++; st.sellerFailures++; }
        break;
      }
      case "settled":
        st.paid++;
        st.revenue += Number(d.amount) || 0;
        if (d.scheme !== "tab") st.settleAttempts++;
        break;
      case "tab_flush":
        st.settleAttempts++;
        if (d.error) { st.settleFailures++; st.sellerFailures++; }
        break;
      case "payment_failed": {
        const reason = String(d.reason ?? "");
        if (d.stage === "settle" && !BUYER_REASONS.has(reason)) { st.settleAttempts++; st.settleFailures++; st.sellerFailures++; }
        break;
      }
      case "dispute":
        st.disputes++;
        break;
      case "quote_round": {
        st.rfqAsked++;
        if (d.status === "offered") st.rfqOffered++;
        if (d.won) st.rfqWon++;
        break;
      }
    }
  }

  /** A liveness probe of the service's endpoint. */
  probe(serviceId: string, up: boolean): void {
    const st = this.s(serviceId);
    st.probes++;
    if (up) st.probesUp++;
    if (st.probes > 10_000) { st.probes = Math.round(st.probes / 2); st.probesUp = Math.round(st.probesUp / 2); }
  }

  setAnchor(serviceId: string, anchor: ReputationRecord["anchor"]) { this.anchors.set(serviceId, anchor); }

  record(serviceId: string, now = Date.now()): ReputationRecord {
    const st = this.stats.get(serviceId) ?? blank();
    const median = quantile(st.latencies, 0.5);
    const components: ReputationComponents = {
      execution: round3(ratio(st.paid, st.paid + st.sellerFailures)),
      response_success: round3(ratio(st.upstreamCalls - st.upstreamErrors, st.upstreamCalls)),
      latency: round3(median == null ? 1 : clamp01(1 - (median - 300) / 2700)),
      disputes: round3(st.paid > 0 ? clamp01(1 - (10 * st.disputes) / st.paid) : st.disputes ? 0 : 1),
      uptime: round3(ratio(st.probesUp, st.probes)),
      payment_reliability: round3(ratio(st.settleAttempts - st.settleFailures, st.settleAttempts)),
    };
    const sample = st.upstreamCalls + st.settleFailures;
    const confidence = sample < 5 ? "none" : sample < 20 ? "low" : sample < 100 ? "medium" : "high";
    const weighted = (Object.keys(WEIGHTS) as (keyof ReputationComponents)[]).reduce((sum, k) => sum + WEIGHTS[k] * components[k], 0);
    return {
      mx402: PROTOCOL_VERSION,
      service_id: serviceId,
      score: confidence === "none" ? null : Math.round(weighted * 1000) / 10,
      confidence,
      sample_size: sample,
      components,
      weights: WEIGHTS,
      stats: {
        calls: st.calls,
        paid_calls: st.paid,
        revenue: Math.round(st.revenue * 1e8) / 1e8,
        upstream_calls: st.upstreamCalls,
        upstream_errors: st.upstreamErrors,
        settle_attempts: st.settleAttempts,
        settle_failures: st.settleFailures,
        quote_rounds: st.rfqAsked,
        quotes_offered: st.rfqOffered,
        quote_rounds_won: st.rfqWon,
        disputes: st.disputes,
        median_latency_ms: median,
        p90_latency_ms: quantile(st.latencies, 0.9),
        uptime_ratio: st.probes ? round3(st.probesUp / st.probes) : null,
      },
      computed_at: now,
      ...(this.anchors.get(serviceId) ? { anchor: this.anchors.get(serviceId)! } : {}),
    };
  }
}
