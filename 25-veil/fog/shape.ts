import * as THREE from "three/webgpu";

// The coast, in metres: the sea at y = 0, the eye on a pebble beach looking out across a cove at a lighthouse on the
// end of a rocky headland, with the open sea beyond. Shared by the processor (the ground, the fog's stirring, where a
// drag lands) and the shaders.

export const EYE = new THREE.Vector3(8, 4.2, 46);
export const LOOK = new THREE.Vector3(-14, 14, -40);

// The lighthouse: where its foot stands on the headland, how tall the tower is, and the lamp at its top.
export const TOWER = { x: -30, z: -62, ground: 13, height: 24, base: 3.4, top: 2.3 };
export const LAMP = new THREE.Vector3(TOWER.x, TOWER.ground + TOWER.height + 2.2, TOWER.z);

// The fog: how high its body lies, and the region the stirring field covers (x, z from and size).
export const FOG = { top: 22, field: { x: -150, z: -230, size: 300 } };

// The ground's heights, made once at load, over this square; the shaders read the same numbers from a texture.
export const GROUND = { x: -200, z: -260, size: 400, cells: 256 };

// Smooth value noise for the processor: rocks, ridges and coves.
function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise(x: number, y: number) {
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
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, octaves = 5) {
  let sum = 0;
  let amplitude = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x, y) * amplitude;
    norm += amplitude;
    x = x * 2.03 + 17.1;
    y = y * 2.03 - 9.3;
    amplitude *= 0.5;
  }
  return sum / norm;
}

// Distance from a point to a segment in the plane.
function toSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The ground's height at a point: the headland running out from the left to the lighthouse's point, its sides cliffs
// into the sea; the beach under the eye rising gently inland; the sea floor shelving away between them.
export function groundHeight(x: number, z: number) {
  const wobble = (fbm(x * 0.02, z * 0.02) - 0.5) * 18;
  // The headland: a ridge from far left out to the point, rounded at its end round the tower.
  const ridge = toSegment(x + wobble * 0.4, z + wobble * 0.3, -170, 10, TOWER.x + 6, TOWER.z - 4);
  const width = 26 + (fbm(x * 0.03 + 5, z * 0.03) - 0.5) * 16;
  const shoulder = smooth(width, width * 0.55, ridge);
  // Cliffs: the land holds its height to near the edge, then drops.
  const cliff = Math.pow(shoulder, 0.35);
  const top = TOWER.ground + (fbm(x * 0.05, z * 0.05) - 0.5) * 5 + Math.max(0, -x - 40) * 0.05;
  let h = -6 + (top + 6) * cliff;
  // Boulders and ledges at the cliff foot, where the sea works the rock.
  const rough = Math.pow(fbm(x * 0.12 + 3, z * 0.12 - 7, 4), 2) * 6;
  h += rough * smooth(0.05, 0.4, shoulder) * smooth(1, 0.6, shoulder);
  // The beach: shingle rising inland behind the eye, its edge wandering.
  const shore = 28 + (fbm(x * 0.015 - 4, 3) - 0.5) * 22 - x * 0.08;
  const beach = (z - shore) * 0.11 + (fbm(x * 0.08, z * 0.08) - 0.5) * 0.6;
  h = Math.max(h, beach);
  // A few rocks standing on the beach and out in the cove.
  for (const [rx, rz, r, height] of ROCKS) {
    const d = Math.hypot(x - rx, z - rz) / r;
    if (d < 1) h = Math.max(h, groundAtRock(height, d, x, z));
  }
  return h;
}

const ROCKS: [number, number, number, number][] = [
  [-8, 30, 3.2, 1.6],
  [14, 24, 2.4, 1.2],
  [-22, 12, 4.5, 2.6],
  [6, -8, 3.5, 3.2],
  [-46, -30, 5, 4]
];
function groundAtRock(height: number, d: number, x: number, z: number) {
  const lumpy = 0.75 + fbm(x * 0.6, z * 0.6, 3) * 0.5;
  return -1.5 + (height + 1.5) * Math.pow(1 - d * d, 0.6) * lumpy;
}

// The heights over GROUND, row by row (z), for the ground mesh and the shaders.
export function bakeGround() {
  const n = GROUND.cells + 1;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) heights[j * n + i] = groundHeight(GROUND.x + (GROUND.size * i) / GROUND.cells, GROUND.z + (GROUND.size * j) / GROUND.cells);
  const texture = new THREE.DataTexture(heights, n, n, THREE.RedFormat, THREE.FloatType);
  // Nearest: 32-bit float textures need not filter everywhere.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return { heights, texture, n };
}
