// Subscriptions: commitments the seller can count, and the checks that stop a
// buyer claiming credit for a payment they never committed.
//
// Everything here runs against a fake ledger. What we are testing is the
// seller's scepticism: the schedule has to pay the right account, the right
// amount, from the right buyer, with wait_for_expiry set, and it must be the
// buyer's own money rather than an allowance they can revoke.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SubscriptionBook, checkSchedule, subscriptionChallenge, type OnChainSchedule } from "../src/subscriptions.ts";

const BUYER = "0.0.10470117";
const PAYTO = "0.0.10454509";
const AMOUNT = 100_000_000n; // 1 HBAR in tinybar
const DAY = 86_400;

const schedule = (over: Partial<OnChainSchedule> = {}): OnChainSchedule => ({
  schedule_id: "0.0.900001",
  creator: BUYER,
  payer: BUYER,
  due_at: Date.now() + DAY * 1000,
  executed_at: null,
  deleted: false,
  wait_for_expiry: true,
  memo: "mx402 weather",
  transfers: [
    { account: BUYER, amount: -AMOUNT, approved: false },
    { account: PAYTO, amount: AMOUNT, approved: false },
  ],
  tokenTransfers: 0,
  ...over,
});

// ── what the seller will and will not accept ─────────────────────────────
test("a schedule that really pays us passes", () => {
  assert.equal(checkSchedule(schedule(), { buyer: BUYER, payTo: PAYTO, amountAtomic: AMOUNT }).ok, true);
});

test("a schedule paying someone else, or the wrong amount, fails", () => {
  const toOther = schedule({ transfers: [{ account: BUYER, amount: -AMOUNT, approved: false }, { account: "0.0.999", amount: AMOUNT, approved: false }] });
  assert.match(checkSchedule(toOther, { buyer: BUYER, payTo: PAYTO, amountAtomic: AMOUNT }).reason!, /pays 0 to/);

  const short = schedule({ transfers: [{ account: BUYER, amount: -1n, approved: false }, { account: PAYTO, amount: 1n, approved: false }] });
  assert.match(checkSchedule(short, { buyer: BUYER, payTo: PAYTO, amountAtomic: AMOUNT }).reason!, /expected 100000000/);
});

test("someone else's schedule does not become your subscription", () => {
  const notMine = schedule({ transfers: [{ account: "0.0.777", amount: -AMOUNT, approved: false }, { account: PAYTO, amount: AMOUNT, approved: false }] });
  assert.match(checkSchedule(notMine, { buyer: BUYER, payTo: PAYTO, amountAtomic: AMOUNT }).reason!, /debits 0 from/);
});

test("an allowance-backed transfer is refused: that is not a commitment", () => {
  const approved = schedule({ transfers: [{ account: BUYER, amount: -AMOUNT, approved: true }, { account: PAYTO, amount: AMOUNT, approved: false }] });
  assert.match(checkSchedule(approved, { buyer: BUYER, payTo: PAYTO, amountAtomic: AMOUNT }).reason!, /allowance_backed/);
});

test("cancelled, missing and token schedules are refused", () => {
  assert.equal(checkSchedule(null, { buyer: BUYER, payTo: PAYTO, amountAtomic: AMOUNT }).reason, "not_found");
  assert.equal(checkSchedule(schedule({ deleted: true }), { buyer: BUYER, payTo: PAYTO, amountAtomic: AMOUNT }).reason, "cancelled");
  assert.equal(checkSchedule(schedule({ tokenTransfers: 1 }), { buyer: BUYER, payTo: PAYTO, amountAtomic: AMOUNT }).reason, "token_transfer_not_supported");
});

// ── opening one ──────────────────────────────────────────────────────────
const key = { verify: () => true };
const badKey = { verify: () => false };

function book(over: { read?: (id: string) => Promise<OnChainSchedule | null>; publicKeyOf?: any; includes?: number | null } = {}) {
  return new SubscriptionBook({
    lane: "weather",
    payTo: PAYTO,
    amountAtomic: AMOUNT,
    secret: "test-secret",
    publicKeyOf: over.publicKeyOf ?? (async () => key),
    read: over.read ?? (async (id) => schedule({ schedule_id: id })),
    terms: { price: "1", period_sec: DAY, max_periods: 4, includes_units: over.includes === undefined ? 100 : over.includes, payTo: PAYTO, currency: "HBAR", network: "hedera:testnet" },
  });
}

