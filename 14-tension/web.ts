import type { Look } from "./versions";

// An orb web, spun the way a garden spider spins one: a few frame threads strung between twigs, spokes from the hub out
// to the frame, a tight mesh at the hub, then the sticky spiral wound out from the free zone to the edge, wider spaced
// below the hub than above. Every crossing is a point the silk can move at, and every length of silk between two is a
// thread that pulls when stretched and goes slack when not, solved a few times a frame (position-based dynamics).

export const enum Kind {
  Frame,
  Spoke,
  Spiral,
  Hub
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Where the frame is tied to the twigs, by angle round the hub (degrees) and distance from it. The garden is drawn to pass
// through these, so the web always hangs from something.
export const ANCHORS: [number, number, number][] = [
  [104, 1.42, 0.02],
  [36, 1.5, -0.04],
  [-38, 1.38, 0.05],
  [-104, 1.3, -0.02],
  [-166, 1.46, 0.03],
  [158, 1.4, -0.05]
];
export const anchorPoint = (i: number): [number, number, number] => {
  const [deg, r, z] = ANCHORS[i];
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a) * r, Math.sin(a) * r, z];
};

export class Web {
  count = 0;
  position: Float32Array;
  previous: Float32Array;
  inverseMass: Float32Array;
  // Mass the dew adds to each point; the silk itself is next to nothing.
  load: Float32Array;
  pinned: Uint8Array;
  segments: {
    a: number;
    b: number;
    rest: number;
    kind: Kind;
    alive: boolean;
  }[] = [];
  // For each point, the threads that meet there, for the spider to find its way.
  around: number[][] = [];
  hub = 0;
  radius = 1;
  // Spiral threads, for dew to sit on.
  spiral: number[] = [];
  grabbed = -1;
  target = new Float32Array(3);
  // Set by the scene: the wind's push this frame, along z mostly.
  wind = 0;
  time = 0;
  snapped: { x: number; y: number; z: number; kind: Kind }[] = [];
  // How hard the web has been shaken since last asked, for the drops and the spider.
  shaken: Float32Array;
  calm: Float32Array;

