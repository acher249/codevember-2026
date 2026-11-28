import * as THREE from "three/webgpu";
import { lehmer } from "../shared/engine/random";
import { CavernRock, faceZ, galleryCentre, groundY, POOL_WATER, Rock, topY, type Cavern } from "./field";
import { around, holds, pool, river, type Fall, type Sheet } from "./water";

// What fills a cavern found by digging (the hashed ones, field.ts `cellCavern`): where every piece of its dressing goes
// and the light it gives, as plain numbers. Worked out in a worker (dress-worker.ts), off the page: placing one cavern
// asks the field some thousands of questions, which on the page held a frame for tens of milliseconds just as a cavern
// came into reach. The page only copies the result into its pools (dressing.tsx).

// How many instances of each piece one cavern may use.
export const PER = {
  stalactite: 12,
  stalactiteB: 12,
  stalagmite: 8,
  column: 4,
  straw: 10,
  curtain: 5,
  fungus: 90,
  rubble: 64,
  boulder0: 3,
  boulder1: 3,
  boulder2: 3,
  puddle: 7,
  lantern: 1,
  flame: 1,
  crate: 3,
  // Breakdown (slabs fallen from the roof), rimstone pools with their cave pearls, flowstone down the walls, moonmilk,
  // and roots hanging through where the surface is near.
  breakdown0: 6,
  breakdown1: 6,
  rimstone: 6,
  flowstone: 4,
  moonmilk: 6,
  roots: 8,
  // Each kind's own (see GROUP).
  shroom: 18,
  selenite: 40,
  bone: 70,
  skull: 5,
  rib: 50,
  block: 14,
  hatchet: 1,
  bedroll: 1,
  rope: 1,
  log: 5,
  embers: 1,
  fire: 5,
  dinoSkull: 1,
  dinoVert: 58,
  dinoRib: 30,
  limb: 12,
  ammonite: 5,
  trilobite: 5,
  quartz: 96
} satisfies Record<string, number>;
export type PoolName = keyof typeof PER;
export const POOLS = Object.keys(PER) as PoolName[];

// The pieces only one kind of cavern holds. Every cavern dressed borrows one of the SLOTS of every common pool, but a
// kind's own pools have room for only a few caverns of that kind at once: hidden instances still cost their vertices,
// and with caverns every few metres all the slots are always in use.
export const SLOTS = 8;
export const GROUP: Partial<Record<PoolName, Cavern["kind"]>> = {
  shroom: "mushrooms",
  selenite: "selenite",
  bone: "bones",
  skull: "bones",
  rib: "bones",
  block: "temple",
  hatchet: "camp",
  bedroll: "camp",
  rope: "camp",
  log: "camp",
  embers: "camp",
  fire: "camp",
  dinoSkull: "dino",
  dinoVert: "dino",
  dinoRib: "dino",
  limb: "dino",
  ammonite: "ammonites",
  trilobite: "ammonites",
  quartz: "pool"
};
export const KIND_SLOTS: Partial<Record<Cavern["kind"], number>> = { mushrooms: 3, selenite: 3, bones: 3, temple: 3, camp: 3, dino: 2, ammonites: 2, pool: 3 };
export const BOULDER_SHAPES = 3;

export type Placed = { pool: PoolName; m: THREE.Matrix4; tint?: number };
// A light a cavern holds, for the rock round it: where, its colour and strength, and how much it flickers (a fire's).
export type Glow = { p: THREE.Vector3; colour: THREE.Color; strength: number; flicker?: number };
export type Made = {
  placed: Placed[];
  glows: Glow[];
  // A river's water and its fall; molten rock; a still pool's water.
  water?: { level: number; sheet: Sheet; fall?: Fall };
  lava?: { level: number; sheet: Sheet };
  pond?: { level: number; sheet: Sheet };
  // The level the cavern's puddles lie at, and where they lie (for the one mirror they share).
  still?: { level: number; spread: THREE.Sphere };
  // A fire burning in it (a lost explorer's camp).
  fire?: THREE.Vector3;
};

// A sampler of the real rock (see water.ts `around`) as a Rock, to march rays through.
class Sampled extends Rock {
  field: Pick<Rock, "sample">;
  constructor(field: Pick<Rock, "sample">) {
    super();
    this.field = field;
  }
  sample(x: number, y: number, z: number) {
    return this.field.sample(x, y, z);
  }
}

// ---- Placing -------------------------------------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

// Random points in a cavern's air: anywhere in a hall's footprint, or along a gallery's winding line.
function cavernPoint(c: Cavern, random: () => number, out: THREE.Vector3) {
  if (c.axis) {
    const at: [number, number, number] = [0, 0, 0];
    galleryCentre(c, (random() * 2 - 1) * c.size[0] * 0.9, at);
    return out.set(at[0] + (random() - 0.5) * c.size[1], at[1], at[2] + (random() - 0.5) * c.size[1]);
  }
  const a = random() * Math.PI * 2;
  const r = Math.sqrt(random()) * 0.85;
  return out.set(c.centre[0] + Math.cos(a) * r * c.size[0], c.centre[1], c.centre[2] + Math.sin(a) * r * c.size[2]);
}

// Where a ray from inside meets the cavern's wall, with the wall's normal (into the air).
function hit(field: Rock, from: THREE.Vector3, dir: THREE.Vector3, far: number, normal: THREE.Vector3) {
  if (field.sample(from.x, from.y, from.z) > -0.05) return null;
  const t = field.march(from.x, from.y, from.z, dir.x, dir.y, dir.z, far);
  if (t <= 0) return null;
  const p = from.clone().addScaledVector(dir, t);
  const g = [0, 0, 0];
  field.gradient(p.x, p.y, p.z, g, 0.12);
  normal.set(-g[0], -g[1], -g[2]).normalize();
  return p;
}

const compose = (p: THREE.Vector3, q: THREE.Quaternion, sx: number, sy: number, sz: number) => new THREE.Matrix4().compose(p, q, new THREE.Vector3(sx, sy, sz));
const turned = (yaw: number) => new THREE.Quaternion().setFromAxisAngle(UP, yaw);

