// Paper on the counter: a stack of folded newspapers and the paper towel under the plate. Built once at load in their own
// frames (y = 0 on the counter, one unit 25 cm).

import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import * as THREE from "three/webgpu";
import { lehmer } from "../../shared/engine/random";
import { PAGE } from "./prints";
import { surface } from "./surface";

// A broadsheet folded once: about 30 × 29 cm (the top half of its front page showing), a few millimetres thick, rounder
// and thicker at the fold. The fold runs along +z, toward the eye at the default view; the masthead is at -z.
export const SHEET = { w: 1.22, d: 1.16, thick: 0.015 };
// The texture's page fills the canvas's top rows; below them plain newsprint for the edges.
const PAGE_V = PAGE.h / 2048;

// Smooth value noise, enough for paper's gentle waves.
function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
export function noise2(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

// One folded paper, flat on y = 0, its top page's texture turned by `flip` (lower papers show other parts of the page at
// their edges). `curl` lifts its open far corner a little, as a read paper's does. Tag: 0 the printed faces, 1 the
// edges, where the many sheets show as fine lines.
function folded(seed: number, flip: boolean, curl: number, fine: boolean) {
  const { w, d, thick } = SHEET;
  // Finer for the top paper, whose corner curls; the ones under it are flat but for faint waves.
  const nu = fine && curl > 0 ? 40 : fine ? 16 : 12;
  const nv = fine && curl > 0 ? 36 : fine ? 14 : 10;
  // Thicker toward the fold; a faint wave over the sheet; the far corner's curl.
  const bulge = (z: number) => 0.78 + 0.22 * Math.pow(Math.max(0, (z / d + 0.5 - 0.6) / 0.4), 2);
  const wave = (x: number, z: number) => 0.0018 * noise2(x * 3 + seed, z * 3 - seed) + 0.0008 * noise2(x * 9 - seed, z * 7);
  const lift = (x: number, z: number) => curl * Math.pow(Math.max(0, (x / w + 0.5 - 0.62) / 0.38), 2) * Math.pow(Math.max(0, (0.38 - (z / d + 0.5)) / 0.38), 2);
  const top = (x: number, z: number) => thick * bulge(z) + wave(x, z) + lift(x, z);
  const bottom = (x: number, z: number) => Math.max(0, 0.6 * wave(x, z)) + lift(x, z);
  const texU = (x: number) => (flip ? 0.5 - x / w : x / w + 0.5);
  const texV = (z: number) => {
    const t = flip ? 0.5 - z / d : z / d + 0.5;
    return 1 - t * PAGE_V;
  };
  const parts: THREE.BufferGeometry[] = [];
  const up = () => new THREE.Vector3(0, 1, 0);
  const down = () => new THREE.Vector3(0, -1, 0);
  parts.push(
    surface(
      nu,
      nv,
      (i, j) => {
        const x = (i / nu - 0.5) * w;
        const z = (j / nv - 0.5) * d;
        return { p: [x, top(x, z), z], uv: [texU(x), texV(z)] };
      },
      up
    )
  );
  parts.push(
    surface(
      nu,
      nv,
      (i, j) => {
        const x = (i / nu - 0.5) * w;
        const z = (j / nv - 0.5) * d;
        return { p: [x, bottom(x, z), z], uv: [1 - texU(x), texV(z)] };
      },
      down
    )
  );
  // The fold: a half round from the bottom sheet up to the top along +z.
  const steps = fine ? 8 : 4;
  parts.push(
    surface(
      nu,
      steps,
      (i, j) => {
        const x = (i / nu - 0.5) * w;
        const z0 = d / 2;
        const lo = bottom(x, z0);
        const hi = top(x, z0);
        const r = (hi - lo) / 2;
        const a = -Math.PI / 2 + (j / steps) * Math.PI;
        return { p: [x, lo + r + Math.sin(a) * r, z0 + Math.cos(a) * r * 0.9], uv: [texU(x), 0.02], tag: 1 };
      },
      () => new THREE.Vector3(0, 0, 1)
    )
  );
  // The three open edges, where the sheets' edges show: straight up from the bottom sheet to the top.
  const edge = (from: [number, number], to: [number, number], out: [number, number]) =>
    surface(
      nu,
      2,
      (i, j) => {
        const x = from[0] + (to[0] - from[0]) * (i / nu);
        const z = from[1] + (to[1] - from[1]) * (i / nu);
        const y = bottom(x, z) + (top(x, z) - bottom(x, z)) * (j / 2);
        return { p: [x, y, z], uv: [i / nu, 0.02], tag: 1 };
      },
      () => new THREE.Vector3(out[0], 0, out[1])
    );
  parts.push(edge([-w / 2, -d / 2], [w / 2, -d / 2], [0, -1]));
  parts.push(edge([-w / 2, -d / 2], [-w / 2, d / 2], [-1, 0]));
  parts.push(edge([w / 2, -d / 2], [w / 2, d / 2], [1, 0]));
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

// Five papers, each a little turned and pushed off the one below, the top one with its headline toward the eye.
export function newspaperStack(fine: boolean) {
  const random = lehmer(4242);
  const papers: THREE.BufferGeometry[] = [];
  let y = 0;
  const count = 5;
  for (let k = 0; k < count; k++) {
    const last = k === count - 1;
    const g = folded(k * 7.3 + 1, !last && k % 2 === 0, last ? 0.05 : 0, fine);
    // Uneven: each turned a few degrees and pushed a centimetre or two; the second from the top turned the most.
    const turn = last ? 0.02 : (random() - 0.5) * (k === count - 2 ? 0.2 : 0.11);
    g.rotateY(turn);
    g.translate((random() - 0.5) * 0.07, y, (random() - 0.5) * 0.06);
    // Resting on the one below at its thickest (its fold), plus a hair for the waves.
    y += SHEET.thick * 1.02 + 0.0024;
    papers.push(g);
  }
  const g = mergeGeometries(papers);
  papers.forEach((p) => p.dispose());
  return { geometry: g, height: y };
}

// A kitchen paper towel folded in four under the plate: `thick` from the counter up, flat where the plate's floor rests
// on it, its corners outside the plate lifting a few millimetres as folded paper does. Its edges a strip all round.
// uv across the folded square; tag 1 on the edges.
export function foldedTowel(w: number, d: number, thick: number, fine: boolean) {
  const n = fine ? 48 : 20;
  const lift = (x: number, z: number) => {
    const r = Math.hypot(x, z);
    const out = Math.max(0, r - 0.4);
    return out * out * 0.12 + Math.max(0, r - 0.36) * 0.006 * (0.5 + 0.5 * noise2(x * 9, z * 9));
  };
  const top = (x: number, z: number) => thick + lift(x, z);
  const parts = [
    surface(
      n,
      n,
      (i, j) => {
        const x = (i / n - 0.5) * w;
        const z = (j / n - 0.5) * d;
        return { p: [x, top(x, z), z], uv: [i / n, j / n] };
      },
      () => new THREE.Vector3(0, 1, 0)
    ),
    surface(
      n,
      n,
      (i, j) => {
        const x = (i / n - 0.5) * w;
        const z = (j / n - 0.5) * d;
        return { p: [x, lift(x, z) * 0.9, z], uv: [i / n, j / n] };
      },
      () => new THREE.Vector3(0, -1, 0)
    )
  ];
  const edge = (from: [number, number], to: [number, number], out: [number, number]) =>
    surface(
      n,
      1,
      (i, j) => {
        const x = from[0] + (to[0] - from[0]) * (i / n);
        const z = from[1] + (to[1] - from[1]) * (i / n);
        return { p: [x, j ? top(x, z) : lift(x, z) * 0.9, z], uv: [i / n, 0], tag: 1 };
      },
      () => new THREE.Vector3(out[0], 0, out[1])
    );
  parts.push(
    edge([-w / 2, -d / 2], [w / 2, -d / 2], [0, -1]),
    edge([-w / 2, d / 2], [w / 2, d / 2], [0, 1]),
    edge([-w / 2, -d / 2], [-w / 2, d / 2], [-1, 0]),
    edge([w / 2, -d / 2], [w / 2, d / 2], [1, 0])
  );
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}
