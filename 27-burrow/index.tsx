"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as THREE from "three/webgpu";
import { lights } from "three/tsl";
import { cameraTaken } from "../shared/engine/controls";
import { useDispose } from "../shared/engine/dispose";
import { airAmount, airTint, focusBlur, focusDistance } from "../shared/engine/Post";
import { dismissPrompt } from "../shared/engine/prompt";
import { scenePhase, useQuality } from "../shared/engine/quality";
import { suspendRetried } from "../shared/engine/retry";
import { useSettingAction } from "../shared/engine/settings";
import { useMusic } from "../shared/engine/sound";
import type { DayDefinition } from "../shared/engine/types";
import { followPrompt } from "../shared/ui/Follow";
import { shareResult } from "../shared/ui/Share";
import { Caverns } from "./caverns";
import { CAVERNS, cavernDistance, cavernsNear, cliffDepth, cliffMass, DIG_RADIUS, groundY, strata, type Cavern } from "./field";
import { caveLights, lamp, Motes, TORCH_LIGHTS, useDust, usePebbles } from "./fx";
import { supply, torches, Torches } from "./torches";
import { Dressings } from "./dressing";
import { Collectibles, collectibles } from "./collectibles";
import { Backpack } from "./backpack";
import { Found } from "./found";
import { panels, uiBlocks } from "./panels";
import { viewfinder } from "./photos";
import { Forest, keepInClearing, leafStep, treeHit, treeSolid } from "./forest/index";
import { outdoorLights } from "./forest/lights";
import { mouth, Outside, shadow, SUN_DIRECTION } from "./outside";
import { createRockMaterial, loadTextures, rockUniforms } from "./rock";
import { bats, Bats, leaveTrail } from "./bats";
import { bloom, breakthrough, clink, drip, footstep, pebble, preloadDig, setSpace, splashStep, strike, wetStep } from "./sound";
import { loadWorld } from "./world";
import { frameClock, sampleStats, statSources } from "./stats";
import { axisAt, climbTop, fitLadder, grabLadder, type Ladder, LadderHud, Ladders, ladders, notice } from "./ladder";
import { holding, HOLD_MS, isTouch, stick, Stick, touchActions } from "./touch";

// You stand off a granite cliff in the midday sun. Walk up to it and click the rock: a pick strike carves a hole in
// it; click again to dig on; walk on into what you dig. Somewhere in the cliff are caverns nobody has seen.

// Eye height over whatever is underfoot, and the body's two spheres for walls: the head, and the chest below it.
const EYE = 1.25;
const HEAD = 0.24;
const CHEST_DROP = 0.5;
const PACE = 2.1;
const RUN = 4.2;
const LOOK = 0.0036;
// How far a torch, a ladder or a find can be reached (arm), and how far a click looks for rock at all (sight), so rock
// out of a pick's reach can say to come closer. How far a press may move before it is a look.
const REACH = { sight: 24, arm: 4.6 };
// How far a pick strike reaches from the eye: an arm and a pick's swing. Further off, no pick shows and a click only
// says to come closer, so the cliff is dug from right under it and a tunnel by walking into it.
const DIG_REACH = 5.5;
// The lens: the furthest it focuses out in the open (m), and the bokeh's radius (full-size pixels), larger the
// nearer the focus.
const FOCUS_FAR = 14;
const BLUR = { min: 4, max: 7 };
const JUMP = 4.2;
const STILL_PX = 8;
const START = { position: new THREE.Vector3(0.6, 0, 10.5), yaw: 0.06, pitch: 0.24 };
const LAKE = CAVERNS.find((c) => c.kind === "lake") as Cavern;
// How far behind the rock's original surface the eye must be to count as in the rock, where digging goes any way.
const IN_ROCK = 0.25;

// Which cavern was just found, for the line that says so.
const found = {
  cavern: null as Cavern | null,
  at: 0,
  listeners: new Set<() => void>(),
  set(cavern: Cavern) {
    this.cavern = cavern;
    this.at = performance.now();
    for (const listener of this.listeners) listener();
  }
};

const scratch = {
  ray: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
  hit: new THREE.Vector3(),
  out: new THREE.Vector3(),
  centre: new THREE.Vector3(),
  clamped: new THREE.Vector3(),
  forward: new THREE.Vector3(),
  right: new THREE.Vector3(),
  wish: new THREE.Vector3(),
  euler: new THREE.Euler(0, 0, 0, "YXZ"),
  grad: [0, 0, 0],
  colour: new THREE.Color()
};

// Fourteen directions spread round the sphere, for measuring the space by ear.
const PROBES = Array.from({ length: 14 }, (_, i) => {
  const y = 1 - ((i + 0.5) / 14) * 2;
  const r = Math.sqrt(1 - y * y);
  const a = i * 2.39996;
  return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
});

