// Deployer view: the seller's dashboard (income, lanes, registry, payments,
// analytics, live events). Loaded first: it defines the shared helpers ($, S,
// fmt, esc, short, time) the user views reuse.
const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const S = { lanes: [], events: [], payments: [], receipts: {}, flushes: {}, laneFilter: Q.get("lane") ?? "all", owner: Q.get("wallet") ?? "", analytics: null, status: null };
const cur = () => (S.lanes[0]?.currency ?? "HBAR");
const fmt = (n, d = 8) => {
  const x = Number(n) || 0;
  if (x === 0) return "0";
  if (Math.abs(x) >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return x.toLocaleString(undefined, { maximumFractionDigits: d, maximumSignificantDigits: 6 });
};
const compact = (n) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(n) || 0);
const short = (s) => { s = String(s ?? ""); return s.length > 16 ? s.slice(0, 8) + "…" + s.slice(-4) : s; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const time = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function ownedLanes() {
  const o = S.owner.trim().toLowerCase();
  return S.lanes.filter((l) => !o || String(l.payTo).toLowerCase() === o);
}
function scopeKeys() {
  const owned = ownedLanes().map((l) => l.name);
  return S.laneFilter === "all" ? owned : owned.filter((n) => n === S.laneFilter);
}

// ── data ────────────────────────────────────────────────────────────────
async function refreshLanes() {
  try {
    const [{ lanes }, status] = await Promise.all([fetch("/lanes").then((r) => r.json()), fetch("/status").then((r) => r.json())]);
    const changed = JSON.stringify(lanes.map((l) => [l.name, l.rate, l.policy])) !== JSON.stringify(S.lanes.map((l) => [l.name, l.rate, l.policy]));
    S.lanes = lanes; S.status = status;
    renderStatus();
    if (changed) { renderFilters(); renderLanes(); }
  } catch {}
}
async function refreshAnalytics() {
  try {
    const keys = scopeKeys();
    S.analytics = await fetch(`/analytics?lanes=${encodeURIComponent(keys.join(","))}`).then((r) => r.json());
    renderKpis(); renderHours(); renderTables();
  } catch {}
}

const COMPONENTS = ["execution", "response_success", "latency", "disputes", "uptime", "payment_reliability"];
async function refreshRegistry() {
  try {
    const { services } = await fetch("/registry/services?live=all").then((r) => r.json());
    const o = S.owner.trim().toLowerCase();
    const rows = services.filter((l) => !o || String(l.descriptor.owner.account).toLowerCase() === o);
    $("registry").innerHTML = rows.length ? rows.map((l) => {
      const d = l.descriptor, r = l.reputation, st = r.stats;
      const bars = COMPONENTS.map((k) => `<i title="${k.replace(/_/g, " ")}: ${Math.round(r.components[k] * 100)}% × ${r.weights[k]}"><b style="height:${Math.round(r.components[k] * 100)}%"></b></i>`).join("");
      const score = r.score == null ? `<span style="color:var(--muted)">unrated</span>` : `<span class="score">${r.score}</span><span style="color:var(--muted)">/100</span>`;
      return `<tr>
        <td><b>${esc(d.name)}</b> <span class="mono" style="color:var(--muted)">${esc(d.service_id)}</span>${l.live ? "" : ` <span class="badge" style="background:var(--chip);color:var(--muted)">down</span>`}</td>
        <td class="caps">${d.capabilities.map((c) => `<span>${esc(c)}</span>`).join("")}</td>
        <td>${esc(d.pricing.rate)} ${esc(d.pricing.currency)} / ${d.pricing.per === 1 ? "" : d.pricing.per + " "}${esc(d.pricing.unit)}</td>
        <td style="color:var(--ink-2)">${d.interfaces.join(" · ")}</td>
        <td title="${r.confidence} confidence, ${r.sample_size} samples${r.anchor ? `; anchored on HCS ${r.anchor.topic_id}` : ""}">${score}<span class="repbar">${bars}</span></td>
        <td class="num">${st.paid_calls}</td>
        <td class="num">${st.median_latency_ms ?? "–"}</td>
        <td class="num">${st.uptime_ratio == null ? "–" : Math.round(st.uptime_ratio * 100) + "%"}</td>
        <td class="num">${st.disputes}</td></tr>`;
    }).join("") : `<tr><td colspan="9" class="empty">No services registered yet</td></tr>`;
  } catch {}
}
$("anchor-btn").onclick = async () => {
  $("anchor-note").textContent = "anchoring…";
  const r = await fetch("/registry/reputation/anchor", { method: "POST" }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
  $("anchor-note").innerHTML = r.ok
    ? `Anchored ${r.services.length} scores on HCS topic ${esc(r.topic_id)}: <a href="${esc(r.hashscan)}" target="_blank" rel="noopener">transaction</a> · digest <span class="mono">${esc(r.digest.slice(0, 16))}…</span>`
    : `Not anchored: ${esc(r.error)}${r.digest ? ` (digest <span class="mono">${esc(r.digest.slice(0, 16))}…</span>)` : ""}`;
  refreshRegistry();
};

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  ws.onopen = () => { $("wsdot").classList.add("on"); $("wstext").textContent = "live"; };
  ws.onclose = () => { $("wsdot").classList.remove("on"); $("wstext").textContent = "reconnecting"; setTimeout(connect, 1500); };
  ws.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch {} };
}

