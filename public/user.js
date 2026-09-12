// User views: Explore (the marketplace for people), the service sheet with a
// task-shaped "Try it", and Activity.
//
// The protocol is still exactly the protocol: quote → budget check → pay →
// verify → receipt. What changes here is who it's addressed to. The steps are
// collapsed into one "Ready to pay" sheet and a receipt, with the timeline kept
// under "What happened". The Developers tab (playground.js) shows the same
// lifecycle step by step, and reuses runLifecycle() from the bottom of this file.

const M = { services: [], loaded: false, q: "", cap: "all", sort: "best", rated: false, open: null, tab: "try", receipts: {} };
const HUB = location.origin;
const IFACE = { rest: "REST", graphql: "GraphQL", a2a: "A2A", mcp: "MCP", sdk: "SDK" };
const COMP_LABEL = { execution: "Delivered what was paid for", response_success: "Answered successfully", latency: "Responds quickly", disputes: "No disputes", uptime: "Online when checked", payment_reliability: "Payments settle cleanly" };

async function loadMarket() {
  try {
    // Validate before trusting: a hub that answers 503 with an error object
    // still parses as JSON, and destructuring it produces a confusing crash
    // three frames later instead of an honest "the hub is down".
    const res = await fetch("/registry/services?live=all");
    if (!res.ok) throw new Error(`hub_${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.services)) throw new Error("bad_response");
    M.services = body.services;
    M.loaded = true;
    setNet(true);
    renderExplore();
    if (typeof refreshPlaygroundServices === "function") refreshPlaygroundServices();
    if (M.open) renderSheet(false);
  } catch (e) {
    setNet(false, friendly(e));
    if (!M.services.length) {
      M.loaded = true;                       // stop the skeletons spinning forever
      $("mkt-grid").innerHTML = `<div class="card empty-state" style="grid-column:1/-1"><b>Can't reach the hub.</b>
        <div class="sub" style="margin:6px 0 12px">It may still be starting, or it may have stopped. Nothing was charged.</div>
        <button class="ghost" id="mkt-retry">Try again</button></div>`;
      $("mkt-retry").onclick = loadMarket;
    }
  }
}

// ── Explore ─────────────────────────────────────────────────────────────
function filtered() {
  const q = M.q.trim().toLowerCase();
  let xs = M.services.filter((l) => {
    const d = l.descriptor;
    if (M.cap !== "all" && catKey(d) !== M.cap) return false;
    if (M.rated && !(l.reputation.score >= 75)) return false;
    if (q && !`${titleOf(d)} ${d.name} ${d.description ?? ""} ${catOf(d).label} ${d.capabilities.join(" ")} ${unitBase(d.pricing)}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const cost = (l) => l.price.typical_call ?? l.price.worst_case_call ?? Infinity;
  if (M.sort === "cheap") xs = xs.sort((a, b) => cost(a) - cost(b));
  if (M.sort === "rep") xs = xs.sort((a, b) => (b.reputation.score ?? -1) - (a.reputation.score ?? -1));
  if (M.sort === "fast") xs = xs.sort((a, b) => (a.reputation.stats.median_latency_ms ?? 1e9) - (b.reputation.stats.median_latency_ms ?? 1e9));
  return xs.sort((a, b) => Number(b.live) - Number(a.live));
}

function renderExplore() {
  // categories, with counts
  const counts = new Map();
  for (const l of M.services) { const k = catKey(l.descriptor); counts.set(k, (counts.get(k) ?? 0) + 1); }
  if (M.cap !== "all" && !counts.has(M.cap)) M.cap = "all";
  const cats = [...counts.keys()].sort();
  $("mkt-caps").innerHTML = [["all", { label: "Everything", icon: "sparkles" }], ...cats.map((k) => [k, CATS[k] ?? { label: prettyName(k), icon: "grid" }])]
    .map(([k, c]) => `<button class="cat" data-cap="${esc(k)}" aria-pressed="${M.cap === k}">${icon(c.icon, "ci")}${esc(c.label)}${k === "all" ? "" : ` <small>${counts.get(k)}</small>`}</button>`).join("");
  $("mkt-caps").querySelectorAll("button").forEach((b) => b.onclick = () => { M.cap = b.dataset.cap; renderExplore(); });

  const live = M.services.filter((l) => l.live).length;
  const xs = filtered();
  $("mkt-sub").textContent = M.services.length
    ? `${xs.length} of ${M.services.length} service${M.services.length === 1 ? "" : "s"}${live < M.services.length ? ` · ${live} online` : ""}`
    : "";

  if (!M.loaded) { $("mkt-grid").innerHTML = Array.from({ length: 3 }, () => `<div class="card svc skeleton"><div class="sk-row"></div><div class="sk-line"></div><div class="sk-line short"></div></div>`).join(""); return; }
  $("mkt-grid").innerHTML = xs.length ? xs.map(cardHtml).join("")
    : `<div class="card empty-state" style="grid-column:1/-1">${M.services.length
        ? `Nothing matches “${esc(M.q)}”. Try another word, or pick <b>Everything</b>.`
        : `No services yet. Switch to <b>Deployer</b> to publish one, or run <span class="mono">npm run demo:offline</span>.`}</div>`;

  $("mkt-grid").querySelectorAll(".svc[data-id]").forEach((card) => {
    const id = card.dataset.id;
    card.onclick = (e) => openService(id, e.target.closest("[data-act]")?.dataset.act === "about" ? "about" : "try");
    card.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openService(id, "try"); } };
  });
}

