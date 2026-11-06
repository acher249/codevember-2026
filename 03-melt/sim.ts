import { lehmer } from "../shared/engine/random";

// Liquid metal as a set of spheres: they swell under the source, stretch, pinch off, fall and splash.
// The look comes from blending them per pixel. All this has to do is move them convincingly.

export const MAX_BLOBS = 30;
export const MAX_RIPPLES = 8;
export const BOUND_CENTRE_Y = 3.6;
export const BOUND_RADIUS = 9;

const EMPTY = 0;
const SWELL = 1;
const FREE = 2;
const TAIL = 3;
const SINK = 4;
const HELD = 5;

type Blob = {
  state: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  target: number;
  site: number;
  parent: number;
  link: number;
  age: number;
};

export type SourceKind = "ring" | "orb" | "bar";

export const SOURCE_Y = 6.7;
export const RING_RADIUS = 2.7;
export const RING_TUBE = 0.4;
export const ORB_RADIUS = 1.75;
export const BAR_HALF = 3.2;
export const BAR_RADIUS = 0.36;

const SITES = 14;

export class MeltSim {
  blobs: Blob[] = Array.from({ length: MAX_BLOBS }, () => ({ state: EMPTY, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0, target: 0, site: 0, parent: -1, link: 0, age: 0 }));
  ripples = Array.from({ length: MAX_RIPPLES }, () => ({ x: 0, z: 0, born: -100, amp: 0 }));
  private nextRipple = 0;
  clock = 0;
  source: SourceKind = "ring";
  // Where the source hangs. It stays wherever it is put down.
  sourceAt = { x: 0, y: SOURCE_Y, z: 0 };
  private sourceGoal = { x: 0, y: SOURCE_Y, z: 0 };
  // Told when a drop lets go of the source, and when anything falls into the lake.
  onDrip: ((x: number, r: number) => void) | null = null;
  onPlop: ((x: number, r: number, hit: number) => void) | null = null;
  private emitTimer = 0.2;
  private random = lehmer(1234);
  capacity = MAX_BLOBS;

  // Each source's drip points lie along its underside.
  sitePosition(site: number, out: { x: number; y: number; z: number }) {
    const t = site / SITES;
    const { x, y, z } = this.sourceAt;
    if (this.source === "ring") {
      const angle = t * Math.PI * 2;
      out.x = x + Math.cos(angle) * RING_RADIUS;
      out.z = z + Math.sin(angle) * RING_RADIUS;
      out.y = y - RING_TUBE * 0.8;
    } else if (this.source === "orb") {
      const angle = site * 2.399;
      const spread = Math.sqrt(t) * 0.82;
      out.x = x + Math.cos(angle) * spread * ORB_RADIUS;
      out.z = z + Math.sin(angle) * spread * ORB_RADIUS;
      out.y = y - Math.sqrt(Math.max(0, 1 - spread * spread)) * ORB_RADIUS * 0.92;
    } else {
      out.x = x + (t - 0.5) * BAR_HALF * 1.9;
      out.z = z;
      out.y = y - BAR_RADIUS * 0.8;
    }
    return out;
  }

  // The distance from a point to the source's surface: the same shape the shader draws.
  private sourceDistance(x: number, y: number, z: number) {
    const qx = x - this.sourceAt.x;
    const qy = y - this.sourceAt.y;
    const qz = z - this.sourceAt.z;
    if (this.source === "ring") return Math.hypot(Math.hypot(qx, qz) - RING_RADIUS, qy) - RING_TUBE;
    if (this.source === "orb") return Math.hypot(qx, qy, qz) - ORB_RADIUS;
    return Math.hypot(qx - Math.max(-BAR_HALF, Math.min(BAR_HALF, qx)), qy, qz) - BAR_RADIUS;
  }

  // Walks a ray up to the source's surface, so that only a press on the metal itself picks it up.
  pickSource(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
    let t = 0;
    for (let i = 0; i < 64 && t < 60; i++) {
      const distance = this.sourceDistance(ox + dx * t, oy + dy * t, oz + dz * t);
      if (distance < 0.01) return t;
      t += distance;
    }
    return null;
  }

