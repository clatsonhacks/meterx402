// The hub: one process every gateway and dashboard talks to (port of GlassBox402's).
//   - receives MXEvents from gateways, broadcasts them over a websocket
//   - records every event to the tape (JSONL), hydrates from it at boot,
//     `--replay <file>` plays a recorded session at original timing
//   - aggregates analytics (units, per-call price spread, savings vs flat)
//   - writes an HCS receipt per settled payment (units, rate, amount, body hash)
//   - holds each lane's pricing policy (World ID tiers)
//   - runs the dashboard's test buyer with the buyer's own limits, including
//     opening a Metered Tab and streaming a response through it
//   - serves the dashboard (public/) on the same origin
//   - runs the SERVICE REGISTRY (discovery) and the REPUTATION engine:
//       GET  /registry/services?capability=&maxPrice=&minReputation=&q=&unit=&network=&iface=
//       GET  /registry/services/:id            descriptor + reputation + price
//       POST /registry/services                publish / update a ServiceDescriptor
//       GET  /registry/services/:id/reputation a ReputationRecord
//       POST /registry/services/:id/disputes   a buyer disputes a paid call (anchored on HCS)
//       GET  /registry/receipts?service=&buyer=
//       POST /registry/reputation/anchor       snapshot every score to HCS

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { loadEnv, ROOT } from "./env.ts";
import { HUB_PORT, mxe, type MXEvent } from "./events.ts";
import { Analytics } from "./analytics.ts";
import { verifyWorldProof, issueSessionToken, rpContext, worldLive, worldMode } from "./world.ts";
import { hederaEnabled, ensureTopic, hederaReceipt, resolveOrCreateAccount, lookupAccount, type HederaAccount } from "./hedera.ts";
import { createHash } from "node:crypto";
import { Registry, type SearchFilter } from "./registry/registry.ts";
import { ReputationEngine } from "./registry/reputation.ts";
import { Dispute, PROTOCOL_VERSION, SettlementReceipt } from "./protocol/schemas.ts";
import { slug } from "./protocol/describe.ts";

loadEnv();

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : null);
const replayFile = arg("replay");
const tapeFile = arg("tape") ?? resolve(ROOT, "tape.jsonl");
const seedFile = arg("seed");
const OFFLINE = process.env.MX_OFFLINE === "1";

const lanes = new Map<string, Record<string, unknown>>();    // lane → lane_up data
const policies = new Map<string, Record<string, unknown>>(); // lane → pricing policy
const accounts = new Map<string, Promise<HederaAccount | null>>();
const ring: MXEvent[] = []; // recent events, replayed to fresh dashboards
const RING_MAX = 800;
const analytics = new Analytics();
const wss = new WebSocketServer({ noServer: true });
let hcsTopic: string | null = null;

// ── registry + reputation ─────────────────────────────────────────────────
const registry = new Registry(arg("registry") ?? resolve(ROOT, OFFLINE ? "registry.offline.json" : "registry.json"));
const reputation = new ReputationEngine();
const receipts: SettlementReceipt[] = [];            // newest last, capped
const paidQuotes = new Map<string, { service: string; buyer: string }>(); // who may dispute what
const disputed = new Set<string>();
const serviceIdOf = (lane: string) => registry.byLane(lane)?.descriptor.service_id ?? slug(lane);

/** Everything the payment layer does is reputation evidence. */
function evidence(ev: MXEvent) {
  const id = serviceIdOf(ev.lane);
  reputation.ingest(id, ev);
  const r = SettlementReceipt.safeParse(ev.data?.receipt);
  if ((ev.type === "settled" || ev.type === "tab_flush") && r.success) {
    receipts.push(r.data);
    if (receipts.length > 5000) receipts.shift();
    if (r.data.quote_id) paidQuotes.set(r.data.quote_id, { service: r.data.service_id, buyer: r.data.buyer });
  }
  if (ev.type === "dispute" && typeof ev.data?.quote_id === "string") disputed.add(ev.data.quote_id);
}

const typicalCharge = (id: string) => {
  const e = registry.get(id);
  if (!e) return null;
  const snap = analytics.snapshot([e.lane]).byLane[e.lane];
  return snap && snap.totalRequests ? snap.charges.p50 : null;
};

