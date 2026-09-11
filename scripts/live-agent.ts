// The payment-layer lifecycle, live on Hedera testnet, as an agent sees it.
//   (start the stack first: npm run demo, and optionally `mx402 publish …`)
//   npx tsx scripts/live-agent.ts
//
// Discover → Quote → Budget → Pay → Use → Meter → Settle → Receipt → Reputation,
// through the SDK, A2A and Metered Tabs, with every settlement checked on the
// mirror node and the reputation snapshot anchored on HCS.

import { loadEnv } from "../src/env.ts";
import { MeterX402, MeterX402Agent, BudgetError } from "../src/sdk/index.ts";
import { mirrorTransfer } from "../src/hedera.ts";
import { hashscanTx } from "../src/events.ts";

loadEnv();
const HUB = process.env.MX_HUB ?? "http://127.0.0.1:4021";
const wallet = { accountId: process.env.BUYER_ACCOUNT_ID!, privateKey: process.env.BUYER_PRIVATE_KEY! };
if (!wallet.accountId || !wallet.privateKey) { console.error("set BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY in .env"); process.exit(2); }
const line = (s = "") => console.log(s);
const h = (s: string) => line(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`);

const agent = new MeterX402Agent({ wallet, budget: "0.5 HBAR", registry: HUB });

h("1 · Discover");
for (const capability of ["weather_forecast", "market_data", "text_generation", "blockchain_data"]) {
  const found = await agent.discover({ capability });
  line(`${capability.padEnd(18)} ${found.map((l) => `${l.service_id} (${l.price.rate} ${l.price.currency}/${l.price.unit}, rep ${l.reputation.score ?? "unrated"})`).join("  ·  ") || "none"}`);
}

h("2 · Quote → budget → pay (explicit steps)");
const mx = new MeterX402({ wallet, budget: "0.5 HBAR", registry: HUB });
const q = await mx.quote("crypto-markets", { query: { per_page: "5" } }).catch(() => null);
if (q && "pay" in q) {
  line(`quote ${q.quote.quote_id.slice(0, 8)}…  ${q.quote.units} ${q.quote.unit} → ${q.quote.amount} ${q.quote.currency}  (route: ${q.route.scheme} on ${q.route.option.network})`);
  const r = await q.pay();
  line(`paid  ${r.receipt!.amount} ${r.receipt!.currency}  tx ${hashscanTx(r.receipt!.transaction_id!)}`);
  line(`verify body hash ${r.verification!.bodyHash ? "✓" : "✗"} · re-metered ${r.verification!.remetered} ${q.quote.unit} (${r.verification!.method}) ${r.verification!.unitsMatch ? "✓" : "✗"}`);
  const coins = (r.data as any[]).map((c) => `${c.symbol.toUpperCase()} $${c.current_price}`).join(", ");
  line(`data  ${coins}`);
  const onChain = await mirrorTransfer(r.receipt!.transaction_id!, r.receipt!.seller);
  line(`mirror node: ${onChain.result}, ${onChain.tinybar} tinybar credited (receipt says ${r.receipt!.amount_atomic}) ${String(onChain.tinybar) === r.receipt!.amount_atomic ? "✓" : "✗"}`);
} else line("crypto-markets not published — run `mx402 publish` (see README) to include it");

h("3 · An agent names a capability; the layer picks, pays, verifies");
for (const days of ["1", "3"]) {
  const r = await agent.call("weather_forecast", { query: { forecast_days: days } });
  line(`${r.service}: ${days}-day forecast → ${r.receipt!.metered_units} ${r.receipt!.unit} = ${r.receipt!.amount} HBAR  ${r.verification!.unitsMatch ? "re-metered ✓" : "✗"}  ${hashscanTx(r.receipt!.transaction_id!)}`);
}

h("4 · Agent-to-agent over A2A (the LLM is Groq gpt-oss-20b)");
const llm = (await agent.discover({ capability: "text_generation" }))[0];
if (llm) {
  const a = await agent.a2a(llm.descriptor.endpoint, "In one sentence: why should AI agents pay per token instead of per call?");
  const text = (a.data as any)?.choices?.[0]?.message?.content ?? JSON.stringify(a.data).slice(0, 200);
  line(`task ${a.task.id.slice(0, 8)}… ${a.task.status.state}; quoted ${a.quote?.units} tokens = ${a.quote?.amount} HBAR; paid ${a.paid}`);
  line(`answer: ${String(text).replace(/\s+/g, " ").slice(0, 220)}`);
  if (a.receipt?.transaction_id) line(`tx ${hashscanTx(a.receipt.transaction_id)}`);
}

h("5 · Metered Tab: one allowance, many calls, one settlement");
const tabAgent = new MeterX402Agent({ wallet, budget: "0.5 HBAR", registry: HUB, useTabs: { allowance: "0.05" } });
const t0 = Date.now();
for (const days of ["1", "2", "1", "2"]) {
  const t = Date.now();
  const r = await tabAgent.call("weather", { query: { forecast_days: days } });
  line(`tab call: ${r.receipt!.metered_units} rows = ${r.receipt!.amount} HBAR in ${Date.now() - t}ms (settles later)`);
}
await tabAgent.close();
line(`4 calls in ${Date.now() - t0}ms, settled in one approved transfer on close: ${tabAgent.spent} HBAR`);

h("6 · Budgets are enforced before signing");
const tight = new MeterX402Agent({ wallet, budget: "0.0005 HBAR", registry: HUB });
try { await tight.call("text_generation", { body: { model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "Write 300 words about budgets" }] } }); line("✗ paid anyway"); }
catch (e) { line(`${e instanceof BudgetError ? "refused" : "failed"}: ${(e as Error).message}`); }

h("7 · Reputation, anchored on HCS");
const anchor = await fetch(`${HUB}/registry/reputation/anchor`, { method: "POST" }).then((r) => r.json());
line(anchor.ok ? `snapshot of ${anchor.services.length} services → HCS topic ${anchor.topic_id}  ${anchor.hashscan}` : `not anchored: ${anchor.error}`);
for (const l of await agent.discover({})) {
  const r = l.reputation;
  line(`${l.service_id.padEnd(15)} ${String(r.score ?? "unrated").padStart(7)}  (${r.confidence}, ${r.sample_size} samples · ${r.stats.paid_calls} paid · median ${r.stats.median_latency_ms ?? "-"} ms · uptime ${r.stats.uptime_ratio ?? "-"})`);
}

line(`\nagent spent ${agent.spent} HBAR of 0.5 across ${agent.receipts.length} receipts; buyer-side SDK spent ${mx.spent}`);
