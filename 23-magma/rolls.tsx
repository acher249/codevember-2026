"use client";

// Pizza rolls: "Add some Pizza Rolls" runs the microwave again, then drops ten onto the plate, Rapier bodies falling onto
// the plate, the pocket and each other. Each is a little fried-dough pillow (about 3.8 × 2.8 × 1.6 cm): puffed in the
// middle, pinched thin and crimped at its two ends, its corners standing out as ears; golden with browner edges, its
// surface blistered with small bubbles as fried dough is. A press bites one in half: the shader cuts it away along a
// toothed edge, its hollow inside shows sauce glowing hot, and its filling pours out onto the plate as lava (a source in
// the same flow as the pocket's). A second press eats the rest. Once a roll lies still it is fixed where it lies and
// no longer simulated; a roll still falling into lava floats on it, and any in lava scorch.

import { useFrame } from "@react-three/fiber";
import { Physics, useRapier } from "@react-three/rapier";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import {
  abs,
  attribute,
  cross,
  Discard,
  dot,
  faceDirection,
  float,
  Fn,
  frontFacing,
  If,
  max,
  mix,
  normalGeometry,
  normalize,
  normalView,
  positionGeometry,
  positionView,
  select,
  sin,
  smoothstep,
  texture,
  vec3
} from "three/tsl";
import { useGrabbable } from "../shared/engine/controls";
import { useDispose } from "../shared/engine/dispose";
import { dismissPrompt } from "../shared/engine/prompt";
import { lehmer } from "../shared/engine/random";
import { intro } from "./intro";
import type { Lava } from "./lava";
import type { Crumbs, Puffs } from "./render";
import { bottomHeight, COUNTER, outline, PLATE, plateHeight, POCKET, pocketToWorld, SLEEVE, topHeight } from "./shape";
import { crunch, thud } from "./sound";
import { clock } from "./time";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Its size in scene units (one is 25 cm): length along its own x, width along z, height.
export const ROLL = { length: 0.135, width: 0.1, height: 0.058 };
// The most on the plate at once: past this the oldest go to make room.
const MAX = 40;
const GRAVITY = 9.8 * 4;
// How much filling one holds, and how fast it runs out once bitten (scene units cubed, and per second).
const FILLING = 0.0003;
const POUR_RATE = 0.0004;

// What the scene calls: drop some in, clear them all.
export const pizzaRolls = { add: (count: number) => void count, clear: () => {} };

// How thick the fried dough is (about 2 mm, a crisp shell over soft bread, as the pocket's), and the bite's edge: where a
// roll's cut runs at (z, y) across it, for a bite at `at` along it, slanted, bowed in the middle as a mouth bites, and
// toothed. The same sum runs in the shader (the cut) and here (the cut face's ring), so the two meet.
const THICK = 0.008;
export type RollBite = { at: number; slope: number; depth: number; phase: number; freq: number };
function cutAt(b: RollBite, z: number, y: number) {
  const across = z / (ROLL.width / 2);
  const teeth = Math.abs(Math.sin(z * b.freq + b.phase)) * 0.005 + Math.sin(z * 61 + b.phase * 3) * 0.0018 + Math.sin(y * 90 + z * 37 + b.phase) * 0.0012 + y * 0.06;
  return b.at + b.slope * z - b.depth * (1 - across * across) + teeth;
}

