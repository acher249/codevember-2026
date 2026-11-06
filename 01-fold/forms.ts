import { hillsAt, PANEL_DEPTH, PANEL_WIDTH, PANELS, SHEET_WIDTH } from "./map";

// The sheet is cut into flat facets along its creases, and every facet gets one matrix a frame.
// Coordinates on the sheet are (x, z), centred, with the land on +y and the back on -y.

type V2 = readonly [number, number];
type Vertex = { x: number; z: number; qx: number; qz: number; history: number[] };

export type Step = {
  a: V2;
  b: V2;
  // A point on the side that moves. Positive angles lift that side toward the land.
  toward: V2;
  angle: number;
  stage: number;
  // A flat fold: later lines are drawn on the sheet as it lies after this one.
  flat?: boolean;
  joint?: boolean;
  lift?: number;
  only?: number;
  unless?: number;
  // Nothing grows on it, which leaves the bare paper.
  bare?: boolean;
};

export type Facet = {
  id: number;
  // In order around the facet, on the flat sheet.
  poly: number[];
  free: boolean[];
  nodes?: [number, number, number];
  growth: number;
  // Trees only stand on what ends up roughly level.
  upright: boolean;
};

export type Crease = { joint: number; facet: number; a: V2; b: V2 };

export type Family = {
  key: FamilyKey;
  facets: Facet[];
  steps: Step[];
  creases: Crease[];
  stages: number;
  relief: number;
  lookup: Int32Array[];
  nodes?: { x: number; z: number; row: number; neighbours: Set<number> }[];
  pose: (angles: Float32Array, out: RootPose, stageDone: (stage: number) => number, clock: number) => void;
};

export type RootPose = { rx: number; ry: number; rz: number; hover: number };

export type FamilyKey = "strip" | "vault" | "plane" | "box";
export const SHAPE_FAMILY: Record<string, FamilyKey> = { pleats: "strip", roll: "strip", wave: "strip", stair: "strip", facets: "vault", plane: "plane", box: "box" };

export const MAX_FACETS = 256;
const W = SHEET_WIDTH / 2;
const D = PANEL_DEPTH / 2;
const EPS = 1e-4;
const GRID_X = 48;
const GRID_Z = 26;
// How far the underside of the sheet stays off the meadow: enough to read as floating, near enough for a tight shadow.
// The gold rods reach 0.042 past the paper, so they stay clear of it too.
const CLEARANCE = 0.075;
// The back of the sheet sits this far behind its land.
const BACK = 0.012;
// The most a crease being dragged may raise the whole sheet in one pointer move.
const MAX_RISE = 0.14;
// Stages a second. A long arm swinging under the sheet raises all of it, so this sets how hard it rises and falls.
const ORIGAMI_RATE = 1.2;

const ease = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

function cutFacets(steps: Step[]) {
  type Piece = { verts: Vertex[]; free: boolean[] };
  const corner = (x: number, z: number): Vertex => ({ x, z, qx: x, qz: z, history: [] });
  let pieces: Piece[] = [{ verts: [corner(-W, -D), corner(-W, D), corner(W, D), corner(W, -D)], free: [] }];

  steps.forEach((step, index) => {
    const dx = step.b[0] - step.a[0];
    const dz = step.b[1] - step.a[1];
    const length = Math.hypot(dx, dz);
    let nx = -dz / length;
    let nz = dx / length;
    if ((step.toward[0] - step.a[0]) * nx + (step.toward[1] - step.a[1]) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const side = (v: Vertex) => (v.qx - step.a[0]) * nx + (v.qz - step.a[1]) * nz;

    const next: Piece[] = [];
    for (const piece of pieces) {
      for (const v of piece.verts) v.history.push(v.qx, v.qz);
      const eligible = (step.only === undefined || piece.free[step.only]) && (step.unless === undefined || !piece.free[step.unless]);
      const sides = piece.verts.map(side);
      if (!eligible || sides.every((s) => s <= EPS)) {
        next.push({ verts: piece.verts, free: [...piece.free, false] });
        continue;
      }
      if (sides.every((s) => s >= -EPS)) {
        next.push({ verts: piece.verts, free: [...piece.free, true] });
        continue;
      }
      const inside: Vertex[] = [];
      const outside: Vertex[] = [];
      piece.verts.forEach((v, i) => {
        const w = piece.verts[(i + 1) % piece.verts.length];
        const sv = sides[i];
        const sw = sides[(i + 1) % sides.length];
        if (sv >= -EPS) inside.push({ ...v, history: [...v.history] });
        if (sv <= EPS) outside.push({ ...v, history: [...v.history] });
        if ((sv > EPS && sw < -EPS) || (sv < -EPS && sw > EPS)) {
          const t = sv / (sv - sw);
          const mix = (from: number, to: number) => from + (to - from) * t;
          const cut: Vertex = { x: mix(v.x, w.x), z: mix(v.z, w.z), qx: mix(v.qx, w.qx), qz: mix(v.qz, w.qz), history: v.history.map((h, k) => mix(h, w.history[k])) };
          inside.push({ ...cut, history: [...cut.history] });
          outside.push({ ...cut, history: [...cut.history] });
        }
      });
      if (inside.length > 2) next.push({ verts: inside, free: [...piece.free, true] });
      if (outside.length > 2) next.push({ verts: outside, free: [...piece.free, false] });
    }
    if (step.flat) {
      for (const piece of next) {
        if (!piece.free[index]) continue;
        for (const v of piece.verts) {
          const s = side(v);
          v.qx -= 2 * s * nx;
          v.qz -= 2 * s * nz;
        }
      }
    }
    pieces = next;
  });

  const facets: Facet[] = pieces.map((piece, id) => ({ id, poly: piece.verts.flatMap((v) => [v.x, v.z]), free: piece.free, growth: 1, upright: true }));
  const creases: Crease[] = [];
  steps.forEach((step, index) => {
    if (!step.joint) return;
    const dx = step.b[0] - step.a[0];
    const dz = step.b[1] - step.a[1];
    const length = Math.hypot(dx, dz);
    const on = (v: Vertex) => Math.abs((v.history[index * 2] - step.a[0]) * dz - (v.history[index * 2 + 1] - step.a[1]) * dx) / length < 1e-3;
    pieces.forEach((piece, id) => {
      if (!piece.free[index]) return;
      piece.verts.forEach((v, i) => {
        const w = piece.verts[(i + 1) % piece.verts.length];
        if (on(v) && on(w) && Math.hypot(v.x - w.x, v.z - w.z) > 0.02) creases.push({ joint: index, facet: id, a: [v.x, v.z], b: [w.x, w.z] });
      });
    });
  });
  return { facets, creases };
}

function buildLookup(facets: Facet[]) {
  const cells: number[][] = Array.from({ length: GRID_X * GRID_Z }, () => []);
  for (const facet of facets) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < facet.poly.length; i += 2) {
      minX = Math.min(minX, facet.poly[i]);
      maxX = Math.max(maxX, facet.poly[i]);
      minZ = Math.min(minZ, facet.poly[i + 1]);
      maxZ = Math.max(maxZ, facet.poly[i + 1]);
    }
    const x0 = Math.max(0, Math.floor(((minX + W) / (2 * W)) * GRID_X));
    const x1 = Math.min(GRID_X - 1, Math.floor(((maxX + W) / (2 * W)) * GRID_X));
    const z0 = Math.max(0, Math.floor(((minZ + D) / (2 * D)) * GRID_Z));
    const z1 = Math.min(GRID_Z - 1, Math.floor(((maxZ + D) / (2 * D)) * GRID_Z));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cells[z * GRID_X + x].push(facet.id);
  }
  return cells.map((cell) => Int32Array.from(cell));
}

