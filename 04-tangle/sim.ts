import { mulberry32 } from "../shared/engine/random";

// Position-based cords, after Müller et al., "Position Based Dynamics" (2007), with real self-collision: cords cannot pass through each other, so a knot
// stays a knot until someone works it loose. Pure TypeScript with no three.js, one flat array per field.

type TangleOptions = {
  cords: number;
  particlesPerCord: number;
  radius: number;
  centre: [number, number, number];
  floorY: number;
  seed: number;
};

export type Sphere = { x: number; y: number; z: number; radius: number; impulseX: number; impulseY: number; impulseZ: number };

const HASH_SIZE = 1 << 15;
const KNOTS: [number, number][] = [
  [2, 3],
  [3, 2],
  [2, 5],
  [3, 4],
  [5, 2],
  [3, 5]
];


export class TangleSim {
  readonly count: number;
  readonly cords: number;
  readonly perCord: number;
  readonly radius: number;
  readonly spacing: number;
  readonly position: Float32Array;
  readonly previous: Float32Array;
  readonly inverseMass: Float32Array;
  private readonly grounded: Uint8Array;

  tension = 0.5;
  gravity = 0;
  time = 0;
  // The hardest contact since these were last cleared, in units a second, and where. Cord on cord or bead
  // never quite rests, because the solver keeps nudging it, so a landing on the floor is kept apart from it.
  impact = 0;
  impactX = 0;
  landing = 0;
  landingX = 0;

  private readonly centre: [number, number, number];
  private readonly floorY: number;
  private readonly head = new Int32Array(HASH_SIZE);
  private readonly next: Int32Array;
  private grabbed = -1;
  private dt = 1 / 60;
  private readonly grabTarget = [0, 0, 0];

  constructor(options: TangleOptions) {
    this.cords = options.cords;
    this.perCord = options.particlesPerCord;
    this.count = options.cords * options.particlesPerCord;
    this.radius = options.radius;
    // Tighter than the diameter, so a chain of spheres behaves as a continuous tube.
    this.spacing = options.radius * 1.15;
    this.centre = options.centre;
    this.floorY = options.floorY;
    this.position = new Float32Array(this.count * 3);
    this.previous = new Float32Array(this.count * 3);
    this.inverseMass = new Float32Array(this.count).fill(1);
    this.grounded = new Uint8Array(this.count);
    this.next = new Int32Array(this.count);
    this.scatter(options.seed);
  }

  // Each cord starts as a wide torus knot at a random rotation, all sharing a centre. They begin
  // interlaced and barely touching, then the tension pulls them into one snarl.
  scatter(seed: number) {
    const rand = mulberry32(seed);
    const length = (this.perCord - 1) * this.spacing;
    const samples = this.perCord * 4;
    const curve = new Float32Array(samples * 3);

    for (let cord = 0; cord < this.cords; cord++) {
      const [p, q] = KNOTS[Math.floor(rand() * KNOTS.length)];
      const start = rand() * Math.PI * 2;
      const span = Math.PI * 2 * (0.82 + rand() * 0.16);
      const tube = 0.42 + rand() * 0.16;

      let arc = 0;
      for (let s = 0; s < samples; s++) {
        const t = start + (s / (samples - 1)) * span;
        const ring = 1 + tube * Math.cos(q * t);
        curve[s * 3] = ring * Math.cos(p * t);
        curve[s * 3 + 1] = ring * Math.sin(p * t);
        curve[s * 3 + 2] = tube * Math.sin(q * t);
        if (s > 0) {
          arc += Math.hypot(curve[s * 3] - curve[s * 3 - 3], curve[s * 3 + 1] - curve[s * 3 - 2], curve[s * 3 + 2] - curve[s * 3 - 1]);
        }
      }

      // A random rotation, from a random unit quaternion.
      const u1 = rand();
      const u2 = rand() * Math.PI * 2;
      const u3 = rand() * Math.PI * 2;
      const qx = Math.sqrt(1 - u1) * Math.sin(u2);
      const qy = Math.sqrt(1 - u1) * Math.cos(u2);
      const qz = Math.sqrt(u1) * Math.sin(u3);
      const qw = Math.sqrt(u1) * Math.cos(u3);

      // Walk the curve and drop a particle at every equal length, so spacing starts already satisfied.
      const scale = length / arc;
      let walked = 0;
      let sample = 1;
      for (let index = 0; index < this.perCord; index++) {
        const wanted = (index * this.spacing) / scale;
        while (sample < samples - 1) {
          const segment = Math.hypot(curve[sample * 3] - curve[sample * 3 - 3], curve[sample * 3 + 1] - curve[sample * 3 - 2], curve[sample * 3 + 2] - curve[sample * 3 - 1]);
          if (walked + segment >= wanted) break;
          walked += segment;
          sample++;
        }
        const segment = Math.hypot(curve[sample * 3] - curve[sample * 3 - 3], curve[sample * 3 + 1] - curve[sample * 3 - 2], curve[sample * 3 + 2] - curve[sample * 3 - 1]);
        const f = Math.min(1, segment > 0 ? (wanted - walked) / segment : 0);
        const x = (curve[sample * 3 - 3] + (curve[sample * 3] - curve[sample * 3 - 3]) * f) * scale;
        const y = (curve[sample * 3 - 2] + (curve[sample * 3 + 1] - curve[sample * 3 - 2]) * f) * scale;
        const z = (curve[sample * 3 - 1] + (curve[sample * 3 + 2] - curve[sample * 3 - 1]) * f) * scale;

        const ix = qw * x + qy * z - qz * y;
        const iy = qw * y + qz * x - qx * z;
        const iz = qw * z + qx * y - qy * x;
        const iw = -qx * x - qy * y - qz * z;
        const i = (cord * this.perCord + index) * 3;
        this.position[i] = ix * qw + iw * -qx + iy * -qz - iz * -qy + this.centre[0];
        this.position[i + 1] = iy * qw + iw * -qy + iz * -qx - ix * -qz + this.centre[1];
        this.position[i + 2] = iz * qw + iw * -qz + ix * -qy - iy * -qx + this.centre[2];
      }
    }
    this.previous.set(this.position);
  }

