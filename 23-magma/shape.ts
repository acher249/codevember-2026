// The scene's shapes, shared by the processor (the lava, the bite, the crumbs) and the shaders. One unit is 25 cm: a
// pocket about 14 cm long is 0.56, so the engine's camera defaults (closest 0.4, the hover) suit it as they are.

// The paper plate: flat to FLAT, then a rim curving up to RIM at its edge, PLATE across. Its top is y = 0 in the middle,
// and it stands on the counter at COUNTER.
export const PLATE = 0.46;
export const FLAT = 0.34;
// A deep paper plate's rim, about 2.5 cm high: high enough for the sleeve to rest its back end on.
export const RIM = 0.1;
// Two paper towels crossed under the plate, 1.5 mm thick together: the plate (its underside at -0.0024) rests on them,
// and they on the counter. The plate, the pocket, the lava and the crumbs keep their heights; the counter is lowered by the towels.
export const PLATE_LIFT = 0.006;
// The kitchen counter's top, along the wall behind.
export const COUNTER = -0.0024 - PLATE_LIFT;
// The wall behind the counter (its backsplash), and the microwave standing against it about 29 cm behind the plate:
// centred at x, its door face at z = front.
export const BACKSPLASH_Z = -2.3;
export const MICROWAVE = { x: -0.4, front: -1.15, back: -2.25, width: 2.1, height: 1.12 };

export function plateHeight(r: number) {
  if (r <= FLAT) return 0;
  const t = Math.min(1, (r - FLAT) / (PLATE - FLAT));
  return RIM * t * t * (1.6 - 0.6 * t);
}

// The pocket: a puffy rounded oblong, LENGTH along its own x (the bitten end toward +x), WIDTH across, rising to HEIGHT,
// set on the plate at (X, Z) turned by YAW about the vertical. About 13 × 7 × 2.5 cm, as the photos: flat and oblong,
// its corners only a little rounded. It is not flat on the plate: its sleeve's back end rests up on the rim and the
// bitten end down on the floor (REST, solved below).
// Leaning: the sleeve's back end up on the plate's rim, the bitten end down on its floor (REST, solved below).
export const POCKET = { x: -0.03, z: -0.24, yaw: -1.12, length: 0.52, width: 0.28, height: 0.1, corner: 0.035 };
const cosYaw = Math.cos(POCKET.yaw);
const sinYaw = Math.sin(POCKET.yaw);

// The pocket's frame to the world: tilted by REST.tilt about its own across axis (back end up), lifted by REST.lift,
// then turned and placed. And back.
export function pocketToWorld(x: number, y: number, z: number, rest = REST): [number, number, number] {
  const c = Math.cos(rest.tilt);
  const s = Math.sin(rest.tilt);
  const ax = x * c + y * s;
  const ay = -x * s + y * c + rest.lift;
  return [POCKET.x + ax * cosYaw + z * sinYaw, ay, POCKET.z - ax * sinYaw + z * cosYaw];
}
export function worldToPocket(wx: number, wy: number, wz: number): [number, number, number] {
  const dx = wx - POCKET.x;
  const dz = wz - POCKET.z;
  const ax = dx * cosYaw - dz * sinYaw;
  const z = dx * sinYaw + dz * cosYaw;
  const ay = wy - REST.lift;
  const c = Math.cos(REST.tilt);
  const s = Math.sin(REST.tilt);
  return [ax * c - ay * s, ax * s + ay * c, z];
}

// A point on the plate (world x, z) in the pocket's own frame, taken on the pocket's underside, and back.
export function toPocket(x: number, z: number): [number, number] {
  const dx = x - POCKET.x;
  const dz = z - POCKET.z;
  const ax = dx * cosYaw - dz * sinYaw;
  return [ax / Math.cos(REST.tilt), dx * sinYaw + dz * cosYaw];
}
export function fromPocket(x: number, z: number): [number, number] {
  const ax = x * Math.cos(REST.tilt);
  return [POCKET.x + ax * cosYaw + z * sinYaw, POCKET.z - ax * sinYaw + z * cosYaw];
}

// Signed distance to the pocket's outline in its own frame: negative inside.
export function outline(x: number, z: number) {
  const hx = POCKET.length / 2 - POCKET.corner;
  const hz = POCKET.width / 2 - POCKET.corner;
  const qx = Math.abs(x) - hx;
  const qz = Math.abs(z) - hz;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - POCKET.corner;
}

