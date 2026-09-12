// A quote round against the live registry.
//
//   npm run demo                      # in another terminal
//   npx tsx scripts/live-rfq.ts [--binding]
//
// The agent states a job and a ceiling instead of picking a service. Every live
// seller with that capability answers at once, the losers are part of the
// record, and the reason the winner won is written down.
//
// To make that a real contest rather than a walkover, this script first stands
// up two rival weather sellers at different prices next to the one the demo
// already runs.

import { loadEnv } from "../src/env.ts";
import { MeterX402Agent } from "../src/sdk/agent.ts";
import { wrap } from "../src/sdk/seller.ts";

loadEnv();
const HUB = process.env.MX_HUB ?? "http://127.0.0.1:4021";
const binding = process.argv.includes("--binding");
const wallet = { accountId: process.env.BUYER_ACCOUNT_ID!, privateKey: process.env.BUYER_PRIVATE_KEY! };
const payTo = process.env.WALLET!;
if (!wallet.accountId || !wallet.privateKey) { console.error("set BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY in .env"); process.exit(2); }

const line = (s = "") => console.log(s);
const h = (s: string) => line(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`);

h("0 · Two rivals join the market");
const rivals = [];
for (const [name, rate, port] of [["weather-budget", "0.00005", 4101], ["weather-premium", "0.0004", 4102]] as const) {
  rivals.push(await wrap({
    upstream: "https://api.open-meteo.com/v1/forecast",
    sample: "/?latitude=13.0827&longitude=80.2707&hourly=temperature_2m&forecast_days=1",
    wallet: payTo, rate, meter: "rows:hourly.time", name,
    description: `Hourly forecasts at ${rate} HBAR per hour of forecast.`,
    capabilities: ["weather_forecast"], port, registry: HUB, quiet: true,
  }));
  line(`${name.padEnd(18)} ${rate} HBAR / row`);
}
line("waiting for the registry to probe them…");
await new Promise((r) => setTimeout(r, 12_000));

const agent = new MeterX402Agent({ wallet, budget: "1 HBAR", registry: HUB });

for (const [capability, maxUnits, ceiling] of [["weather_forecast", 24, "0.05"], ["text_generation", 500, "0.01"]] as const) {
  h(`Round: ${capability}, at most ${maxUnits} units for ${ceiling} HBAR`);
  const round = await agent.rfq({ capability, maxUnits, maxPrice: ceiling, binding, top: 2 });
  for (const o of round.offers) {
    const mark = o.service_id === round.winner ? "★" : o.status === "offered" ? " " : "✗";
    const price = o.est_amount == null ? "no price" : `${o.est_amount} ${o.currency}`;
    const rep = o.reputation == null ? "unrated" : `rep ${o.reputation}`;
    line(` ${mark} ${o.service_id.padEnd(18)} ${price.padEnd(16)} ${rep.padEnd(10)} rank ${String(o.rank).padEnd(6)}${o.quote ? "binding " : ""}${o.reason ? `— ${o.reason}` : ""}`);
  }
  line(`why: ${round.why}`);
  if (round.winner) {
    const r = await round.accept();
    line(`bought from ${r.service}: paid ${r.receipt?.amount ?? "0"} ${r.receipt?.currency ?? ""} for ${r.receipt?.metered_units} ${r.receipt?.unit}`);
  }
}

h("A ceiling nobody can meet");
const tight = await agent.rfq({ capability: "weather_forecast", maxUnits: 24, maxPrice: "0.0000001" });
line(`winner: ${tight.winner ?? "none"} — ${tight.why}`);
for (const o of tight.offers.slice(0, 3)) line(`   ${o.service_id.padEnd(18)} ${o.status.padEnd(12)} ${o.reason ?? ""}`);

h("What the rounds left behind");
for (const id of ["weather", "weather-budget", "weather-premium", "llm"]) {
  const rec = await fetch(`${HUB}/registry/services/${id}/reputation`).then((r) => r.json() as any).catch(() => null);
  const s = rec?.stats;
  if (s) line(`${id.padEnd(18)} asked ${s.quote_rounds ?? 0}, answered ${s.quotes_offered ?? 0}, won ${s.quote_rounds_won ?? 0}`);
}

for (const r of rivals) await r.close();
process.exit(0);
