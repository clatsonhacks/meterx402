#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../../src/events.ts
var events_exports = {};
__export(events_exports, {
  HUB_PORT: () => HUB_PORT,
  HUB_URL: () => HUB_URL,
  emit: () => emit,
  hashscanTx: () => hashscanTx,
  mxe: () => mxe
});
function mxe(type, lane, reqId, data = {}) {
  return { id: crypto.randomUUID(), reqId, lane, type, t: Date.now(), data };
}
async function emit(ev, hub = HUB_URL) {
  try {
    await fetch(`${hub}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev)
    });
  } catch {
  }
}
var HUB_PORT, HUB_URL, hashscanTx;
var init_events = __esm({
  "../../src/events.ts"() {
    "use strict";
    HUB_PORT = Number(process.env.PORT ?? process.env.MX_HUB_PORT ?? 4021);
    HUB_URL = process.env.MX_HUB ?? `http://127.0.0.1:${HUB_PORT}`;
    hashscanTx = (txId, network2 = "testnet") => (
      // HashScan wants 0.0.x@sss.nnn as 0.0.x-sss-nnn
      `https://hashscan.io/${network2}/transaction/${String(txId).replace("@", "-").replace(/\.(\d+)$/, "-$1")}`
    );
  }
});

// ../../src/hedera.ts
var hedera_exports = {};
__export(hedera_exports, {
  MIRROR: () => MIRROR,
  ensureTopic: () => ensureTopic,
  hederaEnabled: () => hederaEnabled,
  hederaReceipt: () => hederaReceipt,
  hederaTransfer: () => hederaTransfer,
  initHedera: () => initHedera,
  lookupAccount: () => lookupAccount,
  mirrorPublicKey: () => mirrorPublicKey,
  mirrorTransfer: () => mirrorTransfer,
  parseHederaKey: () => parseHederaKey,
  resolveOrCreateAccount: () => resolveOrCreateAccount
});
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  PublicKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TransferTransaction
} from "@hiero-ledger/sdk";
function parseHederaKey(raw, type = process.env.HEDERA_KEY_TYPE ?? "ecdsa") {
  const k = raw.trim().replace(/^0x/, "");
  if (/^30[0-9a-f]+$/i.test(k) && k.length > 64) return PrivateKey.fromStringDer(k);
  return type.toLowerCase() === "ed25519" ? PrivateKey.fromStringED25519(k) : PrivateKey.fromStringECDSA(k);
}
function hederaEnabled() {
  return !!(process.env.HEDERA_ACCOUNT_ID && process.env.HEDERA_PRIVATE_KEY) && process.env.MX_OFFLINE !== "1";
}
function initHedera() {
  if (client) return client;
  const id = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const key = parseHederaKey(process.env.HEDERA_PRIVATE_KEY);
  client = (NET() === "mainnet" ? Client.forMainnet() : Client.forTestnet()).setOperator(id, key);
  return client;
}
async function ensureTopic() {
  if (topicId) return topicId;
  if (process.env.HEDERA_TOPIC_ID) {
    topicId = process.env.HEDERA_TOPIC_ID;
    console.log(`\u{1FAB5} HCS receipt topic ${topicId} (from HEDERA_TOPIC_ID)  https://hashscan.io/${NET()}/topic/${topicId}`);
    return topicId;
  }
  const c = initHedera();
  const tx = await new TopicCreateTransaction().setTopicMemo("MeterX402 metered x402 receipts").execute(c);
  topicId = (await tx.getReceipt(c)).topicId.toString();
  console.log(`\u{1FAB5} HCS receipt topic ${topicId}  https://hashscan.io/${NET()}/topic/${topicId}`);
  console.log(`   \u21B3 add HEDERA_TOPIC_ID=${topicId} to .env to keep this topic across restarts`);
  return topicId;
}
async function hederaReceipt(message) {
  const c = initHedera();
  const topic = await ensureTopic();
  const submit = await new TopicMessageSubmitTransaction().setTopicId(topic).setMessage(message).execute(c);
  await submit.getReceipt(c);
  const txId = submit.transactionId.toString();
  return { txId, topicId: topic, hashscan: hashscanTx(txId, NET()) };
}
async function hederaTransfer(to, hbar) {
  const c = initHedera();
  const from = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const toAccount = to.startsWith("0x") ? AccountId.fromEvmAddress(0, 0, to) : AccountId.fromString(to);
  const tx = await new TransferTransaction().addHbarTransfer(from, new Hbar(-hbar)).addHbarTransfer(toAccount, new Hbar(hbar)).execute(c);
  await tx.getReceipt(c);
  const txId = tx.transactionId.toString();
  return { txId, topicId: "", hashscan: hashscanTx(txId, NET()) };
}
async function mirrorPublicKey(account) {
  try {
    const r = await fetch(`${MIRROR()}/accounts/${account}`);
    if (!r.ok) return null;
    const k = (await r.json())?.key;
    if (!k?.key) return null;
    return k._type === "ED25519" ? PublicKey.fromStringED25519(k.key) : k._type === "ECDSA_SECP256K1" ? PublicKey.fromStringECDSA(k.key) : PublicKey.fromString(k.key);
  } catch {
    return null;
  }
}
async function lookupAccount(addrOrId) {
  try {
    const r = await fetch(`${MIRROR()}/accounts/${addrOrId}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.account) return null;
    return {
      accountId: j.account,
      evm: j.evm_address ?? null,
      balance: Number(j.balance?.balance ?? 0) / 1e8,
      created: false,
      hashscan: `https://hashscan.io/${NET()}/account/${j.account}`
    };
  } catch {
    return null;
  }
}
async function resolveOrCreateAccount(addr) {
  const existing = await lookupAccount(addr);
  if (existing) return existing;
  if (!addr.startsWith("0x") || !hederaEnabled()) return null;
  await hederaTransfer(addr, 0.1);
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const found = await lookupAccount(addr);
    if (found) return { ...found, created: true };
  }
  return null;
}
async function mirrorTransfer(txId, account, asset = "0.0.0") {
  const id = txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  const isHbar = !asset || asset === "0.0.0";
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${MIRROR()}/transactions/${id}`);
      if (r.ok) {
        const j = await r.json();
        const t = j.transactions?.[0];
        if (t) {
          const credit = isHbar ? (t.transfers ?? []).filter((x) => x.account === account).reduce((s, x) => s + BigInt(x.amount), 0n) : (t.token_transfers ?? []).filter((x) => x.account === account && x.token_id === asset).reduce((s, x) => s + BigInt(x.amount), 0n);
          const assessedFees = (t.assessed_custom_fees ?? []).filter((f) => isHbar ? !f.token_id : f.token_id === asset).map((f) => ({ amount: BigInt(f.amount ?? 0), collector: String(f.collector_account_id ?? ""), token: f.token_id ?? null }));
          const taken = assessedFees.reduce((s, f) => s + f.amount, 0n);
          return { found: true, tinybar: credit, result: t.result, assessedFees, gross: credit + taken };
        }
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { found: false, tinybar: 0n };
}
var NET, MIRROR, client, topicId;
var init_hedera = __esm({
  "../../src/hedera.ts"() {
    "use strict";
    init_events();
    NET = () => process.env.HEDERA_NETWORK === "hedera:mainnet" ? "mainnet" : "testnet";
    MIRROR = () => `https://${NET() === "mainnet" ? "mainnet-public" : "testnet"}.mirrornode.hedera.com/api/v1`;
    client = null;
    topicId = null;
  }
});

