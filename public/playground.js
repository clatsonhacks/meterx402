// Playground: every way into a service, generated from its live descriptor.
//
// Pick a service and an integration; the code on the right is filled in with
// that service's real id, endpoint, sample request and price. "Run" performs
// the same call through this hub's buyer (quote → budget → pay → receipt →
// verify), or the A2A task flow, so what you read is what actually happens.

const PG = { id: null, integ: "sdk", file: 0, touched: false };

const INTEGRATIONS = [
  { id: "sdk", title: "Buyer SDK", sub: "TypeScript · quote, then pay", run: "quote" },
  { id: "agent", title: "Agent SDK", sub: "discover by capability · budgets · tabs", run: "quote" },
  { id: "mcp", title: "MCP connector", sub: "Claude Code, Claude Desktop, any MCP client", run: "quote", labels: { quote: "get_quote", pay: "pay_for_service" } },
  { id: "a2a", title: "A2A", sub: "agent card + JSON-RPC task, x402 in metadata", run: "a2a" },
  { id: "http", title: "HTTP / x402", sub: "curl and any x402 client", run: "quote" },
  { id: "cli", title: "CLI", sub: "inspect, check, publish", run: "inspect" },
];

function refreshPlaygroundServices() {
  const sel = $("pg-service");
  const ids = M.services.map((l) => l.service_id);
  if (!PG.id || !ids.includes(PG.id)) PG.id = ids[0] ?? null;
  const current = [...sel.options].map((o) => o.value).join();
  if (current !== ids.join()) {
    sel.innerHTML = M.services.map((l) => `<option value="${esc(l.service_id)}">${esc(l.descriptor.name)} · ${esc(l.descriptor.capabilities[0] ?? "")}</option>`).join("") || `<option value="">no services yet</option>`;
    sel.value = PG.id ?? "";
    if (!PG.touched) fillRequest();
    renderPlayground();
  }
}

function svc() { return M.services.find((l) => l.service_id === PG.id)?.descriptor ?? null; }

function fillRequest() {
  const d = svc();
  if (!d) return;
  const s = d.sample ?? { method: "GET", path: "/" };
  $("pg-method").value = s.method;
  $("pg-path").value = s.path;
  $("pg-body").value = s.body ?? "";
}

function req() {
  const method = $("pg-method").value;
  let body = method === "GET" ? "" : $("pg-body").value.trim();
  return { method, path: $("pg-path").value || "/", body, maxUnits: $("pg-maxunits").value, maxPrice: $("pg-maxprice").value };
}

const js = (v) => JSON.stringify(v);
const bodyLiteral = (b) => { if (!b) return null; try { return JSON.stringify(JSON.parse(b), null, 2).replace(/\n/g, "\n  "); } catch { return js(b); } };

