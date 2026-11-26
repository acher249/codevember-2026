"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { cos, float, lights, smoothstep, uniform, uv, vec3 } from "three/tsl";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { cameraTaken, orbitControls, orbitPoint } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { airTint, focusBlur, focusDistance } from "../../shared/engine/Post";
import { dismissPrompt } from "../../shared/engine/prompt";
import { holdQuality, scenePhase, useQuality } from "../../shared/engine/quality";
import { loadRetried, suspendRetried } from "../../shared/engine/retry";
import { useSettingAction, useSettingRef, useSettingsStore } from "../../shared/engine/settings";
import { sound, useBed, useEvery, useMusic } from "../../shared/engine/sound";
import { StudioEnvironment } from "../../shared/engine/studio";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { CENTRE, EYE } from "./drawings";
import { aimSpotFocus, spotDepth } from "./focus";
import { type DrawingKind, KINDS } from "./kinds";
import { armFor, buildGround, holeMask, STROKES, strokeAt, strokeSpans } from "./ground";
import { buildStreet, CURB, FAR_CURB, FRONT, ROAD, LAMP_Z, PIT_X, sidewalkFeet, stoopTreads, TREE_Z } from "./street";
import { useLoop, useWhileLoop } from "./sound";
import { Shafts } from "./air";

// A chalk drawing on the sidewalk of a brownstone block on a soft sunny morning: a pit, a swimming pool or a flight of
// stone stairs. Walk round it and it is a long flat smear of chalk. Tap it and the view sweeps through the one spot it
// was drawn for, where the chalk is the real thing pixel for pixel, and on that frame the drawing is swapped for the
// real thing. The view sweeps on, drifting as before, and it stays real: walk round it and look in. Tap it again and it
// goes back to chalk the same way.
// Metres throughout; the sidewalk at y = 0.

// The view to start from (the owner's own framing): standing just to the left of the artist's spot and a step behind,
// looking down the sidewalk past the drawing, where it is plainly a drawing. The orbit turns about the point on that
// line of sight nearest the drawing's middle, so dragging walks round the drawing.
const START = new THREE.Vector3(-1.33, 1.63, 4.47);
const AROUND = new THREE.Vector3(0, 0.58, -1.31);
const FOV = 40;
// Where the real thing waits while it is only a drawing: deep under the sidewalk, out of sight but drawn every frame
// (so nothing is built for it the moment it turns real).
const PARKED = -40;
// Once it has been drawn there for a while (its shaders built for the view), it waits out of sight beyond the far end of
// the view instead, where it is left out of the frame altogether.
const AWAY_BELOW = -1000;
const WARM_FRAMES = 90;
// A press that moves less than this (pixels) and lets go this soon (ms) is a tap.
const TAP = { move: 8, time: 450 };
// The sun, low down the street and a little from across the road.
const SUN = new THREE.Vector3(-0.3, 0.45, -1).normalize();
// How soft the street far off is from the spot.
const SPOT_BLUR = 7.5;
// And from anywhere else, where nothing has to match: the background well out of focus.
const AWAY_BLUR = 9;
// The light in the air: the shafts through the canopy, warm.
const SHAFT = new THREE.Color("#ffd9a3");

const ROOT = "/assets/26-anamorph";
const TEXTURES = {
  colour: "/assets/18-pendulum/concrete_floor_worn_001_diff_2k.jpg",
  normal: "/assets/18-pendulum/concrete_floor_worn_001_nor_gl_2k.jpg",
  rough: "/assets/18-pendulum/concrete_floor_worn_001_rough_2k.jpg",
  dirty: `${ROOT}/dirty_concrete_diff_2k.jpg`,
  dirtyNormal: `${ROOT}/dirty_concrete_nor_gl_2k.jpg`,
  cracked: `${ROOT}/cracked_concrete_diff_2k.jpg`,
  crackedNormal: `${ROOT}/cracked_concrete_nor_gl_1k.jpg`,
  granular: `${ROOT}/granular_concrete_nor_gl_1k.jpg`,
  rock: "/assets/17-kelp/low_tide_rocks_diff_2k.jpg",
  rockNormal: "/assets/17-kelp/low_tide_rocks_nor_gl_2k.jpg",
  tiles: `${ROOT}/blue_floor_tiles_01_diff_2k.jpg`,
  tilesNormal: `${ROOT}/blue_floor_tiles_01_nor_gl_2k.jpg`,
  granite: `${ROOT}/granite_tile_diff_2k.jpg`,
  graniteNormal: `${ROOT}/granite_tile_nor_gl_2k.jpg`,
  bark: `${ROOT}/bark_platanus_diff_2k.jpg`,
  barkNormal: `${ROOT}/bark_platanus_nor_gl_2k.jpg`,
  brick: `${ROOT}/red_brick_03_diff_2k.jpg`,
  brickNormal: `${ROOT}/red_brick_03_nor_gl_2k.jpg`,
  asphalt: `${ROOT}/asphalt_02_diff_2k.jpg`,
  asphaltNormal: `${ROOT}/asphalt_02_nor_gl_2k.jpg`
};
const COLOUR = new Set(["colour", "dirty", "rock", "tiles", "granite", "bark", "brick", "asphalt"]);
const MODELS = { lamp: `${ROOT}/street_lamp_01/street_lamp_01_1k.gltf`, hydrant: `${ROOT}/fire_hydrant/fire_hydrant_1k.gltf` };

type Loaded = Record<keyof typeof TEXTURES, THREE.Texture> & { lamp: THREE.Group; hydrant: THREE.Group; extra: Record<string, Record<string, THREE.Texture>> };

// Every texture a painting asks for, each with the painting it is for: all loaded up front, so switching paintings
// waits for nothing.
const OWN = (Object.keys(KINDS) as DrawingKind[]).flatMap((kind) => Object.entries(KINDS[kind].textures as Record<string, { url: string; colour?: boolean }>).map(([name, t]) => ({ kind, name, ...t })));