  grab(index: number) {
    this.release();
    this.grabbed = index;
    this.grabTarget[0] = this.position[index * 3];
    this.grabTarget[1] = this.position[index * 3 + 1];
    this.grabTarget[2] = this.position[index * 3 + 2];
    this.inverseMass[index] = 0;
  }

  moveGrab(x: number, y: number, z: number) {
    this.grabTarget[0] = x;
    this.grabTarget[1] = y;
    this.grabTarget[2] = z;
  }

  release() {
    if (this.grabbed >= 0) this.inverseMass[this.grabbed] = 1;
    this.grabbed = -1;
  }

  step(delta: number, substeps: number, spheres: Sphere[] = []) {
    const dt = Math.min(delta, 1 / 30) / substeps;
    this.dt = dt;
    for (let sub = 0; sub < substeps; sub++) {
      this.time += dt;
      this.integrate(dt);
      this.solveLengths();
      this.solveCollisions();
      this.solveSpheres(spheres, dt);
      this.solveFloor();
      this.solveLengths();
    }
  }

  private integrate(dt: number) {
    const { position, previous, inverseMass, count, centre } = this;
    const maxStep = this.radius * 0.7;
    const maxSquared = maxStep * maxStep;
    const damping = 0.985;
    const pull = 3 + this.tension * 12;
    // Only cord outside this shell is pulled in, which leaves the middle of the snarl loose and airy.
    const shell = 1.6 - this.tension * 0.9;
    // A slow swell in the tension keeps the snarl breathing after it has settled.
    const breath = 1 + Math.sin(this.time * 0.5) * 0.25;
    const t = this.time * 0.35;

    for (let i = 0; i < count; i++) {
      if (inverseMass[i] === 0) continue;
      const a = i * 3;
      const px = position[a];
      const py = position[a + 1];
      const pz = position[a + 2];

      const toX = centre[0] - px;
      const toY = centre[1] - py;
      const toZ = centre[2] - pz;

      // Slow swirl, so no two moments of the knot look the same.
      const swirlX = Math.sin(py * 1.4 + t) * 0.5;
      const swirlY = Math.sin(pz * 1.2 + t * 1.3) * 0.5;
      const swirlZ = Math.sin(px * 1.3 - t * 0.8) * 0.5;

      const distance = Math.sqrt(toX * toX + toY * toY + toZ * toZ) || 1;
      const inward = (Math.max(0, distance - shell) / distance) * pull * breath;

      const accelX = toX * inward + swirlX;
      const accelY = toY * inward + swirlY - this.gravity * 16;
      const accelZ = toZ * inward + swirlZ;

      let vx = (px - previous[a]) * damping + accelX * dt * dt;
      let vy = (py - previous[a + 1]) * damping + accelY * dt * dt;
      let vz = (pz - previous[a + 2]) * damping + accelZ * dt * dt;

      // The speed limit is what makes collisions airtight: nothing can skip across a cord in one step.
      const squared = vx * vx + vy * vy + vz * vz;
      if (squared > maxSquared) {
        const scale = maxStep / Math.sqrt(squared);
        vx *= scale;
        vy *= scale;
        vz *= scale;
      }

      previous[a] = px;
      previous[a + 1] = py;
      previous[a + 2] = pz;
      position[a] = px + vx;
      position[a + 1] = py + vy;
      position[a + 2] = pz + vz;
    }

    if (this.grabbed >= 0) {
      // Pulled, not teleported, so a hard yank travels through the cord instead of tearing it.
      const a = this.grabbed * 3;
      const dx = this.grabTarget[0] - position[a];
      const dy = this.grabTarget[1] - position[a + 1];
      const dz = this.grabTarget[2] - position[a + 2];
      const distance = Math.hypot(dx, dy, dz);
      const move = distance > maxStep ? maxStep / distance : 1;
      previous[a] = position[a];
      previous[a + 1] = position[a + 1];
      previous[a + 2] = position[a + 2];
      position[a] += dx * move;
      position[a + 1] += dy * move;
      position[a + 2] += dz * move;
    }
  }

