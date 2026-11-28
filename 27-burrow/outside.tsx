"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, clamp, cross as crossNode, dot, float, hash, instanceIndex, mix, normalize, positionGeometry, positionLocal, positionView, positionWorld, pow, sin, smoothstep, texture, transformNormalToView, uv, vec2, vec3, vec4 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { Birds, SkyDome, type SkyPalette } from "../shared/engine/outdoors";
import { OVERLAY_LAYER } from "../shared/engine/Post";
import { overlayMaterial, useOverlay } from "./fx";
import { statSources } from "./stats";
import { devParts, outdoorLights, SHADOW_ONLY_LAYER, woodShown } from "./forest/lights";
import { CLEARING } from "./forest/terrain";
import { lehmer, mulberry32 } from "../shared/engine/random";
import { scenePhase, useQuality } from "../shared/engine/quality";
import { buildCanopy, buildTrunks, CANOPY_EYE, canopyTime, isConifer, leafCluster, leafMaterial, type Crown } from "./forest/trees";
import type { TreeSpot } from "./forest/layout";
import { BACKDROP_BACK, chunkKey, chunkOf, cliffDepth, faceZ, groundY, noise3, backdropGrid, skyline, topY, type Rock } from "./field";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Everything outside the diggable rock: the rest of the cliff, the ground before it, the desert and mesas behind the
// viewer, the midday sky, and the light.

// The sun: high at midday (about 46 degrees up), a little to the right and in front of the face, so the whole face is
// in full light and turned well toward it, every ledge throws a short crisp shadow under it, and a tunnel's mouth is a
// bright disc looking back out.
export const SUN_DIRECTION = new THREE.Vector3(0.3, 0.74, 0.6).normalize();

// The light, as a clear midday has it: a sun a touch warm (about 5,200 K), a sky fill cool and blue, nearer a third of
// the sun on a level floor than a fifth, so the shade under the trees reads airy and open, never gloomy. (The shadow
// itself stays full: a lighter one would let the sun through the rock into the tunnels.)
const SUN_COLOUR = "#fff0dc";
const SUN = 4.8;
const SKY_FILL = 1.5;
const SKY_COLOUR = "#afcbef";
// The sky's lower half: light thrown back up off the warm litter, the sunlit grass and the sandstone.
const BOUNCE_COLOUR = "#968257";
// Where the sun's shadow map is centred while the eye is out in the clearing: a little toward the face, so the cliff and
// the wood either side are in it as well as the clearing.
const OPEN_SHADOW = { x: CLEARING.x, y: 0, z: CLEARING.z - 3 };

// Asks for the sun's shadow to be drawn again, after a dig has changed the rock.
export const shadow = { redraw: () => {} };

export const PALETTE: SkyPalette = {
  zenith: "#2a64c8",
  // Pale and a little grey, as a clear midday's horizon is: the air's haze outside (index.tsx `airTint`, linear
  // 0.5, 0.62, 0.78) is the same hue at about nine tenths of it, so far trees fade toward the sky behind them.
  horizon: "#c3d6ec",
  sun: "#fffaf0",
  cloudLit: "#ffffff",
  cloudShade: "#a3b0c4",
  sunDirection: [SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z],
  cloudCover: 0.3,
  cloudDrift: 0.004
};