function cardHtml(l) {
  const d = l.descriptor, p = d.pricing, c = catOf(d);
  const typical = l.price.typical_call, worst = l.price.worst_case_call;
  const cents = typical != null ? centsPhrase(typical) : null;
  return `<article class="card svc" tabindex="0" data-id="${esc(d.service_id)}" aria-label="${esc(titleOf(d))}">
    <div class="top">
      ${avatar(d)}
      <div style="min-width:0">
        <h3>${esc(titleOf(d))}</h3>
        <div class="svc-cat">${esc(c.label)} · ${l.live ? `<span class="online">Online</span>` : `<span class="offline">Offline</span>`}</div>
      </div>
      ${trustBadge(l.reputation)}
    </div>
    <p class="desc">${esc(d.description ?? "")}</p>
    <div class="pricebox">
      <div class="p-main">${fmt(p.rate)} <small>HBAR ${esc(perPhrase(p))}</small></div>
      <div class="p-sub">${typical != null ? `Typical use ${hbar(typical)}${cents ? ` · ${cents}` : ""}` : worst != null ? `Never more than ${hbar(worst)} a use` : "priced by usage"}</div>
    </div>
    <div class="foot">
      <div class="feats">${d.payment.streaming ? `<span class="feat">${icon("zap")} Streams live</span>` : ""}${l.reputation.stats.paid_calls ? `<span class="feat">${l.reputation.stats.paid_calls} paid use${l.reputation.stats.paid_calls === 1 ? "" : "s"}</span>` : ""}</div>
      <div class="actions">${l.live ? `<button class="primary">Try it</button>` : `<button class="ghost" data-act="about">Details</button>`}</div>
    </div>
  </article>`;
}

// ── the service sheet ───────────────────────────────────────────────────
const TAB_ALIAS = { overview: "about", integrate: "dev", try: "try", about: "about", dev: "dev" };
function openService(id, tab = "try") {
  M.open = id; M.tab = TAB_ALIAS[tab] ?? "try";
  renderSheet(true);
  fetch(`/registry/receipts?service=${encodeURIComponent(id)}&limit=6`).then((r) => r.json())
    .then((j) => { M.receipts[id] = j.receipts; if (M.open === id && M.tab === "about") renderSheet(false); }).catch(() => {});
}
function closeService() { M.open = null; TRY = null; $("drawer-root").innerHTML = ""; document.body.style.overflow = ""; }
addEventListener("keydown", (e) => { if (e.key === "Escape" && M.open) closeService(); });

function renderSheet(fresh) {
  const l = M.services.find((x) => x.service_id === M.open);
  if (!l) return closeService();
  if (!fresh && M.tab === "try") return; // never wipe a purchase in progress
  const d = l.descriptor, c = catOf(d);
  document.body.style.overflow = "hidden";
  $("drawer-root").innerHTML = `<div class="overlay" id="dr-ov"></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(titleOf(d))}">
    <div class="dhead">
      <div class="dh">${avatar(d, "big")}
        <div style="min-width:0"><h3>${esc(titleOf(d))}</h3>
          <div class="sub">${esc(c.label)} · ${l.live ? `<span class="online">Online</span>` : `<span class="offline">Offline</span>`} · ${trustBadge(l.reputation)}</div></div>
        <button class="close" id="dr-x" aria-label="Close">×</button></div>
      <div class="subnav">${[["try", "Try it"], ["about", "About"], ["dev", "For developers"]].map(([t, label]) => `<button role="tab" data-t="${t}" aria-selected="${M.tab === t}">${label}</button>`).join("")}</div>
    </div>
    <div class="body" id="dr-body"></div>
  </aside>`;
  $("dr-ov").onclick = closeService;
  $("dr-x").onclick = closeService;
  $("drawer-root").querySelectorAll("[data-t]").forEach((b) => b.onclick = () => { M.tab = b.dataset.t; renderSheet(true); });
  const body = $("dr-body");
  if (M.tab === "try") renderTry(body, l);
  if (M.tab === "about") body.innerHTML = aboutHtml(l);
  if (M.tab === "dev") { body.innerHTML = devHtml(l); bindCopy(body); body.querySelector("#dr-pg")?.addEventListener("click", () => { closeService(); openPlayground(d.service_id); }); }
}

