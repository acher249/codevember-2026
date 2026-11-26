/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, dot, exp, float, floor, fract, length, max, min, mix, mx_noise_float, normalMap, varying, normalWorld, positionWorld, smoothstep, step, texture, uniform, uv, vec2, vec3 } from "three/tsl";
import { buildBikes } from "./bikes";
import { buildCars, streetReflection } from "./cars";
import { buildClutter, type Clutter } from "./clutter";
import { nameTint, SHOP_NAMES, signLettering } from "./signs";

// The gaps in the canopy's shadow: their size (per metre) and how much opens (higher, more sun).
const LEAF_GAPS = { scale: 0.55, open: -0.25 };

// A brownstone block on a soft sunny morning: the sidewalk runs along z, the row houses stand off to +x behind their
// stoops, iron railings and areaway fences, and to -x are the curb, plane trees in fenced pits, cast-iron lamps and the
// road, with cars parked far down the block. Built from boxes, tubes and scans, merged into a handful of draws.
// Metres; the sidewalk at y = 0 between the curb (x = CURB) and the house fronts (x = FRONT).

export const CURB = -3.2;
// How far the houses' base course stands proud of their fronts: where the sidewalk really meets them.
export const BASE_COURSE = 0.12;
export const FRONT = 5.6;
export const ROAD = -0.15;
export const FAR_CURB = -13.6;
// The far row's house fronts.
const FAR_FRONT = FAR_CURB - 4.8;
// How far the block runs each way: well behind the start too, so looking back down it there is street, not sky.
export const NEAR = 75;
export const AWAY = -150;
// Where the houses are laid out from, both ways (the houses by the drawing stay where they were first placed).
const MIDDLE = 30;

export type StreetScans = {
  bark: THREE.Texture;
  barkNormal: THREE.Texture;
  brick: THREE.Texture;
  brickNormal: THREE.Texture;
  asphalt: THREE.Texture;
  asphaltNormal: THREE.Texture;
  granite: THREE.Texture;
  dirty: THREE.Texture;
  dirtyNormal: THREE.Texture;
};

const rand = (i: number, n: number) => {
  const v = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

// A row of houses laid out along z: where each starts, its width and which end its stoop is at. Our side's row is
// shared with the sidewalk, which gathers its grime against the stoops, fences and pits.
type House = { z: number; width: number; zMid: number; stoopSide: number; stoopZ: number; i: number };
function houseRow(seed: number) {
  const out: House[] = [];
  const house = (z: number, i: number) => {
    const width = 5.6 + rand(seed + i, 1) * 1.2;
    const zMid = z - width / 2;
    const stoopSide = rand(seed + i, 6) < 0.5 ? 1 : -1;
    return { z, width, zMid, stoopSide, stoopZ: zMid + stoopSide * (width / 2 - 1.15), i };
  };
  for (let z = MIDDLE, i = 0; z > AWAY; i++) {
    out.push(house(z, i));
    z -= out[out.length - 1].width;
  }
  // Back toward the start and past it, each house ending where the one before it begins.
  for (let z = MIDDLE, i = 500; z < NEAR; i++) {
    const width = 5.6 + rand(seed + i, 1) * 1.2;
    out.unshift(house(z + width, i));
    z += width;
  }
  return out;
}
const OUR_ROW = houseRow(1);
// On our side the house beside the drawing is pale limestone, with its door at the sidewalk; the rest brownstone.
const isLime = (h: House) => h.z > 1 && h.z - h.width < 1;
// How far a stoop reaches out from the front, cheek walls included, and where the areaway fence runs.
const STOOP_OUT = 3.27;
const FENCE_OUT = 1.55;

// Close together, as old street trees are, but with the drawing's stretch of curb left between two of them.
export const TREE_Z: number[] = [72, 63, 54.5, 45, 36, 27, 18, 9, -6.1];
for (let z = -6.1 - 9.5; z > AWAY + 10; z -= 8.5 + rand(z, 9) * 2.5) TREE_Z.push(z);
export const PIT_X = CURB + 0.85;
// The cast-iron lamps along the curb (placed in index.tsx), one beside the drawing.
export const LAMP_Z = [52, 28, 2.4, -21, -45, -70];

// The treads of our side's stoops near enough to see, where a few leaves settle: [x0, x1, y, z] for each, z its middle.
export function stoopTreads(far = -40) {
  const treads: [number, number, number, number][] = [];
  OUR_ROW.filter((h) => !isLime(h) && h.z - h.width < MIDDLE + 10 && h.z > far).forEach((h) => {
    for (let s = 0; s < 10; s++) treads.push([FRONT - 0.75 - 0.24 * (s + 1), FRONT - 0.75 - 0.24 * s, 1.72 - 0.172 * s, h.stoopZ]);
  });
  return treads;
}

// Where dirt and leaves gather on the sidewalk, near enough to see: the feet of the stoops and the areaway curbs, the
// limestone house's step and planters, and the tree pits, as boxes [x0, x1, z0, z1].
export function sidewalkFeet(far = -45) {
  const feet: [number, number, number, number][] = [];
  OUR_ROW.filter((h) => h.z - h.width < NEAR && h.z > far).forEach((h) => {
    if (isLime(h)) {
      feet.push([FRONT - 0.5, FRONT, h.stoopZ - 0.95, h.stoopZ + 0.95]);
      [-1, 1].forEach((s) => feet.push([FRONT - 0.95, FRONT - 0.15, h.stoopZ + s * 1.3 - 0.4, h.stoopZ + s * 1.3 + 0.4]));
      return;
    }
    feet.push([FRONT - STOOP_OUT, FRONT, h.stoopZ - 1.08, h.stoopZ + 1.08]);
    const fence = (za: number, zb: number) => {
      if (za - zb > 0.2) feet.push([FRONT - FENCE_OUT - 0.125, FRONT - FENCE_OUT + 0.125, zb, za]);
    };
    fence(h.z - 0.05, h.stoopZ + 1.1);
    fence(h.stoopZ - 1.1, h.z - h.width + 0.05);
  });
  TREE_Z.filter((z) => z > far).forEach((z) => feet.push([PIT_X - 0.65, PIT_X + 0.65, z - 0.95, z + 0.95]));
  // The lamps' cast-iron bases.
  LAMP_Z.filter((z) => z > far).forEach((z) => feet.push([CURB + 0.38, CURB + 0.62, z - 0.12, z + 0.12]));
  return feet;
}

// How far each point of a stretch of sidewalk (x0 to x1 across, the block's length along) is from the nearest of some
// boxes standing on it, [x0, x1, z0, z1], on a FIELD_STEP grid: worked out once, read by the sidewalk's shader for the
// dirt round their feet. Stored as a byte of FIELD_REACH metres (to a few millimetres: plenty, for dirt).
const FIELD_STEP = 0.05;
const FIELD_REACH = 2;
function feetField(boxes: [number, number, number, number][], x0: number, x1: number) {
  const w = Math.ceil((x1 - x0) / FIELD_STEP) + 1;
  const h = Math.ceil((NEAR - AWAY) / FIELD_STEP) + 1;
  const data = new Uint8Array(w * h).fill(255);
  boxes.forEach(([bx0, bx1, z0, z1]) => {
    // Only the cells within reach of this box, each keeping the nearest so far.
    const [lo, hi] = [Math.min(bx0, bx1), Math.max(bx0, bx1)];
    const j0 = Math.max(0, Math.floor((z0 - FIELD_REACH - AWAY) / FIELD_STEP));
    const j1 = Math.min(h - 1, Math.ceil((z1 + FIELD_REACH - AWAY) / FIELD_STEP));
    const i0 = Math.max(0, Math.floor((lo - FIELD_REACH - x0) / FIELD_STEP));
    const i1 = Math.min(w - 1, Math.ceil((hi + FIELD_REACH - x0) / FIELD_STEP));
    for (let j = j0; j <= j1; j++) {
      const dz = Math.max(z0 - (AWAY + j * FIELD_STEP), AWAY + j * FIELD_STEP - z1, 0);
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * FIELD_STEP;
        const d = Math.hypot(Math.max(lo - x, x - hi, 0), dz);
        const v = Math.min(255, Math.round((d / FIELD_REACH) * 255));
        if (v < data[j * w + i]) data[j * w + i] = v;
      }
    }
  });
  const map = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  map.minFilter = map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = false;
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  return { map, w, h };
}

// Boxes gathered for one merged draw, each with a colour, with uv in metres on its faces.
class Pile {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  colours: number[] = [];
  nooks: number[] = [];
  index: number[] = [];
  // What the next things added are, for the dirt in their corners (see the weathering): 0 most things, 1 a stoop's
  // steps, 2 the inside face of a stoop's cheek wall (by its normal, so its outside stays 0).
  nook: number | ((normal: THREE.Vector3) => number) = 0;
  // ownUv keeps the geometry's own uv (0 to 1 over each face of a box) in place of metres.
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, colour: THREE.Color, ownUv = false) {
    const g = geometry.clone().applyMatrix4(matrix);
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const u = g.getAttribute("uv");
    const base = this.positions.length / 3;
    const normal = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      const [x, y, z] = [p.getX(i), p.getY(i), p.getZ(i)];
      const [ax, ay] = [Math.abs(n.getX(i)), Math.abs(n.getY(i))];
      this.nooks.push(typeof this.nook === "number" ? this.nook : this.nook(normal.fromBufferAttribute(n, i)));
      this.positions.push(x, y, z);
      this.normals.push(n.getX(i), n.getY(i), n.getZ(i));
      if (ownUv) this.uvs.push(u.getX(i), u.getY(i));
      else this.uvs.push(ax > 0.6 ? z : x, ay > 0.6 ? z : y);
      this.colours.push(colour.r, colour.g, colour.b);
    }
    const idx = g.index;
    if (idx) for (let i = 0; i < idx.count; i++) this.index.push(idx.getX(i) + base);
    else for (let i = 0; i < p.count; i++) this.index.push(i + base);
    g.dispose();
  }
  box(w: number, h: number, d: number, x: number, y: number, z: number, colour: THREE.Color, turn = 0, ownUv = false) {
    const m = new THREE.Matrix4().makeRotationY(turn).setPosition(x, y, z);
    this.add(UNIT.clone().scale(w, h, d), m, colour, ownUv);
  }
  // A flat quad on a wall facing along x (way: +1 or -1), its uv 0 to 1 across it, v up.
  quad(x: number, y: number, z: number, w: number, h: number, way: number, colour: THREE.Color) {
    const m = new THREE.Matrix4().makeRotationY(way * (Math.PI / 2)).setPosition(x, y, z);
    this.add(QUAD.clone().scale(w, h, 1), m, colour, true);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute("tint", new THREE.Float32BufferAttribute(this.colours, 3));
    g.setAttribute("nook", new THREE.Float32BufferAttribute(this.nooks, 1));
    g.setIndex(this.index);
    return g;
  }
}
const UNIT = new THREE.BoxGeometry(1, 1, 1);
const QUAD = new THREE.PlaneGeometry(1, 1);

