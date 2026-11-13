"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { cameraTaken, flyFov, orbitPoint } from "./controls";
import { rushAmount } from "./Post";
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
  // Which footstep sound, one of the `step` shot's kinds.
  steps?: string;
};

const RADIUS = 0.42;
// Anything lower than this is stepped over.
const KNEE = 0.45;
const PACE = 2.4;
const JOG = 5.25;
// How far one step carries, walking and jogging.
const STRIDE = 0.72;
const JOG_STRIDE = 1.05;
const LOOK_SPEED = 0.0042;
// A jump, under a gravity much lighter than ours: up about five metres, well over a hedge, and a long drift down.
const GRAVITY = 4;
const LEAP = Math.sqrt(2 * GRAVITY * 3.75);
const WALK_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", "Space"]);

// Moves `current` toward `target` on a critically damped spring taking about `time` seconds, carrying `velocity`.
function damp(current: THREE.Vector3, target: THREE.Vector3, velocity: THREE.Vector3, time: number, delta: number) {
  const omega = 2 / time;
  const x = omega * delta;
  const fade = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  for (const axis of ["x", "y", "z"] as const) {
    const change = current[axis] - target[axis];
    const pull = (velocity[axis] + omega * change) * delta;
    velocity[axis] = (velocity[axis] - omega * pull) * fade;
    current[axis] = target[axis] + (change + pull) * fade;
  }
}

