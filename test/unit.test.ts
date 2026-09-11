// Unit tests for everything that decides how much money moves.
//   npm run test:unit

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rational, toAtomic, fromAtomic, billableUnits, priceAtomic, quote, bindingCap, describeRate } from "../src/pricing.ts";
import { makeMeter, tokenUsage, countRows, clampGraphqlFirst, getPath, estimateTokens, type MeterInput } from "../src/meters.ts";
import { HoldStore, RateLimiter, fingerprint } from "../src/holds.ts";
import { interpolate } from "../src/env.ts";
import { issueSessionToken, verifySessionToken } from "../src/world.ts";
import { Analytics } from "../src/analytics.ts";

const input = (resJson: unknown, extra: Partial<MeterInput> = {}): MeterInput => ({
  reqBody: undefined, status: 200, resText: JSON.stringify(resJson ?? ""), resJson, bytes: 0, ms: 0, ...extra,
});

describe("pricing: exact money", () => {
  test("rational parses decimals and exponent form exactly", () => {
    assert.deepEqual(rational("0.01"), { n: 1n, d: 100n });
    assert.deepEqual(rational(1e-7), { n: 1n, d: 10000000n });
    assert.deepEqual(rational("2.5e3"), { n: 25000n, d: 10n });
    assert.throws(() => rational("abc"));
  });

  test("toAtomic / fromAtomic round-trip without float error", () => {
    assert.equal(toAtomic("0.1"), 10_000_000n);
    assert.equal(toAtomic(0.1 + 0.2), 30_000_001n); // float noise rounds UP, never down
    assert.equal(fromAtomic(44_000n), "0.00044");
    assert.equal(fromAtomic(100_000_000n), "1");
    assert.equal(fromAtomic(1n, 6), "0.000001");
  });

  test("price = units × rate / per, in tinybar", () => {
    // 0.01 HBAR per 1000 tokens → 1000 tinybar per token
    assert.equal(priceAtomic(9, { rate: "0.01", per: "1000" }), 9_000n);
    assert.equal(priceAtomic(734, { rate: 0.01, per: 1000 }), 734_000n);
    assert.equal(priceAtomic(1, { rate: "0.002" }), 200_000n);
  });

  test("fractional tinybar always rounds up, never to zero for real work", () => {
    // 0.0000000001 HBAR per byte = 0.01 tinybar/byte → 150 bytes = 1.5 tinybar → 2
    assert.equal(priceAtomic(150, { rate: "0.0000000001" }), 2n);
    assert.equal(priceAtomic(1, { rate: "0.0000000001" }), 1n);
  });

  test("minimum charge applies to paid calls, not to free ones", () => {
    assert.equal(priceAtomic(3, { rate: "0.01", per: "1000", min: "0.0001" }), 10_000n);
    assert.equal(priceAtomic(0, { rate: "0.01", per: "1000", min: "0.0001" }), 0n);
  });

  test("multiplier (World ID bot tier) scales exactly", () => {
    assert.equal(priceAtomic(100, { rate: "0.01", per: "1000" }, 10), 1_000_000n);
    assert.equal(priceAtomic(100, { rate: "0.01", per: "1000" }, 1.5), 150_000n);
  });

  test("billable = min(measured, buyer cap, seller cap) − free", () => {
    assert.deepEqual(billableUnits(900, { maxUnits: 2000 }, 500), { measured: 900, cap: 500, capped: true, billable: 500 });
    assert.deepEqual(billableUnits(300, { maxUnits: 2000 }, 500), { measured: 300, cap: 500, capped: false, billable: 300 });
    assert.deepEqual(billableUnits(300, {}), { measured: 300, cap: null, capped: false, billable: 300 });
    assert.equal(billableUnits(300, { free: 100 }).billable, 200);
    assert.equal(billableUnits(50, { free: 100 }).billable, 0);
    assert.equal(billableUnits(12.2, {}).billable, 13); // a started unit (ms, KB) is a used unit
    assert.equal(billableUnits(NaN, {}).billable, 0);
    assert.equal(bindingCap({ buyerCap: 0, sellerCap: 10 }), 10); // 0/negative caps are ignored
  });

  test("quote carries the flat-at-cap comparison", () => {
    const q = quote(200, { unit: "tokens", rate: "0.01", per: "1000", maxUnits: 2000 });
    assert.equal(q.amount, 200_000n);
    assert.equal(q.ceilingAmount, 2_000_000n); // what flat pricing at the cap would charge
    assert.equal(quote(5, { unit: "rows", rate: 1 }).ceilingAmount, null);
    assert.equal(quote(10, { unit: "t", rate: "0.01", per: 1000 }, { decimals: 6 }).amount, 100n); // USDC atomic
  });

  test("describeRate", () => {
    assert.equal(describeRate({ unit: "tokens", rate: 0.01, per: 1000 }), "0.01 HBAR / 1000 tokens");
    assert.equal(describeRate({ unit: "rows", rate: 0.002 }), "0.002 HBAR / row");
  });
});

