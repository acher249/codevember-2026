/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, clamp, exp, float, floor, fract, max, mix, normalLocal, positionLocal, positionWorld, sin, smoothstep, step, texture, transformNormalToView, uniform, vec2, vec3 } from "three/tsl";
import { type Drawing, type Scans, SLAB, footprint, shadeFor, specks, wakeAt, wobble } from "../drawings";

// A jagged crack splits the sidewalk open over a chasm of molten rock. Under the paving it opens out into a cavern,
// undercut and running away from the artist far beneath the sidewalk, its walls laid down in ledges of old flows, with
// a lake of lava at its foot: crusted plates of black rock adrift on it, glowing in every seam. As chalk it is
// perfectly still; once real the lava churns and flows toward the artist, its crust cracks open and glows brighter,
// embers rise out of the crack and the heat pulses on the walls.

// Textures this drawing loads for itself, by name: given to `build` once loaded. `colour` for colour maps.
export const textures: Record<string, { url: string; colour?: boolean }> = {
  rock: { url: "/assets/26-anamorph/lava/dark_rock_02_diff_2k.jpg", colour: true },
  rockNormal: { url: "/assets/26-anamorph/lava/dark_rock_02_nor_gl_2k.jpg" }
};

// The crack runs away from the artist from its near tip to its far one; the lava's surface is this far down.
const NEAR = 0.45;
const FAR = -5.0;
const LAVA = -2.0;
// How much the cavern opens out with depth: lengthening away from the artist, and widening to each side.
const LENGTHEN = 0.75;
const WIDEN = 0.15;
// Points down each side of the crack (dense, so the outline matches the per-pixel test in `inside` to a millimetre).
const PER_SIDE = 560;
// Rings of the rock from the slab down to the lava (taking every other point round the outline: the rock needs depth
// more than it needs the outline's millimetres).
const ROCK_RINGS = 56;

// The crust's plates and the lava's slow churning, worked out once on the processor and laid on as small textures
// that repeat (cheaper on the graphics card than working out cells and noise for every pixel, every frame). The crust
// repeats every CRUST metres of the flow, with PLATES plates across and CRAZE cells of fine crazing; the churn every
// four of its own units.
const CRUST = 4.2;
const PLATES = 8;
const CRAZE = 26;
const CRUST_SIZE = 512;
const CHURN_SIZE = 128;

// The crack's shape as a function of z, the same on the processor (the outline) and per pixel (`inside`): a wandering
// middle line, a width that swells in the middle and closes to a point at each tip, and each side broken into straight
// jagged runs (a triangle wave and straight lines between random heights, so the outline between points is straight).
// The random heights come from a hash of small whole numbers that the graphics card works out exactly as here.
type Ops<T> = { sin: (v: T) => T; abs: (v: T) => T; fract: (v: T) => T; floor: (v: T) => T; pow: (v: T, e: number) => T; max0: (v: T) => T; add: (a: T, b: T) => T; mul: (a: T, b: number | T) => T; num: (n: number) => T };
function shape<T>(o: Ops<T>, z: T) {
  const lin = (k: number, c: number) => o.add(o.mul(z, k), o.num(c));
  const tri = (k: number, c: number) => o.add(o.mul(o.abs(o.add(o.fract(lin(k, c)), o.num(-0.5))), 2), o.num(-0.5));
  const hash = (i: T) => o.fract(o.add(o.add(o.mul(o.mul(i, i), 0.1031), o.mul(i, 0.6180339)), o.num(0.31)));
  const broken = (k: number, c: number) => {
    const v = lin(k, c);
    const i = o.floor(v);
    const a = hash(i);
    return o.add(o.add(a, o.mul(o.add(hash(o.add(i, o.num(1))), o.mul(a, -1)), o.add(v, o.mul(i, -1)))), o.num(-0.5));
  };
  const along = o.mul(o.add(o.num(NEAR), o.mul(z, -1)), 1 / (NEAR - FAR));
  const envelope = o.pow(o.max0(o.sin(o.mul(along, Math.PI))), 0.6);
  const centre = o.add(o.mul(o.sin(lin(0.85, 0.6)), 0.16), o.mul(o.sin(lin(2.2, 1.3)), 0.06));
  const swell = o.add(o.num(0.55), o.mul(o.sin(lin(1.4, 0.2)), 0.1));
  const jagLeft = o.add(o.add(o.mul(tri(2.3, 0.31), 0.12), o.mul(broken(6.1, 0.77), 0.08)), o.add(o.mul(broken(15.3, 0.13), 0.035), o.mul(broken(37.1, 0.4), 0.012)));
  const jagRight = o.add(o.add(o.mul(tri(2.1, 0.58), 0.12), o.mul(broken(5.7, 40.21), 0.08)), o.add(o.mul(broken(14.1, 70.49), 0.035), o.mul(broken(35.3, 90.66), 0.012)));
  const rough = o.pow(envelope, 0.5);
  return { centre, left: o.mul(envelope, o.add(swell, o.mul(jagLeft, rough))), right: o.mul(envelope, o.add(swell, o.mul(jagRight, rough))) };
}
const cpu: Ops<number> = { sin: Math.sin, abs: Math.abs, fract: (v) => v - Math.floor(v), floor: Math.floor, pow: Math.pow, max0: (v) => Math.max(0, v), add: (a, b) => a + b, mul: (a, b) => a * b, num: (n) => n };
const gpu: Ops<any> = { sin, abs, fract, floor, pow: (v, e) => v.pow(e), max0: (v) => max(v, 0), add: (a, b) => a.add(b), mul: (a, b) => a.mul(b), num: (n) => float(n) };

