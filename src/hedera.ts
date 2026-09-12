// Operator-side Hedera: HCS receipts, mirror-node lookups, account lazy-create.
//
// Not in the payment path. Payments are signed by the buyer and settled by the
// facilitator; this module only needs the OPERATOR's credentials
// (HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY), and everything here degrades to a
// no-op without them.
//
// The HCS receipt is what makes metering auditable: every settled call writes
// {lane, unit, units, rate, amount, bodySha256, tx} to a public topic,
// consensus-timestamped by the network. The transfer proves money moved; the
// receipt proves what was measured and what it was for.

import {
  AccountId, Client, Hbar, PrivateKey,
  PublicKey, TopicCreateTransaction, TopicMessageSubmitTransaction, TransferTransaction,
} from "@hiero-ledger/sdk";
import { hashscanTx } from "./events.ts";

/** Hedera keys come as DER (302e…/3030…) or raw hex. Raw hex is ambiguous, so
 *  HEDERA_KEY_TYPE picks (default ECDSA, what EVM-alias / portal accounts use). */
export function parseHederaKey(raw: string, type = process.env.HEDERA_KEY_TYPE ?? "ecdsa"): PrivateKey {
  const k = raw.trim().replace(/^0x/, "");
  if (/^30[0-9a-f]+$/i.test(k) && k.length > 64) return PrivateKey.fromStringDer(k);
  return type.toLowerCase() === "ed25519" ? PrivateKey.fromStringED25519(k) : PrivateKey.fromStringECDSA(k);
}

const NET = () => (process.env.HEDERA_NETWORK === "hedera:mainnet" ? "mainnet" : "testnet");
export const MIRROR = () => `https://${NET() === "mainnet" ? "mainnet-public" : "testnet"}.mirrornode.hedera.com/api/v1`;

let client: Client | null = null;
let topicId: string | null = null;

export function hederaEnabled(): boolean {
  return !!(process.env.HEDERA_ACCOUNT_ID && process.env.HEDERA_PRIVATE_KEY) && process.env.MX_OFFLINE !== "1";
}

export function initHedera(): Client {
  if (client) return client;
  const id = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID!);
  const key = parseHederaKey(process.env.HEDERA_PRIVATE_KEY!);
  client = (NET() === "mainnet" ? Client.forMainnet() : Client.forTestnet()).setOperator(id, key);
  return client;
}

export async function ensureTopic(): Promise<string> {
  if (topicId) return topicId;
  if (process.env.HEDERA_TOPIC_ID) {
    topicId = process.env.HEDERA_TOPIC_ID;
    console.log(`🪵 HCS receipt topic ${topicId} (from HEDERA_TOPIC_ID)  https://hashscan.io/${NET()}/topic/${topicId}`);
    return topicId;
  }
  const c = initHedera();
  const tx = await new TopicCreateTransaction().setTopicMemo("MeterX402 metered x402 receipts").execute(c);
  topicId = (await tx.getReceipt(c)).topicId!.toString();
  console.log(`🪵 HCS receipt topic ${topicId}  https://hashscan.io/${NET()}/topic/${topicId}`);
  console.log(`   ↳ add HEDERA_TOPIC_ID=${topicId} to .env to keep this topic across restarts`);
  return topicId;
}

export interface HederaReceipt { txId: string; topicId: string; hashscan: string; }

export async function hederaReceipt(message: string): Promise<HederaReceipt> {
  const c = initHedera();
  const topic = await ensureTopic();
  const submit = await new TopicMessageSubmitTransaction().setTopicId(topic).setMessage(message).execute(c);
  await submit.getReceipt(c);
  const txId = submit.transactionId!.toString();
  return { txId, topicId: topic, hashscan: hashscanTx(txId, NET()) };
}

/** Real HBAR transfer to an account id or a raw EVM address (a fresh 0x address
 *  is lazy-created by receiving HBAR). */
export async function hederaTransfer(to: string, hbar: number): Promise<HederaReceipt> {
  const c = initHedera();
  const from = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID!);
  const toAccount = to.startsWith("0x") ? AccountId.fromEvmAddress(0, 0, to) : AccountId.fromString(to);
  const tx = await new TransferTransaction()
    .addHbarTransfer(from, new Hbar(-hbar))
    .addHbarTransfer(toAccount, new Hbar(hbar))
    .execute(c);
  await tx.getReceipt(c);
  const txId = tx.transactionId!.toString();
  return { txId, topicId: "", hashscan: hashscanTx(txId, NET()) };
}

