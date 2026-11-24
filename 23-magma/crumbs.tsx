"use client";

// Crumbs on the plate, and what the lava does to them. Pastry crumbs lie scattered on the plate's floor, thickest round
// the bitten end: mostly fine dust and specks, many small crumbs, a few thin layered flakes and a couple of crust shards
// with the crimp's ridges. Each is its own shape, made at load from a noise-displaced sphere: lumpy, broken along a
// plane or two, with the pastry's laminated layers round its sides, smooth-shaded; a golden speckled crust side as the
// pocket's and a paler porous broken side. They sit a little sunk into the plate, darker underneath, and all of them
// are one mesh and one draw.
//
// When the lava's front reaches a crumb it catches, as brush does when lava creeps into it on a hillside: flames wrap it
// (fire.tsx), a glowing line of burning creeps over it and leaves it charred black, embers glow in its cracks, it
// shrinks, and it falls to grey ash. Crumbs float up on the lava that runs under them, and a burning crumb sets its
// close neighbours alight, so a cluster goes up as one front. Each crumb's state is a texel of a small texture the mesh
// reads, so nothing is rebuilt as it burns.

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import {
  attribute,
  clamp,
  exp,
  float,
  Fn,
  If,
  mix,
  mx_cell_noise_float,
  mx_noise_float,
  mx_worley_noise_float,
  mx_worley_noise_vec2,
  positionGeometry,
  smoothstep,
  step,
  texture,
  time,
  varying,
  vec2,
  vec3
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { useQuality } from "../shared/engine/quality";
import { lehmer } from "../shared/engine/random";
import { useFire } from "./fire";
import type { Lava } from "./lava";
import { COUNTER, FLAT, mirrored, outline, PLATE, plateHeight, pocketToWorld, toPocket } from "./shape";
import { catchFire, crackle } from "./sound";
import { clock } from "./time";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The kinds of crumb: fine dust, crumbs, thin flakes of layered pastry, shards of crust with the crimp.
const DUST = 0;
const CRUMB = 1;
const FLAKE = 2;
const SHARD = 3;
// How long each kind burns, in seconds: flame first, then a glowing coal, then ash.
const BURN = [2.5, 9, 7, 13];
// The pocket's units are a quarter metre: a millimetre is this much.
const MM = 0.004;

type Crumb = {
  x: number;
  y: number;
  z: number;
  kind: number;
  size: number;
  height: number;
  burn: number;
  lit: number;
  flame: number;
  lift: number;
  seed: number;
  near: number[];
  group: number[];
  // How far it lies from the pocket's outline, so its flames never cut into the pastry.
  room: number;
};

// Smooth value noise in three dimensions, 0 to 1, for shaping crumbs at load.
function hash(x: number, y: number, z: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483587);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, y: number, z: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const at = (a: number, b: number, c: number) => hash(ix + a, iy + b, iz + c);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(at(0, 0, 0), at(1, 0, 0), u), lerp(at(0, 1, 0), at(1, 1, 0), u), v),
    lerp(lerp(at(0, 0, 1), at(1, 0, 1), u), lerp(at(0, 1, 1), at(1, 1, 1), u), v),
    w
  );
}
const fbm = (x: number, y: number, z: number) => noise(x, y, z) * 0.6 + noise(x * 2.1 + 7, y * 2.1, z * 2.1) * 0.28 + noise(x * 4.3, y * 4.3 + 3, z * 4.3) * 0.12;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The unit spheres crumbs are shaped from, one per level of detail, with shared vertices so they shade smooth.
const spheres = new Map<number, THREE.BufferGeometry>();
function sphere(detail: number) {
  let g = spheres.get(detail);
  if (!g) {
    const raw = new THREE.IcosahedronGeometry(1, detail);
    raw.deleteAttribute("normal");
    raw.deleteAttribute("uv");
    g = mergeVertices(raw);
    raw.dispose();
    spheres.set(detail, g);
  }
  return g;
}

