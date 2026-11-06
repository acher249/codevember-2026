import { edgeDistance, FoldRig, groundHeight } from "./forms";
import { isRiver, PANEL_DEPTH, SHEET_WIDTH } from "./map";

// Sheep live on the sheet by its own flat coordinates, so walking off it is not something they can do.
// Whichever way the paper faces, down for a sheep is into the paper: they walk up walls and over folds as if on level ground.
// Only a face turned toward the ground, or closing up inside a fold, shakes them off, onto the sheet or the meadow around it.

const W = SHEET_WIDTH / 2;
const D = PANEL_DEPTH / 2;
const MARGIN = 0.16;
const GRAVITY = 7;
const MEADOW_RADIUS = 15;
export const MAX_SHEEP = 160;
// Room for a sheep's back under the sheet.
const STANDING = 0.28;

const WALK = 0;
const GROUND = 1;
const AIR = 2;
const HELD = 3;

const hash = (n: number) => {
  const s = Math.sin(n * 91.7) * 43758.5453;
  return s - Math.floor(s);
};

export class Flock {
  state = new Uint8Array(MAX_SHEEP);
  facet = new Int32Array(MAX_SHEEP);
  // On the sheet: flat x and z. On the ground, in the air or in hand: world x and z.
  x = new Float32Array(MAX_SHEEP);
  z = new Float32Array(MAX_SHEEP);
  y = new Float32Array(MAX_SHEEP);
  vx = new Float32Array(MAX_SHEEP);
  vy = new Float32Array(MAX_SHEEP);
  vz = new Float32Array(MAX_SHEEP);
  heading = new Float32Array(MAX_SHEEP);
  timer = new Float32Array(MAX_SHEEP);
  grazing = new Uint8Array(MAX_SHEEP);
  walk = new Float32Array(MAX_SHEEP);
  stride = new Float32Array(MAX_SHEEP);
  graze = new Float32Array(MAX_SHEEP);
  tumble = new Float32Array(MAX_SHEEP);
  flung = new Uint8Array(MAX_SHEEP);
  world = new Float32Array(MAX_SHEEP * 3);
  up = new Float32Array(MAX_SHEEP * 3);
  forward = new Float32Array(MAX_SHEEP * 3);
  count = 0;
  // Told whenever a sheep in the air comes down, with where, how hard, and whether someone threw it.
  onLand: ((x: number, speed: number, flung: boolean) => void) | null = null;
  private point = { x: 0, y: 0, z: 0 };

  constructor(private rig: FoldRig) {
    for (let i = 0; i < MAX_SHEEP; i++) {
      let x = 0;
      let z = 0;
      for (let tries = 0; tries < 12; tries++) {
        x = (hash(i * 3 + tries * 7 + 1) - 0.5) * (2 * W - 1);
        z = (hash(i * 5 + tries * 11 + 2) - 0.5) * (2 * D - 1);
        if (!isRiver(x + W, z)) break;
      }
      this.x[i] = x;
      this.z[i] = z;
      this.heading[i] = hash(i + 3) * Math.PI * 2;
      this.timer[i] = hash(i + 4) * 4;
      this.grazing[i] = hash(i + 5) > 0.5 ? 1 : 0;
      this.facet[i] = -1;
      this.up[i * 3 + 1] = 1;
    }
  }

  onFamilySwap() {
    for (let i = 0; i < MAX_SHEEP; i++) if (this.state[i] === WALK) this.facet[i] = this.rig.locate(this.x[i], this.z[i]);
  }

  private walkable(facet: number) {
    return this.rig.upY(facet) > -0.25 && this.rig.family.facets[facet].growth > 0;
  }

