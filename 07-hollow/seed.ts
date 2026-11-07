import * as THREE from "three/webgpu";
import { JUICE_LEVEL, R, STONE_CENTRE_Y, cavityAt, hollowReach, inFlesh, skinRadius, stoneRadius } from "./shape";

// The stone, and the wet strands holding it in the hollow. Strands are chains of points, each pulled along by its
// neighbours. They are slack and stretchy, like wet pulp, and drops of juice crawl down them.

const NODES = 13;
const SIDES = 6;
const HOME = new THREE.Vector3(0, STONE_CENTRE_Y, 0);

type Strand = { fromStone: boolean; anchorStone: THREE.Vector3; wall: THREE.Vector3; rest: number; length: number; width: number; pinned: boolean; hangs: boolean; torn: boolean; tearAt: number; limit: number };

export class Seed {
  position = HOME.clone();
  velocity = new THREE.Vector3();
  quaternion = new THREE.Quaternion();
  spin = new THREE.Vector3();
  held = false;
  target = HOME.clone();
  strands: Strand[] = [];
  points: Float32Array;
  before: Float32Array;
  geometry: THREE.BufferGeometry;
  private surface: Float32Array;
  private normal: Float32Array;
  private workA = new THREE.Vector3();
  private workB = new THREE.Vector3();
  private workC = new THREE.Vector3();
  private workQ = new THREE.Quaternion();
  private lastY = STONE_CENTRE_Y;
  pinnedShare = 1;
  // Nothing is holding it any more.
  free = false;
  private wasInSea = false;
  onSplash: ((x: number, z: number, speed: number) => void) | null = null;
  private cutNormal = new THREE.Vector3(1, 0, 0);
  private cutDepth = 10;
  onTear: ((x: number, y: number, z: number) => void) | null = null;

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      // Spread evenly over the stone by the golden angle. One in five hangs loose from the ceiling and drips.
      const hangs = i % 8 === 7;
      const angle = i * 2.399963;
      const lift = 1 - ((i + 0.5) / count) * 1.75;
      const ring = Math.sqrt(Math.max(0, 1 - lift * lift));
      const dir = new THREE.Vector3(Math.cos(angle) * ring, lift, Math.sin(angle) * ring);
      const onStone = dir.clone().multiplyScalar(stoneRadius(dir.x, dir.y, dir.z) * 0.96);
      const wander = new THREE.Vector3(Math.sin(i * 7.1), Math.cos(i * 4.3) * 0.5 + 0.28, Math.cos(i * 3.3));
      const wall = hangs ? cavityAt(Math.cos(angle) * 0.6, 1, Math.sin(angle) * 0.6) : cavityAt(dir.x + wander.x * 0.5, dir.y * 0.8 + wander.y + 0.15, dir.z + wander.z * 0.5);
      const start = hangs ? wall : onStone.clone().add(HOME);
      const rest = hangs ? 0.18 + (i % 7) * 0.05 : start.distanceTo(wall) * 1.03;
      this.strands.push({ fromStone: !hangs, anchorStone: onStone, wall, rest: rest / (NODES - 1), length: rest / (NODES - 1), width: 0.009 + ((i * 7) % 5) * 0.0042, pinned: true, hangs, torn: false, tearAt: 2 + Math.floor(Math.random() * (NODES - 5)), limit: 1.45 + Math.random() * Math.random() * 3.4 });
    }
    this.points = new Float32Array(count * NODES * 3);
    for (let s = 0; s < count; s++) {
      const strand = this.strands[s];
      const a = strand.hangs ? strand.wall : strand.anchorStone.clone().add(HOME);
      const b = strand.hangs ? strand.wall.clone().add(new THREE.Vector3(0, -strand.rest * (NODES - 1), 0)) : strand.wall;
      for (let n = 0; n < NODES; n++) {
        const t = n / (NODES - 1);
        const at = a.clone().lerp(b, t);
        at.y -= Math.sin(t * Math.PI) * 0.26;
        this.points.set([at.x, at.y, at.z], (s * NODES + n) * 3);
      }
    }
    this.before = this.points.slice();

    const rings = count * NODES;
    this.surface = new Float32Array(rings * SIDES * 3);
    this.normal = new Float32Array(rings * SIDES * 3);
    const index: number[] = [];
    for (let s = 0; s < count; s++) {
      for (let n = 0; n < NODES - 1; n++) {
        const here = (s * NODES + n) * SIDES;
        const next = here + SIDES;
        for (let k = 0; k < SIDES; k++) {
          const k2 = (k + 1) % SIDES;
          index.push(here + k, here + k2, next + k, here + k2, next + k2, next + k);
        }
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.surface, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("normal", new THREE.BufferAttribute(this.normal, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(index);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40);
  }

  // The strands whose place on the wall has been cut away come loose, and hang from the stone. They take hold again when the blade comes back.
  step(delta: number, normal: THREE.Vector3, depth: number, sea: number) {
    this.cutNormal.copy(normal);
    this.cutDepth = depth;
    let pinned = 0;
    let tied = 0;
    for (const strand of this.strands) {
      strand.pinned = strand.wall.dot(normal) < depth;
      if (!strand.fromStone) continue;
      tied++;
      if (strand.torn) continue;
      // Pulled further than it can stretch, a strand parts: each at its own limit, and at its own place along it.
      this.workA.copy(strand.anchorStone).applyQuaternion(this.quaternion).add(this.position);
      // What counts is how hard it is being pulled. Boxed in by the hollow, the stone may not have moved at all, but the hand has.
      const stretched = Math.max(this.workA.distanceTo(strand.wall), this.held ? this.target.distanceTo(strand.wall) : 0);
      if (strand.pinned && stretched > Math.min(4, strand.rest * (NODES - 1) * strand.limit)) {
        strand.torn = true;
        this.onTear?.(this.workA.x, this.workA.y, this.workA.z);
        continue;
      }
      if (strand.pinned) pinned++;
    }
    this.pinnedShare = tied ? pinned / tied : 0;
    // Once most of them have gone, the last few can't hold it, and go all at once.
    if (!this.free && this.held) {
      const holding = this.strands.filter((strand) => strand.fromStone && strand.wall.dot(normal) < depth);
      const gone = holding.filter((strand) => strand.torn).length;
      if (holding.length && gone / holding.length > 0.6) {
        for (const strand of holding) {
          if (strand.torn) continue;
          strand.torn = true;
          this.workA.copy(strand.anchorStone).applyQuaternion(this.quaternion).add(this.position);
          this.onTear?.(this.workA.x, this.workA.y, this.workA.z);
        }
        this.pinnedShare = 0;
      }
    }
    // Strands whose place on the wall has been cut away hold nothing, so once the rest have parted, the stone is loose.
    if (this.strands.every((strand) => !strand.fromStone || strand.torn || !strand.pinned)) this.free = true;
    this.moveStone(delta, normal, depth, sea);
    this.moveStrands(delta, normal, depth);
    this.rebuild();
    const crossed = !this.free && this.lastY > JUICE_LEVEL !== this.position.y > JUICE_LEVEL;
    this.lastY = this.position.y;
    return crossed;
  }

  private moveStone(delta: number, normal: THREE.Vector3, depth: number, sea: number) {
    const v = this.velocity;
    if (this.held) {
      // Holds on through the strands' pull: heavy in the hand, and the further it goes the harder they drag it back.
      const away = this.position.distanceTo(HOME);
      const give = 1 - 0.32 * Math.min(1, away / 8) * this.pinnedShare;
      this.workA.copy(this.target).lerp(HOME, 1 - give).sub(this.position);
      v.addScaledVector(this.workA, delta * 130);
      v.multiplyScalar(Math.exp(-delta * 15));
    } else {
      this.workA.copy(HOME).sub(this.position);
      // Half of the strands hold it as firmly as all of them. Without any, it drops into the sea and floats.
      const share = this.free ? 0 : Math.min(1, this.pinnedShare * 2.2);
      v.addScaledVector(this.workA, delta * 16 * share);
      v.y -= delta * (this.free ? 9.8 : 7 * (1 - share * 0.97));
      if (this.free) {
        // Nothing but air now, and it hardly slows at all, until it lands in the sea.
        v.multiplyScalar(Math.exp(-delta * (this.position.y < sea ? 1.5 : 0.12)));
      } else {
        // Thick juice slows anything moving through it.
        const inJuice = this.position.y < JUICE_LEVEL ? 2.4 : 0;
        v.multiplyScalar(Math.exp(-delta * (1.7 + inJuice)));
      }
    }
    this.position.addScaledVector(v, delta);
    // Loose, it goes wherever it is thrown or carried. Only if it comes to rest inside the flesh is it eased back out.
    if (this.free) {
      if (!this.held && v.length() < 3) this.bounceOffPeach(normal, depth);
    } else {
      // The rest of the peach is solid. It can leave through the cut, and nowhere else.
      const kept = this.position.dot(normal) < depth;
      if (kept) {
        const limit = hollowReach(this.position.x, this.position.y, this.position.z);
        const room = limit * this.position.length();
        const reach = this.position.length();
        const margin = 0.62;
        if (reach > room - margin && reach > 0.001) {
          const pull = (reach - (room - margin)) / reach;
          this.position.multiplyScalar(1 - Math.min(1, pull) * Math.min(1, delta * 30));
          v.multiplyScalar(0.72);
        }
      }
    }
    if (this.position.y < sea) {
      v.y += (sea - this.position.y) * delta * 22;
      if (!this.free) v.multiplyScalar(Math.exp(-delta * 3));
    }
    const wet = this.position.y < sea;
    if (this.free && wet !== this.wasInSea) {
      this.wasInSea = wet;
      if (wet) this.onSplash?.(this.position.x, this.position.z, Math.abs(v.y));
    }
    // Attached, it can only go so far. Loose, it can go anywhere there is still sea to see it in.
    const range = this.free ? 90 : R * 3.4;
    if (this.position.length() > range) this.position.setLength(range);
    // It turns as it is dragged about, and rolls back upright when left.
    this.workB.copy(HOME).sub(this.position).cross(v).multiplyScalar(-0.09);
    this.spin.addScaledVector(this.workB, delta * 9);
    this.spin.multiplyScalar(Math.exp(-delta * 2.6));
    const size = this.spin.length();
    if (size > 0.0001) {
      this.workQ.setFromAxisAngle(this.workC.copy(this.spin).divideScalar(size), size * delta);
      this.quaternion.premultiply(this.workQ);
    }
    this.workQ.identity();
    this.quaternion.slerp(this.workQ, Math.min(1, delta * (this.held ? 0.3 : 1.4)));
  }

  // Loose, the stone goes anywhere, and the half of the peach that remains is only something it can hit.
  private bounceOffPeach(normal: THREE.Vector3, depth: number) {
    const p = this.position;
    const fromCut = depth - p.dot(normal);
    if (fromCut < -0.45) return;
    const reach = p.length() || 0.001;
    const skin = skinRadius(p.x / reach, p.y / reach, p.z / reach) + 0.5;
    if (reach >= skin) return;
    // Sitting in the hollow is fine: there is no flesh there.
    if (fromCut > 0 && inFlesh(p.x, p.y, p.z) === "hollow" && hollowReach(p.x, p.y, p.z) * reach > reach + 0.6) return;
    const v = this.velocity;
    // Out by the shorter way: through the skin, or back through the cut.
    if (skin - reach < fromCut + 0.45) {
      p.multiplyScalar(skin / reach);
      this.workB.copy(p).normalize();
    } else {
      p.addScaledVector(normal, fromCut + 0.45);
      this.workB.copy(normal);
    }
    const into = v.dot(this.workB);
    if (into < 0) v.addScaledVector(this.workB, -into);
  }

  private moveStrands(delta: number, normal: THREE.Vector3, depth: number) {
    const p = this.points;
    const b = this.before;
    const count = this.strands.length;
    const dt = Math.min(delta, 1 / 40);
    for (let s = 0; s < count; s++) {
      const strand = this.strands[s];
      // A strand with nothing to hold draws back into a short dripping stub.
      strand.length += ((strand.torn ? strand.rest * 0.62 : strand.hangs || strand.pinned ? strand.rest : strand.rest * 0.28) - strand.length) * Math.min(1, dt * 2.4);
      for (let n = 0; n < NODES; n++) {
        const i = (s * NODES + n) * 3;
        const x = p[i];
        const y = p[i + 1];
        const z = p[i + 2];
        p[i] += (x - b[i]) * 0.965;
        p[i + 1] += (y - b[i + 1]) * 0.965 - 3.6 * dt * dt;
        p[i + 2] += (z - b[i + 2]) * 0.965;
        b[i] = x;
        b[i + 1] = y;
        b[i + 2] = z;
      }
      // Strands stay in the hollow: where they sag against its wall, the wall holds them up.
      for (let n = 1; n < NODES - 1; n++) {
        const i = (s * NODES + n) * 3;
        if (p[i] * normal.x + p[i + 1] * normal.y + p[i + 2] * normal.z < depth && inFlesh(p[i], p[i + 1], p[i + 2]) !== "hollow") {
          const scale = hollowReach(p[i], p[i + 1], p[i + 2]) * 0.985;
          p[i] *= scale;
          p[i + 1] *= scale;
          p[i + 2] *= scale;
        }
      }
      this.keepOutOfStone(s);
      this.workA.copy(strand.anchorStone).applyQuaternion(this.quaternion).add(this.position);
      for (let round = 0; round < 5; round++) {
        if (strand.fromStone) p.set([this.workA.x, this.workA.y, this.workA.z], s * NODES * 3);
        else p.set([strand.wall.x, strand.wall.y, strand.wall.z], s * NODES * 3);
        if ((strand.pinned || strand.torn) && strand.fromStone) p.set([strand.wall.x, strand.wall.y, strand.wall.z], (s * NODES + NODES - 1) * 3);
        for (let n = 0; n < NODES - 1; n++) {
          if (strand.torn && n === strand.tearAt) continue;
          const i = (s * NODES + n) * 3;
          const j = i + 3;
          const dx = p[j] - p[i];
          const dy = p[j + 1] - p[i + 1];
          const dz = p[j + 2] - p[i + 2];
          const size = Math.hypot(dx, dy, dz) || 0.0001;
          // Only pulls. A link shorter than its length simply goes slack, which is what lets it droop.
          if (size <= strand.length) continue;
          const pull = ((size - strand.length) / size) * 0.5 * 0.82;
          p[i] += dx * pull;
          p[i + 1] += dy * pull;
          p[i + 2] += dz * pull;
          p[j] -= dx * pull;
          p[j + 1] -= dy * pull;
          p[j + 2] -= dz * pull;
        }
      }
      this.keepOutOfStone(s);
    }
  }

  // The stone is solid. A strand may be fixed to its surface, but where it sags against the stone it lies on it.
  private keepOutOfStone(s: number) {
    const p = this.points;
    const b = this.before;
    const { x: qx, y: qy, z: qz, w: qw } = this.quaternion;
    const first = this.strands[s].fromStone ? 1 : 0;
    for (let n = first; n < NODES - 1; n++) {
      const i = (s * NODES + n) * 3;
      const rx = p[i] - this.position.x;
      const ry = p[i + 1] - this.position.y;
      const rz = p[i + 2] - this.position.z;
      const reach = Math.hypot(rx, ry, rz);
      if (reach > 1.3 || reach < 0.0001) continue;
      // Into the stone's own frame, where its shape is defined: the rotation run backwards.
      const tx = 2 * (-qy * rz + qz * ry);
      const ty = 2 * (-qz * rx + qx * rz);
      const tz = 2 * (-qx * ry + qy * rx);
      const lx = rx + qw * tx + (-qy * tz + qz * ty);
      const ly = ry + qw * ty + (-qz * tx + qx * tz);
      const lz = rz + qw * tz + (-qx * ty + qy * tx);
      const surface = stoneRadius(lx / reach, ly / reach, lz / reach) * 1.03 + this.strands[s].width;
      if (reach >= surface) continue;
      const scale = surface / reach;
      const nx = this.position.x + rx * scale;
      const ny = this.position.y + ry * scale;
      const nz = this.position.z + rz * scale;
      // Lands, rather than bouncing off: it keeps what it had of sideways motion, and loses what took it inward.
      b[i] += nx - p[i];
      b[i + 1] += ny - p[i + 1];
      b[i + 2] += nz - p[i + 2];
      p[i] = nx;
      p[i + 1] = ny;
      p[i + 2] = nz;
    }
  }

  private rebuild() {
    const p = this.points;
    const out = this.surface;
    const nor = this.normal;
    const t = this.workA;
    const side = this.workB;
    const other = this.workC;
    for (let s = 0; s < this.strands.length; s++) {
      const strand = this.strands[s];
      for (let n = 0; n < NODES; n++) {
        const i = (s * NODES + n) * 3;
        const a = Math.max(0, n - 1);
        const c = Math.min(NODES - 1, n + 1);
        const ia = (s * NODES + a) * 3;
        const ic = (s * NODES + c) * 3;
        t.set(p[ic] - p[ia], p[ic + 1] - p[ia + 1], p[ic + 2] - p[ia + 2]);
        const stretch = t.length() / Math.max(strand.length * (c - a), 0.0001);
        t.normalize();
        side.set(0, 1, 0).cross(t);
        if (side.lengthSq() < 0.001) side.set(1, 0, 0);
        side.normalize();
        other.crossVectors(t, side);
        // Thick where it is fixed, thin in the middle, and thinner as it is drawn out. A loose end finishes in a bead.
        const u = n / (NODES - 1);
        const ends = strand.hangs ? (0.12 + (1 - u) * 0.62 + (u > 0.95 ? 1.1 : 0)) : 0.46 + 4.4 * (u - 0.5) * (u - 0.5);
        let radius = strand.width * ends / Math.max(1, Math.sqrt(stretch));
        // A torn end comes to a point. What was left on a wall that has been cut away goes with it.
        if (strand.torn) {
          const gap = n <= strand.tearAt ? strand.tearAt - n : n - strand.tearAt - 1;
          if (gap === 0) radius = 0;
          else if (gap === 1) radius *= 0.45;
          else radius *= 0.72;
          if (n > strand.tearAt && !strand.pinned) radius = 0;
        }
        // What grows from the wall exists only where there is still a wall: nothing is left of it on the side cut away.
        const fromWall = strand.hangs || (strand.torn && n > strand.tearAt);
        if (fromWall && (!strand.pinned || p[i] * this.cutNormal.x + p[i + 1] * this.cutNormal.y + p[i + 2] * this.cutNormal.z > this.cutDepth)) radius = 0;
        for (let k = 0; k < SIDES; k++) {
          const angle = (k / SIDES) * Math.PI * 2;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const nx = side.x * cos + other.x * sin;
          const ny = side.y * cos + other.y * sin;
          const nz = side.z * cos + other.z * sin;
          const w = ((s * NODES + n) * SIDES + k) * 3;
          out[w] = p[i] + nx * radius;
          out[w + 1] = p[i + 1] + ny * radius;
          out[w + 2] = p[i + 2] + nz * radius;
          nor[w] = nx;
          nor[w + 1] = ny;
          nor[w + 2] = nz;
        }
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
  }

  // When the peach is thrown about, what hangs inside it swings the other way.
  // Let go. A loose stone keeps all its speed, and a bit more: a flick should really send it.
  letGo(thrown: THREE.Vector3) {
    this.held = false;
    if (!this.free) return;
    // By how fast the hand was going: the stone may not have caught up with it yet.
    if (thrown.length() > this.velocity.length()) this.velocity.copy(thrown);
    this.velocity.multiplyScalar(1.3).clampLength(0, 30);
    // Anything thrown goes up as well as along, or it would only ever land at the thrower's feet.
    this.velocity.y += this.velocity.length() * 0.28;
  }

  jostle(change: THREE.Vector3, moved: THREE.Vector3, delta: number) {
    if (delta <= 0) return;
    // Once torn free, it has nothing to do with the peach, and stays where it is as the peach moves.
    if (this.free && !this.held) this.position.sub(moved);
    else this.velocity.addScaledVector(change, 0.7);
    const shift = 0.35 * delta;
    const p = this.points;
    for (let i = 0; i < p.length; i += 3) {
      p[i] += change.x * shift;
      p[i + 1] += change.y * shift;
      p[i + 2] += change.z * shift;
    }
  }

  // Where along a strand a drop has crawled to, from 0 at its start to 1 at its end.
  along(strand: number, t: number, out: THREE.Vector3) {
    const f = Math.min(NODES - 1.001, Math.max(0, t) * (NODES - 1));
    const n = Math.floor(f);
    const i = (strand * NODES + n) * 3;
    const k = f - n;
    const p = this.points;
    return out.set(p[i] + (p[i + 3] - p[i]) * k, p[i + 1] + (p[i + 4] - p[i + 1]) * k, p[i + 2] + (p[i + 5] - p[i + 2]) * k);
  }
}