let dirty = false;
function onEvent(ev) {
  S.events.push(ev); if (S.events.length > 300) S.events.shift();
  if (ev.type === "settled") {
    if (!S.payments.some((p) => p.reqId === ev.reqId)) S.payments.unshift({ ...ev.data, lane: ev.lane, t: ev.t, reqId: ev.reqId, fresh: true });
    if (S.payments.length > 200) S.payments.pop();
    dirty = true;
  }
  if (ev.type === "hedera_receipt" || ev.type === "hcs_receipt") { (S.receipts[ev.reqId] ??= {})[ev.type] = ev.data; dirty = true; }
  if (ev.type === "tab_flush" && ev.data.tab) { S.flushes[ev.data.tab] = ev.data; dirty = true; }
  if (ev.type === "hcs_receipt" && ev.data.topicUrl) { const h = $("hcs"); h.hidden = false; h.innerHTML = `HCS receipts <a href="${esc(ev.data.topicUrl)}" target="_blank" rel="noopener">${esc(ev.data.topicId)}</a>`; }
  if (ev.type === "lane_up" || ev.type === "policy") refreshLanes();
  feed(ev);
}
setInterval(() => { if (dirty) { dirty = false; renderPayments(); renderCharges(); refreshAnalytics(); } }, 400);

// ── render ──────────────────────────────────────────────────────────────
function renderStatus() {
  const s = S.status; if (!s) return;
  const label = { live: "Hedera testnet · blocky402", offline: "offline demo · mock facilitator", replay: "replaying a recorded tape" }[s.mode] ?? s.mode;
  $("mode").textContent = label;
  if (s.hcsTopicUrl) { const h = $("hcs"); h.hidden = false; h.innerHTML = `HCS receipts <a href="${esc(s.hcsTopicUrl)}" target="_blank" rel="noopener">${esc(s.hcsTopic)}</a>`; }
}

function renderFilters() {
  const names = ownedLanes().map((l) => l.name);
  if (S.laneFilter !== "all" && !names.includes(S.laneFilter)) S.laneFilter = "all";
  $("lanefilter").innerHTML = ["all", ...names].map((n) => `<button class="pill" data-lane="${esc(n)}" aria-pressed="${S.laneFilter === n}">${n === "all" ? "All APIs" : esc(n)}</button>`).join("");
  $("lanefilter").querySelectorAll("button").forEach((b) => b.onclick = () => { S.laneFilter = b.dataset.lane; renderFilters(); renderCharges(); renderPayments(); refreshAnalytics(); });
}

