// Live test on Hedera testnet through the real blocky402 facilitator.
//   npm run test:live
//
// Needs in .env:
//   BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY   a funded testnet account that pays (DER or hex; HEDERA_KEY_TYPE for raw hex)
//   WALLET                                  the payout account (0.0.x), must already exist
//
// Runs the mock LLM locally as the upstream (so the only external systems are
// blocky402 and Hedera), buys two calls of very different size, and then checks
// each settlement on the public mirror node, with none of our code in the loop:
// the payout account must have been credited EXACTLY the metered amount.

import { loadEnv } from "../src/env.ts";
import { startMockUpstream } from "../src/mock/upstream.ts";
import { startGateway } from "../src/gateway.ts";
import { createMeteredBuyer } from "../src/paid-fetch.ts";
import { lookupAccount, mirrorTransfer } from "../src/hedera.ts";
import { hederaTabLedger } from "../src/tabs.ts";
import { toAtomic } from "../src/pricing.ts";
import { hashscanTx } from "../src/events.ts";

loadEnv();
const buyerId = process.env.BUYER_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID;
const buyerKey = process.env.BUYER_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY;
const payTo = process.env.WALLET;
if (!buyerId || !buyerKey || !payTo) {
  console.error("✖ set BUYER_ACCOUNT_ID, BUYER_PRIVATE_KEY and WALLET (payout 0.0.x) in .env first");
  process.exit(2);
}
if (buyerId === payTo) console.warn("⚠️  buyer and payout are the same account: the net balance change will be ~0, but the transfer is still verifiable");

let failures = 0;
const ok = (name: string, cond: boolean, extra = "") => { console.log(`${cond ? "✅" : "❌"} ${name}${extra ? `  (${extra})` : ""}`); if (!cond) failures++; };

const buyerAcct = await lookupAccount(buyerId);
ok("buyer account exists on testnet", !!buyerAcct, buyerAcct ? `${buyerAcct.balance.toFixed(4)} HBAR` : "not found on mirror node");
const payAcct = await lookupAccount(payTo);
ok("payout account exists on testnet", !!payAcct, payAcct?.accountId);
if (!buyerAcct || !payAcct) process.exit(1);

const up = await startMockUpstream();
const gw = await startGateway({
  upstream: up.url, name: "llm-live", port: 4991, payTo: payAcct.accountId, meter: "tokens",
  card: { rate: "0.01", per: "1000", min: "0.0001" }, hub: process.env.MX_LIVE_HUB ?? null,
});
const buyer = createMeteredBuyer({ accountId: buyerId, privateKey: buyerKey, maxPerCall: "0.05", budget: "0.1" });
const chat = (words: number) => ({ method: "POST", body: JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: `answer in ${words} words` }] }) });

try {
  for (const words of [20, 600]) {
    const t0 = Date.now();
    const r = await buyer.buy(`${gw.url}/v1/chat/completions`, chat(words));
    const rc = r.receipt;
    ok(`${words}-word answer: paid and served`, r.status === 200 && r.paid, `${Date.now() - t0}ms`);
    if (!rc?.txHash) { ok("settlement tx returned", false); continue; }
    console.log(`   ${rc.billable} ${rc.unit} × ${rc.rate}/${rc.per} = ${rc.amount} HBAR   ${hashscanTx(rc.txHash)}`);
    ok("body hash matches the quote", rc.bodyVerified);
    const onChain = await mirrorTransfer(rc.txHash, payAcct.accountId);
    ok("mirror node: transaction SUCCESS", onChain.found && onChain.result === "SUCCESS", onChain.result ?? "not found");
    ok("mirror node: payout credited exactly the metered amount", onChain.tinybar === toAtomic(rc.amount), `${onChain.tinybar} tinybar vs quoted ${toAtomic(rc.amount)}`);
  }
  ok("session spend tracked", Number(buyer.spent()) > 0, `${buyer.spent()} HBAR`);
} finally {
  await gw.close();
}

