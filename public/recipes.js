// Task-shaped "Try it": a few friendly inputs instead of a method and a path.
//
// Each recipe matches a capability (and checks the service's advertised sample
// really has the parameters it wants to change), turns the inputs into that
// service's real request, estimates the cost from the price card, and renders
// the answer as something readable. Anything without a recipe falls back to the
// generic request editor and an auto table, so any JSON API still works.

const CITIES = [
  ["Chennai", 13.0827, 80.2707], ["London", 51.5072, -0.1276], ["New York", 40.7128, -74.006],
  ["Tokyo", 35.6762, 139.6503], ["Berlin", 52.52, 13.405], ["São Paulo", -23.5505, -46.6333],
];
const EXAMPLE_PROMPTS = [
  "Explain what Hedera is, in two sentences",
  "Write a haiku about paying per use",
  "Three dinner ideas using rice and eggs",
];
const DEMO_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth, a busy account

// ── working with the service's advertised sample request ────────────────
const sampleUrl = (d) => new URL(d.sample?.path ?? "/", "http://s");
const sampleHas = (d, ...keys) => { const u = sampleUrl(d); return keys.every((k) => u.searchParams.has(k)); };
const sampleParam = (d, k, fallback = "") => sampleUrl(d).searchParams.get(k) ?? fallback;
/** The sample path with some query parameters replaced. */
function pathWith(d, set) {
  const u = sampleUrl(d);
  for (const [k, v] of Object.entries(set)) u.searchParams.set(k, String(v));
  const q = u.searchParams.toString();
  return `${u.pathname}${q ? `?${q}` : ""}`;
}
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

// ── result rendering helpers ────────────────────────────────────────────
const asObject = (data) => { if (typeof data !== "string") return data; try { return JSON.parse(data); } catch { return null; } };
const nl2br = (s) => esc(s).replace(/\n/g, "<br>");
/** Minimal markdown: **bold**, `code`, and paragraphs. Models answer in it. */
function prose(text) {
  return esc(String(text))
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");
}
function chatText(data) {
  const o = asObject(data);
  if (typeof o === "string") return o;
  return o?.choices?.[0]?.message?.content ?? o?.choices?.[0]?.text ?? o?.content?.[0]?.text
    ?? o?.message?.content ?? o?.output_text ?? o?.response ?? o?.text ?? null;
}
/** The biggest array of objects anywhere in the response: what was counted. */
function largestArray(v, depth = 0) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object" || depth > 4) return null;
  let best = null;
  for (const x of Object.values(v)) {
    const found = largestArray(x, depth + 1);
    if (found && (!best || found.length > best.length)) best = found;
  }
  return best;
}
function autoRender(data) {
  const o = asObject(data);
  if (o == null) return `<pre class="code respbox">${esc(String(data).slice(0, 4000))}</pre>`;
  if (typeof o === "string") return `<div class="answer"><p>${nl2br(o.slice(0, 4000))}</p></div>`;
  const rows = largestArray(o);
  if (Array.isArray(rows) && rows.length && typeof rows[0] === "object") {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))].filter((k) => rows.some((r) => r && typeof r[k] !== "object")).slice(0, 6);
    return `<div class="tablewrap"><table class="vtable"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
      ${rows.slice(0, 25).map((r) => `<tr>${cols.map((c) => `<td>${esc(String(r?.[c] ?? "")).slice(0, 60)}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>${rows.length > 25 ? `<div class="sub">showing 25 of ${rows.length}</div>` : ""}`;
  }
  if (Array.isArray(rows)) return `<div class="answer"><p>${esc(rows.slice(0, 50).join(", "))}</p></div>`;
  const pairs = Object.entries(o).filter(([, v]) => typeof v !== "object").slice(0, 12);
  if (pairs.length) return `<div class="kv">${pairs.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(String(v))}</span>`).join("")}</div>`;
  return `<pre class="code respbox">${esc(JSON.stringify(o, null, 2).slice(0, 4000))}</pre>`;
}

/** A small line chart for a series of numbers. */
function sparkline(values, labels, unit) {
  const W = 640, H = 150, P = 26;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const x = (i) => P + (W - P * 2) * (values.length === 1 ? 0.5 : i / (values.length - 1));
  const y = (v) => 12 + (H - 34) * (1 - (v - min) / span);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ticks = [0, Math.floor(values.length / 3), Math.floor((values.length * 2) / 3), values.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Forecast chart" preserveAspectRatio="none">
    <polyline class="sp-line" points="${pts}" />
    <polygon class="sp-fill" points="${x(0).toFixed(1)},${H - 20} ${pts} ${x(values.length - 1).toFixed(1)},${H - 20}" />
    ${ticks.map((i) => `<text class="sp-x" x="${x(i).toFixed(1)}" y="${H - 4}" text-anchor="middle">${esc(labels[i] ?? "")}</text>`).join("")}
    <text class="sp-y" x="2" y="16">${max.toFixed(1)}${esc(unit)}</text>
    <text class="sp-y" x="2" y="${H - 24}">${min.toFixed(1)}${esc(unit)}</text>
  </svg>`;
}

