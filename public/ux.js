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

// ── icons ───────────────────────────────────────────────────────────────
// One stroked set, drawn in currentColor, instead of emoji. Emoji render
// differently on every platform, carry their own colour, and read as a
// prototype; a consistent 1.75px line set reads as a product.
const ICONS = {
  "cloud-sun": '<path d="M12 2.5v2M4.9 4.9l1.4 1.4M2.5 12h2M19.1 4.9l-1.4 1.4M21.5 12h-2"/><path d="M15.9 12.6a4 4 0 1 0-5.9-4.1"/><path d="M13 21.5H7a4.5 4.5 0 1 1 .9-8.9 5.5 5.5 0 0 1 10.6 1.9A3.5 3.5 0 0 1 17.5 21.5H13Z"/>',
  message: '<path d="M21 14.5a2 2 0 0 1-2 2H8l-4 4v-15a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z"/><path d="M8 8.5h8M8 12h5"/>',
  trending: '<path d="M22 7.5 13.5 16l-5-5L2 17.5"/><path d="M16 7.5h6v6"/>',
  blocks: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M3 16.5A4.5 4.5 0 0 0 7.5 21H9M15 3h1.5A4.5 4.5 0 0 1 21 7.5V9"/>',
  repeat: '<path d="m17 2.5 3.5 3.5-3.5 3.5"/><path d="M3.5 11.5v-1a4 4 0 0 1 4-4h13"/><path d="m7 21.5-3.5-3.5L7 14.5"/><path d="M20.5 12.5v1a4 4 0 0 1-4 4h-13"/>',
  landmark: '<path d="M3 21.5h18M5.5 21.5V11M9.5 21.5V11M14.5 21.5V11M18.5 21.5V11"/><path d="M12 2.5 21 8.5H3Z"/>',
  package: '<path d="M20.5 8.2a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4a2 2 0 0 0-1 1.7v7.6a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7Z"/><path d="m3.5 7.5 8.5 5 8.5-5M12 21.5v-9M7.7 4.8l8.6 5"/>',
  droplet: '<path d="M12 2.8s6.5 7 6.5 11.7a6.5 6.5 0 0 1-13 0C5.5 9.8 12 2.8 12 2.8Z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  sparkles: '<path d="M12 3l1.9 5.3a2 2 0 0 0 1.3 1.3L20.5 11.5l-5.3 1.9a2 2 0 0 0-1.3 1.3L12 20l-1.9-5.3a2 2 0 0 0-1.3-1.3L3.5 11.5l5.3-1.9a2 2 0 0 0 1.3-1.3Z"/>',
  star: '<path d="m12 3 2.7 5.5 6 .9-4.35 4.25L17.4 20 12 17.1 6.6 20l1.05-6.35L3.3 9.4l6-.9Z"/>',
  zap: '<path d="M13 2.5 4.8 13.2a.6.6 0 0 0 .5 1h5.2l-1 7.3 8.7-11.2a.6.6 0 0 0-.5-1h-5.4Z"/>',
  search: '<circle cx="11" cy="11" r="7.2"/><path d="m20 20-3.6-3.6"/>',
  sliders: '<path d="M4 21v-6.5M4 10V3M12 21v-9M12 7.5V3M20 21v-4.5M20 12V3M1.5 14h5M9.5 7.5h5M17.5 16.5h5"/>',
  check: '<path d="M21.8 11.1V12a9.8 9.8 0 1 1-5.8-8.95"/><path d="m9 11.2 3 3 9.5-9.7"/>',
  upload: '<path d="M12 13v8.5M8.5 16.5 12 13l3.5 3.5"/><path d="M20.3 14.8A4.5 4.5 0 0 0 18 6.3h-1.3A7 7 0 1 0 5 12.9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gauge: '<path d="m12 13.8 4.2-4.2"/><path d="M3.5 18.8a10 10 0 1 1 17 0"/>',
};
/** An inline SVG for `name`, sized by CSS. */
function icon(name, cls = "") {
  const d = ICONS[name] ?? ICONS.grid;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

// ── saying what went wrong ──────────────────────────────────────────────
// The payment layer speaks in codes (facilitator_unavailable, tab_exhausted,
// pay_to_not_associated). Those are right for logs and wrong for a person
// standing in front of the screen, and "TypeError: Failed to fetch" is right
// for nobody. Every message a human can see goes through here first.
const ERRORS = {
  facilitator_unavailable: "The payment network isn't answering right now. Nothing was charged.",
  quote_failed: "This service couldn't work out a price for that request.",
  rate_limited: "Too many requests in a row. Wait a moment and try again.",
  too_many_unpaid_quotes: "There are unpaid quotes outstanding. Pay one or let them expire first.",
  response_too_large_to_meter: "The response was too big to meter. Ask for less in one go.",
  unknown_or_expired_quote: "That price expired. Ask again to get a fresh one.",
  expired: "That price expired. Ask again to get a fresh one.",
  tab_exhausted: "The prepaid tab has run out. Top it up to keep going.",
  tab_frozen: "The prepaid tab was frozen, usually because the allowance was revoked.",
  unknown_or_expired_tab: "That tab is no longer open.",
  unknown_or_expired_subscription: "That subscription is no longer valid.",
  subscription_period_exhausted: "This period's included usage is spent, so this call is priced normally.",
  no_allowance: "No allowance was found on the ledger for this tab.",
  bad_signature: "The signature didn't match the account.",
  bad_response: "The hub answered with something unexpected.",
  challenge_expired: "That took too long. Start again.",
  pay_to_not_associated: "The seller's account isn't set up to receive this token yet.",
  insufficient_balance: "Not enough balance in the wallet for this payment.",
  insufficient_funds: "Not enough balance in the wallet for this payment.",
  payment_does_not_match_quote: "The payment didn't match the quote, so it was refused before settling.",
  human_verification_required: "This service only answers verified humans.",
  subscriptions_not_enabled: "This service doesn't sell subscriptions.",
  tabs_not_enabled: "This service doesn't offer prepaid tabs.",
};
function friendly(err) {
  const raw = String(err?.message ?? err ?? "").trim();
  if (!raw) return "Something went wrong.";
  for (const [code, text] of Object.entries(ERRORS)) if (raw === code || raw.includes(code)) return text;
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return "Can't reach the hub. Is it still running?";
  if (/^hub_5\d\d$/.test(raw)) return "The hub is up but not answering properly yet.";
  if (/^hub_\d+$/.test(raw)) return `The hub refused that request (${raw.slice(4)}).`;
  // an internal JS error is a bug, not a message: never show its text
  if (/is not (iterable|a function|defined)|undefined|null|cannot read/i.test(raw)) {
    console.error("mx402:", raw);
    return "Something went wrong on this page.";
  }
  if (/^\s*5\d\d/.test(raw) || /50[0-9]/.test(raw)) return "The service is having trouble. Nothing was charged.";
  // a sentence from the SDK (budget refusals and the like) is already readable
  return raw.length > 160 ? raw.slice(0, 157) + "…" : raw;
}

// ── is the hub still there? ─────────────────────────────────────────────
// Every view polls. Without this, a hub that dies mid-demo looks exactly like
// a hub with nothing to say: stale cards, no explanation.
let netDown = false;
function setNet(ok, detail = "") {
  if (ok === !netDown) return;               // no change
  netDown = !ok;
  const bar = $("netbar");
  bar.hidden = ok;
  if (!ok) bar.innerHTML = `<span>${esc(detail || "Can't reach the hub.")}</span><button class="linky" id="net-retry">Retry now</button>`;
  if (!ok) $("net-retry").onclick = () => { loadMarket?.(); loadMe?.(); };
}

// ── names, categories, units ────────────────────────────────────────────
const CATS = {
  text_generation: { label: "AI Chat", icon: "message", hue: 265 },
  weather_forecast: { label: "Weather", icon: "cloud-sun", hue: 200 },
  market_data: { label: "Markets", icon: "trending", hue: 145 },
  blockchain_data: { label: "Blockchain", icon: "blocks", hue: 35 },
  onchain_analytics: { label: "DeFi", icon: "repeat", hue: 320 },
  dao_governance: { label: "Governance", icon: "landmark", hue: 10 },
  file_download: { label: "Files", icon: "package", hue: 28 },
  dex_liquidity: { label: "DEX Pools", icon: "droplet", hue: 290 },
  dex_quote: { label: "Swaps", icon: "repeat", hue: 330 },
};
const ACRONYMS = { llm: "LLM", ai: "AI", api: "API", eth: "ETH", dao: "DAO", nft: "NFT", usd: "USD" };
const prettyName = (s) => String(s ?? "").split(/[\s_-]+/).filter(Boolean).map((w) => ACRONYMS[w.toLowerCase()] ?? w[0].toUpperCase() + w.slice(1)).join(" ");
const titleOf = (d) => d.title || prettyName(d.name);
const catOf = (d) => CATS[d.capabilities.find((c) => CATS[c])] ?? { label: prettyName(d.capabilities[0] ?? "Data"), icon: "grid", hue: 220 };
const catKey = (d) => d.capabilities.find((c) => CATS[c]) ?? d.capabilities[0] ?? "data";
const avatar = (d, cls = "") => { const c = catOf(d); return `<div class="avatar cat ${cls}" style="--h:${c.hue}" aria-hidden="true">${icon(c.icon)}</div>`; };

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
/** A decimal string to atomic units, exactly. Number("0.0001") * 1e8 is
 *  9999.999999999998 on some values, and 48 x that rounds UP a tinybar — so a
 *  48-hour forecast quotes as 0.00480001 and the whole thing looks broken.
 *  The server does this with rationals; the browser can do it with strings. */
function toAtomicJs(dec, decimals = 8) {
  const [wholeRaw = "0", fracRaw = ""] = String(dec ?? "0").trim().split(".");
  const neg = wholeRaw.startsWith("-");
  const whole = wholeRaw.replace(/^[+-]/, "") || "0";
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  const dropped = fracRaw.slice(decimals);
  let n = BigInt(whole + frac);
  if (/[1-9]/.test(dropped)) n += 1n;         // never under-charge on truncation
  return neg ? -n : n;
}
const fromAtomicJs = (atomic, decimals = 8) => {
  const neg = atomic < 0n, a = (neg ? -atomic : atomic).toString().padStart(decimals + 1, "0");
  const frac = a.slice(-decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${a.slice(0, -decimals)}${frac ? "." + frac : ""}`;
};
/** Exact price of n units: atomic units, always rounded up, never below the
 *  minimum — the same rule the gateway applies, so the UI never disagrees
 *  with the quote it is about to show. */
function priceFor(p, n, decimals = 8) {
  const rate = toAtomicJs(p.rate, decimals);
  const per = BigInt(Math.max(1, Math.round(Number(p.per) || 1)));
  const units = BigInt(Math.max(0, Math.ceil(Number(n) || 0)));
  const total = (units * rate + per - 1n) / per;            // ceil-divide
  const min = toAtomicJs(p.min ?? 0, decimals);
  return Number(fromAtomicJs(total > min ? total : min, decimals));
}

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

// The same, for whatever a service settles in: HBAR on Hedera, USDC on Base
// and Solana. USDC is already dollars, so it needs no exchange rate.
const curOf = (l) => l?.price?.currency ?? l?.descriptor?.payment?.settlement?.[0]?.currency ?? "HBAR";
const isUsd = (c) => /^USD/i.test(String(c ?? ""));
const amt = (h, c = "HBAR") => `${fmt(h)} ${c}`;
const moneyIn = (h, c = "HBAR") => (isUsd(c) ? amt(h, c) : money(h));
const centsIn = (h, c = "HBAR") => { const u = isUsd(c) ? Number(h) : usdOf(h); return u == null ? "" : u < 0.01 ? "under 1¢" : `about ${usdText(u)}`; };
/** Where a payment settled, in words and as an explorer link. */
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const chainName = (network) => !network || network.startsWith("hedera:") ? "Hedera"
  : network === "eip155:84532" ? "Base Sepolia" : network === "eip155:8453" ? "Base"
  : network === SOLANA_DEVNET ? "Solana devnet" : network.startsWith("solana:") ? "Solana" : network;
const txUrl = (tx, network) => !network || network.startsWith("hedera:") ? hashscanTx(tx)
  : network === "eip155:84532" ? `https://sepolia.basescan.org/tx/${tx}` : network.startsWith("eip155:") ? `https://basescan.org/tx/${tx}`
  : `https://solscan.io/tx/${tx}${network === SOLANA_DEVNET ? "?cluster=devnet" : ""}`;
const explorerName = (network) => !network || network.startsWith("hedera:") ? "HashScan" : network.startsWith("solana:") ? "Solscan" : "BaseScan";

// ── trust ───────────────────────────────────────────────────────────────
function trustOf(r) {
  if (r.score == null) return { key: "new", label: "New", title: `New: fewer than ${r.min_samples ?? 5} paid uses so far, too few to rate` };
  const s = Math.round(r.score);
  const [key, label] = s >= 90 ? ["excellent", "Excellent"] : s >= 75 ? ["good", "Good"] : s >= 50 ? ["fair", "Fair"] : ["poor", "Poor"];
  return { key, label, score: s, title: `${s}/100 from ${r.stats.paid_calls} paid uses` };
}
const trustBadge = (r) => { const t = trustOf(r); return `<span class="trust ${t.key}" title="${esc(t.title)}">${icon(t.key === "new" ? "sparkles" : "star")} ${t.label}${t.score != null ? ` <small>${t.score}</small>` : ""}</span>`; };

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
  try { W = await fetch("/me").then((r) => r.json()); setNet(true); }
  catch (e) { W = { ok: false }; setNet(false, friendly(e)); }
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
