"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useSetting, useSettingAction } from "../../shared/engine/settings";
import { useBed, useEvery } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Coast } from "./coast";
import { Fog, fogNoise, veil } from "./fog";
import { EYE, groundHeight, LAMP, LOOK } from "./shape";
import { bell, foghorn, hush, wash } from "./sound";
import { makeStir } from "./stir";

// Veil: a lighthouse on a headland at night, across a cove, and a fog bank lying over the sea and the land. The beams
// sweep round through it as solid shafts; the lantern glows in it. Drag through the fog to sweep it aside and see the
// coast, the cove and its bell buoy; it drifts on the wind and rolls back in.

// The lighthouse's beams go round once in this many seconds.
const TURN = 16;
// How far off a drag can reach to sweep fog.
const REACH = 260;

const scratch = { ray: new THREE.Raycaster(), ndc: new THREE.Vector2(), point: new THREE.Vector3(), toEye: new THREE.Vector3(), beam: new THREE.Vector3() };

// Where a ray first meets the ground or the sea, stepping out along it, within reach; or null.
function landing(ray: THREE.Ray, out: THREE.Vector3) {
  let step = 0.5;
  for (let t = 1; t < REACH; t += step) {
    out.copy(ray.origin).addScaledVector(ray.direction, t);
    if (out.y < Math.max(0, groundHeight(out.x, out.z))) return t;
    step = Math.min(4, step * 1.08);
  }
  return null;
}