function aboutHtml(l) {
  const d = l.descriptor, r = l.reputation, st = r.stats, p = d.pricing;
  const cap = p.max_units;
  const pcStart = Math.min(cap ?? 100, Math.max(1, Math.round((cap ?? 100) / 4)));
  const reasons = [
    [st.paid_calls > 0, `Delivered on ${st.paid_calls} paid request${st.paid_calls === 1 ? "" : "s"}`],
    [st.upstream_errors === 0 && st.paid_calls > 0, "No failed responses"],
    [st.median_latency_ms != null, `Answers in about ${((st.median_latency_ms ?? 0) / 1000).toFixed(1)}s`],
    [st.disputes === 0, "No disputes ever filed"],
    [st.uptime_ratio != null, `Online in ${Math.round((st.uptime_ratio ?? 0) * 100)}% of checks`],
  ].filter(([ok]) => ok).map(([, t]) => `<li>✓ ${esc(t)}</li>`).join("");
  const recent = (M.receipts[d.service_id] ?? []).slice(0, 5).map((x) =>
    `<li><span>${ago(x.settled_at)}</span><span>${esc(units(p, x.metered_units))}</span><b>${hbar(x.amount)}</b></li>`).join("");
  return `<p class="lead">${esc(d.description ?? "")}</p>

    <h4>What it costs</h4>
    <div class="pricecalc card">
      <div class="pc-top"><b>${fmt(p.rate)} HBAR</b> <span>${esc(perPhrase(p))}</span></div>
      <label class="pc-row">How much would you use?
        <input type="range" id="pc-range" min="1" max="${cap ?? 100}" value="${pcStart}"></label>
      <div class="pc-out" id="pc-out">${esc(units(p, pcStart))} → <b>${money(priceFor(p, pcStart))}</b></div>
      ${cap ? `<div class="pc-flat">A flat-priced API has to charge for the worst case: <b>${hbar(priceFor(p, cap))}</b> every single call, however little you use.</div>` : ""}
    </div>

    <h4>Can you trust it?</h4>
    <div class="trustbox">
      <div class="tb-score">${trustBadge(r)}<div class="sub">${r.score == null ? `fewer than 5 paid uses so far` : `${Math.round(r.score)}/100 · ${r.confidence} confidence · ${r.sample_size} samples`}${r.anchor ? " · anchored on Hedera" : ""}</div></div>
      <ul class="reasons">${reasons || "<li>No evidence yet: this service is new.</li>"}</ul>
    </div>
    <details class="adv"><summary>How the score is worked out</summary>
      ${Object.keys(COMP_LABEL).map((k) => `<div class="comp"><span>${COMP_LABEL[k]}</span><span class="track"><i style="width:${Math.round(r.components[k] * 100)}%"></i></span><span class="w">${Math.round(r.components[k] * 100)}%</span></div>`).join("")}
      <div class="sub">Every score comes from settlement evidence: paid calls, disputes, uptime probes and latency. Weights: ${Object.entries(r.weights).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")}.</div>
    </details>

    <h4>Recent uses</h4>
    ${recent ? `<ul class="recent">${recent}</ul>` : `<div class="sub">No paid uses yet.</div>`}

    <h4>Good to know</h4>
    <div class="kv">
      <span>Run by</span><span class="mono">${esc(d.owner.account)}</span>
      <span>You pay</span><span>${esc(p.currency)} on ${esc(d.owner.network.replace(":", " "))}, straight to the seller</span>
      <span>Your data</span><span>The seller holds any API key. Your request goes to them, and nothing else.</span>
      ${d.payment.streaming ? `<span>Streaming</span><span>Yes, on a prepaid tab</span>` : ""}
      <span>Most per call</span><span>${cap ? esc(units(p, cap)) : "no cap"}</span>
    </div>`;
}

function devHtml(l) {
  const d = l.descriptor;
  const code = `import { MeterX402 } from "mx402";\n\nconst mx = new MeterX402({ wallet, budget: "1 HBAR", registry: "${HUB}" });\nconst r = await mx.call("${d.service_id}");\nconsole.log(r.receipt, r.data);`;
  return `<div class="kv">
      <span>service id</span><span class="mono">${esc(d.service_id)}</span>
      <span>endpoint</span><span class="mono">${esc(d.endpoint)}</span>
      <span>meter</span><span class="mono">${esc(d.pricing.meter)}</span>
      <span>settlement</span><span>${d.payment.settlement.map((o) => `${esc(o.currency)} on ${esc(o.network)} (${o.schemes.join(" + ")})`).join("; ")}</span>
      <span>interfaces</span><span>${d.interfaces.map((i) => IFACE[i] ?? i).join(" · ")}</span>
      <span>links</span><span><a href="${esc(d.links.descriptor)}" target="_blank" rel="noopener">descriptor</a> · <a href="${esc(d.links.a2a_card)}" target="_blank" rel="noopener">A2A card</a></span>
    </div>
    ${snippet("SDK", code)}
    <div class="runbar"><button class="primary" id="dr-pg">Open in the playground</button><span class="label">MCP, A2A, raw HTTP and CLI, runnable</span></div>`;
}

// ── Try it ──────────────────────────────────────────────────────────────
let TRY = null; // { l, recipe, root, advTouched }

