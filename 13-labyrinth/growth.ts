import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  abs,
  atan,
  attribute,
  cameraPosition,
  color,
  cos,
  dot,
  float,
  fract,
  length,
  max,
  mix,
  normalGeometry,
  normalView,
  normalWorld,
  normalize,
  output,
  positionGeometry,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  time,
  uv,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { mulberry32 } from "../shared/engine/random";
import { walkAmount } from "../shared/engine/walk";
import { type Air, bumped, fading, HEIGHT, leafGreen, made, placement, shape, swellAt, throughMist } from "./hedge-look";
import { fractal2, noise3 } from "./hedge-noise";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What grows on and around the hedges, made once in a hedge's own frame and drawn with the same instances as the hedges
// near the camera: loose leaves standing out of the clipped surface, new shoots, ivy, bindweed, bramble and clematis
// climbing over it, grass at its foot and leaves it has dropped, and stones along its edge. Every piece belongs to a
// group with a chance of showing, and each hedge rolls its own dice, so no two hedges carry quite the same.

// The kinds of card, each cut to its own shape.
const BOX = 0;
const IVY = 1;
const BINDWEED = 2;
const TRUMPET = 3;
const BRAMBLE = 4;
const CLEMATIS = 5;
const STEM = 6;
const GRASS = 7;
const FALLEN = 8;
const UMBEL = 9;
const BELL = 10;

type V = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

class Cards {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  roots: number[] = [];
  surfaces: number[] = [];
  kinds: number[] = [];
  groups: number[] = [];
  index: number[] = [];
  group = [0, 1];

  // One card: hung from `root` on a surface facing `surface`, centred on `base` (the stalk end), reaching `length` along
  // `up` and `width` along `side`, facing `face`, cupped by `cup`.
  add(kind: number, root: V, surface: V, base: V, up: V, side: V, face: V, length: number, width: number, cup = 0.5, seed = Math.random()) {
    const first = this.positions.length / 3;
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ]) {
      const p = base.clone().addScaledVector(side, (u - 0.5) * width).addScaledVector(up, v * length);
      this.positions.push(p.x, p.y, p.z);
      const n = face.clone().addScaledVector(side, (u - 0.5) * 2 * cup).normalize();
      this.normals.push(n.x, n.y, n.z);
      this.uvs.push(u, v);
      this.roots.push(root.x, root.y, root.z);
      this.surfaces.push(surface.x, surface.y, surface.z);
      this.kinds.push(kind, seed);
      this.groups.push(this.group[0], this.group[1]);
    }
    this.index.push(first, first + 1, first + 2, first + 2, first + 1, first + 3);
  }

  geometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute("aRoot", new THREE.Float32BufferAttribute(this.roots, 3));
    geometry.setAttribute("aSurface", new THREE.Float32BufferAttribute(this.surfaces, 3));
    geometry.setAttribute("aKind", new THREE.Float32BufferAttribute(this.kinds, 2));
    geometry.setAttribute("aGroup", new THREE.Float32BufferAttribute(this.groups, 2));
    geometry.setIndex(this.index);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

// A point on a hedge's surface: `side` picks the face (+z, -z, +x, -x), `along` runs across it, and `climb` goes up the
// face from the ground, round the clipped top edge and in across the top, so that every face can be walked as one strip.
const ROUND = 0.16;
type Spot = { at: V; normal: V; up: V };
function surfaceSpot(ax: number, az: number, side: number, along: number, climb: number): Spot {
  const out = [v3(0, 0, 1), v3(0, 0, -1), v3(1, 0, 0), v3(-1, 0, 0)][side];
  const across = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, -1), v3(0, 0, 1)][side];
  const half = side < 2 ? az : ax;
  const wall = HEIGHT - ROUND;
  const arc = (ROUND * Math.PI) / 2;
  if (climb <= wall) return { at: out.clone().multiplyScalar(half).addScaledVector(across, along).setY(climb), normal: out, up: v3(0, 1, 0) };
  if (climb <= wall + arc) {
    const theta = (climb - wall) / ROUND;
    const at = out
      .clone()
      .multiplyScalar(half - ROUND * (1 - Math.cos(theta)))
      .addScaledVector(across, along)
      .setY(wall + ROUND * Math.sin(theta));
    const normal = out.clone().multiplyScalar(Math.cos(theta)).setY(Math.sin(theta));
    return { at, normal, up: out.clone().multiplyScalar(-Math.sin(theta)).setY(Math.cos(theta)) };
  }
  const inward = Math.min(climb - wall - arc + ROUND, half);
  return { at: out.clone().multiplyScalar(half - inward).addScaledVector(across, along).setY(HEIGHT), normal: v3(0, 1, 0), up: out.clone().negate() };
}
const climbOf = (ax: number, az: number, side: number) => HEIGHT - ROUND + (ROUND * Math.PI) / 2 + (side < 2 ? az : ax) - ROUND;

// A random direction across a surface, leaning toward `toward` by `lean`.
function across(normal: V, toward: V, lean: number, random: () => number) {
  const t = v3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(2).addScaledVector(toward, lean);
  return t.addScaledVector(normal, -t.dot(normal)).normalize();
}

// The loose leaves standing proud of a hedge, `count` per square metre, fewer low down where little light reaches. For
// walls, only the long faces and top: their ends are buried in posts.
export function leafGeometry(x: number, z: number, perMetre: number, ends: boolean, seed: number) {
  const random = mulberry32(seed);
  const cards = new Cards();
  const ax = x / 2;
  const az = z / 2;
  for (let side = 0; side < (ends ? 4 : 2); side++) {
    const span = (side < 2 ? ax : az) - 0.1;
    const climb = climbOf(ax, az, side);
    const count = Math.round(perMetre * span * 2 * climb);
    for (let i = 0; i < count; i++) {
      const c = Math.pow(random(), 0.75) * climb;
      // Thinner toward the ground.
      if (c < 0.9 && random() > 0.35 + c * 0.7) continue;
      const spot = surfaceSpot(ax, az, side, (random() * 2 - 1) * span, c);
      cards.group = [Math.floor(random() * 8), 0.8];
      const up = across(spot.normal, spot.up, 1.3, random);
      const lift = 0.004 + Math.pow(random(), 2) * 0.03;
      const face = spot.normal.clone().addScaledVector(up, -0.3 - random() * 0.4).add(v3(random() - 0.5, random() - 0.2, random() - 0.5).multiplyScalar(0.9)).normalize();
      const side2 = new THREE.Vector3().crossVectors(face, up).normalize();
      const leafUp = new THREE.Vector3().crossVectors(side2, face).normalize();
      const length = 0.022 + random() * 0.02;
      const base = spot.at.clone().addScaledVector(spot.normal, lift).addScaledVector(leafUp, -length * 0.3);
      cards.add(BOX, spot.at, spot.normal, base, leafUp, side2, face, length, length * (0.5 + random() * 0.15), 0.55, random());
    }
  }
  return cards.geometry();
}

