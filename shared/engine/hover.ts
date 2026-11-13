import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three/webgpu";
import { cameraTaken, orbitPoint } from "./controls";
import { walking } from "./walk";

// How long the hover takes to come in, at the start and after each change between flying and walking.
const EASE_IN = 2;
// On foot it is gentler, under the walk's own sway.
const ON_FOOT = 0.45;

// The eye always hangs a little in the air and drifts: a slow rise and fall, a little sway, and the point it looks at
// wandering a touch, so the view breathes, laid over whatever the controls or the walk do and never stopped by them.
// Flying, it moves the camera and the point it orbits together by the change in the drift each frame, so the controls
// are never fought or wound up. Walking, the walk places the eye outright each frame, so the drift is added whole on top.
// While the camera is carried up out of the maze it is left alone, and the drift comes back in once it is handed over.
export function Hover() {
  const camera = useThree((state) => state.camera);
  const run = useRef({
    mode: "",
    amount: 0,
    time: 0,
    body: new THREE.Vector3(),
    look: new THREE.Vector3(),
    nextBody: new THREE.Vector3(),
    nextLook: new THREE.Vector3(),
    aim: new THREE.Vector3()
  });

  useFrame((_, rawDelta) => {
    const state = run.current;
    const delta = Math.min(rawDelta, 0.1);
    const at = orbitPoint.current;
    const mode = walking.on ? "walk" : at && !cameraTaken.current ? "fly" : "";
    if (mode !== state.mode) {
      state.mode = mode;
      state.amount = 0;
      state.body.set(0, 0, 0);
      state.look.set(0, 0, 0);
    }
    if (!mode || !at) return;
    state.amount = Math.min(1, state.amount + delta / EASE_IN);
    state.time += delta;
    const t = state.time;
    // Sized to the scene: as much as it is at about eight metres from what is looked at, less the closer the eye, so a
    // study of something small drifts by a hair rather than swinging the view.
    const scale = mode === "walk" ? ON_FOOT : Math.min(1, camera.position.distanceTo(at) / 8);
    const k = state.amount * state.amount * (3 - 2 * state.amount) * scale;
    state.nextBody.set(Math.sin(t * 0.31) * 0.14, Math.sin(t * 0.5) * 0.2 + Math.sin(t * 0.23 + 1) * 0.08, Math.cos(t * 0.27) * 0.14).multiplyScalar(k);
    state.nextLook.set(Math.sin(t * 0.19 + 2) * 0.3, Math.sin(t * 0.37) * 0.12, Math.cos(t * 0.21) * 0.3).multiplyScalar(k);
    if (mode === "walk") {
      // Turned toward a point a few metres ahead, nudged by the drift, from the eye nudged by it.
      camera.getWorldDirection(state.aim).multiplyScalar(6).add(camera.position).add(state.nextLook).add(state.nextBody);
      camera.position.add(state.nextBody);
      camera.lookAt(state.aim);
    } else {
      const move = state.body.subVectors(state.nextBody, state.body);
      const turn = state.look.subVectors(state.nextLook, state.look).add(move);
      camera.position.add(move);
      at.add(turn);
      camera.lookAt(at);
    }
    camera.updateMatrixWorld();
    state.body.copy(state.nextBody);
    state.look.copy(state.nextLook);
    // After everything else that moves the camera this frame, the controls and a day's walk included, and before the
    // frame is drawn.
  }, 0.5);
  return null;
}