// The roll's shape: a top and a bottom sheet over its outline, joined round a thin pressed rim; and inside it, the
// same again a shell's thickness in (facing inward), the hollow the filling fills. puff is how full each point is (0
// at the pinched edges and ends), kept for the shading.
function buildRoll(seed: number) {
  const random = lehmer(seed);
  const NU = 30;
  const NV = 22;
  const T = 0.0045;
  const fill = ROLL.height - 2 * T;
  const up = fill * 0.6;
  const down = fill * 0.4;
  // Where the puffed middle ends and each pinched end begins, and a few seeded wobbles so no two quite match.
  const END = 0.87;
  const wob = [random() * 6, random() * 6, random() * 6, 0.85 + random() * 0.3];
  const at = (u: number, v: number, side: number): [number, number, number, number] => {
    const gu = Math.abs(u) < END ? Math.pow(1 - Math.pow(Math.abs(u) / END, 4), 0.55) : 0;
    const gv = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(v), 5)), 0.5);
    const lump = 1 + 0.07 * Math.sin(u * 4.1 + wob[0]) * Math.cos(v * 3.3 + wob[1]) + 0.04 * Math.sin(u * 9 + v * 7 + wob[2]);
    const puff = gu * gv;
    // The ends fan out a little where they were pressed flat, and the corners lift into ears.
    const flare = 1 + 0.08 * Math.max(0, Math.abs(u) - END) / (1 - END);
    const x = (u * ROLL.length) / 2;
    const z = (v * ROLL.width * flare) / 2;
    // The pressed ends crimped: a ripple across them, both sheets together.
    const crimp = Math.abs(u) > END - 0.05 ? 0.0009 * Math.sin(v * Math.PI * 6 + wob[0]) * Math.min(1, (Math.abs(u) - END + 0.05) / 0.1) : 0;
    const ear = 0.004 * Math.pow(Math.abs(u), 6) * Math.pow(Math.abs(v), 4) * wob[3];
    const y = side > 0 ? T + up * puff * lump : -T - down * puff * (0.9 + 0.1 * lump);
    return [x, y + crimp + ear, z, puff];
  };
  // A shell's thickness in: drawn in from the top and the bottom (never past the middle, where the pinched ends are
  // solid dough), and in from the sides and the ends.
  const inner = (u: number, v: number, side: number): [number, number, number, number] => {
    const [x, y, z, puff] = at(u, v, side);
    const top = at(u, v, 1)[1];
    const bottom = at(u, v, -1)[1];
    const d = Math.min(THICK, ((top - bottom) / 2) * 0.9);
    return [x * (1 - (THICK * 1.4) / (ROLL.length / 2)), y - side * d, z * (1 - (THICK * 1.1) / (ROLL.width / 2)), puff];
  };
  const positions: number[] = [];
  const puffs: number[] = [];
  const kinds: number[] = [];
  let kind = 0;
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    for (const p of kind === 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c]) {
      positions.push(p[0], p[1], p[2]);
      puffs.push(p[3]);
      kinds.push(kind);
    }
  };
  const U = (i: number) => -1 + (2 * i) / NU;
  const V = (j: number) => -1 + (2 * j) / NV;
  const ring: [number, number][] = [];
  for (let i = 0; i < NU; i++) ring.push([U(i), -1]);
  for (let j = 0; j < NV; j++) ring.push([1, V(j)]);
  for (let i = NU; i > 0; i--) ring.push([U(i), 1]);
  for (let j = NV; j > 0; j--) ring.push([-1, V(j)]);
  // The outer shell (kind 0), then the inner (kind 1, wound the other way so it faces into the hollow).
  for (const surface of [at, inner]) {
    for (let i = 0; i < NU; i++)
      for (let j = 0; j < NV; j++) {
        // Top, facing up; bottom, facing down.
        quad(surface(U(i), V(j), 1), surface(U(i), V(j + 1), 1), surface(U(i + 1), V(j + 1), 1), surface(U(i + 1), V(j), 1));
        quad(surface(U(i), V(j), -1), surface(U(i + 1), V(j), -1), surface(U(i + 1), V(j + 1), -1), surface(U(i), V(j + 1), -1));
      }
    // The rim: round the outline, from the bottom sheet's edge up to the top's.
    for (let n = 0; n < ring.length; n++) {
      const [u0, v0] = ring[n];
      const [u1, v1] = ring[(n + 1) % ring.length];
      quad(surface(u0, v0, 1), surface(u1, v1, 1), surface(u1, v1, -1), surface(u0, v0, -1));
    }
    kind = 1;
  }
  let geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aPuff", new THREE.Float32BufferAttribute(puffs, 1));
  geometry.setAttribute("aKind", new THREE.Float32BufferAttribute(kinds, 1));
  geometry = mergeVertices(geometry, 1e-6);
  geometry.computeVertexNormals();
  return { geometry, at, inner };
}

