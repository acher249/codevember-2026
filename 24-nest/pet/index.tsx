"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { cameraTaken, orbitControls, orbitPoint, useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useSettingAction, useSettingRef } from "../../shared/engine/settings";
import { StudioEnvironment } from "../../shared/engine/studio";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { createEgg, SHELLS } from "./egg";
import { SCREEN } from "./lcd";
import { Pet } from "./pet";
import { Bedroom, DESK_Y, LAMP } from "./room";
import { BACK_PIN, BUTTONS, SCREEN_Z, SOCKET_Z, TAB_SIZE } from "./shape";
import { click, roomTone, slide, voice } from "./sound";

// How far a button travels in, and how long C is held to start a new egg.
const TRAVEL = 0.11;
const HOLD_RESET = 1.4;
// The tab comes free once pulled this far out.
const FREE = TAB_SIZE.inside + 0.15;
// Gravity (cm/s²) for the tab once free, and the hang's swing: a pendulum the chain's length, gently damped.
const GRAVITY = 981;
const CENTRE = new THREE.Vector3(0, -0.2, 0);

type Part = { kind: "button"; k: number } | { kind: "tab" } | { kind: "pin" } | { kind: "screen" };

const scratch = { ray: new THREE.Ray(), inverse: new THREE.Matrix4(), box: new THREE.Box3(), hit: new THREE.Vector3(), sphere: new THREE.Sphere(), pull: new THREE.Vector3(), local: new THREE.Vector3(), q: new THREE.Quaternion() };

