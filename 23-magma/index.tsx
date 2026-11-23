"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { useDispose } from "../shared/engine/dispose";
import { cameraTaken, orbitControls, orbitPoint, useGrabbable } from "../shared/engine/controls";
import { focusBlur, focusDistance, postBypass } from "../shared/engine/Post";
import { dismissPrompt, resetPrompt } from "../shared/engine/prompt";
import { scenePhase, useQuality } from "../shared/engine/quality";
import { lehmer } from "../shared/engine/random";
import { useSettingAction, useSettingRef } from "../shared/engine/settings";
import { useBed } from "../shared/engine/sound";
import type { DayDefinition } from "../shared/engine/types";
import { followPrompt } from "../shared/ui/Follow";
import { shareResult } from "../shared/ui/Share";
import { createCrust } from "./crust";
import { PlateCrumbs, plateCrumbs } from "./crumbs";
import { createLava } from "./lava";
import { intro, Intro } from "./intro";
import { Kitchen, WindowLight } from "./kitchen";
import { Props } from "./props";
import { PizzaRolls, pizzaRolls } from "./rolls";
import { microwaveState } from "./props/microwave";
import { LavaSurface, magma, Plate, Pocket, useCrumbs, useLavaLight, usePuffs } from "./render";
import { BACKSPLASH_Z, bitten, COUNTER, MAX_BITES, MICROWAVE, nextBite, outline, pocketToWorld, SLEEVE, topHeight, worldToPocket } from "./shape";
import { crunch, ding, plop, sizzle } from "./sound";
import { clock } from "./time";

// A bright day, as Pendulum's studio: little bloom (only the lava passes its threshold), soft occlusion in the
// crags and folds, a light vignette.
// The lowest the eye may go: a little above the counter top.
const EYE_FLOOR = COUNTER + 0.05;

const LOOK = {
  // Black behind, as Pendulum's: the overlay pass (beams, dust, steam) is cleared to the background and added over the
  // whole frame, so any other colour here lays a veil over everything. The room closes round the view, so it never shows.
  background: "#000000",
  exposure: 0.95,
  bloom: 0.2,
  bloomThreshold: 0.92,
  // Bounce light on High (the lava's glow warming the pastry and plate, the white plate lifting the pocket's underside),
  // reaching about 6 cm, the scale of the plate; occlusion in the folds, the crumbs and under the rolls.
  gi: 3.2,
  giRadius: 0.25,
  ao: 1,
  aoRadius: 0.09,
  vignette: 0.25,
  grain: 0.02,
  haze: 0
};

