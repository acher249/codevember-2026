// A quilted oven mitt dropped flat on the counter: the hand a puffy pillow, the thumb its own sewn piece crossing into
// it, both with top and underside meeting at a piped seam round the edge. Its frame: x from the cuff (0) to the
// fingertips (+x), z across, y up from the counter. uv: the quilting's own coordinates (the thumb's run its own way, as a
// separate piece's do). Tag: how far inside the edge, for the piping.

import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import * as THREE from "three/webgpu";
import { noise2 } from "./paper";
import { surface } from "./surface";

// About 30 cm long, 16 across the hand; a little over 2 cm thick.
export const MITT = { length: 1.15, half: 0.32, thumb: { from: [0.4, 0.2], turn: 0.62, length: 0.42, half: 0.105 } };
// Where the edge's seam runs (above the counter), how much the top and the underside puff, and over what width.
const SEAM = 0.022;
const PUFF_TOP = 0.07;
const PUFF_UNDER = 0.02;
const ROUND = 0.09;

// A pillow over rows along x: at each x the half-width `half(x)`, so every row runs from edge to edge (no grid points
// thrown outside the outline). The fingertip end is a superellipse.
function pillow(length: number, half: (x: number) => number, place: (x: number, z: number) => [number, number], fine: boolean, seed: number) {
  const nu = fine ? 72 : 32;
  const nv = fine ? 30 : 14;
  const edge = (x: number, z: number) => {
    const h = half(x);
    // The cuff is pressed shut as the mitt lies flat, so it too meets at the seam.
    return Math.max(0, Math.min(h - Math.abs(z), x * 1.2, (length - x) * 1.5));
  };
  const lump = (x: number, z: number) => 0.012 * noise2(x * 4 + seed, z * 4 - seed) + 0.006 * noise2(x * 9 - seed, z * 9);
  const build = (top: boolean) =>
    surface(
      nu,
      nv,
      (i, j) => {
        // Rows bunched toward the ends, where the outline turns fastest.
        const t = i / nu;
        const x = length * (0.5 - 0.5 * Math.cos(t * Math.PI));
        const s = (j / nv) * 2 - 1;
        const z = s * half(x);
        const e = edge(x, z);
        const r = Math.min(1, e / ROUND);
        const round = Math.sqrt(1 - (1 - r) * (1 - r));
        const y = top ? SEAM + PUFF_TOP * round + lump(x, z) * round : Math.max(0.0008, SEAM - PUFF_UNDER * round - SEAM * 0.9 * round * round);
        const [px, pz] = place(x, z);
        return { p: [px, y, pz], uv: [x, z], tag: e };
      },
      () => new THREE.Vector3(0, top ? 1 : -1, 0)
    );
  return [build(true), build(false)];
}

export function ovenMitt(fine: boolean) {
  const { length, half, thumb } = MITT;
  // The hand: a little narrower at the cuff, widest across the palm, rounded to the fingertips.
  const handHalf = (x: number) => {
    const tip = length - half * 1.05;
    const body = half * (0.86 + 0.14 * Math.min(1, x / 0.5));
    if (x <= tip) return body;
    const u = Math.min(1, (x - tip) / (length - tip));
    return body * Math.pow(Math.max(0, 1 - Math.pow(u, 2.4)), 1 / 2.4);
  };
  const hand = pillow(length, handHalf, (x, z) => [x, z], fine, 3.1);
  // The thumb: from inside the palm out at an angle, rounded at both ends.
  const c = Math.cos(thumb.turn);
  const s = Math.sin(thumb.turn);
  const thumbHalf = (x: number) => {
    const u = Math.abs(x / thumb.length - 0.5) * 2;
    return thumb.half * Math.pow(Math.max(0, 1 - Math.pow(u, 3)), 1 / 3);
  };
  const thumbParts = pillow(thumb.length, thumbHalf, (x, z) => [thumb.from[0] + x * c - z * s, thumb.from[1] + x * s + z * c], fine, 7.7);
  const g = mergeGeometries([...hand, ...thumbParts]);
  [...hand, ...thumbParts].forEach((p) => p.dispose());
  return g;
}
