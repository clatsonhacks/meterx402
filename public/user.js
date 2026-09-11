// User view: the agent marketplace for humans.
//
// Agents never need this page: they query /registry/services, the MCP server
// or A2A agent cards. This is the same registry data made browsable, with a
// "Try it" that walks the payment lifecycle one visible step at a time.
// Reuses the helpers deployer.js defines ($, fmt, esc, short, time).

const M = { services: [], q: "", cap: "all", sort: "best", rated: false, open: null, tab: "overview", receipts: {} };
const HUB = location.origin;

const initials = (name) => name.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
const unitLabel = (p) => `${p.per === 1 ? "" : p.per + " "}${p.per === 1 ? p.unit.replace(/s$/, "") : p.unit}`;
const priceLine = (d) => `${fmt(d.pricing.rate)} ${esc(d.pricing.currency)} <small>/ ${esc(unitLabel(d.pricing))}</small>`;
const typical = (l) => (l.price.typical_call != null ? `typical call ${fmt(l.price.typical_call)} ${l.price.currency}` : l.price.worst_case_call != null ? `at most ${fmt(l.price.worst_case_call)} ${l.price.currency} a call` : "uncapped");
const repLabel = (r) => (r.score == null ? `<span class="n" style="color:var(--muted);font-size:14px">unrated</span>` : `<span class="n">${r.score}<small>/100</small></span>`);
const IFACE = { rest: "REST", graphql: "GraphQL", a2a: "A2A", mcp: "MCP", sdk: "SDK" };
const COMP_LABEL = { execution: "Execution", response_success: "Response success", latency: "Latency", disputes: "No disputes", uptime: "Uptime", payment_reliability: "Payment reliability" };

async function loadMarket() {
  try {
    const { services } = await fetch("/registry/services?live=all").then((r) => r.json());
    M.services = services;
    renderMarket();
    if (typeof refreshPlaygroundServices === "function") refreshPlaygroundServices();
    if (M.open) renderDrawer(false);
  } catch {}
}