// ../../src/meters.ts
function getPath(obj, path) {
  let cur = obj;
  for (const k of path.split(".").filter(Boolean)) {
    if (cur == null) return void 0;
    cur = Array.isArray(cur) && /^\d+$/.test(k) ? cur[Number(k)] : cur[k];
  }
  return cur;
}
function tokenUsage(res) {
  if (!isObj(res)) return null;
  const u = res.usage;
  if (isObj(u)) {
    const pt = num(u.prompt_tokens), ct = num(u.completion_tokens);
    if (pt != null || ct != null) return { input: pt ?? 0, output: ct ?? Math.max(0, (num(u.total_tokens) ?? 0) - (pt ?? 0)), source: "openai" };
    const it = num(u.input_tokens), ot = num(u.output_tokens);
    if (it != null || ot != null) return { input: it ?? 0, output: ot ?? 0, source: "input/output_tokens" };
    const tt = num(u.total_tokens);
    if (tt != null) return { input: 0, output: tt, source: "total_tokens" };
  }
  const pe = num(res.prompt_eval_count), ev = num(res.eval_count);
  if (pe != null || ev != null) return { input: pe ?? 0, output: ev ?? 0, source: "ollama" };
  const g = res.usageMetadata;
  if (isObj(g)) {
    const p = num(g.promptTokenCount) ?? 0, c = num(g.candidatesTokenCount);
    return { input: p, output: c ?? Math.max(0, (num(g.totalTokenCount) ?? 0) - p), source: "gemini" };
  }
  return null;
}
function outputText(res, raw) {
  if (isObj(res)) {
    const c = res.choices?.[0];
    if (typeof c?.message?.content === "string") return c.message.content;
    if (typeof c?.text === "string") return c.text;
    if (Array.isArray(res.content)) return res.content.map((p) => p?.text ?? "").join("");
    if (typeof res.response === "string") return res.response;
    if (typeof res.message?.content === "string") return res.message.content;
    if (typeof res.output_text === "string") return res.output_text;
  }
  return raw;
}
function inputText(req) {
  if (!isObj(req)) return "";
  if (Array.isArray(req.messages)) return req.messages.map((m) => typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")).join("\n");
  if (typeof req.prompt === "string") return req.prompt;
  if (typeof req.input === "string") return req.input;
  return "";
}
function tokensMeter(mode) {
  return {
    spec: mode === "output" ? "tokens:output" : "tokens",
    unit: "tokens",
    measure(i) {
      const u = tokenUsage(i.resJson);
      if (u) return mode === "output" ? u.output : u.input + u.output;
      const out = estimateTokens(outputText(i.resJson, i.resText));
      return mode === "output" ? out : out + estimateTokens(inputText(i.reqBody));
    },
    stream(reqBody) {
      const prompt = mode === "total" ? estimateTokens(inputText(reqBody)) : 0;
      let text2 = "", reported = null, buffer = "";
      return {
        onChunk(chunk) {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const j = JSON.parse(payload);
              const u = tokenUsage(j);
              if (u && (u.input || u.output)) reported = u;
              const d = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.text ?? j?.delta?.text ?? j?.message?.content ?? j?.response;
              if (typeof d === "string") text2 += d;
            } catch {
              text2 += payload;
            }
          }
        },
        units() {
          if (reported) return mode === "output" ? reported.output : reported.input + reported.output;
          return estimateTokens(text2) + prompt;
        }
      };
    },
    capFromRequest(req) {
      if (!isObj(req)) return void 0;
      for (const f of TOKEN_CAP_FIELDS) if (num(req[f]) != null) return req[f];
      return num(req.options?.num_predict);
    },
    clamp(req, cap) {
      if (!isObj(req)) return req;
      const out = { ...req };
      if (out.stream === true) out.stream = false;
      let set = false;
      for (const f of TOKEN_CAP_FIELDS) {
        if (num(out[f]) != null) {
          out[f] = Math.min(out[f], cap);
          set = true;
        }
      }
      if (isObj(out.options)) {
        out.options = { ...out.options, num_predict: Math.min(num(out.options.num_predict) ?? cap, cap) };
        set = true;
      }
      if (!set && (Array.isArray(out.messages) || typeof out.prompt === "string")) out.max_tokens = cap;
      return out;
    }
  };
}
function countRows(res) {
  if (Array.isArray(res)) return res.length;
  if (!isObj(res)) return 0;
  if (isObj(res.data)) {
    let n = 0;
    for (const v of Object.values(res.data)) n += Array.isArray(v) ? v.length : v == null ? 0 : 1;
    return n;
  }
  for (const k of ["data", "result", "results", "items", "rows", "records", "entries"]) {
    if (Array.isArray(res[k])) return res[k].length;
  }
  return 1;
}
function clampGraphqlFirst(query, cap) {
  return query.replace(/\bfirst\s*:\s*(\d+)/g, (_, n) => `first: ${Math.min(Number(n), cap)}`);
}
function rowsMeter(path) {
  return {
    spec: path ? `rows:${path}` : "rows",
    unit: "rows",
    measure(i) {
      if (path) {
        const v = getPath(i.resJson, path);
        return Array.isArray(v) ? v.length : v == null ? 0 : 1;
      }
      return countRows(i.resJson);
    },
    clamp(req, cap) {
      if (isObj(req) && typeof req.query === "string") return { ...req, query: clampGraphqlFirst(req.query, cap) };
      return req;
    }
  };
}
function makeMeter(spec = "request") {
  const [kind, arg] = [spec.split(":")[0], spec.split(":").slice(1).join(":")];
  switch (kind) {
    case "tokens":
      return tokensMeter(arg === "output" ? "output" : "total");
    case "rows":
      return rowsMeter(arg || void 0);
    case "bytes":
      return {
        spec,
        unit: "bytes",
        measure: (i) => i.bytes,
        stream: () => {
          let n = 0;
          return { onChunk: (t) => {
            n += Buffer.byteLength(t);
          }, units: () => n };
        }
      };
    case "ms":
      return { spec, unit: "ms", measure: (i) => i.ms };
    case "json": {
      if (!arg) throw new Error("json meter needs a path, e.g. --meter json:usage.credits");
      return { spec, unit: arg.split(".").pop(), measure: (i) => Number(getPath(i.resJson, arg)) || 0 };
    }
    case "request":
    case "flat":
      return { spec: "request", unit: "requests", measure: () => 1 };
    default:
      throw new Error(`unknown meter "${spec}". try: tokens, tokens:output, rows, rows:<path>, bytes, ms, json:<path>, request`);
  }
}
var isObj, num, estimateTokens, TOKEN_CAP_FIELDS;
var init_meters = __esm({
  "../../src/meters.ts"() {
    "use strict";
    isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
    num = (x) => typeof x === "number" && Number.isFinite(x) ? x : void 0;
    estimateTokens = (text2) => Math.ceil(text2.length / 4);
    TOKEN_CAP_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
  }
});

// ../../src/pricing.ts
function rational(v) {
  if (typeof v === "bigint") return { n: v, d: 1n };
  const s = typeof v === "number" ? Number.isFinite(v) ? String(v) : "" : v.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m || m[2] === "" && (m[3] ?? "") === "") throw new Error(`not a decimal number: ${String(v)}`);
  const [, sign, int, frac = "", exp = "0"] = m;
  let n = BigInt((int || "0") + frac);
  let d = 10n ** BigInt(frac.length);
  const e = Number(exp);
  if (e > 0) n *= 10n ** BigInt(e);
  else if (e < 0) d *= 10n ** BigInt(-e);
  return { n: sign === "-" ? -n : n, d };
}
function toAtomic(amount, decimals = 8) {
  const r = rational(amount);
  return ceilDiv(r.n * 10n ** BigInt(decimals), r.d);
}
function fromAtomic(atomic, decimals = 8) {
  const a = BigInt(atomic);
  const neg = a < 0n;
  const s = (neg ? -a : a).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}
