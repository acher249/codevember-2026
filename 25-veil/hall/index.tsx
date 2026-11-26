"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  bumpMap,
  cameraPosition,
  cross,
  dot,
  exp,
  float,
  fract,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionWorld,
  sin,
  smoothstep,
  step,
  time,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { Haze } from "../../shared/engine/studio";
import { PhotoLight, Shaft, useAir, Watchers, World, world, type Seat } from "../worlds/common";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Veil in the hall: a long, high corridor of sandstone laid in great blocks, piers between its bays, dark doorways in
// them, bands of carved script running along its courses and a coffered roof; a worn red runner down the middle of its
// floor and sand drifted along its benches. At its far end the day blazes through a wide opening, and over the figures
// seated down the aisle the roof is cut through: a shaft of sun comes down through the dust onto them, and the dust
// turns in it.

// The sun through the cut in the roof, high and a little to the left; the cloth glows where it comes through.
const SUN: [number, number, number] = [-3, 30, 2];
const AIM: [number, number, number] = [0, 0.6, -1.5];
const KEY = new THREE.Vector3(...SUN).normalize();
const SEATS: Seat[] = [
  [0, 0, 0, true],
  [-2.6, -3.4, 0.25],
  [2.5, -4.2, -0.2],
  [-1.4, -9, 0.1],
  [2.7, -11.5, -0.25],
  [-3, -15, 0.3]
];
const W = 12;
const H = 16;
const BAY = 6;
const LENGTH = 66;

// A number from 0 to 1 that stays the same across a cell and jumps between cells.
const hash = (v: any) => fract(sin(dot(v, vec2(12.9898, 78.233))).mul(43758.5453)) as any;

// Dressed stone in courses: blocks of slightly different height and tone, recessed joints, a chiselled face, dark grime
// run down it in streaks; on every fifth course a band of carved script, cell after cell of short cut strokes.
// `plan` lays it on the ground (courses along x and z) instead of up a wall.
function carved(base: [number, number, number], { course = 1.3, block = 3.4, script = true, plan = false, grime = 0.08 } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  const p = positionWorld as any;
  const u = (plan ? p.x : p.z.add(p.x)) as any;
  const v = (plan ? p.z : p.y) as any;
  const row = v.div(course) as any;
  const ri = row.floor() as any;
  const rf = row.fract() as any;
  const along = u.div(block).add(ri.mul(0.5)) as any;
  const ai = along.floor() as any;
  const af = along.fract() as any;
  // How far to the nearest joint, in metres.
  const edge = min(min(rf, float(1).sub(rf)).mul(course), min(af, float(1).sub(af)).mul(block)) as any;
  const face = smoothstep(0.0, 0.025, edge) as any;
  const bevel = smoothstep(0.02, 0.08, edge) as any;
  const id = hash(vec2(ri, ai)) as any;
  const chisel = mx_noise_float(p.mul(2.5)).mul(0.5).add(mx_noise_float(p.mul(14)).mul(0.18)).add(mx_noise_float(p.mul(60)).mul(0.05)) as any;
  let height = face.mul(bevel.mul(0.25).add(0.55).add(id.mul(0.12))).add(chisel.mul(0.12)) as any;
  let tone = vec3(...base).mul(id.mul(0.18).add(0.88)).mul(face.mul(0.45).add(0.55)) as any;
  if (script) {
    // The band: every fifth course, inset from the joints.
    const band = step(abs(fract(ri.div(5)).sub(0.6)), 0.05).mul(smoothstep(0.12, 0.2, rf.mul(course))).mul(smoothstep(0.12, 0.2, float(1).sub(rf).mul(course))) as any;
    const gx = u.div(0.3) as any;
    const gy = rf.mul(course).div(0.36) as any;
    const cell = vec2(gx.floor(), gy.floor().add(ri.mul(7))) as any;
    const fx = gx.fract() as any;
    const fy = gy.fract() as any;
    const h1 = hash(cell) as any;
    const h2 = hash(cell.add(3.1)) as any;
    const h3 = hash(cell.add(7.7)) as any;
    const across = step(abs(fy.sub(h1.mul(0.6).add(0.2))), 0.07).mul(step(0.18, fx)).mul(step(fx, 0.82)) as any;
    const down = step(abs(fx.sub(h2.mul(0.6).add(0.2))), 0.06).mul(step(0.15, fy)).mul(step(fy, 0.85)).mul(step(0.35, h3)) as any;
    const dot_ = step(vec2(fx.sub(0.5), fy.sub(h3)).length(), 0.09).mul(step(h1, 0.3)) as any;
    const glyph = min(across.add(down).add(dot_), 1).mul(band) as any;
    height = height.sub(glyph.mul(0.3));
    tone = tone.mul(float(1).sub(glyph.mul(0.3)));
  }
  // Grime run down from the joints, in long streaks.
  const streak = mx_noise_float(vec3(u.mul(2.2), v.mul(0.12), 0)).mul(0.5).add(0.5) as any;
  tone = tone.mul(float(1).sub(streak.mul(grime)));
  material.colorNode = tone;
  material.normalNode = bumpMap(height, float(1.4)) as any;
  return material;
}