function renderKpis() {
  const a = S.analytics; if (!a) return;
  const c = cur();
  $("k-income").innerHTML = `${fmt(a.totalIncome)}<small>${c}</small>`;
  $("k-income-sub").textContent = S.laneFilter === "all" ? `across ${scopeKeys().length} metered API${scopeKeys().length === 1 ? "" : "s"}` : `from ${S.laneFilter}`;
  $("k-calls").textContent = compact(a.totalRequests);
  $("k-calls-sub").textContent = a.byTier?.bot ? `${a.byTier.bot.calls} from bots at the bot rate` : " ";
  // tokens + rows + bytes don't add up to anything: only sum one unit
  $("k-units").textContent = a.unit === "mixed" ? "mixed" : compact(a.totalUnits);
  $("k-units-sub").textContent = a.unit === "mixed" ? "pick one API to see its units" :a.unit ? `${a.unit} · ${fmt(a.pricePerUnit)} ${c}/unit` : " ";
  $("k-avg").innerHTML = `${fmt(a.charges.p50)}<small>${c}</small>`;
  $("k-avg-sub").textContent = a.totalRequests ? `median · p90 ${fmt(a.charges.p90)} · max ${fmt(a.charges.max)}` : "median · p90";
  $("k-saved").innerHTML = `${fmt(a.saved)}<small>${c}</small>`;
}

const tip = $("tip");
function showTip(e, html) { tip.innerHTML = html; tip.hidden = false; const w = tip.offsetWidth; tip.style.left = Math.min(innerWidth - w - 8, e.clientX + 12) + "px"; tip.style.top = (e.clientY + 14) + "px"; }
function hideTip() { tip.hidden = true; }

// axis max = 4 clean steps (4 gridlines); integer data (counts) gets integer steps
function niceMax(v, integer = false) {
  if (v <= 0) return integer ? 4 : 1;
  const raw = v / 4, p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const step = +(m * p).toPrecision(6);
    if (integer && (step < 1 || !Number.isInteger(step))) continue;
    if (step >= raw - 1e-12) return +(step * 4).toPrecision(6);
  }
  return 40 * p;
}

/** Column chart: 4px rounded data-end, square baseline, <=24px thick, 2px surface gap, hover per mark. */
function columns(svg, items, { value, tipHtml, ref, xLabels, integer }) {
  const W = svg.clientWidth || 600, H = svg.clientHeight || 160, L = 48, R = 8, T = 10, B = 18;
  const vals = items.map(value);
  const max = niceMax(Math.max(...vals, ref ?? 0, 0), integer);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let out = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    out += `<line class="${i ? "gridline" : "baseline"}" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 6}" y="${yy + 3.5}" text-anchor="end">${fmt(v, 6)}</text>`;
  }
  const n = Math.max(items.length, 1), band = (W - L - R) / n, bw = Math.max(2, Math.min(24, band - 2));
  items.forEach((it, i) => {
    const v = vals[i], x = L + band * i + (band - bw) / 2, top = y(v), h = Math.max(0, y(0) - top), r = Math.min(4, bw / 2, h);
    const d = h <= 0 ? "" : `M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${y(0)} Z`;
    out += `<path class="bar" d="${d}"/><rect data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent"/>`;
    if (xLabels && xLabels[i]) out += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${xLabels[i]}</text>`;
  });
  if (ref != null && ref > 0) out += `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}"/><text x="${W - R}" y="${y(ref) - 4}" text-anchor="end" style="fill:var(--ink-2)">flat at cap ${fmt(ref)}</text>`;
  if (!items.length) out += `<text x="${(W + L) / 2}" y="${H / 2}" text-anchor="middle">no paid calls yet</text>`;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = out;
  const bars = svg.querySelectorAll(".bar");
  svg.querySelectorAll("rect[data-i]").forEach((r) => {
    const i = Number(r.dataset.i);
    r.onmousemove = (e) => { bars.forEach((b) => b.classList.remove("hot")); bars[i]?.classList.add("hot"); showTip(e, tipHtml(items[i])); };
    r.onmouseleave = () => { bars[i]?.classList.remove("hot"); hideTip(); };
  });
}

function scopedPayments() {
  const keys = new Set(scopeKeys());
  return S.payments.filter((p) => keys.has(p.lane) || !S.lanes.length);
}

