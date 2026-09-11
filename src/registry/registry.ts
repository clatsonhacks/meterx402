// The MeterX402 service registry: the discovery layer.
//
// An agent shouldn't need to know a service's URL in advance. Services are
// registered by their ServiceDescriptor (gateways register themselves when they
// come up; `mx402 publish` does it explicitly) and found by what they do, what
// they cost, and how well they have behaved.
//
// Storage is a JSON file: enough to survive restarts, trivially inspectable,
// and it keeps the registry out of the settlement trust path (the registry says
// what a service claims; receipts and HCS say what actually happened).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ServiceDescriptor, type ReputationRecord } from "../protocol/schemas.ts";
import { fromAtomic, priceAtomic } from "../pricing.ts";

export interface RegistryEntry {
  descriptor: ServiceDescriptor;
  lane: string;              // the gateway's lane name (events are keyed by it)
  source: "gateway" | "publish";
  first_seen: number;
  last_seen: number;
  live: boolean;
}

export interface SearchFilter {
  capability?: string;       // exact capability id, e.g. weather_forecast
  q?: string;                // free text over name, description, capabilities
  maxPrice?: number;         // max price of a typical call, in the service currency
  minReputation?: number;    // 0–100; unrated services are excluded when set
  unit?: string;             // tokens | rows | …
  network?: string;          // a settlement network the buyer can pay on
  currency?: string;
  iface?: string;            // rest | a2a | mcp | sdk | graphql
  live?: boolean;            // only services answering probes (default true)
}

export interface Listing {
  service_id: string;
  descriptor: ServiceDescriptor;
  live: boolean;
  reputation: ReputationRecord;
  price: {
    rate: string; unit: string; per: number; currency: string;
    typical_call: number | null;  // median charge actually paid, when known
    worst_case_call: number | null; // the cap priced at the rate
  };
  rank: number;              // 0–1, higher is better (reputation, price, latency)
}

export class Registry {
  private entries = new Map<string, RegistryEntry>();
  private dirty: ReturnType<typeof setTimeout> | null = null;

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as RegistryEntry[];
        for (const e of raw) {
          const d = ServiceDescriptor.safeParse(e.descriptor);
          if (d.success) this.entries.set(d.data.service_id, { ...e, descriptor: d.data, live: false });
        }
      } catch {}
    }
  }

  /** Publish or update a service. Throws on an invalid descriptor. */
  upsert(descriptor: unknown, meta: { lane: string; source: RegistryEntry["source"] }): RegistryEntry {
    const d = ServiceDescriptor.parse(descriptor);
    const prev = this.entries.get(d.service_id);
    const t = Date.now();
    const entry: RegistryEntry = { descriptor: d, lane: meta.lane, source: prev?.source === "publish" ? "publish" : meta.source, first_seen: prev?.first_seen ?? t, last_seen: t, live: true };
    this.entries.set(d.service_id, entry);
    this.save();
    return entry;
  }

  get(id: string) { return this.entries.get(id); }
  byLane(lane: string) { for (const e of this.entries.values()) if (e.lane === lane) return e; return undefined; }
  all() { return [...this.entries.values()]; }
  setLive(id: string, live: boolean) { const e = this.entries.get(id); if (e && e.live !== live) { e.live = live; } }
  remove(id: string) { const ok = this.entries.delete(id); if (ok) this.save(); return ok; }

  /** Find services, ranked. `typicalCharge` supplies the median paid charge per
   *  service where the hub has seen payments. */
  search(f: SearchFilter, reputationOf: (id: string) => ReputationRecord, typicalCharge: (id: string) => number | null = () => null): Listing[] {
    const q = f.q?.toLowerCase();
    const listings: Listing[] = [];
    for (const e of this.entries.values()) {
      const d = e.descriptor;
      if ((f.live ?? true) && !e.live) continue;
      if (f.capability && !d.capabilities.includes(f.capability)) continue;
      if (f.unit && d.pricing.unit !== f.unit) continue;
      if (f.iface && !d.interfaces.includes(f.iface as any)) continue;
      if (f.network && !d.payment.settlement.some((o) => o.network === f.network)) continue;
      if (f.currency && d.pricing.currency.toUpperCase() !== f.currency.toUpperCase()) continue;
      if (q && !`${d.name} ${d.description ?? ""} ${d.capabilities.join(" ")} ${d.service_id}`.toLowerCase().includes(q)) continue;
      const reputation = reputationOf(d.service_id);
      if (f.minReputation != null && (reputation.score == null || reputation.score < f.minReputation)) continue;
      const card = { rate: d.pricing.rate, per: d.pricing.per, min: d.pricing.min };
      const worst = d.pricing.max_units == null ? null : Number(fromAtomic(priceAtomic(d.pricing.max_units, card), 8));
      const typical = typicalCharge(d.service_id);
      const estimate = typical ?? worst;
      if (f.maxPrice != null && (estimate == null || estimate > f.maxPrice)) continue;
      listings.push({
        service_id: d.service_id, descriptor: d, live: e.live, reputation,
        price: { rate: d.pricing.rate, unit: d.pricing.unit, per: d.pricing.per, currency: d.pricing.currency, typical_call: typical, worst_case_call: worst },
        rank: 0,
      });
    }
    return rank(listings);
  }

  private save() {
    if (!this.file) return;
    if (this.dirty) clearTimeout(this.dirty);
    this.dirty = setTimeout(() => {
      try { writeFileSync(this.file!, JSON.stringify(this.all(), null, 2)); } catch {}
    }, 200);
    this.dirty.unref?.();
  }
}

/** Phase-8 routing, in its simplest honest form: among compatible services,
 *  reputation dominates (60%), then price (25%, relative to the cheapest and
 *  dearest candidates), then latency (15%). A badly rated service is rarely a
 *  bargain for an agent that has to retry or dispute, so price alone can't lift
 *  it past a well-rated one. Unrated services sit at 50 on reputation. */
export function rank(listings: Listing[]): Listing[] {
  const prices = listings.map((l) => l.price.typical_call ?? l.price.worst_case_call).filter((x): x is number => x != null);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  for (const l of listings) {
    const rep = l.reputation.score == null ? 0.5 : l.reputation.score / 100;
    const p = l.price.typical_call ?? l.price.worst_case_call;
    const price = p == null || !Number.isFinite(lo) || hi === lo ? 0.5 : 1 - (p - lo) / (hi - lo);
    const lat = l.reputation.components.latency;
    l.rank = Math.round((0.6 * rep + 0.25 * price + 0.15 * lat) * 1000) / 1000;
  }
  return listings.sort((a, b) => b.rank - a.rank);
}