var ceilDiv;
var init_pricing = __esm({
  "../../src/pricing.ts"() {
    "use strict";
    ceilDiv = (a, b) => a <= 0n ? 0n : (a + b - 1n) / b;
  }
});

// ../../src/settlement/adapter.ts
function selectRoute(accepts, wallet, prefer = "exact") {
  const compatible = accepts.filter((o) => wallet.some((w) => w.network === o.network && (!w.currencies || w.currencies.map((c) => c.toUpperCase()).includes(o.currency.toUpperCase()))));
  if (!compatible.length) return null;
  const withPreferred = compatible.find((o) => o.schemes.includes(prefer));
  if (withPreferred) return { option: withPreferred, scheme: prefer };
  const exact = compatible.find((o) => o.schemes.includes("exact"));
  return exact ? { option: exact, scheme: "exact" } : { option: compatible[0], scheme: compatible[0].schemes[0] };
}
var init_adapter = __esm({
  "../../src/settlement/adapter.ts"() {
    "use strict";
  }
});

// ../../src/protocol/schemas.ts
import { z } from "zod";
var PROTOCOL_VERSION, decimal, network, SettlementOption, ServiceDescriptor, PaymentQuote, PaymentAuthorization, SettlementReceipt, ReputationComponents, ReputationRecord, Dispute, decodeHeader;
var init_schemas = __esm({
  "../../src/protocol/schemas.ts"() {
    "use strict";
    PROTOCOL_VERSION = "1";
    decimal = z.string().regex(/^\d+(\.\d+)?$/, "a non-negative decimal string");
    network = z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9-]+$/, "a CAIP-2 network id, e.g. hedera:testnet");
    SettlementOption = z.object({
      network,
      asset: z.string(),
      // "0.0.0" = HBAR, an HTS token id, an ERC-20 address…
      currency: z.string(),
      // what humans call it: HBAR, USDC
      decimals: z.number().int().min(0),
      schemes: z.array(z.enum(["exact", "tab"])).min(1),
      facilitator: z.string().optional(),
      /** A fee the LEDGER assesses on every transfer of this asset (HTS custom
       *  fee schedule). Disclosed so a buyer knows what the seller actually nets;
       *  it is not added to the price, and no code here collects it. */
      fee: z.object({
        percent: decimal,
        collector: z.string(),
        assessment: z.enum(["inclusive", "exclusive"]),
        source: z.literal("hts-custom-fee")
      }).optional()
    });
    ServiceDescriptor = z.object({
      mx402: z.literal(PROTOCOL_VERSION),
      service_id: z.string().regex(/^[a-z0-9][a-z0-9-_.]{0,62}$/, "lowercase slug"),
      name: z.string().min(1),
      description: z.string().optional(),
      /** HCS-14 Universal Agent ID: the same agent across Web2, EVM and Hedera.
       *  Derived from what the agent IS (registry, name, version, protocol,
       *  account, skills), never from where it is hosted or what it charges. */
      uaid: z.string().regex(/^uaid:(aid|did):/).optional(),
      type: z.enum(["rest", "graphql", "llm", "mcp", "a2a"]),
      endpoint: z.string().url(),
      // the payment-enabled base URL buyers call
      sample: z.object({ method: z.string(), path: z.string(), body: z.string().optional() }).optional(),
      capabilities: z.array(z.string().min(1)).min(1),
      pricing: z.object({
        meter: z.string(),
        // tokens | rows:<path> | bytes | ms | json:<path> | request
        unit: z.string(),
        rate: decimal,
        // price per `per` units
        per: z.number().positive(),
        min: decimal,
        free: z.number().int().min(0),
        max_units: z.number().positive().nullable(),
        currency: z.string()
      }),
      payment: z.object({
        protocol: z.literal("x402"),
        settlement: z.array(SettlementOption).min(1),
        streaming: z.boolean(),
        // only ever true where tabs are offered
        /** Pre-signed future payments (Hedera scheduled transactions). Unlike an
         *  allowance, these are commitments the seller can count before they land. */
        subscription: z.object({
          price: decimal,
          // per period
          period_sec: z.number().int().positive(),
          max_periods: z.number().int().positive(),
          includes_units: z.number().int().nonnegative().nullable(),
          open: z.string().url()
        }).optional()
      }),
      interfaces: z.array(z.enum(["rest", "graphql", "a2a", "mcp", "sdk"])).min(1),
      auth: z.object({
        // how the UPSTREAM authenticates; the key is held by the seller's gateway,
        // so buyers never need it
        type: z.enum(["none", "api-key", "bearer", "header"]),
        held_by: z.literal("seller")
      }),
      owner: z.object({ account: z.string(), network }),
      links: z.object({
        descriptor: z.string().url(),
        a2a_card: z.string().url().optional(),
        tab: z.string().url().optional()
      }),
      published_at: z.string()
    });
    PaymentQuote = z.object({
      mx402: z.literal(PROTOCOL_VERSION),
      quote_id: z.string(),
      service_id: z.string(),
      scheme: z.literal("exact"),
      meter: z.string(),
      unit: z.string(),
      units: z.number().min(0),
      // billable
      measured: z.number().min(0),
      // what the meter counted, before caps
      cap: z.number().nullable(),
      rate: decimal,
      per: z.number().positive(),
      amount: decimal,
      amount_atomic: z.string().regex(/^\d+$/),
      currency: z.string(),
      network,
      asset: z.string(),
      pay_to: z.string(),
      body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      // the quote commits to the response
      expires_at: z.number().int()
    });
    PaymentAuthorization = z.object({
      mx402: z.literal(PROTOCOL_VERSION),
      kind: z.enum(["exact", "tab"]),
      buyer: z.string(),
      service_id: z.string(),
      network,
      // the constraints the buyer set; whichever are present are enforced
      max_per_call: decimal.optional(),
      max_units: z.number().positive().optional(),
      budget: decimal.optional(),
      allowance: decimal.optional(),
      // tabs: the on-chain allowance
      expires_at: z.number().int().optional(),
      quote_id: z.string().optional(),
      // exact: the quote being paid
      tab_id: z.string().optional(),
      // tab: the session
      authorized_at: z.number().int()
    });
    SettlementReceipt = z.object({
      mx402: z.literal(PROTOCOL_VERSION),
      receipt_id: z.string(),
      scheme: z.enum(["exact", "tab", "subscription"]),
      quote_id: z.string().nullable(),
      tab_id: z.string().nullable(),
      subscription_id: z.string().nullable().optional(),
      // subscription: the period's commitment
      service_id: z.string(),
      buyer: z.string(),
      seller: z.string(),
      metered_units: z.number().min(0),
      unit: z.string(),
      rate: decimal,
      per: z.number().positive(),
      amount: decimal,
      amount_atomic: z.string().regex(/^\d+$/),
      currency: z.string(),
      network,
      // null while a tab call is metered but not yet in a settled batch
      transaction_id: z.string().nullable(),
      body_sha256: z.string().nullable(),
      settled_at: z.number().int()
    });
    ReputationComponents = z.object({
      execution: z.number().min(0).max(1),
      response_success: z.number().min(0).max(1),
      latency: z.number().min(0).max(1),
      disputes: z.number().min(0).max(1),
      uptime: z.number().min(0).max(1),
      payment_reliability: z.number().min(0).max(1)
    });
    ReputationRecord = z.object({
      mx402: z.literal(PROTOCOL_VERSION),
      service_id: z.string(),
      score: z.number().min(0).max(100).nullable(),
      // null = not enough evidence to rank
      confidence: z.enum(["none", "low", "medium", "high"]),
      sample_size: z.number().int().min(0),
      components: ReputationComponents,
      weights: ReputationComponents,
      stats: z.object({
        calls: z.number().int(),
        paid_calls: z.number().int(),
        revenue: z.number(),
        upstream_calls: z.number().int(),
        upstream_errors: z.number().int(),
        settle_attempts: z.number().int(),
        settle_failures: z.number().int(),
        disputes: z.number().int(),
        median_latency_ms: z.number().nullable(),
        p90_latency_ms: z.number().nullable(),
        uptime_ratio: z.number().nullable(),
        // quote rounds this service was asked into, answered, and won
        quote_rounds: z.number().int().nonnegative().default(0),
        quotes_offered: z.number().int().nonnegative().default(0),
        quote_rounds_won: z.number().int().nonnegative().default(0)
      }),
      computed_at: z.number().int(),
      anchor: z.object({ topic_id: z.string(), transaction_id: z.string(), digest: z.string() }).optional()
    });
    Dispute = z.object({
      mx402: z.literal(PROTOCOL_VERSION),
      service_id: z.string(),
      quote_id: z.string().nullable(),
      receipt_id: z.string().nullable(),
      buyer: z.string(),
      reason: z.enum(["body_hash_mismatch", "units_mismatch", "not_delivered"]),
      claimed_units: z.number().nullable(),
      observed_units: z.number().nullable(),
      body_sha256_claimed: z.string().nullable(),
      body_sha256_observed: z.string().nullable(),
      filed_at: z.number().int()
    });
    decodeHeader = (value, schema) => {
      if (!value) return null;
      try {
        return schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
      } catch {
        return null;
      }
    };
  }
});

