import * as THREE from "three/webgpu";
import { pointHash } from "../shared/engine/random";

// The cliff is a surface, not a heightfield, because its walls stand upright and lean out. A point on it is
// named (u, v) in metres: u runs along the cliff, and v runs up and over it, from the valley to the top.

const CLIFF_RADIUS = 260;
export const SHELF_V = -4.5;
export const VALLEY_FLOOR = -92;

export function noise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = pointHash(ix, iy) * (1 - sx) + pointHash(ix + 1, iy) * sx;
  const bottom = pointHash(ix, iy + 1) * (1 - sx) + pointHash(ix + 1, iy + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Where rain collects: hollows in the rock along the shelf and the ledge above it.
export const POOLS: { u: number; v: number; r: number }[] = [
  { u: -6.2, v: -5, r: 1.9 },
  { u: -2.6, v: -2.8, r: 1.05 },
  { u: 1.2, v: -5.4, r: 1.75 },
  { u: 6.6, v: -5.4, r: 1.35 },
  { u: 11.6, v: -3.5, r: 1.75 },
  { u: 3.2, v: 3.9, r: 0.75 }
];

// The water stands at the lowest point of each rim, so that it can never hang out over the edge.
export function poolLevel(pool: { u: number; v: number; r: number }) {
  const point = new THREE.Vector3();
  let level = Infinity;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    level = Math.min(level, surfaceAt(pool.u + Math.cos(a) * pool.r, pool.v + (Math.sin(a) * pool.r) / 1.15, point).y);
  }
  return level - 0.025;
}

// 1 in the middle of a pool, falling to 0 at its rim, and on past that for the ground that slopes in to it.
export function poolAt(u: number, v: number, reach = 1) {
  let most = 0;
  for (const pool of POOLS) {
    const distance = Math.hypot(u - pool.u, (v - pool.v) * 1.15) / (pool.r * reach);
    if (distance < 1) most = Math.max(most, 1 - distance);
  }
  return most;
}

const V_MIN = -125;
const V_MAX = 240;
const V_STEP = 0.05;
const V_COUNT = Math.ceil((V_MAX - V_MIN) / V_STEP) + 1;

// The way the rock heads at each v, in degrees: 90 is straight up, 180 straight back into the cliff.
function buildProfile(faces: number, shelf: number, ledge: number) {
  const breaks: [number, number][] = [
    [-7.5, faces],
    [-1.5, shelf],
    [3.1, 83],
    [4.7, ledge],
    [9.4, 94],
    [240, 176]
  ];
  const angle = (v: number) => {
    let a = breaks[0][1];
    for (let i = 0; i < breaks.length - 1; i++) a += (breaks[i + 1][1] - breaks[i][1]) * smooth(breaks[i][0] - 0.4, breaks[i][0] + 0.4, v);
    return a;
  };
  const out = new Float32Array(V_COUNT);
  const up = new Float32Array(V_COUNT);
  const heading = new Float32Array(V_COUNT);
  const anchor = Math.round((SHELF_V - V_MIN) / V_STEP);
  for (let i = 0; i < V_COUNT; i++) heading[i] = angle(V_MIN + i * V_STEP);
  for (let i = anchor + 1; i < V_COUNT; i++) {
    const a = (heading[i] * Math.PI) / 180;
    out[i] = out[i - 1] + Math.cos(a) * V_STEP;
    up[i] = up[i - 1] + Math.sin(a) * V_STEP;
  }
  for (let i = anchor - 1; i >= 0; i--) {
    const a = (heading[i + 1] * Math.PI) / 180;
    out[i] = out[i + 1] - Math.cos(a) * V_STEP;
    up[i] = up[i + 1] - Math.sin(a) * V_STEP;
  }
  return { out, up, heading };
}

const WIDE = buildProfile(97, 177, 170);
const BROKEN = buildProfile(97, 128, 122);

// The shelf holds in the middle, and breaks up into slopes further along.
const brokenness = (u: number) => smooth(32, 46, Math.abs(u)) * smooth(0.25, 0.55, noise(u * 0.035 + 4, 2.5));