const facetContains = (facet: Facet, x: number, z: number) => {
  const poly = facet.poly;
  let sign = 0;
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length;
    const cross = (poly[j] - poly[i]) * (z - poly[i + 1]) - (poly[j + 1] - poly[i + 1]) * (x - poly[i]);
    if (Math.abs(cross) < 1e-6) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
};

export const edgeDistance = (facet: Facet, x: number, z: number) => {
  const poly = facet.poly;
  let best = Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length;
    const dx = poly[j] - poly[i];
    const dz = poly[j + 1] - poly[i + 1];
    const length = Math.hypot(dx, dz) || 1;
    best = Math.min(best, Math.abs((x - poly[i]) * dz - (z - poly[i + 1]) * dx) / length);
  }
  return best;
};

// Ground rises away from every crease, so facets still meet exactly when they fold.
export const groundHeight = (facet: Facet, x: number, z: number) => {
  if (facet.growth <= 0) return 0;
  return hillsAt(x + W, z) * Math.min(1, edgeDistance(facet, x, z) * 6) * facet.growth;
};

/* Strips: the panels either side of the fourth hinge stay put, and each hinge carries what lies outward of it. */

function stripFamily(): Family {
  const steps: Step[] = [];
  const hinge = (k: number): Step => {
    const x = k * PANEL_WIDTH - W;
    return { a: [x, -D], b: [x, D], toward: k >= 4 ? [W, 0] : [-W, 0], angle: 0, stage: 0, joint: true };
  };
  for (let k = PANELS - 1; k >= 4; k--) steps.push(hinge(k));
  for (let k = 1; k <= 3; k++) steps.push(hinge(k));
  const { facets, creases } = cutFacets(steps);
  return { key: "strip", facets, steps, creases, stages: 1, relief: 1, lookup: buildLookup(facets), pose: () => {} };
}

const stripHinge = (stepIndex: number) => (stepIndex < 4 ? PANELS - 1 - stepIndex : stepIndex - 3);

function stripTarget(shape: string, hingeNumber: number, amount: number, clock: number) {
  if (shape === "pleats") return (hingeNumber % 2 ? -2 : 2) * amount * 0.72;
  if (shape === "roll") return amount * ((Math.PI * 2) / PANELS);
  if (shape === "wave") return Math.sin(hingeNumber * 1.15 + clock * 0.9) * amount * 0.95;
  if (shape === "stair") return (hingeNumber % 2 ? 1 : -1) * amount * (Math.PI / 2);
  return 0;
}

const PI = Math.PI;
const tip22 = 3.6 / Math.tan(PI / 8);
const BOX_AJAR = 0.22;

/* A dart. Corners go under twice to make the nose, then the wings and the keel. */
function planeFamily(): Family {
  const nose = -W;
  const reach = nose + tip22;
  const steps: Step[] = [
    { a: [-W, 0], b: [W, 0], toward: [0, D], angle: 0, stage: 0 },
    { a: [nose, 0], b: [nose + D, D], toward: [nose, D], angle: -PI, stage: 0, flat: true, lift: -0.012 },
    { a: [nose, 0], b: [nose + D, -D], toward: [nose, -D], angle: -PI, stage: 0, flat: true, lift: -0.012 },
    { a: [nose, 0], b: [reach, D], toward: [nose + D, D], angle: -PI, stage: 1, flat: true, lift: -0.024 },
    { a: [nose, 0], b: [reach, -D], toward: [nose + D, -D], angle: -PI, stage: 1, flat: true, lift: -0.024 },
    { a: [W, 2.1], b: [W - 2.6, D], toward: [W, D], angle: -PI, stage: 1, flat: true, lift: -0.012 },
    { a: [W, -2.1], b: [W - 2.6, -D], toward: [W, -D], angle: -PI, stage: 1, flat: true, lift: -0.012 },
    { a: [-W, 1.05], b: [W, 1.05], toward: [0, D], angle: -1.36, stage: 3, joint: true },
    { a: [-W, -1.05], b: [W, -1.05], toward: [0, -D], angle: -1.36, stage: 3, joint: true },
    { a: [-W, 0], b: [W, 0], toward: [0, D], angle: PI - 0.28, stage: 2, joint: true, only: 0 }
  ];
  const { facets, creases } = cutFacets(steps);
  return {
    key: "plane",
    facets,
    steps,
    creases,
    stages: 4,
    relief: 0.42,
    lookup: buildLookup(facets),
    pose(_, out, done, clock) {
      const e = done(2);
      // Banked toward the viewer so the wings read, with the nose coming round.
      out.rx = -(1.43 + 0.5 * done(3)) * e;
      out.ry = 0.62 * done(3);
      out.rz = -(0.1 + Math.sin(clock * 0.5) * 0.025) * done(3);
      out.hover = (0.16 + Math.sin(clock * 0.7) * 0.05) * done(3);
    }
  };
}