describe("meters: read real response shapes", () => {
  test("token usage across providers", () => {
    assert.deepEqual(tokenUsage({ usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 } }), { input: 12, output: 30, source: "openai" });
    assert.deepEqual(tokenUsage({ usage: { input_tokens: 5, output_tokens: 7 } }), { input: 5, output: 7, source: "input/output_tokens" }); // Anthropic / Responses
    assert.deepEqual(tokenUsage({ prompt_eval_count: 26, eval_count: 298 }), { input: 26, output: 298, source: "ollama" });
    assert.deepEqual(tokenUsage({ usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 9, totalTokenCount: 13 } }), { input: 4, output: 9, source: "gemini" });
    assert.equal(tokenUsage({ hello: 1 }), null);
  });

  test("tokens meter: total vs output, and the estimate fallback", () => {
    const res = { usage: { prompt_tokens: 12, completion_tokens: 30 } };
    assert.equal(makeMeter("tokens").measure(input(res)), 42);
    assert.equal(makeMeter("tokens:output").measure(input(res)), 30);
    const noUsage = { choices: [{ message: { content: "x".repeat(40) } }] };
    assert.equal(makeMeter("tokens:output").measure(input(noUsage)), 10);
    assert.equal(estimateTokens("abcde"), 2);
  });

  test("tokens clamp: caps max_tokens, forces non-streaming, leaves non-LLM bodies alone", () => {
    const m = makeMeter("tokens");
    assert.deepEqual(m.clamp!({ messages: [], max_tokens: 900, stream: true }, 500), { messages: [], max_tokens: 500, stream: false });
    assert.deepEqual(m.clamp!({ messages: [], max_tokens: 100 }, 500), { messages: [], max_tokens: 100 });
    assert.deepEqual(m.clamp!({ messages: [] }, 64), { messages: [], max_tokens: 64 });
    assert.deepEqual(m.clamp!({ model: "x", messages: [], options: {} }, 64), { model: "x", messages: [], options: { num_predict: 64 } });
    assert.deepEqual(m.clamp!({ query: "{ a }" }, 64), { query: "{ a }" });
    assert.equal(m.capFromRequest!({ max_tokens: 256 }), 256);
    assert.equal(m.capFromRequest!({ options: { num_predict: 99 } }), 99);
  });

  test("rows: GraphQL, arrays, envelopes, paths", () => {
    assert.equal(countRows({ data: { pools: [1, 2, 3], bundle: { id: 1 } } }), 4);
    assert.equal(countRows({ data: { pools: [] } }), 0);
    assert.equal(countRows([1, 2]), 2);
    assert.equal(countRows({ status: "1", result: [1, 2, 3, 4] }), 4); // Etherscan
    assert.equal(countRows({ "Global Quote": {} }), 1);
    assert.equal(makeMeter("rows:data.pools").measure(input({ data: { pools: [1, 2], x: [1] } })), 2);
  });

  test("rows clamp rewrites GraphQL first: N to the cap", () => {
    assert.equal(clampGraphqlFirst("{ pools(first: 500) { id } tokens(first:3) { id } }", 50), "{ pools(first: 50) { id } tokens(first: 3) { id } }");
    assert.deepEqual(makeMeter("rows").clamp!({ query: "{ p(first: 99) { id } }" }, 10), { query: "{ p(first: 10) { id } }" });
  });

  test("bytes, ms, json, request", () => {
    assert.equal(makeMeter("bytes").measure(input({}, { bytes: 8123 })), 8123);
    assert.equal(makeMeter("ms").measure(input({}, { ms: 41.2 })), 41.2);
    assert.equal(makeMeter("json:usage.credits").measure(input({ usage: { credits: 7 } })), 7);
    assert.equal(makeMeter("json:usage.credits").unit, "credits");
    assert.equal(makeMeter("request").measure(input({})), 1);
    assert.equal(getPath({ a: [{ b: 5 }] }, "a.0.b"), 5);
    assert.throws(() => makeMeter("bogus"));
    assert.throws(() => makeMeter("json"));
  });
});

