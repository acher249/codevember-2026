import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import * as THREE from "three/webgpu";
import {
  abs,
  bumpMap,
  cameraPosition,
  cameraViewMatrix,
  dot,
  faceDirection,
  float,
  hash,
  instanceIndex,
  mix,
  mx_noise_float,
  normalize,
  normalMap,
  normalViewGeometry,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import type { QualityTier } from "../../shared/engine/types";
import { mulberry32 } from "../../shared/engine/random";
import type { ForestTextures, Scan } from "./assets";
import { jitterGrid, place, tierShare, type Made } from "./cells";
import { buildLitter } from "./litter";
import { grassAt, pathAt } from "./cover";
import { outdoorLights } from "./lights";
import { beforeFace, spotsFor, type TreeSpot } from "./layout";
import { CLEARING, clearingEdge, forestGround, noise, onPath } from "./terrain";
import { canopyTime, type Crown } from "./trees";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The low growth: grass in clumps of two and three with short blades round their feet, ferns at the clearing's edge
// and in under the trees, a leafy woodland plant (scanned), fallen trunks and branches, mossy boulders gathered at the
// cliff's foot, and last year's leaves lying loose on the floor close by.

// Leaves and blades lit through from behind when the sun is beyond them.
const backlit = (sun: THREE.Vector3) => pow(dot(normalize(positionWorld.sub(cameraPosition)), vec3(sun.x, sun.y, sun.z)).max(0), float(5)) as any;

// ---- Grass ---------------------------------------------------------------------------------------------------------

// A clump: a dozen or so blades from a hand's width of root, arching out and over, longest in the middle; a few short
// ones round them.
function clumpGeometry(seed: number, tall: number, count = 16, spread = 1) {
  const rand = mulberry32(seed);
  const blades: THREE.BufferGeometry[] = [];
  for (let b = 0; b < count; b++) {
    const short = b >= Math.round(count * 0.7);
    const g = new THREE.PlaneGeometry(1, 1, 1, short ? 2 : 3);
    g.translate(0, 0.5, 0);
    const p = g.getAttribute("position");
    const turn = rand() * Math.PI * 2;
    const root = short ? 0.06 + rand() * 0.08 : rand() * 0.035;
    const arch = ((short ? 0.05 : 0.12) + rand() * (short ? 0.08 : 0.28)) * spread;
    const height = tall * (short ? 0.2 + rand() * 0.2 : 0.55 + rand() * 0.45);
    const width = 0.012 + rand() * 0.007;
    const twist = (rand() - 0.5) * 1.2;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      // Never quite to nothing at the tip.
      const w = width * (1 - y * 0.85) * p.getX(i) * 2;
      const out = root + arch * y * y * height * 2;
      const t = turn + twist * y;
      p.setXYZ(i, Math.cos(turn) * out - Math.sin(t) * w, y * height - arch * y * y * y * height * 0.6, Math.sin(turn) * out + Math.cos(t) * w);
    }
    // How far up the blade (for its colour) in uv.y, kept from the plane.
    g.computeVertexNormals();
    blades.push(g);
  }
  const merged = mergeGeometries(blades)!;
  blades.forEach((g) => g.dispose());
  return merged;
}

