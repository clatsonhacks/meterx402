// Auto-detect what an API should be metered on, by calling it once.
//
// A seller shouldn't have to know our meter vocabulary before they can sell
// anything. `mx402 <url> --wallet …` probes the endpoint, reads the shape of the
// response, and picks the meter itself:
//
//   usage.total_tokens / eval_count / usageMetadata   → tokens   (LLMs)
//   GraphQL data{...[]}, a top-level array, {result:[]} → rows    (data APIs)
//   a big body with neither                            → bytes
//   a small fixed body                                 → request (flat)
//
// It also suggests a rate, scaled so a typical call lands near a sensible price
// rather than at 1000× or 1/1000 of one. Everything it picks can be overridden
// by the usual flags: this is a starting point, not a policy.

import { makeMeter, tokenUsage, countRows } from "./meters.ts";
import { fromAtomic, priceAtomic, type RateCard } from "./pricing.ts";

export interface ProbeRequest {
  upstream: string;
  sample?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface Probe {
  ok: boolean;
  status: number;
  ms: number;
  bytes: number;
  json: unknown;
  text: string;
  url: string;
  error?: string;
}

/** Build the upstream URL the same way the gateway does. */
export function probeUrl(p: ProbeRequest): URL {
  const base = new URL(p.upstream);
  const sample = p.sample ?? "/";
  const [path, qs] = sample.split("?");
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(path === "/" || path === "" ? base.pathname : basePath + path, base.origin);
  for (const [k, v] of base.searchParams) url.searchParams.set(k, v);
  if (qs) for (const [k, v] of new URLSearchParams(qs)) url.searchParams.set(k, v);
  for (const [k, v] of Object.entries(p.query ?? {})) url.searchParams.set(k, v);
  return url;
}

/** Call the upstream once, exactly as a paying request would. */
export async function probe(p: ProbeRequest): Promise<Probe> {
  const url = probeUrl(p);
  const method = (p.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { accept: "application/json", ...p.headers };
  if (method !== "GET" && method !== "HEAD") headers["content-type"] ??= "application/json";
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : p.body });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, ms: performance.now() - t0, bytes: Buffer.byteLength(text), json, text, url: url.toString() };
  } catch (e) {
    return { ok: false, status: 0, ms: performance.now() - t0, bytes: 0, json: undefined, text: "", url: url.toString(), error: String(e).split("\n")[0] };
  }
}

export interface Detection {
  meter: string;
  unit: string;
  rate: string;
  per: number;
  min?: string;
  maxUnits: number;
  measured: number;
  why: string;
}

/** Defaults per meter, chosen so a normal call costs roughly 0.01 HBAR. */
const DEFAULTS: Record<string, { rate: string; per: number; maxUnits: number; min?: string }> = {
  tokens: { rate: "0.01", per: 1000, maxUnits: 4000, min: "0.0001" },
  rows: { rate: "0.002", per: 1, maxUnits: 1000, min: "0.0005" },
  bytes: { rate: "0.001", per: 1000, maxUnits: 5_000_000 },
  request: { rate: "0.01", per: 1, maxUnits: 1 },
};

const TARGET = 0.01; // HBAR a typical call should cost

/** Nudge the rate by powers of ten until the sampled call lands near TARGET. */
function scaleRate(rate: string, per: number, measured: number): string {
  let r = Number(rate);
  if (!(measured > 0) || !(r > 0)) return rate;
  const cost = () => (measured * r) / per;
  for (let i = 0; i < 6 && cost() > TARGET * 4; i++) r /= 10;
  for (let i = 0; i < 6 && cost() < TARGET / 8; i++) r *= 10;
  return String(Number(r.toPrecision(2)));
}

