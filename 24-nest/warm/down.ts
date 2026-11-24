/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  attribute,
  cameraPosition,
  color,
  cross,
  dot,
  float,
  length,
  max,
  mix,
  modelWorldMatrixInverse,
  normalize,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  transformNormalToView,
  varying,
  vec3,
  vec4
} from "three/tsl";
import type { Lighting } from "./light";

// Nestling down. Real down grows in tufts: from each root a spray of fine barbs fans out, so the coat reads as soft
// puffs rather than hair. Each barb is a ribbon of a few segments turned to the eye, drooping a little under its own
// weight and stirring in the air; lit as the skin under it would be, darker toward the root where the light cannot
// reach, and glowing at the tips when the sun is behind.

export type Tuft = {
  root: THREE.Vector3;
  normal: THREE.Vector3;
  // The way the tuft leans, along the skin, and how long, wide and many its barbs.
  lean: THREE.Vector3;
  length: number;
  spread: number;
  count: number;
  tone: number;
};

const SEGMENTS = 3;

// Every barb of every tuft as one geometry: per vertex its root, its reach (direction times length), the droop at its
// tip, the skin normal, and [how far along, which side, tone, width].
export function downGeometry(tufts: Tuft[], random: () => number, width: number) {
  let barbs = 0;
  for (const t of tufts) barbs += t.count;
  const verts = barbs * (SEGMENTS + 1) * 2;
  const position = new Float32Array(verts * 3);
  const reach = new Float32Array(verts * 3);
  const droop = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const info = new Float32Array(verts * 4);
  const index: number[] = [];
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3();
  let v = 0;
  for (const t of tufts) {
    side.crossVectors(t.normal, t.lean).normalize();
    for (let k = 0; k < t.count; k++) {
      // Fanned round the tuft's axis, which stands off the skin and leans back along it.
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(random()) * t.spread;
      up.copy(t.normal).multiplyScalar(0.55).add(t.lean).normalize();
      dir.copy(up).addScaledVector(side, Math.cos(a) * r).addScaledVector(t.normal, Math.sin(a) * r * 0.8).normalize();
      // Never into the skin.
      const into = dir.dot(t.normal);
      if (into < 0.15) dir.addScaledVector(t.normal, 0.15 - into).normalize();
      const len = t.length * (0.6 + random() * 0.55);
      const sag = len * (0.35 + random() * 0.35);
      const tone = t.tone * (0.85 + random() * 0.3);
      const w = width * (0.7 + random() * 0.6);
      const base = v;
      for (let s = 0; s <= SEGMENTS; s++) {
        for (const sideSign of [-1, 1]) {
          position.set([t.root.x, t.root.y, t.root.z], v * 3);
          reach.set([dir.x * len, dir.y * len, dir.z * len], v * 3);
          droop.set([0, -sag, 0], v * 3);
          normal.set([t.normal.x, t.normal.y, t.normal.z], v * 3);
          info.set([s / SEGMENTS, sideSign, tone, w], v * 4);
          v++;
        }
      }
      for (let s = 0; s < SEGMENTS; s++) {
        const a0 = base + s * 2;
        index.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(position, 3));
  g.setAttribute("aReach", new THREE.BufferAttribute(reach, 3));
  g.setAttribute("aDroop", new THREE.BufferAttribute(droop, 3));
  g.setAttribute("aNormal", new THREE.BufferAttribute(normal, 3));
  g.setAttribute("aInfo", new THREE.BufferAttribute(info, 4));
  g.setIndex(index);
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += 2;
  return g;
}

// Tufts spread over an ellipsoid (radii, centre), on the part facing `keep` (dot above `cut`), leaning toward `back`.
export function tuftsOnEllipsoid(
  random: () => number,
  count: number,
  radii: THREE.Vector3,
  centre: THREE.Vector3,
  // `hidden`/`hide`: skip the part facing `hidden` beyond `hide` (a side no view reaches).
  opts: { length: number; spread: number; barbs: number; back: THREE.Vector3; keep?: THREE.Vector3; cut?: number; hidden?: THREE.Vector3; hide?: number; tone?: (n: THREE.Vector3, p: THREE.Vector3) => number; longer?: (n: THREE.Vector3) => number }
) {
  const tufts: Tuft[] = [];
  let guard = 0;
  // Tufts on a hidden side still count, so the rest of the coat keeps its density.
  let skipped = 0;
  while (tufts.length + skipped < count && guard++ < count * 6) {
    // An even spread over the sphere, then stretched.
    const u = random() * 2 - 1;
    const a = random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const unit = new THREE.Vector3(s * Math.cos(a), u, s * Math.sin(a));
    if (opts.keep && unit.dot(opts.keep) < (opts.cut ?? -1)) continue;
    if (opts.hidden && unit.dot(opts.hidden) > (opts.hide ?? 2)) {
      skipped++;
      continue;
    }
    const root = unit.clone().multiply(radii).add(centre);
    const normal = unit.clone().divide(radii).normalize();
    const lean = opts.back.clone().addScaledVector(normal, -opts.back.dot(normal));
    if (lean.lengthSq() < 1e-4) lean.set(random() - 0.5, 0, random() - 0.5);
    lean.normalize();
    const more = opts.longer ? opts.longer(unit) : 1;
    tufts.push({ root, normal, lean, length: opts.length * more, spread: opts.spread, count: opts.barbs, tone: opts.tone ? opts.tone(unit, root) : 1 });
  }
  return tufts;
}

export type DownLook = { root: string; tip: string };

// The barbs' material: placed in the vertex stage, lit by the world's lights as a soft coat.
// `fluff` lengthens every barb: a cold chick puffs its down out, a hot one lies sleek.
// With `parts` (an array of matrices, picked per vertex by its aPart), each barb is placed by its part's matrix: the
// coat worked out in the part's own frame as ever, then carried into the world and turned to the eye there.
// `press`, given with parts, flattens the down under a pair of sunglasses: for the barbs of part `press.part` whose root
// points toward either lens, the reach shrinks by that chick's `press.wear` (one value per chick, P parts each).
export type Press = { wear: any; part: number; P: number; lenses: THREE.Vector3[] };
// `mouths` keeps the open mouths clean: any part of a barb that falls inside a chick's gape (the wedge between its open
// beak halves, from just behind the base out to the tips), worked out in that chick's head frame, is cut away. The
// outside of the face keeps its whole coat.
export type Mouths = { heads: any; gapes: any; count: number; base: THREE.Vector3; beak: number };
export function downMaterial(l: Lighting, look: DownLook, stir: any, fluff: any = float(1), parts: any = null, press: Press | null = null, mouths: Mouths | null = null) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  const root = attribute("position", "vec3") as any;
  let reachA = (attribute("aReach", "vec3") as any).mul(fluff) as any;
  if (press) {
    const index = attribute("aPart", "float") as any;
    const chick = index.div(press.P).floor() as any;
    const onHead = step(abs(index.sub(chick.mul(press.P)).sub(press.part)), 0.5) as any;
    const d = normalize(attribute("position", "vec3")) as any;
    let under: any = float(0);
    for (const lens of press.lenses) under = max(under, smoothstep(0.86, 0.95, dot(d, vec3(lens.x, lens.y, lens.z))));
    const wear = press.wear.element(chick.toInt()) as any;
    reachA = reachA.mul(float(1).sub(under.mul(onHead).mul(wear).mul(0.8)));
  }
  const droopA = attribute("aDroop", "vec3") as any;
  const nA = attribute("aNormal", "vec3") as any;
  const info = attribute("aInfo", "vec4") as any;
  const y = info.x as any;
  // The air stirs the tips: a slow sway, different for every barb by where it grows.
  const phase = root.x.mul(3.1).add(root.y.mul(2.3)).add(root.z.mul(1.7)) as any;
  const sway = vec3(sin(stir.mul(2.1).add(phase)), sin(stir.mul(1.7).add(phase.mul(1.3))).mul(0.4), sin(stir.mul(2.6).add(phase.mul(0.7)))).mul(length(reachA).mul(0.06)) as any;
  const centre = root.add(reachA.mul(y)).add(droopA.add(sway).mul(y.mul(y))) as any;
  const T = normalize(reachA.add(droopA.add(sway).mul(y.mul(2))).add(vec3(0, 0.0001, 0))) as any;
  // Tapering to a wisp, and never thinner than about half a pixel.
  const taper = float(1).sub(pow(y, 0.9).mul(0.8)) as any;
  if (parts) {
    const M = parts.element((attribute("aPart", "float") as any).toInt()) as any;
    const scale = M.mul(vec4(1, 0, 0, 0)).xyz.length() as any;
    const at = M.mul(vec4(centre, 1)).xyz as any;
    const along = normalize(M.mul(vec4(T, 0)).xyz) as any;
    const n = M.mul(vec4(nA, 0)).xyz as any;
    const toEye = cameraPosition.sub(at) as any;
    const side = normalize(cross(along, toEye).add(n.mul(0.0001))) as any;
    const wide = max(info.w.mul(taper).mul(scale), length(toEye).mul(0.00022)) as any;
    m.positionNode = at.add(side.mul(info.y.mul(wide))) as any;
  } else {
    const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz as any;
    const toEye = eye.sub(centre) as any;
    const side = normalize(cross(T, toEye).add(nA.mul(0.0001))) as any;
    const wide = max(info.w.mul(taper), length(toEye).mul(0.00022)) as any;
    m.positionNode = centre.add(side.mul(info.y.mul(wide))) as any;
  }
  const vN = varying(parts ? (parts.element((attribute("aPart", "float") as any).toInt()) as any).mul(vec4(attribute("aNormal", "vec3"), 0)).xyz : nA) as any;
  const vY = varying(y) as any;
  const vTone = varying(info.z) as any;
  m.normalNode = transformNormalToView(normalize(vN)) as any;
  const coat = mix(color(look.root), color(look.tip), smoothstep(0.1, 0.95, vY)).mul(vTone) as any;
  // Deep in the coat the light hardly reaches.
  const depth = mix(float(0.5), float(1), smoothstep(0, 0.7, vY)) as any;
  m.colorNode = coat.mul(depth) as any;
  if (mouths) {
    let inside: any = float(0);
    for (let c = 0; c < mouths.count; c++) {
      const local = mouths.heads.element(c).mul(vec4(positionWorld, 1)).xyz as any;
      const rel = local.sub(vec3(mouths.base.x, mouths.base.y, mouths.base.z)) as any;
      const g = mouths.gapes.element(c) as any;
      const angle = atan(rel.y, rel.z.max(0.001)) as any;
      // Between the jaw (turned down 1.05 × gape) and the upper bill (up 0.32 × gape), a little in from each.
      const between = step(g.mul(-1.05).add(0.04), angle).mul(step(angle, g.mul(0.32).sub(0.02))) as any;
      const reach = step(rel.length(), mouths.beak * 1.05).mul(step(-0.35, rel.z)) as any;
      const narrow = step(rel.x.abs(), mouths.beak * 0.95) as any;
      inside = max(inside, between.mul(reach).mul(narrow).mul(step(0.04, g)));
    }
    m.alphaTest = 0.5;
    m.opacityNode = float(1).sub(inside) as any;
  }
  // With the sun behind, the fine tips glow.
  const V = normalize(cameraPosition.sub(positionWorld)) as any;
  const behind = pow(max(dot(V, (l.toSun as any).negate()), 0), 3) as any;
  m.emissiveNode = coat.mul(l.sun as any).mul(behind.mul(vY.mul(vY)).mul(0.45)) as any;
  return m;
}
