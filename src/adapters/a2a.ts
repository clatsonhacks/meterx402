// A2A adapter: every MeterX402 service is also an A2A agent.
//
//   GET  /.well-known/agent.json        the agent card (skills = capabilities, pricing in x-mx402)
//   POST /a2a                            JSON-RPC 2.0: message/send, tasks/get
//
// Payment follows the shape of the a2a-x402 extension: when a task needs paying,
// it comes back `input-required` with metadata
//   x402.payment.status   = "payment-required"
//   x402.payment.required = the x402 PaymentRequired (our exact metered quote)
// and the client answers on the same taskId with
//   x402.payment.payload  = a signed x402 PaymentPayload
// after which the task completes with the result as an artifact, plus
//   x402.payment.receipts / mx402.receipt.
//
// The adapter owns no payment logic. It turns A2A messages into requests on this
// gateway's own REST path (over loopback, tagged as the A2A interface), so the
// metering, holds, caps, settlement and receipts are exactly the ones REST uses.

import type { Hono, Context } from "hono";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { decodeHeader, PaymentQuote, SettlementReceipt, type ServiceDescriptor } from "../protocol/schemas.ts";

export const A2A_X402_EXTENSION = "https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.1";

// ── A2A shapes (the subset we use) ────────────────────────────────────────

export type Part = { kind: "text"; text: string } | { kind: "data"; data: Record<string, unknown> };
export interface Message {
  kind: "message";
  role: "user" | "agent";
  messageId: string;
  parts: Part[];
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}
export type TaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";
export interface Task {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState; message?: Message; timestamp: string };
  artifacts?: { artifactId: string; name: string; parts: Part[] }[];
  metadata?: Record<string, unknown>;
}

interface Pending {
  task: Task;
  request: { method: string; path: string; body?: string };
  client: string;
  maxUnits?: number;
  expires: number;
}

export interface A2AContext {
  descriptor: () => ServiceDescriptor;
  selfUrl: string;         // loopback URL of this gateway
  internalToken: string;   // proves the loopback hop came from this adapter
  cors: Record<string, string>;
  log?: (...a: unknown[]) => void;
}

export function agentCard(d: ServiceDescriptor) {
  const price = `${d.pricing.rate} ${d.pricing.currency} per ${d.pricing.per === 1 ? "" : d.pricing.per + " "}${d.pricing.unit}`;
  return {
    protocolVersion: "0.3.0",
    name: d.name,
    description: d.description ?? d.name,
    url: `${d.endpoint}/a2a`,
    preferredTransport: "JSONRPC",
    version: "1.0.0",
    provider: { organization: d.owner.account, url: d.endpoint },
    // HCS-14: one identity for this agent wherever it is met
    ...(d.uaid ? { uaid: d.uaid, additionalInterfaces: [{ transport: "HCS-14", url: d.uaid }] } : {}),
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [{ uri: A2A_X402_EXTENSION, description: `x402 payments, metered: ${price}`, required: true }],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills: d.capabilities.map((cap) => ({
      id: cap,
      name: cap.replace(/_/g, " "),
      description: `${d.description ?? d.name}. Metered: ${price}.`,
      tags: [cap, d.pricing.unit, "x402", "metered"],
      examples: d.sample ? [`${d.sample.method} ${d.sample.path}`] : [],
    })),
    "x-mx402": { service_id: d.service_id, uaid: d.uaid, descriptor: d.links.descriptor, pricing: d.pricing, settlement: d.payment.settlement },
  };
}

const now = () => new Date().toISOString();
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const agentMessage = (text: string, taskId: string, contextId: string): Message => ({ kind: "message", role: "agent", messageId: crypto.randomUUID(), parts: [{ kind: "text", text }], taskId, contextId });

/** Turn an A2A message into a request on this service. A data part can say it
 *  exactly ({request:{method,path,body}}); plain text is fitted to the
 *  service's sample request (an LLM prompt, a GraphQL query, or the sample call). */
