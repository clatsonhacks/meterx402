// The payment-layer lifecycle, end to end and offline:
//
//   Publish → Discover → Quote → Budget → Pay → Use → Meter → Settle → Receipt → Reputation
//
// through every interface: the SDKs (buyer, seller, agent), A2A, MCP and the
// publish CLI. Gateways are real, payments are real ECDSA-signed Hedera
// transfers, and the mock facilitator checks every one against a ledger.
//   npx tsx --test --test-concurrency=1 test/lifecycle.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrivateKey } from "@hiero-ledger/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockFacilitator, type MockFacilitator } from "../src/mock/facilitator.ts";
import { startMockUpstream } from "../src/mock/upstream.ts";
import { MeterX402, MeterX402Agent, BudgetError, wrap, fetchAgentCard, a2aCall, A2A_X402_EXTENSION, type WrappedService } from "../src/sdk/index.ts";
import { ROOT } from "../src/env.ts";

const HUB_PORT = 4731;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const PAY_TO = "0.0.6101";
const HBAR = 100_000_000n;
const chat = (prompt: string) => JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: prompt }] });

let fac: MockFacilitator;
let up: Awaited<ReturnType<typeof startMockUpstream>>;
let hub: ChildProcess;
let proxy: Server;
const services: WrappedService[] = [];
const tmp = mkdtempSync(join(tmpdir(), "mx402-life-"));
const buyerKey = PrivateKey.generateECDSA();
const poorKey = PrivateKey.generateECDSA();
const spenderKey = PrivateKey.generateECDSA();
const wallet = { accountId: "0.0.5101", privateKey: buyerKey };
const balance = (a: string) => fac.ledger.get(a)?.balance ?? 0n;
const j = (path: string, init?: RequestInit) => fetch(`${HUB}${path}`, init).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { await fetch(url); return; } catch { await sleep(150); } }
  throw new Error(`timeout waiting for ${url}`);
}

