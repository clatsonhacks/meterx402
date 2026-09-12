// Quote rounds: the buyer states a job and a ceiling, sellers answer, and the
// losers are part of the record.
//
// What matters here is that the round is decidable and honest: a ceiling is
// enforced, a seller that cannot be reached is not silently dropped, a seller
// that might blow the ceiling is flagged rather than quietly ranked, and the
// reason for the winner is something a person can read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runRound, estimate, RFQ_WEIGHTS, type Rfq } from "../src/registry/rfq.ts";
import type { Listing } from "../src/registry/registry.ts";
import { ReputationEngine } from "../src/registry/reputation.ts";

const listing = (o: {
  id: string; rate: string; per?: number; cap?: number | null; score?: number | null;
  latency?: number | null; live?: boolean; currency?: string; typical?: number | null;
}): Listing => ({
  service_id: o.id,
  live: o.live ?? true,
  descriptor: {
    mx402: "1", service_id: o.id, name: o.id, type: "rest",
    endpoint: `http://127.0.0.1:4000/${o.id}`,
    capabilities: ["weather_forecast"],
    pricing: { meter: "rows", unit: "rows", rate: o.rate, per: o.per ?? 1, min: "0", free: 0, max_units: o.cap === undefined ? 100 : o.cap, currency: o.currency ?? "HBAR" },
    payment: { protocol: "x402", settlement: [{ network: "hedera:testnet", asset: "0.0.0", currency: o.currency ?? "HBAR", decimals: 8, schemes: ["exact"] }], streaming: false },
    interfaces: ["rest"], auth: { type: "none", held_by: "seller" },
    owner: { account: `0.0.${o.id.length}`, network: "hedera:testnet" },
    links: { descriptor: `http://127.0.0.1:4000/${o.id}/.well-known/mx402` },
    published_at: new Date().toISOString(),
  } as any,
  reputation: {
    mx402: "1", service_id: o.id, score: o.score === undefined ? 80 : o.score,
    confidence: "medium", sample_size: 20,
    components: {} as any, weights: {} as any,
    stats: { calls: 0, paid_calls: 0, revenue: 0, upstream_calls: 0, upstream_errors: 0, settle_attempts: 0, settle_failures: 0, disputes: 0, median_latency_ms: o.latency === undefined ? 500 : o.latency, uptime_ratio: 1, quote_rounds: 0, quotes_offered: 0, quote_rounds_won: 0 } as any,
    anchor: null,
  } as any,
  price: { rate: o.rate, unit: "rows", per: o.per ?? 1, currency: o.currency ?? "HBAR", typical_call: o.typical ?? null, worst_case_call: null },
  rank: 0,
});

const rfq = (over: Partial<Rfq> = {}): Rfq => ({
  rfq_id: "r1", buyer: "0.0.5001", capability: "weather_forecast",
  currency: "HBAR", binding: false, created_at: Date.now(), max_units: 24, ...over,
});

// ── estimating without doing the work ────────────────────────────────────
test("an estimate prices the buyer's stated size, capped by the seller's limit", () => {
  const l = listing({ id: "a", rate: "0.001", cap: 50 });
  assert.deepEqual(estimate(l, 24), { units: 24, amount: "0.024", worst: "0.05" });
  assert.deepEqual(estimate(l, 1000).units, 50, "the seller's cap binds");
});

test("with no stated size, a known typical charge beats guessing the cap", () => {
  const withHistory = listing({ id: "a", rate: "0.001", cap: 50, typical: 0.004 });
  assert.equal(estimate(withHistory, undefined).amount, "0.004");
  const noHistory = listing({ id: "b", rate: "0.001", cap: 50 });
  assert.equal(estimate(noHistory, undefined).amount, "0.05", "falls back to the worst case, not an optimistic one");
});

// ── the round ────────────────────────────────────────────────────────────
test("the cheapest good seller wins, and the reason says why", () => {
  const r = runRound(rfq(), [
    listing({ id: "dear", rate: "0.01" }),
    listing({ id: "cheap", rate: "0.001" }),
    listing({ id: "middling", rate: "0.005" }),
  ]);
  assert.equal(r.winner, "cheap");
  assert.match(r.why, /cheap at 0\.024 HBAR/);
  assert.match(r.why, /beat 2 others/);
  assert.equal(r.offers.filter((o) => o.status === "offered").length, 3);
  assert.ok(r.offers[0].rank >= r.offers[1].rank, "offers come back ranked");
});