function renderTry(body, l) {
  const d = l.descriptor, recipe = recipeFor(d);
  if (!l.live) {
    body.innerHTML = `<div class="notice bad"><b>This service is offline right now.</b><div>Nothing can be requested or charged. It may come back: the registry keeps checking.</div></div>${aboutHtml(l)}`;
    return;
  }
  body.innerHTML = `
    <div class="tryform" id="tf">${recipe.form(d, l)}</div>
    <details class="adv" id="t-adv"><summary>Advanced: the exact request</summary>
      <div class="form" style="margin-top:8px">
        <div class="trio"><label>Method<select id="a-method"><option>GET</option><option>POST</option></select></label>
          <label>Path and query<input type="text" id="a-path"></label></div>
        <label>Body<textarea id="a-body" rows="2"></textarea></label>
        <label>Most ${esc(plural(unitBase(d.pricing), 2))} to use<input type="number" id="a-max" min="1" placeholder="the service's cap"></label>
      </div>
    </details>
    <div class="costline" id="costline"></div>
    <div class="runbar"><button class="primary big" id="t-go">${esc(recipe.cta)}</button></div>
    <div id="t-out"></div>`;
  TRY = { l, recipe, root: $("tf"), advTouched: false };
  recipe.bind($("tf"), () => { syncAdvanced(); refreshCostLine(); });
  ["a-method", "a-path", "a-body", "a-max"].forEach((id) => $(id).addEventListener("input", () => { TRY.advTouched = true; refreshCostLine(); }));
  syncAdvanced();
  refreshCostLine();
  $("t-go").onclick = runTry;
}

/** Keep the advanced editor showing what the friendly form would send. */
function syncAdvanced() {
  if (!TRY || TRY.advTouched) return;
  const req = TRY.recipe.build(TRY.l.descriptor, TRY.recipe.read(TRY.root));
  $("a-method").value = req.method;
  $("a-path").value = req.path;
  $("a-body").value = req.body ?? "";
}
function currentRequest() {
  const { l, recipe, root, advTouched } = TRY;
  const f = recipe.read(root);
  const req = advTouched
    ? { method: $("a-method").value, path: $("a-path").value || "/", body: $("a-method").value === "GET" ? "" : $("a-body").value, stream: f.stream }
    : recipe.build(l.descriptor, f);
  const max = $("a-max")?.value;
  return { req: { ...req, maxUnits: max || undefined }, f };
}

