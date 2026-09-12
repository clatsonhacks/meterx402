// Explore's front page: a recent real payment replayed in the hero, the live
// numbers under it, and a ticker of receipts. Everything shown comes from the
// hub's own registry and receipts. Only when there are no receipts yet does
// the hero play an example, and it says so.

(() => {
  if (!$("hh-demo")) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const EXAMPLE = { service_id: "llm", metered_units: 289, unit: "tokens", rate: "0.01", per: 1000, amount: "0.00289", currency: "HBAR", network: "hedera:testnet", transaction_id: null, settled_at: Date.now(), example: true };
  let receipts = [];
  let idx = 0;
  let timer = null;
  let hovering = false;

  const listing = (id) => M.services.find((x) => x.service_id === id);
  const titleFor = (id) => (listing(id) ? titleOf(listing(id).descriptor) : id);
  const markFor = (id) => (listing(id) ? avatar(listing(id).descriptor) : `<div class="avatar cat" style="--h:220">${icon("grid")}</div>`);
  const when = (t) => (typeof ago === "function" ? ago(t) : new Date(t).toLocaleTimeString());
  const one = (unit) => String(unit).replace(/s$/, "");
  const unitsText = (n, unit) => `${Number(n).toLocaleString()} ${Number(n) === 1 ? one(unit) : unit}`;
  const visible = () => !document.hidden && !$("user-market").hidden && !$("view-user").hidden;

  function demoHtml(r) {
    const proof = r.transaction_id
      ? `<a href="${esc(txUrl(r.transaction_id, r.network))}" target="_blank" rel="noopener">${esc(explorerName(r.network))} ↗</a>`
      : r.example ? "a Hedera transaction" : "on a prepaid tab";
    return `<div class="hd-top">${markFor(r.service_id)}
        <div class="hd-name"><b>${esc(titleFor(r.service_id))}</b><span>${r.example ? "how a call is paid" : esc(when(r.settled_at))} · ${esc(chainName(r.network))}</span></div>
        <span class="hd-live">${r.example ? "example" : `<i></i>real payment`}</span></div>
      <div class="hd-meter">
        <div class="hd-count"><b id="hd-units">0</b> <span>${esc(r.unit)}</span></div>
        <div class="hd-price"><b id="hd-amt">0</b> <span>${esc(r.currency)}</span></div>
      </div>
      <div class="hd-bar"><i id="hd-fill"></i></div>
      <div class="hd-rate">${fmt(r.rate)} ${esc(r.currency)} per ${Number(r.per) > 1 ? `${Number(r.per).toLocaleString()} ${esc(r.unit)}` : esc(one(r.unit))}, so this call cost exactly what it used</div>
      <ol class="hd-steps">
        <li><b>Metered</b><span>the call ran and was counted</span></li>
        <li><b>Quoted</b><span>a 402 with the exact price</span></li>
        <li><b>Paid</b><span>signed inside the buyer's limit</span></li>
        <li><b>Settled</b><span>${proof}</span></li>
      </ol>`;
  }

  function play(r) {
    const box = $("hh-demo");
    box.innerHTML = demoHtml(r);
    const units = Number(r.metered_units) || 0, amount = Number(r.amount) || 0;
    // count in the final amount's own precision, so the number does not change width as it runs
    const places = (String(r.amount).split(".")[1] ?? "").length;
    const steps = [...box.querySelectorAll(".hd-steps li")];
    const show = (p) => {
      $("hd-units").textContent = Math.round(units * p).toLocaleString();
      $("hd-amt").textContent = (amount * p).toFixed(places);
      $("hd-fill").style.width = `${p * 100}%`;
    };
    if (reduced) { show(1); steps.forEach((s) => s.classList.add("on")); return; }
    let start = null;
    const duration = 1500;
    const frame = (now) => {
      // the first frame's timestamp can precede performance.now(): start the clock there
      start ??= now;
      const t = Math.max(0, Math.min(1, (now - start) / duration));
      show(1 - (1 - t) ** 3);
      if (t > 0.05) steps[0].classList.add("on");
      if (t < 1) requestAnimationFrame(frame);
      else steps.slice(1).forEach((s, i) => setTimeout(() => s.classList.add("on"), 380 * (i + 1)));
    };
    requestAnimationFrame(frame);
  }

  function cycle() {
    clearTimeout(timer);
    const list = receipts.length ? receipts : [EXAMPLE];
    if (visible() && !hovering) play(list[idx++ % list.length]);
    if (!reduced) timer = setTimeout(cycle, 5600);
  }

  function renderStats() {
    const live = M.services.filter((l) => l.live);
    const paid = M.services.reduce((n, l) => n + (l.reputation?.stats?.paid_calls ?? 0), 0);
    const chains = [...new Set(live.flatMap((l) => (l.descriptor.payment?.settlement ?? []).map((o) => chainName(o.network))))];
    const meters = new Set(live.map((l) => l.descriptor.pricing?.unit).filter(Boolean));
    $("proof-stats").innerHTML = [
      [live.length, "services live"],
      [paid.toLocaleString(), "paid calls settled"],
      [chains.length, chains.length === 1 ? "chain settling" : "chains settling"],
      [meters.size, "ways to meter a call"],
    ].map(([n, label]) => `<div class="ps"><b>${n}</b><span>${esc(label)}</span></div>`).join("");
  }

  function renderTicker() {
    const items = receipts.slice(0, 18).map((r) => {
      const inner = `<b>${esc(titleFor(r.service_id))}</b><span>${esc(unitsText(r.metered_units, r.unit))}</span><span class="tk-amt">${fmt(r.amount)} ${esc(r.currency)}</span><span class="tk-net">${esc(chainName(r.network))} · ${esc(when(r.settled_at))}</span>`;
      return r.transaction_id ? `<a class="tk" href="${esc(txUrl(r.transaction_id, r.network))}" target="_blank" rel="noopener">${inner}</a>` : `<span class="tk">${inner}</span>`;
    }).join("");
    // two copies side by side make the loop seamless; the second is hidden from screen readers
    $("ticker").innerHTML = items ? `<div class="ticker-track"><div class="tk-group">${items}</div><div class="tk-group" aria-hidden="true">${items}</div></div>` : "";
    $("ticker").hidden = !items;
  }

  async function refresh() {
    try {
      const j = await fetch("/registry/receipts?limit=40").then((r) => r.json());
      receipts = (j.receipts ?? []).filter((r) => Number(r.metered_units) > 0 && Number(r.amount) > 0);
    } catch {}
    renderStats();
    renderTicker();
  }

  const ready = setInterval(() => {
    if (!M.loaded) return;
    clearInterval(ready);
    refresh().then(cycle);
    setInterval(refresh, 30_000);
  }, 200);

  $("hh-demo").addEventListener("mouseenter", () => { hovering = true; });
  $("hh-demo").addEventListener("mouseleave", () => { hovering = false; });

  // ── calls to action ──
  const scrollTo = (el) => el?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  const toAnalyst = () => { $("tab-play").click(); setTimeout(() => { scrollTo($("analyst")); $("an-q")?.focus({ preventScroll: true }); }, 80); };
  const toSeller = () => { $("mode-deployer").click(); $("dtab-apis")?.click(); setTimeout(() => $("sell-open")?.click(), 80); };
  $("hh-browse").onclick = () => scrollTo($("mkt-anchor"));
  $("hh-sell").onclick = toSeller;
  $("hh-ask").onclick = toAnalyst;
  $("bento-ask").onclick = toAnalyst;
  $("bento-sell").onclick = toSeller;
  $("bento-code").onclick = () => { $("tab-play").click(); setTimeout(() => { $("agents-note").open = true; scrollTo($("agents-note")); }, 80); };
  $("bento-claude").onclick = () => (typeof openLLMModal === "function" ? openLLMModal("claude") : $("bento-code").click());
  $("bento-chatgpt").onclick = () => (typeof openLLMModal === "function" ? openLLMModal("chatgpt") : $("bento-code").click());
  // searching from the hero takes you to the results
  $("mkt-q").addEventListener("keydown", (e) => { if (e.key === "Enter") scrollTo($("mkt-anchor")); });
})();
