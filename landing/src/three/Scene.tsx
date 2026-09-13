// The one WebGL canvas behind the landing page: the payment globe, an x402
// coin and a ring of subgraphs. Loaded lazily as its own chunk. Scroll never
// re-renders React here: the frame loop eases towards targets in `stage`.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { CHAINS, CITIES } from "../chains";
import { chainOf, type Receipt } from "../data";
import { prefersReducedMotion, stage } from "../scroll";
import type { ThemeMode } from "../theme";

interface SceneProps {
  mode: ThemeMode;
  receipts: Receipt[];
  labels: RefObject<HTMLDivElement | null>[];
  onReady?: () => void;
}

const PALETTE = {
  // Claude light: ivory paper, oat shading, warm grey ink, a clay accent
  light: { edge: "#e3dfd2", center: "#fdfcf8", rim: "#d97757", rimAmt: 0.2, dots: "#a19e94", halo: "#d97757", haloAmt: 0.13, arcStart: "#b3ab9c", coin: "#d97757", glow: "#c6613f", face: "#faf9f5", faceInk: "#141413", paid: "#6b8a4e", ring: "#cdc8ba", light: "#f3c3ae" },
  dark: { edge: "#0d0d14", center: "#272638", rim: "#6f7bff", rimAmt: 0.55, dots: "#8986a6", halo: "#6d74ff", haloAmt: 0.36, arcStart: "#6f8bff", coin: "#8f86ff", glow: "#4c3fd6", face: "#1d1c2c", faceInk: "#dcd9ff", paid: "#3ccf93", ring: "#45445c", light: "#8f86ff" },
} as const;

const RING_COLORS = {
  light: ["#d97757", "#788c5d", "#6a9bcc", "#c46686", "#d4a27f", "#9e9bbf"],
  dark: ["#6f4cff", "#ff007a", "#2ebac6", "#00d395", "#f5a524", "#4c6ef5"],
};

const toVec = (lat: number, lon: number, r = 1) => {
  const a = THREE.MathUtils.degToRad(lat), b = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(r * Math.cos(a) * Math.sin(b), r * Math.sin(a), r * Math.cos(a) * Math.cos(b));
};

let glowTexture: THREE.CanvasTexture | null = null;
function glowTex() {
  if (glowTexture) return glowTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

const hash = (s: string) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
const FALLBACK_NETWORKS = ["hedera:testnet", "eip155:84532", "solana:devnet", "hedera:testnet", "eip155:84532", "solana:devnet", "hedera:testnet", "eip155:84532"];

const SPHERE_VS = /* glsl */ `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SPHERE_FS = /* glsl */ `
  uniform vec3 uEdge; uniform vec3 uCenter; uniform vec3 uRim; uniform float uRimAmt; uniform float uAlpha; varying vec3 vN;
  void main(){
    float f = clamp(dot(vN, vec3(0.0, 0.0, 1.0)), 0.0, 1.0);
    vec3 base = mix(uEdge, uCenter, pow(f, 0.55));
    float l = clamp(dot(vN, normalize(vec3(-0.45, 0.55, 0.75))), 0.0, 1.0);
    base *= 0.94 + 0.06 * l;
    gl_FragColor = vec4(mix(base, uRim, pow(1.0 - f, 3.2) * uRimAmt), uAlpha);
  }`;
const HALO_FS = /* glsl */ `
  uniform vec3 uColor; uniform float uAmt; varying vec3 vN;
  void main(){ float i = pow(clamp(0.72 - dot(vN, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 2.4); gl_FragColor = vec4(uColor, i * uAmt); }`;

function useLand() {
  const [land, setLand] = useState<Int16Array | null>(null);
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}land-dots.bin`).then((r) => r.arrayBuffer()).then((b) => setLand(new Int16Array(b))).catch(() => setLand(new Int16Array(0)));
  }, []);
  return land;
}

