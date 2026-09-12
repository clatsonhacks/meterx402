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

// ── onchain data from The Graph ─────────────────────────────────────────
const choiceRow = (id, opts, pressed = 0) =>
  `<div class="choices" id="${id}">${opts.map(([v, l], i) => `<button type="button" class="choice" data-v="${esc(v)}" aria-pressed="${i === pressed}">${esc(l)}</button>`).join("")}</div>`;
const pickedIn = (root, id, fallback = "") => root.querySelector(`#${id} .choice[aria-pressed="true"]`)?.dataset.v ?? fallback;
function wireChoices(root, ids, onChange) {
  for (const id of ids) root.querySelector(`#${id}`)?.querySelectorAll(".choice").forEach((b) => b.onclick = () => {
    root.querySelector(`#${id}`).querySelectorAll(".choice").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    onChange();
  });
}
const usdCompact = (n) => (n == null ? "–" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`);
const pct = (n) => (n == null ? "–" : `${Number(n).toFixed(2)}%`);
const CHAIN_CHOICES = [["", "All chains"], ["ethereum", "Ethereum"], ["arbitrum", "Arbitrum"], ["base", "Base"], ["optimism", "Optimism"], ["polygon", "Polygon"], ["bsc", "BSC"], ["avalanche", "Avalanche"]];

/** Which subgraphs answered, which fell back, which were down. A paid answer
 *  should show its own coverage rather than imply it saw every chain. */
function sourcesStrip(sources) {
  if (!Array.isArray(sources) || !sources.length) return "";
  const ok = sources.filter((s) => s.ok && s.via !== "fallback"), fb = sources.filter((s) => s.via === "fallback"), down = sources.filter((s) => !s.ok);
  const chip = (s, cls, title) => `<span class="src ${cls}" title="${esc(title)}">${esc(s.protocol)} · ${esc(s.chain)}</span>`;
  return `<details class="adv srcs"><summary>${ok.length + fb.length} of ${sources.length} subgraphs answered${fb.length ? `, ${fb.length} through Uniswap's own subgraph` : ""}${down.length ? `, ${down.length} unavailable` : ""}</summary>
    <div class="src-strip">${ok.map((s) => chip(s, "ok", `${s.rows} rows in ${s.ms} ms`)).join("")}${fb.map((s) => chip(s, "fb", `the standardized subgraph failed (${s.primary_error ?? ""}), so Uniswap's own answered`)).join("")}${down.map((s) => chip(s, "down", s.error ?? "unavailable")).join("")}</div>
    <div class="sub">Green answered, amber answered through a fallback, grey was unavailable and is missing from the table.</div></details>`;
}

/** Rows with one level of nested objects spread into columns (token0.symbol). */
function flatTable(rows) {
  const flat = rows.slice(0, 50).map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r ?? {})) {
      if (Array.isArray(v)) out[k] = `${v.length} item${v.length === 1 ? "" : "s"}`;
      else if (v && typeof v === "object") { for (const [k2, v2] of Object.entries(v)) if (typeof v2 !== "object") out[`${k}.${k2}`] = v2; }
      else out[k] = v;
    }
    return out;
  });
  const cols = [...new Set(flat.flatMap(Object.keys))].slice(0, 8);
  return `<div class="tablewrap"><table class="vtable"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
    ${flat.map((r) => `<tr>${cols.map((c) => `<td>${esc(String(r[c] ?? "")).slice(0, 48)}</td>`).join("")}</tr>`).join("")}
  </tbody></table></div>${rows.length > 50 ? `<div class="sub">showing 50 of ${rows.length}</div>` : ""}`;
}

RECIPES.push({
  id: "dex-pools",
  cta: "Find pools",
  working: "Asking every DEX subgraph at once…",
  match: (d) => d.capabilities.includes("dex_liquidity") && /\/pools/.test(d.sample?.path ?? ""),
  form: () => `
    <div class="big">Which pair?</div>
    ${choiceRow("r-pair", [["USDC,ETH", "USDC / ETH"], ["WBTC,ETH", "WBTC / ETH"], ["USDC,USDT", "USDC / USDT"], ["ETH", "Anything with ETH"]])}
    <div class="big">Where?</div>
    ${choiceRow("r-chain", CHAIN_CHOICES)}
    <div class="big">Best by</div>
    ${choiceRow("r-sort", [["tvl", "Deepest"], ["volume", "Busiest today"], ["fee_apr", "Highest fee APR"]])}
    <div class="big">How many pools?</div>
    ${choiceRow("r-n", [["5", "5"], ["10", "10"], ["20", "20"]], 1)}`,
  bind: (root, onChange) => wireChoices(root, ["r-pair", "r-chain", "r-sort", "r-n"], onChange),
  read: (root) => ({ tokens: pickedIn(root, "r-pair", "USDC,ETH"), chain: pickedIn(root, "r-chain"), sort: pickedIn(root, "r-sort", "tvl"), n: Number(pickedIn(root, "r-n", "10")) }),
  build: (d, f) => {
    // a fee APR on thin liquidity is noise, so that sort asks for deeper pools
    const p = new URLSearchParams({ tokens: f.tokens, sort: f.sort, first: String(f.n), min_tvl: f.sort === "fee_apr" ? "250000" : "50000" });
    if (f.chain) p.set("chains", f.chain);
    return { method: "GET", path: `/pools?${p}`, body: "" };
  },
  estimateUnits: (d, f) => f.n,
  render: (data) => {
    const o = asObject(data);
    if (!Array.isArray(o?.pools)) return autoRender(data);
    if (!o.pools.length) return `<div class="notice">No pools matched. Nothing is charged for pools you did not get.</div>${sourcesStrip(o.sources)}`;
    return `<div class="tablewrap"><table class="vtable"><thead><tr><th>Pool</th><th>Chain</th><th class="num">Fee</th><th class="num">TVL</th><th class="num">24h volume</th><th class="num">Fee APR</th></tr></thead><tbody>
      ${o.pools.map((p) => `<tr><td><b>${esc(p.tokens.join(" / "))}</b><div class="sub">${esc(p.protocol)}</div></td><td>${esc(p.chain)}</td>
        <td class="num">${pct(p.fee_percent)}</td><td class="num">${usdCompact(p.tvl_usd)}</td><td class="num">${usdCompact(p.volume_24h_usd)}</td><td class="num">${pct(p.fee_apr_percent)}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="sub">Fee APR is 24h volume × fee over TVL, a signal rather than a promised yield.</div>${sourcesStrip(o.sources)}`;
  },
});

