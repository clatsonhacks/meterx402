// Metered Tabs: the buyer's limit lives ON-CHAIN, as a Hedera allowance.
//
// Meter-then-pay (gateway.ts) settles every call on its own: exact, but one
// consensus round trip per call. An agent making hundreds of small calls wants
// something else, and so does a buyer who wants a hard spending limit that the
// SELLER can't exceed even by lying:
//
//   1. the buyer approves an HBAR allowance to the lane's spender account
//      (AccountAllowanceApproveTransaction, signed by the buyer). That amount IS
//      the buyer's limit; Hedera enforces it, and the buyer can revoke it any time
//   2. the buyer proves they own the account (signs a one-time challenge) and the
//      gateway reads the allowance off the ledger → a tab opens
//   3. calls go straight through: no 402, no per-call wait. Each is metered and
//      debited from the tab. The tab's remaining allowance also CAPS each call's
//      work, so a call can never run past what the buyer can pay for
//   4. the gateway settles what was used in batches with an approved transfer
//      (owner → payTo, signed by the spender): exactly the metered total, one
//      transaction per batch. Closing the tab settles the rest
//
// Nothing is deposited, nothing needs refunding: unused allowance simply stays
// in the buyer's account. The seller's exposure if a buyer revokes mid-tab is at
// most one unsettled batch (`flushAt`).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AccountAllowanceApproveTransaction, AccountId, Client, Hbar, PublicKey, TransferTransaction, type PrivateKey } from "@hiero-ledger/sdk";
import { MIRROR, parseHederaKey } from "./hedera.ts";

// ── the ledger a tab settles against ─────────────────────────────────────

export interface TabLedger {
  mode: "hedera" | "mock";
  /** Where a buyer approves an allowance in mock mode (dev only). */
  devUrl?: string;
  /** The account's public key (for verifying the tab challenge signature). */
  publicKeyOf(account: string): Promise<PublicKey | null>;
  /** Remaining HBAR allowance owner → spender, in tinybar. */
  allowance(owner: string, spender: string): Promise<bigint>;
  /** Approved transfer owner → to, signed by the spender. */
  pull(owner: string, to: string, amount: bigint, memo: string): Promise<{ txId: string }>;
}

const toPublicKey = (k: { _type?: string; key?: string } | null | undefined): PublicKey | null => {
  if (!k?.key) return null;
  try {
    return k._type === "ED25519" ? PublicKey.fromStringED25519(k.key) : k._type === "ECDSA_SECP256K1" ? PublicKey.fromStringECDSA(k.key) : PublicKey.fromString(k.key);
  } catch { return null; }
};

/** Real Hedera: mirror node for reads, the spender's key for the pull. */
export function hederaTabLedger(spenderId: string, spenderKey: string, network = process.env.HEDERA_NETWORK ?? "hedera:testnet"): TabLedger {
  const client = (network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet()).setOperator(AccountId.fromString(spenderId), parseHederaKey(spenderKey));
  return {
    mode: "hedera",
    async publicKeyOf(account) {
      const r = await fetch(`${MIRROR()}/accounts/${account}`);
      if (!r.ok) return null;
      return toPublicKey((await r.json())?.key);
    },
    async allowance(owner, spender) {
      const r = await fetch(`${MIRROR()}/accounts/${owner}/allowances/crypto?spender.id=${spender}`);
      if (!r.ok) return 0n;
      const a = (await r.json())?.allowances?.[0];
      return a ? BigInt(a.amount ?? a.amount_granted ?? 0) : 0n;
    },
    async pull(owner, to, amount, memo) {
      const tx = await new TransferTransaction()
        .addApprovedHbarTransfer(AccountId.fromString(owner), Hbar.fromTinybars((-amount).toString()))
        .addHbarTransfer(AccountId.fromString(to), Hbar.fromTinybars(amount.toString()))
        .setTransactionMemo(memo.slice(0, 100))
        .execute(client);
      await tx.getReceipt(client);
      return { txId: tx.transactionId!.toString() };
    },
  };
}

/** The mock facilitator's ledger (offline demo + tests). Pulls are signed by
 *  the spender's key and checked by the mock, like Hedera would. */