/* A carton: four walls in a row wrap into a tube with the land outside, the flaps at each end close over it, and it stands on end. */
function boxFamily(): Family {
  const side = 2 * PANEL_WIDTH;
  const flapAt = D - side / 2;
  // The flaps that go under sit a little further in, so that they never share a plane with the ones over them.
  const under = flapAt - 0.04;
  // Lines that move nothing, so each flap below can name its own wall.
  const mark = (x: number): Step => ({ a: [x, -D], b: [x, D], toward: [-W, 0], angle: 0, stage: 0 });
  const flap = (end: number, at: number, stage: number, only?: number, unless?: number): Step => ({
    a: [-W, end * at],
    b: [W, end * at],
    toward: [0, end * D],
    angle: -PI / 2,
    stage,
    joint: true,
    only,
    unless,
    // +z becomes the bottom, which nobody sees and nothing should hang from.
    bare: end > 0
  });
  const hinge = (x: number, toward: number, stage: number): Step => ({ a: [x, -D], b: [x, D], toward: [toward, 0], angle: -PI / 2, stage, joint: true });
  const steps: Step[] = [
    mark(-side),
    mark(0),
    mark(side),
    flap(-1, under, 2, 1, 0),
    flap(-1, under, 2, undefined, 2),
    flap(1, under, 2, 1, 0),
    flap(1, under, 2, undefined, 2),
    // The two top flaps stand a little open, which is what makes it read as a box.
    { ...flap(-1, flapAt, 3, 0), angle: -PI / 2 + BOX_AJAR },
    { ...flap(-1, flapAt, 3, 2, 1), angle: -PI / 2 + BOX_AJAR },
    flap(1, flapAt, 3, 0),
    flap(1, flapAt, 3, 2, 1),
    hinge(-side, -W, 0),
    hinge(0, -W, 1),
    hinge(side, W, 0)
  ];
  const { facets, creases } = cutFacets(steps);
  return {
    key: "box",
    facets,
    steps,
    creases,
    stages: 5,
    relief: 0.5,
    lookup: buildLookup(facets),
    pose(_, out, done) {
      // Standing it up puts the seam where the sheet's two ends meet round the back.
      out.rx = -(PI / 2) * done(4);
      out.ry = 0.62 * done(4);
      out.rz = 0;
      out.hover = 0;
    }
  };
}

/* Triangles over a dome: a staggered grid whose rows push in and out, so every facet catches the light differently. */
function vaultFamily(): Family {
  const rows = 5;
  const columns = PANELS;
  const rowHeight = (2 * D) / rows;
  const cell = (2 * W) / columns;
  const nodes: NonNullable<Family["nodes"]> = [];
  const rowNodes: number[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: number[] = [];
    const push = (x: number) => {
      nodes.push({ x, z: -D + r * rowHeight, row: r, neighbours: new Set() });
      row.push(nodes.length - 1);
    };
    if (r % 2 === 0) for (let c = 0; c <= columns; c++) push(-W + c * cell);
    else {
      push(-W);
      for (let c = 0; c < columns; c++) push(-W + (c + 0.5) * cell);
      push(W);
    }
    rowNodes.push(row);
  }

  const facets: Facet[] = [];
  const edges = new Set<string>();
  const creases: Crease[] = [];
  const steps: Step[] = [];
  const tri = (a: number, b: number, c: number) => {
    const na = nodes[a];
    const nb = nodes[b];
    const nc = nodes[c];
    const id = facets.length;
    facets.push({ id, poly: [na.x, na.z, nb.x, nb.z, nc.x, nc.z], free: [], nodes: [a, b, c], growth: 1, upright: true });
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a]
    ]) {
      nodes[p].neighbours.add(q);
      nodes[q].neighbours.add(p);
      const key = p < q ? `${p}-${q}` : `${q}-${p}`;
      const np = nodes[p];
      const nq = nodes[q];
      const outer = (Math.abs(np.x) >= W - EPS && Math.abs(nq.x) >= W - EPS) || (np.row === nq.row && (np.row === 0 || np.row === rows));
      if (edges.has(key) || outer) continue;
      edges.add(key);
      creases.push({ joint: creases.length, facet: id, a: [np.x, np.z], b: [nq.x, nq.z] });
    }
  };
  for (let r = 0; r < rows; r++) {
    const low = rowNodes[r];
    const high = rowNodes[r + 1];
    let i = 0;
    let j = 0;
    while (i < low.length - 1 || j < high.length - 1) {
      const lowNext = i < low.length - 1 ? nodes[low[i + 1]].x : Infinity;
      const highNext = j < high.length - 1 ? nodes[high[j + 1]].x : Infinity;
      if (lowNext <= highNext) {
        tri(low[i], high[j], low[i + 1]);
        i++;
      } else {
        tri(low[i], high[j], high[j + 1]);
        j++;
      }
    }
  }
  return { key: "vault", facets, steps, creases, stages: 1, relief: 0.6, lookup: buildLookup(facets), nodes, pose: () => {} };
}