// A stem wandering across a surface from a spot, as a run of thin cards, with something hung from it every so often.
// It stops where it would leave the hedge, past an end, off the top or into the ground.
function stem(cards: Cards, box: [number, number], start: Spot, steps: number, step: number, heading: V, wander: number, width: number, random: () => number, hang: (spot: Spot, along: V, i: number) => void) {
  let at = start.at.clone();
  let normal = start.normal.clone();
  let dir = heading.clone().addScaledVector(normal, -heading.dot(normal)).normalize();
  for (let i = 0; i < steps; i++) {
    dir = across(normal, dir, 2.2 / Math.max(wander, 0.05), random);
    const next = at.clone().addScaledVector(dir, step);
    if (Math.abs(next.x) > box[0] + 0.01 || Math.abs(next.z) > box[1] + 0.01 || next.y < 0.03) break;
    const side = new THREE.Vector3().crossVectors(normal, dir).normalize();
    cards.add(STEM, at, normal, at.clone().addScaledVector(normal, 0.006), dir, side, normal, step * 1.15, width * (1 - (i / steps) * 0.5), 0.9, random());
    hang({ at: next, normal, up: dir }, dir, i);
    at = next;
    // Over the top edge, the stem bends with the hedge.
    if (at.y > HEIGHT - 0.04 && normal.y < 0.5) {
      at.y = HEIGHT + 0.004;
      at.addScaledVector(normal, -0.08);
      normal = v3(0, 1, 0);
      dir = dir.setY(0).lengthSq() > 0.001 ? dir.setY(0).normalize() : v3(1, 0, 0);
    }
  }
}

// A leaf on a short stalk off a stem, facing out from the surface.
function leafOff(cards: Cards, kind: number, spot: Spot, along: V, size: number, random: () => number) {
  const outward = across(spot.normal, along, 0.3, random);
  const up = outward
    .clone()
    .addScaledVector(spot.normal, 0.3 + random() * 0.5)
    .normalize();
  const face = spot.normal
    .clone()
    .addScaledVector(up, -0.4)
    .add(v3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(0.5))
    .normalize();
  const side = new THREE.Vector3().crossVectors(face, up).normalize();
  const leafUp = new THREE.Vector3().crossVectors(side, face).normalize();
  cards.add(kind, spot.at, spot.normal, spot.at.clone().addScaledVector(spot.normal, 0.01 + random() * 0.015), leafUp, side, face, size, size * (kind === BINDWEED ? 0.8 : 1), 0.4, random());
}

function flower(cards: Cards, kind: number, spot: Spot, size: number, random: () => number) {
  const face = spot.normal
    .clone()
    .add(v3(random() - 0.5, random() * 0.6, random() - 0.5).multiplyScalar(0.8))
    .normalize();
  const side = across(face, v3(1, 0, 0), 0, random);
  const up = new THREE.Vector3().crossVectors(side, face).normalize();
  const base = spot.at.clone().addScaledVector(spot.normal, 0.02 + random() * 0.02).addScaledVector(up, -size / 2);
  cards.add(kind, spot.at, spot.normal, base, up, side, face, size, size, 0.2, random());
}

// A shoot grown long since the last clipping: a whippy stem out of the surface with its leaves in pairs, bending over
// under their weight as it goes.
function shoot(cards: Cards, root: V, surface: V, heading: V, steps: number, random: () => number) {
  let dir = heading.clone().normalize();
  let at = root.clone();
  for (let i = 0; i < steps; i++) {
    dir = dir
      .clone()
      .add(v3((random() - 0.5) * 0.3, -0.05 * i, (random() - 0.5) * 0.3))
      .normalize();
    const next = at.clone().addScaledVector(dir, 0.05);
    const sideways = across(dir, v3(random() - 0.5, 0, random() - 0.5), 0, random);
    cards.add(STEM, root, surface, at, dir, sideways, new THREE.Vector3().crossVectors(sideways, dir).normalize(), 0.055, 0.004, 0.9, random());
    for (const flip of [-1, 1]) {
      const out = sideways.clone().multiplyScalar(flip).addScaledVector(dir, 0.5).normalize();
      const face = new THREE.Vector3()
        .crossVectors(out, sideways)
        .multiplyScalar(flip)
        .add(v3(0, 0.6, 0))
        .normalize();
      const side2 = new THREE.Vector3().crossVectors(face, out).normalize();
      const size = 0.02 + random() * 0.012 + i * 0.002;
      cards.add(BOX, root, surface, next, out, side2, face, size, size * 0.55, 0.5, 0.95 + random() * 0.05);
    }
    at = next;
  }
}