// ../../src/subscriptions.ts
var subscriptions_exports = {};
__export(subscriptions_exports, {
  MAX_SCHEDULE_AHEAD_SEC: () => MAX_SCHEDULE_AHEAD_SEC,
  SubscriptionBook: () => SubscriptionBook,
  cancelScheduled: () => cancelScheduled,
  checkSchedule: () => checkSchedule,
  readSchedule: () => readSchedule,
  scheduleSubscription: () => scheduleSubscription,
  subscriptionChallenge: () => subscriptionChallenge
});
import { createHmac, randomBytes } from "node:crypto";
async function scheduleSubscription(o) {
  const { AccountId: AccountId2, Client: Client2, Hbar: Hbar2, ScheduleCreateTransaction, Timestamp, TransferTransaction: TransferTransaction2 } = await import("@hiero-ledger/sdk");
  const key = typeof o.buyer.privateKey === "string" ? parseHederaKey(o.buyer.privateKey) : o.buyer.privateKey;
  const client2 = (o.network === "hedera:mainnet" ? Client2.forMainnet() : Client2.forTestnet()).setOperator(AccountId2.fromString(o.buyer.accountId), key);
  const out = [];
  try {
    for (let i = 0; i < o.periods; i++) {
      const dueMs = (o.startAt ?? Date.now() + o.periodSec * 1e3) + i * o.periodSec * 1e3;
      const dueSec = Math.floor(dueMs / 1e3);
      const ahead = dueSec - Math.floor(Date.now() / 1e3);
      if (ahead <= 0) throw new Error(`period ${i + 1} is already due`);
      if (ahead > MAX_SCHEDULE_AHEAD_SEC) throw new Error(`period ${i + 1} is ${Math.round(ahead / 86400)} days out; Hedera schedules reach ~62 days`);
      const inner = new TransferTransaction2().addHbarTransfer(AccountId2.fromString(o.buyer.accountId), Hbar2.fromTinybars((-o.amountAtomic).toString())).addHbarTransfer(AccountId2.fromString(o.payTo), Hbar2.fromTinybars(o.amountAtomic.toString()));
      const tx = await new ScheduleCreateTransaction().setScheduledTransaction(inner).setScheduleMemo((o.memo ?? "mx402 subscription").slice(0, 100)).setExpirationTime(new Timestamp(dueSec, 0)).setWaitForExpiry(true).setPayerAccountId(AccountId2.fromString(o.buyer.accountId)).setAdminKey(key.publicKey).execute(client2);
      const id = (await tx.getReceipt(client2)).scheduleId.toString();
      out.push({ schedule_id: id, due_at: dueSec * 1e3, amount_atomic: o.amountAtomic.toString(), executed_at: null });
    }
    return out;
  } finally {
    client2.close();
  }
}
async function cancelScheduled(scheduleId, buyer2, network2) {
  const { AccountId: AccountId2, Client: Client2, ScheduleDeleteTransaction, ScheduleId } = await import("@hiero-ledger/sdk");
  const key = typeof buyer2.privateKey === "string" ? parseHederaKey(buyer2.privateKey) : buyer2.privateKey;
  const client2 = (network2 === "hedera:mainnet" ? Client2.forMainnet() : Client2.forTestnet()).setOperator(AccountId2.fromString(buyer2.accountId), key);
  try {
    const tx = await (await new ScheduleDeleteTransaction().setScheduleId(ScheduleId.fromString(scheduleId)).freezeWith(client2).sign(key)).execute(client2);
    await tx.getReceipt(client2);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).split("\n")[0] };
  } finally {
    client2.close();
  }
}
async function readSchedule(scheduleId, mirror = MIRROR()) {
  const r = await fetch(`${mirror}/schedules/${scheduleId}`).catch(() => null);
  if (!r?.ok) return null;
  const j = await r.json();
  const { proto } = await import("@hiero-ledger/proto");
  let transfers = [];
  let tokenTransfers = 0;
  try {
    const body = proto.SchedulableTransactionBody.decode(Buffer.from(j.transaction_body, "base64"));
    transfers = (body.cryptoTransfer?.transfers?.accountAmounts ?? []).map((a) => ({
      account: acct(a.accountID),
      amount: BigInt(a.amount?.toString() ?? "0"),
      approved: !!a.isApproval
    }));
    tokenTransfers = (body.cryptoTransfer?.tokenTransfers ?? []).length;
  } catch {
  }
  const sec = (t) => t ? Math.round(Number(t) * 1e3) : null;
  return {
    schedule_id: String(j.schedule_id),
    creator: String(j.creator_account_id ?? ""),
    payer: String(j.payer_account_id ?? ""),
    due_at: sec(j.expiration_time) ?? 0,
    executed_at: sec(j.executed_timestamp),
    deleted: !!j.deleted,
    wait_for_expiry: !!j.wait_for_expiry,
    memo: String(j.memo ?? ""),
    transfers,
    tokenTransfers
  };
}
function checkSchedule(s, expect) {
  if (!s) return { ok: false, reason: "not_found" };
  if (s.deleted) return { ok: false, reason: "cancelled" };
  if (s.tokenTransfers) return { ok: false, reason: "token_transfer_not_supported" };
  const credit = s.transfers.filter((t) => t.account === expect.payTo).reduce((a, t) => a + t.amount, 0n);
  const debit = s.transfers.filter((t) => t.account === expect.buyer).reduce((a, t) => a + t.amount, 0n);
  if (credit !== expect.amountAtomic) return { ok: false, reason: `pays ${credit} to ${expect.payTo}, expected ${expect.amountAtomic}`, schedule: s };
  if (debit !== -expect.amountAtomic) return { ok: false, reason: `debits ${debit} from ${expect.buyer}, expected -${expect.amountAtomic}`, schedule: s };
  if (s.transfers.some((t) => t.approved)) return { ok: false, reason: "allowance_backed: the buyer has not committed their own funds", schedule: s };
  return { ok: true, schedule: s };
}
var MAX_SCHEDULE_AHEAD_SEC, acct, subscriptionChallenge, SubscriptionBook;
var init_subscriptions = __esm({
  "../../src/subscriptions.ts"() {
    "use strict";
    init_hedera();
    MAX_SCHEDULE_AHEAD_SEC = 5356800;
    acct = (a) => `${a?.shardNum ?? 0}.${a?.realmNum ?? 0}.${a?.accountNum ?? 0}`;
    subscriptionChallenge = (lane, buyer2, nonce) => `mx402-sub:${lane}:${buyer2}:${nonce}`;
    SubscriptionBook = class {
      constructor(o) {
        this.o = o;
        this.secret = o.secret ?? process.env.MX_SUB_SECRET ?? "dev-subscription-secret";
      }
      o;
      subs = /* @__PURE__ */ new Map();
      nonces = /* @__PURE__ */ new Map();
      secret;
      now = () => (this.o.now ?? Date.now)();
      sign = (payload) => createHmac("sha256", this.secret).update(payload).digest("base64url");
      challenge() {
        const nonce = randomBytes(16).toString("hex");
        const expiresAt = this.now() + 5 * 6e4;
        this.nonces.set(nonce, expiresAt);
        for (const [n, e] of this.nonces) if (e < this.now()) this.nonces.delete(n);
        return { nonce, expiresAt };
      }
      /** Accept a subscription: every period must really pay us, on-chain. */
      async open(buyer2, nonce, signatureHex, scheduleIds) {
        const exp = this.nonces.get(nonce);
        if (!exp || exp < this.now()) return { ok: false, error: "challenge_expired" };
        this.nonces.delete(nonce);
        const keyOf = this.o.publicKeyOf ?? (async (a) => {
          const { mirrorPublicKey: mirrorPublicKey2 } = await Promise.resolve().then(() => (init_hedera(), hedera_exports));
          return mirrorPublicKey2(a);
        });
        const key = await keyOf(buyer2).catch(() => null);
        if (!key) return { ok: false, error: "buyer_key_not_found" };
        let good = false;
        try {
          good = key.verify(Buffer.from(subscriptionChallenge(this.o.lane, buyer2, nonce)), Buffer.from(signatureHex, "hex"));
        } catch {
        }
        if (!good) return { ok: false, error: "bad_signature" };
        if (!scheduleIds.length) return { ok: false, error: "no_schedules" };
        if (scheduleIds.length > this.o.terms.max_periods) return { ok: false, error: `at most ${this.o.terms.max_periods} periods` };
        const read = this.o.read ?? ((id) => readSchedule(id));
        const periods = [];
        for (const id of scheduleIds) {
          let s = await read(id).catch(() => null);
          for (const end = this.now() + (this.o.mirrorWaitMs ?? 15e3); !s && this.now() < end; ) {
            await new Promise((r) => setTimeout(r, 1e3));
            s = await read(id).catch(() => null);
          }
          const check = checkSchedule(s, { buyer: buyer2, payTo: this.o.payTo, amountAtomic: this.o.amountAtomic });
          if (!check.ok) return { ok: false, error: `schedule ${id}: ${check.reason}` };
          if (!s.wait_for_expiry) return { ok: false, error: `schedule ${id}: must wait for expiry, or it runs the moment it is signed` };
          periods.push({ schedule_id: id, due_at: s.due_at, amount_atomic: this.o.amountAtomic.toString(), executed_at: s.executed_at });
        }
        periods.sort((a, b) => a.due_at - b.due_at);
        const sub = {
          id: randomBytes(9).toString("base64url"),
          buyer: buyer2,
          periods,
          amount_atomic: this.o.amountAtomic.toString(),
          period_sec: this.o.terms.period_sec,
          includes_units: this.o.terms.includes_units,
          created_at: this.now(),
          used: 0,
          period_index: 0
        };
        this.subs.set(sub.id, sub);
        const until = periods[periods.length - 1].due_at;
        const payload = `sub.v1.${sub.id}.${until}`;
        return { ok: true, token: `${payload}.${this.sign(payload)}`, sub };
      }
      /** The subscription behind a token, if the token is ours and still valid. */
      fromToken(token) {
        if (!token) return null;
        const i = token.lastIndexOf(".");
        if (i < 0) return null;
        const payload = token.slice(0, i);
        if (this.sign(payload) !== token.slice(i + 1)) return null;
        const [, , id, until] = payload.split(".");
        if (Number(until) < this.now()) return null;
        return this.subs.get(id) ?? null;
      }
      /** Consume the period's included units. Returns what is left to pay for. */
      spend(sub, units) {
        const start = sub.periods[0]?.due_at ?? sub.created_at;
        const idx = Math.max(0, Math.floor((this.now() - start) / (sub.period_sec * 1e3)) + 1);
        if (idx !== sub.period_index) {
          sub.period_index = idx;
          sub.used = 0;
        }
        if (sub.includes_units == null) return { covered: units, excess: 0 };
        const left = Math.max(0, sub.includes_units - sub.used);
        const covered = Math.min(units, left);
        sub.used += covered;
        return { covered, excess: units - covered };
      }
      get(id) {
        return this.subs.get(id);
      }
      all() {
        return [...this.subs.values()];
      }
      /** Committed revenue: what is scheduled and has not run yet. */
      committed(now = this.now()) {
        let atomic = 0n, periods = 0;
        for (const s of this.subs.values()) {
          for (const p of s.periods) {
            if (p.executed_at == null && p.due_at > now) {
              atomic += BigInt(p.amount_atomic);
              periods++;
            }
          }
        }
        return { atomic, periods, subscriptions: this.subs.size };
      }
      /** Refresh execution state from the ledger. */
      async refresh(read = (id) => readSchedule(id)) {
        for (const s of this.subs.values()) {
          for (const p of s.periods) {
            if (p.executed_at != null) continue;
            const on = await read(p.schedule_id).catch(() => null);
            if (on?.executed_at) p.executed_at = on.executed_at;
          }
        }
      }
    };
  }
});