const cache = new Map<FamilyKey, Family>();
export function familyFor(key: FamilyKey): Family {
  let family = cache.get(key);
  if (!family) {
    family = key === "strip" ? stripFamily() : key === "plane" ? planeFamily() : key === "box" ? boxFamily() : vaultFamily();
    cache.set(key, family);
  }
  return family;
}

type Hit = { facet: number; t: number; x: number; z: number; land: boolean };

// All of the fold's state. Scenes read matrices and ask questions; this owns the pose.
export class FoldRig {
  family: Family;
  wanted: Family;
  angles = new Float32Array(32);
  drag = new Float32Array(MAX_FACETS * 2);
  offsets = new Float32Array(0);
  matrices = new Float32Array(MAX_FACETS * 12);
  previous = new Float32Array(MAX_FACETS * 12);
  progress = 0;
  relief = 1;
  root = new Float64Array(9);
  tx = 0;
  ty = CLEARANCE;
  tz = 0;
  // Added to ty whenever the sheet would otherwise reach the floor, and let go of slowly.
  lift = 0;
  // Things standing on the land, as facet, x, y, z and radius, set by whoever placed them.
  guards = new Float32Array(0);
  settled = false;
  // The current fold has finished arriving.
  folded = false;
  smoothing = false;
  level = 0;
  hover = -1;
  held = -1;
  private rotation = new Float64Array(12);
  private scratch = new Float64Array(12);
  private out: RootPose = { rx: 0, ry: 0, rz: 0, hover: 0 };

  constructor(start: FamilyKey) {
    this.family = this.wanted = familyFor(start);
    this.resetFamily();
    this.settleGrowth(this.family);
  }

  private resetFamily() {
    this.drag.fill(0);
    this.offsets = new Float32Array((this.family.nodes?.length ?? 0) * 3);
    this.hover = this.held = -1;
  }

  // Land grows on every face it can, however steep: just not inside a fold, or on a face turned down at the ground.
  settleGrowth(family: Family) {
    if (family.key === "strip" || family.key === "vault") return;
    const { steps, facets } = family;
    const angles = new Float32Array(steps.length);
    steps.forEach((step, i) => (angles[i] = step.angle));
    family.pose(angles, this.out, () => 1, 0);
    this.rootRotation();
    const worlds = facets.map((facet) => {
      const matrix = new Float64Array(12);
      matrix[0] = matrix[5] = matrix[10] = 1;
      for (let s = 0; s < steps.length; s++) {
        if (!facet.free[s]) continue;
        this.stepMatrix(steps[s], angles[s], this.rotation, steps[s].lift ?? 0);
        premultiply(matrix, this.rotation);
      }
      const points: number[] = [];
      for (let i = 0; i < facet.poly.length; i += 2) {
        const x = facet.poly[i];
        const z = facet.poly[i + 1];
        points.push(matrix[0] * x + matrix[2] * z + matrix[3], matrix[4] * x + matrix[6] * z + matrix[7], matrix[8] * x + matrix[10] * z + matrix[11]);
      }
      return { matrix, points };
    });
    facets.forEach((facet, f) => {
      const { matrix, points } = worlds[f];
      let cx = 0;
      let cy = 0;
      let cz = 0;
      const count = points.length / 3;
      for (let i = 0; i < points.length; i += 3) {
        cx += points[i] / count;
        cy += points[i + 1] / count;
        cz += points[i + 2] / count;
      }
      const nx = matrix[1];
      const ny = matrix[5];
      const nz = matrix[9];
      let covered = false;
      for (let g = 0; g < facets.length && !covered; g++) {
        if (g === f) continue;
        covered = rayFan(worlds[g].points, cx + nx * 0.002, cy + ny * 0.002, cz + nz * 0.002, nx, ny, nz, 0.7) !== null;
      }
      const bare = steps.some((step, s) => step.bare && facet.free[s]);
      facet.growth = covered || bare ? 0 : 1;
      facet.upright = this.root[3] * nx + this.root[4] * ny + this.root[5] * nz > -0.3;
    });
  }

