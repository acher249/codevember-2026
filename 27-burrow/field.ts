// The rock as a field of numbers: positive inside rock, negative in air, roughly the distance in metres to the nearest
// surface either way. It goes on for ever: a cliff with a plateau over it and ground at its foot, all of it solid, with
// caverns placed by hashed cells, and every dig kept as a sparse list of edits. Chunks of it are sampled on a 20 cm grid
// and meshed by surface nets in workers as the visitor comes near. Pure arithmetic with no three.js, so the workers and
// the page run exactly the same numbers: the page reads the field directly to walk and aim, never waiting on a mesh.

import { forestGround } from "./forest/terrain";

export const VOXEL = 0.2;
export const CHUNK = 32;
export const SIZE = CHUNK * VOXEL;
// The field is kept within this much either way, so a dig far from a surface never piles up huge numbers.
const LIMIT = 2.5;

// How big a bite each strike takes.
export const DIG_RADIUS = 1.2;

// The plain cliff and ground drawn beyond the chunks that are meshed sit this far back inside the rock, so they never
// show in front of the real surface.
export const BACKDROP_BACK = 0.15;

// ---- Noise ---------------------------------------------------------------------------------------------------------

function hash3(x: number, y: number, z: number) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);
export function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Value noise from -1 to 1.
export function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const w = fade(z - zi);
  const a = hash3(xi, yi, zi) + (hash3(xi + 1, yi, zi) - hash3(xi, yi, zi)) * u;
  const b = hash3(xi, yi + 1, zi) + (hash3(xi + 1, yi + 1, zi) - hash3(xi, yi + 1, zi)) * u;
  const c = hash3(xi, yi, zi + 1) + (hash3(xi + 1, yi, zi + 1) - hash3(xi, yi, zi + 1)) * u;
  const d = hash3(xi, yi + 1, zi + 1) + (hash3(xi + 1, yi + 1, zi + 1) - hash3(xi, yi + 1, zi + 1)) * u;
  const e = a + (b - a) * v;
  const f = c + (d - c) * v;
  return (e + (f - e) * w) * 2 - 1;
}

// Value noise in two dimensions, from -1 to 1: half the hashing of noise3, for the face, which is all in x and y.
function hash2(x: number, y: number) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise2(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u + (c - a + (d - c - b + a) * u) * v) * 2 - 1;
}

function fbm2(x: number, y: number, octaves: number) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

function fbm3(x: number, y: number, z: number, octaves: number) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise3(x * f, y * f, z * f);
    f *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

// ---- The cliff face ------------------------------------------------------------------------------------------------

// A granite wall, as Yosemite's are (El Capitan, the Cathedral Rocks): no beds, but blocks and sheets. The rock splits
// along a few joints that run long distances up the face and along curved sheets parallel to it (exfoliation); slabs
// fall away between them, so the face is a patchwork of smooth blocks and slabs standing at different depths, with corners
// (dihedrals) and roofs where one block steps out past the next, and here and there a long crack running up through
// them. Over tens of metres it swells into buttresses and sinks into bays, and at the top it rolls over into a rounded,
// broken skyline of domes and notches.

export const CLIFF_TOP = 19;

// Blocks: the wall splits along upright joints a few metres apart (irregularly, each leaning and wandering), and within
// each column between two of them, along sheet joints across it at heights and spacings of that column's own, so they
// never line up from one column to the next (staggered, like a wall of unevenly laid stone). Each block stands at its
// own depth: where one steps out past its neighbour there is a corner (a dihedral), past the one below it a roof, and
// behind the one below it a ledge. Some joints are open, as cracks, over part of their length.
// Returns [offset, crack] in `blockOut`.
const blockOut: [number, number] = [0, 0];
const COLUMN = 5.5;
// Where a column's sheet joints fall, as a coordinate that counts them.
const sheetRise = (k: number) => 4 + hash3(k, 5, 9) * 8;
const sheetOf = (k: number, x: number, y: number) => (y + hash3(k, 4, 9) * 12) / sheetRise(k) + (hash3(k, 6, 9) - 0.5) * 0.22 * x + noise2(x * 0.11, y * 0.06 + k) * 0.3;
// Most blocks stand near the wall's own line; now and then one stands well out or back.
const blockDepth = (k: number, h: number) => {
  const r = hash3(k, h, 77) * 2 - 1;
  return Math.sign(r) * Math.abs(r) ** 1.4 * 0.5;
};
function blocks(x: number, y: number, amp: number) {
  // Across the columns (warped, so their spacing varies from 3 to 8 m and each joint wanders and leans).
  const u = (x + noise2(y * 0.045, 3.3) * 3.4 + noise2(y * 0.16, 8.1) * 0.5 + y * 0.1) / COLUMN + noise2(x * 0.07, 1.7) * 0.42;
  const k = Math.floor(u);
  const f = u - k;
  const v = sheetOf(k, x, y);
  const h = Math.floor(v);
  const g = v - h;
  const own = blockDepth(k, h);
  // Toward the column's side: the neighbour's block at this height, met over 25 cm.
  const side = f < 0.5 ? k - 1 : k + 1;
  const toSide = Math.min(f, 1 - f) * COLUMN;
  const next = blockDepth(side, Math.floor(sheetOf(side, x, y)));
  // Toward a sheet joint above or below: that block, met over 20 cm.
  const rise = sheetRise(k);
  const toSheet = Math.min(g, 1 - g) * rise;
  const over = blockDepth(k, g < 0.5 ? h - 1 : h + 1);
  let d = own;
  d += (next - own) * 0.5 * (1 - smooth(0, 0.25, toSide));
  d += (over - own) * 0.5 * (1 - smooth(0, 0.2, toSheet));
  blockOut[0] = d * amp;
  // Open joints: about a third of the upright ones and a quarter of the sheet joints, each over part of its length.
  let crack = 0;
  const kc = f < 0.5 ? k : k + 1;
  if (hash3(kc, 8, 3) < 0.3) {
    const w = 0.14 + hash3(kc, 9, 3) * 0.2;
    const t = toSide / w;
    if (t < 2.5) crack = -(0.35 + hash3(kc, 1, 3) * 0.45) * smooth(-0.3, 0.15, noise2(y * 0.06, kc * 2.3)) * Math.exp(-t * t);
  }
  const hc = g < 0.5 ? h : h + 1;
  if (hash3(k, hc, 31) < 0.16) {
    const w = 0.1 + hash3(k, hc, 32) * 0.14;
    const t = toSheet / w;
    if (t < 2.5) crack = Math.min(crack, -(0.25 + hash3(k, hc, 33) * 0.35) * smooth(-0.2, 0.25, noise2(x * 0.2, hc * 1.9 + k)) * Math.exp(-t * t));
  }
  blockOut[1] = crack;
  return blockOut;
}

// Long cracks that run up the wall through the blocks, a few metres apart where they come, each wandering, leaning
// its own way, and dying out above and below; and a sparser set slanting across (`slant`, radians from upright).
function crackSet(x: number, y: number, spacing: number, slant: number, chance: number, seed: number) {
  const s = Math.sin(slant);
  const c = Math.cos(slant);
  // Across the set, and along it.
  const across = x * c - y * s;
  const along = x * s + y * c;
  const w = across + noise2(along * 0.06 + seed, seed) * 1.8 + noise2(along * 0.3, seed + 3) * 0.2;
  const k = Math.floor(w / spacing);
  if (hash3(k, seed, 5) > chance) return 0;
  const at = k * spacing + spacing * (0.2 + hash3(k, seed, 6) * 0.6);
  const width = 0.2 + hash3(k, seed, 7) * 0.3;
  const deep = 0.35 + hash3(k, seed, 8) * 0.75;
  const reach = smooth(-0.25, 0.15, noise2(along * 0.045, k * 3.7 + seed));
  const t = (w - at) / width;
  return t * t > 9 ? 0 : -deep * reach * Math.exp(-t * t);
}

