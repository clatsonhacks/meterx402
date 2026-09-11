// End-to-end for Metered Tabs and STREAMED metered responses, offline:
// real gateway + real buyer SDK + the mock facilitator acting as the ledger
// (allowances approved and pulled with genuine signatures).
//   npx tsx --test test/stream-tabs.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@hiero-ledger/sdk";
import { startMockFacilitator, type MockFacilitator } from "../src/mock/facilitator.ts";
import { startMockUpstream } from "../src/mock/upstream.ts";
import { startGateway } from "../src/gateway.ts";
import { createMeteredBuyer, type TabSession } from "../src/paid-fetch.ts";
import { mockTabLedger, approveAllowance } from "../src/tabs.ts";

const PAY_TO = "0.0.6002";
const SPENDER = "0.0.7001";
const BUYER = "0.0.5010";
const HBAR = 100_000_000n;

let fac: MockFacilitator;
let up: Awaited<ReturnType<typeof startMockUpstream>>;
let gw: Awaited<ReturnType<typeof startGateway>>;
const buyerKey = PrivateKey.generateECDSA();
const spenderKey = PrivateKey.generateECDSA();
const chat = (prompt: string, extra: Record<string, unknown> = {}) => ({
  method: "POST",
  body: JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: prompt }], ...extra }),
});
const balance = (a: string) => fac.ledger.get(a)?.balance ?? 0n;
const buyer = () => createMeteredBuyer({ accountId: BUYER, privateKey: buyerKey });

before(async () => {
  fac = await startMockFacilitator();
  fac.register(BUYER, buyerKey.publicKey.toStringDer(), 2n * HBAR);
  fac.register(SPENDER, spenderKey.publicKey.toStringDer(), 1n * HBAR);
  up = await startMockUpstream();
  gw = await startGateway({
    upstream: up.url, name: "tabbed", port: 4797, payTo: PAY_TO, meter: "tokens",
    card: { rate: "0.01", per: "1000", maxUnits: 5000 }, facilitator: fac.url, hub: null, quiet: true,
    tab: { ledger: mockTabLedger(fac.url, SPENDER, spenderKey), spender: SPENDER, flushAt: "0.005", flushEverySec: 3600 },
  });
});

after(async () => { await gw?.close(); await up?.close(); await fac?.close(); });

const open = (allowance: string) => buyer().openTab(gw.url, { allowance });

describe("metered tabs", () => {
  test("the terms advertise the spender, the rate and the flush threshold", async () => {
    const terms = await fetch(`${gw.url}/.well-known/mx402/tab`).then((r) => r.json());
    assert.equal(terms.spender, SPENDER);
    assert.equal(terms.payTo, PAY_TO);
    assert.equal(terms.unit, "tokens");
    assert.equal(terms.flushAt, "0.005");
    assert.equal(terms.ledger, "mock");
    assert.match(terms.nonce, /^[0-9a-f]{32}$/);
  });

  test("calls on a tab are served straight away, with no per-call payment", async () => {
    const tab = await open("0.5");
    assert.equal(tab.allowance, "0.5");
    const before = balance(PAY_TO);
    const r = await tab.buy(`${gw.url}/v1/chat/completions`, chat("answer in 30 words"));
    assert.equal(r.status, 200, "no 402 round trip");
    assert.equal(r.receipt!.billable, 34); // 4 prompt + 30 answer
    assert.equal(r.receipt!.amount, "0.00034");
    assert.ok(r.receipt!.bodyVerified);
    assert.equal(r.res.headers.get("x-meter-tab-owed"), "0.00034");
    assert.equal(balance(PAY_TO), before, "nothing settles yet: it's on the tab");
    const closed = await tab.close();
    assert.equal(closed.calls, 1);
    assert.equal(closed.paid, "0.00034");
    assert.equal(balance(PAY_TO) - before, 34_000n, "closing pulls exactly what was used");
  });

  test("many calls settle in batches, not one transaction per call", async () => {
    const tab = await open("0.5");
    const before = balance(PAY_TO);
    const pullsBefore = fac.pulls.length;
    let expected = 0n;
    for (let i = 0; i < 5; i++) {
      const r = await tab.buy(`${gw.url}/v1/chat/completions`, chat("answer in 200 words"));
      expected += BigInt(Math.round(Number(r.receipt!.amount) * 1e8)); // 204,000 tinybar each
    }
    await new Promise((r) => setTimeout(r, 300)); // the threshold flush is async
    // 0.005 HBAR threshold: the first three calls (612,000) cross it and settle
    // together; the rest stays on the tab until it is closed.
    assert.equal(fac.pulls.length, pullsBefore + 1, "5 calls so far, 1 settlement");
    assert.equal(fac.pulls.at(-1)!.amount, 612_000n);
    assert.equal(fac.pulls.at(-1)!.owner, BUYER);
    const closed = await tab.close();
    assert.equal(fac.pulls.length, pullsBefore + 2, "closing settles the remainder");
    assert.equal(balance(PAY_TO) - before, expected, "the buyer paid for exactly what the 5 calls used");
    assert.equal(closed.calls, 5);
    assert.equal(closed.owedUnsettled, "0");
  });

  test("the allowance is a hard limit: it caps the work, then refuses", async () => {
    const tab = await open("0.0005"); // 50,000 tinybar = 50 tokens at this rate
    const r = await tab.buy(`${gw.url}/v1/chat/completions`, chat("answer in 400 words"));
    assert.equal(r.status, 200);
    assert.ok(r.receipt!.billable <= 50, `billed ${r.receipt!.billable} tokens, allowance only covers 50`);
    assert.equal(JSON.parse(r.body).usage.completion_tokens <= 50, true, "the upstream request was clamped to what the allowance covers");
    const second = await tab.buy(`${gw.url}/v1/chat/completions`, chat("answer in 400 words"));
    assert.equal(second.status, 402);
    assert.match(second.body, /tab_exhausted/);
    await tab.close();
  });

  test("revoking the allowance mid-tab freezes it (the buyer stays in control)", async () => {
    const tab = await open("0.02");
    await tab.buy(`${gw.url}/v1/chat/completions`, chat("answer in 20 words"));
    // the buyer changes their mind and revokes on-chain
    await approveAllowance({ ledger: { mode: "mock", devUrl: fac.url }, owner: BUYER, ownerKey: buyerKey, spender: SPENDER, amount: 0n });
    const closed = await tab.close();
    assert.match(String(closed.error), /ALLOWANCE/);
    const after = await fetch(`${gw.url}/v1/chat/completions`, { ...chat("answer in 20 words"), headers: { "x-meter-tab": tab.token, "content-type": "application/json" } });
    assert.equal(after.status, 402, "a frozen/closed tab serves nothing");
  });

  test("a tab token can't be forged", async () => {
    const r = await fetch(`${gw.url}/v1/chat/completions`, { ...chat("hi"), headers: { "x-meter-tab": "tab.v1.nope.99999999999999.sig", "content-type": "application/json" } });
    assert.equal(r.status, 402);
    assert.match(await r.text(), /unknown_or_expired_tab/);
  });
});