// A wild flower at the foot of a hedge, standing in front of it: cow parsley with its flat white heads, or a foxglove
// with a spike of hanging pink bells. Each with a rosette of leaves at its foot.
function wildflower(cards: Cards, foot: V, out: V, foxglove: boolean, random: () => number) {
  const tall = foxglove ? 0.7 + random() * 0.5 : 0.5 + random() * 0.45;
  let dir = out
    .clone()
    .multiplyScalar(0.15 + random() * 0.15)
    .add(v3((random() - 0.5) * 0.2, 1, (random() - 0.5) * 0.2))
    .normalize();
  let at = foot.clone();
  const steps = Math.round(tall / 0.07);
  for (let i = 0; i < steps; i++) {
    dir = dir.clone().add(v3((random() - 0.5) * 0.06, 0, (random() - 0.5) * 0.06)).normalize();
    const next = at.clone().addScaledVector(dir, 0.07);
    const sideways = across(dir, v3(random() - 0.5, 0, random() - 0.5), 0, random);
    cards.add(STEM, foot, v3(), at, dir, sideways, new THREE.Vector3().crossVectors(sideways, dir).normalize(), 0.075, foxglove ? 0.009 : 0.006, 0.9, random());
    // Bells hang all round the top half of a foxglove, smaller toward the tip.
    if (foxglove && i > steps * 0.45) {
      for (let b = 0; b < 2; b++) {
        const round = across(dir, v3(random() - 0.5, 0, random() - 0.5), 0, random);
        const hang = round.clone().multiplyScalar(0.8).add(v3(0, -0.6, 0)).normalize();
        const face = new THREE.Vector3().crossVectors(hang, new THREE.Vector3().crossVectors(dir, hang)).normalize();
        const side = new THREE.Vector3().crossVectors(face, hang).normalize();
        const size = 0.06 * (1.2 - (i / steps) * 0.6);
        // Two cards crossed, so a bell has some body from any side.
        const own = random();
        cards.add(BELL, foot, v3(), next.clone().addScaledVector(round, 0.008), hang, side, face, size, size * 0.8, 0.6, own);
        cards.add(BELL, foot, v3(), next.clone().addScaledVector(round, 0.008), hang, face, side, size, size * 0.8, 0.6, own);
      }
    }
    at = next;
  }
  if (!foxglove) {
    // A flat head of tiny white flowers, and a smaller one or two lower down.
    for (let h = 0; h < 1 + Math.floor(random() * 3); h++) {
      const size = h ? 0.06 + random() * 0.03 : 0.1 + random() * 0.04;
      const head = at.clone().add(v3((random() - 0.5) * 0.12 * h, -0.1 * h, (random() - 0.5) * 0.12 * h));
      const face = v3((random() - 0.5) * 0.4, 1, (random() - 0.5) * 0.4).normalize();
      const side = across(face, v3(1, 0, 0), 0, random);
      const up = new THREE.Vector3().crossVectors(side, face).normalize();
      cards.add(UMBEL, foot, v3(), head.clone().addScaledVector(up, -size / 2), up, side, face, size, size, 0.1, random());
    }
  }
  for (let l = 0; l < 5 + random() * 4; l++) {
    const lean = v3(random() - 0.5, 0.35 + random() * 0.4, random() - 0.5).normalize();
    const face = across(lean, v3(0, 1, 0), 0.8, random).add(v3(0, 0.5, 0)).normalize();
    const side = new THREE.Vector3().crossVectors(face, lean).normalize();
    const size = foxglove ? 0.12 + random() * 0.08 : 0.08 + random() * 0.06;
    cards.add(foxglove ? BOX : IVY, foot, v3(), foot.clone().add(v3(0, 0.01, 0)), lean, side, face, size, size * (foxglove ? 0.45 : 0.9), 0.5, random() * 0.9);
  }
}