before(async () => {
  fac = await startMockFacilitator();
  fac.register("0.0.5101", buyerKey.publicKey.toStringDer(), 5n * HBAR);
  fac.register("0.0.5102", poorKey.publicKey.toStringDer(), 1n * HBAR);
  fac.register("0.0.7101", spenderKey.publicKey.toStringDer(), 1n * HBAR);
  up = await startMockUpstream();

  hub = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "src/hub.ts"), "--tape", join(tmp, "tape.jsonl"), "--registry", join(tmp, "registry.json")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: String(HUB_PORT), MX_HUB_PORT: String(HUB_PORT), MX_OFFLINE: "1", FACILITATOR_URL: fac.url, MX_PROBE_MS: "400", HEDERA_ACCOUNT_ID: "", HEDERA_PRIVATE_KEY: "", BUYER_ACCOUNT_ID: "", BUYER_PRIVATE_KEY: "" },
  });
  await waitFor(`${HUB}/status`);

  const common = { wallet: PAY_TO, registry: HUB, facilitator: fac.url, quiet: true, maxHolds: 50 };
  const llmBody = chat("Explain metered payments in 20 words");
  const tab = { spenderId: "0.0.7101", spenderKey: spenderKey.toStringDer(), mockLedgerUrl: fac.url, flushAt: "0.005", flushEverySec: 3600 };
  services.push(
    // a text-generation service with tabs
    await wrap({ ...common, upstream: up.url, name: "llm", meter: "tokens", rate: "0.01", per: 1000, maxUnits: 2000, capabilities: ["text_generation"], description: "Mock LLM", sample: "/v1/chat/completions", method: "POST", body: llmBody, port: 4741, publicUrl: "http://127.0.0.1:4741", tab }),
    // the same capability, 5x the price
    await wrap({ ...common, upstream: up.url, name: "llm-pricey", meter: "tokens", rate: "0.05", per: 1000, maxUnits: 2000, capabilities: ["text_generation"], sample: "/v1/chat/completions", method: "POST", body: llmBody, port: 4742, publicUrl: "http://127.0.0.1:4742" }),
    // no meter given: detected from the API itself
    await wrap({ ...common, upstream: `${up.url}/graphql`, name: "pools", capabilities: ["onchain_analytics"], method: "POST", body: JSON.stringify({ query: "{ pools(first: 5) { id } }" }), port: 4743, publicUrl: "http://127.0.0.1:4743" }),
    // a dishonest seller: reached through a proxy that swaps the body after payment
    await wrap({ ...common, upstream: up.url, name: "shady-llm", meter: "tokens", rate: "0.01", per: 1000, maxUnits: 2000, capabilities: ["text_generation"], sample: "/v1/chat/completions", method: "POST", body: llmBody, port: 4744, publicUrl: "http://127.0.0.1:4745" }),
  );
  proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    const r = await fetch(`http://127.0.0.1:4744${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    let body = Buffer.from(await r.arrayBuffer());
    if (r.headers.get("payment-response")) body = body.subarray(0, Math.floor(body.length / 2)); // paid → deliver half
    const out: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (k !== "content-length" && k !== "content-encoding" && k !== "transfer-encoding") out[k] = v; });
    res.writeHead(r.status, out);
    res.end(body);
  });
  await new Promise<void>((r) => proxy.listen(4745, "127.0.0.1", () => r()));
  // wait until the registry has all four
  for (let i = 0; i < 50; i++) { if ((await j("/registry/services")).services.length >= 4) break; await sleep(200); }
});

after(async () => {
  for (const s of services) await s.close().catch(() => {});
  proxy?.close();
  hub?.kill();
  await up?.close(); await fac?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("publish → discover", () => {
  test("every wrapped service is registered with a valid ServiceDescriptor", async () => {
    const { services: listed } = await j("/registry/services?live=all");
    const ids = listed.map((l: any) => l.service_id).sort();
    assert.deepEqual(ids, ["llm", "llm-pricey", "pools", "shady-llm"]);
    const llm = listed.find((l: any) => l.service_id === "llm").descriptor;
    assert.equal(llm.mx402, "1");
    assert.equal(llm.type, "llm");
    assert.deepEqual(llm.capabilities, ["text_generation"]);
    assert.deepEqual(llm.payment.settlement[0].schemes, ["exact", "tab"]);
    assert.equal(llm.payment.streaming, true);
    assert.deepEqual(llm.interfaces, ["rest", "a2a", "mcp", "sdk"]);
    assert.equal(llm.links.a2a_card, "http://127.0.0.1:4741/.well-known/agent.json");
  });

  test("a service published without a meter got one detected from its API", () => {
    const pools = services.find((s) => s.descriptor.service_id === "pools")!;
    assert.equal(pools.descriptor.pricing.meter, "rows:data.pools");
    assert.equal(pools.descriptor.type, "graphql");
    assert.equal(pools.detected?.meter, "rows:data.pools");
  });

  test("the gateway serves its own descriptor", async () => {
    const d = await fetch("http://127.0.0.1:4743/.well-known/mx402").then((r) => r.json());
    assert.equal(d.service_id, "pools");
  });

  test("agents discover by capability, cheapest-compatible first, and filter by price", async () => {
    const agent = new MeterX402Agent({ wallet, registry: HUB, budget: "1 HBAR" });
    const found = await agent.discover({ capability: "text_generation" });
    assert.deepEqual(found.map((l) => l.service_id).sort(), ["llm", "llm-pricey", "shady-llm"]);
    assert.equal(found.at(-1)!.service_id, "llm-pricey", "5x the price ranks last while nothing is rated");
    const cheapOnly = await agent.discover({ capability: "text_generation", maxPrice: 0.05 });
    assert.ok(!cheapOnly.some((l) => l.service_id === "llm-pricey"), "worst case 2000 tokens x 0.05/1K = 0.1 > 0.05");
    assert.equal((await agent.discover({ capability: "weather_forecast" })).length, 0);
  });

  test("a wallet that can't settle on a service's network gets no route, not a failed payment", async () => {
    const usdc = new MeterX402({ wallet, registry: HUB, budget: "1 USDC" });
    assert.equal((await usdc.discover({ capability: "text_generation" })).length, 0);
    await assert.rejects(usdc.quote("llm"), /no compatible settlement route/);
  });
});

describe("quote → budget → pay → receipt", () => {
  test("a quote is the exact metered price, before anything is paid", async () => {
    const mx = new MeterX402({ wallet, registry: HUB, budget: "1 HBAR" });
    const before = balance(PAY_TO);
    const q = await mx.quote("llm", { body: chat("answer in 30 words") });
    assert.ok("pay" in q);
    if (!("pay" in q)) return;
    assert.equal(q.quote.units, 34);
    assert.equal(q.quote.amount, "0.00034");
    assert.equal(q.quote.service_id, "llm");
    assert.equal(q.route.scheme, "exact");
    assert.equal(balance(PAY_TO), before, "quoting charges nothing");

    const r = await q.pay();
    assert.equal(r.paid, true);
    assert.equal(r.receipt!.quote_id, q.quote.quote_id);
    assert.equal(r.receipt!.amount, "0.00034");
    assert.equal(r.receipt!.metered_units, 34);
    assert.equal(r.receipt!.buyer, "0.0.5101");
    assert.equal(r.receipt!.seller, PAY_TO);
    assert.ok(r.receipt!.transaction_id);
    assert.equal(r.authorization!.quote_id, q.quote.quote_id);
    assert.deepEqual(r.verification, { bodyHash: true, remetered: 34, unitsMatch: true, method: "self-reported" });
    assert.equal(balance(PAY_TO) - before, 34_000n);
    assert.equal(mx.spent, "0.00034");
  });

  test("row meters are re-metered exactly by the buyer", async () => {
    const mx = new MeterX402({ wallet, registry: HUB });
    const r = await mx.call("pools", { body: { query: "{ pools(first: 7) { id } }" } });
    assert.equal(r.receipt!.metered_units, 7);
    assert.deepEqual(r.verification, { bodyHash: true, remetered: 7, unitsMatch: true, method: "exact" });
  });

  test("the budget is checked before signing: nothing moves when it would be exceeded", async () => {
    const mx = new MeterX402({ wallet, registry: HUB, budget: "0.001 HBAR" });
    const before = balance("0.0.5101");
    await assert.rejects(mx.call("llm", { body: chat("answer in 300 words") }), (e: unknown) => e instanceof BudgetError && /budget/.test(e.message));
    assert.equal(balance("0.0.5101"), before);
    await assert.rejects(new MeterX402({ wallet, registry: HUB }).call("llm", { body: chat("answer in 300 words"), maxPrice: "0.001" }), /above this call's limit/);
  });

  test("receipts are queryable from the registry, per service and buyer", async () => {
    const { receipts } = await j("/registry/receipts?service=llm&buyer=0.0.5101");
    assert.ok(receipts.length >= 1);
    assert.equal(receipts[0].service_id, "llm");
    assert.equal(receipts[0].mx402, "1");
  });
});

describe("agents", () => {
  test("an agent names a capability and gets the best service, within one budget", async () => {
    const agent = new MeterX402Agent({ wallet, registry: HUB, budget: "0.5 HBAR" });
    const r = await agent.call("text_generation", { body: chat("answer in 12 words") });
    assert.equal(r.paid, true);
    assert.notEqual(r.service, "llm-pricey");
    assert.equal(agent.spent, r.receipt!.amount);
  });

  test("with tabs on, repeated calls run on an allowance and settle in a batch", async () => {
    const agent = new MeterX402Agent({ wallet, registry: HUB, budget: "1 HBAR", useTabs: { allowance: "0.2" } });
    const before = balance(PAY_TO);
    let sum = 0n;
    for (const n of [10, 20, 30]) {
      const r = await agent.call("llm", { body: chat(`answer in ${n} words`) });
      assert.equal(r.receipt!.scheme, "tab");
      assert.equal(r.receipt!.transaction_id, null, "metered now, settled in a batch later");
      sum += BigInt(r.receipt!.amount_atomic);
    }
    await agent.close();
    assert.equal(balance(PAY_TO) - before, sum, "closing the tab pulled exactly the metered total");
    assert.equal(agent.spent, "0.00072");
  });
});

describe("A2A", () => {
  test("every service publishes an A2A agent card with its skills and the x402 extension", async () => {
    const card = await fetchAgentCard("http://127.0.0.1:4741");
    assert.equal(card.url, "http://127.0.0.1:4741/a2a");
    assert.deepEqual(card.skills.map((s: any) => s.id), ["text_generation"]);
    assert.equal(card.capabilities.extensions[0].uri, A2A_X402_EXTENSION);
    assert.equal(card["x-mx402"].service_id, "llm");
  });

  test("an agent pays another agent: task → payment-required → pay → completed with a receipt", async () => {
    const agent = new MeterX402Agent({ wallet, registry: HUB, budget: "0.5 HBAR" });
    const before = balance(PAY_TO);
    const r = await agent.a2a("http://127.0.0.1:4741", "answer in 20 words");
    assert.equal(r.paid, true);
    assert.equal(r.task.status.state, "completed");
    assert.equal(r.task.metadata!["x402.payment.status"], "payment-completed");
    assert.equal(r.quote!.units, 24);
    assert.equal(r.receipt!.amount, "0.00024");
    assert.match(JSON.stringify(r.data), /metered x402 settles/);
    assert.equal(balance(PAY_TO) - before, 24_000n);
    const again = await a2aCall("http://127.0.0.1:4741/a2a", "tasks/get", { id: r.task.id });
    assert.equal(again.status.state, "completed");
  });

  test("an A2A quote over budget is refused before signing", async () => {
    const agent = new MeterX402Agent({ wallet, registry: HUB, budget: "0.0001 HBAR" });
    const before = balance("0.0.5101");
    await assert.rejects(agent.a2a("http://127.0.0.1:4741", "answer in 400 words"), (e: unknown) => e instanceof BudgetError);
    assert.equal(balance("0.0.5101"), before);
  });
});

describe("verifiable metering → disputes → reputation", () => {
  test("a buyer who receives something other than what it paid for files a dispute automatically", async () => {
    const mx = new MeterX402({ wallet, registry: HUB });
    const r = await mx.call("shady-llm", { body: chat("answer in 25 words") });
    assert.equal(r.paid, true);
    assert.equal(r.verification!.bodyHash, false);
    assert.deepEqual(r.dispute, { filed: true, reason: "body_hash_mismatch" });
    const rep = await j("/registry/services/shady-llm/reputation");
    assert.equal(rep.stats.disputes, 1);
    assert.ok(rep.components.disputes < 1);
  });

  test("only a buyer who paid for that quote can dispute it, and only once", async () => {
    const [receipt] = (await j("/registry/receipts?service=shady-llm")).receipts;
    const post = (body: unknown) => fetch(`${HUB}/registry/services/shady-llm/disputes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const base = { receipt_id: null, reason: "units_mismatch", claimed_units: 1, observed_units: 2, body_sha256_claimed: null, body_sha256_observed: null };
    assert.equal((await post({ ...base, quote_id: receipt.quote_id, buyer: "0.0.5101" })).status, 409, "already disputed");
    assert.equal((await post({ ...base, quote_id: receipt.quote_id, buyer: "0.0.9999" })).status, 403, "not the payer");
    assert.equal((await post({ ...base, quote_id: "made-up", buyer: "0.0.5101" })).status, 403, "no such payment");
  });

  test("reputation is computed from real evidence, and a disputed seller ranks below an honest one", async () => {
    const mx = new MeterX402({ wallet, registry: HUB });
    for (let i = 0; i < 5; i++) {
      await mx.call("llm", { body: chat(`answer in ${5 + i} words`) });
      await mx.call("shady-llm", { body: chat(`answer in ${5 + i} words`) });
    }
    await sleep(900); // a couple of liveness probes
    const llm = await j("/registry/services/llm/reputation");
    const shady = await j("/registry/services/shady-llm/reputation");
    assert.notEqual(llm.score, null);
    assert.equal(llm.components.disputes, 1);
    assert.ok(llm.components.uptime > 0);
    assert.ok(shady.score < llm.score, `shady ${shady.score} < honest ${llm.score}`);
    const agent = new MeterX402Agent({ wallet, registry: HUB, budget: "1 HBAR" });
    const ranked = (await agent.discover({ capability: "text_generation" })).map((l) => l.service_id);
    assert.ok(ranked.indexOf("llm") < ranked.indexOf("shady-llm"));
    assert.equal((await agent.discover({ capability: "text_generation", minReputation: shady.score + 0.1 })).some((l) => l.service_id === "shady-llm"), false);
  });

  test("reputation snapshots have a stable digest to anchor on HCS", async () => {
    const a = await j("/registry/reputation/anchor", { method: "POST" });
    assert.equal(a.ok, false, "offline: no HCS, but the digest is still produced");
    assert.match(a.digest, /^[0-9a-f]{64}$/);
    assert.ok(a.services.some((s: any) => s.id === "llm"));
  });
});

