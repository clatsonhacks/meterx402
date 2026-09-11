// App shell: the User / Deployer switch, the User sub-tabs, deep links, and
// the Deployer's "Publish an API" panel.
//
//   #user              marketplace (default)
//   #user/playground   playground            (?service=<id>&integ=mcp also works)
//   #deployer          the seller dashboard  (?stream=<lane> still opens it)

let MODE = "user";

function setMode(mode, push = true) {
  MODE = mode;
  $("mode-user").setAttribute("aria-pressed", String(mode === "user"));
  $("mode-deployer").setAttribute("aria-pressed", String(mode === "deployer"));
  $("view-user").hidden = mode !== "user";
  $("view-deployer").hidden = mode !== "deployer";
  if (mode === "deployer") { renderCharges(); renderHours(); refreshPublished(); }
  if (push) history.replaceState(null, "", `${location.pathname}${location.search}#${mode === "user" ? `user${USER_TAB === "play" ? "/playground" : ""}` : "deployer"}`);
  try { localStorage.setItem("mx402.mode", mode); } catch {}
}

let USER_TAB = "market";
function setUserTab(tab, push = true) {
  USER_TAB = tab;
  $("tab-market").setAttribute("aria-selected", String(tab === "market"));
  $("tab-play").setAttribute("aria-selected", String(tab === "play"));
  $("user-market").hidden = tab !== "market";
  $("user-play").hidden = tab !== "play";
  if (tab === "play") renderPlayground();
  if (MODE !== "user") setMode("user", false);
  if (push) history.replaceState(null, "", `${location.pathname}${location.search}#user${tab === "play" ? "/playground" : ""}`);
}

$("mode-user").onclick = () => setMode("user");
$("mode-deployer").onclick = () => setMode("deployer");
$("tab-market").onclick = () => setUserTab("market");
$("tab-play").onclick = () => setUserTab("play");