// The street's own textures and models, and the ones the paintings ask for themselves.
function useAssets(): Loaded {
  const gl = useThree((state) => state.gl);
  const keys = Object.keys(TEXTURES) as (keyof typeof TEXTURES)[];
  const urls = [...keys.map((k) => TEXTURES[k]), MODELS.lamp, MODELS.hydrant, ...OWN.map((t) => t.url)];
  const loaded = suspendRetried(
    () =>
      Promise.all([
        ...keys.map((k) => loadRetried(new THREE.TextureLoader(), TEXTURES[k])),
        loadRetried(new GLTFLoader(), MODELS.lamp),
        loadRetried(new GLTFLoader(), MODELS.hydrant),
        ...OWN.map((t) => loadRetried(new THREE.TextureLoader(), t.url))
      ]),
    ["anamorph-street", ...urls]
  );
  return useMemo(() => {
    const out = {} as Loaded;
    keys.forEach((k, i) => {
      const t = loaded[i] as THREE.Texture;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = Math.min(8, (gl as any).getMaxAnisotropy?.() ?? 8);
      if (COLOUR.has(k)) t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      out[k] = t;
    });
    out.lamp = (loaded[keys.length] as any).scene;
    out.hydrant = (loaded[keys.length + 1] as any).scene;
    out.extra = {};
    OWN.forEach((own, i) => {
      const t = loaded[keys.length + 2 + i] as THREE.Texture;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = Math.min(8, (gl as any).getMaxAnisotropy?.() ?? 8);
      if (own.colour) t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      (out.extra[own.kind] ??= {})[own.name] = t;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, gl]);
}

// The artist's chalk, left lying about: a handful dropped just in front of the drawing's near edge, a few kicked off past its
// far side, and a box's worth spilled in front of the tree up the sidewalk to the left. Some worn down, a couple
// snapped. Made once; laid out again for each painting (placeSticks), never on the chalk itself.
const STICKS = { near: 11, back: 5, tree: 8 };
// Fat sidewalk chalk, 3.6 cm across and 7 to 13 cm long.
const STICK_RADIUS = 0.018;
function chalkSticks() {
  const colours = ["#f2efe6", "#f2efe6", "#e9b3c2", "#f3d98a", "#9cc3e6", "#c98d5a", "#2a2a2e", "#a5d6a0", "#f2efe6", "#e58f6b", "#c7a3d9", "#f2efe6"];
  const geometry = new THREE.CylinderGeometry(STICK_RADIUS, STICK_RADIUS, 1, 10);
  const materials = colours.map((colour) => new THREE.MeshStandardNodeMaterial({ color: colour, roughness: 0.97 }));
  const group = new THREE.Group();
  for (let k = 0; k < STICKS.near + STICKS.back + STICKS.tree; k++) {
    const mesh = new THREE.Mesh(geometry, materials[(k * 7) % colours.length]);
    const f = hash(k, 1);
    mesh.scale.set(1, 0.07 + f * 0.06, 1);
    mesh.rotation.order = "YZX";
    mesh.rotation.set(0, hash(k, 2) * Math.PI * 2, Math.PI / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, geometries: [geometry], materials };
}

function hash(k: number, n: number) {
  const r = Math.sin(k * 12.9898 + n * 78.233) * 43758.5453;
  return r - Math.floor(r);
}

// Each group about its own spot, the same for every painting: just clear of all their footprints on the sidewalk
// (together x -1.83 to 1.76, z -5.06 to 0.52), so the chalk lies where it was put while the paintings change.
function placeSticks(sticks: THREE.Group) {
  const groups = [
    { count: STICKS.near, x: 1.4, z: 0.97, rx: 0.24, rz: 0.15 },
    { count: STICKS.back, x: 0.4, z: -5.55, rx: 0.5, rz: 0.15 },
    { count: STICKS.tree, x: PIT_X + 0.1, z: TREE_Z.reduce((a, z) => (z < 0 && z > a ? z : a), -99) + 1.35, rx: 0.28, rz: 0.18 }
  ];
  let k = 0;
  groups.forEach((g) => {
    for (let i = 0; i < g.count; i++, k++) {
      const a = i * 2.4 + hash(k, 3);
      const r = 0.25 + 0.75 * Math.sqrt(hash(k, 4));
      const x = THREE.MathUtils.clamp(g.x + Math.cos(a) * g.rx * r, CURB + 0.1, FRONT - 0.1);
      sticks.children[k].position.set(x, STICK_RADIUS, g.z + Math.sin(a) * g.rz * r);
    }
  });
  sticks.updateMatrixWorld(true);
}

// A spot in a corner of the sidewalk, where things blown along it come to rest: against the curb, or round the feet of
// the stoops, areaway curbs and tree pits, pushed out from the edge by up to `spread`. Null where it would leave the
// sidewalk.
function inCorner(r: (n: number) => number, feet: [number, number, number, number][], spread: number): [number, number] | null {
  const drift = Math.pow(r(12), 2.2) * spread;
  if (r(13) < 0.2) return [CURB + 0.04 + drift, 14 - Math.pow(r(2), 0.7) * 50];
  const [x0, x1, z0, z1] = feet[Math.floor(r(14) * feet.length)];
  const w = x1 - x0;
  const h = z1 - z0;
  const t = r(15) * 2 * (w + h);
  let at: [number, number];
  if (t < w) at = [x0 + t, z0 - drift];
  else if (t < w + h) at = [x1 + drift, z0 + t - w];
  else if (t < 2 * w + h) at = [x1 - (t - w - h), z1 + drift];
  else at = [x0 - drift, z1 - (t - 2 * w - h)];
  return at[0] > FRONT - 0.05 || at[0] < CURB + 0.04 ? null : at;
}

// Fallen leaves on the sidewalk, curled and orange-brown, never on the drawing itself: scattered over the flags, and
// more than half of them blown into drifts in the corners, some lying on others. And `inRoad` more down in the road:
// most drifted into the gutters against both curbs, the rest strewn across the asphalt.
function fallenLeaves(covers: (x: number, z: number) => boolean, count: number, inRoad: number) {
  const feet = sidewalkFeet(-38);
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.5);
  [[0.4, -0.1], [0.5, 0.25], [0.15, 0.2], [0, 0.55], [-0.15, 0.2], [-0.5, 0.25], [-0.4, -0.1]].forEach(([x, y]) => shape.lineTo(x, y));
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, side: THREE.DoubleSide });
  // Room for the sidewalk's leaves and up to three on each stoop tread.
  const treads = stoopTreads();
  const mesh = new THREE.InstancedMesh(geometry, material, count + inRoad + treads.length * 3);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  let placed = 0;
  for (let i = 0; placed < count && i < count * 4; i++) {
    const r = (n: number) => {
      const v = Math.sin(i * 91.3 + n * 47.1) * 43758.5453;
      return v - Math.floor(v);
    };
    let at: [number, number] | null = [CURB + 0.2 + r(1) * (FRONT - CURB - 1.9), 14 - Math.pow(r(2), 0.7) * 50];
    const drifted = r(11) < 0.6;
    if (drifted) at = inCorner(r, feet, 0.3);
    if (!at) continue;
    const [x, z] = at;
    if (covers(x, z) || Math.hypot(x - EYE.x, z - EYE.z) < 0.5) continue;
    const size = 0.08 + r(3) * 0.08;
    q.setFromEuler(new THREE.Euler((r(4) - 0.5) * 0.6, r(5) * 6.28, (r(6) - 0.5) * 0.6));
    // Drifted leaves heap up, the ones nearest the edge highest.
    const heap = drifted ? r(7) * 0.035 : r(7) * 0.012;
    m.compose(new THREE.Vector3(x, 0.004 + heap, z), q, new THREE.Vector3(size, size, size));
    mesh.setMatrixAt(placed, m);
    // Mostly orange-brown, some dry and pale, a few still yellow, a few dark and wet.
    const kind = r(8);
    if (kind < 0.6) c.setHSL(0.05 + r(9) * 0.04, 0.55 + r(10) * 0.2, 0.16 + r(16) * 0.12);
    else if (kind < 0.8) c.setHSL(0.08 + r(9) * 0.03, 0.35 + r(10) * 0.15, 0.26 + r(16) * 0.1);
    else if (kind < 0.9) c.setHSL(0.11 + r(9) * 0.03, 0.6, 0.3 + r(16) * 0.08);
    else c.setHSL(0.06, 0.4, 0.07 + r(16) * 0.05);
    mesh.setColorAt(placed, c);
    placed++;
  }
  const sidewalk = placed;
  for (let i = 0; placed < sidewalk + inRoad && i < inRoad * 3; i++) {
    const r = (n: number) => {
      const v = Math.sin(i * 63.7 + n * 29.3) * 43758.5453;
      return v - Math.floor(v);
    };
    const gutter = r(1) < 0.7;
    const x = gutter ? (r(2) < 0.6 ? CURB - 0.04 - Math.pow(r(3), 2.5) * 0.9 : FAR_CURB + 0.04 + Math.pow(r(3), 2.5) * 0.9) : FAR_CURB + 0.3 + r(3) * (CURB - FAR_CURB - 0.6);
    const z = 14 - Math.pow(r(4), 0.7) * 52;
    const size = 0.08 + r(5) * 0.08;
    q.setFromEuler(new THREE.Euler((r(6) - 0.5) * 0.6, r(7) * 6.28, (r(8) - 0.5) * 0.6));
    m.compose(new THREE.Vector3(x, ROAD + 0.004 + (gutter ? r(9) * 0.03 : r(9) * 0.008), z), q, new THREE.Vector3(size, size, size));
    mesh.setMatrixAt(placed, m);
    // Darker and wetter in the gutter, otherwise as on the sidewalk.
    const kind = r(10);
    if (kind < 0.55) c.setHSL(0.05 + r(11) * 0.04, 0.5 + r(12) * 0.2, (gutter ? 0.11 : 0.15) + r(13) * 0.1);
    else if (kind < 0.8) c.setHSL(0.08 + r(11) * 0.03, 0.35, 0.22 + r(13) * 0.08);
    else c.setHSL(0.06, 0.4, 0.06 + r(13) * 0.05);
    mesh.setColorAt(placed, c);
    placed++;
  }
  // A few more settled on the stoops, in the corners of the treads against the cheek walls. Up off the sidewalk and
  // by the houses, nowhere near the drawing.
  treads.forEach(([x0, x1, y, z], t) => {
    const r = (n: number) => {
      const v = Math.sin(t * 57.1 + n * 23.9) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let n = 0; n < Math.floor(r(1) * 4); n++) {
      const side = r(2 + n) < 0.5 ? -1 : 1;
      const size = 0.05 + r(6 + n) * 0.04;
      q.setFromEuler(new THREE.Euler((r(10 + n) - 0.5) * 0.5, r(14 + n) * 6.28, (r(18 + n) - 0.5) * 0.5));
      m.compose(new THREE.Vector3(x0 + r(22 + n) * (x1 - x0), y + 0.005, z + side * (0.72 - r(26 + n) * 0.25)), q, new THREE.Vector3(size, size, size));
      mesh.setMatrixAt(placed, m);
      mesh.setColorAt(placed, c.setHSL(0.05 + r(30 + n) * 0.04, 0.55, 0.15 + r(34 + n) * 0.12));
      placed++;
    }
  });
  mesh.count = placed;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return { mesh, geometries: [geometry], materials: [material] };
}

