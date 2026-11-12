"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { cameraTaken, orbitPoint } from "./controls";
import { worldShifted } from "./extents";
import { sound } from "./sound";

// Everything solid near a point, as boxes standing on the ground: each given by its extent across x and z and how high its
// top stands. A day hands over whatever is there within `reach` of x, z.
export type Solids = (x: number, z: number, reach: number, add: (minX: number, minZ: number, maxX: number, maxZ: number, top: number) => void) => void;

// Whether someone is walking, for anything that wants to look different close up: `amount` runs from 0 in the air to 1
// on foot, easing between, and `walkAmount` is the same for shaders.
export const walking = { on: false, amount: 0 };
export const walkAmount = uniform(0);

type WalkProps = {
  on: boolean;
  solids: Solids;
  // Eye height, and the field of view on foot.
  eye?: number;
  fov?: number;
  // Where flying again rises to: this high, this far back from where the walker stood, looking at a point this far ahead.
  overview?: { height: number; back: number; ahead: number };
  // Which footstep sound, one of the `step` shot's kinds.
  steps?: string;
};

const RADIUS = 0.42;
// Anything lower than this is stepped over.
const KNEE = 0.45;
const PACE = 1.6;
const JOG = 3.5;
// How far one step carries, walking and jogging.
const STRIDE = 0.72;
const JOG_STRIDE = 1.05;
const LOOK_SPEED = 0.0042;
const WALK_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

