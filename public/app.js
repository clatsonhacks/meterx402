// App shell: the User / Deployer switch, the User tabs, deep links, and the
// Deployer's "Sell your API" wizard.
//
//   #user             Explore (default)
//   #user/activity    what this wallet paid for
//   #user/developers  the playground and agent snippets
//   #deployer         the seller's dashboard

let MODE = "user";
let USER_TAB = "market";
const TAB_IDS = { market: "user-market", activity: "user-activity", play: "user-play" };
const TAB_HASH = { market: "user", activity: "user/activity", play: "user/developers" };

function setMode(mode, push = true) {
  MODE = mode;
  document.body.className = `mode-${mode}`;
  $("mode-user").setAttribute("aria-pressed", String(mode === "user"));
  $("mode-deployer").setAttribute("aria-pressed", String(mode === "deployer"));
  $("view-user").hidden = mode !== "user";
  $("view-deployer").hidden = mode !== "deployer";
  if (mode === "deployer") { renderCharges(); renderHours(); refreshPublished(); renderEarnLine(); }
  if (push) history.replaceState(null, "", `${location.pathname}${location.search}#${mode === "user" ? TAB_HASH[USER_TAB] : "deployer"}`);
  try { localStorage.setItem("mx402.mode", mode); } catch {}
}

function setUserTab(tab, push = true) {
  USER_TAB = tab;
  for (const [k, id] of Object.entries(TAB_IDS)) $(id).hidden = k !== tab;
  $("tab-market").setAttribute("aria-selected", String(tab === "market"));
  $("tab-activity").setAttribute("aria-selected", String(tab === "activity"));
  $("tab-play").setAttribute("aria-selected", String(tab === "play"));
  if (tab === "play") renderPlayground();
  if (tab === "activity") { renderActivity(); loadMine(); }
  if (MODE !== "user") setMode("user", false);
  if (push) history.replaceState(null, "", `${location.pathname}${location.search}#${TAB_HASH[tab]}`);
}

$("mode-user").onclick = () => setMode("user");
$("mode-deployer").onclick = () => setMode("deployer");
$("tab-market").onclick = () => setUserTab("market");
$("tab-activity").onclick = () => setUserTab("activity");
$("tab-play").onclick = () => setUserTab("play");

// "How it works", until it's been read once
if (localStorage.getItem("mx402.howto") !== "done") $("howto").hidden = false;
$("howto-ok").onclick = () => { $("howto").hidden = true; try { localStorage.setItem("mx402.howto", "done"); } catch {} };

// ── Deployer: earnings, in a sentence ───────────────────────────────────
function renderEarnLine() {
  const a = S.analytics;
  if (!a || !a.totalRequests) { $("earn-line").textContent = "Sell any API by usage. Buyers pay for exactly what each call returns."; return; }
  const usd = typeof usdOf === "function" ? usdOf(a.totalIncome) : null;
  const n = scopeKeys().length;
  $("earn-line").innerHTML = `You've earned <b>${fmt(a.totalIncome)} HBAR</b>${usd != null ? ` <span class="usd">≈ ${usdText(usd)}</span>` : ""} from ${a.totalRequests} paid use${a.totalRequests === 1 ? "" : "s"} across ${n} API${n === 1 ? "" : "s"}.`;
}
setInterval(() => { if (MODE === "deployer") renderEarnLine(); }, 2000);

// ── Deployer: the "Sell your API" wizard ────────────────────────────────
let CHECK = null; // the last successful /deploy/check
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

$("sell-open").onclick = () => {
  const open = $("sell-body").hidden;
  $("sell-body").hidden = !open;
  $("sell-open").setAttribute("aria-expanded", String(open));
  $("sell-open").innerHTML = open ? "Close" : `${icon("plus")} Sell an API`;
  if (open) sellStep(1);
};

function sellStep(n) {
  for (const s of [1, 2, 3]) $(`ss-${s}`).hidden = s !== n;
  $("ss-done").hidden = true;
  $("stepper").querySelectorAll("li").forEach((li) => {
    const s = Number(li.dataset.s);
    li.className = s === n ? "on" : s < n ? "done" : "";
  });
  if (n === 3) renderPreview();
  renderPublishCli();
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) sellStep(Number(b.dataset.go)); });

