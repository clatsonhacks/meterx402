// Mock upstream APIs, so the whole product can be demoed and tested offline.
// Each answers with the SAME shapes the real services use, which is what the
// meters read:
//
//   POST /v1/chat/completions  OpenAI-compatible LLM with a real `usage` block.
//                              Answer length follows the prompt ("in N words")
//                              and honours max_tokens, like a real model.
//   POST /api/chat             Ollama-native shape (prompt_eval_count / eval_count)
//   POST /graphql              GraphQL: `pools(first: N)` returns N rows
//   GET  /blob?kb=N            N kilobytes of JSON
//   GET  /price                a tiny fixed response (flat-priced lane)
//   GET  /fail                 a 500, for "upstream errors are free"
//
// `stream: true` on the chat route returns SSE chunks (plus a final usage chunk
// with stream_options.include_usage): what the tab streaming path meters.
//
// Tokens are counted as whitespace-separated words, deterministically, so a
// test can predict the exact bill.

import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

const WORDS = "metered x402 settles exactly what each call consumes on hedera and nothing more".split(" ");
const countTokens = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function answer(prompt: string, maxTokens?: number): string {
  // "…in 40 words" → 40 words; otherwise 12
  const m = /in\s+(\d+)\s+words/i.exec(prompt);
  let n = m ? Number(m[1]) : 12;
  if (maxTokens != null) n = Math.min(n, maxTokens);
  return Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length]).join(" ");
}

export async function startMockUpstream(port = 0): Promise<{ url: string; server: Server; hits: () => number; close(): Promise<void> }> {
  let hits = 0;
  const server = createServer(async (req, res) => {
    hits++;
    const url = new URL(req.url ?? "/", "http://m");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch {}
    const json = (code: number, data: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };

    // an upstream auth check, so tests can prove the operator's key is injected
    if (url.pathname.startsWith("/private") && req.headers["x-api-key"] !== "sekret") return json(401, { error: "bad key" });

    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/private/v1/chat/completions")) {
      const prompt = (body.messages ?? []).map((m: any) => m.content).join("\n");
      const text = answer(prompt, body.max_tokens ?? body.max_completion_tokens);
      // Streaming (OpenAI SSE), so the metered streaming path has something real
      // to count: one word per chunk, and a final `usage` chunk when asked.
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const words = text.split(" ");
        for (const [i, w] of words.entries()) {
          res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: i ? " " + w : w } }] })}\n\n`);
          await new Promise((r) => setTimeout(r, 3));
        }
        if (body.stream_options?.include_usage) {
          const pt = countTokens(prompt);
          res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: pt, completion_tokens: words.length, total_tokens: pt + words.length } })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      const prompt_tokens = countTokens(prompt);
      const completion_tokens = countTokens(text);
      return json(200, {
        id: "chatcmpl-mock", object: "chat.completion", model: body.model ?? "mock-1",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: body.max_tokens != null && completion_tokens >= body.max_tokens ? "length" : "stop" }],
        usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
      });
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const prompt = (body.messages ?? []).map((m: any) => m.content).join("\n");
      const text = answer(prompt, body.options?.num_predict);
      return json(200, { model: body.model ?? "mock", message: { role: "assistant", content: text }, done: true, prompt_eval_count: countTokens(prompt), eval_count: countTokens(text) });
    }
    if (req.method === "POST" && url.pathname === "/graphql") {
      const q = String(body.query ?? "");
      const first = Number(/first\s*:\s*(\d+)/.exec(q)?.[1] ?? 10);
      const pools = Array.from({ length: Math.min(first, 1000) }, (_, i) => ({ id: `0xpool${i}`, totalValueLockedUSD: String(1_000_000 - i * 1000) }));
      return json(200, { data: { pools } });
    }
    if (req.method === "GET" && url.pathname === "/blob") {
      const kb = Number(url.searchParams.get("kb") ?? 1);
      return json(200, { pad: "x".repeat(Math.max(0, kb * 1000 - 10)) });
    }
    if (req.method === "GET" && url.pathname === "/price") return json(200, { ethereum: { usd: 4242.42 } });
    if (url.pathname === "/fail") return json(500, { error: "upstream exploded" });
    if (url.pathname === "/empty") return json(200, { data: { pools: [] } });
    json(404, { error: "no such mock route", path: url.pathname });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  const p = (server.address() as any).port;
  return { url: `http://127.0.0.1:${p}`, server, hits: () => hits, close: () => new Promise((r) => server.close(() => r())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMockUpstream(Number(process.env.MOCK_UPSTREAM_PORT ?? 4800)).then((m) =>
    console.log(`🧪 mock upstream (LLM /v1/chat/completions, GraphQL /graphql, /blob, /price) on ${m.url}`));
}