// The little bits of litter that end up in the same corners: cigarette ends, bottle caps, a crumpled paper or two and
// a wrapper. Plain, nothing printed on any of them.
function litter(covers: (x: number, z: number) => boolean, scale: number) {
  const feet = sidewalkFeet(-30);
  const paper = new THREE.IcosahedronGeometry(1, 1);
  const pp = paper.getAttribute("position");
  for (let i = 0; i < pp.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pp, i);
    const k = 0.7 + 0.5 * Math.abs(Math.sin(v.x * 7.1 + v.y * 5.3 + v.z * 3.7));
    pp.setXYZ(i, v.x * k, v.y * k * 0.7, v.z * k);
  }
  paper.computeVertexNormals();
  const wrapper = new THREE.PlaneGeometry(1, 0.6, 4, 3);
  const wp = wrapper.getAttribute("position");
  for (let i = 0; i < wp.count; i++) wp.setZ(i, Math.sin(wp.getX(i) * 13 + wp.getY(i) * 7) * 0.06);
  wrapper.computeVertexNormals();
  wrapper.rotateX(-Math.PI / 2);
  const butt = new THREE.CylinderGeometry(1, 1, 1, 7);
  butt.rotateZ(Math.PI / 2);
  const cap = new THREE.CylinderGeometry(1, 1, 1, 12);
  const kinds = [
    { geometry: butt, count: 46, size: [0.0042, 0.0042, 0.028], y: 0.0042, colours: ["#c99a63", "#e8e2d4", "#b98450", "#d9d1bf"], rough: 0.85, metal: 0 },
    { geometry: cap, count: 14, size: [0.014, 0.003, 0.014], y: 0.003, colours: ["#a8a8a4", "#8c2a22", "#2d4f7a", "#c9a438", "#6d6d68"], rough: 0.4, metal: 0.8 },
    { geometry: paper, count: 7, size: [0.035, 0.035, 0.035], y: 0.022, colours: ["#ece8de", "#c9b48d", "#dcd7cb"], rough: 0.95, metal: 0 },
    { geometry: wrapper, count: 7, size: [0.09, 0.09, 0.09], y: 0.006, colours: ["#b9bcbf", "#a33a2c", "#d8b43c", "#3e6b45"], rough: 0.35, metal: 0.5 }
  ];
  const meshes: THREE.InstancedMesh[] = [];
  const materials: THREE.Material[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  kinds.forEach((kind, k) => {
    const count = Math.max(2, Math.round(kind.count * scale));
    const material = new THREE.MeshStandardNodeMaterial({ roughness: kind.rough, metalness: kind.metal, side: kind.geometry === wrapper ? THREE.DoubleSide : THREE.FrontSide });
    const mesh = new THREE.InstancedMesh(kind.geometry, material, count);
    let placed = 0;
    for (let i = 0; placed < count && i < count * 6; i++) {
      const r = (n: number) => {
        const v = Math.sin((i + k * 1000) * 63.7 + n * 19.3) * 43758.5453;
        return v - Math.floor(v);
      };
      const at = inCorner(r, feet, 0.18);
      if (!at || covers(at[0], at[1])) continue;
      q.setFromEuler(new THREE.Euler(0, r(5) * 6.28, 0));
      m.compose(new THREE.Vector3(at[0], kind.y, at[1]), q, new THREE.Vector3(...kind.size).multiplyScalar(0.8 + r(6) * 0.4));
      mesh.setMatrixAt(placed, m);
      mesh.setColorAt(placed, c.set(kind.colours[Math.floor(r(7) * kind.colours.length)]));
      placed++;
    }
    mesh.count = placed;
    mesh.receiveShadow = true;
    meshes.push(mesh);
    materials.push(material);
  });
  const group = new THREE.Group();
  meshes.forEach((mesh) => group.add(mesh));
  return { group, geometries: [paper, wrapper, butt, cap], materials };
}

// Dust and pollen hanging in the sunlight, drifting.
function motes(count: number) {
  const geometry = new THREE.SphereGeometry(1, 6, 4);
  const material = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color("#fff1d8").multiplyScalar(1.6) });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const seeds = Array.from({ length: count }, (_, i) => {
    const r = (n: number) => {
      const s = Math.sin(i * 47.3 + n * 7.7) * 43758.5453;
      return s - Math.floor(s);
    };
    return { x: (r(1) - 0.5) * 7, y: 0.3 + r(2) * 4, z: (r(3) - 0.5) * 12 - 1, size: 0.003 + Math.pow(r(4), 3) * 0.007, phase: r(5) * 100 };
  });
  return { mesh, seeds, geometries: [geometry], materials: [material] };
}

// The sweep through the artist's spot: in from wherever the view is, past the spot sideways (so the depth shows at once
// as the view moves on), and out the other side. Two curves that meet at the spot heading the same way, so the path
// bends smoothly everywhere. It is travelled by distance at a speed that eases in, slows right down through the spot
// (never stopping) and brakes evenly to rest, the speed itself followed with damping so it never changes at once. The
// view turns from the point it was looking at to the drawing's middle, arriving exactly as it passes the spot.
type Sweep = { path: THREE.CurvePath<THREE.Vector3>; length: number; spot: number; travelled: number; speed: number; top: number; age: number; passed: boolean; toReal: boolean; lookFrom: THREE.Vector3; look: THREE.Vector3; passedAt: number };

function sweepFrom(from: THREE.Vector3, lookFrom: THREE.Vector3, toReal: boolean): Sweep {
  const side = new THREE.Vector3(from.x >= EYE.x ? 1 : -1, 0, 0);
  const through = side.clone().negate().add(new THREE.Vector3(0, -0.12, -0.25)).normalize();
  const end = EYE.clone().addScaledVector(through, 1.9);
  const inward = new THREE.CubicBezierCurve3(from.clone(), from.clone().lerp(EYE, 0.35).add(new THREE.Vector3(0, 0.2, 0)), EYE.clone().addScaledVector(through, -1.6), EYE.clone());
  const outward = new THREE.CubicBezierCurve3(EYE.clone(), EYE.clone().addScaledVector(through, 0.9), end.clone().addScaledVector(through, -0.4), end);
  inward.arcLengthDivisions = outward.arcLengthDivisions = 400;
  const path = new THREE.CurvePath<THREE.Vector3>();
  path.add(inward);
  path.add(outward);
  const spot = inward.getLength();
  const length = spot + outward.getLength();
  return { path, length, spot, travelled: 0, speed: 0, top: THREE.MathUtils.clamp(length / 3.4, 1.1, 2.4), age: 0, passed: false, toReal, lookFrom: lookFrom.clone(), look: new THREE.Vector3(), passedAt: 0 };
}

// The speed wanted at a point along the sweep (metres a second): up to `top`, down to about a quarter through the spot,
// and at the end braking evenly (as a thing slowing under constant friction) to rest exactly on the end.
function pace(run: Sweep) {
  // Easing down to about half speed through the spot and on again, never stopping: the view glides slowly through the
  // moment it turns real.
  const near = Math.exp(-Math.pow((run.travelled - run.spot) / 1.1, 2));
  return Math.min(run.top * (1 - 0.5 * near), Math.sqrt(2 * 0.45 * Math.max(0, run.length - run.travelled)));
}

// The drawing's outline on the sidewalk, lit to show it can be tapped: drawn round from a point when it shows, then a
// glint running round it. A thin ribbon just above the stone, along the drawing's edge.
function outlineOf(edge: THREE.Vector3[]) {
  const n = edge.length;
  const lengths = [0];
  for (let i = 1; i <= n; i++) lengths.push(lengths[i - 1] + edge[i % n].distanceTo(edge[i - 1]));
  const total = lengths[n];
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const half = 0.018;
  for (let i = 0; i <= n; i++) {
    const prev = edge[(i - 1 + n) % n];
    const next = edge[(i + 1) % n];
    const at = edge[i % n];
    const side = new THREE.Vector2(next.z - prev.z, -(next.x - prev.x)).normalize();
    positions.push(at.x - side.x * half, 0.006, at.z - side.y * half, at.x + side.x * half, 0.006, at.z + side.y * half);
    uvs.push(lengths[i] / total, 0, lengths[i] / total, 1);
    if (i < n) indices.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  const show = uniform(0);
  const trace = uniform(0);
  const time = uniform(0);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const along = uv().x;
  const across = float(1).sub(uv().y.sub(0.5).abs().mul(2));
  const glint = cos(along.sub(time.mul(0.18)).mul(Math.PI * 4)).mul(0.5).add(0.5).pow(8);
  const drawn = smoothstep(trace.add(0.02), trace, along);
  material.colorNode = vec3(1, 0.96, 0.88).mul(float(1.1).add(glint.mul(0.9)));
  material.opacityNode = show.mul(drawn).mul(across.pow(1.5)).mul(float(0.4).add(glint.mul(0.5)));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return { mesh, show, trace, time, geometries: [geometry], materials: [material] };
}

// Going back to chalk, the painting is set back to how it was drawn (its clock at 0) not by running its clock back
// through all that has happened, but by moving each thing straight from where it is to where it began: where everything
// is now and where it was at the start are both taken here (the painting is wherever its clock puts it, so the start is
// one call away), and `at(p)` puts each moved thing that fraction of the way, instanced ones too (on straight paths).
function settleBack(real: THREE.Object3D, animate: (life: number) => void, from: number) {
  type Pose = [THREE.Vector3, THREE.Quaternion, THREE.Vector3];
  const poses = () => {
    const each = new Map<THREE.Object3D, Pose>();
    const many = new Map<THREE.InstancedMesh, Float32Array>();
    real.traverse((o) => {
      if (o === real) return;
      each.set(o, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]);
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh) many.set(m, (m.instanceMatrix.array as Float32Array).slice(0, m.count * 16));
    });
    return { each, many };
  };
  const now = poses();
  animate(0);
  const start = poses();
  animate(from);
  const same = (a: Pose, b: Pose) => a[0].equals(b[0]) && a[1].equals(b[1]) && a[2].equals(b[2]);
  const moved = [...now.each].filter(([o, a]) => !same(a, start.each.get(o)!)).map(([o, a]) => ({ o, a, b: start.each.get(o)! }));
  // Instances apart, each taken apart into where, which way and how big, so a fish turning round turns rather than
  // squashing flat halfway.
  const m4 = new THREE.Matrix4();
  const column = new THREE.Vector3();
  // (One shrunk to nothing, as a painting's specks are once it is chalk, is nothing: three takes it apart as full size,
  // and the lava's embers swelled to a metre across on the way back.)
  const apart = (m: THREE.Matrix4, pose: Pose) => {
    m.decompose(...pose);
    if (column.setFromMatrixColumn(m, 0).lengthSq() === 0) pose[2].setScalar(0);
  };
  const flocks = [...now.many].map(([mesh, a]) => {
    const b = start.many.get(mesh)!;
    const list: { i: number; a: Pose; b: Pose }[] = [];
    for (let i = 0; i < mesh.count; i++) {
      let differs = false;
      for (let k = 0; k < 16 && !differs; k++) differs = a[i * 16 + k] !== b[i * 16 + k];
      if (!differs) continue;
      const pa: Pose = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
      const pb: Pose = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
      apart(m4.fromArray(a, i * 16), pa);
      apart(m4.fromArray(b, i * 16), pb);
      list.push({ i, a: pa, b: pb });
    }
    return { mesh, list };
  }).filter((f) => f.list.length);
  const p3 = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const k3 = new THREE.Vector3();
  return {
    from,
    at(p: number) {
      moved.forEach(({ o, a, b }) => {
        // In a low arc, a third as high as it goes across, so a thing coming back over an edge (the pool's ball over
        // its coping) clears it.
        o.position.lerpVectors(a[0], b[0], p);
        o.position.y += 0.35 * Math.hypot(b[0].x - a[0].x, b[0].z - a[0].z) * 4 * p * (1 - p);
        o.quaternion.slerpQuaternions(a[1], b[1], p);
        o.scale.lerpVectors(a[2], b[2], p);
      });
      flocks.forEach(({ mesh, list }) => {
        list.forEach(({ i, a, b }) => mesh.setMatrixAt(i, m4.compose(p3.lerpVectors(a[0], b[0], p), q.slerpQuaternions(a[1], b[1], p), k3.lerpVectors(a[2], b[2], p))));
        mesh.instanceMatrix.needsUpdate = true;
      });
    }
  };
}