  private blocked(i: number, x: number, z: number, hint: number) {
    if (Math.abs(x) > W - MARGIN || Math.abs(z) > D - MARGIN || isRiver(x + W, z)) return true;
    const { rig } = this;
    const facet = rig.locate(x, z, hint);
    if (facet < 0) return true;
    // Anywhere will do to get out of a place it should not be.
    if (!this.walkable(hint)) return false;
    if (!this.walkable(facet)) return true;
    if (facet === hint) return false;
    // Side by side when flat can be far apart once folded, and a sheep should not cross a cut in one step.
    rig.toWorld(facet, x, 0, z, this.point);
    const a = i * 3;
    const flat = Math.hypot(x - this.x[i], z - this.z[i]);
    return Math.hypot(this.point.x - this.world[a], this.point.y - this.world[a + 1], this.point.z - this.world[a + 2]) > flat * 3 + 0.3;
  }

  private launch(i: number, vx: number, vy: number, vz: number) {
    const a = i * 3;
    this.state[i] = AIR;
    this.x[i] = this.world[a];
    this.y[i] = this.world[a + 1];
    this.z[i] = this.world[a + 2];
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
  }

  private land(i: number, facet: number, x: number, z: number) {
    this.state[i] = WALK;
    this.facet[i] = facet;
    this.x[i] = Math.max(-W + MARGIN, Math.min(W - MARGIN, x));
    this.z[i] = Math.max(-D + MARGIN, Math.min(D - MARGIN, z));
    this.vx[i] = this.vz[i] = 0;
    this.tumble[i] = 0;
    this.timer[i] = 0.6;
    this.grazing[i] = 1;
    this.flung[i] = 0;
  }

  private walkOnSheet(i: number, delta: number, clock: number) {
    const { rig } = this;
    const located = rig.locate(this.x[i], this.z[i], this.facet[i]);
    if (located < 0) return;
    this.facet[i] = located;
    const m = rig.matrices;
    const o = located * 12;
    const upY = m[o + 5];
    const a = i * 3;

    if (upY < -0.25 || (rig.family.facets[located].growth <= 0 && rig.progress > 0.25)) {
      // Turned to face the ground, or closing up in a fold: thrown clear of the paper, the way it faces.
      this.launch(i, m[o + 1] * 1.3, Math.max(0.4, m[o + 5] * 1.3), m[o + 9] * 1.3);
      return;
    }
    this.vx[i] *= Math.exp(-delta * 6);
    this.vz[i] *= Math.exp(-delta * 6);
    this.x[i] = Math.max(-W + MARGIN, Math.min(W - MARGIN, this.x[i] + this.vx[i] * delta));
    this.z[i] = Math.max(-D + MARGIN, Math.min(D - MARGIN, this.z[i] + this.vz[i] * delta));
    this.amble(i, delta, clock);

    const facetNow = rig.family.facets[located];
    const h = groundHeight(facetNow, this.x[i], this.z[i]) * rig.relief;
    rig.toWorld(located, this.x[i], h, this.z[i], this.point);
    this.world[a] = this.point.x;
    this.world[a + 1] = this.point.y;
    this.world[a + 2] = this.point.z;
    const cos = Math.cos(this.heading[i]);
    const sin = Math.sin(this.heading[i]);
    this.forward[a] = m[o] * cos + m[o + 2] * sin;
    this.forward[a + 1] = m[o + 4] * cos + m[o + 6] * sin;
    this.forward[a + 2] = m[o + 8] * cos + m[o + 10] * sin;
    this.settleUp(a, m[o + 1], m[o + 5], m[o + 9], delta);
  }

  private settleUp(a: number, x: number, y: number, z: number, delta: number) {
    const rate = 1 - Math.exp(-delta * 10);
    this.up[a] += (x - this.up[a]) * rate;
    this.up[a + 1] += (y - this.up[a + 1]) * rate;
    this.up[a + 2] += (z - this.up[a + 2]) * rate;
  }