/** The code for one integration, as tabs of files. */
function generate(d, r) {
  const H = location.origin;
  const cap = d.capabilities[0];
  const maxP = r.maxPrice || "0.05";
  const opts = [r.path !== (d.sample?.path ?? "/") ? `path: ${js(r.path)}` : null, r.method !== (d.sample?.method ?? "GET") ? `method: ${js(r.method)}` : null, r.body && r.body !== (d.sample?.body ?? "") ? `body: ${bodyLiteral(r.body)}` : null, r.maxUnits ? `maxUnits: ${r.maxUnits}` : null].filter(Boolean);
  const reqObj = opts.length ? `{ ${opts.join(", ")} }` : "{}";
  const wallet = `{ accountId: process.env.BUYER_ACCOUNT_ID!, privateKey: process.env.BUYER_PRIVATE_KEY! }`;
  const url = `${d.endpoint}${r.path}`;
  const curlBody = r.body ? ` \\\n  -H 'content-type: application/json' -d '${r.body.replace(/'/g, "'\\''")}'` : "";
  const unitsHdr = r.maxUnits ? ` \\\n  -H 'x-meter-max-units: ${r.maxUnits}'` : "";

  switch (PG.integ) {
    case "sdk": return [{ name: "buy.ts", code:
`import { MeterX402 } from "mx402";

const mx = new MeterX402({
  wallet: ${wallet},
  budget: "1 HBAR",              // checked before anything is signed
  registry: "${H}",
});

// 1. Quote: the service runs the call and meters it. Nothing is paid yet.
const q = await mx.quote("${d.service_id}", ${reqObj});

if ("pay" in q) {
  console.log(\`\${q.quote.units} \${q.quote.unit} = \${q.quote.amount} \${q.quote.currency}\`);

  // 2. Pay only if the exact price is acceptable.
  if (Number(q.quote.amount) <= ${maxP}) {
    const r = await q.pay();
    console.log(r.receipt?.transaction_id);  // SettlementReceipt, settled on ${d.owner.network}
    console.log(r.verification);             // your own re-hash and re-metering of the body
    console.log(r.data);
  }
}` }];

    case "agent": return [{ name: "agent.ts", code:
`import { MeterX402Agent } from "mx402";

const agent = new MeterX402Agent({
  wallet: ${wallet},
  budget: "1 HBAR",              // one budget across every call, tab and A2A task
  registry: "${H}",
});

// Find services for the job, ranked by reputation, then price, then latency.
const found = await agent.discover({ capability: "${cap}", minReputation: 80, maxPrice: ${maxP} });

// Or just name the capability: the agent picks the best compatible service.
const r = await agent.call("${cap}", ${reqObj}, { maxPrice: "${maxP}" });
console.log(r.service, r.receipt, r.data);
${d.payment.settlement.some((o) => o.schemes.includes("tab")) ? `
// Many calls? A Metered Tab: approve one allowance, then no per-call payment.
const busy = new MeterX402Agent({ wallet: ${wallet}, budget: "1 HBAR", registry: "${H}", useTabs: { allowance: "0.05" } });
for (let i = 0; i < 10; i++) await busy.call("${d.service_id}", ${reqObj});
await busy.close();  // settles everything in one approved transfer` : ""}` }];

    case "mcp": return [
      { name: "Claude Code", code:
`# add the MeterX402 MCP server to Claude Code
claude mcp add meterx402 \\
  -e MX_HUB=${H} \\
  -e BUYER_ACCOUNT_ID=0.0.… -e BUYER_PRIVATE_KEY=302e… -e BUYER_BUDGET="1 HBAR" \\
  -- npx -y mx402 mcp

# (until mx402 is on npm, from a clone of the repo:  -- npx tsx src/mcp.ts)` },
      { name: ".mcp.json", code: JSON.stringify({ mcpServers: { meterx402: { command: "npx", args: ["-y", "mx402", "mcp"], env: { MX_HUB: H, BUYER_ACCOUNT_ID: "0.0.…", BUYER_PRIVATE_KEY: "302e…", BUYER_BUDGET: "1 HBAR" } } } }, null, 2) },
      { name: "Claude Desktop", code:
`// claude_desktop_config.json  →  "mcpServers"
${JSON.stringify({ meterx402: { command: "npx", args: ["-y", "mx402", "mcp"], env: { MX_HUB: H, BUYER_ACCOUNT_ID: "0.0.…", BUYER_PRIVATE_KEY: "302e…", BUYER_BUDGET: "1 HBAR" } } }, null, 2)}` },
      { name: "Ask your agent", code:
`# then just ask. The agent calls the tools itself:
"Find a ${cap.replace(/_/g, " ")} service on MeterX402 with reputation above 80,
 get a quote for it, and pay only if it costs less than ${maxP} HBAR."

# what it does, step by step
list_services({ capability: "${cap}", min_reputation: 80 })
get_quote({ service_id: "${d.service_id}"${r.maxUnits ? `, max_units: ${r.maxUnits}` : ""} })   // → quote_id, exact price
pay_for_service({ quote_id: "…", max_price: ${maxP} })       // → result + SettlementReceipt
get_reputation({ service_id: "${d.service_id}" })` },
    ];

    case "a2a": return [
      { name: "curl", code:
`# 1. the agent card: skills, pricing, and the x402 payment extension
curl -s ${d.links.a2a_card}

# 2. send a task. It comes back "input-required" with an exact, metered x402 quote
curl -s ${d.endpoint}/a2a -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": { "message": { "kind": "message", "role": "user", "messageId": "m1",
    "parts": [{ "kind": "text", "text": ${js(a2aText(d, r))} }] } } }'

# 3. sign result.metadata["x402.payment.required"] with any x402 client and send
#    it back on the same task (params.message.taskId), in
#    params.message.metadata["x402.payment.payload"]. The task completes with the
#    result as an artifact and a receipt in metadata["mx402.receipt"].` },
      { name: "agent.ts", code:
`import { MeterX402Agent } from "mx402";

const agent = new MeterX402Agent({ wallet: ${wallet}, budget: "1 HBAR", registry: "${H}" });

// task → payment-required → budget check → pay → completed, in one call
const r = await agent.a2a("${d.endpoint}", ${js(a2aText(d, r))}, { maxPrice: "${maxP}" });
console.log(r.task.status.state, r.quote?.amount, r.receipt?.transaction_id);
console.log(r.data);` },
    ];

    case "http": return [
      { name: "curl", code:
`# Plain x402. The first call is metered and answered with 402 + the exact price.
curl -si -X ${r.method} '${url}'${unitsHdr}${curlBody} \\
  | grep -iE '^HTTP|^x-meter-(amount|unit|billable)|^payment-required'

# The PAYMENT-REQUIRED header is standard x402 (base64 JSON). Sign it with any x402
# client, and repeat the same request with a PAYMENT-SIGNATURE header to receive
# the held response, a PAYMENT-RESPONSE and an x-mx402-receipt.` },
      { name: "x402-fetch.ts", code:
`// any standard x402 client works: here the official @x402/fetch
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { createClientHederaSigner, ExactHederaScheme, PrivateKey } from "@x402/hedera";

const signer = createClientHederaSigner(process.env.BUYER_ACCOUNT_ID!, PrivateKey.fromStringDer(process.env.BUYER_PRIVATE_KEY!));
const client = new x402Client().register("${d.owner.network}", new ExactHederaScheme(signer));
client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network: "${d.owner.network}", asset: "0.0.0", maxAmountPerPayment: "${Math.round(Number(maxP) * 1e8)}" }] });

const pay = wrapFetchWithPayment(fetch, client);
const res = await pay("${url}", { method: "${r.method}"${r.body ? `, headers: { "content-type": "application/json" }, body: ${js(r.body)}` : ""} });
console.log(res.headers.get("x-meter-amount"), await res.text());` },
    ];

    case "cli": return [{ name: "terminal", code:
`# everything the registry knows about this service
npx mx402 inspect ${d.service_id} --registry ${H}

# discover by capability, like an agent would
curl -s '${H}/registry/services?capability=${cap}&minReputation=80'

# its reputation and the evidence behind it
curl -s ${H}/registry/services/${d.service_id}/reputation

# what buyers paid, receipt by receipt
curl -s '${H}/registry/receipts?service=${d.service_id}&limit=10'` }];
  }
  return [];
}

function a2aText(d, r) {
  try { const b = JSON.parse(r.body || d.sample?.body || "{}"); const m = b.messages?.at(-1)?.content; if (m) return m; } catch {}
  return `run your default request (${d.sample?.method ?? "GET"} ${d.sample?.path ?? "/"})`;
}

function renderPlayground() {
  $("pg-integ").innerHTML = INTEGRATIONS.map((i) => `<button role="tab" data-i="${i.id}" aria-pressed="${PG.integ === i.id}" aria-selected="${PG.integ === i.id}" title="${esc(i.sub)}">${esc(i.title)}</button>`).join("");
  $("pg-integ").querySelectorAll("button").forEach((b) => b.onclick = () => { PG.integ = b.dataset.i; PG.file = 0; renderPlayground(); });
  const d = svc();
  if (!d) { $("pg-code").innerHTML = `<div class="empty-state">No services yet. Publish one in <b>Deployer</b>.</div>`; $("pg-files").innerHTML = ""; return; }
  const files = generate(d, req());
  PG.file = Math.min(PG.file, files.length - 1);
  $("pg-files").innerHTML = files.map((f, i) => `<button data-f="${i}" aria-pressed="${i === PG.file}">${esc(f.name)}</button>`).join("");
  $("pg-files").querySelectorAll("button").forEach((b) => b.onclick = () => { PG.file = Number(b.dataset.f); renderPlayground(); });
  $("pg-code").innerHTML = `<pre class="code">${highlight(files[PG.file].code)}</pre><button class="copy" data-code="${esc(files[PG.file].code)}">copy</button>`;
  bindCopy($("pg-code"));
  const integ = INTEGRATIONS.find((i) => i.id === PG.integ);
  $("pg-run").textContent = integ.run === "a2a" ? "Run the A2A task" : integ.run === "inspect" ? "Run inspect" : `Run: quote, then pay`;
  $("pg-runnote").textContent = integ.run === "inspect" ? "reads the registry, pays nothing" : integ.run === "a2a" ? `pays from this hub's buyer wallet, within your max price` : `you approve the quote before anything is paid`;
}

async function runPlayground() {
  const d = svc();
  if (!d) return;
  const r = req();
  const out = $("pg-out");
  out.hidden = false;
  const integ = INTEGRATIONS.find((i) => i.id === PG.integ);
  if (integ.run === "quote") return runLifecycle(d, r, out, integ.labels);
  if (integ.run === "inspect") {
    const l = await fetch(`/registry/services/${encodeURIComponent(d.service_id)}`).then((x) => x.json());
    out.innerHTML = `<h4>npx mx402 inspect ${esc(d.service_id)}</h4><pre class="code respbox">${esc(JSON.stringify({ descriptor: l.descriptor, price: l.price, reputation: { score: l.reputation.score, confidence: l.reputation.confidence, components: l.reputation.components, stats: l.reputation.stats } }, null, 2))}</pre>`;
    return;
  }
  // A2A
  out.innerHTML = `<ul class="steps"><li class="wait"><span class="ic">…</span><div><b>message/send</b><div class="d">sending the task to ${esc(d.links.a2a_card ?? d.endpoint)}…</div></div></li></ul>`;
  let data;
  try { data = JSON.parse(r.body || "null"); } catch {}
  const text = a2aText(d, r);
  const res = await fetch("/playground/a2a", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service_id: d.service_id, text: data && !data.messages ? undefined : text, data: data && !data.messages ? { request: { method: r.method, path: r.path, body: data } } : undefined, maxUnits: r.maxUnits || undefined, maxPrice: r.maxPrice || undefined }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
  if (!res.ok) { out.innerHTML = `<ul class="steps"><li class="bad"><span class="ic">!</span><div><b>${res.refused ? "Refused before signing" : "A2A task failed"}</b><div class="d">${esc(res.error)}</div></div></li></ul>`; return; }
  const t = res.task, q = res.quote, rc = res.receipt;
  const part = t.artifacts?.[0]?.parts?.[0];
  const result = part ? (part.kind === "data" ? part.data?.result ?? part.data : part.text) : null;
  const li = (state, title, detail) => `<li class="${state}"><span class="ic">${state === "ok" ? "✓" : "!"}</span><div><b>${esc(title)}</b><div class="d">${detail}</div></div></li>`;
  out.innerHTML = `<ul class="steps">
    ${li("ok", "Agent card", `skills: ${esc(d.capabilities.join(", "))} · x402 extension declared`)}
    ${li("ok", "message/send → input-required", q ? `x402.payment.status = payment-required · quote <b>${esc(q.amount)} ${esc(q.currency)}</b> for ${q.units} ${esc(q.unit)}` : "no payment needed")}
    ${li(res.paid ? "ok" : "bad", "message/send with x402.payment.payload", res.paid ? `settled · tx <span class="mono">${esc(rc?.transaction_id ?? "")}</span>` : "not paid")}
    ${li(t.status.state === "completed" ? "ok" : "bad", `task ${t.status.state}`, `task ${esc(t.id.slice(0, 8))}… · metadata carries x402.payment.receipts and mx402.receipt`)}
  </ul>${respBlock(result)}`;
  loadMarket();
}

// ── wiring ────────────────────────────────────────────────────────────────
$("pg-service").onchange = () => { PG.id = $("pg-service").value; PG.touched = false; fillRequest(); renderPlayground(); };
for (const id of ["pg-method", "pg-path", "pg-body", "pg-maxunits", "pg-maxprice"]) $(id).addEventListener("input", () => { PG.touched = true; renderPlayground(); });
$("pg-method").addEventListener("change", renderPlayground);
$("pg-run").onclick = runPlayground;

/** Deep link from the marketplace: open the playground on one service. */
function openPlayground(id, integ) {
  PG.id = id; PG.touched = false;
  if (integ) PG.integ = integ;
  $("pg-service").value = id;
  fillRequest();
  renderPlayground();
  setUserTab("play");
}
