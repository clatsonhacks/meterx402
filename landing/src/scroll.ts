// Scroll: Lenis smooths it, GSAP ScrollTrigger reads it. The 3D scene does not
// re-render React on scroll: sections write targets into this plain store and
// the scene's frame loop eases towards them.

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { useLayoutEffect, type RefObject } from "react";

gsap.registerPlugin(ScrollTrigger);

export type StageKey = "hero" | "problem" | "how" | "chains" | "data" | "agents" | "sellers" | "wallet" | "proof" | "cta";

export interface StageTarget {
  key: StageKey;
  /** globe centre, as a fraction of half the viewport (−1 left … 1 right) */
  x: number;
  y: number;
  scale: number;
  opacity: number;
  spin: number;
  coin: number;
  ring: number;
  focusChain: number;
}

// The globe only shows where the layout leaves it an empty column (hero,
// chains, data, the closing horizon). Where cards fill the width it fades out
// entirely, drifting towards where it reappears, and stops drawing.
export const TARGETS: Record<StageKey, StageTarget> = {
  hero: { key: "hero", x: 0.47, y: -0.02, scale: 1, opacity: 1, spin: 1, coin: 0, ring: 0, focusChain: -1 },
  problem: { key: "problem", x: 0.95, y: 0, scale: 0.8, opacity: 0, spin: 1, coin: 0, ring: 0, focusChain: -1 },
  how: { key: "how", x: 0.95, y: 0, scale: 0.8, opacity: 0, spin: 0.6, coin: 1, ring: 0, focusChain: -1 },
  chains: { key: "chains", x: 0.47, y: -0.02, scale: 0.98, opacity: 1, spin: 0, coin: 0, ring: 0, focusChain: 0 },
  data: { key: "data", x: -0.66, y: 0, scale: 0.7, opacity: 1, spin: 0.8, coin: 0, ring: 1, focusChain: -1 },
  agents: { key: "agents", x: -0.95, y: 0, scale: 0.7, opacity: 0, spin: 1, coin: 0, ring: 0, focusChain: -1 },
  sellers: { key: "sellers", x: 0, y: -1.62, scale: 2, opacity: 0, spin: 1, coin: 0, ring: 0, focusChain: -1 },
  wallet: { key: "wallet", x: 0, y: -1.62, scale: 2, opacity: 0, spin: 1, coin: 0, ring: 0, focusChain: -1 },
  proof: { key: "proof", x: 0, y: -1.62, scale: 2, opacity: 0, spin: 1, coin: 0, ring: 0, focusChain: -1 },
  cta: { key: "cta", x: 0, y: -1.62, scale: 2, opacity: 0.8, spin: 1, coin: 0, ring: 0, focusChain: -1 },
};

/** `chainFocus` is written by the Chains section; the globe turns to it while `target.focusChain` ≥ 0. */
export const stage = { target: { ...TARGETS.hero }, step: 0, chainFocus: 0 };

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let lenis: Lenis | null = null;

export function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  if (lenis) lenis.scrollTo(el, { offset: -70 });
  else el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

/** Smooth scrolling, stage targets per section, and reveal-on-scroll. */
export function useScrollScenes() {
  useLayoutEffect(() => {
    const reduced = prefersReducedMotion();
    const raf = (time: number) => lenis?.raf(time * 1000);
    if (!reduced) {
      lenis = new Lenis({ lerp: 0.1 });
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add(raf);
      gsap.ticker.lagSmoothing(0);
    }
    const ctx = gsap.context(() => {
      document.querySelectorAll<HTMLElement>("[data-stage]").forEach((el) => {
        const key = el.dataset.stage as StageKey;
        ScrollTrigger.create({
          trigger: el,
          // the closing horizon rises only once the proof cards have scrolled away
          start: key === "cta" ? "top 40%" : "top 60%",
          end: "bottom 40%",
          onToggle: (self) => {
            if (self.isActive) stage.target = { ...TARGETS[key] };
          },
        });
      });
      if (reduced) gsap.set(".reveal", { opacity: 1, y: 0 });
      else ScrollTrigger.batch(".reveal", {
        start: "top 88%",
        onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, duration: 0.9, ease: "power3.out", stagger: 0.07, overwrite: true }),
      });
    });
    const refresh = () => ScrollTrigger.refresh();
    window.addEventListener("load", refresh);
    document.fonts?.ready.then(refresh);
    return () => {
      ctx.revert();
      window.removeEventListener("load", refresh);
      if (lenis) { gsap.ticker.remove(raf); lenis.destroy(); lenis = null; }
    };
  }, []);
}

/** 0 → 1 while a (tall, sticky) section scrolls past. */
export function useSectionProgress(ref: RefObject<HTMLElement | null>, onProgress: (p: number) => void, start = "top top", end = "bottom bottom") {
  useLayoutEffect(() => {
    if (!ref.current) return;
    const st = ScrollTrigger.create({ trigger: ref.current, start, end, onUpdate: (self) => onProgress(self.progress) });
    onProgress(st.progress);
    return () => st.kill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
