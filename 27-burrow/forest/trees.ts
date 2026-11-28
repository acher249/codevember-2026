import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  dot,
  float,
  floor,
  fract,
  hash,
  mix,
  mx_noise_float,
  normalMap,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  texture,
  transformNormalToView,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { mulberry32 } from "../../shared/engine/random";
import type { ForestTextures } from "./assets";
import { outdoorLights } from "./lights";
import type { TreeSpot } from "./layout";
import { CLEARING } from "./terrain";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The trees: tall broadleaves with scanned bark (Poly Haven's Bark Brown 02), their trunks flaring into roots that run
// out over the ground, a few big limbs up high, and crowns of leaf-cluster cards. Every trunk, root and limb of a level
// of detail is one merged mesh; every card of the canopy is one instance of a single quad.

// The canopy's time, for its stir in the air.
export const canopyTime = uniform(0);

type Parts = { position: number[]; normal: number[]; uv: number[]; tint: number[]; index: number[] };
const parts = (): Parts => ({ position: [], normal: [], uv: [], tint: [], index: [] });

const UP = new THREE.Vector3(0, 1, 0);

// A tube along a spine of points, `sides` round, its radius at each point given (with an optional bulge round it, for
// a trunk's buttresses), bark laid on it in metres.
function tube(out: Parts, spine: THREE.Vector3[], radius: (i: number, a: number) => number, sides: number, tint: [number, number, number, number], twist = 0) {
  const base = out.position.length / 3;
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const across = new THREE.Vector3();
  const p = new THREE.Vector3();
  let along = 0;
  // One reference for the whole tube, from its overall direction, so the rings never turn against each other.
  const overall = spine[spine.length - 1].clone().sub(spine[0]).normalize();
  const reference = Math.abs(overall.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP;
  for (let i = 0; i < spine.length; i++) {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(spine.length - 1, i + 1)];
    tangent.subVectors(b, a).normalize();
    if (i > 0) along += spine[i].distanceTo(spine[i - 1]);
    // A frame square to the spine.
    side.crossVectors(tangent, reference).normalize();
    across.crossVectors(side, tangent).normalize();
    const r0 = radius(i, 0);
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2 + twist;
      const r = radius(i, a);
      const c = Math.cos(a);
      const n = Math.sin(a);
      p.copy(spine[i])
        .addScaledVector(side, c * r)
        .addScaledVector(across, n * r);
      out.position.push(p.x, p.y, p.z);
      out.normal.push(side.x * c + across.x * n, side.y * c + across.y * n, side.z * c + across.z * n);
      // Round the trunk at its own girth (so bark keeps its size), along it in metres.
      out.uv.push((s / sides) * Math.max(1, Math.round(r0 * 6.28 * 1.1)), along * 1.1);
      out.tint.push(...tint);
    }
  }
  const ring = sides + 1;
  for (let i = 0; i < spine.length - 1; i++)
    for (let s = 0; s < sides; s++) {
      const a = base + i * ring + s;
      out.index.push(a, a + ring, a + 1, a + 1, a + ring, a + ring + 1);
    }
}

// A gently wandering line from a point, in the direction given, bending as it goes.
function wander(from: THREE.Vector3, way: THREE.Vector3, length: number, steps: number, bend: number, rand: () => number, droop = 0) {
  const points = [from.clone()];
  const dir = way.clone().normalize();
  const p = from.clone();
  for (let i = 1; i <= steps; i++) {
    dir.x += (rand() - 0.5) * bend;
    dir.z += (rand() - 0.5) * bend;
    dir.y += (rand() - 0.5) * bend * 0.5 - droop;
    dir.normalize();
    p.addScaledVector(dir, length / steps);
    points.push(p.clone());
  }
  return points;
}

export type Crown = { at: THREE.Vector3; r: number };

// The share of the wood's grown trees (not bushes) that are conifers: tall, straight, dark firs among the broadleaves,
// for the silhouettes a mixed wood has (spires against the cliff).
const CONIFERS = 0.2;
export const isConifer = (spot: TreeSpot) => spot.height > 3 && mulberry32(spot.seed * 13 + 5)() < CONIFERS;