describe("holds: the meter-then-pay store", () => {
  const mk = (over: Partial<ConstructorParameters<typeof HoldStore>[0]> = {}) => {
    let t = 1_000;
    const store = new HoldStore<string>({ ttlMs: 100, maxPerClient: 2, maxTotal: 3, now: () => t, ...over });
    return { store, tick: (ms: number) => { t += ms; } };
  };

  test("create → lock → remove", () => {
    const { store } = mk();
    const c = store.create("ip1", "fp", "body");
    assert.ok(c.ok);
    const id = c.ok ? c.hold.id : "";
    const l = store.lock(id, "fp");
    assert.ok(l.ok);
    assert.deepEqual(store.lock(id, "fp"), { ok: false, reason: "already_settling" }); // no double settlement
    store.unlock(id);
    assert.ok(store.lock(id, "fp").ok);
    store.remove(id);
    assert.deepEqual(store.lock(id, "fp"), { ok: false, reason: "not_found" });
  });

  test("a payment only releases the response it was quoted for", () => {
    const { store } = mk();
    const c = store.create("ip1", "fp-A", "A");
    assert.deepEqual(store.lock(c.ok ? c.hold.id : "", "fp-B"), { ok: false, reason: "fingerprint_mismatch" });
  });

  test("per-client and global limits bound unpaid work", () => {
    const { store } = mk();
    assert.ok(store.create("ip1", "a", "x").ok);
    assert.ok(store.create("ip1", "b", "x").ok);
    assert.deepEqual(store.create("ip1", "c", "x"), { ok: false, reason: "too_many_unpaid" });
    assert.ok(store.create("ip2", "d", "x").ok);
    assert.deepEqual(store.create("ip3", "e", "x"), { ok: false, reason: "store_full" });
  });

  test("holds expire, but never while settling", () => {
    const { store, tick } = mk();
    const a = store.create("ip1", "a", "x");
    const b = store.create("ip1", "b", "x");
    const bid = b.ok ? b.hold.id : "";
    assert.ok(store.lock(bid, "b").ok);
    tick(150);
    assert.equal(store.get(a.ok ? a.hold.id : ""), undefined);
    assert.ok(store.get(bid)); // mid-settlement: kept
    assert.equal(store.countFor("ip1"), 1);
  });

  test("fingerprint ignores nothing but payment headers", () => {
    assert.equal(fingerprint("post", "/v1?x=1", "{}"), fingerprint("POST", "/v1?x=1", "{}"));
    assert.notEqual(fingerprint("POST", "/v1?x=1", "{}"), fingerprint("POST", "/v1?x=2", "{}"));
    assert.notEqual(fingerprint("POST", "/v1", '{"a":1}'), fingerprint("POST", "/v1", '{"a":2}'));
  });

  test("rate limiter: fixed window per client", () => {
    let t = 0;
    const rl = new RateLimiter(2, () => t);
    assert.ok(rl.hit("a")); assert.ok(rl.hit("a")); assert.ok(!rl.hit("a"));
    assert.ok(rl.hit("b"));
    t = 60_001;
    assert.ok(rl.hit("a"));
    assert.ok(new RateLimiter(0).hit("x"));
  });
});

describe("support", () => {
  test("interpolate: required vars, defaults", () => {
    process.env.MX_T_SET = "v";
    delete process.env.MX_T_UNSET;
    assert.equal(interpolate("a ${MX_T_SET} b"), "a v b");
    assert.equal(interpolate("${MX_T_UNSET}"), null);
    assert.equal(interpolate("${MX_T_UNSET:-dflt}"), "dflt");
    assert.equal(interpolate("${MX_T_SET:-dflt}"), "v");
  });

  test("World session tokens: signed, expiring, unforgeable", () => {
    const tok = issueSessionToken("nullifier123", true);
    const v = verifySessionToken(tok);
    assert.ok(v.ok); assert.equal(v.nullifier, "nullifier123"); assert.equal(v.simulated, true);
    assert.equal(verifySessionToken("lol").ok, false);
    assert.equal(verifySessionToken(tok.slice(0, -2) + "xx").ok, false);
    assert.equal(verifySessionToken(tok.replace("nullifier123", "someoneelse")).ok, false);
  });

  test("analytics: units, spread, and savings vs flat", () => {
    const a = new Analytics();
    const t = Date.UTC(2026, 8, 10, 14);
    a.ingest("llm", { amount: 0.00009, units: 9, unit: "tokens", ceilingAmount: 0.02, path: "/v1/chat", from: "0.0.1" }, t);
    a.ingest("llm", { amount: 0.00044, units: 44, unit: "tokens", ceilingAmount: 0.02, path: "/v1/chat", from: "0.0.1" }, t);
    a.ingest("pools", { amount: 0.01, units: 5, unit: "rows", ceilingAmount: null, path: "/", from: "0.0.2" }, t);
    const s = a.snapshot(["llm"]);
    assert.equal(s.totalRequests, 2);
    assert.equal(s.totalUnits, 53);
    assert.equal(s.totalIncome, 0.00053);
    assert.equal(s.saved, 0.03947);
    assert.equal(s.charges.min, 0.00009);
    assert.equal(s.charges.max, 0.00044);
    assert.equal(s.byHour[14], 2);
    assert.equal(a.snapshot().unit, "mixed");
    assert.equal(a.snapshot([]).totalRequests, 0);
  });
});
