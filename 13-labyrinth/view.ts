import * as THREE from "three/webgpu";
import { orbitPoint } from "../shared/engine/controls";

// Where the camera stands for a study, and what it looks at.
export type StudyView = { position: [number, number, number]; target: [number, number, number]; fov?: number };

// Moves the camera to a study's view when that study is chosen.
export function goTo(camera: THREE.PerspectiveCamera, view: StudyView) {
  camera.position.set(...view.position);
  if (view.fov) {
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
  }
  orbitPoint.current?.set(...view.target);
  camera.lookAt(...view.target);
}

// What the camera can see, roughly, for leaving out what it cannot: a cone about where it looks, as wide as the view
// across its corners and a little more for the hover and a quick turn of the head, widened for each thing by the angle
// its own reach takes up. Things nearer than their reach always count as seen.
export type Sight = { x: number; y: number; z: number; forward: THREE.Vector3; half: number };
export const sight = (): Sight => ({ x: 0, y: 0, z: 0, forward: new THREE.Vector3(0, 0, -1), half: Math.PI });

export function aim(seen: Sight, camera: THREE.PerspectiveCamera) {
  seen.x = camera.position.x;
  seen.y = camera.position.y;
  seen.z = camera.position.z;
  camera.getWorldDirection(seen.forward);
  const up = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  seen.half = Math.atan(Math.hypot(up, up * camera.aspect)) + 0.12;
}

export function inSight(seen: Sight, x: number, y: number, z: number, reach: number) {
  const dx = x - seen.x;
  const dy = y - seen.y;
  const dz = z - seen.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < reach) return true;
  const along = (dx * seen.forward.x + dy * seen.forward.y + dz * seen.forward.z) / d;
  return along >= Math.cos(Math.min(Math.PI, seen.half + Math.asin(reach / d)));
}