function profileAt(u: number, v: number) {
  const f = Math.min(V_COUNT - 1.001, Math.max(0, (v - V_MIN) / V_STEP));
  const i = Math.floor(f);
  const t = f - i;
  const b = brokenness(u);
  const lerp = (a: Float32Array) => a[i] + (a[i + 1] - a[i]) * t;
  const out = lerp(WIDE.out) * (1 - b) + lerp(BROKEN.out) * b;
  const up = lerp(WIDE.up) * (1 - b) + lerp(BROKEN.up) * b;
  const heading = lerp(WIDE.heading) * (1 - b) + lerp(BROKEN.heading) * b;
  return { out, up, heading };
}

// How much a spot lies flat, from the upright wall at 0 to level ground at 1.
export const flatnessAt = (u: number, v: number) => smooth(120, 158, profileAt(u, v).heading);

const fbm = (x: number, y: number) => noise(x, y) - 0.5 + (noise(x * 2.3 + 11, y * 2.3) - 0.5) * 0.42 + (noise(x * 5.3 + 3, y * 5.3 + 7) - 0.5) * 0.14;

const blockHash = (x: number, y: number) => {
  const s1 = Math.sin(x * 91.7 + y * 47.3) * 24634.6345;
  return s1 - Math.floor(s1);
};

// How a real face breaks up: thick beds that stand proud or fall back one by one, split by joints running down them
// into columns, each block with its own lean, and all of it broken up again at every smaller scale.
function reliefAt(u: number, v: number, height: number, flat: number) {
  const wobble = (noise(u * 0.07 + 2, v * 0.11 + 8) - 0.5) * 2.6;
  const bedAt = height * 0.42 + wobble * 0.5;
  const bed = Math.floor(bedAt);
  const inBed = bedAt - bed;
  const bedOut = (blockHash(bed, 3.1) - 0.5) * 1.5;
  const lip = smooth(0, 0.07, inBed) * smooth(1, 0.93, inBed);
  const columnAt = u * (0.2 + blockHash(bed, 9.4) * 0.14) + blockHash(bed, 6.2) * 7 + (noise(u * 0.13, v * 0.05 + 4) - 0.5) * 2.2;
  const column = Math.floor(columnAt);
  const inColumn = columnAt - column;
  const blockOut = (blockHash(column, bed + 11) - 0.5) * 1.15;
  const joint = smooth(0, 0.06, inColumn) * smooth(1, 0.94, inColumn);
  const lean = (inBed - 0.5) * (blockHash(column, bed + 21) - 0.5) * 0.9;
  const blocks = (bedOut + blockOut + lean) * joint * lip - (1 - joint * lip) * 0.42;
  const lumps = fbm(u * 0.08 + 3, v * 0.08) * 2.5 + (noise(u * 0.6 + 1, v * 0.6) - 0.5) * 0.46 + (noise(u * 1.7, v * 1.7 + 5) - 0.5) * 0.17 + (noise(u * 4.3 + 8, v * 4.3) - 0.5) * 0.05;
  const wall = blocks + lumps;
  // Far along the cliff, the mesh is too coarse to hold blocks, and they would only alias into spikes.
  const far = smooth(32, 70, Math.abs(u));
  const roll = (noise(u * 0.32 + 7, v * 0.32) - 0.5) * 0.26 + (noise(u * 1.3, v * 1.3 + 3) - 0.5) * 0.05;
  const bowl = smooth(0, 0.75, poolAt(u, v)) * 0.34;
  const level = 1 - smooth(0, 0.9, poolAt(u, v, 1.9));
  return (wall * (1 - far * 0.65) + lumps * far * 0.65) * (1 - flat) + (roll * level - bowl) * flat;
}

export function surfaceAt(u: number, v: number, out = new THREE.Vector3(), inset = 0) {
  const profile = profileAt(u, v);
  const a = (profile.heading * Math.PI) / 180;
  const flat = smooth(120, 158, profile.heading);
  const relief = reliefAt(u, v, profile.up, flat) - inset;
  const outward = profile.out + relief * Math.sin(a);
  const theta = u / CLIFF_RADIUS;
  const reach = CLIFF_RADIUS - outward;
  let y = profile.up - relief * Math.cos(a);
  // Far along, the cliff sinks away into the forest.
  const away = smooth(150, 290, Math.abs(u));
  y += (VALLEY_FLOOR + 6 + (y - VALLEY_FLOOR - 6) * 0.1 - y) * away;
  return out.set(reach * Math.sin(theta), y, CLIFF_RADIUS - reach * Math.cos(theta));
}