  // Asks for the source at a spot, held inside the volume that gets ray-marched and clear of the lake.
  moveSource(x: number, y: number, z: number) {
    const extent = this.source === "ring" ? RING_RADIUS + RING_TUBE : this.source === "orb" ? ORB_RADIUS : BAR_HALF + BAR_RADIUS;
    const under = this.source === "ring" ? RING_TUBE : this.source === "orb" ? ORB_RADIUS : BAR_RADIUS;
    const goal = this.sourceGoal;
    goal.x = x;
    goal.y = Math.max(under + 0.5, y);
    goal.z = z;
    const limit = BOUND_RADIUS - extent - 0.2;
    const reach = Math.hypot(goal.x, goal.y - BOUND_CENTRE_Y, goal.z);
    if (reach > limit) {
      goal.x *= limit / reach;
      goal.y = BOUND_CENTRE_Y + (goal.y - BOUND_CENTRE_Y) * (limit / reach);
      goal.z *= limit / reach;
      goal.y = Math.max(under + 0.5, goal.y);
    }
  }

  private spawn(state: number, x: number, y: number, z: number, r: number) {
    for (let i = 0; i < this.capacity; i++) {
      const blob = this.blobs[i];
      if (blob.state !== EMPTY) continue;
      blob.state = state;
      blob.x = x;
      blob.y = y;
      blob.z = z;
      blob.vx = blob.vy = blob.vz = 0;
      blob.r = r;
      blob.target = r;
      blob.parent = -1;
      blob.age = 0;
      return i;
    }
    return -1;
  }

  private ripple(x: number, z: number, amp: number) {
    const ripple = this.ripples[this.nextRipple];
    this.nextRipple = (this.nextRipple + 1) % MAX_RIPPLES;
    ripple.x = x;
    ripple.z = z;
    ripple.born = this.clock;
    ripple.amp = amp;
  }

  private emit(size = 1) {
    const site = Math.floor(this.random() * SITES);
    const at = this.sitePosition(site, { x: 0, y: 0, z: 0 });
    for (const blob of this.blobs) {
      if (blob.state === SWELL && blob.site === site) return;
    }
    const index = this.spawn(SWELL, at.x, at.y, at.z, 0.06);
    if (index < 0) return;
    this.blobs[index].site = site;
    this.blobs[index].target = (0.34 + this.random() * 0.34) * size;
  }

  pour() {
    for (let i = 0; i < 9; i++) this.emit(0.9 + this.random() * 0.5);
  }

  resetSource() {
    for (const blob of this.blobs) if (blob.state === SWELL || blob.state === TAIL) blob.state = EMPTY;
  }

  // A tap on the surface throws up a crown of droplets.
  splash(x: number, z: number, strength: number) {
    this.ripple(x, z, strength);
    const drops = Math.round(3 + strength * 5);
    for (let i = 0; i < drops; i++) {
      const size = 0.07 + this.random() * 0.09 * (0.6 + strength);
      const index = this.spawn(FREE, x + (this.random() - 0.5) * 0.3, size, z + (this.random() - 0.5) * 0.3, size);
      if (index < 0) return;
      const angle = this.random() * Math.PI * 2;
      const out = (0.5 + this.random() * 1.7) * (0.6 + strength);
      const blob = this.blobs[index];
      blob.vx = Math.cos(angle) * out;
      blob.vz = Math.sin(angle) * out;
      blob.vy = (3 + this.random() * 3.6) * (0.65 + strength * 0.55);
    }
  }

  pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
    let best = -1;
    let bestT = Infinity;
    for (let i = 0; i < this.capacity; i++) {
      const blob = this.blobs[i];
      if (blob.state === EMPTY || blob.state === SINK || blob.state === TAIL || blob.r < 0.05) continue;
      const cx = blob.x - ox;
      const cy = blob.y - oy;
      const cz = blob.z - oz;
      const t = cx * dx + cy * dy + cz * dz;
      if (t < 0 || t >= bestT) continue;
      const reach = Math.max(blob.r * 1.2, 0.28);
      if (Math.hypot(cx - dx * t, cy - dy * t, cz - dz * t) < reach) {
        best = i;
        bestT = t;
      }
    }
    return best < 0 ? null : { index: best, t: bestT };
  }

  grab(index: number) {
    const blob = this.blobs[index];
    if (blob.state === SWELL) blob.target = blob.r;
    blob.state = HELD;
    blob.vx = blob.vy = blob.vz = 0;
  }

  drag(index: number, x: number, y: number, z: number, delta: number) {
    const blob = this.blobs[index];
    if (blob.state !== HELD) return;
    const rate = 1 - Math.exp(-delta * 22);
    const nx = blob.x + (x - blob.x) * rate;
    const ny = blob.y + (y - blob.y) * rate;
    const nz = blob.z + (z - blob.z) * rate;
    blob.vx = (nx - blob.x) / Math.max(delta, 1 / 240);
    blob.vy = (ny - blob.y) / Math.max(delta, 1 / 240);
    blob.vz = (nz - blob.z) / Math.max(delta, 1 / 240);
    blob.x = nx;
    blob.y = ny;
    blob.z = nz;
  }

  release(index: number) {
    const blob = this.blobs[index];
    if (blob.state !== HELD) return;
    blob.state = FREE;
    const speed = Math.hypot(blob.vx, blob.vy, blob.vz);
    const scale = speed > 14 ? 14 / speed : 1;
    blob.vx *= scale;
    blob.vy *= scale;
    blob.vz *= scale;
  }

  update(delta: number, heat: number, viscosity: number, gravity: number, heldTarget: { index: number; x: number; y: number; z: number } | null) {
    this.clock += delta;
    const g = 9.5 * gravity;
    const blobs = this.blobs;

    const follow = 1 - Math.exp(-delta * 12);
    this.sourceAt.x += (this.sourceGoal.x - this.sourceAt.x) * follow;
    this.sourceAt.y += (this.sourceGoal.y - this.sourceAt.y) * follow;
    this.sourceAt.z += (this.sourceGoal.z - this.sourceAt.z) * follow;

    this.emitTimer -= delta * heat;
    if (this.emitTimer < 0) {
      this.emitTimer = 0.28 + this.random() * 0.6;
      this.emit();
    }

    const drag = Math.exp(-delta * (0.15 + viscosity * 1.1));
    const site = { x: 0, y: 0, z: 0 };

    for (let i = 0; i < this.capacity; i++) {
      const blob = blobs[i];
      if (blob.state === EMPTY) continue;
      blob.age += delta;

      if (blob.state === HELD) {
        if (heldTarget && heldTarget.index === i) this.drag(i, heldTarget.x, heldTarget.y, heldTarget.z, delta);
      } else if (blob.state === SWELL) {
        // Hanging by the surface: fattens, sags, and goes when its weight beats the skin holding it.
        blob.r += ((blob.target - blob.r) * delta * (0.5 + heat * 0.9)) / (0.5 + viscosity);
        this.sitePosition(blob.site, site);
        const sag = blob.r * (0.5 + blob.age * 0.13 * Math.max(gravity, 0.2));
        blob.x = site.x;
        blob.z = site.z;
        blob.y = site.y - sag;
        if (blob.r > blob.target * 0.93) {
          blob.state = FREE;
          blob.vy = -0.2;
          this.onDrip?.(blob.x, blob.r);
          // A strand of smaller spheres runs back up to the source until it necks and snaps.
          let parent = i;
          for (let k = 1; k <= 3; k++) {
            const tail = this.spawn(TAIL, site.x, site.y - sag * (1 - k * 0.25), site.z, blob.r * (0.5 - k * 0.09));
            if (tail < 0) break;
            blobs[tail].parent = i;
            blobs[tail].site = blob.site;
            blobs[tail].link = k * 0.25;
            blobs[tail].target = blobs[tail].r;
            parent = tail;
          }
          void parent;
        }
      } else if (blob.state === TAIL) {
        const parent = blobs[blob.parent];
        this.sitePosition(blob.site, site);
        const stillThere = parent && parent.state !== EMPTY && parent.state !== SINK;
        if (stillThere) {
          blob.x = parent.x + (site.x - parent.x) * blob.link;
          blob.y = parent.y + (site.y - parent.y) * blob.link;
          blob.z = parent.z + (site.z - parent.z) * blob.link;
        }
        // Stretching thins the strand. When it is thin enough, the middle becomes a stray droplet.
        const length = stillThere ? Math.hypot(parent.x - site.x, parent.y - site.y, parent.z - site.z) : 9;
        blob.r = blob.target * Math.max(0.28, 1 - length * 0.3);
        if (length > 1.3 + viscosity * 1.9 || !stillThere) {
          blob.state = FREE;
          blob.r *= 0.82;
          blob.vy = stillThere ? parent.vy * 0.75 : 0;
          blob.vx = blob.vz = 0;
        }
      } else if (blob.state === FREE) {
        blob.vy -= g * delta;
        blob.vx *= drag;
        blob.vy *= gravity > 0.02 ? Math.exp(-delta * 0.05) : drag;
        blob.vz *= drag;
        blob.x += blob.vx * delta;
        blob.y += blob.vy * delta;
        blob.z += blob.vz * delta;

        // Keep inside the volume that gets ray-marched.
        const bx = blob.x;
        const by = blob.y - BOUND_CENTRE_Y;
        const bz = blob.z;
        const reach = Math.hypot(bx, by, bz);
        const limit = BOUND_RADIUS - blob.r - 0.1;
        if (reach > limit) {
          const nx = bx / reach;
          const ny = by / reach;
          const nz = bz / reach;
          blob.x = nx * limit;
          blob.y = ny * limit + BOUND_CENTRE_Y;
          blob.z = nz * limit;
          const outward = blob.vx * nx + blob.vy * ny + blob.vz * nz;
          if (outward > 0) {
            blob.vx -= 1.6 * outward * nx;
            blob.vy -= 1.6 * outward * ny;
            blob.vz -= 1.6 * outward * nz;
          }
        }

        // Into the lake: a ring on the surface, and a crown from anything big enough.
        if (blob.y < blob.r * 0.1 && blob.vy < 0) {
          const hit = Math.min(1, (blob.r * -blob.vy) / 2.6);
          this.onPlop?.(blob.x, blob.r, hit);
          if (blob.r > 0.2) this.splash(blob.x, blob.z, hit);
          else this.ripple(blob.x, blob.z, hit * 0.7 + 0.08);
          blob.state = SINK;
          blob.vy = -Math.min(1.4, -blob.vy * 0.2);
          blob.age = 0;
        }
      } else if (blob.state === SINK) {
        blob.y += blob.vy * delta;
        blob.r -= delta * Math.max(0.3, blob.r * 2);
        if (blob.r < 0.02 || blob.y < -blob.target - 0.6) blob.state = EMPTY;
      }
    }

    // Free metal pulls together on contact, and the bigger drop swallows the smaller.
    for (let i = 0; i < this.capacity; i++) {
      const a = blobs[i];
      if (a.state !== FREE && a.state !== HELD) continue;
      for (let j = i + 1; j < this.capacity; j++) {
        const b = blobs[j];
        if (b.state !== FREE && b.state !== HELD) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const distance = Math.hypot(dx, dy, dz) || 1e-4;
        const touch = a.r + b.r;
        if (distance > touch * 1.5) continue;
        const pull = (1 - distance / (touch * 1.5)) * 8 * delta;
        const ux = dx / distance;
        const uy = dy / distance;
        const uz = dz / distance;
        if (a.state === FREE) {
          a.vx += ux * pull;
          a.vy += uy * pull;
          a.vz += uz * pull;
        }
        if (b.state === FREE) {
          b.vx -= ux * pull;
          b.vy -= uy * pull;
          b.vz -= uz * pull;
        }
        if (distance < Math.max(a.r, b.r) * 0.7 && a.state === FREE && b.state === FREE) {
          const [big, small] = a.r >= b.r ? [a, b] : [b, a];
          const volumeBig = big.r ** 3;
          const volumeSmall = small.r ** 3;
          const total = volumeBig + volumeSmall;
          big.vx = (big.vx * volumeBig + small.vx * volumeSmall) / total;
          big.vy = (big.vy * volumeBig + small.vy * volumeSmall) / total;
          big.vz = (big.vz * volumeBig + small.vz * volumeSmall) / total;
          big.r = Math.min(1.05, Math.cbrt(total));
          small.state = EMPTY;
        }
      }
    }
  }

  isActive(index: number) {
    return this.blobs[index].state !== EMPTY;
  }
}
