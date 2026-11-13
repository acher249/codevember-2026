"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { Fn, exp, float, length, max, screenCoordinate, sin, smoothstep, time, uniform, vec3 } from "three/tsl";
import { bayer16 } from "three/addons/tsl/math/Bayer.js";
import { orbitPoint } from "../shared/engine/controls";
import { worldOffset } from "../shared/engine/extents";
import { mulberry32 } from "../shared/engine/random";
import { airAmount, focusBlur, focusDistance, HAZE_LAYER, hazeLink } from "../shared/engine/Post";
import { holdQuality, useQuality } from "../shared/engine/quality";
import { sound } from "../shared/engine/sound";
import { useLook } from "../shared/engine/Stage";
import { StudioEnvironment } from "../shared/engine/studio";
import { CELL, createAir, groundMaterial, hedgeGeometry, hedgeMaterial, HEIGHT, sharedAir, skyMaterial, sprigGeometry, sprigMaterial, tallness, THICK, WALL_LENGTH, type Air } from "./hedge-look";
import { Maze } from "./hedge-maze";
import { useDressing } from "./dressing";
import type { QualityTier } from "../shared/engine/types";
import { trafficMesh } from "./tech";
import { Bunnies } from "./bunnies";
import { Adapt, Birds, Fireflies } from "./life";
import { Gravel } from "./gravel";
import type { StudyView } from "./view";
import { farReach, stepStudies, type Study, trackViewer, warp } from "./warp";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A hedge maze at the end of a summer evening, which never stops rewriting itself. Walls sink into the earth and
// others grow back out of it, a loop at a time, so it is always a true maze with one way through.
export const VIEW: StudyView = { position: [-12.5, 4.2, 5], target: [-14.85, 3.6, -9.5], fov: 54 };

// Cells across the maze, which repeats beyond the mist, and how many cells out from the camera are drawn on each tier.
// Walls nearer than NEAR get the finely made hedge.
export const SIZE = 40;
const REACH = { high: 20, medium: 16, low: 12 };
const NEAR = 24;
// How deep a sunken hedge goes, so that nothing of it shows through the ground.
export const SINK = HEIGHT + 0.4;
// How far up each wall stands this frame, 0 sunk to 1 grown, for walking to bump into.
export const liveHeights: { current: Float32Array | null } = { current: null };
// When, by the page's clock, every hedge had finished rising out of the ground at the start.
export const hedgesUp = { at: Infinity };
// Seconds between the maze's own changes, somewhere near where the camera is looking.
const EVERY = 0.55;
// The rustle of a hedge as it moves sounded like feathers, so it is off until a better sound replaces it.
const MOVING_SOUND = false;

// Black behind the sky dome: the overlay pass clears to the background colour and adds it over everything.
export const LOOK = { background: "#000000", exposure: 1.08, bloom: 0.15, bloomThreshold: 0.85, gi: 2, ao: 0.85, aoRadius: 0.6, aoReach: 45, haze: 0.7, vignette: 0.5, grain: 0.018 };

