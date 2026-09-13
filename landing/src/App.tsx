import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CHAINS } from "./chains";
import { Footer, Nav } from "./components";
import { LiveProvider, useLive } from "./data";
import { useScrollScenes } from "./scroll";
import { Agents, Chains, Data, FinalCta, Hero, HowItWorks, Problem, Proof, Sellers } from "./sections";
import { useTheme } from "./theme";

// Three.js and the scene arrive as their own chunk, after first paint
const Scene = lazy(() => import("./three/Scene"));

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function Page() {
  const { mode } = useTheme();
  const { receipts } = useLive();
  const hedera = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLDivElement>(null);
  const solana = useRef<HTMLDivElement>(null);
  const labels = [hedera, base, solana];
  const [load3d, setLoad3d] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!webglAvailable()) return;
    const go = () => setLoad3d(true);
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 1200 });
    else setTimeout(go, 250);
  }, []);

  useScrollScenes();

  return (
    <>
      <div className={`stage ${ready ? "ready" : ""}`} aria-hidden="true">
        <div className="stage-poster" />
        {load3d && (
          <Suspense fallback={null}>
            <Scene mode={mode} receipts={receipts} labels={labels} onReady={() => setReady(true)} />
          </Suspense>
        )}
        <div className="chain-labels">
          {CHAINS.map((c, i) => (
            <div key={c.key} ref={labels[i]} className="chain-label">
              <i style={{ background: c.dot }} />{c.label}<small>{c.unit}</small>
            </div>
          ))}
        </div>
      </div>
      <Nav />
      <main>
        <Hero />
        <Problem />
        <HowItWorks />
        <Chains />
        <Data />
        <Agents />
        <Sellers />
        <Proof />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}

export function App() {
  return (
    <LiveProvider>
      <Page />
    </LiveProvider>
  );
}