test("reputation outweighs a few tinybar, but not everything", () => {
  const r = runRound(rfq(), [
    listing({ id: "cheap-bad", rate: "0.001", score: 20 }),
    listing({ id: "dear-good", rate: "0.0012", score: 98 }),
  ]);
  assert.equal(r.winner, "dear-good", "a 20%% cheaper price does not buy a terrible reputation");

  const r2 = runRound(rfq(), [
    listing({ id: "cheap-ok", rate: "0.001", score: 75 }),
    listing({ id: "extortionate-good", rate: "0.05", score: 99 }),
  ]);
  assert.equal(r2.winner, "cheap-ok", "nor does a perfect reputation justify 50× the price");
});

test("an unrated seller is neither trusted nor written off", () => {
  const r = runRound(rfq(), [listing({ id: "new", rate: "0.001", score: null }), listing({ id: "known", rate: "0.001", score: 90 })]);
  assert.equal(r.winner, "known", "at the same price, proven beats unproven");
  const r2 = runRound(rfq(), [listing({ id: "new", rate: "0.001", score: null }), listing({ id: "known", rate: "0.01", score: 90 })]);
  assert.equal(r2.winner, "new", "but unrated still wins when it is far cheaper");
});

// ── the ceiling, and the losers ──────────────────────────────────────────
test("a seller above the ceiling is declined, with the number in the reason", () => {
  const r = runRound(rfq({ max_price: "0.03" }), [
    listing({ id: "fits", rate: "0.001" }),
    listing({ id: "too-dear", rate: "0.01" }),
  ]);
  assert.equal(r.winner, "fits");
  const declined = r.offers.find((o) => o.service_id === "too-dear")!;
  assert.equal(declined.status, "declined");
  assert.match(declined.reason!, /0\.24 HBAR is above the ceiling of 0\.03/);
});

test("a seller that could blow the ceiling is flagged, not hidden", () => {
  const r = runRound(rfq({ max_price: "0.03", max_units: undefined }), [
    listing({ id: "risky", rate: "0.001", cap: 1000, typical: 0.002 }),
  ]);
  const o = r.offers[0];
  assert.equal(o.status, "offered", "it can still be chosen");
  assert.match(o.reason!, /could reach 1 HBAR at its cap/);
});

test("unreachable and wrong-currency sellers stay in the record", () => {
  const r = runRound(rfq(), [
    listing({ id: "down", rate: "0.001", live: false }),
    listing({ id: "wrong-money", rate: "0.001", currency: "MXC" }),
    listing({ id: "up", rate: "0.002" }),
  ]);
  assert.equal(r.winner, "up");
  assert.equal(r.offers.find((o) => o.service_id === "down")!.status, "no_response");
  assert.match(r.offers.find((o) => o.service_id === "wrong-money")!.reason!, /settles in MXC/);
  assert.equal(r.offers.length, 3, "losers are part of the round, not dropped");
});

test("a round nobody can serve says so plainly", () => {
  assert.match(runRound(rfq(), []).why, /no service offers that capability/);
  assert.equal(runRound(rfq(), []).winner, null);
  const allDown = runRound(rfq(), [listing({ id: "a", rate: "0.001", live: false })]);
  assert.equal(allDown.winner, null);
  assert.match(allDown.why, /every seller declined or was unreachable/);
});

test("the weights are published, so a decision can be recomputed", () => {
  assert.equal(RFQ_WEIGHTS.price + RFQ_WEIGHTS.reputation + RFQ_WEIGHTS.latency, 1);
  assert.match(runRound(rfq(), [listing({ id: "a", rate: "0.001" }), listing({ id: "b", rate: "0.002" })]).why, /price 0.45, reputation 0.4, latency 0.15/);
});

// ── the evidence it leaves behind ────────────────────────────────────────
test("being asked, answering and winning are all recorded", () => {
  const rep = new ReputationEngine();
  rep.ingest("a", { type: "quote_round", data: { status: "offered", won: true } } as any);
  rep.ingest("a", { type: "quote_round", data: { status: "offered", won: false } } as any);
  rep.ingest("b", { type: "quote_round", data: { status: "no_response" } } as any);

  const a = rep.record("a").stats as any;
  assert.equal(a.quote_rounds, 2);
  assert.equal(a.quotes_offered, 2);
  assert.equal(a.quote_rounds_won, 1);

  const b = rep.record("b").stats as any;
  assert.equal(b.quote_rounds, 1);
  assert.equal(b.quotes_offered, 0, "silence is recorded as silence");
  assert.equal(rep.record("b").score, null, "and does not by itself invent a score");
});