  private stepMatrix(step: Step, angle: number, out: Float64Array, lift: number) {
    const dx = step.b[0] - step.a[0];
    const dz = step.b[1] - step.a[1];
    const length = Math.hypot(dx, dz);
    let nx = -dz / length;
    let nz = dx / length;
    if ((step.toward[0] - step.a[0]) * nx + (step.toward[1] - step.a[1]) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    // The axis that lifts the moving side toward +y for a positive angle.
    const wx = -nz;
    const wz = nx;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const k = 1 - c;
    out[0] = c + wx * wx * k;
    out[1] = -wz * s;
    out[2] = wx * wz * k;
    out[4] = wz * s;
    out[5] = c;
    out[6] = -wx * s;
    out[8] = wz * wx * k;
    out[9] = wx * s;
    out[10] = c + wz * wz * k;
    const ax = step.a[0];
    const az = step.a[1];
    out[3] = ax - (out[0] * ax + out[2] * az);
    out[7] = -(out[4] * ax + out[6] * az) + lift * (Math.abs(angle) / PI);
    out[11] = az - (out[8] * ax + out[10] * az);
  }

  // Roll about the spine (+z toward +y), then pitch, then turn on the spot.
  private rootRotation() {
    const { rx, ry, rz } = this.out;
    const c = Math.cos(rx);
    const s = Math.sin(rx);
    const cy = Math.cos(ry);
    const sy = Math.sin(ry);
    const cz = Math.cos(rz);
    const sz = Math.sin(rz);
    const r = this.root;
    r[0] = cy * cz;
    r[1] = -cy * sz * c - sy * s;
    r[2] = -cy * sz * s + sy * c;
    r[3] = sz;
    r[4] = cz * c;
    r[5] = cz * s;
    r[6] = -sy * cz;
    r[7] = sy * sz * c - cy * s;
    r[8] = sy * sz * s + cy * c;
  }

  private writePose(withDrag: boolean, target: Float32Array) {
    const { facets, steps, nodes } = this.family;
    const { root, scratch } = this;
    if (nodes) return this.writeVault(withDrag, target);
    for (const facet of facets) {
      const m = scratch;
      m.fill(0);
      m[0] = m[5] = m[10] = 1;
      for (let s = 0; s < steps.length; s++) {
        const step = steps[s];
        if (!facet.free[s]) continue;
        const angle = this.angles[s] + (withDrag ? this.drag[s] : 0);
        if (angle !== 0) {
          this.stepMatrix(step, angle, this.rotation, step.lift ?? 0);
          premultiply(m, this.rotation);
        }
      }
      const o = facet.id * 12;
      for (let row = 0; row < 3; row++) {
        const a = root[row * 3];
        const b = root[row * 3 + 1];
        const c = root[row * 3 + 2];
        target[o + row * 4] = a * m[0] + b * m[4] + c * m[8];
        target[o + row * 4 + 1] = a * m[1] + b * m[5] + c * m[9];
        target[o + row * 4 + 2] = a * m[2] + b * m[6] + c * m[10];
        target[o + row * 4 + 3] = a * m[3] + b * m[7] + c * m[11];
      }
    }
  }

  // Each node has one place, and each triangle stretches between its three, so nothing can tear.
  private writeVault(withDrag: boolean, target: Float32Array) {
    const { facets, nodes } = this.family;
    if (!nodes) return;
    const amount = this.level * ease(this.progress);
    const curve = Math.max(1e-3, (amount * 1.75) / W);
    const depth = amount * 0.26;
    const n = nodes.length;
    if (!this.nodeWorld || this.nodeWorld.length !== n * 3) this.nodeWorld = new Float64Array(n * 3);
    const world = this.nodeWorld;
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      const tx = node.x * curve;
      const tz = node.z * curve * 0.9;
      let nx = Math.sin(tx);
      let ny = Math.cos(tx) * Math.cos(tz);
      let nz = Math.sin(tz);
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const push = (node.row % 2 ? -depth : depth) * (Math.abs(node.x) >= W - EPS ? 0.4 : 1);
      world[i * 3] = Math.sin(tx) / curve + nx * push;
      world[i * 3 + 1] = (Math.cos(tx) - 1) / curve + (Math.cos(tz) - 1) / (curve * 0.9) + ny * push;
      world[i * 3 + 2] = Math.sin(tz) / (curve * 0.9) + nz * push;
      if (withDrag) {
        world[i * 3] += this.offsets[i * 3];
        world[i * 3 + 1] += this.offsets[i * 3 + 1];
        world[i * 3 + 2] += this.offsets[i * 3 + 2];
      }
    }
    for (const facet of facets) {
      const [a, b, c] = facet.nodes as [number, number, number];
      const fx0 = nodes[a].x;
      const fz0 = nodes[a].z;
      const ex1 = nodes[b].x - fx0;
      const ez1 = nodes[b].z - fz0;
      const ex2 = nodes[c].x - fx0;
      const ez2 = nodes[c].z - fz0;
      const det = ex1 * ez2 - ex2 * ez1;
      const ax = world[a * 3];
      const ay = world[a * 3 + 1];
      const az = world[a * 3 + 2];
      const b1x = world[b * 3] - ax;
      const b1y = world[b * 3 + 1] - ay;
      const b1z = world[b * 3 + 2] - az;
      const b2x = world[c * 3] - ax;
      const b2y = world[c * 3 + 1] - ay;
      const b2z = world[c * 3 + 2] - az;
      // d/dx and d/dz of the map from the flat triangle to the world one.
      const xx = (b1x * ez2 - b2x * ez1) / det;
      const xy = (b1y * ez2 - b2y * ez1) / det;
      const xz = (b1z * ez2 - b2z * ez1) / det;
      const zx = (b2x * ex1 - b1x * ex2) / det;
      const zy = (b2y * ex1 - b1y * ex2) / det;
      const zz = (b2z * ex1 - b1z * ex2) / det;
      let upx = zy * xz - zz * xy;
      let upy = zz * xx - zx * xz;
      let upz = zx * xy - zy * xx;
      const up = Math.hypot(upx, upy, upz) || 1;
      upx /= up;
      upy /= up;
      upz /= up;
      const o = facet.id * 12;
      target[o] = xx;
      target[o + 1] = upx;
      target[o + 2] = zx;
      target[o + 3] = ax - xx * fx0 - zx * fz0;
      target[o + 4] = xy;
      target[o + 5] = upy;
      target[o + 6] = zy;
      target[o + 7] = ay - xy * fx0 - zy * fz0;
      target[o + 8] = xz;
      target[o + 9] = upz;
      target[o + 10] = zz;
      target[o + 11] = az - xz * fx0 - zz * fz0;
    }
  }

  private nodeWorld: Float64Array | null = null;