// One tree into the merged parts: its trunk, buttresses and roots, its limbs, and the clumps its leaves gather in.
// `detail` 2 near the clearing, 1 further off, 0 a far silhouette.
function tree(out: Parts, spot: TreeSpot, crowns: Crown[], ground: (x: number, z: number) => number) {
  if (isConifer(spot)) return conifer(out, spot, crowns, ground);
  const rand = mulberry32(spot.seed);
  const { height, radius, detail } = spot;
  const sides = detail === 2 ? 16 : detail === 1 ? 9 : 6;
  const rings = detail === 2 ? 22 : detail === 1 ? 10 : 6;
  const base = new THREE.Vector3(spot.x, spot.y - 0.4, spot.z);
  // Each tree its own tone of bark: some greyer, some browner, a few nearly black with damp.
  const tone = 0.75 + rand() * 0.4;
  const tint: [number, number, number, number] = [tone * (0.95 + rand() * 0.1), tone, tone * (0.92 + rand() * 0.1), spot.y];
  // The trunk leans a little and wanders, more in its upper half.
  const lean = new THREE.Vector3(spot.lean[0], 1, spot.lean[1]).normalize();
  const spine: THREE.Vector3[] = [];
  const top = height * (0.72 + rand() * 0.1);
  const wobble = [rand() * 6, rand() * 6, rand() * 6];
  for (let i = 0; i <= rings; i++) {
    // Rings closer together at the foot, where the flare changes fast.
    const s = Math.pow(i / rings, 1.6);
    const y = s * top;
    const sway = s * s * 0.6;
    spine.push(
      base
        .clone()
        .addScaledVector(lean, y)
        .add(new THREE.Vector3(Math.sin(y * 0.35 + wobble[0]) * 0.18 * sway, 0, Math.sin(y * 0.3 + wobble[1]) * 0.18 * sway))
    );
  }
  const lobes = 4 + Math.floor(rand() * 3);
  const lobeTurn = rand() * 6.28;
  tube(
    out,
    spine,
    (i, a) => {
      const y = (Math.pow(i / rings, 1.6) * top) as number;
      const taper = radius * (1 - (y / height) * 0.62);
      // The foot flares out into buttresses that run down into the roots.
      const flare = Math.exp(-Math.max(0, y - 0.35) / 0.55);
      const lobe = Math.pow(Math.max(0, Math.cos((a - lobeTurn) * lobes * 0.5)), 3);
      const bark = detail === 2 ? Math.sin(a * 11 + y * 1.3) * 0.012 + Math.sin(a * 5 - y * 0.7) * 0.02 : 0;
      return taper * (1 + flare * (0.35 + lobe * 0.9) + bark);
    },
    sides,
    tint
  );
  // Roots running out from the buttresses over the ground and down into it.
  if (detail === 2) roots(out, spot, lobes, lobeTurn, tint, rand, ground);
  // The limbs: a few big ones from the upper trunk, out and up to the crown's clumps.
  const limbs = detail === 0 ? 3 : 4 + Math.floor(rand() * 3);
  const topAt = spine[spine.length - 1];
  crowns.push({ at: topAt.clone().add(new THREE.Vector3(0, height * 0.12, 0)), r: height * (0.17 + rand() * 0.05) });
  for (let b = 0; b < limbs; b++) {
    const s = 0.62 + (b / limbs) * 0.3 + rand() * 0.05;
    const i = Math.min(spine.length - 2, Math.round(Math.pow(s, 1 / 1.6) * rings));
    const from = spine[i];
    const a = (b / limbs) * Math.PI * 2 + rand() * 1.2;
    const way = new THREE.Vector3(Math.cos(a), 0.9 + rand() * 0.6, Math.sin(a));
    const length = height * (0.2 + rand() * 0.12);
    const path = wander(from, way, length, detail === 2 ? 6 : 3, 0.35, rand);
    const r0 = radius * (1 - (from.y - base.y) / height) * (0.45 + rand() * 0.15);
    if (detail > 0) tube(out, path, (k) => r0 * (1 - (k / (path.length - 1)) * 0.75), detail === 2 ? 8 : 5, tint);
    const tip = path[path.length - 1];
    crowns.push({ at: tip.clone().add(new THREE.Vector3(0, height * 0.03, 0)), r: height * (0.13 + rand() * 0.06) });
    // And a lower clump partway out, so the crown is deep, not a lollipop.
    crowns.push({
      at: path[Math.floor(path.length / 2)].clone().add(
        way
          .clone()
          .setY(0)
          .normalize()
          .multiplyScalar(height * 0.05)
      ),
      r: height * (0.09 + rand() * 0.04)
    });
  }
}

// Roots running out from a trunk's buttresses over the ground and down into it.
function roots(out: Parts, spot: TreeSpot, lobes: number, lobeTurn: number, tint: [number, number, number, number], rand: () => number, ground: (x: number, z: number) => number, reach = 1) {
  const { radius } = spot;
  for (let k = 0; k < lobes; k++) {
    const a = lobeTurn + (k / lobes) * Math.PI * 2 + (rand() - 0.5) * 0.4;
    const way = new THREE.Vector3(Math.cos(a), -0.05, Math.sin(a));
    const from = new THREE.Vector3(spot.x + Math.cos(a) * radius * 0.9, spot.y + 0.25, spot.z + Math.sin(a) * radius * 0.9);
    const length = (1.4 + rand() * 1.8) * reach;
    const path = wander(from, way, length, 7, 0.5, rand);
    path.forEach((p, i) => (p.y = Math.min(p.y, ground(p.x, p.z) + 0.1 - (i / 7) * 0.35)));
    const r0 = radius * (0.32 + rand() * 0.12);
    tube(out, path, (i) => r0 * (1 - (i / 7) * 0.8), 7, tint);
  }
}

