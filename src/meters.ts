// Meters: what a response consumed, read off the real response.
//
// A meter has two jobs:
//   measure() — count units from the upstream response (after the call)
//   clamp()   — shrink the upstream request to the buyer's cap (before the call),
//               so a cap limits the work done, not only what is billed
//
// Specs (the --meter flag / "meter" in lanes.json):
//   tokens           LLM tokens, input + output (OpenAI, Anthropic, Ollama, Gemini shapes)
//   tokens:output    output tokens only
//   rows             items returned (GraphQL top-level lists, JSON arrays, {result:[...]})
//   rows:<path>      length of the array at a dotted path, e.g. rows:data.pools
//   bytes            response body size
//   ms               upstream wall-clock time
//   json:<path>      a number the upstream reports itself, e.g. json:usage.credits
//   request          1 per call: flat pricing, exactly what GlassBox402 did

export interface MeterInput {
  reqBody: unknown;   // parsed request body (JSON), if any
  status: number;
  resText: string;
  resJson: unknown;   // parsed response body, or undefined if not JSON
  bytes: number;      // response body size in bytes
  ms: number;         // upstream wall time
}

/** Counts units as bytes go past, for responses that are streamed to the buyer
 *  instead of buffered (see the tab streaming path in gateway.ts). */
export interface StreamMeter {
  onChunk(text: string): void;
  /** Units counted so far (used live, to stop at the cap). */
  units(): number;
}

export interface Meter {
  spec: string;
  unit: string;
  measure(i: MeterInput): number;
  /** Present only on meters that can count a response as it streams. */
  stream?(reqBody: unknown): StreamMeter;
  /** Rewrite the upstream request body so it can't exceed `cap` units. */
  clamp?(reqBody: unknown, cap: number): unknown;
  /** A cap the buyer declared inside the request itself (e.g. max_tokens). */
  capFromRequest?(reqBody: unknown): number | undefined;
}

type J = Record<string, any>;
const isObj = (x: unknown): x is J => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const k of path.split(".").filter(Boolean)) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(k) ? cur[Number(k)] : cur[k];
  }
  return cur;
}

// ── tokens ────────────────────────────────────────────────────────────────

export interface TokenUsage { input: number; output: number; source: string; }

/** Token usage as reported by the upstream, across the common API shapes. */
export function tokenUsage(res: unknown): TokenUsage | null {
  if (!isObj(res)) return null;
  const u = res.usage;
  if (isObj(u)) {
    // OpenAI chat/completions
    const pt = num(u.prompt_tokens), ct = num(u.completion_tokens);
    if (pt != null || ct != null) return { input: pt ?? 0, output: ct ?? Math.max(0, (num(u.total_tokens) ?? 0) - (pt ?? 0)), source: "openai" };
    // OpenAI responses API / Anthropic
    const it = num(u.input_tokens), ot = num(u.output_tokens);
    if (it != null || ot != null) return { input: it ?? 0, output: ot ?? 0, source: "input/output_tokens" };
    const tt = num(u.total_tokens);
    if (tt != null) return { input: 0, output: tt, source: "total_tokens" };
  }
  // Ollama native (/api/chat, /api/generate)
  const pe = num(res.prompt_eval_count), ev = num(res.eval_count);
  if (pe != null || ev != null) return { input: pe ?? 0, output: ev ?? 0, source: "ollama" };
  // Gemini
  const g = res.usageMetadata;
  if (isObj(g)) {
    const p = num(g.promptTokenCount) ?? 0, c = num(g.candidatesTokenCount);
    return { input: p, output: c ?? Math.max(0, (num(g.totalTokenCount) ?? 0) - p), source: "gemini" };
  }
  return null;
}

/** The generated text, for the fallback estimate when an upstream reports no usage. */
export function outputText(res: unknown, raw: string): string {
  if (isObj(res)) {
    const c = res.choices?.[0];
    if (typeof c?.message?.content === "string") return c.message.content;
    if (typeof c?.text === "string") return c.text;
    if (Array.isArray(res.content)) return res.content.map((p: any) => p?.text ?? "").join("");
    if (typeof res.response === "string") return res.response;
    if (typeof res.message?.content === "string") return res.message.content;
    if (typeof res.output_text === "string") return res.output_text;
  }
  return raw;
}

function inputText(req: unknown): string {
  if (!isObj(req)) return "";
  if (Array.isArray(req.messages)) return req.messages.map((m: any) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""))).join("\n");
  if (typeof req.prompt === "string") return req.prompt;
  if (typeof req.input === "string") return req.input;
  return "";
}