  // Returns true when the family was swapped this frame, which only happens with the sheet flat.
  update(delta: number, shape: string, amount: number, clock: number) {
    let swapped = false;
    const wanted = familyFor(SHAPE_FAMILY[shape] ?? "strip");
    this.wanted = wanted;
    if (this.family !== wanted) {
      this.folded = false;
      const speed = this.family.key === "strip" || this.family.key === "vault" ? 2 : ORIGAMI_RATE;
      this.progress = Math.max(0, this.progress - delta * speed);
      this.relief = Math.max(0, this.relief - delta * 2.4);
      for (let i = 0; i < this.family.steps.length; i++) this.drag[i] *= Math.exp(-delta * 9);
      this.offsets.forEach((value, i) => (this.offsets[i] = value * Math.exp(-delta * 9)));
      let flat = this.progress <= 0 && this.relief <= 0;
      for (let i = 0; i < this.family.steps.length && flat; i++) flat = Math.abs(this.angles[i]) + Math.abs(this.drag[i]) < 0.015;
      if (flat) {
        this.settleGrowth(wanted);
        this.family = wanted;
        this.angles.fill(0);
        this.resetFamily();
        this.guards = new Float32Array(0);
        swapped = true;
      }
    } else {
      const origami = this.family.key === "plane" || this.family.key === "box";
      const goal = origami ? this.family.stages * Math.min(1, amount / 0.6) : 1;
      const rate = origami ? ORIGAMI_RATE : 2;
      this.progress += Math.max(-rate * delta, Math.min(rate * delta, goal - this.progress));
      this.folded = this.progress === goal;
      const reliefGoal = this.family.relief;
      this.relief += Math.max(-1.6 * delta, Math.min(1.6 * delta, reliefGoal - this.relief));
    }

    const family = this.family;
    const { steps, key } = family;
    const done = (stage: number) => ease(this.progress - stage);
    if (key === "strip") {
      const rate = 1 - Math.exp(-delta * 3.5);
      const e = done(0);
      for (let s = 0; s < steps.length; s++) {
        const target = stripTarget(shape in SHAPE_FAMILY && SHAPE_FAMILY[shape] === "strip" ? shape : "flat", stripHinge(s), amount * (0.9 + Math.sin(clock * 0.42) * 0.1), clock) * e;
        this.angles[s] += (target - this.angles[s]) * rate;
      }
      // Pleats and waves sit level on average. A roll or a stair rests flat on its middle panels.
      let heading = 0;
      let mean = 0;
      for (let s = 3; s >= 0; s--) {
        heading += this.angles[s];
        mean += heading / PANELS;
      }
      heading = 0;
      for (let s = 6; s >= 4; s--) {
        heading -= this.angles[s];
        mean += heading / PANELS;
      }
      const resting = shape === "roll" || shape === "stair";
      this.level += ((resting ? 0 : -mean) - this.level) * rate;
      this.out.rx = 0;
      this.out.ry = 0;
      this.out.rz = this.level;
      this.out.hover = 0;
    } else if (key === "vault") {
      const rate = 1 - Math.exp(-delta * 3);
      this.level += (amount * (0.92 + Math.sin(clock * 0.42) * 0.08) - this.level) * rate;
      this.out.rx = this.out.ry = this.out.rz = this.out.hover = 0;
    } else {
      for (let s = 0; s < steps.length; s++) this.angles[s] = steps[s].angle * done(steps[s].stage);
      // The wings and the flaps keep breathing once they are up.
      for (let s = 0; s < steps.length; s++) {
        if (key === "box" && (s === 7 || s === 8)) this.angles[s] += Math.sin(clock * 0.8) * 0.05 * done(4);
        if (key === "plane" && (s === 7 || s === 8)) this.angles[s] += Math.sin(clock * 0.9) * 0.05 * done(3);
      }
      family.pose(this.angles, this.out, done, clock);
    }
    this.rootRotation();

    // Rest and centre from the fold as shaped, never from a crease being dragged, so that a drag moves only its own side.
    this.previous.set(this.matrices);
    this.writePose(false, this.matrices);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const m = this.matrices;
    for (const facet of family.facets) {
      const o = facet.id * 12;
      for (let i = 0; i < facet.poly.length; i += 2) {
        const x = facet.poly[i];
        const z = facet.poly[i + 1];
        const wx = m[o] * x + m[o + 2] * z + m[o + 3];
        const wz = m[o + 8] * x + m[o + 10] * z + m[o + 11];
        minX = Math.min(minX, wx);
        maxX = Math.max(maxX, wx);
        minZ = Math.min(minZ, wz);
        maxZ = Math.max(maxZ, wz);
      }
    }
    const follow = this.settled ? 1 - Math.exp(-delta * 5) : 1;
    const hug = this.settled ? 1 - Math.exp(-delta * 14) : 1;
    this.settled = true;
    this.tx += (-(minX + maxX) / 2 - this.tx) * follow;
    // Height hugs the floor. The fold is already smooth, so this needs little smoothing of its own, and any rise pays off the lift.
    const rise = (CLEARANCE - this.lowestPoint(m) + this.out.hover - this.ty) * hug;
    this.ty += rise;
    this.lift = Math.max(0, this.lift - Math.max(0, rise));
    this.tz += (-(minZ + maxZ) / 2 - this.tz) * follow;

    if (this.smoothing) {
      const fade = Math.exp(-delta * 5);
      let left = 0;
      for (let i = 0; i < steps.length; i++) {
        this.drag[i] *= fade;
        left += Math.abs(this.drag[i]);
      }
      for (let i = 0; i < this.offsets.length; i++) {
        this.offsets[i] *= fade;
        left += Math.abs(this.offsets[i]);
      }
      if (left < 1e-3) {
        this.drag.fill(0);
        this.offsets.fill(0);
        this.smoothing = false;
      }
    }

    this.lift *= Math.exp(-delta * 2.5);
    this.writeFinal();
    return swapped;
  }