// The skyline: where the face rolls over into the top, along the wall. Domes and notches over tens of metres, and
// blocks broken off the rim (steps of a metre or two).
// Worked out once per 5 cm along the wall and kept: it depends on x alone, and the face asks for it at every sample.
const skylines = new Map<number, number>();
export function skyline(x: number) {
  const key = Math.round(x * 20);
  let at = skylines.get(key);
  if (at === undefined) skylines.set(key, (at = skylineAt(key / 20)));
  return at;
}
function skylineAt(x: number) {
  const u = x / 7 + noise2(x * 0.05, 8.8) * 0.6;
  const k = Math.floor(u);
  const steps = (hash3(k, 91, 1) + (hash3(k + 1, 91, 1) - hash3(k, 91, 1)) * smooth(0.82, 1, u - k) - 0.5) * 2.8;
  // Now and then a gully cuts the rim down a few metres in a V.
  const g = x / 23 + noise2(x * 0.04, 2.2) * 0.3;
  const gk = Math.floor(g);
  const gully = hash3(gk, 5, 5) < 0.45 ? -(1.5 + hash3(gk, 6, 5) * 3.5) * Math.max(0, 1 - Math.abs(g - gk - 0.5) * (6 + hash3(gk, 7, 5) * 8)) : 0;
  return CLIFF_TOP - 1 + fbm2(x * 0.022 + 7.3, 2.1, 3) * 13 + gully + steps + noise2(x * 0.17, 4.4) * 0.5;
}

// How far the face stands out (toward +z) at a point on it.
export function faceZ(x: number, y: number) {
  // Buttresses and bays, tens of metres across and running most of the height.
  const wx = x + noise2(x * 0.03, y * 0.02 + 5) * 6;
  // (Bays are kept shallower than buttresses stand out, so the caverns behind the face keep their roof of rock.)
  const swell = fbm2(wx * 0.045, y * 0.016 + 1.3, 3) * 14;
  // And prows: every 12-30 m along the wall a buttress stands out 2-7 m, its nose blunt, its sides falling back into
  // the corners beside it, thinning and leaning as it climbs.
  const pu = (x + noise2(y * 0.03, 9.1) * 4 + y * 0.12) / 19 + noise2(x * 0.02, 4.4) * 0.35;
  const pk = Math.floor(pu);
  const pf = pu - pk;
  const across = Math.abs(pf - (0.35 + hash3(pk, 2, 41) * 0.3)) / (0.18 + hash3(pk, 3, 41) * 0.14);
  const prow = hash3(pk, 1, 41) < 0.7 ? (2 + hash3(pk, 4, 41) * 5) * Math.max(0, 1 - across * across) ** 0.8 * smooth(-0.6, 0.2, noise2(y * 0.05, pk * 1.7)) : 0;
  const mass = (swell > 0 ? swell : swell * 0.45) + prow;
  // Flakes: sheets of rock peeled off in curved outlines, the face stepping back 30 cm at each (contours of a slow
  // noise, stretched upright), so slab edges run in arcs, as they do on a granite wall.
  const sheet = (fbm2(x * 0.045 + 4, y * 0.024, 3) + noise2(x * 0.14, y * 0.08) * 0.1) * 6;
  const level = Math.floor(sheet);
  const flake = (level + smooth(0.78, 1, sheet - level)) * 0.32;
  // Blocks standing out or back by up to 70 cm, some of their joints open; blockier in some stretches than others.
  const block = blocks(x + mass * 0.5, y, 2 * (0.45 + 0.55 * smooth(-0.3, 0.3, noise2(x * 0.03, 6.6))));
  const blockAt = block[0];
  const blockCrack = block[1];
  // The long cracks up the face, and a sparser set slanting across.
  const cracks = Math.min(crackSet(x, y, 6.5, 0.06, 0.55, 1), crackSet(x, y, 11, 0.75, 0.3, 2), crackSet(x, y, 13, -0.6, 0.25, 3));
  // Smooth, rounded relief on each block, as granite weathers.
  const detail = fbm2(x * 0.5, y * 0.38, 2) * 0.16;
  // Toward the top the wall rolls back over a shoulder into the domes (and the blocks fade there, worn round).
  const top = skyline(x);
  // How broad the shoulder is, and how far back it rolls, both change along the wall: in places the wall runs sheer to
  // the rim, in others it rounds over into a dome.
  const round = smooth(-0.4, 0.4, noise2(x * 0.035, 12.5));
  const shoulder = smooth(top - 3 - round * 8, top + 1, y);
  const worn = 1 - shoulder * 0.45;
  return mass + (flake + blockAt + Math.min(blockCrack, cracks)) * worn + detail - shoulder * shoulder * (1.5 + round * 4);
}

// The top of the cliff: the skyline at the rim, rising gently back into rounded domes behind it.
export function topY(x: number, z: number) {
  const back = Math.max(0, -z - 2);
  return skyline(x) + fbm2(x * 0.05 + 3, z * 0.05, 3) * 1.6 + Math.min(back * 0.12, 2.5);
}

// Solid behind the face and below the top, the edge between them rounded off over most of a metre.
function cliff(face: number, top: number) {
  const k = 1.8;
  const h = Math.max(k - Math.abs(face - top), 0) / k;
  return Math.min(face, top) - h * h * k * 0.25;
}

// How deep into the beds a point lies, for the colour of the rock: they dip into the cliff, so going straight in at one
// height passes from sandstone into shale, and deeper, into a dark wet layer.
export const strata = (x: number, y: number, z: number) => y + x * 0.03 + z * 0.22;

// The ground in front of the cliff: sand and gravel, gently uneven, rising a little toward the foot of the face.
export function groundY(x: number, z: number) {
  return forestGround(x, z);
}

// How deep inside the rock as it was made a point lies (0 on the face, the plateau or the ground, negative in the air),
// ignoring the caverns: for how far daylight reaches, and where rock has been freshly broken.
export const cliffDepth = (x: number, y: number, z: number) => Math.max(cliff(faceZ(x, y) - z, topY(x, z) - y), groundY(x, z) - y);

// The same, for the cliff alone (the face and the plateau, not the ground at its foot): positive inside it, negative out
// in front of the face or over the top. What may be dug from outside is decided by it.
export const cliffMass = (x: number, y: number, z: number) => cliff(faceZ(x, y) - z, topY(x, z) - y);

// ---- Caverns -------------------------------------------------------------------------------------------------------

export type CavernKind =
  | "grotto"
  | "lake"
  | "geode"
  | "fossil"
  | "mine"
  | "hall"
  | "gallery"
  | "river"
  | "mushrooms"
  | "selenite"
  | "bones"
  | "camp"
  | "temple"
  | "lava"
  | "dino"
  | "ammonites"
  | "pool";

export type Cavern = {
  kind: CavernKind;
  name: string;
  // What the share line boasts of.
  boast: string;
  centre: [number, number, number];
  // Half sizes (ellipsoid radii, or the box's half lengths for the mine).
  size: [number, number, number];
  // The flat floor's height, if it has one, and the water's for the lake.
  floor?: number;
  water?: number;
  // The light it holds, cast on its own walls once open: its colour, where it comes from, how far it carries (the
  // larger, the shorter) and how strong.
  glow?: { colour: [number, number, number]; at: [number, number, number]; reach: number; strength: number };
  // A gallery's direction (a unit vector) and its seed, for the ones placed by hashed cells.
  axis?: [number, number, number];
  seed?: number;
  // The hashed cell it was made for, so a worker can make the same one again (cellCavern).
  cell?: [number, number, number];
  // How far from its centre its air reaches (cavernBound), and its field is still under the limit (cavernsNear),
  // worked out once.
  bound?: number;
  reach?: number;
};