function publishPayload() {
  const header = $("pub-header").value.trim(), query = $("pub-query").value.trim();
  const headers = {}, q = {};
  if (header.includes(":")) headers[header.slice(0, header.indexOf(":")).trim()] = header.slice(header.indexOf(":") + 1).trim();
  if (query.includes("=")) q[query.slice(0, query.indexOf("=")).trim()] = query.slice(query.indexOf("=") + 1).trim();
  const title = $("pub-title").value.trim();
  return {
    url: $("pub-url").value.trim(), method: $("pub-method").value, sample: $("pub-sample").value.trim() || "/",
    body: $("pub-method").value === "POST" ? $("pub-body").value.trim() : "", headers, query,
    name: slug(title) || undefined, title: title || undefined,
    description: $("pub-desc").value.trim() || undefined,
    unitLabel: $("pub-unitlabel").value.trim() || undefined,
    rate: $("pub-rate").value || undefined, per: $("pub-per").value || undefined,
    capabilities: $("pub-caps").value.split(",").map((s) => s.trim()).filter(Boolean),
    wallet: $("pub-wallet").value.trim(), tab: $("pub-tab").checked,
  };
}

function cliFor(p) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const parts = ["npx mx402 publish", q(p.url || "https://api.example.com"), "--wallet", p.wallet || "<your-account>"];
  if (p.sample && p.sample !== "/") parts.push("--sample", q(p.sample));
  if (p.method === "POST") parts.push("--method POST");
  if (p.body) parts.push("--body", q(p.body));
  for (const [k] of Object.entries(p.headers)) parts.push("--header", q(`${k}: $KEY`));
  for (const [k] of Object.entries(p.query)) parts.push("--query", q(`${k}=$KEY`));
  if (p.title) parts.push("--title", q(p.title), "--name", q(p.name));
  if (p.unitLabel) parts.push("--unit-label", q(p.unitLabel));
  if (p.rate) parts.push("--rate", p.rate);
  for (const c of p.capabilities) parts.push("--capability", c);
  if (p.description) parts.push("--description", q(p.description));
  if (p.tab) parts.push("--tab");
  return parts.join(" \\\n  ");
}
function renderPublishCli() { $("pub-cli").innerHTML = snippet("", cliFor(publishPayload())); bindCopy($("pub-cli")); }

