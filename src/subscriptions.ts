// Subscriptions: revenue the seller can see before it arrives.
//
// A Metered Tab is an allowance — permission to take money, which the buyer can
// revoke at any moment and which promises nothing. A subscription here is the
// opposite: the buyer signs the future transfers NOW, as Hedera scheduled
// transactions (HIP-423), each due at its own period boundary with
// wait_for_expiry set. Consensus executes them unattended — verified on
// testnet: one signature at creation, executed 14 ms after the expiry
// timestamp with nobody online.
//
// What that buys each side:
//   seller — committed revenue, on the public ledger, countable before it lands
//   buyer  — pays on a schedule, keeps an admin key, cancels any unexecuted
//            period; nothing is deposited and nothing needs refunding
//
// The gateway never holds a key here either. It reads the schedules off the
// mirror node, decodes the actual transfer body, and believes what the ledger
// says rather than what the buyer claims.

import { createHmac, randomBytes } from "node:crypto";
import { MIRROR, parseHederaKey } from "./hedera.ts";
import type { PrivateKey } from "@hiero-ledger/sdk";

export interface ScheduledPayment {
  schedule_id: string;
  due_at: number;          // ms
  amount_atomic: string;
  executed_at: number | null;
}

export interface SubscriptionTerms {
  /** price per period, as a decimal string in the settlement currency */
  price: string;
  period_sec: number;
  /** how many periods a buyer may commit to at once */
  max_periods: number;
  /** metered units included per period; calls beyond it fall back to pay-per-call */
  includes_units: number | null;
  payTo: string;
  currency: string;
  network: string;
}

/** Hedera caps how far ahead a schedule may sit (HIP-423: ~62 days). */
export const MAX_SCHEDULE_AHEAD_SEC = 5_356_800;

// ── buyer side: commit to the future payments ────────────────────────────

export interface SubscribeOptions {
  buyer: { accountId: string; privateKey: string | PrivateKey };
  payTo: string;
  amountAtomic: bigint;
  periods: number;
  periodSec: number;
  /** when the first payment falls due (default: one period from now) */
  startAt?: number;
  memo?: string;
  network?: string;
}

/** Create one scheduled transfer per period, signed by the buyer up front. */
export async function scheduleSubscription(o: SubscribeOptions): Promise<ScheduledPayment[]> {
  const { AccountId, Client, Hbar, ScheduleCreateTransaction, Timestamp, TransferTransaction } = await import("@hiero-ledger/sdk");
  const key = typeof o.buyer.privateKey === "string" ? parseHederaKey(o.buyer.privateKey) : o.buyer.privateKey;
  const client = (o.network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet())
    .setOperator(AccountId.fromString(o.buyer.accountId), key);
  const out: ScheduledPayment[] = [];
  try {
    for (let i = 0; i < o.periods; i++) {
      const dueMs = (o.startAt ?? Date.now() + o.periodSec * 1000) + i * o.periodSec * 1000;
      const dueSec = Math.floor(dueMs / 1000);
      const ahead = dueSec - Math.floor(Date.now() / 1000);
      if (ahead <= 0) throw new Error(`period ${i + 1} is already due`);
      if (ahead > MAX_SCHEDULE_AHEAD_SEC) throw new Error(`period ${i + 1} is ${Math.round(ahead / 86400)} days out; Hedera schedules reach ~62 days`);
      const inner = new TransferTransaction()
        .addHbarTransfer(AccountId.fromString(o.buyer.accountId), Hbar.fromTinybars((-o.amountAtomic).toString()))
        .addHbarTransfer(AccountId.fromString(o.payTo), Hbar.fromTinybars(o.amountAtomic.toString()));
      const tx = await new ScheduleCreateTransaction()
        .setScheduledTransaction(inner)
        .setScheduleMemo((o.memo ?? "mx402 subscription").slice(0, 100))
        .setExpirationTime(new Timestamp(dueSec, 0))
        .setWaitForExpiry(true)                       // due at the boundary, not on last signature
        .setPayerAccountId(AccountId.fromString(o.buyer.accountId))
        .setAdminKey(key.publicKey)                   // the buyer can cancel what has not run
        .execute(client);
      const id = (await tx.getReceipt(client)).scheduleId!.toString();
      out.push({ schedule_id: id, due_at: dueSec * 1000, amount_atomic: o.amountAtomic.toString(), executed_at: null });
    }
    return out;
  } finally {
    client.close();
  }
}

/** Cancel an unexecuted period. Needs the admin key, i.e. the buyer's. */
export async function cancelScheduled(scheduleId: string, buyer: { accountId: string; privateKey: string | PrivateKey }, network?: string): Promise<{ ok: boolean; error?: string }> {
  const { AccountId, Client, ScheduleDeleteTransaction, ScheduleId } = await import("@hiero-ledger/sdk");
  const key = typeof buyer.privateKey === "string" ? parseHederaKey(buyer.privateKey) : buyer.privateKey;
  const client = (network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet())
    .setOperator(AccountId.fromString(buyer.accountId), key);
  try {
    const tx = await (await new ScheduleDeleteTransaction()
      .setScheduleId(ScheduleId.fromString(scheduleId))
      .freezeWith(client)
      .sign(key)).execute(client);
    await tx.getReceipt(client);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).split("\n")[0] };
  } finally {
    client.close();
  }
}