/** What this request is likely to cost, against the limit the user set. */
function refreshCostLine() {
  if (!TRY || !$("costline")) return;
  const { l, recipe, root } = TRY, p = l.descriptor.pricing;
  const f = recipe.read(root);
  let est = null, exact = false;
  const u = recipe.estimateUnits(l.descriptor, f);
  if (u != null) { est = priceFor(p, p.max_units ? Math.min(u, p.max_units) : u); exact = true; }
  else if (l.price.typical_call != null) est = l.price.typical_call;
  const overs = est != null && est > Number(LIM.perRequest);
  $("costline").className = `costline${overs ? " over" : ""}`;
  $("costline").innerHTML = `
    <span class="cl-est">${est == null
      ? `You'll see the exact price before paying.`
      : `${exact ? "This request" : "Usually"}: <b>${money(est)}</b>${exact && u != null ? ` for ${esc(units(p, Math.min(u, p.max_units ?? u)))}` : ""}`}</span>
    <span class="cl-lim">${overs ? "⚠ above" : "Your limit:"} ${hbar(LIM.perRequest)} per request <button class="linky" id="cl-change">Change</button></span>`;
  $("cl-change").onclick = (e) => { e.preventDefault(); openWalletPop(); };
}

const workingHtml = (msg) => `<div class="working"><span class="spin" aria-hidden="true"></span><div><b>${esc(msg)}</b><div class="sub">The service is running your request and measuring exactly what it uses. Nothing is charged yet.</div></div></div>`;
const errorHtml = (title, detail, retry = true) => `<div class="notice bad"><b>${esc(title)}</b><div>${esc(friendly(detail))}</div>
  <div class="sub">Nothing was charged.</div>${retry ? `<div class="runbar"><button class="ghost" data-retry="1">Try again</button></div>` : ""}</div>`;
/** Wire any "Try again" the last render produced. */
function bindRetry(root, fn) { root.querySelector("[data-retry]")?.addEventListener("click", fn); }

async function runTry() {
  const { l, recipe } = TRY, d = l.descriptor;
  const { req, f } = currentRequest();
  const out = $("t-out");
  if (req.stream) return streamTry(l, req, f, out);
  if (!W.ok) { out.innerHTML = errorHtml("No wallet set up", "Add BUYER_ACCOUNT_ID and BUYER_PRIVATE_KEY to .env, or run the offline demo.", false); return; }

  $("t-go").disabled = true;
  out.innerHTML = workingHtml(recipe.working);
  const steps = [{ t: "Asked for a price", d: `${esc(titleOf(d))} ran your request and metered it` }];
  const qr = await fetch("/playground/quote", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ service_id: d.service_id, method: req.method, path: req.path, body: req.body || undefined, maxUnits: req.maxUnits }),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
  $("t-go").disabled = false;

  if (!qr.ok) { out.innerHTML = errorHtml("That didn't work", qr.error); bindRetry(out, runTry); return; }
  if (qr.free) { out.innerHTML = `<div class="notice ok"><b>Free</b><div>Nothing billable was used, so there was nothing to pay.</div></div>${resultHtml(l, qr.result?.data, f)}`; return; }

  const q = qr.quote, amount = Number(q.amount);
  const overReq = amount > Number(LIM.perRequest);
  const overSes = sessionSpent() + amount > Number(LIM.session);
  steps.push({ t: "Got an exact price", d: `${esc(units(d.pricing, q.units))} → ${esc(q.amount)} ${esc(q.currency)}, with the answer held until paid` });

  if (LIM.autopay && !overReq && !overSes) {
    steps.push({ t: "Checked your limits", d: `under your ${hbar(LIM.perRequest)} limit, so it was paid automatically` });
    return payQuote(l, q, f, out, steps, LIM.perRequest, true);
  }
  steps.push({ t: "Checked your limits", d: overReq ? `above your ${hbar(LIM.perRequest)} limit: asking you first` : overSes ? `would pass your ${hbar(LIM.session)} session limit: asking you first` : `within your ${hbar(LIM.perRequest)} limit` });
  renderPaySheet(l, q, f, out, steps, { overReq, overSes });
}

function renderPaySheet(l, q, f, out, steps, warn) {
  const d = l.descriptor, amount = Number(q.amount);
  const span = Math.max(1000, q.expires_at - Date.now());   // for the hold bar
  out.innerHTML = `<div class="paysheet" role="group" aria-label="Confirm payment">
      <div class="ps-head">Ready to pay</div>
      <div class="ps-row"><span>${esc(titleOf(d))}</span><span>${esc(units(d.pricing, q.units))}</span></div>
      <div class="ps-total"><span>Total</span><span class="amt">${fmt(q.amount)} <small>${esc(q.currency)}</small></span></div>
      ${usdOf(amount) != null ? `<div class="ps-usd">≈ ${usdText(usdOf(amount))}</div>` : ""}
      ${warn.overReq ? `<div class="notice warn">This is above your ${hbar(LIM.perRequest)} per-request limit.</div>` : ""}
      ${warn.overSes ? `<div class="notice warn">This would take you past your ${hbar(LIM.session)} limit for this session.</div>` : ""}
      <div class="ps-actions"><button class="primary big" id="ps-pay">Pay ${fmt(q.amount)} ${esc(q.currency)}</button><button class="ghost" id="ps-no">Cancel</button></div>
      <div class="ps-hold" aria-hidden="true"><i id="ps-bar"></i></div>
      <div class="ps-fine">You pay only for what was measured. Cancel and nothing is charged. <span id="ps-cd"></span></div>
    </div>`;
  // The hold is a real deadline, so show it draining rather than as a number
  // that people have to read and convert into urgency themselves.
  const cd = setInterval(() => {
    const left = q.expires_at - Date.now();
    const el = $("ps-cd"), bar = $("ps-bar");
    if (!el) return clearInterval(cd);
    const sec = Math.max(0, Math.round(left / 1000));
    el.textContent = sec ? `Held for ${sec}s` : "The price expired: ask again.";
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, (left / span) * 100))}%`;
    if (sec <= 0) { clearInterval(cd); $("ps-pay").disabled = true; done(); }
  }, 250);

  const done = () => { clearInterval(cd); removeEventListener("keydown", keys); };
  const cancel = () => {
    done();
    steps.push({ t: "You declined", d: "nothing was signed and nothing was paid; the hold expires on its own" });
    out.innerHTML = `<div class="notice"><b>Cancelled.</b> <span class="sub">Nothing was charged.</span></div>${whatHappened(steps)}`;
  };
  const pay = () => {
    done();
    const b = $("ps-pay");
    if (b) { b.disabled = true; b.textContent = "Paying…"; }
    payQuote(l, q, f, out, steps, q.amount, false);
  };
  // Enter pays, Escape cancels: the two things a checkout has to answer to.
  const keys = (e) => {
    if (M.tab !== "try") return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pay(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
  };
  addEventListener("keydown", keys);
  $("ps-no").onclick = cancel;
  $("ps-pay").onclick = pay;
  $("ps-pay").focus({ preventScroll: true });
}