describe("MCP", () => {
  test("an MCP agent discovers, quotes, pays and reads reputation through the same layer", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", resolve(ROOT, "src/mcp.ts")],
      env: { ...process.env, MX_HUB: HUB, BUYER_ACCOUNT_ID: "0.0.5103", BUYER_PRIVATE_KEY: PrivateKey.generateECDSA().toStringDer(), BUYER_BUDGET: "1 HBAR" } as Record<string, string>,
      cwd: ROOT,
    });
    const client = new Client({ name: "lifecycle-test", version: "0.0.1" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      for (const t of ["list_services", "get_service", "get_quote", "pay_for_service", "call_service", "get_reputation"]) assert.ok(tools.includes(t), t);
      const listed: any = await client.callTool({ name: "list_services", arguments: { capability: "text_generation" } });
      assert.match(listed.content[0].text, /"service_id": "llm"/);
      const quoted: any = await client.callTool({ name: "get_quote", arguments: { service_id: "llm", body: chat("answer in 15 words") } });
      const q = JSON.parse(quoted.content[0].text);
      assert.equal(q.price, "0.00019 HBAR");
      const paid: any = await client.callTool({ name: "pay_for_service", arguments: { quote_id: q.quote_id } });
      assert.match(paid.content[0].text, /^PAID 0\.00019 HBAR for 19 tokens/);
      assert.match(paid.content[0].text, /body hash matches the quote/);
      const rep: any = await client.callTool({ name: "get_reputation", arguments: { service_id: "llm" } });
      assert.equal(JSON.parse(rep.content[0].text).service_id, "llm");
    } finally {
      await client.close();
    }
  });
});