RECIPES.push({
  id: "lending",
  cta: "Compare rates",
  working: "Asking every lending subgraph at once…",
  match: (d) => d.capabilities.includes("lending_rates") && /\/markets/.test(d.sample?.path ?? ""),
  form: () => `
    <div class="big">Which token?</div>
    ${choiceRow("r-token", [["USDC", "USDC"], ["USDT", "USDT"], ["WETH", "ETH"], ["WBTC", "BTC"], ["DAI", "DAI"]])}
    <div class="big">You want to</div>
    ${choiceRow("r-side", [["supply_apy", "Earn on a deposit"], ["borrow_apy", "Borrow cheaply"], ["tvl", "See the biggest markets"]])}
    <div class="big">Where?</div>
    ${choiceRow("r-chain", CHAIN_CHOICES)}
    <div class="big">How many markets?</div>
    ${choiceRow("r-n", [["5", "5"], ["10", "10"], ["20", "20"]], 1)}`,
  bind: (root, onChange) => wireChoices(root, ["r-token", "r-side", "r-chain", "r-n"], onChange),
  read: (root) => ({ token: pickedIn(root, "r-token", "USDC"), sort: pickedIn(root, "r-side", "supply_apy"), chain: pickedIn(root, "r-chain"), n: Number(pickedIn(root, "r-n", "10")) }),
  build: (d, f) => {
    const p = new URLSearchParams({ tokens: f.token, sort: f.sort, first: String(f.n), min_tvl: "1000000" });
    if (f.chain) p.set("chains", f.chain);
    return { method: "GET", path: `/markets?${p}`, body: "" };
  },
  estimateUnits: (d, f) => f.n,
  render: (data, { f }) => {
    const o = asObject(data);
    if (!Array.isArray(o?.markets)) return autoRender(data);
    if (!o.markets.length) return `<div class="notice">No active markets matched. Nothing is charged for markets you did not get.</div>${sourcesStrip(o.sources)}`;
    const lead = f?.sort === "borrow_apy" ? "borrow" : "supply";
    return `<div class="tablewrap"><table class="vtable"><thead><tr><th>Market</th><th>Chain</th>
        <th class="num${lead === "supply" ? " lead" : ""}">Supply APY</th><th class="num${lead === "borrow" ? " lead" : ""}">Borrow APY</th>
        <th class="num">Deposits</th><th class="num">Borrowed</th><th class="num">Max LTV</th></tr></thead><tbody>
      ${o.markets.map((m) => `<tr><td><b>${esc(m.token)}</b><div class="sub">${esc(m.protocol)}</div></td><td>${esc(m.chain)}</td>
        <td class="num">${pct(m.supply_apy_percent)}</td><td class="num">${m.can_borrow ? pct(m.borrow_apy_percent) : "off"}</td>
        <td class="num">${usdCompact(m.deposits_usd)}</td><td class="num">${m.utilization_percent == null ? "–" : `${Math.round(m.utilization_percent)}%`}</td>
        <td class="num">${m.max_ltv_percent ? `${m.max_ltv_percent}%` : "–"}</td></tr>`).join("")}
    </tbody></table></div>${sourcesStrip(o.sources)}`;
  },
});

