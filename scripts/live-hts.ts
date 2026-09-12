// Settle a metered call in an HTS token, and let the LEDGER take the protocol
// fee. Live on Hedera testnet.
//
//   npx tsx scripts/new-token.ts        # once: creates MXC + accounts
//   npx tsx scripts/live-hts.ts         # then: sells an API in credits and pays for it
//
// What this demonstrates, end to end:
//   · the same exact x402 scheme, the same facilitator, a different asset
//   · a price of "0.01" means 0.01 MXC, with the token's own decimals
//   · consensus assesses the token's 2% fractional fee on the transfer and
//     routes it to the treasury — there is no fee-collection code in this repo
//   · the buyer signs exactly the quoted amount; the seller nets the remainder,
//     which the receipt and the mirror node both state plainly

import { loadEnv } from "../src/env.ts";
import { wrap } from "../src/sdk/seller.ts";
import { MeterX402 } from "../src/sdk/buyer.ts";
import { mirrorTransfer, MIRROR } from "../src/hedera.ts";
import { hashscanTx } from "../src/events.ts";
import { hederaTokenPreset } from "../src/chains.ts";

loadEnv();

const token = process.env.MX_TOKEN_ID;
const seller = process.env.MX_TOKEN_SELLER;
const wallet = { accountId: process.env.BUYER_ACCOUNT_ID!, privateKey: process.env.BUYER_PRIVATE_KEY! };
if (!token || !seller) { console.error("run `npx tsx scripts/new-token.ts` first, then put MX_TOKEN_ID / MX_TOKEN_SELLER in .env"); process.exit(2); }
if (!wallet.accountId || !wallet.privateKey) { console.error("set BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY in .env"); process.exit(2); }

const line = (s = "") => console.log(s);
const h = (s: string) => line(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`);
const bal = async (account: string) => {
  const r = await fetch(`${MIRROR()}/accounts/${account}/tokens?token.id=${token}`).then((x) => x.json() as any).catch(() => null);
  return BigInt(r?.tokens?.[0]?.balance ?? 0);
};

h("0 · The token and its fee schedule");
const preset = await hederaTokenPreset(token);
line(`${preset.currency} ${token} · ${preset.decimals} decimals`);
line(preset.fee
  ? `fee schedule: ${preset.fee.percent}% ${preset.fee.assessment}, collected by ${preset.fee.collector} — enforced by consensus, not by us`
  : "no custom fee on this token");
const scale = 10 ** preset.decimals;
const show = (atomic: bigint | string) => `${Number(atomic) / scale} ${preset.currency}`;

h("1 · Sell an API priced in credits");
const svc = await wrap({
  upstream: "https://api.open-meteo.com/v1/forecast",
  sample: "/?latitude=13.0827&longitude=80.2707&hourly=temperature_2m&forecast_days=1",
  wallet: seller,
  asset: token,
  rate: "0.01",              // 0.01 MXC per forecast hour
  meter: "rows:hourly.time",
  name: "weather-credits",
  description: "Hourly forecasts, priced in MeterX402 credits.",
  capabilities: ["weather_forecast"],
  port: 4097,
  registry: null,            // standalone: this script is the whole demo
  quiet: true,
});
const accepts = svc.descriptor.payment.settlement[0];
line(`weather-credits on ${svc.url}`);
line(`accepts ${accepts.currency} (${accepts.asset}) on ${accepts.network}, scheme ${accepts.schemes.join(" + ")}`);
line(accepts.fee ? `discloses a ${accepts.fee.percent}% ${accepts.fee.assessment} ledger fee to ${accepts.fee.collector}` : "discloses no ledger fee");

h("2 · Buy it");
const before = { buyer: await bal(wallet.accountId), seller: await bal(seller), treasury: await bal(preset.fee!.collector) };
line(`before   buyer ${show(before.buyer)} · seller ${show(before.seller)} · treasury ${show(before.treasury)}`);

const mx = new MeterX402({ wallet, budget: "100 MXC", assets: [token] });  // opt in to paying in this token
const q = await mx.quote(svc.descriptor, {});
if (!("pay" in q)) { console.error("nothing billable"); process.exit(1); }
line(`quote    ${q.quote.units} ${q.quote.unit} → ${q.quote.amount} ${q.quote.currency}  (${q.quote.amount_atomic} atomic)`);
const r = await q.pay();
line(`paid     ${r.receipt!.amount} ${r.receipt!.currency}  tx ${hashscanTx(r.receipt!.transaction_id!)}`);
line(`verify   body hash ${r.verification!.bodyHash ? "✓" : "✗"} · re-metered ${r.verification!.remetered} ${q.quote.unit} ${r.verification!.unitsMatch ? "✓" : "✗"}`);

h("3 · What the ledger did with it");
const onChain = await mirrorTransfer(r.receipt!.transaction_id!, seller, token);
const fees = onChain.assessedFees ?? [];
line(`mirror   ${onChain.result}`);
line(`         buyer signed for ${show(r.receipt!.amount_atomic)}`);
line(`         seller credited  ${show(onChain.tinybar)}`);
for (const f of fees) line(`         fee ${show(f.amount)} → ${f.collector}   (assessed by consensus)`);
const after = { buyer: await bal(wallet.accountId), seller: await bal(seller), treasury: await bal(preset.fee!.collector) };
line(`after    buyer ${show(after.buyer)} · seller ${show(after.seller)} · treasury ${show(after.treasury)}`);

const paid = before.buyer - after.buyer;
const got = after.seller - before.seller;
const cut = after.treasury - before.treasury;
h("4 · The sum");
line(`buyer paid       ${show(paid)}   (exactly the quote: ${String(paid) === r.receipt!.amount_atomic ? "✓" : "✗"})`);
line(`seller received  ${show(got)}`);
line(`treasury took    ${show(cut)}   (${cut > 0n ? ((Number(cut) / Number(paid)) * 100).toFixed(2) + "%" : "0%"} of the payment)`);
line(`accounted for    ${got + cut === paid ? "✓ every unit" : `✗ ${show(paid - got - cut)} unaccounted`}`);

await svc.close();
process.exit(0);