// A tuft of the short sward: a couple of dozen single-triangle blades from a palm's width of ground, leaning out. Three
// vertices a blade, so the floor can be carpeted with them.
function tuftGeometry(seed: number, blades = 22, radius = 0.17, tall = 0.22) {
  const rand = mulberry32(seed);
  const position: number[] = [];
  const uvs: number[] = [];
  for (let b = 0; b < blades; b++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * radius;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    // Leaning out from the middle and a little each its own way.
    const way = a + (rand() - 0.5) * 1.4;
    const h = tall * (0.45 + rand() * 0.55);
    const lean = (0.15 + rand() * 0.45) * h;
    const w = 0.008 + rand() * 0.008;
    const side = way + Math.PI / 2;
    position.push(x - Math.cos(side) * w, 0, z - Math.sin(side) * w, x + Math.cos(side) * w, 0, z + Math.sin(side) * w, x + Math.cos(way) * lean, h, z + Math.sin(way) * lean);
    uvs.push(0, 0, 1, 0, 0.5, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

// The grass's material, one for the tall clumps and one for the short sward. Past `reach - 7` m each blade sinks into the
// floor (whole, not shrunk), so by the time its cell is hidden at `reach` there is nothing left to vanish.
function grassMaterial(sun: THREE.Vector3, reach: number) {
  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    roughness: 0.7
  });
  material.lightsNode = outdoorLights;
  const up = uv().y as any;
  // From the litter's brown at the root, so a clump grows out of the floor rather than sitting on it, to a green up the
  // blade, paler at the tips. Each clump's own green, yellow or straw comes from its instance colour (set below from the
  // ground it stands on, not from its index, which would repeat the same run of colours in every cell).
  const blade = mix(vec3(0.2, 0.25, 0.075), vec3(0.3, 0.32, 0.12), smoothstep(0.55, 1, up)) as any;
  const green = mix(vec3(0.075, 0.06, 0.03), blade, smoothstep(0, 0.55, up)) as any;
  material.colorNode = green;
  material.emissiveNode = green.mul(vec3(1.1, 1.3, 0.5)).mul(backlit(sun).mul(up).mul(0.9)) as any;
  // Lit mostly as the ground it stands in is, so a thin blade seen edge on or from behind is never a black stroke.
  const upView = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz as any;
  material.normalNode = normalize(mix(normalViewGeometry.mul(faceDirection), upView, 0.55)) as any;
  // Stirred by the air, more at the tips: a flutter of its own, and gusts that roll across the clearing in waves.
  const gust = sin(canopyTime.mul(0.7).sub(positionWorld.x.mul(0.22)).sub(positionWorld.z.mul(0.12)))
    .mul(0.5)
    .add(0.5) as any;
  const sway = sin(canopyTime.mul(1.6).add(positionWorld.x.mul(1.3)).add(positionWorld.z.mul(0.9)))
    .mul(0.35)
    .add(sin(canopyTime.mul(3.7).add(positionWorld.x.mul(4))).mul(0.15))
    .add(gust.mul(gust).mul(1.2))
    .mul(up.mul(up).mul(0.07)) as any;
  const sink = smoothstep(reach - 7, reach - 1, positionWorld.sub(cameraPosition).length()).mul(0.9) as any;
  material.positionNode = positionLocal.add(vec3(sway, sway.abs().mul(-0.3).sub(sink), sway.mul(0.45))) as any;
  return material;
}

// The grass: tall clumps over all the sunny floor, thick in drifts, and under them a short sward of tufts close round
// the eye. Both follow the cover grid (cover.ts), which the floor's turf follows too, so the blades stand where the
// ground is green: all over the clearing, into the sunny gaps between the trees, thinning to nothing in the leaves under
// the crowns, and parted down the trodden way.
const CLUMP_REACH = 26;
const TUFT_REACH = 17;
function grass(sun: THREE.Vector3, tier: QualityTier, made: Made) {
  const share = tierShare(tier);
  const clumpMaterial = grassMaterial(sun, CLUMP_REACH);
  const tuftMaterial = grassMaterial(sun, TUFT_REACH);
  made.disposables.push(clumpMaterial, tuftMaterial);
  // Three clumps (each draws once a cell, so few kinds, varied by scale): middling, a tall dense tussock, and a low
  // splayed tuft.
  const kinds = [clumpGeometry(1, 0.48), clumpGeometry(4, 0.66, 20, 0.8), clumpGeometry(5, 0.22, 10, 1.6)];
  const per = kinds.map(() => [] as THREE.Matrix4[]);
  const tints = kinds.map(() => [] as THREE.Color[]);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  const e = new THREE.Euler();
  const Y = new THREE.Vector3(0, 1, 0);
  const at = new THREE.Vector3();
  const size = new THREE.Vector3();
  // Leaning together the way the wind has laid each patch; its colour fresh green, yellow-green or dried to straw, by
  // drifts of its own, and each a little its own.
  const lay = (x: number, z: number, s: number, tall: number, rand: () => number) => {
    const way = noise(x * 0.08 + 11, z * 0.08) * Math.PI * 2;
    const lean = 0.05 + rand() * 0.18;
    q.setFromEuler(e.set(Math.cos(way) * lean, 0, Math.sin(way) * lean)).multiply(turn.setFromAxisAngle(Y, rand() * 6.28));
    m.compose(at.set(x, forestGround(x, z) - 0.02, z), q, size.set(s, s * tall, s));
    const dry = Math.min(1, Math.max(0, noise(x * 0.16 - 4, z * 0.16 + 9) * 1.4 + 0.15 + (rand() - 0.5) * 0.4));
    const v = 0.88 + rand() * 0.24;
    return new THREE.Color(v * (1 + dry * 0.55), v * (1 + dry * 0.18), v * (1 - dry * 0.25));
  };
  // The clumps: one dart a cell of a grid, kept by how thick the grass is there; a few clumps together where it is thick.
  jitterGrid(611, 0.62 / Math.sqrt(share), -27, 28, -3, 41, (x, z, rand) => {
    const thick = grassAt(x, z);
    if (rand() > thick * 1.15 || clearingEdge(x, z) > 11) return;
    const n = 1 + Math.floor(rand() * (0.5 + thick * 2));
    for (let k = 0; k < n; k++) {
      const cx = x + (rand() - 0.5) * 0.7;
      const cz = z + (rand() - 0.5) * 0.7;
      if (onPath(cx, cz, -2.2) || pathAt(cx, cz) > 0.35) continue;
      // Bigger where it grows thick; thick grass mostly the big kinds, thin grass the short ones.
      const s = (0.6 + rand() * 0.5) * (0.75 + thick * 0.5);
      const kind = thick < 0.3 && rand() < 0.5 ? 2 : thick > 0.6 && rand() < 0.4 ? 1 : rand() < 0.15 ? 2 : 0;
      const tint = lay(cx, cz, s, 0.7 + rand() * 0.6, rand);
      per[kind].push(m.clone());
      tints[kind].push(tint);
    }
  });
  kinds.forEach((geometry, k) => {
    place(made, geometry, clumpMaterial, per[k], false, CLUMP_REACH, tints[k]);
    made.disposables.push(geometry);
  });
  // The sward: tufts close together over the clearing and into the sunny gaps, short and fine on the trodden way's
  // edges, gone down its middle. Only near the eye (TUFT_REACH); further off the floor's turf carries it.
  const tufts = [tuftGeometry(21, 18, 0.17, 0.24)];
  const tuftPer = tufts.map(() => [] as THREE.Matrix4[]);
  const tuftTints = tufts.map(() => [] as THREE.Color[]);
  jitterGrid(613, 0.36 / Math.sqrt(share), -24, 25, -2, 37, (x, z, rand) => {
    const thick = grassAt(x, z);
    const path = pathAt(x, z);
    if (rand() > Math.pow(thick, 0.7) * 1.1 + 0.04 || path > 0.6 || onPath(x, z, -2.4) || clearingEdge(x, z) > 10) return;
    // Short and fine on the trodden way's edges and where the sward thins; taller where it is thick.
    const s = (0.75 + rand() * 0.5) * (0.7 + thick * 0.4) * (1 - path * 0.6);
    const kind = 0;
    const tint = lay(x, z, s, (0.55 + rand() * 0.5) * (0.6 + thick * 0.6), rand);
    tuftPer[kind].push(m.clone());
    tuftTints[kind].push(tint);
  });
  tufts.forEach((geometry, k) => {
    place(made, geometry, tuftMaterial, tuftPer[k], false, TUFT_REACH, tuftTints[k]);
    made.disposables.push(geometry);
  });
  return {
    clumps: per.reduce((n, l) => n + l.length, 0),
    tufts: tuftPer.reduce((n, l) => n + l.length, 0)
  };
}

// ---- Ferns ---------------------------------------------------------------------------------------------------------

// A fern (after Spore's): fronds arching up and out from one crown, each a stalk with leaflets down both sides, longest
// in the middle of the frond; the leaflets' toothed outline is cut in the shader.
function fernGeometry(seed: number, FRONDS = 11, PAIRS = 14) {
  const position: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const rand = mulberry32(seed);
  const up = new THREE.Vector3(0, 1, 0);
  for (let f = 0; f < FRONDS; f++) {
    const turn = (f / FRONDS) * Math.PI * 2 + rand() * 0.5;
    const out = new THREE.Vector3(Math.cos(turn), 0, Math.sin(turn));
    const reach = 0.75 + rand() * 0.35;
    const lift = 0.55 + rand() * 0.3;
    const at = (s: number) =>
      out
        .clone()
        .multiplyScalar(s * reach)
        .add(new THREE.Vector3(0, Math.sin(s * Math.PI * 0.75) * lift - s * s * 0.3, 0));
    for (let k = 0; k < PAIRS; k++) {
      const s = 0.14 + (k / (PAIRS - 1)) * 0.84;
      const p = at(s);
      const tangent = at(Math.min(1, s + 0.01))
        .sub(at(Math.max(0, s - 0.01)))
        .normalize();
      const sideways = new THREE.Vector3().crossVectors(tangent, up).normalize();
      const length = 0.21 * Math.pow(Math.sin((Math.PI * (s - 0.08)) / 0.94), 0.8) * reach;
      const width = length * 0.3;
      for (const side of [-1, 1]) {
        const dir = sideways.clone().multiplyScalar(side).addScaledVector(tangent, 0.4).addScaledVector(up, -0.12).normalize();
        const across = new THREE.Vector3()
          .crossVectors(dir, up)
          .normalize()
          .multiplyScalar(width * 0.5);
        const tip = p.clone().addScaledVector(dir, length);
        const droop = up.clone().multiplyScalar(-length * 0.08);
        const v = position.length / 3;
        for (const [q, u, w] of [
          [p.clone().sub(across), 0, 0],
          [p.clone().add(across), 0, 1],
          [tip.clone().add(across).add(droop), 1, 1],
          [tip.clone().sub(across).add(droop), 1, 0]
        ] as [THREE.Vector3, number, number][]) {
          position.push(q.x, q.y, q.z);
          uvs.push(u, w);
        }
        index.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function ferns(sun: THREE.Vector3, tier: QualityTier, made: Made) {
  const rand = mulberry32(77);
  const geometry = fernGeometry(5);
  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    roughness: 0.65
  });
  material.lightsNode = outdoorLights;
  const leaf = uv() as any;
  const toothed = float(0.82).add(abs(leaf.x.mul(26).fract().sub(0.5)).mul(0.36)) as any;
  const half = pow(float(1).sub(leaf.x), float(0.55))
    .mul(smoothstep(0, 0.12, leaf.x))
    .mul(toothed) as any;
  material.opacityNode = smoothstep(half, half.sub(0.08), abs(leaf.y.sub(0.5)).mul(2)) as any;
  // Each fern's own shade of green comes from its instance colour (set from where it stands).
  const green = vec3(0.1, 0.16, 0.043).mul(smoothstep(0.0, 0.3, leaf.x).mul(0.4).add(0.8)) as any;
  // Darker in toward the crown and the ground, where the fronds shade each other.
  material.colorNode = green.mul(smoothstep(0, 0.35, positionGeometry.y).mul(0.55).add(0.45));
  material.emissiveNode = green.mul(vec3(1.2, 1.4, 0.5)).mul(backlit(sun).mul(0.9)) as any;
  const sway = sin(canopyTime.mul(1.1).add(positionWorld.x.mul(2)).add(positionWorld.z.mul(1.6))).mul(positionLocal.y.mul(0.05)) as any;
  material.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.6))) as any;
  // Thick along the edge and under the trees, a few out in the clearing, and banked along the cliff's foot.
  const count = tier === "low" ? 80 : tier === "medium" ? 260 : 360;
  const spots = [...spotsFor(91, count, -1.5, 14, 0.8, 34), ...spotsFor(93, Math.round(count * 0.15), -6, -1, 0.5, 20)];
  // Close by, the full fern; further off, one of fewer fronds and leaflets.
  const near: THREE.Matrix4[] = [];
  const far: THREE.Matrix4[] = [];
  const nearTint: THREE.Color[] = [];
  const farTint: THREE.Color[] = [];
  spots.forEach((s) => {
    const h = 0.55 + rand() * rand() * 0.75;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(s.x, forestGround(s.x, s.z) - 0.04, s.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.15, rand() * Math.PI * 2, (rand() - 0.5) * 0.15)),
      new THREE.Vector3(h, h * (0.8 + rand() * 0.4), h)
    );
    const close = clearingEdge(s.x, s.z) < 4;
    (close ? near : far).push(m);
    // Darker and bluer in drifts under the trees, yellower in others, each a little its own.
    const shade = noise(s.x * 0.13 + 2, s.z * 0.13 - 3);
    const v = 0.75 + rand() * 0.5;
    (close ? nearTint : farTint).push(new THREE.Color(v * (1 + shade * 0.3), v * (1 + shade * 0.12), v * (1 - shade * 0.2)));
  });
  const simple = fernGeometry(5, 7, 8);
  place(made, geometry, material, near, tier !== "low", 24, nearTint);
  place(made, simple, material, far, false, 30, farTint);
  made.disposables.push(geometry, simple, material);
}