// A fir: one straight trunk tapering nearly to a point, its lower stretch bare but for dead snags, the crown a spire of
// flat drooping tiers, widest low and narrowing to a leader at the top. Its bark redder and more plated in tone.
function conifer(out: Parts, spot: TreeSpot, crowns: Crown[], ground: (x: number, z: number) => number) {
  const rand = mulberry32(spot.seed);
  const { height, radius, detail } = spot;
  const sides = detail === 2 ? 14 : detail === 1 ? 8 : 5;
  const rings = detail === 2 ? 18 : detail === 1 ? 8 : 5;
  const base = new THREE.Vector3(spot.x, spot.y - 0.4, spot.z);
  const tone = 0.7 + rand() * 0.3;
  const tint: [number, number, number, number] = [tone * 1.08, tone * 0.84, tone * 0.72, spot.y];
  const lean = new THREE.Vector3(spot.lean[0] * 0.4, 1, spot.lean[1] * 0.4).normalize();
  const top = height * 1.02;
  const spine: THREE.Vector3[] = [];
  for (let i = 0; i <= rings; i++) spine.push(base.clone().addScaledVector(lean, Math.pow(i / rings, 1.5) * top));
  const lobes = 3 + Math.floor(rand() * 3);
  const lobeTurn = rand() * 6.28;
  const girth = radius * 0.85;
  tube(
    out,
    spine,
    (i, a) => {
      const y = Math.pow(i / rings, 1.5) * top;
      const taper = girth * Math.max(0.04, 1 - y / top);
      const flare = Math.exp(-Math.max(0, y - 0.3) / 0.45);
      const lobe = Math.pow(Math.max(0, Math.cos((a - lobeTurn) * lobes * 0.5)), 3);
      return taper * (1 + flare * (0.3 + lobe * 0.7));
    },
    sides,
    tint
  );
  if (detail === 2) roots(out, { ...spot, radius: girth }, lobes, lobeTurn, tint, rand, ground, 0.7);
  const at = (y: number) => base.clone().addScaledVector(lean, y);
  const crownBase = height * (0.3 + rand() * 0.14);
  // Dead snags on the bare lower trunk.
  if (detail === 2)
    for (let k = 0; k < 5; k++) {
      const y = 1.8 + rand() * (crownBase - 1.8);
      const a = rand() * 6.28;
      const from = at(y);
      const path = wander(from, new THREE.Vector3(Math.cos(a), -0.15, Math.sin(a)), 0.4 + rand() * 0.7, 2, 0.3, rand);
      const r0 = girth * (1 - y / top) * 0.14;
      tube(out, path, (i) => r0 * (1 - i * 0.4), 4, tint);
    }
  // The tiers, each a ring of flat clumps round the trunk on drooping boughs.
  const tiers = detail === 0 ? 4 : 7;
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers;
    const y = crownBase + (top - crownBase) * Math.pow(f, 0.9);
    const reach = height * 0.2 * Math.pow(1 - f, 1.05) + 0.3;
    const around = Math.max(2, Math.round(reach * 2.6));
    const turn = t * 2.4 + rand();
    for (let k = 0; k < around; k++) {
      const a = turn + (k / around) * Math.PI * 2 + (rand() - 0.5) * 0.4;
      const out2 = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const from = at(y);
      const tip = from.clone().addScaledVector(out2, reach * 0.62).add(new THREE.Vector3(0, -reach * 0.2, 0));
      if (detail === 2 && k % 2 === 0) {
        const r0 = girth * (1 - y / top) * 0.22 + 0.015;
        tube(out, [from, from.clone().lerp(tip, 0.5).add(new THREE.Vector3(0, reach * 0.04, 0)), tip], (i) => r0 * (1 - i * 0.4), 4, tint);
      }
      crowns.push({ at: tip, r: reach * 0.5 + 0.18 });
    }
  }
  crowns.push({ at: at(top - 0.3), r: 0.45 });
}

