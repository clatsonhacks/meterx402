// A local x402 facilitator for offline tests and the offline demo.
//
// It speaks the same HTTP API as blocky402 (/supported, /verify, /settle), and
// it genuinely checks the payment instead of rubber-stamping it: it decodes the
// buyer's partially signed Hedera TransferTransaction and verifies
//   - it is a plain transfer, with the facilitator as transaction payer (fee payer)
//   - payTo receives exactly the required amount, and only one account pays it
//   - the paying account's registered key signed it
//   - the payer can afford it, and the transaction id hasn't been used (replay)
// against an in-memory ledger. The only thing it doesn't do is gossip the
// transaction to Hedera, which is exactly the part the live test covers.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { PublicKey, Transaction } from "@hiero-ledger/sdk";
import {
  inspectHederaTransaction,
  getNetForAccount,
  hederaAccountIdsEqual,
  sumTransfers,
} from "@x402/hedera";

export interface MockFacilitatorOptions {
  port?: number;
  feePayer?: string;
  network?: string;
  /** Accept any payer with this balance (tinybar) when it isn't registered. Off by default. */
  openAccounts?: bigint;
}

interface Account { publicKey?: string; balance: bigint; }

export interface MockFacilitator {
  url: string;
  feePayer: string;
  ledger: Map<string, Account>;
  settlements: { txId: string; payer: string; payTo: string; amount: bigint }[];
  pulls: { txId: string; owner: string; to: string; amount: bigint }[];
  register(accountId: string, publicKeyDer: string | undefined, balanceTinybar: bigint): void;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

export async function startMockFacilitator(opts: MockFacilitatorOptions = {}): Promise<MockFacilitator> {
  const feePayer = opts.feePayer ?? "0.0.7162784";
  const network = opts.network ?? "hedera:testnet";
  const ledger = new Map<string, Account>();
  const usedTxIds = new Set<string>();
  const settlements: MockFacilitator["settlements"] = [];
  const allowances = new Map<string, bigint>(); // "owner>spender" → tinybar
  const pulls: MockFacilitator["pulls"] = [];

  const account = (id: string): Account | undefined => {
    for (const [k, v] of ledger) if (hederaAccountIdsEqual(k, id)) return v;
    if (opts.openAccounts != null) { const a = { balance: opts.openAccounts }; ledger.set(id, a); return a; }
    return undefined;
  };

  type Check = { ok: true; payer: string; txId: string; amount: bigint; payTo: string } | { ok: false; reason: string; payer?: string };

  function check(payload: any, req: any): Check {
    if (payload?.x402Version !== 2) return { ok: false, reason: "unsupported_x402_version" };
    if (req?.scheme !== "exact" || req?.network !== network) return { ok: false, reason: "unsupported_scheme_or_network" };
    if (req.asset !== "0.0.0") return { ok: false, reason: "only_hbar_supported_by_mock" };
    const b64 = payload?.payload?.transaction;
    if (typeof b64 !== "string") return { ok: false, reason: "invalid_exact_hedera_payload_transaction" };
    let tx;
    try { tx = inspectHederaTransaction(b64); } catch (e) { return { ok: false, reason: "invalid_transaction_bytes" }; }
    // (transactionType is a minified class name in the SDK build; the flag is instanceof-based)
    if (tx.hasNonTransferOperations) return { ok: false, reason: "not_a_transfer" };
    if (!hederaAccountIdsEqual(tx.transactionIdAccountId, feePayer)) return { ok: false, reason: "fee_payer_mismatch" };
    if (Object.keys(tx.tokenTransfers).length) return { ok: false, reason: "unexpected_token_transfers" };
    if (sumTransfers(tx.hbarTransfers) !== 0n) return { ok: false, reason: "transfers_do_not_balance" };

    const amount = BigInt(req.amount);
    const toPayTo = getNetForAccount(tx.hbarTransfers, req.payTo);
    if (toPayTo !== amount) return { ok: false, reason: "amount_mismatch" };
    if (getNetForAccount(tx.hbarTransfers, feePayer) !== 0n) return { ok: false, reason: "fee_payer_would_be_debited" };
    const payers = tx.hbarTransfers.filter((t) => BigInt(t.amount) < 0n);
    if (payers.length !== 1) return { ok: false, reason: "expected_single_payer" };
    const payer = payers[0].accountId;

    const acct = account(payer);
    if (!acct) return { ok: false, reason: "payer_not_found", payer };
    if (acct.publicKey) {
      const signed = PublicKey.fromString(acct.publicKey).verifyTransaction(Transaction.fromBytes(Buffer.from(b64, "base64")));
      if (!signed) return { ok: false, reason: "invalid_payer_signature", payer };
    }
    if (acct.balance < amount) return { ok: false, reason: "insufficient_funds", payer };
    if (usedTxIds.has(tx.transactionId)) return { ok: false, reason: "transaction_already_used", payer };
    return { ok: true, payer, txId: tx.transactionId, amount, payTo: req.payTo };
  }

  const server: Server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url ?? "/", "http://f");
      if (req.method === "GET" && url.pathname === "/supported") {
        return send(200, {
          kinds: [{ x402Version: 2, scheme: "exact", network, extra: { feePayer } }],
          extensions: [],
          signers: { "hedera:*": [feePayer] },
        });
      }
      if (req.method === "GET" && url.pathname === "/ledger") {
        return send(200, { balances: Object.fromEntries([...ledger].map(([k, v]) => [k, v.balance.toString()])), settlements: settlements.map((s) => ({ ...s, amount: s.amount.toString() })) });
      }
      if (req.method === "POST" && url.pathname === "/verify") {
        const { paymentPayload, paymentRequirements } = await readJson(req);
        const r = check(paymentPayload, paymentRequirements);
        return send(200, r.ok ? { isValid: true, payer: r.payer } : { isValid: false, invalidReason: r.reason, payer: r.payer });
      }
      if (req.method === "POST" && url.pathname === "/settle") {
        const { paymentPayload, paymentRequirements } = await readJson(req);
        const r = check(paymentPayload, paymentRequirements);
        if (!r.ok) return send(200, { success: false, errorReason: r.reason, payer: r.payer, transaction: "", network });
        usedTxIds.add(r.txId);
        account(r.payer)!.balance -= r.amount;
        const dest = account(r.payTo) ?? (ledger.set(r.payTo, { balance: 0n }), ledger.get(r.payTo)!);
        dest.balance += r.amount;
        settlements.push({ txId: r.txId, payer: r.payer, payTo: r.payTo, amount: r.amount });
        return send(200, { success: true, transaction: r.txId, network, payer: r.payer, amount: r.amount.toString() });
      }
      // ── Hedera allowances, for Metered Tabs (src/tabs.ts) ──────────────
      // approve: signed by the OWNER's key; pull: signed by the SPENDER's key,
      // bounded by the allowance and the owner's balance, like Hedera enforces.
      const verifySig = (acct: string, msg: string, sigHex: string) => {
        const a = account(acct);
        if (!a?.publicKey) return false;
        try { return PublicKey.fromString(a.publicKey).verify(Buffer.from(msg), Buffer.from(String(sigHex), "hex")); } catch { return false; }
      };
      if (req.method === "GET" && url.pathname.startsWith("/keys/")) {
        const a = account(decodeURIComponent(url.pathname.slice(6)));
        return a?.publicKey ? send(200, { publicKey: a.publicKey }) : send(404, { error: "not_found" });
      }
      if (url.pathname === "/allowances") {
        if (req.method === "GET") return send(200, { amount: (allowances.get(`${url.searchParams.get("owner")}>${url.searchParams.get("spender")}`) ?? 0n).toString() });
        const { owner, spender, amount, signature } = await readJson(req);
        if (!verifySig(owner, `mx402-approve:${owner}:${spender}:${amount}`, signature)) return send(200, { ok: false, error: "bad_owner_signature" });
        allowances.set(`${owner}>${spender}`, BigInt(amount)); // approve REPLACES, like Hedera; 0 revokes
        return send(200, { ok: true, txId: `${owner}@${(Date.now() / 1000).toFixed(9)}` });
      }
      if (req.method === "POST" && url.pathname === "/pull") {
        const { owner, spender, to, amount, nonce, signature } = await readJson(req);
        if (!verifySig(spender, `mx402-pull:${owner}:${spender}:${to}:${amount}:${nonce}`, signature)) return send(200, { ok: false, error: "bad_spender_signature" });
        if (usedTxIds.has(`pull:${nonce}`)) return send(200, { ok: false, error: "replayed" });
        const amt = BigInt(amount), key = `${owner}>${spender}`;
        const left = allowances.get(key) ?? 0n;
        if (amt > left) return send(200, { ok: false, error: "AMOUNT_EXCEEDS_ALLOWANCE" });
        const src = account(owner);
        if (!src || src.balance < amt) return send(200, { ok: false, error: "INSUFFICIENT_PAYER_BALANCE" });
        usedTxIds.add(`pull:${nonce}`);
        allowances.set(key, left - amt);
        src.balance -= amt;
        const dest = account(to) ?? (ledger.set(to, { balance: 0n }), ledger.get(to)!);
        dest.balance += amt;
        const txId = `${spender}@${(Date.now() / 1000).toFixed(9)}`;
        pulls.push({ txId, owner, to, amount: amt });
        return send(200, { ok: true, txId });
      }
      if (req.method === "POST" && url.pathname === "/accounts") {
        const { accountId, publicKey, balance } = await readJson(req);
        ledger.set(accountId, { publicKey, balance: BigInt(balance ?? 0) });
        return send(200, { ok: true });
      }
      send(404, { error: "not_found" });
    } catch (e) {
      send(500, { error: String(e) });
    }
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    feePayer,
    ledger,
    settlements,
    pulls,
    register(accountId, publicKeyDer, balanceTinybar) { ledger.set(accountId, { publicKey: publicKeyDer, balance: balanceTinybar }); },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Standalone (offline demo): every payer starts with 100 HBAR, signatures
  // are checked only for accounts registered via POST /accounts.
  const port = Number(process.env.MOCK_FACILITATOR_PORT ?? 4899);
  startMockFacilitator({ port, openAccounts: 100n * 100_000_000n }).then((f) =>
    console.log(`🧪 mock x402 facilitator on ${f.url} (fee payer ${f.feePayer}): offline, nothing reaches Hedera`));
}