export function Hedge({ study = "flat" }: { study?: Study }) {
  const { tier } = useQuality();
  const size = SIZE;
  const reach = REACH[tier];
  const air = useMemo(() => createAir(), []);
  useLook(LOOK);
  // The ambience is chosen in the settings, and played by the day: see sounds.ts.

  // The earth under each hedge, as the ground shader reads it: east side in red, south side in green.
  const beds = useMemo(() => {
    const texture = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size, THREE.RGBAFormat);
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return texture;
  }, [size]);
  useEffect(() => () => beds.dispose(), [beds]);

  // The mist is as thick on every tier, but comes in to hide the edge sooner on those that draw less of the maze. A bent
  // world thins it and pushes it back, so that the maze can be seen rising up into the sky.
  const thick = useMemo(() => ({ density: air.density.value, lying: air.lying.value }), [air]);
  const far = (reach - 1.5) * CELL;

  // The materials carry the mist themselves, coloured by where the sun is, so the post stack's own air stays off.
  useEffect(() => {
    airAmount.value = 0;
    focusBlur.value = 1.7;
    return () => {
      airAmount.value = 1;
      focusBlur.value = 1;
    };
  }, []);

  const camera = useThree((state) => state.camera);
  useFrame((_, delta) => {
    if (orbitPoint.current) focusDistance.value = Math.max(0.5, camera.position.distanceTo(orbitPoint.current));
    stepStudies(study, Math.min(delta, 0.1));
    trackViewer(camera);
    // The hedges rising and the world bending are heavy while they last, and pass: no reason for Auto to lower the quality.
    const bending = (amount: number) => amount > 0 && amount < 1;
    if (hedgesUp.at === Infinity || bending(warp.ring.value) || bending(warp.fold.value) || bending(warp.twist.value)) holdQuality(2000);
    // The air clears early as a study comes in and thickens late as it goes, so that what is up in the sky is never seen
    // as a sheet of mist.
    const clear = (amount: number) => 1 - (1 - amount) ** 4;
    const ring = clear(warp.ring.value);
    const fold = clear(warp.fold.value);
    const twist = clear(warp.twist.value);
    const bent = Math.max(ring, fold, twist);
    air.far.value = far * (1 + ring * 9 + fold * 4 + twist * 3);
    // The air in use, for the styles (React may make a second one in development and throw it away).
    sharedAir.current = air;
    air.density.value = thick.density * (1 - bent * 0.88);
    air.lying.value = thick.lying * (1 - bent * 0.9);
    // Less blur far off, so that what rises up into the sky is not lost in it.
    focusBlur.value = 1.7 * (1 - bent);
  });

  return (
    <>
      <Sky air={air} />
      <Sun air={air} />
      <StudioEnvironment
        ambient="#5d5446"
        // The low tier has no bounce light to lift the shade, so the sky does more of it.
        intensity={tier === "low" ? 0.95 : 0.85}
        boxes={[
          { position: [0, 12, 0], scale: [30, 0.2, 30], color: "#8fa6c8", intensity: 1.3 },
          { position: [air.sun.value.x * 12, air.sun.value.y * 12 + 1, air.sun.value.z * 12], scale: [8, 3, 8], color: "#ffb067", intensity: 4 },
          { position: [0, -6, 0], scale: [30, 0.2, 30], color: "#8a7556", intensity: 0.5 }
        ]}
      />
      <Mist air={air} />
      <Ground air={air} beds={beds} size={size} />
      {/* Not remounted when the tier changes: the maze, and where every wall has got to, carry on through it. */}
      <Hedges air={air} size={size} reach={reach} beds={beds} />
      <Adapt exposure={LOOK.exposure} down={2.2} />
      {tier !== "low" && <Gravel air={air} across={tier === "high" ? 9 : 7} />}
      <Fireflies count={tier === "high" ? 260 : tier === "medium" ? 160 : 70} />
      <SkyTraffic tier={tier} />
      <Bunnies air={air} tier={tier} />
      <Birds air={air} count={tier === "low" ? 90 : tier === "medium" ? 180 : 260} flock={tier === "low" ? 36 : 80} skein={tier === "low" ? 11 : 19} />
    </>
  );
}

// The sky dome goes wherever the camera does, so it is never reached.
function Sky({ air }: { air: Air }) {
  const material = useMemo(() => skyMaterial(air), [air]);
  useEffect(() => () => material.dispose(), [material]);
  const camera = useThree((state) => state.camera);
  const mesh = useRef<THREE.Mesh>(null);
  useFrame(() => mesh.current?.position.copy(camera.position));
  return (
    <mesh ref={mesh} material={material} renderOrder={-1} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[300, 48, 24]} />
    </mesh>
  );
}

// The ground, slid along under the camera a whole metre at a time; its pattern is drawn from where it lies in the world.
// Long north to south, and cut into strips, for when the world is bent up into a ring or a fold.
function Ground({ air, beds, size }: { air: Air; beds: THREE.DataTexture; size: number }) {
  const material = useMemo(() => groundMaterial(air, beds, size), [air, beds, size]);
  useEffect(() => () => material.dispose(), [material]);
  const camera = useThree((state) => state.camera);
  const mesh = useRef<THREE.Mesh>(null);
  useFrame(() => mesh.current?.position.set(Math.round(camera.position.x), 0, Math.round(camera.position.z)));
  return (
    // Drawn after the hedges, so that the depth test spares the costly gravel wherever a hedge stands in front of it.
    <mesh ref={mesh} material={material} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1} receiveShadow frustumCulled={false} raycast={() => null}>
      <planeGeometry args={[260, 900, 130, 450]} />
    </mesh>
  );
}