export function buildTrunks(spots: TreeSpot[], ground: (x: number, z: number) => number) {
  const out = parts();
  const crowns: { spot: TreeSpot; clumps: Crown[] }[] = [];
  for (const spot of spots) {
    const clumps: Crown[] = [];
    tree(out, spot, clumps, ground);
    crowns.push({ spot, clumps });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(out.position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(out.normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(out.uv, 2));
  geometry.setAttribute("aTint", new THREE.Float32BufferAttribute(out.tint, 4));
  geometry.setIndex(out.index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry, crowns };
}

export function barkMaterial(t: ForestTextures, sun: THREE.Vector3) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  m.lightsNode = outdoorLights;
  const scan = texture(t.bark, uv()).rgb as any;
  const info = attribute("aTint", "vec4") as any;
  const tint = info.xyz as any;
  const p = positionWorld as any;
  // Moss creeps up the side away from the sun and gathers at the foot, in soft patches.
  const away = normalize(vec3(-sun.x, 0, -sun.z)) as any;
  const n = normalize(attribute("normal", "vec3")) as any;
  const shaded = dot(n, away).mul(0.5).add(0.5) as any;
  const patches = varying(smoothstep(-0.2, 0.5, mx_noise_float(p.mul(vec3(0.9, 0.35, 0.9))))) as any;
  const low = float(1).sub(smoothstep(0.2, 2.6, p.y.sub(info.w))) as any;
  const moss = smoothstep(0.35, 0.85, shaded.mul(patches).add(low.mul(0.55))).mul(0.85) as any;
  const mossy = texture(t.moss, uv().mul(0.7)).rgb.mul(vec3(0.62, 0.78, 0.38)) as any;
  // Darker in the last half metre down into the ground and in the roots' crooks (the day has no screen-space
  // occlusion to do it).
  const contact = smoothstep(-0.1, 0.7, p.y.sub(info.w)).mul(0.5).add(0.5) as any;
  // Crusts of pale grey-green lichen in patches up the trunk, over the bark's ridges more than in its furrows, above
  // the moss.
  const ridge = smoothstep(0.08, 0.3, dot(scan, vec3(0.33))) as any;
  const crust = smoothstep(0.3, 0.62, mx_noise_float(p.mul(vec3(2.6, 0.9, 2.6))).add(patches.mul(0.25)))
    .mul(ridge)
    .mul(float(1).sub(moss))
    .mul(smoothstep(0.8, 2.5, p.y.sub(info.w))) as any;
  const bark = mix(scan.mul(tint).mul(vec3(0.78, 0.74, 0.7)), vec3(0.3, 0.32, 0.25).mul(dot(scan, vec3(0.33)).mul(1.6).add(0.5)), crust.mul(0.75)) as any;
  m.colorNode = mix(bark, mossy, moss).mul(contact) as any;
  m.normalNode = normalMap(texture(t.barkNormal, uv()), float(1.4) as any) as any;
  m.roughnessNode = mix(texture(t.barkRough, uv()).r.mul(0.25).add(0.75), float(0.95), moss) as any;
  // Limbs and the upper trunk cast no shade over the open middle of the clearing (as the leaves, below); the lower trunk
  // still does, so each tree keeps its own shadow at its foot.
  const sunWay = vec3(sun.x, sun.y, sun.z) as any;
  const landing = positionWorld.xz.sub(sunWay.xz.mul(positionWorld.y.div(sunWay.y))) as any;
  const open = vec2(landing.x.sub(CLEARING.x).div(CLEARING.rx), landing.y.sub(CLEARING.z).div(CLEARING.rz)).length() as any;
  // (The edge's noise is metres across, so it is worked out per vertex.)
  const ragged = vertexStage(mx_noise_float(landing.mul(0.25))) as any;
  m.maskShadowNode = open.greaterThan(ragged.mul(0.12).add(0.68)).or(p.y.sub(info.w).lessThan(4)) as any;
  return m;
}

// ---- The canopy ----------------------------------------------------------------------------------------------------

// Four sprays side by side, painted once at load: pointed, finely toothed leaves (beech, hornbeam); rounder, broader
// ones hanging looser (lime); lobed oak leaves; and a fir's flat spray of needles. Each leaf darker at its stalk, its
// veins paler. A broadleaf card is cut out of one of the first three, so no crown is one leaf stamped over and over;
// a conifer's out of the fourth.
export const LEAF_PANELS = 4;
export function leafCluster() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size * LEAF_PANELS;
  canvas.height = size;
  const g = canvas.getContext("2d")!;
  g.clearRect(0, 0, size * LEAF_PANELS, size);
  paintCluster(g, size, 0, 4242, "pointed");
  paintCluster(g, size, size, 5353, "round");
  paintCluster(g, size, size * 2, 6464, "lobed");
  paintNeedles(g, size, size * 3, 7575);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

type LeafShape = "pointed" | "round" | "lobed";
function paintCluster(g: CanvasRenderingContext2D, size: number, left: number, seed: number, shape: LeafShape) {
  const rand = mulberry32(seed);
  const round = shape !== "pointed";
  const lobed = shape === "lobed";
  g.save();
  // Kept inside its own half, so the two never bleed into each other.
  g.beginPath();
  g.rect(left + 4, 0, size - 8, size);
  g.clip();
  g.translate(left, 0);
  // Twigs from the lower middle out to each corner.
  g.strokeStyle = "rgba(70,52,38,1)";
  g.lineCap = "round";
  const twigs: [number, number, number, number][] = [];
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + (k - 2) * (round ? 0.62 : 0.55) + (rand() - 0.5) * 0.3;
    const x0 = size * 0.5;
    const y0 = size * 0.98;
    const len = size * (0.55 + rand() * 0.3);
    const x1 = x0 + Math.cos(a) * len;
    const y1 = y0 + Math.sin(a) * len;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x0, y0);
    g.quadraticCurveTo(x0 + Math.cos(a + 0.3) * len * 0.5, y0 + Math.sin(a + 0.3) * len * 0.5, x1, y1);
    g.stroke();
    twigs.push([x0, y0, x1, y1]);
  }
  // Leaves along each twig, alternate sides, smaller toward its tip, the inner ones overlapped by the outer.
  const leaves: { x: number; y: number; a: number; l: number; shade: number }[] = [];
  for (const [x0, y0, x1, y1] of twigs) {
    const n = (round ? 5 : 7) + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      const s = 0.2 + (i / n) * 0.85;
      const x = x0 + (x1 - x0) * s;
      const y = y0 + (y1 - y0) * s;
      const along = Math.atan2(y1 - y0, x1 - x0);
      const side = i % 2 ? 1 : -1;
      const droop = round ? 0.35 : 0;
      leaves.push({ x, y, a: along + side * (0.7 + droop + rand() * 0.5), l: size * (round ? 0.13 : 0.11 + rand() * 0.05) * (1.15 - s * 0.35) * (round ? 0.9 + rand() * 0.25 : 1), shade: rand() });
    }
  }
  leaves.sort((p, q) => q.y - p.y);
  for (const leaf of leaves) {
    g.save();
    g.translate(leaf.x, leaf.y);
    g.rotate(leaf.a + Math.PI / 2);
    const l = leaf.l;
    const w = l * (lobed ? 0.46 : round ? 0.5 : 0.36);
    // The outline: an oval drawn to a point, with small teeth.
    g.beginPath();
    const steps = lobed ? 40 : 28;
    for (let i = 0; i <= steps * 2; i++) {
      const t = i <= steps ? i / steps : 2 - i / steps;
      const side = i <= steps ? 1 : -1;
      // An oak's: an oblong of four or five rounded lobes a side, deep sinuses between.
      const half = lobed
        ? w * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.9)), 0.6) * (0.55 + 0.45 * Math.abs(Math.sin(t * Math.PI * 4.5)))
        : round
          ? w * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.65)), 0.7) * (1 + (i % 4 === 0 ? 0.03 : 0))
          : w * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.9) * (1 + (i % 2) * 0.06);
      const x = side * half;
      const y = -t * l;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    const light = 0.75 + leaf.shade * 0.4;
    const grad = g.createLinearGradient(0, 0, 0, -l);
    grad.addColorStop(0, `rgb(${Math.round(120 * light)},${Math.round(150 * light)},${Math.round(70 * light)})`);
    grad.addColorStop(0.6, `rgb(${Math.round(170 * light)},${Math.round(200 * light)},${Math.round(95 * light)})`);
    grad.addColorStop(1, `rgb(${Math.round(150 * light)},${Math.round(185 * light)},${Math.round(85 * light)})`);
    g.fillStyle = grad;
    g.fill();
    // Midrib and side veins.
    g.strokeStyle = `rgba(225,235,170,0.45)`;
    g.lineWidth = 1.3;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, -l * 0.95);
    for (let v = 1; v < 8; v++) {
      const y = -l * (v / 8.5);
      const span = w * 0.85 * Math.sin(Math.PI * (v / 8.5));
      g.moveTo(0, y);
      g.lineTo(span, y - l * 0.08);
      g.moveTo(0, y);
      g.lineTo(-span, y - l * 0.08);
    }
    g.lineWidth = 0.7;
    g.stroke();
    g.restore();
  }
  g.restore();
}

