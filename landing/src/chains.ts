// The three settlement chains as the globe shows them. Positions are chosen
// for composition on the globe, not geography.

import type { ChainKey } from "./data";

export interface ChainSpot {
  key: ChainKey;
  label: string;
  unit: string;
  at: readonly [number, number];
  glow: string;
  /** the glow on light paper: a touch deeper so it reads on ivory */
  glowLight: string;
  core: string;
  coreDark: string;
  dot: string;
}

export const CHAINS: ChainSpot[] = [
  { key: "hedera", label: "Hedera", unit: "HBAR", at: [34, -98], glow: "#7048e8", glowLight: "#7048e8", core: "#1f1f24", coreDark: "#ecebf7", dot: "var(--hedera-dot)" },
  { key: "base", label: "Base", unit: "USDC", at: [50, 2], glow: "#2f6bff", glowLight: "#3f6ff0", core: "#0052ff", coreDark: "#5b91ff", dot: "#0052ff" },
  { key: "solana", label: "Solana", unit: "USDC", at: [-18, -48], glow: "#14c98a", glowLight: "#1fa97a", core: "#9945ff", coreDark: "#b48cff", dot: "linear-gradient(135deg,#9945ff,#14f195)" },
];

/** Where buyers pay from, picked per receipt so the arcs are stable. */
export const CITIES: [number, number][] = [
  [37.8, -122.4], [52.5, 13.4], [6.5, 3.4], [19.4, -99.1], [30.0, 31.2], [40.7, -74.0], [-33.9, 18.4], [55.7, 37.6],
  [48.9, 2.3], [-23.5, -46.6], [43.6, -79.4], [35.7, 139.7], [1.3, 103.8], [13.1, 80.3], [25.2, 55.3], [-34.6, -58.4],
];
