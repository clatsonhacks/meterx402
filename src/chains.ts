// Chain presets: one flag picks where a lane settles (carried over from
// GlassBox402's x402ify). Each preset is a facilitator + scheme + network id +
// how to express an exact atomic amount as an x402 price.
//
// Hedera is the tested path. The EVM / Solana presets need their optional
// @x402 package installed (npm i @x402/evm or @x402/svm).

import type { Price, SchemeNetworkServer } from "@x402/core/types";
import { fromAtomic } from "./pricing.ts";

export interface ChainPreset {
  name: string;
  network: `${string}:${string}`;
  facilitator: string;
  register: `${string}:${string}`;
  decimals: number;   // atomic units of the settlement asset
  currency: string;   // what `rate` is denominated in
  explorer: "hashscan-testnet" | "hashscan-mainnet" | "basescan" | "basescan-sepolia" | "solscan";
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
    explorer: "basescan",
    load: async () => (await import(/* optional */ "@x402/evm/exact/server" as string)).ExactEvmScheme,
    price: usdc,
  },
  solana: {
    name: "solana",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    facilitator: "https://x402.org/facilitator",
    register: "solana:*",
    decimals: 6,
    currency: "USDC",
    explorer: "solscan",
    load: async () => (await import(/* optional */ "@x402/svm/exact/server" as string)).ExactSvmScheme,
    price: usdc,
  },
};

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
  }
}