// ---- Scans ---------------------------------------------------------------------------------------------------------

// Moss over the tops of things, in soft patches, from above.
function mossOver(t: ForestTextures, amount: number) {
  // Broken into cushions with bare stone between, never one green carpet.
  const patches = mx_noise_float(positionWorld.mul(1.9))
    .mul(0.6)
    .add(mx_noise_float(positionWorld.mul(7)).mul(0.25)) as any;
  const cover = smoothstep(0.45, 0.75, normalWorld.y.add(patches).add(amount - 0.5)) as any;
  const tone = mx_noise_float(positionWorld.mul(0.8).add(5)).mul(0.25).add(0.85) as any;
  const colour = texture(t.moss, positionWorld.xz.mul(1.6))
    .rgb.mul(vec3(1.2, 1.0, 1.5))
    .mul(tone) as any;
  return { cover, colour };
}

function scanMaterial(t: ForestTextures, scan: Scan, mossy: number, tone: [number, number, number]) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88 });
  m.lightsNode = outdoorLights;
  const moss = mossOver(t, mossy);
  // Darker where it meets the ground (the day has no screen-space occlusion to do it).
  const contact = smoothstep(0, 0.18, positionGeometry.y).mul(0.55).add(0.45) as any;
  m.colorNode = mix(texture(scan.diffuse, uv()).rgb.mul(vec3(...tone)), moss.colour, moss.cover).mul(contact) as any;
  m.roughnessNode = mix(float(0.85), float(1), moss.cover) as any;
  m.normalNode = normalMap(texture(scan.normal, uv()), vec2(1.3, 1.3).mul(float(1).sub(moss.cover.mul(0.6)))) as any;
  return m;
}