function isLocal(req: IncomingMessage) {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
/** Publishing is open on loopback (gateways on this machine) or with the
 *  registry token; anyone can read. */
const mayPublish = (req: IncomingMessage) =>
  isLocal(req) || (!!process.env.MX_REGISTRY_TOKEN && req.headers["x-mx402-registry-token"] === process.env.MX_REGISTRY_TOKEN);

// Liveness: probe every registered service's descriptor. This is the uptime
// component of reputation, and what hides dead services from discovery.
async function probeAll() {
  await Promise.all(registry.all().map(async (e) => {
    let up = false;
    try { up = (await fetch(e.descriptor.links.descriptor, { signal: AbortSignal.timeout(2500) })).ok; } catch {}
    reputation.probe(e.descriptor.service_id, up);
    registry.setLive(e.descriptor.service_id, up);
  }));
}
const probeTimer = setInterval(() => void probeAll(), Number(process.env.MX_PROBE_MS ?? 10_000));
probeTimer.unref?.();

// ── HCS receipts ──────────────────────────────────────────────────────────
// One public, consensus-timestamped message per settled call. Read the topic off
// the mirror node and it has to match the payments table row for row, including
// the unit count each price was computed from. Fire-and-forget: without
// operator credentials, payments and the dashboard work exactly the same.
async function receiptFor(ev: MXEvent) {
  if (!hederaEnabled() || replayFile) return;
  try {
    const d = ev.data;
    const r = await hederaReceipt(JSON.stringify({
      mx402: "metered-settlement", lane: ev.lane, from: d.from, unit: d.unit, units: d.units, measured: d.measured,
      cap: d.cap, rate: d.rate, per: d.per, amount: d.amount, currency: d.currency, payTo: d.payTo,
      bodySha256: d.bodySha256, tx: d.txHash, t: ev.t,
    }));
    hcsTopic = r.topicId;
    broadcast(mxe("hcs_receipt", ev.lane, ev.reqId, { topicId: r.topicId, hashscan: r.hashscan, topicUrl: `https://hashscan.io/testnet/topic/${r.topicId}`, tx: d.txHash }));
  } catch (e) {
    console.error("hcs receipt failed:", String(e).split("\n")[0]);
  }
}

function broadcast(ev: MXEvent, record = true) {
  if (ev.type === "lane_up") {
    const known = lanes.has(ev.lane);
    lanes.set(ev.lane, { name: ev.lane, ...ev.data, lastSeen: Date.now() });
    // a gateway coming up registers (or refreshes) its service
    if (ev.data.descriptor) {
      try { registry.upsert(ev.data.descriptor, { lane: ev.lane, source: "gateway" }); }
      catch (e) { console.error(`registry: ${ev.lane} sent an invalid descriptor:`, String(e).split("\n")[0]); }
    }
    // heartbeats keep a lane registered across hub restarts; they are not news
    if (ev.data.heartbeat && known) return;
  }
  if (ev.type === "settled") { analytics.ingest(ev.lane, ev.data as any, ev.t); void receiptFor(ev); }
  if (ev.type === "policy") policies.set(ev.lane, ev.data);
  evidence(ev);
  ring.push(ev);
  if (ring.length > RING_MAX) ring.shift();
  if (record && !replayFile) { try { appendFileSync(tapeFile, JSON.stringify(ev) + "\n"); } catch {} }
  const msg = JSON.stringify(ev);
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(msg);
}

function portAlive(port: number, timeout = 350): Promise<boolean> {
  return new Promise((done) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const end = (ok: boolean) => { sock.destroy(); done(ok); };
    sock.setTimeout(timeout);
    sock.once("connect", () => end(true));
    sock.once("timeout", () => end(false));
    sock.once("error", () => end(false));
  });
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-allow-private-network": "true",
};
function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