// The low sun. A spot rather than a directional light, because only lights with a reach light the mist, but so far off
// and with no falloff that it might as well be the sun. It follows what the camera looks at, its shadow with it.
function Sun({ air }: { air: Air }) {
  const { tier } = useQuality();
  const light = useMemo(() => {
    const spot = new THREE.SpotLight("#ffbb70", 5.5, 0, Math.atan(58 / 160), 0.25, 0);
    spot.castShadow = true;
    spot.shadow.bias = -0.0004;
    spot.shadow.normalBias = 0.03;
    spot.shadow.radius = 4;
    spot.shadow.camera.near = 90;
    spot.shadow.camera.far = 240;
    spot.layers.enable(HAZE_LAYER);
    return spot;
  }, []);

  useEffect(() => {
    const size = tier === "high" ? 4096 : tier === "medium" ? 2048 : 1024;
    light.shadow.mapSize.set(size, size);
    light.shadow.map?.dispose();
    light.shadow.map = null;
  }, [light, tier]);
  useEffect(() => () => light.dispose(), [light]);

  const camera = useThree((state) => state.camera);
  useFrame(() => {
    const focus = orbitPoint.current ?? camera.position;
    // Whole metres, so the shadow does not crawl as the view turns.
    const x = Math.round(focus.x);
    const z = Math.round(focus.z);
    const sun = air.sun.value;
    // A bent world brings maze from hundreds of metres off into view, all of which the sun must reach, so it goes
    // further off and lights a wider circle; its shadow still covers only the same circle round what is looked at.
    const bent = Math.max(warp.ring.value, warp.fold.value, warp.twist.value);
    const away = 160 + bent * 840;
    light.angle = Math.atan((58 + bent * 470) / away);
    light.shadow.focus = Math.atan(58 / away) / light.angle;
    if (light.shadow.camera.near !== away - 70) {
      light.shadow.camera.near = away - 70;
      light.shadow.camera.far = away + 80;
      light.shadow.camera.updateProjectionMatrix();
    }
    light.target.position.set(x, 0, z);
    light.position.set(x + sun.x * away, sun.y * away, z + sun.z * away);
    light.target.updateMatrixWorld();
  });

  return (
    <>
      <primitive object={light} />
      <primitive object={light.target} />
    </>
  );
}

// Mist lying in the paths, raymarched by the post stack at low resolution so the sun can throw shafts through it.
function Mist({ air }: { air: Air }) {
  const { tier } = useQuality();
  const centre = useMemo(() => uniform(new THREE.Vector3()), []);
  const material = useMemo(() => {
    const volume = new THREE.VolumeNodeMaterial() as any;
    volume.steps = tier === "high" ? 20 : 12;
    volume.offsetNode = bayer16(screenCoordinate);
    volume.scatteringNode = Fn(({ positionRay }: any) => {
      // Carried through every wrap of the camera, so the billows do not jump when it is sent back a period.
      const p = positionRay.add(worldOffset).add(vec3(time.mul(0.18), 0, time.mul(-0.07)));
      const billow = sin(p.x.mul(0.41).add(sin(p.z.mul(0.33).add(p.y)))).mul(sin(p.z.mul(0.37).add(sin(p.x.mul(0.29))))).mul(0.5).add(0.5);
      const low = exp(max(positionRay.y, float(0)).div(-1.3));
      // Thinning out well before the sides of the box, which would otherwise show as a line along the horizon.
      const out = length(positionRay.xz.sub(centre.xz));
      const inside = float(1).sub(smoothstep(30, 54, out));
      return float(0.012).add(low.mul(0.08)).mul(billow.mul(0.7).add(0.3)).mul(air.density.mul(30)).mul(inside);
    });
    return volume;
  }, [air, centre, tier]);

  useEffect(() => {
    hazeLink.add(material);
    return () => {
      hazeLink.remove(material);
      material.dispose();
    };
  }, [material]);

  const camera = useThree((state) => state.camera);
  const mesh = useRef<THREE.Mesh>(null);
  useFrame(() => {
    mesh.current?.position.set(Math.round(camera.position.x), 4, Math.round(camera.position.z));
    if (mesh.current) centre.value.copy(mesh.current.position);
  });

  if (tier === "low") return null;
  return (
    <mesh
      ref={mesh}
      material={material}
      receiveShadow
      onUpdate={(m) => {
        m.layers.disableAll();
        m.layers.enable(HAZE_LAYER);
      }}
    >
      <boxGeometry args={[110, 8, 110]} />
    </mesh>
  );
}