// Everything that grows on a hedge besides its own leaves. `ends` again for posts, whose every face can show.
export function growthGeometry(x: number, z: number, ends: boolean, seed: number) {
  const random = mulberry32(seed);
  const cards = new Cards();
  const ax = x / 2;
  const az = z / 2;
  const faces = ends ? 4 : 2;
  const spanOf = (side: number) => (side < 2 ? ax : az) - 0.08;
  let group = 8;

  for (let side = 0; side < faces; side++) {
    const span = spanOf(side);

    // Ivy up the face from the ground, a few stems from one root, some reaching the top and creeping over it.
    cards.group = [group++, ends ? 0.2 : 0.42];
    const ivyFrom = (random() * 2 - 1) * span * 0.6;
    for (let s = 0; s < (ends ? 3 : 6); s++) {
      const start = surfaceSpot(ax, az, side, ivyFrom + (random() - 0.5) * 0.3, 0.02);
      stem(cards, [ax, az], start, 14 + Math.floor(random() * 22), 0.07, v3(random() - 0.5, 1, random() - 0.5), 0.6, 0.008, random, (spot, along, i) => {
        if (i % 2 === 0 || random() < 0.4) leafOff(cards, IVY, spot, along, 0.045 + random() * 0.035, random);
      });
    }

    // Bindweed twining up from the foot, with white trumpets where it reaches the light.
    cards.group = [group++, 0.3];
    for (let s = 0; s < 4; s++) {
      const start = surfaceSpot(ax, az, side, (random() * 2 - 1) * span * 0.8, 0.02 + random() * 0.5);
      stem(cards, [ax, az], start, 16 + Math.floor(random() * 18), 0.065, v3(random() - 0.5, 1, random() - 0.5), 0.9, 0.005, random, (spot, along, i) => {
        if (i % 3 === 1) leafOff(cards, BINDWEED, spot, along, 0.04 + random() * 0.025, random);
        if (spot.at.y > 1.2 && random() < 0.07) flower(cards, TRUMPET, spot, 0.05 + random() * 0.02, random);
      });
    }

    // Bramble arching out of the side, with pale pink flowers.
    cards.group = [group++, ends ? 0.06 : 0.16];
    for (let s = 0; s < 3; s++) {
      const start = surfaceSpot(ax, az, side, (random() * 2 - 1) * span * 0.8, 0.6 + random() * 1.4);
      let at = start.at.clone();
      let dir = start.normal
        .clone()
        .multiplyScalar(0.9)
        .add(v3(random() - 0.5, 0.6, random() - 0.5))
        .normalize();
      const steps = 6 + Math.floor(random() * 5);
      for (let i = 0; i < steps; i++) {
        dir.y -= 0.12;
        dir = dir.normalize();
        const next = at.clone().addScaledVector(dir, 0.06);
        const sideways = new THREE.Vector3().crossVectors(dir, v3(0, 1, 0)).normalize();
        cards.add(STEM, at.clone(), start.normal, at, dir, sideways, new THREE.Vector3().crossVectors(sideways, dir).normalize(), 0.07, 0.007, 0.9, random());
        if (i > 1) leafOff(cards, BOX, { at: next, normal: v3(0, 1, 0), up: dir }, dir, 0.05 + random() * 0.03, random);
        if (i > 2 && random() < 0.35) flower(cards, BRAMBLE, { at: next, normal: start.normal.clone().add(v3(0, 0.5, 0)).normalize(), up: dir }, 0.035 + random() * 0.01, random);
        at = next;
      }
    }

    // Clematis from under the top edge, trailing down the face, starred with purple.
    cards.group = [group++, 0.2];
    for (let s = 0; s < (ends ? 1 : 2); s++) {
      const start = surfaceSpot(ax, az, side, (random() * 2 - 1) * span * 0.5, HEIGHT - ROUND - 0.05);
      stem(cards, [ax, az], start, 18 + Math.floor(random() * 10), 0.07, v3(random() - 0.5, -1, random() - 0.5), 1.2, 0.004, random, (spot, along, i) => {
        if (i % 2 === 0) leafOff(cards, IVY, spot, along, 0.035 + random() * 0.015, random);
        if (random() < 0.3) flower(cards, CLEMATIS, spot, 0.06 + random() * 0.03, random);
      });
    }

    // Honeysuckle climbing in a long slant from the foot, hung with pale bells.
    cards.group = [group++, ends ? 0.15 : 0.35];
    for (let s = 0; s < (ends ? 1 : 2); s++) {
      const start = surfaceSpot(ax, az, side, (random() * 2 - 1) * span * 0.7, 0.05 + random() * 0.3);
      const slant = random() < 0.5 ? -1 : 1;
      stem(cards, [ax, az], start, 18 + Math.floor(random() * 16), 0.07, v3(slant * 0.8, 1, (random() - 0.5) * 0.4), 0.7, 0.005, random, (spot, along, i) => {
        if (i % 2 === 1) leafOff(cards, BINDWEED, spot, along, 0.035 + random() * 0.02, random);
        if (spot.at.y > 0.8 && random() < 0.12) flower(cards, BELL, spot, 0.04 + random() * 0.02, random);
      });
    }

    // A creeper running round the hedge, sideways along the face partway up, as if feeling its way to the corner.
    cards.group = [group++, ends ? 0.2 : 0.4];
    {
      const start = surfaceSpot(ax, az, side, (random() * 2 - 1) * span * 0.6, 0.5 + random() * 1.4);
      const way = random() < 0.5 ? -1 : 1;
      const along = [v3(way, 0.12, 0), v3(-way, 0.12, 0), v3(0, 0.12, -way), v3(0, 0.12, way)][side];
      stem(cards, [ax, az], start, 16 + Math.floor(random() * 14), 0.07, along, 0.5, 0.005, random, (spot, dir, i) => {
        if (i % 2 === 0 || random() < 0.3) leafOff(cards, IVY, spot, dir, 0.03 + random() * 0.02, random);
      });
    }

    // Shoots out of the sides as well as the top, longest high up where the light is.
    for (let t = 0; t < Math.round(span * 7); t++) {
      cards.group = [group++, 0.6];
      const spot = surfaceSpot(ax, az, side, (random() * 2 - 1) * span, 0.3 + Math.pow(random(), 0.6) * (HEIGHT - ROUND - 0.35));
      const heading = spot.normal
        .clone()
        .multiplyScalar(0.9)
        .add(v3(random() - 0.5, 0.35 + random() * 0.5, random() - 0.5));
      shoot(cards, spot.at.clone().addScaledVector(spot.normal, -0.02), spot.normal, heading, 2 + Math.floor(random() * (2 + spot.at.y * 2.5)), random);
    }

    // The hedge's own stems, bare where they come out of the ground under its skirt of leaves.
    for (let t = 0; t < Math.round(span * 8); t++) {
      cards.group = [group++, 0.8];
      const spot = surfaceSpot(ax, az, side, (random() * 2 - 1) * span, 0);
      const foot = spot.at.clone().addScaledVector(spot.normal, -0.03 - random() * 0.08);
      const lean = spot.normal
        .clone()
        .multiplyScalar(0.15 + random() * 0.2)
        .add(v3((random() - 0.5) * 0.4, 1, (random() - 0.5) * 0.4))
        .normalize();
      const sideways = new THREE.Vector3().crossVectors(lean, spot.normal).normalize();
      cards.add(STEM, foot, v3(), foot.clone().setY(-0.02), lean, sideways, spot.normal, 0.25 + random() * 0.25, 0.012 + random() * 0.012, 0.9, 0.5 + random() * 0.5);
    }

    // Grass in tufts along the foot, and dropped leaves lying on the ground in front.
    const out = [v3(0, 0, 1), v3(0, 0, -1), v3(1, 0, 0), v3(-1, 0, 0)][side];
    const sideways = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, -1), v3(0, 0, 1)][side];
    const half = side < 2 ? az : ax;
    for (let w = 0; w < (ends ? 1 : 4); w++) {
      cards.group = [group++, 0.3];
      const foot = out
        .clone()
        .multiplyScalar(half + 0.04 + random() * 0.12)
        .addScaledVector(sideways, (random() * 2 - 1) * span);
      wildflower(cards, foot, out, random() < 0.4, random);
    }
    const tuft = (at: V, tall: number, blades: number) => {
      for (let b = 0; b < blades; b++) {
        const lean = out
          .clone()
          .multiplyScalar(0.15 + random() * 0.5)
          .add(v3((random() - 0.5) * 0.7, 1, (random() - 0.5) * 0.7))
          .normalize();
        const spin = across(lean, v3(random() - 0.5, 0, random() - 0.5), 0, random);
        const face = new THREE.Vector3().crossVectors(spin, lean).normalize();
        const foot = at.clone().add(v3((random() - 0.5) * 0.05, -0.01, (random() - 0.5) * 0.05));
        cards.add(GRASS, at, v3(), foot, lean, spin, face, tall * (0.6 + random() * 0.5), 0.008 + random() * 0.006, 0.7, random());
      }
    };
    for (let t = 0; t < Math.round(span * 7); t++) {
      cards.group = [group++, 0.65];
      const at = out
        .clone()
        .multiplyScalar(half + 0.02 + Math.pow(random(), 2) * 0.22)
        .addScaledVector(sideways, (random() * 2 - 1) * span);
      tuft(at, 0.12 + random() * 0.24, 7 + random() * 8);
    }
    // Thicker grass in the corners, among the grit and stones there, where no foot or blade reaches.
    for (const end of [-1, 1]) {
      for (let t = 0; t < (ends ? 1 : 3); t++) {
        cards.group = [group++, 0.8];
        const at = out
          .clone()
          .multiplyScalar(half + 0.02 + Math.pow(random(), 2) * 0.12)
          .addScaledVector(sideways, end * (span - Math.pow(random(), 1.5) * 0.35));
        tuft(at, 0.14 + random() * 0.26, 10 + random() * 10);
      }
    }
    for (let l = 0; l < Math.round(span * 22); l++) {
      cards.group = [group++, 0.75];
      const at = out
        .clone()
        .multiplyScalar(half + 0.02 + Math.pow(random(), 1.5) * 0.5)
        .addScaledVector(sideways, (random() * 2 - 1) * span)
        .setY(0.006 + random() * 0.004);
      const face = v3((random() - 0.5) * 0.5, 1, (random() - 0.5) * 0.5).normalize();
      const up = across(face, v3(), 0, random);
      const sideLeaf = new THREE.Vector3().crossVectors(face, up).normalize();
      const length = 0.025 + random() * 0.035;
      cards.add(FALLEN, at, v3(), at.clone().addScaledVector(up, -length / 2), up, sideLeaf, face, length, length * 0.6, 0.6, random());
    }
  }

  // New shoots, grown long since the last clipping, standing up out of the top.
  const topArea = x * z;
  for (let s = 0; s < Math.round(topArea * 9); s++) {
    cards.group = [group++, 0.5];
    const atEdge = random() < 0.6;
    const lengthwise = x >= z;
    const a = (random() * 2 - 1) * (lengthwise ? ax - 0.1 : az - 0.1);
    const b = atEdge ? (random() < 0.5 ? -1 : 1) * (Math.min(ax, az) - 0.06) : (random() * 2 - 1) * (Math.min(ax, az) - 0.15);
    const root = lengthwise ? v3(a, HEIGHT - (atEdge ? 0.05 : 0), b) : v3(b, HEIGHT - (atEdge ? 0.05 : 0), a);
    const surface = atEdge ? (lengthwise ? v3(0, 1, Math.sign(b) * 0.7) : v3(Math.sign(b) * 0.7, 1, 0)).normalize() : v3(0, 1, 0);
    const heading = surface.clone().add(v3(random() - 0.5, 0.8, random() - 0.5).multiplyScalar(0.8));
    shoot(cards, root, surface, heading, 3 + Math.floor(random() * 6), random);
  }
  return cards.geometry();
}