/** ~4 characters per token: the usual rule of thumb, used only when the
 *  upstream doesn't report usage. Estimates are rounded up. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const TOKEN_CAP_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;

function tokensMeter(mode: "total" | "output"): Meter {
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
      // Server-sent events: each "data: {...}" chunk carries a delta, and the
      // last one carries `usage` when the caller asked for it (stream_options).
      const prompt = mode === "total" ? estimateTokens(inputText(reqBody)) : 0;
      let text = "", reported: TokenUsage | null = null, buffer = "";
      return {
        onChunk(chunk) {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? ""; // keep the partial line
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
              if (typeof d === "string") text += d;
            } catch {
              text += payload; // not JSON: count it as plain output
            }
          }
        },
        units() {
          if (reported) return mode === "output" ? reported.output : reported.input + reported.output;
          return estimateTokens(text) + prompt;
        },
      };
    },
    capFromRequest(req) {
      if (!isObj(req)) return undefined;
      for (const f of TOKEN_CAP_FIELDS) if (num(req[f]) != null) return req[f];
      return num(req.options?.num_predict);
    },
    clamp(req, cap) {
      if (!isObj(req)) return req;
      const out: J = { ...req };
      // the gateway holds the whole response before quoting, so it can't stream
      if (out.stream === true) out.stream = false;
      let set = false;
      for (const f of TOKEN_CAP_FIELDS) {
        if (num(out[f]) != null) { out[f] = Math.min(out[f], cap); set = true; }
      }
      if (isObj(out.options)) { // Ollama native
        out.options = { ...out.options, num_predict: Math.min(num(out.options.num_predict) ?? cap, cap) };
        set = true;
      }
      // OpenAI-compatible default. Only for LLM-shaped bodies: never inject
      // fields into an arbitrary API's JSON.
      if (!set && (Array.isArray(out.messages) || typeof out.prompt === "string")) out.max_tokens = cap;
      return out;
    },
  };
}

// ── rows ──────────────────────────────────────────────────────────────────

/** Items in a response: GraphQL top-level fields, a JSON array, or a common
 *  list envelope ({result: [...]}, {items: [...]}, ...). */
export function countRows(res: unknown): number {
  if (Array.isArray(res)) return res.length;
  if (!isObj(res)) return 0;
  if (isObj(res.data)) {
    // GraphQL: { data: { pools: [...], bundle: {...} } }
    let n = 0;
    for (const v of Object.values(res.data)) n += Array.isArray(v) ? v.length : v == null ? 0 : 1;
    return n;
  }
  for (const k of ["data", "result", "results", "items", "rows", "records", "entries"]) {
    if (Array.isArray(res[k])) return res[k].length;
  }
  return 1;
}

/** Clamp every `first: N` in a GraphQL query to the cap, so a cap limits the
 *  work the upstream does, not only what is billed. */
export function clampGraphqlFirst(query: string, cap: number): string {
  return query.replace(/\bfirst\s*:\s*(\d+)/g, (_, n: string) => `first: ${Math.min(Number(n), cap)}`);
}

function rowsMeter(path?: string): Meter {
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
    },
  };
}

// ── registry ──────────────────────────────────────────────────────────────

export function makeMeter(spec = "request"): Meter {
  const [kind, arg] = [spec.split(":")[0], spec.split(":").slice(1).join(":")];
  switch (kind) {
    case "tokens":
      return tokensMeter(arg === "output" ? "output" : "total");
    case "rows":
      return rowsMeter(arg || undefined);
    case "bytes":
      return {
        spec, unit: "bytes", measure: (i) => i.bytes,
        stream: () => { let n = 0; return { onChunk: (t) => { n += Buffer.byteLength(t); }, units: () => n }; },
      };
    case "ms":
      return { spec, unit: "ms", measure: (i) => i.ms };
    case "json": {
      if (!arg) throw new Error("json meter needs a path, e.g. --meter json:usage.credits");
      return { spec, unit: arg.split(".").pop()!, measure: (i) => Number(getPath(i.resJson, arg)) || 0 };
    }
    case "request":
    case "flat":
      return { spec: "request", unit: "requests", measure: () => 1 };
    default:
      throw new Error(`unknown meter "${spec}". try: tokens, tokens:output, rows, rows:<path>, bytes, ms, json:<path>, request`);
  }
}