// The cliff beyond the diggable part, as a plain grid that hides itself wherever a chunk of the real rock is drawn
// (rock.ts `cut`): the rays are cast in field.ts (`backdropGrid`).
export function buildBackdrop() {
  const { position, columns: W, rows } = backdropGrid();
  const info = new Float32Array((position.length / 3) * 3).map((_, i) => (i % 3 === 1 ? 1 : 0));
  const index: number[] = [];
  for (let j = 0; j < rows - 1; j++)
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i;
      index.push(a, a + 1, a + W, a + 1, a + W + 1, a + W);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("aInfo", new THREE.Float32BufferAttribute(info, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

// The ground beyond the meshed chunks: rings round the start, fine close by and coarse far off, out to the haze, set a
// little below the true ground (which the chunks draw near the eye).
export function buildGround() {
  const position: number[] = [];
  const radii: number[] = [0];
  let r = 0.2;
  while (r < 260) {
    radii.push(r);
    r *= 1.06;
    r += 0.02;
  }
  const around = 192;
  const cx = 0;
  const cz = 4;
  position.push(cx, groundY(cx, cz) - BACKDROP_BACK, cz);
  for (let k = 1; k < radii.length; k++)
    for (let s = 0; s < around; s++) {
      const a = (s / around) * Math.PI * 2;
      const x = cx + Math.cos(a) * radii[k];
      const z = cz + Math.sin(a) * radii[k];
      position.push(x, groundY(x, z) - BACKDROP_BACK, z);
    }
  const index: number[] = [];
  for (let s = 0; s < around; s++) index.push(0, 1 + ((s + 1) % around), 1 + s);
  for (let k = 1; k < radii.length - 1; k++)
    for (let s = 0; s < around; s++) {
      const a = 1 + (k - 1) * around + s;
      const b = 1 + (k - 1) * around + ((s + 1) % around);
      const c = a + around;
      const d = b + around;
      index.push(a, b, c, b, d, c);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  // Ground, open to the sky (field.ts `ChunkMesh` info).
  geometry.setAttribute(
    "aInfo",
    new THREE.Float32BufferAttribute(
      new Float32Array((position.length / 3) * 3).map((_, i) => (i % 3 === 0 ? 0 : 1)),
      3
    )
  );
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  // Facing up: flip the winding if it came out the other way.
  if ((geometry.getAttribute("normal") as THREE.BufferAttribute).getY(1) < 0) {
    const flipped: number[] = [];
    for (let t = 0; t < index.length; t += 3) flipped.push(index[t], index[t + 2], index[t + 1]);
    geometry.setIndex(flipped);
    geometry.computeVertexNormals();
  }
  return geometry;
}

// Mesas and buttes far out over the desert behind the viewer, flat-topped, in two rows fading into the evening haze.
function buildMesas() {
  const position: number[] = [];
  const colour: number[] = [];
  const index: number[] = [];
  const random = lehmer(2711);
  const rows = [
    { r: 62, tint: [0.36, 0.24, 0.24], height: 7 },
    { r: 78, tint: [0.36, 0.24, 0.24], height: 9 },
    { r: 94, tint: [0.62, 0.42, 0.38], height: 14 }
  ];
  for (const row of rows) {
    const steps = 260;
    const base = position.length / 3;
    // Tops: flat plateaus broken by gaps, with steep sides.
    const tops: number[] = [];
    let level = 0;
    let left = 0;
    for (let s = 0; s <= steps; s++) {
      if (left <= 0) {
        level = random() < 0.35 ? 0 : row.height * (0.3 + random() * 0.7);
        left = 4 + Math.floor(random() * 22);
      }
      left--;
      tops.push(level);
    }
    // Soften the steps a little so the sides read as steep slopes, not walls.
    const soft = tops.map((_, s) => (tops[Math.max(0, s - 1)] + tops[s] * 2 + tops[Math.min(steps, s + 1)]) / 4);
    for (let s = 0; s <= steps; s++) {
      // The half of the horizon in front of the cliff (toward +z), and a little round the sides.
      const a = -0.15 + (s / steps) * (Math.PI + 0.3);
      const x = Math.cos(a) * row.r;
      const z = 4 + Math.sin(a) * row.r;
      const h = soft[s] + 1.5 + noise3(s * 0.3, row.r, 1) * 1.2;
      position.push(x, -2, z, x, h, z);
      colour.push(...row.tint, ...row.tint);
      if (s < steps) {
        const a0 = base + s * 2;
        index.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colour, 3));
  geometry.setIndex(index);
  return geometry;
}

// Shafts of low sun in the dusty air before the cliff: long soft strips laid along the light, each turned about its own
// length to face the eye, brightest down the middle and gone at the edges, fading where the eye looks along them (or
// their sides show as hard bands), hidden behind the rock by the scene's depth.
// Where the eye last went in through the face: one shaft is kept falling into that tunnel's mouth.
export const mouth = { at: null as THREE.Vector3 | null, moved: false };

function SunShafts() {
  const built = useMemo(() => {
    const random = lehmer(515);
    const COUNT = 22;
    const data = new Float32Array(COUNT * 4);
    for (let k = 0; k < COUNT; k++) {
      // Where each strip comes down (through gaps in the canopy, over the clearing and the face), and how wide it is.
      const x = -14 + random() * 26;
      const y = 0.3 + random() * 8;
      data.set([x, y, Math.max(faceZ(x, y) + 0.4, 1 + random() * 22), 0.4 + random() * 1.6], k * 4);
    }
    const quad = new THREE.PlaneGeometry(1, 1, 1, 1);
    quad.translate(0, 0.5, 0);
    quad.setAttribute("aShaft", new THREE.InstancedBufferAttribute(data, 4));
    const material = overlayMaterial();
    material.side = THREE.DoubleSide;
    const mesh = new THREE.InstancedMesh(quad, material, COUNT);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    const attribute = quad.getAttribute("aShaft") as THREE.InstancedBufferAttribute;
    return { quad, material, mesh, data, attribute };
  }, []);
  useDispose(built.quad, built.material);
  useFrame(() => {
    if (!mouth.moved || !mouth.at) return;
    mouth.moved = false;
    // Starting a metre and a half inside, so it lights the first stretch of tunnel too.
    const p = mouth.at.clone().addScaledVector(SUN_DIRECTION, -1.5);
    built.data.set([p.x, p.y + 0.2, p.z, 1.1], 0);
    built.attribute.needsUpdate = true;
  });
  useOverlay(built.material, (sceneZ) => {
    const s = attribute("aShaft", "vec4") as any;
    const axis = vec3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z) as any;
    const length = float(26) as any;
    const toEye = normalize(cameraPosition.sub(s.xyz)) as any;
    const side = normalize(crossNode(axis, toEye).add(vec3(0, 1e-4, 0))) as any;
    const g = positionGeometry as any;
    built.material.positionNode = s.xyz.add(axis.mul(g.y.mul(length))).add(side.mul(g.x.mul(s.w))) as any;
    const across = abs(g.x.mul(2)) as any;
    const bell = pow(float(1).sub(across.mul(across)).max(0), float(2)) as any;
    const along = g.y as any;
    const ends = smoothstep(0, 0.12, along).mul(float(1).sub(smoothstep(0.55, 1, along))) as any;
    const edgeOn = float(1).sub(pow(abs(dot(normalize(cameraPosition.sub(positionWorld)), axis)), float(3))) as any;
    const flicker = sin(along.mul(7).add(s.x)).mul(0.15).add(0.85) as any;
    const behind = clamp(positionView.z.sub(sceneZ).div(0.6).add(1), 0, 1) as any;
    built.material.colorNode = vec4(vec3(1.0, 0.96, 0.88).mul(bell.mul(ends).mul(edgeOn).mul(flicker).mul(behind).mul(0.005)), 1) as any;
    built.material.needsUpdate = true;
  });
  return <primitive object={built.mesh} />;
}

// ---- What grows on the ledges ---------------------------------------------------------------------------------------

// A real granite wall is never bare: every ledge top holds a fringe of grass and small ferns, bushes root on the wider
// ledges and in the cracks, trailing plants (ivy, creepers) hang from the lips, thickest in the damp patches, and along
// the rim shrubs and small trees lean out over the drop. Strands and tufts are two alpha-cut cards painted once at
// load (left half: trailing strands; right half: a tuft), instanced over the lips the field's own face gives; bushes
// and trees are the wood's own (forest/trees.ts).
const LEDGE_KEEP = 0.6;
const LEDGE_HANG = 2.4;

function paintLedgePlants() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size * 2;
  canvas.height = size;
  const g = canvas.getContext("2d")!;
  const rand = mulberry32(8181);
  const leaf = (x: number, y: number, a: number, l: number, light: number) => {
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.beginPath();
    g.moveTo(0, 0);
    g.bezierCurveTo(l * 0.55, -l * 0.15, l * 0.5, l * 0.75, 0, l);
    g.bezierCurveTo(-l * 0.5, l * 0.75, -l * 0.55, -l * 0.15, 0, 0);
    g.fillStyle = `rgb(${Math.round(95 * light)},${Math.round(135 * light)},${Math.round(55 * light)})`;
    g.fill();
    g.strokeStyle = `rgba(200,220,150,0.35)`;
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(0, l * 0.1);
    g.lineTo(0, l * 0.85);
    g.stroke();
    g.restore();
  };
  // Trailing strands from the top edge, each its own length, swinging a little as it falls, leaves alternate along it.
  g.save();
  g.beginPath();
  g.rect(3, 0, size - 6, size);
  g.clip();
  for (let k = 0; k < 13; k++) {
    let x = size * (0.12 + rand() * 0.76);
    let y = 0;
    const length = size * (0.35 + rand() * 0.63);
    const swing = (rand() - 0.5) * 0.7;
    const points: [number, number][] = [[x, y]];
    for (let s = 1; s <= 24; s++) {
      x += Math.sin(s * 0.45 + k) * 2.2 + swing * 2;
      y += length / 24;
      points.push([x, y]);
    }
    g.strokeStyle = "rgb(62,58,34)";
    g.lineWidth = 2;
    g.beginPath();
    points.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.stroke();
    points.forEach(([px, py], i) => {
      if (i < 2 || i % 2) return;
      const side = (i / 2) % 2 ? 1 : -1;
      const s = 1 - i / 30;
      leaf(px, py, side * (0.9 + rand() * 0.5), (11 + rand() * 9) * (0.6 + s * 0.5), 0.7 + rand() * 0.5);
    });
  }
  g.restore();
  // The tuft: blades fanning up from the bottom middle, green going to straw, with a couple of small fern fronds.
  g.save();
  g.translate(size, 0);
  g.beginPath();
  g.rect(3, 0, size - 6, size);
  g.clip();
  for (let k = 0; k < 70; k++) {
    const x0 = size * (0.38 + rand() * 0.24);
    const a = (rand() - 0.5) * 1.5;
    const h = size * (0.35 + rand() * 0.6);
    const bend = (rand() - 0.5) * 0.6 + a * 0.5;
    const x1 = x0 + Math.sin(a) * h + bend * h * 0.3;
    const y1 = size - Math.cos(a) * h;
    const w = 3 + rand() * 4;
    const dry = rand();
    g.fillStyle = dry < 0.35 ? `rgb(${170 + rand() * 30},${150 + rand() * 20},${90 + rand() * 20})` : `rgb(${80 + rand() * 40},${120 + rand() * 40},${45 + rand() * 20})`;
    g.beginPath();
    g.moveTo(x0 - w / 2, size);
    g.quadraticCurveTo(x0 + Math.sin(a) * h * 0.5, size - Math.cos(a) * h * 0.5, x1, y1);
    g.quadraticCurveTo(x0 + Math.sin(a) * h * 0.5 + w * 0.3, size - Math.cos(a) * h * 0.5, x0 + w / 2, size);
    g.fill();
  }
  for (let k = 0; k < 3; k++) {
    const x0 = size * (0.35 + rand() * 0.3);
    const a = (rand() - 0.5) * 1.2;
    const h = size * (0.45 + rand() * 0.3);
    for (let i = 2; i < 22; i++) {
      const t = i / 22;
      const x = x0 + Math.sin(a) * h * t + a * t * t * 40;
      const y = size - Math.cos(a) * h * t;
      const l = (1 - t) * 34 + 6;
      g.strokeStyle = "rgb(90,130,55)";
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - Math.cos(a) * l, y - Math.sin(a) * l - l * 0.3);
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l - l * 0.3);
      g.stroke();
    }
  }
  g.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

type Planting = { at: THREE.Vector3; anchor: THREE.Vector3; matrix: THREE.Matrix4 };
// A bush (or a small tree's crown) on the wall: its clumps for the leaf cards, and the rock it holds on to.
type Bush = { spot: TreeSpot; clumps: Crown[]; anchor: THREE.Vector3 };

// What grows on the wall, found by walking up each column of the face as made (field.ts `faceZ`), every 45 cm along it:
// - ledges: a run of heights over which the face steps back (its top), the lip where the run starts. Strands hang from
//   the lip, tufts stand on the top, and on the wider ones a bush;
// - cracks: where the face lies well behind the rock either side, now and then a bush rooted in it;
// - the rim: where the face meets the top, a fringe of bushes leaning out over the edge, strands hanging down the wall
//   and, every several metres, a small tree (pine or broadleaf) leaning out over the drop.
// Kept or not by a slow noise (the damp patches, where plants crowd) and a hash. Placed on the true face: the far
// backdrop lies 15 cm behind it (BACKDROP_BACK), too little to see from there.
function findGrowth(keep: number) {
  const random = mulberry32(6262);
  const hang: Planting[] = [];
  const tufts: Planting[] = [];
  const bushes: Bush[] = [];
  const trees: Bush[] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const strand = (cx: number, y0: number, lipZ: number, longest: number) => {
    // Long only where the face below falls straight or under: the strand must not run into rock that stands out.
    let length = longest;
    for (let d = 0.2; d < length; d += 0.15)
      if (faceZ(cx, y0 - d) > lipZ + 0.02) {
        length = d - 0.1;
        break;
      }
    if (length < 0.35) return;
    const width = THREE.MathUtils.clamp(length * (0.5 + random() * 0.4), 0.45, 1.5);
    q.setFromEuler(e.set(-0.06, (random() - 0.5) * 0.7, (random() - 0.5) * 0.15));
    const at = new THREE.Vector3(cx, y0 + 0.03, lipZ + 0.04);
    hang.push({ at, anchor: new THREE.Vector3(cx, y0 - 0.12, lipZ - 0.2), matrix: new THREE.Matrix4().compose(at, q, s.set(width, length, 1)) });
  };
  // A loose bush: several clumps strung out from where it roots, leaning out from the wall (+z) and a little down.
  const bush = (x: number, y: number, z: number, size: number, out: number) => {
    const clumps: Crown[] = [];
    const n = 2 + Math.floor(random() * 3) + (size > 0.6 ? 1 : 0);
    for (let c = 0; c < n; c++) {
      const f = c / Math.max(1, n - 1);
      clumps.push({
        at: new THREE.Vector3(x + (random() - 0.5) * size * 2.4, y + size * (0.25 + random() * 0.9) - f * out * 0.5, z + size * 0.35 + f * out + random() * size * 0.4),
        r: size * (0.45 + random() * 0.45)
      });
    }
    bushes.push({ spot: { x, y, z, height: 2, radius: 0, lean: [0, 0], seed: 12000 + bushes.length, detail: 2 }, clumps, anchor: new THREE.Vector3(x, y - 0.15, z - 0.25) });
  };
  const damp = (x: number, y: number) => THREE.MathUtils.smoothstep(noise3(x * 0.11, y * 0.17, 5.5), -0.35, 0.25);
  const ledge = (cx: number, y0: number, lipZ: number, y1: number, z1: number) => {
    const depth = lipZ - z1;
    if (depth < 0.12) return;
    const wet = damp(cx, y0);
    // On the wider ledges, a bush: more of them and bigger where it is damp.
    if (depth > 0.2 && random() < (0.3 + wet * 0.45) * keep * 1.6) bush(cx, y0 + (y1 - y0) * 0.3, lipZ - depth * 0.45, 0.4 + random() * 0.5 + wet * 0.3, 0.3 + random() * 0.4);
    if (random() > keep * (0.25 + wet * 1.4)) return;
    if (random() < 0.8) strand(cx, y0, lipZ, (0.5 + Math.pow(random(), 1.8) * LEDGE_HANG) * (0.7 + wet * 0.6));
    // A tuft or two standing on the ledge's top, back from the lip, where the top's slope puts its floor.
    for (let k = random() < 0.6 ? 2 : 1; k > 0; k--) {
      const f = 0.2 + random() * 0.4;
      const at = new THREE.Vector3(cx + (random() - 0.5) * 0.3, y0 + (y1 - y0) * f - 0.04, lipZ - depth * f);
      const height = 0.3 + random() * 0.45;
      q.setFromEuler(e.set((random() - 0.5) * 0.2, k * 1.4 + random() * 0.6, 0));
      tufts.push({ at, anchor: new THREE.Vector3(at.x, at.y - 0.12, at.z - 0.12), matrix: new THREE.Matrix4().compose(at, q, s.set(height * 1.3, height, 1)) });
    }
  };
  // A tuft of grass on the wall itself, rooted in a seam: tipped out from the face (its top toward +z), so it reads as
  // growing out and up, not flat on the rock.
  const wallTuft = (x: number, y: number, z: number, height: number) => {
    const at = new THREE.Vector3(x, y, z + 0.02);
    q.setFromEuler(e.set(0.45 + random() * 0.5, (random() - 0.5) * 1.1, (random() - 0.5) * 0.5));
    tufts.push({ at, anchor: new THREE.Vector3(x, y, z - 0.15), matrix: new THREE.Matrix4().compose(at, q, s.set(height * 1.3, height, 1)) });
  };
  // A tuft standing upright on level ground or a ledge.
  const groundTuft = (x: number, y: number, z: number, height: number, anchor: THREE.Vector3) => {
    const at = new THREE.Vector3(x, y - 0.04, z);
    q.setFromEuler(e.set((random() - 0.5) * 0.25, random() * Math.PI, 0));
    tufts.push({ at, anchor, matrix: new THREE.Matrix4().compose(at, q, s.set(height * 1.3, height, 1)) });
  };
  for (let x = -62; x <= 62; x += 0.45) {
    const cx = x + (random() - 0.5) * 0.3;
    const floor = groundY(cx, faceZ(cx, 1) + 0.5);
    const rimY = skyline(cx);
    // The foot: where the wall meets the wood, bushes big and small and grass crowding against the rock.
    const footZ = faceZ(cx, floor + 0.4);
    const footWet = damp(cx, floor);
    if (random() < (0.3 + footWet * 0.35) * keep * 1.6) bush(cx, groundY(cx, footZ + 0.5), footZ + 0.25, random() < 0.35 ? 0.7 + random() * 0.5 : 0.35 + random() * 0.3, 0.3 + random() * 0.4);
    for (let k = 1 + Math.floor(random() * 3 * keep * 1.6); k > 0; k--) {
      const tz = footZ + 0.1 + random() * 0.9;
      const tx = cx + (random() - 0.5) * 0.4;
      groundTuft(tx, groundY(tx, tz), tz, 0.3 + random() * 0.5, new THREE.Vector3(tx, groundY(tx, tz) - 0.3, tz));
    }
    let was = faceZ(cx, floor + 1);
    // The run under way: where it began (its lip) or null.
    let start: { y: number; z: number } | null = null;
    for (let y = floor + 1.1; y < rimY - 1; y += 0.1) {
      const z = faceZ(cx, y);
      const stepping = was - z > 0.045;
      if (stepping && !start) start = { y: y - 0.1, z: was };
      else if (!stepping && start) {
        ledge(cx, start.y, start.z, y - 0.1, was);
        start = null;
      }
      was = z;
      if (Math.round(y * 10) % 5 === 0) {
        // A crack: the face well behind the rock either side of it. Bushes root in some, grass in more.
        const crack = Math.min(faceZ(cx - 0.6, y), faceZ(cx + 0.6, y)) - z > 0.18;
        if (crack && random() < 0.14 * keep * 2) bush(cx, y, z + 0.1, 0.3 + random() * 0.35, 0.25);
        else if (random() < (crack ? 0.5 : 0.12 + damp(cx, y) * 0.16) * keep * 1.6) wallTuft(cx + (random() - 0.5) * 0.3, y, z, 0.22 + random() * 0.35);
      }
    }
    // The rim: from under the skyline, upward, the last height at which the face still stands in front of the top.
    let lipY = rimY - 6;
    let lipZ = faceZ(cx, lipY);
    for (let y = rimY - 6; y < rimY + 4; y += 0.1) {
      const z = faceZ(cx, y);
      if (topY(cx, z - 0.3) < y) break;
      lipY = y;
      lipZ = z;
    }
    const wet = damp(cx, lipY);
    // Along the rim, bushes big and small leaning out over the edge, nearly all the way along, and grass between.
    if (random() < (0.55 + wet * 0.3) * keep * 1.6) bush(cx, lipY - 0.1, lipZ - 0.35, 0.55 + random() * 0.65, 0.4 + random() * 0.7);
    if (random() < 0.5 * keep * 1.6) bush(cx + (random() - 0.5) * 0.4, lipY - 0.05, lipZ - 0.6 - random() * 0.6, 0.25 + random() * 0.3, 0.2);
    for (let k = Math.floor(random() * 3 * keep * 1.6); k > 0; k--) {
      const tz = lipZ - 0.2 - random() * 1.2;
      groundTuft(cx + (random() - 0.5) * 0.4, topY(cx, tz), tz, 0.3 + random() * 0.4, new THREE.Vector3(cx, topY(cx, tz) - 0.25, tz));
    }
    if (random() < 0.35 * keep * 2) strand(cx, lipY - 0.2, lipZ - 0.05, (0.8 + Math.pow(random(), 1.5) * LEDGE_HANG * 1.4) * (0.7 + wet * 0.6));
    if (random() < 0.075) {
      const back = 0.5 + random() * 0.6;
      const tz = lipZ - back;
      const height = 3.2 + random() * 4.5;
      const conifer = random() < 0.5;
      // Its seed picked so the forest draws it a pine or a broadleaf as wanted (forest/trees.ts `isConifer`).
      let seed = Math.floor(random() * 1e9);
      const spot: TreeSpot = { x: cx, y: topY(cx, tz), z: tz, height, radius: 0.07 + random() * 0.09, lean: [(random() - 0.5) * 0.3, 0.2 + random() * 0.35], seed, detail: Math.abs(cx) < 30 ? 1 : 0 };
      for (let tries = 0; tries < 40 && isConifer(spot) !== conifer; tries++) spot.seed = seed = seed + 7919;
      trees.push({ spot, clumps: [], anchor: new THREE.Vector3(cx, spot.y - 0.3, tz) });
    }
  }
  return { hang, tufts, bushes, trees };
}

// The trunks of the small trees on the rim: plain bark, grey-brown, a little lighter on top.
function rimBark() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  m.lightsNode = outdoorLights;
  const tint = attribute("aTint", "vec4") as any;
  const streak = sin(positionWorld.y.mul(9).add(sin(positionWorld.x.mul(23).add(positionWorld.z.mul(17))).mul(2)))
    .mul(0.12)
    .add(0.9) as any;
  m.colorNode = tint.xyz.mul(vec3(0.15, 0.125, 0.1)).mul(streak) as any;
  return m;
}

function LedgeGrowth({ field }: { field?: Rock }) {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const built = useMemo(() => {
    const { hang, tufts, bushes, trees } = findGrowth(startTier === "low" ? LEDGE_KEEP * 0.5 : LEDGE_KEEP);
    const tex = paintLedgePlants();
    const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.8 });
    material.lightsNode = outdoorLights;
    const panel = attribute("aPanel", "float") as any;
    const own = hash(instanceIndex.toFloat().mul(3.17)) as any;
    // Mirrored by its own hash, so neighbours differ.
    const u = mix(uv().x, float(1).sub(uv().x), own.greaterThan(0.5).select(float(1), float(0))) as any;
    const tap = texture(tex, vec2(u.mul(0.5).add(panel.mul(0.5)), uv().y)) as any;
    material.opacityNode = tap.a;
    material.maskShadowNode = tap.a.greaterThan(0.5) as any;
    material.colorNode = tap.rgb.mul(mix(vec3(0.75, 0.82, 0.62), vec3(1.05, 1.0, 0.85), own)) as any;
    // Lit as foliage against the wall: out from the face and up, whichever side shows.
    material.normalNode = transformNormalToView(normalize(vec3(0.1, 0.55, 0.83))) as any;
    // The sun through the leaves where the eye looks up into it.
    const sunWay = vec3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z) as any;
    const through = pow(dot(normalize(positionWorld.sub(cameraPosition)), sunWay).max(0), float(4)) as any;
    material.emissiveNode = tap.rgb.mul(vec3(0.7, 0.9, 0.3)).mul(through.mul(0.35)) as any;
    // Stirring in the air, the more the further from where it holds on.
    const reach = abs(positionLocal.y) as any;
    const stir = sin(canopyTime.mul(own.mul(0.8).add(0.9)).add(own.mul(40)))
      .mul(0.05)
      .mul(reach.mul(reach)) as any;
    material.positionNode = positionLocal.add(vec3(stir, 0, stir.mul(0.4))) as any;
    const make = (list: Planting[], panelOf: number, down: boolean) => {
      const quad = new THREE.PlaneGeometry(1, 1, 1, down ? 3 : 1);
      quad.translate(0, down ? -0.5 : 0.5, 0);
      quad.setAttribute("aPanel", new THREE.Float32BufferAttribute(new Float32Array(quad.getAttribute("position").count).fill(panelOf), 1));
      // One parked instance so the pipeline compiles behind the loader even if none were found.
      const mesh = new THREE.InstancedMesh(quad, material, list.length + 1);
      list.forEach((p, i) => mesh.setMatrixAt(i, p.matrix));
      mesh.setMatrixAt(list.length, new THREE.Matrix4().compose(new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), new THREE.Vector3(1e-4, 1e-4, 1e-4)));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      return { mesh, quad, list };
    };
    // The bushes and the rim trees' crowns: the wood's own leaf cards (forest/trees.ts), so they read as the same
    // plants as the wood below. The trees' trunks give their crowns' clumps.
    const trunks = buildTrunks(
      trees.map((t) => t.spot),
      topY
    );
    trees.forEach((t, i) => (t.clumps = trunks.crowns[i].clumps));
    const bark = rimBark();
    const trunkMesh = new THREE.Mesh(trunks.geometry, bark);
    trunkMesh.castShadow = trunkMesh.receiveShadow = true;
    const cluster = leafCluster();
    const leaves = leafMaterial(cluster, SUN_DIRECTION);
    const scale = startTier === "low" ? 0.55 : startTier === "medium" ? 0.8 : 1;
    const crowns = [...bushes, ...trees];
    const perClump = (spot: TreeSpot) => Math.round((spot.height < 3 ? 9 : 12) * scale);
    const canopy = buildCanopy(crowns, leaves, perClump, CANOPY_EYE);
    canopy.mesh.castShadow = startTier !== "low";
    // Which cards belong to which crown (buildCanopy lays them out crown by crown, clump by clump, then sorts them
    // nearest the clearing first: `slot`), so a dig that takes a bush's rock takes the bush.
    const cards: { slots: number[]; matrices: THREE.Matrix4[] }[] = [];
    let at = 0;
    for (const c of crowns) {
      const n = perClump(c.spot);
      const count = c.clumps.length * (isConifer(c.spot) ? Math.max(4, Math.round(n * 0.42)) : n);
      const slots: number[] = [];
      const matrices: THREE.Matrix4[] = [];
      for (let i = 0; i < count; i++) {
        const m = new THREE.Matrix4();
        slots.push(canopy.slot[at + i]);
        canopy.mesh.getMatrixAt(slots[i], m);
        matrices.push(m);
      }
      cards.push({ slots, matrices });
      at += count;
    }
    return { tex, material, sets: [make(hang, 0, true), make(tufts, 1, false)], crowns, cards, canopy, cluster, leaves, bark, trunks: trunks.geometry, trunkMesh };
  }, [startTier]);
  useDispose(built.tex, built.material, built.cluster, built.leaves, built.bark, built.trunks, built.canopy.geometry, ...built.sets.map((set) => set.quad));

  // A dig that takes away the rock a plant holds on to takes the plant: checked when the rock changes, and only for the
  // plants in a chunk that has been dug.
  const digs = useRef(-1);
  const hidden = useMemo(() => new THREE.Matrix4().makeScale(0, 0, 0), []);
  const dug = (a: THREE.Vector3) => !!field && field.byChunk.has(chunkKey(chunkOf(a.x), chunkOf(a.y), chunkOf(a.z)));
  // The cliff's growth goes with the wood (hidden deep underground, forest/index.tsx), so its 30k cards are not drawn
  // (nor in the puddle mirrors) where they cannot be seen. Development only: `__burrowHide("ledges")`.
  const holder = useRef<THREE.Group>(null);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    devParts.set("ledges", () => (holder.current ? [holder.current.children[0]] : []));
    return () => void devParts.delete("ledges");
  }, []);
  useFrame(() => {
    const group = holder.current;
    if (!group || group.visible === woodShown.current) return;
    group.visible = woodShown.current;
    // Its shade on the face comes and goes with it.
    shadow.redraw();
  });
  useFrame(() => {
    if (!field || field.edits.length === digs.current) return;
    digs.current = field.edits.length;
    for (const set of built.sets) {
      let changed = false;
      set.list.forEach((p, i) => {
        const a = p.anchor;
        if (!dug(a)) return;
        set.mesh.setMatrixAt(i, field.sample(a.x, a.y, a.z) > 0 ? p.matrix : hidden);
        changed = true;
      });
      if (changed) set.mesh.instanceMatrix.needsUpdate = true;
    }
    let changed = false;
    built.crowns.forEach((c, k) => {
      if (!dug(c.anchor)) return;
      const keep = field.sample(c.anchor.x, c.anchor.y, c.anchor.z) > 0;
      const { slots, matrices } = built.cards[k];
      slots.forEach((slot, i) => built.canopy.mesh.setMatrixAt(slot, keep ? matrices[i] : hidden));
      changed = true;
    });
    if (changed) built.canopy.mesh.instanceMatrix.needsUpdate = true;
  });
  return (
    <group ref={holder}>
      <group>
        {built.sets.map((set, k) => (
          <primitive key={k} object={set.mesh} />
        ))}
        <primitive object={built.canopy.mesh} />
        <primitive object={built.trunkMesh} />
      </group>
    </group>
  );
}