// A batch holds only as many instances as it has lately needed, doubling when it runs out and halving once it has needed
// far fewer for a while: the motion vectors keep a copy of last frame's matrices, uploaded whole every frame.
// Nothing drawn with the hedge material may grow, though: it has too many attributes of its own for WebGPU to bind
// instance data per object, so its shaders hold on to the buffers they were built with, and a resized batch draws nothing.
type Batch = { mesh: THREE.InstancedMesh; rest: THREE.InstancedBufferAttribute; count: number; capacity: number; least: number; limit: number; shared: THREE.InstancedMesh[]; spare: number };
const LEAST = 256;

function batch(geometry: THREE.BufferGeometry, material: THREE.Material, limit: number, grows = false): Batch {
  const least = grows ? LEAST : limit;
  const mesh = new THREE.InstancedMesh(geometry, material, least);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.count = 0;
  const part = { mesh, rest: null as unknown as THREE.InstancedBufferAttribute, count: 0, capacity: 0, least, limit, shared: [], spare: 0 };
  resize(part, least);
  return part;
}

// New buffers of another size for a batch and every mesh drawn with its instances, keeping those placed so far.
function resize(part: Batch, capacity: number) {
  const matrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
  const rest = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  matrix.setUsage(THREE.DynamicDrawUsage);
  rest.setUsage(THREE.DynamicDrawUsage);
  const kept = Math.min(part.count, capacity);
  const oldMatrix = part.mesh.instanceMatrix;
  const oldRest = part.rest;
  if (oldRest) {
    matrix.array.set((oldMatrix.array as Float32Array).subarray(0, kept * 16));
    rest.array.set((oldRest.array as Float32Array).subarray(0, kept * 4));
  }
  for (const mesh of [part.mesh, ...part.shared]) {
    mesh.instanceMatrix = matrix;
    mesh.geometry.setAttribute("aRest", rest);
  }
  oldMatrix.dispose();
  oldRest?.dispose();
  part.rest = rest;
  part.capacity = capacity;
  part.spare = 0;
}

// Once a frame, after placing: a batch that has used under a third of its room for two seconds or so gives half back.
function settle(part: Batch) {
  part.spare = part.capacity > part.least && part.count * 3 < part.capacity ? part.spare + 1 : 0;
  if (part.spare > 120) resize(part, Math.max(part.least, part.capacity / 2));
}

// Puts one more hedge into a batch: where it stands grown, whether it runs north to south, and how far it has sunk.
// Sprigs drawn with the same instances as a batch of hedges, sharing where each one stands.
function sprigs(geometry: THREE.BufferGeometry, material: THREE.Material, hedges: Batch) {
  geometry.setAttribute("aRest", hedges.rest);
  const mesh = new THREE.InstancedMesh(geometry, material, 1);
  mesh.name = "sprigs";
  mesh.instanceMatrix.dispose();
  mesh.instanceMatrix = hedges.mesh.instanceMatrix;
  hedges.shared.push(mesh);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.count = 0;
  return mesh;
}

// Hedges past the usual reach, seen only when the world is bent up into view: a plain box each, unshadowed, in a batch of
// fixed size, as they wear the hedge material.
const ARCH = 40000;
function arch(length: number, material: THREE.Material, capacity: number) {
  const geometry = new THREE.BoxGeometry(length, HEIGHT + 0.3, THICK);
  geometry.translate(0, (HEIGHT - 0.3) / 2, 0);
  const part = batch(geometry, material, capacity);
  part.mesh.castShadow = false;
  return part;
}

