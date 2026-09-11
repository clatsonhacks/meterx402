// Helpers that turn what a seller configured (or what we detected) into the
// fields of a ServiceDescriptor. Shared by the gateway, `mx402 publish`, and the
// seller SDK, so every entry point describes a service the same way.

import { fromAtomic, toAtomic } from "../pricing.ts";

/** Any decimal (number, "1e-7", "0.010") → a plain decimal string ("0.0000001"). */
export function plainDecimal(x: number | string | undefined | null): string {
  if (x == null || x === "") return "0";
  return fromAtomic(toAtomic(x, 18), 18);
}

/** A registry-safe id: lowercase, [a-z0-9-_.], starts alphanumeric. */
export function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9-_.]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 63);
  return out || "service";
}

export type ServiceType = "rest" | "graphql" | "llm" | "mcp" | "a2a";
export type AuthType = "none" | "api-key" | "bearer" | "header";

export function inferType(unit: string, sampleBody?: string): ServiceType {
  if (unit === "tokens") return "llm";
  if (sampleBody && /"query"\s*:\s*"\s*(query|\{)/.test(sampleBody)) return "graphql";
  return "rest";
}

/** How the UPSTREAM authenticates, from the credentials the seller supplied. */
export function inferAuth(headers: Record<string, string> = {}, query: Record<string, string> = {}): AuthType {
  // "Bearer none" / an empty bearer is the lanes.json placeholder for "no key"
  const placeholder = ([k, v]: [string, string]) => k.toLowerCase() === "authorization" && /^bearer(\s+none)?\s*$/i.test(v.trim());
  headers = Object.fromEntries(Object.entries(headers).filter((e) => !placeholder(e)));
  const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === "authorization");
  if (auth && /^bearer\s+\S/i.test(auth[1])) return "bearer";
  if (Object.keys(headers).some((k) => /key|token|secret/i.test(k))) return "api-key";
  if (Object.keys(query).some((k) => /key|token|secret/i.test(k))) return "api-key";
  if (Object.keys(headers).length) return "header";
  return "none";
}

/** A first guess at what a service does, from its URL and shape. Sellers can
 *  (and should) say it themselves with --capability; this keeps a service
 *  discoverable when they don't. */
export function inferCapabilities(upstream: string, type: ServiceType, sample = ""): string[] {
  const hay = `${upstream} ${sample}`.toLowerCase();
  const caps: string[] = [];
  if (type === "llm") caps.push("text_generation");
  const rules: [RegExp, string][] = [
    [/weather|forecast|meteo/, "weather_forecast"],
    [/etherscan|txlist|blockchain|explorer|mirrornode|hashscan/, "blockchain_data"],
    [/thegraph|subgraph|uniswap|defi/, "onchain_analytics"],
    [/price|quote|stock|finance|alphavantage|coingecko|market/, "market_data"],
    [/tally|governance|proposal|dao/, "dao_governance"],
    [/translat/, "translation"],
    [/search/, "search"],
    [/image|vision/, "image_generation"],
  ];
  for (const [re, cap] of rules) if (re.test(hay) && !caps.includes(cap)) caps.push(cap);
  if (!caps.length) {
    let host = "api";
    try { host = new URL(upstream).hostname.replace(/^(api|www)\./, "").split(".")[0]; } catch {}
    caps.push(`${slug(host).replace(/[-.]/g, "_")}_api`);
  }
  return caps;
}