// The path a vine takes over a hedge, a point every `step`, wandering as `stem` does and bending over the top edge.
type Point = { at: V; normal: V; dir: V };
function vinePath(box: [number, number], start: Spot, steps: number, step: number, heading: V, wander: number, random: () => number) {
  const points: Point[] = [{ at: start.at.clone(), normal: start.normal.clone(), dir: heading.clone() }];
  let at = start.at.clone();
  let normal = start.normal.clone();
  let dir = heading.clone().addScaledVector(normal, -heading.dot(normal)).normalize();
  for (let i = 0; i < steps; i++) {
    dir = across(normal, dir, 2.2 / Math.max(wander, 0.05), random);
    const next = at.clone().addScaledVector(dir, step);
    if (Math.abs(next.x) > box[0] + 0.01 || Math.abs(next.z) > box[1] + 0.01 || next.y < 0.03) break;
    at = next;
    if (at.y > HEIGHT - 0.04 && normal.y < 0.5) {
      at.y = HEIGHT + 0.004;
      at.addScaledVector(normal, -0.08);
      normal = v3(0, 1, 0);
      dir = dir.setY(0).lengthSq() > 0.001 ? dir.setY(0).normalize() : v3(1, 0, 0);
    }
    points.push({ at: at.clone(), normal: normal.clone(), dir: dir.clone() });
  }
  return points;
}

// Vines all over a hedge, in two levels of detail along the same paths, so that one becomes the other as it nears: `fine`
// close up, a thin stem with its leaves and flowers one by one; otherwise a few long cards with big leaves, which read
// as the same vine from further off for a fraction of the cost.
export function vineGeometry(x: number, z: number, ends: boolean, seed: number, fine: boolean) {
  const path = mulberry32(seed);
  const random = mulberry32(seed + (fine ? 1 : 2) * 7919);
  const cards = new Cards();
  const ax = x / 2;
  const az = z / 2;
  const faces = ends ? 4 : 2;
  let group = 40;
  // Ivy, bindweed, honeysuckle, clematis and a creeper: the leaf each carries, its flower and how often, and which way it heads.
  const kinds = [
    { leaf: IVY, size: 0.05, flower: -1, often: 0, up: 1, from: 0.02, wander: 0.6 },
    { leaf: BINDWEED, size: 0.045, flower: TRUMPET, often: 0.06, up: 1, from: 0.1, wander: 0.9 },
    { leaf: BINDWEED, size: 0.04, flower: BELL, often: 0.1, up: 1, from: 0.2, wander: 0.7 },
    { leaf: IVY, size: 0.04, flower: CLEMATIS, often: 0.2, up: -1, from: HEIGHT - ROUND - 0.05, wander: 1.1 },
    { leaf: IVY, size: 0.04, flower: -1, often: 0, up: 0.15, from: 0.6, wander: 0.5 }
  ];
  for (let side = 0; side < faces; side++) {
    const span = (side < 2 ? ax : az) - 0.08;
    const count = ends ? 6 : 22;
    for (let n = 0; n < count; n++) {
      const kind = kinds[Math.floor(path() * kinds.length)];
      cards.group = [group++, 0.95];
      const from = kind.up === 0.15 ? kind.from + path() * 1.3 : kind.up < 0 ? kind.from : kind.from + path() * 0.4;
      const start = surfaceSpot(ax, az, side, (path() * 2 - 1) * span, from);
      const way = path() < 0.5 ? -1 : 1;
      const sideways = [v3(way, 0, 0), v3(-way, 0, 0), v3(0, 0, -way), v3(0, 0, way)][side];
      const heading = kind.up === 0.15 ? sideways.clone().setY(0.15) : v3(0, kind.up, 0).addScaledVector(sideways, 0.3 + path() * 0.5);
      const points = vinePath([ax, az], start, 40 + Math.floor(path() * 40), 0.05, heading, kind.wander, path);
      const every = fine ? 2 : 4;
      for (let i = 0; i + 1 < points.length; i += every) {
        const a = points[i];
        const b = points[Math.min(i + every, points.length - 1)];
        const along = b.at.clone().sub(a.at);
        const reach = along.length();
        if (reach < 1e-4) continue;
        along.divideScalar(reach);
        const flat = new THREE.Vector3().crossVectors(a.normal, along).normalize();
        cards.add(STEM, a.at, a.normal, a.at.clone().addScaledVector(a.normal, 0.006), along, flat, a.normal, reach * 1.1, fine ? 0.006 : 0.014, 0.9, random());
        const spot = { at: b.at, normal: b.normal, up: along };
        if (fine) {
          leafOff(cards, kind.leaf, spot, along, kind.size * (0.8 + random() * 0.6), random);
          if (random() < 0.6) leafOff(cards, kind.leaf, { at: a.at.clone().lerp(b.at, 0.5), normal: a.normal, up: along }, along, kind.size * (0.7 + random() * 0.5), random);
          if (kind.flower >= 0 && random() < kind.often) flower(cards, kind.flower, spot, 0.05 + random() * 0.02, random);
        } else {
          // The leaves of a stretch gathered into two big ones, and a flower now and then big enough to be seen.
          leafOff(cards, kind.leaf, spot, along, kind.size * 2.2 * (0.8 + random() * 0.4), random);
          leafOff(cards, kind.leaf, { at: a.at.clone().lerp(b.at, 0.5), normal: a.normal, up: along }, along, kind.size * 1.9 * (0.8 + random() * 0.4), random);
          if (kind.flower >= 0 && random() < kind.often * 2) flower(cards, kind.flower, spot, 0.08 + random() * 0.03, random);
        }
      }
    }
  }
  return cards.geometry();
}

