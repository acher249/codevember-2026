import { edgeTable as edgeTableTyped, triTable as triTableTyped } from "three/addons/objects/MarchingCubes.js";

// Paul Bourke's marching cubes tables, as three.js publishes them: http://paulbourke.net/geometry/polygonise/
const edgeTable = edgeTableTyped as unknown as ArrayLike<number>;
const triTable = triTableTyped as unknown as ArrayLike<number>;

// One continuous deer body, from its anatomy: bones with flesh on them, blended where they meet, then skinned over
// as a single surface. Nose along +x, hooves at y = 0, the same frame as the rig that moves it.

type Bone = { a: number[]; b: number[]; ra: number; rb: number; blend: number };

const bone = (a: number[], b: number[], ra: number, rb: number, blend: number): Bone => ({ a, b, ra, rb, blend });

const BONES: Bone[] = [
  // Barrel of the ribs, tucked up toward the flank, then the rump.
  bone([0.3, 1.0, 0], [-0.02, 0.97, 0], 0.215, 0.245, 0.1),
  bone([-0.02, 0.95, 0], [-0.3, 0.99, 0], 0.235, 0.19, 0.1),
  bone([-0.3, 1.02, 0], [-0.52, 1.03, 0], 0.2, 0.17, 0.1),
  // Withers and shoulder blades, standing proud of the ribs.
  bone([0.3, 1.14, 0], [0.12, 1.11, 0], 0.075, 0.09, 0.09),
  // The neck, deep where it leaves the chest and fine at the throat.
  bone([0.36, 1.02, 0], [0.56, 1.3, 0], 0.15, 0.09, 0.1),
  bone([0.56, 1.3, 0], [0.7, 1.5, 0], 0.09, 0.062, 0.06),
  // Skull, cheek, then the long narrow muzzle.
  bone([0.72, 1.55, 0], [0.84, 1.54, 0], 0.075, 0.066, 0.04),
  bone([0.76, 1.5, 0], [0.84, 1.5, 0], 0.052, 0.05, 0.04),
  bone([0.86, 1.53, 0], [1.03, 1.47, 0], 0.052, 0.03, 0.03),
];

// Shoulder to forearm to knee to fetlock. Hip to thigh to hock to fetlock.
const FORE = [
  [0.38, 1.0],
  [0.4, 0.78],
  [0.37, 0.55],
  [0.37, 0.34],
  [0.37, 0.08],
  [0.385, 0.018]
];
const HIND = [
  [-0.42, 1.02],
  [-0.4, 0.74],
  [-0.5, 0.55],
  [-0.56, 0.42],
  [-0.48, 0.08],
  [-0.465, 0.018]
];
const FORE_R = [0.105, 0.072, 0.036, 0.03, 0.021, 0.028];
const HIND_R = [0.125, 0.09, 0.038, 0.03, 0.021, 0.028];

// Each leg, with the phase the rig steps it on: every hind foot leads the front foot on its own side by a quarter stride.
const LEGS = [
  { path: FORE, radii: FORE_R, side: 0.125, phase: 0 },
  { path: FORE, radii: FORE_R, side: -0.125, phase: Math.PI },
  { path: HIND, radii: HIND_R, side: 0.125, phase: Math.PI * 0.5 },
  { path: HIND, radii: HIND_R, side: -0.125, phase: Math.PI * 1.5 }
];

for (const leg of LEGS) {
  for (let i = 0; i < leg.path.length - 1; i++) {
    const inward = i === 0 ? 0.09 : leg.side > 0 ? 0.125 : -0.125;
    const z0 = i === 0 ? Math.sign(leg.side) * inward : leg.side;
    BONES.push(bone([leg.path[i][0], leg.path[i][1], z0], [leg.path[i + 1][0], leg.path[i + 1][1], leg.side], leg.radii[i], leg.radii[i + 1], i === 0 ? 0.09 : 0.02));
  }
}

const BOX = { min: [-0.8, -0.02, -0.34], max: [1.12, 1.72, 0.34] };
const VOXEL = 0.0175;

function distanceTo(b: Bone, x: number, y: number, z: number) {
  const ax = b.b[0] - b.a[0];
  const ay = b.b[1] - b.a[1];
  const az = b.b[2] - b.a[2];
  const px = x - b.a[0];
  const py = y - b.a[1];
  const pz = z - b.a[2];
  const t = Math.max(0, Math.min(1, (px * ax + py * ay + pz * az) / (ax * ax + ay * ay + az * az)));
  return Math.hypot(px - ax * t, py - ay * t, pz - az * t) - (b.ra + (b.rb - b.ra) * t);
}

function field(x: number, y: number, z: number) {
  let d = 1e3;
  for (const b of BONES) {
    const next = distanceTo(b, x, y, z);
    // A smooth union, so that flesh runs from one bone into the next without a crease. After Inigo Quilez: https://iquilez.org/articles/smin/
    const k = b.blend;
    const h = Math.max(k - Math.abs(d - next), 0) / k;
    d = Math.min(d, next) - h * h * k * 0.25;
  }
  return d;
}

const mix3 = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const COAT = [0.27, 0.165, 0.09];
const SADDLE = [0.17, 0.105, 0.062];
const CREAM = [0.72, 0.62, 0.48];
const SOCK = [0.19, 0.135, 0.095];
const HOOF = [0.018, 0.014, 0.012];
const NOSE = [0.012, 0.01, 0.01];