// A fir's spray: a flat, forking twig with short needles close along both sides of every shoot, the tips paler with new
// growth, drooping a little at the ends.
function paintNeedles(g: CanvasRenderingContext2D, size: number, left: number, seed: number) {
  const rand = mulberry32(seed);
  g.save();
  g.beginPath();
  g.rect(left + 4, 0, size - 8, size);
  g.clip();
  g.translate(left, 0);
  g.lineCap = "round";
  const shoot = (x: number, y: number, a: number, length: number, depth: number) => {
    const steps = Math.max(6, Math.round(length / 7));
    let px = x;
    let py = y;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const dir = a + t * 0.25;
      const nx = px + Math.cos(dir) * (length / steps);
      const ny = py + Math.sin(dir) * (length / steps);
      g.strokeStyle = "rgb(70,52,36)";
      g.lineWidth = 2.2 * (1 - t * 0.6) + depth;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(nx, ny);
      g.stroke();
      // Needles both sides, slanting forward, shorter toward the tip.
      const l = (13 - t * 5) * (0.85 + rand() * 0.3);
      const fresh = t > 0.75 ? 1 : 0;
      for (const side of [-1, 1]) {
        const na = dir + side * (1.05 + rand() * 0.25);
        const light = 0.75 + rand() * 0.45;
        g.strokeStyle = fresh ? `rgb(${Math.round(120 * light)},${Math.round(165 * light)},${Math.round(75 * light)})` : `rgb(${Math.round(55 * light)},${Math.round(95 * light)},${Math.round(70 * light)})`;
        g.lineWidth = 2.1;
        g.beginPath();
        g.moveTo(nx, ny);
        g.lineTo(nx + Math.cos(na) * l, ny + Math.sin(na) * l);
        g.stroke();
      }
      if (depth > 0 && i > 1 && i < steps - 2 && i % 3 === 0) shoot(nx, ny, dir + (i % 2 ? 0.75 : -0.75) + (rand() - 0.5) * 0.3, length * (0.45 - t * 0.2), depth - 1);
      px = nx;
      py = ny;
    }
  };
  for (let k = 0; k < 3; k++) shoot(size * 0.5, size * 0.98, -Math.PI / 2 + (k - 1) * 0.55 + (rand() - 0.5) * 0.2, size * (0.75 + rand() * 0.15), 1);
  g.restore();
}

// `slot[i]`: where the i-th card laid out (crown by crown, clump by clump) ended up in the mesh once sorted.
type CardSet = { mesh: THREE.InstancedMesh; geometry: THREE.BufferGeometry; slot: Int32Array };

// Where the eye mostly is while the wood is in sight: standing in the clearing, before the face.
export const CANOPY_EYE = new THREE.Vector3(CLEARING.x, 1.4, CLEARING.z + 2);