// The cards' shapes and colours: everything above is drawn by this one material. `reach` is how far from the camera they
// are drawn; beyond it they shrink away into the hedge, where they would only be a costly shimmer.
export function cardMaterial(air: Air, reach: { fly: number; walk: number; from?: number }) {
  // Leaves are no mirrors: a third of the usual sheen, or every one tipped up to the sky is turned blue by it.
  const material = made(new THREE.MeshPhysicalNodeMaterial({ roughness: 0.6, metalness: 0, specularIntensity: 0.35, side: THREE.DoubleSide, alphaTest: 0.5 }));
  const { at: place, world, own } = placement();
  const rootLocal = attribute("aRoot", "vec3") as any;
  const surface = attribute("aSurface", "vec3") as any;
  const kinds = attribute("aKind", "vec2") as any;
  const group = attribute("aGroup", "vec2") as any;
  const kind = kinds.x as any;
  const seed = kinds.y as any;
  const root = place(rootLocal);
  const far = mix(float(reach.fly), float(reach.walk), walkAmount) as any;
  const away = length(world(rootLocal).sub(cameraPosition)) as any;
  // A coarse level of detail also gives way to a fine one nearer than `from`.
  const near = (reach.from ? smoothstep(far, far.mul(0.72), away).mul(smoothstep(reach.from * 0.72, reach.from, away)) : smoothstep(far, far.mul(0.72), away)) as any;
  const shown = select(fract(own.x.add(group.x.mul(0.6180339))).lessThan(group.y), float(1), float(0)) as any;
  const tip = positionGeometry.sub(rootLocal) as any;
  // Long things sway in the evening air, and short ones only stir.
  const loose = select(kind.equal(GRASS).or(kind.greaterThan(8.5)), float(0.06), select(kind.equal(FALLEN), float(0), float(0.05))) as any;
  const sway = sin(time.mul(1.6).add(root.x.mul(1.3)).add(root.z.mul(0.9)).add(seed.mul(2)))
    .add(sin(time.mul(3.1).add(seed.mul(9))).mul(0.3))
    .mul(loose)
    .mul(length(tip).min(0.4)) as any;
  shape(
    material,
    tip
      .mul(near.mul(shown))
      .add(rootLocal)
      .add(surface.mul(swellAt(root, surface.y)))
      .add(vec3(sway, 0, sway.mul(0.7)))
  );

  // Each kind cut out of its card, and coloured. A card is all one kind, so only that kind's shape and colour are worked
  // out for it, in a branch every pixel of the card takes alike, rather than all eleven and one picked: most of what the
  // cards cost is this, over the many layers of leaves the camera looks through. Each branch makes its own nodes, since
  // one first used inside a branch would be declared there and missing from the next.
  const p = uv() as any;
  const u = () => p.x.sub(0.5) as any;
  const v = () => p.y as any;
  const centred = () => vec2(u(), v().sub(0.5)) as any;
  const r = () => length(centred()).mul(2) as any;
  const angle = () => {
    const c = centred();
    return atan(c.x, c.y) as any;
  };
  const leafWidth = () => pow(sin(v().min(1).mul(Math.PI)).max(0), float(0.7)).mul(float(1).sub(v().mul(0.25))).mul(0.5) as any;
  const box = () => leafWidth().sub(abs(u())) as any;
  const ivy = () => {
    const at = vec2(u(), v().sub(0.42)) as any;
    return float(0.44)
      .mul(cos(atan(at.x, at.y).mul(5)).mul(0.22).add(0.78))
      .sub(length(at)) as any;
  };
  // A heart, point outward: (x² + y² - 1)³ - x²y³ is below nothing inside one.
  const arrow = () => {
    const hx = u().mul(2.3) as any;
    const hy = float(0.55).sub(v()).mul(2.4) as any;
    const round = hx.mul(hx).add(hy.mul(hy)).sub(1) as any;
    return hx.mul(hx).mul(hy.mul(hy).mul(hy)).sub(round.mul(round).mul(round)).mul(0.3) as any;
  };
  const trumpet = () => float(0.46).add(cos(angle().mul(5)).mul(0.03)).mul(2).sub(r()) as any;
  const bramble = () => float(0.48).mul(pow(abs(cos(angle().mul(2.5))), float(0.6)).mul(0.45).add(0.55)).mul(2).sub(r()) as any;
  const clematis = () => float(0.48).mul(pow(abs(cos(angle().mul(2))), float(0.5)).mul(0.65).add(0.35)).mul(2).sub(r()) as any;
  const stemCut = () => float(0.5).sub(abs(u())) as any;
  const blade = () => pow(float(1).sub(v()), float(0.7)).mul(0.5).sub(abs(u())) as any;
  // Cow parsley: a disc of tiny florets, each a dot on a staggered grid.
  const umbel = () => {
    const florets = p.mul(9).add(vec2(fract(p.y.mul(9).floor().mul(0.5)), 0)) as any;
    return float(0.06).sub(length(fract(florets).sub(0.5)).mul(0.2)).min(float(0.48).sub(length(centred()))) as any;
  };
  // A foxglove bell from the side, flaring to its mouth.
  const bell = () => float(0.16).add(pow(v(), float(1.6)).mul(0.32)).sub(abs(u())).min(float(1.04).sub(v()).sub(u().mul(u()).mul(0.8))) as any;
  // The value for this card's kind, from one maker for each kind in order.
  const pick = (zero: any, makers: (() => any)[]): any =>
    Fn(() => {
      const out = zero.toVar();
      let chain: any = If(kind.lessThan(0.5), () => {
        out.assign(makers[0]());
      });
      for (let k = 1; k < makers.length - 1; k++)
        chain = chain.ElseIf(kind.lessThan(k + 0.5), () => {
          out.assign(makers[k]());
        });
      chain.Else(() => {
        out.assign(makers[makers.length - 1]());
      });
      return out;
    })();
  material.opacityNode = pick(float(0), [box, ivy, arrow, trumpet, bramble, clematis, stemCut, blade, box, umbel, bell]).mul(40).add(0.5) as any;

  // Colours. The green leaves take the hedge's own, deeper for ivy and paler for bindweed.
  const variety = varying(smoothstep(-0.35, 0.45, fractal2(root.xz, 4, 2).mul(1.6)), "vCardVariety") as any;
  const height = varying(root.y, "vCardHeight") as any;
  const young = () => smoothstep(0.95, 1, seed).mul(0.7) as any;
  const vein = () => float(1).sub(smoothstep(0.004, 0.02, abs(u()))).mul(smoothstep(0.05, 0.3, v())) as any;
  const boxColour = () => leafGreen(fract(seed.mul(7.3)), young().add(smoothstep(1.6, 2.5, height).mul(0.35)), variety).mul(1.4) as any;
  const ivyColour = () => mix(mix(color("#0e1d0c"), color("#1d3316"), fract(seed.mul(5.1))), color("#55603a"), vein().mul(0.6)) as any;
  const bindweedColour = () => mix(color("#2f5219"), color("#4c6e22"), fract(seed.mul(3.7))) as any;
  const trumpetColour = () => {
    const throat = smoothstep(0.55, 0.05, r()) as any;
    return mix(mix(color("#e9e4dc"), color("#f2d9df"), fract(seed.mul(11))), color("#b8c47c"), throat.mul(0.8)).mul(smoothstep(0, 0.6, r()).mul(0.35).add(0.65)) as any;
  };
  const brambleColour = () => mix(mix(color("#efd3df"), color("#d9a6c1"), fract(seed.mul(13))), color("#d8c25a"), smoothstep(0.32, 0.18, r())) as any;
  const clematisColour = () => mix(mix(color("#5a2f7e"), color("#8a5aa8"), fract(seed.mul(9))), color("#e8dfb8"), smoothstep(0.22, 0.08, r())).mul(abs(sin(angle().mul(14))).mul(0.15).add(0.85)) as any;
  const stemColour = () => mix(color("#3c4a1c"), color("#4a3a24"), fract(seed.mul(4.3))) as any;
  const grassColour = () => mix(mix(color("#2c4012"), color("#5c6a20"), fract(seed.mul(6.1))), color("#9a8a4a"), smoothstep(0.5, 1, v()).mul(fract(seed.mul(2.3)))) as any;
  const fallenColour = () => mix(mix(color("#5e3f17"), color("#9a7a2c"), fract(seed.mul(17.3))), color("#33240f"), smoothstep(0.5, 1, fract(seed.mul(5.9)))) as any;
  const umbelColour = () => mix(color("#e8e4d4"), color("#d6dcb4"), fract(seed.mul(7.7))) as any;
  const bellColour = () => {
    const mouth = smoothstep(0.55, 0.95, v()) as any;
    const spots = smoothstep(0.55, 0.7, fract(u().mul(23).add(v().mul(17)).sin().mul(43.7))).mul(mouth) as any;
    return mix(mix(color("#c4589a"), color("#e09cc4"), fract(seed.mul(5.3))), color("#5a2048"), spots.mul(0.6)).mul(mouth.mul(0.2).add(0.8)) as any;
  };
  const albedo = pick(vec3(0), [boxColour, ivyColour, bindweedColour, trumpetColour, brambleColour, clematisColour, stemColour, grassColour, fallenColour, umbelColour, bellColour]) as any;
  // Darker toward the stalk, and low down, where the hedge shades itself.
  const base = smoothstep(0, 0.45, v()).mul(0.35).add(0.65) as any;
  const low = smoothstep(0, 1.2, height).mul(0.4).add(0.6) as any;
  // Leaves lying close in against the hedge are in its shade; those standing out of it catch the light.
  const proud = varying(dot(positionGeometry.sub(rootLocal), surface), "vCardProud") as any;
  const shade = mix(float(0.45), float(1), smoothstep(0.0, 0.03, proud)) as any;
  const isPetal = kind.greaterThan(2.5).and(kind.lessThan(5.5)).or(kind.greaterThan(8.5)) as any;
  material.colorNode = fading(air, albedo.mul(select(isPetal, float(1), base)).mul(select(kind.greaterThan(6.5), float(1), low.mul(shade))));

  // A rib and veins pressed into each leaf, and the leaves cupped by their normals.
  const veins = abs(sin(u().mul(3).add(v().mul(18)))).mul(0.0005).add(vein().mul(-0.002)) as any;
  material.normalNode = select(isPetal, normalView, bumped(veins.mul(select(kind.lessThan(2.5), float(1), float(0)))));
  material.roughnessNode = pick(float(0), [0.7, 0.6, 0.7, 0.7, 0.7, 0.6, 0.75, 0.8, 0.85, 0.8, 0.6].map((value) => () => float(value)));

  // Light through the leaves and petals, where the sun is behind them and they are high enough to be in it.
  const view = normalize(positionWorld.sub(cameraPosition)) as any;
  const behind = pow(max(dot(view, air.sun), float(0)), float(4)) as any;
  const lit = smoothstep(HEIGHT - 0.9, HEIGHT + 0.1, height).add(smoothstep(0.2, -0.5, dot(normalWorld, air.sun)).mul(0.2)) as any;
  const glow = select(isPetal, vec3(1, 0.9, 0.85), select(kind.greaterThan(6.5), vec3(0.7, 0.6, 0.2), vec3(0.45, 0.62, 0.14))) as any;
  material.emissiveNode = (air.sunColour as any).mul(glow).mul(behind.mul(lit).mul(air.backlight).mul(select(kind.equal(STEM), float(0), float(0.55))));
  material.outputNode = vec4(throughMist(air, (output as any).rgb), 1) as any;
  return material;
}