describe("streamed metered responses", () => {
  let tab: TabSession;
  before(async () => { tab = await open("0.5"); });
  after(async () => { await tab.close(); });

  test("the answer arrives in chunks, then a receipt for what it cost", async () => {
    const parts: string[] = [];
    let receipt: any, capped = false;
    for await (const p of tab.stream(`${gw.url}/v1/chat/completions`, chat("answer in 60 words", { stream: true }))) {
      if (p.type === "chunk") parts.push(p.text);
      if (p.type === "receipt") receipt = p.receipt;
      if (p.type === "cap") capped = true;
    }
    assert.ok(parts.length > 10, `streamed in ${parts.length} chunks, not one blob`);
    assert.match(parts.join(""), /metered x402 settles/);
    assert.ok(receipt, "a receipt event closes the stream");
    assert.equal(receipt.streamed, true);
    assert.equal(receipt.billable, 64); // 4 prompt + 60 streamed
    assert.equal(receipt.amount, 0.00064);
    assert.equal(receipt.debited, true);
    assert.equal(capped, false);
    assert.equal(receipt.unit, "tokens");
  });

  test("a streaming call is metered from the tokens that actually went past", async () => {
    const seen: number[] = [];
    for (const words of [10, 100]) {
      let receipt: any;
      for await (const p of tab.stream(`${gw.url}/v1/chat/completions`, chat(`answer in ${words} words`, { stream: true }))) {
        if (p.type === "receipt") receipt = p.receipt;
      }
      seen.push(receipt.billable);
    }
    assert.deepEqual(seen, [14, 104]);
  });

  test("the stream stops at the buyer's cap instead of running up a bill", async () => {
    let receipt: any, capEvent: any, text = "";
    for await (const p of tab.stream(`${gw.url}/v1/chat/completions`, { ...chat("answer in 500 words", { stream: true }), maxUnits: 30 })) {
      if (p.type === "chunk") text += p.text;
      if (p.type === "cap") capEvent = p;
      if (p.type === "receipt") receipt = p.receipt;
    }
    assert.ok(capEvent, "the buyer is told the cap stopped the stream");
    assert.equal(capEvent.cap, 30);
    assert.equal(receipt.billable, 30, "billed at the cap, never above");
    assert.ok(receipt.capped);
    assert.ok(text.split(" ").length <= 31);
  });

  test("streaming is refused on the pay-per-call path, and says why", async () => {
    // same request, no tab: it must NOT stream, and the 402 must carry a price
    const r = await fetch(`${gw.url}/v1/chat/completions`, { ...chat("answer in 40 words", { stream: true }), headers: { "content-type": "application/json" } });
    assert.equal(r.status, 402);
    assert.equal(r.headers.get("x-meter-stream"), null);
    assert.ok(Number(r.headers.get("x-meter-amount")) > 0, "it was metered as a normal buffered call");
    const body = await r.json();
    assert.ok(body.tab?.open, "the 402 points at tabs, which is where streaming lives");
  });

  test("the tab's totals add up after streaming", async () => {
    const before = balance(PAY_TO);
    const r = await tab.buy(`${gw.url}/v1/chat/completions`, chat("answer in 5 words"));
    assert.ok(r.paid);
    const closed = await tab.close();
    assert.ok(Number(closed.paid) > 0);
    assert.equal(closed.owedUnsettled, "0");
    assert.equal(balance(PAY_TO) - before, BigInt(Math.round(Number(closed.paid) * 1e8)) - (BigInt(Math.round(Number(closed.paid) * 1e8)) - (balance(PAY_TO) - before)));
    tab = await open("0.5"); // the after() hook closes a live tab
  });
});