// A random number 0 to 1 for a pair of whole numbers and a seed.
const hash = (i: number, j: number, seed: number) => {
  const v = Math.sin(i * 127.1 + j * 311.7 + seed * 74.7) * 43758.5453;
  return v - Math.floor(v);
};

// A smooth random field, -1 to 1, that repeats every `cells` grid squares, laid out over a square of `size` points
// (octaves of it, each twice as fine and half as strong).
function fractal(size: number, cells: number, octaves: number, seed: number) {
  const out = new Float32Array(size * size);
  for (let o = 0; o < octaves; o++) {
    const m = cells << o;
    const lattice = new Float32Array(m * m);
    for (let k = 0; k < m * m; k++) lattice[k] = hash(k % m, Math.floor(k / m), seed + o * 13) * 2 - 1;
    const weight = 1 / (1 << o) / 1.6;
    for (let y = 0; y < size; y++) {
      const fy = (y * m) / size;
      const j = Math.floor(fy);
      const ty = (fy - j) * (fy - j) * (3 - 2 * (fy - j));
      const j0 = j * m;
      const j1 = ((j + 1) % m) * m;
      for (let x = 0; x < size; x++) {
        const fx = (x * m) / size;
        const i = Math.floor(fx);
        const tx = (fx - i) * (fx - i) * (3 - 2 * (fx - i));
        const i1 = (i + 1) % m;
        const a = lattice[j0 + i] + (lattice[j0 + i1] - lattice[j0 + i]) * tx;
        const b = lattice[j1 + i] + (lattice[j1 + i1] - lattice[j1 + i]) * tx;
        out[y * size + x] += (a + (b - a) * ty) * weight;
      }
    }
  }
  return out;
}

// The crust: the width of the seam between plates (red, kept fine near nothing, where it matters), how far from its
// plate's middle a point lies (green), the fine crazing on each plate (blue) and each plate's own random number
// (alpha), each from the nearest and next nearest of a cell's jittered points. The seams are bent a little (by a field
// laid out at a quarter of the size and stretched), so the plates break along ragged lines rather than ruled ones.
// (Worked out at every point: the seams are only a few points wide, and stretched from fewer they draw as ladders.)
function crustTexture() {
  const data = new Uint8Array(CRUST_SIZE * CRUST_SIZE * 4);
  const small = CRUST_SIZE / 4;
  const stretch = (f: Float32Array) => {
    const into = new Float32Array(CRUST_SIZE * CRUST_SIZE);
    for (let y = 0; y < CRUST_SIZE; y++) {
      const j = y >> 2;
      const ty = (y & 3) / 4;
      const j1 = (j + 1) % small;
      for (let x = 0; x < CRUST_SIZE; x++) {
        const i = x >> 2;
        const tx = (x & 3) / 4;
        const i1 = (i + 1) % small;
        const a = f[j * small + i] + (f[j * small + i1] - f[j * small + i]) * tx;
        const c = f[j1 * small + i] + (f[j1 * small + i1] - f[j1 * small + i]) * tx;
        into[y * CRUST_SIZE + x] = a + (c - a) * ty;
      }
    }
    return into;
  };
  const bendX = stretch(fractal(small, 4, 3, 21));
  const bendY = stretch(fractal(small, 4, 3, 37));
  const layer = (n: number, seed: number, bend: number, channel: number, range: number, withMiddle: boolean) => {
    const points = new Float32Array(n * n * 3);
    for (let k = 0; k < n * n; k++) for (let c = 0; c < 3; c++) points[k * 3 + c] = hash(k % n, Math.floor(k / n), seed + c);
    const wrap = Int32Array.from({ length: 3 * n + 3 }, (_, i) => i % n);
    for (let y = 0; y < CRUST_SIZE; y++)
      for (let x = 0; x < CRUST_SIZE; x++) {
        const at = y * CRUST_SIZE + x;
        const px = (x / CRUST_SIZE) * n + bendX[at] * bend + n;
        const py = (y / CRUST_SIZE) * n + bendY[at] * bend + n;
        const i0 = Math.floor(px);
        const j0 = Math.floor(py);
        let near = 9;
        let next = 9;
        let id = 0;
        for (let j = j0 - 1; j <= j0 + 1; j++) {
          const row = wrap[j] * n;
          for (let i = i0 - 1; i <= i0 + 1; i++) {
            const k = (row + wrap[i]) * 3;
            const dx = px - i - points[k];
            const dy = py - j - points[k + 1];
            const d = dx * dx + dy * dy;
            if (d < near) {
              next = near;
              near = d;
              id = points[k + 2];
            } else if (d < next) next = d;
          }
        }
        near = Math.sqrt(near);
        data[at * 4 + channel] = Math.round(Math.sqrt(Math.min(1, (Math.sqrt(next) - near) / range)) * 255);
        if (withMiddle) {
          data[at * 4 + 1] = Math.round(Math.min(1, near) * 255);
          data[at * 4 + 3] = Math.round(id * 255);
        }
      }
  };
  layer(PLATES, 3, 0.22, 0, 0.6, true);
  layer(CRAZE, 9, 0.6, 2, 0.5, false);
  return data;
}

