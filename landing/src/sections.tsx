import { useRef, useState } from "react";
import { ANALYST, APP, ReceiptCard, REPO, SELL } from "./components";
import { chainName, txUrl, useLive, useStats } from "./data";
import { stage, useSectionProgress } from "./scroll";

const Eyebrow = ({ children }: { children: React.ReactNode }) => <span className="eyebrow reveal">{children}</span>;
const Sparkle = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.3a2 2 0 0 0 1.3 1.3L20.5 11.5l-5.3 1.9a2 2 0 0 0-1.3 1.3L12 20l-1.9-5.3a2 2 0 0 0-1.3-1.3L3.5 11.5l5.3-1.9a2 2 0 0 0 1.3-1.3Z" /></svg>
);

// ── 1. hero ───────────────────────────────────────────────────────────────
export function Hero() {
  const s = useStats();
  return (
    <section id="top" className="hero" data-stage="hero">
      <div className="container hero-grid">
        <div className="hero-copy">
          <span className="pill-live"><i />Live on Hedera, Base and Solana testnets</span>
          <h1>Pay per use.<br /><span className="grad">Not per call.</span></h1>
          <p className="lede">APIs, AI and onchain data priced by what each call actually returns. People and AI agents pay over x402, inside a budget they set, and every payment ends in a receipt anyone can verify on chain.</p>
          <div className="cta-row">
            <a className="btn primary lg" href={APP}>Get started</a>
            <a className="btn ghost lg" href={SELL}>Sell your API</a>
            <a className="ai-pill" href={ANALYST}><Sparkle />Ask the DEX analyst<em aria-hidden="true">→</em></a>
          </div>
          <dl className="stats">
            <div><dt>services live</dt><dd>{s.live || "–"}</dd></div>
            <div><dt>paid calls settled</dt><dd>{s.paid || "–"}</dd></div>
            <div><dt>chains settling</dt><dd>{s.chains || 3}</dd></div>
            <div><dt>standardized subgraphs</dt><dd>30</dd></div>
          </dl>
        </div>
        <div className="hero-visual">
          <ReceiptCard />
        </div>
      </div>
      <div className="scroll-hint" aria-hidden="true"><span />scroll</div>
    </section>
  );
}

// ── 2. flat versus metered ────────────────────────────────────────────────
const ROWS = [
  { call: "A 5-word answer", units: "289 tokens", metered: 0.00289, flat: 0.04, cur: "HBAR" },
  { call: "A 200-word answer", units: "563 tokens", metered: 0.00563, flat: 0.04, cur: "HBAR" },
  { call: "A 1-day forecast", units: "24 hours", metered: 0.0024, flat: 0.024, cur: "HBAR" },
];

export function Problem() {
  const ref = useRef<HTMLElement>(null);
  useSectionProgress(ref, (p) => ref.current?.style.setProperty("--p", p.toFixed(3)), "top 75%", "center 45%");
  return (
    <section id="problem" ref={ref} className="section problem" data-stage="problem">
      <div className="container split">
        <div>
          <Eyebrow>The problem</Eyebrow>
          <h2 className="reveal">A flat price is the wrong unit.</h2>
          <p className="reveal">x402 made APIs payable per request. But a five-word answer and a two-hundred-word answer are not the same request. Flat pricing makes sellers charge for the worst case, and light users, especially agents making many small calls, pay for heavy ones.</p>
          <p className="reveal muted">MeterX402 meters each answer and charges exactly what it used.</p>
        </div>
        <div className="bars glass reveal">
          {ROWS.map((r) => (
            <div className="bar-row" key={r.call} style={{ "--flat": r.flat / 0.04, "--metered": r.metered / 0.04 } as React.CSSProperties}>
              <div className="bar-label"><b>{r.call}</b><span>{r.units}</span></div>
              <div className="bar-track"><i className="bar-flat" /><i className="bar-metered" /></div>
              <div className="bar-values"><span className="flat">flat {r.flat} {r.cur}</span><b>metered {r.metered} {r.cur}</b></div>
            </div>
          ))}
          <p className="bar-note">Real calls, settled on Hedera testnet.</p>
        </div>
      </div>
    </section>
  );
}