function Scene() {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl);
  const noise = useMemo(() => fogNoise(), []);
  const stir = useMemo(() => makeStir(), []);
  const amount = useSetting<number>("fog");
  const wind = useSetting<number>("wind");
  const moon = useMemo(() => {
    const light = new THREE.DirectionalLight("#8fa3c4", 0.35);
    light.position.copy(veil.moon.value).multiplyScalar(200);
    return light;
  }, []);

  const state = useRef({
    clock: 0,
    held: false,
    pointer: { x: 0, y: 0 },
    last: null as THREE.Vector3 | null,
    lastHush: 0,
    earned: false
  });

  useGrabbable({
    pick: (ray) => {
      const t = landing(ray, scratch.point);
      if (t === null) return null;
      return { distance: t, point: scratch.point.clone() };
    },
    grab: () => {
      state.current.held = true;
      state.current.last = null;
      dismissPrompt();
    },
    drag: () => {},
    release: () => {
      state.current.held = false;
      state.current.last = null;
    }
  });

  // The pointer, followed so the sweep goes where the hand goes.
  useEffect(() => {
    const el = gl.domElement;
    const move = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      state.current.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      state.current.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };
    el.addEventListener("pointerdown", move);
    el.addEventListener("pointermove", move);
    return () => {
      el.removeEventListener("pointerdown", move);
      el.removeEventListener("pointermove", move);
    };
  }, [gl]);

  const horn = () => foghorn(1, -0.45);
  useSettingAction("horn", horn);
  // The horn calls on its own every half minute or so; the sea washes in; the buoy's bell rings as it rocks.
  useEvery(24, 36, horn);
  useEvery(4, 8, () => wash(0.7 + Math.random() * 0.5, (Math.random() - 0.5) * 0.8));
  useEvery(5, 12, () => bell(0.6 + Math.random() * 0.4, 0.35));
  useBed("wind", 0.05 + wind * 0.04);

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __veil: { state, stir, veil, camera } });

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const s = state.current;
    s.clock += dt;
    veil.time.value = s.clock;
    veil.amount.value += (amount - veil.amount.value) * (1 - Math.exp(-dt * 1.5));
    // The wind off the sea, toward the shore and a little across.
    const wx = 1.6 * wind;
    const wz = 2.4 * wind;
    veil.drift.value.x -= wx * dt;
    veil.drift.value.z -= wz * dt;
    veil.drift.value.y += 0.15 * dt;
    stir.step(dt, wx, wz);
    veil.lamp.value.copy(LAMP);
    veil.turn.value = (s.clock / TURN) * Math.PI * 2;

    // The lamp flares as a beam comes round to face the eye.
    scratch.toEye.copy(camera.position).sub(LAMP).normalize();
    let facing = 0;
    for (const side of [1, -1]) {
      scratch.beam.set(Math.cos(veil.turn.value) * side, -veil.dip.value, Math.sin(veil.turn.value) * side).normalize();
      facing = Math.max(facing, scratch.beam.dot(scratch.toEye));
    }
    veil.flare.value = Math.pow(Math.max(0, facing), 60);

    // A drag wipes the fog aside along the line of sight, from near the eye out to where the pointer lands, as a hand
    // wipes a misted window: so the coast shows through wherever it goes. Wider further out, moving as the hand moves.
    if (s.held && dt > 0) {
      scratch.ndc.set(s.pointer.x, s.pointer.y);
      scratch.ray.setFromCamera(scratch.ndc, camera);
      const reach = landing(scratch.ray.ray, scratch.point) ?? REACH;
      const here = scratch.point.copy(scratch.ray.ray.origin).addScaledVector(scratch.ray.ray.direction, reach).clone();
      const vx = s.last ? (here.x - s.last.x) / dt : 0;
      const vz = s.last ? (here.z - s.last.z) / dt : 0;
      for (let t = 6; t < reach; ) {
        const radius = 2 + t * 0.07;
        const f = t / reach;
        const x = scratch.ray.ray.origin.x + scratch.ray.ray.direction.x * t;
        const z = scratch.ray.ray.origin.z + scratch.ray.ray.direction.z * t;
        // Only where the ray is low enough to be in the fog.
        if (scratch.ray.ray.origin.y + scratch.ray.ray.direction.y * t < 60) stir.sweep(x, z, vx * f, vz * f, radius);
        t += radius * 0.6;
      }
      if (s.last) {
        const speed = Math.hypot(vx, vz) / (reach * 0.05 + 1);
        if (speed > 1 && s.clock - s.lastHush > 0.18) {
          s.lastHush = s.clock;
          scratch.point.copy(here).project(camera);
          hush(Math.min(1, speed / 12), THREE.MathUtils.clamp(scratch.point.x, -0.9, 0.9));
        }
      }
      s.last = here;
    }
    if (!s.earned && s.clock > 20 && stir.cleared() > 0.06) {
      s.earned = true;
      followPrompt.earn("veil");
      shareResult.set("Swept a fog bank off the sea to find the lighthouse");
    }
  });

  return (
    <>
      <primitive object={moon} />
      <hemisphereLight args={["#1b2436", "#050608", 0.35]} />
      <pointLight position={[LAMP.x, LAMP.y, LAMP.z]} color="#ffe2b0" intensity={260} distance={0} decay={2} />
      <Suspense fallback={null}>
        <Coast noise={noise} />
      </Suspense>
      <Fog stir={stir} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [EYE.x, EYE.y, EYE.z],
    target: [LOOK.x, LOOK.y, LOOK.z],
    fov: 50,
    limits: { turn: { left: 55, right: 55, up: 25, down: 12 }, move: { left: 3, right: 3, down: 1, up: 3, nearer: 6, further: 6 } }
  },
  hover: true,
  extents: { centre: [LOOK.x, LOOK.y, LOOK.z], radius: 140, floor: 2, color: "#0a0f18" },
  // Black behind: the fog is laid over the finished frame in its own pass, and the sky is a dome.
  look: { background: "#000000", exposure: 1.0, bloom: 0.5, bloomThreshold: 1.0, gi: 0, ao: 0.6, vignette: 0.55, grain: 0.03, haze: 0 },
  passes: { bounce: false, haze: false, veil: true },
  settings: {
    fog: { type: "range", label: "Fog", min: 0.3, max: 2, step: 0.01, value: 1, reset: 1 },
    wind: { type: "range", label: "Wind", min: 0, max: 2, step: 0.01, value: 1, reset: 1 },
    horn: { type: "action", label: "Sound the foghorn" }
  },
  phoneDock: ["fog", "wind"],
  phonePills: ["horn"],
  prompt: { title: "Drag through the fog", detail: "Sweep it aside to see the coast", low: true },
  hint: "Drag across the fog to sweep it aside; it drifts on the wind and rolls back in. The lighthouse's beams sweep round through it.",
  notes: "A lighthouse on a headland at night, across a cove, with a fog bank rolling in off the sea. Its beams sweep through the fog as shafts of light; sweep the fog aside with your hand.",
  Scene
};

export default day;