// Cards over every crown's clumps: each turned mostly outward from its clump (so the crown reads as masses of foliage
// with light on its outside), the most at the clump's skin, their size and green each their own.
export function buildCanopy(crowns: { spot: TreeSpot; clumps: Crown[] }[], material: THREE.Material, perClump: (spot: TreeSpot) => number, from?: THREE.Vector3): CardSet {
  const quad = new THREE.PlaneGeometry(1, 1);
  const centres: number[] = [];
  // Which spray each card is cut from: 0 any broadleaf one (picked by the card's own hash), 1 a fir's.
  const kinds: number[] = [];
  const matrices: THREE.Matrix4[] = [];
  const colours: THREE.Color[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const out = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (const { spot, clumps } of crowns) {
    const rand = mulberry32(spot.seed * 31 + 7);
    const fir = isConifer(spot);
    // A fir's many small clumps take fewer, smaller cards each.
    const n = fir ? Math.max(4, Math.round(perClump(spot) * 0.42)) : perClump(spot);
    // Each tree a green of its own, as a mixed wood has: fresh yellow-greens (beech, lime), deeper blue-greens (oak),
    // and a few turning toward autumn; some crowns lighter, some darker.
    const kind = rand();
    // Firs a dark, cool blue-green, darker than any broadleaf.
    const hue = fir ? 0.36 + rand() * 0.05 : kind < 0.42 ? 0.22 + rand() * 0.03 : kind < 0.88 ? 0.27 + rand() * 0.04 : 0.13 + rand() * 0.05;
    const sat = fir ? 0.3 + rand() * 0.1 : kind < 0.42 ? 0.48 + rand() * 0.12 : kind < 0.88 ? 0.34 + rand() * 0.12 : 0.5 + rand() * 0.15;
    const tone = fir ? 0.1 + (rand() - 0.5) * 0.02 : (kind < 0.42 ? 0.17 : kind < 0.88 ? 0.13 : 0.17) + (rand() - 0.5) * 0.04;
    for (const clump of clumps)
      for (let k = 0; k < n; k++) {
        const th = rand() * Math.PI * 2;
        const ph = Math.acos(2 * rand() - 1);
        // A fir's clumps are flat tiers; a broadleaf's rounder masses.
        out.set(Math.sin(ph) * Math.cos(th), Math.cos(ph) * (fir ? 0.3 : 0.7), Math.sin(ph) * Math.sin(th));
        const r = (0.55 + 0.45 * Math.sqrt(rand())) * clump.r;
        const at = clump.at.clone().addScaledVector(out, r);
        // Facing out, tipped about at random.
        const face = out.clone().normalize();
        face.x += (rand() - 0.5) * 0.9;
        face.y += (rand() - 0.5) * 0.9 + (fir ? 0.9 : 0.25);
        face.z += (rand() - 0.5) * 0.9;
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), face.normalize());
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rand() * Math.PI * 2));
        const size = (spot.detail === 2 ? 1.35 : spot.detail === 1 ? 2.0 : 3.2) * (0.75 + rand() * 0.5) * (fir ? 0.85 : 1);
        m.compose(at, q, s.set(size, size, size));
        matrices.push(m.clone());
        centres.push(clump.at.x, clump.at.y, clump.at.z, clump.r);
        kinds.push(fir ? 1 : 0);
        // Outside and on top lighter, inside darker.
        const light = THREE.MathUtils.clamp(0.45 + out.y * 0.3 + (r / clump.r - 0.75) * 0.9, 0, 1);
        colours.push(new THREE.Color().setHSL(hue + (rand() - 0.5) * 0.03, sat + (rand() - 0.5) * 0.1, tone + light * 0.11 + rand() * 0.04));
      }
  }
  // Nearest the eye first (`from`, where it mostly stands), so the cards in front write their depth before those behind
  // them are drawn and the GPU skips most of the hidden ones. `order[i]` is the card laid out i-th above.
  const order = matrices.map((_, i) => i);
  if (from) {
    const at = new THREE.Vector3();
    const away = order.map((i) => at.setFromMatrixPosition(matrices[i]).distanceToSquared(from));
    order.sort((a, b) => away[a] - away[b]);
  }
  const slot = new Int32Array(order.length);
  order.forEach((i, k) => (slot[i] = k));
  const sorted = (list: number[], size: number) => {
    const out = new Float32Array(list.length);
    order.forEach((i, k) => out.set(list.slice(i * size, i * size + size), k * size));
    return out;
  };
  quad.setAttribute("aCentre", new THREE.InstancedBufferAttribute(sorted(centres, 4), 4));
  // Each card's place as laid out (x), which picks its spray (leafMaterial), so the sort changes nothing that shows; and
  // its kind (y). One attribute for both: with position, normal, uv, aCentre, the instance matrix and colour, a ninth
  // vertex buffer is past WebGPU's limit of eight and the pipeline fails (27 Nov).
  const kindOf = sorted(kinds, 1);
  const card = new Float32Array(order.length * 2);
  order.forEach((i, k) => {
    card[k * 2] = i;
    card[k * 2 + 1] = kindOf[k];
  });
  quad.setAttribute("aCard", new THREE.InstancedBufferAttribute(card, 2));
  const mesh = new THREE.InstancedMesh(quad, material, matrices.length);
  order.forEach((i, k) => {
    mesh.setMatrixAt(k, matrices[i]);
    mesh.setColorAt(k, colours[i]);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  registerCanopy(mesh);
  quad.addEventListener("dispose", () => canopies.delete(mesh));
  return { mesh, geometry: quad, slot };
}

// How hot the leaves glow close round the sun, seen against it.
const TRANSLUCENCY = 0.9;

// The canopy's gaps (leafMaterial's shadow mask): a noise a metre or so across over the plane square to the sun, so the
// leaves that let the sun through line up along its way. It depends on a point's place on that plane alone, so it is
// drawn once into a texture over the plane (10 cm texels, over every card of every canopy built, bushes and the
// cliff's growth included) and read in the mask. Bilinear over 10 cm, 0.4% of points change side of its edge, by under
// a centimetre mostly (a shadow texel is 2 cm), so the shade is as it was. `bakeCanopyGaps` draws it once the renderer
// can, again for a new renderer, and again if a canopy built later reaches past it.
type Gaps = { e1: THREE.Vector3; e2: THREE.Vector3; u0: any; v0: any; width: any; height: any; target: THREE.RenderTarget; sized: boolean; baked: WeakSet<object>; baking: WeakSet<object> };
const GAP_TEXEL = 0.1;
// Room round the card centres: half a card's diagonal at its largest (3.2 m × 1.25).
const GAP_MARGIN = 3;
const gapsBySun = new Map<string, Gaps>();
const canopies = new Set<THREE.InstancedMesh>();
export function canopyGaps(sun: THREE.Vector3) {
  const key = sun.toArray().join(",");
  let gaps = gapsBySun.get(key);
  if (gaps) return gaps;
  const e1 = new THREE.Vector3().crossVectors(sun, UP).normalize();
  const e2 = new THREE.Vector3().crossVectors(e1, sun).normalize();
  const target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false });
  target.texture.name = "canopy-gaps";
  gaps = { e1, e2, u0: uniform(0), v0: uniform(0), width: uniform(1), height: uniform(1), target, sized: false, baked: new WeakSet(), baking: new WeakSet() };
  gapsBySun.set(key, gaps);
  return gaps;
}