function renderCharges() {
  const items = scopedPayments().slice(0, 60).reverse();
  const c = cur();
  // The flat price a GlassBox-style lane would need: every call priced at the seller cap.
  const lane = S.laneFilter !== "all" ? S.lanes.find((l) => l.name === S.laneFilter) : null;
  const ref = lane?.maxUnits ? Math.max(Number(lane.min) || 0, (lane.maxUnits * Number(lane.rate)) / Number(lane.per || 1)) : null;
  $("ref-key").hidden = ref == null;
  columns($("c-charges"), items, {
    value: (p) => Number(p.amount) || 0,
    ref,
    tipHtml: (p) => `<b>${fmt(p.amount)} ${c}</b> · ${esc(p.lane)}<br>${p.units} ${esc(p.unit)} × ${esc(p.rate)} / ${esc(p.per)}${p.cap ? `<br>cap ${p.cap} → flat would be ${fmt(p.ceilingAmount)}` : ""}<br>${time(p.t)}`,
  });
}

function renderHours() {
  const hrs = S.analytics?.byHour ?? new Array(24).fill(0);
  columns($("c-hours"), hrs.map((v, h) => ({ v, h })), {
    value: (d) => d.v,
    integer: true,
    xLabels: hrs.map((_, h) => (h % 6 === 0 ? String(h).padStart(2, "0") : "")),
    tipHtml: (d) => `<b>${d.v} call${d.v === 1 ? "" : "s"}</b><br>${String(d.h).padStart(2, "0")}:00–${String(d.h).padStart(2, "0")}:59 UTC`,
  });
}

function renderTables() {
  const a = S.analytics; if (!a) return;
  $("endpoints").innerHTML = a.byEndpoint.length ? a.byEndpoint.map((e) => `<tr><td class="mono">${esc(e.key)}</td><td class="num">${e.calls}</td><td class="num">${compact(e.units)}</td><td class="num">${fmt(e.income)}</td></tr>`).join("") : `<tr><td colspan="4" class="empty">no traffic</td></tr>`;
  $("payers").innerHTML = a.byPayer.length ? a.byPayer.map((p) => `<tr><td class="mono">${esc(short(p.payer))}</td><td class="num">${p.calls}</td><td class="num">${compact(p.units)}</td><td class="num">${fmt(p.spend)}</td></tr>`).join("") : `<tr><td colspan="4" class="empty">no payers</td></tr>`;
}

function renderPayments() {
  const rows = scopedPayments().slice(0, 50);
  $("payments").innerHTML = rows.length ? rows.map((p) => {
    const r = S.receipts[p.reqId] ?? {};
    const flush = p.tab ? S.flushes[p.tab] : null;
    const links = (p.scheme === "tab"
      ? [`<span class="badge" title="on tab ${esc(p.tab)}">tab</span>`,
         flush?.hashscan ? `<a href="${esc(flush.hashscan)}" target="_blank" rel="noopener">batch tx</a>` : flush?.txHash ? `<span class="mono" title="${esc(flush.txHash)}">${esc(short(flush.txHash))}</span>` : `<span style="color:var(--muted)">owed</span>`]
      : [r.hedera_receipt?.hashscan ? `<a href="${esc(r.hedera_receipt.hashscan)}" target="_blank" rel="noopener">tx</a>` : `<span class="mono" title="${esc(p.txHash)}">${esc(short(p.txHash))}</span>`,
         r.hcs_receipt?.hashscan ? `<a href="${esc(r.hcs_receipt.hashscan)}" target="_blank" rel="noopener">HCS</a>` : ""]).filter(Boolean).join(" · ");
    const row = `<tr class="${p.fresh ? "new" : ""}"><td>${time(p.t)}</td><td>${esc(p.lane)}</td><td class="mono">${esc(short(p.from))}</td>
      <td class="num">${p.units} <span style="color:var(--muted)">${esc(p.unit)}</span>${p.measured > p.units ? ` <span title="measured ${p.measured}, billed at the cap" style="color:var(--muted)">(of ${p.measured})</span>` : ""}</td>
      <td class="num">${p.cap ?? "–"}</td><td>${esc(p.rate)} / ${esc(p.per)}</td><td class="num"><b>${fmt(p.amount)}</b></td>
      <td class="num" style="color:var(--muted)">${p.ceilingAmount != null ? fmt(p.ceilingAmount) : "–"}</td><td>${esc(p.tier)}</td><td>${links}</td></tr>`;
    p.fresh = false;
    return row;
  }).join("") : `<tr><td colspan="10" class="empty">No payments yet: send a test buyer from an API card</td></tr>`;
}

