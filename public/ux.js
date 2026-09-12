// The consumer layer shared by the User views: plain-language names and units,
// dollars next to HBAR, trust labels, categories, the wallet with its spending
// limits, and toasts. Loaded after deployer.js, whose helpers ($, esc, fmt,
// short, time) it reuses.

// ── theme: system / light / dark ────────────────────────────────────────
// Three states, not two. "System" is the default and the honest one: most
// people have already told their OS what they want. An explicit choice wins
// over the system preference, survives a reload, and is applied before first
// paint by a snippet in <head> so there is no white flash on the way in.
const THEME_KEY = "mx402.theme";
const themePref = () => { try { const t = localStorage.getItem(THEME_KEY); return t === "light" || t === "dark" ? t : "system"; } catch { return "system"; } };
const activeTheme = () => {
  const p = themePref();
  return p === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p;
};
function applyTheme(pref) {
  if (pref === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", pref);
  try { pref === "system" ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, pref); } catch {}
  // keep the browser chrome (mobile address bar) in step with the page
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", activeTheme() === "dark" ? "#1a1a20" : "#f9f9f7");
  for (const b of document.querySelectorAll("[data-theme-set]")) {
    b.setAttribute("aria-checked", String(b.dataset.themeSet === pref));
  }
  if (typeof renderCharges === "function" && !$("view-deployer").hidden) { renderCharges(); renderHours(); }
}
for (const b of document.querySelectorAll("[data-theme-set]")) b.onclick = () => applyTheme(b.dataset.themeSet);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (themePref() === "system") applyTheme("system"); });
applyTheme(themePref());

// ── names, categories, units ────────────────────────────────────────────
const CATS = {
  text_generation: { label: "AI Chat", icon: "💬", hue: 265 },
  weather_forecast: { label: "Weather", icon: "🌦️", hue: 200 },
  market_data: { label: "Markets", icon: "📈", hue: 145 },
  blockchain_data: { label: "Blockchain", icon: "⛓️", hue: 35 },
  onchain_analytics: { label: "DeFi", icon: "🔄", hue: 320 },
  dao_governance: { label: "Governance", icon: "🗳️", hue: 10 },
  file_download: { label: "Files", icon: "📦", hue: 28 },
};
const ACRONYMS = { llm: "LLM", ai: "AI", api: "API", eth: "ETH", dao: "DAO", nft: "NFT", usd: "USD" };
const prettyName = (s) => String(s ?? "").split(/[\s_-]+/).filter(Boolean).map((w) => ACRONYMS[w.toLowerCase()] ?? w[0].toUpperCase() + w.slice(1)).join(" ");
const titleOf = (d) => d.title || prettyName(d.name);
const catOf = (d) => CATS[d.capabilities.find((c) => CATS[c])] ?? { label: prettyName(d.capabilities[0] ?? "Data"), icon: "🧩", hue: 220 };
const catKey = (d) => d.capabilities.find((c) => CATS[c]) ?? d.capabilities[0] ?? "data";
const avatar = (d, cls = "") => { const c = catOf(d); return `<div class="avatar cat ${cls}" style="--h:${c.hue}" aria-hidden="true">${c.icon}</div>`; };

/** One unit in plain words: the descriptor's unit_label, else the meter unit. */
const unitBase = (p) => p.unit_label || String(p.unit).replace(/s$/, "");
function plural(word, n) {
  if (n === 1 || /^[A-Z]{2,}$/.test(word)) return word;
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|ch|sh)$/.test(word)) return word + "es";
  return word + "s";
}
const units = (p, n) => `${Number(n).toLocaleString()} ${plural(unitBase(p), Number(n))}`;
/** "per forecast hour", "per 1,000 tokens (~750 words)" */
function perPhrase(p) {
  const base = unitBase(p);
  const s = p.per === 1 ? `per ${base}` : `per ${Number(p.per).toLocaleString()} ${plural(base, p.per)}`;
  return /^tokens?$/.test(p.unit) && p.per >= 100 ? `${s} (~${Math.round(p.per * 0.75).toLocaleString()} words)` : s;
}
/** Exact price of n units: tinybar, always rounded up, never below the minimum. */
const priceFor = (p, n) => Math.max(Number(p.min) || 0, Math.ceil((Number(n) * Number(p.rate) * 1e8) / p.per) / 1e8);