// One crumb's shape, in its own frame with its foot at the origin (sunk a little), in world units: positions, normals,
// how much of each vertex is crust (0 the broken inside, 1 the baked outside), and how open each vertex is to the sky.
function shapeCrumb(kind: number, size: number, random: () => number) {
  const detail = kind === DUST ? 0 : kind === SHARD ? 3 : size > 0.007 ? 3 : 2;
  const base = sphere(detail);
  const unit = base.attributes.position as THREE.BufferAttribute;
  const count = unit.count;
  const o = [random() * 40, random() * 40, random() * 40];
  const squash = kind === DUST ? 0.5 + random() * 0.4 : kind === CRUMB ? 0.42 + random() * 0.36 : kind === FLAKE ? 0.15 + random() * 0.1 : 0.24 + random() * 0.06;
  const across = kind === SHARD ? 0.55 + random() * 0.15 : 0.6 + random() * 0.4;
  const rough = kind === DUST ? 0.3 : kind === CRUMB ? 0.5 : kind === FLAKE ? 0.32 : 0.18;
  const layers = kind === CRUMB ? 1 : kind === FLAKE ? 0.5 : kind === SHARD ? 0.6 : 0;
  // Broken faces: a crumb is torn off along a plane or two, which flattens that side.
  const cuts: [number, number, number, number][] = [];
  if (kind === CRUMB || kind === SHARD)
    for (let c = 0; c < (kind === SHARD ? 2 : 1 + Math.floor(random() * 2)); c++) {
      const a = random() * Math.PI * 2;
      const e = (random() - 0.5) * 0.6;
      cuts.push([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), 0.35 + random() * 0.3]);
    }
  // Which way its crust faces, if it has one.
  const crustUp = kind === FLAKE || kind === SHARD || random() < 0.55;
  const ca = random() * Math.PI * 2;
  const tilt = kind === CRUMB ? random() * 1.2 : 0;
  const crustDir = [Math.sin(tilt) * Math.cos(ca), Math.cos(tilt), Math.sin(tilt) * Math.sin(ca)];
  const curl = kind === FLAKE ? (random() - 0.5) * 0.7 : kind === SHARD ? 0.35 : 0;
  const dust = kind === DUST ? (random() < 0.45 ? 1 : 0.08) : 0;

  const positions = new Float32Array(count * 3);
  const crust = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const vx = unit.getX(k);
    const vy = unit.getY(k);
    const vz = unit.getZ(k);
    const n1 = fbm(vx * 1.6 + o[0], vy * 1.6 + o[1], vz * 1.6 + o[2]) - 0.5;
    const n2 = noise(vx * 4.5 + o[1], vy * 4.5 + o[2], vz * 4.5 + o[0]) - 0.5;
    let r = 1 + rough * (n1 * 1.2 + n2 * 0.5);
    // The pastry's layers: fine ridges running round the sides.
    if (layers) r *= 1 + layers * 0.06 * Math.sin(vy * 13 + n1 * 5) * (1 - Math.abs(vy));
    let x = vx * r;
    let y = vy * r * squash;
    let z = vz * r * across;
    for (const [nx, ny, nz, d] of cuts) {
      const along = x * nx + y * ny + z * nz;
      if (along > d) {
        x -= nx * (along - d) * 0.85;
        y -= ny * (along - d) * 0.85;
        z -= nz * (along - d) * 0.85;
      }
    }
    // Flakes curl and ripple; shards are a piece of the curved shell, with the crimp's ridges along one edge.
    y += curl * (x * x - 0.3) + (kind === FLAKE ? 0.05 * Math.sin(x * 5 + o[0]) : 0);
    if (kind === SHARD && vy > -0.2) y += 0.09 * (0.5 + 0.5 * Math.sin(z * 24)) * smooth(0.35, 0.85, x);
    // A flat underside, so it lies on the plate rather than balancing on a point.
    const floor = -squash * 0.55;
    if (y < floor) y = floor + (y - floor) * 0.2;
    positions[k * 3] = x * size;
    positions[k * 3 + 1] = y * size;
    positions[k * 3 + 2] = z * size;
    const facing = vx * crustDir[0] + vy * crustDir[1] + vz * crustDir[2];
    crust[k] =
      kind === DUST
        ? dust
        : kind === CRUMB
          ? crustUp
            ? smooth(0.2, 0.6, facing + n2 * 0.6)
            : 0
          : kind === FLAKE
            ? smooth(0.2, 0.55, Math.abs(vy) + n2 * 0.4) * (vy > 0 ? 1 : 0.7)
            : vy > 0
              ? smooth(-0.15, 0.2, vy + n2 * 0.3)
              : 0.12;
  }
  // Its foot at the origin, sunk a little into what it lies on; then smooth normals.
  let low = Infinity;
  let high = -Infinity;
  for (let k = 0; k < count; k++) {
    low = Math.min(low, positions[k * 3 + 1]);
    high = Math.max(high, positions[k * 3 + 1]);
  }
  const height = high - low;
  for (let k = 0; k < count; k++) positions[k * 3 + 1] -= low + height * 0.1;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(base.index!.clone());
  g.computeVertexNormals();
  const normals = (g.attributes.normal as THREE.BufferAttribute).array as Float32Array;
  const index = Array.from(g.index!.array);
  g.dispose();
  const open = new Float32Array(count);
  for (let k = 0; k < count; k++) open[k] = 0.4 + 0.6 * smooth(-0.1 * height, 0.65 * height, positions[k * 3 + 1]);
  return { positions, normals, crust, open, index, height: height * 0.9 };
}