function feed(ev) {
  const d = ev.data ?? {};
  const txt = {
    request_in: () => `${d.method} ${d.path}`,
    metered: () => `metered ${d.measured} ${d.unit}${d.capped ? ` (capped at ${d.cap})` : ""} → ${d.billable} billable = ${fmt(d.amount)} ${d.currency}`,
    quote_402: () => `402 quote ${fmt(d.amount)} ${d.currency}, response held`,
    settled: () => `settled ${fmt(d.amount)} ${d.currency} from ${short(d.from)} for ${d.units} ${d.unit}`,
    free: () => `free: 0 billable ${d.unit}`,
    payment_failed: () => `payment failed at ${d.stage ?? "?"}: ${d.reason}`,
    quote_expired: () => `quote expired, re-metering`,
    upstream_error: () => `upstream ${d.status}: not charged`,
    rate_limited: () => `refused: ${d.reason}`,
    blocked: () => `blocked: ${d.reason}`,
    policy: () => `policy: ${JSON.stringify(d)}`,
    lane_up: () => `lane up: ${d.rateLabel ?? ""}`,
    hcs_receipt: () => `HCS receipt on ${d.topicId}`,
    service_published: () => `published to the registry: ${(d.capabilities ?? []).join(", ")}`,
    dispute: () => `DISPUTE by ${short(d.buyer)}: ${d.reason} on quote ${short(d.quote_id)}`,
    reputation_anchor: () => `reputation snapshot of ${d.services} services anchored on HCS ${d.topicId}`,
    tab_open: () => `tab ${d.tab} opened by ${short(d.owner)}: ${d.allowance} allowance approved on-chain`,
    tab_flush: () => (d.error ? `tab ${d.tab} settlement failed: ${d.error}` : `tab ${d.tab}: ${fmt(d.amount)} settled for ${d.calls} calls in one transfer`),
    tab_close: () => `tab ${d.tab} closed: ${d.calls} calls, ${fmt(d.pulled)} paid`,
  }[ev.type];
  if (!txt || (ev.type === "lane_up" && d.heartbeat)) return;
  const el = document.createElement("div");
  el.innerHTML = `<span class="t">${time(ev.t)}</span> <b>${esc(ev.lane)}</b> ${esc(txt())}`;
  const f = $("feed"); f.prepend(el); while (f.children.length > 120) f.lastChild.remove();
}