  // Graze, wander, keep near the others, turn away from water and from any face they could not stand on.
  private amble(i: number, delta: number, clock: number) {
    this.timer[i] -= delta;
    if (this.timer[i] < 0) {
      this.grazing[i] = this.grazing[i] ? 0 : 1;
      this.timer[i] = this.grazing[i] ? 1.5 + hash(i + Math.floor(clock)) * 4 : 2 + hash(i * 2 + Math.floor(clock)) * 5;
    }
    const grazing = this.grazing[i] === 1;
    this.graze[i] += ((grazing ? 1 : 0) - this.graze[i]) * (1 - Math.exp(-delta * 4));
    let speed = grazing ? 0 : 0.3 + hash(i + 9) * 0.1;

    if (!grazing) {
      let nearX = 0;
      let nearZ = 0;
      let near = 0;
      for (let j = 0; j < this.count; j++) {
        if (j === i || this.state[j] !== WALK) continue;
        const dx = this.x[j] - this.x[i];
        const dz = this.z[j] - this.z[i];
        const squared = dx * dx + dz * dz;
        if (squared > 2.2) continue;
        if (squared < 0.09 && squared > 1e-5) {
          nearX -= (dx / squared) * 0.5;
          nearZ -= (dz / squared) * 0.5;
        } else {
          nearX += dx * 0.25;
          nearZ += dz * 0.25;
        }
        near++;
      }
      let turn = Math.sin(clock * 0.37 + i * 2.1) * 0.5;
      if (near) {
        const wanted = Math.atan2(nearZ, nearX);
        turn += Math.atan2(Math.sin(wanted - this.heading[i]), Math.cos(wanted - this.heading[i])) * 0.8;
      }
      const lookX = this.x[i] + Math.cos(this.heading[i]) * 0.42;
      const lookZ = this.z[i] + Math.sin(this.heading[i]) * 0.42;
      if (this.blocked(i, lookX, lookZ, this.facet[i])) {
        turn = i % 2 ? 3.4 : -3.4;
        speed *= 0.3;
      }
      this.heading[i] += turn * delta;
      const nx = this.x[i] + Math.cos(this.heading[i]) * speed * delta;
      const nz = this.z[i] + Math.sin(this.heading[i]) * speed * delta;
      if (!this.blocked(i, nx, nz, this.facet[i])) {
        this.x[i] = nx;
        this.z[i] = nz;
      } else {
        speed = 0;
      }
    }
    this.stride[i] += (Math.min(1, speed * 3.2) - this.stride[i]) * (1 - Math.exp(-delta * 8));
    this.walk[i] += speed * delta * 34;
  }

  private walkOnGround(i: number, delta: number, clock: number) {
    const { rig } = this;
    const a = i * 3;
    this.amble2(i, delta, clock);
    // A sheet standing in the way is just more ground to a sheep: it walks straight on up it.
    const cos = Math.cos(this.heading[i]);
    const sin = Math.sin(this.heading[i]);
    const ahead = this.grazing[i] ? null : rig.raycast(this.x[i], 0.16, this.z[i], cos, 0, sin, 0.3);
    if (ahead) {
      if (ahead.land && this.walkable(ahead.facet)) {
        this.land(i, ahead.facet, ahead.x, ahead.z);
        this.grazing[i] = 0;
        return;
      }
      // Its back or a closed fold: go round.
      this.heading[i] += Math.PI * 0.6;
      this.x[i] -= cos * delta * 0.5;
      this.z[i] -= sin * delta * 0.5;
    }
    // The sheet hangs lower than a sheep is tall, so anything caught beneath it is walked out from under.
    const over = rig.raycast(this.x[i], 0.01, this.z[i], 0, 1, 0, STANDING);
    if (over && !(over.land && this.walkable(over.facet))) {
      const out = Math.atan2(this.z[i], this.x[i]);
      this.heading[i] = out;
      this.grazing[i] = 0;
      this.x[i] += Math.cos(out) * delta * 1.1;
      this.z[i] += Math.sin(out) * delta * 1.1;
    }
    this.y[i] = 0;
    this.world[a] = this.x[i];
    this.world[a + 1] = 0;
    this.world[a + 2] = this.z[i];
    this.forward[a] = Math.cos(this.heading[i]);
    this.forward[a + 1] = 0;
    this.forward[a + 2] = Math.sin(this.heading[i]);
    this.settleUp(a, 0, 1, 0, delta);

    this.vy[i] -= delta;
    if (this.vy[i] > 0) return;
    this.vy[i] = 0.3 + hash(i + clock) * 0.3;
    // A sheet that has come down around it: step up.
    const under = rig.raycast(this.x[i], 0.9, this.z[i], 0, -1, 0, 0.95);
    if (under && under.land && this.walkable(under.facet)) {
      this.land(i, under.facet, under.x, under.z);
      return;
    }
    // Otherwise, every so often, try to jump back on.
    if (hash(i * 7 + clock * 3.1) > 0.82) {
      for (let tries = 0; tries < 5; tries++) {
        const fx = (hash(i + tries * 13 + clock) - 0.5) * (2 * W - 1);
        const fz = (hash(i * 3 + tries * 17 + clock) - 0.5) * (2 * D - 1);
        if (isRiver(fx + W, fz)) continue;
        const facet = rig.locate(fx, fz);
        if (facet < 0 || !this.walkable(facet) || edgeDistance(rig.family.facets[facet], fx, fz) < 0.2) continue;
        rig.toWorld(facet, fx, 0, fz, this.point);
        if (this.point.y > 4.6) continue;
        const distance = Math.hypot(this.point.x - this.x[i], this.point.z - this.z[i]);
        const flight = 0.9 + Math.min(1, distance * 0.07);
        this.launch(i, (this.point.x - this.x[i]) / flight, this.point.y / flight + 0.5 * GRAVITY * flight, (this.point.z - this.z[i]) / flight);
        return;
      }
    }
  }