// Fallen trunks and branches: one along the clearing's edge where it can be seen from the start, others in the trees.
const LOGS: [number, number, number, number][] = [
  // x, z, turn, scale
  [-8.2, 8.5, 0.5, 1.25],
  [-17, 25, 1.9, 1.2],
  [15.5, 26.5, 2.4, 1.15],
  [-25.5, 15, -0.1, 1.3],
  [23, 13.5, 1.7, 1.2],
  [11.2, 12.5, -0.9, 1.1],
  [-15, 18, 1.9, 1.4],
  [7, 21.5, 0.2, 1.3],
  [-22, 6, 2.6, 1.2],
  [19, 5, 1.2, 1.15]
];
const BRANCHES: [number, number, number, number][] = [
  [-3.5, 13.6, 0.9, 1.2],
  [4.8, 3.6, -0.4, 1],
  [-6.5, 2.5, 2.2, 1.1],
  [9.8, 8.2, 1.4, 1.3],
  [-11.5, 13, 0.1, 1.2],
  [2.5, 16.5, 2.9, 1.1],
  [13.5, 17, 0.7, 1.4]
];

function deadwood(t: ForestTextures, made: Made) {
  const rand = mulberry32(404);
  const lay = (scan: Scan, list: [number, number, number, number][], sink: number, mossy: number) => {
    const material = scanMaterial(t, scan, mossy, [0.85, 0.8, 0.75]);
    made.disposables.push(material);
    const matrices = list.map(([x, z, turn, scale]) => {
      // Level with the ground along its length.
      const y = Math.min(forestGround(x - Math.cos(turn) * 1.5, z + Math.sin(turn) * 1.5), forestGround(x, z), forestGround(x + Math.cos(turn) * 1.5, z - Math.sin(turn) * 1.5));
      const tilt = Math.atan2(forestGround(x + Math.cos(turn) * 1.5, z - Math.sin(turn) * 1.5) - forestGround(x - Math.cos(turn) * 1.5, z + Math.sin(turn) * 1.5), 3);
      return new THREE.Matrix4().compose(
        new THREE.Vector3(x, y - sink * scale, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, turn, tilt + (rand() - 0.5) * 0.05, "YZX")),
        new THREE.Vector3(scale, scale, scale)
      );
    });
    for (const piece of scan.pieces) place(made, piece, material, matrices, true, 60);
  };
  // Mossed over along their tops, the trunks more than the branches.
  lay(t.log, LOGS, 0.18, 0.78);
  lay(t.branch, BRANCHES, 0.05, 0.25);
}

