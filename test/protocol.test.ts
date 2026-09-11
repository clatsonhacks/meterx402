// Unit tests for the payment-layer abstractions: protocol objects, descriptors,
// settlement route selection, the registry, and the reputation model.
//   npx tsx --test test/protocol.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ServiceDescriptor, PaymentQuote, SettlementReceipt, Dispute, encodeHeader, decodeHeader, PROTOCOL_VERSION } from "../src/protocol/schemas.ts";
import { plainDecimal, slug, inferType, inferAuth, inferCapabilities } from "../src/protocol/describe.ts";
import { selectRoute, type Capability } from "../src/settlement/adapter.ts";
import { ReputationEngine, WEIGHTS } from "../src/registry/reputation.ts";
import { Registry, rank } from "../src/registry/registry.ts";

const descriptor = (over: Partial<ServiceDescriptor> = {}): ServiceDescriptor => ServiceDescriptor.parse({
  mx402: PROTOCOL_VERSION,
  service_id: "weather-api",
  name: "Weather",
  type: "rest",
  endpoint: "http://localhost:4111",
  capabilities: ["weather_forecast"],
  pricing: { meter: "rows:hourly.time", unit: "rows", rate: "0.0002", per: 1, min: "0.0005", free: 0, max_units: 192, currency: "HBAR" },
  payment: { protocol: "x402", streaming: false, settlement: [{ network: "hedera:testnet", asset: "0.0.0", currency: "HBAR", decimals: 8, schemes: ["exact"] }] },
  interfaces: ["rest", "a2a", "mcp", "sdk"],
  auth: { type: "none", held_by: "seller" },
  owner: { account: "0.0.6001", network: "hedera:testnet" },
  links: { descriptor: "http://localhost:4111/.well-known/mx402" },
  published_at: new Date(0).toISOString(),
  ...over,
});

describe("protocol objects", () => {
  test("a valid ServiceDescriptor parses; a broken one is rejected with a reason", () => {
    assert.equal(descriptor().service_id, "weather-api");
    assert.throws(() => descriptor({ service_id: "Not A Slug!" } as any));
    assert.throws(() => descriptor({ capabilities: [] } as any));
    assert.throws(() => descriptor({ pricing: { ...descriptor().pricing, rate: "1e-7" } } as any), /decimal/);
    assert.throws(() => descriptor({ payment: { protocol: "x402", streaming: false, settlement: [] } } as any));
  });

  test("quotes, receipts and disputes validate their money and hashes", () => {
    const q = {
      mx402: "1", quote_id: "q1", service_id: "s", scheme: "exact", meter: "tokens", unit: "tokens", units: 24, measured: 24, cap: null,
      rate: "0.01", per: 1000, amount: "0.00024", amount_atomic: "24000", currency: "HBAR", network: "hedera:testnet", asset: "0.0.0",
      pay_to: "0.0.6001", body_sha256: "a".repeat(64), expires_at: 1,
    };
    assert.ok(PaymentQuote.safeParse(q).success);
    assert.equal(PaymentQuote.safeParse({ ...q, amount_atomic: "2.4" }).success, false);
    assert.equal(PaymentQuote.safeParse({ ...q, body_sha256: "nope" }).success, false);
    assert.equal(PaymentQuote.safeParse({ ...q, network: "hedera" }).success, false);
    const r = {
      mx402: "1", receipt_id: "r1", scheme: "tab", quote_id: null, tab_id: "t1", service_id: "s", buyer: "0.0.1", seller: "0.0.2",
      metered_units: 3, unit: "rows", rate: "0.002", per: 1, amount: "0.006", amount_atomic: "600000", currency: "HBAR",
      network: "hedera:testnet", transaction_id: null, body_sha256: null, settled_at: 1,
    };
    assert.ok(SettlementReceipt.safeParse(r).success, "a tab call's receipt has no transaction until its batch settles");
    assert.equal(Dispute.safeParse({ mx402: "1", service_id: "s", quote_id: "q", receipt_id: null, buyer: "0.0.1", reason: "lies", claimed_units: 1, observed_units: 1, body_sha256_claimed: null, body_sha256_observed: null, filed_at: 1 }).success, false);
  });

  test("protocol objects travel in one header and come back intact", () => {
    const d = descriptor();
    assert.deepEqual(decodeHeader(encodeHeader(d), ServiceDescriptor), d);
    assert.equal(decodeHeader("garbage", ServiceDescriptor), null);
    assert.equal(decodeHeader(encodeHeader({ hello: 1 }), ServiceDescriptor), null);
  });
});