describe("mx402 publish", () => {
  test("one command: detect, register, serve", async () => {
    const cli = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "src/cli-entry.ts"), "publish", `${up.url}/graphql`,
      "--wallet", PAY_TO, "--name", "pools-cli", "--method", "POST", "--body", JSON.stringify({ query: "{ pools(first: 4) { id } }" }),
      "--capability", "dex_pools", "--registry", HUB, "--port", "4746", "--facilitator", fac.url, "--yes"], {
      cwd: ROOT, env: { ...process.env, NO_COLOR: "1" },
    });
    let out = "";
    cli.stdout.on("data", (d) => { out += d; });
    cli.stderr.on("data", (d) => { out += d; });
    try {
      for (let i = 0; i < 100 && !/Service ID/.test(out); i++) await sleep(200);
      const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(plain, /✓ API detected: GRAPHQL/);
      assert.match(plain, /✓ Meter detected: rows:data\.pools/);
      assert.match(plain, /✓ Service registered/);
      assert.match(plain, /Service ID\s+pools-cli/);
      const listing = await j("/registry/services/pools-cli");
      assert.deepEqual(listing.descriptor.capabilities, ["dex_pools"]);
      const mx = new MeterX402({ wallet, registry: HUB });
      const r = await mx.call("pools-cli");
      assert.equal(r.receipt!.metered_units, 4);
    } finally {
      cli.kill();
    }
  });
});