async function payQuote(l, q, f, out, steps, maxPrice, auto) {
  const d = l.descriptor;
  out.innerHTML = workingHtml("Paying on Hedera…");
  const pr = await fetch("/playground/pay", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quote_id: q.quote_id, maxPrice: String(maxPrice) }),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));

  if (!pr.ok || !pr.result?.paid) {
    steps.push({ t: "Payment refused", d: esc(pr.error ?? `HTTP ${pr.result?.status}`), bad: true });
    out.innerHTML = errorHtml(pr.refused ? "Refused before signing" : "Payment didn't go through", pr.error, !pr.refused) + whatHappened(steps);
    bindRetry(out, runTry);
    return;
  }
  const rc = pr.result.receipt, v = pr.result.verification;
  steps.push({ t: "Paid", d: `${esc(rc.amount)} ${esc(rc.currency)} settled on Hedera${rc.transaction_id ? ` · ${esc(rc.transaction_id)}` : ""}` });
  if (v) steps.push({ t: "Checked what arrived", d: `body hash ${v.bodyHash ? "matches the price you agreed" : "does NOT match"} · re-counted ${v.remetered ?? "n/a"} ${esc(rc.unit)} (${esc(v.method)})${pr.result.dispute?.filed ? " · dispute filed automatically" : ""}`, bad: v.bodyHash === false });

  out.innerHTML = receiptHtml(l, rc, v, auto) + resultHtml(l, pr.result.data, f) + whatHappened(steps);
  toast(`Paid ${hbar(rc.amount)} · ${esc(titleOf(d))}`);
  loadMine(); loadMarket();
}

function receiptHtml(l, rc, v, auto) {
  const d = l.descriptor, worst = l.price.worst_case_call, amount = Number(rc.amount);
  const saved = worst != null && worst > amount ? worst - amount : null;
  const verified = v ? v.bodyHash !== false && v.unitsMatch !== false : null;
  // When the asset carries a custom fee, consensus splits this payment on the
  // way through. Show the split: the seller did not receive what you paid.
  const fee = d.payment.settlement.find((o) => o.currency === rc.currency)?.fee;
  const cut = fee ? Number(fee.percent) : 0;
  const split = fee && cut > 0 ? `<div class="rc-split">
      <div class="sp-bar"><i class="sp-seller" style="width:${100 - cut}%"></i><i class="sp-fee" style="width:${cut}%"></i></div>
      <div class="sp-keys">
        <span><i class="sp-seller"></i>Seller ${fmt(amount * (100 - cut) / 100)} ${esc(rc.currency)}</span>
        <span><i class="sp-fee"></i>Network fee ${fee.percent}% → ${esc(fee.collector)}</span>
      </div>
      <div class="sub">Assessed by consensus from the token's own fee schedule, not by MeterX402.</div>
    </div>` : "";
  return `<div class="receipt-card">
    <div class="rc-head"><span class="rc-tick">✓</span><b>Paid ${fmt(rc.amount)} ${esc(rc.currency)}</b>${usdOf(amount) != null ? `<span class="usd">≈ ${usdText(usdOf(amount))}</span>` : ""}${auto ? `<span class="badge">auto-paid</span>` : ""}</div>
    <div class="rc-lines">
      <span>For</span><span>${esc(units(d.pricing, rc.metered_units))} × ${fmt(rc.rate)} ${esc(rc.currency)}${rc.per > 1 ? ` / ${rc.per}` : ""}</span>
      ${verified != null ? `<span>Checked</span><span class="${verified ? "good" : "bad"}">${verified ? "You were charged for exactly what you received" : "What arrived did not match the price: a dispute was filed"}</span>` : ""}
      ${saved != null ? `<span>Versus flat</span><span>A flat price would have been ${hbar(worst)} — you saved <b>${hbar(saved)}</b></span>` : ""}
      ${rc.transaction_id ? `<span>Proof</span><span><a href="${esc(hashscanTx(rc.transaction_id))}" target="_blank" rel="noopener">View on HashScan ↗</a></span>` : `<span>Proof</span><span>On your prepaid tab; settles in a batch</span>`}
    </div>${split}</div>`;
}

const resultHtml = (l, data, f) => {
  const r = recipeFor(l.descriptor);
  let rendered;
  try { rendered = r.render(data, { d: l.descriptor, l, f }); } catch { rendered = autoRender(data); }
  const raw = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return `<div class="result-box">${rendered}</div>
    <details class="adv raw"><summary>Raw response</summary><pre class="code respbox">${esc((raw ?? "").slice(0, 8000))}</pre></details>`;
};

const whatHappened = (steps) => `<details class="adv what"><summary>What happened</summary><ul class="steps">${steps.map((s) => `<li class="${s.bad ? "bad" : "ok"}"><span class="ic">${s.bad ? "!" : "✓"}</span><div><b>${esc(s.t)}</b><div class="d">${s.d}</div></div></li>`).join("")}</ul></details>`;