/** An account's public key, straight off the mirror node. Needs no operator,
 *  no client and no key of our own: it is a public record. */
export async function mirrorPublicKey(account: string): Promise<PublicKey | null> {
  try {
    const r = await fetch(`${MIRROR()}/accounts/${account}`);
    if (!r.ok) return null;
    const k = ((await r.json()) as any)?.key;
    if (!k?.key) return null;
    return k._type === "ED25519" ? PublicKey.fromStringED25519(k.key)
      : k._type === "ECDSA_SECP256K1" ? PublicKey.fromStringECDSA(k.key)
      : PublicKey.fromString(k.key);
  } catch { return null; }
}

export interface HederaAccount { accountId: string; evm: string | null; balance: number; created: boolean; hashscan: string; }

export async function lookupAccount(addrOrId: string): Promise<HederaAccount | null> {
  try {
    const r = await fetch(`${MIRROR()}/accounts/${addrOrId}`);
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!j?.account) return null;
    return {
      accountId: j.account, evm: j.evm_address ?? null, balance: Number(j.balance?.balance ?? 0) / 1e8,
      created: false, hashscan: `https://hashscan.io/${NET()}/account/${j.account}`,
    };
  } catch {
    return null;
  }
}

/** Resolve a connected wallet to its Hedera account, lazy-creating it (a small
 *  transfer to the 0x address) if Hedera has never seen it. */
export async function resolveOrCreateAccount(addr: string): Promise<HederaAccount | null> {
  const existing = await lookupAccount(addr);
  if (existing) return existing;
  if (!addr.startsWith("0x") || !hederaEnabled()) return null;
  await hederaTransfer(addr, 0.1);
  for (let i = 0; i < 15; i++) { // the mirror node lags consensus by a beat
    await new Promise((r) => setTimeout(r, 400));
    const found = await lookupAccount(addr);
    if (found) return { ...found, created: true };
  }
  return null;
}

/** What `account` was actually credited by transaction `txId`, read off the
 *  mirror node with none of our code in the loop.
 *
 *  For an HTS asset this also reports the fees CONSENSUS assessed on the
 *  transfer (a token's custom fee schedule), which is the difference between
 *  what the buyer signed for and what the seller nets. Used by the live test
 *  and by SettlementAdapter.verify. */
export interface MirrorCredit {
  found: boolean;
  /** credited amount in the asset's atomic units (tinybar for HBAR) */
  tinybar: bigint;
  result?: string;
  /** ledger-assessed custom fees on this transfer, if any */
  assessedFees?: { amount: bigint; collector: string; token: string | null }[];
  /** gross = credit + fees taken out of it (inclusive fees) */
  gross?: bigint;
}

export async function mirrorTransfer(txId: string, account: string, asset = "0.0.0"): Promise<MirrorCredit> {
  // mirror wants 0.0.x-sss-nnn
  const id = txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  const isHbar = !asset || asset === "0.0.0";
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${MIRROR()}/transactions/${id}`);
      if (r.ok) {
        const j: any = await r.json();
        const t = j.transactions?.[0];
        if (t) {
          const credit = isHbar
            ? (t.transfers ?? []).filter((x: any) => x.account === account).reduce((s: bigint, x: any) => s + BigInt(x.amount), 0n)
            : (t.token_transfers ?? []).filter((x: any) => x.account === account && x.token_id === asset)
                .reduce((s: bigint, x: any) => s + BigInt(x.amount), 0n);
          const assessedFees = (t.assessed_custom_fees ?? [])
            .filter((f: any) => isHbar ? !f.token_id : f.token_id === asset)
            .map((f: any) => ({ amount: BigInt(f.amount ?? 0), collector: String(f.collector_account_id ?? ""), token: f.token_id ?? null }));
          const taken = assessedFees.reduce((s: bigint, f: { amount: bigint }) => s + f.amount, 0n);
          return { found: true, tinybar: credit, result: t.result, assessedFees, gross: credit + taken };
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { found: false, tinybar: 0n };
}