// Where a canopy's cards lie on a gap plane: [u0, u1, v0, v1].
function spanOf(mesh: THREE.InstancedMesh, gaps: Gaps, into = [Infinity, -Infinity, Infinity, -Infinity]) {
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    p.setFromMatrixPosition(m);
    if (p.y < -500) continue;
    const u = p.dot(gaps.e1);
    const v = p.dot(gaps.e2);
    into[0] = Math.min(into[0], u - GAP_MARGIN);
    into[1] = Math.max(into[1], u + GAP_MARGIN);
    into[2] = Math.min(into[2], v - GAP_MARGIN);
    into[3] = Math.max(into[3], v + GAP_MARGIN);
  }
  return into;
}

// A canopy built: its cards must lie within the gaps drawn, or they are drawn again over all of them.
function registerCanopy(mesh: THREE.InstancedMesh) {
  canopies.add(mesh);
  for (const gaps of gapsBySun.values()) {
    if (!gaps.sized) continue;
    const [a, b, c, d] = spanOf(mesh, gaps);
    if (a < gaps.u0.value || b > gaps.u0.value + gaps.width.value || c < gaps.v0.value || d > gaps.v0.value + gaps.height.value) {
      gaps.sized = false;
      gaps.baked = new WeakSet();
    }
  }
}

// Draws every gap plane this renderer has not drawn yet (cheap enough to try each frame until all are in): a quad over
// the target, the very noise the mask worked out per fragment before (stored as 0.5 + n / 2, as outputs are kept
// positive), then reads a texel back to be sure it was drawn (while the engine warms up, a draw whose pipeline is not
// built yet is skipped). `drawn` is told when one is in, so the sun's shadow can be drawn again with it. True once all
// are in.
export function bakeCanopyGaps(renderer: THREE.WebGPURenderer, drawn: () => void) {
  let all = true;
  for (const gaps of gapsBySun.values()) {
    if (gaps.baked.has(renderer)) continue;
    all = false;
    if (gaps.baking.has(renderer)) continue;
    if (!gaps.sized) {
      const span = [Infinity, -Infinity, Infinity, -Infinity];
      for (const mesh of canopies) spanOf(mesh, gaps, span);
      if (!(span[1] > span[0])) continue;
      gaps.u0.value = span[0];
      gaps.v0.value = span[2];
      gaps.width.value = span[1] - span[0];
      gaps.height.value = span[3] - span[2];
      gaps.target.setSize(Math.ceil(gaps.width.value / GAP_TEXEL), Math.ceil(gaps.height.value / GAP_TEXEL));
      gaps.sized = true;
    }
    gaps.baking.add(renderer);
    const material = new THREE.NodeMaterial();
    const at = uv() as any;
    const q = vec3(gaps.e1.x, gaps.e1.y, gaps.e1.z)
      .mul(at.x.mul(gaps.width).add(gaps.u0))
      .add(vec3(gaps.e2.x, gaps.e2.y, gaps.e2.z).mul(at.y.mul(gaps.height).add(gaps.v0))) as any;
    material.fragmentNode = vec4(mx_noise_float(q.mul(1.1).add(9)).mul(0.5).add(0.5), 0, 0, 1) as any;
    const quad = new THREE.QuadMesh(material);
    const before = renderer.getRenderTarget();
    const mrt = renderer.getMRT();
    try {
      renderer.setMRT(null);
      renderer.setRenderTarget(gaps.target);
      quad.render(renderer);
    } finally {
      renderer.setRenderTarget(before);
      renderer.setMRT(mrt);
    }
    const { width, height } = gaps.target;
    const baked = gaps.baked;
    (renderer.readRenderTargetPixelsAsync(gaps.target, width >> 1, height >> 1, 1, 1) as Promise<ArrayLike<number>>)
      .then((texel) => {
        if (!texel[0] || baked !== gaps.baked) return;
        baked.add(renderer);
        drawn();
      })
      .catch(() => {})
      .finally(() => {
        gaps.baking.delete(renderer);
        material.dispose();
      });
  }
  return all;
}

