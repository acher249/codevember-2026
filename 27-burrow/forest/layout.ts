import { mulberry32 } from "../../shared/engine/random";
import { faceZ, topY } from "../field";
import { CLEARING, clearingEdge, forestGround, onPath } from "./terrain";

// Where everything in the forest stands, worked out once: the trees round the clearing and along the cliff's foot, the
// line of them along the top of the cliff against the sky, and the low growth.

// 2 near the clearing (full trunks, roots, fine canopy), 1 further, 0 the far ring.
export type TreeSpot = { x: number; y: number; z: number; height: number; radius: number; lean: [number, number]; seed: number; detail: 0 | 1 | 2 };

// Whether a point on the ground is clear of the cliff by `room` metres (in front of its face).
export const beforeFace = (x: number, z: number, room: number) => z > faceZ(x, forestGround(x, z) + 1) + room;

// Darts thrown at a region and kept where they are far enough from all kept so far.
function scatter(rand: () => number, tries: number, pick: () => [number, number] | null, spacing: (x: number, z: number) => number, taken: { x: number; z: number; r: number }[]) {
  const kept: [number, number][] = [];
  for (let n = 0; n < tries; n++) {
    const at = pick();
    if (!at) continue;
    const [x, z] = at;
    const r = spacing(x, z);
    if (taken.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < (Math.max(r, t.r) * 0.95) ** 2)) continue;
    taken.push({ x, z, r });
    kept.push(at);
  }
  return kept;
}

// How far from the clearing's middle the woods are drawn.
export const FOREST_REACH = 95;

export function plantTrees(): TreeSpot[] {
  const rand = mulberry32(2701);
  const taken: { x: number; z: number; r: number }[] = [];
  const spots: TreeSpot[] = [];
  // In front of the cliff: close round the clearing, thinning a little with distance; wide gaps on the sun's side so
  // the low light streams in between the trunks.
  const front = scatter(
    rand,
    9000,
    () => {
      const a = rand() * Math.PI;
      const d = Math.sqrt(rand()) * FOREST_REACH;
      const x = CLEARING.x + Math.cos(a) * d * 1.15;
      const z = 1 + Math.sin(a) * d;
      const edge = clearingEdge(x, z);
      if (edge < 0.8 || !beforeFace(x, z, 1.4)) return null;
      return [x, z];
    },
    (x, z) => {
      const edge = clearingEdge(x, z);
      const sunSide = x > CLEARING.x + 6 && z > 0 ? 1.25 : 1;
      return (3.6 + Math.min(edge, 40) * 0.08) * sunSide;
    },
    taken
  );
  for (const [x, z] of front) {
    const edge = clearingEdge(x, z);
    const detail: 0 | 1 | 2 = edge < 16 ? 2 : edge < 42 ? 1 : 0;
    // The trees right at the edge lean a little out over the clearing, toward the light.
    const lean: [number, number] = [(rand() - 0.5) * 0.08, (rand() - 0.5) * 0.08];
    if (edge < 6) {
      const dx = CLEARING.x - x;
      const dz = CLEARING.z - z;
      const d = Math.hypot(dx, dz);
      lean[0] += (dx / d) * 0.05;
      lean[1] += (dz / d) * 0.05;
    }
    const height = (17 + rand() * 9 + Math.min(edge, 30) * 0.08) * (0.55 + 0.45 * Math.min(1, Math.max(0, (z - 2) / 16)));
    const radius = 0.26 + rand() * 0.26 + (rand() < 0.15 ? 0.2 : 0);
    const seed = Math.floor(rand() * 1e9);
    // About one in five a younger tree, shorter and slimmer, so the wood is of all ages rather than one height.
    const young = (seed % 97) / 97 < 0.2 ? 0.62 + ((seed >> 8) % 100) / 500 : 1;
    spots.push({
      x,
      y: forestGround(x, z),
      z,
      // Lower beside the face, so the cliff stands over the wood rather than the wood over it.
      height: height * young,
      radius: radius * (young < 1 ? 0.7 : 1),
      lean,
      seed,
      detail
    });
  }
  // Along the top of the cliff: a line of trees standing over the face, against the sky.
  const top = scatter(
    rand,
    2000,
    () => {
      const x = (rand() - 0.5) * 130;
      // Well back from the lip, so from below the rock face, not the trees on top, holds the eye.
      // Further back still in the middle of the view, so the rock's edge stands clean against the sky there.
      const z = (Math.abs(x - 0.6) < 16 ? -17 : -9) - rand() * 30;
      // Well back from the lip.
      if (faceZ(x, topY(x, z) - 1) - z < 2.5) return null;
      return [x, z];
    },
    () => 5,
    taken
  );
  for (const [x, z] of top) {
    const lip = Math.abs(z) < 18;
    spots.push({
      x,
      y: topY(x, z),
      z,
      height: 13 + rand() * 7,
      radius: 0.22 + rand() * 0.2,
      lean: [(rand() - 0.5) * 0.1, (rand() - 0.5) * 0.1 + 0.03],
      seed: Math.floor(rand() * 1e9),
      detail: lip && Math.abs(x) < 30 ? 1 : 0
    });
  }
  return spots;
}

