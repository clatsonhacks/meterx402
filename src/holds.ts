// Held responses: the piece that makes "meter, then pay" work.
//
// The gateway runs the upstream call, counts the units, and parks the finished
// response here while the buyer decides whether to pay the exact quote. A hold:
//   - expires (the quote's maxTimeoutSeconds), so memory is bounded
//   - is capped per client, so a caller who never pays can't make the seller
//     do unbounded work
//   - is locked while it settles, so two payments racing for one quote can't
//     both be charged and both be served
//   - is bound to a request fingerprint, so a payment for quote A can only
//     ever release response A

import { createHash } from "node:crypto";

export interface Hold<T> {
  id: string;
  client: string;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  settling: boolean;
  data: T;
}

export interface HoldOptions {
  ttlMs: number;
  maxPerClient: number;
  maxTotal: number;
  now?: () => number;
}

export type LockResult<T> =
  | { ok: true; hold: Hold<T> }
  | { ok: false; reason: "not_found" | "fingerprint_mismatch" | "already_settling" };

export class HoldStore<T> {
  private holds = new Map<string, Hold<T>>();
  private now: () => number;

  constructor(private opts: HoldOptions) {
    this.now = opts.now ?? Date.now;
  }

  get size() { this.sweep(); return this.holds.size; }

  countFor(client: string): number {
    this.sweep();
    let n = 0;
    for (const h of this.holds.values()) if (h.client === client) n++;
    return n;
  }

  create(client: string, fingerprint: string, data: T):
    | { ok: true; hold: Hold<T> }
    | { ok: false; reason: "too_many_unpaid" | "store_full" } {
    this.sweep();
    if (this.countFor(client) >= this.opts.maxPerClient) return { ok: false, reason: "too_many_unpaid" };
    if (this.holds.size >= this.opts.maxTotal) return { ok: false, reason: "store_full" };
    const t = this.now();
    const hold: Hold<T> = {
      id: crypto.randomUUID(), client, fingerprint,
      createdAt: t, expiresAt: t + this.opts.ttlMs, settling: false, data,
    };
    this.holds.set(hold.id, hold);
    return { ok: true, hold };
  }

  get(id: string): Hold<T> | undefined {
    const h = this.holds.get(id);
    if (!h) return undefined;
    if (!h.settling && this.now() > h.expiresAt) { this.holds.delete(id); return undefined; }
    return h;
  }

  /** Take exclusive ownership of a hold for settlement. */
  lock(id: string, fingerprint: string): LockResult<T> {
    const h = this.get(id);
    if (!h) return { ok: false, reason: "not_found" };
    if (h.fingerprint !== fingerprint) return { ok: false, reason: "fingerprint_mismatch" };
    if (h.settling) return { ok: false, reason: "already_settling" };
    h.settling = true;
    return { ok: true, hold: h };
  }

  /** Settlement failed: release the lock so the buyer can retry until expiry. */
  unlock(id: string) { const h = this.holds.get(id); if (h) h.settling = false; }

  remove(id: string) { this.holds.delete(id); }

  sweep() {
    const t = this.now();
    for (const [id, h] of this.holds) if (!h.settling && t > h.expiresAt) this.holds.delete(id);
  }
}

/** Same request ⇒ same fingerprint. Payment headers are deliberately not part
 *  of it: the paid retry must match the unpaid original. */
export function fingerprint(method: string, pathWithQuery: string, body: string): string {
  return createHash("sha256").update(`${method.toUpperCase()} ${pathWithQuery}\n`).update(body).digest("hex");
}

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Fixed-window per-client counter for unpaid (work-triggering) requests. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private perMinute: number, private now: () => number = Date.now) {}

  /** true = allowed. A limit of 0 or less disables limiting. */
  hit(client: string): boolean {
    if (!(this.perMinute > 0)) return true;
    const t = this.now();
    const w = this.windows.get(client);
    if (!w || t - w.start >= 60_000) { this.windows.set(client, { start: t, count: 1 }); return true; }
    if (w.count >= this.perMinute) return false;
    w.count++;
    return true;
  }
}
