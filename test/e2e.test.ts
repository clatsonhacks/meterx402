// Offline end-to-end: the real x402 client, real ECDSA-signed Hedera transfer
// transactions, the real gateway and hub, against a mock upstream and a mock
// facilitator that decodes and checks every transaction against a ledger.
//   npm run test:e2e

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { createClientHederaSigner, ExactHederaScheme } from "@x402/hedera";
import { startMockFacilitator, type MockFacilitator } from "../src/mock/facilitator.ts";
import { startMockUpstream } from "../src/mock/upstream.ts";
import { startGateway } from "../src/gateway.ts";
import { createMeteredBuyer, BuyerLimitError } from "../src/paid-fetch.ts";
import { issueSessionToken } from "../src/world.ts";
import { ROOT } from "../src/env.ts";

const HUB_PORT = 4721;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const PAY_TO = "0.0.6001";
const HBAR = 100_000_000n;
const chat = (prompt: string, extra: Record<string, unknown> = {}) => ({
  method: "POST",
  body: JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: prompt }], ...extra }),
});

let fac: MockFacilitator;
let up: Awaited<ReturnType<typeof startMockUpstream>>;
let hub: ChildProcess;
const gateways: { close(): Promise<void> }[] = [];
const tmp = mkdtempSync(join(tmpdir(), "mx402-e2e-"));
const TAPE = join(tmp, "tape.jsonl");
const buyerKey = PrivateKey.generateECDSA();
const poorKey = PrivateKey.generateECDSA();
const hubBuyerKey = PrivateKey.generateECDSA();
const lane = (port: number) => `http://127.0.0.1:${port}`;
const balance = (acct: string) => fac.ledger.get(acct)?.balance ?? 0n;

async function waitFor(url: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 150)); } }
  throw new Error(`timeout waiting for ${url}`);
}

/** Pay a 402 by hand, optionally tampering with what gets signed. */
async function manualPay(url: string, init: RequestInit, key: PrivateKey, acct: string, tamper?: (req: any) => void, keepAccepted = false) {
  const first = await fetch(url, init);
  assert.equal(first.status, 402);
  const pr = decodePaymentRequiredHeader(first.headers.get("payment-required")!);
  const original = structuredClone(pr.accepts[0]);
  if (tamper) tamper(pr.accepts[0]);
  const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(createClientHederaSigner(acct, key)) as any).setSpendControls(false);
  const payload = await client.createPaymentPayload(pr);
  if (keepAccepted) payload.accepted = original; // claim the real quote, sign something else
  const header = encodePaymentSignatureHeader(payload);
  const second = await fetch(url, { ...init, headers: { ...(init.headers as any), "PAYMENT-SIGNATURE": header } });
  return { first, second, header, quote: original };
}

before(async () => {
  fac = await startMockFacilitator();
  fac.register("0.0.5001", buyerKey.publicKey.toStringDer(), 1n * HBAR);
  fac.register("0.0.5003", poorKey.publicKey.toStringDer(), 1000n); // 0.00001 HBAR
  fac.register("0.0.5004", hubBuyerKey.publicKey.toStringDer(), 1n * HBAR);
  up = await startMockUpstream();

  hub = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "src/hub.ts"), "--tape", TAPE], {
    cwd: ROOT, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: String(HUB_PORT), MX_HUB_PORT: String(HUB_PORT), MX_OFFLINE: "1", FACILITATOR_URL: fac.url,
      BUYER_ACCOUNT_ID: "0.0.5004", BUYER_PRIVATE_KEY: hubBuyerKey.toStringDer(), HEDERA_ACCOUNT_ID: "", HEDERA_PRIVATE_KEY: "" },
  });
  await waitFor(`${HUB}/status`);

  const common = { payTo: PAY_TO, facilitator: fac.url, hub: HUB, quiet: true, maxHolds: 50 };
  gateways.push(
    await startGateway({ ...common, name: "llm", port: 4791, upstream: up.url, meter: "tokens", card: { rate: "0.01", per: "1000", min: "0.0001", maxUnits: 2000 } }),
    await startGateway({ ...common, name: "pools", port: 4792, upstream: `${up.url}/graphql`, meter: "rows", card: { rate: "0.002", maxUnits: 100 } }),
    await startGateway({ ...common, name: "flat", port: 4793, upstream: up.url, meter: "request", card: { rate: "0.01" } }),
    await startGateway({ ...common, name: "private", port: 4794, upstream: `${up.url}/private`, meter: "tokens", card: { rate: "0.01", per: "1000" }, headers: { "x-api-key": "sekret" } }),
    await startGateway({ ...common, name: "tight", port: 4795, upstream: up.url, meter: "request", card: { rate: "0.01" }, maxHolds: 1 }),
    await startGateway({ ...common, name: "expiry", port: 4796, upstream: up.url, meter: "request", card: { rate: "0.01" }, holdTtlSec: 1 }),
  );
});

