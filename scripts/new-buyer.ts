// Create a funded testnet BUYER account with the operator, and append it to .env.
// The buyer must be a different account from the tab spender: Hedera rejects an
// allowance granted to yourself.
//   npx tsx scripts/new-buyer.ts [hbar]
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { loadEnv, ROOT } from "../src/env.ts";
import { initHedera, hederaEnabled, lookupAccount } from "../src/hedera.ts";

loadEnv();
if (!hederaEnabled()) { console.error("set HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY in .env first"); process.exit(1); }
const envPath = resolve(ROOT, ".env");
if (/^BUYER_ACCOUNT_ID=\S/m.test(readFileSync(envPath, "utf8"))) {
  console.log("BUYER_ACCOUNT_ID is already set in .env; nothing to do.");
  process.exit(0);
}
const hbar = Number(process.argv[2] ?? 5);
const client = initHedera();
const key = PrivateKey.generateECDSA();
const tx = await new AccountCreateTransaction().setKeyWithoutAlias(key.publicKey).setInitialBalance(new Hbar(hbar)).execute(client);
const accountId = (await tx.getReceipt(client)).accountId!.toString();
appendFileSync(envPath, `\n# buyer wallet created by scripts/new-buyer.ts on ${new Date().toISOString().slice(0, 10)}\nBUYER_ACCOUNT_ID=${accountId}\nBUYER_PRIVATE_KEY=${key.toStringDer()}\n`);
const acct = await lookupAccount(accountId);
console.log(`created buyer ${accountId} with ${hbar} HBAR (key written to .env, not printed)`);
console.log(`mirror node says: ${acct ? acct.balance + " HBAR" : "not visible yet"}  https://hashscan.io/testnet/account/${accountId}`);
client.close();