  private amble2(i: number, delta: number, clock: number) {
    this.timer[i] -= delta;
    if (this.timer[i] < 0) {
      this.grazing[i] = this.grazing[i] ? 0 : 1;
      this.timer[i] = this.grazing[i] ? 1.5 + hash(i + Math.floor(clock)) * 3 : 2 + hash(i * 2 + Math.floor(clock)) * 4;
    }
    const grazing = this.grazing[i] === 1;
    this.graze[i] += ((grazing ? 1 : 0) - this.graze[i]) * (1 - Math.exp(-delta * 4));
    const speed = grazing ? 0 : 0.34;
    let turn = Math.sin(clock * 0.31 + i * 1.7) * 0.6;
    const r = Math.hypot(this.x[i], this.z[i]);
    if (r > MEADOW_RADIUS - 2.5) {
      const home = Math.atan2(-this.z[i], -this.x[i]);
      turn = Math.atan2(Math.sin(home - this.heading[i]), Math.cos(home - this.heading[i])) * 2.4;
    }
    this.heading[i] += turn * delta;
    this.x[i] += Math.cos(this.heading[i]) * speed * delta;
    this.z[i] += Math.sin(this.heading[i]) * speed * delta;
    const limit = MEADOW_RADIUS / Math.max(MEADOW_RADIUS, Math.hypot(this.x[i], this.z[i]));
    this.x[i] *= limit;
    this.z[i] *= limit;
    this.stride[i] += (Math.min(1, speed * 3.2) - this.stride[i]) * (1 - Math.exp(-delta * 8));
    this.walk[i] += speed * delta * 34;
  }