// Everything one cavern holds: where each piece goes, and the light it gives.
export function dress(c: Cavern, whole: Rock): Made {
  const field = new CavernRock(c);
  // The real rock round it (other caverns, digs), for what must lie on a real floor.
  const rock = around(c, whole);
  const random = lehmer(Math.floor((c.seed ?? 1) * 1000) + 7);
  // The same, as a Rock to march (for the floors that what is placed must stand on).
  const solid = new Sampled(rock);
  const placed: Placed[] = [];
  const glows: Glow[] = [];
  let still: Made["still"];
  const done = (more: Partial<Made> = {}): Made => ({ placed, glows, still, ...more });
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const span = c.axis ? c.size[1] : c.size[1];
  // Dripstone: fewer and bigger. Stalactite clusters hang from the roof; under the bigger ones a lower stalagmite has
  // grown, and where the roof is low the two have met in a column. Round some, a patch of soda straws; along a few
  // cracks in the roof, a curtain.
  const ceiling = (count: number, longest: number) => {
    let made = 0;
    count = Math.ceil(count * 0.45);
    longest *= 1.3;
    for (let k = 0; k < count * 3 && made < count; k++) {
      cavernPoint(c, random, p);
      const at = hit(field, p, UP, span * 3, n);
      if (!at || n.y > -0.45) continue;
      made++;
      const len = 0.2 + Math.pow(random(), 1.6) * longest;
      const w = len * (0.4 + random() * 0.25);
      const under = hit(field, at.clone().add(new THREE.Vector3(0, -0.2, 0)), DOWN, span * 4, n);
      const gap = under && n.y > 0.5 ? at.y - under.y : Infinity;
      if (gap < len * 2.4 && gap > 0.6) {
        // A column, floor to roof.
        const fat = Math.min(gap * 0.32, w * 1.6);
        placed.push({ pool: "column", m: compose((under as THREE.Vector3).clone().add(new THREE.Vector3(0, gap + 0.05, 0)), turned(random() * 6.3), fat, gap + 0.15, fat), tint: random() });
        continue;
      }
      placed.push({ pool: random() < 0.5 ? "stalactite" : "stalactiteB", m: compose(at.clone().addScaledVector(n, -0.03), q.setFromAxisAngle(UP, random() * 6.3), w, len, w), tint: random() });
      if (random() < 0.35) {
        const spread = 0.4 + random() * 0.8;
        placed.push({
          pool: "straw",
          m: compose(at.clone().add(new THREE.Vector3((random() - 0.5) * 1.2, 0.02, (random() - 0.5) * 1.2)), turned(random() * 6.3), spread, 0.1 + random() * 0.3, spread),
          tint: random()
        });
      }
      if (random() < 0.16) {
        const wide = 1.4 + random() * 1.8;
        placed.push({ pool: "curtain", m: compose(at.clone().add(new THREE.Vector3(0, 0.12, 0)), turned(random() * 6.3), wide, 0.5 + random() * 0.9, 1), tint: random() });
      }
      // Stalagmites under the bigger ones only, and shorter: the roof's are most of it.
      if (under && gap < Infinity && len > longest * 0.4 && random() < 0.4) {
        const h = len * (0.5 + random() * 0.5);
        placed.push({
          pool: "stalagmite",
          m: compose(under.clone().addScaledVector(n, -0.04), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI).premultiply(turned(random() * 6.3)), w * 0.7, h, w * 0.7),
          tint: random()
        });
      }
    }
  };
  // The real floor (every cavern, every dig) under a point in the air, or null: everything on a floor stands on it,
  // not on the cavern's own (a neighbour reaching in, or a dig, can take that away).
  const groundAt = (from: THREE.Vector3) => {
    const at = hit(solid, from, DOWN, span * 4, n);
    return at && n.y > 0.55 ? at : null;
  };
  const floorAt = groundAt;
  // Fallen rock: the big pieces are scanned boulders, sunk a third into the floor, tilted, with chips and flakes round
  // their feet; the rest is that scatter alone.
  const chips = (around: THREE.Vector3, radius: number, count: number, size: number) => {
    for (let k = 0; k < count; k++) {
      const a = random() * Math.PI * 2;
      const d = radius * (0.8 + random() * 0.7);
      p.set(around.x + Math.cos(a) * d, around.y + 0.5, around.z + Math.sin(a) * d);
      const at = floorAt(p);
      if (!at) continue;
      const s = size * (0.3 + Math.pow(random(), 2) * 0.9);
      placed.push({
        pool: "rubble",
        m: compose(
          at.addScaledVector(n, s * 0.15),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(random() * 6, random() * 6, random() * 6)),
          s,
          s * (0.4 + random() * 0.4),
          s * (0.7 + random() * 0.4)
        ),
        tint: random()
      });
    }
  };
  const rubble = (count: number, big: number) => {
    let boulders = 0;
    for (let k = 0; k < count; k++) {
      cavernPoint(c, random, p);
      const at = floorAt(p);
      if (!at) continue;
      if (boulders < 6 && random() < 0.3) {
        // A boulder, half a metre to a metre and a bit across (the scans are low, so a little sinking beds them in).
        const s = 0.45 + Math.pow(random(), 1.6) * (0.4 + big);
        const shape = Math.floor(random() * BOULDER_SHAPES);
        const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler((random() - 0.5) * 0.5, random() * 6.3, (random() - 0.5) * 0.5));
        placed.push({ pool: `boulder${shape}` as PoolName, m: compose(at.clone().addScaledVector(n, -s * 0.09), tilt, s, s * (0.9 + random() * 0.5), s), tint: random() });
        chips(at, s * 0.55, 6, 0.09);
        boulders++;
      } else chips(at, 0.15, 2, 0.07 + big * 0.1);
    }
  };
  // Fungi in clusters round the foot of the walls, each cluster a soft light on the rock round it.
  const fungi = (clusters: number, each: number, colour: THREE.Color, strength: number) => {
    for (let k = 0; k < clusters; k++) {
      cavernPoint(c, random, p);
      const at = floorAt(p);
      if (!at) continue;
      // Toward the nearest wall from there.
      const dir = new THREE.Vector3(Math.cos(random() * 6.3), 0, Math.sin(random() * 6.3));
      const wall = hit(field, at.clone().add(new THREE.Vector3(0, 0.25, 0)), dir, Math.max(...c.size) * 2, n) ?? at;
      const base = wall.clone().addScaledVector(dir, -0.25);
      for (let j = 0; j < each; j++) {
        const s = new THREE.Vector3(base.x + (random() - 0.5) * 1.2, base.y + 0.6, base.z + (random() - 0.5) * 1.2);
        const ground = floorAt(s);
        if (!ground) continue;
        const size = 0.03 + Math.pow(random(), 2) * 0.09;
        placed.push({
          pool: "fungus",
          m: compose(ground.addScaledVector(n, -0.01), new THREE.Quaternion().setFromUnitVectors(UP, n.clone().lerp(UP, 0.5).normalize()), size, size * (0.8 + random() * 0.6), size),
          tint: random()
        });
      }
      glows.push({ p: base.clone().add(new THREE.Vector3(0, 0.25, 0)), colour: colour.clone(), strength });
    }
  };
  const glowGreen = new THREE.Color(0.25, 0.95, 0.65);

  // Breakdown: slabs fallen from the roof, bedded flat where they landed, now and then one on edge, sunk a little in
  // the floor, with chips round their feet. `big` is their length in metres.
  const breakdown = (count: number, big: number) => {
    for (let k = 0, made = 0; k < count * 4 && made < count; k++) {
      cavernPoint(c, random, p);
      const at = floorAt(p);
      if (!at) continue;
      made++;
      const s = big * (0.45 + Math.pow(random(), 1.4) * 0.8);
      const lean = random() < 0.22 ? 0.45 + random() * 0.5 : (random() - 0.5) * 0.25;
      const bed = new THREE.Quaternion().setFromUnitVectors(UP, n).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(lean, random() * 6.3, (random() - 0.5) * 0.2, "YXZ")));
      placed.push({ pool: random() < 0.5 ? "breakdown0" : "breakdown1", m: compose(at.clone().addScaledVector(n, -s * 0.1), bed, s, s * (0.7 + random() * 0.6), s * (0.8 + random() * 0.4)), tint: random() });
      chips(at, s * 0.5, 4, 0.06 + big * 0.03);
    }
  };
  // Rimstone pools: a dam of calcite holding a shallow basin of still water, cave pearls in it, only where the floor
  // under the whole dam is level (the water inside must not stand above the rock round it, nor the dam hang over a
  // drop), and not on top of each other.
  const rims: THREE.Vector4[] = [];
  const probe = new THREE.Vector3();
  const rimstones = (count: number) => {
    for (let k = 0, made = 0; k < count * 6 && made < count; k++) {
      cavernPoint(c, random, p);
      const at = floorAt(p);
      if (!at || n.y < 0.9) continue;
      let r = 0.3 + random() * 0.6;
      const sy = 0.7 + r * 0.6;
      const level = (radius: number) => {
        for (let j = 0; j < 7; j++) {
          const a = (j / 7) * Math.PI * 2;
          const g = floorAt(probe.set(at.x + Math.cos(a) * radius * 1.05, at.y + 0.5, at.z + Math.sin(a) * radius * 1.05));
          if (!g || g.y > at.y + 0.02 || g.y < at.y - 0.12 * sy) return false;
        }
        return true;
      };
      for (let tries = 0; tries < 2 && !level(r); tries++) r *= 0.7;
      if (r < 0.2 || !level(r) || rims.some((o) => Math.hypot(o.x - at.x, o.z - at.z) < o.w + r + 0.1)) continue;
      made++;
      rims.push(new THREE.Vector4(at.x, at.y, at.z, r));
      placed.push({ pool: "rimstone", m: compose(at.clone().setY(at.y - 0.015), turned(random() * 6.3), r, sy, r), tint: random() });
    }
  };
  // Flowstone poured down a wall to the floor, from a crack a metre or two up.
  const flows = (count: number) => {
    const out = new THREE.Vector3();
    const side = new THREE.Vector3();
    for (let k = 0, made = 0; k < count * 5 && made < count; k++) {
      cavernPoint(c, random, p);
      const ground = floorAt(p);
      if (!ground) continue;
      const a = random() * Math.PI * 2;
      const wall = hit(field, ground.clone().add(new THREE.Vector3(0, 1.1 + random() * 1.5, 0)), new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), Math.max(...c.size) * 2, n);
      if (!wall || Math.abs(n.y) > 0.35) continue;
      out.set(n.x, 0, n.z).normalize();
      const foot = floorAt(wall.clone().addScaledVector(out, 0.35));
      if (!foot) continue;
      const length = wall.y - foot.y + 0.08;
      if (length < 0.6 || length > 3.2) continue;
      made++;
      const w = Math.min(length * 0.8, 1.6) * (0.7 + random() * 0.5);
      // Its +z out of the wall, +y up: x = y × z keeps the frame right-handed (no mirroring, so no faces turned in).
      side.crossVectors(UP, out);
      const m = new THREE.Matrix4().makeBasis(side, UP, out).scale(new THREE.Vector3(w, length, w));
      m.setPosition(wall.addScaledVector(out, -0.06));
      placed.push({ pool: "flowstone", m, tint: random() });
    }
  };
  // Moonmilk: soft white crusts on the walls and roof (never the floor, where it is trodden into the mud).
  const milk = (count: number) => {
    const dir = new THREE.Vector3();
    for (let k = 0, made = 0; k < count * 4 && made < count; k++) {
      cavernPoint(c, random, p);
      dir.set(random() * 2 - 1, random() * 1.4 - 0.3, random() * 2 - 1).normalize();
      const at = hit(field, p, dir, Math.max(...c.size) * 2, n);
      if (!at || n.y > 0.4) continue;
      made++;
      const s = 0.25 + Math.pow(random(), 1.5) * 0.6;
      placed.push({ pool: "moonmilk", m: compose(at.addScaledVector(n, -0.02), new THREE.Quaternion().setFromUnitVectors(UP, n).multiply(turned(random() * 6.3)), s, s * (0.5 + random() * 0.5), s * (0.6 + random() * 0.4)), tint: random() });
    }
  };
  // Roots hanging through the roof, only where the open air (the plateau, or the ground before the cliff) is a few
  // metres above it.
  const rootsDown = (count: number) => {
    for (let k = 0, made = 0; k < count * 3 && made < count; k++) {
      cavernPoint(c, random, p);
      const at = hit(field, p, UP, span * 3, n);
      if (!at || n.y > -0.4) continue;
      const above = (at.z < faceZ(at.x, at.y) ? topY(at.x, at.z) : groundY(at.x, at.z)) - at.y;
      if (above > 6 || above < 0.3) continue;
      made++;
      const s = 0.5 + random() * 0.9;
      placed.push({ pool: "roots", m: compose(at.addScaledVector(n, -0.04), turned(random() * 6.3), s, s * (0.8 + random() * 0.9), s), tint: random() });
    }
  };
  // Still pools on the flattest low floor, mirroring the lights.
  // All of a cavern's pools stand at one level (water finds its own), the lowest flat floor found, so one mirror
  // serves them all.
  const puddles = (count: number) => {
    let level = Infinity;
    const spots: THREE.Vector3[] = [];
    for (let k = 0; k < count * 8; k++) {
      cavernPoint(c, random, p);
      const at = floorAt(p);
      if (!at || n.y < 0.85) continue;
      spots.push(at.clone());
      level = Math.min(level, at.y);
    }
    let made = 0;
    const spread = new THREE.Sphere(new THREE.Vector3(), -1);
    // A pool only where it has a basin: its film must lie on the real floor (or run under a wall) all round, out to
    // where it fades. One spread over a dip in a neighbouring cavern, or over the lip of a ledge, is drawn in, and
    // left out if even a small one would not lie.
    const lies = (x: number, z: number, r: number, squash: number, yaw: number) => {
      for (let k = 0; k < 9; k++) {
        const a = (k / 8) * Math.PI * 2;
        const f = k === 8 ? 0 : 0.85;
        const lx = Math.cos(a) * r * f;
        const lz = Math.sin(a) * r * squash * f;
        // The puddle's own yaw, as `turned` sets it (about +y).
        const wx = x + lx * Math.cos(yaw) + lz * Math.sin(yaw);
        const wz = z - lx * Math.sin(yaw) + lz * Math.cos(yaw);
        if (!holds(rock, wx, level + 0.06, wz, 0.12)) return false;
      }
      return true;
    };
    for (const at of spots) {
      if (made >= count || at.y > level + 0.3) continue;
      let r = 0.35 + random() * 1.1 + (at.y - level) * 1.5;
      const squash = 0.6 + random() * 0.4;
      const yaw = random() * 6.3;
      for (let tries = 0; tries < 3 && !lies(at.x, at.z, r, squash, yaw); tries++) r *= 0.65;
      if (!lies(at.x, at.z, r, squash, yaw)) continue;
      spread.expandByPoint(at);
      placed.push({ pool: "puddle", m: compose(at.setY(level + 0.06), turned(yaw), r, 1, r * squash) });
      made++;
    }
    // (Pools reach up to two metres or so from their centres.)
    if (made) still = { level: level + 0.06, spread: spread.set(spread.center, spread.radius + 2.2) };
  };
  // (Not in a river, whose own water covers its floor.)
  if (c.kind !== "lava" && c.kind !== "selenite" && c.kind !== "river" && c.kind !== "pool") puddles(5);

  switch (c.kind) {
    case "hall":
      // The great dripstone chamber: breakdown from the roof, rimstone pools, flowstone down the walls.
      ceiling(46, 1.5);
      rubble(24, 0.6);
      breakdown(6, 1.8);
      rimstones(6);
      flows(4);
      milk(2);
      rootsDown(6);
      fungi(3, 12, glowGreen, 0.5);
      break;
    case "gallery":
      // A dry winding passage: moonmilk on its walls, rubble and slabs underfoot, roots where it runs shallow.
      ceiling(18, 0.8);
      rubble(30, 0.45);
      breakdown(4, 1.0);
      milk(6);
      flows(1);
      rootsDown(8);
      fungi(2, 10, glowGreen, 0.45);
      break;
    case "river": {
      // Wet and loud: flowstone streaming down the walls to the water, boulders fallen in it.
      ceiling(16, 0.9);
      rubble(14, 0.5);
      breakdown(3, 1.2);
      flows(4);
      rootsDown(4);
      // Water along the floor, and a fall pouring in at the far end; the water's own cool light round its foot.
      const water = river(c, field, rock, c.centre[1] + (c.floor ?? 0) + 0.45);
      if (water?.fall) glows.push({ p: water.fall.foot.clone().add(new THREE.Vector3(0, 0.5, 0)), colour: new THREE.Color(0.3, 0.6, 0.7), strength: 0.35 });
      return done({ water });
    }
    case "mushrooms": {
      for (let k = 0; k < 18; k++) {
        cavernPoint(c, random, p);
        const at = floorAt(p);
        if (!at) continue;
        const s = 0.35 + Math.pow(random(), 1.5) * 1.3;
        placed.push({
          pool: "shroom",
          m: compose(
            at.addScaledVector(n, -0.05),
            new THREE.Quaternion().setFromEuler(new THREE.Euler((random() - 0.5) * 0.3, random() * 6.3, (random() - 0.5) * 0.3)),
            s,
            s * (0.8 + random() * 0.5),
            s
          ),
          tint: random()
        });
        if (k % 3 === 0) glows.push({ p: at.clone().add(new THREE.Vector3(0, s * 0.8, 0)), colour: new THREE.Color(0.3, 0.75, 1.0), strength: 0.5 + s * 0.4 });
      }
      fungi(6, 14, new THREE.Color(0.35, 0.8, 1.0), 0.45);
      ceiling(16, 0.6);
      // Damp and organic: roots in the roof, moonmilk.
      rootsDown(8);
      milk(3);
      breakdown(2, 0.9);
      break;
    }
    case "selenite": {
      // Beams of gypsum crystal, metres long, crossing the chamber from wall to wall at every angle.
      for (let k = 0; k < 40; k++) {
        const big = k < 14;
        const dir = new THREE.Vector3(random() * 2 - 1, (random() - 0.4) * (big ? 0.5 : 1.4), random() * 2 - 1).normalize();
        const from = new THREE.Vector3(...c.centre).add(new THREE.Vector3((random() - 0.5) * c.size[0], (random() - 0.6) * c.size[1], (random() - 0.5) * c.size[2]));
        const start = hit(field, from, dir.clone().negate(), Math.max(...c.size) * 3, n);
        if (!start) continue;
        const reach = field.march(start.x + n.x * 0.1, start.y + n.y * 0.1, start.z + n.z * 0.1, dir.x, dir.y, dir.z, 14);
        const length = big ? Math.min(Math.max(2.5, (reach > 0 ? reach : 8) * (0.7 + random() * 0.4)), 11) : 0.6 + random() * 2;
        const r = big ? 0.22 + random() * 0.4 : 0.05 + random() * 0.12;
        placed.push({
          pool: "selenite",
          m: compose(start.addScaledVector(dir, -0.15), new THREE.Quaternion().setFromUnitVectors(UP, dir).multiply(turned(random() * 6.3)), r, length, r),
          tint: random()
        });
      }
      glows.push({ p: new THREE.Vector3(...c.centre), colour: new THREE.Color(0.95, 0.85, 0.65), strength: 0.25 });
      // A white crust of gypsum on the walls, and slabs fallen among the beams.
      milk(6);
      breakdown(2, 1.2);
      break;
    }
    case "bones": {
      // An old den: breakdown and flowstone, a couple of dry rimstone dams, all far older than the bones.
      ceiling(20, 0.7);
      rubble(14, 0.4);
      breakdown(4, 1.3);
      flows(3);
      rimstones(2);
      // Three or four bears lying where they died: skull, spine, ribs and limbs, a little scattered.
      for (let b = 0; b < 4; b++) {
        cavernPoint(c, random, p);
        const at = floorAt(p);
        if (!at) continue;
        const yaw = random() * Math.PI * 2;
        const along = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
        const side = new THREE.Vector3(-along.z, 0, along.x);
        const lie = (pos: THREE.Vector3) => {
          const g = floorAt(pos.clone().add(new THREE.Vector3(0, 0.8, 0)));
          return g ?? pos;
        };
        const skull = lie(at.clone().addScaledVector(along, 0.8));
        placed.push({
          pool: "skull",
          m: compose(skull.add(new THREE.Vector3(0, 0.07, 0)), new THREE.Quaternion().setFromEuler(new THREE.Euler((random() - 0.5) * 0.4, -yaw, (random() - 0.5) * 0.6)), 1, 1, 1)
        });
        for (let v = 0; v < 12; v++) {
          const at2 = lie(
            at
              .clone()
              .addScaledVector(along, 0.55 - v * 0.09)
              .addScaledVector(side, Math.sin(v * 0.5 + b) * 0.06)
          );
          placed.push({
            pool: "bone",
            m: compose(at2.add(new THREE.Vector3(0, 0.03, 0)), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, yaw + random() * 0.3, 0)), 0.55, 0.08, 0.55)
          });
        }
        for (let r = 0; r < 9; r++) {
          const at3 = lie(at.clone().addScaledVector(along, 0.4 - r * 0.07));
          const flop = random() < 0.5 ? 1 : -1;
          placed.push({
            pool: "rib",
            m: compose(
              at3.add(new THREE.Vector3(0, 0.02, 0)),
              new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 + (random() - 0.5) * 0.4, yaw + (flop > 0 ? 0 : Math.PI), random() * 0.6)),
              0.34,
              0.34,
              0.34
            )
          });
        }
        for (let l = 0; l < 6; l++) {
          const at4 = lie(
            at
              .clone()
              .addScaledVector(along, (random() - 0.5) * 1.2)
              .addScaledVector(side, (random() - 0.5) * 1.1)
          );
          placed.push({
            pool: "bone",
            m: compose(
              at4.add(new THREE.Vector3(0, 0.04, 0)),
              new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 + (random() - 0.5) * 0.2, random() * 6.3, 0)),
              1,
              0.32 + random() * 0.18,
              1
            )
          });
        }
      }
      break;
    }
    case "camp": {
      rubble(6, 0.35);
      ceiling(10, 0.4);
      breakdown(2, 0.9);
      rimstones(1);
      rootsDown(3);
      // Their fire in the middle of the floor, still burning low, and the camp round it.
      const at = groundAt(new THREE.Vector3(...c.centre)) ?? floorAt(new THREE.Vector3(...c.centre)) ?? new THREE.Vector3(c.centre[0], c.centre[1] - c.size[1] * 0.5, c.centre[2]);
      const yaw = random() * Math.PI * 2;
      const f = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
      const s = new THREE.Vector3(-f.z, 0, f.x);
      const on = (dx: number, dz: number) =>
        groundAt(
          at
            .clone()
            .addScaledVector(f, dx)
            .addScaledVector(s, dz)
            .add(new THREE.Vector3(0, 0.8, 0))
        ) ?? at.clone();
      const fire = on(0, 0);
      // A ring of stones bedded round it.
      for (let k = 0; k < 11; k++) {
        const a = (k / 11) * Math.PI * 2 + random() * 0.2;
        const stone = on(Math.cos(a) * 0.5, Math.sin(a) * 0.5);
        const size = 0.1 + random() * 0.06;
        placed.push({ pool: "rubble", m: compose(stone.addScaledVector(UP, size * 0.12), new THREE.Quaternion().setFromEuler(new THREE.Euler(random() * 0.6, random() * 6.3, random() * 0.6)), size * 1.2, size * 0.8, size) });
      }
      placed.push({ pool: "embers", m: compose(fire.clone().add(new THREE.Vector3(0, -0.015, 0)), turned(random() * 6.3), 0.42, 1, 0.42) });
      // Four logs leaning in over the coals, each burnt away at its inner end (`fireLog` runs from its outer foot, y = 0,
      // to the end in the fire).
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4 + random() * 0.3;
        const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        const foot = fire.clone().addScaledVector(out, 0.4).add(new THREE.Vector3(0, 0.05, 0));
        const head = fire
          .clone()
          .addScaledVector(out, 0.05)
          .add(new THREE.Vector3(0, 0.2 + random() * 0.06, 0));
        const dir = head.clone().sub(foot);
        const length = dir.length();
        const thick = 0.12 + random() * 0.04;
        placed.push({ pool: "log", m: compose(foot, new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()).multiply(turned(random() * 6.3)), thick, length + 0.06, thick) });
      }
      // Flames: a tall one in the middle, lower ones round it.
      for (let k = 0; k < 5; k++) {
        const a = random() * 6.3;
        const r = k === 0 ? 0 : 0.07 + random() * 0.1;
        const h = k === 0 ? 0.6 : 0.28 + random() * 0.22;
        placed.push({ pool: "fire", m: compose(fire.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.05, Math.sin(a) * r)), turned(random() * 6.3), h * 0.42, h, h * 0.42) });
      }
      // A log dragged up to sit on, lying along the ring a little way out.
      const seat = on(0.15, 1.2);
      const seatLength = 1.1;
      placed.push({
        pool: "log",
        m: compose(seat.addScaledVector(f, -seatLength / 2).add(new THREE.Vector3(0, 0.11, 0)), new THREE.Quaternion().setFromUnitVectors(UP, f).multiply(turned(random() * 6.3)), 0.26, seatLength, 0.26)
      });
      placed.push({
        pool: "bedroll",
        m: compose(on(-1.35, 0.3).add(new THREE.Vector3(0, 0.1, 0)), turned(-yaw + Math.PI / 2).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)), 1, 1, 1)
      });
      const crate = on(1.25, -0.8);
      placed.push({ pool: "crate", m: compose(crate.clone().add(new THREE.Vector3(0, 0.2, 0)), turned(-yaw + 0.3), 1, 1, 1) });
      placed.push({ pool: "crate", m: compose(on(1.55, -0.15).add(new THREE.Vector3(0, 0.17, 0)), turned(-yaw + 1.2), 0.85, 0.85, 0.85) });
      const lantern = crate.clone().add(new THREE.Vector3(0, 0.4, 0));
      placed.push({ pool: "lantern", m: compose(lantern, turned(random() * 6), 1, 1, 1) });
      placed.push({ pool: "flame", m: compose(lantern.clone().add(new THREE.Vector3(0, 0.13, 0)), new THREE.Quaternion(), 0.025, 0.045, 0.025) });
      placed.push({ pool: "hatchet", m: compose(on(0.4, -1.05).add(new THREE.Vector3(0, 0.03, 0)), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, yaw)), 1, 1, 1) });
      placed.push({ pool: "rope", m: compose(on(-0.7, 1.05).add(new THREE.Vector3(0, 0.04, 0)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), 1, 1, 1) });
      glows.push({ p: fire.clone().add(new THREE.Vector3(0, 0.35, 0)), colour: new THREE.Color(1.0, 0.5, 0.18), strength: 2.6, flicker: 0.3 });
      glows.push({ p: lantern.clone().add(new THREE.Vector3(0, 0.15, 0)), colour: new THREE.Color(1.0, 0.62, 0.28), strength: 0.9, flicker: 0.08 });
      return done({ fire: fire.clone().add(new THREE.Vector3(0, 0.2, 0)) });
    }
    case "dino": {
      // A dry, old chamber: a few slabs, little dripstone, and the skeleton across its floor.
      ceiling(14, 0.6);
      rubble(16, 0.45);
      breakdown(3, 1.2);
      flows(2);
      milk(2);
      rootsDown(3);
      // Lying belly down along the chamber's length, half sunk in the floor: the tail running into the rock, the ribs
      // arching out of the stone, the neck bent round to the skull lying on its side.
      const yaw = (random() < 0.5 ? 0 : Math.PI) + (random() - 0.5) * 0.5;
      const t = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
      const side = new THREE.Vector3().crossVectors(t, UP);
      const length = Math.min(c.size[0] * 1.5, 7.6);
      const mid = new THREE.Vector3(...c.centre);
      const base = c.centre[1] + (c.floor ?? -c.size[1] * 0.6);
      const phase = random() * 6.3;
      const probe2 = new THREE.Vector3();
      // The spine's line, from the tail's tip (0) to the back of the skull (1), and its height over the real floor.
      const lift = (s: number) => (s < 0.38 ? 0.02 + (s / 0.38) * 0.4 : s < 0.78 ? 0.42 : 0.42 - (s - 0.78) * 1.2);
      const spineAt = (s: number, out: THREE.Vector3) => {
        const u = (s - 0.5) * length;
        const curl = Math.sin(s * Math.PI * 1.4 + phase) * 0.35 * (1 - s) + (s > 0.8 ? Math.sin((s - 0.8) * 9) * 0.3 : 0);
        out.copy(mid).addScaledVector(t, u).addScaledVector(side, curl);
        const ground = groundAt(probe2.set(out.x, mid.y, out.z));
        out.y = (ground ? Math.max(ground.y, base - 0.2) : base) + lift(s);
        return out;
      };
      const dia = (s: number) => (s < 0.38 ? 0.05 + 0.14 * Math.pow(s / 0.38, 0.8) : s < 0.78 ? 0.19 : 0.19 - (s - 0.78) * 0.4);
      const COUNT = 58;
      const spacing = length / (COUNT - 1);
      const here = new THREE.Vector3();
      const ahead = new THREE.Vector3();
      const ax = new THREE.Vector3();
      const ay = new THREE.Vector3();
      const az = new THREE.Vector3();
      const basis = new THREE.Matrix4();
      const frame = (x: THREE.Vector3, y: THREE.Vector3) => {
        // A right-handed frame from x and something near y.
        ax.copy(x).normalize();
        az.crossVectors(ax, y).normalize();
        ay.crossVectors(az, ax);
        return new THREE.Quaternion().setFromRotationMatrix(basis.makeBasis(ax, ay, az));
      };
      for (let k = 0; k < COUNT; k++) {
        const s = k / (COUNT - 1);
        spineAt(s, here);
        spineAt(Math.min(1, s + 0.01), ahead);
        if (s >= 1) ahead.copy(here).add(t);
        const along = ahead.clone().sub(here);
        const d = dia(s);
        const body = s > 0.38 && s < 0.78 ? Math.sin(((s - 0.38) / 0.4) * Math.PI) : 0;
        placed.push({ pool: "dinoVert", m: compose(here, frame(along, UP), (spacing * 1.02) / 0.88, (d / 1.04) * (1 + body * 0.9), d / 1.04) });
        // Ribs from the chest, a pair at every other vertebra, sweeping back and down into the stone.
        if (s > 0.42 && s < 0.77 && k % 2 === 0) {
          const len = 0.5 + 0.6 * Math.sin(((s - 0.42) / 0.35) * Math.PI);
          for (const sign of [1, -1]) {
            const out = side.clone().multiplyScalar(sign * Math.cos(0.3)).addScaledVector(along.clone().normalize(), -Math.sin(0.3));
            // The rib's +z out to its side, +y up: x = y × z.
            const x = new THREE.Vector3().crossVectors(UP, out).normalize();
            const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, UP, out.normalize()));
            placed.push({ pool: "dinoRib", m: compose(here.clone().addScaledVector(UP, -d * 0.25), q, len, len, len) });
          }
        }
        // Legs at the hips and arms at the shoulders: upper and lower bones splayed out and down into the floor.
        if (k === Math.round(0.4 * (COUNT - 1)) || k === Math.round(0.74 * (COUNT - 1))) {
          const hind = s < 0.6;
          for (const sign of [1, -1]) {
            const hip = here
              .clone()
              .addScaledVector(side, sign * d * 0.7)
              .addScaledVector(UP, -d * 0.3);
            const upper = side
              .clone()
              .multiplyScalar(sign * 0.65)
              .addScaledVector(UP, -0.65)
              .addScaledVector(t, hind ? 0.3 : 0.2)
              .normalize();
            const one = hind ? 1.0 : 0.42;
            placed.push({ pool: "limb", m: compose(hip, new THREE.Quaternion().setFromUnitVectors(UP, upper), one * 0.24, one, one * 0.24) });
            const knee = hip.clone().addScaledVector(upper, one * 0.95);
            const lower = t
              .clone()
              .multiplyScalar(hind ? -0.55 : 0.5)
              .addScaledVector(side, sign * 0.4)
              .addScaledVector(UP, -0.35)
              .normalize();
            placed.push({ pool: "limb", m: compose(knee, new THREE.Quaternion().setFromUnitVectors(UP, lower), one * 0.2, one * 0.85, one * 0.2) });
          }
          // The hips' blades, down into the floor either side of the spine.
          if (hind)
            for (const sign of [1, -1])
              placed.push({
                pool: "limb",
                m: compose(here.clone().addScaledVector(side, sign * 0.08), new THREE.Quaternion().setFromUnitVectors(UP, side.clone().multiplyScalar(sign * 0.3).addScaledVector(UP, -0.8).addScaledVector(t, 0.5).normalize()), 0.32, 0.7, 0.32)
              });
        }
      }
      // The skull at the end of the neck, fallen on its side, its jaw bedded in the floor.
      spineAt(1, here);
      const skullLength = length * 0.15;
      const k = skullLength / 1.13;
      const head = here.clone().addScaledVector(t, skullLength * 0.5);
      const headGround = groundAt(probe2.set(head.x, mid.y, head.z));
      head.y = (headGround ? headGround.y : base) + k * 0.2;
      const tilt = frame(t.clone().addScaledVector(UP, -0.08), UP).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.55 + random() * 0.3));
      placed.push({ pool: "dinoSkull", m: compose(head, tilt, k, k, k) });
      // The rock it lies in: low slabs of the old bed under the body, so the bones come out of stone rather than lie on
      // the floor.
      for (const s of [0.3, 0.5, 0.66]) {
        spineAt(s, here);
        const ground = groundAt(probe2.set(here.x, mid.y, here.z));
        if (!ground) continue;
        placed.push({ pool: s === 0.5 ? "breakdown0" : "breakdown1", m: compose(ground.addScaledVector(UP, -0.12), frame(t, UP).multiply(turned(random() * 0.4 - 0.2)), 1.6, 0.42, 1.1) });
      }
      // Someone was digging it out: a lantern on a crate by the skull, the only light in the chamber.
      let crate: THREE.Vector3 | null = null;
      for (const [across, back] of [
        [1.1, 0],
        [-1.1, 0],
        [0.8, -0.8],
        [-0.8, -0.8],
        [0.7, 0.5]
      ]) {
        crate ??= groundAt(
          head
            .clone()
            .addScaledVector(side, across)
            .addScaledVector(t, back)
            .add(new THREE.Vector3(0, 0.8, 0))
        );
        // (With room for the crate: rock no nearer than half a metre round it.)
        if (crate && solid.sample(crate.x, crate.y + 0.3, crate.z) > -0.45) crate = null;
      }
      if (crate) {
        placed.push({ pool: "crate", m: compose(crate.clone().add(new THREE.Vector3(0, 0.2, 0)), turned(yaw + 0.4), 1, 1, 1) });
        const lantern = crate.clone().add(new THREE.Vector3(0, 0.4, 0));
        placed.push({ pool: "lantern", m: compose(lantern, turned(random() * 6), 1, 1, 1) });
        placed.push({ pool: "flame", m: compose(lantern.clone().add(new THREE.Vector3(0, 0.13, 0)), new THREE.Quaternion(), 0.025, 0.045, 0.025) });
        glows.push({ p: lantern.clone().add(new THREE.Vector3(0, 0.15, 0)), colour: new THREE.Color(1.0, 0.64, 0.3), strength: 1.3, flicker: 0.08 });
      }
      glows.push({ p: mid.clone().add(new THREE.Vector3(0, c.size[1] * 0.3, 0)), colour: new THREE.Color(0.75, 0.68, 0.58), strength: 0.25 });
      break;
    }
    case "ammonites": {
      // A bedding plane full of them, weathered out of the walls: a few as big as cartwheels at eye height, trilobites
      // among them; slabs fallen off the walls below.
      ceiling(16, 0.7);
      rubble(14, 0.4);
      breakdown(4, 1.1);
      milk(2);
      flows(2);
      const spots: { at: THREE.Vector3; size: number }[] = [];
      const from = new THREE.Vector3();
      const dir = new THREE.Vector3();
      const wall = (count: number, piece: PoolName, smallest: number, largest: number, sink: number) => {
        for (let k = 0, made = 0; k < count * 12 && made < count; k++) {
          const a = random() * Math.PI * 2;
          from.set(c.centre[0], c.centre[1] + (c.floor ?? 0) + 0.8 + random() * 1.6, c.centre[2]);
          dir.set(Math.cos(a), (random() - 0.5) * 0.3, Math.sin(a)).normalize();
          const at = hit(solid, from, dir, Math.max(...c.size) * 2, n);
          if (!at || Math.abs(n.y) > 0.45) continue;
          const size = smallest + Math.pow(random(), 1.5) * (largest - smallest);
          if (spots.some((o) => o.at.distanceTo(at) < (o.size + size) * 0.55)) continue;
          made++;
          spots.push({ at: at.clone(), size });
          placed.push({ pool: piece, m: compose(at.addScaledVector(n, -size * sink), new THREE.Quaternion().setFromUnitVectors(UP, n).multiply(turned(random() * 6.3)), size, size * (0.75 + random() * 0.25), size) });
        }
      };
      wall(5, "ammonite", 0.9, 1.7, 0.1);
      wall(5, "trilobite", 0.2, 0.4, 0.02);
      glows.push({ p: new THREE.Vector3(c.centre[0], c.centre[1] + c.size[1] * 0.2, c.centre[2]), colour: new THREE.Color(0.78, 0.74, 0.66), strength: 0.3 });
      break;
    }
    case "pool": {
      // Still water in a basin of the floor (field.ts `basin`), clear and blue-green, lit from within; quartz grown round
      // its rim and on its bed; dripstone over it, the drips feeding it.
      ceiling(30, 0.9);
      rimstones(2);
      flows(3);
      milk(2);
      breakdown(2, 0.9);
      const level = c.centre[1] + (c.floor ?? 0) - POOL_WATER;
      const centre = new THREE.Vector3(c.centre[0], level, c.centre[2]);
      const sheet = pool(field, rock, centre, level, 32, 1.4);
      // Quartz in clusters: round the rim, where the water stood longest, and a few under water and on the walls.
      // (Each crystal's foot found again on the real rock, a little way across the surface from the cluster's middle.)
      const across = new THREE.Vector3();
      const other = new THREE.Vector3();
      const back = new THREE.Vector3();
      const surface = new THREE.Vector3();
      const cluster = (at: THREE.Vector3, normal: THREE.Vector3, count: number, big: number) => {
        across.crossVectors(normal, Math.abs(normal.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0)).normalize();
        other.crossVectors(normal, across);
        back.copy(normal).negate();
        for (let k = 0; k < count; k++) {
          const lean = new THREE.Vector3((random() - 0.5) * 1.1, 0, (random() - 0.5) * 1.1).add(normal).normalize();
          const size = big * (0.35 + Math.pow(random(), 1.6) * 0.65);
          const from = at
            .clone()
            .addScaledVector(across, (random() - 0.5) * big * 0.8)
            .addScaledVector(other, (random() - 0.5) * big * 0.8)
            .addScaledVector(normal, 0.3);
          const foot = hit(solid, from, back, 0.8, surface);
          if (!foot) continue;
          placed.push({ pool: "quartz", m: compose(foot.addScaledVector(surface, -size * 0.22), new THREE.Quaternion().setFromUnitVectors(UP, lean).multiply(turned(random() * 6.3)), size * 0.16, size, size * 0.16) });
        }
      };
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2 + random() * 0.3;
        // Out along the floor to where the basin's rim stands just above the water.
        const r = 0.6 + random() * 0.15;
        const at = groundAt(new THREE.Vector3(c.centre[0] + Math.cos(a) * c.size[0] * r, c.centre[1], c.centre[2] + Math.sin(a) * c.size[2] * r));
        if (!at || at.y < level - 0.05) continue;
        cluster(at, n.clone(), 3 + Math.floor(random() * 3), 0.3 + random() * 0.35);
      }
      for (let k = 0; k < 5; k++) {
        const a = random() * Math.PI * 2;
        const r = Math.sqrt(random()) * 0.45;
        const at = floorAt(new THREE.Vector3(c.centre[0] + Math.cos(a) * c.size[0] * r, level - 0.05, c.centre[2] + Math.sin(a) * c.size[2] * r));
        if (at) cluster(at, UP, 3, 0.25);
      }
      for (let k = 0; k < 4; k++) {
        const a = random() * Math.PI * 2;
        const at = hit(solid, new THREE.Vector3(c.centre[0], level + 0.6 + random() * 1.2, c.centre[2]), new THREE.Vector3(Math.cos(a), 0.2, Math.sin(a)).normalize(), Math.max(...c.size) * 2, n);
        if (at && Math.abs(n.y) < 0.6) cluster(at, n.clone(), 4, 0.3);
      }
      glows.push({ p: centre.clone().add(new THREE.Vector3(0, 0.25, 0)), colour: new THREE.Color(0.3, 0.85, 0.85), strength: 0.7 });
      return done({ pond: { level, sheet } });
    }
    case "temple": {
      // Roots through the roof over the doorway, and slabs come down from it.
      rubble(18, 0.5);
      ceiling(14, 0.5);
      breakdown(4, 1.2);
      rootsDown(6);
      milk(2);
      // A doorway carved into the wall the chamber's far side, with its steps.
      const yaw = random() * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
      const wall = hit(field, new THREE.Vector3(...c.centre), dir, Math.max(...c.size) * 2, n);
      if (wall) {
        const floor = floorAt(wall.clone().addScaledVector(dir, -1.2)) ?? wall;
        const face = Math.atan2(-dir.x, -dir.z);
        const base = new THREE.Vector3(wall.x, floor.y, wall.z).addScaledVector(dir, -0.2);
        const side = new THREE.Vector3(-dir.z, 0, dir.x);
        const q2 = turned(face);
        // Pillars, lintel, the sealed door between, and three steps up to it.
        for (const sgn of [-1, 1])
          placed.push({
            pool: "block",
            m: compose(
              base
                .clone()
                .addScaledVector(side, sgn * 1.05)
                .add(new THREE.Vector3(0, 1.4, 0)),
              q2,
              0.45,
              2.8,
              0.5
            ),
            tint: 0
          });
        placed.push({ pool: "block", m: compose(base.clone().add(new THREE.Vector3(0, 2.95, 0)), q2, 2.9, 0.5, 0.6), tint: 0.2 });
        placed.push({
          pool: "block",
          m: compose(
            base
              .clone()
              .addScaledVector(dir, 0.18)
              .add(new THREE.Vector3(0, 1.35, 0)),
            q2,
            1.65,
            2.7,
            0.2
          ),
          tint: 1
        });
        for (let st = 0; st < 3; st++)
          placed.push({
            pool: "block",
            m: compose(
              base
                .clone()
                .addScaledVector(dir, -0.45 - st * 0.35)
                .add(new THREE.Vector3(0, 0.1 - st * 0.12, 0)),
              q2,
              2.6 + st * 0.3,
              0.22,
              0.5
            ),
            tint: 0.5
          });
        glows.push({
          p: base
            .clone()
            .addScaledVector(dir, -1)
            .add(new THREE.Vector3(0, 1.6, 0)),
          colour: new THREE.Color(0.8, 0.6, 0.4),
          strength: 0.2
        });
      }
      break;
    }
    case "lava": {
      rubble(16, 0.5);
      breakdown(4, 1.3);
      const level = c.centre[1] + (c.floor ?? 0) + 0.15;
      for (let k = 0; k < 4; k++) glows.push({ p: new THREE.Vector3(c.centre[0] + (k - 1.5) * c.size[0] * 0.45, level + 0.4, c.centre[2]), colour: new THREE.Color(1.0, 0.35, 0.08), strength: 2.2 });
      // Molten rock pooled in the fissure's floor, out to its own walls (it was a slab 2.4 times the fissure's size).
      return done({ lava: { level, sheet: pool(field, rock, new THREE.Vector3(c.centre[0], level, c.centre[2]), level, 24, 0.3) } });
    }
    default:
      break;
  }
  return done();
}


