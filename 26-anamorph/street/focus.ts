import * as THREE from "three/webgpu";
import { float, length, max, mix, screenUV, smoothstep, uniform, vec2 } from "three/tsl";
import { focusDistance } from "../../shared/engine/Post";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model swizzles. */

// The lens at the spot: the drawing and the sidewalk round it sharp, the street going soft from BEYOND metres out and
// softer all the way to FULL, the far end of the block and the glow past it. Every painting together covers this
// stretch of sidewalk (x0, x1, z0, z1), with some room round it.
const PAINTINGS = { x0: -1.83, x1: 1.76, z0: -5.06, z1: 0.52, room: 0.35 };
const BEYOND = 10;
const FULL = 45;
// Away from the spot, walking or circling round the drawing: sharp a few metres past it (AHEAD of the focus, and never
// nearer than SOFT_FROM), the street going soft from there and fully so by FULL_AWAY.
const AHEAD = 4;
const SOFT_FROM = 8;
const FULL_AWAY = 35;
// The depth of field's range, as index.tsx sets it: the blur is full that far past the focus.
const RANGE = 9;

// How much of the spot's lens is on (1 at the spot, none away from it).
const hold = uniform(0);
// The view's rays through the corners of the screen (top left, top right, bottom left, bottom right) and its eye.
const corners = [uniform(new THREE.Vector3()), uniform(new THREE.Vector3()), uniform(new THREE.Vector3()), uniform(new THREE.Vector3())];
const eye = uniform(new THREE.Vector3());

// The distances the blur reads, reshaped at the spot. Whatever is seen through the drawing's stretch of sidewalk (found
// by where the view's ray meets the ground, so a hole sunk into it, or a thing standing up out of it, counts the same as
// the chalk of it, and the two blur alike: not at all) is held at the focus, and so is everything nearer than BEYOND;
// past that the distance is reshaped so the blur comes on soon after and then keeps growing, more slowly, until FULL
// (by the square root of the way there). Away from the spot the same, from just past the drawing, and sooner.
export function spotDepth(viewZ: any) {
  const ray: any = mix(mix(corners[0], corners[1], screenUV.x), mix(corners[2], corners[3], screenUV.x), screenUV.y);
  const ground: any = eye.add(ray.mul(eye.y.div(ray.y.negate().max(1e-4))));
  const centre = vec2((PAINTINGS.x0 + PAINTINGS.x1) / 2, (PAINTINGS.z0 + PAINTINGS.z1) / 2);
  const half = vec2((PAINTINGS.x1 - PAINTINGS.x0) / 2 + PAINTINGS.room, (PAINTINGS.z1 - PAINTINGS.z0) / 2 + PAINTINGS.room);
  const outside = length(max(ground.xz.sub(centre).abs().sub(half), 0));
  const inside = smoothstep(0.3, 0, outside).mul(smoothstep(0, -0.02, ray.y));
  const seen = viewZ.negate();
  const from = mix((focusDistance as any).add(AHEAD).max(SOFT_FROM), float(BEYOND), hold);
  const full = mix(float(FULL_AWAY), float(FULL), hold);
  const along = seen.sub(from).div(full.sub(from)).clamp(0, 1).sqrt();
  return mix((focusDistance as any).add(along.mul(RANGE)), focusDistance, inside.mul(hold)).negate();
}

// Each frame: the view's corner rays, and how near the spot it is.
const at = new THREE.Vector3();
export function aimSpotFocus(camera: THREE.Camera, near: number) {
  hold.value = near;
  eye.value.setFromMatrixPosition(camera.matrixWorld);
  [
    [-1, 1],
    [1, 1],
    [-1, -1],
    [1, -1]
  ].forEach(([x, y], i) => corners[i].value.copy(at.set(x, y, 0.5).unproject(camera).sub(eye.value)));
}