// ── seller side: believe the ledger, not the buyer ───────────────────────

export interface OnChainSchedule {
  schedule_id: string;
  creator: string;
  payer: string;
  due_at: number;
  executed_at: number | null;
  deleted: boolean;
  wait_for_expiry: boolean;
  memo: string;
  /** decoded from the scheduled transaction body */
  transfers: { account: string; amount: bigint; approved: boolean }[];
  tokenTransfers: number;
}

const acct = (a: any) => `${a?.shardNum ?? 0}.${a?.realmNum ?? 0}.${a?.accountNum ?? 0}`;

/** Read a schedule and decode what it will actually do. */
export async function readSchedule(scheduleId: string, mirror = MIRROR()): Promise<OnChainSchedule | null> {
  const r = await fetch(`${mirror}/schedules/${scheduleId}`).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json()) as any;
  const { proto } = await import("@hiero-ledger/proto");
  let transfers: OnChainSchedule["transfers"] = [];
  let tokenTransfers = 0;
  try {
    const body = proto.SchedulableTransactionBody.decode(Buffer.from(j.transaction_body, "base64"));
    transfers = (body.cryptoTransfer?.transfers?.accountAmounts ?? []).map((a: any) => ({
      account: acct(a.accountID), amount: BigInt(a.amount?.toString() ?? "0"), approved: !!a.isApproval,
    }));
    tokenTransfers = (body.cryptoTransfer?.tokenTransfers ?? []).length;
  } catch { /* not a transfer, or an unreadable body: transfers stays empty */ }
  const sec = (t: string | null) => (t ? Math.round(Number(t) * 1000) : null);
  return {
    schedule_id: String(j.schedule_id),
    creator: String(j.creator_account_id ?? ""),
    payer: String(j.payer_account_id ?? ""),
    due_at: sec(j.expiration_time) ?? 0,
    executed_at: sec(j.executed_timestamp),
    deleted: !!j.deleted,
    wait_for_expiry: !!j.wait_for_expiry,
    memo: String(j.memo ?? ""),
    transfers,
    tokenTransfers,
  };
}

export interface ScheduleCheck {
  ok: boolean;
  reason?: string;
  schedule?: OnChainSchedule;
}

/** Does this schedule really pay us, from this buyer, for this much? */
export function checkSchedule(s: OnChainSchedule | null, expect: { buyer: string; payTo: string; amountAtomic: bigint }): ScheduleCheck {
  if (!s) return { ok: false, reason: "not_found" };
  if (s.deleted) return { ok: false, reason: "cancelled" };
  if (s.tokenTransfers) return { ok: false, reason: "token_transfer_not_supported" };
  const credit = s.transfers.filter((t) => t.account === expect.payTo).reduce((a, t) => a + t.amount, 0n);
  const debit = s.transfers.filter((t) => t.account === expect.buyer).reduce((a, t) => a + t.amount, 0n);
  if (credit !== expect.amountAtomic) return { ok: false, reason: `pays ${credit} to ${expect.payTo}, expected ${expect.amountAtomic}`, schedule: s };
  if (debit !== -expect.amountAtomic) return { ok: false, reason: `debits ${debit} from ${expect.buyer}, expected -${expect.amountAtomic}`, schedule: s };
  if (s.transfers.some((t) => t.approved)) return { ok: false, reason: "allowance_backed: the buyer has not committed their own funds", schedule: s };
  return { ok: true, schedule: s };
}

// ── the seller's book of committed revenue ───────────────────────────────

export interface Subscription {
  id: string;
  buyer: string;
  periods: ScheduledPayment[];
  amount_atomic: string;
  period_sec: number;
  includes_units: number | null;
  created_at: number;
  /** units used in the current period */
  used: number;
  period_index: number;
}

export const subscriptionChallenge = (lane: string, buyer: string, nonce: string) => `mx402-sub:${lane}:${buyer}:${nonce}`;

export class SubscriptionBook {
  private subs = new Map<string, Subscription>();
  private nonces = new Map<string, number>();
  private secret: string;

  constructor(private o: {
    lane: string;
    payTo: string;
    terms: SubscriptionTerms;
    amountAtomic: bigint;
    /** for tests */
    now?: () => number;
    secret?: string;
    /** how long to let the mirror node catch up with a fresh schedule */
    mirrorWaitMs?: number;
    publicKeyOf?: (account: string) => Promise<{ verify(m: Uint8Array, s: Uint8Array): boolean } | null>;
    read?: (id: string) => Promise<OnChainSchedule | null>;
  }) {
    this.secret = o.secret ?? process.env.MX_SUB_SECRET ?? "dev-subscription-secret";
  }

  private now = () => (this.o.now ?? Date.now)();
  private sign = (payload: string) => createHmac("sha256", this.secret).update(payload).digest("base64url");