// Boulders fallen from the face and gathered at its foot, mossed over on top, and a few out in the trees.
function boulders(t: ForestTextures, made: Made) {
  const rand = mulberry32(1203);
  const material = scanMaterial(t, t.boulders, 0.3, [0.82, 0.8, 0.76]);
  made.disposables.push(material);
  const per = t.boulders.pieces.map(() => [] as THREE.Matrix4[]);
  const add = (x: number, z: number, scale: number) => {
    const k = Math.floor(rand() * per.length);
    const y = forestGround(x, z) - scale * 0.18;
    per[k].push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.3, rand() * 6.28, (rand() - 0.5) * 0.3)),
        new THREE.Vector3(scale, scale * (0.8 + rand() * 0.4), scale)
      )
    );
  };
  // Along the foot of the face, either side of where you dig, in from the trees.
  for (let n = 0, tries = 0; n < 26 && tries < 600; tries++) {
    const x = (rand() - 0.5) * 34;
    if (Math.abs(x - 0.5) < 3.2) continue;
    let z = 0;
    // Find the face at ground level, then out from it a little.
    for (z = -3; z < 6 && !beforeFace(x, z, 0); z += 0.1);
    z += 0.2 + rand() * rand() * 3.5;
    add(x, z, 0.5 + rand() * rand() * 1.5);
    n++;
  }
  // Scattered in the forest.
  for (const s of spotsFor(1207, 22, 1, 30, 1, 50)) add(s.x, s.z, 0.6 + s.r * 1.0);
  per.forEach((list, k) => place(made, t.boulders.pieces[k], material, list, true, 60));
}

