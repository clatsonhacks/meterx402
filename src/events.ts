// MXEvent: the shared vocabulary of the whole system. Every hop of every
// metered payment becomes one of these, broadcast on the hub websocket and
// appended to the tape (JSONL). The dashboard renders nothing that didn't
// arrive as an MXEvent, which is what makes a tape replay identical to a live run.

export type MXEventType =
  | "lane_up"        // a gateway came online: { upstream, unit, rate, per, min, free, maxUnits, payTo, port, ... }
  | "request_in"     // request arrived at a lane: { method, path, cap }
  | "metered"        // upstream answered and was counted: { unit, measured, billable, cap, amount, ceilingAmount, bodySha256 }
  | "quote_402"      // exact metered price quoted, response held: { quoteId, amount, units, expiresAt }
  | "free"           // metered to zero billable units, served without payment
  | "settled"        // payment settled: { from, unit, units, measured, cap, rate, per, amount, ceilingAmount, txHash, path, tier }
  | "payment_failed" // verify/settle rejected: { reason, stage }
  | "quote_expired"  // payment arrived for a hold that no longer exists
  | "upstream_error" // upstream failed, nothing charged: { status }
  | "blocked"        // refused by policy (World ID blockBots)
  | "rate_limited"   // too many unpaid quotes / requests per minute
  | "hedera_receipt" // the settlement transaction on HashScan: { hashscan, txId }
  | "hcs_receipt"    // HCS topic message recording this payment: { topicId, hashscan }
  | "policy"         // a lane's pricing policy changed from the dashboard
  | "subscription_open"
  | "quote_round"
  | "tab_open"       // a buyer opened a Metered Tab: { tab, owner, allowance, spender }
  | "tab_flush"      // a tab's usage was settled in one approved transfer: { tab, amount, calls, txHash } or { error }
  | "tab_close"      // tab closed: { tab, calls, units, pulled }
  | "service_published" // a ServiceDescriptor was published to the registry
  | "dispute"        // a buyer disputed a paid call (Dispute object)
  | "reputation_anchor"; // a reputation snapshot was written to HCS

export interface MXEvent {
  id: string;
  reqId: string; // groups all events of one payment flow
  lane: string;
  type: MXEventType;
  t: number; // epoch ms
  data: Record<string, unknown>;
}

// PORT is what a PaaS hands us; 4021 stays the local default. Gateways reach
// the hub over loopback, and MX_HUB overrides that when they run elsewhere.
export const HUB_PORT = Number(process.env.PORT ?? process.env.MX_HUB_PORT ?? 4021);
export const HUB_URL = process.env.MX_HUB ?? `http://127.0.0.1:${HUB_PORT}`;

export function mxe(type: MXEventType, lane: string, reqId: string, data: Record<string, unknown> = {}): MXEvent {
  return { id: crypto.randomUUID(), reqId, lane, type, t: Date.now(), data };
}

/** Fire-and-forget: if the hub is down, gateways keep serving and settling;
 *  only visibility degrades. */
export async function emit(ev: MXEvent, hub = HUB_URL): Promise<void> {
  try {
    await fetch(`${hub}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
    });
  } catch {
    // hub down
  }
}

export const hashscanTx = (txId: string, network = "testnet") =>
  // HashScan wants 0.0.x@sss.nnn as 0.0.x-sss-nnn
  `https://hashscan.io/${network}/transaction/${String(txId).replace("@", "-").replace(/\.(\d+)$/, "-$1")}`;
