// Live check of The Graph services, paid from the Hedera buyer over x402.
//
//   npm run demo                 (in another terminal, with GRAPH_API_KEY set)
//   npx tsx scripts/live-graph.ts
//
// Buys lending markets, runs a query on an arbitrary subgraph (and a broken one,
// which must cost nothing), and asks for pools on chains whose standardized
// subgraphs are often down, to show the fallbacks and the source report.

import { loadEnv } from "../src/env.ts";
import { MeterX402, type CallResult } from "../src/sdk/buyer.ts";

loadEnv();
const HUB = process.env.MX_HUB ?? "http://127.0.0.1:4021";
const UNISWAP_V3_ETHEREUM = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";

const line = (label: string, r: CallResult) =>
  console.log(`\n${label}: HTTP ${r.status}, ${r.paid ? `paid ${r.receipt?.metered_units} ${r.receipt?.unit} = ${r.receipt?.amount} ${r.receipt?.currency}, tx ${r.receipt?.transaction_id}` : "nothing paid"}`);

async function main() {
  const accountId = process.env.BUYER_ACCOUNT_ID, privateKey = process.env.BUYER_PRIVATE_KEY;
  if (!accountId || !privateKey) throw new Error("set BUYER_ACCOUNT_ID and BUYER_PRIVATE_KEY");
  const mx = new MeterX402({ wallet: { accountId, privateKey }, registry: HUB, budget: "0.5 HBAR" });

  const lending = await mx.call("lending-markets", { path: "/markets", method: "GET", query: { tokens: "USDC", sort: "supply_apy", first: "5", min_tvl: "1000000" }, maxUnits: 5 });
  line("lending-markets, USDC by supply APY", lending);
  const ld = lending.data as any;
  for (const m of ld?.markets ?? []) console.log(`   ${m.protocol}/${m.chain} ${m.token}: supply ${m.supply_apy_percent}%, borrow ${m.borrow_apy_percent}%, deposits $${Math.round(m.deposits_usd).toLocaleString("en-US")}`);
  console.log(`   ${ld?.summary ?? ""}`);

  const query = `{ pools(first: 3, orderBy: totalValueLockedUSD, orderDirection: desc, where: { totalValueLockedUSD_lt: "5000000000" }) { id feeTier token0 { symbol } token1 { symbol } } }`;
  const sg = await mx.call("subgraph-gateway", { path: `/subgraphs/${UNISWAP_V3_ETHEREUM}`, method: "POST", body: { query }, maxUnits: 50 });
  line("subgraph-gateway, any GraphQL", sg);
  console.log(`   ${(sg.data as any)?.entities} entities: ${JSON.stringify((sg.data as any)?.data).slice(0, 200)}`);

  const bad = await mx.call("subgraph-gateway", { path: `/subgraphs/${UNISWAP_V3_ETHEREUM}`, method: "POST", body: { query: "{ notAField { id } }" } });
  line("subgraph-gateway, a query that errors", bad);
  console.log(`   ${String((bad.data as any)?.errors?.[0]?.message ?? "").slice(0, 120)}`);

  const pools = await mx.call("dex-pools", { path: "/pools", method: "GET", query: { tokens: "USDC,ETH", chains: "base,optimism,avalanche,arbitrum", first: "6", min_tvl: "100000" }, maxUnits: 6 });
  line("dex-pools on chains with fallbacks", pools);
  const pd = pools.data as any;
  for (const s of pd?.sources ?? []) console.log(`   ${s.ok ? "ok  " : "down"} ${`${s.protocol}/${s.chain}`.padEnd(22)} ${(s.via ?? "").padEnd(8)} ${s.schema.padEnd(20)} rows ${s.rows} ${String(s.primary_error ?? s.error ?? "").slice(0, 60)}`);
  for (const p of pd?.pools ?? []) console.log(`   ${p.protocol}/${p.chain} ${p.tokens.join("/")} ${p.fee_percent}%: TVL $${Math.round(p.tvl_usd).toLocaleString("en-US")}, fee APR ${p.fee_apr_percent}%`);
  console.log(`   ${pd?.summary ?? ""}`);

  console.log(`\nspent ${mx.spent} HBAR in this run`);
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