// Scree: stones broken off the face and lying where they fell along its foot, thickest against it and thinning out into
// the litter, some half buried; each an icosphere pushed about by noise so no two match, in the boulders' scanned stone.
function screeGeometry(seed: number) {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.getAttribute("position");
  const rand = mulberry32(seed);
  const cuts = Array.from({ length: 4 }, () => new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize());
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    let r = 1;
    // Flat broken faces where a plane cuts it, as rock splits.
    for (const c of cuts) r = Math.min(r, 0.72 / Math.max(0.3, v.dot(c)));
    v.multiplyScalar(r);
    v.y *= 0.6;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  // Welded (92 vertices rather than 540: the copies of a corner moved alike) and drawn flat-shaded (screeMaterial),
  // so its facets look as they did when each triangle had its own vertices.
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  const welded = mergeVertices(g, 1e-5);
  g.dispose();
  welded.computeVertexNormals();
  return welded;
}

// Broken sandstone, of the face's own beds: the stone scan's grain under the cliff's colours (each stone one bed, by its
// own hash, rock.ts `SAND`), weathered darker on top, with spots of pale and orange lichen.
function screeMaterial(t: ForestTextures) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, flatShading: true });
  m.lightsNode = outdoorLights;
  // The scan of broken rock face, seen along the world's three axes (the stones' own UVs would cut through an atlas).
  const n = normalWorld.abs() as any;
  const w = n.pow(vec3(4)).div(n.pow(vec3(4)).dot(vec3(1)).add(1e-4)) as any;
  const pw = positionWorld.mul(1.4) as any;
  const scan = texture(t.stone, pw.zy).rgb.mul(w.x).add(texture(t.stone, pw.xz).rgb.mul(w.y)).add(texture(t.stone, pw.xy).rgb.mul(w.z)) as any;
  const grain = dot(scan, vec3(0.33)).mul(2.2) as any;
  const pick = hash(instanceIndex.toFloat().mul(4.7)) as any;
  const bed = mix(mix(vec3(0.86, 0.72, 0.56), vec3(0.78, 0.53, 0.33), smoothstep(0.2, 0.5, pick)), vec3(0.64, 0.36, 0.2), smoothstep(0.6, 0.9, pick)) as any;
  const banding = mx_noise_float(positionWorld.mul(vec3(1.5, 14, 1.5)))
    .mul(0.08)
    .add(1) as any;
  // The scan's grain at half strength over the bed's own colour, so the sandstone keeps its warmth.
  const stone = bed.mul(bed).mul(grain.mul(0.6).add(0.4)).mul(banding).mul(0.62) as any;
  const spots = mx_noise_float(positionWorld.mul(9)) as any;
  const lichen = smoothstep(0.5, 0.56, spots).mul(normalWorld.y.mul(0.5).add(0.5)) as any;
  const orange = smoothstep(0.55, 0.62, mx_noise_float(positionWorld.mul(13).add(31))) as any;
  // Darker underneath, where each stone sits in the litter.
  const contact = smoothstep(-0.6, 0.15, positionGeometry.y).mul(0.6).add(0.4) as any;
  m.colorNode = mix(mix(stone, vec3(0.42, 0.44, 0.34), lichen.mul(0.6)), vec3(0.55, 0.3, 0.08), orange.mul(0.6)).mul(contact) as any;
  // Pitted and grainy to the touch: the same scan as relief.
  m.normalNode = bumpMap(dot(scan, vec3(0.33)), float(2.5)) as any;
  return m;
}

