import { useEffect, useRef, useState, type ReactNode } from "react";
import { chainName, explorerName, txUrl, useLive, type Receipt } from "./data";
import { prefersReducedMotion, scrollToId } from "./scroll";
import { useTheme, type ThemePref } from "./theme";

export const APP = "/app#user";
export const SELL = "/app#deployer/apis";
export const ANALYST = "/app?ask=Where%20should%20USDC%20earn%20the%20most%3A%20lending%20or%20liquidity%20against%20ETH%3F#user/playground";
export const REPO = "https://github.com/clatsonhacks/meterx402";

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <span className="mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"><path d="m12 13.8 4.2-4.2" /><path d="M3.5 18.8a10 10 0 1 1 17 0" /></svg>
    </span>
  );
}

const THEMES: { pref: ThemePref; label: string; icon: ReactNode }[] = [
  { pref: "system", label: "Match my system", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 20.5h8" /></svg> },
  { pref: "light", label: "Light", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" /></svg> },
  { pref: "dark", label: "Dark", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z" /></svg> },
];

export function ThemeToggle() {
  const { pref, setPref } = useTheme();
  return (
    <div className="themetoggle" role="radiogroup" aria-label="Colour theme">
      {THEMES.map((t) => (
        <button key={t.pref} type="button" role="radio" aria-checked={pref === t.pref} title={t.label} onClick={() => setPref(t.pref)}>
          {t.icon}<span className="sr-only">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  const links: [string, string][] = [["how", "How it works"], ["chains", "Chains"], ["data", "Data"], ["agents", "Agents"], ["sellers", "Sellers"]];
  return (
    <header className={`nav ${scrolled ? "scrolled" : ""}`}>
      <div className="container nav-in">
        <a className="brand" href="/" aria-label="MeterX402 home"><Mark />MeterX402</a>
        <nav className="nav-links" aria-label="Sections">
          {links.map(([id, label]) => <button key={id} type="button" onClick={() => scrollToId(id)}>{label}</button>)}
        </nav>
        <div className="nav-right">
          <ThemeToggle />
          <a className="btn primary sm" href={APP}>Get started</a>
        </div>
      </div>
    </header>
  );
}

const EXAMPLE: Receipt = { receipt_id: "example", service_id: "llm", metered_units: 289, unit: "tokens", rate: "0.01", per: 1000, amount: "0.00289", currency: "HBAR", network: "hedera:testnet", transaction_id: null, settled_at: Date.now() };

function ago(t: number) {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const one = (u: string) => u.replace(/s$/, "");

/** A recent real payment, replayed: units and price count up, then the steps light. */
export function ReceiptCard() {
  const { receipts, titleFor } = useLive();
  const list = receipts.length ? receipts : [EXAMPLE];
  const [index, setIndex] = useState(0);
  const r = list[index % list.length];
  const units = useRef<HTMLElement>(null);
  const amount = useRef<HTMLElement>(null);
  const fill = useRef<HTMLElement>(null);
  const [lit, setLit] = useState(0);
  const hovering = useRef(false);

  useEffect(() => {
    const total = Number(r.metered_units) || 0, amt = Number(r.amount) || 0;
    const places = (String(r.amount).split(".")[1] ?? "").length;
    const show = (p: number) => {
      if (units.current) units.current.textContent = Math.round(total * p).toLocaleString("en-US");
      if (amount.current) amount.current.textContent = (amt * p).toFixed(places);
      if (fill.current) fill.current.style.width = `${p * 100}%`;
    };
    const timers: number[] = [];
    let raf = 0;
    if (prefersReducedMotion()) { show(1); setLit(4); }
    else {
      setLit(0);
      let start: number | null = null;
      const frame = (now: number) => {
        start ??= now;
        const t = Math.max(0, Math.min(1, (now - start) / 1500));
        show(1 - (1 - t) ** 3);
        if (t > 0.05) setLit((l) => Math.max(l, 1));
        if (t < 1) raf = requestAnimationFrame(frame);
        else [2, 3, 4].forEach((n, i) => timers.push(window.setTimeout(() => setLit(n), 380 * (i + 1))));
      };
      raf = requestAnimationFrame(frame);
    }
    const next = window.setInterval(() => { if (!hovering.current && !document.hidden) setIndex((i) => i + 1); }, 5600);
    return () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); clearInterval(next); };
  }, [r.receipt_id, index]);

  const unitLabel = Number(r.metered_units) === 1 ? one(r.unit) : r.unit;
  const steps = [
    ["Metered", "the call ran and was counted"],
    ["Quoted", "a 402 with the exact price"],
    ["Paid", "signed inside the limit"],
    ["Settled", null],
  ] as const;
  return (
    <div className="receipt glass" onMouseEnter={() => (hovering.current = true)} onMouseLeave={() => (hovering.current = false)} aria-label="A recent payment, replayed">
      <div className="rc-top">
        <div><b>{r.receipt_id === "example" ? "AI Chat" : titleFor(r.service_id)}</b><span>{r.receipt_id === "example" ? "how a call is paid" : ago(r.settled_at)} · {chainName(r.network)}</span></div>
        <em>{r.receipt_id === "example" ? "example" : <><i />real payment</>}</em>
      </div>
      <div className="rc-meter">
        <div><b ref={units}>0</b> <span>{unitLabel}</span></div>
        <div className="rc-price"><b ref={amount}>0</b> <span>{r.currency}</span></div>
      </div>
      <div className="rc-bar"><i ref={fill} /></div>
      <ol className="rc-steps">
        {steps.map(([title, text], i) => (
          <li key={title} className={lit > i ? "on" : ""}>
            <b>{title}</b>
            <span>{text ?? (r.transaction_id ? <a href={txUrl(r.transaction_id, r.network)} target="_blank" rel="noopener">{explorerName(r.network)} ↗</a> : "on a prepaid tab")}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="container foot-in">
        <div className="foot-brand"><Mark size={24} /><div><b>MeterX402</b><span>Usage-based x402 payments for APIs and AI agents.</span></div></div>
        <nav className="foot-links" aria-label="Project">
          <a href={APP}>Open the app</a>
          <a href={REPO} target="_blank" rel="noopener">GitHub</a>
          <a href={`${REPO}/blob/main/README.md`} target="_blank" rel="noopener">README</a>
          <a href={`${REPO}/blob/main/skills/meterx402-onchain-data/SKILL.md`} target="_blank" rel="noopener">Agent skill</a>
          <a href={`${REPO}/blob/main/FEEDBACK.md`} target="_blank" rel="noopener">Uniswap feedback</a>
        </nav>
        <div className="foot-note">Built at ETHOnline 2026 on Hedera, The Graph and Uniswap. Testnets only: no real money moves.</div>
      </div>
    </footer>
  );
}
