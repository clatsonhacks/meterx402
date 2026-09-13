// Live data from the hub: the registry and recent receipts. Everything the
// landing page counts or replays is real; examples appear only when empty.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface Receipt {
  receipt_id: string;
  service_id: string;
  metered_units: number;
  unit: string;
  rate: string;
  per: number;
  amount: string;
  currency: string;
  network: string;
  transaction_id: string | null;
  settled_at: number;
}

export interface Listing {
  service_id: string;
  live: boolean;
  descriptor: {
    name: string;
    title?: string;
    capabilities: string[];
    pricing?: { unit?: string };
    payment?: { settlement?: { network: string }[] };
  };
  reputation?: { stats?: { paid_calls?: number } };
}

export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export type ChainKey = "hedera" | "base" | "solana";

export const chainOf = (network?: string): ChainKey =>
  !network || network.startsWith("hedera:") ? "hedera" : network.startsWith("eip155:") ? "base" : "solana";

export const chainName = (network?: string) =>
  ({ hedera: "Hedera", base: network === "eip155:8453" ? "Base" : "Base Sepolia", solana: network === SOLANA_DEVNET ? "Solana devnet" : "Solana" })[chainOf(network)];

export function txUrl(tx: string, network?: string) {
  const c = chainOf(network);
  if (c === "hedera") return `https://hashscan.io/testnet/transaction/${tx.replace("@", "-").replace(/\.(\d+)$/, "-$1")}`;
  if (c === "base") return `https://sepolia.basescan.org/tx/${tx}`;
  return `https://solscan.io/tx/${tx}${network === SOLANA_DEVNET ? "?cluster=devnet" : ""}`;
}

export const explorerName = (network?: string) => ({ hedera: "HashScan", base: "BaseScan", solana: "Solscan" })[chainOf(network)];

interface Live {
  services: Listing[];
  receipts: Receipt[];
  loaded: boolean;
  titleFor: (serviceId: string) => string;
}

const LiveContext = createContext<Live>({ services: [], receipts: [], loaded: false, titleFor: (s) => s });

export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ services: Listing[]; receipts: Receipt[]; loaded: boolean }>({ services: [], receipts: [], loaded: false });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, r] = await Promise.all([
          fetch("/registry/services?live=all").then((x) => x.json()),
          fetch("/registry/receipts?limit=40").then((x) => x.json()),
        ]);
        if (!alive) return;
        setState({
          services: Array.isArray(s?.services) ? s.services : [],
          receipts: (Array.isArray(r?.receipts) ? r.receipts : []).filter((x: Receipt) => Number(x.metered_units) > 0 && Number(x.amount) > 0),
          loaded: true,
        });
      } catch {
        if (alive) setState((p) => ({ ...p, loaded: true }));
      }
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const titleFor = (id: string) => {
    const d = state.services.find((l) => l.service_id === id)?.descriptor;
    return d?.title ?? d?.name ?? id;
  };
  return <LiveContext.Provider value={{ ...state, titleFor }}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);

export function useStats() {
  const { services } = useLive();
  const live = services.filter((l) => l.live);
  const paid = services.reduce((n, l) => n + (l.reputation?.stats?.paid_calls ?? 0), 0);
  const chains = new Set(live.flatMap((l) => (l.descriptor.payment?.settlement ?? []).map((o) => chainOf(o.network))));
  return { live: live.length, paid, chains: chains.size };
}