function scree(t: ForestTextures, tier: QualityTier, made: Made) {
  const rand = mulberry32(4711);
  const material = screeMaterial(t);
  made.disposables.push(material);
  const kinds = [screeGeometry(1), screeGeometry(2), screeGeometry(3)];
  const per = kinds.map(() => [] as THREE.Matrix4[]);
  const count = tier === "low" ? 120 : 380;
  for (let n = 0, tries = 0; n < count && tries < count * 20; tries++) {
    const x = -22 + rand() * 45;
    let z = -3;
    for (; z < 6 && !beforeFace(x, z, 0); z += 0.1);
    // Most right at the foot, a long tail out from it.
    z += Math.pow(rand(), 2.2) * 5;
    if (onPath(x, z, -1.6)) continue;
    const s = 0.06 + Math.pow(rand(), 3) * 0.4;
    per[n % kinds.length].push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, forestGround(x, z) - s * 0.25, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 6.28, rand() * 6.28, rand() * 6.28)),
        new THREE.Vector3(s * (0.8 + rand() * 0.5), s, s * (0.8 + rand() * 0.5))
      )
    );
    n++;
  }
  kinds.forEach((g, k) => {
    place(made, g, material, per[k], false, 22, undefined, 24);
    made.disposables.push(g);
  });
}