// The crimped lip round the edge is this wide; inside it the pastry puffs up.
// The edge is pressed flat this wide (about a centimetre), top and bottom sealed together.
export const LIP = 0.042;
// How thick the pastry is: a thin crisp shell over a layer of soft bread.
export const CRUST = 0.012;
export const SHELL = 0.006;
export const BREAD = 0.022;

// The pastry's top and bottom over the pocket's own frame, from how far inside the outline a point is (depth >= 0).
export function topHeight(depth: number, x: number, z: number) {
  const lip = 0.014;
  // A soft rounded seam, rising into the filled middle and rounded over the top: a puffy loaf, thickest in the middle.
  const rise = 1 - Math.exp(-Math.max(0, depth - LIP * 0.3) / 0.035);
  // Lumpy, as a filled pocket is: uneven bulges where the filling sits, and a sag between them.
  const lumps = 1 + 0.09 * Math.sin(x * 13.1 + 0.7) * Math.cos(z * 11.3 + 0.4) + 0.06 * Math.sin(x * 27 + z * 19) + 0.04 * Math.cos(x * 41 - z * 33);
  return lip + (POCKET.height - lip) * rise * lumps;
}
export function bottomHeight(depth: number) {
  return 0.002 + 0.006 * (1 - Math.exp(-depth / 0.05));
}

// Bites, in the pocket's own frame: a round bite from a mouth (centre, radius), its edge scalloped by teeth.
export type Bite = { x: number; z: number; r: number };
export const MAX_BITES = 3;
export const TEETH = 0.011;

// A bite's edge is torn, not stamped: soft uneven dents where the teeth pressed, and a ragged tear at three smaller
// scales, each seeded by the bite so no two look alike; and the top crust bitten further back than the bottom (y, the
// height in the pocket). The shaders use the same sums, so the pastry, its cut walls and the lava agree.
export function biteRadius(bite: Bite, a: number, y = 0.02) {
  const dent = 0.5 + 0.5 * Math.sin(a * 9 + bite.r * 40);
  // An uneven bite: lopsided at the largest scale (one side bitten deeper), then torn finer.
  const tear =
    0.008 * Math.sin(a * 3 + bite.z * 17) +
    0.005 * Math.sin(a * 5 + bite.x * 29) +
    0.004 * Math.sin(a * 13 + bite.x * 97 + bite.r * 13) +
    0.0012 * Math.sin(a * 41 + bite.z * 131) +
    0.0006 * Math.sin(a * 71 + bite.r * 211);
  return bite.r - TEETH * 0.35 * dent * dent - tear + (y - 0.05) * 0.12;
}
export function biteDistance(bite: Bite, x: number, z: number, y = 0.02) {
  const dx = x - bite.x;
  const dz = z - bite.z;
  return Math.hypot(dx, dz) - biteRadius(bite, Math.atan2(dz, dx), y);
}

// The next bite, from where the last one left the end: each bigger, and further in, aimed across at z.
export function nextBite(count: number, z: number): Bite {
  const r = 0.1 + 0.018 * count;
  const reach = 0.075 + 0.055 * count;
  return { x: POCKET.length / 2 + r - reach, z: Math.max(-0.06, Math.min(0.06, z * 0.6)), r };
}

export function bitten(bites: Bite[], x: number, z: number) {
  let d = Infinity;
  for (const b of bites) d = Math.min(d, biteDistance(b, x, z));
  return d;
}

// The sleeve: a card tube round the pocket's far end, from SLEEVE.from to SLEEVE.to along the pocket.
// A real paperboard sleeve, snug round the pocket: its outer width and its height at the top's folded edges, its top
// rising to a centre crease (a shallow tent, as the board is folded down the middle), sharp folds at the corners, and
// the board about half a millimetre thick.
export const SLEEVE = { from: -0.32, to: 0.05, width: 0.302, height: 0.104, tent: 0.01, corner: 0.012, board: 0.002 };