/** What should this API be metered on? Reads one real response. */
export function detectFrom(p: Probe, reqBody?: unknown): Detection | { error: string } {
  if (!p.ok) {
    return { error: p.error ?? `the API answered HTTP ${p.status}${p.text ? `: ${p.text.slice(0, 200)}` : ""}` };
  }
  let meter = "request";
  let why = "the response is a single fixed-size object, so every call is worth the same";

  const usage = tokenUsage(p.json);
  const list = largestArray(p.json);
  if (usage) {
    meter = "tokens";
    why = `the response reports token usage (${usage.input} in + ${usage.output} out), so calls are priced per token`;
  } else if (list && list.length > 1) {
    // Price on the list the API actually returns. Naming the path keeps the
    // count stable even if the envelope around it changes.
    meter = list.path ? `rows:${list.path}` : "rows";
    const where = list.path ? `at ${list.path}` : "at the top level";
    why = `the response carries a list of ${list.length} items ${where}, so calls are priced per row returned`;
  } else if (p.bytes > 20_000) {
    meter = "bytes";
    why = `no usage or item count, but the body is ${(p.bytes / 1000).toFixed(1)} KB, so calls are priced per KB`;
  }

  const base = DEFAULTS[meter.split(":")[0]];
  const m = makeMeter(meter);
  const measured = m.measure({ reqBody, status: p.status, resText: p.text, resJson: p.json, bytes: p.bytes, ms: p.ms });
  const rate = meter === "request" ? base.rate : scaleRate(base.rate, base.per, measured);
  // Tether the cap to what this API actually returned, with a floor so a small
  // sample doesn't lock the lane down: room to grow, not a blank cheque.
  const FLOOR: Record<string, number> = { tokens: 1000, rows: 20, bytes: 50_000 };
  const kind = meter.split(":")[0];
  const maxUnits = meter === "request" ? 1 : Math.max(Math.ceil(measured * 4), FLOOR[kind] ?? 1);
  return { meter, unit: m.unit, rate, per: base.per, min: base.min, maxUnits, measured, why };
}

/** The biggest array in the response, and the dotted path to it. This is what
 *  a data API is really selling: 24 forecast hours, 10 transactions, 5 pools. */
export function largestArray(json: unknown, maxDepth = 4): { path: string; length: number } | null {
  let best: { path: string; length: number } | null = null;
  const walk = (node: unknown, path: string, depth: number) => {
    if (node == null || depth > maxDepth) return;
    if (Array.isArray(node)) {
      if (!best || node.length > best.length) best = { path, length: node.length };
      return; // don't descend into rows
    }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(json, "", 0);
  return best;
}

/** Probe, then decide. */
export async function detect(p: ProbeRequest): Promise<{ probe: Probe; detection: Detection | { error: string } }> {
  const result = await probe(p);
  let reqBody: unknown;
  if (p.body) { try { reqBody = JSON.parse(p.body); } catch {} }
  return { probe: result, detection: detectFrom(result, reqBody) };
}

/** Price one metered reading with a rate card, as a decimal string. */
export const priceOf = (units: number, card: Pick<RateCard, "rate" | "per" | "min">, decimals = 8) =>
  fromAtomic(priceAtomic(units, card, 1, decimals), decimals);

/** Variants that make the price MOVE, so a dry run shows metering doing its job:
 *  a smaller and a larger version of the same call. */
export function variants(p: ProbeRequest): { label: string; req: ProbeRequest }[] {
  const out: { label: string; req: ProbeRequest }[] = [];
  let body: any;
  if (p.body) { try { body = JSON.parse(p.body); } catch {} }
  if (body && Array.isArray(body.messages)) {
    for (const n of [64, 256]) out.push({ label: `max_tokens ${n}`, req: { ...p, body: JSON.stringify({ ...body, max_tokens: n }) } });
    return out;
  }
  if (body && typeof body.query === "string" && /\bfirst\s*:\s*\d+/.test(body.query)) {
    for (const n of [3, 15]) out.push({ label: `first: ${n}`, req: { ...p, body: JSON.stringify({ ...body, query: body.query.replace(/\bfirst\s*:\s*\d+/g, `first: ${n}`) }) } });
    return out;
  }
  const sample = p.sample ?? "/";
  for (const key of ["offset", "limit", "count", "forecast_days", "per_page"]) {
    const re = new RegExp(`([?&]${key}=)(\\d+)`);
    if (re.test(sample)) {
      const cur = Number(re.exec(sample)![2]) || 2;
      for (const n of [Math.max(1, Math.floor(cur / 2)), cur * 2]) out.push({ label: `${key}=${n}`, req: { ...p, sample: sample.replace(re, `$1${n}`) } });
      return out;
    }
  }
  return out;
}