// ── 3. how a call is paid (sticky) ───────────────────────────────────────
const STEPS = [
  { title: "Meter", text: "The gateway runs the call and counts what the answer used: tokens, rows, cells or entities.", http: "GET /chat/completions\n→ 612 tokens counted\n  (body held, not sent yet)" },
  { title: "Quote", text: "It answers 402 with the exact price of that answer, committed to the body's hash.", http: "HTTP/1.1 402 Payment Required\nx-meter-units: 612 tokens\nx-meter-amount: 0.00612 HBAR\nx-meter-body-sha256: 19a6bc…" },
  { title: "Check the budget", text: "The buyer's client compares the price with the limit they set. Nothing above it is signed.", http: "limit per call  0.01 HBAR\nthis call       0.00612 HBAR\n✓ within budget, signing" },
  { title: "Pay", text: "One x402 payment for exactly that amount, settled on chain by the facilitator.", http: "PAYMENT-SIGNATURE: eyJ4NDAy…\n→ settled 0.00612 HBAR\n  tx 0.0.7162784@1789247964…" },
  { title: "Receipt and proof", text: "The body is released with a receipt. The SDK re-hashes and re-meters it; a mismatch files a dispute.", http: "HTTP/1.1 200 OK\nx-mx402-receipt: …\nsha256 matches ✓  re-metered 612 ✓\nverified on the mirror node ✓" },
];