// Where the fossil hall's back wall stands (z).
export const FOSSIL_PLANE = -24.4;

export const CAVERNS: Cavern[] = [
  // The glow-worms' blue-green from the roof.
  {
    kind: "grotto",
    name: "a glow-worm grotto",
    boast: "found a grotto of glow-worms",
    centre: [1.2, 3.0, -9.0],
    size: [3.8, 2.6, 3.4],
    floor: 0.75,
    glow: { colour: [0.25, 0.85, 0.75], at: [1.2, 4.95, -9.0], reach: 0.3, strength: 0.32 }
  },
  // The amethyst's violet, from all round.
  {
    kind: "geode",
    name: "a geode",
    boast: "found the geode chamber",
    centre: [7.8, 3.6, -11.2],
    size: [2.4, 2.4, 2.4],
    glow: { colour: [0.55, 0.25, 0.9], at: [7.8, 3.6, -11.2], reach: 0.4, strength: 0.3 }
  },
  // Evening light fallen down the chimney, thrown back off the water round the cavern.
  {
    kind: "lake",
    name: "an underground lake",
    boast: "found a hidden lake under the sky",
    centre: [-7.0, 2.3, -11.5],
    size: [3.4, 2.3, 3.6],
    water: 1.05,
    glow: { colour: [0.95, 0.72, 0.55], at: [-6.4, 1.4, -11.1], reach: 0.18, strength: 0.2 }
  },
  { kind: "mine", name: "an old mine", boast: "broke into an abandoned mine", centre: [0, 1.75, -17.5], size: [10.2, 1.2, 1.05], floor: 0.6 },
  { kind: "fossil", name: "a fossil wall", boast: "uncovered a wall of ammonites", centre: [-2.5, 2.9, -22.6], size: [3.8, 2.2, 2.8], floor: 1.0 }
];

// How far a cavern's air reaches from its centre at most (its lumps, a gallery's bends), the lake's chimney aside.
export function cavernBound(c: Cavern) {
  const [a, b, d] = c.size;
  if (c.kind === "lake") return Infinity;
  if (c.kind === "mine") return Math.hypot(a, b, d) + 0.6;
  if (c.axis) return a + b * 1.1 + 4.6;
  return Math.max(a, b, d) + 1;
}

// How far outside a cavern's air a point lies (negative inside it). Beyond the field's limit it is only the distance past
// the cavern's bound, the same on the page and in the workers, so a mesher may leave out a cavern too far from a block
// of samples to matter.
export function cavernDistance(c: Cavern, x: number, y: number, z: number) {
  const px = x - c.centre[0];
  const py = y - c.centre[1];
  const pz = z - c.centre[2];
  const far = Math.sqrt(px * px + py * py + pz * pz) - (c.bound ??= cavernBound(c));
  if (far > LIMIT) return far;
  const [a, b, d] = c.size;
  if (c.kind === "mine") {
    // A hewn passage: a rounded box, its walls a little uneven, both ends caved in.
    const qx = Math.abs(px) - a;
    const qy = Math.abs(py) - b;
    const qz = Math.abs(pz) - d;
    const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
    if (out > 1.5) return out;
    return out - 0.12 + fbm3(x * 0.9, y * 0.9, z * 0.9, 2) * 0.14 + Math.max(0, Math.abs(px) - a + 1.5) * 0.2 * (noise3(x * 1.3, y * 1.3, z) + 0.6);
  }
  if ((c.kind === "gallery" || c.kind === "river") && c.axis) {
    // A long winding passage: a capsule along its axis, swelling and narrowing, its line bent by noise.
    const [ux, uy, uz] = c.axis;
    const t = Math.max(-a, Math.min(a, px * ux + py * uy + pz * uz));
    // Far from the straight line it winds about (by its bends, lift and widest), no noise is needed.
    const off = Math.hypot(px - ux * t, py - uy * t, pz - uz * t) - b * 1.1 - 4.5;
    if (off > LIMIT) return off;
    const s = c.seed ?? 0;
    const bend = noise3(t * 0.12 + s, s, 3) * 3;
    const lift = noise3(t * 0.1, s + 5, 7) * 1.4;
    const qx = px - ux * t + uz * bend;
    const qy = py - uy * t - lift;
    const qz = pz - uz * t - ux * bend;
    const r = b * (0.75 + noise3(t * 0.25, s + 9, 1) * 0.35);
    const out = Math.hypot(qx, qy / 0.8, qz) - r + Math.max(0, Math.abs(px * ux + py * uy + pz * uz) - a);
    if (out > 1.5) return out;
    return Math.max(out + fbm3(x * 0.6, y * 0.6, z * 0.6, 2) * 0.5, (c.floor ?? -1e9) - y + c.centre[1]);
  }
  // An ellipsoid's distance (Quilez's estimate: exact on its axes, near enough elsewhere, and true far off, so a cavern
  // left out beyond its reach (cavernsNear) is never nearer than the field's limit there).
  const kx = px / a;
  const ky = py / b;
  const kz = pz / d;
  const k = Math.sqrt(kx * kx + ky * ky + kz * kz);
  const k1 = Math.sqrt((kx / a) ** 2 + (ky / b) ** 2 + (kz / d) ** 2);
  let dist = k1 > 1e-6 ? (k * (k - 1)) / k1 : -Math.min(a, b, d);
  // The lake's roof has a chimney up to the plateau, a crack of evening sky the light falls down.
  if (c.kind === "lake") dist = Math.min(dist, chimney(x, y, z));
  // (Lumps move the wall 0.85 m at most, so a point further in than this stays solid; the field there is never drawn.)
  if (dist > 1.3) return dist;
  const lumpy = c.kind === "geode" ? 0.18 : c.kind === "fossil" ? 0.16 : 0.42;
  // (Nor do they matter well out in the air, past where the crevice test of meshChunk looks.)
  if (dist > -1.8) dist += fbm3(x * 0.55, y * 0.55, z * 0.55, 3) * lumpy * 2;
  if (c.floor !== undefined) dist = Math.max(dist, (c.seed !== undefined ? c.centre[1] + c.floor : c.floor) + noise3(x * 0.8, 3, z * 0.8) * 0.08 - y - (c.kind === "pool" ? basin(c, px, pz) : 0));
  // The fossil hall ends in a flat bedding plane, the face the ammonites weathered out of.
  if (c.kind === "fossil") dist = Math.max(dist, FOSSIL_PLANE + noise3(x * 0.6, y * 0.6, 9) * 0.05 - z);
  return dist;
}

// Whether two caverns' air may meet (one can then be seen from the other): a grid over where their bounds overlap, a
// metre apart, then a quarter metre round any point close enough to be in doubt. Each cavern's distance changes by at
// most about 3 m per metre (its lumps included), so a point of shared air is never further below the test than that
// times the spacing's half diagonal: in doubt, they meet.
export function cavernsMeet(a: Cavern, b: Cavern) {
  const ra = (a.bound ??= cavernBound(a));
  const rb = (b.bound ??= cavernBound(b));
  let result = false;
  if (Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1], a.centre[2] - b.centre[2]) < ra + rb) {
    const lo = [0, 1, 2].map((i) => Math.max(a.centre[i] - ra, b.centre[i] - rb));
    const hi = [0, 1, 2].map((i) => Math.min(a.centre[i] + ra, b.centre[i] + rb));
    const both = (x: number, y: number, z: number) => Math.max(cavernDistance(a, x, y, z), cavernDistance(b, x, y, z));
    const scan = (from: number[], to: number[], step: number, doubt: number, then: (x: number, y: number, z: number) => boolean) => {
      for (let x = from[0]; x <= to[0]; x += step)
        for (let y = from[1]; y <= to[1]; y += step)
          for (let z = from[2]; z <= to[2]; z += step) if (both(x, y, z) < doubt && then(x, y, z)) return true;
      return false;
    };
    const fine = (x: number, y: number, z: number) => scan([x - 0.5, y - 0.5, z - 0.5], [x + 0.5, y + 0.5, z + 0.5], 0.25, 3 * 0.125 * 1.74, () => true);
    result = scan(lo, [hi[0] + 0.5, hi[1] + 0.5, hi[2] + 0.5], 1, 3 * 0.5 * 1.74, fine);
  }
  return result;
}