// The sleeve's outline round the pocket (z across, y up), outside: from the middle of its underside round by +z, the
// side, the top's fold, up the top to the crease and down the other side, back to the middle. The sides and top bow
// outward a touch between their folds, as board does.
export function sleeveProfile(): [number, number][] {
  const w = SLEEVE.width / 2;
  const h = SLEEVE.height;
  const c = SLEEVE.corner;
  const points: [number, number][] = [];
  const arc = (cz: number, cy: number, from: number) => {
    for (let k = 1; k <= 6; k++) {
      const a = from + (k / 6) * (Math.PI / 2);
      points.push([cz + Math.cos(a) * c, cy + Math.sin(a) * c]);
    }
  };
  const run = (z0: number, y0: number, z1: number, y1: number, steps: number, bow: [number, number]) => {
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const b = Math.sin(t * Math.PI) * 0.0018;
      points.push([z0 + (z1 - z0) * t + bow[0] * b, y0 + (y1 - y0) * t + bow[1] * b]);
    }
  };
  points.push([0, 0]);
  run(0, 0, w - c, 0, 6, [0, 0]);
  arc(w - c, c, -Math.PI / 2);
  run(w, c, w, h - c, 8, [1, 0]);
  arc(w - c, h - c, 0);
  // Up to the crease, then down the other side: two flat panels meeting at a ridge.
  run(w - c, h, 0, h + SLEEVE.tent, 10, [0, 1]);
  run(0, h + SLEEVE.tent, -w + c, h, 10, [0, 1]);
  arc(-w + c, h - c, Math.PI / 2);
  run(-w, h - c, -w, c, 8, [-1, 0]);
  arc(-w + c, c, Math.PI);
  run(-w + c, 0, 0, 0, 6, [0, 0]);
  return points;
}

// The inside of the sleeve's top at z (its own frame), and half its inside width: the pastry is squeezed under these.
export function sleeveInnerTop(z: number) {
  const w = SLEEVE.width / 2 - SLEEVE.corner;
  return SLEEVE.height + SLEEVE.tent * Math.max(0, 1 - Math.abs(z) / w) - SLEEVE.board;
}
export const SLEEVE_INNER_HALF = SLEEVE.width / 2 - SLEEVE.board;
// How fully the sleeve holds the pastry at x along it: wholly inside, easing to nothing a little past its mouth.
export function squeezeAt(x: number) {
  if (x <= SLEEVE.to) return 1;
  const t = Math.min(1, (x - SLEEVE.to) / 0.012);
  return 1 - t * t * (3 - 2 * t);
}

// How the pocket rests: points on the underside of the sleeve and the pastry, each of which must stay on or above the
// plate (its fluting stands about 1.6 mm proud, so with a margin for it). For each tilt, the lift that just clears them
// all; the resting tilt is the one that brings the middle lowest, as gravity would: the bitten end down on the floor and
// the sleeve's back end up on the rim.
// Just clear of the plate (0.1 mm), plus the fluting's height where the rim is fluted.
const CLEAR = 0.0013;
function undersides() {
  const points: [number, number, number][] = [];
  for (let i = 0; i <= 40; i++) {
    const x = SLEEVE.from + (i / 40) * (SLEEVE.to - SLEEVE.from);
    for (let j = 0; j <= 8; j++) points.push([x, 0.001, -SLEEVE.width / 2 + SLEEVE.corner + (j / 8) * (SLEEVE.width - 2 * SLEEVE.corner)]);
  }
  for (let i = 0; i <= 52; i++) {
    for (let j = 0; j <= 28; j++) {
      const x = -POCKET.length / 2 + (i / 52) * POCKET.length;
      const z = -POCKET.width / 2 + (j / 28) * POCKET.width;
      const d = -outline(x, z);
      if (d >= 0) points.push([x, bottomHeight(d), z]);
    }
  }
  return points;
}
export function clearance(rest: { tilt: number; lift: number }, points = undersides()) {
  let least = Infinity;
  for (const [x, y, z] of points) {
    const [wx, wy, wz] = pocketToWorld(x, y, z, rest);
    const r = Math.hypot(wx, wz);
    least = Math.min(least, wy - plateHeight(r) - (r > FLAT + 0.02 ? 0.0016 : 0));
  }
  return least;
}
function solveRest() {
  const points = undersides();
  let best = { tilt: 0, lift: 0, middle: Infinity };
  for (let tilt = 0; tilt <= 0.45; tilt += 0.0015) {
    // The lift that leaves the closest point exactly CLEAR above the plate.
    const lift = CLEAR - clearance({ tilt, lift: 0 }, points);
    const middle = pocketToWorld(0, 0.04, 0, { tilt, lift })[1];
    if (middle < best.middle) best = { tilt, lift, middle };
  }
  return { tilt: best.tilt, lift: best.lift };
}
export const REST: { tilt: number; lift: number } = { tilt: 0, lift: 0 };
Object.assign(REST, solveRest());

// What the counter's mirror (High) draws: only the plate and what is on it. The room comes into the marble from the
// captured cube; drawn again in the mirror, every material in the kitchen compiled a second time at load.
export const MIRROR_LAYER = 7;
export function mirrored<T extends { traverse: (each: (o: { layers: { enable: (layer: number) => void } }) => void) => void }>(object: T) {
  object.traverse((o) => o.layers.enable(MIRROR_LAYER));
  return object;
}
