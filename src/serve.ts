// serve.ts: the whole product as one process tree (port of GlassBox402's).
//
//   npm run demo            hub + one metered gateway per lane in lanes.json (Hedera testnet via blocky402)
//   npm run demo:offline    same, against local mocks: mock LLM/GraphQL upstream +
//                           mock facilitator. Zero config, nothing touches a network.
//
// The same three load-bearing rules as GlassBox402:
//   1. wait for the hub before starting lanes (a lane's first lane_up must land)
//   2. skip a lane whose ${VAR}s are unset (a keyless lane would quote, then 401)
//   3. if any child dies, take the tree down so the platform restarts it clean

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, interpolate, ROOT } from "./env.ts";
import { HUB_PORT } from "./events.ts";

loadEnv();
const argv = process.argv.slice(2);
const OFFLINE = argv.includes("--offline") || process.env.MX_OFFLINE === "1";
const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
const MOCK_UPSTREAM_PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 4800);
const MOCK_FACILITATOR_PORT = Number(process.env.MOCK_FACILITATOR_PORT ?? 4899);

export interface LaneSpec {
  name: string;
  upstream: string;
  meter?: string;
  rate: number | string;
  per?: number | string;
  min?: number | string;
  free?: number;
  maxUnits?: number;
  port: number;
  chain?: string;
  /** Payout address for this lane when it settles somewhere else (e.g. ${WALLET_EVM}). */
  wallet?: string;
  sample?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  holdTtl?: number;
  maxHolds?: number;
  rpm?: number;
  /** Offer Metered Tabs on this lane (needs a spender account; see .env). */
  tab?: boolean;
  /** How the service describes itself in the registry and marketplace. */
  description?: string;
  capabilities?: string[];
  title?: string;
  unitLabel?: string;
  /** Sell access by the period, paid by pre-signed scheduled transfers. */
  subscribe?: string;
  period?: number;
  subPeriods?: number;
  subUnits?: number;
  tabFlush?: number | string;
}

const children: ChildProcess[] = [];
let shuttingDown = false;

function child(label: string, file: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const p = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, file), ...args], {
    cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env },
  });
  children.push(p);
  p.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n💥 ${label} exited (code=${code} signal=${signal}): bringing the stack down.`);
    shutdown(1);
  });
  return p;
}

function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of children) { try { p.kill(); } catch {} }
  setTimeout(() => process.exit(code), 300);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { console.log(`\n${sig}: stopping.`); shutdown(0); });

async function waitFor(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not answer within ${timeoutMs}ms`);
}

/** lanes.json entry → gateway CLI args, or null if a required ${VAR} is unset. */
export function laneArgs(lane: LaneSpec, wallet: string, tabsPossible = false): string[] | null {
  const s = (v: unknown) => (v == null ? null : interpolate(String(v)));
  const upstream = s(lane.upstream);
  if (upstream == null) return null;
  // an EVM or Solana lane pays out to its own address; skip it until that is set
  const payout = lane.wallet != null ? s(lane.wallet) : wallet;
  if (!payout) return null;
  const args = [upstream, "--name", lane.name, "--port", String(lane.port), "--wallet", payout];
  // No meter stated? Leave the flag off and let the CLI detect it from the API.
  if (lane.meter) args.push("--meter", lane.meter);
  if (lane.rate != null) args.push("--rate", String(lane.rate));
  const opt: [string, unknown][] = [["per", lane.per], ["min", lane.min], ["free", lane.free], ["max-units", lane.maxUnits],
    ["chain", lane.chain], ["sample", lane.sample], ["method", lane.method], ["hold-ttl", lane.holdTtl], ["max-holds", lane.maxHolds], ["rpm", lane.rpm]];
  for (const [k, v] of opt) if (v != null) args.push(`--${k}`, String(v));
  if (lane.tab && tabsPossible) {
    args.push("--tab");
    if (lane.tabFlush != null) args.push("--tab-flush", String(lane.tabFlush));
  }
  if (lane.description) args.push("--description", lane.description);
  if (lane.title) args.push("--title", lane.title);
  if (lane.unitLabel) args.push("--unit-label", lane.unitLabel);
  if (lane.subscribe) {
    args.push("--subscribe", lane.subscribe);
    if (lane.period) args.push("--period", String(lane.period));
    if (lane.subPeriods) args.push("--sub-periods", String(lane.subPeriods));
    if (lane.subUnits) args.push("--sub-units", String(lane.subUnits));
  }
  for (const c of lane.capabilities ?? []) args.push("--capability", c);
  if (lane.body != null) { const b = s(lane.body); if (b == null) return null; args.push("--body", b); }
  for (const [k, v] of Object.entries(lane.headers ?? {})) { const val = s(v); if (val == null) return null; args.push("--header", `${k}: ${val}`); }
  for (const [k, v] of Object.entries(lane.query ?? {})) { const val = s(v); if (val == null) return null; args.push("--query", `${k}=${val}`); }
  return args;
}