// A crystal pool's basin: how far its floor dips at a point (relative to the centre), deepest mid-chamber, its rim
// easing into the flat floor. The water stands POOL_WATER under the floor's level (dressing).
export const POOL_WATER = 0.14;
export function basin(c: Cavern, px: number, pz: number) {
  const q = Math.hypot(px / (c.size[0] * 0.66), pz / (c.size[2] * 0.66));
  return 0.95 * (1 - smooth(0.3, 1, q));
}

// The lake's chimney: a rough shaft, wider where it opens into the cavern, leaning a little.
export const CHIMNEY = { from: [-6.3, 3.6, -11.0], to: [-5.2, 24, -10.1] } as const;
function chimney(x: number, y: number, z: number) {
  const [ax, ay, az] = CHIMNEY.from;
  const [bx, by, bz] = CHIMNEY.to;
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / (dx * dx + dy * dy + dz * dz)));
  const r = 0.42 + Math.max(0, 0.25 - t) * 2.4;
  const d = Math.hypot(x - ax - dx * t, y - ay - dy * t, z - az - dz * t) - r;
  if (d > 1.2) return d;
  return d + noise3(x * 2.2, y * 1.1, z * 2.2) * 0.12;
}

// ---- Caverns placed by hashed cells --------------------------------------------------------------------------------

// The world is cut into cells; each may hold one cavern, its kind, size and place drawn from the cell's hash, so new ones
// keep turning up however far the digging goes. The cells lie in horizontal layers. The one round the entrance level
// (8 m either side) keeps its caverns seated on the cliff's foot, so a level tunnel breaks into one every 15-25 m.
// Above and below, layers 9 m deep of 12 m cells, nearly every one holding a cavern that all but fills it, each layer's
// grid shifted by its own amount so the walls between caverns never line up from one layer to the next: digging any
// way at all (down, along, up) breaks into something every 10-20 m. The cells round the start are left to the five made
// by hand.
type Band = { y: number; height: number; width: number; chance: number; ox: number; oz: number };
const LAYER = 7.5;
const DENSE = 10;
const bands = new Map<number, Band>();
function band(j: number): Band {
  let b = bands.get(j);
  if (!b) {
    if (j === 0) b = { y: -8, height: 16, width: 11.5, chance: 0.95, ox: 0, oz: 0 };
    else b = { y: j > 0 ? 8 + (j - 1) * LAYER : -8 + j * LAYER, height: LAYER, width: DENSE, chance: j > 0 ? 0.9 : 0.95, ox: hash3(j, 11, 5) * DENSE, oz: hash3(j, 13, 7) * DENSE };
    bands.set(j, b);
  }
  return b;
}
function bandAt(y: number) {
  if (y >= -8 && y < 8) return 0;
  return y >= 8 ? 1 + Math.floor((y - 8) / LAYER) : -1 - Math.floor((-8 - y) / LAYER);
}
// The furthest a cavern reaches from its centre (a long gallery's half length, its bends and margin), across (in the
// entrance band and in the dense layers) and up: how many cells round a box are looked at.
const MOST_ACROSS = 25;
const MOST_ACROSS_DENSE = 20;
const MOST_UP = 11;
// Cells by one number (each axis within about ±2,000 cells): string keys made thousands of garbage strings a frame.
const cellKey = (i: number, j: number, k: number) => i + 4096 + (j + 1024) * 8192 + (k + 4096) * 8192 * 2048;
const cells = new Map<number, Cavern | null>();

function handMade(i: number, j: number, k: number) {
  const { y, height, width, ox, oz } = band(j);
  const x0 = ox + i * width;
  const z0 = oz + k * width;
  return x0 + width > -18 && x0 < 18 && z0 + width > -34 && z0 < 6 && y + height > -8 && y < 14;
}

// What the hashed cells hold, and how likely each is (deeper than 18 m, a fissure of molten rock may turn up instead).
const KINDS: { kind: CavernKind; weight: number; name: string; boast: string }[] = [
  { kind: "hall", weight: 12, name: "a hidden hall", boast: "broke into a hidden hall hung with stalactites" },
  { kind: "gallery", weight: 7, name: "a long gallery", boast: "found a winding gallery deep in the rock" },
  { kind: "river", weight: 9, name: "an underground river", boast: "found a river and a waterfall inside a cliff" },
  { kind: "mushrooms", weight: 10, name: "a mushroom grotto", boast: "found a grotto of glowing mushrooms" },
  { kind: "selenite", weight: 8, name: "a cave of giant crystals", boast: "broke into a cave of giant crystals" },
  { kind: "bones", weight: 8, name: "a cave bears' den", boast: "found the bones of ancient cave bears" },
  { kind: "camp", weight: 9, name: "a lost explorer's camp", boast: "found a lost explorer's camp, its fire still burning" },
  { kind: "temple", weight: 7, name: "a buried doorway", boast: "uncovered a carved doorway buried in the rock" },
  { kind: "dino", weight: 10, name: "a dinosaur's tomb", boast: "found a dinosaur's skeleton sealed in the rock" },
  { kind: "ammonites", weight: 8, name: "a wall of giant ammonites", boast: "found ammonites as big as cartwheels" },
  { kind: "pool", weight: 9, name: "a crystal pool", boast: "found a still crystal pool deep in a cliff" }
];
// Further down, the strange ones come up more often.
const DEEP_WEIGHT: Partial<Record<CavernKind, number>> = { hall: 0.6, gallery: 0.7, river: 0.6, selenite: 1.5, temple: 1.6, camp: 1.2, mushrooms: 1.3, dino: 1.4, ammonites: 1.3, pool: 1.2 };
const weightOf = (option: (typeof KINDS)[number], under: boolean) => option.weight * (under ? (DEEP_WEIGHT[option.kind] ?? 1) : 1);

// A cell's first choice of kind, from its hash alone (an index into KINDS).
function firstChoice(i: number, j: number, k: number) {
  const under = j < 0;
  let roll = hash3(i * 13 + 1, j * 31 + 7, k * 17 + 3) * KINDS.reduce((sum, o) => sum + weightOf(o, under), 0);
  for (let n = 0; n < KINDS.length; n++) {
    roll -= weightOf(KINDS[n], under);
    if (roll <= 0) return n;
  }
  return 0;
}
// Its kind: the first choice, unless a neighbouring cell's first choice is the same, when it draws again from the
// kinds none of its neighbours chose, so caverns dug through one after another are rarely alike.
function kindOf(i: number, j: number, k: number) {
  const first = firstChoice(i, j, k);
  const taken = [firstChoice(i - 1, j, k), firstChoice(i + 1, j, k), firstChoice(i, j, k - 1), firstChoice(i, j, k + 1), firstChoice(i, j - 1, k), firstChoice(i, j + 1, k)];
  if (!taken.includes(first)) return KINDS[first];
  const under = j < 0;
  const left = KINDS.filter((_, n) => !taken.includes(n));
  let roll = hash3(i * 7 + 5, j * 19 + 2, k * 23 + 9) * left.reduce((sum, o) => sum + weightOf(o, under), 0);
  for (const option of left) {
    roll -= weightOf(option, under);
    if (roll <= 0) return option;
  }
  return KINDS[first];
}