// First-person walking for a day with ground to stand on: down to eye height, drag to look round, WASD or the arrows to
// walk (Shift to jog), and on a touch screen, hold still to walk the way you face. While walking it takes the camera from
// the rig, keeps the orbit point where the eye rests, and hands both back on rising again.
export function Walk({ on, solids, eye = 1.65, fov: walkFov = 42, overview = { height: 6, back: 6, ahead: 9 }, steps = "gravel" }: WalkProps) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const dom = useThree((state) => state.gl.domElement) as HTMLCanvasElement;

  const state = useRef({
    mode: "fly" as "fly" | "down" | "walk" | "up",
    // Where a move between flying and walking began and ends, and how far along it is.
    t: 0,
    length: 1,
    fromPosition: new THREE.Vector3(),
    fromQuaternion: new THREE.Quaternion(),
    fromFov: 40,
    flyFov: 40,
    toPosition: new THREE.Vector3(),
    toQuaternion: new THREE.Quaternion(),
    toTarget: new THREE.Vector3(),
    // Where the walker stands, on the ground, and which way they face.
    position: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    velocity: new THREE.Vector3(),
    travelled: 0,
    steps: 0,
    focus: 4,
    keys: new Set<string>(),
    holding: false
  });

  const scratch = useMemo(
    () => ({
      euler: new THREE.Euler(0, 0, 0, "YXZ"),
      forward: new THREE.Vector3(),
      wish: new THREE.Vector3(),
      look: new THREE.Vector3(),
      probe: new THREE.Vector3()
    }),
    []
  );

  // Moves a point out of anything solid it stands in, by no more than `most` from any one thing, so a hedge that grows up
  // through the walker eases them aside rather than throwing them.
  const resolve = (p: THREE.Vector3, most: number) => {
    solids(p.x, p.z, RADIUS + 2, (minX, minZ, maxX, maxZ, top) => {
      if (top < KNEE) return;
      const nx = Math.min(maxX, Math.max(minX, p.x));
      const nz = Math.min(maxZ, Math.max(minZ, p.z));
      const dx = p.x - nx;
      const dz = p.z - nz;
      const d = Math.hypot(dx, dz);
      if (d > 1e-6) {
        if (d >= RADIUS) return;
        const out = Math.min(RADIUS - d, most);
        p.x += (dx / d) * out;
        p.z += (dz / d) * out;
        return;
      }
      // Right inside: out by the shortest way.
      const ways = [p.x - minX, maxX - p.x, p.z - minZ, maxZ - p.z];
      const way = ways.indexOf(Math.min(...ways));
      const out = Math.min(ways[way] + RADIUS, most);
      if (way === 0) p.x -= out;
      else if (way === 1) p.x += out;
      else if (way === 2) p.z -= out;
      else p.z += out;
    });
  };

  // How far the eye can see ahead before something solid, up to a limit.
  const clearAhead = (from: THREE.Vector3, direction: THREE.Vector3, limit: number) => {
    const { probe } = scratch;
    let hit = limit;
    for (let d = 0.4; d < limit; d += 0.3) {
      probe.copy(from).addScaledVector(direction, d);
      if (probe.y <= 0) return d;
      let inside = false;
      solids(probe.x, probe.z, 0.1, (minX, minZ, maxX, maxZ, top) => {
        if (top >= probe.y && probe.x >= minX && probe.x <= maxX && probe.z >= minZ && probe.z <= maxZ) inside = true;
      });
      if (inside) {
        hit = d;
        break;
      }
    }
    return hit;
  };

  // Starts the move down to the ground, or back up into the air.
  useEffect(() => {
    const run = state.current;
    const { forward } = scratch;
    if (on === (run.mode === "walk" || run.mode === "down")) return;
    run.fromPosition.copy(camera.position);
    run.fromQuaternion.copy(camera.quaternion);
    run.fromFov = camera.fov;
    run.t = 0;
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    if (on) {
      if (run.mode === "fly") run.flyFov = camera.fov;
      run.mode = "down";
      cameraTaken.current = true;
      // Somewhere clear to stand, as near below the camera as there is.
      run.position.set(camera.position.x, 0, camera.position.z);
      for (let i = 0; i < 6; i++) resolve(run.position, Infinity);
      run.toPosition.set(run.position.x, eye, run.position.z);
      // Facing the most open way, favouring the way the camera faced, so the first sight is down a path, not into a wall.
      const heading = Math.atan2(-forward.x, -forward.z);
      let best = -1;
      for (let i = 0; i < 24; i++) {
        const yaw = heading + (i / 24) * Math.PI * 2;
        scratch.look.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        const score = clearAhead(run.toPosition, scratch.look, 14) * (0.75 + 0.25 * Math.cos(yaw - heading));
        if (score > best) {
          best = score;
          run.yaw = yaw;
        }
      }
      run.pitch = -0.04;
      run.velocity.set(0, 0, 0);
      run.length = 1 + Math.min(1, Math.max(0, camera.position.y - eye) / 40);
    } else {
      run.mode = "up";
      run.toTarget.copy(camera.position).addScaledVector(forward, overview.ahead).setY(1.2);
      run.toPosition.copy(camera.position).addScaledVector(forward, -overview.back).setY(overview.height);
      run.length = 1.3;
    }
    walking.on = on;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, camera]);

  // Gives the camera back to the rig if the day goes while walking.
  useEffect(
    () => () => {
      cameraTaken.current = false;
      walking.on = false;
      walking.amount = 0;
      walkAmount.value = 0;
    },
    []
  );

  // An endless world carried back under the walker carries everything they are moving between with it.
  useEffect(() => {
    const run = state.current;
    const listener = (shift: THREE.Vector3) => {
      for (const point of [run.fromPosition, run.toPosition, run.toTarget, run.position]) point.add(shift);
    };
    worldShifted.add(listener);
    return () => {
      worldShifted.delete(listener);
    };
  }, []);

  // Drag to look round; on a touch screen, a press held still walks forward until it lifts.
  useEffect(() => {
    const run = state.current;
    const drag = { id: -1, x: 0, y: 0, startX: 0, startY: 0, timer: 0 };
    const active = () => run.mode === "walk" || run.mode === "down";
    const onDown = (event: PointerEvent) => {
      if (!active() || drag.id !== -1 || (event.pointerType === "mouse" && event.button !== 0)) return;
      Object.assign(drag, { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
      if (event.pointerType !== "mouse") {
        window.clearTimeout(drag.timer);
        drag.timer = window.setTimeout(() => {
          if (drag.id !== -1 && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 10) run.holding = true;
        }, 260);
      }
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== drag.id || !active()) return;
      // The same way round as the orbit: drag right to look right, drag down to look down.
      run.yaw -= (event.clientX - drag.x) * LOOK_SPEED;
      run.pitch = Math.max(-1.3, Math.min(1.3, run.pitch - (event.clientY - drag.y) * LOOK_SPEED));
      drag.x = event.clientX;
      drag.y = event.clientY;
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== drag.id) return;
      drag.id = -1;
      window.clearTimeout(drag.timer);
      run.holding = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (!WALK_KEYS.has(event.code)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const element = event.target as HTMLElement | null;
      // Not while typing; a slider or the switch just pressed to start walking can keep the focus.
      if (element?.tagName === "INPUT" && !["range", "checkbox"].includes((element as HTMLInputElement).type)) return;
      if (event.type === "keydown") run.keys.add(event.code);
      else run.keys.delete(event.code);
    };
    const onBlur = () => {
      run.keys.clear();
      run.holding = false;
    };
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerup", onUp);
    dom.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.clearTimeout(drag.timer);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [dom]);

  useFrame((_, rawDelta) => {
    const run = state.current;
    if (run.mode === "fly") return;
    const delta = Math.min(rawDelta, 1 / 20);
    const { euler, forward, wish, look } = scratch;

    if (run.mode === "walk" || run.mode === "down") {
      // Walking, along the ground the way the walker faces.
      const held = (...codes: string[]) => (codes.some((code) => run.keys.has(code)) ? 1 : 0);
      const jogging = held("ShiftLeft", "ShiftRight") === 1;
      const ahead = Math.max(held("KeyW", "ArrowUp"), run.holding ? 1 : 0) - held("KeyS", "ArrowDown");
      const across = held("KeyD", "ArrowRight") - held("KeyA", "ArrowLeft");
      forward.set(-Math.sin(run.yaw), 0, -Math.cos(run.yaw));
      wish.set(-forward.z, 0, forward.x).multiplyScalar(across).addScaledVector(forward, ahead);
      if (wish.lengthSq() > 1) wish.normalize();
      if (run.mode === "down") wish.set(0, 0, 0);
      run.velocity.lerp(wish.multiplyScalar(jogging ? JOG : PACE), 1 - Math.exp(-delta * 8));
      const moved = run.velocity.length() * delta;
      run.position.addScaledVector(run.velocity, delta);
      resolve(run.position, moved + 1.5 * delta);
      resolve(run.position, moved + 1.5 * delta);

      // A step each stride, each foot from its own side, a little harder when jogging.
      const speed = run.velocity.length();
      run.travelled += moved / (speed > (PACE + JOG) / 2 ? JOG_STRIDE : STRIDE);
      if (Math.floor(run.travelled) > run.steps) {
        run.steps = Math.floor(run.travelled);
        const side = run.steps % 2 ? 1 : -1;
        const hard = Math.min(1, speed / JOG);
        sound.play("step", { variant: steps, gain: 0.22 + hard * 0.25 + Math.random() * 0.08, pitch: 0.9 + Math.random() * 0.2 - hard * 0.06, pan: side * 0.15 });
      }
      // The head dips as each foot lands, and more for a jog.
      const bob = (Math.cos(run.travelled * Math.PI * 2) - 1) * 0.5 * Math.min(1, speed / PACE) * (0.022 + Math.min(1, speed / JOG) * 0.025);

      euler.set(run.pitch, run.yaw, 0);
      look.set(0, 0, -1).applyEuler(euler);
      const eyeAt = scratch.probe.set(run.position.x, eye + bob, run.position.z);
      if (run.mode === "walk") {
        camera.position.copy(eyeAt);
        camera.quaternion.setFromEuler(euler);
        camera.fov += (walkFov - camera.fov) * (1 - Math.exp(-delta * 4));
      } else {
        // Dropping down to it.
        run.toPosition.copy(eyeAt);
        run.toQuaternion.setFromEuler(euler);
        run.t = Math.min(1, run.t + delta / run.length);
        const k = smoother(run.t);
        camera.position.lerpVectors(run.fromPosition, run.toPosition, k);
        camera.quaternion.slerpQuaternions(run.fromQuaternion, run.toQuaternion, k);
        camera.fov = THREE.MathUtils.lerp(run.fromFov, walkFov, k);
        walking.amount = k;
        if (run.t >= 1) run.mode = "walk";
      }
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      // The point looked at rests on whatever the eye meets, so focus and anything keyed to the view follow it.
      run.focus += (Math.max(1.5, clearAhead(camera.position, look, 9)) - run.focus) * (1 - Math.exp(-delta * 6));
      orbitPoint.current?.copy(camera.position).addScaledVector(look, run.focus);
    } else {
      // Rising back up into the air, to look down over where the walker was.
      run.t = Math.min(1, run.t + delta / run.length);
      const k = smoother(run.t);
      camera.position.copy(run.toPosition);
      camera.lookAt(run.toTarget);
      run.toQuaternion.copy(camera.quaternion);
      camera.position.lerpVectors(run.fromPosition, run.toPosition, k);
      camera.quaternion.slerpQuaternions(run.fromQuaternion, run.toQuaternion, k);
      camera.fov = THREE.MathUtils.lerp(run.fromFov, run.flyFov, k);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      walking.amount = 1 - k;
      // The orbit point slides out to where the rig will pick it up.
      orbitPoint.current?.lerp(run.toTarget, k);
      if (run.t >= 1) {
        run.mode = "fly";
        orbitPoint.current?.copy(run.toTarget);
        cameraTaken.current = false;
      }
    }
    if (run.mode === "walk") walking.amount = 1;
    walkAmount.value = walking.amount;
  });

  return null;
}
