// The DEX analyst in the Playground: one question, four paid steps.
//
// The hub runs the agent (src/graph/analyst.ts) with the playground's buyer:
// LLM plan → The Graph pools → Uniswap quote → LLM answer, each an x402
// payment. This page only asks and shows what came back: the answer, the facts
// it rests on, the pools that were bought and a receipt per step.

(() => {
  if (!$("an-form")) return;

  const EXAMPLES = [
    "Where can USDC earn the most fees against ETH?",
    "Swap $2000 USDC to ETH where liquidity is deepest",
    "Where is it cheapest to borrow USDC?",
  ];
  const STEPS = [
    ["plan", "Plan the query", "LLM, per token"],
    ["pools", "Read pools", "The Graph, per pool"],
    ["lending", "Read lending rates", "The Graph, per market"],
    ["quote", "Price the trade", "Uniswap API, per quote"],
    ["answer", "Write the answer", "LLM, per token"],
  ];

  const usdShort = (n) => (n == null ? "–" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`);
  // the model writes **bold** and line breaks; nothing else is rendered
  const prose = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n+/g, "<br>");
  const txLink = (tx, network) => ` · <a href="${esc(txUrl(tx, network))}" target="_blank" rel="noopener" title="View on ${explorerName(network)}">tx</a>`;

  $("an-examples").innerHTML = EXAMPLES.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("");
  $("an-examples").querySelectorAll("[data-q]").forEach((b) => b.onclick = () => { $("an-q").value = b.dataset.q; $("an-form").requestSubmit(); });

  $("an-form").onsubmit = async (e) => {
    e.preventDefault();
    const question = $("an-q").value.trim();
    if (!question) return $("an-q").focus();
    const btn = $("an-run"), out = $("an-out");
    btn.disabled = true;
    btn.textContent = "Working…";
    out.hidden = false;
    out.innerHTML = `<ol class="an-steps">${STEPS.map(([, t, s]) => `<li class="wait"><b>${t}</b><span>${s}</span></li>`).join("")}</ol>
      <div class="hint">Usually 15 to 30 seconds: each step waits for its payment to settle before the next one starts.</div>`;
    const r = await fetch("/playground/analyst", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) })
      .then((x) => x.json()).catch((err) => ({ ok: false, error: String(err) }));
    btn.disabled = false;
    btn.textContent = "Ask";
    if (!r.ok) {
      out.innerHTML = `<div class="notice bad"><b>The analyst could not finish</b><div>${esc(friendly(r.error))}</div></div>`;
      return;
    }
    out.innerHTML = reportHtml(r.report);
    bindSwap(out, r.report);
  };

  // The quote is a price; this turns it into transactions a wallet could sign.
  function bindSwap(root, rep) {
    const btn = root.querySelector("#an-build");
    if (!btn || !rep.quote?.request) return;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Building…";
      const box = root.querySelector("#an-swap");
      const r = await fetch("/playground/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rep.quote.request) })
        .then((x) => x.json()).catch((err) => ({ ok: false, error: String(err) }));
      btn.textContent = "Build again";
      btn.disabled = false;
      if (!r.ok) { box.innerHTML = `<div class="notice bad"><b>Could not build the swap</b><div>${esc(friendly(r.error))}</div></div>`; return; }
      const p = r.prepared;
      const tx = (label, t) => t ? `<div class="an-tx"><b>${label}</b><span class="mono">to ${esc(short(t.to))} · ${Math.round(t.data.length / 2).toLocaleString()} bytes${t.gas_limit ? ` · gas ${Number(t.gas_limit).toLocaleString()}` : ""}</span>
        <button type="button" class="linky" data-copy="${esc(JSON.stringify({ to: t.to, data: t.data, value: t.value, chainId: t.chain_id }))}">Copy transaction</button></div>` : "";
      const paid = p.spend.map((s) => `${esc(s.step)} ${s.amount == null ? "free" : `${fmt(s.amount)} ${esc(s.currency)}`}`).join(" · ");
      box.innerHTML = `<div class="an-swapbox ${p.ok ? "ok" : ""}">
        <div class="an-swaphead"><b>${p.ok ? (p.swap ? "Swap ready to sign" : "Quoted for this wallet") : "Swap not built"}</b><span class="sub">wallet ${esc(short(p.swapper))} · chain ${p.chain_id} · nothing was sent</span></div>
        <ol class="an-swapsteps">${p.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
        ${tx("1. Approve Permit2", p.approval)}${tx(p.approval ? "2. Swap" : "Swap", p.swap)}
        <div class="sub">Paid to Uniswap's API through x402: ${paid || "nothing"}</div></div>`;
      box.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast("Transaction copied"); });
    };
  }

  // ?ask=… opens the Playground and asks straight away (demo links)
  const ask = new URLSearchParams(location.search).get("ask");
  if (ask) {
    $("an-q").value = ask;
    setTimeout(() => { $("analyst").scrollIntoView({ block: "start" }); $("an-form").requestSubmit(); }, 400);
  }

  function reportHtml(rep) {
    const paid = Object.fromEntries(rep.spend.map((s) => [s.step, s]));
    const steps = STEPS.map(([k, t]) => {
      const s = paid[k];
      const why = rep.skipped.find((x) => x.startsWith(`${k}:`));
      const detail = s
        ? `${s.units ?? ""} ${esc(s.units === 1 ? String(s.unit ?? "").replace(/s$/, "") : s.unit ?? "")} · ${s.amount == null ? "free" : `${fmt(s.amount)} ${esc(s.currency)}`}${s.tx ? txLink(s.tx, s.network) : ""}`
        : esc(why ? why.slice(k.length + 1).trim() : "not needed for this question");
      return `<li class="${s ? "done" : "skip"}"><b>${t}</b><span>${detail}</span></li>`;
    }).join("");
    const rows = rep.pools.slice(0, 10).map((p) => `<tr>
        <td>${esc(p.protocol)}</td><td>${esc(p.chain)}</td><td>${esc(p.tokens.join(" / "))}</td>
        <td class="num">${p.fee_percent == null ? "–" : `${p.fee_percent}%`}</td><td class="num">${usdShort(p.tvl_usd)}</td>
        <td class="num">${usdShort(p.volume_24h_usd)}</td><td class="num">${p.fee_apr_percent == null ? "–" : `${p.fee_apr_percent}%`}</td></tr>`).join("");
    const pctOr = (n) => (n == null ? "–" : `${Number(n).toFixed(2)}%`);
    const marketRows = (rep.markets ?? []).map((m) => `<tr>
        <td>${esc(m.protocol)}</td><td>${esc(m.chain)}</td><td>${esc(m.token)}</td>
        <td class="num">${pctOr(m.supply_apy_percent)}</td><td class="num">${m.can_borrow ? pctOr(m.borrow_apy_percent) : "off"}</td>
        <td class="num">${usdShort(m.deposits_usd)}</td><td class="num">${m.utilization_percent == null ? "–" : `${Math.round(m.utilization_percent)}%`}</td></tr>`).join("");
    const total = Object.entries(rep.totals).map(([c, v]) => `${fmt(v)} ${esc(c)}`).join(" + ") || "nothing";
    return `<div class="an-answer">${prose(rep.answer)}</div>
      <div class="an-meta">${rep.writer === "llm" ? "Written by the LLM, only from the facts below" : "Facts only: no LLM service was available"} · planned by ${rep.planner === "llm" ? "the LLM" : "rules"} · paid ${total} in ${rep.spend.length} payment${rep.spend.length === 1 ? "" : "s"}</div>
      ${rep.removed?.length ? `<div class="an-meta">Cut from the answer because the paid data doesn't contain the number: ${rep.removed.map((x) => `“${esc(x)}”`).join(", ")}</div>` : ""}
      <ol class="an-steps">${steps}</ol>
      ${rep.quote?.request ? `<div class="an-build"><button type="button" class="ghost" id="an-build">Build this swap for my wallet</button>
        <span class="hint">Checks the approval, signs the Permit2 message and returns the transaction unsigned. Nothing is sent.</span></div><div id="an-swap"></div>` : ""}
      <details class="adv" open><summary>Facts it rests on (computed in code from paid data)</summary>
        <ul class="an-facts">${rep.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></details>
      ${rows ? `<details class="adv"><summary>Pools bought: ${rep.pools.length}, from ${rep.sources.ok} of ${rep.sources.total} standardized subgraphs</summary>
        <div class="tablewrap compact"><table><thead><tr><th>Protocol</th><th>Chain</th><th>Pair</th><th>Fee</th><th>TVL</th><th>24h volume</th><th>Fee APR</th></tr></thead><tbody>${rows}</tbody></table></div></details>` : ""}
      ${marketRows ? `<details class="adv an-markets"><summary>Lending markets bought: ${rep.markets.length}</summary>
        <div class="tablewrap compact"><table><thead><tr><th>Protocol</th><th>Chain</th><th>Token</th><th>Supply APY</th><th>Borrow APY</th><th>Deposits</th><th>Borrowed</th></tr></thead><tbody>${marketRows}</tbody></table></div></details>` : ""}`;
  }
})();