// step 1 → check
$("pub-check").onclick = async () => {
  const p = publishPayload();
  if (!p.url) return ($("pub-check-msg").innerHTML = `<div class="notice bad">Enter your API's URL first.</div>`);
  $("pub-check").disabled = true;
  $("pub-check-msg").innerHTML = `<div class="working"><span class="spin"></span><div><b>Calling your API once…</b><div class="sub">Nothing is charged or published.</div></div></div>`;
  const r = await fetch("/deploy/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
  $("pub-check").disabled = false;
  if (!r.ok) {
    $("pub-check-msg").innerHTML = `<div class="notice bad"><b>${r.needsAuth ? "Your API needs a key" : "Couldn't read your API"}</b><div>${r.needsAuth ? `It answered ${r.status}. Open “It needs an API key” above and add it: the key stays on your server.` : esc(r.error)}</div></div>`;
    return;
  }
  CHECK = r;
  $("pub-check-msg").innerHTML = "";
  const d = r.detection;
  if (!$("pub-unitlabel").value) $("pub-unitlabel").value = String(d.unit).replace(/s$/, "");
  if (!$("pub-rate").value) $("pub-rate").value = d.rate;
  $("pub-per").value = d.per;
  if (!$("pub-caps").value) $("pub-caps").value = r.capabilities.join(", ");
  if (!$("pub-title").value) $("pub-title").value = prettyName(new URL(p.url).hostname.replace(/^api\./, "").split(".")[0]);
  $("pub-found").innerHTML = `<div class="notice ok"><b>Found a ${esc(r.type.toUpperCase())} API</b>
    <div>${esc(d.why)} — so each call is priced by <b>${esc(d.unit)}</b>.</div>
    <div class="sub">${r.status} in ${r.ms} ms · ${(r.bytes / 1000).toFixed(1)} KB · auth: ${esc(r.auth)}</div></div>`;
  sellStep(2);
  renderPrices();
};

// step 2 → live pricing preview
function renderPrices() {
  if (!CHECK) return;
  const d = CHECK.detection;
  const card = { rate: $("pub-rate").value || d.rate, per: Number($("pub-per").value) || d.per, min: d.min };
  const label = $("pub-unitlabel").value.trim() || String(d.unit).replace(/s$/, "");
  const row = (l, n) => `<tr><td>${esc(l)}</td><td class="num">${Number(n).toLocaleString()} ${esc(plural(label, n))}</td><td class="num"><b>${fmt(priceFor(card, n))}</b> HBAR</td></tr>`;
  $("pub-prices").innerHTML = `<table class="vtable"><tbody>
      ${CHECK.variants.map((v) => row(v.label, v.units)).join("")}
      <tr class="flatrow"><td>a flat price, at your cap</td><td class="num">${Number(CHECK.flat.units).toLocaleString()} ${esc(plural(label, 2))}</td><td class="num">${fmt(priceFor(card, CHECK.flat.units))} HBAR</td></tr>
    </tbody></table>
    <div class="sub">Same API, different work, different price. A flat price would have to charge the last row every time.</div>`;
  const usd = typeof usdOf === "function" ? usdOf(Number(card.rate)) : null;
  $("pub-rate-usd").textContent = usd != null ? `≈ ${usdText(usd)} per ${card.per === 1 ? label : `${card.per} ${plural(label, 2)}`}` : "";
}
for (const id of ["pub-rate", "pub-per", "pub-unitlabel"]) $(id).addEventListener("input", () => { renderPrices(); renderPublishCli(); });
for (const id of ["pub-url", "pub-method", "pub-sample", "pub-body", "pub-header", "pub-query", "pub-title", "pub-caps", "pub-desc", "pub-wallet"]) $(id).addEventListener("input", renderPublishCli);
$("pub-tab").addEventListener("change", () => { renderPublishCli(); renderPreview(); });

// step 3 → what buyers will see, using the real marketplace card
function renderPreview() {
  const p = publishPayload(), d = CHECK?.detection;
  if (!d) { $("pub-preview").innerHTML = `<div class="empty-state">Check your API first.</div>`; return; }
  const rate = p.rate || d.rate, per = Number(p.per) || d.per;
  const fake = {
    service_id: p.name ?? "preview", live: true,
    descriptor: {
      service_id: p.name ?? "preview", name: p.name ?? "preview", title: p.title, description: p.description ?? "",
      capabilities: p.capabilities.length ? p.capabilities : CHECK.capabilities,
      pricing: { rate, per, min: d.min, unit: d.unit, unit_label: p.unitLabel, max_units: d.maxUnits, currency: "HBAR" },
      payment: { streaming: p.tab }, interfaces: ["rest"], owner: { account: p.wallet || "your wallet", network: "hedera:testnet" },
    },
    reputation: { score: null, stats: { paid_calls: 0 } },
    price: { typical_call: priceFor({ rate, per, min: d.min }, d.measured), worst_case_call: priceFor({ rate, per, min: d.min }, d.maxUnits) },
  };
  $("pub-preview").innerHTML = cardHtml(fake);
}

// publish
$("pub-go").onclick = async () => {
  const p = publishPayload();
  if (!p.url) return ($("pub-result").innerHTML = `<div class="notice bad">Enter your API's URL first.</div>`);
  $("pub-go").disabled = true;
  $("pub-result").innerHTML = `<div class="working"><span class="spin"></span><div><b>Publishing…</b><div class="sub">Starting your payment endpoint and registering it.</div></div></div>`;
  const r = await fetch("/deploy/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
  $("pub-go").disabled = false;
  if (!r.ok) return ($("pub-result").innerHTML = `<div class="notice bad"><b>Couldn't publish</b><div>${esc(friendly(r.error))}</div></div>`);
  const d = r.descriptor;
  $("pub-result").innerHTML = "";
  for (const s of [1, 2, 3]) $(`ss-${s}`).hidden = true;
  $("stepper").querySelectorAll("li").forEach((li) => (li.className = "done"));
  $("ss-done").hidden = false;
  $("ss-done").innerHTML = `<div class="done-ic">${icon("check")}</div>
    <h3>${esc(d.title || prettyName(d.name))} is live</h3>
    <p class="label">Buyers and AI agents can find it, get a price, and pay per use. Payments settle straight to ${esc(d.owner.account)}.</p>
    <div class="kv">
      <span>Price</span><span>${fmt(d.pricing.rate)} ${esc(d.pricing.currency)} ${esc(perPhrase(d.pricing))}</span>
      <span>Endpoint</span><span class="mono">${esc(d.endpoint)}</span>
      <span>Settles on</span><span>${d.payment.settlement.map((o) => o.schemes.join(" + ")).join("; ")}${r.tabs ? " (prepaid tabs on)" : ""}</span>
    </div>
    <div class="runbar"><button class="primary" id="pub-see">See it in the marketplace</button><button class="ghost" id="pub-again">Sell another</button></div>`;
  $("pub-see").onclick = () => { setMode("user"); setUserTab("market"); openService(d.service_id, "try"); };
  $("pub-again").onclick = () => { CHECK = null; ["pub-url", "pub-sample", "pub-body", "pub-title", "pub-desc", "pub-caps", "pub-rate", "pub-unitlabel"].forEach((id) => ($(id).value = "")); sellStep(1); };
  toast(`Published ${esc(d.title || d.name)}`);
  loadMarket(); refreshLanes(); refreshPublished();
};

async function refreshPublished() {
  const { services } = await fetch("/deploy/published").then((r) => r.json()).catch(() => ({ services: [] }));
  $("pub-list").innerHTML = services.length
    ? `<div class="label" style="margin-top:12px">Running in this dashboard</div>${services.map((s) => `<div class="row" style="align-items:center;justify-content:space-between;margin-top:6px"><span class="mono">${esc(s.service_id)} · ${esc(s.url)}</span><button class="ghost" data-stop="${esc(s.service_id)}">Stop</button></div>`).join("")}`
    : "";
  $("pub-list").querySelectorAll("[data-stop]").forEach((b) => b.onclick = async () => {
    await fetch(`/deploy/published/${encodeURIComponent(b.dataset.stop)}`, { method: "DELETE" });
    refreshPublished(); loadMarket(); refreshLanes();
  });
}

// ── start where the URL says ────────────────────────────────────────────
(function boot() {
  const hash = location.hash.replace(/^#/, "");
  const qs = new URLSearchParams(location.search);
  renderPublishCli();
  if (qs.get("stream") || qs.get("lane") || hash.startsWith("deployer")) return setMode("deployer", false);
  if (qs.get("rfq")) {
    setMode("user", false); setUserTab("market", false);
    const want = qs.get("rfq");
    const t = setInterval(() => {
      if (!M.services.length) return;
      clearInterval(t);
      rfqOpen(true);
      if (want !== "1" && [...$("rfq-cap").options].some((o) => o.value === want)) $("rfq-cap").value = want;
      if (qs.get("units")) $("rfq-units").value = qs.get("units");
      if (qs.get("max")) $("rfq-max").value = qs.get("max");
      if (qs.get("run") !== "0") $("rfq-go").click();
    }, 200);
    return;
  }
  if (qs.get("service")) { setMode("user", false); return openPlayground(qs.get("service"), qs.get("integ") ?? undefined); }
  if (qs.get("open")) {
    setMode("user", false); setUserTab("market", false);
    const id = qs.get("open"), tab = qs.get("tab") ?? "try";
    const t = setInterval(() => { if (M.services.some((l) => l.service_id === id)) { clearInterval(t); openService(id, tab); } }, 200);
    return;
  }
  let saved = null;
  try { saved = localStorage.getItem("mx402.mode"); } catch {}
  setMode(hash.startsWith("user") || !saved ? "user" : saved, false);
  setUserTab(hash === "user/activity" ? "activity" : hash === "user/developers" || hash === "user/playground" ? "play" : "market", false);
})();