// The colour of freshly broken rock at a point, for chips and dust: the bed it is in.
function rockColour(p: THREE.Vector3, out: THREE.Color) {
  const b = strata(p.x, p.y, p.z);
  if (b < -3.3) return out.setRGB(0.09, 0.075, 0.065);
  if (b < -0.55) return out.setRGB(0.25, 0.25, 0.27);
  return out.setRGB(0.72, 0.5, 0.33);
}

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const { world, textures } = suspendRetried(
    () =>
      Promise.all([loadWorld(new THREE.Vector3(START.position.x, groundY(START.position.x, START.position.z) + EYE, START.position.z)), loadTextures()]).then(([world, textures]) => ({
        world,
        textures
      })),
    ["burrow"]
  );
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const rock = useMemo(() => createRockMaterial(textures, undefined, startTier === "low"), [textures, startTier]);
  // The same rock with fewer lights (world.ts `lightsFor`): untouched outer rock by the sun, the sky and the headlamp
  // (filled in below), and rock well inside by the caves' own lights, with no sun.
  const openLights = useMemo(() => lights([]), []);
  const rockOpen = useMemo(() => createRockMaterial(textures, undefined, startTier === "low", false, openLights), [textures, startTier, openLights]);
  const rockDeep = useMemo(() => createRockMaterial(textures, undefined, startTier === "low", false, caveLights), [textures, startTier]);
  // The plain cliff and ground beyond the meshed chunks, hiding wherever a chunk is drawn.
  const beyond = useMemo(() => createRockMaterial(textures, world.mask, startTier === "low"), [textures, world, startTier]);
  const beyondGround = useMemo(() => createRockMaterial(textures, world.mask, startTier === "low", true), [textures, world, startTier]);
  useDispose(rock, rockOpen, rockDeep, beyond, beyondGround);
  useEffect(() => world.setMaterial(rock, rockOpen, rockDeep), [world, rock, rockOpen, rockDeep]);
  useEffect(() => preloadDig(), []);
  useEffect(() => {
    world.changed = () => shadow.redraw();
    shadow.redraw();
    return () => {
      world.changed = () => {};
    };
  }, [world]);

  const dust = useDust();
  const landed = useRef((size: number, at: THREE.Vector3) => {
    void at;
    pebble(size);
  });
  const pebbles = usePebbles(world.rock, textures, landed);

  // The headlamp: a warm white spot a hand above and right of the eye, so walls show their relief rather than lying
  // flat in light from straight behind the eye.
  const headlamp = useMemo(() => {
    const light = new THREE.SpotLight("#ffe6c8", 0, 32, 0.66, 1, 1);
    light.castShadow = false;
    return light;
  }, []);
  useEffect(() => () => headlamp.dispose(), [headlamp]);
  // The caverns' dressing is lit by the sky's fill, the headlamp and the torches only (fx.tsx `caveLights`): set once
  // every part is mounted, before the warm-up compiles anything.
  const scene = useThree((three) => three.scene) as unknown as THREE.Scene;
  useLayoutEffect(() => {
    const sky = new Set<THREE.Light>();
    for (const light of outdoorLights.getLights()) if ((light as THREE.HemisphereLight).isHemisphereLight) sky.add(light);
    scene.traverse((object) => {
      if ((object as THREE.HemisphereLight).isHemisphereLight) sky.add(object as THREE.Light);
    });
    caveLights.setLights([...sky, headlamp, ...torches.lights]);
    const sun = new Set<THREE.Light>();
    for (const light of outdoorLights.getLights()) if ((light as THREE.DirectionalLight).isDirectionalLight) sun.add(light);
    scene.traverse((object) => {
      if ((object as THREE.DirectionalLight).isDirectionalLight) sun.add(object as THREE.Light);
    });
    openLights.setLights([...sun, ...sky, headlamp]);
  }, [scene, headlamp, openLights]);

  useMusic("/codevember/music/epic-orchestral-adventure.mp3", 0.32);
  // No wind bed: the owner found it a loud, unwelcome hiss under the music (27 Nov).

  const state = useMemo(
    () => ({
      eye: new THREE.Vector3(START.position.x, groundY(START.position.x, START.position.z) + EYE, START.position.z),
      velocity: new THREE.Vector3(),
      yaw: START.yaw,
      pitch: START.pitch,
      grounded: true,
      keys: new Set<string>(),
      // A finger held still also counts down to a right click (`hold`, a timer), and once that has acted, `held`.
      press: null as null | { id: number; x: number; y: number; startX: number; startY: number; look: boolean; button: number; hold: number; held: boolean },
      lastStrike: -1,
      kick: 0,
      shake: 0,
      time: 0,
      walked: 0,
      focus: 6,
      inside: 0,
      promptGone: false,
      nextProbe: 0,
      // The sound's sweep of rays under way (k the next ray, -1 between sweeps).
      sweep: { k: -1, escaped: 0, sum: 0, hits: 0 },
      nextDrip: 2,
      enclosed: 0,
      size: 0,
      strikes: 0,
      earned: false,
      revealAt: CAVERNS.map(() => -1),
      lastDepth: -1,
      // On a ladder: which, the feet's height on it, the speed up it, and the step off at the top once begun.
      climb: null as null | { ladder: Ladder; h: number; v: number; exit: null | { from: THREE.Vector3; to: THREE.Vector3; t: number } },
      climbFree: 0
    }),
    []
  );

  // The day takes the camera for good: no orbit, no fly. It is given back on leaving.
  useEffect(() => {
    cameraTaken.current = true;
    camera.fov = 62;
    camera.near = 0.03;
    camera.updateProjectionMatrix();
    return () => {
      cameraTaken.current = false;
      camera.near = 0.05;
      camera.updateProjectionMatrix();
    };
  }, [camera]);

  // A strike where the pointer is: at the first rock along its line within a pick's reach. Returns whether it bit.
  // Where a strike may bite. In the rock (a tunnel, a cavern, a shaft: the eye behind the rock's original surface), any
  // way at all, down included. Outside, only the cliff (the face and the plateau, by its own field), and only above the
  // line of the floor at its foot, so a low swing cannot start a pit. And never the clearing's floor out in front of
  // the face, from anywhere (a tunnel's mouth included), unless you are already down under it.
  const diggable = (hit: THREE.Vector3) => {
    const e = state.eye;
    const mass = cliffMass(hit.x, hit.y, hit.z);
    const ground = groundY(hit.x, hit.z);
    const underFloor = e.y - EYE < groundY(e.x, e.z) - 0.8;
    if (mass < -0.3 && hit.y > ground - 1 && !underFloor) return false;
    if (cliffDepth(e.x, e.y, e.z) > IN_ROCK) return true;
    return mass > -0.3 && hit.y > ground + 0.25;
  };

  // Whether a click here would dig (as strikeAt finds it), for the forest's pick cursor and first-hover hint.
  const aimAt = (clientX: number, clientY: number) => {
    // A ladder in hand, or the camera up: no pick.
    if (ladders.placing || viewfinder.up) return null;
    const rect = gl.domElement.getBoundingClientRect();
    scratch.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    scratch.ray.setFromCamera(scratch.pointer, camera);
    const o = scratch.ray.ray.origin;
    const d = scratch.ray.ray.direction;
    const t = world.rock.march(o.x, o.y, o.z, d.x, d.y, d.z, DIG_REACH);
    return t >= 0 && diggable(scratch.out.copy(o).addScaledVector(d, t)) ? scratch.out : null;
  };
  const strikeAt = (clientX: number, clientY: number) => {
    const rect = gl.domElement.getBoundingClientRect();
    scratch.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    scratch.ray.setFromCamera(scratch.pointer, camera);
    const o = scratch.ray.ray.origin;
    const d = scratch.ray.ray.direction;
    // Something to find right where it points comes out before any rock is struck.
    if (collectibles.tryPick(scratch.ray.ray, REACH.arm)) {
      dismissPrompt();
      return true;
    }
    const t = world.rock.march(o.x, o.y, o.z, d.x, d.y, d.z, REACH.sight);
    // Rock too far off for a swing: nothing struck, no knock, only a word to come closer if it is rock that would give.
    if (t < 0 || t > DIG_REACH) {
      if (t >= 0 && diggable(scratch.hit.copy(o).addScaledVector(d, t))) notice.say("Too far to dig. Walk up closer");
      return false;
    }
    scratch.hit.copy(o).addScaledVector(d, t);
    // Into the rock a little, and when digging level a touch low, so a tunnel keeps a floor you can walk on; straight
    // on when digging up or down.
    const c = scratch.centre.copy(scratch.hit).addScaledVector(d, 0.6);
    c.y -= 0.22 * (1 - Math.min(1, Math.abs(d.y) * 2));
    // Where it may not bite (see diggable): a dull knock and a puff of dust, and a word on why.
    if (!diggable(scratch.hit)) {
      scratch.out.copy(d).negate();
      dust.emit(scratch.hit, scratch.out, 0.06);
      footstep(THREE.MathUtils.clamp(scratch.pointer.x, -1, 1));
      notice.say("Only the cliff gives out here. Once you're in the rock, dig any way");
      return false;
    }
    // From outside, the bite stays above the floor at the cliff's foot (a tunnel's floor comes out level with it).
    if (cliffDepth(state.eye.x, state.eye.y, state.eye.z) <= IN_ROCK) c.y = Math.max(c.y, groundY(c.x, c.z) + 0.8, groundY(scratch.hit.x, scratch.hit.z) + 0.8);
    const r = DIG_RADIUS * (0.92 + Math.random() * 0.16);
    // Nothing solid within the bite: a swing at the air.
    if (world.rock.sample(c.x, c.y, c.z) < -r) return false;
    // How close an unopened cavern lies: the strike rings hollow over it.
    let hollow = 0;
    for (const cavern of cavernsNear(c.x, c.y, c.z, c.x, c.y, c.z, 3, []))
      if (!world.opened.has(cavern)) hollow = Math.max(hollow, 1 - THREE.MathUtils.smoothstep(cavernDistance(cavern, c.x, c.y, c.z), 0.9, 2.6));
    const broke = world.dig(c.x, c.y, c.z, r);
    collectibles.dugOut(c.x, c.y, c.z, r);
    scratch.out.copy(d).negate();
    const inside = THREE.MathUtils.smoothstep(cliffDepth(scratch.hit.x, scratch.hit.y, scratch.hit.z), 0.3, 2.5);
    dust.emit(scratch.hit, scratch.out, 0.25);
    pebbles.emit(scratch.hit, scratch.out, 3 + Math.floor(Math.random() * 4), rockColour(c, scratch.colour), 1 - inside);
    strike(hollow, THREE.MathUtils.clamp(scratch.pointer.x, -1, 1));
    state.kick = 1;
    state.shake = 0.6;
    state.strikes += 1;
    dismissPrompt();
    for (const cavern of broke) openCavern(cavern);
    // The thin wall left round the hole gives way: a bigger ball falls in, so the cavern shows at once.
    if (broke.length) {
      const fall = scratch.clamped.copy(scratch.hit).addScaledVector(d, 0.9);
      world.dig(fall.x, fall.y, fall.z, DIG_RADIUS * 1.4);
      pebbles.emit(scratch.hit, d, 18, rockColour(scratch.hit, scratch.colour), 0);
    }
    return true;
  };

  const openCavern = (cavern: Cavern) => {
    const k = CAVERNS.indexOf(cavern);
    // The light inside comes up with a flare (see the frame loop), the reverb opens out, the colony wakes.
    if (k >= 0) state.revealAt[k] = state.time;
    if (cavern.kind === "grotto") rockUniforms.breach.value.copy(scratch.hit);
    breakthrough(cavern.kind);
    bloom();
    // A lost explorer's camp: their spare torches.
    if (cavern.kind === "camp") supply.give(5);
    bats.scatter(cavern.kind, scratch.hit);
    state.shake = 1.6;
    const centre = new THREE.Vector3(...cavern.centre);
    const towards = centre.clone().sub(scratch.hit).normalize();
    dust.emit(scratch.hit, towards, 0.35);
    pebbles.emit(scratch.hit, towards, 14, rockColour(scratch.hit, scratch.colour), 0);
    // Never the first-move prompt and the find at once.
    dismissPrompt();
    found.set(cavern);
    if (!state.earned) {
      state.earned = true;
      followPrompt.earn("cavern");
    }
    shareResult.set(`Dug into a granite cliff with a pick and ${cavern.boast}`);
  };

  // A torch on the wall where the pointer (or the middle of the view) points, within reach; with no wall there, stood on
  // the floor just ahead. `onWall`: only on a wall in reach, or nothing (a finger held on the scene, which may only have
  // paused before a drag).
  const mountTorch = (clientX?: number, clientY?: number, onWall = false) => {
    const rect = gl.domElement.getBoundingClientRect();
    if (clientX === undefined || clientY === undefined) scratch.pointer.set(0, 0);
    else scratch.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    scratch.ray.setFromCamera(scratch.pointer, camera);
    const o = scratch.ray.ray.origin;
    const d = scratch.ray.ray.direction;
    let t = world.rock.march(o.x, o.y, o.z, d.x, d.y, d.z, REACH.arm);
    const at = new THREE.Vector3();
    if (t >= 0) at.copy(o).addScaledVector(d, t);
    else if (onWall) return;
    else {
      scratch.forward.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
      at.copy(state.eye).addScaledVector(scratch.forward, 0.8);
      t = world.rock.march(at.x, at.y, at.z, 0, -1, 0, 4);
      if (t < 0) return;
      at.y -= t;
    }
    world.rock.gradient(at.x, at.y, at.z, scratch.grad, 0.15);
    const normal = new THREE.Vector3(-scratch.grad[0], -scratch.grad[1], -scratch.grad[2]).normalize();
    // One from the sixty you carry; none left, nothing mounts (the HUD says so).
    if (!supply.take()) {
      clink();
      return;
    }
    torches.place(at, normal);
    world.torchAt(at);
    dismissPrompt();
  };
  useSettingAction("torch", () => mountTorch());
  useSettingAction("ladder", () => ladders.toggle());
  // The touch buttons (backpack.tsx): a torch where the view points, and the carried ladder down where its ghost stands.
  useEffect(() => {
    touchActions.torch = () => mountTorch();
    touchActions.placeLadder = () => placeGhost();
    return () => {
      touchActions.torch = touchActions.placeLadder = () => {};
    };
  });

  const pointerRay = (clientX: number, clientY: number) => {
    const rect = gl.domElement.getBoundingClientRect();
    scratch.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    scratch.ray.setFromCamera(scratch.pointer, camera);
    return scratch.ray.ray;
  };
  // Leans the ladder being carried against the wall where the click is, if it can stand there.
  const placeLadder = (clientX: number, clientY: number) => {
    const ray = pointerRay(clientX, clientY);
    if (ladders.place(fitLadder(world.rock, ray.origin, ray.direction))) {
      footstep();
      dismissPrompt();
    } else clink();
  };
  // On a touch screen the ghost stands where the middle of the view points (ladder.tsx), and goes down there.
  const placeGhost = () => {
    if (ladders.place()) {
      footstep();
      dismissPrompt();
    } else clink();
  };
  // Takes back the ladder a right click is on, if it is on one before any rock.
  const pickUpLadder = (clientX: number, clientY: number) => {
    const ray = pointerRay(clientX, clientY);
    const t = world.rock.march(ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, REACH.arm);
    const k = ladders.at(ray, t >= 0 ? t + 0.15 : REACH.arm);
    if (k < 0) return false;
    const ladder = ladders.remove(k);
    if (state.climb?.ladder === ladder) letGo();
    footstep();
    return true;
  };

  // Input: a click strikes when it lets go; dragged, it turns the view instead and strikes nothing. Right drag always
  // looks, and a right click that stays put mounts a torch. WASD or the arrows to walk, Shift to hurry, Space to jump,
  // T for a torch.
  useEffect(() => {
    const dom = gl.domElement;
    const down = (event: PointerEvent) => {
      if (state.press || uiBlocks(event)) return;
      const button = event.pointerType === "mouse" ? event.button : 0;
      if (button !== 0 && button !== 2) return;
      const press = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, look: button === 2, button, hold: 0, held: false };
      state.press = press;
      // A finger held still is a touch screen's right click: it takes back a ladder, puts a carried one away, or mounts
      // a torch where it is held. Not with the camera up, where a tap is the shutter.
      if (event.pointerType === "touch" && !viewfinder.up) {
        holding.set({ x: event.clientX, y: event.clientY });
        press.hold = window.setTimeout(() => {
          holding.set(null);
          if (state.press !== press || press.look || uiBlocks()) return;
          press.held = true;
          secondary(press.startX, press.startY, true);
        }, HOLD_MS);
      }
    };
    const unhold = (p: { hold: number }) => {
      if (!p.hold) return;
      window.clearTimeout(p.hold);
      p.hold = 0;
      holding.set(null);
    };
    const move = (event: PointerEvent) => {
      const p = state.press;
      if (!p || event.pointerId !== p.id) return;
      if (!p.look && Math.hypot(event.clientX - p.startX, event.clientY - p.startY) > STILL_PX) {
        p.look = true;
        unhold(p);
      }
      if (p.look) {
        // The same way round as every other day: drag right to look right.
        state.yaw -= (event.clientX - p.x) * LOOK;
        state.pitch = THREE.MathUtils.clamp(state.pitch - (event.clientY - p.y) * LOOK, -1.35, 1.35);
      }
      p.x = event.clientX;
      p.y = event.clientY;
    };
    const up = (event: PointerEvent) => {
      const p = state.press;
      if (!p || event.pointerId !== p.id) return;
      state.press = null;
      unhold(p);
      // A held finger has already acted.
      if (p.held) return;
      // Let go over a panel, or with one open: nothing happens in the scene.
      if (uiBlocks(event)) return;
      // The camera up (photos.tsx): a click that did not turn the view takes a photo, and nothing digs, leans or mounts.
      if (viewfinder.up) {
        if (event.type === "pointerup" && p.button === 0 && !p.look) viewfinder.shoot();
        return;
      }
      // A click that did not turn the view strikes where it let go, or with a ladder in hand, leans it there.
      if (event.type === "pointerup" && p.button === 0 && !p.look) {
        if (ladders.placing && event.pointerType === "touch") placeGhost();
        else if (ladders.placing) placeLadder(event.clientX, event.clientY);
        else strikeAt(event.clientX, event.clientY);
      }
      // A right click that did not turn the view puts a ladder in hand down, takes back a ladder it is on, or mounts a
      // torch where it points.
      if (p.button === 2 && Math.hypot(event.clientX - p.startX, event.clientY - p.startY) <= STILL_PX) secondary(event.clientX, event.clientY);
    };
    const secondary = (clientX: number, clientY: number, onWall = false) => {
      if (ladders.placing) ladders.cancel();
      else if (!pickUpLadder(clientX, clientY)) mountTorch(clientX, clientY, onWall);
    };
    const menu = (event: Event) => event.preventDefault();
    const key = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // With a modal view open, no key acts on the game (letting go of one still does, so nothing keeps walking).
      if (event.type === "keydown" && uiBlocks()) return;
      const element = event.target as HTMLElement | null;
      if (element?.tagName === "INPUT" && (element as HTMLInputElement).type !== "range") return;
      if (event.code === "KeyT") {
        if (event.type === "keydown" && !event.repeat) mountTorch();
        return;
      }
      if (event.code === "KeyL") {
        if (event.type === "keydown" && !event.repeat) ladders.toggle();
        return;
      }
      if (event.code === "Escape" && event.type === "keydown") ladders.cancel();
      if (event.type === "keydown") {
        state.keys.add(event.code);
        if (event.code.startsWith("Arrow") || event.code === "Space") event.preventDefault();
        // Off a ladder: a push back from it, and down. With the camera up Space is its shutter, so J jumps.
        const jump = event.code === (viewfinder.up ? "KeyJ" : "Space") && !event.repeat;
        if (jump && state.climb) {
          const out = state.climb.ladder.out;
          letGo();
          state.velocity.set(out.x * 2.4, JUMP * 0.55, out.z * 2.4);
        } else if (jump && state.grounded) {
          state.velocity.y = JUMP;
          state.grounded = false;
        }
      } else state.keys.delete(event.code);
    };
    const blur = () => {
      state.keys.clear();
      if (state.press) unhold(state.press);
      state.press = null;
    };
    dom.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    dom.addEventListener("contextmenu", menu);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", blur);
    return () => {
      dom.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      dom.removeEventListener("contextmenu", menu);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", blur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handlers read only refs and memoised state.
  }, [gl, state]);

  if (process.env.NODE_ENV !== "production")
    Object.assign(globalThis, {
      __burrow: { state, world, strikeAt, mountTorch, torches, ladders, camera, cavernsNear, open: (k: number) => openCavern(CAVERNS[k]) }
    });
  // `__burrowStats()` in the console (development only): about a second and a half of frames, then a table of the frame
  // rate, the page's own frame time, draws and triangles by pass, and what each part draws (stats.ts).
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    statSources.set("rock", () => {
      const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      let meshes = 0;
      let seen = 0;
      let triangles = 0;
      let open = 0;
      let deep = 0;
      for (const slot of world.slots.values()) {
        const mesh = slot.mesh;
        if (!mesh) continue;
        meshes++;
        if (mesh.material === world.open) open++;
        else if (mesh.material === world.deep) deep++;
        if (!mesh.visible || !frustum.intersectsSphere(mesh.geometry.boundingSphere as THREE.Sphere)) continue;
        seen++;
        triangles += (mesh.geometry.index as THREE.BufferAttribute).count / 3;
      }
      return { "chunks loaded": world.slots.size, "chunks with a surface": meshes, "chunks hidden (only sealed caverns' walls)": world.hidden, "chunks lit as outer rock (sun, sky, lamp)": open, "chunks lit as deep rock (no sun)": deep, "chunks in view": seen, "chunk triangles in view": triangles, "chunks waiting": world.queue.length, "caverns opened": world.opened.size };
    });
    statSources.set("torches", () => ({ mounted: torches.list.length, "real lights": TORCH_LIGHTS }));
    Object.assign(globalThis, { __burrowStats: (seconds?: number) => sampleStats(gl, scene, camera, seconds) });
    return () => {
      statSources.delete("rock");
      statSources.delete("torches");
    };
  }, [gl, scene, camera, world]);
  useFrame(() => {
    frameClock.start = performance.now();
  }, -1000);
  useFrame(() => {
    frameClock.total += performance.now() - frameClock.start;
    frameClock.frames++;
  }, 1000);

  // How solid it is at a point for the body (the ground is rock too, and the trees' trunks are in the way).
  const solid = (x: number, y: number, z: number) => Math.max(world.rock.sample(x, y, z), treeSolid(x, y, z));
  const solidGradient = (x: number, y: number, z: number, out: number[]) => {
    const h = 0.06;
    out[0] = solid(x + h, y, z) - solid(x - h, y, z);
    out[1] = solid(x, y + h, z) - solid(x, y - h, z);
    out[2] = solid(x, y, z + h) - solid(x, y, z - h);
    return out;
  };
  // Pushes a ball of radius r at p out of anything solid. With `duck`, rock overhead pushes the head straight down (a
  // crouch) rather than back, so a low roof never stops you walking on.
  const pushOut = (p: THREE.Vector3, r: number, duck = false) => {
    for (let n = 0; n < 3; n++) {
      const d = solid(p.x, p.y, p.z);
      if (d < -r) return;
      const g = solidGradient(p.x, p.y, p.z, scratch.grad);
      const len = Math.hypot(g[0], g[1], g[2]) || 1;
      const push = Math.min(0.25, d + r);
      if (duck && g[1] / len > 0.35) {
        p.y -= push;
        if (state.velocity.y > 0) state.velocity.y = 0;
        continue;
      }
      p.x -= (g[0] / len) * push;
      p.y -= (g[1] / len) * push;
      p.z -= (g[2] / len) * push;
      // No more speed into the wall.
      const into = -(state.velocity.x * g[0] + state.velocity.y * g[1] + state.velocity.z * g[2]) / len;
      if (into < 0) {
        state.velocity.x += (g[0] / len) * into;
        state.velocity.y += (g[1] / len) * into;
        state.velocity.z += (g[2] / len) * into;
      }
    }
  };

  const letGo = () => {
    state.climb = null;
    state.climbFree = state.time + 0.45;
  };
  // Where the eye comes to rest stepping off a ladder's top: a little in past the lip, on whatever floor is there, with
  // room for the head and chest. None, and the top of the ladder is as far as it goes.
  const ledgeOver = (l: Ladder) => {
    const lip = axisAt(l, climbTop(l), new THREE.Vector3());
    for (const inward of [0.75, 1.05, 0.5]) {
      const x = lip.x - l.out.x * inward;
      const z = lip.z - l.out.z * inward;
      const from = (l.lip as number) + EYE + 0.3;
      const t = world.rock.march(x, from, z, 0, -1, 0, EYE + 1.2);
      if (t <= 0 || Math.abs(from - t - (l.lip as number)) > 0.7) continue;
      const to = new THREE.Vector3(x, from - t + EYE, z);
      if (solid(to.x, to.y, to.z) > -HEAD * 0.7 || solid(to.x, to.y - CHEST_DROP, to.z) > -HEAD * 0.7) continue;
      return to;
    }
    return null;
  };
  // On a ladder: up and down it as the keys say (forward climbs facing it; facing away, forward goes down), with no
  // gravity and no walls, the eye eased along it so nothing jitters. Off at the top onto the ledge, at the foot onto the
  // floor, sideways near the foot, or with a jump.
  const climbLadder = (dt: number, ahead: number, across: number, hurry: boolean, forward: THREE.Vector3) => {
    const c = state.climb;
    if (!c) return;
    const l = c.ladder;
    state.velocity.set(0, 0, 0);
    if (c.exit) {
      c.exit.t = Math.min(1, c.exit.t + dt / 0.45);
      const k = THREE.MathUtils.smoothstep(c.exit.t, 0, 1);
      state.eye.lerpVectors(c.exit.from, c.exit.to, k);
      state.eye.y += Math.sin(Math.PI * k) * 0.15;
      if (c.exit.t >= 1) letGo();
      return;
    }
    if (across !== 0 && ahead === 0 && c.h < 0.6) return letGo();
    const top = climbTop(l);
    const facing = forward.x * -l.out.x + forward.z * -l.out.z > -0.15 ? 1 : -1;
    const wish = ahead * facing * (hurry ? 2.3 : 1.4);
    c.v += (wish - c.v) * (1 - Math.exp(-dt * 10));
    const was = c.h;
    c.h = THREE.MathUtils.clamp(c.h + c.v * dt, 0, top);
    // A step on each rung.
    if (Math.floor(was / 0.3) !== Math.floor(c.h / 0.3)) footstep(Math.floor(c.h / 0.3) % 2 ? 0.12 : -0.12);
    if (c.h <= 0 && wish < 0) return letGo();
    if (c.h >= top && wish > 0 && l.lip !== null) {
      const to = ledgeOver(l);
      if (to) {
        c.exit = { from: state.eye.clone(), to, t: 0 };
        return;
      }
    }
    const target = axisAt(l, c.h, scratch.clamped).addScaledVector(l.out, 0.36);
    target.y += EYE;
    pushOut(target, HEAD * 0.8);
    state.eye.lerp(target, 1 - Math.exp(-dt * 16));
  };

  const chest = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, raw) => {
    const dt = Number.isFinite(raw) ? Math.min(raw, 1 / 20) : 1 / 60;
    const s = state;
    s.time += dt;
    const { forward, right, wish, euler } = scratch;

    // Walking.
    const held = (...codes: string[]) => (codes.some((code) => s.keys.has(code)) ? 1 : 0);
    // The keys, or on a touch screen the thumb stick (touch.tsx), as far as it is pushed; nothing with a modal view open.
    const free = panels.modal === 0;
    const ahead = THREE.MathUtils.clamp(held("KeyW", "ArrowUp") - held("KeyS", "ArrowDown") + (free ? stick.y : 0), -1, 1);
    const across = THREE.MathUtils.clamp(held("KeyD", "ArrowRight") - held("KeyA", "ArrowLeft") + (free ? stick.x : 0), -1, 1);
    forward.set(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));
    right.set(-forward.z, 0, forward.x);
    wish.set(0, 0, 0).addScaledVector(forward, ahead).addScaledVector(right, across);
    if (wish.lengthSq() > 1) wish.normalize();
    // With the camera up Shift lines up a shot rather than hurrying, and you creep while you do.
    wish.multiplyScalar(viewfinder.up ? PACE * (viewfinder.aim > 0.5 ? 0.5 : 0.85) : held("ShiftLeft", "ShiftRight") ? RUN : PACE);
    // Taking hold of a ladder: walking into one at its foot, or out over the edge onto its top.
    if (!s.climb && s.time > s.climbFree) {
      const grab = grabLadder(s.eye, EYE, forward, wish, ahead);
      if (grab) s.climb = { ladder: grab.ladder, h: grab.h, v: 0, exit: null };
    }
    const blend = 1 - Math.exp(-dt * 9);
    s.velocity.x += (wish.x - s.velocity.x) * blend;
    s.velocity.z += (wish.z - s.velocity.z) * blend;
    // Underground, walking on while looking well up climbs: up the shaft you are digging, as on a rope.
    const climb = !s.climb && ahead > 0 && s.inside > 0.5 && s.pitch > 0.35 ? Math.sin(s.pitch) * PACE * ahead : 0;
    if (s.climb) climbLadder(dt, ahead, across, held("ShiftLeft", "ShiftRight") > 0, forward);
    else if (climb > 0) s.velocity.y += (climb - s.velocity.y) * blend;
    else s.velocity.y -= 9.8 * dt;
    s.eye.addScaledVector(s.velocity, dt);

    // Feet: whatever is under the eye within reach. Steps up ease the eye up; drops are fallen.
    const down = world.rock.march(s.eye.x, s.eye.y, s.eye.z, 0, -1, 0, EYE + 0.7);
    let floor = down < 0 ? -Infinity : s.eye.y - down;
    // Wading in the lake: the water is knee deep wherever it stands over the floor.
    if (LAKE.water !== undefined && world.opened.has(LAKE) && s.eye.y > LAKE.water && cavernDistance(LAKE, s.eye.x, LAKE.water, s.eye.z) < 0) floor = Math.max(floor, LAKE.water - 0.35);
    const wasGrounded = s.grounded;
    s.grounded = false;
    if (s.eye.y - floor < EYE + 0.02 && climb === 0 && !s.climb && s.velocity.y <= 0) {
      const want = floor + EYE;
      s.eye.y += (want - s.eye.y) * Math.min(1, dt * 12);
      if (s.velocity.y < 0) s.velocity.y = 0;
      s.grounded = true;
    }
    // Walls and roof (on a ladder, its own path keeps clear of them).
    if (!s.climb) {
      pushOut(s.eye, HEAD, true);
      chest.copy(s.eye);
      chest.y -= CHEST_DROP;
      const beforeX = chest.x;
      const beforeZ = chest.z;
      pushOut(chest, HEAD);
      s.eye.x += chest.x - beforeX;
      s.eye.z += chest.z - beforeZ;
    }
    // Out on the open ground, not off into the desert for ever.
    if (!s.climb && cliffDepth(s.eye.x, s.eye.y, s.eye.z) < -0.3) keepInClearing(s.eye, s.velocity, dt);
    world.follow(s.eye, scenePhase.current === "live");

    // Footsteps.
    const speed = Math.hypot(s.velocity.x, s.velocity.z);
    if (s.grounded && speed > 0.4) {
      const was = s.walked;
      s.walked += speed * dt;
      if (Math.floor(was / 0.62) !== Math.floor(s.walked / 0.62)) {
        // Leaves outside; grit in the tunnels; slick rock in the dark wet beds; water where the lake is.
        const pan = (Math.floor(s.walked / 0.62) % 2) * 0.3 - 0.15;
        const wading = LAKE.water !== undefined && world.opened.has(LAKE) && s.eye.y - EYE < LAKE.water + 0.05 && cavernDistance(LAKE, s.eye.x, LAKE.water, s.eye.z) < 0;
        if (s.inside < 0.5) leafStep(pan);
        else if (wading) splashStep(pan);
        else if (strata(s.eye.x, s.eye.y - EYE, s.eye.z) < -3.3) wetStep(pan);
        else footstep(pan);
      }
    }
    if (s.grounded && !wasGrounded && s.velocity.y < -2) footstep();

    // The view: yaw and pitch, a gentle breath, a bob while walking, and a jolt with each strike.
    s.kick = Math.max(0, s.kick - dt * 5);
    s.shake = Math.max(0, s.shake - dt * 2.5);
    const bob = Math.sin((s.walked / 0.62) * Math.PI) * 0.025 * Math.min(1, speed / PACE);
    const breath = Math.sin(s.time * 1.1) * 0.004;
    const jolt = s.kick * s.kick * 0.035;
    const shake = s.shake * s.shake;
    euler.set(
      s.pitch + breath + jolt + Math.sin(s.time * 41) * 0.004 * shake,
      s.yaw + Math.sin(s.time * 37 + 1) * 0.004 * shake,
      Math.sin(s.time * 0.7) * 0.003 + Math.sin(s.time * 29) * 0.003 * shake
    );
    camera.quaternion.setFromEuler(euler);
    camera.position.copy(s.eye);
    camera.position.y += Math.abs(bob) - 0.012;
    // A phone held upright: 62 degrees top to bottom would be a slot side to side, so the view opens until it is about 50
    // degrees across (walk.tsx does the same, to 65; capped lower here, as every degree more is more wood to draw). Only
    // while the camera is down, whose lens works from whatever this leaves.
    if (!viewfinder.up && viewfinder.factor === 1) {
      const fov = camera.aspect < 1 ? Math.min(90, Math.max(62, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(25)) / camera.aspect)))) : 62;
      if (Math.abs(camera.fov - fov) > 0.05) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    }

    // Underground or out: how deep behind the face the eye is.
    const behind = cliffDepth(s.eye.x, s.eye.y, s.eye.z);
    // Crossing in through the face: the sun's shaft follows to this mouth.
    if (behind > 0.15 && s.lastDepth <= 0.15) {
      mouth.at = s.eye.clone();
      mouth.moved = true;
    }
    s.lastDepth = behind;
    s.inside += (THREE.MathUtils.smoothstep(behind, 0.2, 2.4) - s.inside) * Math.min(1, dt * 2.5);
    const inside = s.inside;
    // Underground by any way at all (a strike dismisses it too): the opening prompt has done its job.
    if (inside > 0.3 && !s.promptGone) {
      s.promptGone = true;
      dismissPrompt();
    }

    // The headlamp follows the head.
    camera.getWorldDirection(forward);
    right.crossVectors(forward, camera.up).normalize();
    headlamp.position.copy(camera.position).addScaledVector(right, 0.12).addScaledVector(camera.up, 0.16);
    headlamp.target.position.copy(camera.position).addScaledVector(forward, 6);
    headlamp.target.updateMatrixWorld();
    headlamp.intensity = THREE.MathUtils.lerp(1.6, 5.8, inside);
    lamp.position.value.copy(headlamp.position);
    lamp.direction.value.copy(forward);
    lamp.strength.value = THREE.MathUtils.lerp(0.15, 1, inside);
    lamp.time.value = s.time;
    lamp.inside.value = inside;
    rockUniforms.time.value = s.time;

    // The lens: focused on whatever is in the middle of the view, the air dark and close underground, golden outside.
    const centre = world.rock.march(camera.position.x, camera.position.y, camera.position.z, forward.x, forward.y, forward.z, 40);
    let target = Math.min(centre < 0 ? 40 : Math.max(0.4, centre), treeHit(camera.position, forward, 40));
    // The lake's water is not in the field: focus on it where the middle of the view meets it first.
    if (LAKE.water !== undefined && world.opened.has(LAKE) && forward.y < -0.02 && camera.position.y > LAKE.water) {
      const t = (LAKE.water - camera.position.y) / forward.y;
      if (t < target && cavernDistance(LAKE, camera.position.x + forward.x * t, LAKE.water, camera.position.z + forward.z * t) < 0.3) target = Math.max(0.4, t);
    }
    // A strong, photographic depth of field (owner, 27 Nov: "everything really far away is super sharp"). Outside the
    // focus never reaches past FOCUS_FAR, so the far wood always goes soft; the bokeh scale is a radius in full-size
    // pixels, so the old 0.5–1.4 was a blur of a pixel or two, invisible.
    target = Math.min(target, THREE.MathUtils.lerp(FOCUS_FAR, 40, inside));
    s.focus += (target - s.focus) * Math.min(1, dt * 6);
    focusDistance.value = s.focus;
    focusBlur.value = THREE.MathUtils.clamp(16 / Math.max(1, s.focus), BLUR.min, BLUR.max);
    // The camera's lens, when it is up: zoom, and a shallow focus hunted for and locked on the same target.
    viewfinder.frame(camera, dt, target, inside);
    // A clear midday haze is cool: distant trees and the far cliff go blue-grey outside; the caves keep their near-black air.
    airTint.value.setRGB(THREE.MathUtils.lerp(0.5, 0.02, inside), THREE.MathUtils.lerp(0.62, 0.016, inside), THREE.MathUtils.lerp(0.78, 0.012, inside));
    airAmount.value = THREE.MathUtils.lerp(2.2, 0.7, inside);

    // The space by ear, a few times a second: how many directions are shut in, and how far the walls are. A sweep's
    // rays are cast a few a frame (all fourteen at once were half a millisecond, every ninth frame or so).
    const sweep = s.sweep;
    if (sweep.k < 0 && s.time > s.nextProbe) {
      s.nextProbe = s.time + 0.15;
      sweep.k = sweep.escaped = sweep.sum = sweep.hits = 0;
    }
    for (let n = 0; n < 3 && sweep.k >= 0 && sweep.k < PROBES.length; n++, sweep.k++) {
      const p = PROBES[sweep.k];
      const t = world.rock.march(s.eye.x, s.eye.y, s.eye.z, p.x, p.y, p.z, 12);
      if (t < 0) sweep.escaped++;
      else {
        sweep.sum += t;
        sweep.hits++;
      }
    }
    if (sweep.k >= PROBES.length) {
      sweep.k = -1;
      const enclosed = 1 - sweep.escaped / PROBES.length;
      const mean = sweep.hits ? sweep.sum / sweep.hits : 0;
      s.enclosed = enclosed;
      s.size = THREE.MathUtils.smoothstep(mean, 1.6, 4.5);
      setSpace(Math.max(enclosed * inside, enclosed > 0.85 ? enclosed : 0), s.size);
    }
    // Water dripping somewhere in the dark: now and then underground, often in a cavern.
    if (s.time > s.nextDrip) {
      s.nextDrip = s.time + (s.size > 0.5 ? 0.6 + Math.random() * 1.8 : 2 + Math.random() * 4);
      if (inside > 0.5) drip(Math.random() * 2 - 1, 0.4 + s.size * 0.8);
    }

    // Each opened cavern's light: up from nothing with a flare as the dust clears, then steady.
    CAVERNS.forEach((cavern, k) => {
      const at = s.revealAt[k];
      if (at < 0) return;
      const t = s.time - at;
      rockUniforms.opened.array[k] = 1 - Math.exp(-t * 1.4) + 1.3 * Math.exp(-(((t - 0.6) / 0.4) ** 2));
      if (cavern.kind === "grotto") rockUniforms.since.value = t;
    });
    leaveTrail(s.eye);

    dust.update(dt);
    pebbles.update(dt);
  }, -1);

  return (
    <>
      <primitive object={world.group} />
      <Outside rock={beyond} ground={beyondGround} eye={state.eye} field={world.rock} />
      <Forest sun={SUN_DIRECTION} inside={() => state.inside} aim={aimAt} stone={textures.broken} />
      <primitive object={headlamp} />
      <primitive object={headlamp.target} />
      <primitive object={dust.mesh} />
      <primitive object={pebbles.mesh} />
      <Motes count={startTier === "low" ? 600 : 1600} />
      <Caverns world={world} />
      <Bats />
      <Torches />
      <Ladders rock={world.rock} />
      <Dressings world={world} textures={textures} />
      <Collectibles rock={world.rock} textures={textures} />
    </>
  );
}