function Scene() {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  const shell = useSettingRef<string>("shell");
  const speed = useSettingRef<number>("speed");
  const egg = useMemo(() => createEgg(), []);
  // Freed with useDispose, not a bare cleanup: the development double mount would free it and keep the memo.
  useDispose(egg);
  const pet = useMemo(() => new Pet(), []);

  const state = useRef({
    pressed: [false, false, false],
    travel: [0, 0, 0],
    held: null as Part | null,
    heldFor: 0,
    resetDone: false,
    tab: "in" as "in" | "pulling" | "free" | "landed",
    pull: 0,
    grabY: 0,
    tabVel: new THREE.Vector3(),
    tabSpin: new THREE.Vector3(),
    landing: new THREE.Quaternion(),
    twist: 0,
    twistVel: 0,
    sway: new THREE.Vector2(),
    swayVel: new THREE.Vector2(),
    time: 0,
    lastSlide: 0,
    hatched: false,
    gone: false,
    room: null as null | (() => void)
  });
  const loose = useMemo(() => new THREE.Group(), []);

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __nest: { pet, egg, state: state.current, scene, camera } });

  // What a ray lands on, in the toy's own frame: the tab, a button (from the front), the reset pin (from the back), or
  // the screen while there is an egg on it to tap.
  const pick = (ray: THREE.Ray): { part: Part; distance: number; point: THREE.Vector3 } | null => {
    const s = state.current;
    let best: { part: Part; distance: number; point: THREE.Vector3 } | null = null;
    const consider = (part: Part, local: THREE.Ray, test: (r: THREE.Ray) => THREE.Vector3 | null, frame: THREE.Object3D) => {
      const at = test(local);
      if (!at) return;
      const world = at.clone().applyMatrix4(frame.matrixWorld);
      const distance = world.distanceTo(ray.origin);
      if (!best || distance < best.distance) best = { part, distance, point: world };
    };
    if (s.tab === "in" || s.tab === "pulling") {
      scratch.inverse.copy(egg.tab.matrixWorld).invert();
      const local = scratch.ray.copy(ray).applyMatrix4(scratch.inverse);
      // Only the part of the strip that is out, a little fattened for the hand.
      scratch.box.min.set(-TAB_SIZE.w / 2 - 0.08, 0.15 - s.pull, -0.12);
      scratch.box.max.set(TAB_SIZE.w / 2 + 0.08, TAB_SIZE.out + 0.08, 0.12);
      consider({ kind: "tab" }, local.clone(), (r) => r.intersectBox(scratch.box, new THREE.Vector3()), egg.tab);
    }
    scratch.inverse.copy(egg.body.matrixWorld).invert();
    const local = new THREE.Ray().copy(ray).applyMatrix4(scratch.inverse);
    if (local.direction.z < 0) {
      BUTTONS.forEach((b, k) => {
        scratch.sphere.set(new THREE.Vector3(b.x, b.y, SOCKET_Z[k] + 0.28), 0.5);
        consider({ kind: "button", k }, local, (r) => r.intersectSphere(scratch.sphere, new THREE.Vector3()), egg.body);
      });
      if (pet.mode === "egg") {
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -SCREEN_Z);
        consider(
          { kind: "screen" },
          local,
          (r) => {
            const at = r.intersectPlane(plane, new THREE.Vector3());
            return at && Math.abs(at.x) < SCREEN.w / 2 && Math.abs(at.y - SCREEN.y) < SCREEN.h / 2 ? at : null;
          },
          egg.body
        );
      }
    } else {
      scratch.sphere.set(BACK_PIN, 0.3);
      consider({ kind: "pin" }, local, (r) => r.intersectSphere(scratch.sphere, new THREE.Vector3()), egg.body);
    }
    return best;
  };

  const picked = useRef<Part | null>(null);
  useGrabbable({
    pick: (ray) => {
      const hit = pick(ray);
      picked.current = hit?.part ?? null;
      return hit ? { distance: hit.distance, point: hit.point } : null;
    },
    grab: (point) => {
      const s = state.current;
      const part = picked.current;
      if (!part) return;
      s.held = part;
      s.heldFor = 0;
      s.resetDone = false;
      // The room's radio comes on a moment after the first press, clear of the frame that wakes the sound.
      if (!s.room) {
        s.room = () => {};
        window.setTimeout(() => (s.room = roomTone()), 400);
      }
      if (part.kind === "button") {
        s.pressed[part.k] = true;
        click(true, part.k - 1);
        pet.press(part.k);
        // The press pushes the toy back on its chain, and turns it a touch.
        s.swayVel.x += 0.028;
        s.twistVel += (part.k - 1) * -0.25;
      } else if (part.kind === "tab") {
        s.tab = "pulling";
        s.grabY = egg.tabHome.worldToLocal(scratch.local.copy(point)).y - s.pull;
      } else if (part.kind === "pin") {
        click(true, 0);
        pet.reset();
      } else if (part.kind === "screen") {
        click(true, 0);
        pet.press(1);
        s.swayVel.x += 0.02;
      }
    },
    drag: (point) => {
      const s = state.current;
      if (s.held?.kind !== "tab" || s.tab !== "pulling") return;
      const y = egg.tabHome.worldToLocal(scratch.local.copy(point)).y - s.grabY;
      const pull = THREE.MathUtils.clamp(y, 0, FREE + 0.01);
      const now = performance.now();
      if (Math.abs(pull - s.pull) > 0.05 && now - s.lastSlide > 60) {
        slide(pull / FREE);
        s.lastSlide = now;
      }
      // The pull tugs the toy along a little.
      s.swayVel.y += (pull - s.pull) * -0.02;
      s.pull = pull;
      if (pull >= FREE) free();
    },
    release: () => {
      const s = state.current;
      if (s.held?.kind === "button") {
        s.pressed[s.held.k] = false;
        if (!s.resetDone) click(false, s.held.k - 1);
      }
      if (s.held?.kind === "tab" && s.tab === "pulling") s.tab = "in";
      s.held = null;
    }
  });

  // Out comes the tab: it drops away to the desk, and the contacts close.
  const free = () => {
    const s = state.current;
    s.tab = "free";
    s.held = null;
    egg.tab.updateWorldMatrix(true, false);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    egg.tab.matrixWorld.decompose(position, quaternion, new THREE.Vector3());
    loose.add(egg.tab);
    egg.tab.position.copy(position);
    egg.tab.quaternion.copy(quaternion);
    const out = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    s.tabVel.copy(out).multiplyScalar(28).add(new THREE.Vector3(0, 10, 4));
    s.tabSpin.set(3 + Math.random() * 3, 1.5, 5 * (Math.random() - 0.5));
    s.landing.setFromEuler(new THREE.Euler(-Math.PI / 2, 0.6 + Math.random() * 0.6, 0, "YXZ"));
    click(true, 0.6);
    pet.power();
    dismissPrompt();
    s.swayVel.y += 0.02;
  };

  useSettingAction("fresh", () => {
    if (pet.mode === "off") return;
    pet.reset();
  });

  useEffect(() => {
    const s = state.current;
    return () => {
      s.room?.();
      s.room = null;
    };
  }, []);

  // For testing in development: put the eye somewhere, looking at a point; or show every surface's normal as colour.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const normals = new THREE.MeshNormalNodeMaterial();
    Object.assign(globalThis, {
      __view: (from: number[], to: number[]) => {
        cameraTaken.current = true;
        camera.position.set(from[0], from[1], from[2]);
        orbitPoint.current?.set(to[0], to[1], to[2]);
        camera.lookAt(to[0], to[1], to[2]);
      },
      __normals: (on: boolean) => {
        scene.overrideMaterial = on ? normals : null;
      },
      // The share of each built mesh's normals that face away from its middle (should be all, bar the window's walls).
      __outward: () =>
        [...egg.halves, ...egg.buttons].map((mesh) => {
          const g = mesh.geometry;
          const p = g.attributes.position;
          const n = g.attributes.normal;
          g.computeBoundingBox();
          const c = g.boundingBox!.getCenter(new THREE.Vector3());
          let out = 0;
          for (let i = 0; i < p.count; i++) if ((p.getX(i) - c.x) * n.getX(i) + (p.getY(i) - c.y) * n.getY(i) + (p.getZ(i) - c.z) * n.getZ(i) > 0) out++;
          return Math.round((out / p.count) * 1000) / 10;
        })
    });
    return () => normals.dispose();
  }, [camera, scene, egg]);

  // The orbit: round the toy, never far, never through it.
  useEffect(() => {
    const c = orbitControls.current;
    if (!c) return;
    const kept = { minDistance: c.minDistance, maxDistance: c.maxDistance, minPolar: c.minPolarAngle, maxPolar: c.maxPolarAngle, pan: c.enablePan };
    c.minDistance = 7;
    c.maxDistance = 26;
    c.minPolarAngle = 0.75;
    c.maxPolarAngle = 2.05;
    c.enablePan = false;
    return () => {
      c.minDistance = kept.minDistance;
      c.maxDistance = kept.maxDistance;
      c.minPolarAngle = kept.minPolar;
      c.maxPolarAngle = kept.maxPolar;
      c.enablePan = kept.pan;
    };
  }, []);

  useFrame((_, raw) => {
    const dt = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1 / 20) : 0;
    const s = state.current;
    s.time += dt;
    egg.setShell(shell.current ?? "grape");

    // The pet, and its voice.
    pet.step(dt, speed.current ?? 1);
    for (const kind of pet.sounds) voice(kind);
    pet.sounds.length = 0;
    // C held: a new egg.
    if (s.held) s.heldFor += dt;
    if (s.held?.kind === "button" && s.held.k === 2 && s.heldFor > HOLD_RESET && !s.resetDone) {
      s.resetDone = true;
      pet.reset();
    }
    if (!s.hatched && (pet.mode === "hatch" || pet.mode === "life")) {
      s.hatched = true;
      shareResult.set("I hatched a little pixel nest-builder in Nest");
      followPrompt.earn("hatch");
    }
    if (pet.mode === "gone" && !s.gone) {
      s.gone = true;
      shareResult.set('I forgot to feed my virtual pet. It packed a tiny bindle and left me a note: "gone to find a nicer nest. bye"');
    } else if (pet.mode !== "gone") s.gone = false;
    pet.draw();
    egg.screen.update(pet, dt);

    // Buttons travel in quickly and spring back.
    egg.buttons.forEach((mesh, k) => {
      const target = s.pressed[k] ? TRAVEL : 0;
      s.travel[k] += (target - s.travel[k]) * (1 - Math.exp(-dt * (s.pressed[k] ? 60 : 30)));
      mesh.position.z = SOCKET_Z[k] - s.travel[k];
    });

    // The hang: turning slowly back and forth on the chain, swinging a little when pushed.
    const t = s.time;
    s.twistVel += (-s.twist * 1.6 - s.twistVel * 1.2) * dt;
    s.twist += s.twistVel * dt;
    egg.twist.rotation.y = 0.2 * Math.sin(t * 0.31) + 0.06 * Math.sin(t * 0.77 + 1.3) + s.twist;
    const w2 = GRAVITY / 34;
    s.swayVel.x += (-w2 * s.sway.x - s.swayVel.x * 1.1) * dt;
    s.swayVel.y += (-w2 * s.sway.y - s.swayVel.y * 1.1) * dt;
    s.sway.x += s.swayVel.x * dt;
    s.sway.y += s.swayVel.y * dt;
    egg.pivot.rotation.set(s.sway.x + Math.sin(t * 0.43) * 0.0025, 0, s.sway.y + Math.sin(t * 0.29 + 2) * 0.002);

    // The tab: pulled out along its length; once free, falling to the desk and lying there.
    if (s.tab === "in" || s.tab === "pulling") {
      if (s.tab === "in") s.pull = Math.max(0, s.pull - dt * 0.6);
      egg.tab.position.set(0, s.pull, 0);
    } else if (s.tab === "free") {
      s.tabVel.y -= GRAVITY * dt * 0.35;
      egg.tab.position.addScaledVector(s.tabVel, dt);
      scratch.q.setFromEuler(new THREE.Euler(s.tabSpin.x * dt, s.tabSpin.y * dt, s.tabSpin.z * dt));
      egg.tab.quaternion.multiply(scratch.q);
      if (egg.tab.position.y < DESK_Y + 0.05) {
        egg.tab.position.y = DESK_Y + 0.05;
        s.tab = "landed";
      }
    } else egg.tab.quaternion.slerp(s.landing, 1 - Math.exp(-dt * 18));

    egg.lampDir.value.set(...LAMP).normalize();
    egg.screen.place(egg.lcd);

    // A study of one thing: the orbit point drawn gently back to the toy, the eye carried with it; focus on the toy.
    const at = orbitPoint.current;
    if (at && !cameraTaken.current) {
      scratch.pull.copy(at).sub(CENTRE).multiplyScalar(-(1 - Math.exp(-dt * 0.8)));
      at.add(scratch.pull);
      camera.position.add(scratch.pull);
    }
    const focus = Math.max(4, camera.position.distanceTo(CENTRE));
    focusDistance.value = focus;
    focusBlur.value = 5.5;
  });

  return (
    <>
      <StudioEnvironment
        ambient="#07060a"
        intensity={0.7}
        boxes={[
          { position: [-6, 2, 3], scale: [2, 3, 3], color: "#ffb46a", intensity: 5 },
          { position: [6, 3, -4], scale: [1, 4, 3], color: "#8ea4ff", intensity: 1.1 },
          { position: [5, -1, -6], scale: [1, 2, 1], color: "#ff3f7a", intensity: 1.4 },
          { position: [0, 8, 0], scale: [10, 0.5, 10], color: "#2a2430", intensity: 0.6 }
        ]}
      />
      <primitive object={egg.pivot} />
      <primitive object={loose} />
      <Bedroom />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [3.7, 2.3, 18.4],
    target: [CENTRE.x, CENTRE.y - 0.45, CENTRE.z],
    fov: 32
  },
  hover: true,
  look: { background: "#000000", exposure: 1, bloom: 0.35, bloomThreshold: 0.85, gi: 0, ao: 0.6, aoRadius: 0.4, vignette: 0.5, grain: 0.025, haze: 0 },
  // A product macro: the toy sharp, the room melted behind it.
  passes: { haze: false, bounce: false, overlay: true, depthOfField: { range: 22 } },
  settings: {
    shell: {
      type: "choice",
      label: "Shell",
      options: Object.entries(SHELLS).map(([value, s]) => ({ value, label: value[0].toUpperCase() + value.slice(1), swatch: [s.candy, s.button] })),
      value: "grape"
    },
    speed: { type: "range", label: "Time speed", min: 0.5, max: 4, step: 0.1, value: 1 },
    fresh: { type: "action", label: "New egg" }
  },
  prompt: { title: "Pull the tab", detail: "Drag it out to switch the egg on", high: true },
  hint: "Drag the PULL tab out to switch it on. A picks, B chooses, C goes back; hold C (or poke the pin on the back) for a new egg. Drag anywhere else to turn it over.",
  notes: "A 90s keychain pet egg, hanging in a bedroom at night. Pull the tab, hatch it, and watch it build its nest. Keep it fed and happy, or it leaves.",
  Scene
};

export default day;
