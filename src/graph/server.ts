// The Graph upstream behind the dex-pools, lending-markets and subgraph-gateway lanes.
//
//   GET|POST /pools              DEX pools across chains, one standardized query
//                                ?tokens=USDC,ETH&chains=base,arbitrum&sort=fee_apr&first=10&min_tvl=100000
//   GET|POST /markets            lending markets across protocols and chains
//                                ?tokens=USDC&sort=supply_apy|borrow_apy|tvl&first=10
//   POST     /subgraphs/<id>     any subgraph on The Graph Network: { query, variables } → { data, entities }
//   POST     /deployments/<Qm…>  the same, pinned to one deployment
//   GET      /sources            every subgraph asked, with Explorer links (no query spent)
//   GET      /health
//
// It holds the Graph API key; buyers never see it. MeterX402 gateways sit in
// front and meter rows:pools, rows:markets and json:entities, so an agent pays
// per pool, per market or per entity, and a query that errors or finds nothing
// costs nothing.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadEnv } from "../env.ts";
import { DEX_SOURCES, parsePoolQuery, queryPools, type Source } from "./standard.ts";
import { LENDING_SOURCES, parseMarketQuery, queryMarkets } from "./lending.ts";
import { DEPLOYMENT_ID, SUBGRAPH_ID, checkGraphqlBody, proxySubgraph } from "./subgraphs.ts";

loadEnv();

const PORT = Number(process.env.MX_GRAPH_PORT ?? 4130);
const MAX_BODY = 64 * 1024;
class TooLarge extends Error {}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new TooLarge();
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

const explorer = (id: string) => `https://thegraph.com/explorer/subgraphs/${id}`;
const describe = (s: Source) => ({
  protocol: s.protocol, chain: s.chain, chain_id: s.chainId, subgraph: s.id, schema: s.kind ?? "messari", explorer: explorer(s.id),
  ...(s.fallback ? { fallback: { subgraph: s.fallback.id, schema: s.fallback.kind, explorer: explorer(s.fallback.id) } } : {}),
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const apiKey = process.env.GRAPH_API_KEY ?? "";
  const opts = { apiKey, gateway: process.env.GRAPH_GATEWAY };
  const params = async () => (req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams));
  try {
    if (path === "/health") return send(res, 200, { ok: true, dex_sources: DEX_SOURCES.length, lending_sources: LENDING_SOURCES.length, key: !!apiKey });
    if (path === "/sources") {
      return send(res, 200, {
        dex: { schema: "messari dex-amm, with Uniswap v3 fallbacks", sources: DEX_SOURCES.map(describe) },
        lending: { schema: "messari lending", sources: LENDING_SOURCES.map(describe) },
      });
    }
    // a 5xx is never billed by the gateway, so a missing key costs nobody anything
    if (!apiKey) return send(res, 503, { error: "GRAPH_API_KEY is not set on this service" });

    if (path === "/pools" || path === "/") {
      const result = await queryPools(parsePoolQuery(await params()), opts);
      const answered = result.sources.filter((s) => s.ok).length;
      if (!answered && result.sources.length) return send(res, 502, { error: "no subgraph answered", sources: result.sources });
      const fallbacks = result.sources.filter((s) => s.via === "fallback").length;
      return send(res, 200, {
        schema: "messari dex-amm",
        query: result.query,
        pools: result.pools,
        sources: result.sources,
        summary: `${result.pools.length} pools from ${answered}/${result.sources.length} subgraphs${fallbacks ? ` (${fallbacks} via Uniswap's own subgraph)` : ""}`,
      });
    }

    if (path === "/markets") {
      const result = await queryMarkets(parseMarketQuery(await params()), opts);
      const answered = result.sources.filter((s) => s.ok).length;
      if (!answered && result.sources.length) return send(res, 502, { error: "no subgraph answered", sources: result.sources });
      return send(res, 200, {
        schema: "messari lending",
        query: result.query,
        markets: result.markets,
        sources: result.sources,
        summary: `${result.markets.length} markets from ${answered}/${result.sources.length} standardized lending subgraphs`,
      });
    }

    const m = path.match(/^\/(subgraphs|deployments)\/([^/]+)$/);
    if (m) {
      const kind = m[1] as "subgraphs" | "deployments";
      const id = m[2];
      if (!(kind === "subgraphs" ? SUBGRAPH_ID : DEPLOYMENT_ID).test(id)) return send(res, 400, { error: `not a ${kind === "subgraphs" ? "subgraph" : "deployment"} id: ${id}` });
      if (req.method !== "POST") return send(res, 405, { error: 'POST a GraphQL body: { "query": "{ … }", "variables": { … } }' });
      const checked = checkGraphqlBody(await readJson(req));
      if (!checked.ok) return send(res, 400, { error: checked.error });
      const r = await proxySubgraph(kind, id, checked.payload, opts);
      if (r.status === 0 || r.status >= 500) return send(res, 502, { ...r.json, entities: 0 });
      // GraphQL errors arrive with HTTP 200 and no data: zero entities, zero cost
      return send(res, 200, { ...r.json, entities: r.entities, subgraph: id });
    }

    return send(res, 404, { error: "try /pools, /markets, POST /subgraphs/<id> or /sources" });
  } catch (e) {
    if (e instanceof TooLarge) return send(res, 413, { error: `request body over ${MAX_BODY / 1024} KB` });
    return send(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
}).listen(PORT, "127.0.0.1", () =>
  console.log(`[graph] DEX pools (${DEX_SOURCES.length}), lending markets (${LENDING_SOURCES.length}) and any subgraph on :${PORT}`));
