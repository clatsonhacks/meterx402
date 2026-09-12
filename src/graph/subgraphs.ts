// Any subgraph, paid per entity.
//
// The Graph Network serves 15,000+ subgraphs, but querying one needs a Graph
// API key, which an agent paying its own way usually does not have. This is
// the missing piece: POST a GraphQL body to /subgraphs/<id>, the service adds
// its key, and a MeterX402 gateway in front bills `json:entities`, every
// object in the answer counted once. A query that errors, or finds nothing,
// counts zero and costs nothing.

export const SUBGRAPH_ID = /^[1-9A-HJ-NP-Za-km-z]{40,50}$/;
export const DEPLOYMENT_ID = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const MAX_QUERY_CHARS = 20_000;

/** Every object in a GraphQL `data` payload (the payload itself excluded). */
export function countEntities(data: unknown): number {
  let n = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") { n++; Object.values(v).forEach(walk); }
  };
  if (data && typeof data === "object" && !Array.isArray(data)) Object.values(data).forEach(walk);
  else walk(data);
  return n;
}

export type GraphqlPayload = { query: string; variables?: Record<string, unknown>; operationName?: string };

/** What a buyer may send: a read-only query of sane size. */
export function checkGraphqlBody(body: Record<string, unknown>): { ok: true; payload: GraphqlPayload } | { ok: false; error: string } {
  const query = typeof body.query === "string" ? body.query : "";
  if (!query.trim()) return { ok: false, error: 'send a GraphQL body: { "query": "{ … }" }' };
  if (query.length > MAX_QUERY_CHARS) return { ok: false, error: `the query is over ${MAX_QUERY_CHARS.toLocaleString("en-US")} characters` };
  if (/^\s*(mutation|subscription)\b/m.test(query)) return { ok: false, error: "only queries are allowed" };
  const variables = body.variables && typeof body.variables === "object" && !Array.isArray(body.variables) ? (body.variables as Record<string, unknown>) : undefined;
  return {
    ok: true,
    payload: { query, ...(variables ? { variables } : {}), ...(typeof body.operationName === "string" ? { operationName: body.operationName } : {}) },
  };
}

export async function proxySubgraph(
  kind: "subgraphs" | "deployments",
  id: string,
  payload: GraphqlPayload,
  opts: { apiKey: string; gateway?: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<{ status: number; json: any; entities: number }> {
  const url = `${(opts.gateway ?? "https://gateway.thegraph.com").replace(/\/+$/, "")}/api/${kind}/id/${id}`;
  try {
    const r = await (opts.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const json: any = await r.json().catch(() => ({ errors: [{ message: `HTTP ${r.status} from The Graph gateway` }] }));
    return { status: r.status, json, entities: json?.errors?.length && !json?.data ? 0 : countEntities(json?.data) };
  } catch (e) {
    return { status: 0, json: { errors: [{ message: String((e as Error)?.message ?? e).slice(0, 200) }] }, entities: 0 };
  }
}