// A red-brown coat, darker along the spine, cream underneath and on the throat, a white rump, a pale muzzle.
function paint(x: number, y: number, z: number) {
  const side = Math.abs(z);
  let c = mix3(COAT, SADDLE, smooth(1.1, 1.24, y) * (1 - smooth(0.04, 0.1, side)));
  const belly = (1 - smooth(0.74, 0.88, y)) * smooth(-0.4, -0.3, x) * (1 - smooth(0.3, 0.4, x));
  c = mix3(c, CREAM, belly * smooth(0.0, 0.1, 0.2 - side + 0.03));
  // The throat and the inside of the thighs.
  const throat = smooth(0.42, 0.5, x) * (1 - smooth(0.72, 0.82, x)) * smooth(0.04, 0, y - (1.05 + (x - 0.42) * 1.0));
  c = mix3(c, CREAM, throat * 0.8);
  const rump = smooth(-0.56, -0.66, x) * smooth(0.82, 0.95, y);
  c = mix3(c, CREAM, rump * 0.42);
  c = mix3(c, SOCK, 1 - smooth(0.34, 0.6, y));
  c = mix3(c, CREAM, smooth(0.92, 0.98, x) * smooth(1.5, 1.44, y) * 0.5);
  c = mix3(c, CREAM, smooth(0.8, 0.86, x) * (1 - smooth(1.44, 1.5, y)) * 0.7);
  c = mix3(c, HOOF, 1 - smooth(0.05, 0.075, y));
  c = mix3(c, NOSE, smooth(1.015, 1.045, x));
  return c;
}

// How much of the rig's leg or neck this point of the skin follows. Fades out through the shoulder and the hip,
// and through the base of the neck, so that the skin bends there and does not tear.
function rigAt(x: number, y: number, z: number) {
  if (y < 1.0 && (Math.abs(x - 0.38) < 0.26 || Math.abs(x + 0.47) < 0.3)) {
    const follow = smooth(0.95, 0.68, y);
    if (follow > 0 || y < 0.9) {
      const front = x > 0;
      const near = z >= 0;
      const phase = front ? (near ? LEGS[0].phase : LEGS[1].phase) : near ? LEGS[2].phase : LEGS[3].phase;
      return [1.5 + 0.1 * follow, phase];
    }
  }
  const up = smooth(0.34, 0.54, x + (y - 1.05) * 0.55);
  if (x > 0.3 && y > 0.98) return [0.5 + 0.1 * up, 0];
  return [0, 0];
}

let built: { position: number[]; normal: number[]; color: number[]; rig: number[]; index: number[] } | null = null;

export function buildDeerSkin() {
  if (built) return built;
  const nx = Math.ceil((BOX.max[0] - BOX.min[0]) / VOXEL);
  const ny = Math.ceil((BOX.max[1] - BOX.min[1]) / VOXEL);
  const nz = Math.ceil((BOX.max[2] - BOX.min[2]) / VOXEL);
  const values = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  const at = (i: number, j: number, k: number) => i + (nx + 1) * (j + (ny + 1) * k);
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        values[at(i, j, k)] = field(BOX.min[0] + i * VOXEL, BOX.min[1] + j * VOXEL, BOX.min[2] + k * VOXEL);
      }
    }
  }
  const position: number[] = [];
  const index: number[] = [];
  const edges = new Map<number, number>();
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1]
  ];
  const edgeEnds = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7]
  ];
  const span = (nx + 1) * (ny + 1) * (nz + 1);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let code = 0;
        for (let c = 0; c < 8; c++) if (values[at(i + corners[c][0], j + corners[c][1], k + corners[c][2])] < 0) code |= 1 << c;
        if (code === 0 || code === 255) continue;
        const crossed = edgeTable[code];
        const vertex = new Array<number>(12);
        for (let e = 0; e < 12; e++) {
          if (!(crossed & (1 << e))) continue;
          const [c0, c1] = edgeEnds[e];
          const a = at(i + corners[c0][0], j + corners[c0][1], k + corners[c0][2]);
          const b = at(i + corners[c1][0], j + corners[c1][1], k + corners[c1][2]);
          const key = Math.min(a, b) * span + Math.max(a, b);
          let id = edges.get(key);
          if (id === undefined) {
            const t = values[a] / (values[a] - values[b]);
            const x0 = i + corners[c0][0];
            const y0 = j + corners[c0][1];
            const z0 = k + corners[c0][2];
            const x1 = i + corners[c1][0];
            const y1 = j + corners[c1][1];
            const z1 = k + corners[c1][2];
            id = position.length / 3;
            position.push(BOX.min[0] + (x0 + (x1 - x0) * t) * VOXEL, BOX.min[1] + (y0 + (y1 - y0) * t) * VOXEL, BOX.min[2] + (z0 + (z1 - z0) * t) * VOXEL);
            edges.set(key, id);
          }
          vertex[e] = id;
        }
        const row = code * 16;
        for (let t = 0; triTable[row + t] !== -1; t += 3) index.push(vertex[triTable[row + t]], vertex[triTable[row + t + 2]], vertex[triTable[row + t + 1]]);
      }
    }
  }
  const normal: number[] = [];
  const color: number[] = [];
  const rig: number[] = [];
  const e = VOXEL * 0.8;
  for (let v = 0; v < position.length; v += 3) {
    const x = position[v];
    const y = position[v + 1];
    const z = position[v + 2];
    const nxv = field(x + e, y, z) - field(x - e, y, z);
    const nyv = field(x, y + e, z) - field(x, y - e, z);
    const nzv = field(x, y, z + e) - field(x, y, z - e);
    const length = Math.hypot(nxv, nyv, nzv) || 1;
    normal.push(nxv / length, nyv / length, nzv / length);
    color.push(...paint(x, y, z));
    rig.push(...rigAt(x, y, z));
  }
  built = { position, normal, color, rig, index };
  return built;
}