export function requestFromMessage(msg: Message, d: ServiceDescriptor): { method: string; path: string; body?: string } {
  const sample = d.sample ?? { method: "GET", path: "/" };
  const data = msg.parts.find((p): p is Extract<Part, { kind: "data" }> => p.kind === "data")?.data;
  const req = (data?.request ?? data) as Record<string, any> | undefined;
  if (req && (req.path || req.body || req.method)) {
    const body = req.body == null ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    return { method: String(req.method ?? (body ? "POST" : sample.method)).toUpperCase(), path: String(req.path ?? sample.path), body };
  }
  const text = msg.parts.filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("\n").trim();
  if (text && sample.body) {
    try {
      const base = JSON.parse(sample.body);
      if (Array.isArray(base.messages)) return { method: "POST", path: sample.path, body: JSON.stringify({ ...base, messages: [{ role: "user", content: text }] }) };
      if (typeof base.query === "string" && /^\s*(\{|query\b)/.test(text)) return { method: "POST", path: sample.path, body: JSON.stringify({ ...base, query: text }) };
    } catch {}
  }
  return { method: sample.method, path: sample.path, body: sample.body };
}

export function mountA2A(app: Hono, ctx: A2AContext) {
  const tasks = new Map<string, Pending>();
  const TTL = 10 * 60_000;
  const sweep = () => { const t = Date.now(); for (const [k, v] of tasks) if (v.expires < t) tasks.delete(k); };

  const card = (c: Context) => c.json(agentCard(ctx.descriptor()), 200, ctx.cors);
  app.get("/.well-known/agent.json", card);
  app.get("/.well-known/agent-card.json", card);

  /** One hop to our own REST path, tagged as A2A, carrying the real client. */
  const callSelf = (p: Pending, payment?: PaymentPayload) => {
    const headers: Record<string, string> = {
      "x-mx402-internal": ctx.internalToken,
      "x-mx402-client": p.client,
      "x-mx402-interface": "a2a",
      accept: "application/json",
    };
    if (p.request.body) headers["content-type"] = "application/json";
    if (p.maxUnits) headers["x-meter-max-units"] = String(p.maxUnits);
    if (payment) headers["PAYMENT-SIGNATURE"] = encodePaymentSignatureHeader(payment);
    return fetch(`${ctx.selfUrl}${p.request.path}`, { method: p.request.method, headers, body: p.request.method === "GET" ? undefined : p.request.body });
  };

  /** Fold a gateway response into the task. */
  const advance = async (p: Pending, res: Response, paid: boolean): Promise<Task> => {
    const t = p.task;
    const text = await res.text();
    if (res.status === 402) {
      const header = res.headers.get("payment-required");
      const required: PaymentRequired | null = header ? decodePaymentRequiredHeader(header) : null;
      const quote = decodeHeader(res.headers.get("x-mx402-quote"), PaymentQuote);
      let error: string | undefined;
      try { error = JSON.parse(text)?.error; } catch {}
      t.status = {
        state: "input-required",
        timestamp: now(),
        message: agentMessage(quote ? `Payment required: ${quote.amount} ${quote.currency} for ${quote.units} ${quote.unit} (metered).` : "Payment required.", t.id, t.contextId),
      };
      t.metadata = {
        "x402.payment.status": paid ? "payment-failed" : "payment-required",
        ...(required ? { "x402.payment.required": required } : {}),
        ...(quote ? { "mx402.quote": quote } : {}),
        ...(paid && error ? { "x402.payment.error": error } : {}),
      };
      return t;
    }
    if (!res.ok) {
      t.status = { state: "failed", timestamp: now(), message: agentMessage(`The service answered HTTP ${res.status}: ${text.slice(0, 300)}`, t.id, t.contextId) };
      t.metadata = { ...(t.metadata ?? {}), "x402.payment.status": paid ? "payment-failed" : "not-required" };
      return t;
    }
    let part: Part;
    try { part = { kind: "data", data: { result: JSON.parse(text) } }; } catch { part = { kind: "text", text }; }
    const receipt = decodeHeader(res.headers.get("x-mx402-receipt"), SettlementReceipt);
    const settle = res.headers.get("payment-response");
    t.artifacts = [{ artifactId: crypto.randomUUID(), name: "result", parts: [part] }];
    t.status = { state: "completed", timestamp: now() };
    t.metadata = {
      ...(t.metadata ?? {}),
      "x402.payment.status": paid ? "payment-completed" : "not-required",
      ...(settle ? { "x402.payment.receipts": [decodePaymentResponseHeader(settle)] } : {}),
      ...(receipt ? { "mx402.receipt": receipt } : {}),
    };
    return t;
  };

  app.post("/a2a", async (c) => {
    sweep();
    const rpc = await c.req.json().catch(() => null) as { id?: unknown; method?: string; params?: any } | null;
    if (!rpc || typeof rpc.method !== "string") return c.json(rpcError(null, -32700, "parse error"), 200, ctx.cors);
    const client = (c.env as any)?.incoming?.socket?.remoteAddress ?? "a2a";

    if (rpc.method === "tasks/get") {
      const p = tasks.get(String(rpc.params?.id ?? ""));
      return c.json(p ? rpcResult(rpc.id, p.task) : rpcError(rpc.id, -32001, "task not found"), 200, ctx.cors);
    }
    if (rpc.method !== "message/send") return c.json(rpcError(rpc.id, -32601, `method not found: ${rpc.method}`), 200, ctx.cors);

    const msg = rpc.params?.message as Message | undefined;
    if (!msg || !Array.isArray(msg.parts)) return c.json(rpcError(rpc.id, -32602, "params.message with parts is required"), 200, ctx.cors);
    const meta = msg.metadata ?? {};
    const payment = meta["x402.payment.payload"] as PaymentPayload | undefined;

    // Paying for an existing task
    if (msg.taskId && tasks.has(msg.taskId)) {
      const p = tasks.get(msg.taskId)!;
      if (!payment) return c.json(rpcError(rpc.id, -32602, "this task is waiting for x402.payment.payload"), 200, ctx.cors);
      const task = await advance(p, await callSelf(p, payment), true);
      ctx.log?.(`[a2a] task ${task.id} → ${task.status.state}`);
      return c.json(rpcResult(rpc.id, task), 200, ctx.cors);
    }

    // A new task: run it unpaid; the gateway meters it and answers with a quote
    const d = ctx.descriptor();
    const task: Task = { kind: "task", id: crypto.randomUUID(), contextId: msg.contextId ?? crypto.randomUUID(), status: { state: "submitted", timestamp: now() } };
    const maxUnits = Number(meta["mx402.max_units"]) || undefined;
    const p: Pending = { task, request: requestFromMessage(msg, d), client, maxUnits, expires: Date.now() + TTL };
    tasks.set(task.id, p);
    if (tasks.size > 5000) tasks.delete(tasks.keys().next().value!);
    const result = await advance(p, await callSelf(p), false);
    return c.json(rpcResult(rpc.id, result), 200, ctx.cors);
  });
}

// ── client side (used by the agent SDK) ───────────────────────────────────

export async function fetchAgentCard(baseUrl: string): Promise<ReturnType<typeof agentCard>> {
  const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/.well-known/agent.json`);
  if (!r.ok) throw new Error(`no A2A agent card at ${baseUrl} (HTTP ${r.status})`);
  return r.json();
}

export async function a2aCall(rpcUrl: string, method: string, params: unknown): Promise<any> {
  const r = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`A2A ${method}: ${j.error.message}`);
  return j.result;
}