after(async () => {
  for (const g of gateways) await g.close().catch(() => {});
  hub?.kill();
  await up?.close(); await fac?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("meter, then pay", () => {
  test("an unpaid call gets a 402 with the EXACT metered price, and no data", async () => {
    const r = await fetch(`${lane(4791)}/v1/chat/completions`, chat("answer in 20 words"));
    assert.equal(r.status, 402);
    const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!);
    const req = pr.accepts[0];
    const m = (req.extra as any).meter;
    // prompt "answer in 20 words" = 4 tokens + 20 answer tokens = 24 → 24 × 1000 tinybar
    assert.equal(m.measured, 24);
    assert.equal(req.amount, "24000");
    assert.equal(req.asset, "0.0.0");
    assert.equal(req.payTo, PAY_TO);
    assert.equal((req.extra as any).feePayer, fac.feePayer);
    assert.equal(r.headers.get("x-meter-amount"), "0.00024");
    const body = await r.text();
    assert.ok(!body.includes("metered x402 settles"), "402 must not leak the held response");
  });

  test("different usage → different price, settled to the tinybar", async () => {
    const buyer = createMeteredBuyer({ accountId: "0.0.5001", privateKey: buyerKey });
    const before = balance(PAY_TO);
    const small = await buyer.buy(`${lane(4791)}/v1/chat/completions`, chat("answer in 5 words"));
    const big = await buyer.buy(`${lane(4791)}/v1/chat/completions`, chat("answer in 300 words"));
    assert.equal(small.status, 200); assert.ok(small.paid);
    assert.equal(big.status, 200); assert.ok(big.paid);
    assert.equal(small.receipt!.billable, 9);     // 4 + 5  → below the 0.0001 min
    assert.equal(small.receipt!.amount, "0.0001"); // min charge
    assert.equal(big.receipt!.billable, 304);     // 4 + 300
    assert.equal(big.receipt!.amount, "0.00304");
    assert.equal(balance(PAY_TO) - before, 10_000n + 304_000n);
    assert.ok(small.receipt!.bodyVerified && big.receipt!.bodyVerified);
    assert.match(big.body, /metered x402 settles/);
    assert.equal(buyer.spent(), "0.00314");
  });

  test("buyer cap: upstream is clamped and the bill stops at the cap", async () => {
    const buyer = createMeteredBuyer({ accountId: "0.0.5001", privateKey: buyerKey });
    const r = await buyer.buy(`${lane(4791)}/v1/chat/completions`, { ...chat("answer in 400 words"), maxUnits: 50 });
    assert.equal(r.status, 200);
    const out = JSON.parse(r.body);
    assert.equal(out.usage.completion_tokens, 50, "max_tokens was clamped to the cap upstream");
    assert.equal(r.receipt!.measured, 54);
    assert.equal(r.receipt!.billable, 50);
    assert.equal(r.receipt!.amount, "0.0005");
    assert.equal(r.receipt!.ceiling, "0.0005");
  });

  test("seller cap applies when the buyer sets none", async () => {
    const buyer = createMeteredBuyer({ accountId: "0.0.5001", privateKey: buyerKey });
    const r = await buyer.buy(`${lane(4791)}/v1/chat/completions`, chat("answer in 5000 words"));
    assert.equal(r.receipt!.billable, 2000);
    assert.equal(r.receipt!.amount, "0.02");
  });

  test("max_tokens in the body counts as the buyer's cap", async () => {
    const buyer = createMeteredBuyer({ accountId: "0.0.5001", privateKey: buyerKey });
    const r = await buyer.buy(`${lane(4791)}/v1/chat/completions`, chat("answer in 400 words", { max_tokens: 30 }));
    assert.equal(r.receipt!.cap, 30);
    assert.equal(r.receipt!.billable, 30);
  });

  test("the buyer's client refuses to SIGN above maxPerCall", async () => {
    const buyer = createMeteredBuyer({ accountId: "0.0.5001", privateKey: buyerKey, maxPerCall: "0.0002" });
    const before = balance("0.0.5001");
    await assert.rejects(buyer.buy(`${lane(4791)}/v1/chat/completions`, chat("answer in 300 words")), (e: unknown) => {
      assert.ok(e instanceof BuyerLimitError);
      assert.equal(e.quote.amount, "0.00304");
      return true;
    });
    assert.equal(balance("0.0.5001"), before);
    const also = await buyer.buy(`${lane(4791)}/v1/chat/completions`, chat("answer in 100 words")).catch((e) => e); // 0.00104 > cap too
    assert.ok(also instanceof BuyerLimitError);
    const cheap = await buyer.buy(`${lane(4791)}/v1/chat/completions`, chat("answer in 10 words"));
    assert.equal(cheap.receipt!.amount, "0.00014");
  });

  test("a session budget stops spending across calls", async () => {
    const buyer = createMeteredBuyer({ accountId: "0.0.5001", privateKey: buyerKey, budget: "0.004" });
    const a = await buyer.buy(`${lane(4791)}/v1/chat/completions`, chat("answer in 300 words"));
    assert.equal(a.receipt!.amount, "0.00304");
    await assert.rejects(buyer.buy(`${lane(4791)}/v1/chat/completions`, chat("answer in 300 words")), /budget/);
    assert.equal(buyer.spent(), "0.00304");
    assert.equal(buyer.remaining(), "0.00096");
  });
});

describe("the payment can't be gamed", () => {
  test("signing a smaller amount for the quote is rejected", async () => {
    const before = balance(PAY_TO);
    const { second } = await manualPay(`${lane(4791)}/v1/chat/completions`, chat("answer in 60 words"), buyerKey, "0.0.5001", (req) => { req.amount = "1"; });
    assert.equal(second.status, 402);
    assert.equal((await second.json()).error, "payment_does_not_match_quote");
    assert.equal(balance(PAY_TO), before);
  });

  test("claiming the real quote but signing less fails facilitator verify", async () => {
    const before = balance(PAY_TO);
    const { second } = await manualPay(`${lane(4791)}/v1/chat/completions`, chat("answer in 61 words"), buyerKey, "0.0.5001", (req) => { req.amount = "1"; }, true);
    assert.equal(second.status, 402);
    assert.equal((await second.json()).error, "amount_mismatch");
    assert.equal(balance(PAY_TO), before);
  });

  test("a replayed payment header is not charged twice and gets a fresh quote", async () => {
    const init = chat("answer in 62 words");
    const { second, header } = await manualPay(`${lane(4791)}/v1/chat/completions`, init, buyerKey, "0.0.5001");
    assert.equal(second.status, 200);
    const afterFirst = balance(PAY_TO);
    const replay = await fetch(`${lane(4791)}/v1/chat/completions`, { ...init, headers: { "PAYMENT-SIGNATURE": header } });
    assert.equal(replay.status, 402);
    assert.equal((await replay.json()).error, "quote_expired");
    assert.equal(balance(PAY_TO), afterFirst);
  });

  test("a payment for one request can't unlock another", async () => {
    const { header } = await (async () => {
      const r = await fetch(`${lane(4791)}/v1/chat/completions`, chat("answer in 7 words"));
      const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!);
      const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(createClientHederaSigner("0.0.5001", buyerKey)) as any).setSpendControls(false);
      const payload = await client.createPaymentPayload(pr);
      return { header: encodePaymentSignatureHeader(payload) };
    })();
    const other = await fetch(`${lane(4791)}/v1/chat/completions`, { ...chat("answer in 500 words"), headers: { "PAYMENT-SIGNATURE": header } });
    assert.equal(other.status, 402);
    assert.equal((await other.json()).error, "payment_does_not_match_request");
  });

  test("a payer who can't afford the quote is refused and keeps their money", async () => {
    const { second } = await manualPay(`${lane(4791)}/v1/chat/completions`, chat("answer in 40 words"), poorKey, "0.0.5003");
    assert.equal(second.status, 402);
    assert.equal((await second.json()).error, "insufficient_funds");
    assert.equal(balance("0.0.5003"), 1000n);
  });

  test("an unpaid client can't stack up unlimited work", async () => {
    const a = await fetch(`${lane(4795)}/price`);
    assert.equal(a.status, 402);
    const b = await fetch(`${lane(4795)}/price?x=2`);
    assert.equal(b.status, 429);
    assert.equal((await b.json()).error, "too_many_unpaid_quotes");
  });

  test("an expired hold is re-metered instead of paid", async () => {
    const init = {} as RequestInit;
    const first = await fetch(`${lane(4796)}/price`, init);
    const pr = decodePaymentRequiredHeader(first.headers.get("payment-required")!);
    await new Promise((r) => setTimeout(r, 1300));
    const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(createClientHederaSigner("0.0.5001", buyerKey)) as any).setSpendControls(false);
    const header = encodePaymentSignatureHeader(await client.createPaymentPayload(pr));
    const before = balance(PAY_TO);
    const late = await fetch(`${lane(4796)}/price`, { headers: { "PAYMENT-SIGNATURE": header } });
    assert.equal(late.status, 402);
    assert.equal((await late.json()).error, "quote_expired");
    assert.equal(balance(PAY_TO), before);
  });
});