// Stones along the foot of a hedge: boulders in twos and threes, and smaller stones and pebbles between, half sunk in
// the earth. Each is a low ball of flat facets, pushed in and out by its own lumps and flattened, and given a group so
// that each hedge shows a different handful. `big` makes the boulders, which are seen from further off; otherwise the
// small stones.
export function stoneGeometry(x: number, z: number, ends: boolean, seed: number, big: boolean) {
  const random = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const ax = x / 2;
  const az = z / 2;
  const make = (centre: V, size: number, detail: number, chance: number, id: number) => {
    const ball = new THREE.IcosahedronGeometry(1, detail);
    ball.deleteAttribute("uv");
    // Lumps and a squash of its own, worked out from where each corner points, so corners shared by faces stay shared.
    const bumps = Array.from({ length: 6 }, () => [v3(random() - 0.5, random() - 0.5, random() - 0.5).normalize(), random() * 0.35, 1 + random() * 3] as const);
    const squash = v3(1 + random() * 0.6, 0.5 + random() * 0.35, 0.8 + random() * 0.4);
    const turn = random() * Math.PI;
    const tip = (random() - 0.5) * 0.5;
    const position = ball.getAttribute("position") as THREE.BufferAttribute;
    const p = v3();
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      let r = 1;
      for (const [direction, amount, sharp] of bumps) r += amount * Math.pow(Math.max(0, p.dot(direction)), sharp) - amount * 0.3;
      p.multiplyScalar(r).multiply(squash).applyAxisAngle(v3(1, 0, 0), tip).applyAxisAngle(v3(0, 1, 0), turn).multiplyScalar(size);
      p.y = Math.max(p.y, -size * 0.7);
      p.add(centre);
      position.setXYZ(i, p.x, p.y, p.z);
    }
    // Not merged, so each face keeps its own normal and the stone stays faceted.
    ball.computeVertexNormals();
    const count = position.count;
    const own = random();
    ball.setAttribute("aStone", new THREE.Float32BufferAttribute(new Array(count).fill(0).flatMap(() => [centre.x, centre.y, centre.z, own]), 4));
    ball.setAttribute("aGroup", new THREE.Float32BufferAttribute(new Array(count).fill(0).flatMap(() => [id, chance]), 2));
    parts.push(ball);
  };
  let id = 0;
  for (let side = 0; side < (ends ? 4 : 2); side++) {
    const out = [v3(0, 0, 1), v3(0, 0, -1), v3(1, 0, 0), v3(-1, 0, 0)][side];
    const sideways = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, -1), v3(0, 0, 1)][side];
    const half = side < 2 ? az : ax;
    const span = (side < 2 ? ax : az) - 0.02;
    const at = (along: number, from: number, size: number, sunk: number) =>
      out
        .clone()
        .multiplyScalar(half + from)
        .addScaledVector(sideways, along)
        .setY(size * sunk);
    if (big) {
      // Boulders in little heaps, the biggest pushed in against the hedge.
      for (let heap = 0; heap < (ends ? 3 : 6); heap++) {
        const along = (random() * 2 - 1) * span;
        for (let k = 0; k < 1 + Math.floor(random() * 3); k++) {
          const size = (k ? 0.05 + random() * 0.08 : 0.1 + random() * 0.16) * (ends ? 0.8 : 1);
          make(at(along + (random() - 0.5) * 0.35, size * (k ? 0.9 : 0.55) + random() * 0.08, size, -0.3 + random() * 0.35), size, k ? 0 : 1, 0.75, id++);
        }
      }
    } else {
      for (let i = 0; i < Math.round(span * (ends ? 16 : 30)); i++) {
        const size = 0.012 + Math.pow(random(), 2.2) * 0.05;
        make(at((random() * 2 - 1) * span, 0.015 + Math.pow(random(), 1.4) * 0.5, size, -0.2 + random() * 0.3), size, 0, 0.7, id++);
      }
      // Grit washed into the corners, where the hedge's foot turns: very small, and thickest right in the angle.
      for (const end of [-1, 1]) {
        for (let i = 0; i < (ends ? 7 : 12); i++) {
          const size = 0.005 + Math.pow(random(), 2) * 0.018;
          make(at(end * (span - Math.pow(random(), 1.8) * 0.3), 0.008 + Math.pow(random(), 2) * 0.16, size, -0.1 + random() * 0.3), size, 0, 0.85, id++);
        }
      }
    }
  }
  const geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return geometry;
}