function renderLanes() {
  const lanes = ownedLanes();
  const el = $("lanes");
  if (!lanes.length) { el.innerHTML = `<div class="card empty">No live lanes${S.owner ? " for this wallet" : ""} yet: run <span class="mono">npm run demo:offline</span></div>`; return; }
  el.innerHTML = lanes.map((l) => {
    // same mark the marketplace shows: the registry descriptor when there is one,
    // else a best guess from the lane name
    const listed = (typeof M !== "undefined" ? M.services ?? [] : []).find((s) => s.lane === l.name || s.descriptor?.service_id === l.name)?.descriptor;
    const guess = /llm|chat|gpt/i.test(l.name) ? "text_generation" : /weather/i.test(l.name) ? "weather_forecast" : /ether|chain|scan/i.test(l.name) ? "blockchain_data" : /market|price/i.test(l.name) ? "market_data" : "data";
    const d = { capabilities: listed?.capabilities?.length ? listed.capabilities : l.capabilities?.length ? l.capabilities : [guess], name: l.name };
    return `<article class="card lane" data-lane="${esc(l.name)}">
      <div class="lane-top">
        <div class="lane-name">${typeof avatar === "function" ? avatar(d) : ""}
          <div style="min-width:0"><h3>${esc(l.title ?? l.name)}</h3><div class="lane-id mono">${esc(l.name)} · :${l.port}</div></div></div>
        ${l.tabs ? `<span class="badge">tabs</span>` : ""}
      </div>
      <div class="rate">${esc(l.rateLabel)}</div>
      <div class="lane-meta">
        <span class="mono">${esc(l.meter)}</span>
        <span>cap ${l.maxUnits ?? "none"}${l.maxUnits ? ` ${esc(l.unit)}` : ""}</span>
        <span>min ${fmt(l.min)} ${esc(l.currency)}</span>
      </div>
      <details class="lane-more"><summary>Details and test buyer</summary>
        <div class="kv">
          <span>endpoint</span><span class="mono">${esc(l.sampleMethod)} :${l.port}${esc(l.sample)}</span>
          <span>payout</span><span class="mono">${esc(short(l.payTo))} · ${esc(l.network)}</span>
          ${l.tabs ? `<span>tabs</span><span>allowance to <span class="mono">${esc(l.tabs.spender)}</span>, settles every ${esc(l.tabs.flushAt)} ${esc(l.currency)}</span>` : ""}
        </div>
        ${l.sampleMethod !== "GET" ? `<details><summary>request body</summary><textarea class="body">${esc(l.sampleBody ?? "")}</textarea></details>` : `<input type="text" class="path" value="${esc(l.sample ?? "/")}" style="width:100%">`}
        <div class="row">
          <label class="field">max ${esc(l.unit)}<input type="number" class="maxunits" min="1" placeholder="none"></label>
          <label class="field">max ${esc(l.currency)} / call<input type="number" class="maxhbar" min="0" step="0.0001" placeholder="none"></label>
          <button class="primary buy">Send test buyer</button>
        </div>
        ${l.tabs ? `<div class="tabline">
          <span class="badge">tab</span>
          <input type="text" class="prompt" value="Explain metered x402 in 60 words" style="flex:1;min-width:160px">
          <button class="primary stream">Stream</button>
        </div>
        <div class="stream-out" hidden></div>
        <div class="meterbar" hidden><i></i></div>
        <div class="tick" hidden><span class="t-units">0 ${esc(l.unit)}</span><span class="t-cost">0 ${esc(l.currency)}</span></div>` : ""}
      </details>
      <div class="result" hidden></div>
    </article>`;
  }).join("");
  el.querySelectorAll(".lane").forEach((card) => {
    const lane = lanes.find((l) => l.name === card.dataset.lane);
    card.querySelector(".buy").onclick = () => testBuy(card, lane);
    card.querySelector(".stream")?.addEventListener("click", () => testStream(card, lane));
    // ?stream=<lane> opens the page straight into a live metered stream
    if (Q.get("stream") === lane.name && !card.dataset.autoStreamed && lane.tabs) {
      card.dataset.autoStreamed = "1";
      setTimeout(() => testStream(card, lane), 300);
    }
  });
}

/** Stream a metered response over a tab: text arrives token by token, the meter
 *  moves as it goes, and the receipt lands when the stream ends. */
function testStream(card, lane) {
  const out = card.querySelector(".stream-out"), bar = card.querySelector(".meterbar"), tick = card.querySelector(".tick");
  const btn = card.querySelector(".stream");
  const units = card.querySelector(".t-units"), cost = card.querySelector(".t-cost");
  const maxUnits = card.querySelector(".maxunits").value;
  const prompt = card.querySelector(".prompt").value;
  out.hidden = bar.hidden = tick.hidden = false;
  out.innerHTML = `<span class="cursor"></span>`;
  bar.firstElementChild.style.width = "0%";
  btn.disabled = true;
  let text = "", seen = 0;
  const cap = Number(maxUnits) || lane.maxUnits || 0;
  const rate = Number(lane.rate) / Number(lane.per || 1);
  const es = new EventSource(`/teststream?lane=${encodeURIComponent(lane.name)}&prompt=${encodeURIComponent(prompt)}${maxUnits ? `&maxUnits=${maxUnits}` : ""}`);
  const done = () => { es.close(); btn.disabled = false; };
  es.addEventListener("chunk", (e) => {
    text += JSON.parse(e.data).text ?? "";
    out.innerHTML = `${esc(text)}<span class="cursor"></span>`;
    // an in-flight estimate: the receipt at the end is the real count
    seen = Math.ceil(text.length / 4);
    units.textContent = `~${seen} ${lane.unit}`;
    cost.textContent = `~${fmt(seen * rate)} ${lane.currency}`;
    if (cap) bar.firstElementChild.style.width = `${Math.min(100, (seen / cap) * 100)}%`;
  });
  es.addEventListener("cap", (e) => {
    const d = JSON.parse(e.data);
    text += `\n\n— stopped at your cap of ${d.cap} ${d.unit} —`;
    out.textContent = text;
  });
  es.addEventListener("receipt", (e) => {
    const r = JSON.parse(e.data).receipt ?? {};
    out.textContent = text;
    units.textContent = `${r.billable} ${r.unit} metered`;
    cost.textContent = `${fmt(r.amount)} ${r.currency} · tab owes ${r.owed}`;
    if (cap) bar.firstElementChild.style.width = `${Math.min(100, (r.billable / cap) * 100)}%`;
    done();
  });
  es.addEventListener("error", (e) => {
    let msg = "stream failed";
    try { msg = JSON.parse(e.data).error ?? msg; } catch {}
    out.innerHTML = `<span class="status bad"><span class="ico">×</span>${esc(msg)}</span>`;
    done();
  });
  es.onerror = () => done();
}

