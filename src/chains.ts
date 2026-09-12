// Chain presets: one flag picks where a lane settles (carried over from
// GlassBox402's x402ify). Each preset is a facilitator + scheme + network id +
// how to express an exact atomic amount as an x402 price.
//
// Hedera is the tested path. The EVM / Solana presets need their optional
// @x402 package installed (npm i @x402/evm or @x402/svm).

import type { Price, SchemeNetworkServer } from "@x402/core/types";
import { fromAtomic } from "./pricing.ts";

export interface AssetFee {
  percent: string;
  collector: string;
  assessment: "inclusive" | "exclusive";
  source: "hts-custom-fee";
}

export interface ChainPreset {
  name: string;
  network: `${string}:${string}`;
  facilitator: string;
  register: `${string}:${string}`;
  decimals: number;   // atomic units of the settlement asset
  currency: string;   // what `rate` is denominated in
  asset: string;      // "0.0.0" = native HBAR, else an HTS token id / ERC-20
  /** Present when the ledger itself takes a cut of every transfer. */
  fee?: AssetFee;
  explorer: "hashscan-testnet" | "hashscan-mainnet" | "basescan" | "basescan-sepolia" | "solscan" | "solscan-devnet";
  load(): Promise<new () => SchemeNetworkServer>;
  price(atomic: bigint): Price;
}

const usdc = (atomic: bigint): Price => `$${fromAtomic(atomic, 6)}`;

export const CHAINS: Record<string, ChainPreset> = {
  hedera: {
    name: "hedera",
    network: "hedera:testnet",
    facilitator: "https://api.testnet.blocky402.com",
    register: "hedera:*",
    decimals: 8, // tinybar
    currency: "HBAR",
    asset: "0.0.0",
    explorer: "hashscan-testnet",
    load: async () => (await import("@x402/hedera/exact/server")).ExactHederaScheme as any,
    price: (atomic) => ({ amount: atomic.toString(), asset: "0.0.0" }), // native HBAR
  },
  "base-sepolia": {
    name: "base-sepolia",
    network: "eip155:84532",
    facilitator: "https://x402.org/facilitator",
    register: "eip155:*",
    decimals: 6,
    currency: "USDC",
    asset: "USDC",
    explorer: "basescan-sepolia",
    load: async () => (await import(/* optional */ "@x402/evm/exact/server" as string)).ExactEvmScheme,
    price: usdc,
  },
  base: {
    name: "base",
    network: "eip155:8453",
    facilitator: "https://x402.org/facilitator",
    register: "eip155:*",
    decimals: 6,
    currency: "USDC",
    asset: "USDC",
    explorer: "basescan",
    load: async () => (await import(/* optional */ "@x402/evm/exact/server" as string)).ExactEvmScheme,
    price: usdc,
  },
  "solana-devnet": {
    name: "solana-devnet",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    facilitator: "https://x402.org/facilitator",
    register: "solana:*",
    decimals: 6,
    currency: "USDC",
    asset: "USDC",
    explorer: "solscan-devnet",
    load: async () => (await import(/* optional */ "@x402/svm/exact/server" as string)).ExactSvmScheme,
    price: usdc,
  },
  solana: {
    name: "solana",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    facilitator: "https://x402.org/facilitator",
    register: "solana:*",
    decimals: 6,
    currency: "USDC",
    asset: "USDC",
    explorer: "solscan",
    load: async () => (await import(/* optional */ "@x402/svm/exact/server" as string)).ExactSvmScheme,
    price: usdc,
  },
};

/** The USDC each non-Hedera network settles in: what a buyer agrees to sign
 *  a transfer of without an explicit opt-in. */
export const USDC: Record<string, string> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "EPjFWdd5AufqyNpD6XpN3fhbZtjHsMXNpVCpWdpHXqYf",
};

/** Settlement decimals by network family: tinybar on Hedera, USDC elsewhere. */
export const decimalsFor = (network: string) => (network.startsWith("hedera:") ? 8 : 6);

/** Settle in an HTS token instead of HBAR.
 *
 * Everything about the payment path is unchanged: the same exact scheme, the
 * same facilitator, the same signature. Only the asset moves. The token's
 * decimals, symbol and fee schedule are read off the mirror node rather than
 * configured, so a price of "0.01" always means 0.01 of whatever the token
 * actually is, and the fee we advertise is the fee the ledger will really take.
 */
export async function hederaTokenPreset(tokenId: string, base: ChainPreset = CHAINS.hedera, network?: string): Promise<ChainPreset> {
  const { MIRROR } = await import("./hedera.ts");
  const r = await fetch(`${MIRROR()}/tokens/${tokenId}`);
  if (!r.ok) throw new Error(`token ${tokenId} not found on the mirror node (${r.status})`);
  const t = (await r.json()) as any;
  const decimals = Number(t.decimals ?? 0);
  if (!Number.isFinite(decimals)) throw new Error(`token ${tokenId} has no decimals`);
  const frac = t.custom_fees?.fractional_fees?.[0];
  const fee: AssetFee | undefined = frac
    ? {
        percent: plainPercent(Number(frac.amount?.numerator ?? 0), Number(frac.amount?.denominator ?? 1)),
        collector: String(frac.collector_account_id ?? ""),
        assessment: frac.net_of_transfers ? "exclusive" : "inclusive",
        source: "hts-custom-fee",
      }
    : undefined;
  return {
    ...base,
    name: `${base.name}-hts`,
    network: (network as `${string}:${string}`) ?? base.network,
    decimals,
    currency: String(t.symbol ?? tokenId),
    asset: tokenId,
    fee,
    price: (atomic) => ({ amount: atomic.toString(), asset: tokenId }),
  };
}

/** 200/10000 → "2", 25/10000 → "0.25". */
function plainPercent(numerator: number, denominator: number): string {
  if (!denominator) return "0";
  const pct = (numerator / denominator) * 100;
  return String(Number(pct.toFixed(6)));
}

export function explorerTx(preset: Pick<ChainPreset, "explorer">, tx: string): string | null {
  if (!tx) return null;
  switch (preset.explorer) {
    case "hashscan-testnet":
    case "hashscan-mainnet": {
      const net = preset.explorer === "hashscan-mainnet" ? "mainnet" : "testnet";
      return `https://hashscan.io/${net}/transaction/${tx.replace("@", "-").replace(/\.(\d+)$/, "-$1")}`;
    }
    case "basescan": return `https://basescan.org/tx/${tx}`;
    case "basescan-sepolia": return `https://sepolia.basescan.org/tx/${tx}`;
    case "solscan": return `https://solscan.io/tx/${tx}`;
    case "solscan-devnet": return `https://solscan.io/tx/${tx}?cluster=devnet`;
  }
}