describe("describing a service", () => {
  test("plain decimals and slugs", () => {
    assert.equal(plainDecimal(1e-7), "0.0000001");
    assert.equal(plainDecimal("0.010"), "0.01");
    assert.equal(plainDecimal(undefined), "0");
    assert.equal(slug("Open Meteo!"), "open-meteo");
    assert.equal(slug("__x"), "x");
  });

  test("type, auth and capabilities are inferred from what the seller gave us", () => {
    assert.equal(inferType("tokens"), "llm");
    assert.equal(inferType("rows", '{"query":"{ pools { id } }"}'), "graphql");
    assert.equal(inferType("rows"), "rest");
    assert.equal(inferAuth({ Authorization: "Bearer gsk_123" }), "bearer");
    assert.equal(inferAuth({ Authorization: "Bearer none" }), "none");
    assert.equal(inferAuth({}, { apikey: "k" }), "api-key");
    assert.equal(inferAuth({ "Api-Key": "k" }), "api-key");
    assert.equal(inferAuth(), "none");
    assert.deepEqual(inferCapabilities("https://api.open-meteo.com/v1/forecast", "rest"), ["weather_forecast"]);
    assert.deepEqual(inferCapabilities("https://api.groq.com/openai/v1", "llm"), ["text_generation"]);
    assert.deepEqual(inferCapabilities("https://api.etherscan.io/v2/api", "rest"), ["blockchain_data"]);
    assert.deepEqual(inferCapabilities("https://api.example.com/x", "rest"), ["example_api"]);
  });
});

describe("settlement routing", () => {
  const hedera: Capability = { network: "hedera:testnet", asset: "0.0.0", currency: "HBAR", decimals: 8, schemes: ["exact", "tab"] };
  const base: Capability = { network: "eip155:84532", asset: "USDC", currency: "USDC", decimals: 6, schemes: ["exact"] };

  test("the first option both sides support wins", () => {
    assert.deepEqual(selectRoute([base, hedera], [{ network: "hedera:testnet" }]), { option: hedera, scheme: "exact" });
    assert.deepEqual(selectRoute([base, hedera], [{ network: "eip155:84532", currencies: ["USDC"] }]), { option: base, scheme: "exact" });
  });
  test("a tab is used when the buyer prefers one and it's offered", () => {
    assert.equal(selectRoute([hedera], [{ network: "hedera:testnet" }], "tab")?.scheme, "tab");
    assert.equal(selectRoute([base], [{ network: "eip155:84532" }], "tab")?.scheme, "exact");
  });
  test("no shared network or currency means no route, not a guess", () => {
    assert.equal(selectRoute([hedera], [{ network: "solana:mainnet" }]), null);
    assert.equal(selectRoute([hedera], [{ network: "hedera:testnet", currencies: ["USDC"] }]), null);
  });
});

describe("reputation", () => {
  const ev = (type: string, data: Record<string, unknown> = {}) => ({ type: type as any, data });

  test("no evidence, no score: unrated rather than ranked on noise", () => {
    const r = new ReputationEngine().record("s");
    assert.equal(r.score, null);
    assert.equal(r.confidence, "none");
  });

  test("a clean service scores 100, deterministically, with published weights", () => {
    const e = new ReputationEngine();
    for (let i = 0; i < 25; i++) {
      e.ingest("s", ev("request_in"));
      e.ingest("s", ev("metered", { ms: 120 }));
      e.ingest("s", ev("settled", { amount: 0.001 }));
      e.probe("s", true);
    }
    const r = e.record("s", 1);
    assert.equal(r.score, 100);
    assert.equal(r.confidence, "medium");
    assert.deepEqual(r.weights, WEIGHTS);
    assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0).toFixed(6), "1.000000");
    assert.deepEqual(new ReputationEngine().record("s", 1).weights, r.weights);
  });

  test("seller-caused failures cost reputation; buyer mistakes don't", () => {
    const clean = new ReputationEngine(), buyerErrs = new ReputationEngine(), sellerErrs = new ReputationEngine();
    for (const e of [clean, buyerErrs, sellerErrs]) for (let i = 0; i < 20; i++) { e.ingest("s", ev("metered", { ms: 100 })); e.ingest("s", ev("settled", { amount: 0.001 })); }
    for (let i = 0; i < 10; i++) buyerErrs.ingest("s", ev("payment_failed", { stage: "verify", reason: "insufficient_funds" }));
    for (let i = 0; i < 10; i++) buyerErrs.ingest("s", ev("upstream_error", { status: 404 }));
    for (let i = 0; i < 5; i++) sellerErrs.ingest("s", ev("upstream_error", { status: 500 }));
    for (let i = 0; i < 5; i++) sellerErrs.ingest("s", ev("payment_failed", { stage: "settle", reason: "settle_failed" }));
    assert.equal(buyerErrs.record("s").score, clean.record("s").score);
    const s = sellerErrs.record("s");
    assert.ok(s.score! < clean.record("s").score!);
    assert.ok(s.components.response_success < 1 && s.components.payment_reliability < 1 && s.components.execution < 1);
  });

  test("disputes and slow responses are priced in", () => {
    const e = new ReputationEngine();
    for (let i = 0; i < 20; i++) { e.ingest("s", ev("metered", { ms: 1650 })); e.ingest("s", ev("settled", { amount: 0.001 })); }
    e.ingest("s", ev("dispute"));
    const r = e.record("s");
    assert.equal(r.components.latency, 0.5);      // 1650 ms is halfway between 300 and 3000
    assert.equal(r.components.disputes, 0.5);     // 1 dispute in 20 paid calls = 5% → ×10 = 0.5
    assert.equal(r.stats.disputes, 1);
  });

  test("uptime comes from liveness probes", () => {
    const e = new ReputationEngine();
    for (let i = 0; i < 8; i++) e.probe("s", i % 4 !== 0);
    assert.equal(e.record("s").components.uptime, 0.75);
  });
});

