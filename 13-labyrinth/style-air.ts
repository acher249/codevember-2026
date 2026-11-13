import { exp, float, length, max, mix, normalize, positionWorld, cameraPosition, smoothstep, uniform } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The air every style but the natural one draws through, shared by styles.ts and what the styles add of their own.
// The eye opens up down in the paths (see Adapt in life.tsx). A style that sets its own brightness takes that back out.
export const steady = uniform(1);

export const toEye = (): any => normalize(positionWorld.sub(cameraPosition));
export const away = (): any => length(positionWorld.sub(cameraPosition));

// Into the style's own air with distance, and wholly gone where the natural mist would hide the edge of what is drawn.
// The bent world thins every style's air as it does the natural mist, so the maze can be seen rising up into the sky; the
// edge of what is drawn goes out with it, through the natural mist's own `far`.
export const thinned = uniform(1);
export const farOut = uniform(48);
export function fogged(rgb: any, fog: any, density: number): any {
  const far = farOut as any;
  const d = away();
  const amount = max(float(1).sub(exp(d.mul(-density).mul(thinned))), smoothstep(far.mul(0.6), far, d));
  return mix(rgb, fog, amount);
}