const SUBGRAPH_PRESETS = [
  { label: "Uniswap v3 on Ethereum: top pools", id: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
    query: `{\n  pools(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc, where: { totalValueLockedUSD_lt: "5000000000" }) {\n    id feeTier totalValueLockedUSD\n    token0 { symbol }\n    token1 { symbol }\n  }\n}` },
  { label: "Uniswap v3 on Base: latest swaps", id: "43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG",
    query: `{\n  swaps(first: 5, orderBy: timestamp, orderDirection: desc) {\n    timestamp amountUSD\n    token0 { symbol }\n    token1 { symbol }\n  }\n}` },
  { label: "Aave v3 on Arbitrum: markets", id: "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf",
    query: `{\n  markets(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) {\n    name totalValueLockedUSD\n    inputToken { symbol }\n  }\n}` },
];

RECIPES.push({
  id: "subgraph",
  cta: "Run the query",
  working: "Querying The Graph…",
  match: (d) => d.capabilities.includes("subgraph_query"),
  form: () => `
    <div class="big">Start from</div>
    <div class="choices" id="r-preset">${SUBGRAPH_PRESETS.map((p, i) => `<button type="button" class="choice" data-i="${i}" aria-pressed="${i === 0}">${esc(p.label)}</button>`).join("")}</div>
    <label class="big" for="r-sgid">Subgraph id <span class="hint">any of The Graph's 15,000+ subgraphs</span></label>
    <input type="text" id="r-sgid" class="mono" value="${esc(SUBGRAPH_PRESETS[0].id)}" spellcheck="false">
    <label class="big" for="r-gql">GraphQL <span class="hint">you pay per object in the answer; errors and empty answers are free</span></label>
    <textarea id="r-gql" class="mono gql" rows="8" spellcheck="false">${esc(SUBGRAPH_PRESETS[0].query)}</textarea>`,
  bind: (root, onChange) => {
    root.querySelectorAll("#r-preset .choice").forEach((b) => b.onclick = () => {
      root.querySelectorAll("#r-preset .choice").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
      const p = SUBGRAPH_PRESETS[Number(b.dataset.i)];
      root.querySelector("#r-sgid").value = p.id;
      root.querySelector("#r-gql").value = p.query;
      onChange();
    });
    ["r-sgid", "r-gql"].forEach((id) => root.querySelector(`#${id}`)?.addEventListener("input", onChange));
  },
  read: (root) => ({ id: root.querySelector("#r-sgid")?.value.trim() || SUBGRAPH_PRESETS[0].id, query: root.querySelector("#r-gql")?.value || SUBGRAPH_PRESETS[0].query }),
  build: (d, f) => ({ method: "POST", path: `/${/^Qm/.test(f.id) ? "deployments" : "subgraphs"}/${f.id}`, body: JSON.stringify({ query: f.query }) }),
  // nested objects make the entity count unknowable up front; the quote is exact
  estimateUnits: () => null,
  render: (data) => {
    const o = asObject(data);
    if (o?.errors?.length && !o.data) return `<div class="notice bad"><b>The subgraph returned an error</b><div>${esc(o.errors[0]?.message ?? "")}</div><div class="sub">Zero entities came back, so nothing was charged.</div></div>`;
    if (!o?.data) return autoRender(data);
    const rows = largestArray(o.data);
    return `<div class="ds-meta">${Number(o.entities ?? 0).toLocaleString()} entities</div>
      ${Array.isArray(rows) && rows.length && typeof rows[0] === "object" ? flatTable(rows) : autoRender(o.data)}
      <details class="adv"><summary>Raw JSON</summary><pre class="code respbox">${esc(JSON.stringify(o.data, null, 2).slice(0, 6000))}</pre></details>`;
  },
});

/** A dataset: browse the columns, filter, and watch the price follow the rows.
 *  The schema is free, so the form can be built from the real columns before
 *  the buyer has paid for anything. */