export function cellCavern(i: number, j: number, k: number): Cavern | null {
  const key = cellKey(i, j, k);
  const known = cells.get(key);
  if (known !== undefined) return known;
  let made: Cavern | null = null;
  const cell = band(j);
  if (!handMade(i, j, k) && hash3(i, j * 7 + 3, k) < cell.chance) {
    const r = (n: number) => hash3(i * 13 + n, j * 31 + n * 7, k * 17 + n * 3);
    const pick = kindOf(i, j, k);
    const entrance = j === 0;
    const deep = cell.y + cell.height < -18;
    const lava = deep && r(11) < 0.15;
    const kind: CavernKind = lava ? "lava" : pick.kind;
    const long = kind === "gallery" || kind === "river";
    // How big a cavern may be: in the entrance band as before; in the dense layers, all but filling its cell.
    const room = entrance ? 6 : cell.width / 2 - 0.8;
    const tall = entrance ? 4.4 : cell.height / 2 - 0.6;
    const size: [number, number, number] = long
      ? [entrance ? 6 + r(2) * 8 : 5 + r(2) * 4, kind === "river" ? 1.9 + r(3) * 0.8 : 1.4 + r(3) * 1.2, 0]
      : kind === "selenite"
        ? [Math.min(room, 4.6 + r(2) * 3.4), Math.min(tall, 3.4 + r(3) * 1.8), Math.min(room, 4.4 + r(4) * 3.1)]
        : kind === "lava"
          ? [3 + r(2) * 2, Math.min(tall + 0.6, 4.5 + r(3) * 2), 1.4 + r(4) * 0.8]
          : kind === "camp" || kind === "temple"
            ? [Math.min(room, 3.2 + r(2) * 1.5), 2 + r(3) * 0.8, Math.min(room, 3.2 + r(4) * 1.5)]
            : kind === "dino"
              ? [Math.min(room, 4.7 + r(2) * 1.5), Math.min(tall, 2.5 + r(3) * 0.7), Math.min(room, 3.6 + r(4))]
              : kind === "pool"
                ? [Math.min(room, 3.6 + r(2) * 1.2), Math.min(tall, 2.3 + r(3) * 0.7), Math.min(room, 3.6 + r(4) * 1.2)]
                : kind === "ammonites"
                  ? [Math.min(room, 3.4 + r(2) * 1.2), Math.min(tall, 2.4 + r(3) * 0.7), Math.min(room, 3 + r(4) * 1.2)]
                  : [3 + r(2) * (room - 3), 2.4 + r(3) * (tall - 2.4), 3 + r(4) * (room - 3)];
    if (long) size[2] = size[1];
    let centre: [number, number, number];
    if (entrance) {
      const reach = Math.max(...size) + 2;
      centre = [
        i * cell.width + reach + r(5) * Math.max(0.1, cell.width - 2 * reach),
        cell.y + 2 + r(6) * (cell.height - 4),
        k * cell.width + reach + r(7) * Math.max(0.1, cell.width - 2 * reach)
      ];
    } else {
      // Anywhere the cavern still keeps a metre of rock to its cell's sides, half a metre to its top and bottom (a long
      // one, anywhere along the middle of its cell).
      const spare = (half: number) => Math.max(0, cell.width - 2 * (half + 0.8));
      const across = long ? cell.width - 2 : 0;
      centre = [
        cell.ox + (i + 0.5) * cell.width + (r(5) - 0.5) * (long ? across : spare(size[0])),
        cell.y + size[1] + 0.5 + r(6) * Math.max(0, cell.height - 2 * size[1] - 1),
        cell.oz + (k + 0.5) * cell.width + (r(7) - 0.5) * (long ? across : spare(size[2]))
      ];
    }
    // Only wholly inside the rock: no cavern opens into the open air by itself. Under the open ground, one in the
    // entrance band that would break the surface sinks until it has a roof of a metre and a half.
    const ground = groundY(centre[0], centre[2]);
    const inCliff = () => cliff(faceZ(centre[0], centre[1]) - centre[2], topY(centre[0], centre[2]) - centre[1]) > Math.max(...size) + 2;
    // In the entrance band, a cavern behind the face sits on about the level of the cliff's foot, so a level tunnel
    // runs into it; under the open ground it lies just below, under a roof of a metre and a half or more.
    if (entrance) {
      const level = groundY(centre[0], Math.min(centre[2], faceZ(centre[0], 0)));
      centre[1] = level + size[1] * 0.4 + r(12) * 1.2;
      if (!inCliff()) centre[1] = ground - size[1] - 1.5 - r(12) * 3;
    }
    if (inCliff() || ground - centre[1] > size[1] + 1.5) {
      const a = r(8) * Math.PI * 2;
      const tilt = long ? (r(9) - 0.5) * (kind === "river" ? 0.08 : 0.5) : 0;
      const label = lava ? { name: "a fissure of molten rock", boast: "found molten rock glowing deep under a cliff" } : pick;
      made = {
        kind,
        name: label.name,
        boast: label.boast,
        centre,
        size,
        seed: r(10) * 100,
        cell: [i, j, k],
        // (A dinosaur's tomb and a pool on a flatter floor, lower in the chamber: room to walk round the bones, and a
        // basin under a higher roof.)
        floor: -size[1] * (long ? 0.6 : kind === "lava" ? 0.75 : kind === "dino" || kind === "pool" ? 0.6 : 0.55),
        ...(long ? { axis: [Math.cos(a) * Math.cos(tilt), Math.sin(tilt), Math.sin(a) * Math.cos(tilt)] as [number, number, number] } : {})
      };
    }
  }
  cells.set(key, made);
  return made;
}

// The middle of a gallery (or a river's) passage at `t` along its axis, as cavernDistance winds it.
export function galleryCentre(c: Cavern, t: number, out: [number, number, number]) {
  const [ux, uy, uz] = c.axis as [number, number, number];
  const s = c.seed ?? 0;
  const bend = noise3(t * 0.12 + s, s, 3) * 3;
  const lift = noise3(t * 0.1, s + 5, 7) * 1.4;
  out[0] = c.centre[0] + ux * t - uz * bend;
  out[1] = c.centre[1] + uy * t + lift;
  out[2] = c.centre[2] + uz * t + ux * bend;
  return out;
}

// Every cavern whose reach comes within `margin` of a box: the five made by hand and those of the cells round it.
export function cavernsNear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, margin: number, out: Cavern[] = []) {
  out.length = 0;
  // (Out to where its field reaches the limit: past that it changes nothing.)
  const near = (c: Cavern) => {
    const r = (c.reach ??= c.kind === "lake" ? Math.max(...c.size) + 2.5 : cavernBound(c) + LIMIT) + margin;
    const extra = c.kind === "lake" ? 14 : 0;
    return c.centre[0] + r > x0 && c.centre[0] - r < x1 && c.centre[1] + r + extra > y0 && c.centre[1] - r < y1 && c.centre[2] + r > z0 && c.centre[2] - r < z1;
  };
  for (const c of CAVERNS) if (near(c)) out.push(c);
  // (The entrance band's caverns may sink a little below it, under the open ground: MOST_UP covers that too.)
  for (let j = bandAt(y0 - MOST_UP - margin); j <= bandAt(y1 + MOST_UP + margin); j++) {
    const { width: w, ox, oz } = band(j);
    const most = margin + (j === 0 ? MOST_ACROSS : MOST_ACROSS_DENSE);
    for (let i = Math.floor((x0 - most - ox) / w); i <= Math.floor((x1 + most - ox) / w); i++)
      for (let k = Math.floor((z0 - most - oz) / w); k <= Math.floor((z1 + most - oz) / w); k++) {
        const c = cellCavern(i, j, k);
        if (c && near(c)) out.push(c);
      }
  }
  return out;
}

