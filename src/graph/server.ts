// The upstream behind the `dex-pools` lane: one standardized question, asked
// of every Messari DEX subgraph on The Graph at once.
//
//   GET  /pools?tokens=USDC,ETH&chains=base,arbitrum&protocols=uniswap-v3&min_tvl=100000&first=10&sort=fee_apr
//   POST /pools   { "tokens": ["USDC","ETH"], "sort": "volume" }
//   GET  /sources the subgraphs asked, with Graph Explorer links (no query spent)
//   GET  /health
//
// It holds the Graph API key; buyers never see it. A MeterX402 gateway sits in
// front and meters `rows:pools`, so a caller pays per pool returned, in HBAR
// or USDC, and nothing for a question with no answers.

import { createServer, type IncomingMessage } from "node:http";
import { loadEnv } from "../env.ts";
import { DEX_SOURCES, parsePoolQuery, queryPools } from "./standard.ts";

loadEnv();

const PORT = Number(process.env.MX_GRAPH_PORT ?? 4130);
const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (path === "/health") return send(res, 200, { ok: true, sources: DEX_SOURCES.length, key: !!process.env.GRAPH_API_KEY });
    if (path === "/sources") {
      return send(res, 200, {
        schema: "messari dex-amm (standardized)",
        sources: DEX_SOURCES.map((s) => ({ ...s, explorer: `https://thegraph.com/explorer/subgraphs/${s.id}` })),
      });
    }
    if (path === "/pools" || path === "/") {
      const apiKey = process.env.GRAPH_API_KEY;
      // a 5xx is never billed by the gateway, so a missing key costs nobody anything
      if (!apiKey) return send(res, 503, { error: "GRAPH_API_KEY is not set on this service" });
      const params = req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams);
      const q = parsePoolQuery(params);
      const result = await queryPools(q, { apiKey, gateway: process.env.GRAPH_GATEWAY });
      const answered = result.sources.filter((s) => s.ok).length;
      if (!answered && result.sources.length) return send(res, 502, { error: "no subgraph answered", sources: result.sources });
      return send(res, 200, {
        schema: "messari dex-amm",
        query: result.query,
        pools: result.pools,
        sources: result.sources,
        summary: `${result.pools.length} pools from ${answered}/${result.sources.length} standardized subgraphs`,
      });
    }
    return send(res, 404, { error: "try /pools or /sources" });
  } catch (e) {
    return send(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`[graph] standardized DEX data on :${PORT} (${DEX_SOURCES.length} subgraphs)`));