// `ground`: a cheaper material for the far ground ring, if given (else `rock`). `field`: the rock with its digs, so the
// plants on the ledges go with the rock under them (they stay put if it is not given).
export function Outside({ rock, ground, eye, field }: { rock: THREE.Material; ground?: THREE.Material; eye: THREE.Vector3; field?: Rock }) {
  const backdrop = useMemo(() => buildBackdrop(), []);
  const floor = useMemo(() => buildGround(), []);
  const mesas = useMemo(() => buildMesas(), []);
  const mesaMaterial = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, vertexColors: true });
    // Lit from behind by the low sun: dark faces, bluer and paler with distance, a warm rim toward the sun.
    const toSun = normalize(vec3(SUN_DIRECTION.x, 0, SUN_DIRECTION.z)) as any;
    const along = normalize(positionWorld.sub(cameraPosition)) as any;
    const rim = pow(along.dot(toSun).max(0), float(6)) as any;
    const haze = smoothstep(55, 100, positionWorld.sub(cameraPosition).length()) as any;
    // Darker toward their feet, where the haze over the plain lies thickest in front of them. Banded like the cliff,
    // cut by gullies down their faces, and each butte its own shade, so they read as rock, not cut-outs; a warm rim
    // along the caprock where the sun behind them catches it.
    const pw = positionWorld as any;
    const low = smoothstep(-2, 10, pw.y) as any;
    const around = pw.x.mul(0.9).add(pw.z.mul(0.55)) as any;
    const bands = sin(pw.y.mul(0.9).add(sin(around.mul(0.08)).mul(0.8)))
      .mul(0.5)
      .add(0.5) as any;
    const gullies = pow(abs(sin(around.mul(0.34).add(sin(around.mul(0.07)).mul(2)))), float(4)) as any;
    const butte = sin(around.mul(0.11)).mul(0.5).add(0.5) as any;
    const cap = smoothstep(0.75, 1, pw.y.div(pw.y.max(1).add(1.5))) as any;
    const tone = float(0.72).add(bands.mul(0.22)).sub(gullies.mul(0.3)).add(butte.mul(0.18)) as any;
    // Each face looks back toward the cliff; those turned to the low sun catch it warm, the rest stay in shadow, so the
    // rows separate into planes.
    const facing = normalize(vec3(pw.x.negate(), 0, float(4).sub(pw.z))) as any;
    const sunlit = facing.dot(toSun).max(0) as any;
    m.colorNode = mix(vec3(0.085, 0.06, 0.07), vec3(0.3, 0.21, 0.23), haze.mul(0.65))
      .mul(tone)
      .mul(mix(vec3(0.6, 0.58, 0.66), vec3(2.1, 1.45, 0.95), sunlit.mul(float(1).sub(haze.mul(0.6)))))
      .mul(low.mul(0.55).add(0.45))
      .add(vec3(0.5, 0.24, 0.09).mul(rim.mul(cap.mul(0.6).add(0.4)))) as any;
    return m;
  }, []);
  useDispose(backdrop, floor, mesas, mesaMaterial);

  // The sun and its shadow map. Out in the clearing the map stays put over the clearing and the wood seen from it, wide
  // enough that nothing within sight lies past its edge (past the edge a shadow map lets the sun through, so a box that
  // followed the eye drew the wood's shade in only as the eye walked toward it). Underground it follows the eye in whole
  // steps of 4 m, so the shadows never crawl and the sun never shines into a tunnel through rock.
  const sun = useMemo(() => {
    const light = new THREE.DirectionalLight(SUN_COLOUR, SUN);
    light.castShadow = true;
    light.shadow.mapSize.set(4096, 4096);
    const cam = light.shadow.camera as THREE.OrthographicCamera;
    cam.left = -44;
    cam.right = 44;
    cam.top = 40;
    cam.bottom = -40;
    cam.near = 5;
    cam.far = 135;
    cam.updateProjectionMatrix();
    // Undergrowth beyond its view distance still casts (forest/lights.ts). With a layer of its own set, the shadow
    // camera keeps this mask rather than taking the eye's.
    cam.layers.enable(SHADOW_ONLY_LAYER);
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.035;
    light.shadow.radius = 4;
    // Drawn again only when the rock changes or the map moves: the sun never moves.
    light.shadow.autoUpdate = false;
    light.shadow.needsUpdate = true;
    return light;
  }, []);
  useEffect(() => {
    shadow.redraw = () => {
      sun.shadow.needsUpdate = true;
    };
    return () => {
      shadow.redraw = () => {};
    };
  }, [sun]);
  useEffect(() => () => sun.dispose(), [sun]);
  // Midday sky light, strong enough that the shade under the canopy reads as shade, not night; its ground half the
  // green-brown of light bounced off the leaves and litter.
  const sky = useMemo(() => new THREE.HemisphereLight(SKY_COLOUR, BOUNCE_COLOUR, SKY_FILL), []);
  // The forest is lit by these two alone (forest/lights.ts).
  useMemo(() => outdoorLights.setLights([sun, sky]), [sun, sky]);
  const placed = useMemo(() => new THREE.Vector3(Infinity, 0, 0), []);
  // How far into the rock (m) the sun is gone entirely.
  const DEEP = 13;
  // Behind the loader the engine builds pipelines in the background, and a caster whose shadow pipeline is not built
  // yet is left out of that frame's shadow map. A map drawn once then stayed empty until the first dig asked for
  // another, so the clearing had no shade until the first click. Drawn every frame until the scene is live (the warm-up
  // waits for those pipelines), and twice more after, with nothing hidden drawn for the warm-up.
  const settle = useRef(2);
  // How often the 4096² map is drawn again, for `__burrowStats()` (stats.ts; development only): times of the last
  // redraws, and the frame clock they were counted on.
  const redraws = useRef<number[]>([]);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    statSources.set("sun", () => {
      const now = performance.now();
      const recent = redraws.current.filter((t) => now - t < 10000);
      return { "shadow map": `${sun.shadow.mapSize.x}² over ${sun.shadow.camera.right - sun.shadow.camera.left} m`, "shadow redraws in the last 10 s": recent.length };
    });
    return () => void statSources.delete("sun");
  }, [sun]);
  // Counted at the end of the frame's work (after every part has had its say), before the render that draws it.
  useFrame(() => {
    if (process.env.NODE_ENV === "production" || !sun.shadow.needsUpdate) return;
    const list = redraws.current;
    list.push(performance.now());
    if (list.length > 400) list.splice(0, list.length - 400);
  }, 0.5);
  useFrame(() => {
    if (scenePhase.current !== "live") {
      settle.current = 2;
      sun.shadow.needsUpdate = true;
    } else if (settle.current > 0) {
      settle.current -= 1;
      sun.shadow.needsUpdate = true;
    }
    const depth = cliffDepth(eye.x, eye.y, eye.z);
    // Underground, the sky's fill eases back to what the caves were tuned with (their materials darken it by depth).
    sky.intensity = THREE.MathUtils.lerp(SKY_FILL, 0.55, THREE.MathUtils.smoothstep(depth, 0.2, 2.4));
    // Deep in the rock no sunlight can reach, so the sun fades out (an intensity change, no recompile) and its map stops
    // following the eye: moving it redrew the 4096 map every 4 m walked underground, a GPU cost on a regular beat.
    sun.intensity = SUN * (1 - THREE.MathUtils.smoothstep(depth, DEEP - 3, DEEP));
    if (depth > DEEP) return;
    const open = depth < -0.3;
    const x = open ? OPEN_SHADOW.x : Math.round(eye.x / 4) * 4;
    const y = open ? OPEN_SHADOW.y : Math.round(eye.y / 4) * 4;
    const z = open ? OPEN_SHADOW.z : Math.round(eye.z / 4) * 4 - 6;
    if (x === placed.x && y === placed.y && z === placed.z) return;
    placed.set(x, y, z);
    sun.target.position.set(x, y, z);
    sun.target.updateMatrixWorld();
    sun.position.copy(sun.target.position).addScaledVector(SUN_DIRECTION, 60);
    sun.updateMatrixWorld();
    sun.shadow.needsUpdate = true;
  });

  return (
    <>
      <SkyDome palette={PALETTE} radius={120} />
      <primitive object={sun} />
      <primitive object={sun.target} />
      <primitive object={sky} />
      <mesh geometry={backdrop} material={rock} castShadow receiveShadow />
      <mesh geometry={floor} material={ground ?? rock} receiveShadow />
      {/* The desert mesas are hidden by the forest now (forest/), so they are not drawn. */}
      <SunShafts />
      <LedgeGrowth field={field} />
      {/* Swallows working the face, in twos and threes. */}
      <Birds count={22} centre={[1, 9, 9]} spread={11} color="#17120f" size={0.1} groupSize={3} separation={1.6} />
    </>
  );
}