// ---- The field before anything is dug -------------------------------------------------------------------------------

// Solid behind the face and under the plateau, and under the ground everywhere.
const solidOf = (face: number, top: number, ground: number, y: number, z: number) => Math.max(cliff(face - z, top - y), ground - y);

// ---- The plain cliff beyond the meshed chunks -------------------------------------------------------------------------

// The cliff beyond the diggable part (outside.tsx `buildBackdrop`): the very same outer surface (face, top and ground;
// the caverns never reach it), found by casting rays at it, each hit set back BACKDROP_BACK into the rock. Columns
// along x, finer near the middle and coarser far off; in each, rows run up the face to a little under its own rim
// (field.ts `skyline`), turn over the lip from there, and come back down onto the top behind it. Returns the hits row
// by row, `columns` to a row.
// The face is most of the cost, so it is worked out as few times as it can be: once for a ray straight along z, whose
// (x, y) never changes, and for the rays round the lip and onto the top (all in one column, so x is fixed) read from
// a table of the face up that column every 5 cm (filled as it is asked for), linearly between; the top and the
// ground under the column likewise, by z.
const FACE_ROWS = 80;
const LIP_ROWS = 10;
const TOP_ROWS = 16;
const TABLE_STEP = 0.05;
const TABLE = 301;
const Z_FROM = -50;
const Z_TABLE = 1200;
export function backdropGrid() {
  const xs: number[] = [];
  for (let x = -14; x <= 14 + 1e-6; x += 0.25) xs.push(x);
  let step = 0.25;
  for (let x = 14; x < 90; ) {
    step = Math.min(2, step * 1.05);
    x += step;
    xs.push(x);
    xs.unshift(-x);
  }
  const columns = xs.length;
  const rows = FACE_ROWS + 1 + LIP_ROWS + TOP_ROWS;
  const position = new Float32Array(rows * columns * 3);
  const table = new Float32Array(TABLE);
  const tops = new Float32Array(Z_TABLE);
  const grounds = new Float32Array(Z_TABLE);
  const o = [0, 0, 0];
  const d = [0, 0, 0];
  xs.forEach((x, i) => {
    const pivotY = skyline(x) - 3;
    const pivotZ = faceZ(x, pivotY) - 1.6;
    // Filled as the rays ask for it: most of the column is never visited.
    table.fill(NaN);
    const entry = (k: number) => {
      let v = table[k];
      if (v !== v) table[k] = v = faceZ(x, pivotY + k * TABLE_STEP);
      return v;
    };
    const faceAt = (y: number) => {
      const f = (y - pivotY) / TABLE_STEP;
      if (!(f >= 0 && f < TABLE - 1)) return faceZ(x, y);
      const k = Math.floor(f);
      const a = entry(k);
      return a + (entry(k + 1) - a) * (f - k);
    };
    // The top and the ground under the column, by z, the same way (every 5 cm from Z_FROM, filled as asked for).
    tops.fill(NaN);
    grounds.fill(NaN);
    const along = (store: Float32Array, of: (z: number) => number, z: number) => {
      const f = (z - Z_FROM) / TABLE_STEP;
      if (!(f >= 0 && f < Z_TABLE - 1)) return of(z);
      const k = Math.floor(f);
      let a = store[k];
      if (a !== a) store[k] = a = of(Z_FROM + k * TABLE_STEP);
      let b = store[k + 1];
      if (b !== b) store[k + 1] = b = of(Z_FROM + (k + 1) * TABLE_STEP);
      return a + (b - a) * (f - k);
    };
    const topOf = (z: number) => topY(x, z);
    const groundOf = (z: number) => groundY(x, z);
    for (let r = 0; r < rows; r++) {
      let outward = false;
      let face = NaN;
      if (r <= FACE_ROWS) {
        o[0] = x;
        o[1] = -0.6 + (r / FACE_ROWS) * (pivotY + 0.6);
        o[2] = 8;
        d[0] = 0;
        d[1] = 0;
        d[2] = -1;
        face = faceZ(x, o[1]);
      } else if (r <= FACE_ROWS + LIP_ROWS) {
        const a = ((r - FACE_ROWS) / LIP_ROWS) * (Math.PI / 2);
        o[0] = x;
        o[1] = pivotY;
        o[2] = pivotZ;
        d[0] = 0;
        d[1] = Math.sin(a);
        d[2] = Math.cos(a);
        outward = true;
      } else {
        const k = r - FACE_ROWS - LIP_ROWS;
        o[0] = x;
        o[1] = pivotY + 15;
        o[2] = pivotZ - k * 0.4 - k * k * 0.12;
        d[0] = 0;
        d[1] = -1;
        d[2] = 0;
      }
      const sign = outward ? -1 : 1;
      // The ground's part kept apart: a level ray skimming just over the ground would otherwise creep along it 3 cm at a
      // time, when the ground (sloping less than 1 in 3) lets it take steps of 2.5 times what it lies above it.
      let groundPart = 0;
      let cliffPart = 0;
      const density = (t: number) => {
        const y = o[1] + d[1] * t;
        const z = o[2] + d[2] * t;
        const f = face === face ? face : faceAt(y);
        groundPart = along(grounds, groundOf, z) - y;
        cliffPart = cliff(f - z, along(tops, topOf, z) - y);
        return sign * Math.max(cliffPart, groundPart);
      };
      // Where the ray first crosses the surface, from air into rock (or, `outward`, from rock into air).
      let t = 0;
      let last = 0;
      for (let n = 0; n < 400 && t < 40; n++) {
        const v = density(t);
        if (v > 0) {
          let lo = last;
          let hi = t;
          for (let k = 0; k < 6; k++) {
            const mid = (lo + hi) / 2;
            if (density(mid) > 0) hi = mid;
            else lo = mid;
          }
          t = (lo + hi) / 2;
          break;
        }
        last = t;
        // (Only along a level ray, a face row's: the others may run up or down, and the ground with them.)
        t += Math.min(2.5, Math.max(0.03, face === face ? Math.min(-cliffPart * 0.85, -groundPart * 2.5) : -v * 0.85));
      }
      const at = t + (outward ? -BACKDROP_BACK : BACKDROP_BACK);
      const v = (r * columns + i) * 3;
      position[v] = o[0] + d[0] * at;
      position[v + 1] = o[1] + d[1] * at;
      position[v + 2] = o[2] + d[2] * at;
    }
  });
  return { position, columns, rows };
}

// The caverns near each 3 m cube asked about, kept: walking, aiming, the sound's rays and the dressing ask about the
// same few metres again and again, so the cell lookups are made once per cube rather than once per sample.
const CUBE = 3;
const cubes = new Map<number, Cavern[]>();
export function baseDensity(x: number, y: number, z: number) {
  let d = solidOf(faceZ(x, y), topY(x, z), groundY(x, z), y, z);
  if (d < -LIMIT) return -LIMIT;
  const qx = Math.floor(x / CUBE);
  const qy = Math.floor(y / CUBE);
  const qz = Math.floor(z / CUBE);
  const cube = qx + 4096 + (qy + 1024) * 8192 + (qz + 4096) * 8192 * 2048;
  let nearby = cubes.get(cube);
  if (!nearby) {
    if (cubes.size > 40000) cubes.clear();
    nearby = cavernsNear(qx * CUBE, qy * CUBE, qz * CUBE, (qx + 1) * CUBE, (qy + 1) * CUBE, (qz + 1) * CUBE, 0, []);
    cubes.set(cube, nearby);
  }
  for (const c of nearby) d = Math.min(d, cavernDistance(c, x, y, z));
  return Math.max(-LIMIT, Math.min(LIMIT, d));
}

