// Unit tests for auto-detection: a seller shouldn't need to know our meter
// vocabulary, so this has to read real response shapes correctly.
//   npx tsx --test test/detect.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectFrom, largestArray, probeUrl, variants, priceOf, type Probe } from "../src/detect.ts";

const probeOf = (json: unknown, over: Partial<Probe> = {}): Probe => {
  const text = JSON.stringify(json);
  return { ok: true, status: 200, ms: 120, bytes: Buffer.byteLength(text), json, text, url: "http://x", ...over };
};

describe("detect: what should this API be metered on", () => {
  test("an LLM that reports usage is metered per token", () => {
    const d = detectFrom(probeOf({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 79, completion_tokens: 213, total_tokens: 292 } }));
    assert.ok(!("error" in d));
    if ("error" in d) return;
    assert.equal(d.meter, "tokens");
    assert.equal(d.measured, 292);
    assert.equal(d.unit, "tokens");
    assert.match(d.why, /token usage \(79 in \+ 213 out\)/);
  });

  test("a nested list is found and named, not missed", () => {
    // Open-Meteo: the list lives at hourly.time, not at the top level
    const d = detectFrom(probeOf({ latitude: 13, longitude: 80, hourly: { time: Array(48).fill("2026-01-01T00:00"), temperature_2m: Array(48).fill(24.9) } }));
    assert.ok(!("error" in d));
    if ("error" in d) return;
    assert.equal(d.meter, "rows:hourly.time");
    assert.equal(d.measured, 48);
  });

  test("common envelopes: Etherscan, GraphQL, a bare array", () => {
    const es = detectFrom(probeOf({ status: "1", message: "OK", result: Array(10).fill({ hash: "0x" }) }));
    assert.equal((es as any).meter, "rows:result");
    assert.equal((es as any).measured, 10);
    const gql = detectFrom(probeOf({ data: { pools: Array(5).fill({ id: "0x" }) } }));
    assert.equal((gql as any).meter, "rows:data.pools");
    assert.equal((gql as any).measured, 5);
    const bare = detectFrom(probeOf([1, 2, 3]));
    assert.equal((bare as any).meter, "rows");
    assert.equal((bare as any).measured, 3);
  });

  test("a big body with no list or usage is metered per byte", () => {
    const d = detectFrom(probeOf({ blob: "x".repeat(40_000) }));
    assert.equal((d as any).meter, "bytes");
    assert.equal((d as any).unit, "bytes");
  });

  test("a small fixed object falls back to a flat price per request", () => {
    const d = detectFrom(probeOf({ ethereum: { usd: 4242.42 } }));
    assert.equal((d as any).meter, "request");
    assert.equal((d as any).rate, "0.01");
    assert.equal((d as any).maxUnits, 1);
  });

  test("a failing API is reported, not priced", () => {
    const d = detectFrom(probeOf({ error: "bad key" }, { ok: false, status: 401, text: '{"error":"bad key"}' }));
    assert.ok("error" in d);
    assert.match((d as any).error, /401/);
  });

  test("the suggested rate lands a typical call near a sensible price", () => {
    for (const json of [
      { hourly: { time: Array(48).fill("t") } },
      { result: Array(10_000).fill(1) },
      { data: { pools: Array(3).fill(1) } },
    ]) {
      const d = detectFrom(probeOf(json)) as any;
      const cost = Number(priceOf(d.measured, { rate: d.rate, per: d.per, min: d.min }));
      assert.ok(cost >= 0.0005 && cost <= 0.08, `${d.measured} ${d.unit} priced at ${cost} HBAR`);
    }
  });

  test("the cap is tethered to what the API actually returned", () => {
    const d = detectFrom(probeOf({ result: Array(10).fill(1) })) as any;
    assert.equal(d.maxUnits, 40); // 4× the sample, with a floor of 20
    const big = detectFrom(probeOf({ usage: { total_tokens: 4000 } })) as any;
    assert.equal(big.maxUnits, 16_000);
  });
});

describe("detect: probing", () => {
  test("largestArray walks nested objects and reports the path", () => {
    assert.deepEqual(largestArray({ a: { b: [1, 2] }, c: [1, 2, 3] }), { path: "c", length: 3 });
    assert.deepEqual(largestArray({ a: { b: { c: { d: [1] } } } }), { path: "a.b.c.d", length: 1 });
    assert.equal(largestArray({ a: 1 }), null);
    assert.equal(largestArray(null), null);
  });

  test("the probe URL is built exactly like the gateway builds it", () => {
    assert.equal(probeUrl({ upstream: "https://api.x.com/v2/api", sample: "/?a=1" }).toString(), "https://api.x.com/v2/api?a=1");
    assert.equal(probeUrl({ upstream: "https://api.groq.com/openai/v1", sample: "/chat/completions" }).toString(), "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(probeUrl({ upstream: "https://api.x.com/q", sample: "/", query: { apikey: "k" } }).toString(), "https://api.x.com/q?apikey=k");
  });

  test("variants vary the thing that changes the price", () => {
    const llm = variants({ upstream: "u", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    assert.deepEqual(llm.map((v) => v.label), ["max_tokens 64", "max_tokens 256"]);
    assert.equal(JSON.parse(llm[0].req.body!).max_tokens, 64);

    const gql = variants({ upstream: "u", body: JSON.stringify({ query: "{ pools(first: 5) { id } }" }) });
    assert.deepEqual(gql.map((v) => v.label), ["first: 3", "first: 15"]);
    assert.match(JSON.parse(gql[1].req.body!).query, /first: 15/);

    const rest = variants({ upstream: "u", sample: "/?offset=10&page=1" });
    assert.deepEqual(rest.map((v) => v.label), ["offset=5", "offset=20"]);
    assert.equal(rest[1].req.sample, "/?offset=20&page=1");

    assert.deepEqual(variants({ upstream: "u", sample: "/fixed" }), []);
  });
});