  private solveLengths() {
    const { position, inverseMass, cords, perCord, spacing } = this;
    for (let cord = 0; cord < cords; cord++) {
      const first = cord * perCord;
      // Sweeping back and forth stops a pull from fading out along the length of a cord.
      for (let pass = 0; pass < 2; pass++) {
        const forward = pass === 0;
        for (let k = 0; k < perCord - 1; k++) {
          const i = first + (forward ? k : perCord - 2 - k);
          this.solveDistance(position, inverseMass, i, i + 1, spacing, 1);
        }
      }
      // Skip-one links resist sharp kinks, which reads as stiffness in the cord.
      for (let k = 0; k < perCord - 2; k++) {
        const i = first + k;
        this.solveDistance(position, inverseMass, i, i + 2, spacing * 1.94, 0.4);
      }
    }
  }

  private solveDistance(position: Float32Array, inverseMass: Float32Array, i: number, j: number, rest: number, stiffness: number) {
    const a = i * 3;
    const b = j * 3;
    const weight = inverseMass[i] + inverseMass[j];
    if (weight === 0) return;
    const dx = position[b] - position[a];
    const dy = position[b + 1] - position[a + 1];
    const dz = position[b + 2] - position[a + 2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < 1e-6) return;
    if (stiffness < 1 && distance > rest) return;
    const correction = (((distance - rest) / distance) * stiffness) / weight;
    const wi = inverseMass[i] * correction;
    const wj = inverseMass[j] * correction;
    position[a] += dx * wi;
    position[a + 1] += dy * wi;
    position[a + 2] += dz * wi;
    position[b] -= dx * wj;
    position[b + 1] -= dy * wj;
    position[b + 2] -= dz * wj;
  }

  private solveCollisions() {
    const { position, previous, inverseMass, count, head, next, radius, perCord, dt } = this;
    const diameter = radius * 2;
    const diameterSquared = diameter * diameter;
    const cell = diameter;
    const hash = (x: number, y: number, z: number) =>
      ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0) & (HASH_SIZE - 1);

    head.fill(-1);
    for (let i = 0; i < count; i++) {
      const a = i * 3;
      const key = hash(Math.floor(position[a] / cell), Math.floor(position[a + 1] / cell), Math.floor(position[a + 2] / cell));
      next[i] = head[key];
      head[key] = i;
    }