// The young trees and saplings of the understorey, thin and short, a layer between the trunks.
export function plantSaplings(): TreeSpot[] {
  const rand = mulberry32(919);
  const spots: TreeSpot[] = [];
  for (let n = 0; n < 4000 && spots.length < 70; n++) {
    const a = rand() * Math.PI;
    const d = 8 + rand() * 30;
    const x = CLEARING.x + Math.cos(a) * d * 1.2;
    const z = 1 + Math.sin(a) * d;
    const edge = clearingEdge(x, z);
    if (edge < 0.2 || edge > 22 || !beforeFace(x, z, 0.8)) continue;
    spots.push({ x, y: forestGround(x, z), z, height: 4 + rand() * 4, radius: 0.05 + rand() * 0.05, lean: [(rand() - 0.5) * 0.2, (rand() - 0.5) * 0.2], seed: Math.floor(rand() * 1e9), detail: 1 });
  }
  return spots;
}

// Spots for low growth, by how far into the trees each kind likes to be (edge, in metres past the clearing's edge),
// how many, and how far from the face it keeps.
export function spotsFor(seed: number, count: number, from: number, to: number, room = 0.6, reach = 40) {
  const rand = mulberry32(seed);
  const out: { x: number; z: number; r: number }[] = [];
  for (let n = 0; n < count * 40 && out.length < count; n++) {
    const a = rand() * Math.PI * 1.0;
    const d = Math.sqrt(rand()) * reach;
    const x = CLEARING.x + Math.cos(a) * d * 1.2;
    const z = 1 + Math.sin(a) * d + rand() * 4;
    const edge = clearingEdge(x, z);
    if (edge < from || edge > to || !beforeFace(x, z, room) || onPath(x, z)) continue;
    out.push({ x, z, r: rand() });
  }
  return out;
}

// Every trunk, planted once for the visit.
let planted: { trees: TreeSpot[]; saplings: TreeSpot[] } | null = null;
export const forestTrees = () => (planted ??= { trees: plantTrees(), saplings: plantSaplings() });

// A trunk's radius at a height above its foot, as trees.ts builds it (without the bark's small ripples).
const trunkRadius = (t: TreeSpot, up: number) => t.radius * (1 - (up / t.height) * 0.62) * (1 + Math.exp(-Math.max(0, up - 0.35) / 0.55) * 0.5);

// How far inside a trunk a point is (positive inside), for walking into one.
export function treeSolid(x: number, y: number, z: number) {
  let best = -9;
  for (const t of forestTrees().trees) {
    const dx = x - t.x;
    const dz = z - t.z;
    if (dx * dx + dz * dz > 4) continue;
    const up = y - t.y;
    if (up < -0.5 || up > t.height * 0.75) continue;
    best = Math.max(best, trunkRadius(t, up) + 0.05 - Math.hypot(dx - t.lean[0] * up, dz - t.lean[1] * up));
  }
  return best;
}

// Where a ray first meets a trunk, or Infinity.
export function treeHit(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, far: number) {
  let best = Infinity;
  for (const t of forestTrees().trees) {
    const ox = o.x - t.x;
    const oz = o.z - t.z;
    const a = d.x * d.x + d.z * d.z;
    const b = ox * d.x + oz * d.z;
    const c = ox * ox + oz * oz - t.radius * t.radius;
    const disc = b * b - a * c;
    if (disc < 0 || a < 1e-6) continue;
    const s = (-b - Math.sqrt(disc)) / a;
    if (s > 0 && s < Math.min(best, far)) {
      const y = o.y + d.y * s - t.y;
      if (y > 0 && y < t.height * 0.75) best = s;
    }
  }
  return best;
}
