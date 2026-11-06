// With gravity past zero a rock does not fly away. It rises to its own height over where it was, and hangs there,
// turning about its own centre so slowly that you only notice if you watch for it.

export type Hover = { ceiling: number | null; height: number; phase: number };

export const HOVER_SPIN = 0.025;

export const makeHover = (rand: () => number): Hover => ({ ceiling: null, height: 0.75 + rand() * 1.5, phase: rand() * 6.28 });

// Where it means to be at this moment, with a slow bob on top of its height.
export const hoverLevel = (hover: Hover, clock: number) => (hover.ceiling ?? 0) + Math.sin(clock * 0.7 + hover.phase) * 0.09 + Math.sin(clock * 0.31 + hover.phase * 2.3) * 0.05;

export function hoverBody(rigid: any, hover: Hover, gravity: number, clock: number) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const at = rigid.translation();
  if (hover.ceiling === null) hover.ceiling = at.y + hover.height;
  const climb = 0.35 + Math.min(1, -gravity) * 2.4;
  const wanted = Math.max(-climb, Math.min(climb, (hoverLevel(hover, clock) - at.y) * 1.4));
  const v = rigid.linvel();
  // Knocked sideways it glides on for a moment, then comes to rest in the air wherever that left it.
  const sideways = Math.hypot(v.x, v.z);
  const glide = 0.975 * (sideways > 2.5 ? 2.5 / sideways : 1);
  rigid.setLinvel({ x: v.x * glide, y: v.y + (wanted - v.y) * 0.12, z: v.z * glide }, true);
  const w = rigid.angvel();
  rigid.setAngvel({ x: w.x * 0.96, y: w.y + (HOVER_SPIN - w.y) * 0.04, z: w.z * 0.96 }, true);
}

// Whatever is moving near the small rocks, which rest when they have arrived and have to be woken in time to be hit.
export type Pusher = { x: number; y: number; z: number; reach: number };
export const pushers = new Set<Pusher>();
