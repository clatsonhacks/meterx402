// Independent checks for EVM and Solana settlements.
//
// The facilitator says "settled"; the buyer should not have to take its word.
// On Hedera we read the transfer off the mirror node. Here we do the same with
// a public RPC: find the transaction, confirm it succeeded, and add up the USDC
// that actually reached the seller.

import { USDC } from "../chains.ts";
import type { Verification } from "./adapter.ts";

const EVM_RPC: Record<string, string> = {
  "eip155:84532": "https://sepolia.base.org",
  "eip155:8453": "https://mainnet.base.org",
};
const SOLANA_RPC: Record<string, string> = {
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "https://api.devnet.solana.com",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "https://api.mainnet-beta.solana.com",
};
/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpc(url: string, method: string, params: unknown[], f: typeof fetch = fetch): Promise<any> {
  const r = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  return j.result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** USDC atomic units a receipt's Transfer logs credit to `payTo`. Pure. */
export function evmCredited(receipt: any, payTo: string, token?: string): bigint {
  const to = "0x" + payTo.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return (receipt?.logs ?? [])
    .filter((l: any) => l.topics?.[0] === ERC20_TRANSFER && String(l.topics?.[2]).toLowerCase() === to && (!token || String(l.address).toLowerCase() === token.toLowerCase()))
    .reduce((s: bigint, l: any) => s + BigInt(l.data), 0n);
}

/** Change in `owner`'s balance of `mint` across a parsed Solana transaction. Pure. */
export function solanaCredited(tx: any, owner: string, mint?: string): bigint {
  const sum = (list: any[] | undefined): bigint => (list ?? [])
    .filter((b: any) => b.owner === owner && (!mint || b.mint === mint))
    .reduce<bigint>((s, b: any) => s + BigInt(b.uiTokenAmount?.amount ?? 0), 0n);
  return sum(tx?.meta?.postTokenBalances) - sum(tx?.meta?.preTokenBalances);
}

export async function verifyEvmTransfer(network: string, tx: string, payTo: string, opts: { rpcUrl?: string; fetch?: typeof fetch; tries?: number } = {}): Promise<Verification> {
  const url = opts.rpcUrl ?? process.env.EVM_RPC_URL ?? EVM_RPC[network];
  if (!url) return { verified: false, detail: `no RPC for ${network}: set EVM_RPC_URL` };
  // the receipt can trail the facilitator's answer by a block or two
  for (let i = 0; i < (opts.tries ?? 6); i++) {
    const receipt = await rpc(url, "eth_getTransactionReceipt", [tx], opts.fetch).catch(() => null);
    if (receipt) {
      const credited = evmCredited(receipt, payTo, USDC[network]);
      return {
        verified: receipt.status === "0x1" && credited > 0n,
        credited,
        detail: `${network} block ${Number(receipt.blockNumber)}: status ${receipt.status === "0x1" ? "success" : "reverted"}, ${credited} USDC atomic to ${payTo}`,
      };
    }
    if (i < (opts.tries ?? 6) - 1) await sleep(1500);
  }
  return { verified: false, detail: `transaction ${tx} not found on ${network}` };
}

export async function verifySolanaTransfer(network: string, signature: string, payTo: string, opts: { rpcUrl?: string; fetch?: typeof fetch; tries?: number } = {}): Promise<Verification> {
  const url = opts.rpcUrl ?? process.env.SOLANA_RPC_URL ?? SOLANA_RPC[network];
  if (!url) return { verified: false, detail: `no RPC for ${network}: set SOLANA_RPC_URL` };
  for (let i = 0; i < (opts.tries ?? 8); i++) {
    const tx = await rpc(url, "getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }], opts.fetch).catch(() => null);
    if (tx) {
      const credited = solanaCredited(tx, payTo, USDC[network]);
      return {
        verified: tx.meta?.err == null && credited > 0n,
        credited,
        detail: `${network} slot ${tx.slot}: ${tx.meta?.err ? "failed" : "confirmed"}, ${credited} USDC atomic to ${payTo}`,
      };
    }
    if (i < (opts.tries ?? 8) - 1) await sleep(1500);
  }
  return { verified: false, detail: `transaction ${signature} not found on ${network}` };
}