// ── the recipes ─────────────────────────────────────────────────────────
const RECIPES = [
  {
    id: "chat",
    cta: "Ask",
    working: "Thinking…",
    match: (d) => d.capabilities.includes("text_generation") && d.sample?.method === "POST" && /messages/.test(d.sample?.body ?? ""),
    form: (d) => `
      <label class="big" for="r-prompt">What do you want to ask?</label>
      <textarea id="r-prompt" class="prompt" rows="3" placeholder="Ask anything…"></textarea>
      <div class="examples">${EXAMPLE_PROMPTS.map((e) => `<button type="button" class="ex" data-ex="${esc(e)}">${esc(e)}</button>`).join("")}</div>
      ${d.payment.streaming ? `<label class="check stream-opt"><input type="checkbox" id="r-stream"> Watch the answer as it's written <span class="hint">uses a prepaid tab</span></label>` : ""}`,
    bind: (root, onChange) => {
      root.querySelectorAll("[data-ex]").forEach((b) => b.onclick = () => { root.querySelector("#r-prompt").value = b.dataset.ex; onChange(); });
      root.querySelector("#r-prompt").addEventListener("input", onChange);
      root.querySelector("#r-stream")?.addEventListener("change", onChange);
    },
    read: (root) => ({ prompt: root.querySelector("#r-prompt")?.value.trim() || EXAMPLE_PROMPTS[0], stream: !!root.querySelector("#r-stream")?.checked }),
    build: (d, f) => {
      let body = {};
      try { body = JSON.parse(d.sample.body); } catch {}
      body.messages = [{ role: "user", content: f.prompt }];
      return { method: "POST", path: d.sample.path, body: JSON.stringify(body), stream: f.stream, prompt: f.prompt };
    },
    estimateUnits: () => null, // a model's length isn't knowable up front: use the typical call
    render: (data) => {
      const t = chatText(data);
      return t ? `<div class="answer chat"><p>${prose(t)}</p></div>` : autoRender(data);
    },
  },

  {
    id: "weather",
    cta: "Get the forecast",
    working: "Fetching the forecast…",
    match: (d) => d.capabilities.includes("weather_forecast") && sampleHas(d, "latitude", "longitude"),
    form: () => `
      <div class="big">Where?</div>
      <div class="choices" id="r-city">${CITIES.map(([n, la, lo], i) => `<button type="button" class="choice" data-la="${la}" data-lo="${lo}" aria-pressed="${i === 0}">${esc(n)}</button>`).join("")}</div>
      <div class="big">How far ahead?</div>
      <div class="choices" id="r-days">${[[1, "Today"], [2, "2 days"], [3, "3 days"], [7, "A week"]].map(([v, l], i) => `<button type="button" class="choice" data-days="${v}" aria-pressed="${i === 1}">${esc(l)}</button>`).join("")}</div>`,
    bind: (root, onChange) => {
      for (const group of ["r-city", "r-days"]) {
        root.querySelector(`#${group}`).querySelectorAll(".choice").forEach((b) => b.onclick = () => {
          root.querySelector(`#${group}`).querySelectorAll(".choice").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
          onChange();
        });
      }
    },
    read: (root) => {
      const city = root.querySelector('#r-city .choice[aria-pressed="true"]') ?? root.querySelector("#r-city .choice");
      const days = root.querySelector('#r-days .choice[aria-pressed="true"]') ?? root.querySelector("#r-days .choice");
      return { lat: city.dataset.la, lon: city.dataset.lo, city: city.textContent, days: Number(days.dataset.days) };
    },
    build: (d, f) => ({ method: "GET", path: pathWith(d, { latitude: f.lat, longitude: f.lon, forecast_days: f.days }), body: "" }),
    estimateUnits: (d, f) => f.days * 24,
    render: (data, { f }) => {
      const o = asObject(data);
      const time = o?.hourly?.time, series = o?.hourly ? Object.entries(o.hourly).find(([k, v]) => k !== "time" && Array.isArray(v)) : null;
      if (!Array.isArray(time) || !series) return autoRender(data);
      const [key, vals] = series;
      const unit = o.hourly_units?.[key] ?? "";
      const nums = vals.map(Number).filter(Number.isFinite);
      const labels = time.map((t) => String(t).slice(5, 16).replace("T", " "));
      const now = nums[0], hi = Math.max(...nums), lo = Math.min(...nums);
      return `<div class="wx">
        <div class="wx-now"><b>${now}${esc(unit)}</b><span>${esc(f?.city ?? "")} · now</span></div>
        <div class="wx-hilo"><span>High <b>${hi}${esc(unit)}</b></span><span>Low <b>${lo}${esc(unit)}</b></span><span>${nums.length} hours</span></div>
      </div>${sparkline(nums, labels, unit)}<div class="sub">${esc(key.replace(/_/g, " "))} · hourly</div>`;
    },
  },

  {
    id: "txs",
    cta: "Look it up",
    working: "Reading the blockchain…",
    match: (d) => d.capabilities.includes("blockchain_data") && sampleHas(d, "address"),
    form: (d) => `
      <label class="big" for="r-addr">Which Ethereum address?</label>
      <input type="text" id="r-addr" class="mono" value="${esc(sampleParam(d, "address", DEMO_ADDRESS))}" spellcheck="false">
      <div class="examples"><button type="button" class="ex" data-addr="${DEMO_ADDRESS}">Use a busy example account</button></div>
      ${sampleHas(d, "offset") ? `<div class="big">How many transactions?</div>
      <div class="choices" id="r-n">${[5, 10, 25].map((v, i) => `<button type="button" class="choice" data-n="${v}" aria-pressed="${i === 1}">${v}</button>`).join("")}</div>` : ""}`,
    bind: (root, onChange) => {
      root.querySelector("#r-addr").addEventListener("input", onChange);
      root.querySelectorAll("[data-addr]").forEach((b) => b.onclick = () => { root.querySelector("#r-addr").value = b.dataset.addr; onChange(); });
      root.querySelector("#r-n")?.querySelectorAll(".choice").forEach((b) => b.onclick = () => {
        root.querySelector("#r-n").querySelectorAll(".choice").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
        onChange();
      });
    },
    read: (root) => ({
      address: root.querySelector("#r-addr")?.value.trim() || DEMO_ADDRESS,
      n: Number(root.querySelector('#r-n .choice[aria-pressed="true"]')?.dataset.n ?? 10),
    }),
    build: (d, f) => ({ method: "GET", path: pathWith(d, sampleHas(d, "offset") ? { address: f.address, offset: f.n, page: 1 } : { address: f.address }), body: "" }),
    estimateUnits: (d, f) => f.n,
    render: (data, { f }) => {
      const o = asObject(data);
      const rows = Array.isArray(o?.result) ? o.result : largestArray(o);
      if (!Array.isArray(rows) || !rows.length || !rows[0]?.hash) return autoRender(data);
      const me = String(f?.address ?? "").toLowerCase();
      return `<ul class="txs">${rows.slice(0, 25).map((t) => {
        const out = String(t.from).toLowerCase() === me;
        const eth = Number(t.value ?? 0) / 1e18;
        return `<li class="${t.isError === "1" ? "failed" : ""}">
          <span class="dir ${out ? "out" : "in"}">${out ? "↑ Sent" : "↓ Received"}</span>
          <span class="amt">${eth ? `${eth.toFixed(eth < 0.001 ? 6 : 4)} ETH` : "—"}</span>
          <span class="who mono">${esc(short(out ? t.to : t.from))}</span>
          <span class="when">${t.timeStamp ? ago(Number(t.timeStamp) * 1000) : ""}</span>
          <a class="ext" href="https://etherscan.io/tx/${esc(t.hash)}" target="_blank" rel="noopener" title="View on Etherscan">↗</a>
        </li>`;
      }).join("")}</ul>`;
    },
  },

  {
    id: "markets",
    cta: "Get prices",
    working: "Fetching prices…",
    match: (d) => d.capabilities.includes("market_data") && sampleHas(d, "per_page"),
    form: (d) => `
      <div class="big">How many coins?</div>
      <div class="choices" id="r-n">${[5, 10, 20].map((v, i) => `<button type="button" class="choice" data-n="${v}" aria-pressed="${i === 1}">Top ${v}</button>`).join("")}</div>
      ${sampleHas(d, "vs_currency") ? `<div class="big">Priced in</div>
      <div class="choices" id="r-cur">${["usd", "eur", "inr"].map((v, i) => `<button type="button" class="choice" data-cur="${v}" aria-pressed="${i === 0}">${v.toUpperCase()}</button>`).join("")}</div>` : ""}`,
    bind: (root, onChange) => {
      for (const g of ["r-n", "r-cur"]) root.querySelector(`#${g}`)?.querySelectorAll(".choice").forEach((b) => b.onclick = () => {
        root.querySelector(`#${g}`).querySelectorAll(".choice").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
        onChange();
      });
    },
    read: (root) => ({
      n: Number(root.querySelector('#r-n .choice[aria-pressed="true"]')?.dataset.n ?? 10),
      cur: root.querySelector('#r-cur .choice[aria-pressed="true"]')?.dataset.cur ?? "usd",
    }),
    build: (d, f) => ({ method: "GET", path: pathWith(d, sampleHas(d, "vs_currency") ? { per_page: f.n, vs_currency: f.cur } : { per_page: f.n }), body: "" }),
    estimateUnits: (d, f) => f.n,
    render: (data, { f }) => {
      const rows = largestArray(asObject(data));
      if (!Array.isArray(rows) || !rows.length || rows[0]?.current_price == null) return autoRender(data);
      const sym = { usd: "$", eur: "€", inr: "₹" }[f?.cur ?? "usd"] ?? "";
      return `<ul class="coins">${rows.slice(0, 25).map((c) => {
        const ch = Number(c.price_change_percentage_24h ?? 0);
        return `<li>
          ${c.image ? `<img src="${esc(c.image)}" alt="" width="22" height="22" loading="lazy">` : `<span class="coin-dot"></span>`}
          <span class="cn"><b>${esc(c.name ?? c.id ?? "")}</b><small>${esc(String(c.symbol ?? "").toUpperCase())}</small></span>
          <span class="cp">${sym}${Number(c.current_price).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
          <span class="cc ${ch >= 0 ? "up" : "down"}">${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch).toFixed(2)}%</span>
        </li>`;
      }).join("")}</ul>`;
    },
  },
];