// The churn: four unrelated smooth random fields, -1 to 1 (kept to about the spread of the noise they stand in for).
function churnTexture() {
  const data = new Uint8Array(CHURN_SIZE * CHURN_SIZE * 4);
  [51, 63, 77, 89].forEach((seed, c) => {
    const values = fractal(CHURN_SIZE, 4, 4, seed);
    let spread = 0;
    for (let k = 0; k < values.length; k++) spread += values[k] * values[k];
    const scale = 0.3 / Math.sqrt(spread / values.length);
    for (let k = 0; k < values.length; k++) data[k * 4 + c] = Math.round(THREE.MathUtils.clamp(values[k] * scale * 0.5 + 0.5, 0, 1) * 255);
  });
  return data;
}

// Worked out on the first build only (they come out the same every time).
let baked: { crust: Uint8Array; churn: Uint8Array } | null = null;

function repeating(data: Uint8Array, size: number) {
  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  return map;
}

// The crack's outline, its walls and the lake at their foot: the same every time, so worked out on the first build
// only and kept (each build lays its own meshes over the same arrays).
let made: ReturnType<typeof carve> | undefined;
function carve() {
  // The outline: down the left side from the near tip to the far one, back up the right.
  const sides: { z: number; side: number }[] = [];
  for (let k = 0; k <= PER_SIDE; k++) sides.push({ z: NEAR + (FAR - NEAR) * (k / PER_SIDE), side: -1 });
  for (let k = PER_SIDE - 1; k >= 1; k--) sides.push({ z: NEAR + (FAR - NEAR) * (k / PER_SIDE), side: 1 });
  const shapes = sides.map(({ z }) => shape(cpu, z));
  const edge = sides.map(({ z, side }, k) => [shapes[k].centre + (side < 0 ? -shapes[k].left : shapes[k].right), z]);

  // The walls: straight down through the slab's cut edge, then rock that opens out into the cavern, lengthening away
  // from the artist and widening to the sides, broken and bulging.
  const n = edge.length;
  // Where the slab broke, the fracture runs in under the paving at a slant: its foot juts into the crack by up to a few
  // centimetres, more in some runs along the edge than others, and its face is rough. The top stays on the outline.
  const chipAt = (k: number, d: number) => {
    const { z, side } = sides[k % n];
    const v = z * 22 + (side < 0 ? 0 : 57);
    const i = Math.floor(v);
    const run = hash(i, 0, 5) + (hash(i + 1, 0, 5) - hash(i, 0, 5)) * (v - i);
    const down = Math.min(1, d / SLAB);
    return down * (0.005 + 0.018 * run * run) + Math.sin(Math.PI * down) * 0.004 * wobble(z * 41, d * 90, side * 3);
  };
  // A point of the wall, `depth` down at point `k` round the outline, written into `into` at `at`. Under the lava the
  // wall drops straight down (opening out there, it would lie so near level that the lava's troughs showed it through).
  const point = (k: number, depth: number, into: Float32Array | number[], at: number) => {
    const d = Math.min(depth, -LAVA);
    const { z, side } = sides[k % n];
    const s = shapes[k % n];
    const below = Math.max(0, d - SLAB);
    const rock = THREE.MathUtils.smoothstep(d, SLAB, SLAB + 0.5);
    const zz = NEAR + (z - NEAR) * (1 + LENGTHEN * below);
    // Under the slab the soil has fallen away a little; lower down the rock bulges and breaks, laid down in ledges (old
    // flows, each jutting out at its foot and undercut beneath it, more in some places than others; worn away where the
    // lava laps, so no shelf of them lies along its surface), and faceted.
    let bulge = THREE.MathUtils.smoothstep(d, SLAB, SLAB + 0.06) * 0.05;
    if (rock > 0) {
      const swell = wobble(zz * 0.9, d * 0.8, side);
      const layer = d * 2.9 + 0.35 * wobble(zz * 0.35, 0.3, side * 2);
      const within = layer - Math.floor(layer);
      const ledge = (within < 0.86 ? Math.pow(within / 0.86, 1.6) : (1 - within) / 0.14) * (0.45 + 0.55 * hash(Math.floor(layer), side, 11)) * (0.6 + 0.4 * swell) * (1 - THREE.MathUtils.smoothstep(d, -LAVA - 0.3, -LAVA + 0.05));
      bulge += rock * (0.22 * swell + 0.1 * wobble(zz * 2.6, d * 2.4, side * 3) + 0.04 * wobble(zz * 7, d * 6, side * 5) + 0.065 * ledge + 0.03 * Math.abs(wobble(zz * 4.3, d * 3.9, side * 7)));
    }
    const out = (side < 0 ? s.left : s.right) + WIDEN * below + Math.max(-0.05, bulge) - (d <= SLAB ? chipAt(k, d) : 0);
    into[at] = s.centre + side * out;
    into[at + 1] = -depth;
    into[at + 2] = zz;
  };
  // The slab's cut edge, at every point round the outline; its foot meets the rock, which takes every other point
  // (the points between laid on the straight line between theirs, so the two meet without a gap). The rock stops a
  // little under the lava: nothing below it is ever seen.
  const FOOT = SLAB + 0.03;
  const slabDepths = [0, 0.035, SLAB * 0.5, SLAB - 0.01, SLAB, FOOT];
  const rockDepths = [FOOT];
  for (let j = 1; j <= ROCK_RINGS; j++) rockDepths.push(FOOT + (-LAVA - FOOT) * Math.pow(j / ROCK_RINGS, 1.35));
  rockDepths.push(-LAVA + 0.25);
  const all = n + 1;
  const half = n / 2 + 1;
  const positions = new Float32Array((slabDepths.length * all + rockDepths.length * half) * 3);
  const uvs = new Float32Array((positions.length / 3) * 2);
  const index: number[] = [];
  const pair = [0, 0, 0, 0, 0, 0];
  let v = 0;
  const band = (rows: number, row: number) => {
    const first = v - rows * row;
    for (let j = 0; j < rows - 1; j++)
      for (let c = 0; c < row - 1; c++) {
        const a = first + j * row + c;
        index.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
  };
  slabDepths.forEach((d) => {
    for (let k = 0; k < all; k++, v++) {
      if (d < FOOT || k % 2 === 0) point(k, d, positions, v * 3);
      else {
        point(k - 1, d, pair, 0);
        point(k + 1, d, pair, 3);
        for (let c = 0; c < 3; c++) positions[v * 3 + c] = (pair[c] + pair[c + 3]) / 2;
      }
      uvs[v * 2] = k / n;
      uvs[v * 2 + 1] = d;
    }
  });
  band(slabDepths.length, all);
  const rockStart = v;
  rockDepths.forEach((d) => {
    for (let k = 0; k < all; k += 2, v++) {
      point(k, d, positions, v * 3);
      uvs[v * 2] = k / n;
      uvs[v * 2 + 1] = d;
    }
  });
  band(rockDepths.length, half);
  const walls = new THREE.BufferGeometry();
  walls.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  walls.setIndex(index);
  walls.computeVertexNormals();
  // Faces into the crack: a point on the left wall partway down should face +x; turn the winding if it does not.
  {
    const at = rockStart + half * Math.floor(rockDepths.length / 2) + Math.floor(PER_SIDE / 4);
    if (walls.getAttribute("normal").getX(at) < 0) {
      for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
      walls.setIndex(index);
      walls.computeVertexNormals();
    }
  }

  // The walls where they meet the lava (the rock's ring at its depth), each side's points in order away from the artist.
  const atLava = rockStart + ROCK_RINGS * half;
  const lakeWalls = [
    Array.from({ length: PER_SIDE / 2 + 1 }, (_, c) => atLava + c),
    Array.from({ length: half - PER_SIDE / 2 }, (_, c) => atLava + PER_SIDE / 2 + c)
  ].map((list) => list.map((i) => ({ x: positions[i * 3], z: positions[i * 3 + 2] })).sort((a, b) => a.z - b.z));
  const wallAt = (list: { x: number; z: number }[], z: number) => {
    if (z < list[0].z || z > list[list.length - 1].z) return NaN;
    let lo = 0;
    let hi = list.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (list[mid].z < z) lo = mid;
      else hi = mid;
    }
    const f = (z - list[lo].z) / Math.max(1e-6, list[hi].z - list[lo].z);
    return list[lo].x + (list[hi].x - list[lo].x) * f;
  };
  let [x0, x1, z0] = [Infinity, -Infinity, Infinity];
  lakeWalls.flat().forEach(({ x, z }) => ([x0, x1, z0] = [Math.min(x0, x), Math.max(x1, x), Math.min(z0, z)]));
  [x0, x1, z0] = [x0 - 0.1, x1 + 0.1, z0 - 0.1];
  const z1 = NEAR + 0.25;
  // The crust's rise and fall changes over no less than a few centimetres (see `lift`), so the mesh needs no finer;
  // its sharper edges are in the light. Coarser away from the artist, where it is only seen from afar.
  const rows: number[] = [];
  for (let z = z1; z > z0; z -= 0.034 + 0.07 * (1 - THREE.MathUtils.smoothstep(z, -9, -2.5))) rows.push(z);
  rows.push(z0);
  const across = Math.ceil((x1 - x0) / 0.036);
  const lakePositions = new Float32Array(rows.length * (across + 1) * 3);
  // How far from the walls each point lies: as they are, and smoothed along the lake (the walls are jagged from one
  // row to the next, which the melt and crust kept off them would show as steps).
  const shore = new Float32Array(rows.length * (across + 1) * 2);
  const banks = (z: number) => {
    const [a, b] = [wallAt(lakeWalls[0], z), wallAt(lakeWalls[1], z)];
    return Number.isNaN(a + b) ? null : [Math.min(a, b), Math.max(a, b)];
  };
  rows.forEach((z, j) => {
    const walls = banks(z);
    const near = [-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15].map((dz) => banks(z + dz)).filter((w) => w !== null);
    const [left, right] = near.reduce((sum, w) => [sum[0] + w[0] / near.length, sum[1] + w[1] / near.length], [0, 0]);
    for (let i = 0; i <= across; i++) {
      const at = j * (across + 1) + i;
      const x = x0 + ((x1 - x0) * i) / across;
      lakePositions.set([x, LAVA, z], at * 3);
      shore[at * 2] = walls ? Math.max(0, Math.min(x - walls[0], walls[1] - x)) : 0;
      shore[at * 2 + 1] = walls ? Math.max(0, Math.min(x - left, right - x)) : 0;
    }
  });
  // Wound counter-clockwise seen from above, so they face up.
  const lakeIndex: number[] = [];
  for (let j = 0; j < rows.length - 1; j++)
    for (let i = 0; i < across; i++) {
      const a = j * (across + 1) + i;
      lakeIndex.push(a, a + 1, a + across + 1, a + 1, a + across + 2, a + across + 1);
    }
  return {
    edge,
    wall: { position: positions, uv: uvs, normal: walls.getAttribute("normal").array as Float32Array, index: Uint32Array.from(index) },
    lake: { position: lakePositions, normal: new Float32Array(lakePositions.length).map((_, c) => (c % 3 === 1 ? 1 : 0)), shore, index: Uint32Array.from(lakeIndex) }
  };
}