function place(target: Batch, x: number, z: number, turned: boolean, sink: number) {
  if (target.count >= target.capacity) {
    if (target.capacity >= target.limit) return;
    resize(target, Math.min(target.limit, target.capacity * 2));
  }
  const i = target.count++;
  const m = target.mesh.instanceMatrix.array as Float32Array;
  const o = i * 16;
  // Written in place, not from an array made for each one: thousands go in a frame.
  m.fill(0, o, o + 16);
  m[o + 5] = tallness(x, z);
  m[o + 15] = 1;
  if (turned) {
    m[o + 2] = -1;
    m[o + 8] = 1;
  } else {
    m[o] = 1;
    m[o + 10] = 1;
  }
  m[o + 12] = x;
  m[o + 13] = -sink;
  m[o + 14] = z;
  const r = target.rest.array as Float32Array;
  r[i * 4] = x;
  r[i * 4 + 1] = z;
  r[i * 4 + 2] = turned ? 1 : 0;
  r[i * 4 + 3] = sink;
}

function Hedges({ air, size, reach, beds }: { air: Air; size: number; reach: number; beds: THREE.DataTexture }) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const { tier } = useQuality();

  const maze = useMemo(() => new Maze(size, 1313), [size]);
  const dress = useDressing(air, tier);
  // Made once, not again with each tier, so that a change of tier builds no new shaders.
  const looks = useMemo(() => ({ material: hedgeMaterial(air), farMaterial: hedgeMaterial(air, true), sprig: sprigMaterial(air) }), [air]);
  useEffect(
    () => () => {
      looks.material.dispose();
      looks.farMaterial.dispose();
      looks.sprig.dispose();
    },
    [looks]
  );
  const parts = useMemo(() => {
    const { material, farMaterial, sprig } = looks;
    const fine = tier === "low" ? 0.7 : 1;
    const walls = size * size * 2;
    const near = batch(hedgeGeometry(WALL_LENGTH, THICK, fine), material, walls);
    const posts = batch(hedgeGeometry(THICK, THICK, fine * 0.8), material, size * size);
    // Only the walls between posts grow sprigs; their tucked-in ends are inside the posts.
    const density = tier === "high" ? 40 : tier === "medium" ? 34 : 16;
    return {
      near,
      far: batch(hedgeGeometry(WALL_LENGTH, THICK, 0.4), farMaterial, walls),
      posts,
      farPosts: batch(hedgeGeometry(THICK, THICK, 0.35), farMaterial, size * size),
      archWalls: arch(WALL_LENGTH, farMaterial, ARCH * 2),
      archPosts: arch(THICK, farMaterial, ARCH),
      fringes: density
        ? [sprigs(sprigGeometry(CELL - THICK, THICK, density, 7), sprig, near), sprigs(sprigGeometry(THICK, THICK, density, 11), sprig, posts)]
        : []
    };
  }, [looks, size, tier]);

  useEffect(
    () => () => {
      for (const part of [parts.near, parts.far, parts.posts, parts.farPosts, parts.archWalls, parts.archPosts]) {
        part.mesh.geometry.dispose();
        part.mesh.dispose();
      }
      for (const fringe of parts.fringes) fringe.geometry.dispose();
    },
    [parts]
  );

  const state = useRef({ clock: 0, next: 2, nextFar: 2, pace: mulberry32(29), risen: false, upBy: Infinity, heights: new Float32Array(size * size * 2), earth: new Float32Array(size * size * 2), sounds: [] as { at: number; x: number; z: number; rising: boolean }[] });
  const scratch = useMemo(() => ({ right: new THREE.Vector3(), to: new THREE.Vector3() }), []);

  // Which copy of a cell is the one nearest a point, in whole cells of the world.
  const nearest = (slot: number, around: number) => slot + size * Math.floor((around + size / 2 - slot) / size);
  const slotOf = (world: number) => ((world % size) + size) % size;

  // A rustle from wherever a hedge is moving, quieter further off, and from its side of the view.
  const rustle = (x: number, z: number, rising: boolean) => {
    scratch.to.set(x, 1, z).sub(camera.position);
    const distance = scratch.to.length();
    scratch.right.setFromMatrixColumn(camera.matrixWorld, 0);
    const pan = Math.max(-1, Math.min(1, scratch.to.normalize().dot(scratch.right) * 1.2));
    const gain = Math.min(1, 7 / Math.max(distance, 1));
    if (!MOVING_SOUND || gain < 0.08) return;
    sound.play("rustle", { gain: gain * (rising ? 0.9 : 0.7), pan, pitch: rising ? 0.62 : 0.5, size: 0.8 });
  };

  // Rewires the maze around a cell, and queues the sound of each wall as it begins to move.
  const change = (cell: number, reach: number, now: number, cx: number, cz: number) => {
    const done = maze.change(cell, reach, now);
    if (!done) return;
    for (const wall of [done.opened, done.closed]) {
      const own = wall >> 1;
      const wx = (nearest(own % size, cx) + (wall & 1 ? 0.5 : 1)) * CELL;
      const wz = (nearest(Math.floor(own / size), cz) + (wall & 1 ? 1 : 0.5)) * CELL;
      state.current.sounds.push({ at: maze.start[wall], x: wx, z: wz, rising: wall === done.closed });
    }
  };

  // A press that does not turn the view rewires the maze where it lands.
  useEffect(() => {
    const dom = gl.domElement;
    const press = { x: 0, y: 0, time: 0 };
    const ray = new THREE.Raycaster();
    const hit = new THREE.Vector3();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1);
    const down = (event: PointerEvent) => Object.assign(press, { x: event.clientX, y: event.clientY, time: performance.now() });
    const up = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6 || performance.now() - press.time > 400) return;
      const rect = dom.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera);
      if (!ray.ray.intersectPlane(ground, hit)) return;
      const cx = Math.floor(camera.position.x / CELL);
      const cz = Math.floor(camera.position.z / CELL);
      const cell = slotOf(Math.floor(hit.z / CELL)) * size + slotOf(Math.floor(hit.x / CELL));
      for (let i = 0; i < 4; i++) change(cell, 1.5, state.current.clock + i * 0.25, cx, cz);
    };
    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointerup", up);
    return () => {
      dom.removeEventListener("pointerdown", down);
      dom.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, camera, maze, size]);

  useFrame((_, delta) => {
    const run = state.current;
    const step = Math.min(delta, 1 / 8);
    run.clock += step;
    const now = run.clock;
    const cx = Math.floor(camera.position.x / CELL);
    const cz = Math.floor(camera.position.z / CELL);
    if (!run.risen) {
      run.risen = true;
      maze.rise(slotOf(cz) * size + slotOf(cx), now + 0.4);
      run.upBy = maze.settled();
      hedgesUp.at = Infinity;
    }
    if (hedgesUp.at === Infinity && now >= run.upBy) hedgesUp.at = performance.now();

    // The maze's own changes, somewhere around what the camera is looking at.
    if (now > run.next) {
      run.next = now + EVERY * (0.6 + run.pace() * 0.8);
      const focus = orbitPoint.current ?? camera.position;
      change(slotOf(Math.floor(focus.z / CELL)) * size + slotOf(Math.floor(focus.x / CELL)), 6, now, cx, cz);
    }
    // And while the world is bent up into view, changes anywhere in it too, so the walls far up the bend rise and sink.
    if (now > run.nextFar && farReach()) {
      run.nextFar = now + EVERY * 0.5 * (0.6 + run.pace() * 0.8);
      change(Math.floor(run.pace() * size * size), size / 2, now, cx, cz);
    }
    for (let i = run.sounds.length - 1; i >= 0; i--) {
      const queued = run.sounds[i];
      if (now < queued.at) continue;
      rustle(queued.x, queued.z, queued.rising);
      run.sounds.splice(i, 1);
    }

    // Earth shows as soon as a hedge starts to rise, and once it has sunk is slowly raked over.
    const { heights, earth } = run;
    liveHeights.current = heights;
    const texels = beds.image.data as Uint8Array;
    for (let wall = 0; wall < heights.length; wall++) {
      const h = maze.height(wall, now);
      heights[wall] = h;
      earth[wall] = h > 0.002 ? 1 : Math.max(0, earth[wall] - step / 12);
      texels[(wall >> 1) * 4 + (wall & 1)] = earth[wall] * 255;
    }
    beds.needsUpdate = true;
    const { near, far, posts, farPosts } = parts;
    near.count = far.count = posts.count = farPosts.count = 0;
    dress.start(camera as THREE.PerspectiveCamera);
    const px = camera.position.x;
    const pz = camera.position.z;
    for (let j = 0; j < size; j++) {
      const wz = nearest(j, cz);
      if (Math.abs(wz - cz) > reach) continue;
      for (let i = 0; i < size; i++) {
        const wx = nearest(i, cx);
        if (Math.abs(wx - cx) > reach) continue;
        const cell = j * size + i;
        for (let side = 0; side < 2; side++) {
          const h = heights[cell * 2 + side];
          if (h < 0.002) continue;
          const x = (wx + (side ? 0.5 : 1)) * CELL;
          const z = (wz + (side ? 1 : 0.5)) * CELL;
          const distance = Math.hypot(x - px, z - pz);
          place(distance < NEAR ? near : far, x, z, side === 0, (1 - h) * SINK);
          dress.wall(x, z, side === 0, (1 - h) * SINK, distance);
        }
        // A post stands at the south-east corner, as tall as the tallest wall that meets it.
        const east = (j * size + ((i + 1) % size)) * 2 + 1;
        const south = (((j + 1) % size) * size + i) * 2;
        const post = Math.max(heights[cell * 2], heights[cell * 2 + 1], heights[east], heights[south]);
        if (post < 0.002) continue;
        const x = (wx + 1) * CELL;
        const z = (wz + 1) * CELL;
        const distance = Math.hypot(x - px, z - pz);
        place(distance < NEAR ? posts : farPosts, x, z, false, (1 - post) * SINK);
        dress.post(x, z, (1 - post) * SINK, distance);
      }
    }
    dress.finish();

    // Out past the usual reach, wherever the bent world lifts the maze into view, plain boxes.
    const { archWalls, archPosts } = parts;
    archWalls.count = archPosts.count = 0;
    const out = farReach();
    if (out) {
      for (let wz = Math.floor((pz - out.north) / CELL); wz <= Math.ceil((pz + out.south) / CELL); wz++) {
        for (let wx = Math.floor((px - out.side) / CELL); wx <= Math.ceil((px + out.side) / CELL); wx++) {
          // Skipping only what the hedges above drew: their nearest copy of each cell, which at full reach leaves one
          // row and column at the edge to be drawn here.
          if (Math.abs(wx - cx) <= reach && Math.abs(wz - cz) <= reach && nearest(slotOf(wx), cx) === wx && nearest(slotOf(wz), cz) === wz) continue;
          if (archPosts.count >= ARCH) break;
          const i = slotOf(wx);
          const j = slotOf(wz);
          const cell = j * size + i;
          const east = heights[cell * 2];
          const south = heights[cell * 2 + 1];
          if (east > 0.002) place(archWalls, (wx + 1) * CELL, (wz + 0.5) * CELL, true, (1 - east) * SINK);
          if (south > 0.002) place(archWalls, (wx + 0.5) * CELL, (wz + 1) * CELL, false, (1 - south) * SINK);
          const post = Math.max(east, south, heights[(j * size + slotOf(wx + 1)) * 2 + 1], heights[(slotOf(wz + 1) * size + i) * 2]);
          if (post > 0.002) place(archPosts, (wx + 1) * CELL, (wz + 1) * CELL, false, (1 - post) * SINK);
        }
      }
    }
    if (parts.fringes.length) {
      parts.fringes[0].count = near.count;
      parts.fringes[1].count = posts.count;
    }
    for (const part of [near, far, posts, farPosts, archWalls, archPosts]) {
      settle(part);
      part.mesh.count = part.count;
      part.mesh.instanceMatrix.clearUpdateRanges();
      part.mesh.instanceMatrix.addUpdateRange(0, part.count * 16);
      part.mesh.instanceMatrix.needsUpdate = true;
      part.rest.clearUpdateRanges();
      part.rest.addUpdateRange(0, part.count * 4);
      part.rest.needsUpdate = true;
    }
  });

  return (
    <>
      <primitive object={parts.near.mesh} />
      <primitive object={parts.far.mesh} />
      <primitive object={parts.posts.mesh} />
      <primitive object={parts.farPosts.mesh} />
      <primitive object={parts.archWalls.mesh} />
      <primitive object={parts.archPosts.mesh} />
      {parts.fringes.map((fringe) => (
        <primitive key={fringe.uuid} object={fringe} />
      ))}
      {dress.meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
    </>
  );
}

// The craft and packets of light in the Tron sky, put away in every other style by styles.ts.
function SkyTraffic({ tier }: { tier: QualityTier }) {
  const { mesh, material } = useMemo(() => trafficMesh(tier === "low" ? 14 : 30, tier === "low" ? 30 : 80), [tier]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
    [mesh, material]
  );
  return <primitive object={mesh} />;
}