function mergeGeometries(parts: THREE.BufferGeometry[]) {
  const names = ["position", "normal", "aStone", "aGroup"];
  const total = parts.reduce((sum, part) => sum + part.getAttribute("position").count, 0);
  const geometry = new THREE.BufferGeometry();
  let offset = 0;
  const arrays = names.map((name) => new Float32Array(total * parts[0].getAttribute(name).itemSize));
  for (const part of parts) {
    names.forEach((name, n) => arrays[n].set((part.getAttribute(name) as THREE.BufferAttribute).array as Float32Array, offset * part.getAttribute(name).itemSize));
    offset += part.getAttribute("position").count;
  }
  names.forEach((name, n) => geometry.setAttribute(name, new THREE.Float32BufferAttribute(arrays[n], parts[0].getAttribute(name).itemSize)));
  geometry.computeBoundingSphere();
  return geometry;
}

export function stoneMaterial(air: Air, reach: number) {
  const material = made(new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 }));
  const { world, own } = placement();
  const stone = attribute("aStone", "vec4") as any;
  const group = attribute("aGroup", "vec2") as any;
  const near = smoothstep(reach, reach * 0.75, length(world(stone.xyz).sub(cameraPosition))) as any;
  const shown = select(fract(own.y.add(group.x.mul(0.6180339))).lessThan(group.y), float(1), float(0)) as any;
  shape(material, positionGeometry.sub(stone.xyz).mul(near.mul(shown)).add(stone.xyz));

  // Flint, limestone and sandstone, speckled, with moss and lichen on top and earth staining the foot.
  const p = positionGeometry.add(stone.w.mul(3)) as any;
  const grain = noise3(p, 1787) as any;
  const speck = noise3(p, 7686) as any;
  const sort = fract(stone.w.mul(3.7)) as any;
  // Each facet a shade of its own, as broken stone catches the light.
  const facet = fract(sin(dot(normalGeometry, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;
  let rock: any = mix(color("#77706a"), color("#a39a88"), sort).mul(facet.mul(0.24).add(0.88));
  rock = mix(rock, color("#4c4741"), smoothstep(0.75, 0.9, fract(stone.w.mul(7.1))));
  rock = rock.mul(grain.x.mul(0.18).add(1)).mul(smoothstep(0.35, 0.6, speck.y).mul(-0.25).add(1));
  const up = normalWorld.y as any;
  const moss = smoothstep(0.3, 0.75, up.add(grain.z.mul(0.5))).mul(smoothstep(0.15, 0.55, fract(stone.w.mul(5.3)))) as any;
  rock = mix(rock, mix(color("#3d4a1a"), color("#66702a"), speck.x.mul(0.5).add(0.5)), moss.mul(0.85));
  rock = mix(rock, color("#c8b04a"), smoothstep(0.62, 0.7, speck.w).mul(up.max(0)).mul(0.6));
  const foot = smoothstep(0, 0.035, positionGeometry.y) as any;
  rock = rock.mul(foot.mul(0.55).add(0.45));
  material.colorNode = fading(air, rock);
  material.normalNode = bumped(grain.x.mul(0.0025).add(speck.y.mul(0.0008)));
  material.roughnessNode = mix(float(0.78), float(0.95), moss);
  material.outputNode = vec4(throughMist(air, (output as any).rgb), 1) as any;
  return material;
}