// ---- Digs ----------------------------------------------------------------------------------------------------------

export type Edit = { x: number; y: number; z: number; r: number; seed: number };

const reachOf = (e: Edit) => e.r * 1.35 + 0.3;

// A dig's ball, at one point: lumpy, a little flatter underneath, blended smoothly into what is already open.
function carve(old: number, e: Edit, x: number, y: number, z: number) {
  const dx = x - e.x;
  const dy = y - e.y;
  const dz = z - e.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len > reachOf(e)) return old;
  const s = e.seed * 7.31;
  const wobble = noise3(x * 2.1 + s, y * 2.1, z * 2.1) * 0.16 + noise3(x * 4.7, y * 4.7 + s, z * 4.7) * 0.06;
  const ball = len - e.r * (1 + wobble) + Math.max(0, e.y - e.r * 0.55 - y) * 0.6;
  const blend = 0.32;
  const h = Math.max(blend - Math.abs(old - ball), 0) / blend;
  return Math.max(-LIMIT, Math.min(old, ball) - h * h * blend * 0.25);
}

// Chunk coordinates as one number (each axis within ±512 chunks, about 3 km).
export const chunkKey = (cx: number, cy: number, cz: number) => ((cx + 512) & 1023) | (((cy + 512) & 1023) << 10) | (((cz + 512) & 1023) << 20);
export const chunkOf = (v: number) => Math.floor(v / SIZE);

// The whole rock: the field as made, and every dig since, indexed by the chunks each dig reaches.
export class Rock {
  edits: Edit[] = [];
  byChunk = new Map<number, number[]>();

  add(e: Edit) {
    const n = this.edits.length;
    this.edits.push(e);
    const reach = reachOf(e);
    const touched: number[] = [];
    for (let cx = chunkOf(e.x - reach - VOXEL * 3); cx <= chunkOf(e.x + reach + VOXEL * 3); cx++)
      for (let cy = chunkOf(e.y - reach - VOXEL * 3); cy <= chunkOf(e.y + reach + VOXEL * 3); cy++)
        for (let cz = chunkOf(e.z - reach - VOXEL * 3); cz <= chunkOf(e.z + reach + VOXEL * 3); cz++) {
          const key = chunkKey(cx, cy, cz);
          let list = this.byChunk.get(key);
          if (!list) this.byChunk.set(key, (list = []));
          list.push(n);
          touched.push(key);
        }
    return touched;
  }

  // The field at any point, digs included.
  sample(x: number, y: number, z: number) {
    let d = baseDensity(x, y, z);
    const list = this.byChunk.get(chunkKey(chunkOf(x), chunkOf(y), chunkOf(z)));
    if (list) for (const n of list) d = carve(d, this.edits[n], x, y, z);
    return d;
  }

  gradient(x: number, y: number, z: number, out: number[], h = VOXEL * 0.5) {
    out[0] = this.sample(x + h, y, z) - this.sample(x - h, y, z);
    out[1] = this.sample(x, y + h, z) - this.sample(x, y - h, z);
    out[2] = this.sample(x, y, z + h) - this.sample(x, y, z - h);
    return out;
  }

  // Where a ray first meets rock, as a distance along it, or -1 within `far`.
  march(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, far: number) {
    let t = 0.02;
    let last = this.sample(ox, oy, oz);
    if (last > 0) return 0;
    while (t < far) {
      const step = Math.max(0.05, Math.min(0.6, -last * 0.8));
      const next = Math.min(far, t + step);
      const d = this.sample(ox + dx * next, oy + dy * next, oz + dz * next);
      if (d > 0) {
        let lo = t;
        let hi = next;
        for (let n = 0; n < 6; n++) {
          const mid = (lo + hi) / 2;
          if (this.sample(ox + dx * mid, oy + dy * mid, oz + dz * mid) > 0) hi = mid;
          else lo = mid;
        }
        return (lo + hi) / 2;
      }
      if (next >= far) break;
      t = next;
      last = d;
    }
    return -1;
  }
}

// One cavern alone, as if it were all the rock there is: for placing what grows in it (worms, crystals, fossils) at
// load, which needs thousands of rays and only the cavern's own walls.
export class CavernRock extends Rock {
  cavern: Cavern;

  constructor(cavern: Cavern) {
    super();
    this.cavern = cavern;
  }

  sample(x: number, y: number, z: number) {
    return Math.max(-LIMIT, Math.min(LIMIT, cavernDistance(this.cavern, x, y, z)));
  }
}

// ---- Meshing a chunk -----------------------------------------------------------------------------------------------

export type ChunkMesh = {
  key: number;
  position: Float32Array;
  normal: Float32Array;
  // Per vertex: how deep inside the rock as it was made (0 on its outer surface), how open it is (1) or tucked into a
  // crevice (0), and whether its outer surface there was ground (1) rather than cliff (0).
  info: Float32Array;
  index: Uint32Array;
};

const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1]
];
const EDGES: [number, number][] = [];
for (let a = 0; a < 8; a++)
  for (let b = a + 1; b < 8; b++) if (Math.abs(CORNERS[a][0] - CORNERS[b][0]) + Math.abs(CORNERS[a][1] - CORNERS[b][1]) + Math.abs(CORNERS[a][2] - CORNERS[b][2]) === 1) EDGES.push([a, b]);

// Samples cover the chunk's own 33 per axis plus two either side, for the cells of its low border and for gradients.
const APRON = 2;
const BLOCK = 6;
const N = CHUNK + 1 + APRON * 2;

// Whether a chunk can be passed over: far from every surface (all rock or all air), with no dig in reach.
export function chunkIsUniform(rock: Rock, cx: number, cy: number, cz: number) {
  if (rock.byChunk.has(chunkKey(cx, cy, cz))) return false;
  const x = (cx + 0.5) * SIZE;
  const y = (cy + 0.5) * SIZE;
  const z = (cz + 0.5) * SIZE;
  let d = solidOf(faceZ(x, y), topY(x, z), groundY(x, z), y, z);
  for (const c of cavernsNear(x - SIZE, y - SIZE, z - SIZE, x + SIZE, y + SIZE, z + SIZE, 0, [])) d = Math.min(d, cavernDistance(c, x, y, z));
  return Math.abs(d) > 8.5;
}