    for (let i = 0; i < count; i++) {
      const a = i * 3;
      const cx = Math.floor(position[a] / cell);
      const cy = Math.floor(position[a + 1] / cell);
      const cz = Math.floor(position[a + 2] / cell);
      const cordI = Math.floor(i / perCord);

      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (let oz = -1; oz <= 1; oz++) {
            let j = head[hash(cx + ox, cy + oy, cz + oz)];
            while (j !== -1) {
              // Each pair once. Neighbours along the same cord overlap by design and are skipped.
              if (j > i && !(Math.floor(j / perCord) === cordI && j - i <= 2)) {
                const b = j * 3;
                const dx = position[b] - position[a];
                const dy = position[b + 1] - position[a + 1];
                const dz = position[b + 2] - position[a + 2];
                const squared = dx * dx + dy * dy + dz * dz;
                if (squared < diameterSquared && squared > 1e-10) {
                  const weight = inverseMass[i] + inverseMass[j];
                  if (weight > 0) {
                    const distance = Math.sqrt(squared);
                    const closing =
                      -(dx * (position[b] - previous[b] - position[a] + previous[a]) +
                        dy * (position[b + 1] - previous[b + 1] - position[a + 1] + previous[a + 1]) +
                        dz * (position[b + 2] - previous[b + 2] - position[a + 2] + previous[a + 2])) /
                      distance /
                      dt;
                    if (closing > this.impact) {
                      this.impact = closing;
                      this.impactX = position[a];
                    }
                    const correction = (diameter - distance) / distance / weight;
                    const wi = inverseMass[i] * correction;
                    const wj = inverseMass[j] * correction;
                    position[a] -= dx * wi;
                    position[a + 1] -= dy * wi;
                    position[a + 2] -= dz * wi;
                    position[b] += dx * wj;
                    position[b + 1] += dy * wj;
                    position[b + 2] += dz * wj;
                  }
                }
              }
              j = next[j];
            }
          }
        }
      }
    }
  }

  private solveSpheres(spheres: Sphere[], dt: number) {
    const { position, previous, inverseMass, count, radius } = this;
    for (const sphere of spheres) {
      const reach = sphere.radius + radius;
      const reachSquared = reach * reach;
      for (let i = 0; i < count; i++) {
        if (inverseMass[i] === 0) continue;
        const a = i * 3;
        const dx = position[a] - sphere.x;
        const dy = position[a + 1] - sphere.y;
        const dz = position[a + 2] - sphere.z;
        const squared = dx * dx + dy * dy + dz * dz;
        if (squared >= reachSquared || squared < 1e-10) continue;
        const distance = Math.sqrt(squared);
        const closing = -(dx * (position[a] - previous[a]) + dy * (position[a + 1] - previous[a + 1]) + dz * (position[a + 2] - previous[a + 2])) / distance / dt;
        if (closing > this.impact) {
          this.impact = closing;
          this.impactX = position[a];
        }
        const push = (reach - distance) / distance;
        const px = dx * push;
        const py = dy * push;
        const pz = dz * push;
        position[a] += px;
        position[a + 1] += py;
        position[a + 2] += pz;
        // Newton's third law, in units the rigid body can apply as an impulse.
        const reaction = 0.02 / dt;
        sphere.impulseX -= px * reaction;
        sphere.impulseY -= py * reaction;
        sphere.impulseZ -= pz * reaction;
        // A little surface drag, so cords lie on a bead rather than skate off it.
        previous[a] += (position[a] - previous[a]) * 0.04;
        previous[a + 1] += (position[a + 1] - previous[a + 1]) * 0.04;
        previous[a + 2] += (position[a + 2] - previous[a + 2]) * 0.04;
      }
    }
  }

  private solveFloor() {
    const { position, previous, count, radius, floorY, grounded } = this;
    const limit = floorY + radius;
    for (let i = 0; i < count; i++) {
      const a = i * 3;
      if (position[a + 1] > limit + radius) grounded[i] = 0;
      if (position[a + 1] < limit) {
        const falling = (previous[a + 1] - position[a + 1]) / this.dt;
        if (!grounded[i] && falling > this.landing) {
          this.landing = falling;
          this.landingX = position[a];
        }
        grounded[i] = 1;
        position[a + 1] = limit;
        // Floor friction, so a dropped pile comes to rest.
        previous[a] += (position[a] - previous[a]) * 0.3;
        previous[a + 2] += (position[a + 2] - previous[a + 2]) * 0.3;
      }
    }
  }

  // The nearest particle to a ray, within `reach` of it.
  pick(originX: number, originY: number, originZ: number, dirX: number, dirY: number, dirZ: number, reach: number) {
    const { position, count } = this;
    const reachSquared = reach * reach;
    let best = -1;
    let bestAlong = Infinity;
    for (let i = 0; i < count; i++) {
      const a = i * 3;
      const dx = position[a] - originX;
      const dy = position[a + 1] - originY;
      const dz = position[a + 2] - originZ;
      const along = dx * dirX + dy * dirY + dz * dirZ;
      if (along < 0 || along >= bestAlong) continue;
      const squared = dx * dx + dy * dy + dz * dz - along * along;
      if (squared < reachSquared) {
        best = i;
        bestAlong = along;
      }
    }
    return best < 0 ? null : { index: best, distance: bestAlong };
  }
}