  constructor(look: Look, seed: number, fine: number) {
    const random = mulberry32(seed);
    const points: number[] = [];
    const pins: number[] = [];
    const add = (x: number, y: number, z: number, pin = false) => {
      points.push(x, y, z);
      pins.push(pin ? 1 : 0);
      return points.length / 3 - 1;
    };
    const link = (a: number, b: number, kind: Kind, slack = 1) => {
      const dx = points[b * 3] - points[a * 3];
      const dy = points[b * 3 + 1] - points[a * 3 + 1];
      const dz = points[b * 3 + 2] - points[a * 3 + 2];
      // Spun taut: each thread a little shorter than the gap it spans, so it pulls.
      const taut = kind === Kind.Spiral ? 0.992 : kind === Kind.Hub ? 0.99 : 0.982;
      this.segments.push({
        a,
        b,
        rest: Math.hypot(dx, dy, dz) * taut * slack,
        kind,
        alive: true
      });
    };

    const hubY = look.hubLift * 0.5;
    const hubX = (random() - 0.5) * 0.08;
    this.hub = add(hubX, hubY, 0);

    // The frame: corners tied to the twigs, and the polygon between them.
    const corners = ANCHORS.map((_, i) => {
      const [x, y, z] = anchorPoint(i);
      return {
        x,
        y,
        z,
        angle: Math.atan2(y - hubY, x - hubX),
        node: add(x, y, z, true)
      };
    }).sort((p, q) => p.angle - q.angle);
    const reach = (angle: number) => {
      // Where a ray from the hub at this angle meets the frame.
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      for (let i = 0; i < corners.length; i++) {
        const p = corners[i];
        const q = corners[(i + 1) % corners.length];
        const ex = q.x - p.x;
        const ey = q.y - p.y;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((p.x - hubX) * ey - (p.y - hubY) * ex) / den;
        const u = ((p.x - hubX) * dy - (p.y - hubY) * dx) / den;
        if (t > 0 && u >= 0 && u <= 1) return { t, edge: i, u };
      }
      return { t: 1, edge: 0, u: 0 };
    };

    const spokes = Math.max(12, Math.round(look.spokes * fine));
    const turns = Math.max(10, Math.round(look.turns * fine));
    const angles = Array.from({ length: spokes }, (_, i) => ((i + (random() - 0.5) * 0.35) / spokes) * Math.PI * 2 - Math.PI);
    const ends = angles.map(reach);
    this.radius = ends.reduce((sum, end) => sum + end.t, 0) / spokes;

    // Along each spoke, from the hub out: the hub rings, the spiral's crossings, then the frame.
    const along: { r: number; node: number }[][] = angles.map(() => []);
    const hubRings = [0.028, 0.05, 0.072, 0.094];
    const free = 0.15;
    const outer = this.radius * 0.9;
    const spacing = (outer - free) / turns;
    const rings: number[][] = hubRings.map(() => []);
    const crossings: number[][] = [];
    angles.forEach((angle, i) => {
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const at = (r: number) => add(hubX + dx * r, hubY + dy * r, (random() - 0.5) * 0.004);
      hubRings.forEach((r, k) => {
        const node = at(r);
        rings[k][i] = node;
        along[i].push({ r, node });
      });
      // Wider spaced below the hub, as the spider winds it.
      const below = Math.max(0, -dy);
      const step = spacing * (1 + (look.lopsided - 1) * below) * (1 / (1 + (look.lopsided - 1) * 0.35));
      for (let j = 0; ; j++) {
        const r = free + (j + i / spokes) * step;
        if (r > ends[i].t * 0.94) break;
        const node = at(r);
        along[i].push({ r, node });
        (crossings[j] ??= [])[i] = node;
      }
    });
    // The spokes' ends on the frame, and the frame threads between them and the corners in order round it.
    const onEdge: { u: number; node: number }[][] = corners.map(() => []);
    ends.forEach((end, i) => {
      const p = corners[end.edge];
      const q = corners[(end.edge + 1) % corners.length];
      const node = add(p.x + (q.x - p.x) * end.u, p.y + (q.y - p.y) * end.u, p.z + (q.z - p.z) * end.u);
      along[i].push({ r: end.t, node });
      onEdge[end.edge].push({ u: end.u, node });
    });
    this.count = points.length / 3;
    corners.forEach((p, i) => {
      const chain = [p.node, ...onEdge[i].sort((a, b) => a.u - b.u).map((e) => e.node), corners[(i + 1) % corners.length].node];
      for (let k = 1; k < chain.length; k++) link(chain[k - 1], chain[k], Kind.Frame);
    });
    along.forEach((chain) => {
      let last = this.hub;
      for (const { node } of chain) {
        link(last, node, Kind.Spoke);
        last = node;
      }
    });
    rings.forEach((ring) => ring.forEach((node, i) => link(node, ring[(i + 1) % spokes], Kind.Hub, 1.01)));
    // The sticky spiral: each crossing to the next spoke's, and round from the last spoke to the first one turn on.
    crossings.forEach((ring, j) =>
      ring.forEach((node, i) => {
        if (node === undefined) return;
        const next = i + 1 < spokes ? ring[i + 1] : crossings[j + 1]?.[0];
        if (next === undefined) return;
        if (random() < look.broken) return;
        this.spiral.push(this.segments.length);
        link(node, next, Kind.Spiral, 1 + random() * 0.01);
      })
    );

    this.position = new Float32Array(points);
    this.previous = new Float32Array(points);
    this.inverseMass = new Float32Array(this.count).fill(1);
    this.load = new Float32Array(this.count);
    this.pinned = new Uint8Array(pins);
    this.shaken = new Float32Array(this.count);
    this.calm = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) if (this.pinned[i]) this.inverseMass[i] = 0;
    this.around = Array.from({ length: this.count }, () => []);
    this.segments.forEach((s, i) => {
      this.around[s.a].push(i);
      this.around[s.b].push(i);
    });
  }

  // Hung and left to settle before anyone sees it, so it starts at rest rather than dropping into its sag.
  settle() {
    for (let n = 0; n < 120; n++) this.step(1 / 60, 8);
    this.previous.set(this.position);
    this.shaken.fill(0);
    this.calm.fill(0);
    this.time = 0;
  }

  // Dew weighs the points it hangs nearest.
  weigh() {
    for (let i = 0; i < this.count; i++) this.inverseMass[i] = this.pinned[i] ? 0 : 1 / (1 + this.load[i] * 2.4e5);
  }

  step(delta: number, iterations: number) {
    // A frame with no time in it moves nothing, and would make every speed nought over nought.
    if (!(delta > 0)) return;
    const substeps = 2;
    const dt = Math.min(delta, 1 / 30) / substeps;
    const p = this.position;
    const q = this.previous;
    for (let s = 0; s < substeps; s++) {
      this.time += dt;
      const t = this.time;
      for (let i = 0; i < this.count; i++) {
        if (this.inverseMass[i] === 0 || i === this.grabbed) continue;
        const a = i * 3;
        const x = p[a];
        const y = p[a + 1];
        const z = p[a + 2];
        // Silk rings for a long while: very little damping, more on heavier points.
        const keep = 0.993 - this.load[i] * 900;
        const vx = (x - q[a]) * keep;
        const vy = (y - q[a + 1]) * keep;
        const vz = (z - q[a + 2]) * keep;
        q[a] = x;
        q[a + 1] = y;
        q[a + 2] = z;
        // The breeze through the web: a slow swell over the whole of it, ripples crossing it, and gusts.
        const push = this.wind * (0.6 + 0.4 * Math.sin(t * 1.7 + x * 2.3 + y * 1.1) + 0.25 * Math.sin(t * 5.3 - y * 6 + x * 3));
        p[a] = x + vx + push * 0.15 * dt * dt;
        p[a + 1] = y + vy - 0.5 * dt * dt;
        p[a + 2] = z + vz + push * dt * dt;
      }
      if (this.grabbed >= 0) {
        const g = this.grabbed * 3;
        for (let k = 0; k < 3; k++) {
          q[g + k] = p[g + k];
          p[g + k] += (this.target[k] - p[g + k]) * 0.5;
        }
      }
      for (let n = 0; n < iterations; n++) {
        for (const seg of this.segments) {
          if (!seg.alive) continue;
          const wa = seg.a === this.grabbed ? 0 : this.inverseMass[seg.a];
          const wb = seg.b === this.grabbed ? 0 : this.inverseMass[seg.b];
          const sum = wa + wb;
          if (sum === 0) continue;
          const a = seg.a * 3;
          const b = seg.b * 3;
          const dx = p[b] - p[a];
          const dy = p[b + 1] - p[a + 1];
          const dz = p[b + 2] - p[a + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          // Silk only pulls: slack it hangs loose.
          if (d <= seg.rest || d === 0) continue;
          const k = ((d - seg.rest) / (d * sum)) * (seg.kind === Kind.Spiral ? 0.8 : 1);
          p[a] += dx * k * wa;
          p[a + 1] += dy * k * wa;
          p[a + 2] += dz * k * wa;
          p[b] -= dx * k * wb;
          p[b + 1] -= dy * k * wb;
          p[b + 2] -= dz * k * wb;
        }
      }
    }
    // How sharply each point has been jolted, for what hangs on it: its speed over and above its own recent average,
    // so a web swaying in a steady breeze keeps its dew and only a pluck or a gust throws it off.
    for (let i = 0; i < this.count; i++) {
      const a = i * 3;
      const speed = Math.hypot(p[a] - q[a], p[a + 1] - q[a + 1], p[a + 2] - q[a + 2]) / dt;
      this.calm[i] += (speed - this.calm[i]) * 0.04;
      this.shaken[i] = Math.max(this.shaken[i] * 0.9, speed - this.calm[i] * 1.5);
    }
    if (this.grabbed >= 0) {
      for (const seg of this.segments) {
        if (!seg.alive) continue;
        const a = seg.a * 3;
        const b = seg.b * 3;
        const d = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
        if (d > seg.rest * (seg.kind === Kind.Spiral ? 1.9 : seg.kind === Kind.Hub ? 1.7 : 1.45)) {
          seg.alive = false;
          this.snapped.push({
            x: (p[a] + p[b]) / 2,
            y: (p[a + 1] + p[b + 1]) / 2,
            z: (p[a + 2] + p[b + 2]) / 2,
            kind: seg.kind
          });
        }
      }
    }
  }

  // The point nearest a ray, if the ray passes close enough to any.
  // The thread a ray passes closest to, if it passes within `within` (an angle, so the same on screen however far the
  // web), and the point of that thread nearest where it was touched. Only a press right on the silk takes hold: one in
  // the gaps between threads is left to turn the view.
  pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, within: number) {
    const p = this.position;
    let best = -1;
    let bestScore = within;
    let bestT = 0;
    for (const seg of this.segments) {
      if (!seg.alive) continue;
      const a = seg.a * 3;
      const b = seg.b * 3;
      // Closest approach between the ray and the thread, as two lines, the thread's end clamped.
      const ux = p[b] - p[a];
      const uy = p[b + 1] - p[a + 1];
      const uz = p[b + 2] - p[a + 2];
      const wx = p[a] - ox;
      const wy = p[a + 1] - oy;
      const wz = p[a + 2] - oz;
      const uu = ux * ux + uy * uy + uz * uz;
      const ud = ux * dx + uy * dy + uz * dz;
      const uw = ux * wx + uy * wy + uz * wz;
      const dw = dx * wx + dy * wy + dz * wz;
      const den = uu - ud * ud;
      const k = den > 1e-12 ? Math.max(0, Math.min(1, (ud * dw - uw) / den)) : 0;
      const qx = p[a] + ux * k - ox;
      const qy = p[a + 1] + uy * k - oy;
      const qz = p[a + 2] + uz * k - oz;
      const t = qx * dx + qy * dy + qz * dz;
      if (t <= 0) continue;
      const miss = Math.hypot(qx - dx * t, qy - dy * t, qz - dz * t) / t;
      if (miss < bestScore) {
        const end = k < 0.5 ? seg.a : seg.b;
        const other = k < 0.5 ? seg.b : seg.a;
        // The nearer end, unless it is tied to a twig.
        best = this.pinned[end] ? (this.pinned[other] ? -1 : other) : end;
        if (best < 0) continue;
        bestScore = miss;
        bestT = t;
      }
    }
    return best < 0 ? null : { node: best, distance: bestT };
  }

  // The way along the silk from one point to another, for the spider.
  path(from: number, to: number) {
    const came = new Int32Array(this.count).fill(-1);
    came[from] = from;
    const queue = [from];
    for (let h = 0; h < queue.length; h++) {
      const n = queue[h];
      if (n === to) break;
      for (const s of this.around[n]) {
        const seg = this.segments[s];
        if (!seg.alive) continue;
        const m = seg.a === n ? seg.b : seg.a;
        if (came[m] >= 0 || this.pinned[m]) continue;
        came[m] = n;
        queue.push(m);
      }
    }
    if (came[to] < 0) return [];
    const route = [to];
    while (route[route.length - 1] !== from) route.push(came[route[route.length - 1]]);
    return route.reverse();
  }
}