// A line that says what you have broken into, rising in for a few seconds.
function Overlay() {
  const cavern = useSyncExternalStore(
    (listener) => {
      found.listeners.add(listener);
      return () => found.listeners.delete(listener);
    },
    () => found.cavern,
    () => null
  );
  const at = useSyncExternalStore(
    (listener) => {
      found.listeners.add(listener);
      return () => found.listeners.delete(listener);
    },
    () => found.at,
    () => 0
  );
  return (
    <>
      <style>{`
        .burrow-found { position: fixed; left: 50%; top: 22%; transform: translateX(-50%); pointer-events: none; text-align: center; color: #f4e6d2; font-size: 15px; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0; text-shadow: 0 1px 12px rgba(0,0,0,0.7); animation: burrow-found 5.5s ease forwards; }
        .burrow-found strong { display: block; font-size: 34px; letter-spacing: 0.02em; text-transform: none; font-weight: 500; margin-top: 6px; }
        @keyframes burrow-found { 0% { opacity: 0; transform: translate(-50%, 10px); } 12% { opacity: 1; transform: translate(-50%, 0); } 75% { opacity: 1; } 100% { opacity: 0; } }
        @media (max-width: 560px), (max-height: 520px) { .burrow-found { width: calc(100vw - 32px); font-size: 12px; } .burrow-found strong { font-size: 26px; } }
      `}</style>
      <Backpack />
      <Stick />
      <Found />
      <LadderHud />
      {cavern ? (
        <div key={at} className="burrow-found">
          You broke into
          <strong>{cavern.name}</strong>
        </div>
      ) : null}
    </>
  );
}

