import * as THREE from "three/webgpu";

// A hooded figure, in metres, facing the eye (+z): a deep hood falling into a cloak over her shoulders, her face set
// back in its shadow, and a sheer veil hung across the hood's opening. Her face and the hood as fields (soft unions of
// simple shapes) made into meshes at load; the same shapes, simpler, that the veil rests on; where it is pinned.

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// The hood: an egg round her head, deep enough that her face sits well back from its rim; the opening an oval.
export const HOOD = { centre: V(0, 1.62, 0.02), radii: V(0.13, 0.155, 0.18), thick: 0.012 };
export const OPENING = { centre: V(0, 1.595, 0), rx: 0.086, ry: 0.127 };

// Signed distance helpers.
const ellipsoid = (px: number, py: number, pz: number, c: THREE.Vector3, r: THREE.Vector3) => {
  const x = (px - c.x) / r.x;
  const y = (py - c.y) / r.y;
  const z = (pz - c.z) / r.z;
  const k0 = Math.hypot(x, y, z);
  const k1 = Math.hypot(x / r.x, y / r.y, z / r.z);
  return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(r.x, r.y, r.z);
};
const sphere = (px: number, py: number, pz: number, c: THREE.Vector3, r: number) => Math.hypot(px - c.x, py - c.y, pz - c.z) - r;
const capsule = (px: number, py: number, pz: number, a: number[], b: number[], ra: number, rb: number) => {
  const bx = b[0] - a[0];
  const by = b[1] - a[1];
  const bz = b[2] - a[2];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * bx + (py - a[1]) * by + (pz - a[2]) * bz) / (bx * bx + by * by + bz * bz)));
  return Math.hypot(px - a[0] - bx * t, py - a[1] - by * t, pz - a[2] - bz * t) - (ra + (rb - ra) * t);
};
const smin = (a: number, b: number, k: number) => {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
};
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

// Her face and neck: a narrow skull, a high forehead, cheekbones, a jaw tapering to a small chin; her eyes closed under
// soft lids; a fine nose; full lips with a bow to the upper one and corners pressed in; a slender neck.
export function face(x: number, y: number, z: number) {
  let d = ellipsoid(x, y, z, V(0, 1.605, -0.005), V(0.071, 0.098, 0.091));
  d = smin(d, ellipsoid(x, y, z, V(0, 1.645, 0.045), V(0.061, 0.04, 0.046)), 0.03);
  d = smin(d, capsule(x, y, z, [-0.038, 1.628, 0.081], [0.038, 1.628, 0.081], 0.008, 0.008), 0.014);
  for (const s of [-1, 1]) d = smin(d, ellipsoid(x, y, z, V(s * 0.046, 1.59, 0.056), V(0.025, 0.02, 0.031)), 0.025);
  d = smin(d, ellipsoid(x, y, z, V(0, 1.567, 0.06), V(0.039, 0.04, 0.04)), 0.03);
  // The jaw, from below each ear down to the chin.
  d = smin(d, ellipsoid(x, y, z, V(0, 1.55, 0.015), V(0.057, 0.052, 0.058)), 0.03);
  for (const s of [-1, 1]) d = smin(d, capsule(x, y, z, [s * 0.05, 1.545, -0.005], [0, 1.509, 0.062], 0.015, 0.014), 0.03);
  d = smin(d, ellipsoid(x, y, z, V(0, 1.507, 0.067), V(0.018, 0.016, 0.015)), 0.015);
  // Eyes: shallow sockets under the brow, closed lids over them.
  for (const s of [-1, 1]) {
    d = smax(d, -sphere(x, y, z, V(s * 0.031, 1.615, 0.099), 0.017), 0.01);
    d = smin(d, ellipsoid(x, y, z, V(s * 0.031, 1.613, 0.083), V(0.0155, 0.0095, 0.012)), 0.004);
  }
  // The nose.
  d = smin(d, capsule(x, y, z, [0, 1.622, 0.089], [0, 1.586, 0.108], 0.0055, 0.0078), 0.008);
  d = smin(d, sphere(x, y, z, V(0, 1.581, 0.106), 0.0092), 0.005);
  for (const s of [-1, 1]) {
    d = smin(d, ellipsoid(x, y, z, V(s * 0.011, 1.578, 0.096), V(0.0075, 0.0065, 0.007)), 0.004);
    d = smax(d, -sphere(x, y, z, V(s * 0.0058, 1.5725, 0.1005), 0.0028), 0.002);
  }
  // The lips: the upper with its bow, the lower fuller, the corners pressed in, a fine line between.
  d = smin(d, ellipsoid(x, y, z, V(0, 1.5555, 0.0955), V(0.021, 0.0055, 0.0095)), 0.005);
  for (const s of [-1, 1]) d = smin(d, ellipsoid(x, y, z, V(s * 0.006, 1.558, 0.0965), V(0.007, 0.004, 0.006)), 0.003);
  d = smin(d, ellipsoid(x, y, z, V(0, 1.5455, 0.093), V(0.018, 0.0068, 0.0105)), 0.005);
  for (const s of [-1, 1]) d = smax(d, -sphere(x, y, z, V(s * 0.023, 1.551, 0.089), 0.004), 0.003);
  d = smax(d, -capsule(x, y, z, [-0.02, 1.5505, 0.1], [0.02, 1.5505, 0.1], 0.0012, 0.0012), 0.0015);
  // The neck.
  d = smin(d, capsule(x, y, z, [0, 1.37, -0.01], [0, 1.52, -0.015], 0.047, 0.043), 0.03);
  return d;
}