// Surface nets over one chunk: a vertex in every cell the surface passes through, at the mean of its edge crossings,
// and a quad across every grid edge it crosses, turned to face the air. Returns null for a chunk with no surface.
export function meshChunk(rock: Rock, cx: number, cy: number, cz: number): ChunkMesh | null {
  const key = chunkKey(cx, cy, cz);
  const ox = cx * SIZE - APRON * VOXEL;
  const oy = cy * SIZE - APRON * VOXEL;
  const oz = cz * SIZE - APRON * VOXEL;
  const g = new Float32Array(N * N * N);
  const at = (i: number, j: number, k: number) => i + N * (j + N * k);
  // What does not change down a column, worked out once per column.
  const face = new Float32Array(N * N);
  const top = new Float32Array(N * N);
  const ground = new Float32Array(N * N);
  for (let b = 0; b < N; b++)
    for (let a = 0; a < N; a++) {
      face[a + N * b] = faceZ(ox + a * VOXEL, oy + b * VOXEL);
      top[a + N * b] = topY(ox + a * VOXEL, oz + b * VOXEL);
      ground[a + N * b] = groundY(ox + a * VOXEL, oz + b * VOXEL);
    }
  const span = N * VOXEL;
  const caves = cavernsNear(ox, oy, oz, ox + span, oy + span, oz + span, 0, []);
  // The caverns that can matter in each block of BLOCK³ samples (any further off give at least the limit everywhere
  // in it, see cavernDistance), so a sample asks two or three rather than every cavern near the chunk.
  const blocks = Math.ceil(N / BLOCK);
  const half = Math.sqrt(3) * BLOCK * VOXEL * 0.5;
  const lists: Cavern[][] = [];
  for (let bk = 0; bk < blocks; bk++)
    for (let bj = 0; bj < blocks; bj++)
      for (let bi = 0; bi < blocks; bi++) {
        const x = ox + (bi + 0.5) * BLOCK * VOXEL;
        const y = oy + (bj + 0.5) * BLOCK * VOXEL;
        const z = oz + (bk + 0.5) * BLOCK * VOXEL;
        lists.push(caves.filter((c) => Math.hypot(x - c.centre[0], y - c.centre[1], z - c.centre[2]) - half - (c.bound ??= cavernBound(c)) <= LIMIT));
      }
  // Digs reaching any of these samples: those listed for this chunk and its neighbours, once each, in order.
  const own = new Set<number>();
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) for (const n of rock.byChunk.get(chunkKey(cx + a, cy + b, cz + c)) ?? []) own.add(n);
  const edits = [...own].sort((p, q) => p - q).map((n) => rock.edits[n]);
  let inside = 0;
  for (let k = 0; k < N; k++)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = ox + i * VOXEL;
        const y = oy + j * VOXEL;
        const z = oz + k * VOXEL;
        let d = solidOf(face[i + N * j], top[i + N * k], ground[i + N * k], y, z);
        if (d > -LIMIT) for (const c of lists[((i / BLOCK) | 0) + blocks * (((j / BLOCK) | 0) + blocks * ((k / BLOCK) | 0))]) d = Math.min(d, cavernDistance(c, x, y, z));
        d = Math.max(-LIMIT, Math.min(LIMIT, d));
        for (const e of edits) d = carve(d, e, x, y, z);
        g[at(i, j, k)] = d;
        if (d > 0) inside++;
      }
  if (inside === 0 || inside === N * N * N) return null;

  // Cells from one before the chunk's first sample to its last (local sample indices APRON - 1 .. APRON + CHUNK - 1).
  const lo = APRON - 1;
  const hi = APRON + CHUNK;
  const L = hi - lo;
  const local = (i: number, j: number, k: number) => i - lo + L * (j - lo + L * (k - lo));
  const cell = new Int32Array(L * L * L).fill(-1);
  const points: number[] = [];
  const v = new Float32Array(8);
  for (let k = lo; k < hi; k++)
    for (let j = lo; j < hi; j++)
      for (let i = lo; i < hi; i++) {
        let solid = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = g[at(i + CORNERS[c][0], j + CORNERS[c][1], k + CORNERS[c][2])];
          if (v[c] > 0) solid++;
        }
        if (solid === 0 || solid === 8) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [a, b] of EDGES) {
          if (v[a] > 0 === v[b] > 0) continue;
          const t = v[a] / (v[a] - v[b]);
          sx += CORNERS[a][0] + (CORNERS[b][0] - CORNERS[a][0]) * t;
          sy += CORNERS[a][1] + (CORNERS[b][1] - CORNERS[a][1]) * t;
          sz += CORNERS[a][2] + (CORNERS[b][2] - CORNERS[a][2]) * t;
          n++;
        }
        cell[local(i, j, k)] = points.length / 3;
        points.push(ox + (i + sx / n) * VOXEL, oy + (j + sy / n) * VOXEL, oz + (k + sz / n) * VOXEL);
      }
  const index: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, c, b, a, d, c);
    else index.push(a, b, c, a, c, d);
  };
  for (let k = APRON; k < APRON + CHUNK; k++)
    for (let j = APRON; j < APRON + CHUNK; j++)
      for (let i = APRON; i < APRON + CHUNK; i++) {
        const here = g[at(i, j, k)] > 0;
        if (here !== g[at(i + 1, j, k)] > 0) quad(cell[local(i, j - 1, k - 1)], cell[local(i, j, k - 1)], cell[local(i, j, k)], cell[local(i, j - 1, k)], !here);
        if (here !== g[at(i, j + 1, k)] > 0) quad(cell[local(i - 1, j, k - 1)], cell[local(i - 1, j, k)], cell[local(i, j, k)], cell[local(i, j, k - 1)], !here);
        if (here !== g[at(i, j, k + 1)] > 0) quad(cell[local(i - 1, j - 1, k)], cell[local(i, j - 1, k)], cell[local(i, j, k)], cell[local(i - 1, j, k)], !here);
      }
  if (!index.length) return null;

  // The grid's own value at any point within it (clamped to it), for normals and for crevices.
  const sample = (x: number, y: number, z: number) => {
    const fx = Math.min(N - 1.001, Math.max(0, (x - ox) / VOXEL));
    const fy = Math.min(N - 1.001, Math.max(0, (y - oy) / VOXEL));
    const fz = Math.min(N - 1.001, Math.max(0, (z - oz) / VOXEL));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const k = Math.floor(fz);
    const u = fx - i;
    const w2 = fy - j;
    const w = fz - k;
    const n = at(i, j, k);
    const dy = N;
    const dz = N * N;
    const a = g[n] + (g[n + 1] - g[n]) * u;
    const b = g[n + dy] + (g[n + dy + 1] - g[n + dy]) * u;
    const c = g[n + dz] + (g[n + dz + 1] - g[n + dz]) * u;
    const d = g[n + dy + dz] + (g[n + dy + dz + 1] - g[n + dy + dz]) * u;
    const e = a + (b - a) * w2;
    const f = c + (d - c) * w2;
    return e + (f - e) * w;
  };
  // A column's value between samples (face by x and y, top and ground by x and z), bilinearly.
  const column = (table: Float32Array, a: number, b: number) => {
    const fa = Math.min(N - 1.001, Math.max(0, a / VOXEL));
    const fb = Math.min(N - 1.001, Math.max(0, b / VOXEL));
    const i = Math.floor(fa);
    const j = Math.floor(fb);
    const u = fa - i;
    const w = fb - j;
    const n = i + N * j;
    return (table[n] * (1 - u) + table[n + 1] * u) * (1 - w) + (table[n + N] * (1 - u) + table[n + N + 1] * u) * w;
  };
  const count = points.length / 3;
  const position = new Float32Array(points);
  const normal = new Float32Array(count * 3);
  const info = new Float32Array(count * 3);
  const h = VOXEL * 0.5;
  for (let p = 0; p < count; p++) {
    const x = position[p * 3];
    const y = position[p * 3 + 1];
    const z = position[p * 3 + 2];
    const gx = sample(x + h, y, z) - sample(x - h, y, z);
    const gy = sample(x, y + h, z) - sample(x, y - h, z);
    const gz = sample(x, y, z + h) - sample(x, y, z - h);
    const len = Math.hypot(gx, gy, gz) || 1;
    const nx = -gx / len;
    const ny = -gy / len;
    const nz = -gz / len;
    normal[p * 3] = nx;
    normal[p * 3 + 1] = ny;
    normal[p * 3 + 2] = nz;
    let shut = 0;
    let weight = 0.5;
    for (const d of [0.18, 0.4, 0.8]) {
      const free = -sample(x + nx * d, y + ny * d, z + nz * d);
      shut += Math.max(0, d - free) * weight;
      weight *= 0.6;
    }
    const cliffPart = cliff(column(face, x - ox, y - oy) - z, column(top, x - ox, z - oz) - y);
    const groundPart = column(ground, x - ox, z - oz) - y;
    info[p * 3] = Math.max(0, cliffPart, groundPart);
    info[p * 3 + 1] = Math.max(0, 1 - shut * 1.6);
    info[p * 3 + 2] = smooth(-0.3, 0.3, groundPart - cliffPart);
  }
  return { key, position, normal, info, index: new Uint32Array(index) };
}