const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchC = new THREE.Vector3();

// The outward normal at (u, v), by looking at the surface either side.
export function surfaceNormal(u: number, v: number, out = new THREE.Vector3(), step = 0.12) {
  surfaceAt(u - step, v, scratchA);
  surfaceAt(u + step, v, scratchB);
  scratchB.sub(scratchA);
  surfaceAt(u, v - step, scratchA);
  surfaceAt(u, v + step, scratchC);
  scratchC.sub(scratchA);
  return out.crossVectors(scratchB, scratchC).normalize();
}

const probeA = new THREE.Vector3();

const probes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

// The nearest place on the cliff, followed from where it was last time, so it can never leap to some other part of the rock.
export function nearestOnCliff(point: THREE.Vector3, memory: { v: number | null }) {
  const u = Math.max(-330, Math.min(330, CLIFF_RADIUS * Math.atan2(point.x, CLIFF_RADIUS - point.z)));
  const search = (from: number, to: number, step: number) => {
    let best = from;
    let nearest = Infinity;
    for (let v = from; v <= to; v += step) {
      surfaceAt(u, v, probeA);
      const distance = probeA.distanceToSquared(point);
      if (distance < nearest) {
        nearest = distance;
        best = v;
      }
    }
    return best;
  };
  let v = memory.v === null ? search(-120, 235, 2.5) : search(memory.v - 3, memory.v + 3, 0.5);
  v = search(v - 0.5, v + 0.5, 0.1);
  memory.v = v;
  return { u, v };
}

// How far the point is from the broad shape of the rock, with every ledge and block averaged away, so that it changes
// smoothly as the point moves. Up close the true surface is judged too, because the broad shape can sit behind it.
export function softClearance(point: THREE.Vector3, away: THREE.Vector3, memory: { v: number | null }) {
  const { u, v } = nearestOnCliff(point, memory);
  const reach = 2.2;
  surfaceAt(u - reach, v, probes[0]);
  surfaceAt(u + reach, v, probes[1]);
  surfaceAt(u, v - reach, probes[2]);
  surfaceAt(u, v + reach, probes[3]);
  scratchB.subVectors(probes[1], probes[0]);
  scratchC.subVectors(probes[3], probes[2]);
  away.crossVectors(scratchB, scratchC).normalize();
  scratchA.copy(probes[0]).add(probes[1]).add(probes[2]).add(probes[3]).multiplyScalar(0.25);
  const broad = (point.x - scratchA.x) * away.x + (point.y - scratchA.y) * away.y + (point.z - scratchA.z) * away.z;
  surfaceAt(u, v, probeA);
  const exact = point.distanceTo(probeA);
  return Math.min(broad, exact + 0.25);
}

// Is this point of the valley out in front of the cliff, with room to stand a tree?
export const clearOfCliff = (x: number, z: number, margin: number) => Math.hypot(x, CLIFF_RADIUS - z) < CLIFF_RADIUS - margin;

// A sheet of the surface, from lists of where to put its rows and columns.
export function buildSheet(us: number[], vs: number[], fieldSize: number, wildAt: (u: number, v: number) => number, insetAt?: (u: number, v: number) => number) {
  const count = us.length * vs.length;
  const position = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const wild = new Float32Array(count);
  const shelf = new Float32Array(count);
  const point = new THREE.Vector3();
  let o = 0;
  for (const v of vs) {
    for (const u of us) {
      surfaceAt(u, v, point, insetAt ? insetAt(u, v) : 0);
      position.set([point.x, point.y, point.z], o * 3);
      uv.set([u / fieldSize + 0.5, v / fieldSize + 0.5], o * 2);
      wild[o] = wildAt(u, v);
      shelf[o] = flatnessAt(u, v);
      o++;
    }
  }
  const index: number[] = [];
  for (let j = 0; j < vs.length - 1; j++) {
    for (let i = 0; i < us.length - 1; i++) {
      const a = j * us.length + i;
      index.push(a, a + 1, a + us.length, a + 1, a + us.length + 1, a + us.length);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute("aWild", new THREE.BufferAttribute(wild, 1));
  geometry.setAttribute("aShelf", new THREE.BufferAttribute(shelf, 1));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}