export function mockTabLedger(url: string, spenderId: string, spenderKey: PrivateKey): TabLedger {
  return {
    mode: "mock",
    devUrl: url,
    async publicKeyOf(account) {
      const r = await fetch(`${url}/keys/${account}`);
      return r.ok ? toPublicKey({ key: (await r.json()).publicKey }) : null;
    },
    async allowance(owner, spender) {
      const j = await fetch(`${url}/allowances?owner=${owner}&spender=${spender}`).then((r) => r.json());
      return BigInt(j.amount ?? 0);
    },
    async pull(owner, to, amount, memo) {
      const nonce = randomBytes(8).toString("hex");
      const msg = `mx402-pull:${owner}:${spenderId}:${to}:${amount}:${nonce}`;
      const signature = Buffer.from(spenderKey.sign(Buffer.from(msg))).toString("hex");
      const r = await fetch(`${url}/pull`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner, spender: spenderId, to, amount: amount.toString(), nonce, signature, memo }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "pull_failed");
      return { txId: j.txId };
    },
  };
}

// ── buyer side: approve an allowance (the limit) ─────────────────────────

export async function approveAllowance(opts: {
  ledger: { mode: "hedera" | "mock"; devUrl?: string };
  owner: string; ownerKey: PrivateKey; spender: string; amount: bigint; network?: string;
}): Promise<string> {
  if (opts.ledger.mode === "mock") {
    const msg = `mx402-approve:${opts.owner}:${opts.spender}:${opts.amount}`;
    const r = await fetch(`${opts.ledger.devUrl}/allowances`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: opts.owner, spender: opts.spender, amount: opts.amount.toString(), signature: Buffer.from(opts.ownerKey.sign(Buffer.from(msg))).toString("hex") }),
    }).then((x) => x.json());
    if (!r.ok) throw new Error(r.error ?? "approve_failed");
    return r.txId;
  }
  const client = (opts.network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet()).setOperator(AccountId.fromString(opts.owner), opts.ownerKey);
  try {
    const tx = await new AccountAllowanceApproveTransaction()
      .approveHbarAllowance(AccountId.fromString(opts.owner), AccountId.fromString(opts.spender), Hbar.fromTinybars(opts.amount.toString()))
      .execute(client);
    await tx.getReceipt(client);
    return tx.transactionId!.toString();
  } finally { client.close(); }
}

export const challengeMessage = (lane: string, owner: string, nonce: string) => `mx402-tab:${lane}:${owner}:${nonce}`;

// ── seller side: the tab book ─────────────────────────────────────────────

export interface Tab {
  id: string;
  owner: string;
  openedAt: number;
  allowanceAtOpen: bigint; // remaining allowance when the tab opened
  pulled: bigint;          // settled on-chain so far
  owed: bigint;            // metered, not yet settled
  calls: number;           // total metered calls
  unsettledCalls: number;
  unsettledUnits: number;
  units: number;
  frozen: string | null;   // reason, once a settlement fails (e.g. allowance revoked)
  flushing: Promise<unknown> | null;
  lastFlushAt: number;
}

export interface FlushResult { tabId: string; owner: string; amount: bigint; calls: number; units: number; txId?: string; error?: string; }

export interface TabOptions {
  lane: string;
  ledger: TabLedger;
  spender: string;
  payTo: string;
  flushAt: bigint;          // settle when this much is owed
  flushEveryMs?: number;    // …or this often, when anything is owed
  ttlMs?: number;           // a tab's token lifetime
  secret?: string;
  onFlush?: (r: FlushResult) => void;
  now?: () => number;
}

export class TabBook {
  private tabs = new Map<string, Tab>();
  private nonces = new Map<string, number>();
  private secret: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;