// ../../src/sdk/buyer.ts
var buyer_exports = {};
__export(buyer_exports, {
  BudgetError: () => BudgetError,
  MeterX402: () => MeterX402,
  parseAmount: () => parseAmount,
  verify: () => verify
});
import { createHash } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { createClientHederaSigner, ExactHederaScheme } from "@x402/hedera";
function parseAmount(v) {
  if (v == null || v === "") return null;
  const m = /^\s*([0-9.]+)\s*([A-Za-z]+)?\s*$/.exec(String(v));
  if (!m) throw new Error(`not an amount: ${v}`);
  return { amount: m[1], currency: m[2]?.toUpperCase() };
}
function verify(quote, bytes, text2, json2, reqBody) {
  const bodyHash = createHash("sha256").update(bytes).digest("hex") === quote.body_sha256;
  const kind = quote.meter.split(":")[0];
  if (kind === "ms") return { bodyHash, remetered: null, unitsMatch: null, method: "none" };
  let req;
  if (reqBody) {
    try {
      req = JSON.parse(reqBody);
    } catch {
    }
  }
  const remetered = makeMeter(quote.meter).measure({ reqBody: req, status: 200, resText: text2, resJson: json2 === text2 ? void 0 : json2, bytes: bytes.byteLength, ms: 0 });
  return { bodyHash, remetered, unitsMatch: remetered === quote.measured, method: kind === "tokens" ? "self-reported" : "exact" };
}
var BudgetError, MeterX402;
var init_buyer = __esm({
  "../../src/sdk/buyer.ts"() {
    "use strict";
    init_hedera();
    init_meters();
    init_pricing();
    init_adapter();
    init_schemas();
    BudgetError = class extends Error {
      constructor(message, quote) {
        super(message);
        this.quote = quote;
        this.name = "BudgetError";
      }
      quote;
    };
    MeterX402 = class {
      constructor(opts) {
        this.opts = opts;
        this.accountId = opts.wallet.accountId;
        this.network = opts.wallet.network ?? "hedera:testnet";
        this.key = typeof opts.wallet.privateKey === "string" ? parseHederaKey(opts.wallet.privateKey) : opts.wallet.privateKey;
        this.signer = createClientHederaSigner(this.accountId, this.key, { network: this.network });
        const b = parseAmount(opts.budget), m = parseAmount(opts.maxPerCall);
        this.budget = b ? { atomic: toAtomic(b.amount), currency: b.currency } : null;
        this.maxPerCall = m ? { atomic: toAtomic(m.amount), currency: m.currency } : null;
        this.assets = opts.assets ?? [];
        this.registryUrl = opts.registry?.replace(/\/+$/, "");
        this.autoDispute = opts.autoDispute ?? true;
      }
      opts;
      accountId;
      network;
      key;
      signer;
      budget;
      assets;
      maxPerCall;
      _spent = 0n;
      reserved = 0n;
      receipts = [];
      registryUrl;
      autoDispute;
      get spent() {
        return fromAtomic(this._spent);
      }
      get remaining() {
        return this.budget ? fromAtomic(this.budget.atomic - this._spent - this.reserved) : null;
      }
      get wallet() {
        return { accountId: this.accountId, privateKey: this.key, network: this.network };
      }
      /** What this wallet can settle on, for route selection. */
      get supports() {
        return [{ network: this.network, currencies: this.budget?.currency ? [this.budget.currency] : void 0 }];
      }
      // ── discover ────────────────────────────────────────────────────────────
      async discover(filter = {}) {
        const reg = this.needRegistry();
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(filter)) if (v != null && k !== "chains") q.set(k, String(v));
        const { services } = await fetch(`${reg}/registry/services?${q}`).then((r) => r.json());
        return services.filter((l) => selectRoute(l.descriptor.payment.settlement, this.supports) != null);
      }
      async service(id) {
        const r = await fetch(`${this.needRegistry()}/registry/services/${encodeURIComponent(id)}`);
        if (!r.ok) throw new Error(`service ${id} is not in the registry`);
        return r.json();
      }
      async reputation(id) {
        return fetch(`${this.needRegistry()}/registry/services/${encodeURIComponent(id)}/reputation`).then((r) => r.json());
      }
      needRegistry() {
        if (!this.registryUrl) throw new Error("no registry configured: pass { registry: 'http://\u2026' }");
        return this.registryUrl;
      }
      async resolve(target) {
        if (typeof target !== "string") return "descriptor" in target ? target.descriptor : target;
        if (/^https?:\/\//.test(target)) {
          const r = await fetch(`${target.replace(/\/+$/, "")}/.well-known/mx402`);
          if (!r.ok) throw new Error(`${target} does not serve a MeterX402 descriptor`);
          return r.json();
        }
        return (await this.service(target)).descriptor;
      }
      // ── quote ───────────────────────────────────────────────────────────────
      /** Run the call and get its exact metered price, without paying. The
       *  response is held by the service until the quote expires. */
      async quote(target, req = {}) {
        const service = await this.resolve(target);
        const route = selectRoute(service.payment.settlement, this.supports);
        if (!route) throw new BudgetError(`no compatible settlement route: ${service.service_id} settles on ${service.payment.settlement.map((o) => `${o.currency}@${o.network}`).join(", ")}, this wallet pays ${this.budget?.currency ?? "any"}@${this.network}`);
        const sample = service.sample ?? { method: "GET", path: "/" };
        const method = (req.method ?? (req.body != null ? "POST" : sample.method)).toUpperCase();
        const body = req.body != null ? typeof req.body === "string" ? req.body : JSON.stringify(req.body) : method !== "GET" ? sample.body : void 0;
        const url = new URL(`${service.endpoint}${req.path ?? sample.path}`);
        for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
        const headers = { "x-mx402-interface": "sdk", ...req.headers };
        if (body != null) headers["content-type"] ??= "application/json";
        if (req.maxUnits) headers["x-meter-max-units"] = String(req.maxUnits);
        const init = { method, headers, body: method === "GET" ? void 0 : body };
        const first = await fetch(url, init);
        if (first.status !== 402) return this.finish(first, null, null, null, body);
        const header = first.headers.get("payment-required");
        const quote = decodeHeader(first.headers.get("x-mx402-quote"), PaymentQuote);
        if (!header || !quote) throw new Error(`${service.service_id} answered 402 without a MeterX402 quote`);
        const paymentRequired = decodePaymentRequiredHeader(header);
        return { quote, service, route, pay: () => this.pay(url, init, body, quote, paymentRequired, req) };
      }
      /** Quote and pay in one step. */
      async call(target, req = {}) {
        const q = await this.quote(target, req);
        return "pay" in q ? q.pay() : q;
      }
      // ── authorize + pay ─────────────────────────────────────────────────────
      async pay(url, init, body, quote, paymentRequired, req) {
        const amount = BigInt(quote.amount_atomic);
        const maxPrice = parseAmount(req.maxPrice);
        if (maxPrice && amount > toAtomic(maxPrice.amount)) throw new BudgetError(`quote ${quote.amount} ${quote.currency} is above this call's limit of ${maxPrice.amount}`, quote);
        if (this.maxPerCall && amount > this.maxPerCall.atomic) throw new BudgetError(`quote ${quote.amount} ${quote.currency} is above maxPerCall ${fromAtomic(this.maxPerCall.atomic)}`, quote);
        if (this.budget && this._spent + this.reserved + amount > this.budget.atomic) {
          throw new BudgetError(`budget: ${this.spent} spent + ${quote.amount} would exceed ${fromAtomic(this.budget.atomic)} ${this.budget.currency ?? quote.currency}`, quote);
        }
        if (req.maxUnits && quote.units > req.maxUnits) throw new BudgetError(`quote bills ${quote.units} ${quote.unit}, above the cap of ${req.maxUnits}`, quote);
        if (Date.now() > quote.expires_at) throw new BudgetError("quote expired", quote);
        const asset = paymentRequired.accepts?.[0]?.asset;
        if (!this.allowsAsset(asset)) {
          throw new BudgetError(`this wallet will not pay in ${quote.currency} (${asset}): pass it in \`assets\` to opt in`, quote);
        }
        const authorization = {
          mx402: PROTOCOL_VERSION,
          kind: "exact",
          buyer: this.accountId,
          service_id: quote.service_id,
          network: quote.network,
          ...this.maxPerCall ? { max_per_call: fromAtomic(this.maxPerCall.atomic) } : {},
          ...req.maxUnits ? { max_units: req.maxUnits } : {},
          ...this.budget ? { budget: fromAtomic(this.budget.atomic) } : {},
          expires_at: quote.expires_at,
          quote_id: quote.quote_id,
          authorized_at: Date.now()
        };
        this.reserved += amount;
        try {
          const payload = await this.x402().createPaymentPayload(paymentRequired);
          const headers = new Headers(init.headers);
          headers.set("PAYMENT-SIGNATURE", encodePaymentSignatureHeader(payload));
          const res = await fetch(url, { ...init, headers });
          const result = await this.finish(res, quote, authorization, paymentRequired, body);
          if (result.paid) this._spent += amount;
          return result;
        } finally {
          this.reserved -= amount;
        }
      }
      /** Subscribe: pre-sign one transfer per period, then call without paying.
       *
       *  The commitment is on the ledger, not in this process — the seller reads
       *  the schedules itself and believes those, and the buyer keeps the admin
       *  key, so any period that has not run can still be cancelled. */
      async subscribe(target, opts = {}) {
        const service = await this.resolve(target);
        const terms = service.payment.subscription;
        if (!terms) throw new BudgetError(`${service.service_id} does not sell subscriptions`);
        const periods = Math.min(opts.periods ?? 1, terms.max_periods);
        const open = await fetch(terms.open).then((r) => r.json());
        if (!open?.nonce) throw new BudgetError(`${service.service_id} would not offer a subscription challenge`);
        const amountAtomic = BigInt(open.amountAtomic);
        if (this.budget && amountAtomic * BigInt(periods) > this.budget.atomic) {
          throw new BudgetError(`${periods} periods \xD7 ${terms.price} would exceed the session budget`);
        }
        const { scheduleSubscription: scheduleSubscription2, subscriptionChallenge: subscriptionChallenge2 } = await Promise.resolve().then(() => (init_subscriptions(), subscriptions_exports));
        const scheduled = await scheduleSubscription2({
          buyer: { accountId: this.accountId, privateKey: this.key },
          payTo: open.payTo,
          amountAtomic,
          periods,
          periodSec: terms.period_sec,
          startAt: opts.startAt,
          memo: `mx402 ${service.service_id}`,
          network: this.network
        });
        const signature = Buffer.from(this.key.sign(Buffer.from(subscriptionChallenge2(open.lane, this.accountId, open.nonce)))).toString("hex");
        const res = await fetch(terms.open, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ buyer: this.accountId, nonce: open.nonce, signature, schedules: scheduled.map((p) => p.schedule_id) })
        });
        const body = await res.json();
        if (!res.ok) throw new BudgetError(`subscription refused: ${body?.error ?? res.status}`);
        const call = async (req = {}) => {
          const r = await this.call(service, { ...req, headers: { ...req.headers ?? {}, "x-mx402-subscription": body.token } });
          return r;
        };
        return {
          token: body.token,
          subscription: body.subscription,
          service_id: service.service_id,
          periods: scheduled,
          committed: body.committed,
          includesUnits: body.includesUnits ?? null,
          call,
          cancel: async (scheduleId) => {
            const { cancelScheduled: cancelScheduled2 } = await Promise.resolve().then(() => (init_subscriptions(), subscriptions_exports));
            return cancelScheduled2(scheduleId, { accountId: this.accountId, privateKey: this.key }, this.network);
          }
        };
      }
      /** The x402 client, signing only this buyer's allowed assets and ceiling. */
      x402() {
        const client2 = new x402Client().register(this.network, new ExactHederaScheme(this.signer));
        const cap = this.maxPerCall ? { maxAmountPerPayment: this.maxPerCall.atomic.toString() } : {};
        client2.setSpendControls({
          maxAmountPerPayment: false,
          allowedAssets: ["0.0.0", ...this.assets].map((asset) => ({ network: this.network, asset, ...cap }))
        });
        return client2;
      }
      /** Would this wallet sign a transfer of that asset at all? */
      allowsAsset(asset) {
        return !asset || asset === "0.0.0" || this.assets.includes(asset);
      }
      // ── receipt + verification ──────────────────────────────────────────────
      async finish(res, quote, authorization, _pr, reqBody) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const text2 = new TextDecoder().decode(bytes);
        let data = text2;
        try {
          data = JSON.parse(text2);
        } catch {
        }
        const receipt = decodeHeader(res.headers.get("x-mx402-receipt"), SettlementReceipt);
        const settle = res.headers.get("payment-response");
        const paid = res.ok && !!receipt && !!settle && (() => {
          try {
            return decodePaymentResponseHeader(settle).success;
          } catch {
            return false;
          }
        })();
        if (receipt) this.receipts.push(receipt);
        let verification = null;
        let dispute;
        if (quote && res.ok) {
          verification = verify(quote, bytes, text2, data, reqBody);
          if (this.autoDispute && this.registryUrl && paid && (!verification.bodyHash || verification.unitsMatch === false)) {
            dispute = await this.fileDispute(quote, receipt, verification, bytes);
          }
        }
        return { ok: res.ok, status: res.status, data, text: text2, paid, quote, authorization, receipt, verification, dispute };
      }
      async fileDispute(quote, receipt, v, bytes) {
        const reason = !v.bodyHash ? "body_hash_mismatch" : "units_mismatch";
        try {
          const r = await fetch(`${this.registryUrl}/registry/services/${quote.service_id}/disputes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              quote_id: quote.quote_id,
              receipt_id: receipt?.receipt_id ?? null,
              buyer: this.accountId,
              reason,
              claimed_units: quote.measured,
              observed_units: v.remetered,
              body_sha256_claimed: quote.body_sha256,
              body_sha256_observed: createHash("sha256").update(bytes).digest("hex")
            })
          }).then((x) => x.json());
          return r.ok ? { filed: true, reason } : { filed: false, reason, error: r.error };
        } catch (e) {
          return { filed: false, reason, error: String(e).split("\n")[0] };
        }
      }
    };
  }
});

// ../../src/mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z as z2 } from "zod";

// ../../src/env.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
var ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(file) {
  if (file === void 0) {
    for (const f of [resolve(process.cwd(), ".env"), resolve(ROOT, ".env")]) loadEnv(f);
    return;
  }
  let text2;
  try {
    text2 = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text2.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const val = m[2].replace(/\s+#.*$/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === void 0) process.env[m[1]] = val;
  }
}

// ../../src/mcp.ts
loadEnv();
var { HUB_URL: HUB_URL2 } = await Promise.resolve().then(() => (init_events(), events_exports));
var { MeterX402: MeterX4022, BudgetError: BudgetError2 } = await Promise.resolve().then(() => (init_buyer(), buyer_exports));
var text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...isError ? { isError: true } : {} });
var json = (o) => text(JSON.stringify(o, null, 2));
var mxP = null;
async function makeBuyer() {
  const status = await fetch(`${HUB_URL2}/status`).then((r) => r.json()).catch(() => null);
  let accountId = process.env.BUYER_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID;
  let privateKey = process.env.BUYER_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY;
  if (status?.mode === "offline") {
    const { PrivateKey: PrivateKey2 } = await import("@hiero-ledger/sdk");
    const key = accountId && privateKey ? (await Promise.resolve().then(() => (init_hedera(), hedera_exports))).parseHederaKey(privateKey) : PrivateKey2.generateECDSA();
    accountId ??= "0.0.5002";
    privateKey = key;
    await fetch(`${status.facilitator}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId, publicKey: key.publicKey.toStringDer(), balance: String(100n * 100000000n) })
    }).catch(() => {
    });
  }
  if (!accountId || !privateKey) return null;
  return new MeterX4022({
    wallet: { accountId, privateKey },
    registry: HUB_URL2,
    budget: process.env.BUYER_BUDGET ?? "1 HBAR",
    maxPerCall: process.env.BUYER_MAX_PER_CALL
  });
}
var buyer = async () => {
  mxP ??= makeBuyer();
  return mxP;
};
var noWallet = () => text("Cannot pay: no buyer wallet. Set BUYER_ACCOUNT_ID and BUYER_PRIVATE_KEY (or HEDERA_*) in .env.", true);
var pending = /* @__PURE__ */ new Map();
var reqShape = {
  path: z2.string().optional().describe("Path on the service (default: its sample path)"),
  method: z2.string().optional().describe("GET or POST (default: the service's sample method)"),
  body: z2.string().optional().describe("Request body for POST, as JSON text (default: the service's sample body)"),
  query: z2.record(z2.string(), z2.string()).optional().describe("Query parameters"),
  max_units: z2.number().int().positive().optional().describe("Cap the work: max billable units (tokens, rows, \u2026)")
};
var toReq = (a, maxPrice) => ({ path: a.path, method: a.method, body: a.body, query: a.query, maxUnits: a.max_units, maxPrice });
function summarize(r) {
  const lines = [];
  if (r.receipt) {
    lines.push(`PAID ${r.receipt.amount} ${r.receipt.currency} for ${r.receipt.metered_units} ${r.receipt.unit} (${r.receipt.rate} per ${r.receipt.per}) \u2014 ${r.receipt.scheme} settlement on ${r.receipt.network}${r.receipt.transaction_id ? `, tx ${r.receipt.transaction_id}` : ""}`);
  } else if (r.ok) lines.push("Served free (nothing billable).");
  if (r.verification) {
    lines.push(`verified: body hash ${r.verification.bodyHash ? "matches the quote" : "DOES NOT match"}; re-metered ${r.verification.remetered ?? "n/a"} (${r.verification.unitsMatch === false ? "MISMATCH" : r.verification.method})`);
  }
  if (r.dispute?.filed) lines.push(`\u26A0 dispute filed (${r.dispute.reason})`);
  lines.push(`HTTP ${r.status}`, (typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2)).slice(0, 3500));
  return lines.join("\n");
}
var server = new McpServer({ name: "meterx402", version: "0.2.0" });
server.tool(
  "list_services",
  "Discover paid services on MeterX402 by what they do. Services are priced by what a call consumes (tokens, rows, bytes\u2026), carry a reputation score computed from their settlement and performance history, and are ranked best-first. Use get_quote or call_service next.",
  {
    capability: z2.string().optional().describe("e.g. weather_forecast, text_generation, blockchain_data"),
    query: z2.string().optional().describe("free text over names, descriptions and capabilities"),
    max_price: z2.number().positive().optional().describe("max price of a typical call"),
    min_reputation: z2.number().min(0).max(100).optional()
  },
  async ({ capability, query, max_price, min_reputation }) => {
    const q = new URLSearchParams();
    if (capability) q.set("capability", capability);
    if (query) q.set("q", query);
    if (max_price != null) q.set("maxPrice", String(max_price));
    if (min_reputation != null) q.set("minReputation", String(min_reputation));
    const { services } = await fetch(`${HUB_URL2}/registry/services?${q}`).then((r) => r.json()).catch(() => ({ services: [] }));
    if (!services.length) return text("No matching services are live right now. Start some with `npm run demo` (or demo:offline), or relax the filters.");
    return json(services.map((l) => ({
      service_id: l.service_id,
      name: l.descriptor.name,
      capabilities: l.descriptor.capabilities,
      pricing: `${l.price.rate} ${l.price.currency} per ${l.price.per === 1 ? "" : l.price.per + " "}${l.price.unit}`,
      typical_call: l.price.typical_call,
      reputation: l.reputation.score ?? `unrated (${l.reputation.sample_size} samples)`,
      interfaces: l.descriptor.interfaces,
      sample: l.descriptor.sample
    })));
  }
);
server.tool(
  "get_service",
  "Full details of one service: its ServiceDescriptor (pricing, settlement options, interfaces, sample request), price estimates and reputation.",
  { service_id: z2.string() },
  async ({ service_id }) => {
    const r = await fetch(`${HUB_URL2}/registry/services/${encodeURIComponent(service_id)}`);
    return r.ok ? json(await r.json()) : text(`No service "${service_id}" in the registry.`, true);
  }
);
server.tool(
  "get_reputation",
  "A service's ReputationRecord: a deterministic 0\u2013100 score from settlement and performance evidence (execution, response success, latency, disputes, uptime, payment reliability), with the weights and raw stats.",
  { service_id: z2.string() },
  async ({ service_id }) => {
    const r = await fetch(`${HUB_URL2}/registry/services/${encodeURIComponent(service_id)}/reputation`);
    return r.ok ? json(await r.json()) : text(`No service "${service_id}".`, true);
  }
);
server.tool(
  "get_quote",
  "Run a call on a service and get its EXACT metered price, without paying. The service holds the response until the quote expires (about 2 minutes). Pay it with pay_for_service.",
  { service_id: z2.string(), ...reqShape },
  async (a) => {
    const mx = await buyer();
    if (!mx) return noWallet();
    try {
      const q = await mx.quote(a.service_id, toReq(a));
      if (!("pay" in q)) return text(`No payment needed.
${summarize(q)}`);
      pending.set(q.quote.quote_id, q);
      setTimeout(() => pending.delete(q.quote.quote_id), Math.max(0, q.quote.expires_at - Date.now()) + 1e3).unref?.();
      return json({
        quote_id: q.quote.quote_id,
        price: `${q.quote.amount} ${q.quote.currency}`,
        metered: `${q.quote.units} ${q.quote.unit} (measured ${q.quote.measured}${q.quote.cap ? `, cap ${q.quote.cap}` : ""})`,
        expires_in_s: Math.round((q.quote.expires_at - Date.now()) / 1e3),
        budget_remaining: mx.remaining,
        quote: q.quote
      });
    } catch (e) {
      return text(`Could not quote: ${String(e?.message ?? e).split("\n")[0]}`, true);
    }
  }
);
server.tool(
  "pay_for_service",
  "Pay a quote returned by get_quote and receive the result, a SettlementReceipt and the buyer-side verification. Refused if it would exceed max_price or the session budget.",
  { quote_id: z2.string(), max_price: z2.number().positive().optional() },
  async ({ quote_id, max_price }) => {
    const q = pending.get(quote_id);
    if (!q) return text("Unknown or expired quote_id: call get_quote again.", true);
    if (max_price != null && Number(q.quote.amount) > max_price) return text(`Not paid: the quote is ${q.quote.amount} ${q.quote.currency}, above max_price ${max_price}.`, true);
    try {
      const r = await q.pay();
      pending.delete(quote_id);
      return text(summarize(r));
    } catch (e) {
      return text(`Not paid: ${String(e?.message ?? e).split("\n")[0]}`, true);
    }
  }
);
var callService = async (a) => {
  const mx = await buyer();
  if (!mx) return noWallet();
  try {
    return text(summarize(await mx.call(a.service_id, toReq(a, a.max_price))));
  } catch (e) {
    return text(`${e instanceof BudgetError2 ? "Not paid" : "Failed"}: ${String(e?.message ?? e).split("\n")[0]}`, true);
  }
};
server.tool(
  "call_service",
  "Call a service and pay exactly for what the call consumed, in one step. Set max_units to cap the work and max_price to cap the cost \u2014 the payment is refused rather than exceeding them.",
  { service_id: z2.string(), ...reqShape, max_price: z2.number().positive().optional() },
  callService
);
server.tool("list_paid_apis", "Alias of list_services.", {}, async () => {
  const { services } = await fetch(`${HUB_URL2}/registry/services`).then((r) => r.json()).catch(() => ({ services: [] }));
  return json(services.map((l) => ({ service_id: l.service_id, pricing: `${l.price.rate} ${l.price.currency} / ${l.price.unit}`, url: `${l.descriptor.endpoint}${l.descriptor.sample?.path ?? "/"}` })));
});
server.tool(
  "paid_fetch",
  "Alias of call_service taking a full URL.",
  { url: z2.string(), method: z2.string().optional(), body: z2.string().optional(), max_units: z2.number().int().positive().optional(), max_hbar: z2.number().positive().optional() },
  async ({ url, method, body, max_units, max_hbar }) => {
    const u = new URL(url);
    const mx = await buyer();
    if (!mx) return noWallet();
    try {
      const r = await mx.call(u.origin, { path: u.pathname, method, body, maxUnits: max_units, maxPrice: max_hbar, query: Object.fromEntries(u.searchParams) });
      return text(summarize(r));
    } catch (e) {
      return text(`Not paid: ${String(e?.message ?? e).split("\n")[0]}`, true);
    }
  }
);
await server.connect(new StdioServerTransport());
//# sourceMappingURL=index.js.map