describe("registry", () => {
  const rep = (score: number | null, latency = 1) => (id: string) => ({ ...new ReputationEngine().record(id), score, components: { execution: 1, response_success: 1, latency, disputes: 1, uptime: 1, payment_reliability: 1 } });

  test("publish, look up, and filter by capability, reputation and interface", () => {
    const r = new Registry();
    r.upsert(descriptor(), { lane: "weather", source: "gateway" });
    r.upsert(descriptor({ service_id: "llm", capabilities: ["text_generation"], pricing: { ...descriptor().pricing, meter: "tokens", unit: "tokens", rate: "0.01", per: 1000, max_units: 4000 } }), { lane: "llm", source: "gateway" });
    assert.equal(r.get("weather-api")?.lane, "weather");
    assert.deepEqual(r.search({ capability: "weather_forecast" }, rep(90)).map((l) => l.service_id), ["weather-api"]);
    assert.deepEqual(r.search({ unit: "tokens" }, rep(90)).map((l) => l.service_id), ["llm"]);
    assert.equal(r.search({ minReputation: 95 }, rep(90)).length, 0);
    assert.equal(r.search({ minReputation: 50 }, rep(null)).length, 0, "unrated services don't pass a reputation filter");
    assert.equal(r.search({ iface: "a2a" }, rep(90)).length, 2);
    assert.equal(r.search({ network: "eip155:8453" }, rep(90)).length, 0);
  });

  test("maxPrice uses the typical paid charge when known, else the worst case", () => {
    const r = new Registry();
    r.upsert(descriptor(), { lane: "weather", source: "gateway" });  // worst case: 192 rows × 0.0002 = 0.0384
    assert.equal(r.search({ maxPrice: 0.01 }, rep(90)).length, 0);
    assert.equal(r.search({ maxPrice: 0.01 }, rep(90), () => 0.0048).length, 1);
    const [l] = r.search({}, rep(90), () => 0.0048);
    assert.equal(l.price.worst_case_call, 0.0384);
    assert.equal(l.price.typical_call, 0.0048);
  });

  test("dead services drop out of discovery", () => {
    const r = new Registry();
    r.upsert(descriptor(), { lane: "weather", source: "gateway" });
    r.setLive("weather-api", false);
    assert.equal(r.search({}, rep(90)).length, 0);
    assert.equal(r.search({ live: false }, rep(90)).length, 1);
  });

  test("ranking: reputation dominates, then price, then latency", () => {
    const mk = (id: string, score: number | null, price: number, latency: number) => ({
      service_id: id, descriptor: descriptor({ service_id: id }), live: true,
      reputation: rep(score, latency)(id),
      price: { rate: "1", unit: "rows", per: 1, currency: "HBAR", typical_call: price, worst_case_call: price }, rank: 0,
    });
    const order = (...ls: ReturnType<typeof mk>[]) => rank(ls).map((l) => l.service_id);
    // a 10x cheaper but badly rated service does not beat a well rated one
    assert.deepEqual(order(mk("cheap-bad", 40, 0.001, 1), mk("good", 95, 0.01, 1)), ["good", "cheap-bad"]);
    // with equal reputation, the cheaper one wins
    assert.deepEqual(order(mk("dear", 90, 0.01, 1), mk("cheap", 90, 0.002, 1)), ["cheap", "dear"]);
    // with equal reputation and price, the faster one wins
    assert.deepEqual(order(mk("slow", 90, 0.01, 0.2), mk("fast", 90, 0.01, 1)), ["fast", "slow"]);
    // no evidence ranks between good and bad evidence at the same price
    assert.deepEqual(order(mk("bad", 30, 0.01, 1), mk("unrated", null, 0.01, 1), mk("good", 95, 0.01, 1)), ["good", "unrated", "bad"]);
  });
});