function Rig({ mode, receipts, labels, onReady }: SceneProps) {
  const { camera, size, invalidate } = useThree();
  const reduced = useMemo(prefersReducedMotion, []);
  const land = useLand();
  const globe = useRef<THREE.Group>(null!);
  const coin = useRef<THREE.Group>(null!);
  const coinFlip = useRef<THREE.Group>(null!);
  const ring = useRef<THREE.Group>(null!);
  const cur = useRef({ x: 0.47, y: 0, scale: 1, opacity: 1, coin: 0, ring: 0, spin: 0.62, tilt: 0.32, flip: 0, halo: PALETTE[mode].haloAmt as number });
  const ready = useRef(false);

  // ── materials whose colours follow the theme ──
  // start in the current theme's colours; later switches ease across
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const P0 = useMemo(() => PALETTE[mode], []);

  // The globe fades per material (not the whole canvas) so the coin and ring
  // stay crisp. The sphere draws first and writes depth, hiding the far side.
  const sphereMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: SPHERE_VS, fragmentShader: SPHERE_FS, transparent: true,
    uniforms: { uEdge: { value: new THREE.Color(P0.edge) }, uCenter: { value: new THREE.Color(P0.center) }, uRim: { value: new THREE.Color(P0.rim) }, uRimAmt: { value: P0.rimAmt }, uAlpha: { value: 1 } },
  }), []);
  const haloMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: SPHERE_VS, fragmentShader: HALO_FS, side: THREE.BackSide, transparent: true, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color(P0.halo) }, uAmt: { value: P0.haloAmt } },
  }), []);
  const dotMat = useMemo(() => new THREE.MeshBasicMaterial({ color: P0.dots, side: THREE.DoubleSide, transparent: true }), []);
  const coinMat = useMemo(() => new THREE.MeshStandardMaterial({ color: P0.coin, metalness: 0.4, roughness: 0.32, emissive: new THREE.Color(P0.glow), emissiveIntensity: 0 }), []);
  const lastFade = useRef(-1);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ color: P0.ring, transparent: true, opacity: 0.6 }), []);
  const boxMat = useMemo(() => new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.45 }), []);

  // ── land dots, built once the precomputed file arrives ──
  const dots = useMemo(() => {
    if (!land || land.length === 0) return null;
    const n = land.length / 2;
    const mesh = new THREE.InstancedMesh(new THREE.CircleGeometry(0.0066, 8), dotMat, n);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      dummy.position.copy(toVec(land[i * 2] / 100, land[i * 2 + 1] / 100, 1.001));
      dummy.lookAt(dummy.position.clone().multiplyScalar(2));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }, [land, dotMat]);

  // ── arcs and comets from real receipts ──
  const receiptKey = receipts.slice(0, 10).map((r) => r.receipt_id).join(",");
  const arcs = useMemo(() => {
    const list = receipts.length
      ? receipts.slice(0, 10).map((r) => ({ id: r.receipt_id, network: r.network }))
      : FALLBACK_NETWORKS.map((network, i) => ({ id: `example-${i}`, network }));
    return list.map((r, i) => {
      const chain = CHAINS.find((c) => c.key === chainOf(r.network))!;
      const from = CITIES[hash(r.id) % CITIES.length];
      const a = toVec(from[0], from[1], 1.004), b = toVec(chain.at[0], chain.at[1], 1.004);
      const mid = a.clone().add(b).multiplyScalar(0.5).normalize().multiplyScalar(1 + a.distanceTo(b) * 0.42);
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const seg = 72, rad = 6;
      const geo = new THREE.TubeGeometry(curve, seg, 0.0042, rad, false);
      const colors = new Float32Array((seg + 1) * (rad + 1) * 3);
      const glow = mode === "light" ? chain.glowLight : chain.glow;
      const s = new THREE.Color(PALETTE[mode].arcStart), e = new THREE.Color(glow);
      for (let u = 0; u <= seg; u++) {
        const c = s.clone().lerp(e, u / seg);
        for (let v = 0; v <= rad; v++) { const k = (u * (rad + 1) + v) * 3; colors[k] = c.r; colors[k + 1] = c.g; colors[k + 2] = c.b; }
      }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      return { key: `${r.id}-${i}`, curve, geo, glow, from: a, phase: (i * 0.29) % 1 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptKey, mode]);
  useEffect(() => () => arcs.forEach((a) => a.geo.dispose()), [arcs]);
  const arcMat = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }), []);
  const cometRefs = useRef<(THREE.Group | null)[]>([]);

  const nodeLocal = useMemo(() => CHAINS.map((c) => toVec(c.at[0], c.at[1], 1.012)), []);
  const coreRefs = useRef<(THREE.Mesh | null)[]>([]);

  // ── coin faces, drawn per theme: the quote on the front, "paid" on the back ──
  const faces = useMemo(() => {
    const p = PALETTE[mode];
    const draw = (paid: boolean) => {
      const c = document.createElement("canvas");
      c.width = c.height = 512;
      const g = c.getContext("2d")!;
      const ink = paid ? p.paid : p.coin;
      g.fillStyle = p.face; g.beginPath(); g.arc(256, 256, 256, 0, Math.PI * 2); g.fill();
      g.strokeStyle = ink; g.lineWidth = 12; g.beginPath(); g.arc(256, 256, 218, 0, Math.PI * 2); g.stroke();
      g.textAlign = "center"; g.textBaseline = "middle";
      if (paid) {
        g.strokeStyle = p.paid; g.lineWidth = 26; g.lineCap = "round"; g.lineJoin = "round";
        g.beginPath(); g.moveTo(196, 170); g.lineTo(242, 214); g.lineTo(322, 128); g.stroke();
        g.fillStyle = p.faceInk; g.font = "800 112px 'Inter Tight', system-ui, sans-serif"; g.fillText("PAID", 256, 300);
        g.fillStyle = p.paid; g.font = "600 34px 'Inter Tight', system-ui, sans-serif"; g.fillText("0.00612 HBAR", 256, 380);
      } else {
        g.fillStyle = p.faceInk; g.font = "800 150px 'Inter Tight', system-ui, sans-serif"; g.fillText("x402", 256, 236);
        g.fillStyle = p.coin; g.font = "600 34px 'Inter Tight', system-ui, sans-serif"; g.fillText("612 TOKENS", 256, 340);
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    };
    return { front: draw(false), back: draw(true) };
  }, [mode]);
  useEffect(() => () => { faces.front.dispose(); faces.back.dispose(); }, [faces]);
  useEffect(() => { lastFade.current = -1; }, [arcs, dots, mode]);

  const ringCount = 30;
  const ringBoxes = useMemo(() => {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.085, 0.085, 0.085), boxMat, ringCount);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (let i = 0; i < ringCount; i++) {
      const a = (i / ringCount) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * 1.28, Math.sin(a * 3) * 0.05, Math.sin(a) * 1.28);
      dummy.rotation.set(a, a * 2, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.set(RING_COLORS[mode][i % RING_COLORS[mode].length]));
    }
    return mesh;
  }, [boxMat, mode]);
  useEffect(() => () => { ringBoxes.geometry.dispose(); ringBoxes.dispose(); }, [ringBoxes]);

  // keep rendering on demand when motion is reduced
  useEffect(() => {
    if (!reduced) return;
    const f = () => invalidate();
    window.addEventListener("scroll", f, { passive: true });
    const t = setInterval(f, 400);
    return () => { window.removeEventListener("scroll", f); clearInterval(t); };
  }, [reduced, invalidate]);

  const tmp = useMemo(() => ({ v: new THREE.Vector3(), n: new THREE.Vector3(), c: new THREE.Vector3(), col: new THREE.Color() }), []);

  useFrame((state, dt) => {
    const t = stage.target;
    const d = Math.min(dt, 0.05);
    const k = 1 - Math.pow(0.0015, d);
    const narrow = size.width < 900;
    // phones stack everything in one column: the globe sits above the hero copy
    // and returns as the closing horizon, and never sits behind text
    const tx = narrow ? 0 : t.x;
    const ty = narrow ? (t.key === "hero" ? 0.42 : t.key === "cta" ? -1.5 : t.y) : t.y;
    const topacity = narrow ? (t.key === "hero" ? 1 : t.key === "cta" ? 0.7 : 0) : t.opacity;
    const tscale = narrow ? (t.key === "hero" ? 0.85 : t.key === "cta" ? 2.6 : t.scale) : t.scale;
    const c = cur.current;
    c.x += (tx - c.x) * k; c.y += (ty - c.y) * k;
    c.scale += (tscale - c.scale) * k;
    // fade out quicker than it moves, so it never lingers behind content
    c.opacity += (topacity - c.opacity) * (topacity < c.opacity ? 1 - Math.pow(0.00005, d) : k);
    c.coin += ((narrow ? 0 : t.coin) - c.coin) * k;
    c.ring += (t.ring - c.ring) * k;

    // viewport in world units at z = 0
    const cam = camera as THREE.PerspectiveCamera;
    const h = 2 * cam.position.z * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const w = h * (size.width / size.height);
    const R = Math.min(w, h) * 0.31 * c.scale;
    globe.current.position.set(c.x * (w / 2), c.y * (h / 2), 0);
    globe.current.scale.setScalar(R);

    // rotation: a slow spin, or turn to face a chain
    const focus = t.focusChain >= 0 ? stage.chainFocus : -1;
    if (focus >= 0) {
      const spot = CHAINS[focus];
      const targetY = -THREE.MathUtils.degToRad(spot.at[1]);
      let delta = targetY - c.spin;
      delta = ((((delta + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
      c.spin += delta * k;
      c.tilt += (THREE.MathUtils.degToRad(spot.at[0]) * 0.7 - c.tilt) * k;
    } else {
      if (!reduced) c.spin += d * 0.07 * t.spin;
      c.tilt += (0.32 - c.tilt) * k;
    }
    globe.current.rotation.set(c.tilt, c.spin, 0);

    // theme: ease every colour towards the palette
    const p = PALETTE[mode];
    const e = 1 - Math.pow(0.02, d);
    (sphereMat.uniforms.uEdge.value as THREE.Color).lerp(tmp.col.set(p.edge), e);
    (sphereMat.uniforms.uCenter.value as THREE.Color).lerp(tmp.col.set(p.center), e);
    (sphereMat.uniforms.uRim.value as THREE.Color).lerp(tmp.col.set(p.rim), e);
    sphereMat.uniforms.uRimAmt.value += (p.rimAmt - sphereMat.uniforms.uRimAmt.value) * e;
    (haloMat.uniforms.uColor.value as THREE.Color).lerp(tmp.col.set(p.halo), e);
    const fade = Math.min(1, c.opacity);
    c.halo += (p.haloAmt - c.halo) * e;
    haloMat.uniforms.uAmt.value = c.halo * fade;
    if (Math.abs(fade - lastFade.current) > 0.003) {
      lastFade.current = fade;
      sphereMat.uniforms.uAlpha.value = fade;
      globe.current.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (!m || m === sphereMat || m === haloMat) return;
        m.userData.base ??= m.opacity;
        m.opacity = m.userData.base * fade;
      });
    }
    globe.current.visible = fade > 0.01;
    dotMat.color.lerp(tmp.col.set(p.dots), e);
    coinMat.color.lerp(tmp.col.set(p.coin), e);
    ringMat.color.lerp(tmp.col.set(p.ring), e);

    // comets travel their arcs, then rest a moment
    const time = reduced ? 0.55 : state.clock.elapsedTime;
    arcs.forEach((arc, i) => {
      const g = cometRefs.current[i];
      if (!g) return;
      const u = ((time * 0.32 + arc.phase) % 1.35);
      const visible = u <= 1;
      g.visible = visible;
      if (!visible) return;
      g.children.forEach((child, j) => {
        const tt = Math.max(0, u - j * 0.022);
        child.position.copy(arc.curve.getPoint(tt));
      });
    });
    CHAINS.forEach((_, i) => {
      const core = coreRefs.current[i];
      if (core) core.scale.setScalar(focus === i ? 1.35 + Math.sin(state.clock.elapsedTime * 4) * 0.12 : 1);
    });

    // the coin: beside the steps, flips when the payment is signed
    const stepIndex = Math.min(4, Math.floor(stage.step * 5));
    coin.current.visible = c.coin > 0.01;
    ring.current.visible = c.ring > 0.01;
    coin.current.position.set(w * 0.25, h * 0.17, 0.4);
    coin.current.scale.setScalar(Math.max(0.0001, c.coin) * Math.min(w, h) * 0.15);
    coin.current.rotation.y = reduced ? 0 : Math.sin(state.clock.elapsedTime * 0.8) * 0.35;
    const flipTarget = stepIndex >= 3 ? Math.PI : 0;
    c.flip += (flipTarget - c.flip) * (1 - Math.pow(0.004, d));
    coinFlip.current.rotation.y = c.flip;
    coinMat.emissive.lerp(tmp.col.set(p.glow), e);
    coinMat.emissiveIntensity += ((stepIndex === 4 ? 0.5 : 0) - coinMat.emissiveIntensity) * k;

    // the subgraph ring orbits the globe
    ring.current.position.copy(globe.current.position);
    ring.current.scale.setScalar(Math.max(0.0001, c.ring) * R);
    ring.current.rotation.set(0.42, reduced ? 0.6 : state.clock.elapsedTime * 0.18, 0.18);

    // HTML chain labels follow their nodes
    globe.current.updateMatrixWorld();
    // labels only where the globe is the subject, never over the copy
    const labelFade = Math.max(0, Math.min(1, (c.opacity - 0.75) / 0.2));
    CHAINS.forEach((_, i) => {
      const el = labels[i]?.current;
      if (!el) return;
      tmp.v.copy(nodeLocal[i]).applyMatrix4(globe.current.matrixWorld);
      tmp.n.copy(tmp.v).sub(globe.current.position).normalize();
      tmp.c.copy(cam.position).sub(tmp.v).normalize();
      const facing = tmp.n.dot(tmp.c);
      tmp.v.project(cam);
      const sx = ((tmp.v.x + 1) / 2) * size.width, sy = ((1 - tmp.v.y) / 2) * size.height;
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, calc(-100% - 14px))`;
      const show = narrow || c.scale < 0.6 ? 0 : Math.max(0, Math.min(1, (facing - 0.2) * 4)) * labelFade;
      el.style.opacity = show.toFixed(3);
      el.classList.toggle("on", focus === i);
    });

    if (!ready.current && dots) { ready.current = true; onReady?.(); }
  });

  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[3, 4, 5]} intensity={1.7} />
      <pointLight position={[-3, -2, 3]} intensity={6} distance={12} color={PALETTE[mode].light} />

      <group ref={globe}>
        <mesh material={sphereMat} renderOrder={-1}><sphereGeometry args={[0.995, 96, 96]} /></mesh>
        <mesh material={haloMat} scale={1.1} renderOrder={10}><sphereGeometry args={[1, 64, 64]} /></mesh>
        {dots && <primitive object={dots} />}

        {arcs.map((arc, i) => (
          <group key={arc.key}>
            <mesh geometry={arc.geo} material={arcMat} />
            <mesh position={arc.from}><sphereGeometry args={[0.012, 12, 12]} /><meshBasicMaterial color={PALETTE[mode].arcStart} transparent /></mesh>
            <group ref={(g) => { cometRefs.current[i] = g; }}>
              {Array.from({ length: 7 }, (_, j) => (
                <sprite key={j} scale={j === 0 ? 0.13 : 0.075 - j * 0.007}>
                  <spriteMaterial map={glowTex()} color={arc.glow} transparent opacity={j === 0 ? 0.95 : 0.7 - j * 0.09} depthWrite={false} />
                </sprite>
              ))}
            </group>
          </group>
        ))}

        {CHAINS.map((c, i) => (
          <group key={c.key} position={nodeLocal[i]}>
            {/* userData.base: the unfaded opacity, since it changes with the theme */}
            <sprite scale={0.3}><spriteMaterial map={glowTex()} color={mode === "light" ? c.glowLight : c.glow} transparent opacity={mode === "light" ? 0.3 : 0.5} userData={{ base: mode === "light" ? 0.3 : 0.5 }} depthWrite={false} /></sprite>
            <sprite scale={0.13}><spriteMaterial map={glowTex()} color={mode === "light" ? c.glowLight : c.glow} transparent opacity={mode === "light" ? 0.65 : 0.9} userData={{ base: mode === "light" ? 0.65 : 0.9 }} depthWrite={false} /></sprite>
            <mesh ref={(m) => { coreRefs.current[i] = m; }}><sphereGeometry args={[0.024, 20, 20]} /><meshBasicMaterial color={mode === "dark" ? c.coreDark : c.core} transparent /></mesh>
          </group>
        ))}
      </group>

      <group ref={coin}>
        <group ref={coinFlip}>
          <mesh material={coinMat} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[1, 1, 0.16, 64]} /></mesh>
          <mesh material={coinMat} position={[0, 0, 0.06]}><torusGeometry args={[0.96, 0.05, 16, 64]} /></mesh>
          <mesh material={coinMat} position={[0, 0, -0.06]}><torusGeometry args={[0.96, 0.05, 16, 64]} /></mesh>
          <mesh position={[0, 0, 0.082]}><circleGeometry args={[0.9, 64]} /><meshBasicMaterial map={faces.front} toneMapped={false} /></mesh>
          <mesh position={[0, 0, -0.082]} rotation={[0, Math.PI, 0]}><circleGeometry args={[0.9, 64]} /><meshBasicMaterial map={faces.back} toneMapped={false} /></mesh>
        </group>
      </group>

      <group ref={ring}>
        <mesh material={ringMat} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[1.28, 0.004, 8, 160]} /></mesh>
        <primitive object={ringBoxes} />
      </group>
    </>
  );
}

export default function Scene(props: SceneProps) {
  const reduced = useMemo(prefersReducedMotion, []);
  const [loop, setLoop] = useState<"always" | "demand" | "never">(reduced ? "demand" : "always");
  useEffect(() => {
    // stop drawing entirely while the tab is hidden
    const onVis = () => setLoop(document.hidden ? "never" : reduced ? "demand" : "always");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [reduced]);
  return (
    <Canvas
      className="stage-canvas"
      dpr={[1, 1.75]}
      frameloop={loop}
      camera={{ fov: 30, position: [0, 0, 7], near: 0.1, far: 50 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
    >
      <Rig {...props} />
    </Canvas>
  );
}
