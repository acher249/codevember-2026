// The forest's ground and its clearing, as plain arithmetic (no three.js), so the rock's workers, the page and the
// forest's own builders all read the same numbers. The cliff's face runs along x at about z = 0, facing +z; the clearing
// opens in front of it, and the forest closes round it on both sides and behind.

// The clearing: a small oval in front of the face, a few metres of open ground with the wood close round it, its back
// edge a couple of metres behind where you start.
export const CLEARING = { x: 0.6, z: 6.5, rx: 6.5, rz: 7.5 };

// The way from where you start (index.tsx START, z = 10.5) to the face, kept clear of anything that would stand in front
// of the eye.
export const PATH = { x0: 0.6, z0: 10.5, x1: 0.6, z1: 1.0, r: 2.2 };
export function onPath(x: number, z: number, room = 0) {
  const dx = PATH.x1 - PATH.x0;
  const dz = PATH.z1 - PATH.z0;
  const t = Math.max(0, Math.min(1, ((x - PATH.x0) * dx + (z - PATH.z0) * dz) / (dx * dx + dz * dz)));
  // And a wider ring round where you stand at first, so looking back the wood is not hidden behind a leaf.
  return Math.hypot(x - PATH.x0 - dx * t, z - PATH.z0 - dz * t) < PATH.r + room || Math.hypot(x - PATH.x0, z - PATH.z0) < 3.2 + room;
}

// How far outside the clearing's edge a point on the ground lies, in metres (negative inside).
export function clearingEdge(x: number, z: number) {
  const dx = (x - CLEARING.x) / CLEARING.rx;
  const dz = (z - CLEARING.z) / CLEARING.rz;
  // The edge wanders a little, so the clearing is no drawn oval.
  const a = Math.atan2(dz, dx);
  const wobble = 1 + Math.sin(a * 3 + 0.7) * 0.07 + Math.sin(a * 5 - 1.3) * 0.04;
  return (Math.hypot(dx, dz) / wobble - 1) * Math.min(CLEARING.rx, CLEARING.rz);
}

function hash2(x: number, y: number) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + 977) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Value noise from -1 to 1.
export function noise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let u = x - xi;
  let v = y - yi;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

function fbm(x: number, y: number, octaves: number) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f + o * 17.3, y * f - o * 9.1);
    f *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The forest floor's height. In the clearing it rolls gently, enough to read as ground and never enough to stumble
// over; into the trees it swells into banks and hollows, rising round the clearing so the woods close in above it;
// and it banks up against the foot of the face, where the scree has gathered.
export function forestGround(x: number, z: number) {
  const edge = clearingEdge(x, z);
  const wild = smooth(-3, 9, edge);
  const roll = fbm(x * 0.055, z * 0.055, 3) * (0.9 + wild * 1.8);
  const swell = fbm(x * 0.16 + 4, z * 0.16 - 2, 2) * (0.18 + wild * 0.5);
  const fine = noise(x * 0.7, z * 0.7) * 0.035;
  // The forest's floor stands higher than the clearing's, so the trees rise round it.
  const bank = smooth(-1, 14, edge) * 1.1;
  const scree = Math.exp(-Math.max(0, z) * 0.45) * 0.35;
  return roll + swell + fine + bank + scree - 0.25;
}

// Keeping the visitor in the clearing: a soft wall at its edge. Inside, nothing; near the edge, the step outward is
// eased away more and more, and past it the ground leans you gently back in, so you slow and stop rather than hit
// anything. Only out in the open air: underground, the rock is the wall.
const BOUND = { soft: 1.6, give: 0.6 };
export function keepInClearing(position: { x: number; z: number }, velocity: { x: number; z: number }, dt: number) {
  const e = clearingEdge(position.x, position.z);
  if (e < -BOUND.soft) return 0;
  // Outward, along the edge's gradient.
  const h = 0.05;
  let gx = clearingEdge(position.x + h, position.z) - clearingEdge(position.x - h, position.z);
  let gz = clearingEdge(position.x, position.z + h) - clearingEdge(position.x, position.z - h);
  const len = Math.hypot(gx, gz) || 1;
  gx /= len;
  gz /= len;
  // How much of the outward speed survives: all of it a pace and a half inside, none at the edge.
  const out = velocity.x * gx + velocity.z * gz;
  const hold = smooth(-BOUND.soft, 0, e);
  if (out > 0) {
    velocity.x -= gx * out * hold;
    velocity.z -= gz * out * hold;
  }
  // Past the edge, eased back in, faster the further out.
  if (e > 0) {
    const back = Math.min(e, (e * 3 + 0.4) * dt);
    position.x -= gx * back;
    position.z -= gz * back;
  }
  // Never more than a little past it.
  const over = clearingEdge(position.x, position.z) - BOUND.give;
  if (over > 0) {
    position.x -= gx * over;
    position.z -= gz * over;
  }
  return hold;
}