// ── Deployer: publish an API from the dashboard ──────────────────────────
function publishPayload() {
  const header = $("pub-header").value.trim(), query = $("pub-query").value.trim();
  const headers = {}, q = {};
  if (header.includes(":")) headers[header.slice(0, header.indexOf(":")).trim()] = header.slice(header.indexOf(":") + 1).trim();
  if (query.includes("=")) q[query.slice(0, query.indexOf("=")).trim()] = query.slice(query.indexOf("=") + 1).trim();
  return {
    url: $("pub-url").value.trim(), method: $("pub-method").value, sample: $("pub-sample").value.trim() || "/",
    body: $("pub-method").value === "POST" ? $("pub-body").value.trim() : "", headers, query: q,
    name: $("pub-name").value.trim(), description: $("pub-desc").value.trim(),
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
  if (p.name) parts.push("--name", q(p.name));
  for (const c of p.capabilities) parts.push("--capability", c);
  if (p.description) parts.push("--description", q(p.description));
  if (p.tab) parts.push("--tab");
  return parts.join(" \\\n  ");
}
function renderPublishCli() {
  $("pub-cli").innerHTML = snippet("or from your terminal", cliFor(publishPayload()));
  bindCopy($("pub-cli"));
}
for (const id of ["pub-url", "pub-method", "pub-sample", "pub-body", "pub-header", "pub-query", "pub-name", "pub-caps", "pub-desc", "pub-wallet", "pub-tab"]) $(id).addEventListener("input", renderPublishCli);
$("pub-tab").addEventListener("change", renderPublishCli);

$("pub-check").onclick = async () => {
  const p = publishPayload();
  if (!p.url) return ($("pub-result").innerHTML = `<span class="status bad"><span class="ico">!</span>Enter an API URL first</span>`);
  $("pub-result").innerHTML = `<span class="label">calling it once to see what it returns…</span>`;
  const r = await fetch("/deploy/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
  if (!r.ok) {
    $("pub-result").innerHTML = `<span class="status bad"><span class="ico">!</span>${r.needsAuth ? `The API answered ${r.status}: it needs a key. Add it as an auth header or query parameter; it stays on your gateway.` : esc(r.error)}</span>`;
    return;
  }
  const d = r.detection;
  if (!$("pub-caps").value) $("pub-caps").placeholder = r.capabilities.join(", ");
  $("pub-result").innerHTML = `<ul class="steps">
      <li class="ok"><span class="ic">✓</span><div><b>API detected: ${esc(r.type.toUpperCase())}</b><div class="d">${r.status} in ${r.ms} ms · ${(r.bytes / 1000).toFixed(1)} KB · auth: ${esc(r.auth)}</div></div></li>
      <li class="ok"><span class="ic">✓</span><div><b>Meter: <span class="mono">${esc(d.meter)}</span></b><div class="d">${esc(d.why)}</div></div></li>
      <li class="ok"><span class="ic">✓</span><div><b>Suggested rate: ${esc(d.rate)} HBAR / ${d.per === 1 ? esc(d.unit.replace(/s$/, "")) : d.per + " " + esc(d.unit)}</b><div class="d">capabilities: ${esc(r.capabilities.join(", "))}</div></div></li>
    </ul>
    <table class="vtable" style="margin-top:10px"><thead><tr><th>call</th><th class="num">units</th><th class="num">price</th></tr></thead><tbody>
      ${r.variants.map((v) => `<tr><td>${esc(v.label)}</td><td class="num">${v.units} ${esc(d.unit)}</td><td class="num"><b>${esc(v.price)}</b> HBAR</td></tr>`).join("")}
      <tr><td style="color:var(--muted)">flat, at the cap</td><td class="num" style="color:var(--muted)">${r.flat.units}</td><td class="num" style="color:var(--muted)">${esc(r.flat.price)} HBAR</td></tr>
    </tbody></table>
    <div class="sub" style="margin-top:6px">Same API, different work, different price. A flat price would have to cover the worst case.</div>`;
};

$("pub-go").onclick = async () => {
  const p = publishPayload();
  if (!p.url) return ($("pub-result").innerHTML = `<span class="status bad"><span class="ico">!</span>Enter an API URL first</span>`);
  $("pub-go").disabled = true;
  $("pub-result").innerHTML = `<span class="label">detecting, pricing, starting the payment endpoint, registering…</span>`;
  const r = await fetch("/deploy/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
  $("pub-go").disabled = false;
  if (!r.ok) return ($("pub-result").innerHTML = `<span class="status bad"><span class="ico">!</span>${esc(r.error)}</span>`);
  const d = r.descriptor;
  $("pub-result").innerHTML = `<span class="status ok"><span class="ico">✓</span>Published and registered</span>
    <div class="kv" style="margin-top:8px">
      <span>service id</span><span class="mono">${esc(d.service_id)}</span>
      <span>payment endpoint</span><span class="mono">${esc(d.endpoint)}${esc(d.sample?.path ?? "")}</span>
      <span>meter</span><span class="mono">${esc(d.pricing.meter)}</span>
      <span>price</span><span>${esc(d.pricing.rate)} ${esc(d.pricing.currency)} / ${esc(d.pricing.unit)}</span>
      <span>capabilities</span><span>${esc(d.capabilities.join(", "))}</span>
      <span>settlement</span><span>${d.payment.settlement.map((o) => o.schemes.join(" + ")).join("; ")}${r.tabs ? " (tabs on)" : ""}</span>
      <span>links</span><span><a href="${esc(d.links.descriptor)}" target="_blank" rel="noopener">descriptor</a> · <a href="${esc(d.links.a2a_card)}" target="_blank" rel="noopener">A2A card</a></span>
    </div>
    <div class="runbar"><button class="ghost" id="pub-see">See it in the marketplace</button></div>`;
  $("pub-see").onclick = () => { setMode("user"); setUserTab("market"); openService(d.service_id, "overview"); };
  loadMarket(); refreshLanes(); refreshPublished();
};

async function refreshPublished() {
  const { services } = await fetch("/deploy/published").then((r) => r.json()).catch(() => ({ services: [] }));
  $("pub-list").innerHTML = services.length ? `<div class="label">Published from this dashboard</div>${services.map((s) => `<div class="row" style="align-items:center;justify-content:space-between;margin-top:6px"><span class="mono">${esc(s.service_id)} · ${esc(s.url)}</span><button class="ghost" data-stop="${esc(s.service_id)}">Stop</button></div>`).join("")}` : "";
  $("pub-list").querySelectorAll("[data-stop]").forEach((b) => b.onclick = async () => {
    await fetch(`/deploy/published/${encodeURIComponent(b.dataset.stop)}`, { method: "DELETE" });
    refreshPublished(); loadMarket(); refreshLanes();
  });
}

// ── start where the URL says ─────────────────────────────────────────────
(function boot() {
  const hash = location.hash.replace(/^#/, "");
  const qs = new URLSearchParams(location.search);
  renderPublishCli();
  if (qs.get("stream") || qs.get("lane") || hash.startsWith("deployer")) return setMode("deployer", false);
  if (qs.get("service")) { setMode("user", false); return openPlayground(qs.get("service"), qs.get("integ") ?? undefined); }
  if (qs.get("open")) { setMode("user", false); setUserTab("market", false); const id = qs.get("open"), tab = qs.get("tab") ?? "overview"; const t = setInterval(() => { if (M.services.some((l) => l.service_id === id)) { clearInterval(t); openService(id, tab); } }, 200); return; }
  let saved = null;
  try { saved = localStorage.getItem("mx402.mode"); } catch {}
  setMode(hash.startsWith("user") || !saved ? "user" : saved, false);
  setUserTab(hash === "user/playground" ? "play" : "market", false);
})();