// `emitSmoke` (the shared steam's smoke) is no longer used: the fire has its own, alpha-blended smoke.
export function PlateCrumbs({ lava, fine, onIgnite }: { lava: Lava; fine: boolean; emitSmoke?: (x: number, y: number, z: number) => void; onIgnite: () => void }) {
  // The fire's pools are sized by the tier the visit starts on, so a later step down rebuilds nothing.
  const { tier } = useQuality();
  const fire = useFire(useRef(tier).current);
  const parts = useMemo(() => {
    const random = lehmer(8231);
    // Where they lie: most in a spray round the bitten end (where crumbs fall), the rest anywhere on the floor; never
    // under the pocket or its sleeve.
    const [fx, , fz] = pocketToWorld(0.36, 0, 0);
    const crumbs: Crumb[] = [];
    const place = (kind: number, size: number, spray: number) => {
      for (let tries = 0; tries < 60; tries++) {
        let x: number, z: number;
        if (random() < spray) {
          const a = random() * Math.PI * 2;
          const r = Math.pow(random(), 1.4) * 0.17;
          x = fx + Math.cos(a) * r;
          z = fz + Math.sin(a) * r;
        } else {
          const a = random() * Math.PI * 2;
          const r = Math.sqrt(random()) * (FLAT - 0.02);
          x = Math.cos(a) * r;
          z = Math.sin(a) * r;
        }
        if (Math.hypot(x, z) > FLAT - 0.01) continue;
        const [px, pz] = toPocket(x, z);
        if (outline(px, pz) < 0.012 || (px < 0.06 && Math.abs(pz) < 0.17)) continue;
        crumbs.push({ x, z, y: plateHeight(Math.hypot(x, z)), kind, size, height: 0, burn: 0, lit: -1, flame: -1, lift: 0, seed: random(), near: [], group: [], room: 1 });
        return;
      }
    };
    // Sizes as half-widths: dust a quarter to two-thirds of a millimetre across, crumbs one to three, flakes three to
    // six, shards six to ten.
    for (let k = 0; k < (fine ? 240 : 90); k++) place(DUST, (0.12 + random() * 0.22) * MM, 0.75);
    for (let k = 0; k < (fine ? 120 : 48); k++) place(CRUMB, (0.5 + Math.pow(random(), 2) * 1.1) * MM, 0.72);
    for (let k = 0; k < (fine ? 22 : 9); k++) place(FLAKE, (1.5 + random() * 1.4) * MM, 0.8);
    for (let k = 0; k < (fine ? 3 : 2); k++) place(SHARD, (3 + random() * 2) * MM, 0.9);
    // A few strays on the counter in front of the plate, out of the lava's reach.
    for (let k = 0; k < (fine ? 18 : 7); k++) {
      const a = 0.4 + random() * 1.9;
      const r = PLATE + 0.03 + random() * 0.3;
      const kind = random() < 0.55 ? DUST : random() < 0.85 ? CRUMB : FLAKE;
      const size = (kind === DUST ? 0.15 + random() * 0.2 : kind === CRUMB ? 0.5 + random() * 0.6 : 1.4 + random()) * MM;
      crumbs.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, y: COUNTER, kind, size, height: 0, burn: 0, lit: -1, flame: -1, lift: 0, seed: random(), near: [], group: [], room: 1 });
    }
    for (const c of crumbs) c.room = outline(...toPocket(c.x, c.z));
    // Who is close enough to catch from whom.
    for (let a = 0; a < crumbs.length; a++)
      for (let b = 0; b < crumbs.length; b++)
        if (a !== b && crumbs[b].kind !== DUST) {
          const d = Math.hypot(crumbs[a].x - crumbs[b].x, crumbs[a].z - crumbs[b].z);
          // Close enough to catch from it, and close enough for their flames to join.
          if (d < 0.018 + crumbs[a].size + crumbs[b].size) crumbs[a].near.push(b);
          if (d < 0.04) crumbs[a].group.push(b);
        }

    // Every crumb's shape, turned and placed, into one geometry.
    const shapes = crumbs.map((c) => shapeCrumb(c.kind, c.size, random));
    const vertices = shapes.reduce((n, s) => n + s.positions.length / 3, 0);
    const indices = shapes.reduce((n, s) => n + s.index.length, 0);
    const position = new Float32Array(vertices * 3);
    const normal = new Float32Array(vertices * 3);
    const local = new Float32Array(vertices * 4);
    const footing = new Float32Array(vertices * 4);
    const look = new Float32Array(vertices * 4);
    const index = new Uint32Array(indices);
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    let at = 0;
    let ati = 0;
    crumbs.forEach((c, n) => {
      const s = shapes[n];
      c.height = s.height;
      e.set((random() - 0.5) * 0.25, random() * Math.PI * 2, (random() - 0.5) * 0.25);
      q.setFromEuler(e);
      const count = s.positions.length / 3;
      for (let k = 0; k < count; k++) {
        v.set(s.positions[k * 3], s.positions[k * 3 + 1], s.positions[k * 3 + 2]);
        // In millimetres in its own frame, for its texture to stay put on it.
        local[(at + k) * 4] = v.x / MM;
        local[(at + k) * 4 + 1] = v.y / MM;
        local[(at + k) * 4 + 2] = v.z / MM;
        local[(at + k) * 4 + 3] = s.crust[k];
        v.applyQuaternion(q);
        position[(at + k) * 3] = c.x + v.x;
        position[(at + k) * 3 + 1] = c.y + v.y;
        position[(at + k) * 3 + 2] = c.z + v.z;
        v.set(s.normals[k * 3], s.normals[k * 3 + 1], s.normals[k * 3 + 2]).applyQuaternion(q);
        normal[(at + k) * 3] = v.x;
        normal[(at + k) * 3 + 1] = v.y;
        normal[(at + k) * 3 + 2] = v.z;
        footing[(at + k) * 4] = c.x;
        footing[(at + k) * 4 + 1] = c.y;
        footing[(at + k) * 4 + 2] = c.z;
        footing[(at + k) * 4 + 3] = n;
        look[(at + k) * 4] = c.seed;
        look[(at + k) * 4 + 1] = c.kind;
        look[(at + k) * 4 + 2] = s.open[k];
        look[(at + k) * 4 + 3] = Math.max(0, Math.min(1, (s.positions[k * 3 + 1] + s.height * 0.1) / s.height));
      }
      for (const i of s.index) index[ati++] = i + at;
      at += count;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute("aLocal", new THREE.BufferAttribute(local, 4));
    geometry.setAttribute("aFoot", new THREE.BufferAttribute(footing, 4));
    geometry.setAttribute("aLook", new THREE.BufferAttribute(look, 4));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.computeBoundingSphere();

    // Each crumb's state, a texel each: how burnt (0 to 1), how far the lava has floated it up, how strongly flames
    // wrap it.
    const W = crumbs.length;
    const stateData = new Float32Array(W * 4);
    const state = new THREE.DataTexture(stateData, W, 1, THREE.RGBAFormat, THREE.FloatType);
    state.minFilter = state.magFilter = THREE.NearestFilter;
    state.generateMipmaps = false;
    state.needsUpdate = true;

    const material = new THREE.MeshStandardNodeMaterial();
    const foot = attribute("aFoot", "vec4") as any;
    const at3 = attribute("aLocal", "vec4") as any;
    const info = attribute("aLook", "vec4") as any;
    const read = texture(state, vec2(foot.w.add(0.5).div(W), 0.5)).level(float(0)) as any;
    const st = varying(read, "vCrumbState") as any;
    const burn = st.x;
    const wrapped = st.z;
    // Burning, it shrinks toward its foot; on lava, it rides up on it.
    const shrink = float(1).sub(smoothstep(0.3, 1, read.x).mul(0.35)) as any;
    material.positionNode = foot.xyz.add(positionGeometry.sub(foot.xyz).mul(shrink)).add(vec3(0, read.y, 0)) as any;

    const m = at3.xyz as any;
    const crustAmount = at3.w as any;
    const seed = info.x as any;
    const open = info.z as any;
    const up = info.w as any;
    // The baked outside, as the pocket's crust: golden tan, toasted freckles, dark herb and pepper flecks.
    const tone = smoothstep(-0.3, 0.6, mx_noise_float(m.mul(0.9).add(seed.mul(20)))) as any;
    let crustColour: any = mix(vec3(0.88, 0.64, 0.36), vec3(0.76, 0.48, 0.22), tone);
    const freckle = smoothstep(0.32, 0.06, mx_worley_noise_float(m.mul(1.3).add(seed.mul(9)))) as any;
    crustColour = mix(crustColour, vec3(0.6, 0.33, 0.12), freckle.mul(0.75));
    const fleckCell = mx_cell_noise_float(m.mul(2.2).add(seed.mul(31)).floor()) as any;
    const fleck = smoothstep(0.35, 0.1, mx_worley_noise_float(m.mul(2.2).add(seed.mul(31)))).mul(step(0.78, fleckCell)) as any;
    crustColour = mix(crustColour, mix(vec3(0.1, 0.06, 0.035), vec3(0.17, 0.19, 0.07), step(0.95, fleckCell)), fleck.mul(0.9));
    // The broken inside: pale, soft bread, open with small pores.
    const pores = mx_worley_noise_float(m.mul(2.6).add(seed.mul(17))) as any;
    const pore = smoothstep(0.3, 0.06, pores).mul(step(0.35, mx_cell_noise_float(m.mul(2.6).add(seed.mul(17)).floor()))) as any;
    let bread: any = mix(vec3(0.94, 0.82, 0.6), vec3(0.85, 0.68, 0.43), smoothstep(-0.4, 0.7, mx_noise_float(m.mul(1.1).add(seed.mul(7)))));
    bread = bread.mul(float(1).sub(pore.mul(0.38)));
    // Where the two meet, a little toasting of the inside.
    const edge = smoothstep(0.05, 0.4, crustAmount).mul(float(1).sub(smoothstep(0.55, 0.9, crustAmount))) as any;
    let colour: any = mix(bread, crustColour, smoothstep(0.25, 0.7, crustAmount));
    colour = mix(colour, vec3(0.74, 0.5, 0.26), edge.mul(0.35));
    colour = colour.mul(open);

    // Burning: a glowing line creeps up over it from the foot, browning then charring black behind; embers glow in
    // its cracks while it is a coal; then it falls to grey ash in patches.
    const front = burn.mul(3.4).sub(up.mul(0.9)).add(mx_noise_float(m.mul(0.8).add(seed.mul(13))).mul(0.45)) as any;
    const lit = step(0.001, burn) as any;
    colour = mix(colour, vec3(0.32, 0.15, 0.05), smoothstep(-0.05, 0.25, front).mul(lit));
    const char = smoothstep(0.2, 0.6, front).mul(lit) as any;
    colour = mix(colour, vec3(0.03, 0.024, 0.02), char);
    const line = exp(
      front
        .sub(0.12)
        .div(0.1)
        .pow(2)
        .negate()
    )
      .mul(lit)
      .mul(float(1).sub(smoothstep(0.55, 0.8, burn))) as any;
    // Cracks as cell edges, warped and only some of them glowing, so they never tile into a honeycomb; and the patchy
    // ash. Worked out only for crumbs that are burning (the branch is the same across a crumb), so the many unlit ones
    // pay nothing for them.
    const coal = smoothstep(0.12, 0.35, burn).mul(float(1).sub(smoothstep(0.72, 0.95, burn))) as any;
    const embers = Fn(() => {
      const out = vec3(0, 0, 0).toVar();
      If(burn.greaterThan(0.1), () => {
        const warp = vec3(mx_noise_float(m.mul(0.6).add(seed.mul(4))), mx_noise_float(m.mul(0.6).add(seed.mul(4).add(11))), 0).mul(0.9) as any;
        const cracks = mx_worley_noise_vec2(m.mul(0.75).add(warp).add(seed.mul(5))) as any;
        const crack = smoothstep(0.12, 0.0, cracks.y.sub(cracks.x)).mul(smoothstep(-0.05, 0.35, mx_noise_float(m.mul(0.45).add(seed.mul(23))))) as any;
        const breathing = mx_noise_float(m.mul(0.5).add(vec3(0, time.mul(1.3), seed.mul(9))))
          .mul(0.35)
          .add(0.75) as any;
        const ash = smoothstep(0.8, 1, burn).mul(smoothstep(-0.2, 0.25, mx_noise_float(m.mul(0.7).add(seed.mul(3))))) as any;
        out.assign(vec3(crack, breathing, ash));
      });
      return out;
    })() as any;
    const crack = embers.x;
    const breathing = embers.y;
    const ash = embers.z;
    colour = mix(colour, vec3(0.5, 0.48, 0.45).mul(mx_noise_float(m.mul(2.5)).mul(0.2).add(0.9)), ash);
    material.colorNode = colour;
    // The ember line, cracks and dull glow of the coal, and the flame's own light on the crumb it wraps.
    material.emissiveNode = clamp(
      vec3(1.0, 0.42, 0.1)
        .mul(line.mul(2.2))
        .add(vec3(1.0, 0.38, 0.08).mul(crack.mul(coal).mul(breathing).mul(2.1).mul(char)))
        .add(vec3(0.5, 0.1, 0.015).mul(coal.mul(char).mul(breathing).mul(0.35)))
        .add(colour.mul(vec3(1.0, 0.72, 0.4)).mul(wrapped.mul(0.45))),
      0,
      3
    ) as any;
    material.roughnessNode = mix(mix(float(0.86), float(0.6), smoothstep(0.3, 0.8, crustAmount)), float(0.95), char.max(ash)) as any;
    const mesh = new THREE.Mesh(geometry, material);
    // Too small for the sun's shadow map to resolve (a texel is about 2 mm): they are seated by their own darker
    // undersides and the occlusion pass instead, and spared the shadow pass.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // Its vertices move in the shader; never culled by the place they were built at.
    mesh.frustumCulled = false;
    return { crumbs, geometry, material, mesh, state, stateData, random };
  }, [fine]);
  useDispose(parts.geometry, parts.material, parts.state);

  const status = useMemo(() => ({ ignitions: 0, check: 0, nextCrackle: 0, nextCatch: 0 }), []);
  useEffect(() => {
    const reset = () => {
      for (const c of parts.crumbs) {
        c.burn = 0;
        c.lit = -1;
        c.flame = -1;
        c.lift = 0;
      }
      parts.stateData.fill(0);
      parts.state.needsUpdate = true;
      fire.reset();
      status.ignitions = 0;
    };
    plateCrumbs.reset = reset;
    if (process.env.NODE_ENV !== "production")
      Object.assign(globalThis, {
        __crumbs: parts,
        __crumbState: status,
        // For testing: sets the crumbs within r of a point alight, lava or not.
        __crumbIgnite: (x: number, z: number, r: number) => {
          const now = clock.now;
          for (const c of parts.crumbs) if (c.lit < 0 && Math.hypot(c.x - x, c.z - z) < r) c.lit = now + Math.random() * 0.3;
        }
      });
  }, [parts, status, fire]);

  useFrame((_, raw) => {
    const dt = (Number.isFinite(raw) ? Math.min(raw, 0.1) : 0) * clock.speed;
    if (dt <= 0) return;
    const now = clock.now;
    const { crumbs, stateData, random } = parts;
    const slots = fire.slots;
    let changed = false;
    // Which crumbs the lava has reached: a crumb catches a beat after hot lava touches it, so ignitions spread with the
    // flow rather than all at once. Every crumb also rides up on lava run in under it.
    if (lava.bites.length || lava.pours.length || lava.glow.amount > 0.01) {
      for (let k = 0; k < crumbs.length; k++) {
        const c = crumbs[k];
        if (c.y === COUNTER) continue;
        const at = lava.sample(c.x, c.z);
        if (c.lit < 0 && at.depth > 0.0012 && at.heat > 0.35) c.lit = now + 0.1 + random() * 0.5;
        // Floating: its foot a little under the surface, as light, porous pastry rides on molten rock.
        const lift = at.depth > 0.0006 ? Math.max(0, at.surface - c.height * 0.3 - c.y) : 0;
        if (Math.abs(lift - c.lift) > 1e-5) {
          c.lift += (lift - c.lift) * Math.min(1, dt * 5);
          stateData[k * 4 + 1] = c.lift;
          changed = true;
        }
      }
    }
    let burning = 0;
    for (let k = 0; k < crumbs.length; k++) {
      const c = crumbs[k];
      if (c.lit < 0 || now < c.lit || c.burn >= 1) continue;
      if (c.burn === 0) {
        status.ignitions++;
        if (c.kind !== DUST) {
          onIgnite();
          if (now > status.nextCatch) {
            catchFire(c.kind === CRUMB ? 0.45 : 0.75);
            status.nextCatch = now + 0.12;
          }
          // A flame from the pool, if one is free; dust only glows and chars.
          // Not when a flame already burns right beside it: that one grows with the company instead, which looks the
          // same and saves drawing two flames over each other.
          const crowded = c.group.some((n) => crumbs[n].flame >= 0 && Math.hypot(crumbs[n].x - c.x, crumbs[n].z - c.z) < 0.012);
          const free = crowded ? -1 : slots.findIndex((s) => !s.on);
          if (free >= 0) {
            slots[free].on = true;
            slots[free].seed = random() * 10;
            c.flame = free;
          }
          fire.spark(c.x, c.y + c.lift + c.height, c.z, 2 + Math.floor(random() * 4), 1.2);
        }
      }
      c.burn = Math.min(1, c.burn + dt / BURN[c.kind]);
      // A thin thread of smoke off a smouldering coal.
      if (c.kind !== DUST && c.burn > 0.45 && c.burn < 0.9 && random() < dt * 0.5) fire.smoke(c.x, c.y + c.lift + c.height, c.z, 0.005, 0);
      stateData[k * 4] = c.burn;
      changed = true;
      if (c.flame >= 0) burning++;
      // A burning crumb sets its neighbours alight, a cluster going up as one front.
      if (c.flame >= 0 && c.burn > 0.06 && c.burn < 0.4)
        for (const b of c.near) {
          const o = crumbs[b];
          if (o.lit < 0 && random() < dt * 0.9) o.lit = now + 0.2 + random() * 0.6;
        }
      if (c.flame >= 0 && c.burn > 0.7) {
        slots[c.flame].on = false;
        stateData[k * 4 + 2] = 0;
        c.flame = -1;
      }
    }

    // The flames: on their crumbs, leaping up as they catch, strongest early, dying as the crumb becomes a coal; taller
    // and wider where several burn together.
    for (let k = 0; k < crumbs.length; k++) {
      const c = crumbs[k];
      if (c.flame < 0) continue;
      const s = slots[c.flame];
      const b = c.burn;
      const strength = smooth(0, 0.05, b) * (1 - smooth(0.32, 0.68, b));
      let company = 0;
      for (const n of c.group) {
        // Every crumb burning round it feeds its flame, with a flame of its own or not.
        const o = crumbs[n];
        if (o.burn > 0 && o.burn < 0.68) company += (o.size / MM) * smooth(0, 0.05, o.burn) * (1 - smooth(0.32, 0.68, o.burn));
      }
      const grow = Math.min(2, 1 + 0.32 * Math.sqrt(company));
      const reach = (c.kind === CRUMB ? 9 : c.kind === FLAKE ? 13 : 18) * MM;
      s.x = c.x;
      // From the crumb's foot: drawn in the scene pass, a flame sunk below the plate or lava would be cut off in a line.
      s.y = c.y + c.lift;
      s.z = c.z;
      s.height = (reach * (0.45 + 0.55 * smooth(0, 0.12, b)) + c.size * 2) * grow;
      s.width = Math.max(c.size * 3.5, s.height * 0.6);
      // Drawn in the scene pass, a sheet reaching into the pocket would be cut off along a hard line: narrower beside it.
      s.width = Math.min(s.width, Math.max(0.008, c.room * 1.4));
      s.strength = strength;
      stateData[k * 4 + 2] = strength;
      // Smoke off the tips; sparks now and then.
      if (random() < dt * 3 * strength) fire.smoke(c.x, s.y + s.height * 0.75, c.z, 0.008 + s.width * 0.25, strength);
      if (random() < dt * 1.6 * strength) fire.spark(c.x, s.y + s.height * 0.4, c.z, 1);
    }
    if (changed) parts.state.needsUpdate = true;
    // The crackle of the fire, quicker the more burns.
    if (burning && now > status.nextCrackle) {
      crackle(Math.min(1, 0.35 + burning * 0.06));
      status.nextCrackle = now + (0.05 + random() * 0.3) / Math.min(4, 0.6 + burning * 0.25);
    }
    fire.update(dt, now);
  });

  return (
    <>
      <primitive object={mirrored(parts.mesh)} />
      <primitive object={fire.group} />
    </>
  );
}

// Set by the component: puts every crumb back as it was, for a new pocket.
export const plateCrumbs = { reset: () => {} };