export function build(scans: Scans, extra: Record<string, THREE.Texture>): Drawing {
  const real = new THREE.Group();
  const time = uniform(0);
  const wake = uniform(0);
  // How far the lava has flowed, and how the heat swells and ebbs.
  const drift = uniform(0);
  const pulse = uniform(1);
  baked ??= { crust: crustTexture(), churn: churnTexture() };
  const crustMap = repeating(baked.crust, CRUST_SIZE);
  const churnMap = repeating(baked.churn, CHURN_SIZE);
  // The churn at a point (in units of its smallest swells), -1 to 1 in each of its four fields.
  const churn = (at: any) => texture(churnMap, at.mul(0.25)).mul(2).sub(1);

  made ??= carve();
  const edge = made.edge.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const meshOf = (arrays: Record<string, Float32Array | Uint32Array>) => {
    const geometry = new THREE.BufferGeometry();
    Object.entries(arrays).forEach(([name, array]) => (name === "index" ? geometry.setIndex(new THREE.BufferAttribute(array, 1)) : geometry.setAttribute(name, new THREE.BufferAttribute(array, name === "uv" || name === "shore" ? 2 : 3))));
    return geometry;
  };
  const wallGeometry = meshOf(made.wall);

  // The rock, laid on from three sides (the cavern stretches it too far for one set of coordinates), darkening with
  // depth away from the daylight and glowing hot toward the lava.
  const y = positionWorld.y;
  const p = positionLocal;
  const weights = abs(normalLocal).pow(4);
  const blend = weights.div(weights.x.add(weights.y).add(weights.z));
  const TILE = 1 / 2.1;
  const onX = p.zy.mul(TILE);
  const onY = p.xz.mul(TILE);
  const onZ = p.xy.mul(TILE);
  const rockColour = texture(extra.rock, onX).rgb.mul(blend.x).add(texture(extra.rock, onY).rgb.mul(blend.y)).add(texture(extra.rock, onZ).rgb.mul(blend.z));
  const bumps = (at: any) => texture(extra.rockNormal, at).xy.mul(2).sub(1);
  const bx = bumps(onX);
  const by = bumps(onY);
  const bz = bumps(onZ);
  const rockNormal = normalLocal.add(vec3(0, bx.y, bx.x).mul(blend.x)).add(vec3(by.x, 0, by.y).mul(blend.y)).add(vec3(bz.x, bz.y, 0).mul(blend.z)).normalize();
  // The slab's cut edge: concrete, its grain running round the crack, the broken face pitted with its stones and
  // scorched toward its underside by the heat.
  const lip = smoothstep(-SLAB - 0.02, -SLAB, y);
  const stones = smoothstep(0.05, 0.16, rockColour.r).mul(0.45).add(0.7);
  const scorch = mix(float(1), float(0.7), smoothstep(-0.06, -SLAB, y));
  const slabColour = texture(scans.slab, vec2(p.x.add(p.z), p.y.mul(3)).mul(0.5)).rgb.mul(stones).mul(scorch).mul(0.9);
  const soil = vec3(0.075, 0.06, 0.05).mul(rockColour.r.mul(3).add(0.5));
  const earthy = mix(rockColour.mul(1.3), soil, smoothstep(-0.9, -0.35, y));
  const wallMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  wallMaterial.colorNode = mix(earthy.mul(mix(float(0.05), float(1), clamp(exp(y.mul(1.3)), 0, 1))), slabColour, lip);
  wallMaterial.normalNode = transformNormalToView(mix(rockNormal, normalLocal.add(rockNormal.sub(normalLocal).mul(0.35)).normalize(), lip));
  // The heat on the walls: strongest just over the lava and on rock that faces down onto it, flickering in patches and
  // swelling with the lava's pulse; the deepest seams in the rock glow on their own.
  // (No higher below the lava's surface than at it: rock under the surface glows no hotter than its rim.)
  const rise = max(y.sub(LAVA), 0);
  // Glowing fumes hang over the lake: the further a look travels through the cavern's air, and the lower, the more of
  // their orange light it gathers.
  const fumes = (rise: any) => float(1).sub(exp(positionWorld.sub(cameraPosition).length().mul(-0.07))).mul(exp(rise.mul(-0.9))).mul(smoothstep(-0.2, -0.9, positionWorld.y)).mul(vec3(0.22, 0.05, 0.009)).mul(pulse);
  // The glow over the lake reaching a point from beside it, half a metre up over the middle of the lake: how squarely
  // the surface faces it, falling off with distance.
  const fromLake = (normal: any) => {
    const to = vec3(0, LAVA + 0.5, positionLocal.z).sub(positionLocal);
    return max(normal.dot(to.normalize()), 0).div(to.dot(to).mul(1.5).add(1));
  };
  const facing = clamp(rockNormal.y.mul(-0.6).add(0.55), 0.15, 1);
  const flicker = churn(vec2(p.x.mul(1.3).add(time.mul(0.11)), p.z.mul(0.5).sub(time.mul(0.07)))).x.mul(wake.mul(0.35)).add(1);
  const heat = exp(rise.mul(-1.6)).mul(facing).mul(flicker).mul(pulse);
  const lum = rockColour.r.add(rockColour.g);
  const seam = float(1).sub(smoothstep(0.03, 0.09, lum)).mul(exp(rise.mul(-3)));
  // A rim of rock right at the lava's edge, red hot where the melt laps it.
  const lapping = exp(rise.mul(-14)).mul(smoothstep(0.02, 0.14, lum).mul(0.6).add(0.4));
  // (Light from the lava, as the rock's own colour lit orange: no lamps, which would light the street round it too and
  // cost every pixel a pass through each. Most of it takes in every wall at once; the rest comes from the glow over
  // the lake beside it (`fromLake`), picking out the ledges, the rock's grain and the slab's broken face.)
  wallMaterial.emissiveNode = rockColour
    .mul(vec3(6.5, 1.9, 0.5))
    .mul(heat)
    .add(vec3(2.4, 0.5, 0.05).mul(seam.add(lapping).mul(pulse)))
    .mul(float(1).sub(lip))
    .add(mix(earthy, slabColour.mul(0.5), lip).mul(vec3(2.4, 0.7, 0.18)).mul(fromLake(rockNormal)).mul(pulse))
    .add(fumes(rise));
  const wall = new THREE.Mesh(wallGeometry, wallMaterial);
  wall.receiveShadow = true;
  real.add(wall);

  // The lava: a lake across the cavern floor from wall to wall, its crust broken into plates adrift on it. Hot where it
  // is molten (a channel down the middle and pools here and there) and in every seam between plates. Finer near the
  // artist, where it is looked at closest; each point knows how far it is from the walls (`shore`), where the crust
  // piles up against the rock.
  const lavaGeometry = meshOf(made.lake);

  const banked = attribute<"vec2">("shore").x;
  const banks = attribute<"vec2">("shore").y;
  const nearWall = exp(banks.div(0.22).negate());
  const q = positionLocal.xz.sub(vec2(0, drift));
  const warp = churn(q.mul(0.5).add(vec2(time.mul(0.04), time.mul(-0.03)))).xy.mul(0.7);
  const flow = q.add(warp);
  // Plates of crust, broken into smaller ones and those crazed finer still (all from the baked crust).
  const crustAt = (at: any) => texture(crustMap, at.div(CRUST));
  const plates = crustAt(flow);
  const seamWidth = plates.r.mul(plates.r).mul(0.6);
  // Each plate's own random number, settled only away from its seams: across a seam the baked number jumps from one
  // plate's to the next within a single texel, and anything cut from it there would follow the texels in steps.
  const plateId = mix(float(0.5), plates.a, smoothstep(0.01, 0.06, plates.r.mul(plates.r).mul(0.6)));
  // A slow swell of heat rolls down the lake toward the artist, opening the seams as it passes.
  const swirl = churn(flow.mul(0.4).add(vec2(3.1, 7.7)));
  const wave = sin(flow.y.mul(0.7).sub(time.mul(1.0)).add(swirl.z.mul(2))).mul(0.5).add(0.5).mul(wake);
  const open = float(0.035).add(wave.mul(0.05));
  // Some seams have crusted over and gone dark, others gape.
  const gape = smoothstep(-0.45, 0.25, churn(flow.mul(0.9).add(vec2(5.2, time.mul(0.07)))).w.add(wave.mul(0.3)));
  const seams = float(1).sub(smoothstep(0, open.mul(gape.mul(0.8).add(0.35)), seamWidth)).mul(gape.mul(0.7).add(0.3)).mul(float(1).sub(nearWall.mul(0.6)));
  // Each plate's edges, fresh from the seam, still dull red; thin plates (some of them) glow through all over.
  const rims = float(1).sub(smoothstep(0, open.mul(4), seamWidth)).mul(gape.mul(0.6).add(0.2));
  const thin = smoothstep(0.82, 0.97, plateId);
  const fineWidth = plates.b.mul(plates.b).mul(0.5);
  const crazing = float(1).sub(smoothstep(0, 0.035, fineWidth)).mul(float(1).sub(smoothstep(0.08, 0.3, seamWidth)));
  // Molten rock showing through: a winding channel down the middle, and pools where the crust has broken up. A skin
  // forms on it as it cools, torn into rafts by the flow, so the melt shows as hot veins round darker skin.
  const channel = exp(positionLocal.x.sub(sin(positionLocal.z.mul(0.35).add(0.4)).mul(0.55)).div(0.45).pow(2).negate());
  const stir = churn(flow.mul(0.3).add(vec2(time.mul(0.02), 11.3)));
  const molten = smoothstep(0.45, 0.85, stir.x.mul(0.75).add(channel.mul(0.75)).add(swirl.y.mul(0.15))).mul(float(1).sub(nearWall));
  const skin = smoothstep(0.0, 0.05, fineWidth).mul(smoothstep(-0.3, 0.3, churn(flow.mul(vec2(2.3, 0.9)).add(vec2(0, time.mul(0.25)))).y)).mul(0.3);
  const veins = float(1).sub(smoothstep(0, 0.025, fineWidth)).mul(0.22);
  // How hot each point is, 0 (cold crust) to 1 (white-yellow melt); the seams' heat varies along them.
  const seamHeat = stir.w.mul(0.18).add(0.68).add(wave.mul(0.12));
  const temperature = max(max(max(molten.mul(float(0.7).sub(skin).add(veins)), seams.mul(seamHeat)), crazing.mul(mix(float(0.42), float(0.5), thin))), max(rims.mul(0.4), thin.mul(0.36))).clamp(0, 1);
  const glow = mix(mix(mix(vec3(0, 0, 0), vec3(0.4, 0.025, 0.002), smoothstep(0.2, 0.42, temperature)), vec3(2.6, 0.55, 0.04), smoothstep(0.42, 0.72, temperature)), vec3(5.5, 2.5, 0.45), smoothstep(0.72, 1, temperature));
  // The crust's relief: each plate a low dome that rounds down into its seams, some riding higher than others, the
  // crazing faintly grooved. Worked out three times close together for the slope of the surface (so the light catches
  // the plates' edges), and once more for each corner of the mesh.
  const relief = (c: any) => {
    const sw = c.r.mul(c.r).mul(0.6);
    const edgeRound = smoothstep(0, 0.18, sw).pow(0.6);
    const dome = float(1).sub(c.g.mul(c.g));
    const groove = float(1).sub(smoothstep(0, 0.03, c.b.mul(c.b).mul(0.5)));
    return edgeRound.mul(dome.mul(0.02).add(0.03).add(c.a.sub(0.5).mul(0.024))).sub(groove.mul(0.004));
  };
  const STEP = (CRUST / CRUST_SIZE) * 2.5;
  const h0 = relief(plates);
  const slopeX = relief(crustAt(flow.add(vec2(STEP, 0)))).sub(h0).div(STEP);
  const slopeZ = relief(crustAt(flow.add(vec2(0, STEP)))).sub(h0).div(STEP);
  const grain = texture(extra.rockNormal, flow.mul(0.6)).xy.mul(2).sub(1).mul(0.9);
  const flat = float(1).sub(molten.mul(0.85));
  const lavaNormal = vec3(slopeX.negate().add(grain.x.mul(0.35)).mul(flat), 1, slopeZ.negate().sub(grain.y.mul(0.35)).mul(flat)).normalize();
  const lavaMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.75 });
  // The crust: dark basalt (deep in the cavern, where no daylight reaches), some plates a shade lighter or rustier,
  // lit dull red from the seams beside it.
  const crust = texture(extra.rock, flow.mul(0.6)).rgb.mul(mix(vec3(0.1, 0.1, 0.1), vec3(0.16, 0.12, 0.1), plateId));
  const cool = float(1).sub(smoothstep(0.25, 0.6, temperature));
  lavaMaterial.colorNode = crust.mul(cool);
  // Fresh crust by the seams is glassy; old crust, out in the middle of a plate, dull.
  lavaMaterial.roughnessNode = mix(mix(float(0.85), float(0.45), rims), float(0.35), smoothstep(0.4, 0.8, temperature));
  lavaMaterial.normalNode = transformNormalToView(lavaNormal);
  const underglow = crust.mul(vec3(9, 2, 0.35)).mul(smoothstep(0.25, 0.0, seamWidth).mul(0.5).add(molten.mul(0.6)));
  // Where the melt meets the wall it is kept open, a hot line round the shore.
  const shoreline = exp(banked.div(0.035).negate()).mul(vec3(2.2, 0.45, 0.04)).mul(gape.mul(0.5).add(0.5));
  // (And the crust lit by the glow over the lake, so its plates' edges catch it.)
  const lakeLit = crust.mul(cool).mul(vec3(3, 0.8, 0.2)).mul(fromLake(lavaNormal));
  lavaMaterial.emissiveNode = glow.add(underglow.mul(cool)).add(shoreline).add(lakeLit).mul(pulse).add(fumes(float(0)));
  // Plates stand up off the melt, domed; the molten rock sags between them, and crust heaps against the walls. (Only
  // the broad domes, which rise and fall evenly over a plate: the corners of the mesh could not follow the seams'
  // sharp edges without stepping along them, and those are in the light, above. Right against the rock it lies level,
  // so it meets the walls along a clean line.)
  const middle = texture(crustMap, flow.div(CRUST)).g;
  const domes = float(1).sub(middle.mul(middle)).mul(0.045).add(0.01);
  const lift = mix(domes.mul(float(1).sub(molten)).sub(molten.mul(0.03)).add(swirl.x.mul(0.05)).add(nearWall.mul(0.035)), float(0.03), exp(banks.div(0.07).negate()));
  lavaMaterial.positionNode = positionLocal.add(vec3(0, lift, 0));
  lavaMaterial.addEventListener("dispose", () => {
    crustMap.dispose();
    churnMap.dispose();
  });
  const lava = new THREE.Mesh(lavaGeometry, lavaMaterial);
  lava.receiveShadow = true;
  real.add(lava);

  // Embers rising out of the crack.
  const embers = specks(110, [-0.6, 0.6, LAVA + 0.2, 1.1, -4, 0.2], new THREE.Color("#ffa24a").multiplyScalar(5), 0.45);
  real.add(embers.mesh);

  const shade = shadeFor(edge);
  const extent = [...edge];
  return {
    real,
    shade: shade.mesh,
    edge,
    extent,
    covers: footprint(extent),
    inside: (at: any) => {
      const s = shape(gpu, at.y);
      const dx = at.x.sub(s.centre);
      return step(FAR, at.y).mul(step(at.y, NEAR)).mul(step(s.left.negate(), dx)).mul(step(dx, s.right));
    },
    animate: (t) => {
      // Once real: the lava flows toward the artist and churns, the heat swells and ebbs (the seams opening as each
      // swell rolls through), the light on the walls breathes with it, and embers rise.
      const w = wakeAt(t);
      time.value = t;
      wake.value = w;
      drift.value = 0.11 * t * w;
      const breathe = Math.sin(t * 0.9) * 0.5 + Math.sin(t * 2.3 + 1.1) * 0.25 + Math.sin(t * 5.7 + 0.3) * 0.1;
      pulse.value = 1 + w * (0.12 + 0.13 * breathe);
      embers.update(t, w);
    },
    geometries: [wallGeometry, lavaGeometry, embers.geometry, shade.geometry],
    materials: [wallMaterial, lavaMaterial, embers.material, shade.material]
  };
}
