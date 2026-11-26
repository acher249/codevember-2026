// The figure under the shroud, in metres, facing the eye (+z): seated on a low stool, head a little bowed, arms folded
// across her lap. Never drawn; only these shapes, spheres swept along segments, that the cloth comes to rest on. `breathes`
// marks the chest, which swells a little as she breathes in.
export type Collider = { a: number[]; b: number[]; r: number; breathes?: boolean };

const both = (a: number[], b: number[], r: number): Collider[] => [
  { a, b, r },
  { a: [-a[0], a[1], a[2]], b: [-b[0], b[1], b[2]], r }
];

const POSE: Collider[] = [
  // Head held high on a long neck, bowed a little forward, and the face's fall to the chin.
  { a: [0, 1.232, 0.025], b: [0, 1.2, 0.04], r: 0.096 },
  { a: [0, 1.15, 0.075], b: [0, 1.13, 0.085], r: 0.048 },
  // Brow, nose and chin, so the face shows through the cloth.
  { a: [-0.04, 1.232, 0.1], b: [0.04, 1.232, 0.1], r: 0.024 },
  // Cheekbones.
  ...both([0.05, 1.18, 0.085], [0.05, 1.18, 0.085], 0.03),
  { a: [0, 1.215, 0.118], b: [0, 1.17, 0.14], r: 0.017 },
  { a: [0, 1.115, 0.11], b: [0, 1.115, 0.11], r: 0.025 },
  { a: [0, 0.98, 0.0], b: [0, 1.12, 0.02], r: 0.05 },
  // Narrow shoulders falling from the neck; chest, waist, hips.
  ...both([0.03, 0.99, -0.01], [0.15, 0.955, -0.01], 0.052),
  { a: [-0.06, 0.85, 0.0], b: [0.06, 0.85, 0.0], r: 0.115, breathes: true },
  { a: [0, 0.58, -0.01], b: [0, 0.74, 0.0], r: 0.125 },
  { a: [-0.09, 0.5, -0.03], b: [0.09, 0.5, -0.03], r: 0.12 },
  // Thighs forward to the knees, shins down to the floor.
  ...both([0.1, 0.48, 0.0], [0.12, 0.49, 0.4], 0.075),
  ...both([0.12, 0.47, 0.42], [0.13, 0.05, 0.47], 0.055),
  // Her left arm down, its forearm across her lap; her right raised, its hand at her left shoulder, holding the cloth to her.
  { a: [0.18, 0.93, -0.01], b: [0.21, 0.72, 0.07], r: 0.043 },
  { a: [0.21, 0.72, 0.07], b: [-0.08, 0.6, 0.3], r: 0.038 },
  { a: [-0.18, 0.93, -0.01], b: [-0.18, 0.75, 0.13], r: 0.043 },
  { a: [-0.18, 0.75, 0.13], b: [0.1, 0.92, 0.13], r: 0.038 },
  { a: [0.1, 0.92, 0.13], b: [0.14, 0.96, 0.1], r: 0.035 },
  // The stool's back edge, so the cloth behind her does not fold in under the hips.
  { a: [-0.15, 0.42, -0.12], b: [0.15, 0.42, -0.12], r: 0.04 }
];

// She sits turned from the eye, to its left, so it sees her from off her left shoulder.
export const YAW = -0.75;
export const turned = (p: number[]) => [p[0] * Math.cos(YAW) + p[2] * Math.sin(YAW), p[1], -p[0] * Math.sin(YAW) + p[2] * Math.cos(YAW)];
export const untwisted = (p: number[]) => [p[0] * Math.cos(YAW) - p[2] * Math.sin(YAW), p[1], p[0] * Math.sin(YAW) + p[2] * Math.cos(YAW)];
export const BODY: Collider[] = POSE.map((c) => ({ ...c, a: turned(c.a), b: turned(c.b) }));

// The top of her head: where the cloth's middle comes to rest.
export const CROWN = turned([0, 1.332, 0.026]);