/** Everything else: the service's own sample, editable, rendered generically. */
const GENERIC = {
  id: "generic",
  cta: "Run it",
  working: "Running your request…",
  match: () => true,
  form: (d) => {
    const s = d.sample ?? { method: "GET", path: "/" };
    return `<div class="big">Your request</div>
      <div class="trio"><label>Method<select id="r-method"><option ${s.method === "GET" ? "selected" : ""}>GET</option><option ${s.method === "POST" ? "selected" : ""}>POST</option></select></label>
        <label>Path and query<input type="text" id="r-path" value="${esc(s.path)}"></label></div>
      <label>Body<textarea id="r-body" rows="3">${esc(s.body ?? "")}</textarea></label>`;
  },
  bind: (root, onChange) => ["r-method", "r-path", "r-body"].forEach((id) => root.querySelector(`#${id}`)?.addEventListener("input", onChange)),
  read: (root) => ({
    method: root.querySelector("#r-method")?.value ?? "GET",
    path: root.querySelector("#r-path")?.value || "/",
    body: root.querySelector("#r-body")?.value ?? "",
  }),
  build: (d, f) => ({ method: f.method, path: f.path, body: f.method === "GET" ? "" : f.body }),
  estimateUnits: () => null,
  render: (data) => autoRender(data),
};

const recipeFor = (d) => RECIPES.find((r) => { try { return r.match(d); } catch { return false; } }) ?? GENERIC;