async function testBuy(card, lane) {
  const btn = card.querySelector(".buy"), out = card.querySelector(".result");
  btn.disabled = true; out.hidden = false; out.innerHTML = `<span class="label">metering the call, then paying the quote…</span>`;
  const path = card.querySelector(".path")?.value ?? lane.sample ?? "/";
  const url = `http://127.0.0.1:${lane.port}${lane.sampleMethod === "GET" ? path : lane.sample ?? "/"}`;
  const body = { url, method: lane.sampleMethod, body: card.querySelector(".body")?.value ?? lane.sampleBody, maxUnits: card.querySelector(".maxunits").value || undefined, maxPerCall: card.querySelector(".maxhbar").value || undefined };
  try {
    const r = await fetch("/testbuyer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
    const rc = r.receipt;
    if (r.ok && rc) {
      out.innerHTML = `<span class="status ok"><span class="ico">✓</span>Paid ${fmt(rc.amount)} ${esc(rc.currency)}</span>
        <div class="receipt" style="margin-top:6px">
          <span>metered</span><span>${rc.measured} ${esc(rc.unit)}${rc.cap ? ` · cap ${rc.cap}` : ""} → ${rc.billable} billable</span>
          <span>price</span><span>${rc.billable} × ${esc(rc.rate)} / ${esc(rc.per)} = <b>${fmt(rc.amount)}</b>${rc.ceiling ? ` <span style="color:var(--muted)">(flat at cap: ${fmt(rc.ceiling)})</span>` : ""}</span>
          <span>body</span><span class="${rc.bodyVerified ? "ok" : "bad"}">${rc.bodyVerified ? "hash matches the quote" : "hash does NOT match the quote"}</span>
          <span>settlement</span><span>${r.hashscan ? `<a href="${esc(r.hashscan)}" target="_blank" rel="noopener">${esc(short(rc.txHash))}</a>` : `<span class="mono">${esc(short(rc.txHash))}</span>`} · buyer ${esc(r.buyer)} spent ${fmt(r.spent)}</span>
        </div><pre>${esc(r.body.slice(0, 1200))}</pre>`;
    } else if (r.refused) {
      out.innerHTML = `<span class="status warn"><span class="ico">!</span>Buyer refused to pay</span><div class="sub" style="margin-top:4px">${esc(r.error)}</div>`;
    } else if (r.ok) {
      out.innerHTML = `<span class="status ok"><span class="ico">✓</span>Served free (0 billable units)</span><pre>${esc(r.body.slice(0, 1200))}</pre>`;
    } else {
      out.innerHTML = `<span class="status bad"><span class="ico">×</span>${esc(r.status ? "HTTP " + r.status : "Failed")}</span><div class="sub" style="margin-top:4px">${esc(r.error ?? r.body?.slice(0, 300) ?? "")}</div>`;
    }
  } catch (e) {
    out.innerHTML = `<span class="status bad"><span class="ico">×</span>${esc(String(e))}</span>`;
  } finally { btn.disabled = false; }
}

$("owner").value = S.owner;
$("owner").oninput = () => { S.owner = $("owner").value; renderFilters(); renderLanes(); renderCharges(); renderPayments(); refreshAnalytics(); };
addEventListener("resize", () => { renderCharges(); renderHours(); });

connect();
refreshLanes().then(refreshAnalytics);
refreshRegistry();
setInterval(refreshRegistry, 4000);
setInterval(refreshLanes, 5000);
setInterval(refreshAnalytics, 5000);
renderCharges(); renderHours();