export function leafMaterial(cluster: THREE.Texture, sun: THREE.Vector3) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.45, roughness: 0.75 });
  m.lightsNode = outdoorLights;
  // Each card one of the sprays (leafCluster), mirrored or not, by its own hash: a broadleaf's any of the first three,
  // a fir's the last.
  const own = hash(attribute("aCard", "vec2").x.mul(1.731)) as any;
  const u = mix(uv().x, float(1).sub(uv().x), step(0.5, fract(own.mul(7.3)))) as any;
  const panel = mix(floor(fract(own.mul(13.7)).mul(3)), float(3), attribute("aCard", "vec2").y) as any;
  const tex = texture(cluster, vec2(u.add(panel).div(LEAF_PANELS), uv().y)) as any;
  m.opacityNode = tex.a;
  // The canopy lets the sun through in gaps a metre or two across, lined up along its way, so it comes down in pools:
  // about half the leaves cast none, so the floor under the crowns is dappled with sun, never one shade.
  const sunWay = vec3(sun.x, sun.y, sun.z) as any;
  // (The gaps' noise over the plane square to the sun is baked once into a texture, canopyGaps: the shadow pass runs
  // this mask on about 50M card fragments each time the map is drawn, and the noise was most of it.)
  const gaps = canopyGaps(sun);
  const onPlane = vec2(dot(positionWorld, vec3(gaps.e1.x, gaps.e1.y, gaps.e1.z)), dot(positionWorld, vec3(gaps.e2.x, gaps.e2.y, gaps.e2.z))) as any;
  const gapAt = onPlane.sub(vec2(gaps.u0, gaps.v0)).div(vec2(gaps.width, gaps.height)) as any;
  // And none over the open middle of the clearing: a leaf whose shadow would land there (followed down the sun's way to
  // the clearing's floor) casts none, so the open ground before the face is in full sun and the wood's shade stops
  // at a soft, uneven edge round it.
  const landing = positionWorld.xz.sub(sunWay.xz.mul(positionWorld.y.div(sunWay.y))) as any;
  const open = vec2(landing.x.sub(CLEARING.x).div(CLEARING.rx), landing.y.sub(CLEARING.z).div(CLEARING.rz)).length() as any;
  // (Its noise is metres across, larger than a card, so it is worked out at the card's corners.)
  const ragged = vertexStage(mx_noise_float(landing.mul(0.25))) as any;
  const outside = open.greaterThan(ragged.mul(0.12).add(0.68)) as any;
  // (The cheap tests first: each is skipped where one before it fails.)
  m.maskShadowNode = tex.a
    .greaterThan(0.45)
    .and(outside)
    .and((texture(gaps.target.texture, gapAt) as any).level(float(0)).r.mul(2).sub(1).greaterThan(0.02)) as any;
  const centre = attribute("aCentre", "vec4") as any;
  // Lit as a mass of foliage: the normal mostly out from the clump's middle.
  const outward = normalize(positionWorld.sub(centre.xyz)) as any;
  const facing = transformNormalToView(outward) as any;
  m.normalNode = facing;
  // (The instance's own green multiplies this.) Darker on a clump's underside and deep inside it, where the leaves shade
  // each other, so each clump reads as a rounded mass with a lit top.
  const deep = smoothstep(0.35, 1.0, positionWorld.sub(centre.xyz).length().div(centre.w)) as any;
  const under = smoothstep(-0.8, 0.6, outward.y) as any;
  m.colorNode = tex.rgb.mul(1.2).mul(under.mul(0.35).add(0.65)).mul(deep.mul(0.3).add(0.7)) as any;
  // Leaves between the eye and the sun glow with the light through them: a broad soft lift whenever the eye looks
  // up toward the sun, and a hot yellow-green core close round it, most at a crown's skin (inside, the clump's own
  // leaves have already taken the light) and where the canopy is thin.
  const view = normalize(positionWorld.sub(cameraPosition)) as any;
  const toward = dot(view, sunWay).max(0) as any;
  const through = pow(toward, float(3)).mul(0.3).add(pow(toward, float(16)).mul(TRANSLUCENCY)) as any;
  const thin = varying(smoothstep(0.1, 0.7, mx_noise_float(positionWorld.mul(0.6).add(21)))) as any;
  m.emissiveNode = tex.rgb.mul(vec3(0.9, 1.0, 0.32)).mul(through.mul(thin.mul(0.7).add(0.3)).mul(deep.mul(0.7).add(0.3)).mul(0.55)) as any;
  // A slow stir in the air, more at the edge of each clump.
  const edge = smoothstep(0.4, 1.0, positionLocal.sub(centre.xyz).length().div(centre.w)) as any;
  const stir = sin(canopyTime.mul(1.3).add(centre.x.mul(0.7)).add(centre.z.mul(0.5)))
    .mul(0.04)
    .mul(edge) as any;
  m.positionNode = positionLocal.add(vec3(stir, stir.mul(0.3), stir.mul(0.6))) as any;
  return m;
}