/** Streaming: only possible on a prepaid tab, so there is nothing to withhold. */
function streamTry(l, req, f, out) {
  const d = l.descriptor, p = d.pricing;
  const perUnit = Number(p.rate) / p.per;
  const maxUnits = req.maxUnits ? Number(req.maxUnits) : Math.max(1, Math.floor(Number(LIM.perRequest) / perUnit));
  out.innerHTML = `<div class="notice"><b>Streaming on a prepaid tab.</b> <span class="sub">You approve an allowance once; each answer is deducted as it is written, and stops at your limit.</span></div>
    <div class="answer chat streaming"><p id="st-text"></p><span class="cursor"></span></div>
    <div class="meter" aria-live="off">
      <div class="m-row"><span class="m-units" id="st-u">measuring…</span><span class="m-cost" id="st-cost">0 ${esc(d.pricing.currency)}</span></div>
      <div class="m-bar"><i id="st-fill"></i></div>
      <div class="m-row m-foot"><span id="st-c">opening a tab…</span><span>limit ${esc(units(p, maxUnits))}</span></div>
    </div>`;
  const box = $("st-text");
  let text = "";
  const es = new EventSource(`/teststream?lane=${encodeURIComponent(d.name)}&prompt=${encodeURIComponent(req.prompt ?? "")}&maxUnits=${maxUnits}`);
  es.addEventListener("open", (e) => { try { const o = JSON.parse(e.data); if (o.tab) $("st-c").textContent = `tab ${o.tab} · allowance ${o.allowance} ${d.pricing.currency}`; } catch {} });
  es.addEventListener("chunk", (e) => {
    text += JSON.parse(e.data).text ?? "";
    box.innerHTML = prose(text);
    // The whole point of metering, made visible: the number moves while the
    // answer is still being written. ~4 characters per token is the usual
    // rule of thumb, and the receipt replaces it with the real count.
    const approx = Math.ceil(text.length / 4);
    const cost = priceFor(p, approx);
    $("st-u").textContent = `~${units(p, approx)}`;
    $("st-cost").textContent = `~${hbar(cost)}`;
    $("st-fill").style.width = `${Math.min(100, (approx / maxUnits) * 100)}%`;
  });
  es.addEventListener("cap", (e) => {
    const c = JSON.parse(e.data);
    text += `

— stopped at your limit of ${c.cap} ${c.unit} —`;
    box.innerHTML = prose(text);
    $("st-fill").classList.add("capped");
  });
  es.addEventListener("receipt", (e) => {
    const r = JSON.parse(e.data).receipt ?? {};
    out.querySelector(".streaming")?.classList.remove("streaming");
    $("st-u").textContent = units(p, r.billable ?? 0);
    $("st-cost").textContent = hbar(r.amount);
    $("st-fill").style.width = `${Math.min(100, ((r.billable ?? 0) / maxUnits) * 100)}%`;
    $("st-c").innerHTML = `deducted from your tab · <b>exact</b>, not an estimate`;
    es.close();
    toast(`Streamed ${units(p, r.billable ?? 0)} · ${hbar(r.amount)}`);
    loadMine(); loadMarket();
  });
  es.addEventListener("error", (e) => {
    let m = "the stream stopped"; try { m = JSON.parse(e.data).error ?? m; } catch {}
    out.innerHTML = errorHtml("Streaming stopped", m); bindRetry(out, runTry); es.close();
  });
  es.onerror = () => es.close();
}

// ── Activity ────────────────────────────────────────────────────────────
function renderActivity() {
  if (!W.ok) { $("act-list").innerHTML = `<div class="empty-state">No wallet, so nothing to show yet.</div>`; $("act-kpis").innerHTML = ""; return; }
  const listing = (id) => M.services.find((l) => l.service_id === id);
  const spent = totalSpent();
  const saved = MY.reduce((a, r) => { const w = listing(r.service_id)?.price.worst_case_call; return a + (w != null && w > Number(r.amount) ? w - Number(r.amount) : 0); }, 0);
  $("act-kpis").innerHTML = [
    ["Spent", `${fmt(spent)} <small>HBAR</small>`, usdOf(spent) != null ? `≈ ${usdText(usdOf(spent))}` : "on testnet"],
    ["Paid uses", String(MY.length), `${new Set(MY.map((r) => r.service_id)).size} service${new Set(MY.map((r) => r.service_id)).size === 1 ? "" : "s"}`],
    ["Saved vs flat", `${fmt(saved)} <small>HBAR</small>`, "versus paying each call's worst case"],
  ].map(([k, v, s]) => `<div class="card tile"><div class="label">${k}</div><div class="v">${v}</div><div class="sub">${esc(s)}</div></div>`).join("");

  if (!MY.length) {
    $("act-list").innerHTML = `<div class="empty-state">Nothing yet. <button class="linky" id="act-go">Find something to try</button>.</div>`;
    $("act-go").onclick = () => setUserTab("market");
    return;
  }
  const day = (t) => { const d = new Date(t), n = new Date(); const same = (a, b) => a.toDateString() === b.toDateString(); return same(d, n) ? "Today" : same(d, new Date(n - 864e5)) ? "Yesterday" : d.toLocaleDateString([], { month: "long", day: "numeric" }); };
  let last = null, html = "";
  for (const r of MY) {
    const l = listing(r.service_id), d = l?.descriptor;
    const label = day(r.settled_at);
    if (label !== last) { html += `<div class="act-day">${esc(label)}</div>`; last = label; }
    html += `<div class="act-row"${d ? ` data-open="${esc(r.service_id)}"` : ""}>
      ${d ? avatar(d) : `<div class="avatar cat" style="--h:220">${icon("grid")}</div>`}
      <div class="ar-mid"><b>${esc(d ? titleOf(d) : r.service_id)}</b><span>${esc(d ? units(d.pricing, r.metered_units) : `${r.metered_units} ${r.unit}`)} · ${ago(r.settled_at)}</span></div>
      <div class="ar-amt"><b>${fmt(r.amount)} ${esc(r.currency)}</b>${usdOf(r.amount) != null ? `<span class="usd">≈ ${usdText(usdOf(r.amount))}</span>` : ""}</div>
      <div class="ar-proof">${r.transaction_id ? `<a href="${esc(hashscanTx(r.transaction_id))}" target="_blank" rel="noopener" title="View on HashScan">↗</a>` : `<span class="badge">tab</span>`}</div>
    </div>`;
  }
  $("act-list").innerHTML = html;
  $("act-list").querySelectorAll("[data-open]").forEach((el) => el.onclick = (e) => { if (!e.target.closest("a")) openService(el.dataset.open, "try"); });
}