// ---- Across to the page ---------------------------------------------------------------------------------------------

// The dressing as flat arrays, to post from the worker: each piece's pool and matrix, each light, each sheet's quads
// (four corners of position and data), the fall, the puddles' level and spread, the fire.
export type Packed = {
  pools: Uint8Array;
  matrices: Float32Array;
  glows: Float32Array;
  water?: { level: number; sheet: Float32Array; fall?: number[] };
  lava?: { level: number; sheet: Float32Array };
  pond?: { level: number; sheet: Float32Array };
  still?: number[];
  fire?: number[];
};

function packSheet(sheet: Sheet) {
  const out = new Float32Array(sheet.length * 28);
  sheet.forEach((quad, q) => {
    for (let k = 0; k < 4; k++) {
      quad.corners[k].toArray(out, q * 28 + k * 7);
      out.set(quad.data[k], q * 28 + k * 7 + 3);
    }
  });
  return out;
}
function unpackSheet(data: Float32Array): Sheet {
  const sheet: Sheet = [];
  for (let q = 0; q < data.length / 28; q++) {
    const corners: THREE.Vector3[] = [];
    const values: number[][] = [];
    for (let k = 0; k < 4; k++) {
      corners.push(new THREE.Vector3().fromArray(data, q * 28 + k * 7));
      values.push(Array.from(data.subarray(q * 28 + k * 7 + 3, q * 28 + k * 7 + 7)));
    }
    sheet.push({ corners, data: values });
  }
  return sheet;
}

