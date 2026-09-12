// Rotate buyer account - creates new one and updates .env
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { loadEnv, ROOT } from "../src/env.ts";
import { initHedera, hederaEnabled, lookupAccount } from "../src/hedera.ts";

loadEnv();
if (!hederaEnabled()) {
  console.error("set HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY in .env first");
  process.exit(1);
}

const envPath = resolve(ROOT, ".env");
const hbar = Number(process.argv[2] ?? 5);
const client = initHedera();

console.log("Creating new buyer account...");
const key = PrivateKey.generateECDSA();
const tx = await new AccountCreateTransaction()
  .setKeyWithoutAlias(key.publicKey)
  .setInitialBalance(new Hbar(hbar))
  .execute(client);

const accountId = (await tx.getReceipt(client)).accountId!.toString();

// Read .env and replace old BUYER credentials
let envContent = readFileSync(envPath, "utf8");
envContent = envContent.replace(/^BUYER_ACCOUNT_ID=.*/gm, `BUYER_ACCOUNT_ID=${accountId}`);
envContent = envContent.replace(/^BUYER_PRIVATE_KEY=.*/gm, `BUYER_PRIVATE_KEY=${key.toStringDer()}`);
writeFileSync(envPath, envContent);

const acct = await lookupAccount(accountId);
console.log(`✅ Rotated to new buyer: ${accountId}`);
console.log(`   Balance: ${hbar} HBAR`);
console.log(`   https://hashscan.io/testnet/account/${accountId}`);
console.log(`\n🔑 New credentials written to .env`);
console.log(`   BUYER_ACCOUNT_ID=${accountId}`);
console.log(`   BUYER_PRIVATE_KEY=${key.toStringDer()}`);
client.close();