// ── "for AI agents" snippets (Developers tab) ───────────────────────────
function renderAgentSnippets() {
  const reg = `curl -s '${HUB}/registry/services?capability=weather_forecast&minReputation=80'`;
  const mcp = JSON.stringify({ mcpServers: { meterx402: { command: "npx", args: ["-y", "mx402", "mcp"], env: { MX_HUB: HUB, BUYER_ACCOUNT_ID: "0.0.…", BUYER_PRIVATE_KEY: "302e…", BUYER_BUDGET: "1 HBAR" } } } }, null, 2);
  const sdk = `import { MeterX402Agent } from "mx402";\n\nconst agent = new MeterX402Agent({ wallet, budget: "1 HBAR", registry: "${HUB}" });\nconst r = await agent.call("weather_forecast");   // discover → quote → pay → receipt`;
  const a2a = `# every service is an A2A agent\ncurl -s ${M.services[0]?.descriptor.links.a2a_card ?? "<endpoint>/.well-known/agent.json"}`;
  $("agent-snippets").innerHTML = [["Registry API", reg], ["MCP server (Claude, any MCP client)", mcp], ["SDK", sdk], ["A2A", a2a]].map(([t, c]) => snippet(t, c)).join("");
  bindCopy($("agent-snippets"));
}

/** A labelled, copyable code block. */
function snippet(label, code, id = "") {
  return `<div class="snippet"${id ? ` id="${id}"` : ""}>${label ? `<div class="lbl">${esc(label)}</div>` : ""}<pre class="code">${highlight(code)}</pre><button class="copy" data-code="${esc(code)}">copy</button></div>`;
}
function highlight(code) {
  return esc(code).replace(/(^|\n)(\s*)(\/\/[^\n]*|#[^\n]*)/g, (_, a, b, c) => `${a}${b}<span class="c">${c}</span>`);
}
function bindCopy(root) {
  root.querySelectorAll(".copy").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(b.dataset.code); b.textContent = "copied"; } catch { b.textContent = "select + copy"; }
    setTimeout(() => (b.textContent = "copy"), 1400);
  });
}

// ── the developer lifecycle runner (Developers tab) ─────────────────────
// The same calls as above, but every step stays on screen: this is the view for
// someone implementing against the protocol.
async function runLifecycle(d, req, out, labels = {}) {
  const L = { quote: "Quote", budget: "Budget check", pay: "Pay and settle", verify: "Verify what arrived", ...labels };
  const steps = [];
  const paint = (extra = "") => { out.innerHTML = `<ul class="steps">${steps.map((s) => `<li class="${s.state}"><span class="ic">${s.state === "ok" ? "✓" : s.state === "bad" ? "!" : "…"}</span><div><b>${esc(s.title)}</b><div class="d">${s.detail}</div></div></li>`).join("")}</ul>${extra}`; };
  steps.push({ state: "ok", title: "Discover", detail: `${esc(d.service_id)} from the registry · ${esc(d.pricing.meter)} at ${fmt(d.pricing.rate)} ${esc(d.pricing.currency)} / ${d.pricing.per === 1 ? "" : d.pricing.per + " "}${esc(d.pricing.unit)}` });
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
      loadMarket(); loadMine();
      resolve();
    };
  });
}

function respBlock(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return `<h4>Response</h4><pre class="code respbox">${esc((text ?? "").slice(0, 6000))}</pre>`;
}

// ── wiring ──────────────────────────────────────────────────────────────
$("mkt-q").oninput = () => { M.q = $("mkt-q").value; renderExplore(); };
$("mkt-sort").onchange = () => { M.sort = $("mkt-sort").value; renderExplore(); };
$("mkt-rated").onchange = () => { M.rated = $("mkt-rated").checked; renderExplore(); };
// the price calculator inside the About tab
document.addEventListener("input", (e) => {
  if (e.target.id !== "pc-range") return;
  const l = M.services.find((x) => x.service_id === M.open);
  if (!l) return;
  const p = l.descriptor.pricing, n = Number(e.target.value);
  $("pc-out").innerHTML = `${esc(units(p, n))} → <b>${money(priceFor(p, n))}</b>`;
});

loadMarket().then(renderAgentSnippets);
setInterval(loadMarket, 5000);