function inside(x: number, z: number, edge: THREE.Vector3[]) {
  let hit = false;
  for (let i = 0, j = edge.length - 1; i < edge.length; j = i++) {
    const a = edge[i];
    const b = edge[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

// How long the chalk takes to draw on, and the eraser to take it off: unhurried, an arm's swings (see strokeAt).
const PAINT = 8.4;
const WIPE = 6.6;

function makeScene(kind: DrawingKind) {
  return function Scene() {
    // The painting asked for in the panel, and the one on the sidewalk now: they differ while one is wiped off for the
    // next.
    const wanted = useSettingRef<string>("painting");
    const settings = useSettingsStore();
    const [shown, setShown] = useState<DrawingKind>(() => ((wanted.current as string) in KINDS ? (wanted.current as DrawingKind) : kind));
    const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
    const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
    const scene = useThree((state) => state.scene);
    const { tier } = useQuality();
    const startTier = useRef(tier).current;
    const assets = useAssets();

    // The artist's picture: sized to the view's own pixels each frame (with a margin round them), so that from the
    // spot each pixel of the drawing is exactly one pixel of the picture.
    const picture = useMemo(() => new THREE.RenderTarget(4, 4, { type: THREE.HalfFloatType }), []);
    const shot = useMemo(() => new THREE.PerspectiveCamera(), []);
    // Every painting, built once, behind the loader, and kept for the session: a switch shows the one kept rather than
    // building it again (which held a frame up for a fifth of a second as the next was about to be drawn on, its
    // shapes made and its shaders built). Behind the loader the ones not showing are drawn once under the sidewalk too
    // (see `spares`), so their shaders are built then as well.
    const built = useMemo(() => {
      const scans = { rock: assets.rock, rockNormal: assets.rockNormal, slab: assets.colour, tiles: assets.tiles, tilesNormal: assets.tilesNormal, granite: assets.granite, graniteNormal: assets.graniteNormal };
      return new Map((Object.keys(KINDS) as DrawingKind[]).map((kind) => [kind, KINDS[kind].build(scans, assets.extra[kind] ?? {})]));
    }, [assets]);
    const drawing = built.get(shown)!;
    const spares = useMemo(() => new THREE.Group(), []);
    // (Not on a phone, where building all six held the loader up for a long while: there each is built in the
    // background the first time it is picked, and the picture is taken at the view's own resolution.)
    const warmAll = useMemo(() => typeof window === "undefined" || !window.matchMedia("(pointer: coarse)").matches, []);
    // For each painting, worked out once with it (each took a frame's worth of time on a switch): the hole it cuts, as a
    // mask the sidewalk cuts by once real (ground.ts); the box its strokes are drawn across (x0, x1, z0 far, z1 near),
    // its outline on the sidewalk, so the chalk and the eraser go over the drawing and no further (chalk of things
    // standing up out of it, laid flat past the outline along the artist's sight lines, comes and goes with the first
    // and last strokes); the arm the strokes are swung from; and how far each row of them goes.
    const prepared = useMemo(
      () =>
        new Map(
          [...built.values()].map((d) => {
            const box = new THREE.Vector4(Infinity, -Infinity, Infinity, -Infinity);
            d.edge.forEach((p) => box.set(Math.min(box.x, p.x), Math.max(box.y, p.x), Math.min(box.z, p.z), Math.max(box.w, p.z)));
            box.set(box.x - 0.05, box.y + 0.05, box.z - 0.05, box.w + 0.05);
            const arm = armFor(box);
            const rows = (n: number) => strokeSpans(d.edge, box, arm, n, Array.from({ length: n }, () => new THREE.Vector4()));
            return [d, { hole: holeMask(d.edge), spread: box, arm, paint: rows(STROKES.paint), wipe: rows(STROKES.wipe) }];
          })
        ),
      [built]
    );
    const { spread } = prepared.get(drawing)!;
    // The hole of the painting on the sidewalk now, as a mask the sidewalk cuts by once real (ground.ts).
    const { hole } = prepared.get(drawing)!;
    const ground = useMemo(() => buildGround({ colour: assets.colour, normal: assets.normal, rough: assets.rough, dirty: assets.dirty, dirtyNormal: assets.dirtyNormal, cracked: assets.cracked, crackedNormal: assets.crackedNormal, granular: assets.granular }, picture.texture, hole), [assets, picture]);
    // The arm the strokes are swung from, and how far each row of them goes: over the drawing's outline, no further.
    const arm = useMemo(() => {
      const ready = prepared.get(drawing)!;
      ready.paint.forEach((v, i) => (ground.spans.paint.array[i] as THREE.Vector4).copy(v));
      ready.wipe.forEach((v, i) => (ground.spans.wipe.array[i] as THREE.Vector4).copy(v));
      return ready.arm;
    }, [prepared, drawing, ground]);
    useEffect(() => {
      ground.hole.value = hole;
    }, [ground, hole]);
    useDispose(...[...prepared.values()].map((ready) => ready.hole));
    const street = useMemo(
      () => buildStreet({ bark: assets.bark, barkNormal: assets.barkNormal, brick: assets.brick, brickNormal: assets.brickNormal, asphalt: assets.asphalt, asphaltNormal: assets.asphaltNormal, granite: assets.granite, dirty: assets.dirty, dirtyNormal: assets.dirtyNormal }, startTier),
      [assets, startTier]
    );
    // Lamps along the curb, one beside the drawing; a hydrant behind the artist. The lamps are still lit from the night:
    // a warm glow in the lantern (the clones share its glass, so it is set once) and, under the two nearest, a steady
    // soft pool of orange light on the sidewalk. Steady, or the chalk would flicker with it.
    const props = useMemo(() => {
      const group = new THREE.Group();
      assets.lamp.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!m || !("emissive" in m)) return;
        const glow = m.name.endsWith("_glass") ? 1.6 : m.name.endsWith("_bulb") ? 6 : 0;
        if (!glow) return;
        m.emissive.set("#ff9a48");
        m.emissiveIntensity = glow;
      });
      LAMP_Z.forEach((z) => {
        const lamp = assets.lamp.clone(true);
        lamp.position.set(CURB + 0.5, 0, z);
        group.add(lamp);
        if (z !== 2.4 && z !== -21) return;
        const pool = new THREE.PointLight("#ff9a4a", 6, 9, 2);
        pool.position.set(CURB + 0.5, 3.0, z);
        group.add(pool);
      });
      const hydrant = assets.hydrant.clone(true);
      hydrant.position.set(CURB + 0.55, 0, 13.5);
      hydrant.rotation.y = Math.PI / 2;
      group.add(hydrant);
      // Meshes only: a lamp's light casting would draw the whole street six times over, every frame.
      group.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
      });
      return group;
    }, [assets]);
    // Where the drawing lies in the artist's view (as tangents from its middle, y up), with a little room round it.
    const reach = useMemo(() => {
      const unit = new THREE.PerspectiveCamera(90, 1, 0.05, 100);
      unit.position.copy(EYE);
      unit.lookAt(CENTRE);
      unit.updateMatrixWorld();
      const out = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
      drawing.extent.forEach((p) => {
        const q = p.clone().project(unit);
        out.x0 = Math.min(out.x0, q.x);
        out.x1 = Math.max(out.x1, q.x);
        out.y0 = Math.min(out.y0, q.y);
        out.y1 = Math.max(out.y1, q.y);
      });
      const [padX, padY] = [(out.x1 - out.x0) * 0.04 + 0.01, (out.y1 - out.y0) * 0.04 + 0.02];
      return { x0: out.x0 - padX, x1: out.x1 + padX, y0: out.y0 - padY, y1: out.y1 + padY };
    }, [drawing]);
    const sticks = useMemo(() => chalkSticks(), []);
    useMemo(() => placeSticks(sticks.group), [sticks]);
    // The fallen leaves and the litter, scattered once, clear of every painting together: they lie where they are
    // whichever painting is on the sidewalk, and never move when it changes. Kept out of one box round all the chalk any
    // painting lays (its hole, and the chalk of whatever stands up out of it laid flat along the artist's sight lines),
    // with room to spare, so none ever lies on a drawing.
    const coversAny = useMemo(() => {
      const box = new THREE.Vector4(Infinity, -Infinity, Infinity, -Infinity);
      const take = (x: number, z: number) => box.set(Math.min(box.x, x), Math.max(box.y, x), Math.min(box.z, z), Math.max(box.w, z));
      built.forEach((d) => {
        d.edge.forEach((p) => take(p.x, p.z));
        d.extent.forEach((p) => {
          if (p.y >= EYE.y - 0.05) return;
          const q = p.y > 0.001 ? EYE.clone().addScaledVector(p.clone().sub(EYE), EYE.y / (EYE.y - p.y)) : p;
          take(q.x, q.z);
        });
      });
      const room = 0.35;
      return (x: number, z: number) => x > box.x - room && x < box.y + room && z > box.z - room && z < box.w + room;
    }, [built]);
    const leaves = useMemo(() => fallenLeaves(coversAny, startTier === "low" ? 4000 : 11000, startTier === "low" ? 2000 : 6000), [coversAny, startTier]);
    const trash = useMemo(() => litter(coversAny, startTier === "low" ? 0.5 : 1), [coversAny, startTier]);
    const dust = useMemo(() => motes(startTier === "low" ? 120 : 260), [startTier]);
    const light = useMemo(() => {
      const sun = new THREE.DirectionalLight("#ffe2b8", 3.0);
      sun.position.copy(CENTRE).addScaledVector(SUN, 60);
      sun.target.position.copy(CENTRE).add(new THREE.Vector3(0, 0, -6));
      sun.castShadow = true;
      // Updated only when something casting can have moved (see the frame loop): chalk and street are still.
      sun.shadow.autoUpdate = false;
      sun.shadow.needsUpdate = true;
      sun.shadow.mapSize.set(startTier === "low" ? 2048 : 4096, startTier === "low" ? 2048 : 4096);
      const box = sun.shadow.camera as THREE.OrthographicCamera;
      box.left = box.bottom = -22;
      box.right = box.top = 22;
      box.near = 1;
      box.far = 140;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.02;
      // Soft-edged, as the dapple under a high canopy is.
      sun.shadow.radius = 3;
      const sky = new THREE.HemisphereLight("#d6dde2", "#857a6c", 1.5);
      return { sun, sky };
    }, [startTier]);
    // A painting's own lights (a flame, a glow, the crystals) light the painting only, from the moment it is built and
    // before anything is drawn: put on a layer no camera sees (out of the scene's lighting) and handed to the painting's
    // own materials along with the street's lights. The street is lit the same whatever is drawn on it, chalk or real,
    // and its shaders are built once, never again for another painting's lights (which held frames up for seconds and
    // flashed the light on every switch, and on load).
    useMemo(() => {
      const shared: THREE.Light[] = [light.sun, light.sky];
      props.traverse((o) => (o as THREE.Light).isLight && shared.push(o as THREE.Light));
      built.forEach(({ real }) => {
        const own: THREE.Light[] = [];
        real.traverse((o) => {
          if (!(o as THREE.Light).isLight) return;
          o.layers.set(31);
          own.push(o as THREE.Light);
        });
        if (!own.length) return;
        const node = lights([...shared, ...own]);
        real.traverse((o) => {
          const m = (o as THREE.Mesh).material;
          (Array.isArray(m) ? m : m ? [m] : []).forEach((material) => {
            if ((material as THREE.NodeMaterial).isNodeMaterial) (material as THREE.NodeMaterial).lightsNode = node;
          });
        });
      });
    }, [built, light, props]);
    // Drawn in place of every shadow caster while the picture is taken: the caster still shades the drawing (the leaves'
    // dapple falls in the hole just as it will on the real thing) but shows nothing itself.
    const shadowOnly = useMemo(() => new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false }), []);
    // Left in the frame whatever its bounds say (instanced and moving parts' bounds don't follow them), except while it
    // waits far below, where it is left out (see AWAY_BELOW).
    const culled = (on: boolean) => drawing.real.traverse((object) => (object.frustumCulled = on));
    useMemo(() => culled(false), [drawing]);
    // The painting's shadow casters, and where each was when the sun's shadows were last drawn: once real they are drawn
    // again only when one of these has moved (most paintings cast none, and the pool's ball comes to rest).
    const casters = useMemo(() => {
      const list: { mesh: THREE.Mesh; at: number[] }[] = [];
      drawing.real.traverse((o) => (o as THREE.Mesh).isMesh && o.castShadow && list.push({ mesh: o as THREE.Mesh, at: [] }));
      return list;
    }, [drawing]);
    // The painting's own, apart: freeing them with the street's when the painting changes freed the street too, and
    // while its shaders were built again it went undrawn (a frame of bare page).
    const outline = useMemo(() => outlineOf(drawing.edge), [drawing]);
    // Where the pointer is, whether it is over the drawing, and whether each way through it has been tried yet (the tip
    // shows until it has).
    const hover = useRef({ over: false, x: 0, y: 0, tried: { real: false, chalk: false }, trace: 1 });
    useDispose(...[...built.values()].flatMap((d) => [...d.geometries, ...d.materials]));
    useDispose(...outline.geometries, ...outline.materials, ...leaves.geometries, ...leaves.materials, ...trash.geometries, ...trash.materials);
    useDispose(picture, shadowOnly, ...ground.geometries, ...ground.materials, ...street.geometries, ...street.materials, ...sticks.geometries, ...sticks.materials, ...dust.geometries, ...dust.materials);

    useBed("breeze", 0.08);
    useMusic("/codevember/music/brooklyn-pressure.mp3", 0.18);
    // The street itself under the music: traffic, voices, birds.
    // The chalk scratching on and the eraser rubbing it off, loud enough to hear over the street.
    const scratching = useWhileLoop("/assets/26-anamorph/chalk.mp3", 4);
    const rubbing = useWhileLoop("/assets/26-anamorph/eraser.mp3", 2.5);
    useLoop("/assets/26-anamorph/city-street.mp3", 0.3);
    useLoop("/assets/26-anamorph/city-busy.mp3", 0.22);
    useEvery(3, 9, () => sound.play("chirp", { gain: 0.22, pitch: 0.85 + Math.random() * 0.4 }));
    useEffect(() => {
      airTint.value.set("#e8d6b8");
    }, []);

    const state = useRef({ uploads: [] as { texture: THREE.Texture; ready: boolean }[], toolFrames: 0, building: null as { pending: number; lastNewAt: number; startedAt: number; release: () => void } | null, shown: false, tick: 0, compiling: false, animated: NaN, warm: 0, waiting: false, shadowsAt: "", pictureKey: "", pictureFrames: 0, builds: 0, phase: "painting" as "painting" | "drawn" | "erasing", paint: 0, wipe: 0, builtFor: null as unknown, time: 0, life: 0, still: false, real: false, sparesDone: false, spareFrames: 0, quick: "", sweep: null as Sweep | null, back: null as ReturnType<typeof settleBack> | null, clear: new THREE.Color(), size: new THREE.Vector2(), hidden: [] as THREE.Object3D[], swapped: [] as [THREE.Mesh, THREE.Material | THREE.Material[]][], madeReal: false });
    const scratch = useMemo(() => ({ m: new THREE.Matrix4(), ray: new THREE.Raycaster(), ndc: new THREE.Vector2(), hit: new THREE.Vector3(), floor: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0) }), []);
    // The chalk stick that draws each painting on, and the felt eraser that takes it off: seen only while at work.
    // Neither casts a shadow, so neither is in the artist's picture.
    const tools = useMemo(() => {
      // Big enough to see at work from where the view stands: its tip at its origin, on the sidewalk.
      const stickGeometry = new THREE.CylinderGeometry(0.026, 0.03, 0.26, 12).translate(0, 0.13, 0);
      const stickMaterial = new THREE.MeshStandardNodeMaterial({ color: "#f3f0e8", roughness: 0.95 });
      const stick = new THREE.Mesh(stickGeometry, stickMaterial);
      const feltGeometry = new THREE.BoxGeometry(0.36, 0.05, 0.13);
      const feltMaterial = new THREE.MeshStandardNodeMaterial({ color: "#3a3a3d", roughness: 1 });
      const backGeometry = new THREE.BoxGeometry(0.36, 0.06, 0.13);
      const backMaterial = new THREE.MeshStandardNodeMaterial({ color: "#a8784d", roughness: 0.7 });
      const eraser = new THREE.Group();
      const felt = new THREE.Mesh(feltGeometry, feltMaterial);
      const back = new THREE.Mesh(backGeometry, backMaterial);
      felt.position.y = 0.025;
      back.position.y = 0.08;
      eraser.add(felt, back);
      stick.visible = eraser.visible = false;
      return { stick, eraser, geometries: [stickGeometry, feltGeometry, backGeometry], materials: [stickMaterial, feltMaterial, backMaterial] };
    }, []);
    useDispose(...tools.geometries, ...tools.materials);

    // The orbit's own leftover motion (its damping carries on a drag after the press ends): cleared when the sweep
    // takes the view and again when it gives it back.
    const settle = () => {
      const orbit = orbitControls.current as any;
      orbit?._sphericalDelta?.set(0, 0, 0);
      orbit?._panOffset?.set(0, 0, 0);
      if (orbit && "_scale" in orbit) orbit._scale = 1;
    };

    const sweep = (toReal: boolean) => {
      const s = state.current;
      if (s.sweep) return;
      // From exactly where the view is and what it is looking at (the float moves both), so nothing jumps.
      const looking = orbitPoint.current?.clone() ?? camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(camera.position.distanceTo(CENTRE)).add(camera.position);
      s.sweep = sweepFrom(camera.position, looking, toReal);
      s.back = toReal ? null : settleBack(drawing.real, drawing.animate, s.life);
      settle();
      cameraTaken.current = true;
      sound.play("whoosh", { gain: 0.3, size: 1.5 });
      dismissPrompt();
    };

    // Tap the drawing (or the real thing) to sweep through the spot and swap.
    useEffect(() => {
      const dom = gl.domElement;
      let down: { x: number; y: number; at: number } | null = null;
      const press = (event: PointerEvent) => (down = { x: event.clientX, y: event.clientY, at: performance.now() });
      // Half a second past the spot the view is yours again: a press or a scroll ends the sweep's glide where it is, and
      // the orbit carries on from there. (Heard before the orbit's own listeners, so the same press starts the drag.)
      const takeBack = () => {
        const run = state.current.sweep;
        if (!run?.passed || run.age - run.passedAt < 0.5) return;
        state.current.sweep = null;
        settle();
        cameraTaken.current = false;
        const orbit = orbitControls.current as { enabled: boolean } | null;
        if (orbit) orbit.enabled = true;
      };
      const release = (event: PointerEvent) => {
        if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > TAP.move || performance.now() - down.at > TAP.time) return;
        down = null;
        const rect = dom.getBoundingClientRect();
        scratch.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        scratch.ray.setFromCamera(scratch.ndc, camera);
        if (!scratch.ray.ray.intersectPlane(scratch.floor, scratch.hit)) return;
        // Only once the drawing is all there, and not while the next one is on its way.
        const s = state.current;
        if (!s.real && s.phase !== "drawn") return;
        if ((wanted.current as string) !== shown) return;
        if (inside(scratch.hit.x, scratch.hit.z, drawing.edge)) {
          hover.current.tried[s.real ? "chalk" : "real"] = true;
          sweep(!s.real);
        }
      };
      const move = (event: PointerEvent) => {
        const h = hover.current;
        h.x = event.clientX;
        h.y = event.clientY;
        if (event.pointerType !== "mouse") return void (h.over = false);
        const rect = dom.getBoundingClientRect();
        scratch.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        scratch.ray.setFromCamera(scratch.ndc, camera);
        h.over = !!scratch.ray.ray.intersectPlane(scratch.floor, scratch.hit) && inside(scratch.hit.x, scratch.hit.z, drawing.edge);
      };
      const leave = () => void (hover.current.over = false);
      dom.addEventListener("pointermove", move);
      dom.addEventListener("pointerleave", leave);
      dom.addEventListener("pointerdown", takeBack, { capture: true });
      dom.addEventListener("wheel", takeBack, { capture: true });
      dom.addEventListener("pointerdown", press);
      dom.addEventListener("pointerup", release);
      return () => {
        dom.removeEventListener("pointerdown", takeBack, { capture: true });
        dom.removeEventListener("wheel", takeBack, { capture: true });
        dom.removeEventListener("pointerdown", press);
        dom.removeEventListener("pointerup", release);
        dom.removeEventListener("pointermove", move);
        dom.removeEventListener("pointerleave", leave);
        dom.style.cursor = "";
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gl, camera, drawing, scratch]);

    // The tip by the pointer, over the drawing: what a click does.
    const tip = useMemo(() => {
      if (typeof document === "undefined") return null;
      const el = document.createElement("div");
      Object.assign(el.style, { position: "fixed", left: "0", top: "0", zIndex: "20", pointerEvents: "none", padding: "7px 12px", borderRadius: "999px", background: "rgba(24, 21, 18, 0.72)", backdropFilter: "blur(8px)", color: "#f4efe6", font: "500 13px/1.2 inherit", fontFamily: "inherit", letterSpacing: "0.01em", whiteSpace: "nowrap", opacity: "0", transition: "opacity 0.25s ease", willChange: "transform" });
      return el;
    }, []);
    useEffect(() => {
      if (!tip) return;
      document.body.appendChild(tip);
      return () => tip.remove();
    }, [tip]);

    useSettingAction("redraw", () => state.current.real && sweep(false));
    useEffect(() => () => void (cameraTaken.current = false), []);
    useEffect(() => {
      if (process.env.NODE_ENV === "production") return;
      const hook = { kinds: KINDS, assets, tools, gl, scene, drawing, ground, picture, camera, shot, street, state: state.current, eye: EYE, sweep, settings, light, hold: (on: boolean) => (cameraTaken.current = on) };
      Object.assign(window, { __anamorph: hook });
      if (location.search.includes("audit") && !(window as { __audited?: boolean }).__audited) {
        (window as { __audited?: boolean }).__audited = true;
        void import("./audit").then(({ audit }) => audit(() => (window as unknown as { __anamorph: never }).__anamorph));
      }
    });

    // For the picture: everything but the drawing put out of it. Shadow casters stay, drawn as shadow only.
    const strip = (object: THREE.Object3D) => {
      const s = state.current;
      // (And behind the loader, the paintings not showing, so their shaders for the picture are built too.)
      if (object === drawing.real || object === drawing.shade || (object === spares && scenePhase.current !== "live")) return;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh || (object as THREE.Points).isPoints || (object as THREE.Sprite).isSprite || (object as THREE.Line).isLine) {
        if (!object.visible) return;
        if (mesh.isMesh && mesh.castShadow) {
          s.swapped.push([mesh, mesh.material]);
          mesh.material = shadowOnly;
        } else {
          object.visible = false;
          s.hidden.push(object);
        }
      }
      object.children.forEach(strip);
    };

    // A new painting's shaders, built the ordinary way on its first frames, held everything up for seconds. Instead,
    // while it settles in (under the sidewalk, for the view, the sun's shadow and the artist's picture), each shader is
    // asked of the GPU to build in the background, as the engine does behind its loader, and whatever is not ready yet
    // is left undrawn. Once nothing is left building the painting is drawn on.
    const buildInBackground = () => {
      type Pipelines = { getForRender: (renderObject: unknown, promises?: unknown) => unknown; updateForRender?: (renderObject: unknown) => void };
      const pipelines = (gl as unknown as { _pipelines?: Pipelines })._pipelines;
      const count = { pending: 0, lastNewAt: performance.now(), startedAt: performance.now(), release: () => {} };
      if (!pipelines?.getForRender) return count;
      const own = Object.prototype.hasOwnProperty.call(pipelines, "updateForRender");
      const before = pipelines.updateForRender;
      const tracker = {
        push(promise: Promise<void>) {
          count.pending += 1;
          count.lastNewAt = performance.now();
          const settle = () => void (count.pending -= 1);
          promise.then(settle, settle);
        }
      };
      const mine = (renderObject: unknown) => void pipelines.getForRender(renderObject, tracker);
      pipelines.updateForRender = mine;
      let released = false;
      count.release = () => {
        if (released || pipelines.updateForRender !== mine) return;
        released = true;
        if (own) pipelines.updateForRender = before;
        else delete pipelines.updateForRender;
      };
      return count;
    };
    useEffect(() => () => state.current.building?.release(), []);

    useFrame((_, raw) => {
      const dt = Math.min(raw, 0.05);
      const s = state.current;
      // (`still`, in development only, holds the scene's motion for comparing frames.)
      if (!s.still) s.time += dt;

      // A painting newly on the sidewalk starts clean and is drawn on. Asked for another, the one there is wiped off
      // (if it is real, the view first sweeps back through the spot to turn it to chalk), and the new one built and
      // drawn on in its place. All the while the view is free.
      if (s.builtFor !== drawing) {
        s.builtFor = drawing;
        s.builds++;
        s.warm = 0;
        s.building?.release();
        // Behind the loader the engine is already building everything in the background (and puts it back itself).
        s.building = scenePhase.current === "live" ? buildInBackground() : null;
        s.compiling = true;
        s.tick = 0;
        s.phase = "painting";
        s.paint = 0;
        s.wipe = 0;
        s.life = 0;
        s.animated = NaN;
        s.real = false;
        // Settling a new painting in can still hold a frame or two up: not a reason to lower the quality.
        holdQuality(8000);
      }
      // The phone's pills and the panel's picker kept to the same painting, whichever was used.
      const quick = settings.get("quick") as string;
      if (quick !== s.quick) {
        if (s.quick) settings.set("painting", quick);
        s.quick = quick;
      } else if ((wanted.current as string) !== quick && PICKER.slice(0, 4).includes(wanted.current as DrawingKind)) {
        settings.set("quick", wanted.current as string);
        s.quick = wanted.current as string;
      }
      const want = (wanted.current as string) in KINDS ? (wanted.current as DrawingKind) : shown;
      if (want !== shown && s.phase !== "erasing") {
        if (s.real && !s.sweep) sweep(false);
        else if (!s.real && !s.sweep) {
          s.phase = "erasing";
          // The next painting's textures, decoded off to the side now and sent to the GPU one a frame while the eraser
          // works, rather than all at once the moment it is first drawn.
          s.uploads = Object.values(assets.extra[want] ?? {}).map((texture) => {
            const job = { texture, ready: false };
            const image = texture.image as HTMLImageElement | undefined;
            const decoded = image?.decode ? image.decode() : Promise.resolve();
            decoded.then(() => (job.ready = true), () => (job.ready = true));
            return job;
          });
        }
      }
      const working = scenePhase.current === "live";
      // Behind the loader the paintings not showing hang under the sidewalk with this one, drawn every frame (into the
      // artist's picture too), so their shaders are built while the engine builds everything else; a moment after the
      // scene shows they are put away, kept for when they are asked for.
      if (!s.sparesDone) {
        if (!working && !spares.children.length && warmAll)
          built.forEach((d) => {
            if (d === drawing) return;
            d.real.position.y = PARKED;
            d.real.traverse((o) => (o.frustumCulled = false));
            spares.add(d.real);
          });
        if (working && ++s.spareFrames > 90) {
          spares.clear();
          s.sparesDone = true;
        }
      }
      // Behind the loader the engine builds shaders in the background, and three skips whatever is not ready yet: a
      // picture taken then can be missing parts (the pool's water). Taken again once the scene is on show.
      if (working && !s.shown) {
        s.shown = true;
        s.pictureKey = "";
      }
      // The new painting settling in, its shaders building in the background (see buildInBackground): done once none
      // is left building and none new has been asked for a moment (or, whatever is left, after twelve seconds).
      if (s.compiling) {
        s.tick++;
        const b = s.building;
        const now = performance.now();
        if (!b || (s.tick > 4 && b.pending === 0 && now - b.lastNewAt > 250) || now - b.startedAt > 12000) {
          b?.release();
          s.building = null;
          s.compiling = false;
          s.warm = WARM_FRAMES;
          s.pictureKey = "";
        }
      }
      // Behind the loader the engine builds shaders in the background, and three skips whatever is not ready yet: a
      // picture taken then can be missing parts (the pool's water). Taken again once the scene is on show.
      if (working && !s.shown) {
        s.shown = true;
        s.pictureKey = "";
      }
      if (s.phase === "painting" && working && !s.compiling) {
        s.paint = Math.min(1, s.paint + dt / PAINT);
        if (s.paint >= 1) s.phase = "drawn";
      }
      if (s.phase === "erasing") {
        const next = s.uploads.findIndex((job) => job.ready);
        if (next >= 0) gl.initTexture(s.uploads.splice(next, 1)[0].texture);
        s.wipe = Math.min(1, s.wipe + dt / WIPE);
        if (s.wipe >= 1) {
          if (want !== shown) setShown(want);
          else {
            // Asked back for the one being wiped: draw it on again.
            s.phase = "painting";
            s.paint = 0;
            s.wipe = 0;
          }
        }
      }
      // The sun's shadows are drawn again only when something casting can have moved: while the painting is real, on the
      // frames one of its casters has; and for the frames after anything else changes (a new painting, while it settles
      // in). And all through a sweep, so their cost is already being paid when the swap comes, not added on that frame.
      let moved = false;
      if (s.real)
        casters.forEach((c) => {
          const { position: p, quaternion: q, scale: k } = c.mesh;
          const at = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, k.x, k.y, k.z, (c.mesh as THREE.InstancedMesh).instanceMatrix?.version ?? 0];
          if (at.some((v, i) => v !== c.at[i])) {
            moved = true;
            c.at = at;
          }
        });
      const shadowsAt = `${s.real}|${s.builds}|${s.warm > 0}`;
      if (moved || s.sweep || s.warm > 0 || s.compiling || s.pictureFrames > 0 || shadowsAt !== s.shadowsAt) light.sun.shadow.needsUpdate = true;
      s.shadowsAt = shadowsAt;
      ground.paint.value = s.paint;
      ground.wipe.value = s.wipe;
      ground.spread.value.copy(spread);
      // The chalk stick swings along the strokes, back and forth in arcs from the far end, leaning back toward the arm
      // that holds it; the eraser its broader swings, scrubbing as it goes. Both exactly where the sidewalk's shader
      // lays and lifts the chalk (strokeAt, ground.ts).
      ground.arm.value.copy(arm);
      tools.stick.visible = s.phase === "painting" && working && !s.compiling && s.paint > 0;
      tools.eraser.visible = s.phase === "erasing" && s.wipe < 1;
      if (tools.stick.visible) {
        const at = strokeAt(s.paint, STROKES.paint, spread, arm, ground.spans.paint.array as THREE.Vector4[], scratch.hit);
        tools.stick.position.set(at.x, 0.002 + Math.abs(Math.sin(s.time * 31)) * 0.004, at.z);
        tools.stick.rotation.set(0.6 + Math.sin(s.time * 13) * 0.08, -at.y, 0, "YXZ");
      }
      if (tools.eraser.visible) {
        const at = strokeAt(s.wipe, STROKES.wipe, spread, arm, ground.spans.wipe.array as THREE.Vector4[], scratch.hit);
        // Scrubbing in and out across its swing as it goes.
        const scrub = Math.sin(s.time * 9) * 0.07;
        tools.eraser.position.set(at.x + Math.sin(at.y) * scrub, 0.002, at.z - Math.cos(at.y) * scrub);
        tools.eraser.rotation.set(0, Math.PI / 2 - at.y + Math.sin(s.time * 11) * 0.1, 0);
      }
      // Both drawn under the sidewalk for their first frames, so their shaders are built before they are first needed
      // (built then, they held the frame up as the first wipe began).
      if (s.toolFrames < 12) {
        s.toolFrames++;
        if (!tools.stick.visible) tools.stick.position.set(0, -3, 0);
        if (!tools.eraser.visible) tools.eraser.position.set(0, -3, 0);
        tools.stick.visible = tools.eraser.visible = true;
      }
      // The scratch of chalk, and the rub of the eraser.
      scratching(s.toolFrames >= 12 && tools.stick.visible);
      rubbing(s.toolFrames >= 12 && tools.eraser.visible);
      // The drawing's own clock runs only while it is real: chalk holds still. On the frame it turns real it shows the
      // moment the chalk was holding (so it matches the drawing exactly), and moves on from there.
      if (s.real && !s.still && !(s.sweep && !s.sweep.toReal)) s.life += dt;

      // The sweep, and the swap on the frame it passes the spot.
      const run = s.sweep;
      if (run) {
        run.age += dt;
        // Damped toward the speed wanted here, from rest, gathering over the first second.
        const wanted = pace(run) * THREE.MathUtils.smoothstep(run.age, 0, 1.2);
        run.speed += (wanted - run.speed) * (1 - Math.exp(-dt * 3.5));
        // In the last few frames before the spot, the steps are evened out to land on it exactly.
        let step = run.speed * dt;
        const toSpot = run.spot - run.travelled;
        if (!run.passed && toSpot > 0 && toSpot < step * 4) step = toSpot / Math.max(1, Math.round(toSpot / step));
        let travelled = Math.min(run.length, run.travelled + step);
        if (run.length - travelled < 0.002 && run.speed < 0.05) travelled = run.length;
        if (!run.passed && travelled >= run.spot) {
          // This frame lands on the spot exactly, and the drawing is swapped for the real thing.
          travelled = run.spot;
          run.passed = true;
          run.passedAt = run.age;
          s.real = run.toReal;
          if (s.real && !s.madeReal) {
            s.madeReal = true;
            // A moment later, so the card's arrival (page layout, its blur) doesn't land on the swap itself.
            window.setTimeout(() => {
              followPrompt.earn("real");
              shareResult.set("I walked past a chalk drawing on a Brooklyn sidewalk and it turned real. Anamorph.");
            }, 1500);
          }
        }
        run.travelled = travelled;
        // Going back to chalk, the painting settles back to how it was drawn as the view comes in, everything moving
        // smoothly from where it is to where it began (see settleBack), and arrives exactly on the spot: whatever has
        // come up out of it (lava, birds, the pool's ball) goes back, and the chalk it turns into is the drawing as it
        // was first drawn. (Its clock, for what its shaders show, runs down alongside.)
        if (!run.toReal && !run.passed && s.back) s.life = s.back.from * (1 - THREE.MathUtils.smootherstep(travelled, 0, run.spot));
        if (!run.toReal && run.passed) {
          s.life = 0;
          s.back = null;
        }
        if (travelled === run.spot) camera.position.copy(EYE);
        else camera.position.copy(run.path.getPoint(travelled / run.length));
        const turned = THREE.MathUtils.smootherstep(travelled, 0, run.spot);
        run.look.lerpVectors(run.lookFrom, CENTRE, run.passed ? 1 : turned);
        camera.lookAt(run.look);
        camera.updateMatrixWorld();
        orbitPoint.current?.copy(run.look);
        if (travelled >= run.length) {
          s.sweep = null;
          settle();
          cameraTaken.current = false;
        }
      }
      // After the sweep, which may have rewound the clock this frame. Only when the clock has moved: chalk holds still.
      if (s.animated !== s.life) {
        s.animated = s.life;
        drawing.animate(s.life);
        if (s.back && s.sweep && !s.sweep.passed) s.back.at(1 - s.life / Math.max(s.back.from, 1e-6));
      }
      ground.real.value = s.real ? 1 : 0;

      // Near the spot nothing is blurred and the drawing is the picture exactly; away from it, it is chalk.
      const off = camera.position.distanceTo(EYE);
      ground.chalky.value = THREE.MathUtils.smoothstep(off, 0.05, 1.5);
      // At the spot, the lens is still on the drawing, but softens the street far off (see focus.ts); away from it,
      // more, and sooner.
      const away = THREE.MathUtils.smoothstep(off, 0.1, 2);
      focusBlur.value = THREE.MathUtils.lerp(SPOT_BLUR, AWAY_BLUR, away);
      focusDistance.value = camera.position.distanceTo(CENTRE);
      aimSpotFocus(camera, 1 - away);

      // The artist's picture: the real scene with only the drawing showing, from the spot, through the view's own lens
      // and on the view's own pixel grid, but only the whole pixels the drawing covers (which may run past the view's
      // edges), so the drawing is complete from wherever it is seen and nothing else is drawn.
      if (!s.real) {
        gl.getDrawingBufferSize(s.size);
        const [w, h] = [s.size.x, s.size.y];
        const focal = h / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        const cap = 8192;
        const x0 = Math.max(Math.floor(w / 2 + reach.x0 * focal) - 2, Math.round(w / 2 - cap / 2));
        const x1 = Math.min(Math.ceil(w / 2 + reach.x1 * focal) + 2, x0 + cap);
        const y0 = Math.max(Math.floor(h / 2 - reach.y1 * focal) - 2, Math.round(h / 2 - cap / 2));
        const y1 = Math.min(Math.ceil(h / 2 - reach.y0 * focal) + 2, y0 + cap);
        const [pw, ph] = [x1 - x0, y1 - y0];
        // Taken at twice the view's resolution where it fits, each view pixel then the average of four: the view smooths
        // its edges (and the stripes on a beach ball) over frames, and a picture taken once at its own resolution kept
        // their jaggies, so the swap showed as a crisping of every edge.
        const ss = warmAll && pw * ph * 4 <= 9e6 ? 2 : 1;
        if (picture.width !== pw * ss || picture.height !== ph * ss) picture.setSize(pw * ss, ph * ss);
        shot.fov = camera.fov;
        shot.aspect = w / h;
        shot.setViewOffset(w * ss, h * ss, x0 * ss, y0 * ss, pw * ss, ph * ss);
        shot.near = camera.near;
        shot.far = camera.far;
        shot.position.copy(EYE);
        shot.up.copy(camera.up);
        shot.lookAt(CENTRE);
        shot.updateMatrixWorld();
        shot.updateProjectionMatrix();
        ground.sweet.value.multiplyMatrices(shot.projectionMatrix, shot.matrixWorldInverse);
      }
      // Taken only when what it shows can have changed: a new painting, a new size of view, or the drawing's clock
      // moving (only ever while it rewinds). Chalk is still and so is the light on it, so most frames it is reused.
      // After each change it is taken for a second or so more, while new shaders finish building.
      const pictureKey = `${s.builds}|${picture.width}x${picture.height}|${camera.fov}|${s.life.toFixed(4)}`;
      if (!s.real && !s.compiling && pictureKey !== s.pictureKey) {
        s.pictureKey = pictureKey;
        s.pictureFrames = 60;
      }
      // (Taken on the first frames after a change, then now and then while late shaders and textures come in.)
      // (While a new painting settles in, every other frame, asking for its shaders here too.)
      const taking = (s.compiling && s.tick % 2 === 1) || (!s.compiling && s.pictureFrames > 0 && (s.pictureFrames > 57 || s.pictureFrames % 6 === 0 || s.pictureFrames === 1));
      if (s.pictureFrames > 0) s.pictureFrames--;
      if (!s.real && taking) {
        s.hidden.length = 0;
        s.swapped.length = 0;
        scene.children.forEach(strip);
        drawing.real.position.y = 0;
        drawing.real.updateMatrixWorld(true);
        if (s.waiting) culled(false);
        (drawing.shade.material as THREE.Material).depthWrite = true;
        const background = scene.background;
        scene.background = null;
        const before = gl.getRenderTarget();
        gl.getClearColor(s.clear);
        const alpha = gl.getClearAlpha();
        // The sun's shadow is never drawn again for the picture: with every caster swapped for one that writes no depth
        // it would come out with no shadows in it, and the street flash full sun until it was next drawn. The picture
        // uses the one the view last drew (the same light, the same casters).
        const shadowDue = light.sun.shadow.needsUpdate;
        light.sun.shadow.needsUpdate = false;
        gl.setRenderTarget(picture);
        gl.setClearColor(0x000000, 0);
        gl.clear();
        gl.render(scene, shot);
        light.sun.shadow.needsUpdate = shadowDue;
        gl.setRenderTarget(before);
        gl.setClearColor(s.clear, alpha);
        scene.background = background;
        (drawing.shade.material as THREE.Material).depthWrite = false;
        if (s.waiting) culled(true);
        s.hidden.forEach((object) => (object.visible = true));
        s.swapped.forEach(([mesh, material]) => (mesh.material = material));
      }
      // Waiting while chalk: under the sidewalk for its first frames (so its shaders are built for this view), then far
      // below and left out of the frame. Real: in place, always drawn. And all through a sweep into it, under the
      // sidewalk again, drawn every frame, so on the frame it turns real only its place changes.
      if (s.warm > 0) s.warm--;
      const waiting = !s.real && s.warm === 0 && !s.compiling && !s.sweep?.toReal;
      if (waiting !== s.waiting) {
        s.waiting = waiting;
        culled(waiting);
      }
      const y = s.real ? 0 : waiting ? AWAY_BELOW : PARKED;
      if (drawing.real.position.y !== y) {
        drawing.real.position.y = y;
        drawing.real.updateMatrixWorld(true);
      }

      // Over the drawing, when a click would take it through: the pointer says so, the outline lights and is drawn
      // round, and (until it has been done) a tip says what a click does.
      const h = hover.current;
      const ready = (s.real || s.phase === "drawn") && !s.sweep && (wanted.current as string) === shown && working;
      const over = h.over && ready;
      if (over && outline.show.value < 0.05) h.trace = 0;
      h.trace = Math.min(1, h.trace + dt / 0.8);
      const lit = over ? (s.real ? 0.6 : 1) : 0;
      outline.show.value += (lit - outline.show.value) * (1 - Math.exp(-dt * 8));
      outline.trace.value = 1 - Math.pow(1 - h.trace, 3);
      outline.time.value = s.time;
      outline.mesh.visible = outline.show.value > 0.005;
      gl.domElement.style.cursor = over ? "pointer" : "";
      if (tip) {
        const tell = over && !h.tried[s.real ? "chalk" : "real"];
        if (tell) tip.textContent = s.real ? "Click to turn it back to chalk" : "Click to make it real";
        tip.style.opacity = tell ? "1" : "0";
        tip.style.transform = `translate(${Math.round(h.x + 16)}px, ${Math.round(h.y + 18)}px)`;
      }

      // The dust drifts in the sunlight.
      // (Only near the view: farther off, in the depth of field's blur, a speck that small turns into a bright ring.)
      dust.seeds.forEach((seed, i) => {
        const t = s.time * 0.12 + seed.phase;
        const [x, y, z] = [seed.x + Math.sin(t * 1.3) * 0.5, seed.y + Math.sin(t * 0.7) * 0.3, seed.z + Math.cos(t) * 0.5];
        const size = seed.size * THREE.MathUtils.smoothstep(9, 6, Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z));
        scratch.m.makeScale(size, size, size).setPosition(x, y, z);
        dust.mesh.setMatrixAt(i, scratch.m);
      });
      dust.mesh.instanceMatrix.needsUpdate = true;
    });

    return (
      <>
        <StudioEnvironment
          ambient="#b3bdc6"
          intensity={0.75}
          boxes={[
            { position: [0, 30, 0], scale: [60, 1, 60], color: "#dde4ea", intensity: 1.4 },
            { position: [-10, 12, -40], scale: [20, 10, 2], color: "#fff0d8", intensity: 2.2 }
          ]}
        />
        <primitive object={light.sun} />
        <primitive object={light.sun.target} />
        <primitive object={light.sky} />
        <primitive object={street.group} />
        <primitive object={props} />
        <primitive object={ground.mesh} />
        <primitive object={drawing.real} />
        <primitive object={spares} />
        <primitive object={tools.stick} />
        <primitive object={tools.eraser} />
        <primitive object={drawing.shade} />
        <primitive object={sticks.group} />
        <primitive object={outline.mesh} />
        <primitive object={leaves.mesh} />
        <primitive object={trash.group} />
        <primitive object={dust.mesh} />
        <Shafts sun={SUN} colour={SHAFT} />
      </>
    );
  };
}