// The cut face of a bitten roll: the ring of dough between its outer shell and its inner one, along the bite's edge
// (cutAt) on the side kept. ring is 0 at the outside, 1 at the hollow, for the shading.
function buildCap(shape: { at: (u: number, v: number, side: number) => number[]; inner: (u: number, v: number, side: number) => number[] }, b: RollBite, keep: number) {
  const NV = 40;
  const loop: [number, number][] = [];
  for (let j = 0; j <= NV; j++) loop.push([-1 + (2 * j) / NV, 1]);
  for (let j = NV - 1; j > 0; j--) loop.push([-1 + (2 * j) / NV, -1]);
  // A point of a surface where the cut crosses it: found by stepping along the roll to where the cut is, twice.
  const onCut = (surface: (u: number, v: number, side: number) => number[], v: number, side: number) => {
    let u = (keep * b.at) / (ROLL.length / 2);
    let p = surface(u, v, side);
    for (let n = 0; n < 2; n++) {
      u = Math.max(-0.95, Math.min(0.95, (keep * cutAt(b, p[2], p[1])) / (ROLL.length / 2)));
      p = surface(u, v, side);
    }
    return [keep * cutAt(b, p[2], p[1]), p[1], p[2]];
  };
  const outer = loop.map(([v, side]) => onCut(shape.at, v * 0.999, side));
  const hollow = loop.map(([v, side]) => onCut(shape.inner, v * 0.999, side));
  const positions: number[] = [];
  const rings: number[] = [];
  for (let n = 0; n < loop.length; n++) {
    const m = (n + 1) % loop.length;
    const mid = (a: number[], c: number[]) => [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
    const rows = [outer[n], mid(outer[n], hollow[n]), hollow[n]];
    const next = [outer[m], mid(outer[m], hollow[m]), hollow[m]];
    for (let r = 0; r < 2; r++)
      for (const [p, ring] of [
        [rows[r], r / 2],
        [next[r], r / 2],
        [next[r + 1], (r + 1) / 2],
        [rows[r], r / 2],
        [next[r + 1], (r + 1) / 2],
        [rows[r + 1], (r + 1) / 2]
      ] as [number[], number][]) {
        positions.push(p[0], p[1], p[2]);
        rings.push(ring);
      }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aRing", new THREE.Float32BufferAttribute(rings, 1));
  geometry.setAttribute("aGlow", new THREE.Float32BufferAttribute(new Float32Array(rings.length), 1));
  // Lit as one face looking out of the cut: per-triangle normals across the teeth's little steps shaded it in facets.
  const normals = new Float32Array(rings.length * 3);
  for (let n = 0; n < rings.length; n++) normals[n * 3] = keep;
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  return geometry;
}

// The fried dough's surface, made once at load into a small tiling texture (it spans TILE scene units): red the
// blisters (distance to the nearest of 28 × 28 bubble centres), green the pores (48 × 48), blue a soft value noise (3
// cells across, read at other scales for toasting, flecks, seeping sauce and cheese), alpha a fine grain (90 across).
// Drawn as noise per pixel the rolls cost up to 18 fps; as a few texture reads, nearly nothing.
const TILE = 0.1;
function bakeDough(size = 512) {
  const random = lehmer(9);
  const worley = (cells: number) => {
    const at = new Float32Array(cells * cells * 2).map(() => random());
    return (u: number, v: number) => {
      const x = u * cells;
      const y = v * cells;
      const ci = Math.floor(x);
      const cj = Math.floor(y);
      let best = 9;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const i = (((ci + di) % cells) + cells) % cells;
          const j = (((cj + dj) % cells) + cells) % cells;
          const k = (j * cells + i) * 2;
          best = Math.min(best, Math.hypot(ci + di + at[k] - x, cj + dj + at[k + 1] - y));
        }
      return Math.min(1, best);
    };
  };
  const value = (cells: number) => {
    const at = new Float32Array(cells * cells).map(() => random());
    const get = (i: number, j: number) => at[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
    return (u: number, v: number) => {
      const x = u * cells;
      const y = v * cells;
      const i = Math.floor(x);
      const j = Math.floor(y);
      const fx = x - i;
      const fy = y - j;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const a = get(i, j) + (get(i + 1, j) - get(i, j)) * sx;
      const b = get(i, j + 1) + (get(i + 1, j + 1) - get(i, j + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const bubbles = worley(28);
  const pores = worley(48);
  const soft = value(3);
  const grain = value(90);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const k = (y * size + x) * 4;
      data[k] = bubbles(u, v) * 255;
      data[k + 1] = pores(u, v) * 255;
      data[k + 2] = soft(u, v) * 255;
      data[k + 3] = grain(u, v) * 255;
    }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

type Roll = {
  on: boolean;
  body: any;
  collider: any;
  // Bitten: 0 whole, 1 half eaten (from side), 2 eaten.
  bites: number;
  side: number;
  glow: number;
  scorch: number;
  vy: number;
  // How long it has lain still; once settled it is fixed where it lies and no longer simulated.
  still: number;
  settled: boolean;
  variant: number;
  born: number;
};

function RollsInWorld({ lava, crumbs, puffs, light }: { lava: Lava; crumbs: Crumbs; puffs: Puffs; light: boolean }) {
  const { world, rapier } = useRapier();
  const parts = useMemo(() => {
    const shape = buildRoll(41);
    const geometry = shape.geometry;
    // Per roll: how toasted, which way and where it is cut (side, at), how hot inside, how scorched.
    const shade = new Float32Array(MAX);
    const cut = new Float32Array(MAX * 2);
    const heat = new Float32Array(MAX * 2);
    // Per roll, its bite: slant, bow, the teeth's phase and spacing (where along it is aCut's second value).
    const biteShape = new Float32Array(MAX * 4);
    const random = lehmer(5);
    for (let k = 0; k < MAX; k++) {
      shade[k] = random();
      cut[k * 2] = 1;
      cut[k * 2 + 1] = 1;
    }
    const shadeAttr = new THREE.InstancedBufferAttribute(shade, 1);
    const cutAttr = new THREE.InstancedBufferAttribute(cut, 2);
    const heatAttr = new THREE.InstancedBufferAttribute(heat, 2);
    const biteAttr = new THREE.InstancedBufferAttribute(biteShape, 4);
    geometry.setAttribute("aBite", biteAttr);
    geometry.setAttribute("aShade", shadeAttr);
    geometry.setAttribute("aCut", cutAttr);
    geometry.setAttribute("aHeat", heatAttr);

    const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.75 });
    const doughMap = bakeDough();
    const p = positionGeometry as any;
    // The baked surface is read from the three sides and blended by which way the surface faces (triplanar), so the
    // steep sides are not streaked, and shifted per roll so no two match.
    const puff = attribute("aPuff", "float") as any;
    const toast = attribute("aShade", "float") as any;
    const c = attribute("aCut", "vec2") as any;
    const h = attribute("aHeat", "vec2") as any;
    const shift = toast.mul(0.731) as any;
    const uv0 = p.xz.div(TILE).add(shift) as any;
    const facing = abs(normalGeometry).pow(4) as any;
    const weights = facing.div(facing.x.add(facing.y).add(facing.z)) as any;
    const surface = (texture(doughMap, p.zy.div(TILE).add(shift)) as any)
      .mul(weights.x)
      .add((texture(doughMap, uv0) as any).mul(weights.y))
      .add((texture(doughMap, p.xy.div(TILE).add(shift)) as any).mul(weights.z)) as any;
    // The soft noise at a scale, from -1 to 1 (as mx_noise_float, so its thresholds carry over).
    const soft = (scale: number) => (texture(doughMap, uv0.mul(scale)) as any).b.mul(2).sub(1) as any;
    // The bite: what is past the cut is gone, along its own slanted, bowed, toothed edge (cutAt, as on the processor).
    const bs = attribute("aBite", "vec4") as any;
    const kind = attribute("aKind", "float") as any;
    const across = p.z.div(ROLL.width / 2) as any;
    const teeth = sin(p.z.mul(bs.w).add(bs.z))
      .abs()
      .mul(0.005)
      .add(sin(p.z.mul(61).add(bs.z.mul(3))).mul(0.0018))
      .add(sin(p.y.mul(90).add(p.z.mul(37)).add(bs.z)).mul(0.0012))
      .add(p.y.mul(0.06)) as any;
    const cutLine = c.y.add(bs.x.mul(p.z)).sub(bs.y.mul(float(1).sub(across.mul(across)))).add(teeth) as any;
    const past = p.x.mul(c.x).sub(cutLine) as any;
    // Fried dough: blistered with small bubbles, finer pores between them, a faint grain.
    const bubbles = surface.r as any;
    const pores = surface.g as any;
    const grain = surface.a.mul(2).sub(1) as any;
    const relief = float(1)
      .sub(smoothstep(0.0, 0.5, bubbles))
      .mul(0.5)
      .sub(smoothstep(0.25, 0.0, pores).mul(0.4))
      .add(grain.mul(0.3)) as any;
    // Bumped by the relief's change across the screen (TSL's bumpMap only reads textures): the blisters and pores shade.
    material.normalNode = Fn(() => {
      const H = relief.mul(0.0008).mul(float(1).sub(kind)) as any;
      const n = normalView.mul(faceDirection) as any;
      const sx = positionView.dFdx() as any;
      const sy = positionView.dFdy() as any;
      const r1 = cross(sy, n) as any;
      const r2 = cross(n, sx) as any;
      const det = dot(sx, r1) as any;
      const grad = det.sign().mul(r1.mul(H.dFdx()).add(r2.mul(H.dFdy()))) as any;
      return normalize(det.abs().mul(n).sub(grad));
    })() as any;
    // Golden, browner toward the pinched edges and ends and on the raised blisters, a little paler in the full middle;
    // each roll toasted a shade differently; darkened to char where lava has lain against it.
    // How done each roll is (toast, 0 to 1): from pale and barely coloured, through golden, to deep brown with dark
    // edges and well-browned blisters, as rolls from one batch come out.
    const shadeOf = (pale: any, mid: any, done: any) => mix(mix(pale, mid, smoothstep(0, 0.5, toast)), done, smoothstep(0.5, 1, toast)) as any;
    const golden = shadeOf(vec3(0.9, 0.74, 0.5), vec3(0.82, 0.56, 0.28), vec3(0.6, 0.31, 0.09));
    const brown = shadeOf(vec3(0.76, 0.52, 0.26), vec3(0.62, 0.33, 0.11), vec3(0.34, 0.15, 0.04));
    const edge = float(1).sub(smoothstep(0.05, 0.5, puff)) as any;
    const blister = float(1)
      .sub(smoothstep(0.0, 0.3, bubbles))
      .mul(toast.mul(0.35).add(0.3)) as any;
    const flecks = smoothstep(0.82, 0.9, soft(10)).mul(0.15) as any;
    // Toasted patches where it lay against the hot tray, in soft blotches.
    const patches = smoothstep(0.1, 0.6, surface.b.mul(2).sub(1)).mul(toast.mul(0.45).add(0.25)) as any;
    let dough: any = mix(golden, brown, max(edge.mul(toast.mul(0.3).add(0.6)), blister).add(flecks).add(patches).min(1));
    dough = dough.mul(float(1).sub(smoothstep(0.15, 0.0, pores).mul(0.12)));
    // A little sauce seeped out at the crimped ends of some.
    const seep = smoothstep(0.55, 0.75, soft(2))
      .mul(smoothstep(0.62, 0.9, abs(p.x).div(ROLL.length / 2)))
      .mul(smoothstep(0.55, 0.8, toast)) as any;
    dough = mix(dough, vec3(0.72, 0.22, 0.06), seep.mul(0.85));
    const charred = mix(dough, vec3(0.08, 0.05, 0.035), smoothstep(0.1, 1, h.y)) as any;
    // At the bite: the pale soft dough the teeth tore through, a few millimetres back from the cut.
    const torn = float(1).sub(smoothstep(0, 0.006, past.negate())).mul(c.y.lessThan(0.9).select(float(1), float(0))) as any;
    const front = mix(charred, vec3(0.9, 0.78, 0.56), torn.mul(0.8)) as any;
    // Inside: sauce and melted cheese over the thin dough, hot.
    const cheese = smoothstep(0.5, 0.75, soft(3)) as any;
    const inside = mix(vec3(0.45, 0.07, 0.02), vec3(0.85, 0.55, 0.15), cheese) as any;
    // The outer shell's outside is the dough; everything else (its inside, and the inner shell lining the hollow) is
    // sauce and cheese.
    const outside = frontFacing.and(kind.lessThan(0.5)) as any;
    material.colorNode = Fn(() => {
      If(past.greaterThan(0), () => Discard());
      return select(outside, front, inside);
    })();
    material.emissiveNode = select(
      outside,
      vec3(0.9, 0.35, 0.08).mul(torn).mul(h.x).mul(0.15),
      mix(vec3(1.2, 0.22, 0.03), vec3(1.4, 0.7, 0.12), cheese).mul(h.x).mul(0.9)
    ) as any;
    material.roughnessNode = mix(float(0.78), float(0.55), edge.mul(0.5)).add(grain.mul(0.08)) as any;

    const mesh = new THREE.InstancedMesh(geometry, material, MAX);

    // The bitten rolls' cut faces, one small mesh each (shaped by its own bite), all in one material: a thin golden
    // crust at the outside, the soft pale bread through the thickness, sauce soaking its inner edge, glowing while hot.
    const capMaterial = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.9 });
    const ringAt = attribute("aRing", "float") as any;
    const capGlow = attribute("aGlow", "float") as any;
    // (Read from the dough texture by position, the bread came out flat grey: plain colours here.)
    const breadCrumb = vec3(0.96, 0.82, 0.58) as any;
    const soaked = smoothstep(0.7, 1.0, ringAt) as any;
    capMaterial.colorNode = mix(mix(vec3(0.72, 0.44, 0.17), breadCrumb, smoothstep(0.1, 0.3, ringAt)), vec3(0.62, 0.17, 0.04), soaked.mul(0.85)) as any;
    // The glowing filling lights its own cut face warm while it is hot (in the shade it was a cold grey).
    capMaterial.emissiveNode = vec3(1.2, 0.35, 0.06)
      .mul(soaked)
      .mul(0.6)
      .add(vec3(0.5, 0.28, 0.1).mul(ringAt.mul(0.6).add(0.4)).mul(0.35))
      .mul(capGlow) as any;
    const capPlaceholder = new THREE.BufferGeometry();
    capPlaceholder.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    capPlaceholder.setAttribute("aRing", new THREE.Float32BufferAttribute([0, 0, 0], 1));
    capPlaceholder.setAttribute("aGlow", new THREE.Float32BufferAttribute([0, 0, 0], 1));
    capPlaceholder.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    // Each starts as an empty triangle, drawn (so its shader is built at load, not at the first bite) but invisible.
    const caps = Array.from({ length: MAX }, () => {
      const cap = new THREE.Mesh(capPlaceholder, capMaterial);
      cap.matrixAutoUpdate = false;
      cap.frustumCulled = false;
      cap.castShadow = true;
      cap.receiveShadow = true;
      mesh.add(cap);
      return cap;
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let k = 0; k < MAX; k++) mesh.setMatrixAt(k, hidden);

    const rolls: Roll[] = Array.from({ length: MAX }, () => ({ on: false, body: null, collider: null, bites: 0, side: 1, glow: 0, scorch: 0, vy: 0, variant: 0, born: 0, still: 0, settled: false }));
    return { shape, biteShape, biteAttr, caps, capMaterial, capPlaceholder, geometry, material, doughMap, mesh, shadeAttr, cutAttr, heatAttr, cut, heat, hidden, rolls, random: lehmer(17) };
  }, []);
  useDispose(parts.geometry, parts.material, parts.doughMap, parts.capMaterial, parts.capPlaceholder);
  // What the rolls collide as: a small hull of the real shape (five points along, five across, top and bottom), whole or
  // the half kept after a bite. Hulls of the whole mesh were half a phone's frame in contacts; a box (as cheap) let
  // them stand up on their square ends, which pinched pillows never do.
  const hullShapes = useMemo(() => {
    const hull = (from: number, to: number) => {
      const points: number[] = [];
      for (let a = 0; a <= 4; a++)
        for (let b = 0; b <= 4; b++)
          for (const side of [1, -1]) {
            const [x, y, z] = parts.shape.at(from + ((to - from) * a) / 4, -1 + b / 2, side);
            points.push(x, y, z);
          }
      return rapier.ColliderDesc.convexHull(new Float32Array(points)) ?? rapier.ColliderDesc.cuboid(ROLL.length / 4, ROLL.height / 2, ROLL.width / 2);
    };
    return { whole: hull(-1, 1), "1": hull(-1, 0.02), "-1": hull(-0.02, 1) };
  }, [rapier, parts]);

  // A roll's cut face put away (its own geometry freed).
  const clearCap = (k: number) => {
    const cap = parts.caps[k];
    if (cap.geometry !== parts.capPlaceholder) cap.geometry.dispose();
    cap.geometry = parts.capPlaceholder;
  };

  // The fixed world: the counter, the plate's upper face and the pocket in its sleeve, as they rest.
  useEffect(() => {
    const made: any[] = [];
    const fixed = (desc: any) => made.push(world.createCollider(desc.setFriction(0.8).setRestitution(0.1)));
    fixed(rapier.ColliderDesc.cuboid(3, 0.05, 3).setTranslation(0, COUNTER - 0.05, 0));
    // The plate: its upper face turned round, rings out to the rim.
    const RINGS = 40;
    const AROUND = 72;
    const verts: number[] = [0, 0, 0];
    for (let r = 1; r <= RINGS; r++) {
      const radius = (PLATE * r) / RINGS;
      for (let a = 0; a < AROUND; a++) {
        const t = (a / AROUND) * Math.PI * 2;
        verts.push(Math.cos(t) * radius, plateHeight(radius), Math.sin(t) * radius);
      }
    }
    const index: number[] = [];
    for (let a = 0; a < AROUND; a++) index.push(0, 1 + ((a + 1) % AROUND), 1 + a);
    for (let r = 1; r < RINGS; r++)
      for (let a = 0; a < AROUND; a++) {
        const i0 = 1 + (r - 1) * AROUND + a;
        const i1 = 1 + (r - 1) * AROUND + ((a + 1) % AROUND);
        const o0 = i0 + AROUND;
        const o1 = i1 + AROUND;
        index.push(i0, i1, o1, i0, o1, o0);
      }
    fixed(rapier.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(index)));
    // The pocket: its top and bottom over its outline, in the world as it rests; and its sleeve, a box round its back end.
    const pocket: number[] = [];
    for (let x = -POCKET.length / 2; x <= POCKET.length / 2; x += 0.02)
      for (let z = -POCKET.width / 2; z <= POCKET.width / 2; z += 0.02) {
        const d = -outline(x, z);
        if (d < 0) continue;
        pocket.push(...pocketToWorld(x, topHeight(d, x, z), z), ...pocketToWorld(x, bottomHeight(d), z));
      }
    const pocketHull = rapier.ColliderDesc.convexHull(new Float32Array(pocket));
    if (pocketHull) fixed(pocketHull);
    const sleeve: number[] = [];
    for (const x of [SLEEVE.from, SLEEVE.to]) for (const z of [-SLEEVE.width / 2, SLEEVE.width / 2]) for (const y of [0, SLEEVE.height + SLEEVE.tent]) sleeve.push(...pocketToWorld(x, y, z));
    const sleeveHull = rapier.ColliderDesc.convexHull(new Float32Array(sleeve));
    if (sleeveHull) fixed(sleeveHull);
    return () => {
      for (const c of made) if (world.getCollider(c.handle)) world.removeCollider(c, false);
    };
  }, [world, rapier]);

  const drops = useRef<{ at: number }[]>([]);

  const remove = (roll: Roll) => {
    clearCap(parts.rolls.indexOf(roll));
    if (roll.body && world.getRigidBody(roll.body.handle)) world.removeRigidBody(roll.body);
    roll.body = null;
    roll.collider = null;
    roll.on = false;
  };

  const spawn = (k: number) => {
    const { rolls, random, cut, heat, cutAttr, heatAttr } = parts;
    const roll = rolls[k];
    remove(roll);
    // Somewhere over the plate, high enough to fall into view, turned any way.
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(random()) * 0.3;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(random() * 0.8 - 0.4, random() * Math.PI * 2, random() * 0.8 - 0.4));
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(Math.cos(a) * r, 0.55 + random() * 0.25, Math.sin(a) * r + 0.06)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinvel((random() - 0.5) * 0.3, -0.5, (random() - 0.5) * 0.3)
        .setAngvel({ x: (random() - 0.5) * 6, y: (random() - 0.5) * 6, z: (random() - 0.5) * 6 })
        .setAngularDamping(0.4)
        .setCcdEnabled(true)
    );
    const shape = hullShapes.whole;
    roll.collider = world.createCollider(shape.setFriction(0.75).setRestitution(0.18).setDensity(0.5), body);
    Object.assign(roll, { on: true, body, bites: 0, side: 1, glow: 0, scorch: 0, vy: 0, born: clock.now, still: 0, settled: false });
    // How done this one came out: most golden, some pale, some well browned.
    const done = random();
    (parts.shadeAttr.array as Float32Array)[k] = done < 0.2 ? done * 1.2 : done > 0.8 ? 0.8 + (done - 0.8) : 0.3 + (done - 0.2) * 0.75;
    parts.shadeAttr.needsUpdate = true;
    cut[k * 2] = 1;
    cut[k * 2 + 1] = 1;
    heat[k * 2] = 0;
    heat[k * 2 + 1] = 0;
    cutAttr.needsUpdate = true;
    heatAttr.needsUpdate = true;
  };

  useEffect(() => {
    pizzaRolls.add = (count: number) => {
      // A beat apart, so they tumble in one after another rather than as a block.
      const start = clock.now;
      for (let n = 0; n < count; n++) drops.current.push({ at: start + n * 0.09 });
    };
    pizzaRolls.clear = () => {
      drops.current.length = 0;
      for (const roll of parts.rolls) remove(roll);
      for (let k = 0; k < MAX; k++) parts.mesh.setMatrixAt(k, parts.hidden);
      parts.mesh.instanceMatrix.needsUpdate = true;
    };
    return () => {
      pizzaRolls.clear();
      pizzaRolls.add = () => {};
      pizzaRolls.clear = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts, world]);

  // Pressing a roll bites it: the ray is tested against each roll's box in its own frame (a few dozen slab tests).
  const scratch = useMemo(() => ({ q: new THREE.Quaternion(), o: new THREE.Vector3(), d: new THREE.Vector3(), hit: new THREE.Vector3() }), []);
  const picked = useRef<{ k: number; x: number } | null>(null);
  useGrabbable({
    pick: (ray) => {
      let best: { distance: number; point: THREE.Vector3 } | null = null;
      picked.current = null;
      parts.rolls.forEach((roll, k) => {
        if (!roll.on || !roll.body || roll.bites >= 2) return;
        const t = roll.body.translation();
        const r = roll.body.rotation();
        scratch.q.set(r.x, r.y, r.z, r.w).invert();
        const o = scratch.o.set(ray.origin.x - t.x, ray.origin.y - t.y, ray.origin.z - t.z).applyQuaternion(scratch.q);
        const d = scratch.d.copy(ray.direction).applyQuaternion(scratch.q);
        const half = [ROLL.length / 2, ROLL.height / 2, ROLL.width / 2];
        // What is left of a half-eaten roll: only its own half of the box.
        const lo = [roll.bites === 1 && roll.side < 0 ? 0 : -half[0], -half[1], -half[2]];
        const hi = [roll.bites === 1 && roll.side > 0 ? 0 : half[0], half[1], half[2]];
        let near = 0;
        let far = Infinity;
        const os = [o.x, o.y, o.z];
        const ds = [d.x, d.y, d.z];
        for (let n = 0; n < 3; n++) {
          if (Math.abs(ds[n]) < 1e-9) {
            if (os[n] < lo[n] || os[n] > hi[n]) return;
            continue;
          }
          let t0 = (lo[n] - os[n]) / ds[n];
          let t1 = (hi[n] - os[n]) / ds[n];
          if (t0 > t1) [t0, t1] = [t1, t0];
          near = Math.max(near, t0);
          far = Math.min(far, t1);
          if (near > far) return;
        }
        if (!best || near < best.distance) {
          best = { distance: near, point: ray.at(near, new THREE.Vector3()) };
          picked.current = { k, x: o.x + d.x * near };
        }
      });
      return best;
    },
    grab: () => {
      const p = picked.current;
      if (p) bite(p.k, p.x);
    },
    drag: () => {},
    release: () => {}
  });

  const bite = (k: number, localX: number) => {
    intro.stop();
    dismissPrompt();
    const { rolls, cut, heat, cutAttr, heatAttr } = parts;
    const roll = rolls[k];
    if (!roll.body) return;
    const t = roll.body.translation();
    const r = roll.body.rotation();
    const q = scratch.q.set(r.x, r.y, r.z, r.w);
    crunch();
    if (roll.bites === 0) {
      // In half: the end pressed goes, the other stays, open toward where the bite was.
      roll.side = localX >= 0 ? 1 : -1;
      roll.bites = 1;
      roll.glow = 1;
      // No two bites alike: a little nearer one end or the other, slanted, bowed deeper or shallower in the middle,
      // the teeth spaced and placed their own way.
      const rnd = parts.random;
      const look: RollBite = { at: (rnd() - 0.5) * 0.024, slope: (rnd() - 0.5) * 0.3, depth: rnd() * 0.016, phase: rnd() * Math.PI * 2, freq: 110 + rnd() * 80 };
      cut[k * 2] = roll.side;
      cut[k * 2 + 1] = look.at;
      cutAttr.needsUpdate = true;
      parts.biteShape.set([look.slope, look.depth, look.phase, look.freq], k * 4);
      parts.biteAttr.needsUpdate = true;
      clearCap(k);
      const cap = parts.caps[k];
      cap.geometry = buildCap(parts.shape, look, roll.side);
      cap.matrix.compose(vs.set(t.x, t.y, t.z), qs.set(r.x, r.y, r.z, r.w), one);
      world.removeCollider(roll.collider, true);
      const shape = hullShapes[String(roll.side) as "1" | "-1"];
      if (shape) roll.collider = world.createCollider(shape.setFriction(0.75).setRestitution(0.15).setDensity(0.5), roll.body);
      if (!roll.settled) roll.body.wakeUp();
      // The filling runs out of the open end, onto the plate under it.
      const mouth = scratch.hit.set(roll.side * 0.03, -ROLL.height * 0.3, 0).applyQuaternion(q).add(t as THREE.Vector3);
      lava.pour(mouth.x, mouth.z, FILLING, POUR_RATE, 0.026);
      crumbs.spawn(mouth.x, t.y + 0.02, mouth.z, 8);
      for (let n = 0; n < 12; n++) puffs.emit(mouth.x + (parts.random() - 0.5) * 0.04, t.y + 0.02, mouth.z + (parts.random() - 0.5) * 0.04, 0, 0.05);
    } else {
      // The rest of it, gone in one more bite.
      roll.bites = 2;
      crumbs.spawn(t.x, t.y + 0.02, t.z, 8);
      remove(roll);
      parts.mesh.setMatrixAt(k, parts.hidden);
      parts.mesh.instanceMatrix.needsUpdate = true;
      heat[k * 2] = 0;
      heatAttr.needsUpdate = true;
    }
  };

  if (process.env.NODE_ENV !== "production")
    Object.assign(globalThis, {
      __rolls: {
        mesh: parts.mesh,
        bite: (k: number, x: number) => bite(k, x),
        where: () => parts.rolls.map((r, k) => (r.on && r.body ? { k, bites: r.bites, ...r.body.translation(), sleeping: r.body.isSleeping(), settled: r.settled, fixed: r.body.isFixed() } : null)).filter(Boolean)
      }
    });

  const acc = useRef(0);
  const lastThud = useRef(0);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const qs = useMemo(() => new THREE.Quaternion(), []);
  const vs = useMemo(() => new THREE.Vector3(), []);
  const one = useMemo(() => new THREE.Vector3(1, 1, 1), []);
  useFrame((_, raw) => {
    const dt = (Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1 / 20) : 0) * clock.speed;
    const { rolls, mesh, heat, heatAttr, random } = parts;
    // Drops that are due: into a free slot, or the oldest roll's.
    const due = drops.current;
    while (due.length && due[0].at <= clock.now) {
      due.shift();
      let k = rolls.findIndex((r) => !r.on);
      if (k < 0) k = rolls.reduce((o, r, n) => (r.born < rolls[o].born ? n : o), 0);
      spawn(k);
    }
    if (!rolls.some((r) => r.on)) return;

    // Lava under a roll holds it up (a thick, heavy liquid) and slows it; and scorches it.
    for (let k = 0; k < MAX; k++) {
      const roll = rolls[k];
      if (!roll.on || !roll.body) continue;
      const t = roll.body.translation();
      if (!roll.settled) roll.body.resetForces(false);
      if (Math.hypot(t.x, t.z) < PLATE) {
        const s = lava.sample(t.x, t.z);
        const bottom = t.y - ROLL.height * 0.45;
        if (s.depth > 0.001 && s.surface > bottom) {
          const sunk = Math.min(1, (s.surface - bottom) / (ROLL.height * 0.6));
          if (!roll.settled) {
            const mass = roll.body.mass();
            roll.body.addForce({ x: 0, y: mass * GRAVITY * 2.2 * sunk, z: 0 }, true);
            roll.body.setLinearDamping(1 + 10 * sunk);
            roll.body.setAngularDamping(0.4 + 6 * sunk);
          }
          roll.scorch = Math.min(1, roll.scorch + dt * 0.12 * s.heat * sunk);
          if (s.heat > 0.4 && random() < dt * 2 * sunk) puffs.emit(t.x, s.surface + 0.01, t.z, roll.scorch > 0.5 ? 1 : 0, 0.04);
        } else if (!roll.settled) {
          roll.body.setLinearDamping(0.05);
          roll.body.setAngularDamping(0.4);
        }
      }
      // A bitten roll's inside cools over half a minute, steaming while it is hot.
      if (roll.bites === 1) {
        roll.glow = Math.max(0, roll.glow - dt / 30);
        const glowAttr = parts.caps[k].geometry.getAttribute("aGlow") as THREE.BufferAttribute;
        if (glowAttr.getX(0) !== roll.glow) {
          (glowAttr.array as Float32Array).fill(roll.glow);
          glowAttr.needsUpdate = true;
        }
        if (roll.glow > 0.3 && random() < dt * 3 * roll.glow) {
          const p = vs.set(roll.side * 0.01, 0.01, 0).applyQuaternion(qs.set(roll.body.rotation().x, roll.body.rotation().y, roll.body.rotation().z, roll.body.rotation().w)).add(t as THREE.Vector3);
          puffs.emit(p.x, p.y, p.z, 0, 0.04);
        }
      }
      heat[k * 2] = roll.glow;
      heat[k * 2 + 1] = roll.scorch;
    }
    heatAttr.needsUpdate = true;

    // Fixed steps of a hundred-and-twentieth (small, fast pieces), as many as the time needs, at most a dozen a frame;
    // none once every roll has settled.
    if (rolls.some((r) => r.on && !r.settled)) {
      acc.current += dt;
      // On a phone, sixtieths and at most four a frame (falling a touch less finely; the rolls are continuous-collision
      // bodies, so none passes through the plate).
      const tick = light ? 1 / 60 : 1 / 120;
      const most = light ? 4 : 12;
      world.timestep = tick;
      let steps = 0;
      while (acc.current >= tick && steps < most) {
        world.step();
        acc.current -= tick;
        steps++;
      }
      if (steps === most) acc.current = 0;
    } else acc.current = 0;

    for (let k = 0; k < MAX; k++) {
      const roll = rolls[k];
      if (!roll.on || !roll.body) continue;
      const t = roll.body.translation();
      const r = roll.body.rotation();
      // Fallen off the counter (or through it): gone.
      if (t.y < COUNTER - 0.5 || !Number.isFinite(t.y)) {
        remove(roll);
        mesh.setMatrixAt(k, parts.hidden);
        continue;
      }
      if (roll.settled) continue;
      // Settled: still for a moment (or asleep, or falling a good while), it is fixed where it lies, out of the
      // simulation; later rolls still land on it.
      const v = roll.body.linvel();
      const w = roll.body.angvel();
      roll.still = Math.hypot(v.x, v.y, v.z) < 0.04 && Math.hypot(w.x, w.y, w.z) < 0.4 ? roll.still + dt : 0;
      if (roll.still > 0.4 || roll.body.isSleeping() || clock.now - roll.born > 6) {
        roll.body.setBodyType(rapier.RigidBodyType.Fixed, false);
        roll.settled = true;
      }
      // A soft paper-plate tap as one lands hard.
      const vy = v.y;
      const jolt = vy - roll.vy;
      roll.vy = vy;
      const now = performance.now();
      if (jolt > 0.9 && now - lastThud.current > 45) {
        lastThud.current = now;
        thud(Math.min(1, jolt / 5));
      }
      m.compose(vs.set(t.x, t.y, t.z), qs.set(r.x, r.y, r.z, r.w), one);
      mesh.setMatrixAt(k, m);
      if (roll.bites === 1) parts.caps[k].matrix.copy(m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <primitive object={parts.mesh} />;
}

// Rapier loads its WebAssembly as the scene loads; until then there are simply no rolls. Stepped by hand (paused here),
// so the Speed slider runs it with everything else.
export function PizzaRolls(props: { lava: Lava; crumbs: Crumbs; puffs: Puffs; light: boolean }) {
  return (
    <Suspense fallback={null}>
      <Physics paused gravity={[0, -GRAVITY, 0]}>
        <RollsInWorld {...props} />
      </Physics>
    </Suspense>
  );
}
