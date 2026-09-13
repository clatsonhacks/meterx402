// Precompute the globe's land dots once, so the browser never does map maths.
//
//   npm run land     → public/land-dots.bin (Int16 pairs: lat×100, lon×100)
//
// A Fibonacci lattice covers the sphere evenly; each point is kept if it falls
// on land in Natural Earth's 110m outlines (world-atlas).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { feature } from "topojson-client";
import { geoContains } from "d3-geo";

const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve("world-atlas/land-110m.json"), "utf8"));
const land = feature(topo, topo.objects.land);

const N = 42000;
const out = [];
for (let i = 0; i < N; i++) {
  const y = 1 - ((i + 0.5) / N) * 2;
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  const lat = (Math.asin(y) * 180) / Math.PI;
  const lon = ((((phi * 180) / Math.PI) % 360) + 540) % 360 - 180;
  if (geoContains(land, [lon, lat])) out.push(Math.round(lat * 100), Math.round(lon * 100));
}

mkdirSync("public", { recursive: true });
const bytes = Buffer.from(new Int16Array(out).buffer);
writeFileSync("public/land-dots.bin", bytes);
console.log(`${out.length / 2} land dots → public/land-dots.bin (${(bytes.length / 1024).toFixed(1)} KB)`);