// The paintings in the panel, favourites first.
const PICKER: DrawingKind[] = ["pool", "lava", "ocean", "crystal", "pit", "subway"];

export function makeDay(kind: DrawingKind): DayDefinition {
  return {
    camera: {
      position: [START.x, START.y, START.z],
      target: [AROUND.x, AROUND.y, AROUND.z],
      fov: FOV,
      // From the start (at eye height): well round either side of the drawing, short of the house fronts and out over
      // the road, up to look down on it, and only a little lower.
      limits: { turn: { left: 60, right: 70, up: 8, down: 50 }, move: { left: 1.5, right: 1.5, down: 0.5, up: 0.5, nearer: 3, further: 5 } }
    },
    hover: true,
    // A heavy street: at most one and a half device pixels per pixel.
    maxDpr: 1.5,
    // No ambient occlusion: it would see the flat drawing and the real thing differently, and the two must match on
    // the frame they swap. Depth of field fades out near the spot for the same reason; the haze is too slight to tell.
    look: { background: "#000000", exposure: 1.08, bloom: 0.25, bloomThreshold: 0.9, gi: 0, ao: 0, vignette: 0.35, grain: 0.03, haze: 0 },
    passes: { haze: false, bounce: false, overlay: true, occlusion: false, depthOfField: { range: 9, air: 0.45, airRate: 0.006, airBehindFocus: 4, depth: spotDepth, onLow: true } },
    settings: {
      painting: { type: "choice", label: "Chalk painting", value: kind, options: PICKER.map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })) },
      // On a phone, the first four as pills down the right, so a painting can be picked without opening the panel.
      quick: { type: "choice", label: "Chalk painting", value: kind, hidden: true, options: PICKER.slice(0, 4).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })) },
      redraw: { type: "action", label: "Back to chalk" }
    },
    phonePills: ["quick"],
    prompt: { title: "Walk around the\nchalk drawing", detail: "Then tap it", high: true, phoneUp: 60, phoneAside: true },
    hint: "Drag to walk round the chalk drawing and scroll to step in or back. Tap the drawing and it becomes real; tap it again to turn it back to chalk. Pick another chalk painting in the panel and it is wiped off and the next drawn on.",
    notes: `A chalk drawing of ${KINDS[kind].name} on a Brooklyn sidewalk. Walk round it, then tap it: the view sweeps through the one spot it was drawn for and, there, it becomes real.`,
    Scene: makeScene(kind)
  };
}
