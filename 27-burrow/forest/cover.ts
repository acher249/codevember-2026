import * as THREE from "three/webgpu";
import { faceZ } from "../field";
import { forestTrees } from "./layout";
import { clearingEdge, forestGround, noise, PATH } from "./terrain";

// What covers the floor where, worked out once on a grid over the clearing and the near wood, so the floor's colour
// (floor.ts reads it as a texture) and the growth placed on it (plants.ts, cover.ts's callers read it here) agree:
// grass where the sun reaches, thinning into last year's leaves under the crowns; the damp along the cliff's foot; and
// the trodden way from where you start to the face.
//
//   grass  0..1  how thick the grass grows (sun, drifts, minus the trodden way and the scree at the foot)
//   shade  0..1  how closed the canopy is overhead (the trees' crowns splatted onto the floor)
//   damp   0..1  the wet ground along the face's foot and in hollows, where moss takes over
//   path   0..1  how trodden: 1 down the middle of the way, 0 a metre or so off it

const N = 256;
export const COVER = { x0: -50, z0: -8, span: 102 };

type Grid = {
  grass: Float32Array;
  shade: Float32Array;
  damp: Float32Array;
  path: Float32Array;
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The way you walk: from where you start (index.tsx START, terrain.ts `PATH`) to the face, wandering a little either
// side of the straight line the growth keeps clear of (terrain.ts `onPath`).
export function trodden(x: number, z: number) {
  if (z > PATH.z0 + 1.5) return 0;
  const line = 0.6 + noise(z * 0.13, 4.2) * 0.55 + noise(z * 0.5, 9.1) * 0.12;
  const width = 0.55 + noise(z * 0.21, 1.7) * 0.2;
  const d = Math.abs(x - line);
  // Fading out where you first stand, and close under the face where the scree takes over.
  return (1 - smooth(width, width + 0.9, d)) * (1 - smooth(PATH.z0 - 1, PATH.z0 + 1.5, z)) * smooth(0.4, 1.8, z);
}

let grid: Grid | null = null;
function build(): Grid {
  const size = N * N;
  const g: Grid = {
    grass: new Float32Array(size),
    shade: new Float32Array(size),
    damp: new Float32Array(size),
    path: new Float32Array(size)
  };
  const step = COVER.span / N;
  // The crowns, splatted: each tree's crown a soft disc of shade, a little wider for the taller ones.
  const { trees, saplings } = forestTrees();
  const splat = (x: number, z: number, r: number, w: number) => {
    const i0 = Math.max(0, Math.floor((x - r * 2 - COVER.x0) / step));
    const i1 = Math.min(N - 1, Math.ceil((x + r * 2 - COVER.x0) / step));
    const j0 = Math.max(0, Math.floor((z - r * 2 - COVER.z0) / step));
    const j1 = Math.min(N - 1, Math.ceil((z + r * 2 - COVER.z0) / step));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const dx = COVER.x0 + (i + 0.5) * step - x;
        const dz = COVER.z0 + (j + 0.5) * step - z;
        g.shade[j * N + i] += w * Math.exp(-(dx * dx + dz * dz) / (r * r));
      }
  };
  for (const t of trees) splat(t.x, t.z, 2 + t.height * 0.1, 0.26);
  for (const t of saplings) splat(t.x, t.z, 1.3, 0.2);
  // The floor's height once per texel; the damp's look round each texel reads it rather than working the ground out
  // five times over (a third of the load's time in this grid).
  const height = new Float32Array(size);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) height[j * N + i] = forestGround(COVER.x0 + (i + 0.5) * step, COVER.z0 + (j + 0.5) * step);
  for (let j = 0; j < N; j++) {
    const z = COVER.z0 + (j + 0.5) * step;
    for (let i = 0; i < N; i++) {
      const x = COVER.x0 + (i + 0.5) * step;
      const k = j * N + i;
      const shade = Math.min(1, g.shade[k]);
      g.shade[k] = shade;
      const edge = clearingEdge(x, z);
      // From the face's foot (negative behind it, on the cliff).
      const h = height[k];
      const fromFace = z < 12 ? z - faceZ(x, h + 1) : 12;
      // Sun on the floor: all of the clearing, and the gaps between crowns.
      const light = Math.max(1 - smooth(-3, 4, edge), 1 - shade * 1.25);
      const drift = noise(x * 0.11 + 3.1, z * 0.11 - 7.4) * 0.6 + noise(x * 0.37, z * 0.37 + 5) * 0.3;
      const path = trodden(x, z);
      g.path[k] = path;
      // Grit and sand at the face's foot, then grass from a couple of metres out.
      const foot = smooth(0.6, 3, fromFace);
      g.grass[k] = Math.min(1, Math.max(0, light * 1.15 + drift * 0.5 - 0.12)) * (1 - path * 0.9) * foot;
      // Damp: along the foot, and in the floor's hollows (lower than the ground a couple of metres round).
      const around = (sample(height, x + 2.2, z) + sample(height, x - 2.2, z) + sample(height, x, z + 2.2) + sample(height, x, z - 2.2)) / 4;
      g.damp[k] = Math.min(1, 1 - smooth(0.3, 3.5, fromFace) + Math.max(0, around - h) * 3.5);
    }
  }
  return g;
}
const cover = () => (grid ??= build());

function sample(field: Float32Array, x: number, z: number) {
  const fx = Math.min(N - 1.001, Math.max(0, (x - COVER.x0) / (COVER.span / N) - 0.5));
  const fz = Math.min(N - 1.001, Math.max(0, (z - COVER.z0) / (COVER.span / N) - 0.5));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const k = j * N + i;
  return (field[k] * (1 - u) + field[k + 1] * u) * (1 - v) + (field[k + N] * (1 - u) + field[k + N + 1] * u) * v;
}

export const grassAt = (x: number, z: number) => sample(cover().grass, x, z);
export const shadeAt = (x: number, z: number) => sample(cover().shade, x, z);
export const dampAt = (x: number, z: number) => sample(cover().damp, x, z);
export const pathAt = (x: number, z: number) => sample(cover().path, x, z);

// The same grid as a texture (r grass, g shade, b damp, a path), read at texel centres with linear filtering so the
// floor's blend lands where the samplers above say.
let map: THREE.DataTexture | null = null;
export function coverTexture() {
  if (map) return map;
  const g = cover();
  const data = new Uint8Array(N * N * 4);
  for (let k = 0; k < N * N; k++) {
    data[k * 4] = Math.round(g.grass[k] * 255);
    data[k * 4 + 1] = Math.round(g.shade[k] * 255);
    data[k * 4 + 2] = Math.round(g.damp[k] * 255);
    data[k * 4 + 3] = Math.round(g.path[k] * 255);
  }
  map = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.magFilter = map.minFilter = THREE.LinearFilter;
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  map.generateMipmaps = false;
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  return map;
}