// ── money ───────────────────────────────────────────────────────────────
let FX = null; // USD per HBAR; null = unknown, and then we show HBAR only
async function loadFx() { try { FX = (await fetch("/fx").then((r) => r.json())).usd ?? null; } catch {} }
function usdText(v) {
  if (v == null || !Number.isFinite(v)) return "";
  if (v === 0) return "$0";
  if (v >= 1) return "$" + v.toFixed(2);
  if (v >= 0.01) return "$" + v.toFixed(3).replace(/0$/, "");
  const decimals = Math.min(10, -Math.floor(Math.log10(v)) + 1);
  return "$" + Number(v.toPrecision(2)).toFixed(decimals).replace(/0+$/, "");
}
const usdOf = (h) => (FX == null || h == null ? null : Number(h) * FX);
const hbar = (h) => `${fmt(h)} HBAR`;
/** "0.0024 HBAR (≈ $0.0005)", or just HBAR when the rate is unknown */
const money = (h) => (usdOf(h) == null ? hbar(h) : `${hbar(h)} <span class="usd">≈ ${usdText(usdOf(h))}</span>`);
/** "under 1¢" style phrase for a typical cost */
const centsPhrase = (h) => { const u = usdOf(h); return u == null ? "" : u < 0.01 ? "under 1¢" : `about ${usdText(u)}`; };

// ── trust ───────────────────────────────────────────────────────────────
function trustOf(r) {
  if (r.score == null) return { key: "new", label: "New", title: `New: fewer than ${r.min_samples ?? 5} paid uses so far, too few to rate` };
  const s = Math.round(r.score);
  const [key, label] = s >= 90 ? ["excellent", "Excellent"] : s >= 75 ? ["good", "Good"] : s >= 50 ? ["fair", "Fair"] : ["poor", "Poor"];
  return { key, label, score: s, title: `${s}/100 from ${r.stats.paid_calls} paid uses` };
}
const trustBadge = (r) => { const t = trustOf(r); return `<span class="trust ${t.key}" title="${esc(t.title)}">${t.key === "new" ? "✦" : "★"} ${t.label}${t.score != null ? ` <small>${t.score}</small>` : ""}</span>`; };

// ── time ────────────────────────────────────────────────────────────────
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}
const hashscanTx = (tx) => `https://hashscan.io/testnet/transaction/${String(tx).replace("@", "-").replace(/\.(\d+)$/, "-$1")}`;

// ── toasts ──────────────────────────────────────────────────────────────
function toast(html, kind = "ok", ms = 4200) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = html;
  $("toasts").appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, ms);
}

// ── wallet and spending limits ──────────────────────────────────────────
// The User views pay from the hub's demo buyer (testnet HBAR). Limits live in
// this browser; the per-request limit is sent with every payment as maxPrice,
// so a quote above it is refused before anything is signed.
let W = { ok: false, account: null, balance: null, mode: null };
let MY = []; // this wallet's receipts, newest first
const LIM_DEFAULT = { perRequest: "0.01", session: "0.5", autopay: false };
let LIM = (() => { try { return { ...LIM_DEFAULT, ...JSON.parse(localStorage.getItem("mx402.limits") ?? "{}") }; } catch { return { ...LIM_DEFAULT }; } })();
const saveLim = () => { try { localStorage.setItem("mx402.limits", JSON.stringify(LIM)); } catch {} };
const SESSION_START = (() => {
  try { let s = sessionStorage.getItem("mx402.session"); if (!s) { s = String(Date.now()); sessionStorage.setItem("mx402.session", s); } return Number(s); } catch { return Date.now(); }
})();
const sessionSpent = () => MY.filter((r) => r.settled_at >= SESSION_START).reduce((a, r) => a + Number(r.amount), 0);
const totalSpent = () => MY.reduce((a, r) => a + Number(r.amount), 0);

async function loadMe() {
  try { W = await fetch("/me").then((r) => r.json()); } catch { W = { ok: false }; }
  renderWalletBtn();
  if (W.ok) await loadMine();
}
async function loadMine() {
  if (!W.account) return;
  try {
    const { receipts } = await fetch(`/registry/receipts?buyer=${encodeURIComponent(W.account)}&limit=500`).then((r) => r.json());
    MY = receipts;
  } catch {}
  renderWalletBtn();
  if (!$("wallet-pop").hidden) renderWalletPop();
  if (typeof renderActivity === "function" && !$("user-activity").hidden) renderActivity();
}

/** A balance a person can read: four decimals is plenty for HBAR, and
 *  0.0254543 in a pill is noise, not information. */
function balanceText(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2).replace(/\.?0+$/, "");
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") || "0";
}
/** Below this, the wallet says so before a payment fails for it. */
const LOW_BALANCE = 0.25;
const isLow = () => W.ok && W.balance != null && W.balance < LOW_BALANCE;