// The runner: a long rug of dull red wool down the aisle, a border of ochre and dark stripes, a squared key pattern
// repeating down its middle, worn pale in places and dusted with sand.
function runner() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  const t = uv() as any;
  const x = t.x as any;
  const z = t.y.mul(LENGTH / 3.6) as any;
  const red = vec3(0.17, 0.06, 0.045) as any;
  const ochre = vec3(0.36, 0.27, 0.18) as any;
  const dark = vec3(0.07, 0.035, 0.028) as any;
  const line = (at: number, w: number) => step(abs(x.sub(at)), w).add(step(abs(x.sub(1 - at)), w)) as any;
  const border = min(line(0.04, 0.012).add(line(0.09, 0.006)), 1) as any;
  const borderDark = min(line(0.065, 0.01), 1) as any;
  // The key: nested squares in a repeating cell, with a bar joining one cell to the next.
  const cx = x.sub(0.5).mul(3.6).div(2.2).add(0.5) as any;
  const cz = z.fract() as any;
  const inMid = step(abs(x.sub(0.5)), 0.3) as any;
  const square = max(abs(cx.sub(0.5)), abs(cz.sub(0.5))) as any;
  const ring = (r: number, w: number) => step(abs(square.sub(r)), w) as any;
  const key = min(ring(0.38, 0.03).add(ring(0.2, 0.025)).add(step(square, 0.07)), 1).mul(inMid) as any;
  const bar = step(abs(cx.sub(0.5)), 0.03).mul(step(0.38, abs(cz.sub(0.5)))).mul(inMid) as any;
  let c = mix(red, ochre, min(border.add(key).add(bar), 1)) as any;
  c = mix(c, dark, borderDark);
  const fibre = mx_noise_float(vec3(t.x.mul(900), t.y.mul(9000), 0)).mul(0.05) as any;
  const wear = smoothstep(0.35, 0.8, mx_noise_float(vec3(t.x.mul(4), t.y.mul(30), 0)).mul(0.5).add(0.5)) as any;
  const sand = smoothstep(0.55, 0.85, mx_noise_float(vec3(t.x.mul(9), t.y.mul(90), 2)).mul(0.5).add(0.5)) as any;
  c = mix(c.add(fibre), vec3(0.42, 0.35, 0.27), wear.mul(0.3).add(sand.mul(0.45)));
  material.colorNode = c;
  return material;
}

// Sand drifted along the foot of the benches: a long low mound, rippled.
function drift(length: number, width: number) {
  const g = new THREE.PlaneGeometry(width, length, 24, 240);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k) / (width / 2);
    const z = pos.getZ(k);
    const swell = 0.6 + 0.4 * Math.sin(z * 0.7) * Math.sin(z * 0.23 + 1);
    pos.setY(k, Math.max(0, 1 - x * x) ** 1.5 * 0.28 * swell - 0.02);
  }
  g.computeVertexNormals();
  return g;
}