function Scene() {
  const { tier } = useQuality();
  // Counts are set by the tier the visit starts on, so a later step down never rebuilds anything.
  const startTierRef = useRef(tier);
  const startTier = startTierRef.current;
  // A phone (a touch screen) or the Low tier is light: the lava's flow takes half the substeps, the pastry's baked
  // crust is a quarter the size (two 4096 × 2048 textures with mipmaps are about 128 MB, too much of a phone tab's
  // memory), and the rolls' physics steps coarser.
  const lightDevice = useMemo(() => startTier === "low" || (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches), [startTier]);
  const lava = useMemo(() => createLava(), []);
  lava.light = lightDevice;
  // The crust's textures, baked on the graphics card in the first frame (finer unless the visit starts on Low).
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const crust = useMemo(() => createCrust(!lightDevice), [lightDevice]);
  // Freed with useDispose, not a bare cleanup: the development double mount would free it and keep the memo.
  useDispose(crust);
  const bakeFrame = useRef(0);
  useFrame(() => {
    // A try every eighth frame until a read-back shows it took (bake() itself skips while one is being checked).
    if (!crust.baked && bakeFrame.current++ % 8 === 0) crust.bake(gl);
  }, -10);
  const crumbs = useCrumbs();
  const puffs = usePuffs();
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  if (process.env.NODE_ENV !== "production")
    Object.assign(globalThis, {
      __lava: lava,
      __camera: camera,
      __magma: magma,
      __magmaBite: (z = 0) => takeBite(z),
      __intro: intro,
      __mouth: () => {
        const b = lava.bites[lava.bites.length - 1];
        return b ? pocketToWorld(b.x - b.r, 0.035, b.z) : null;
      },
      __magmaParts: { crumbs: crumbs.mesh, puffs: puffs.mesh, scene, postBypass, crust }
    });

  // The microwave runs for a moment when the pocket appears, then dings: it is ready.
  const [cooking, setCooking] = useState(false);
  useBed("hum", cooking ? 0.3 : 0);
  const microwave = useRef(0);
  const cook = (then?: () => void) => {
    setCooking(true);
    microwaveState.cookingSince = performance.now();
    window.clearTimeout(microwave.current);
    microwave.current = window.setTimeout(() => {
      setCooking(false);
      ding();
      microwaveState.doneAt = performance.now();
      then?.();
    }, 1800);
  };
  const started = useRef(false);
  useEffect(() => () => window.clearTimeout(microwave.current), []);

  const flow = useRef({ since: 0, earned: false, nextSizzle: 0, nextPlop: 0, vent: 0 });

  // A bite at z across the end, if there is a bite left to take: the pastry there goes, crumbs fall, steam bursts out,
  // and the lava starts to run.
  const takeBite = (z: number) => {
    intro.stop();
    if (lava.bites.length >= MAX_BITES) return false;
    const bite = nextBite(lava.bites.length, z);
    lava.bite(bite);
    const k = lava.bites.length - 1;
    (magma.bites.array[k] as THREE.Vector4).set(bite.x, bite.z, bite.r, 1);
    // Crumbs and a puff of steam from where the bite went through the top.
    const [wx, wy, wz] = pocketToWorld(bite.x - bite.r * 0.85, 0.08, bite.z);
    crumbs.spawn(wx, wy, wz, 22);
    for (let n = 0; n < 26; n++) puffs.emit(wx + (Math.random() - 0.5) * 0.1, wy - 0.03 + Math.random() * 0.04, wz + (Math.random() - 0.5) * 0.12, 0, 0.07);
    crunch();
    dismissPrompt();
    flow.current.since = 0;
    return true;
  };

  // Pressing the bare end of the pocket bites it. The press is found by marching the ray over the pastry's own height
  // in the pocket's frame (a few hundred steps of arithmetic, nothing like a mesh raycast's cost).
  const local = useMemo(() => ({ o: new THREE.Vector3(), d: new THREE.Vector3(), hit: new THREE.Vector3() }), []);
  useGrabbable({
    pick: (r) => {
      // The ray in the pocket's own frame (turned, tilted and lifted as it rests).
      const { o, d } = local;
      o.set(...worldToPocket(r.origin.x, r.origin.y, r.origin.z));
      const [ex, ey, ez] = worldToPocket(r.origin.x + r.direction.x, r.origin.y + r.direction.y, r.origin.z + r.direction.z);
      d.set(ex - o.x, ey - o.y, ez - o.z);
      for (let t = 0; t < 3; t += 0.004) {
        const x = o.x + d.x * t;
        const y = o.y + d.y * t;
        const z = o.z + d.z * t;
        if (y < -0.05) break;
        const depth = -outline(x, z);
        if (depth < 0 || y > topHeight(depth, x, z)) continue;
        // Under the sleeve, or through a hole already bitten: no bite here.
        if (x < SLEEVE.to - 0.01) return null;
        if (lava.bites.length && bitten(lava.bites, x, z) < 0) continue;
        return { distance: t, point: r.at(t, local.hit).clone() };
      }
      return null;
    },
    grab: (point) => {
      takeBite(worldToPocket(point.x, point.y, point.z)[2]);
    },
    drag: () => {},
    release: () => {}
  });

  useSettingAction("fresh", () => {
    lava.reset();
    for (const v of magma.bites.array as THREE.Vector4[]) v.set(0, 0, 0, 0);
    crumbs.clear();
    plateCrumbs.reset();
    pizzaRolls.clear();
    resetPrompt();
    cook();
  });
  // Ten pizza rolls, microwaved and then tipped out onto the plate as it dings.
  useSettingAction("rolls", () => cook(() => pizzaRolls.add(10)));

  // For testing in development: put the eye somewhere from the console, looking at a point.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    // The rig is told the camera is taken, so its limits leave a test view where it is put.
    (globalThis as Record<string, unknown>).__view = (from: number[], to: number[]) => {
      cameraTaken.current = true;
      camera.position.set(from[0], from[1], from[2]);
      orbitPoint.current?.set(to[0], to[1], to[2]);
      camera.lookAt(to[0], to[1], to[2]);
    };
  }, [camera]);

  // The plate is on the counter against the wall: the orbit turns through the front half only (never through the
  // backsplash or the microwave), and never under the counter (the polar angle stops short of level); the zoom stays
  // inside the room. Put back as they were when the day goes.
  useEffect(() => {
    const c = orbitControls.current;
    if (!c) return;
    const kept = { maxPolar: c.maxPolarAngle, minDistance: c.minDistance, maxDistance: c.maxDistance, minAzimuth: c.minAzimuthAngle, maxAzimuth: c.maxAzimuthAngle };
    c.maxPolarAngle = 1.5;
    c.minAzimuthAngle = -1.45;
    c.maxAzimuthAngle = 1.45;
    c.minDistance = 0.32;
    c.maxDistance = 3.2;
    return () => {
      c.maxPolarAngle = kept.maxPolar;
      c.minAzimuthAngle = kept.minAzimuth;
      c.maxAzimuthAngle = kept.maxAzimuth;
      c.minDistance = kept.minDistance;
      c.maxDistance = kept.maxDistance;
    };
  }, []);

  // A soft crackle as a crumb catches, never more than a few a second.
  const lastIgnite = useRef(0);
  const ignite = () => {
    const now = performance.now();
    if (now - lastIgnite.current < 140) return;
    lastIgnite.current = now;
    sizzle(0.35);
  };

  const light = useRef<THREE.PointLight | null>(null);
  useEffect(() => {
    light.current = scene.getObjectByName("lava-light") as THREE.PointLight | null;
  });
  useLavaLight(lava, () => light.current);

  const random = useMemo(() => lehmer(999), []);
  const scratch = useMemo(() => new THREE.Vector3(), []);
  const simTime = useRef(0);
  const speed = useSettingRef<number>("speed");
  useFrame((_, raw) => {
    // No time (a first frame, a repeated timestamp) or a bad one moves nothing; a long one (a tab shown again) is cut short.
    // Then run faster by the Speed slider.
    clock.speed = Number.isFinite(speed.current) ? THREE.MathUtils.clamp(speed.current, 1, 4) : 1;
    const dt = (Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1 / 20) : 0) * clock.speed;
    clock.now += dt;
    if (!started.current && scenePhase.current === "live") {
      started.current = true;
      cook();
    }
    // The flow is slow and viscous: stepped at about 30 Hz (every other frame at 60), each step taking the time since the
    // last, so it moves at the same speed at any frame rate for half the work.
    // Sped up, it takes as many steps of at most a thirtieth as the time needs (the flow is only stable that fine), up
    // to two a frame (a step is about 5 ms of the processor): 4× at 60 fps; slower frames drop what they could not step.
    simTime.current += dt;
    if (simTime.current >= 1 / 40) {
      const steps = Math.min(2, Math.ceil(simTime.current * 30 - 1e-6));
      for (let n = 0; n < steps; n++) lava.step(simTime.current / steps);
      simTime.current = 0;
    }
    crumbs.update(dt, (x, z) => lava.sample(x, z).surface);
    // The filling glows through the bite, as bright as what is still inside is hot.
    magma.inside.value += ((lava.bites.length ? Math.min(1.6, 0.4 + lava.glow.inside * 0.08) : 0) - magma.inside.value) * Math.min(1, dt * 4);
    if (!Number.isFinite(magma.inside.value)) magma.inside.value = 0;
    if (Number.isFinite(lava.glow.level) && lava.glow.level > 0) magma.fill.value = lava.glow.level;

    // Steam: a little always off the hot filling; lots off the lava, and smoke where the plate burns.
    const f = flow.current;
    f.vent += dt * 2.5;
    while (f.vent > 1) {
      f.vent -= 1;
      const [x, y, z] = pocketToWorld(0.05 + (random() - 0.5) * 0.3, 0.1, (random() - 0.5) * 0.14);
      puffs.emit(x, y, z, 0, 0.05);
    }
    const g = lava.glow;
    const rate = Math.min(40, g.amount * 9) * dt;
    for (let n = 0; n < Math.floor(rate) + (random() < rate % 1 ? 1 : 0); n++) {
      const c = lava.hotCell(random);
      if (c) puffs.emit(c.x, c.y + 0.01, c.z, c.char > 0.45 && random() < 0.5 ? 1 : 0, 0.05 + c.heat * 0.04);
    }
    puffs.update(dt);

    // The lava's sounds: hissing as it runs, the odd slow plop.
    if (lava.bites.length || lava.glow.amount > 0.01) {
      f.since += dt;
      const t = performance.now() / 1000;
      const hiss = Math.min(1, g.flowing * 1.5 + g.amount * 0.15);
      if (hiss > 0.05 && t > f.nextSizzle) {
        sizzle(hiss);
        f.nextSizzle = t + 0.18 + random() * 0.35;
      }
      if (g.amount > 0.1 && t > f.nextPlop) {
        plop(Math.min(1, 0.4 + g.amount * 0.2));
        f.nextPlop = t + 0.9 + random() * 2.2;
      }
      if (!f.earned && f.since > 5) {
        f.earned = true;
        shareResult.set("I took a bite of a microwave pocket and it was full of lava in Magma");
        followPrompt.earn();
      }
    }

    // Never below or through the counter: however the view is turned, zoomed or flown, the eye stays above its top.
    if (camera.position.y < EYE_FLOOR) camera.position.y = EYE_FLOOR;
    // Nor behind the backsplash, or inside the microwave.
    const wallZ = Math.abs(camera.position.x - MICROWAVE.x) < MICROWAVE.width / 2 + 0.15 && camera.position.y < COUNTER + MICROWAVE.height + 0.15 ? MICROWAVE.front + 0.42 : BACKSPLASH_Z + 0.2;
    if (camera.position.z < wallZ) camera.position.z = wallZ;
    // Focus on what the view turns about.
    // Through the opening move, on the plate.
    const focus = Math.max(0.3, camera.position.distanceTo(intro.active ? scratch.set(0, 0.03, 0) : (orbitPoint.current ?? scratch.set(0, 0, 0))));
    focusDistance.value = focus;
    focusBlur.value = THREE.MathUtils.clamp(1.1 / focus, 0.8, 1.6);
  });

  return (
    <>
      <Intro to={magmaDay.camera} />
      <Kitchen mirror={startTier === "high"} />
      <Plate lava={lava} />
      <Props fine={startTier !== "low"} />
      <Pocket crust={crust} fine={startTier !== "low"} />
      <LavaSurface lava={lava} fine={startTier !== "low"} />
      <PlateCrumbs lava={lava} fine={startTier !== "low"} emitSmoke={(x, y, z) => puffs.emit(x, y, z, 1, 0.035)} onIgnite={ignite} />
      <PizzaRolls lava={lava} crumbs={crumbs} puffs={puffs} light={lightDevice} />
      <primitive object={crumbs.mesh} />
      <primitive object={puffs.mesh} />
      <WindowLight dust={startTier === "low" ? 500 : 1200} />
    </>
  );
}

