// Testnet wallets for the EVM (Base Sepolia) and Solana (devnet) payment paths.
//
//   npx tsx scripts/new-chain-wallets.ts
//
// Creates a buyer and a seller payout wallet on each chain and appends the
// keys to .env, never overwriting a key that is already there. Prints only
// addresses. Fund the BUYER addresses with testnet USDC from
// https://faucet.circle.com (Base Sepolia and Solana Devnet). The x402.org
// facilitator pays gas on both, so buyers need no ETH or SOL.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getBase58Decoder } from "@solana/kit";
import { ROOT } from "../src/env.ts";

const envPath = resolve(ROOT, ".env");
const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const has = (k: string) => new RegExp(`^\\s*${k}\\s*=`, "m").test(env);

function solanaKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const b58 = getBase58Decoder();
  return { secret: b58.decode(new Uint8Array([...priv, ...pub])), address: b58.decode(new Uint8Array(pub)) };
}

const lines: string[] = [];
const report: string[] = [];

for (const role of ["BUYER", "SELLER"] as const) {
  const keyVar = `${role}_EVM_PRIVATE_KEY`;
  if (!has(keyVar)) {
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    lines.push(`${keyVar}=${pk}`);
    if (role === "SELLER" && !has("WALLET_EVM")) lines.push(`WALLET_EVM=${address}`);
    if (role === "BUYER" && !has("BUYER_EVM_ADDRESS")) lines.push(`BUYER_EVM_ADDRESS=${address}`);
    report.push(`${role.toLowerCase()} evm     ${address}`);
  } else report.push(`${role.toLowerCase()} evm     (already in .env)`);

  const solVar = `${role}_SOLANA_SECRET_KEY`;
  if (!has(solVar)) {
    const kp = solanaKeypair();
    lines.push(`${solVar}=${kp.secret}`);
    if (role === "SELLER" && !has("WALLET_SOLANA")) lines.push(`WALLET_SOLANA=${kp.address}`);
    if (role === "BUYER" && !has("BUYER_SOLANA_ADDRESS")) lines.push(`BUYER_SOLANA_ADDRESS=${kp.address}`);
    report.push(`${role.toLowerCase()} solana  ${kp.address}`);
  } else report.push(`${role.toLowerCase()} solana  (already in .env)`);
}

if (lines.length) {
  appendFileSync(envPath, `${env.endsWith("\n") || !env ? "" : "\n"}\n# EVM + Solana testnet wallets (scripts/new-chain-wallets.ts)\n${lines.join("\n")}\n`);
}
console.log(report.join("\n"));
console.log(lines.length ? `\nwrote ${lines.length} entries to .env (keys not printed)` : "\nnothing to do: every key is already in .env");
console.log("fund the buyer addresses with testnet USDC: https://faucet.circle.com (Base Sepolia, Solana Devnet)");