// Thin iron bars (pickets, balusters, posts, rails), as instances of one cylinder from a to b.
class Bars {
  list: { a: THREE.Vector3; b: THREE.Vector3; r: number }[] = [];
  add(a: THREE.Vector3, b: THREE.Vector3, r = 0.012) {
    this.list.push({ a, b, r });
  }
  build(material: THREE.Material) {
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
    geometry.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geometry, material, this.list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    this.list.forEach(({ a, b, r }, i) => {
      const d = b.clone().sub(a);
      q.setFromUnitVectors(up, d.clone().normalize());
      m.compose(a, q, new THREE.Vector3(r, d.length(), r));
      mesh.setMatrixAt(i, m);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { mesh, geometry };
  }
}

const BROWNSTONE = [new THREE.Color("#6a5348"), new THREE.Color("#725a4e"), new THREE.Color("#644e45"), new THREE.Color("#7a6255")];
const LIMESTONE = new THREE.Color("#8f897f");
const BRICK = new THREE.Color("#ffffff");

export function buildStreet(scans: StreetScans, tier: "low" | "medium" | "high") {
  const group = new THREE.Group();
  const stone = new Pile();
  const brick = new Pile();
  const trim = new Pile();
  const glass = new Pile();
  const dark = new Pile();
  const bars = new Bars();
  const green = new Pile();
  // Dirt run down the walls under sills and cornices, as decals; and the shop signs across the street.
  const stains = new Pile();
  const signs = new Pile();
  const names = new Pile();
  // Trash cans and bags out by the stoops, parking signs along the curbs, hydrants (clutter.ts).
  const farFeet: [number, number, number, number][] = TREE_Z.filter((z) => z - 4.5 > -80).map((z) => [FAR_CURB - 1.5, FAR_CURB - 0.2, z - 5.45, z - 3.55]);
  const clutter: Clutter = { cans: [], bags: [], posts: [], hydrants: [] };
  // Each window's own room behind it: [what hangs in it (0 to 1, see the glass), how far across, a hue].
  let windowCount = 0;
  const room = (lit = 0.06) => {
    const k = windowCount++;
    const r = rand(k, 21);
    return new THREE.Color(r < lit ? 0.97 : (r - lit) / (1 - lit) * 0.94, rand(k, 22), rand(k, 23));
  };
  // Where the limestone house's planters stand and its window box hangs, dressed with leaves further down.
  const planters: THREE.Vector3[] = [];
  const windowBoxes: { at: THREE.Vector3; side: number }[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  // Toward the low sun, down the street: the sky glows there and the leaves light up against it.
  const sunWay = uniform(new THREE.Vector3(-0.3, 0.45, -1).normalize());

  // ---- The houses: one row on our side facing the street (-x), one across it facing back (+x), fainter.
  const SASH = new THREE.Color("#1d1b1a");
  const CORNICE = new THREE.Color("#3b302a");
  // A shop in a ground floor: big windows either side of a glazed door over dark panelled bulkheads, a sign board
  // over them, and a canvas awning out over the sidewalk.
  const SHOP_PAINT = ["#1f3326", "#3a1a1a", "#1b2233", "#151515", "#4a3a22"].map((c) => new THREE.Color(c));
  const AWNING = ["#2c4f36", "#7a2422", "#23345a", "#2a2a2a", "#8a6a2a"].map((c) => new THREE.Color(c));
  const storefront = ({ width, zMid, stoopZ, i }: House, out: (u: number) => number, side: number) => {
    const paint = SHOP_PAINT[Math.floor(rand(i, 30) * SHOP_PAINT.length)];
    const lit = new THREE.Color(0.99, 0.5, rand(i, 31));
    [
      [zMid - width / 2 + 0.25, stoopZ - 0.7],
      [stoopZ + 0.7, zMid + width / 2 - 0.25]
    ].forEach(([z0, z1]) => {
      if (z1 - z0 < 0.4) return;
      const cz = (z0 + z1) / 2;
      glass.box(0.02, 2.15, z1 - z0, out(0.05), 0.62 + 1.08, cz, lit, 0, true);
      dark.box(0.14, 0.6, z1 - z0 + 0.08, out(0.07), 0.3, cz, paint);
      dark.box(0.12, 0.1, z1 - z0 + 0.08, out(0.07), 2.78, cz, paint);
      const n = Math.max(1, Math.round((z1 - z0) / 1.3));
      for (let k = 0; k <= n; k++) dark.box(0.1, 2.2, 0.07, out(0.07), 1.7, z0 + ((z1 - z0) * k) / n, paint);
    });
    // The door, glazed, and a transom over it.
    dark.box(0.08, 2.6, 1.3, out(0.03), 1.3, stoopZ, paint);
    glass.box(0.02, 1.6, 0.7, out(0.075), 1.25, stoopZ, lit, 0, true);
    glass.box(0.02, 0.35, 1.1, out(0.075), 2.5, stoopZ, lit, 0, true);
    stone.box(0.5, 0.12, 1.5, out(0.25), 0.06, stoopZ, new THREE.Color("#55524d"));
    // The sign, the shop's name lettered on it (signs.ts), and the awning under it on its iron frame.
    signs.box(0.1, 0.72, width - 0.3, out(0.06), 3.28, zMid, paint);
    names.quad(out(0.115), 3.28, zMid, width - 0.8, 0.52, side, nameTint(Math.floor(rand(i, 34) * SHOP_NAMES.length)));
    const awning = AWNING[Math.floor(rand(i, 32) * AWNING.length)];
    const slope = new THREE.Matrix4().makeRotationZ(-side * 0.32).setPosition(out(0.68), 2.72, zMid);
    trim.add(UNIT.clone().scale(1.35, 0.03, width - 0.6), slope, awning);
    trim.box(0.02, 0.26, width - 0.6, out(1.32), 2.38, zMid, awning);
  };
  // A fire escape across the front of a block of flats: a landing at each floor above the first, railed round,
  // stairs zigzagging up between them, and a drop ladder hung from the lowest.
  const IRON = new THREE.Color("#161514");
  const fireEscape = ({ width, zMid, i }: House, out: (u: number) => number, floors: number, door: number) => {
    const span = width * 0.66;
    const z0 = zMid - span / 2 + (rand(i, 40) - 0.5) * 0.6;
    const z1 = z0 + span;
    const at = (u: number, y: number, z: number) => new THREE.Vector3(out(u), y, z);
    let first = Infinity;
    for (let f = 1; f < floors; f++) {
      const y = door + 0.55 + f * 3.25 - 0.14;
      first = Math.min(first, y);
      dark.box(0.95, 0.05, span, out(0.48), y, (z0 + z1) / 2, IRON);
      bars.add(at(0.95, y + 0.95, z0), at(0.95, y + 0.95, z1), 0.014);
      bars.add(at(0.95, y + 0.5, z0), at(0.95, y + 0.5, z1), 0.01);
      [z0, z1].forEach((z) => {
        bars.add(at(0, y + 0.95, z), at(0.95, y + 0.95, z), 0.014);
        // A bracket under the landing, back to the wall.
        bars.add(at(0.02, y - 0.7, z), at(0.9, y - 0.02, z), 0.015);
      });
      for (let z = z0; z <= z1 + 0.01; z += span / Math.round(span / 0.3)) bars.add(at(0.95, y, z), at(0.95, y + 0.95, z), 0.008);
      if (f < floors - 1) {
        // A stair up to the next landing, along the wall, its treads bars across it.
        const [a, b] = f % 2 ? [z0 + 0.5, z1 - 1.0] : [z1 - 0.5, z0 + 1.0];
        [0.2, 0.62].forEach((u) => bars.add(at(u, y, a), at(u, y + 3.25, b), 0.016));
        for (let t = 1; t < 12; t++) bars.add(at(0.2, y + (3.25 * t) / 12, a + ((b - a) * t) / 12), at(0.62, y + (3.25 * t) / 12, a + ((b - a) * t) / 12), 0.01);
      }
    }
    if (first === Infinity) return;
    // The drop ladder, hung up from the lowest landing out of reach.
    [-0.2, 0.2].forEach((dz) => bars.add(at(0.8, first - 2.2, z1 - 0.5 + dz), at(0.8, first + 0.9, z1 - 0.5 + dz), 0.012));
    for (let y = first - 2.1; y < first + 0.8; y += 0.3) bars.add(at(0.8, y, z1 - 0.7), at(0.8, y, z1 - 0.3), 0.008);
  };
  const row = (side: 1 | -1, front: number, houses: House[], seed: number, detailed: boolean) => {
    // Out from the front by u (toward the street).
    const out = (u: number) => front + side * u;
    houses.forEach((house) => {
      const { z, width, zMid, stoopSide, stoopZ, i } = house;
      // Across the street, more of the block is brick (the taller ones flats with fire escapes), and the odd house has
      // a shop in its ground floor. Those near enough to see are dressed as fully as ours.
      const near = detailed || (zMid < 75 && zMid > -80);
      const kind = detailed && isLime(house) ? "lime" : rand(seed + i, 4) < (detailed ? 0.1 : 0.26) ? "brick" : "brown";
      // (Never two side by side: only the first of a run.)
      const shop = !detailed && rand(seed + i, 8) < 0.18 && rand(seed + i - 1, 8) >= 0.18;
      const flats = !detailed && kind === "brick" && rand(seed + i, 9) < 0.75;
      const height = 12.5 + rand(seed + i, 2) * 2.4 + (rand(seed + i, 3) < 0.15 ? 2.6 : 0) + (flats ? 3.25 : 0);
      // The stone of the stoop, base and bay: brownstone on a brick house too, only its face is brick.
      const colour = kind === "lime" ? LIMESTONE : BROWNSTONE[Math.floor(rand(seed + i, 5) * 4)];
      const body = kind === "brick" ? brick : stone;
      // Window surrounds, lintels and sills: the house's own stone a shade paler, or pale stone on a brick front.
      const dressing = kind === "brick" ? new THREE.Color("#a79f90") : colour.clone().multiplyScalar(1.1);
      const depth = 14;
      const fx = front - (side * depth) / 2;
      body.box(depth, height, width - 0.02, fx, height / 2, zMid, kind === "brick" ? BRICK : colour);
      // A rusticated base course, a little proud of the wall.
      stone.box(BASE_COURSE, 1.55, width, out(BASE_COURSE / 2), 0.78, zMid, colour.clone().multiplyScalar(0.86));
      stone.box(0.16, 0.12, width, out(0.08), 1.6, zMid, dressing);
      // The cornice: a frieze, a row of scrolled brackets under a deep overhanging crown, painted dark.
      const cornice = kind === "lime" ? colour.clone().multiplyScalar(0.92) : CORNICE;
      stone.box(0.1, 0.75, width, out(0.05), height - 0.9, zMid, dressing);
      dark.box(0.28, 0.14, width + 0.02, out(0.14), height - 0.45, zMid, cornice);
      dark.box(0.7, 0.24, width + 0.04, out(0.35), height - 0.12, zMid, cornice);
      dark.box(0.78, 0.06, width + 0.06, out(0.39), height + 0.03, zMid, cornice.clone().multiplyScalar(0.85));
      if (near) for (let b = -width / 2 + 0.3; b < width / 2 - 0.2; b += 0.62) dark.box(0.55, 0.42, 0.12, out(0.27), height - 0.42, zMid + b, cornice);
      // Rain off the cornice has run dirt down the wall under it.
      stains.quad(out(0.012), height - 1.3 - 0.9, zMid, width - 0.1, 1.8, side, new THREE.Color(0.8, rand(seed + i, 10), 0));
      // The stoop to the parlour floor, on one side of the house (none on the limestone, or a shop: their doors are at
      // the sidewalk).
      const stoop = kind !== "lime" && !shop;
      // A bay window over the floors on the other side, on some houses.
      const bay = near && !shop && kind === "brown" && rand(seed + i, 7) < 0.4;
      const bayZ = zMid - stoopSide * (width / 2 - 1.75);
      const door = 1.72;
      const floors = Math.floor((height - 2.2) / 3.2);
      const top = door + 0.55 + (floors - 1) * 3.25 + 2.2;
      if (bay) {
        // Three faces: the front and two at 45 degrees back to the wall, from the ground to the top of the windows.
        stone.box(0.75, top, 1.5, out(0.45), top / 2, bayZ, colour);
        [-1, 1].forEach((s) => stone.box(0.22, top, 1.1, out(0.4), top / 2, bayZ + s * 0.95, colour, -s * side * (Math.PI / 4)));
        stone.box(0.9, 0.2, 2.6, out(0.45), top + 0.1, bayZ, dressing);
      }
      // A window: glass set back in a pale surround, a dark two-over-two sash, a lintel with a cap and a sill.
      const pane = (wz: number, sillY: number, h: number, w: number, u = 0) => {
        glass.box(0.02, h, w, out(u + 0.01), sillY + h / 2, wz, room(), 0, true);
        // Grime washed off the sill down the wall below it, in streaks.
        const drop = Math.min(1.5, sillY - 0.3);
        if (drop > 0.3) stains.quad(out(u + 0.012), sillY - 0.08 - drop / 2, wz, w + 0.34, drop, side, new THREE.Color(1, rand(wz * 7 + sillY, 11), 0));
        stone.box(0.07, h + 0.14, 0.12, out(u + 0.035), sillY + h / 2, wz - w / 2 - 0.06, dressing);
        stone.box(0.07, h + 0.14, 0.12, out(u + 0.035), sillY + h / 2, wz + w / 2 + 0.06, dressing);
        dark.box(0.05, h, 0.06, out(u + 0.025), sillY + h / 2, wz - w / 2 + 0.03, SASH);
        dark.box(0.05, h, 0.06, out(u + 0.025), sillY + h / 2, wz + w / 2 - 0.03, SASH);
        dark.box(0.05, 0.06, w, out(u + 0.025), sillY + h - 0.03, wz, SASH);
        dark.box(0.06, 0.06, w, out(u + 0.03), sillY + h * 0.52, wz, SASH);
        dark.box(0.04, h, 0.03, out(u + 0.02), sillY + h / 2, wz, SASH);
        stone.box(0.08, 0.04, w + 0.45, out(u + 0.2), sillY + h + 0.32, wz, dressing.clone().multiplyScalar(1.05));
        stone.box(0.16, 0.26, w + 0.36, out(u + 0.08), sillY + h + 0.15, wz, dressing);
        stone.box(0.14, 0.08, w + 0.24, out(u + 0.07), sillY - 0.04, wz, dressing);
      };
      for (let f = -1; f < floors; f++) {
        const sillY = f < 0 ? 0.35 : door + 0.55 + f * 3.25;
        // Tall parlour windows, shorter ones higher up.
        const h = f < 0 ? 0.9 : f === 0 ? 2.5 : f === floors - 1 ? 1.75 : 2.15;
        for (let c = 0; c < 3; c++) {
          const wz = zMid + (c - 1) * (width / 3.3);
          if (shop && f <= 0) continue;
          if (stoop && f === 0 && Math.abs(wz - stoopZ) < 0.9) continue;
          if (stoop && f === -1 && Math.abs(wz - stoopZ) < 1.2) continue;
          if (!stoop && (f === -1 || (f === 0 && Math.abs(wz - stoopZ) < 0.9))) continue;
          if (bay && Math.abs(wz - bayZ) < 1.3) continue;
          pane(wz, sillY, h, 0.95);
        }
        if (bay && f >= 0) pane(bayZ, sillY, h, 1.0, 0.82);
      }
      const doorY = stoop ? door : 0.18;
      // The door: a pair of dark leaves under a transom, framed by pilasters, under a hood on two brackets.
      if (shop) {
        storefront(house, out, side);
        return;
      }
      dark.box(0.08, 2.5, 1.15, out(0.03), doorY + 1.25, stoopZ, new THREE.Color("#141313"));
      glass.box(0.02, 0.45, 1.05, out(0.075), doorY + 2.25, stoopZ, new THREE.Color(0.1, 0, 0.5), 0, true);
      // Each leaf with a raised panel low and a tall one above it, catching the light on their edges.
      [-0.29, 0.29].forEach((dz) => {
        dark.box(0.03, 0.75, 0.38, out(0.085), doorY + 0.62, stoopZ + dz, new THREE.Color("#262321"));
        dark.box(0.03, 0.85, 0.38, out(0.085), doorY + 1.55, stoopZ + dz, new THREE.Color("#262321"));
      });
      dark.box(0.05, 0.08, 1.15, out(0.09), doorY + 2.0, stoopZ, new THREE.Color("#1a1918"));
      [-1, 1].forEach((s) => {
        stone.box(0.16, 2.75, 0.22, out(0.08), doorY + 1.37, stoopZ + s * 0.69, dressing);
        stone.box(0.3, 0.38, 0.14, out(0.17), doorY + 2.6, stoopZ + s * 0.69, dressing);
      });
      stone.box(0.42, 0.26, 1.85, out(0.21), doorY + 2.92, stoopZ, dressing);
      stone.box(0.48, 0.07, 1.95, out(0.24), doorY + 3.08, stoopZ, dressing.clone().multiplyScalar(1.05));
      if (!stoop) {
        // A low step to the door, black planters with clipped box balls either side, and a window box of ivy over it.
        stone.box(0.5, 0.18, 1.9, out(0.25), 0.09, stoopZ, colour.clone().multiplyScalar(0.95));
        if (detailed) [-1, 1].forEach((s) => planters.push(new THREE.Vector3(out(0.55), 0, stoopZ + s * 1.3)));
        windowBoxes.push({ at: new THREE.Vector3(out(0.2), door + 0.55 + 3.25 - 0.2, stoopZ), side });
      }
      if (stoop) {
        // The stoop: steps out to the sidewalk between solid cheek walls, an iron railing on each.
        const steps = 10;
        const reach = 2.4;
        const end = 0.75 + reach;
        stone.nook = 1;
        for (let s = 0; s < steps; s++) {
          const tread = door - (door / steps) * s;
          const u = 0.75 + (reach / steps) * s;
          stone.box(reach / steps + 0.06, tread, 1.6, out(u + reach / steps / 2), tread / 2, stoopZ, colour.clone().multiplyScalar(s % 2 ? 0.96 : 1.02));
          // The nosing, a lip of each tread.
          stone.box(0.05, 0.05, 1.62, out(u + reach / steps + 0.02), tread - 0.025, stoopZ, colour.clone().multiplyScalar(1.12));
        }
        stone.box(0.75, door, 1.8, out(0.37), door / 2, stoopZ, colour);
        // Each cheek wall is the stoop's side profile pushed out to its thickness.
        [-1, 1].forEach((s) => {
          const cz = stoopZ + s * 0.94;
          const cheek = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(side * (end + 0.12), 0), new THREE.Vector2(side * (end + 0.12), 0.62), new THREE.Vector2(side * 0.75, door + 0.42), new THREE.Vector2(0, door + 0.42)]);
          const g = new THREE.ExtrudeGeometry(cheek, { depth: 0.28, bevelEnabled: false });
          stone.nook = (n) => (n.z * s < -0.5 ? 2 : 0);
          stone.add(g, new THREE.Matrix4().makeTranslation(front, 0, cz - 0.14), colour.clone().multiplyScalar(0.94));
          stone.nook = 0;
          g.dispose();
          // A coping along its top and a block at its foot.
          stone.box(0.5, 0.7, 0.36, out(end - 0.13), 0.35, cz, colour.clone().multiplyScalar(1.04));
          if (!near) return;
          // The railing on top: a heavy newel post at the foot, a handrail up to the door, balusters between.
          const low = new THREE.Vector3(out(end - 0.15), 0.7, cz);
          const high = new THREE.Vector3(out(0.75), door + 0.42, cz);
          const rail = new THREE.Vector3(0, 0.88, 0);
          bars.add(low.clone(), low.clone().add(rail).add(new THREE.Vector3(0, 0.22, 0)), 0.04);
          bars.add(low.clone().add(rail).add(new THREE.Vector3(0, 0.22, 0)), low.clone().add(rail).add(new THREE.Vector3(0, 0.3, 0)), 0.06);
          bars.add(low.clone().add(rail), high.clone().add(rail), 0.022);
          bars.add(high.clone().add(rail), new THREE.Vector3(out(0.08), door + 0.42 + 0.88, cz), 0.022);
          bars.add(low.clone().add(new THREE.Vector3(0, 0.12, 0)), high.clone().add(new THREE.Vector3(0, 0.12, 0)), 0.012);
          for (let b = 0.06; b < 1; b += 0.05) {
            const p = low.clone().lerp(high, b);
            bars.add(p, p.clone().add(rail), 0.009);
          }
          // A scroll at the newel: a few short bars curling out from its foot.
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 1.5;
            const r = 0.16 - k * 0.02;
            const p = new THREE.Vector3(out(end - 0.15 + side * Math.sin(a) * r * -1), 0.7 + 0.25 + Math.cos(a) * r, cz);
            const q = new THREE.Vector3(out(end - 0.15 + side * Math.sin(a + 0.8) * (r - 0.02) * -1), 0.7 + 0.25 + Math.cos(a + 0.8) * (r - 0.02), cz);
            bars.add(p, q, 0.012);
          }
        });
      }
      if (flats && near) fireEscape(house, out, floors, door);
      // Trash out by the stoop of some houses: cans by the areaway fence, a bag or two leant on them.
      if (stoop && near && rand(seed + i, 12) < (detailed ? 0.35 : 0.6) && (!detailed || Math.abs(zMid) > 22)) {
        const along = stoopZ - stoopSide * (1.5 + rand(seed + i, 13) * 0.6);
        const n = 1 + Math.floor(rand(seed + i, 14) * 3);
        for (let c = 0; c < n; c++) clutter.cans.push({ x: out(FENCE_OUT + 0.35 + (c % 2) * 0.05), z: along - stoopSide * c * 0.62, seed: seed * 100 + i * 7 + c });
        const bags = Math.floor(rand(seed + i, 15) * 3);
        for (let b = 0; b < bags; b++) clutter.bags.push({ x: out(FENCE_OUT + 0.4 + rand(seed + i, 16 + b) * 0.5), z: along - stoopSide * (n * 0.62 + b * 0.5), seed: seed * 100 + i * 7 + b });
      }
      // Across the street, where the stoops and areaway curbs stand on the sidewalk, for the dirt round their feet.
      if (!detailed && stoop) {
        farFeet.push([front, out(STOOP_OUT), stoopZ - 1.08, stoopZ + 1.08]);
        if (near)
          [
            [z - 0.05, stoopZ + 1.1],
            [stoopZ - 1.1, z - width + 0.05]
          ].forEach(([za, zb]) => za - zb > 0.2 && farFeet.push([out(FENCE_OUT) - 0.125, out(FENCE_OUT) + 0.125, zb, za]));
      }
      if (near && stoop) {
        // The areaway fence, along the front of the house either side of the stoop, on a low stone curb.
        const fenceX = out(FENCE_OUT);
        const along = (za: number, zb: number) => {
          if (za - zb < 0.2) return;
          bars.add(new THREE.Vector3(fenceX, 0.95, za), new THREE.Vector3(fenceX, 0.95, zb), 0.016);
          bars.add(new THREE.Vector3(fenceX, 0.85, za), new THREE.Vector3(fenceX, 0.85, zb), 0.01);
          bars.add(new THREE.Vector3(fenceX, 0.2, za), new THREE.Vector3(fenceX, 0.2, zb), 0.014);
          const n = Math.round(Math.abs(zb - za) / 0.11);
          for (let k = 0; k <= n; k++) {
            const pz = za + ((zb - za) * k) / n;
            const post = k % 8 === 0 || k === n;
            bars.add(new THREE.Vector3(fenceX, 0.1, pz), new THREE.Vector3(fenceX, post ? 1.15 : 1.04, pz), post ? 0.025 : 0.01);
          }
          stone.box(0.25, 0.14, Math.abs(zb - za), fenceX, 0.07, (za + zb) / 2, colour.clone().multiplyScalar(0.9));
        };
        along(z - 0.05, stoopZ + 1.1);
        along(stoopZ - 1.1, z - width + 0.05);
      }
    });
  };
  row(-1, FRONT, OUR_ROW, 1, true);
  row(1, FAR_FRONT, houseRow(50), 50, false);

