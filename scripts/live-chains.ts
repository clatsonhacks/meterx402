// Pay for metered calls from an EVM wallet (Base Sepolia) and a Solana wallet
// (devnet), through the same MeterX402 SDK and gateways as Hedera.
//
//   npm run demo                         (in another terminal)
//   npx tsx scripts/new-chain-wallets.ts (once; then fund the buyers at https://faucet.circle.com)
//   npx tsx scripts/live-chains.ts
//
// For each chain: read the gateway's 402 challenge, quote the exact metered
// price, pay it (the buyer signs; the x402.org facilitator pays gas), then
// check the transfer on the chain itself.

import { decodePaymentRequiredHeader } from "@x402/core/http";
import { loadEnv } from "../src/env.ts";
import { MeterX402 } from "../src/sdk/buyer.ts";
import { explorerTx, CHAINS } from "../src/chains.ts";

loadEnv();
const HUB = process.env.MX_HUB ?? "http://127.0.0.1:4021";

const cases = [
  { service: "weather-solana", preset: CHAINS["solana-devnet"], key: process.env.BUYER_SOLANA_SECRET_KEY, probe: "http://127.0.0.1:4134/?latitude=13.08&longitude=80.27&hourly=temperature_2m&forecast_days=1" },
  { service: "dex-pools-base", preset: CHAINS["base-sepolia"], key: process.env.BUYER_EVM_PRIVATE_KEY, probe: "http://127.0.0.1:4132/pools?tokens=USDC,ETH&first=3" },
];

async function main() {
  let failures = 0;
  for (const c of cases) {
    console.log(`\n── ${c.service} (${c.preset.network})`);
    if (!c.key) { console.log("   no buyer key: run scripts/new-chain-wallets.ts"); failures++; continue; }

    const first = await fetch(c.probe).catch(() => null);
    const header = first?.headers.get("payment-required");
    if (first?.status !== 402 || !header) { console.log(`   gateway did not challenge (status ${first?.status ?? "unreachable"}): is npm run demo up?`); failures++; continue; }
    const accept = decodePaymentRequiredHeader(header).accepts[0];
    console.log(`   402 → ${accept.amount} atomic of ${accept.asset} to ${accept.payTo} on ${accept.network}`);

    const mx = new MeterX402({ wallet: { privateKey: c.key, network: c.preset.network }, registry: HUB, budget: "0.05 USDC" });
    try {
      const q = await mx.quote(c.service, {});
      if (!("pay" in q)) { console.log("   served free"); continue; }
      console.log(`   quote ${q.quote.units} ${q.quote.unit} = ${q.quote.amount} ${q.quote.currency}`);
      const r = await q.pay();
      console.log(`   buyer ${mx.accountId}: HTTP ${r.status}, paid ${r.paid}`);
      if (r.receipt?.transaction_id) console.log(`   tx ${explorerTx(c.preset, r.receipt.transaction_id) ?? r.receipt.transaction_id}`);
      if (r.verification) console.log(`   verified: ${JSON.stringify(r.verification).slice(0, 200)}`);
      if (!r.paid) { failures++; console.log(`   body: ${JSON.stringify(r.data).slice(0, 200)}`); }
    } catch (e) {
      failures++;
      console.log(`   buyer ${mx.accountId || "(unsigned)"}: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 240)}`);
    }
  }
  process.exit(failures ? 1 : 0);
}
main();