// The hood and the cloak it falls into: a shell of cloth over her head, peaked at the back, its opening cut round her
// face with a rolled edge; over her shoulders and down, with folds hanging straight from the shoulders and a slit at
// the front where it parts.
export function hood(x: number, y: number, z: number) {
  const around = Math.atan2(x, z - 0.02);
  // The hood's outside: the egg, drawn up and back into a soft point, with folds running back from the opening.
  let outer = ellipsoid(x, y, z, HOOD.centre, HOOD.radii);
  outer = smin(outer, capsule(x, y, z, [0, 1.69, -0.05], [0, 1.775, -0.13], 0.06, 0.022), 0.06);
  // Folds: soft creases running back from the opening over the crown, and the hood's weight sagging into a few deeper
  // ones at the sides of the neck.
  const front = Math.min(1, Math.max(0, (z + 0.1) / 0.2));
  outer += (0.006 * Math.sin(around * 6 + y * 20 + Math.sin(y * 31) * 0.8) + 0.0025 * Math.sin(around * 15 - y * 11)) * front;
  outer += 0.008 * Math.max(0, Math.sin(around * 3 + 1.2)) * Math.max(0, Math.min(1, (1.6 - y) / 0.12));
  // The cloak: over the shoulders and the chest, its folds falling from the shoulders.
  let cloak = capsule(x, y, z, [-0.18, 1.365, 0.0], [0.18, 1.365, 0.0], 0.075, 0.075);
  cloak = smin(cloak, ellipsoid(x, y, z, V(0, 1.15, 0.0), V(0.225, 0.32, 0.14)), 0.08);
  cloak = smin(cloak, capsule(x, y, z, [0, 1.38, 0.0], [0, 1.52, 0.0], 0.08, 0.075), 0.05);
  const hang = Math.min(1, Math.max(0, (1.42 - y) / 0.2));
  cloak += hang * (0.007 * Math.sin(x * 48 + Math.sin(y * 9) * 1.5) + 0.004 * Math.sin(x * 113 + 2));
  let d = smin(outer, cloak, 0.05);
  // A shell of cloth, not a solid.
  d = Math.abs(d + HOOD.thick / 2) - HOOD.thick / 2;
  // The opening round her face, cut from the front, its edge rounded.
  const ox = x / OPENING.rx;
  const oy = (y - OPENING.centre.y) / OPENING.ry;
  const oval = (Math.hypot(ox, oy) - 1) * OPENING.rx;
  d = smax(d, -smax(oval, 0.02 - z, 0.004), 0.005);
  // The slit down the cloak's front, widening as it falls.
  const slit = Math.abs(x) - (0.012 + Math.max(0, 1.47 - y) * 0.16);
  d = smax(d, -smax(slit, Math.max(0.04 - z, y - 1.47), 0.004), 0.004);
  return smax(d, 0.98 - y, 0.01);
}