RECIPES.push({
  id: "dataset",
  cta: "Get the rows",
  working: "Querying the dataset…",
  match: (d) => !!d.dataset?.columns?.length,
  form: (d) => {
    const cols = d.dataset.columns;
    const filterable = cols.slice(0, 24);
    return `<div class="ds-meta">${Number(d.dataset.rows).toLocaleString()} rows · ${cols.length} columns · ${esc(d.dataset.format.toUpperCase())}</div>
      <div class="big">Columns <span class="hint">all of them unless you pick</span></div>
      <div class="ds-cols">${cols.map((c) => `<button type="button" class="dscol" data-col="${esc(c.name)}" aria-pressed="false" title="${esc(c.type)}">${esc(c.name)}<small>${esc(c.type)}</small></button>`).join("")}</div>
      <div class="big">Filter</div>
      <div class="ds-filter">
        <select id="r-col"><option value="">no filter</option>${filterable.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("")}</select>
        <select id="r-op">${[["eq", "is"], ["ne", "is not"], ["contains", "contains"], ["starts", "starts with"], ["gt", "&gt;"], ["gte", "≥"], ["lt", "&lt;"], ["lte", "≤"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        <input type="text" id="r-val" placeholder="value">
      </div>
      <div class="big">How many rows?</div>
      <div class="choices" id="r-n">${[10, 50, 100, 500].map((v, i) => `<button type="button" class="choice" data-n="${v}" aria-pressed="${i === 1}">${v}</button>`).join("")}</div>`;
  },
  bind: (root, onChange) => {
    root.querySelectorAll(".dscol").forEach((b) => b.onclick = () => {
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
      onChange();
    });
    root.querySelector("#r-n").querySelectorAll(".choice").forEach((b) => b.onclick = () => {
      root.querySelector("#r-n").querySelectorAll(".choice").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
      onChange();
    });
    ["r-col", "r-op", "r-val"].forEach((id) => root.querySelector(`#${id}`)?.addEventListener("input", onChange));
  },
  read: (root) => ({
    select: [...root.querySelectorAll('.dscol[aria-pressed="true"]')].map((b) => b.dataset.col),
    col: root.querySelector("#r-col")?.value ?? "",
    op: root.querySelector("#r-op")?.value ?? "eq",
    val: root.querySelector("#r-val")?.value ?? "",
    n: Number(root.querySelector('#r-n .choice[aria-pressed="true"]')?.dataset.n ?? 50),
  }),
  build: (d, f) => {
    const p = new URLSearchParams();
    p.set("limit", String(f.n));
    if (f.select.length) p.set("select", f.select.join(","));
    if (f.col && f.val) p.set("where", `${f.col}:${f.op}:${f.val}`);
    return { method: "GET", path: `/?${p.toString()}`, body: "" };
  },
  // Priced by cells, so the columns you pick change the price as much as the
  // row count does. The estimate is a ceiling; the quote is the truth.
  estimateUnits: (d, f) => {
    const cols = f.select.length || d.dataset.columns.length;
    const units = /cells/.test(d.pricing.meter) ? f.n * cols : f.n;
    return Math.min(units, d.pricing.max_units ?? units);
  },
  /** The free row count, so "what would this cost?" is answered before paying.
   *  Through the hub, like every other call this page makes. */
  count: async (d, f) => {
    const p = new URLSearchParams({ service_id: d.service_id });
    if (f.col && f.val) p.set("where", `${f.col}:${f.op}:${f.val}`);
    if (f.select.length) p.set("select", f.select.join(","));
    const r = await fetch(`/playground/count?${p.toString()}`).then((x) => x.json());
    return r.ok === false ? {} : { matched: r.matched, of: r.of };
  },
  render: (data, { d }) => {
    const o = asObject(data);
    const rows = Array.isArray(o?.rows) ? o.rows : largestArray(o);
    if (!Array.isArray(rows) || !rows.length) return `<div class="notice">No rows matched that filter. Nothing was charged for rows you did not get.</div>`;
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))].slice(0, 10);
    const num = new Set(d.dataset?.columns?.filter((c) => c.type === "number").map((c) => c.name) ?? []);
    return `${o?.total != null ? `<div class="ds-meta">${rows.length} of ${Number(o.total).toLocaleString()} matching rows</div>` : ""}
      <div class="tablewrap"><table class="vtable ds-table"><thead><tr>${cols.map((c) => `<th class="${num.has(c) ? "num" : ""}">${esc(c)}</th>`).join("")}</tr></thead><tbody>
        ${rows.slice(0, 200).map((r) => `<tr>${cols.map((c) => `<td class="${num.has(c) ? "num" : ""}">${esc(String(r?.[c] ?? ""))}</td>`).join("")}</tr>`).join("")}
      </tbody></table></div>`;
  },
});

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