// First-person walking for a day with ground to stand on: down to eye height, drag to look round, WASD or the arrows to
// walk (Shift to jog), Space to jump, and on a touch screen, hold still to walk the way you face, with a button to jump. While walking it takes the camera from
// the rig, keeps the orbit point where the eye rests, and hands both back on rising again.
export function Walk({ on, solids, eye = 1.65, fov: walkFov = 42, steps = "gravel" }: WalkProps) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const dom = useThree((state) => state.gl.domElement) as HTMLCanvasElement;

  const state = useRef({
    mode: "fly" as "fly" | "walk" | "up",
    // Where rising back up began and ends.
    flyFov: 40,
    toPosition: new THREE.Vector3(),
    toQuaternion: new THREE.Quaternion(),
    toTarget: new THREE.Vector3(),
    // How fast the camera is carried on rising back up, so that it eases off from however it was moving.
    lift: new THREE.Vector3(),
    rising: 0,
    // How flat out the walker is running, 0 at a walk to 1 at a full sprint, eased.
    sprint: 0,
    // Where the walker stands, on the ground, and which way they face.
    position: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    velocity: new THREE.Vector3(),
    // How high the feet are off the ground, how fast they rise, and whether they stand on something.
    height: 0,
    rise: 0,
    grounded: true,
    // How much longer a press of jump waits to be used: one just before landing still jumps.
    jump: 0,
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
  const resolve = (p: THREE.Vector3, most: number, feet = 0) => {
    solids(p.x, p.z, RADIUS + 2, (minX, minZ, maxX, maxZ, top) => {
      if (top < feet + KNEE) return;
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

  // What the feet would rest on at a point: the top of anything under it no higher than a step up, or the ground.
  const floorAt = (p: THREE.Vector3, feet: number) => {
    let floor = 0;
    solids(p.x, p.z, RADIUS + 0.5, (minX, minZ, maxX, maxZ, top) => {
      if (top > feet + KNEE || p.x < minX - RADIUS * 0.5 || p.x > maxX + RADIUS * 0.5 || p.z < minZ - RADIUS * 0.5 || p.z > maxZ + RADIUS * 0.5) return;
      floor = Math.max(floor, top);
    });
    return floor;
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
    if (on === (run.mode === "walk")) return;
    if (on) {
      if (run.mode === "fly") run.flyFov = flyFov.current;
      // No ride down: walking starts right where the eye is, looking the way it looks, and the walker falls from there
      // into the maze, onto whatever is under them, a path or a hedge's top.
      run.mode = "walk";
      cameraTaken.current = true;
      run.position.set(camera.position.x, 0, camera.position.z);
      scratch.euler.setFromQuaternion(camera.quaternion, "YXZ");
      run.yaw = scratch.euler.y;
      run.pitch = Math.max(-1.3, Math.min(1.3, scratch.euler.x));
      // Already moving up or down, as on leaving a rise back up halfway, it carries on that way.
      const falling = Math.max(0, camera.position.y - eye);
      Object.assign(run, { height: falling, rise: run.lift.y, grounded: falling < 0.05, jump: 0 });
      run.velocity.set(run.lift.x, 0, run.lift.z);
    } else {
      run.mode = "up";
      // Up just clear of the hedges, about a metre over the tallest top near by, looking exactly the way the walker looked:
      // the eye and the point it looks at rise together, so the view lifts without turning. Already higher, as at the top
      // of a jump, it is not brought down.
      let tallest = 0;
      solids(camera.position.x, camera.position.z, 3, (_minX, _minZ, _maxX, _maxZ, top) => (tallest = Math.max(tallest, top)));
      run.toPosition.copy(camera.position).setY(Math.max(camera.position.y, tallest + 0.9));
      scratch.euler.set(run.pitch, run.yaw, 0, "YXZ");
      run.toQuaternion.setFromEuler(scratch.euler);
      run.toTarget.set(0, 0, -1).applyEuler(scratch.euler).multiplyScalar(8).add(run.toPosition);
      run.rising = 0;
      // Eases off from however the walker was moving, a jump's rise included.
      run.lift.set(run.velocity.x, run.grounded ? 0 : run.rise, run.velocity.z);
    }
    walking.on = on;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, camera]);

  // On a touch screen, a button to jump while walking.
  useEffect(() => {
    if (!on || !window.matchMedia("(pointer: coarse)").matches) return;
    const button = document.createElement("button");
    button.className = "cv-jump";
    button.type = "button";
    button.textContent = "Jump";
    const press = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      state.current.jump = 0.25;
    };
    button.addEventListener("pointerdown", press);
    document.body.appendChild(button);
    return () => {
      button.removeEventListener("pointerdown", press);
      button.remove();
    };
  }, [on]);

  // Gives the camera back to the rig if the day goes while walking.
  useEffect(
    () => () => {
      cameraTaken.current = false;
      walking.on = false;
      walking.amount = 0;
      walkAmount.value = 0;
      rushAmount.value = 0;
    },
    []
  );

  // An endless world carried back under the walker carries everything they are moving between with it.
  useEffect(() => {
    const run = state.current;
    const listener = (shift: THREE.Vector3) => {
      for (const point of [run.toPosition, run.toTarget, run.position]) point.add(shift);
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
    const active = () => run.mode === "walk";
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
      if (event.code === "Space") {
        if (!active()) return;
        // Not to scroll the page, nor to flip the switch just pressed.
        event.preventDefault();
        if (event.type === "keydown" && !event.repeat) run.jump = 0.25;
        return;
      }
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

    if (run.mode === "walk") {
      // Walking, along the ground the way the walker faces.
      const held = (...codes: string[]) => (codes.some((code) => run.keys.has(code)) ? 1 : 0);
      const jogging = held("ShiftLeft", "ShiftRight") === 1;
      const ahead = Math.max(held("KeyW", "ArrowUp"), run.holding ? 1 : 0) - held("KeyS", "ArrowDown");
      const across = held("KeyD", "ArrowRight") - held("KeyA", "ArrowLeft");
      forward.set(-Math.sin(run.yaw), 0, -Math.cos(run.yaw));
      wish.set(-forward.z, 0, forward.x).multiplyScalar(across).addScaledVector(forward, ahead);
      if (wish.lengthSq() > 1) wish.normalize();
      run.velocity.lerp(wish.multiplyScalar(jogging ? JOG : PACE), 1 - Math.exp(-delta * 8));
      const moved = run.velocity.length() * delta;
      run.position.addScaledVector(run.velocity, delta);
      resolve(run.position, moved + 1.5 * delta, run.height);
      resolve(run.position, moved + 1.5 * delta, run.height);

      // Up and down: a jump from wherever the feet stand, falling slowly back to whatever is under them, a hedge's top
      // or the ground; walking off a hedge drops from it, and one growing underfoot lifts the walker with it.
      if (run.jump > 0 && run.grounded && run.mode === "walk") {
        run.jump = 0;
        run.rise = LEAP;
        run.grounded = false;
        sound.play("step", { variant: steps, gain: 2.6, pitch: 0.8 });
      }
      run.jump = Math.max(0, run.jump - delta);
      const floor = floorAt(run.position, run.height);
      if (run.grounded && floor < run.height - 0.05) run.grounded = false;
      if (!run.grounded) {
        run.rise -= GRAVITY * delta;
        run.height += run.rise * delta;
        if (run.height <= floor && run.rise <= 0) {
          sound.play("step", { variant: steps, gain: Math.min(3.6, 1.6 - run.rise * 0.32), pitch: 0.75 });
          run.height = floor;
          run.rise = 0;
          run.grounded = true;
        }
      } else run.height = floor;

      // A step each stride, each foot from its own side, a little harder when jogging.
      const speed = run.velocity.length();
      run.travelled += run.grounded ? moved / (speed > (PACE + JOG) / 2 ? JOG_STRIDE : STRIDE) : 0;

      if (Math.floor(run.travelled) > run.steps) {
        run.steps = Math.floor(run.travelled);
        const side = run.steps % 2 ? 1 : -1;
        const hard = Math.min(1, speed / JOG);
        sound.play("step", { variant: steps, gain: 1.5 + hard * 1.1 + Math.random() * 0.4, pitch: 0.9 + Math.random() * 0.2 - hard * 0.06, pan: side * 0.15 });
      }
      // The head dips as each foot lands, and more for a jog.
      const bob = (Math.cos(run.travelled * Math.PI * 2) - 1) * 0.5 * Math.min(1, speed / PACE) * (0.022 + Math.min(1, speed / JOG) * 0.025);

      euler.set(run.pitch, run.yaw, 0);
      look.set(0, 0, -1).applyEuler(euler);
      const eyeAt = scratch.probe.set(run.position.x, run.height + eye + bob, run.position.z);
      camera.position.copy(eyeAt);
      camera.quaternion.setFromEuler(euler);
      // Running flat out, the view widens a fifth more and its edges streak.
      run.sprint += (Math.max(0, Math.min(1, (speed - PACE) / (JOG - PACE))) - run.sprint) * (1 - Math.exp(-delta * 4));
      rushAmount.value = run.sprint;
      // On a phone held upright the same field would be a slot side to side, so it opens until it is about 65 degrees
      // across, short of turning into a fisheye.
      const upright = camera.aspect < 1 ? Math.min(105, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(32.5)) / camera.aspect))) : 0;
      camera.fov += (Math.max(walkFov, upright) * (1 + run.sprint * 0.2) - camera.fov) * (1 - Math.exp(-delta * 3));
      // Everything that looks different on foot eases over as the walker comes down, not all at once.
      walking.amount += (1 - walking.amount) * (1 - Math.exp(-delta * 2.5));
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      // The point looked at rests on whatever the eye meets, so focus and anything keyed to the view follow it.
      run.focus += (Math.max(1.5, clearAhead(camera.position, look, 9)) - run.focus) * (1 - Math.exp(-delta * 6));
      orbitPoint.current?.copy(camera.position).addScaledVector(look, run.focus);
    } else {
      // Rising back up into the air over where the walker was: carried there on a damped spring from however it was
      // moving, still looking the same way (only any sway of the walk is eased out).
      run.rising += delta;
      damp(camera.position, run.toPosition, run.lift, 0.45, delta);
      camera.quaternion.slerp(run.toQuaternion, 1 - Math.exp(-delta * 3.2));
      camera.fov += (run.flyFov - camera.fov) * (1 - Math.exp(-delta * 3.2));
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      walking.amount *= Math.exp(-delta * 3);
      run.sprint *= Math.exp(-delta * 4);
      rushAmount.value = run.sprint;
      // The orbit point rides out ahead of the eye to where the rig will pick it up.
      camera.getWorldDirection(look);
      orbitPoint.current?.copy(camera.position).addScaledVector(look, run.toPosition.distanceTo(run.toTarget));
      // Handed back once settled, or after a while whatever, so the controls can never be left out.
      const settled = camera.position.distanceToSquared(run.toPosition) < 1e-3 && camera.quaternion.angleTo(run.toQuaternion) < 5e-3 && run.lift.lengthSq() < 1e-3;
      if (settled || run.rising > 2.5) {
        run.mode = "fly";
        camera.position.copy(run.toPosition);
        camera.lookAt(run.toTarget);
        camera.fov = run.flyFov;
        camera.updateProjectionMatrix();
        walking.amount = 0;
        run.sprint = rushAmount.value = 0;
        run.lift.set(0, 0, 0);
        orbitPoint.current?.copy(run.toTarget);
        cameraTaken.current = false;
      }
    }
    walkAmount.value = walking.amount;
  });

  return null;
}