  challenge() {
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = this.now() + 5 * 60_000;
    this.nonces.set(nonce, expiresAt);
    for (const [n, e] of this.nonces) if (e < this.now()) this.nonces.delete(n);
    return { nonce, expiresAt };
  }

  /** Accept a subscription: every period must really pay us, on-chain. */
  async open(buyer: string, nonce: string, signatureHex: string, scheduleIds: string[]): Promise<{ ok: true; token: string; sub: Subscription } | { ok: false; error: string }> {
    const exp = this.nonces.get(nonce);
    if (!exp || exp < this.now()) return { ok: false, error: "challenge_expired" };
    this.nonces.delete(nonce);

    const keyOf = this.o.publicKeyOf ?? (async (a: string) => {
      const { mirrorPublicKey } = await import("./hedera.ts");
      return mirrorPublicKey(a);
    });
    const key = await keyOf(buyer).catch(() => null);
    if (!key) return { ok: false, error: "buyer_key_not_found" };
    let good = false;
    try { good = key.verify(Buffer.from(subscriptionChallenge(this.o.lane, buyer, nonce)), Buffer.from(signatureHex, "hex")); } catch {}
    if (!good) return { ok: false, error: "bad_signature" };

    if (!scheduleIds.length) return { ok: false, error: "no_schedules" };
    if (scheduleIds.length > this.o.terms.max_periods) return { ok: false, error: `at most ${this.o.terms.max_periods} periods` };

    const read = this.o.read ?? ((id: string) => readSchedule(id));
    const periods: ScheduledPayment[] = [];
    for (const id of scheduleIds) {
      // the mirror node lags consensus by a few seconds, and these schedules
      // were created moments ago
      let s = await read(id).catch(() => null);
      for (const end = this.now() + (this.o.mirrorWaitMs ?? 15_000); !s && this.now() < end;) {
        await new Promise((r) => setTimeout(r, 1000));
        s = await read(id).catch(() => null);
      }
      const check = checkSchedule(s, { buyer, payTo: this.o.payTo, amountAtomic: this.o.amountAtomic });
      if (!check.ok) return { ok: false, error: `schedule ${id}: ${check.reason}` };
      if (!s!.wait_for_expiry) return { ok: false, error: `schedule ${id}: must wait for expiry, or it runs the moment it is signed` };
      periods.push({ schedule_id: id, due_at: s!.due_at, amount_atomic: this.o.amountAtomic.toString(), executed_at: s!.executed_at });
    }
    periods.sort((a, b) => a.due_at - b.due_at);

    const sub: Subscription = {
      id: randomBytes(9).toString("base64url"),
      buyer,
      periods,
      amount_atomic: this.o.amountAtomic.toString(),
      period_sec: this.o.terms.period_sec,
      includes_units: this.o.terms.includes_units,
      created_at: this.now(),
      used: 0,
      period_index: 0,
    };
    this.subs.set(sub.id, sub);
    const until = periods[periods.length - 1].due_at;
    const payload = `sub.v1.${sub.id}.${until}`;
    return { ok: true, token: `${payload}.${this.sign(payload)}`, sub };
  }

  /** The subscription behind a token, if the token is ours and still valid. */
  fromToken(token: string | undefined): Subscription | null {
    if (!token) return null;
    const i = token.lastIndexOf(".");
    if (i < 0) return null;
    const payload = token.slice(0, i);
    if (this.sign(payload) !== token.slice(i + 1)) return null;
    const [, , id, until] = payload.split(".");
    if (Number(until) < this.now()) return null;
    return this.subs.get(id) ?? null;
  }

  /** Consume the period's included units. Returns what is left to pay for. */
  spend(sub: Subscription, units: number): { covered: number; excess: number } {
    // roll the period forward as time passes
    const start = sub.periods[0]?.due_at ?? sub.created_at;
    const idx = Math.max(0, Math.floor((this.now() - start) / (sub.period_sec * 1000)) + 1);
    if (idx !== sub.period_index) { sub.period_index = idx; sub.used = 0; }
    if (sub.includes_units == null) return { covered: units, excess: 0 };
    const left = Math.max(0, sub.includes_units - sub.used);
    const covered = Math.min(units, left);
    sub.used += covered;
    return { covered, excess: units - covered };
  }

  get(id: string) { return this.subs.get(id); }
  all() { return [...this.subs.values()]; }

  /** Committed revenue: what is scheduled and has not run yet. */
  committed(now = this.now()) {
    let atomic = 0n, periods = 0;
    for (const s of this.subs.values()) {
      for (const p of s.periods) {
        if (p.executed_at == null && p.due_at > now) { atomic += BigInt(p.amount_atomic); periods++; }
      }
    }
    return { atomic, periods, subscriptions: this.subs.size };
  }

  /** Refresh execution state from the ledger. */
  async refresh(read: (id: string) => Promise<OnChainSchedule | null> = (id) => readSchedule(id)) {
    for (const s of this.subs.values()) {
      for (const p of s.periods) {
        if (p.executed_at != null) continue;
        const on = await read(p.schedule_id).catch(() => null);
        if (on?.executed_at) p.executed_at = on.executed_at;
      }
    }
  }
}
