// MeterX402 seller SDK: put payment and metering around an API you already run.
//
//   const svc = await wrap({
//     upstream: "https://api.example.com",
//     wallet: "0.0.1234",                       // where payments settle
//     capabilities: ["weather_forecast"],
//     registry: "http://localhost:4021",        // publish for discovery
//   });
//   svc.descriptor   // the ServiceDescriptor agents will see
//
// Your API stays the source of truth; nothing about it changes. With no `meter`
// the API is probed once and the meter + a starting rate are detected.

import { startGateway, type GatewayConfig } from "../gateway.ts";
import { detect } from "../detect.ts";
import { hederaTabLedger, mockTabLedger } from "../tabs.ts";
import { parseHederaKey } from "../hedera.ts";
import type { ServiceDescriptor } from "../protocol/schemas.ts";

export interface WrapOptions {
  upstream: string;
  wallet: string;                  // payout account
  meter?: string;                  // omit to auto-detect
  rate?: string | number;
  per?: string | number;
  min?: string | number;
  free?: number;
  maxUnits?: number;
  name?: string;
  serviceId?: string;
  capabilities?: string[];
  description?: string;
  title?: string;
  unitLabel?: string;
  port?: number;
  publicUrl?: string;
  registry?: string | null;        // hub URL to publish to (null = don't publish)
  sample?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>; // upstream auth, kept server-side
  query?: Record<string, string>;
  facilitator?: string;
  chain?: string;
  /** Offer Metered Tabs: the spender account that pulls allowances. */
  tab?: { spenderId: string; spenderKey: string; mockLedgerUrl?: string; flushAt?: string; flushEverySec?: number };
  quiet?: boolean;
  holdTtlSec?: number;
  maxHolds?: number;
}

export interface WrappedService {
  url: string;
  descriptor: ServiceDescriptor;
  detected?: { meter: string; why: string };
  close(): Promise<void>;
}

export async function wrap(o: WrapOptions): Promise<WrappedService> {
  let meter = o.meter, rate = o.rate, per = o.per, min = o.min, maxUnits = o.maxUnits;
  let detected: WrappedService["detected"];
  if (!meter) {
    const { detection } = await detect({ upstream: o.upstream, sample: o.sample, method: o.method, body: o.body, headers: o.headers, query: o.query });
    if ("error" in detection) throw new Error(`could not detect a meter for ${o.upstream}: ${detection.error}`);
    meter = detection.meter;
    rate ??= detection.rate;
    per ??= detection.per;
    min ??= detection.min;
    maxUnits ??= detection.maxUnits;
    detected = { meter: detection.meter, why: detection.why };
  }
  const name = o.name ?? new URL(o.upstream).hostname.replace(/^api\./, "").split(".")[0];
  const cfg: GatewayConfig = {
    upstream: o.upstream, name, port: o.port ?? 4030, payTo: o.wallet, meter,
    card: { rate: rate ?? "0.01", per: per ?? 1, min: min ?? 0, free: o.free, maxUnits },
    chain: o.chain, facilitator: o.facilitator, headers: o.headers, query: o.query,
    sample: o.sample, sampleMethod: o.method, sampleBody: o.body,
    hub: o.registry === undefined ? undefined : o.registry,
    serviceId: o.serviceId, capabilities: o.capabilities, description: o.description, title: o.title, unitLabel: o.unitLabel, publicUrl: o.publicUrl,
    quiet: o.quiet, holdTtlSec: o.holdTtlSec, maxHolds: o.maxHolds,
    tab: o.tab ? {
      ledger: o.tab.mockLedgerUrl ? mockTabLedger(o.tab.mockLedgerUrl, o.tab.spenderId, parseHederaKey(o.tab.spenderKey)) : hederaTabLedger(o.tab.spenderId, o.tab.spenderKey),
      spender: o.tab.spenderId, flushAt: o.tab.flushAt, flushEverySec: o.tab.flushEverySec,
    } : undefined,
  };
  const gw = await startGateway(cfg);
  return { url: gw.url, descriptor: gw.descriptor, detected, close: gw.close };
}