test("the challenge is single use and the signature must verify", async () => {
  const b = book();
  const { nonce } = b.challenge();
  assert.equal((await b.open(BUYER, nonce, "aa", ["0.0.900001"]) as any).ok, true);
  const again = await b.open(BUYER, nonce, "aa", ["0.0.900001"]);
  assert.deepEqual(again, { ok: false, error: "challenge_expired" }, "a nonce cannot be replayed");

  const b2 = book({ publicKeyOf: async () => badKey });
  const r = await b2.open(BUYER, b2.challenge().nonce, "aa", ["0.0.900001"]);
  assert.deepEqual(r, { ok: false, error: "bad_signature" });
});

test("a subscription needs schedules, and not too many", async () => {
  const b = book();
  assert.deepEqual(await b.open(BUYER, b.challenge().nonce, "aa", []), { ok: false, error: "no_schedules" });
  const many = await b.open(BUYER, b.challenge().nonce, "aa", ["1", "2", "3", "4", "5"]);
  assert.match((many as any).error, /at most 4 periods/);
});

test("a schedule without wait_for_expiry is refused: it would fire immediately", async () => {
  const b = book({ read: async (id) => schedule({ schedule_id: id, wait_for_expiry: false }) });
  const r = await b.open(BUYER, b.challenge().nonce, "aa", ["0.0.900001"]);
  assert.match((r as any).error, /must wait for expiry/);
});

test("the token round-trips, and a forged one does not", async () => {
  const b = book();
  const r = await b.open(BUYER, b.challenge().nonce, "aa", ["0.0.900001"]) as any;
  assert.equal(b.fromToken(r.token)?.id, r.sub.id);
  assert.equal(b.fromToken(r.token.slice(0, -3) + "xxx"), null, "a tampered signature is rejected");
  assert.equal(b.fromToken("nonsense"), null);
  assert.equal(book().fromToken(r.token), null, "another seller's secret does not validate it");
});

// ── spending the period ──────────────────────────────────────────────────
test("included units are spent, then the call falls back to paying", async () => {
  const b = book();
  const r = await b.open(BUYER, b.challenge().nonce, "aa", ["0.0.900001"]) as any;
  const sub = b.fromToken(r.token)!;
  assert.deepEqual(b.spend(sub, 40), { covered: 40, excess: 0 });
  assert.deepEqual(b.spend(sub, 50), { covered: 50, excess: 0 });
  assert.deepEqual(b.spend(sub, 30), { covered: 10, excess: 20 }, "the period runs out mid-call");
  assert.deepEqual(b.spend(sub, 5), { covered: 0, excess: 5 }, "and stays out");
});

test("unlimited periods cover everything", async () => {
  const b = book({ includes: null });
  const r = await b.open(BUYER, b.challenge().nonce, "aa", ["0.0.900001"]) as any;
  assert.deepEqual(b.spend(b.fromToken(r.token)!, 10_000), { covered: 10_000, excess: 0 });
});

// ── the point of the exercise: countable revenue ─────────────────────────
test("committed revenue counts only what has not run yet", async () => {
  const now = Date.now();
  const ids = ["0.0.1", "0.0.2", "0.0.3"];
  const b = book({
    read: async (id) => schedule({
      schedule_id: id,
      due_at: now + DAY * 1000 * (ids.indexOf(id) + 1),
      // the first period has already been executed by consensus
      executed_at: id === "0.0.1" ? now - 1000 : null,
    }),
  });
  const r = await b.open(BUYER, b.challenge().nonce, "aa", ids) as any;
  assert.equal(r.ok, true);
  const c = b.committed();
  assert.equal(c.periods, 2, "two future payments remain");
  assert.equal(c.atomic, AMOUNT * 2n);
  assert.equal(c.subscriptions, 1);
  assert.equal(r.sub.periods[0].executed_at, now - 1000, "execution is read from the ledger, not assumed");
});

test("the challenge message is bound to lane and buyer", () => {
  assert.equal(subscriptionChallenge("weather", BUYER, "abc"), `mx402-sub:weather:${BUYER}:abc`);
  assert.notEqual(subscriptionChallenge("weather", BUYER, "abc"), subscriptionChallenge("llm", BUYER, "abc"));
});
