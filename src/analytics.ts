// Analytics: "Google Analytics for metered x402".
//
// Everything is bucketed PER LANE, and the "all APIs" view is folded from those
// same buckets, so the headline can never disagree with the sum of what's on
// screen, and a dead lane can simply be left out of the fold.
//
// On top of GlassBox402's income / calls / endpoints / hours / payers, each
// lane tracks what metering changes:
//   units       total billable units sold (tokens, rows, ...)
//   pricePerUnit income / units: the effective rate after min charges and caps
//   charges     the spread of per-call prices (flat pricing would be one number)
//   saved       Σ (ceiling − charged): what buyers would have paid if every call
//               were priced at its cap, which is what a flat price must do to be safe

export interface Settled {
  amount: number;
  units?: number;
  unit?: string;
  ceilingAmount?: number | null;
  path?: string;
  from?: string;
  tier?: string;
}

export interface Snapshot {
  totalIncome: number;
  totalRequests: number;
  totalUnits: number;
  unit: string | null;
  avgPrice: number;
  pricePerUnit: number;
  saved: number;
  charges: { min: number; p50: number; p90: number; max: number; recent: number[] };
  byEndpoint: { key: string; calls: number; units: number; income: number }[];
  byHour: number[];
  byPayer: { payer: string; spend: number; calls: number; units: number }[];
  byTier: Record<string, { calls: number; income: number }>;
}

export interface LaneSnapshot extends Snapshot { byLane: Record<string, Snapshot>; }

const RECENT = 500;

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}
const round = (x: number) => Math.round(x * 1e8) / 1e8; // tinybar precision, no float noise in the UI

class Agg {
  income = 0;
  requests = 0;
  units = 0;
  saved = 0;
  unit: string | null = null;
  recent: number[] = [];
  endpoint = new Map<string, { calls: number; units: number; income: number }>();
  hour: number[] = new Array(24).fill(0);
  payer = new Map<string, { spend: number; calls: number; units: number }>();
  tier = new Map<string, { calls: number; income: number }>();

  add(d: Settled, t: number) {
    const amount = Number(d.amount) || 0;
    const units = Number(d.units) || 0;
    this.income += amount;
    this.requests += 1;
    this.units += units;
    if (d.unit) this.unit = this.unit && this.unit !== d.unit ? "mixed" : d.unit;
    if (d.ceilingAmount != null && Number(d.ceilingAmount) > amount) this.saved += Number(d.ceilingAmount) - amount;
    this.recent.push(amount);
    if (this.recent.length > RECENT) this.recent.shift();

    const ep = (d.path ?? "/").split("?")[0];
    const e = this.endpoint.get(ep) ?? { calls: 0, units: 0, income: 0 };
    e.calls++; e.units += units; e.income += amount;
    this.endpoint.set(ep, e);
    this.hour[new Date(t).getUTCHours()] += 1;
    const who = d.from ?? "anon";
    const p = this.payer.get(who) ?? { spend: 0, calls: 0, units: 0 };
    p.spend += amount; p.calls++; p.units += units;
    this.payer.set(who, p);
    const tr = this.tier.get(d.tier ?? "anon") ?? { calls: 0, income: 0 };
    tr.calls++; tr.income += amount;
    this.tier.set(d.tier ?? "anon", tr);
  }

  merge(o: Agg) {
    this.income += o.income; this.requests += o.requests; this.units += o.units; this.saved += o.saved;
    if (o.unit) this.unit = this.unit && this.unit !== o.unit ? "mixed" : o.unit;
    this.recent.push(...o.recent);
    for (const [k, v] of o.endpoint) {
      const e = this.endpoint.get(k) ?? { calls: 0, units: 0, income: 0 };
      e.calls += v.calls; e.units += v.units; e.income += v.income;
      this.endpoint.set(k, e);
    }
    for (let h = 0; h < 24; h++) this.hour[h] += o.hour[h];
    for (const [k, v] of o.payer) {
      const p = this.payer.get(k) ?? { spend: 0, calls: 0, units: 0 };
      p.spend += v.spend; p.calls += v.calls; p.units += v.units;
      this.payer.set(k, p);
    }
    for (const [k, v] of o.tier) {
      const tr = this.tier.get(k) ?? { calls: 0, income: 0 };
      tr.calls += v.calls; tr.income += v.income;
      this.tier.set(k, tr);
    }
  }

  snap(): Snapshot {
    const sorted = [...this.recent].sort((a, b) => a - b);
    return {
      totalIncome: round(this.income),
      totalRequests: this.requests,
      totalUnits: this.units,
      unit: this.unit,
      avgPrice: this.requests ? round(this.income / this.requests) : 0,
      pricePerUnit: this.units ? this.income / this.units : 0,
      saved: round(this.saved),
      charges: {
        min: sorted[0] ?? 0, p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), max: sorted.at(-1) ?? 0,
        recent: this.recent.slice(-60),
      },
      byEndpoint: [...this.endpoint].map(([key, v]) => ({ key, ...v, income: round(v.income) })).sort((a, b) => b.calls - a.calls),
      byHour: this.hour,
      byPayer: [...this.payer].map(([payer, v]) => ({ payer, ...v, spend: round(v.spend) })).sort((a, b) => b.spend - a.spend).slice(0, 8),
      byTier: Object.fromEntries([...this.tier].map(([k, v]) => [k, { calls: v.calls, income: round(v.income) }])),
    };
  }
}

export class Analytics {
  private lanes = new Map<string, Agg>();

  ingest(lane: string, d: Settled, t: number) {
    let a = this.lanes.get(lane);
    if (!a) this.lanes.set(lane, (a = new Agg()));
    a.add(d, t);
  }

  /** `only` scopes the result to live lanes, so a dead API drops out of
   *  analytics exactly as it drops out of the API list. */
  snapshot(only?: string[]): LaneSnapshot {
    const keys = only ?? [...this.lanes.keys()];
    const total = new Agg();
    const byLane: Record<string, Snapshot> = {};
    for (const k of keys) {
      const a = this.lanes.get(k) ?? new Agg();
      total.merge(a);
      byLane[k] = a.snap();
    }
    return { ...total.snap(), byLane };
  }
}