  constructor(private o: TabOptions) {
    this.secret = o.secret ?? process.env.MX_TAB_SECRET ?? process.env.WORLD_TOKEN_SECRET ?? randomBytes(32).toString("hex");
    this.now = o.now ?? Date.now;
    if (o.flushEveryMs) {
      this.timer = setInterval(() => { for (const t of this.tabs.values()) if (t.owed > 0n) void this.flush(t.id, "timer"); }, o.flushEveryMs);
      this.timer.unref?.();
    }
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  challenge(): { nonce: string; expiresAt: number } {
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = this.now() + 5 * 60_000;
    this.nonces.set(nonce, expiresAt);
    for (const [n, e] of this.nonces) if (e < this.now()) this.nonces.delete(n);
    return { nonce, expiresAt };
  }

  private sign = (payload: string) => createHmac("sha256", this.secret).update(payload).digest("base64url");

  /** Open a tab: the buyer proves account ownership, the ledger proves the allowance. */
  async open(owner: string, nonce: string, signatureHex: string, waitMs = 12_000): Promise<{ ok: true; token: string; tab: Tab } | { ok: false; error: string }> {
    const exp = this.nonces.get(nonce);
    if (!exp || exp < this.now()) return { ok: false, error: "challenge_expired" };
    this.nonces.delete(nonce); // single use
    const key = await this.o.ledger.publicKeyOf(owner).catch(() => null);
    if (!key) return { ok: false, error: "owner_key_not_found" };
    let good = false;
    try { good = key.verify(Buffer.from(challengeMessage(this.o.lane, owner, nonce)), Buffer.from(signatureHex, "hex")); } catch {}
    if (!good) return { ok: false, error: "bad_signature" };
    // the mirror node lags consensus by a few seconds after an approval
    let allowance = 0n;
    for (const end = this.now() + waitMs; ;) {
      allowance = await this.o.ledger.allowance(owner, this.o.spender).catch(() => 0n);
      if (allowance > 0n || this.now() > end) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (allowance <= 0n) return { ok: false, error: "no_allowance" };
    const tab: Tab = { id: randomBytes(9).toString("base64url"), owner, openedAt: this.now(), allowanceAtOpen: allowance, pulled: 0n, owed: 0n, calls: 0, unsettledCalls: 0, unsettledUnits: 0, units: 0, frozen: null, flushing: null, lastFlushAt: this.now() };
    this.tabs.set(tab.id, tab);
    const payload = `tab.v1.${tab.id}.${this.now() + (this.o.ttlMs ?? 24 * 3600_000)}`;
    return { ok: true, token: `${payload}.${this.sign(payload)}`, tab };
  }

  /** Resolve a token to its open tab (signature + expiry checked, constant-time). */
  get(token: string | undefined | null): Tab | null {
    if (!token) return null;
    const i = token.lastIndexOf(".");
    if (i < 0) return null;
    const payload = token.slice(0, i), got = token.slice(i + 1), want = this.sign(payload);
    if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
    const [v, ver, id, exp] = payload.split(".");
    if (v !== "tab" || ver !== "v1" || Number(exp) < this.now()) return null;
    return this.tabs.get(id) ?? null;
  }

  /** What the tab can still spend: allowance − settled − owed. */
  available(t: Tab): bigint { return t.allowanceAtOpen - t.pulled - t.owed; }

  /** Record one metered call. Refuses anything the allowance can't cover. */
  debit(t: Tab, amount: bigint, units: number): { ok: true } | { ok: false; reason: string } {
    if (t.frozen) return { ok: false, reason: `tab_frozen: ${t.frozen}` };
    if (amount > this.available(t)) return { ok: false, reason: "tab_exhausted" };
    t.owed += amount;
    t.calls++; t.unsettledCalls++; t.unsettledUnits += units; t.units += units;
    if (t.owed >= this.o.flushAt) void this.flush(t.id, "threshold");
    return { ok: true };
  }

  /** Settle what's owed with one approved transfer. Serialised per tab. */
  async flush(tabId: string, reason = "manual"): Promise<FlushResult | null> {
    const t = this.tabs.get(tabId);
    if (!t) return null;
    while (t.flushing) await t.flushing; // one settlement at a time per tab
    const amount = t.owed, calls = t.unsettledCalls, units = t.unsettledUnits;
    if (amount <= 0n || t.frozen) return null;
    const run = (async (): Promise<FlushResult> => {
      try {
        const { txId } = await this.o.ledger.pull(t.owner, this.o.payTo, amount, `mx402 tab ${t.id} ${calls} calls (${reason})`);
        t.owed -= amount; t.pulled += amount; t.unsettledCalls -= calls; t.unsettledUnits -= units; t.lastFlushAt = this.now();
        return { tabId: t.id, owner: t.owner, amount, calls, units, txId };
      } catch (e) {
        // e.g. the buyer revoked or spent the allowance: stop serving this tab
        t.frozen = String((e as Error)?.message ?? e).split("\n")[0];
        return { tabId: t.id, owner: t.owner, amount, calls, units, error: t.frozen };
      }
    })();
    t.flushing = run;
    const res = await run.finally(() => { t.flushing = null; });
    this.o.onFlush?.(res);
    return res;
  }

  /** Close: settle everything, forget the tab. The rest of the allowance stays with the buyer. */
  async close(t: Tab): Promise<{ settled: FlushResult | null; tab: Tab }> {
    const settled = await this.flush(t.id, "close");
    this.tabs.delete(t.id);
    return { settled, tab: t };
  }

  get size() { return this.tabs.size; }
}
