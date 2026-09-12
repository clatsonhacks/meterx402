// A subscription lane, live on Hedera testnet.
//
//   npx tsx scripts/live-subscription.ts [--period 70] [--periods 2]
//
// The buyer signs every future payment up front as a scheduled transaction.
// Nothing is deposited, nobody holds a key, and the seller can count the
// revenue before it lands — which an allowance can never show, because an
// allowance is only permission and can be revoked at any moment.
//
// Watch for: consensus executing the first payment with nobody online, the
// seller's committed total falling as it does, and the buyer cancelling a
// period that has not run.

import { loadEnv } from "../src/env.ts";
import { wrap } from "../src/sdk/seller.ts";
import { MeterX402 } from "../src/sdk/buyer.ts";
import { readSchedule } from "../src/subscriptions.ts";
import { lookupAccount } from "../src/hedera.ts";

loadEnv();
const flag = (n: string, d: number) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const periodSec = flag("period", 70);
const periods = flag("periods", 2);
const price = "0.05";

const wallet = { accountId: process.env.BUYER_ACCOUNT_ID!, privateKey: process.env.BUYER_PRIVATE_KEY! };
const payTo = process.env.WALLET!;
if (!wallet.accountId || !wallet.privateKey || !payTo) { console.error("set BUYER_ACCOUNT_ID, BUYER_PRIVATE_KEY and WALLET in .env"); process.exit(2); }

const line = (s = "") => console.log(s);
const h = (s: string) => line(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`);
const clock = (t: number) => new Date(t).toISOString().slice(11, 19);

h("1 · A lane that sells by the period");
const svc = await wrap({
  upstream: "https://api.open-meteo.com/v1/forecast",
  sample: "/?latitude=13.0827&longitude=80.2707&hourly=temperature_2m&forecast_days=1",
  wallet: payTo,
  rate: "0.0001",
  meter: "rows:hourly.time",
  name: "weather-subscription",
  description: "Hourly forecasts, by subscription.",
  capabilities: ["weather_forecast"],
  subscription: { price, periodSec, maxPeriods: 6, includesUnits: 50 },
  port: 4099,
  registry: null,
  quiet: true,
});
const terms = svc.descriptor.payment.subscription!;
line(`${svc.url}`);
line(`terms    ${terms.price} HBAR per ${terms.period_sec}s period · ${terms.includes_units} units included · up to ${terms.max_periods} periods`);
line(`pay-per-call is still there: ${svc.descriptor.pricing.rate} HBAR / ${svc.descriptor.pricing.unit}`);

h("2 · The buyer commits to the future payments");
const sellerBefore = (await lookupAccount(payTo))?.balance ?? 0;
const mx = new MeterX402({ wallet, budget: "5 HBAR" });
const sub = await mx.subscribe(svc.descriptor, { periods });
line(`subscription ${sub.subscription}`);
for (const p of sub.periods) line(`  schedule ${p.schedule_id}  due ${clock(p.due_at)}  ${Number(p.amount_atomic) / 1e8} HBAR   https://hashscan.io/testnet/schedule/${p.schedule_id}`);
line(`committed to the seller: ${sub.committed} HBAR, signed and on the ledger before a single call`);

h("3 · Calls inside the period cost nothing extra");
for (let i = 1; i <= 2; i++) {
  const r = await sub.call({ query: { forecast_days: "1" } });
  const rc = r.receipt;
  line(`call ${i}  ${r.status}  metered ${rc?.metered_units ?? "?"} ${svc.descriptor.pricing.unit} · charged ${rc?.amount ?? "?"} HBAR · scheme ${rc?.scheme ?? "?"} (${rc?.subscription_id ? "covered by the subscription" : "paid per call"})`);
}

h("4 · What the seller can count");
const book = await fetch(`${svc.url}/.well-known/mx402/subscriptions`).then((r) => r.json() as any);
line(`committed ${book.committed} HBAR across ${book.periodsAhead} unexecuted periods, ${book.subscribers} subscriber(s)`);

h("5 · Consensus executes the first payment, unattended");
const first = sub.periods[0];
const waitFor = Math.max(0, first.due_at - Date.now()) + 15_000;
line(`waiting ${Math.round(waitFor / 1000)}s for ${clock(first.due_at)} — nothing of ours runs in the meantime`);
let executed: number | null = null;
for (const end = Date.now() + waitFor + 30_000; Date.now() < end;) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await readSchedule(first.schedule_id).catch(() => null);
  if (s?.executed_at) { executed = s.executed_at; break; }
  process.stdout.write(".");
}
line();
if (executed) {
  line(`executed at ${clock(executed)} — ${((executed - first.due_at) / 1000).toFixed(1)}s after it was due`);
  const after = (await lookupAccount(payTo))?.balance ?? 0;
  line(`seller balance ${sellerBefore} → ${after} HBAR  (+${(after - sellerBefore).toFixed(4)})`);
} else {
  line("it had not executed yet when this script gave up; the schedule is still on the ledger");
}

h("6 · The buyer cancels what has not run");
const last = sub.periods[sub.periods.length - 1];
const cancelled = await sub.cancel(last.schedule_id);
line(`cancel ${last.schedule_id}: ${cancelled.ok ? "✓ removed from the ledger" : `✗ ${cancelled.error}`}`);
const after = await fetch(`${svc.url}/.well-known/mx402/subscriptions`).then((r) => r.json() as any);
line(`committed now ${after.committed} HBAR across ${after.periodsAhead} periods`);

await svc.close();
process.exit(0);