function renderWalletBtn() {
  const el = $("wallet-amt");
  if (!W.ok) { el.textContent = "No wallet"; return; }
  el.textContent = W.balance != null ? `${balanceText(W.balance)} HBAR` : W.mode === "offline" ? "Demo wallet" : "Wallet";
  $("wallet-btn").classList.toggle("low", isLow());
  $("wallet-btn").title = isLow() ? `Only ${balanceText(W.balance)} HBAR left in the demo wallet` : "Wallet and spending limits";
  $("net-chip").textContent = W.mode === "offline" ? "Offline demo" : "Testnet";
}

function renderWalletPop() {
  const pop = $("wallet-pop");
  if (!W.ok) {
    pop.innerHTML = `<div class="wp-head"><b>No wallet yet</b></div><p class="label">Add a funded testnet account to <span class="mono">.env</span> as <span class="mono">BUYER_ACCOUNT_ID</span> and <span class="mono">BUYER_PRIVATE_KEY</span>, or run <span class="mono">npm run demo:offline</span>.</p>`;
    return;
  }
  const s = sessionSpent();
  pop.innerHTML = `
    <div class="wp-head"><div><b>Demo wallet</b><div class="label">${W.mode === "offline" ? "Offline demo, simulated money" : "Hedera testnet: test HBAR, no real money"}</div></div></div>
    <div class="wp-bal">${W.balance != null ? `${balanceText(W.balance)} <small>HBAR</small>` : `<small>balance unavailable offline</small>`}</div>
    ${W.balance != null && usdOf(W.balance) != null ? `<div class="label">≈ ${usdText(usdOf(W.balance))}</div>` : ""}
    <div class="wp-acct mono">${esc(W.account)}${W.hashscan ? ` · <a href="${esc(W.hashscan)}" target="_blank" rel="noopener">HashScan ↗</a>` : ""}</div>
    <div class="wp-spent"><span>Spent this session</span><b>${hbar(s)}</b></div>
    <div class="wp-meter"><i style="width:${Math.min(100, (s / Math.max(Number(LIM.session) || 1e-9, 1e-9)) * 100)}%"></i></div>
    <div class="label" style="margin-top:2px">of your ${hbar(LIM.session)} session limit</div>
    <div class="wp-sec">Spending limits</div>
    <div class="form">
      <label>Most I'll pay for one request (HBAR)<input type="number" id="lim-req" min="0" step="0.001" value="${esc(LIM.perRequest)}"></label>
      <label>Most I'll spend this session (HBAR)<input type="number" id="lim-ses" min="0" step="0.01" value="${esc(LIM.session)}"></label>
      <label class="check"><input type="checkbox" id="lim-auto" ${LIM.autopay ? "checked" : ""}> Pay automatically when a request is under my limit</label>
    </div>
    <div class="label" style="margin-top:8px">Anything above your limit asks you first, and nothing is ever signed above it without your OK.</div>
    ${isLow() ? `<div class="notice warn wp-low"><b>Running low</b><div>${balanceText(W.balance)} HBAR left. Top the demo wallet up with <span class="mono">npx tsx scripts/fund-buyer.ts</span>, or from the Hedera portal faucet.</div></div>` : ""}
    <button class="ghost" id="wp-activity" style="margin-top:10px;width:100%">See my activity</button>`;
  const save = () => {
    LIM = { perRequest: $("lim-req").value || LIM_DEFAULT.perRequest, session: $("lim-ses").value || LIM_DEFAULT.session, autopay: $("lim-auto").checked };
    saveLim();
    if (typeof refreshCostLine === "function") refreshCostLine();
  };
  for (const id of ["lim-req", "lim-ses"]) $(id).addEventListener("change", () => { save(); toast("Limits saved"); renderWalletPop(); });
  $("lim-auto").addEventListener("change", () => { save(); toast(LIM.autopay ? "Auto-pay is on for requests under your limit" : "Auto-pay is off: you'll confirm every payment"); });
  $("wp-activity").onclick = () => { closeWalletPop(); setUserTab("activity"); };
}
function openWalletPop() { renderWalletPop(); $("wallet-pop").hidden = false; $("wallet-btn").setAttribute("aria-expanded", "true"); loadMe(); }
function closeWalletPop() { $("wallet-pop").hidden = true; $("wallet-btn").setAttribute("aria-expanded", "false"); }
$("wallet-btn").onclick = (e) => { e.stopPropagation(); $("wallet-pop").hidden ? openWalletPop() : closeWalletPop(); };
document.addEventListener("click", (e) => { if (!$("wallet-pop").hidden && !e.target.closest(".walletwrap")) closeWalletPop(); });
addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("wallet-pop").hidden) closeWalletPop(); });

loadFx();
loadMe();
setInterval(loadMe, 30_000);
