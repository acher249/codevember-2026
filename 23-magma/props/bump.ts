// Relief from a procedural height, as a view-space normal. three's `bumpMap` only works on a texture: it finds the
// slope by sampling the texture again at offset coordinates, so for a height made of noise it reads the same value three
// times and returns the surface unchanged. Here the slope comes from the height's own screen-space derivatives
// (Mikkelsen's surface-gradient bump, unnormalised), so `height` is in world units: 0.004 stands 1 mm proud.

import { faceDirection, normalView, positionView } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

export function bump(height: any) {
  const dpx = (positionView as any).dFdx();
  const dpy = (positionView as any).dFdy();
  const n = normalView as any;
  const r1 = dpy.cross(n);
  const r2 = n.cross(dpx);
  const det = dpx.dot(r1).mul(faceDirection);
  const grad = det.sign().mul(height.dFdx().mul(r1).add(height.dFdy().mul(r2)));
  return det.abs().mul(n).sub(grad).normalize();
}