  // The lowest these untranslated matrices reach: every corner on both faces, and whatever stands on the land.
  private lowestPoint(m: Float32Array) {
    let low = Infinity;
    for (const facet of this.family.facets) {
      const o = facet.id * 12;
      const back = BACK * Math.max(0, m[o + 5]);
      for (let i = 0; i < facet.poly.length; i += 2) low = Math.min(low, m[o + 4] * facet.poly[i] + m[o + 6] * facet.poly[i + 1] + m[o + 7] - back);
    }
    const squash = Math.max(0.02, this.relief);
    const { guards } = this;
    for (let i = 0; i < guards.length; i += 5) {
      const o = guards[i] * 12;
      // The radius lies in the facet's plane, so it only reaches down as far as the facet tilts.
      const tilt = Math.hypot(m[o + 4], m[o + 6]);
      low = Math.min(low, m[o + 4] * guards[i + 1] + m[o + 5] * guards[i + 2] * squash + m[o + 6] * guards[i + 3] + m[o + 7] - guards[i + 4] * tilt);
    }
    return low;
  }

  // Everything that moves the sheet ends here, so no frame and no pointer move can put it through the floor.
  private writeFinal() {
    this.writePose(true, this.matrices);
    const m = this.matrices;
    this.lift = Math.max(this.lift, CLEARANCE - this.lowestPoint(m) - this.ty);
    for (const facet of this.family.facets) {
      const o = facet.id * 12;
      m[o + 3] += this.tx;
      m[o + 7] += this.ty + this.lift;
      m[o + 11] += this.tz;
    }
  }

  toWorld(facet: number, x: number, y: number, z: number, out: { x: number; y: number; z: number }) {
    const m = this.matrices;
    const o = facet * 12;
    out.x = m[o] * x + m[o + 1] * y + m[o + 2] * z + m[o + 3];
    out.y = m[o + 4] * x + m[o + 5] * y + m[o + 6] * z + m[o + 7];
    out.z = m[o + 8] * x + m[o + 9] * y + m[o + 10] * z + m[o + 11];
    return out;
  }

  upY(facet: number) {
    return this.matrices[facet * 12 + 5];
  }

  locate(x: number, z: number, hint = -1) {
    const { facets, lookup } = this.family;
    if (hint >= 0 && hint < facets.length && facetContains(facets[hint], x, z)) return hint;
    const gx = Math.min(GRID_X - 1, Math.max(0, Math.floor(((x + W) / (2 * W)) * GRID_X)));
    const gz = Math.min(GRID_Z - 1, Math.max(0, Math.floor(((z + D) / (2 * D)) * GRID_Z)));
    const cell = lookup[gz * GRID_X + gx];
    for (let i = 0; i < cell.length; i++) if (facetContains(facets[cell[i]], x, z)) return cell[i];
    return -1;
  }