// ── the dashboard's buyer ─────────────────────────────────────────────────
// A real x402 client with the buyer's limits. Online it signs as BUYER_* (or
// the operator). Offline it uses a throwaway key registered with the mock
// facilitator, so signatures are still genuinely checked.
let buyerP: Promise<import("./paid-fetch.ts").MeteredBuyer | null> | null = null;
function buyer() {
  buyerP ??= (async () => {
    const { buyerFromEnv, createMeteredBuyer } = await import("./paid-fetch.ts");
    let b = buyerFromEnv();
    if (b && !OFFLINE) return b;
    if (!OFFLINE || !process.env.FACILITATOR_URL) return b;
    // Offline: whatever account we sign as (from .env or a throwaway) has to
    // exist on the mock ledger, or its signatures verify against nothing.
    if (!b) {
      const { PrivateKey } = await import("@hiero-ledger/sdk");
      const key = PrivateKey.generateECDSA();
      b = createMeteredBuyer({ accountId: process.env.OFFLINE_BUYER_ID ?? "0.0.5001", privateKey: key });
    }
    await fetch(`${process.env.FACILITATOR_URL}/accounts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: b.accountId, publicKey: b.publicKeyDer, balance: String(100n * 100_000_000n) }),
    }).catch(() => {});
    return b;
  })().catch((e) => { buyerP = null; throw e; });
  return buyerP;
}

// One tab per lane for the dashboard's streaming demo. Opening a tab approves a
// real HBAR allowance, so it is done once and reused until it is exhausted.
const tabs = new Map<string, Promise<import("./paid-fetch.ts").TabSession>>();
function tabFor(lane: string, port: number, allowance = process.env.DEMO_TAB_ALLOWANCE ?? "0.05") {
  let t = tabs.get(lane);
  if (!t) {
    t = (async () => {
      const b = await buyer();
      if (!b) throw new Error("no buyer wallet configured");
      return b.openTab(`http://127.0.0.1:${port}`, { allowance });
    })().catch((e) => { tabs.delete(lane); throw e; });
    tabs.set(lane, t);
  }
  return t;
}