  // ---- The sidewalk's edges: the granite curbs, the road between them, and the far sidewalk.
  // A curb is a run of granite blocks of uneven length, each the curb's profile (its top edge worn round) pushed along z.
  const curbBlocks = (inner: number, way: number) => {
    const parts: THREE.BufferGeometry[] = [];
    const outer = inner + way * 0.28;
    const profile = new THREE.Shape([new THREE.Vector2(inner, 0), new THREE.Vector2(outer - way * 0.05, 0), new THREE.Vector2(outer - way * 0.015, -0.012), new THREE.Vector2(outer, -0.05), new THREE.Vector2(outer, -0.34), new THREE.Vector2(inner, -0.34)]);
    for (let z = NEAR, k = 0; z > AWAY; k++) {
      const length = 2.1 + rand(k + inner, 11) * 1.3;
      const g = new THREE.ExtrudeGeometry(profile, { depth: length - 0.008, bevelEnabled: false });
      // Metres along the block on the face it shows, so the scan sits right on both its top and its side.
      g.translate(0, 0, z - length);
      parts.push(g);
      z -= length;
    }
    return mergeParts(parts);
  };
  const curbMaterial = (edge: number) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
    const p = positionWorld;
    const flat = smoothstep(0.5, 0.8, abs(normalWorld.y));
    const face = mix(p.zy, p.xz, flat);
    const scan = texture(scans.dirty, face.div(1.7)).rgb;
    // Pale speckled granite, each block a slightly different grey, stained by the dirty scan.
    const speck = mx_noise_float(vec3(p.mul(70))).mul(0.5).add(0.5);
    const tone = mx_noise_float(vec3(p.z.mul(0.45), 3, 3)).mul(0.08).add(0.95);
    let colour = vec3(0.27, 0.265, 0.255).mul(speck.mul(0.28).add(0.86)).mul(tone).mul(mix(vec3(1), scan.div(0.24), 0.55));
    // The top edge chipped away along the road in places, darker and rougher where the stone has spalled.
    const along = mx_noise_float(vec3(p.z.mul(3.1), 1, 7)).add(mx_noise_float(vec3(p.z.mul(11), p.y.mul(9), 2)).mul(0.35));
    const toEdge = length(vec2(p.x.sub(edge), p.y));
    const chip = float(1).sub(smoothstep(0.015, along.max(0).mul(0.09).add(0.02), toEdge)).mul(step(0.12, along));
    colour = mix(colour, colour.mul(vec3(0.62, 0.6, 0.56)), chip);
    // Road grime splashed up its face, darkest at the gutter, in streaks.
    const streak = mx_noise_float(vec3(p.z.mul(9), p.y.mul(1.5), 4)).mul(0.5).add(0.5);
    const splash = smoothstep(0.0, -0.15, p.y).mul(streak.mul(0.5).add(0.5)).mul(float(1).sub(flat.mul(0.5)));
    // Grime trodden into the top too, worst along the gutter edge.
    const trodden = mx_noise_float(vec3(p.x.mul(5), p.z.mul(1.3), 6)).mul(0.5).add(0.5).mul(flat).mul(0.35);
    colour = mix(colour, vec3(0.07, 0.06, 0.05), splash.mul(0.75).add(trodden));
    // And darkest right down in the corner with the road.
    colour = mix(colour, vec3(0.025, 0.022, 0.018), exp(p.y.sub(ROAD).max(0).div(-0.04)).mul(float(1).sub(flat)).mul(0.7));
    m.colorNode = colour;
    m.roughnessNode = float(0.82).add(chip.mul(0.12)).sub(splash.mul(0.15));
    m.normalNode = normalMap(texture(scans.dirtyNormal, face.div(1.7)), vec2(chip.mul(1.5).add(1)));
    materials.push(m);
    return m;
  };
  [
    [CURB, -1],
    [FAR_CURB, 1]
  ].forEach(([inner, way]) => {
    const g = curbBlocks(inner, way);
    const curb = new THREE.Mesh(g, curbMaterial(inner + way * 0.28));
    curb.castShadow = curb.receiveShadow = true;
    group.add(curb);
    geometries.push(g);
  });

  // The far sidewalk: big flags of the dirty concrete scan, each its own shade, with dark joints.
  const farWalk = new THREE.PlaneGeometry(4.8, NEAR - AWAY);
  farWalk.rotateX(-Math.PI / 2);
  farWalk.translate(FAR_CURB - 2.4, 0, (NEAR + AWAY) / 2);
  const farWalkMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.88 });
  const fw = positionWorld.xz;
  const fwFlag = floor(fw.div(1.55));
  const fwHash = fract(dot(fwFlag, vec2(12.9898, 78.233)).sin().mul(43758.5453));
  const fwJoint = abs(fract(fw.div(1.55)).sub(0.5)).mul(1.55).sub(1.55 / 2).abs();
  const fwJoints = float(1).sub(smoothstep(0.006, 0.02, min(fwJoint.x, fwJoint.y)));
  // Grime round the feet of everything standing on it, as on ours (ground.ts): a soft band and a tight dark one in the
  // corner, from the distance to the nearest foot worked out once (farFeet) and to the house fronts and the curb.
  const farField = feetField(farFeet, FAR_FRONT, FAR_CURB);
  const fwFeet = texture(farField.map, vec2(fw.x.sub(FAR_FRONT).div(FIELD_STEP).add(0.5).div(farField.w), fw.y.sub(AWAY).div(FIELD_STEP).add(0.5).div(farField.h))).r.mul(FIELD_REACH);
  const fwStanding = min(min(fw.x.sub(FAR_FRONT + BASE_COURSE), float(FAR_CURB).sub(fw.x)), fwFeet);
  const fwScan = texture(scans.dirty, fw.div(2.3)).rgb;
  const fwBreak = dot(fwScan, vec3(0.3, 0.59, 0.11)).div(0.22).mul(0.3).add(0.75);
  const fwGrime = exp(fwStanding.div(-0.16)).mul(fwBreak).clamp(0, 1);
  const fwBlotch = smoothstep(1.3, 0.7, dot(fwScan, vec3(0.3, 0.59, 0.11)).div(0.22)).mul(0.7).add(0.3);
  const fwBand = exp(fwStanding.div(-0.4)).mul(fwBlotch).add(exp(fwStanding.div(-0.15)).mul(0.5)).clamp(0, 1);
  const fwContact = exp(fwStanding.div(-0.1));
  let fwColour: any = fwScan.mul(fwHash.mul(0.25).add(0.85)).mul(float(1).sub(fwJoints.mul(0.6)));
  fwColour = mix(fwColour, vec3(0.06, 0.05, 0.04), fwGrime.mul(0.6));
  fwColour = mix(fwColour, vec3(0.045, 0.03, 0.016), fwBand);
  farWalkMaterial.colorNode = mix(fwColour, vec3(0.011, 0.009, 0.007), fwContact.mul(0.95));
  farWalkMaterial.addEventListener("dispose", () => farField.map.dispose());
  farWalkMaterial.normalNode = normalMap(texture(scans.dirtyNormal, fw.div(2.3)));
  const farSidewalk = new THREE.Mesh(farWalk, farWalkMaterial);
  farSidewalk.receiveShadow = true;
  group.add(farSidewalk);
  geometries.push(farWalk);
  materials.push(farWalkMaterial);

  // The road: the asphalt scan, with old patches cut in, cracks sealed with tar, the wheel tracks polished paler and
  // the gutters along both curbs dark with grime.
  const roadGeometry = new THREE.PlaneGeometry(CURB - 0.28 - FAR_CURB - 0.28, NEAR - AWAY);
  roadGeometry.rotateX(-Math.PI / 2);
  roadGeometry.translate((CURB + FAR_CURB) / 2, ROAD, (NEAR + AWAY) / 2);
  const roadMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  const rw = positionWorld.xz;
  const roadUv = rw.div(4);
  const patchCell = floor(rw.div(vec2(3.2, 5.5)));
  const patchHash = fract(dot(patchCell, vec2(27.1, 61.7)).sin().mul(23421.631));
  const patchAt = fract(rw.div(vec2(3.2, 5.5)));
  const inPatch = step(0.78, patchHash).mul(step(0.12, patchAt.x)).mul(step(patchAt.x, patchHash.mul(0.3).add(0.62))).mul(step(0.15, patchAt.y)).mul(step(patchAt.y, 0.75));
  const tarField = mx_noise_float(vec3(rw.mul(0.35), 11)).add(mx_noise_float(vec3(rw.mul(3), 12)).mul(0.04));
  const tar = float(1).sub(smoothstep(0.006, 0.016, abs(tarField))).mul(smoothstep(0.1, 0.4, mx_noise_float(vec3(rw.mul(0.2), 13))));
  const gutter = min(rw.x.sub(FAR_CURB + 0.28), float(CURB - 0.28).sub(rw.x));
  const gutterGrime = exp(gutter.div(-0.3)).mul(mx_noise_float(vec3(rw.mul(1.5), 14)).mul(0.3).add(0.8)).clamp(0, 1);
  const wheel = max(exp(rw.x.add(7.5).pow(2).div(-0.08)), exp(rw.x.add(9.2).pow(2).div(-0.08)));
  let asphalt = texture(scans.asphalt, roadUv).rgb.mul(0.75);
  asphalt = mix(asphalt, texture(scans.asphalt, roadUv.mul(1.7).add(0.31)).rgb.mul(0.52), inPatch);
  asphalt = asphalt.mul(wheel.mul(0.12).add(1));
  asphalt = mix(asphalt, vec3(0.06, 0.055, 0.045), gutterGrime.mul(0.6));
  asphalt = mix(asphalt, vec3(0.02, 0.018, 0.015), exp(gutter.max(0).div(-0.045)).mul(0.65));
  asphalt = mix(asphalt, vec3(0.02, 0.02, 0.022), tar.mul(0.9));
  roadMaterial.colorNode = asphalt;
  roadMaterial.roughnessNode = float(0.86).sub(tar.mul(0.45)).sub(wheel.mul(0.08)).sub(gutterGrime.mul(0.2)).sub(inPatch.mul(0.06));
  roadMaterial.normalNode = normalMap(texture(scans.asphaltNormal, roadUv), vec2(float(1).sub(tar.mul(0.8)).sub(inPatch.mul(0.4))));
  const road = new THREE.Mesh(roadGeometry, roadMaterial);
  road.receiveShadow = true;
  group.add(road);
  geometries.push(roadGeometry);
  materials.push(roadMaterial);

  // Iron covers in the road: a ring, and a raised diamond tread across the lid.
  const coverGeometry = new THREE.CylinderGeometry(0.34, 0.34, 0.025, 36);
  const coverMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.6 });
  const cu = uv().sub(0.5);
  const tread = max(step(0.82, fract(cu.x.add(cu.y).mul(18))), step(0.82, fract(cu.x.sub(cu.y).mul(18))));
  const ring = step(0.4, length(cu)).mul(step(length(cu), 0.46));
  coverMaterial.colorNode = mix(vec3(0.075, 0.068, 0.06), vec3(0.16, 0.12, 0.09), tread.max(ring).mul(0.7));
  [
    [-7.6, -16],
    [-9.4, -41],
    [-6.9, 7.5],
    [-10.2, -72]
  ].forEach(([x, z]) => {
    const cover = new THREE.Mesh(coverGeometry, coverMaterial);
    cover.position.set(x, ROAD + 0.006, z);
    cover.receiveShadow = true;
    group.add(cover);
  });
  geometries.push(coverGeometry);
  materials.push(coverMaterial);

  // ---- Tree pits by the curb, with low iron fences; the plane trees in them; cast-iron lamps between.
  const treeZ = TREE_Z;
  const pitX = PIT_X;
  const farPitX = FAR_CURB - 0.85;
  // Ours, and across the street the far row's (fenced only near enough to see).
  const pits = [...treeZ.map((z) => ({ x: pitX, z, fenced: z > -75 })), ...treeZ.filter((z) => z - 4.5 > -80).map((z) => ({ x: farPitX, z: z - 4.5, fenced: true }))];
  pits.forEach(({ x: pitX, z, fenced }) => {
    dark.box(1.1, 0.04, 1.7, pitX, 0.01, z, new THREE.Color("#2a2119"));
    // A granite edging round the pit.
    [-1, 1].forEach((s) => {
      stone.box(1.3, 0.1, 0.1, pitX, 0.03, z + s * 0.9, new THREE.Color("#7d7b77"));
      stone.box(0.1, 0.1, 1.7, pitX + s * 0.6, 0.03, z, new THREE.Color("#7d7b77"));
    });
    if (fenced) {
      const corners = [new THREE.Vector3(pitX - 0.6, 0, z - 0.9), new THREE.Vector3(pitX + 0.6, 0, z - 0.9), new THREE.Vector3(pitX + 0.6, 0, z + 0.9), new THREE.Vector3(pitX - 0.6, 0, z + 0.9)];
      corners.forEach((c, j) => {
        const d = corners[(j + 1) % 4];
        bars.add(c, c.clone().setY(0.48), 0.018);
        bars.add(c.clone().setY(0.42), d.clone().setY(0.42), 0.012);
        bars.add(c.clone().setY(0.07), d.clone().setY(0.07), 0.01);
        const n = Math.round(c.distanceTo(d) / 0.1);
        for (let s = 1; s < n; s++) {
          const p = c.clone().lerp(d, s / n);
          bars.add(p, p.clone().setY(0.42), 0.007);
        }
      });
    }
  });

  // The trees: a mottled trunk that forks into a few limbs, and a canopy of leaves overhead.
  const barkMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  // Plane bark flakes off in patches: cream where it is fresh, grey and olive where it is old, the scan's detail over it.
  const flake = mx_noise_float(vec3(positionWorld.mul(vec3(3.2, 1.6, 3.2))));
  const flake2 = mx_noise_float(vec3(positionWorld.mul(vec3(7, 3, 7)).add(5)));
  const patches = mix(mix(vec3(0.3, 0.29, 0.22), vec3(0.44, 0.43, 0.39), smoothstep(-0.2, 0.2, flake2)), vec3(0.62, 0.59, 0.48), smoothstep(0.2, 0.45, flake));
  const scan = texture(scans.bark, uv()).rgb;
  barkMaterial.colorNode = patches.mul(dot(scan, vec3(0.3, 0.59, 0.11)).mul(1.8).add(0.35));
  barkMaterial.normalNode = normalMap(texture(scans.barkNormal, uv()));
  const trunks: THREE.BufferGeometry[] = [];
  const leafSpots: { at: THREE.Vector3; size: number; shade: number; colour?: THREE.Color }[] = [];
  const limb = (a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number) => {
    const g = new THREE.CylinderGeometry(rb, ra, a.distanceTo(b), 10, 6, true);
    // Bark round the limb and along it, in metres.
    const uvs = g.getAttribute("uv");
    for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * ra * 6.28 * 1.2, uvs.getY(i) * a.distanceTo(b) * 1.2);
    g.translate(0, a.distanceTo(b) / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.applyMatrix4(new THREE.Matrix4().compose(a, q, new THREE.Vector3(1, 1, 1)));
    trunks.push(g);
  };
  // Each crown is a dozen clumps of leaf sprays round the ends of its branches, densest at each clump's skin so
  // the crown reads as masses of foliage with sky through the gaps between them.
  const crownSpots: { at: THREE.Vector3; size: number; colour: THREE.Color }[] = [];
  const perTree = tier === "low" ? 480 : tier === "medium" ? 900 : 1100;
  const tree = (x: number, z: number, k: number, way: number, count: number) => {
    const base = new THREE.Vector3(x, 0, z);
    const lean = new THREE.Vector3(way * (0.08 + rand(k, 1) * 0.12), 1, (rand(k, 2) - 0.5) * 0.15).normalize();
    const fork = base.clone().addScaledVector(lean, 3.2 + rand(k, 3) * 1.2);
    limb(base.clone().setY(-0.1), fork, 0.27, 0.2);
    const clumps: { at: THREE.Vector3; r: number }[] = [];
    const limbs = 4 + Math.floor(rand(k, 4) * 2);
    for (let b = 0; b < limbs; b++) {
      const a = (b / limbs) * Math.PI * 2 + rand(k, 5 + b) * 0.8;
      // Limbs reach out over the road and the sidewalk alike, a little more toward the light over the road.
      const reachOut = 2.2 + rand(k, 9 + b) * 1.6;
      const tip = fork.clone().add(new THREE.Vector3(Math.cos(a) * reachOut + way * 0.6, 2.6 + rand(k, 14 + b) * 2.2, Math.sin(a) * reachOut * 1.1));
      limb(fork, tip, 0.16, 0.08);
      // A lower clump hanging off each limb partway along, so the canopy comes down over the sidewalk.
      clumps.push({ at: fork.clone().lerp(tip, 0.6).add(new THREE.Vector3(Math.cos(a) * 0.9, -0.4, Math.sin(a) * 0.9)), r: 1.3 + rand(k * 29 + b, 1) * 0.5 });
      for (let c = 0; c < 2; c++) {
        const twig = tip.clone().add(new THREE.Vector3((rand(k * 13 + b, c) - 0.5) * 3, 1.2 + rand(k * 17 + b, c) * 2.2, (rand(k * 19 + b, c) - 0.5) * 3));
        limb(tip, twig, 0.08, 0.03);
        clumps.push({ at: twig, r: 1.5 + rand(k * 23 + b, c) * 0.9 });
      }
    }
    clumps.push({ at: fork.clone().add(new THREE.Vector3(0, 6.5, 0)), r: 2.4 });
    // And out the other way, over the sidewalk, so the canopy closes overhead.
    for (let c = 0; c < 2; c++) clumps.push({ at: fork.clone().add(new THREE.Vector3(-way * (2.6 + c * 1.4), 2.4 + c * 1.6, (c - 0.5) * 3)), r: 1.9 });
    for (let n = 0; n < count; n++) {
      const seed = k * 7919 + n;
      const clump = clumps[n % clumps.length];
      const r = (0.6 + 0.4 * Math.sqrt(rand(seed, 1))) * clump.r;
      const th = rand(seed, 2) * Math.PI * 2;
      const ph = Math.acos(2 * rand(seed, 3) - 1);
      const dir = new THREE.Vector3(Math.sin(ph) * Math.cos(th) * 1.15, Math.cos(ph) * 0.75, Math.sin(ph) * Math.sin(th));
      const at = clump.at.clone().addScaledVector(dir, r);
      // Lit tops and outsides a fresh yellow green, the undersides and the inside darker.
      const light = THREE.MathUtils.clamp(0.5 + dir.y * 0.35 + (r / clump.r - 0.8) * 0.8, 0, 1);
      crownSpots.push({ at, size: 1.1 + rand(seed, 4) * 0.65, colour: new THREE.Color().setHSL(0.2 + rand(seed, 5) * 0.06, 0.5 + rand(seed, 6) * 0.15, 0.12 + light * 0.16 + rand(seed, 7) * 0.05) });
    }
  };
  // Seeded from the tree at z = 27, as the block was first laid out, so the trees round the drawing keep their shapes.
  const first = treeZ.indexOf(27);
  treeZ.forEach((z, k) => tree(pitX, z, k - first, -1, z < -90 ? Math.round(perTree * 0.6) : perTree));
  // A row along the far curb too, its crowns hiding the houses across the road as much as the near ones frame ours.
  treeZ.forEach((z, k) => tree(farPitX, z - 4.5, k - first + 101, 1, Math.round(perTree * (z < -90 ? 0.35 : 0.6))));
  // The limestone house's dressing: tall black planters, each with a clipped box ball (a lumpy sphere, its surface
  // broken up by small leaves), and a window box of trailing ivy with white flowers.
  const ballGeometry = new THREE.SphereGeometry(1, 28, 18);
  const bp = ballGeometry.getAttribute("position");
  for (let i = 0; i < bp.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(bp, i);
    v.multiplyScalar(1 + (Math.sin(v.x * 9.1) * Math.sin(v.y * 8.3) * Math.sin(v.z * 7.7)) * 0.05);
    bp.setXYZ(i, v.x, v.y, v.z);
  }
  ballGeometry.computeVertexNormals();
  const potGeometry = new THREE.CylinderGeometry(0.4, 0.3, 1.0, 28);
  planters.forEach((p, k) => {
    dark.add(potGeometry, new THREE.Matrix4().makeTranslation(p.x, 0.5, p.z), new THREE.Color("#121212"));
    const ball = new THREE.Vector3(p.x, 1.38, p.z);
    green.add(ballGeometry, new THREE.Matrix4().makeScale(0.46, 0.42, 0.46).setPosition(ball), new THREE.Color("#2c4a1e"));
    for (let n = 0; n < 260; n++) {
      const d = new THREE.Vector3(rand(k * 31 + n, 1) - 0.5, rand(k * 31 + n, 2) - 0.45, rand(k * 31 + n, 3) - 0.5).normalize();
      leafSpots.push({ at: ball.clone().add(d.multiplyScalar(0.45)), size: 0.07, shade: 0, colour: new THREE.Color().setHSL(0.26, 0.5, 0.1 + rand(k * 31 + n, 4) * 0.1) });
    }
  });
  ballGeometry.dispose();
  potGeometry.dispose();
  windowBoxes.forEach(({ at, side }, k) => {
    dark.box(0.32, 0.3, 1.4, at.x + side * 0.1, at.y, at.z, new THREE.Color("#141414"));
    // Strands hanging from the box's front edge, longest in the middle, swinging a little.
    for (let strand = 0; strand < 26; strand++) {
      const sz = at.z + (strand / 25 - 0.5) * 1.5;
      const long = 0.3 + rand(k + strand, 1) * 1.3 * (1 - Math.abs(strand / 25 - 0.5));
      for (let t = 0; t < long; t += 0.045) {
        const at2 = new THREE.Vector3(at.x + side * (0.28 + Math.sin(t * 3 + strand) * 0.06), at.y + 0.12 - t, sz + Math.sin(t * 5 + strand * 2) * 0.08);
        leafSpots.push({ at: at2, size: 0.07 + rand(strand * 97 + t * 100, 2) * 0.04, shade: 0, colour: new THREE.Color().setHSL(0.27, 0.45, 0.12 + rand(strand * 31 + t * 100, 3) * 0.1) });
      }
    }
    // Leaves and white flowers heaped along the top.
    for (let n = 0; n < 90; n++) {
      const top = new THREE.Vector3(at.x + side * (0.1 + (rand(k + n, 4) - 0.5) * 0.36), at.y + 0.17 + rand(k + n, 5) * 0.2, at.z + (rand(k + n, 6) - 0.5) * 1.45);
      const flower = n % 3 === 0;
      leafSpots.push({ at: top, size: flower ? 0.06 : 0.08, shade: 0, colour: flower ? new THREE.Color("#f2f0ea") : new THREE.Color().setHSL(0.27, 0.45, 0.14) });
    }
    // A few plane leaves blown in from the street, caught on top of it, brown and curled.
    for (let n = 0; n < 9; n++) {
      const top = new THREE.Vector3(at.x + side * (0.05 + rand(k + n, 7) * 0.2), at.y + 0.22 + rand(k + n, 8) * 0.12, at.z + (rand(k + n, 9) - 0.5) * 1.3);
      leafSpots.push({ at: top, size: 0.1, shade: 0, colour: new THREE.Color().setHSL(0.05 + rand(k + n, 10) * 0.04, 0.55, 0.18) });
    }
  });
  const trunkGeometry = mergeParts(trunks);
  const trunk = new THREE.Mesh(trunkGeometry, barkMaterial);
  trunk.castShadow = trunk.receiveShadow = true;
  group.add(trunk);
  geometries.push(trunkGeometry);
  materials.push(barkMaterial);

  // A plane-tree leaf: lobed, a little cupped, as a small fan of triangles.
  const leafShape = new THREE.Shape();
  leafShape.moveTo(0, -0.5);
  [
    [0.18, -0.3],
    [0.5, -0.05],
    [0.32, 0.05],
    [0.42, 0.38],
    [0.14, 0.26],
    [0, 0.55],
    [-0.14, 0.26],
    [-0.42, 0.38],
    [-0.32, 0.05],
    [-0.5, -0.05],
    [-0.18, -0.3]
  ].forEach(([x, y]) => leafShape.lineTo(x, y));
  const leafGeometry = new THREE.ShapeGeometry(leafShape);
  // Each leaf its own green (the instance colour), lit from both faces.
  const leafMaterial = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.7 });
  // Leaves between the eye and the sun glow with the light coming through them, a fresh yellow green.
  // Only the thinner patches of each crown let it through, so the glow comes in clumps.
  const through = positionWorld.sub(cameraPosition).normalize().dot(sunWay).max(0).pow(14);
  // (The patches are metres across, so their noise is worked out per corner, not per pixel: a great many pixels of leaf.)
  const thin = varying(smoothstep(0.1, 0.6, mx_noise_float(positionWorld.mul(0.7).add(21))));
  // And looking up into the canopy, patches where the sun is full on the leaves above show through bright.
  const upward = smoothstep(0.15, 0.7, positionWorld.sub(cameraPosition).normalize().y);
  const sunlit = varying(smoothstep(0.25, 0.65, mx_noise_float(positionWorld.mul(0.45).add(4))));
  leafMaterial.emissiveNode = vec3(0.42, 0.55, 0.14).mul(through.mul(thin).mul(0.55)).add(vec3(0.38, 0.48, 0.12).mul(upward.mul(sunlit).mul(0.32)));
  // The canopy stays full to the eye, but lets the sun through: in the sun's shadow alone, gaps a metre or two across
  // open right through the crowns, lined up along the sun's way, so it comes down in pools on the sidewalk.
  const across = positionWorld.sub(sunWay.mul(positionWorld.dot(sunWay)));
  leafMaterial.maskShadowNode = mx_noise_float(across.mul(LEAF_GAPS.scale).add(9)).greaterThan(LEAF_GAPS.open);
  const leaves = new THREE.InstancedMesh(leafGeometry, leafMaterial, leafSpots.length);
  const lm = new THREE.Matrix4();
  const lq = new THREE.Quaternion();
  const le = new THREE.Euler();
  const lc = new THREE.Color();
  leafSpots.forEach(({ at, size, shade, colour }, i) => {
    le.set(rand(i, 6) * 6.28, rand(i, 7) * 6.28, rand(i, 8) * 6.28);
    lm.compose(at, lq.setFromEuler(le), new THREE.Vector3(size, size, size));
    leaves.setMatrixAt(i, lm);
    leaves.setColorAt(i, colour ?? lc.setHSL(0.24 + shade * 0.06, 0.45 + shade * 0.15, 0.16 + shade * 0.1));
  });
  // The crowns' sprays: four leaves fanned about a stalk, one instance each.
  // A plainer leaf for these (three lobes, five triangles): there are a great many of them and they are never close.
  const lobed = new THREE.Shape();
  lobed.moveTo(0, -0.5);
  [
    [0.5, -0.05],
    [0.36, 0.3],
    [0, 0.55],
    [-0.36, 0.3],
    [-0.5, -0.05]
  ].forEach(([x, y]) => lobed.lineTo(x, y));
  const lobedGeometry = new THREE.ShapeGeometry(lobed);
  const sprayParts: THREE.BufferGeometry[] = [];
  for (let j = 0; j < 4; j++) {
    const g = lobedGeometry.clone();
    g.scale(0.3, 0.3, 0.3);
    g.rotateX(-0.5 + rand(j, 1) * 0.9);
    g.rotateY(rand(j, 2) * 1.2);
    g.translate(Math.cos(j * 1.3) * 0.16, (j - 1.5) * 0.08, Math.sin(j * 1.3) * 0.16);
    sprayParts.push(g);
  }
  const sprayGeometry = mergeParts(sprayParts);
  lobedGeometry.dispose();
  // In bands along the street, so the bands out of the view or the sun's shadow box are skipped.
  const bands = new Map<number, typeof crownSpots>();
  crownSpots.forEach((spot) => {
    const band = Math.floor(spot.at.z / 24);
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band)!.push(spot);
  });
  bands.forEach((spots, band) => {
    const crown = new THREE.InstancedMesh(sprayGeometry, leafMaterial, spots.length);
    spots.forEach(({ at, size, colour }, i) => {
      le.set(rand(i + band * 9973, 16) * 6.28, rand(i + band * 9973, 17) * 6.28, rand(i + band * 9973, 18) * 6.28);
      lm.compose(at, lq.setFromEuler(le), new THREE.Vector3(size, size, size));
      crown.setMatrixAt(i, lm);
      crown.setColorAt(i, colour);
    });
    crown.computeBoundingSphere();
    crown.castShadow = true;
    crown.receiveShadow = true;
    group.add(crown);
  });
  geometries.push(sprayGeometry);
  leaves.castShadow = true;
  leaves.receiveShadow = true;
  group.add(leaves);
  geometries.push(leafGeometry);
  materials.push(leafMaterial);

  // ---- The merged piles.
  // Every wall and stoop weathered the same ways, from the dirty concrete scan and world-space masks: grime soaked into
  // the stone, rain streaks running down below the sills and the cornices, hairline cracks with dirt in them, and dirt
  // splashed up and caked along the foot of everything standing on the sidewalk, heaviest in the corner with the ground.
  const p = positionWorld;
  const soaked = texture(scans.dirty, uv().div(2.2)).rgb;
  const soakedLum = dot(soaked, vec3(0.3, 0.59, 0.11)).div(0.22);
  // (The scan read again pulled out tall, for streaks: a lookup, where noise per pixel over every wall would cost.)
  const lum = vec3(0.3, 0.59, 0.11);
  const streakScan = dot(texture(scans.dirty, uv().mul(vec2(0.55, 0.045)).add(0.37)).rgb, lum).div(0.22);
  // Just under each floor's sills (they run every 3.25 m up from the parlour's), and under the cornice.
  const underSill = smoothstep(1.7, 3.2, p.y.sub(2.27).mod(3.25)).mul(step(1.2, p.y));
  const streaks = smoothstep(1.0, 0.7, streakScan).mul(underSill.mul(0.7).add(0.3));
  const crackLine = float(1).sub(smoothstep(0.004, 0.014, mx_noise_float(p.mul(1.4).add(3)).abs())).mul(smoothstep(0.35, 0.6, mx_noise_float(p.mul(0.25).add(9))));
  // Damp risen up from the sidewalk, to a ragged tide line a metre or so up, darkest in the corner with the ground.
  const tide = soakedLum.mul(0.45).add(0.55);
  const footDirt = float(1).sub(smoothstep(0.0, 0.7, p.y)).mul(soakedLum.mul(0.3).add(0.75)).clamp(0, 1);
  const damp = float(1).sub(smoothstep(tide.mul(0.85), tide.mul(1.05), p.y)).mul(0.22);
  // Where the face has come away, in flakes: brownstone spalled back to paler raw stone, paint chipped to the
  // primer (see peel). Rare, and more of it low down.
  const flakeScan = dot(texture(scans.dirty, uv().mul(1.35).add(0.11)).rgb, lum).div(0.22);
  const flaked = smoothstep(1.5, 1.65, flakeScan.add(smoothstep(1.5, 0, p.y).mul(0.2)));
  // Dirt packed into the corners, as the light reaching into them falls off: along the foot of everything standing on
  // the sidewalk or the road, and on a stoop, along each riser's foot, the back of each tread and the cheek walls just
  // above the treads. All measured from the pile's own marks and the stoop's fixed rise and going, none of it noise.
  const nook = attribute("nook", "float");
  const upright = float(1).sub(step(0.5, abs(normalWorld.y)));
  const fromGround = p.y.sub(p.y.lessThan(-0.01).select(float(ROAD), float(0)));
  const fromFoot = upright.greaterThan(0.5).select(fromGround.max(0), float(10));
  // How far out from the house front, either side of the street; which tread that is, and its height.
  const outward = p.x.greaterThan(0).select(float(FRONT).sub(p.x), p.x.sub(FAR_FRONT));
  const treadAt = floor(outward.sub(0.78).div(0.24)).clamp(0, 10);
  const treadTop = float(1.72).mul(float(1).sub(treadAt.div(10)));
  const riserFoot = p.y.mod(0.172);
  const treadBack = fract(outward.sub(0.78).div(0.24)).mul(0.24);
  const cheekFoot = p.y.sub(treadTop);
  const fromCorner = mix(mix(riserFoot, treadBack, step(0.5, normalWorld.y)), cheekFoot, step(1.5, nook));
  // The nearer corner of the two; then, as on the sidewalk, a near-black contact line in the first few centimetres and
  // a band of blotchy dirt fading up over a quarter of a metre or so.
  const fromNook = min(fromFoot, fromCorner.max(0).add(float(1).sub(step(0.5, nook)).mul(10)));
  const wallBlotch = smoothstep(1.25, 0.7, soakedLum).mul(0.7).add(0.3);
  const wallBand = exp(fromNook.div(-0.35)).mul(wallBlotch).add(exp(fromNook.div(-0.12)).mul(0.5)).clamp(0, 1);
  const wallContact = exp(fromNook.div(-0.08));
  const weather = (colour: any, peel?: any) => {
    let c = colour.mul(mix(float(1), soakedLum, 0.45));
    if (peel) c = mix(c, peel, flaked);
    c = c.mul(streaks.mul(-0.36).add(1)).mul(float(1).sub(damp));
    c = mix(c, vec3(0.04, 0.035, 0.03), crackLine.mul(0.7));
    c = mix(c, vec3(0.05, 0.042, 0.034), footDirt.pow(1.3).mul(0.85));
    c = mix(c, vec3(0.04, 0.027, 0.015), wallBand);
    return mix(c, vec3(0.011, 0.009, 0.007), wallContact.mul(0.95));
  };
  const tinted = (rough: number, map?: THREE.Texture, mapNormal?: THREE.Texture, weathered = true, peel?: "stone" | "paint") => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: rough });
    const tint = attribute("tint", "vec3");
    if (map) {
      m.colorNode = weather(texture(map, uv().div(1.6)).rgb.mul(tint));
      if (mapNormal) m.normalNode = normalMap(texture(mapNormal, uv().div(1.6)));
    } else {
      // Stone: the colour drifting a little over the wall and weathered darker low down, its face pitted.
      const drift = mx_noise_float(vec3(p.mul(0.6))).mul(0.12).add(soakedLum.mul(0.05)).add(0.95);
      const grime = mix(float(0.82), float(1), smoothstep(0, 1.2, p.y));
      const own = tint.mul(drift).mul(grime);
      const under = peel === "stone" ? tint.mul(vec3(1.3, 1.22, 1.12)) : peel === "paint" ? vec3(0.13, 0.12, 0.11) : undefined;
      m.colorNode = weathered ? weather(own, under) : own;
      if (peel) m.roughnessNode = float(rough).add(flaked.mul(0.25));
      if (weathered) m.normalNode = normalMap(texture(scans.dirtyNormal, uv().div(2.2)), vec2(0.7));
    }
    materials.push(m);
    return m;
  };
  const pile = (p: Pile, material: THREE.Material, shadows = true) => {
    if (!p.positions.length) return;
    const g = p.build();
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
    geometries.push(g);
  };
  pile(stone, tinted(0.85, undefined, undefined, true, "stone"));
  pile(brick, tinted(0.9, scans.brick, scans.brickNormal));
  pile(trim, tinted(0.6));
  pile(dark, tinted(0.5, undefined, undefined, true, "paint"));
  pile(green, tinted(0.8, undefined, undefined, false));
  // The windows: the street and sky in the glass, and behind it each its own room (by its tint: what hangs in it,
  // how far across, a hue), mostly dark at this hour; curtains drawn back to the sides, blinds part down, a sheer
  // across, or a lamp still on. Its uv runs 0 to 1 across the pane.
  const glassMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.1 });
  {
    const tint = attribute("tint", "vec3");
    const [what, much, hue] = [tint.x, tint.y, tint.z];
    const at = uv();
    const fabric = mix(mix(vec3(0.42, 0.38, 0.31), vec3(0.2, 0.1, 0.08), step(0.75, hue)), vec3(0.46, 0.45, 0.43), step(hue, 0.35));
    const folds = at.x.mul(46).sin().mul(0.25).add(0.75);
    const curtains = step(0.4, what).mul(step(what, 0.65)).mul(step(float(0.5).sub(much.mul(0.3).add(0.08)), abs(at.x.sub(0.5))));
    const blinds = step(0.65, what).mul(step(what, 0.85)).mul(step(float(1).sub(much.mul(0.85).add(0.1)), at.y));
    const sheer = step(0.85, what).mul(step(what, 0.95));
    const lamp = step(0.95, what);
    // The room: dark, a little lighter low down where the floor catches the light, a lamp's glow if one is on.
    const inside = vec3(0.018, 0.016, 0.015).mul(hue.mul(0.8).add(0.6)).mul(smoothstep(1.1, 0.0, at.y).mul(0.6).add(0.7));
    let behind: any = mix(inside, fabric.mul(folds), curtains);
    behind = mix(behind, vec3(0.5, 0.47, 0.41).mul(at.y.mul(160).fract().mul(0.3).add(0.7)), blinds);
    // A shop's window: shelves of goods inside, lit.
    const shelves = step(0.985, what);
    behind = mix(behind, mix(vec3(0.05, 0.045, 0.04), vec3(0.14, 0.11, 0.08).mul(fract(floor(at.x.mul(9)).mul(0.618).add(hue)).mul(0.8).add(0.4)), step(0.7, fract(at.y.mul(5)))), shelves.mul(step(at.y, 0.82)));
    behind = mix(behind, vec3(0.38, 0.37, 0.34), sheer.mul(0.7));
    glassMaterial.colorNode = behind;
    const { env, fresnel } = streetReflection(normalWorld, sunWay);
    // The lamp's glow brightest up by the ceiling, and dimmed where a curtain hangs in front of it.
    const glow = vec3(1, 0.64, 0.32).mul(lamp.mul(much.mul(0.1).add(0.04))).mul(smoothstep(0.1, 1, at.y).mul(0.7).add(0.3)).mul(float(1).sub(curtains.mul(0.5)));
    glassMaterial.emissiveNode = env.mul(fresnel.mul(0.7).add(0.05)).add(glow);
  }
  materials.push(glassMaterial);
  pile(glass, glassMaterial, false);
  // The shop signs: painted boards, their names lettered on in gilt.
  pile(signs, tinted(0.55, undefined, undefined, false));
  const lettering = signLettering();
  if (lettering) {
    materials.push(lettering);
    pile(names, lettering, false);
  }
  // Dirt run down the walls: dark, in streaks (the scan pulled out tall), heaviest just under the ledge it ran off.
  const stainMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  {
    const tint = attribute("tint", "vec3");
    const at = uv();
    const run = dot(texture(scans.dirty, vec2(p.z.mul(0.9).add(tint.y.mul(5)), p.y.mul(0.06))).rgb, lum).div(0.22);
    const down = at.y.pow(1.6);
    const sides = smoothstep(0.5, 0.36, abs(at.x.sub(0.5)));
    stainMaterial.colorNode = vec3(0.05, 0.043, 0.035);
    stainMaterial.opacityNode = smoothstep(1.05, 0.6, run).mul(down).mul(sides).mul(0.75).add(at.y.pow(8).mul(sides).mul(0.3)).mul(tint.x).clamp(0, 0.85);
  }
  materials.push(stainMaterial);
  pile(stains, stainMaterial, false);
  // Iron painted black, worn: rust come through in patches and along the feet where the wet sits, and chipped back to
  // the grey primer here and there.
  const ironMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.5 });
  {
    const rustScan = dot(texture(scans.dirty, vec2(p.x.add(p.z).mul(0.45), p.y.mul(0.35)).add(0.2)).rgb, lum).div(0.22);
    const rust = smoothstep(0.8, 0.5, rustScan).mul(0.7).add(smoothstep(0.3, 0.02, p.y).mul(0.6)).clamp(0, 1);
    const chipped = smoothstep(1.55, 1.7, rustScan).mul(0.6);
    ironMaterial.colorNode = mix(mix(vec3(0.012, 0.012, 0.013), vec3(0.075, 0.035, 0.02), rust), vec3(0.09, 0.085, 0.08), chipped);
    ironMaterial.roughnessNode = float(0.42).add(rust.mul(0.45)).add(chipped.mul(0.2));
    ironMaterial.metalnessNode = float(0.5).sub(rust.mul(0.4)).sub(chipped.mul(0.4));
  }
  materials.push(ironMaterial);
  const iron = bars.build(ironMaterial);
  group.add(iron.mesh);
  geometries.push(iron.geometry);

  // ---- Parking signs along both curbs (none by the drawing), the trash out by the stoops.
  for (let z = NEAR - 8; z > AWAY + 10; z -= 17 + rand(z, 31) * 9) {
    if (Math.abs(z) > 20 && TREE_Z.every((t) => Math.abs(t - z) > 1.3) && LAMP_Z.every((l) => Math.abs(l - z) > 1)) clutter.posts.push({ x: CURB + 0.3, z, way: 1 });
    if (TREE_Z.every((t) => Math.abs(t - 4.5 - (z - 6.3)) > 1.3)) clutter.posts.push({ x: FAR_CURB - 0.3, z: z - 6.3, way: -1 });
  }
  // A hydrant across the street, in view down the block (a plain one: the scanned one by the artist costs as much as
  // the whole of the rest of this).
  clutter.hydrants.push({ x: FAR_CURB - 0.55, z: -24.6 }, { x: FAR_CURB - 0.55, z: -66 });
  const odds = buildClutter(clutter);
  group.add(odds.mesh);
  geometries.push(...odds.geometries);
  materials.push(...odds.materials);

  // ---- Bike racks between the trees and the lamps on the curb side, clear of the drawing and the chalk by the tree
  // nearest it; bikes locked to most of them, near the drawing on the side away from it.
  const racks = [
    { z: 6.1, bikes: [-1] },
    { z: -9.4, bikes: [-1, 1] },
    { z: -11.7, bikes: [-1] },
    { z: -27.6, bikes: [1] },
    { z: -29.8, bikes: [] },
    { z: -52.4, bikes: [-1, 1] },
    { z: 40.5, bikes: [-1] }
  ].filter(({ z }) => TREE_Z.every((t) => Math.abs(t - z) > 1.5) && LAMP_Z.every((l) => Math.abs(l - z) > 1.1));
  const bikes = buildBikes(racks.map((r) => ({ ...r, x: CURB + 0.62 })));
  group.add(bikes.group);
  geometries.push(...bikes.geometries);
  materials.push(...bikes.materials);

  // ---- Cars parked far down the block, both sides; none near the drawing.
  const cars = buildCars(carPlaces(), ROAD, sunWay.value as THREE.Vector3);
  group.add(cars.group);
  geometries.push(...cars.geometries);
  materials.push(...cars.materials);

  // ---- The sky: pale near the ground and toward the low sun down the street, bluer overhead.
  const skyGeometry = new THREE.SphereGeometry(300, 32, 16);
  const skyMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
  const dir = positionWorld.normalize();
  const up = smoothstep(-0.05, 0.6, dir.y);
  const glow = smoothstep(0.6, 1, dir.dot(sunWay)).pow(3);
  skyMaterial.colorNode = mix(vec3(0.86, 0.88, 0.86), vec3(0.42, 0.6, 0.84), up).add(vec3(1, 0.86, 0.62).mul(glow.mul(1.4))).mul(1.6);
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.renderOrder = -2;
  group.add(sky);
  geometries.push(skyGeometry);
  materials.push(skyMaterial);

  return { group, treeZ, geometries, materials, sunWay: sunWay.value as THREE.Vector3 };
}