  // The first facet along a ray, by its flat polygon.
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): Hit | null {
    let best: Hit | null = null;
    let limit = maxT;
    const m = this.matrices;
    for (const facet of this.family.facets) {
      const o = facet.id * 12;
      const poly = facet.poly;
      const ax = m[o] * poly[0] + m[o + 2] * poly[1] + m[o + 3];
      const ay = m[o + 4] * poly[0] + m[o + 6] * poly[1] + m[o + 7];
      const az = m[o + 8] * poly[0] + m[o + 10] * poly[1] + m[o + 11];
      const nx = m[o + 1];
      const ny = m[o + 5];
      const nz = m[o + 9];
      const denom = nx * dx + ny * dy + nz * dz;
      if (Math.abs(denom) < 1e-6) continue;
      const t = (nx * (ax - ox) + ny * (ay - oy) + nz * (az - oz)) / denom;
      if (t < 0 || t >= limit) continue;
      const px = ox + dx * t - m[o + 3];
      const py = oy + dy * t - m[o + 7];
      const pz = oz + dz * t - m[o + 11];
      // The tangent columns are orthonormal for folds and nearly so for the dome.
      const cxx = m[o] * m[o] + m[o + 4] * m[o + 4] + m[o + 8] * m[o + 8];
      const czz = m[o + 2] * m[o + 2] + m[o + 6] * m[o + 6] + m[o + 10] * m[o + 10];
      const x = (m[o] * px + m[o + 4] * py + m[o + 8] * pz) / cxx;
      const z = (m[o + 2] * px + m[o + 6] * py + m[o + 10] * pz) / czz;
      if (!facetContains(facet, x, z)) continue;
      limit = t;
      best = { facet: facet.id, t, x, z, land: denom < 0 };
    }
    return best;
  }

  // Closest crease within reach of a ray, and only if nothing of the sheet stands in front of it.
  pickCrease(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, reach: number) {
    const { creases } = this.family;
    let best: { crease: number; t: number; x: number; y: number; z: number } | null = null;
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    for (let c = 0; c < creases.length; c++) {
      const crease = creases[c];
      this.toWorld(crease.facet, crease.a[0], 0, crease.a[1], a);
      this.toWorld(crease.facet, crease.b[0], 0, crease.b[1], b);
      const ux = b.x - a.x;
      const uy = b.y - a.y;
      const uz = b.z - a.z;
      const wx = ox - a.x;
      const wy = oy - a.y;
      const wz = oz - a.z;
      const uu = ux * ux + uy * uy + uz * uz;
      const ud = ux * dx + uy * dy + uz * dz;
      const uw = ux * wx + uy * wy + uz * wz;
      const dw = dx * wx + dy * wy + dz * wz;
      const denom = uu - ud * ud;
      let s = denom > 1e-8 ? (uw - ud * dw) / denom : 0;
      s = Math.min(1, Math.max(0, s));
      const t = Math.max(0, ud * s - dw);
      const qx = a.x + ux * s;
      const qy = a.y + uy * s;
      const qz = a.z + uz * s;
      const miss = Math.hypot(ox + dx * t - qx, oy + dy * t - qy, oz + dz * t - qz);
      if (miss > reach * t || (best && t >= best.t)) continue;
      best = { crease: c, t, x: qx, y: qy, z: qz };
    }
    if (!best) return null;
    const front = this.raycast(ox, oy, oz, dx, dy, dz, best.t - 0.2);
    return front ? null : best;
  }

  private freeCentre(joint: number, out: { x: number; y: number; z: number }) {
    const m = this.matrices;
    let x = 0;
    let y = 0;
    let z = 0;
    let count = 0;
    for (const facet of this.family.facets) {
      if (!facet.free[joint]) continue;
      const o = facet.id * 12;
      for (let i = 0; i < facet.poly.length; i += 2) {
        x += m[o] * facet.poly[i] + m[o + 2] * facet.poly[i + 1] + m[o + 3];
        y += m[o + 4] * facet.poly[i] + m[o + 6] * facet.poly[i + 1] + m[o + 7];
        z += m[o + 8] * facet.poly[i] + m[o + 10] * facet.poly[i + 1] + m[o + 11];
        count++;
      }
    }
    out.x = x / Math.max(1, count);
    out.y = y / Math.max(1, count);
    out.z = z / Math.max(1, count);
  }

  dragDirection = { x: 0, y: 1, z: 0 };

  // Turns one joint by a world-space pointer move. The moving side follows the pointer, whichever way it faces.
  // Which way this joint moves on screen as it turns, looking along (fx, fy, fz).
  aimDrag(joint: number, fx: number, fy: number, fz: number) {
    const before = { x: 0, y: 0, z: 0 };
    const after = { x: 0, y: 0, z: 0 };
    this.freeCentre(joint, before);
    const nudge = 0.02;
    this.drag[joint] += nudge;
    this.writeFinal();
    this.freeCentre(joint, after);
    this.drag[joint] -= nudge;
    this.writeFinal();
    let vx = (after.x - before.x) / nudge;
    let vy = (after.y - before.y) / nudge;
    let vz = (after.z - before.z) / nudge;
    const full = Math.hypot(vx, vy, vz) || 1;
    const facing = vx * fx + vy * fy + vz * fz;
    vx -= fx * facing;
    vy -= fy * facing;
    vz -= fz * facing;
    const seen = Math.hypot(vx, vy, vz);
    // Near edge-on the direction is unreliable, so keep the last good one.
    if (seen > full * 0.25) {
      this.dragDirection.x = vx / seen;
      this.dragDirection.y = vy / seen;
      this.dragDirection.z = vz / seen;
    }
  }

  dragJoint(joint: number, mx: number, my: number, mz: number, fx: number, fy: number, fz: number) {
    this.aimDrag(joint, fx, fy, fz);
    const d = this.dragDirection;
    const turn = Math.max(-0.22, Math.min(0.22, (mx * d.x + my * d.y + mz * d.z) * 0.7));
    const was = this.drag[joint];
    const liftWas = this.lift;
    // Pushed against the floor the whole sheet rises to make way, so ease off rather than let it jump.
    for (let share = 1; share > 0.1; share /= 2) {
      const next = was + turn * share;
      if (this.family.key === "strip") {
        const limit = PI * 0.96;
        this.drag[joint] = Math.max(-limit, Math.min(limit, this.angles[joint] + next)) - this.angles[joint];
      } else {
        this.drag[joint] = Math.max(-1.3, Math.min(1.3, next));
      }
      this.writeFinal();
      if (this.lift - liftWas <= MAX_RISE) return;
      this.lift = liftWas;
    }
    this.drag[joint] = was;
    this.writeFinal();
  }

  // On the dome a crease is two nodes: pull them, and the neighbours give a little.
  dragNodes(crease: number, mx: number, my: number, mz: number) {
    const { nodes, creases } = this.family;
    if (!nodes) return;
    const facet = this.family.facets[creases[crease].facet];
    const [ax, az] = creases[crease].a;
    const [bx, bz] = creases[crease].b;
    const moved = new Map<number, number>();
    for (const index of facet.nodes as [number, number, number]) {
      const node = nodes[index];
      const here = (Math.abs(node.x - ax) < EPS && Math.abs(node.z - az) < EPS) || (Math.abs(node.x - bx) < EPS && Math.abs(node.z - bz) < EPS);
      if (!here) continue;
      moved.set(index, 1);
    }
    for (const index of [...moved.keys()]) for (const near of nodes[index].neighbours) if (!moved.has(near)) moved.set(near, 0.28);
    for (const [index, weight] of moved) {
      const i = index * 3;
      const x = this.offsets[i] + mx * weight;
      const y = this.offsets[i + 1] + my * weight;
      const z = this.offsets[i + 2] + mz * weight;
      const length = Math.hypot(x, y, z);
      const scale = length > 1.5 ? 1.5 / length : 1;
      this.offsets[i] = x * scale;
      this.offsets[i + 1] = y * scale;
      this.offsets[i + 2] = z * scale;
    }
    this.writeFinal();
  }
}

function premultiply(m: Float64Array, r: Float64Array) {
  for (let col = 0; col < 4; col++) {
    const a = m[col];
    const b = m[4 + col];
    const c = m[8 + col];
    m[col] = r[0] * a + r[1] * b + r[2] * c + (col === 3 ? r[3] : 0);
    m[4 + col] = r[4] * a + r[5] * b + r[6] * c + (col === 3 ? r[7] : 0);
    m[8 + col] = r[8] * a + r[9] * b + r[10] * c + (col === 3 ? r[11] : 0);
  }
}

function rayFan(points: number[], ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number) {
  for (let i = 3; i + 5 < points.length; i += 3) {
    const e1x = points[i] - points[0];
    const e1y = points[i + 1] - points[1];
    const e1z = points[i + 2] - points[2];
    const e2x = points[i + 3] - points[0];
    const e2y = points[i + 4] - points[1];
    const e2z = points[i + 5] - points[2];
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-8) continue;
    const tx = ox - points[0];
    const ty = oy - points[1];
    const tz = oz - points[2];
    const u = (tx * px + ty * py + tz * pz) / det;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) / det;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (t > 0 && t < maxT) return t;
  }
  return null;
}