async function main() {
  const extraEnv: NodeJS.ProcessEnv = { MX_HUB: HUB_URL };
  if (OFFLINE) {
    extraEnv.MX_OFFLINE = "1";
    extraEnv.FACILITATOR_URL = `http://127.0.0.1:${MOCK_FACILITATOR_PORT}`;
    process.env.WALLET ??= "0.0.6001";
    child("mock-upstream", "src/mock/upstream.ts", [], { MOCK_UPSTREAM_PORT: String(MOCK_UPSTREAM_PORT) });
    child("mock-facilitator", "src/mock/facilitator.ts", [], { MOCK_FACILITATOR_PORT: String(MOCK_FACILITATOR_PORT) });
    await waitFor(`http://127.0.0.1:${MOCK_FACILITATOR_PORT}/supported`);
    await waitFor(`http://127.0.0.1:${MOCK_UPSTREAM_PORT}/price`);
    // A throwaway spender account for Metered Tabs, registered with the mock
    // facilitator so its allowance pulls are signature-checked like Hedera's.
    const { PrivateKey } = await import("@hiero-ledger/sdk");
    const spenderKey = PrivateKey.generateECDSA();
    const spenderId = process.env.TAB_SPENDER_ID ?? "0.0.7001";
    await fetch(`${extraEnv.FACILITATOR_URL}/accounts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: spenderId, publicKey: spenderKey.publicKey.toStringDer(), balance: String(10n * 100_000_000n) }),
    });
    extraEnv.TAB_SPENDER_ID = spenderId;
    extraEnv.TAB_SPENDER_KEY = spenderKey.toStringDer();
  }

  const lanesFile = resolve(ROOT, argv.includes("--lanes") ? argv[argv.indexOf("--lanes") + 1] : OFFLINE ? "lanes.offline.json" : "lanes.json");
  const cfg = JSON.parse(readFileSync(lanesFile, "utf8")) as { wallet: string; lanes: LaneSpec[] };
  const wallet = interpolate(cfg.wallet);
  if (!wallet) { console.error("✖ WALLET is unset: every payment needs a payout account. Set it in .env."); process.exit(1); }

  const hubArgs: string[] = [];
  if (process.env.DEMO_REPLAY === "1") hubArgs.push("--replay", process.env.SEED_FILE ?? "seed.jsonl");
  else hubArgs.push("--tape", process.env.TAPE_FILE ?? (OFFLINE ? "tape.offline.jsonl" : "tape.jsonl"));
  child("hub", "src/hub.ts", hubArgs, extraEnv);
  await waitFor(`${HUB_URL}/status`);
  // The Graph: one standardized query over every Messari DEX subgraph, sold by
  // the dex-pools lanes. Needs a Graph API key; without one those lanes skip.
  if (!OFFLINE && process.env.GRAPH_API_KEY) {
    const graphPort = process.env.MX_GRAPH_PORT ?? "4130";
    child("graph", "src/graph/server.ts", [], { MX_GRAPH_PORT: graphPort });
    await waitFor(`http://127.0.0.1:${graphPort}/health`);
    process.env.MX_GRAPH_URL = `http://127.0.0.1:${graphPort}`;
  }
  console.log(`✅ hub is up on :${HUB_PORT}, starting ${cfg.lanes.length} lane(s) from ${lanesFile}`);

  // Tabs need a spender account to pull the allowance with.
  const tabsPossible = !!(extraEnv.TAB_SPENDER_ID ?? process.env.TAB_SPENDER_ID ?? process.env.HEDERA_ACCOUNT_ID);
  if (!tabsPossible && cfg.lanes.some((l) => l.tab)) console.warn("⏭️  tabs disabled: set TAB_SPENDER_ID/TAB_SPENDER_KEY (or HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY) to offer them");

  let started = 0;
  for (const lane of cfg.lanes) {
    const args = laneArgs(lane, wallet, tabsPossible);
    if (!args) { console.warn(`⏭️  skipping "${lane.name}": an env var it needs is unset`); continue; }
    child(`lane:${lane.name}`, "src/cli-entry.ts", args, extraEnv);
    started++;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!started) console.warn("⚠️  no lanes started: the dashboard will have nothing to sell.");
  console.log(`\n🚀 MeterX402 is live on http://localhost:${HUB_PORT}${OFFLINE ? "  (offline demo: mock upstream + mock facilitator)" : ""}\n`);
}

main().catch((e) => { console.error("serve failed:", e instanceof Error ? e.message : String(e)); shutdown(1); });