const day: DayDefinition = {
  camera: { position: [0.6, 1.4, 20], target: [1.2, 3.8, 10], fov: 62 },
  look: {
    // Black behind, so the overlay pass (dust, motes) adds only light; the sky is a dome.
    background: "#000000",
    exposure: 1.0,
    bloom: 0.32,
    bloomThreshold: 0.8,
    gi: 0,
    ao: 1.1,
    aoRadius: 0.45,
    vignette: 0.52,
    grain: 0.02,
    haze: 0
  },
  // A retina screen drawn at 1.5 rather than 2: 44% fewer pixels to shade through the forest's leaf cards and the rock,
  // with the depth of field softening most of the frame anyway (phones already draw at 1.5).
  maxDpr: 1.5,
  passes: { bounce: false, haze: false, overlay: true, occlusion: false, depthOfField: { range: 3, air: 0.14, airRate: 0.01, sharpSky: true, blurScale: 0.25 } },
  settings: {
    torch: { type: "action", label: isTouch() ? "Mount a torch" : "Mount a torch (T)" },
    ladder: { type: "action", label: isTouch() ? "Carry a ladder" : "Place a ladder (L)" }
  },
  // (The day is loaded in the browser, so the prompt can say which controls this screen has.)
  prompt: isTouch()
    ? { title: "Go explore the caves", detail: "Walk up to the cliff and tap it to dig · drag to look" }
    : { title: "Go explore the caves", detail: "Walk up to the cliff and click it to dig · WASD to walk", high: true },
  Overlay,
  hint: "Walk up to the cliff and click its face to dig in (the ground outside won't give); once you're in the rock, dig any way, down too. T or a right click mounts one of your 60 torches. L takes one of 5 ladders: lean it on a wall up to a ledge or an opening, walk into it to climb, right click it to take it back. P raises a camera: hold Shift to line up a shot and click or Space to take it. The rock goes on for ever, and so do the caverns.",
  // Burrow's own controls in place of the default orbit-and-fly line.
  hintControls: "Click the cliff up close to dig · drag to look · WASD to walk · Space to jump · T torch · L ladder, W to climb · P camera",
  notes: "A granite cliff in a forest clearing at midday. Walk up and dig in with a pick, light your way with torches, and break into what the rock has hidden.",
  overview: [
    {
      title: "Endless rock",
      points: [
        "A signed field with no edge: a cliff, its plateau and the ground, sampled at 20 cm in 6.4 m chunks as you come near.",
        "Workers mesh the nearest chunks by surface nets; every dig is kept as a sparse edit, so tunnels come back as left.",
        "Caverns come from hashed cells in staggered layers, one every 10–20 m dug any way; a worker dresses each; finds sit in finer cells."
      ]
    },
    {
      title: "Underground",
      points: [
        "Sky light fades with depth into the rock, and the sun's shadow map follows you so it never shines through stone.",
        "You carry 60 torches (camps hold spares); the nearest six mounted get real lights, the rest keep flame and glow.",
        "Cavern glows are summed per vertex; still pools mirror the torches by reflecting the view, with no second render."
      ]
    },
    {
      title: "Sound",
      points: [
        "Rays through the rock measure the space round you; strikes, drips and torches feed a short and a long reverb.",
        "Strikes ring hollow as the rock thins over a cavern; each kind opens with its own voice, a river roars through stone."
      ]
    }
  ],
  Scene
};

export default day;