function filtered() {
  const q = M.q.trim().toLowerCase();
  let xs = M.services.filter((l) => {
    const d = l.descriptor;
    if (M.cap !== "all" && !d.capabilities.includes(M.cap)) return false;
    if (M.rated && l.reputation.score == null) return false;
    if (q && !`${d.name} ${d.description ?? ""} ${d.capabilities.join(" ")} ${d.service_id} ${d.pricing.unit}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const cost = (l) => l.price.typical_call ?? l.price.worst_case_call ?? Infinity;
  if (M.sort === "cheap") xs = xs.sort((a, b) => cost(a) - cost(b));
  if (M.sort === "rep") xs = xs.sort((a, b) => (b.reputation.score ?? -1) - (a.reputation.score ?? -1));
  if (M.sort === "fast") xs = xs.sort((a, b) => (a.reputation.stats.median_latency_ms ?? 1e9) - (b.reputation.stats.median_latency_ms ?? 1e9));
  // "best" keeps the registry's ranking (reputation, then price, then latency)
  return xs.sort((a, b) => Number(b.live) - Number(a.live));
}

function renderMarket() {
  const caps = [...new Set(M.services.flatMap((l) => l.descriptor.capabilities))].sort();
  if (M.cap !== "all" && !caps.includes(M.cap)) M.cap = "all";
  $("mkt-caps").innerHTML = ["all", ...caps].map((c) => `<button class="pill" data-cap="${esc(c)}" aria-pressed="${M.cap === c}">${c === "all" ? "All" : esc(c.replace(/_/g, " "))}</button>`).join("");
  $("mkt-caps").querySelectorAll("button").forEach((b) => b.onclick = () => { M.cap = b.dataset.cap; renderMarket(); });

  const live = M.services.filter((l) => l.live).length;
  $("mkt-sub").textContent = `${live} live service${live === 1 ? "" : "s"}, priced by what each call uses, settled on Hedera, rated from real payment evidence.`;

  const xs = filtered();
  $("mkt-grid").innerHTML = xs.length ? xs.map((l) => {
    const d = l.descriptor, r = l.reputation;
    return `<article class="card svc" tabindex="0" data-id="${esc(d.service_id)}" aria-label="${esc(d.name)}">
      <div class="top">
        <div class="avatar" aria-hidden="true">${esc(initials(d.name))}</div>
        <div style="min-width:0"><h3>${esc(d.name)}<span class="livedot ${l.live ? "" : "down"}" title="${l.live ? "live" : "not answering"}"></span></h3>
          <div class="caps">${d.capabilities.map((c) => `<span>${esc(c)}</span>`).join("")}</div></div>
      </div>
      <div class="desc">${esc(d.description ?? "")}</div>
      <div class="meta">
        <div><div class="price">${priceLine(d)}</div><div class="sub">${esc(typical(l))}</div></div>
        <div class="rep" title="${r.confidence} confidence, ${r.sample_size} samples">${repLabel(r)}<div class="sub">${r.stats.paid_calls} paid call${r.stats.paid_calls === 1 ? "" : "s"}</div></div>
      </div>
      <div class="ifaces">${d.interfaces.map((i) => `<span class="iface">${IFACE[i] ?? i}</span>`).join("")}${d.payment.streaming ? `<span class="iface">streaming</span>` : ""}${d.payment.settlement.some((o) => o.schemes.includes("tab")) ? `<span class="iface">tabs</span>` : ""}</div>
      <div class="actions"><button class="primary" data-act="try">Try it</button><button class="ghost" data-act="integrate">Integrate</button><button class="ghost" data-act="details">Details</button></div>
    </article>`;
  }).join("") : `<div class="card empty-state" style="grid-column:1/-1">${M.services.length ? "No service matches: try another word or capability." : "No services yet. Switch to <b>Deployer</b> to publish one, or run <span class='mono'>npm run demo:offline</span>."}</div>`;

  $("mkt-grid").querySelectorAll(".svc").forEach((card) => {
    const id = card.dataset.id;
    card.onclick = (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "integrate") return openPlayground(id);
      openService(id, act === "try" ? "try" : "overview");
    };
    card.onkeydown = (e) => { if (e.key === "Enter") openService(id, "overview"); };
  });
}

// ── the "for agents" panel: how an agent reaches the same services ───────
function renderAgentSnippets() {
  const reg = `curl -s '${HUB}/registry/services?capability=weather_forecast&minReputation=80'`;
  const mcp = JSON.stringify({ mcpServers: { meterx402: { command: "npx", args: ["-y", "mx402", "mcp"], env: { MX_HUB: HUB, BUYER_ACCOUNT_ID: "0.0.…", BUYER_PRIVATE_KEY: "302e…", BUYER_BUDGET: "1 HBAR" } } } }, null, 2);
  const sdk = `import { MeterX402Agent } from "mx402";\n\nconst agent = new MeterX402Agent({ wallet, budget: "1 HBAR", registry: "${HUB}" });\nconst r = await agent.call("weather_forecast");   // discover → quote → pay → receipt`;
  const a2a = `# every service is an A2A agent\ncurl -s ${M.services[0]?.descriptor.links.a2a_card ?? "<endpoint>/.well-known/agent.json"}`;
  $("agent-snippets").innerHTML = [
    ["Registry API", reg], ["MCP server (Claude, any MCP client)", mcp], ["SDK", sdk], ["A2A", a2a],
  ].map(([t, c]) => snippet(t, c)).join("");
  bindCopy($("agent-snippets"));
}

/** A labelled, copyable code block. */
function snippet(label, code, id = "") {
  return `<div class="snippet"${id ? ` id="${id}"` : ""}>${label ? `<div class="lbl">${esc(label)}</div>` : ""}<pre class="code">${highlight(code)}</pre><button class="copy" data-code="${esc(code)}">copy</button></div>`;
}
function highlight(code) {
  // comments only: enough to make code scannable without a highlighter
  return esc(code).replace(/(^|\n)(\s*)(\/\/[^\n]*|#[^\n]*)/g, (_, a, b, c) => `${a}${b}<span class="c">${c}</span>`);
}
function bindCopy(root) {
  root.querySelectorAll(".copy").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(b.dataset.code); b.textContent = "copied"; } catch { b.textContent = "select + copy"; }
    setTimeout(() => (b.textContent = "copy"), 1400);
  });
}

// ── the service drawer ────────────────────────────────────────────────────
function openService(id, tab = "overview") {
  M.open = id; M.tab = tab;
  renderDrawer(true);
  fetch(`/registry/receipts?service=${encodeURIComponent(id)}&limit=6`).then((r) => r.json()).then((j) => { M.receipts[id] = j.receipts; if (M.open === id && M.tab === "overview") renderDrawer(false); }).catch(() => {});
}
function closeService() { M.open = null; $("drawer-root").innerHTML = ""; document.body.style.overflow = ""; }
addEventListener("keydown", (e) => { if (e.key === "Escape" && M.open) closeService(); });

function renderDrawer(fresh) {
  const l = M.services.find((x) => x.service_id === M.open);
  if (!l) return closeService();
  if (!fresh && M.tab === "try") return; // don't wipe an in-progress purchase
  const d = l.descriptor, r = l.reputation;
  document.body.style.overflow = "hidden";
  $("drawer-root").innerHTML = `<div class="overlay" id="dr-ov"></div>
  <aside class="drawer" role="dialog" aria-label="${esc(d.name)}">
    <div class="dhead">
      <div class="dh"><div class="avatar">${esc(initials(d.name))}</div>
        <div><h3 style="margin:0">${esc(d.name)}<span class="livedot ${l.live ? "" : "down"}"></span></h3><div class="sub mono">${esc(d.service_id)} · ${esc(d.type.toUpperCase())}</div></div>
        <button class="close" id="dr-x" aria-label="Close">×</button></div>
      <div class="subnav" style="margin:12px 0 0">${["overview", "try", "integrate"].map((t) => `<button role="tab" data-t="${t}" aria-selected="${M.tab === t}">${{ overview: "Overview", try: "Try it", integrate: "Integrate" }[t]}</button>`).join("")}</div>
    </div>
    <div class="body" id="dr-body"></div>
  </aside>`;
  $("dr-ov").onclick = closeService;
  $("dr-x").onclick = closeService;
  $("drawer-root").querySelectorAll("[data-t]").forEach((b) => b.onclick = () => { M.tab = b.dataset.t; renderDrawer(true); });
  const body = $("dr-body");
  if (M.tab === "overview") body.innerHTML = overviewHtml(l);
  if (M.tab === "try") renderTry(body, l);
  if (M.tab === "integrate") { body.innerHTML = integrateHtml(l); bindCopy(body); body.querySelector("#dr-pg")?.addEventListener("click", () => { closeService(); openPlayground(d.service_id); }); }
}

function overviewHtml(l) {
  const d = l.descriptor, r = l.reputation, st = r.stats;
  const comps = Object.keys(COMP_LABEL).map((k) => `<div class="comp"><span>${COMP_LABEL[k]}</span><span class="track"><i style="width:${Math.round(r.components[k] * 100)}%"></i></span><span class="w">${Math.round(r.components[k] * 100)}% ×${r.weights[k]}</span></div>`).join("");
  const rec = (M.receipts[d.service_id] ?? []).map((x) => `<tr><td>${time(x.settled_at)}</td><td class="mono">${esc(short(x.buyer))}</td><td class="num">${x.metered_units} ${esc(x.unit)}</td><td class="num"><b>${fmt(x.amount)}</b></td><td>${x.transaction_id ? `<span class="mono" title="${esc(x.transaction_id)}">${esc(short(x.transaction_id))}</span>` : `<span class="badge">tab</span>`}</td></tr>`).join("");
  return `<p style="margin:0 0 10px;color:var(--ink-2)">${esc(d.description ?? "")}</p>
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
      <div class="card"><div class="label">Price</div><div class="price">${priceLine(d)}</div><div class="sub">${esc(typical(l))} · min ${fmt(d.pricing.min)} · cap ${d.pricing.max_units ?? "none"} ${esc(d.pricing.unit)}</div></div>
      <div class="card"><div class="label">Reputation</div>${repLabel(r).replace('class="n"', 'class="n" style="font-size:24px"')}<div class="sub">${r.confidence} confidence · ${r.sample_size} samples${r.anchor ? " · anchored on HCS" : ""}</div></div>
    </div>
    <h4>How the score is built</h4>${comps}
    <div class="sub" style="margin-top:6px">${st.paid_calls} paid calls · ${st.upstream_errors} upstream errors · ${st.disputes} disputes · median ${st.median_latency_ms ?? "–"} ms · uptime ${st.uptime_ratio == null ? "–" : Math.round(st.uptime_ratio * 100) + "%"}</div>
    <h4>Payment</h4>
    <div class="kv" style="margin:0">
      <span>meter</span><span class="mono">${esc(d.pricing.meter)}</span>
      <span>settlement</span><span>${d.payment.settlement.map((o) => `${esc(o.currency)} on ${esc(o.network)} (${o.schemes.join(" + ")})`).join("; ")}</span>
      <span>streaming</span><span>${d.payment.streaming ? "yes, on a Metered Tab" : "no"}</span>
      <span>upstream auth</span><span>${d.auth.type === "none" ? "none" : `${esc(d.auth.type)}, held by the seller — you never need it`}</span>
      <span>interfaces</span><span>${d.interfaces.map((i) => IFACE[i] ?? i).join(" · ")}</span>
      <span>owner</span><span class="mono">${esc(d.owner.account)}</span>
      <span>links</span><span><a href="${esc(d.links.descriptor)}" target="_blank" rel="noopener">descriptor</a> · <a href="${esc(d.links.a2a_card)}" target="_blank" rel="noopener">A2A card</a></span>
    </div>
    <h4>Recent payments</h4>
    ${rec ? `<table class="vtable"><tbody>${rec}</tbody></table>` : `<div class="sub">No payments yet.</div>`}`;
}

function integrateHtml(l) {
  const d = l.descriptor;
  const code = `import { MeterX402 } from "mx402";\n\nconst mx = new MeterX402({ wallet, budget: "1 HBAR", registry: "${HUB}" });\nconst r = await mx.call("${d.service_id}");\nconsole.log(r.receipt, r.data);`;
  return `${snippet("SDK", code)}${snippet("A2A agent card", `curl -s ${d.links.a2a_card}`)}${snippet("Registry entry", `curl -s ${HUB}/registry/services/${d.service_id}`)}
    <div class="runbar"><button class="primary" id="dr-pg">Open in Playground</button><span class="label">MCP, A2A, raw HTTP and CLI code, runnable</span></div>`;
}

// ── Try it: quote → budget → pay → receipt → verify, visibly ─────────────
function requestDefaults(d) {
  const s = d.sample ?? { method: "GET", path: "/" };
  return { method: s.method, path: s.path, body: s.body ?? "" };
}

function renderTry(body, l) {
  const d = l.descriptor, def = requestDefaults(d);
  const streamable = d.payment.streaming;
  body.innerHTML = `<div class="form">
      <div class="trio"><label>Method<select id="t-method"><option ${def.method === "GET" ? "selected" : ""}>GET</option><option ${def.method === "POST" ? "selected" : ""}>POST</option></select></label>
        <label>Path and query<input type="text" id="t-path" value="${esc(def.path)}"></label></div>
      <label>Body<textarea id="t-body" rows="3">${esc(def.body)}</textarea></label>
      <div class="pair"><label>Max ${esc(d.pricing.unit)}<input type="number" id="t-max" min="1" placeholder="none"></label>
        <label>Max price (HBAR)<input type="number" id="t-price" min="0" step="0.0001" placeholder="none"></label></div>
      <div class="runbar"><button class="primary" id="t-quote">Get a quote</button>${streamable ? `<button class="ghost" id="t-stream">Stream on a tab</button>` : ""}<span class="label">A quote runs the call and meters it. You pay only if you accept.</span></div>
    </div><div id="t-out"></div>`;
  const req = () => ({ method: $("t-method").value, path: $("t-path").value, body: $("t-method").value === "GET" ? "" : $("t-body").value, maxUnits: $("t-max").value, maxPrice: $("t-price").value });
  $("t-quote").onclick = () => runLifecycle(d, req(), $("t-out"));
  if (streamable) $("t-stream").onclick = () => streamInto(d, req(), $("t-out"));
}

/** The shared lifecycle runner (Try it and the Playground). */
async function runLifecycle(d, req, out, labels = {}) {
  const L = { quote: "Quote", budget: "Budget check", pay: "Pay and settle", verify: "Verify what arrived", ...labels };
  const steps = [];
  const paint = (extra = "") => { out.innerHTML = `<ul class="steps">${steps.map((s) => `<li class="${s.state}"><span class="ic">${s.state === "ok" ? "✓" : s.state === "bad" ? "!" : "…"}</span><div><b>${esc(s.title)}</b><div class="d">${s.detail}</div></div></li>`).join("")}</ul>${extra}`; };
  steps.push({ state: "ok", title: "Discover", detail: `${esc(d.service_id)} from the registry · ${esc(d.pricing.meter)} at ${fmt(d.pricing.rate)} ${esc(d.pricing.currency)} / ${esc(unitLabel(d.pricing))}` });
  steps.push({ state: "wait", title: L.quote, detail: "running the call and metering it…" });
  paint();
  const qr = await fetch("/playground/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service_id: d.service_id, method: req.method, path: req.path, body: req.body || undefined, maxUnits: req.maxUnits || undefined }) }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
  if (!qr.ok) { steps[1] = { state: "bad", title: L.quote, detail: esc(qr.error ?? "failed") }; return paint(); }
  if (qr.free) { steps[1] = { state: "ok", title: L.quote, detail: "nothing billable: served free" }; return paint(respBlock(qr.result?.data)); }
  const q = qr.quote;
  steps[1] = { state: "ok", title: L.quote, detail: `${q.units} ${esc(q.unit)} measured${q.cap ? ` (cap ${q.cap})` : ""} → <b>${esc(q.amount)} ${esc(q.currency)}</b>, body committed as <span class="mono">${esc(q.body_sha256.slice(0, 12))}…</span>` };
  const withinPrice = !req.maxPrice || Number(q.amount) <= Number(req.maxPrice);
  steps.push({ state: withinPrice ? "ok" : "bad", title: L.budget, detail: req.maxPrice ? `${esc(q.amount)} vs your max ${esc(req.maxPrice)} → ${withinPrice ? "within budget" : "refused, nothing signed"}` : "no max price set: the SDK still enforces your session budget and per-call cap before signing" });
  if (!withinPrice) return paint();
  const card = `<div class="quote-card"><div class="label">Quote ${esc(q.quote_id.slice(0, 8))}… · ${esc(q.scheme)} on ${esc(q.network)}</div><div class="amt">${esc(q.amount)} ${esc(q.currency)}</div><div class="sub">${q.units} ${esc(q.unit)} × ${esc(q.rate)} / ${q.per}</div><div class="countdown" id="t-cd"></div>
    <div class="runbar"><button class="primary" id="t-pay">Pay ${esc(q.amount)} ${esc(q.currency)}</button><button class="ghost" id="t-skip">Don't pay</button></div></div>`;
  paint(card);
  const cd = setInterval(() => { const s = Math.max(0, Math.round((q.expires_at - Date.now()) / 1000)); const el = document.getElementById("t-cd"); if (el) el.textContent = s ? `the service holds the response for ${s}s` : "expired: get a new quote"; else clearInterval(cd); }, 500);
  await new Promise((resolve) => {
    document.getElementById("t-skip").onclick = () => { clearInterval(cd); steps.push({ state: "bad", title: L.pay, detail: "declined: nothing was signed or paid. The hold expires on its own." }); paint(); resolve(); };
    document.getElementById("t-pay").onclick = async () => {
      clearInterval(cd);
      steps.push({ state: "wait", title: L.pay, detail: "signing the exact amount and settling…" });
      paint();
      const pr = await fetch("/playground/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote_id: q.quote_id, maxPrice: req.maxPrice || undefined }) }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
      steps.pop();
      if (!pr.ok || !pr.result?.paid) { steps.push({ state: "bad", title: L.pay, detail: esc(pr.error ?? `HTTP ${pr.result?.status}`) }); paint(); return resolve(); }
      const rc = pr.result.receipt, v = pr.result.verification;
      steps.push({ state: "ok", title: L.pay, detail: `settled <b>${esc(rc.amount)} ${esc(rc.currency)}</b> for ${rc.metered_units} ${esc(rc.unit)} · tx <span class="mono">${esc(rc.transaction_id ?? "")}</span>` });
      if (v) steps.push({ state: v.bodyHash && v.unitsMatch !== false ? "ok" : "bad", title: L.verify, detail: `body hash ${v.bodyHash ? "matches the quote" : "does NOT match"} · re-metered ${v.remetered ?? "n/a"} ${esc(rc.unit)} (${esc(v.method)})${pr.result.dispute?.filed ? " · dispute filed" : ""}` });
      steps.push({ state: "ok", title: "Receipt", detail: `SettlementReceipt ${esc(rc.receipt_id.slice(0, 8))}… · the seller's reputation now includes this call` });
      paint(respBlock(pr.result.data));
      loadMarket();
      resolve();
    };
  });
}

function respBlock(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return `<h4>Response</h4><pre class="code respbox">${esc((text ?? "").slice(0, 6000))}</pre>`;
}

/** Streaming lives on tabs: open (or reuse) the hub's tab and stream. */
function streamInto(d, req, out) {
  let prompt = "Explain metered payments in 60 words";
  try { const b = JSON.parse(req.body || "{}"); const m = b.messages?.at(-1)?.content; if (m) prompt = m; } catch {}
  out.innerHTML = `<h4>Streaming on a Metered Tab</h4><div class="stream-out"><span class="cursor"></span></div><div class="tick"><span id="st-u">0 ${esc(d.pricing.unit)}</span><span id="st-c"></span></div>`;
  const box = out.querySelector(".stream-out");
  let text = "";
  const es = new EventSource(`/teststream?lane=${encodeURIComponent(d.name)}&prompt=${encodeURIComponent(prompt)}${req.maxUnits ? `&maxUnits=${req.maxUnits}` : ""}`);
  es.addEventListener("open", (e) => { try { const o = JSON.parse(e.data); if (o.tab) $("st-c").textContent = `tab ${o.tab} · allowance ${o.allowance} HBAR`; } catch {} });
  es.addEventListener("chunk", (e) => { text += JSON.parse(e.data).text ?? ""; box.innerHTML = `${esc(text)}<span class="cursor"></span>`; $("st-u").textContent = `~${Math.ceil(text.length / 4)} ${d.pricing.unit}`; });
  es.addEventListener("cap", (e) => { const c = JSON.parse(e.data); text += `\n\n— stopped at your cap of ${c.cap} ${c.unit} —`; });
  es.addEventListener("receipt", (e) => { const r = JSON.parse(e.data).receipt ?? {}; box.textContent = text; $("st-u").textContent = `${r.billable} ${r.unit} metered`; $("st-c").textContent = `${fmt(r.amount)} ${r.currency} debited · tab owes ${r.owed}`; es.close(); loadMarket(); });
  es.addEventListener("error", (e) => { let m = "stream failed"; try { m = JSON.parse(e.data).error ?? m; } catch {} box.innerHTML = `<span class="status bad"><span class="ico">×</span>${esc(m)}</span>`; es.close(); });
  es.onerror = () => es.close();
}

// ── wiring ────────────────────────────────────────────────────────────────
$("mkt-q").oninput = () => { M.q = $("mkt-q").value; renderMarket(); };
$("mkt-sort").onchange = () => { M.sort = $("mkt-sort").value; renderMarket(); };
$("mkt-rated").onchange = () => { M.rated = $("mkt-rated").checked; renderMarket(); };
loadMarket().then(renderAgentSnippets);
setInterval(loadMarket, 5000);
