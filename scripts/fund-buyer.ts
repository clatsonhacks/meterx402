// Top the demo buyer up from the operator account.
//
//   npx tsx scripts/fund-buyer.ts [--hbar 5] [--to 0.0.x]
//
// Every live demo spends real testnet HBAR, and a buyer that runs dry fails in
// the least interesting way possible: mid-payment, in front of an audience.
// This tops it up from HEDERA_ACCOUNT_ID, which is the account that created it
// in the first place (scripts/new-buyer.ts).

import { loadEnv } from "../src/env.ts";
import { hederaEnabled, hederaTransfer, lookupAccount } from "../src/hedera.ts";

loadEnv();

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const hbar = Number(flag("hbar", "5"));
const to = flag("to", process.env.BUYER_ACCOUNT_ID);

if (!hederaEnabled()) { console.error("set HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY in .env (the operator pays)"); process.exit(1); }
if (!to) { console.error("no target: set BUYER_ACCOUNT_ID in .env or pass --to 0.0.x"); process.exit(1); }
if (!Number.isFinite(hbar) || hbar <= 0) { console.error("--hbar must be a positive number"); process.exit(1); }

const before = await lookupAccount(to);
const operator = await lookupAccount(process.env.HEDERA_ACCOUNT_ID!);
console.log(`operator ${process.env.HEDERA_ACCOUNT_ID} has ${operator?.balance ?? "?"} HBAR`);
if (operator && operator.balance < hbar + 1) {
  console.error(`the operator only holds ${operator.balance} HBAR: fund it at https://portal.hedera.com first`);
  process.exit(1);
}

console.log(`sending ${hbar} HBAR → ${to} (was ${before?.balance ?? "unknown"})…`);
const r = await hederaTransfer(to, hbar);
console.log(`✓ ${r.hashscan}`);

for (let i = 0; i < 10; i++) {
  await new Promise((res) => setTimeout(res, 1200));
  const after = await lookupAccount(to);
  if (after && (!before || after.balance > before.balance)) {
    console.log(`${to} now holds ${after.balance} HBAR`);
    process.exit(0);
  }
}
console.log("sent; the mirror node had not caught up yet");
