// Pricing: measured units → billable units → exact atomic amount.
//
// Everything that decides how much money moves lives here, is pure, and is unit
// tested. Money is computed in integer atomic units (tinybar for HBAR, 1e-6 for
// USDC) with rational arithmetic, and always rounded UP to one atomic unit:
// 0.1 + 0.2 float drift must never be the reason a seller is paid 1 tinybar
// short, or a buyer is quoted 0 for real work.

export interface RateCard {
  unit: string;            // what is counted: "tokens", "rows", "bytes", "ms", "request", ...
  rate: number | string;   // price (in the settlement currency) per `per` units
  per?: number | string;   // unit block the rate applies to (default 1)
  min?: number | string;   // minimum charge for a paid call (default 0)
  free?: number;           // free units per call (default 0)
  maxUnits?: number;       // seller's per-call cap (default: none)
}

export interface Rational { n: bigint; d: bigint; }

/** Parse a decimal (incl. exponent form like 1e-7) into an exact fraction. */
export function rational(v: number | string | bigint): Rational {
  if (typeof v === "bigint") return { n: v, d: 1n };
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`not a decimal number: ${String(v)}`);
  const [, sign, int, frac = "", exp = "0"] = m;
  let n = BigInt((int || "0") + frac);
  let d = 10n ** BigInt(frac.length);
  const e = Number(exp);
  if (e > 0) n *= 10n ** BigInt(e);
  else if (e < 0) d *= 10n ** BigInt(-e);
  return { n: sign === "-" ? -n : n, d };
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a <= 0n ? 0n : (a + b - 1n) / b);

/** Decimal amount (e.g. HBAR) → atomic units (e.g. tinybar), rounded up. */
export function toAtomic(amount: number | string, decimals = 8): bigint {
  const r = rational(amount);
  return ceilDiv(r.n * 10n ** BigInt(decimals), r.d);
}

/** Atomic units → a plain decimal string without float error ("0.00000734"). */
export function fromAtomic(atomic: bigint | string | number, decimals = 8): string {
  const a = BigInt(atomic);
  const neg = a < 0n;
  const s = (neg ? -a : a).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

export interface Caps {
  buyerCap?: number;  // from x-meter-max-units or the request body (max_tokens)
  sellerCap?: number; // RateCard.maxUnits
}

export interface Billing {
  measured: number;   // what the meter counted
  cap: number | null; // the binding cap, if any
  capped: boolean;    // measured exceeded the cap
  billable: number;   // units actually charged (after cap and free units)
}

const positive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/** The smallest cap that applies, or null. */
export function bindingCap(caps: Caps): number | null {
  const all = [caps.buyerCap, caps.sellerCap].filter(positive);
  return all.length ? Math.min(...all) : null;
}

/** Billable units = min(measured, buyer cap, seller cap) − free units, never negative.
 *  Fractional readings (ms, KB) round up: a started unit is a used unit. */
export function billableUnits(measured: number, card: Pick<RateCard, "free" | "maxUnits">, buyerCap?: number): Billing {
  const m = Math.max(0, Number.isFinite(measured) ? measured : 0);
  const cap = bindingCap({ buyerCap, sellerCap: card.maxUnits });
  const used = Math.ceil(cap == null ? m : Math.min(m, cap));
  const billable = Math.max(0, used - Math.max(0, Math.floor(card.free ?? 0)));
  return { measured: m, cap, capped: cap != null && m > cap, billable };
}

/** Exact price for `billable` units in atomic units:
 *    max(min, ceil(billable × rate / per × multiplier × 10^decimals))
 *  Zero billable units is free (0), and the minimum does not apply: a call that
 *  used nothing billable costs nothing. */
export function priceAtomic(billable: number, card: Pick<RateCard, "rate" | "per" | "min">, multiplier: number | string = 1, decimals = 8): bigint {
  if (!(billable > 0)) return 0n;
  const u = rational(Math.ceil(billable));
  const r = rational(card.rate);
  const p = rational(card.per ?? 1);
  const k = rational(multiplier);
  if (p.n <= 0n) throw new Error("per must be > 0");
  const scale = 10n ** BigInt(decimals);
  const num = u.n * r.n * p.d * k.n * scale;
  const den = u.d * r.d * p.n * k.d;
  const amount = ceilDiv(num, den);
  const min = card.min != null ? toAtomic(card.min, decimals) : 0n;
  return amount > min ? amount : min;
}

export interface Quote extends Billing {
  amount: bigint;              // what the buyer pays
  ceilingAmount: bigint | null; // what the call would cost priced at its cap, i.e. what a flat, worst-case price would charge
}

/** One call, end to end: measured units → the exact amount to charge. */
export function quote(measured: number, card: RateCard, opts: { buyerCap?: number; multiplier?: number; decimals?: number } = {}): Quote {
  const b = billableUnits(measured, card, opts.buyerCap);
  const amount = priceAtomic(b.billable, card, opts.multiplier ?? 1, opts.decimals ?? 8);
  const ceilingAmount = b.cap == null
    ? null
    : priceAtomic(Math.max(0, b.cap - Math.max(0, Math.floor(card.free ?? 0))), card, opts.multiplier ?? 1, opts.decimals ?? 8);
  return { ...b, amount, ceilingAmount };
}

/** Human-readable rate: "0.01 HBAR / 1000 tokens". */
export function describeRate(card: RateCard, currency = "HBAR"): string {
  const per = Number(card.per ?? 1);
  return `${card.rate} ${currency} / ${per === 1 ? "" : per + " "}${per === 1 ? singular(card.unit) : card.unit}`;
}
const singular = (u: string) => (u.endsWith("s") ? u.slice(0, -1) : u);
