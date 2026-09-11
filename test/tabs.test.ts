// Unit tests for the tab book: the allowance IS the limit, and the seller can
// never pull more than it, nor keep serving once a settlement fails.
//   npx tsx --test test/tabs.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@hiero-ledger/sdk";
import { TabBook, challengeMessage, type TabLedger } from "../src/tabs.ts";

const ownerKey = PrivateKey.generateECDSA();
const OWNER = "0.0.1001";
const SPENDER = "0.0.7001";
const PAYTO = "0.0.6001";

function fakeLedger(over: Partial<TabLedger> & { allowanceTinybar?: bigint; failPull?: string } = {}): TabLedger & { pulls: bigint[] } {
  const pulls: bigint[] = [];
  let left = over.allowanceTinybar ?? 1_000_000n;
  return {
    mode: "mock",
    pulls,
    async publicKeyOf(a: string) { return a === OWNER ? ownerKey.publicKey : null; },
    async allowance() { return left; },
    async pull(_owner: string, _to: string, amount: bigint) {
      if (over.failPull) throw new Error(over.failPull);
      if (amount > left) throw new Error("AMOUNT_EXCEEDS_ALLOWANCE");
      left -= amount;
      pulls.push(amount);
      return { txId: `0.0.7001@${pulls.length}` };
    },
    ...over,
  } as any;
}

const book = (ledger: TabLedger, flushAt = 1_000_000n) =>
  new TabBook({ lane: "llm", ledger, spender: SPENDER, payTo: PAYTO, flushAt, secret: "test-secret" });

async function openTab(b: TabBook, key = ownerKey, owner = OWNER) {
  const { nonce } = b.challenge();
  const sig = Buffer.from(key.sign(Buffer.from(challengeMessage("llm", owner, nonce)))).toString("hex");
  return b.open(owner, nonce, sig, 0);
}

describe("tabs: opening", () => {
  test("a valid challenge signature + a real allowance opens a tab", async () => {
    const b = book(fakeLedger());
    const r = await openTab(b);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.tab.owner, OWNER);
    assert.equal(r.tab.allowanceAtOpen, 1_000_000n);
    assert.equal(b.get(r.token)?.id, r.tab.id);
  });

  test("someone else's signature does not open a tab on your account", async () => {
    const b = book(fakeLedger());
    const r = await openTab(b, PrivateKey.generateECDSA());
    assert.deepEqual(r, { ok: false, error: "bad_signature" });
  });

  test("no allowance, no tab", async () => {
    const r = await openTab(book(fakeLedger({ allowanceTinybar: 0n })));
    assert.deepEqual(r, { ok: false, error: "no_allowance" });
  });

  test("a challenge is single-use and expires", async () => {
    const b = book(fakeLedger());
    const { nonce } = b.challenge();
    const sig = Buffer.from(ownerKey.sign(Buffer.from(challengeMessage("llm", OWNER, nonce)))).toString("hex");
    assert.ok((await b.open(OWNER, nonce, sig, 0)).ok);
    assert.deepEqual(await b.open(OWNER, nonce, sig, 0), { ok: false, error: "challenge_expired" });
  });

  test("a tampered or unsigned token resolves to nothing", async () => {
    const b = book(fakeLedger());
    const r = await openTab(b);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(b.get(r.token.slice(0, -2) + "xx"), null);
    assert.equal(b.get("tab.v1.whatever.99999999999999.x"), null);
    assert.equal(b.get(undefined), null);
  });
});

describe("tabs: spending", () => {
  test("debits accumulate and never exceed the allowance", async () => {
    const l = fakeLedger({ allowanceTinybar: 1000n });
    const b = book(l, 10_000n); // high threshold: no auto-flush here
    const r = await openTab(b);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(b.debit(r.tab, 400n, 40), { ok: true });
    assert.deepEqual(b.debit(r.tab, 400n, 40), { ok: true });
    assert.equal(b.available(r.tab), 200n);
    assert.deepEqual(b.debit(r.tab, 300n, 30), { ok: false, reason: "tab_exhausted" });
    assert.equal(r.tab.owed, 800n);
    assert.equal(r.tab.calls, 2);
    assert.equal(r.tab.units, 80);
  });

  test("crossing the flush threshold settles exactly what is owed", async () => {
    const l = fakeLedger();
    const b = book(l, 500n);
    const r = await openTab(b);
    assert.ok(r.ok);
    if (!r.ok) return;
    b.debit(r.tab, 200n, 20);
    assert.deepEqual(l.pulls, []);
    b.debit(r.tab, 400n, 40); // 600 ≥ 500 → flush
    await r.tab.flushing;
    assert.deepEqual(l.pulls, [600n]);
    assert.equal(r.tab.owed, 0n);
    assert.equal(r.tab.pulled, 600n);
    assert.equal(b.available(r.tab), 999_400n); // allowance − pulled
  });

  test("closing settles the remainder and forgets the tab", async () => {
    const l = fakeLedger();
    const b = book(l);
    const r = await openTab(b);
    assert.ok(r.ok);
    if (!r.ok) return;
    b.debit(r.tab, 123n, 12);
    const { settled } = await b.close(r.tab);
    assert.equal(settled?.amount, 123n);
    assert.match(settled?.txId ?? "", /^0\.0\.7001@/);
    assert.equal(b.get(r.token), null);
    assert.equal(b.size, 0);
  });

  test("a revoked allowance freezes the tab instead of serving unpaid work", async () => {
    const l = fakeLedger({ failPull: "AMOUNT_EXCEEDS_ALLOWANCE" });
    const b = book(l, 100n);
    const r = await openTab(b);
    assert.ok(r.ok);
    if (!r.ok) return;
    b.debit(r.tab, 150n, 15);
    await r.tab.flushing;
    assert.equal(r.tab.frozen, "AMOUNT_EXCEEDS_ALLOWANCE");
    assert.deepEqual(b.debit(r.tab, 10n, 1), { ok: false, reason: "tab_frozen: AMOUNT_EXCEEDS_ALLOWANCE" });
  });

  test("concurrent flushes settle once, not twice", async () => {
    const l = fakeLedger();
    const b = book(l, 10_000n);
    const r = await openTab(b);
    assert.ok(r.ok);
    if (!r.ok) return;
    b.debit(r.tab, 500n, 50);
    await Promise.all([b.flush(r.tab.id), b.flush(r.tab.id), b.flush(r.tab.id)]);
    assert.deepEqual(l.pulls, [500n]);
    assert.equal(r.tab.owed, 0n);
  });
});