function Hall() {
  const parts = useMemo(() => {
    const wall = carved([0.62, 0.5, 0.38]);
    const plain = carved([0.58, 0.47, 0.36], { script: false, course: 0.65, block: 1.9 });
    const floor = carved([0.5, 0.43, 0.35], { plan: true, course: 2.2, block: 2.2, script: false, grime: 0.04 });
    const rug = runner();
    const sand = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
    sand.colorNode = vec3(0.68, 0.57, 0.44).mul(mx_noise_float(positionWorld.mul(vec3(6, 6, 1.2))).mul(0.06).add(1));
    const dark = new THREE.MeshBasicNodeMaterial();
    dark.colorNode = vec3(0.012, 0.01, 0.008);
    const day = new THREE.MeshBasicNodeMaterial({ fog: false });
    day.colorNode = vec3(2.4, 2.3, 2.15);
    const slit = new THREE.MeshBasicNodeMaterial({ fog: false });
    slit.colorNode = vec3(1.6, 1.5, 1.35);
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, cast = true) => {
      geometries.push(g);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    const mid = -LENGTH / 2 + 8;
    add(new THREE.BoxGeometry(W + 4, 0.4, LENGTH + 8), floor, 0, -0.2, mid, false);
    const rugMesh = add(new THREE.PlaneGeometry(3.6, LENGTH), rug, 0, 0.006, mid, false);
    rugMesh.rotation.x = -Math.PI / 2;
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(2, H, LENGTH + 8), wall, s * (W / 2 + 1), H / 2, mid);
      // Benches along the wall, a ledge high up, and sand drifted at the foot of the benches.
      add(new THREE.BoxGeometry(1.3, 0.85, LENGTH - 6), plain, s * (W / 2 - 0.65), 0.425, mid - 2);
      add(new THREE.BoxGeometry(0.9, 0.55, LENGTH + 8), plain, s * (W / 2 - 0.45), H * 0.64, mid);
      add(drift(LENGTH - 8, 1.6), sand, s * (W / 2 - 1.9), 0, mid - 2, false);
      for (let k = 0; k * BAY < LENGTH; k++) {
        const z = 4 - k * BAY;
        // A pier between bays, standing proud of the wall.
        add(new THREE.BoxGeometry(1.0, H, 1.5), plain, s * (W / 2 - 0.5), H / 2, z);
        // In every other bay a doorway: dark, with a heavy lintel over it.
        if (k % 2) {
          const door = add(new THREE.PlaneGeometry(1.8, 3.4), dark, s * (W / 2 - 0.02), 1.7 + 0.85, z - BAY / 2, false);
          door.rotation.y = (-s * Math.PI) / 2;
          add(new THREE.BoxGeometry(0.5, 0.6, 2.8), plain, s * (W / 2 - 0.25), 4.55, z - BAY / 2);
        }
        // A slit of daylight high in each bay.
        const light = add(new THREE.PlaneGeometry(2.4, 0.22), slit, s * (W / 2 - 0.02), H - 2.6, z - BAY / 2, false);
        light.rotation.y = (-s * Math.PI) / 2;
      }
    }
    // The roof, coffered: beams across and along it, cut open over the figures.
    for (const [z0, z1] of [
      [4, 16],
      [-60, -4]
    ]) {
      const len = z1 - z0;
      add(new THREE.BoxGeometry(W + 4, 1.5, len), wall, 0, H + 0.75, (z0 + z1) / 2);
      for (let z = z0 + 1; z < z1; z += 3) add(new THREE.BoxGeometry(W, 1.1, 0.7), plain, 0, H - 0.55, z);
      for (const x of [-W / 4, 0, W / 4]) add(new THREE.BoxGeometry(0.7, 1.1, len), plain, x, H - 0.55, (z0 + z1) / 2);
    }
    // The far end: a wall with the day blazing through a wide opening, two piers standing in it.
    const end = -LENGTH + 2;
    add(new THREE.BoxGeometry(W + 4, H - 6, 2), wall, 0, 6 + (H - 6) / 2, end);
    for (const x of [-2.2, 2.2]) add(new THREE.BoxGeometry(0.9, 6, 0.9), plain, x, 3, end);
    add(new THREE.PlaneGeometry(W, 6), day, 0, 3, end - 2, false);
    return { mats: [wall, plain, floor, rug, sand, dark, day, slit], geometries, group };
  }, []);
  useDispose(...parts.mats, ...parts.geometries);
  return <primitive object={parts.group} />;
}