export function HowItWorks() {
  const ref = useRef<HTMLElement>(null);
  const [step, setStep] = useState(0);
  useSectionProgress(ref, (p) => {
    stage.step = p;
    const i = Math.min(STEPS.length - 1, Math.floor(p * STEPS.length));
    setStep((s) => (s === i ? s : i));
  });
  return (
    <section id="how" ref={ref} className="scene" data-stage="how" style={{ height: `${STEPS.length * 70 + 60}vh` }}>
      <div className="sticky">
        <div className="container how-grid">
          <div className="how-copy">
            <span className="eyebrow">How a call is paid</span>
            <h2>Metered first.<br />Paid exactly. Proven after.</h2>
            <ol className="steps">
              {STEPS.map((s, i) => (
                <li key={s.title} className={i === step ? "on" : i < step ? "done" : ""}>
                  <span className="num">{i < step ? "✓" : i + 1}</span>
                  <div><b>{s.title}</b><p>{s.text}</p></div>
                </li>
              ))}
            </ol>
          </div>
          <div className="how-visual">
            <div className="coin-space" aria-hidden="true" />
            <div className="http glass" aria-live="polite">
              <div className="http-head"><i /><i /><i /><span>step {step + 1} of {STEPS.length} · {STEPS[step].title}</span></div>
              <pre>{STEPS[step].http}</pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── 4. three chains (sticky) ─────────────────────────────────────────────
const CHAIN_PANELS = [
  { key: "hedera", name: "Hedera", tag: "HBAR and HTS tokens", points: ["Metered Tabs: an on-chain allowance is the spending limit, and streaming works", "Subscriptions as scheduled transactions the buyer can cancel", "HCS receipts and HCS-14 agent identity; every transfer checked on the mirror node"], proof: { label: "HCS receipt topic 0.0.10470327", href: "https://hashscan.io/testnet/topic/0.0.10470327" } },
  { key: "base", name: "Base Sepolia", tag: "USDC", points: ["EIP-3009 transferWithAuthorization: the buyer signs, the facilitator pays gas", "Verified from the USDC Transfer log, not the facilitator's word", "Live: 10 pools of Graph data for 0.0005 USDC"], proof: { label: "BaseScan 0x147cfe9b…", href: txUrl("0x147cfe9b10e4a6491d91a244fe53c9c4d9535077a86957156243b0bb9651bc64", "eip155:84532") } },
  { key: "solana", name: "Solana devnet", tag: "USDC", points: ["An SPL transfer with the facilitator as fee payer", "Verified from the seller's token balance change", "Live: 48 forecast hours for 0.00048 USDC"], proof: { label: "Solscan 51BkXpHw…", href: txUrl("51BkXpHwz3uoTNYcwNwRbLooM5oGHULHkLupbDU7J9RYDTdEqZaWJsoua7aQDaDWusCQHj4UDzhQn2JckX7xsLiL", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1") } },
];

export function Chains() {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  useSectionProgress(ref, (p) => {
    const i = Math.min(2, Math.floor(p * 3));
    stage.chainFocus = i;
    setActive((a) => (a === i ? a : i));
  });
  return (
    <section id="chains" ref={ref} className="scene" data-stage="chains" style={{ height: "280vh" }}>
      <div className="sticky">
        <div className="container chains-grid">
          <div className="chains-copy">
            <span className="eyebrow">Settlement</span>
            <h2>One payment path.<br />Three chains.</h2>
            <p className="muted">The gateway never talks to a chain directly. Each lane picks where it settles, and every payment is checked where it landed.</p>
            <div className="chain-tabs" role="tablist">
              {CHAIN_PANELS.map((c, i) => <span key={c.key} role="tab" aria-selected={i === active} className={i === active ? "on" : ""}>{c.name}</span>)}
            </div>
            <div className="chain-panel glass" key={CHAIN_PANELS[active].key}>
              <div className="cp-head"><b>{CHAIN_PANELS[active].name}</b><span>{CHAIN_PANELS[active].tag}</span></div>
              <ul>{CHAIN_PANELS[active].points.map((pt) => <li key={pt}>{pt}</li>)}</ul>
              <a href={CHAIN_PANELS[active].proof.href} target="_blank" rel="noopener">{CHAIN_PANELS[active].proof.label} ↗</a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── 5. onchain data ──────────────────────────────────────────────────────
const DATA_CARDS = [
  { tag: "The Graph", title: "DEX pools, everywhere", text: "One standardized query across 15 Messari subgraphs on 7+ chains: TVL, 24h volume, fee and fee APR in one shape. Priced per pool.", stat: "15 subgraphs" },
  { tag: "The Graph", title: "Lending markets", text: "Aave, Compound, Spark, Venus, Benqi and Radiant through a second standard: supply and borrow APY, deposits, utilization.", stat: "15 subgraphs" },
  { tag: "The Graph", title: "Any subgraph, per entity", text: "POST any GraphQL to any of 15,000+ subgraphs without a Graph key. Every object in the answer counts once; errors are free.", stat: "9 entities = 0.0009 HBAR" },
  { tag: "Uniswap", title: "Quotes and swaps", text: "Trading API quotes sold per call, and swap calldata built for your wallet: approval, Permit2 signature and transaction, never sent.", stat: "CLASSIC + UniswapX" },
];

export function Data() {
  return (
    <section id="data" className="section" data-stage="data">
      <div className="container data-grid">
        <div className="data-spacer" aria-hidden="true" />
        <div>
          <Eyebrow>Onchain data</Eyebrow>
          <h2 className="reveal">Live data from The Graph and Uniswap, sold by the row.</h2>
          <p className="reveal muted">Standardized subgraphs mean one query shape for many protocols, so a new chain is one line. When a standardized indexer fails, Uniswap's own subgraph answers, and the response says so.</p>
          <div className="cards">
            {DATA_CARDS.map((c) => (
              <article key={c.title} className="card glass reveal">
                <span className={`tag ${c.tag === "Uniswap" ? "uni" : "graph"}`}>{c.tag}</span>
                <h3>{c.title}</h3>
                <p>{c.text}</p>
                <b className="card-stat">{c.stat}</b>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── 6. agents ────────────────────────────────────────────────────────────
export function Agents() {
  return (
    <section id="agents" className="section" data-stage="agents">
      <div className="container split">
        <div>
          <Eyebrow>For AI agents</Eyebrow>
          <h2 className="reveal">An agent that pays for its own research.</h2>
          <p className="reveal">Ask the DEX analyst a question. It buys LLM tokens to plan, pools and lending rates from The Graph, a Uniswap quote, and tokens to answer. It says only what the paid data supports: a grounding filter cuts any number it did not buy.</p>
          <ol className="flow reveal">
            <li><b>Plan</b><span>LLM, per token</span></li>
            <li><b>Pools and rates</b><span>The Graph, per row</span></li>
            <li><b>Quote</b><span>Uniswap, per quote</span></li>
            <li><b>Answer</b><span>LLM, per token</span></li>
          </ol>
          <div className="cta-row reveal"><a className="btn primary" href={ANALYST}>Ask the DEX analyst</a></div>
        </div>
        <div className="agent-side">
          <div className="chips reveal">
            {[["MCP", "12 tools: npx mx402 mcp"], ["A2A", "every service has an agent card"], ["SDK", "quote, pay, verify in code"], ["Skill", "SKILL.md teaches when to buy"]].map(([k, v]) => (
              <div key={k} className="chip glass"><b>{k}</b><span>{v}</span></div>
            ))}
          </div>
          <pre className="code reveal">{`{
  "mcpServers": {
    "meterx402": {
      "command": "npx",
      "args": ["-y", "mx402", "mcp"],
      "env": { "BUYER_BUDGET": "1 HBAR" }
    }
  }
}`}</pre>
        </div>
      </div>
    </section>
  );
}

// ── 7. sellers ───────────────────────────────────────────────────────────
const TERMINAL = [
  ["$ ", "npx mx402 check https://api.open-meteo.com/v1/forecast"],
  ["✓ ", "200 in 1083ms, 0.8 KB back"],
  ["  ", "meter       rows:hourly.time  (24 items at hourly.time)"],
  ["  ", "rate        0.0002 HBAR / row  (minimum 0.0005)"],
  ["  ", "this call   24 rows    0.0048 HBAR"],
  ["  ", "2 days      48 rows    0.0096 HBAR"],
  ["  ", "flat, cap   96 rows    0.0192 HBAR  ← every call, without metering"],
  ["$ ", "npx mx402 https://api.open-meteo.com/v1/forecast --wallet 0.0.1234"],
  ["✓ ", "live, metered, listed in the registry"],
];

export function Sellers() {
  const ref = useRef<HTMLElement>(null);
  useSectionProgress(ref, (p) => ref.current?.style.setProperty("--p", p.toFixed(3)), "top 70%", "center 40%");
  return (
    <section id="sellers" ref={ref} className="section" data-stage="sellers">
      <div className="container split reverse">
        <div className="terminal glass" aria-label="mx402 in a terminal">
          <div className="http-head"><i /><i /><i /><span>terminal</span></div>
          <pre>
            {TERMINAL.map(([p, line], i) => (
              <span key={i} className="t-line" style={{ "--i": i } as React.CSSProperties}><em>{p}</em>{line}{"\n"}</span>
            ))}
          </pre>
        </div>
        <div>
          <Eyebrow>For API owners</Eyebrow>
          <h2 className="reveal">Sell any API with one command.</h2>
          <p className="reveal">No pricing flags: mx402 calls your API once and reads the meter from its own response. Get paid in HBAR, HTS tokens, or USDC on Base and Solana. Your upstream key never reaches a buyer.</p>
          <ul className="ticks reveal">
            <li>Datasets too: <code>mx402 data file.csv</code>, priced per cell</li>
            <li>Metered Tabs and subscriptions on Hedera</li>
            <li>A seller dashboard with every payment and its proof</li>
          </ul>
          <div className="cta-row reveal"><a className="btn primary" href={SELL}>Open the seller dashboard</a></div>
        </div>
      </div>
    </section>
  );
}

// ── 8. proof ─────────────────────────────────────────────────────────────
export function Proof() {
  const { receipts, titleFor } = useLive();
  const items = receipts.slice(0, 18);
  return (
    <section id="proof" className="section proof" data-stage="proof">
      <div className="container">
        <Eyebrow>Proof</Eyebrow>
        <h2 className="reveal">Every row here settled on chain.</h2>
        <div className="proof-cards">
          {[
            { k: "Solana devnet", v: "0.00048 USDC", s: "48 forecast hours", href: CHAIN_PANELS[2].proof.href },
            { k: "Base Sepolia", v: "0.0005 USDC", s: "10 DEX pools", href: CHAIN_PANELS[1].proof.href },
            { k: "Hedera testnet", v: "HCS receipts", s: "one per settled call", href: CHAIN_PANELS[0].proof.href },
            { k: "Tests", v: "219 passing", s: "164 unit + 55 end-to-end", href: REPO },
          ].map((c) => (
            <a key={c.k} className="proof-card glass reveal" href={c.href} target="_blank" rel="noopener"><span>{c.k}</span><b>{c.v}</b><em>{c.s} ↗</em></a>
          ))}
        </div>
      </div>
      {items.length > 0 && (
        <div className="marquee" aria-label="Recent payments">
          <div className="marquee-track">
            {[0, 1].map((copy) => (
              <div className="marquee-group" key={copy} aria-hidden={copy === 1}>
                {items.map((r) => (
                  <a key={`${copy}-${r.receipt_id}`} className="tick" href={r.transaction_id ? txUrl(r.transaction_id, r.network) : undefined} target="_blank" rel="noopener" tabIndex={copy === 1 ? -1 : undefined}>
                    <b>{titleFor(r.service_id)}</b><span>{Number(r.metered_units).toLocaleString("en-US")} {r.unit}</span><strong>{r.amount} {r.currency}</strong><em>{chainName(r.network)}</em>
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ── 9. get started ───────────────────────────────────────────────────────
export function FinalCta() {
  return (
    <section id="get-started" className="section final" data-stage="cta">
      <div className="container final-in">
        <h2 className="reveal">Stop paying for calls.<br /><span className="grad">Pay for what they return.</span></h2>
        <p className="reveal">Explore live services, try one in your browser, or connect your agent. Testnet only, nothing to install.</p>
        <div className="cta-row center reveal">
          <a className="btn primary lg" href={APP}>Get started</a>
          <a className="btn ghost lg" href={REPO} target="_blank" rel="noopener">Read the code</a>
        </div>
      </div>
    </section>
  );
}