  private fly(i: number, delta: number) {
    const { rig } = this;
    const a = i * 3;
    this.vy[i] -= GRAVITY * delta;
    const dx = this.vx[i] * delta;
    const dy = this.vy[i] * delta;
    const dz = this.vz[i] * delta;
    const length = Math.hypot(dx, dy, dz);
    if (length > 1e-5 && this.vy[i] < 0) {
      const hit = rig.raycast(this.x[i], this.y[i], this.z[i], dx / length, dy / length, dz / length, length + 0.02);
      if (hit && hit.land && this.walkable(hit.facet)) {
        this.onLand?.(this.x[i], Math.hypot(this.vx[i], this.vy[i], this.vz[i]), this.flung[i] === 1);
        this.land(i, hit.facet, hit.x, hit.z);
        return;
      }
    }
    this.x[i] += dx;
    this.y[i] += dy;
    this.z[i] += dz;
    const r = Math.hypot(this.x[i], this.z[i]);
    if (r > MEADOW_RADIUS) {
      this.x[i] *= MEADOW_RADIUS / r;
      this.z[i] *= MEADOW_RADIUS / r;
      const inward = (this.vx[i] * this.x[i] + this.vz[i] * this.z[i]) / MEADOW_RADIUS;
      if (inward > 0) {
        this.vx[i] -= (2 * inward * this.x[i]) / MEADOW_RADIUS;
        this.vz[i] -= (2 * inward * this.z[i]) / MEADOW_RADIUS;
      }
    }
    if (this.y[i] <= 0) {
      this.y[i] = 0;
      this.onLand?.(this.x[i], Math.hypot(this.vx[i], this.vy[i], this.vz[i]), this.flung[i] === 1);
      if (this.vy[i] < -2) {
        this.vy[i] *= -0.36;
        this.vx[i] *= 0.6;
        this.vz[i] *= 0.6;
      } else {
        this.state[i] = GROUND;
        this.flung[i] = 0;
        this.tumble[i] = 0;
        this.vy[i] = 1 + hash(i) * 2;
        this.timer[i] = 0.6;
        this.grazing[i] = 1;
      }
    }
    this.tumble[i] += delta * Math.min(9, 2 + Math.abs(this.vy[i]));
    this.stride[i] += (1 - this.stride[i]) * (1 - Math.exp(-delta * 6));
    this.walk[i] += delta * 20;
    this.graze[i] *= Math.exp(-delta * 8);
    this.world[a] = this.x[i];
    this.world[a + 1] = this.y[i];
    this.world[a + 2] = this.z[i];
    const speed = Math.hypot(this.vx[i], this.vz[i]);
    if (speed > 0.2) {
      this.forward[a] = this.vx[i] / speed;
      this.forward[a + 1] = 0;
      this.forward[a + 2] = this.vz[i] / speed;
      this.heading[i] = Math.atan2(this.vz[i], this.vx[i]);
    }
    this.settleUp(a, 0, 1, 0, delta);
  }

  update(delta: number, clock: number) {
    for (let i = 0; i < this.count; i++) {
      const state = this.state[i];
      if (state === WALK) this.walkOnSheet(i, delta, clock);
      else if (state === GROUND) this.walkOnGround(i, delta, clock);
      else if (state === AIR) this.fly(i, delta);
      else if (state === HELD) {
        const a = i * 3;
        this.world[a] = this.x[i];
        this.world[a + 1] = this.y[i];
        this.world[a + 2] = this.z[i];
        this.tumble[i] += delta * 3;
        this.stride[i] += (1 - this.stride[i]) * (1 - Math.exp(-delta * 6));
        this.walk[i] += delta * 30;
        this.settleUp(a, 0, 1, 0, delta);
      }
    }
  }

  pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
    let best = -1;
    let bestT = Infinity;
    for (let i = 0; i < this.count; i++) {
      const a = i * 3;
      const cx = this.world[a] + this.up[a] * 0.12 - ox;
      const cy = this.world[a + 1] + this.up[a + 1] * 0.12 - oy;
      const cz = this.world[a + 2] + this.up[a + 2] * 0.12 - oz;
      const t = cx * dx + cy * dy + cz * dz;
      if (t < 0 || t >= bestT) continue;
      const miss = Math.hypot(cx - dx * t, cy - dy * t, cz - dz * t);
      if (miss < 0.24) {
        best = i;
        bestT = t;
      }
    }
    return best < 0 ? null : { sheep: best, t: bestT };
  }

  hold(i: number, x: number, y: number, z: number) {
    this.state[i] = HELD;
    this.x[i] = x;
    this.y[i] = Math.max(0.05, y);
    this.z[i] = z;
    const r = Math.hypot(this.x[i], this.z[i]);
    if (r > MEADOW_RADIUS) {
      this.x[i] *= MEADOW_RADIUS / r;
      this.z[i] *= MEADOW_RADIUS / r;
    }
  }

  drop(i: number, vx: number, vy: number, vz: number) {
    const speed = Math.hypot(vx, vy, vz);
    const scale = speed > 11 ? 11 / speed : 1;
    this.state[i] = AIR;
    this.flung[i] = 1;
    this.vx[i] = vx * scale;
    this.vy[i] = vy * scale;
    this.vz[i] = vz * scale;
  }
}