// ── static dashboard ──────────────────────────────────────────────────────
const PUBLIC = resolve(ROOT, "public");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };
function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const target = resolve(PUBLIC, "." + decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
  if (target !== PUBLIC && !target.startsWith(PUBLIC + sep)) return false; // path traversal
  let file = target;
  try { if (!statSync(file).isFile()) throw 0; } catch {
    if (extname(target)) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return true; }
    file = resolve(PUBLIC, "index.html");
    if (!existsSync(file)) return false;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  if (req.method === "HEAD") { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://hub");
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  try {
    if (req.method === "POST" && url.pathname === "/event") {
      broadcast(await readBody(req));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/lanes") {
      // self-healing directory: only lanes whose gateway still listens
      const entries = [...lanes.entries()];
      const checks = await Promise.all(entries.map(async ([name, l]) => ({ name, l, alive: await portAlive(Number(l.port)) })));
      for (const c of checks) if (!c.alive) lanes.delete(c.name);
      return json(res, 200, { lanes: checks.filter((c) => c.alive).map((c) => ({ ...c.l, policy: policies.get(c.name) ?? {} })) });
    }
    // ── registry ────────────────────────────────────────────────────────
    if (url.pathname === "/registry/services" && req.method === "GET") {
      const q = url.searchParams;
      const num = (k: string) => (q.get(k) != null && q.get(k) !== "" ? Number(q.get(k)) : undefined);
      const filter: SearchFilter = {
        capability: q.get("capability") ?? undefined, q: q.get("q") ?? undefined,
        maxPrice: num("maxPrice"), minReputation: num("minReputation"),
        unit: q.get("unit") ?? undefined, network: q.get("network") ?? undefined,
        currency: q.get("currency") ?? undefined, iface: q.get("iface") ?? undefined,
        live: q.get("live") === "all" ? false : true,
      };
      return json(res, 200, { mx402: PROTOCOL_VERSION, services: registry.search(filter, (id) => reputation.record(id), typicalCharge) });
    }
    if (url.pathname === "/registry/services" && req.method === "POST") {
      if (!mayPublish(req)) return json(res, 403, { ok: false, error: "publishing needs loopback access or x-mx402-registry-token" });
      const body = await readBody(req);
      try {
        const entry = registry.upsert(body.descriptor ?? body, { lane: body.lane ?? (body.descriptor ?? body).service_id, source: "publish" });
        broadcast(mxe("service_published", entry.lane, crypto.randomUUID(), { service_id: entry.descriptor.service_id, capabilities: entry.descriptor.capabilities }));
        return json(res, 200, { ok: true, service: entry.descriptor });
      } catch (e: any) {
        return json(res, 400, { ok: false, error: "invalid ServiceDescriptor", issues: e?.issues ?? String(e) });
      }
    }
    if (url.pathname === "/registry/receipts") {
      const svc = url.searchParams.get("service"), who = url.searchParams.get("buyer");
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 50));
      const out = receipts.filter((r) => (!svc || r.service_id === svc) && (!who || r.buyer === who)).slice(-limit).reverse();
      return json(res, 200, { receipts: out });
    }
    if (url.pathname === "/registry/reputation/anchor" && req.method === "POST") {
      // Publish every score's evidence summary to HCS: a consensus-timestamped
      // snapshot anyone can compare against the registry later.
      const records = registry.all().map((e) => reputation.record(e.descriptor.service_id));
      const summary = records.map((r) => ({ id: r.service_id, score: r.score, n: r.sample_size, c: r.components }));
      const digest = createHash("sha256").update(JSON.stringify(summary)).digest("hex");
      if (!hederaEnabled()) return json(res, 200, { ok: false, error: "HCS anchoring needs HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY (not offline)", digest, services: summary });
      try {
        const r = await hederaReceipt(JSON.stringify({ mx402: "reputation-snapshot", v: PROTOCOL_VERSION, digest, at: Date.now(), services: summary.map((x) => ({ id: x.id, score: x.score, n: x.n })) }));
        for (const rec of records) reputation.setAnchor(rec.service_id, { topic_id: r.topicId, transaction_id: r.txId, digest });
        broadcast(mxe("reputation_anchor", "registry", crypto.randomUUID(), { topicId: r.topicId, tx: r.txId, hashscan: r.hashscan, digest, services: summary.length }));
        return json(res, 200, { ok: true, topic_id: r.topicId, transaction_id: r.txId, hashscan: r.hashscan, digest, services: summary });
      } catch (e) {
        return json(res, 502, { ok: false, error: String(e).split("\n")[0] });
      }
    }
    {
      const m = /^\/registry\/services\/([^/]+)(\/reputation|\/disputes)?$/.exec(url.pathname);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const entry = registry.get(id);
        if (!entry) return json(res, 404, { ok: false, error: `no service ${id}` });
        if (!m[2] && req.method === "DELETE") {
          if (!mayPublish(req)) return json(res, 403, { ok: false, error: "forbidden" });
          registry.remove(id);
          return json(res, 200, { ok: true });
        }
        if (!m[2]) {
          const [listing] = registry.search({ live: false, q: undefined }, (x) => reputation.record(x), typicalCharge).filter((l) => l.service_id === id);
          return json(res, 200, listing);
        }
        if (m[2] === "/reputation") return json(res, 200, reputation.record(id));
        if (m[2] === "/disputes" && req.method === "POST") {
          // Phase 9: a buyer whose re-metering or body hash disagrees with the
          // quote files a dispute. Only a buyer who actually paid for that quote
          // can dispute it, once; the dispute is public (HCS) and costs the
          // seller reputation.
          const parsed = Dispute.safeParse({ mx402: PROTOCOL_VERSION, filed_at: Date.now(), service_id: id, ...(await readBody(req)) });
          if (!parsed.success) return json(res, 400, { ok: false, error: "invalid Dispute", issues: parsed.error.issues });
          const d = parsed.data;
          const paid = d.quote_id ? paidQuotes.get(d.quote_id) : undefined;
          if (!paid || paid.service !== id || paid.buyer !== d.buyer) return json(res, 403, { ok: false, error: "no settled payment by this buyer for that quote" });
          if (disputed.has(d.quote_id!)) return json(res, 409, { ok: false, error: "already disputed" });
          broadcast(mxe("dispute", entry.lane, crypto.randomUUID(), d as unknown as Record<string, unknown>));
          let hcs: { topicId: string; txId: string; hashscan: string } | null = null;
          if (hederaEnabled()) { try { hcs = await hederaReceipt(JSON.stringify({ kind: "mx402-dispute", ...d })); } catch {} }
          return json(res, 200, { ok: true, dispute: d, hcs, reputation: reputation.record(id) });
        }
        return json(res, 405, { ok: false, error: "method not allowed" });
      }
    }
    if (url.pathname === "/analytics") {
      // ?lanes=a,b scopes to the caller's own APIs; absent = every live lane
      const want = url.searchParams.get("lanes");
      const live = [...lanes.keys()];
      const keys = want == null ? live : live.filter((k) => want.split(",").includes(k));
      return json(res, 200, analytics.snapshot(keys));
    }
    if (url.pathname.startsWith("/policy/")) {
      const lane = decodeURIComponent(url.pathname.slice("/policy/".length));
      if (req.method === "POST") {
        const body = await readBody(req);
        const next = { ...(policies.get(lane) ?? {}), ...body };
        broadcast(mxe("policy", lane, crypto.randomUUID(), next));
        return json(res, 200, { ok: true, policy: next });
      }
      return json(res, 200, { policy: policies.get(lane) ?? {} });
    }
    if (url.pathname === "/world/context") {
      const ctx = await rpContext().catch(() => null);
      return json(res, 200, ctx ? { live: true, ...ctx } : { live: false, mode: worldMode() });
    }
    if (req.method === "POST" && url.pathname === "/world/verify") {
      const { proof, wallet } = await readBody(req);
      if (worldLive()) {
        const v = await verifyWorldProof(proof);
        if (!v.ok) return json(res, 200, { ok: false, error: v.error });
        return json(res, 200, { ok: true, token: issueSessionToken(v.nullifier!, false), simulated: false });
      }
      // World not configured: mint a signed but SIMULATED session, labelled as such everywhere
      return json(res, 200, { ok: true, token: issueSessionToken(`sim_${String(wallet ?? "anon").toLowerCase()}`, true), simulated: true, mode: worldMode() });
    }
    if (req.method === "POST" && url.pathname === "/account") {
      const { addr } = await readBody(req);
      if (typeof addr !== "string" || !addr.trim()) return json(res, 400, { ok: false, error: "addr required" });
      if (OFFLINE) return json(res, 200, { ok: false, error: "offline" });
      const key = addr.trim().toLowerCase();
      let pending = accounts.get(key);
      if (!pending) {
        pending = resolveOrCreateAccount(key).catch((e) => { accounts.delete(key); throw e; });
        accounts.set(key, pending);
      }
      try {
        const acct = await pending;
        return json(res, 200, acct ? { ok: true, ...acct } : { ok: false, error: "unresolved", addr: key });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e).split("\n")[0] });
      }
    }
    if (url.pathname === "/balance") {
      const acct = url.searchParams.get("account");
      if (!acct || OFFLINE) return json(res, 200, { ok: false });
      const a = await lookupAccount(acct);
      return json(res, 200, a ? { ok: true, ...a } : { ok: false });
    }
    // Stream a metered response to the dashboard over a tab, and forward each
    // chunk as it arrives. This is the one path that can stream: the allowance
    // is already approved, so there is nothing to withhold until payment.
    if (url.pathname === "/teststream") {
      const laneName = url.searchParams.get("lane") ?? "";
      const lane = lanes.get(laneName);
      if (!lane?.tabs) return json(res, 404, { error: "no such lane, or it does not offer tabs" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...CORS });
      const sse = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      try {
        const tab = await tabFor(laneName, Number(lane.port));
        const prompt = url.searchParams.get("prompt") || "Explain metered x402 payments in 60 words";
        const maxUnits = url.searchParams.get("maxUnits");
        const base = (() => { try { return JSON.parse(String(lane.sampleBody ?? "{}")); } catch { return {}; } })();
        const body = JSON.stringify({ ...base, messages: [{ role: "user", content: prompt }], stream: true });
        sse("open", { tab: tab.tabId, allowance: tab.allowance, lane: laneName, spender: tab.terms.spender });
        for await (const part of tab.stream(`http://127.0.0.1:${lane.port}${lane.sample ?? "/"}`, { method: "POST", body, maxUnits: maxUnits ? Number(maxUnits) : undefined })) {
          sse(part.type, part);
        }
      } catch (e) {
        sse("error", { error: String((e as Error)?.message ?? e).split("\n")[0] });
      }
      return res.end();
    }
    // Settle and close the dashboard's tab for a lane.
    if (req.method === "POST" && url.pathname === "/testtab/close") {
      const { lane } = await readBody(req);
      const t = tabs.get(String(lane));
      if (!t) return json(res, 200, { ok: false, error: "no open tab" });
      tabs.delete(String(lane));
      try { return json(res, 200, { ok: true, ...(await (await t).close()) }); }
      catch (e) { return json(res, 200, { ok: false, error: String(e).split("\n")[0] }); }
    }
    if (req.method === "POST" && url.pathname === "/testbuyer") {
      const { url: target, method, body, maxUnits, maxPerCall, verified, worldToken } = await readBody(req);
      const b = await buyer().catch(() => null);
      if (!b) return json(res, 200, { ok: false, error: "no buyer wallet: set BUYER_ACCOUNT_ID/BUYER_PRIVATE_KEY (or HEDERA_*) in .env" });
      const headers: Record<string, string> = {};
      if (worldToken) headers["x-world-proof"] = worldToken;
      else if (verified) headers["x-world-proof"] = issueSessionToken("sim_testbuyer", !worldLive());
      try {
        const r = await b.buy(target, {
          method: method && method !== "GET" ? method : "GET",
          body: method && method !== "GET" && body != null ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
          headers,
          maxUnits: maxUnits ? Number(maxUnits) : undefined,
          maxPerCall: maxPerCall || undefined,
        });
        const hashscan = r.receipt?.txHash ? `https://hashscan.io/testnet/transaction/${r.receipt.txHash.replace("@", "-").replace(/\.(\d+)$/, "-$1")}` : undefined;
        return json(res, 200, { ok: r.res.ok, status: r.status, body: r.body.slice(0, 20000), paid: r.paid, receipt: r.receipt, hashscan, buyer: b.accountId, spent: b.spent() });
      } catch (e: any) {
        return json(res, 200, { ok: false, refused: e?.name === "BuyerLimitError" || !!e?.quote, quote: e?.quote, error: String(e?.message ?? e).split("\n")[0] });
      }
    }
    const status = {
      ok: true, service: "meterx402-hub", mode: replayFile ? "replay" : OFFLINE ? "offline" : "live",
      facilitator: process.env.FACILITATOR_URL ?? "https://api.testnet.blocky402.com",
      hcsTopic, hcsTopicUrl: hcsTopic ? `https://hashscan.io/testnet/topic/${hcsTopic}` : null,
      world: worldMode(), lanes: lanes.size, services: registry.all().length,
    };
    if (url.pathname === "/status") return json(res, 200, status);
    if (url.pathname === "/" && !(req.headers.accept ?? "").includes("text/html")) return json(res, 200, status);
    if (serveStatic(req, res, url.pathname)) return;
    return json(res, 404, { error: "not_found" });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e) });
  }
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
    for (const ev of ring) ws.send(JSON.stringify(ev)); // catch a fresh dashboard up
  });
});