describe("other meters and edges", () => {
  const buyer = () => createMeteredBuyer({ accountId: "0.0.5001", privateKey: buyerKey });
  const gql = (first: number) => ({ method: "POST", body: JSON.stringify({ query: `{ pools(first: ${first}) { id } }` }) });

  test("rows: GraphQL priced per row, and a cap rewrites first: N", async () => {
    const r7 = await buyer().buy(lane(4792), gql(7));
    assert.equal(r7.receipt!.billable, 7);
    assert.equal(r7.receipt!.amount, "0.014");
    const r3 = await buyer().buy(lane(4792), { ...gql(50), maxUnits: 3 });
    assert.equal(JSON.parse(r3.body).data.pools.length, 3, "the upstream query was clamped");
    assert.equal(r3.receipt!.amount, "0.006");
  });

  test("zero billable units is served free, no payment", async () => {
    const r = await fetch(`${lane(4792)}/`, { method: "POST", body: JSON.stringify({ query: "{ pools(first: 0) { id } }" }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-meter-amount"), "0");
  });

  test("request meter = GlassBox402's flat price, unchanged", async () => {
    const a = await buyer().buy(`${lane(4793)}/price`);
    const b = await buyer().buy(`${lane(4793)}/price?again=1`);
    assert.equal(a.receipt!.amount, "0.01");
    assert.equal(b.receipt!.amount, "0.01");
    assert.equal(JSON.parse(a.body).ethereum.usd, 4242.42);
  });

  test("upstream errors pass through, free", async () => {
    const before = balance(PAY_TO);
    const r = await fetch(`${lane(4793)}/fail`);
    assert.equal(r.status, 500);
    assert.equal(r.headers.get("x-meter-amount"), "0");
    assert.equal(balance(PAY_TO), before);
  });

  test("the operator's upstream key is injected server-side and never exposed", async () => {
    const direct = await fetch(`${up.url}/private/v1/chat/completions`, chat("hi"));
    assert.equal(direct.status, 401);
    const r = await buyer().buy(`${lane(4794)}/v1/chat/completions`, chat("answer in 3 words"));
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify([...r.res.headers]).includes("sekret"));
  });

  test("concurrent buyers settle independently", async () => {
    const [a, b, c] = await Promise.all([10, 20, 30].map((n) => buyer().buy(`${lane(4791)}/v1/chat/completions`, chat(`answer in ${n} words`))));
    assert.deepEqual([a, b, c].map((r) => r.receipt!.billable), [14, 24, 34]);
    assert.ok([a, b, c].every((r) => r.paid && r.receipt!.bodyVerified));
    assert.equal(new Set([a, b, c].map((r) => r.receipt!.txHash)).size, 3);
  });
});

describe("hub, policy, analytics", () => {
  test("World ID tiers: bots pay the multiplied rate, verified humans the base rate", async () => {
    await fetch(`${HUB}/policy/flat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ humanVerifiedOnly: true, botMultiplier: 10 }) });
    await new Promise((r) => setTimeout(r, 2600)); // gateways poll policy every 2s
    const buyer = createMeteredBuyer({ accountId: "0.0.5001", privateKey: buyerKey });
    const bot = await buyer.buy(`${lane(4793)}/price?who=bot`);
    const human = await buyer.buy(`${lane(4793)}/price?who=human`, { headers: { "x-world-proof": issueSessionToken("n1", true) } });
    const faker = await buyer.buy(`${lane(4793)}/price?who=faker`, { headers: { "x-world-proof": "lol" } });
    assert.equal(bot.receipt!.amount, "0.1");
    assert.equal(human.receipt!.amount, "0.01");
    assert.equal(faker.receipt!.amount, "0.1");
    await fetch(`${HUB}/policy/flat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blockBots: true }) });
    await new Promise((r) => setTimeout(r, 2600));
    const blocked = await fetch(`${lane(4793)}/price?who=bot2`);
    assert.equal(blocked.status, 403);
    await fetch(`${HUB}/policy/flat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ humanVerifiedOnly: false, blockBots: false }) });
  });

  test("the dashboard's test buyer pays with limits", async () => {
    const post = (body: unknown) => fetch(`${HUB}/testbuyer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const ok = await post({ url: `${lane(4791)}/v1/chat/completions`, method: "POST", body: chat("answer in 25 words").body, maxUnits: 20 });
    assert.equal(ok.ok, true);
    assert.equal(ok.paid, true);
    assert.equal(ok.receipt.billable, 20);
    assert.equal(ok.buyer, "0.0.5004");
    const refused = await post({ url: `${lane(4791)}/v1/chat/completions`, method: "POST", body: chat("answer in 300 words").body, maxPerCall: "0.0001" });
    assert.equal(refused.ok, false);
    assert.equal(refused.refused, true);
  });

  test("hub analytics reconcile with the facilitator ledger", async () => {
    const a = await fetch(`${HUB}/analytics`).then((r) => r.json());
    const ledgerIncome = Number(balance(PAY_TO)) / 1e8;
    assert.ok(Math.abs(a.totalIncome - ledgerIncome) < 1e-9, `hub ${a.totalIncome} vs ledger ${ledgerIncome}`);
    assert.equal(a.totalRequests, fac.settlements.length);
    assert.ok(a.byLane.llm.totalUnits > 0);
    assert.equal(a.byLane.llm.unit, "tokens");
    assert.ok(a.byLane.llm.charges.max > a.byLane.llm.charges.min, "metered prices vary per call");
    assert.ok(a.byLane.llm.saved > 0, "buyers saved vs flat-at-cap");
    const { lanes } = await fetch(`${HUB}/lanes`).then((r) => r.json());
    assert.deepEqual(lanes.map((l: any) => l.name).sort(), ["expiry", "flat", "llm", "pools", "private", "tight"]);
    assert.equal(lanes.find((l: any) => l.name === "llm").rateLabel, "0.01 HBAR / 1000 tokens");
  });

  test("the tape records the metered event chain", async () => {
    const events = readFileSync(TAPE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const types = new Set(events.map((e) => e.type));
    for (const t of ["lane_up", "request_in", "metered", "quote_402", "settled", "hedera_receipt", "payment_failed", "quote_expired", "upstream_error", "rate_limited", "free", "blocked", "policy"]) {
      assert.ok(types.has(t), `tape has ${t}`);
    }
    const s = events.find((e) => e.type === "settled" && e.lane === "llm");
    for (const k of ["from", "unit", "units", "measured", "rate", "per", "amount", "txHash", "bodySha256"]) assert.ok(k in s.data, `settled has ${k}`);
    // one settled event per ledger settlement, amounts identical
    const settled = events.filter((e) => e.type === "settled");
    assert.equal(settled.length, fac.settlements.length);
    assert.deepEqual(settled.map((e) => e.data.amountAtomic).sort(), fac.settlements.map((x) => x.amount.toString()).sort());
  });
});