// Dust turning in the shaft: specks drifting slowly, bright inside the beam and all but gone outside it.
function Motes({ count = 2200 }) {
  const parts = useMemo(() => {
    const seeds = new Float32Array(count * 4);
    let s = 9137;
    const random = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < count * 4; i++) seeds[i] = random();
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const seed = attribute("aSeed", "vec4") as any;
    const box = vec3(7, 9, 9) as any;
    const drift = vec3(sin(time.mul(0.07).add(seed.x.mul(30))).mul(0.25), time.mul(-0.02), sin(time.mul(0.05).add(seed.z.mul(20))).mul(0.25)) as any;
    const centre = fract(seed.xyz.add(drift.div(box))).sub(0.5).mul(box).add(vec3(-0.5, 4.5, -0.5)) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    const size = seed.w.mul(0.006).add(0.004) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(size))).add(upward.mul(positionGeometry.y.mul(size))) as any;
    // How near the beam's axis: the line from the sun to where it lands.
    const a = vec3(...SUN) as any;
    const d = normalize(vec3(AIM[0] - SUN[0], AIM[1] - SUN[1], AIM[2] - SUN[2])) as any;
    const rel = centre.sub(a) as any;
    const off = rel.sub(d.mul(dot(rel, d))).length() as any;
    const inBeam = exp(off.mul(off).div(-2.2)) as any;
    const twinkle = sin(time.mul(seed.y.mul(1.5).add(0.4)).add(seed.z.mul(50))).mul(0.35).add(0.65) as any;
    const r = uv().sub(0.5).length() as any;
    const shape = float(1).sub(smoothstep(0.1, 0.5, r)) as any;
    material.colorNode = vec4(vec3(1, 0.93, 0.82).mul(inBeam.mul(1.6).add(0.03)).mul(twinkle).mul(shape), 1) as any;
    const mesh = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    return { quad, material, mesh };
  }, [count]);
  useDispose(parts.quad, parts.material);
  return <primitive object={parts.mesh} />;
}

function Scene() {
  useAir("#4c4237", 14, 95);
  return (
    <World>
      {(data) => (
        <>
          <PhotoLight keyDir={KEY} intensity={0.8} hemi={["#e6d8c4", "#3b2f24", 0.55]} ambient="#5c5044" shadow={4} />
          {/* The sun down through the roof onto them, and the day from the far end behind them, both lighting the dust. */}
          <Shaft from={SUN} to={AIM} intensity={5200} angle={0.13} />
          <Shaft from={[0, 4, -LENGTH - 6]} to={[0, 1, 0]} intensity={9000} angle={0.16} color="#fff6ea" />
          <Haze size={[W, H, LENGTH + 4]} position={[0, H / 2, -LENGTH / 2 + 4]} density={1.3} />
          <Hall />
          <Motes />
          <Watchers data={data} seats={SEATS} keyDir={KEY} />
        </>
      )}
    </World>
  );
}

export default world(
  Scene,
  { background: "#4c4237", bloom: 0.22, bloomThreshold: 0.85, vignette: 0.32, haze: 0.9 },
  "Veiled figures seated down a long carved sandstone hall, a shaft of sun falling on them through a cut in the roof and the day blazing at its far end.",
  {
    position: [0.45, 1.3, 2.3],
    target: [0, 1.0, 0],
    fov: 34,
    phone: { position: [0.4, 1.35, 3.2], target: [0, 1.0, 0], fov: 44 },
    limits: { turn: { left: 80, right: 80, up: 35, down: 15 }, move: { left: 2, right: 2, down: 0.4, up: 2, nearer: 1, further: 9 } }
  }
);