// The scanned woodland plant: broad heart-shaped leaves on soft stems, in drifts at the edge and in under the trees.
function woodlandPlants(t: ForestTextures, sun: THREE.Vector3, tier: QualityTier, made: Made) {
  const rand = mulberry32(330);
  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    roughness: 0.75
  });
  material.lightsNode = outdoorLights;
  const leaf = texture(t.shrub.diffuse, uv()) as any;
  material.colorNode = leaf.rgb.mul(vec3(0.62, 0.7, 0.5)).mul(smoothstep(0, 0.12, positionGeometry.y).mul(0.5).add(0.5)) as any;
  material.opacityNode = smoothstep(0.015, 0.05, leaf.r.max(leaf.g).max(leaf.b)) as any;
  material.normalNode = normalMap(texture(t.shrub.normal, uv())) as any;
  material.emissiveNode = leaf.rgb.mul(vec3(0.6, 0.75, 0.3)).mul(backlit(sun).mul(0.7)) as any;
  const sway = sin(canopyTime.mul(1.4).add(positionWorld.x.mul(3)).add(positionWorld.z.mul(2.3))).mul(positionLocal.y.mul(0.06)) as any;
  material.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.6))) as any;
  made.disposables.push(material);
  const count = tier === "low" ? 30 : tier === "medium" ? 100 : 150;
  const per = t.shrub.pieces.map(() => [] as THREE.Matrix4[]);
  // In drifts at the clearing's edge and in under the trees: each spot a few plants together.
  for (const s of spotsFor(333, count, -0.5, 12, 0.6, 30)) {
    const n = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const x = s.x + (rand() - 0.5) * 1.2;
      const z = s.z + (rand() - 0.5) * 1.2;
      if (onPath(x, z, 0.8)) continue;
      const scale = 1.1 + rand() * 1.0;
      per[Math.floor(rand() * per.length)].push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(x, forestGround(x, z) - 0.02, z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * 6.28, 0)),
          new THREE.Vector3(scale, scale, scale)
        )
      );
    }
  }
  per.forEach((list, k) => place(made, t.shrub.pieces[k], material, list, false, 26));
}

// Bushes of the understorey: clumps of the canopy's leaf cards close to the ground, built as crowns with no trunk.
export function bushCrowns(): { spot: TreeSpot; clumps: Crown[] }[] {
  const rand = mulberry32(5151);
  return spotsFor(5150, 80, 1.2, 18, 1, 40).map((s, k) => {
    const y = forestGround(s.x, s.z);
    const clumps: Crown[] = [];
    // Loose and uneven: several small clumps strung out at different heights, never one ball.
    const n = 3 + Math.floor(rand() * 4);
    const size = 0.5 + rand() * 0.5;
    for (let c = 0; c < n; c++)
      clumps.push({
        at: new THREE.Vector3(s.x + (rand() - 0.5) * size * 3, y + size * (0.4 + rand() * 1.4), s.z + (rand() - 0.5) * size * 3),
        r: size * (0.45 + rand() * 0.4)
      });
    return {
      spot: {
        x: s.x,
        y,
        z: s.z,
        height: 2,
        radius: 0,
        lean: [0, 0],
        seed: 9000 + k,
        detail: 2
      },
      clumps
    };
  });
}

export function buildGrowth(t: ForestTextures, sun: THREE.Vector3, tier: QualityTier): Made {
  const made: Made = { group: new THREE.Group(), disposables: [] };
  made.group.name = "forest-growth";
  const counts = grass(sun, tier, made);
  ferns(sun, tier, made);
  woodlandPlants(t, sun, tier, made);
  deadwood(t, made);
  boulders(t, made);
  scree(t, tier, made);
  const litter = buildLitter(t, sun, tier, made);
  made.counts = { ...counts, ...litter };
  return made;
}