// Where the cars are parked, far down the block both sides; none near the drawing.
function carPlaces() {
  const places: { x: number; z: number; turn: number; seed: number }[] = [];
  const place = (x: number, z: number, turn: number) => places.push({ x: x + (rand(z, 9) - 0.5) * 0.25, z, turn, seed: places.length * 7 + 3 });
  for (let z = -40; z > AWAY + 10; z -= 5.4 + rand(z, 3) * 1.8) if (rand(z, 4) > 0.25) place(CURB - 1.25, z, Math.PI / 2);
  for (let z = -34; z > AWAY + 10; z -= 5.4 + rand(z, 5) * 1.8) if (rand(z, 6) > 0.2) place(FAR_CURB + 1.25, z, -Math.PI / 2);
  // And a few back behind the start, across the road.
  for (let z = 70; z > 26; z -= 5.4 + rand(z, 7) * 1.8) if (rand(z, 8) > 0.35) place(FAR_CURB + 1.25, z, -Math.PI / 2);
  return places;
}

function mergeParts(parts: THREE.BufferGeometry[]) {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  let base = 0;
  parts.forEach((g) => {
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const u = g.getAttribute("uv");
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      normals.push(n.getX(i), n.getY(i), n.getZ(i));
      uvs.push(u.getX(i), u.getY(i));
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) index.push(g.index.getX(i) + base);
    else for (let i = 0; i < p.count; i++) index.push(i + base);
    base += p.count;
    g.dispose();
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  merged.setIndex(index);
  return merged;
}