export function pack(made: Made): { packed: Packed; transfer: ArrayBuffer[] } {
  const pools = new Uint8Array(made.placed.length);
  const matrices = new Float32Array(made.placed.length * 16);
  made.placed.forEach((piece, k) => {
    pools[k] = POOLS.indexOf(piece.pool);
    matrices.set(piece.m.elements, k * 16);
  });
  const glows = new Float32Array(made.glows.length * 8);
  made.glows.forEach((g, k) => glows.set([g.p.x, g.p.y, g.p.z, g.colour.r, g.colour.g, g.colour.b, g.strength, g.flicker ?? 0], k * 8));
  const fall = made.water?.fall;
  const packed: Packed = {
    pools,
    matrices,
    glows,
    water: made.water && {
      level: made.water.level,
      sheet: packSheet(made.water.sheet),
      fall: fall && [...fall.foot.toArray(), ...fall.lip.toArray(), ...fall.turn.toArray(), fall.width, fall.height, fall.wet ? 1 : 0]
    },
    lava: made.lava && { level: made.lava.level, sheet: packSheet(made.lava.sheet) },
    pond: made.pond && { level: made.pond.level, sheet: packSheet(made.pond.sheet) },
    still: made.still && [made.still.level, ...made.still.spread.center.toArray(), made.still.spread.radius],
    fire: made.fire?.toArray()
  };
  const transfer = [pools.buffer, matrices.buffer, glows.buffer] as ArrayBuffer[];
  for (const s of [packed.water, packed.lava, packed.pond]) if (s) transfer.push(s.sheet.buffer as ArrayBuffer);
  return { packed, transfer };
}