server.listen(HUB_PORT, () => {
  console.log(`⚡ meterx402 hub on :${HUB_PORT}  (${replayFile ? `REPLAY ${replayFile}` : `tape ${tapeFile}`}${OFFLINE ? ", OFFLINE" : ""})`);
  if (replayFile) startReplay(replayFile);
  else hydrate();
  if (registry.all().length) console.log(`📚 registry: ${registry.all().length} service(s) on file, probing for liveness`);
  setTimeout(() => void probeAll(), 1500);
  if (hederaEnabled() && !replayFile) {
    ensureTopic().then((t) => { hcsTopic = t; }).catch((e) => console.error("hcs topic unavailable, receipts disabled:", String(e).split("\n")[0]));
  } else if (!replayFile) {
    console.log(`🪵 HCS receipts off (${OFFLINE ? "offline mode" : "no HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY"})`);
  }
});

// Analytics and policies live in memory; the tape has the history. Hydrate the
// aggregates and the replay ring WITHOUT going through broadcast(), which would
// re-append every event to the tape and re-fire an HCS receipt per payment.
function hydrate() {
  const REPLAYABLE = new Set(["settled", "hedera_receipt", "hcs_receipt", "policy", "metered", "quote_402", "free", "tab_flush", "dispute", "reputation_anchor", "service_published"]);
  const history: MXEvent[] = [];
  for (const [file, label] of [[seedFile, "seed"], [tapeFile, "tape"]] as const) {
    if (!file || !existsSync(file)) continue;
    let payments = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let ev: MXEvent;
      try { ev = JSON.parse(line); } catch { continue; } // a half-written last line is normal
      evidence(ev);
      if (ev.type === "settled") { analytics.ingest(ev.lane, ev.data as any, ev.t); payments++; }
      else if (ev.type === "policy") policies.set(ev.lane, ev.data);
      if (REPLAYABLE.has(ev.type)) history.push(ev);
    }
    if (payments) console.log(`📊 hydrated ${payments} payments from ${label} (${file})`);
  }
  ring.unshift(...history.slice(-300));
}

function startReplay(file: string) {
  const events: MXEvent[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!events.length) return console.error("empty tape");
  console.log(`📼 replaying ${events.length} events at original timing…`);
  const t0 = events[0].t;
  for (const ev of events) setTimeout(() => broadcast({ ...ev, t: Date.now() }, false), ev.t - t0);
}