// The surface of a field over a box, by surface nets: one vertex in each cell the surface passes through (the mean of
// where it crosses the cell's edges), joined into quads across every edge it crosses, then nudged onto the surface.
export function surfaceNets(field: (x: number, y: number, z: number) => number, min: THREE.Vector3, max: THREE.Vector3, step: number) {
  const nx = Math.ceil((max.x - min.x) / step) + 1;
  const ny = Math.ceil((max.y - min.y) / step) + 1;
  const nz = Math.ceil((max.z - min.z) / step) + 1;
  const values = new Float32Array(nx * ny * nz);
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[at(i, j, k)] = field(min.x + i * step, min.y + j * step, min.z + k * step);

  const cellVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cell = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
  const positions: number[] = [];
  const EDGES = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7]
  ];
  const corner = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          corner[c] = values[at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          if (corner[c] < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let count = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a];
          const vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += (a & 1) + ((b & 1) - (a & 1)) * t;
          sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
          sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
          count++;
        }
        cellVertex[cell(i, j, k)] = positions.length / 3;
        positions.push(min.x + (i + sx / count) * step, min.y + (j + sy / count) * step, min.z + (k + sz / count) * step);
      }

  const index: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, b, c, a, c, d);
    else index.push(a, c, b, a, d, c);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const here = values[at(i, j, k)] < 0;
        // Along x: the four cells round the edge from (i, j, k) to (i + 1, j, k).
        if (i < nx - 1 && here !== values[at(i + 1, j, k)] < 0) quad(cellVertex[cell(i, j - 1, k - 1)], cellVertex[cell(i, j, k - 1)], cellVertex[cell(i, j, k)], cellVertex[cell(i, j - 1, k)], here);
        if (j < ny - 1 && here !== values[at(i, j + 1, k)] < 0) quad(cellVertex[cell(i - 1, j, k - 1)], cellVertex[cell(i - 1, j, k)], cellVertex[cell(i, j, k)], cellVertex[cell(i, j, k - 1)], here);
        if (k < nz - 1 && here !== values[at(i, j, k + 1)] < 0) quad(cellVertex[cell(i - 1, j - 1, k)], cellVertex[cell(i, j - 1, k)], cellVertex[cell(i, j, k)], cellVertex[cell(i - 1, j, k)], here);
      }

  // Onto the surface: a couple of Newton steps along the field's gradient.
  const e = step * 0.25;
  for (let v = 0; v < positions.length; v += 3) {
    for (let n = 0; n < 2; n++) {
      const [x, y, z] = [positions[v], positions[v + 1], positions[v + 2]];
      const d = field(x, y, z);
      const gx = (field(x + e, y, z) - field(x - e, y, z)) / (2 * e);
      const gy = (field(x, y + e, z) - field(x, y - e, z)) / (2 * e);
      const gz = (field(x, y, z + e) - field(x, y, z - e)) / (2 * e);
      const g2 = gx * gx + gy * gy + gz * gz || 1;
      positions[v] -= (d * gx) / g2;
      positions[v + 1] -= (d * gy) / g2;
      positions[v + 2] -= (d * gz) / g2;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

// What the veil rests on: her face (nose, lips, chin) as overlapping spheres, and the cloak's front. Capsules (ends and
// radius); a sphere is a capsule with both ends at its centre. Read by the cloth on the graphics card.
export const COLLIDERS: { a: number[]; b: number[]; r: number }[] = [
  { a: [0, 1.6, 0.03], b: [0, 1.56, 0.035], r: 0.092 },
  { a: [0, 1.575, 0.104], b: [0, 1.575, 0.104], r: 0.016 },
  { a: [0, 1.52, 0.07], b: [0, 1.52, 0.07], r: 0.025 },
  { a: [-0.12, 1.3, 0.035], b: [0.12, 1.3, 0.035], r: 0.105 },
  { a: [-0.1, 1.17, 0.02], b: [0.1, 1.17, 0.02], r: 0.135 }
];

// Where the veil is pinned: just inside the hood's rim, round the top of the opening, from one side over to the other.
export function pinAt(f: number) {
  const a = Math.PI * (0.06 + 0.88 * f);
  const x = Math.cos(a) * (OPENING.rx + 0.004);
  const y = OPENING.centre.y + Math.sin(a) * (OPENING.ry + 0.004);
  // The rim's depth there: on the hood's egg.
  const ex = x / HOOD.radii.x;
  const ey = (y - HOOD.centre.y) / HOOD.radii.y;
  const z = HOOD.centre.z + HOOD.radii.z * Math.sqrt(Math.max(0, 1 - ex * ex - ey * ey)) - 0.006;
  return V(x, y, z);
}