export function unpack(packed: Packed): Made {
  const placed: Placed[] = [];
  for (let k = 0; k < packed.pools.length; k++) placed.push({ pool: POOLS[packed.pools[k]], m: new THREE.Matrix4().fromArray(packed.matrices, k * 16) });
  const glows: Glow[] = [];
  const g = packed.glows;
  for (let k = 0; k < g.length / 8; k++) glows.push({ p: new THREE.Vector3(g[k * 8], g[k * 8 + 1], g[k * 8 + 2]), colour: new THREE.Color(g[k * 8 + 3], g[k * 8 + 4], g[k * 8 + 5]), strength: g[k * 8 + 6], flicker: g[k * 8 + 7] });
  const f = packed.water?.fall;
  return {
    placed,
    glows,
    water: packed.water && {
      level: packed.water.level,
      sheet: unpackSheet(packed.water.sheet),
      fall: f && { foot: new THREE.Vector3(f[0], f[1], f[2]), lip: new THREE.Vector3(f[3], f[4], f[5]), turn: new THREE.Quaternion(f[6], f[7], f[8], f[9]), width: f[10], height: f[11], wet: f[12] > 0 }
    },
    lava: packed.lava && { level: packed.lava.level, sheet: unpackSheet(packed.lava.sheet) },
    pond: packed.pond && { level: packed.pond.level, sheet: unpackSheet(packed.pond.sheet) },
    still: packed.still && { level: packed.still[0], spread: new THREE.Sphere(new THREE.Vector3(packed.still[1], packed.still[2], packed.still[3]), packed.still[4]) },
    fire: packed.fire && new THREE.Vector3().fromArray(packed.fire)
  };
}