const magmaDay: DayDefinition = {
  camera: {
    // Low and close at the pocket's open end, where the bite will be.
    position: [0, 0.3, 0.86],
    target: [0, 0.03, 0.0],
    fov: 40,
    // Upright on a phone: further back and a little wider, so the whole plate shows and rolls tipped onto its edge
    // stay in frame.
    phone: { position: [0.03, 0.6, 1.26], target: [0.03, 0.0, 0.05], fov: 56 }
  },
  hover: true,
  // Its pastry, crust and glow are shaded per pixel: at a retina screen's full density the frame halved.
  maxDpr: 1.25,
  look: LOOK,
  // A food photograph's shallow focus: the pocket and its bite sharp, the kitchen behind soft. (Low drops it.)
  // Shallow, as a food photograph: sharp only a few centimetres either side of what the view turns about. The bounce is
  // traced at half size (soft anyway).
  passes: { haze: false, bounce: true, halfBounce: true, overlay: true, depthOfField: { range: 0.3 } },
  settings: {
    fresh: { type: "action", label: "Microwave another" },
    rolls: { type: "action", label: "Add some Pizza Rolls" },
    speed: { type: "range", label: "Speed", min: 1, max: 4, step: 0.5, value: 1 }
  },
  phonePills: ["fresh", "rolls"],
  prompt: { title: "Take a bite", detail: "Tap or click the bare end of the pocket", low: true },
  hint: "Click the bare end of the pocket to take a bite, and watch the molten filling run out over the plate. Take up to three bites, then microwave another. Add some pizza rolls and bite those too.",
  notes:
    "A microwave pocket on a paper plate on the kitchen counter, fresh out of the microwave behind it. Its filling is magma: take a bite and it pours out, glowing, crusting and scorching the plate as it spreads.",
  overview: [
    {
      title: "The pocket",
      points: [
        "Pastry built at load as puffed top and flat bottom sheets over shared rings, sealed by a flat pressed edge; it rests tilted, sleeve on the rim.",
        "A bite is a scalloped circle the shader cuts away, so no mesh is rebuilt; the cut shows crumb and the glowing inside."
      ]
    },
    {
      title: "The lava",
      points: [
        "A 256 × 256 thin-film flow on the CPU: lava moves by surface slope × depth³ × a fluidity that falls steeply as it cools.",
        "Heat rides with the flow and leaks from the top, so fronts stall in a crust and hot lava breaks out behind them.",
        "Drawn as a displaced grid: incandescent by temperature, then ropy crust drifting with the flow, cracked to show the glow."
      ]
    },
    {
      title: "Pizza rolls",
      points: [
        "Rapier bodies, each a small hull of the pillow shape, fall onto a trimesh of the plate and a hull of the pocket, then freeze.",
        "A bite cuts the roll away in the shader and swaps in a half hull; its filling joins the lava flow as a source on the plate."
      ]
    },
    {
      title: "Plate, crumbs and counter",
      points: [
        "The plate scorches brown to black wherever hot lava has lain, from a heat map the flow writes as it goes.",
        "Crumbs are one mesh of noise-shaped pieces; lava sets them alight from a pool of flames and lights, and they char, glow and fall to ash.",
        "The kitchen is captured once into a blurred cube the marble reflects; on High a planar mirror adds the plate and lava."
      ]
    }
  ],
  Scene
};

export default magmaDay;