// ── Metered Tabs + streaming, on the real ledger ──────────────────────────
// The buyer approves a real HBAR allowance (their limit), calls stream through
// with no per-call settlement, and the gateway pulls exactly what was used with
// an approved transfer.
const spenderId = process.env.TAB_SPENDER_ID ?? process.env.HEDERA_ACCOUNT_ID!;
const spenderKey = process.env.TAB_SPENDER_KEY ?? process.env.HEDERA_PRIVATE_KEY!;
if (spenderId === buyerId) {
  console.log("\n⏭️  skipping tabs: the buyer and the tab spender are the same account (Hedera rejects an allowance to yourself)");
} else {
  console.log(`\n── Metered Tabs (spender ${spenderId}) ──`);
  const tabGw = await startGateway({
    upstream: up.url, name: "llm-tab-live", port: 4992, payTo: payAcct.accountId, meter: "tokens",
    card: { rate: "0.01", per: "1000" }, hub: process.env.MX_LIVE_HUB ?? null,
    tab: { ledger: hederaTabLedger(spenderId, spenderKey), spender: spenderId, flushAt: "1", flushEverySec: 3600 },
  });
  try {
    const t0 = Date.now();
    const tab = await buyer.openTab(tabGw.url, { allowance: "0.05", revokeOnClose: true });
    ok("tab opened against a real on-chain allowance", !!tab.token, `${tab.allowance} HBAR approved in ${Date.now() - t0}ms`);

    let expected = 0;
    const perCall: number[] = [];
    for (const words of [20, 50]) {
      const t = Date.now();
      const r = await tab.buy(`${tabGw.url}/v1/chat/completions`, chat(words));
      perCall.push(Date.now() - t);
      expected += Number(r.receipt!.amount);
      ok(`tab call (${words} words) served with no per-call payment`, r.status === 200, `${r.receipt!.billable} tokens = ${r.receipt!.amount} HBAR in ${Date.now() - t}ms`);
    }
    ok("tab calls are far faster than settling each one", Math.max(...perCall) < 1500, `${perCall.join("ms, ")}ms vs ~5000ms per settled call`);

    // streaming: the answer arrives in chunks, and the receipt closes the stream
    let chunks = 0, streamed = "", receipt: any;
    const tStream = Date.now();
    for await (const part of tab.stream(`${tabGw.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: "answer in 80 words" }], stream: true }) })) {
      if (part.type === "chunk") { chunks++; streamed += part.text; }
      if (part.type === "receipt") receipt = part.receipt;
    }
    ok("streamed response arrived in chunks, not one blob", chunks > 10, `${chunks} chunks, ${streamed.split(" ").length} words, ${Date.now() - tStream}ms`);
    ok("the stream was metered from the tokens that went past", receipt?.billable === 84, `${receipt?.billable} tokens = ${receipt?.amount} HBAR`);
    expected += Number(receipt?.amount ?? 0);

    const beforeClose = (await lookupAccount(payAcct.accountId))?.balance ?? 0;
    const closed = await tab.close();
    ok("closing the tab settles everything in ONE approved transfer", !!closed.lastTx && closed.owedUnsettled === "0", `${closed.calls} calls, ${closed.paid} HBAR, tx ${closed.lastTx}`);
    ok("the tab total is exactly the sum of the metered calls", Math.abs(Number(closed.paid) - expected) < 1e-8, `${closed.paid} vs ${expected.toFixed(8)}`);
    if (closed.lastTx) {
      console.log(`   ${hashscanTx(closed.lastTx)}`);
      const onChain = await mirrorTransfer(closed.lastTx, payAcct.accountId);
      ok("mirror node: the allowance pull credited the payout account exactly", onChain.found && onChain.tinybar === toAtomic(closed.paid), `${onChain.tinybar} tinybar, ${onChain.result}`);
      await new Promise((r) => setTimeout(r, 3000));
      const after = (await lookupAccount(payAcct.accountId))?.balance ?? 0;
      ok("payout balance grew by the tab total", Math.abs(after - beforeClose - Number(closed.paid)) < 1e-6, `${beforeClose} → ${after} HBAR`);
    }
  } finally {
    await tabGw.close();
  }
}
await up.close();
console.log(failures === 0 ? "\n🟢 LIVE: metered x402 settles exactly on Hedera testnet" : `\n🔴 ${failures} check(s) failed`);
process.exit(failures ? 1 : 0);
