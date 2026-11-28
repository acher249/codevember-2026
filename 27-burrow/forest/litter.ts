import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  attribute,
  bumpMap,
  cameraPosition,
  dot,
  float,
  hash,
  instanceIndex,
  mix,
  mx_noise_float,
  normalLocal,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3
} from "three/tsl";
import { mulberry32 } from "../../shared/engine/random";
import type { QualityTier } from "../../shared/engine/types";
import { noise3 } from "../field";
import type { ForestTextures } from "./assets";
import { jitterGrid, place, tierShare, type Made } from "./cells";
import { dampAt, grassAt, pathAt, shadeAt } from "./cover";
import { beforeFace, forestTrees } from "./layout";
import { outdoorLights } from "./lights";
import { clearingEdge, forestGround, noise, onPath } from "./terrain";
import { canopyTime } from "./trees";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What lies on and comes up through the forest floor, besides the grass and ferns (plants.ts): last year's leaves of
// several trees, twigs and drifts of pine needles, pebbles, cobbles and half-buried boulders with moss on their tops,
// wildflowers in small clusters out in the sun, clover in the sward, and mushrooms round the feet of the trees.
//
// All of it is instanced in floor cells (cells.ts) and placed once, from fixed seeds, by the cover grid (cover.ts), so it
// agrees with the floor's colour. The small things do not cast shadows; past `reach - 6` m they sink into the floor,
// whole, so a cell hidden at `reach` has nothing left to vanish. (Only things that cast no shadow may sink: the sun's
// shadow camera would read the sink from its own position.)

const sinkPast = (reach: number, depth: number) => smoothstep(reach - 6, reach - 1, positionWorld.sub(cameraPosition).length()).mul(depth) as any;

// Leaves and petals lit through from behind when the sun is beyond them.
const backlit = (sun: THREE.Vector3) => pow(dot(positionWorld.sub(cameraPosition).normalize(), vec3(sun.x, sun.y, sun.z)).max(0), float(5)) as any;

// Whether a stone of this size would stand in a trunk or its flared foot.
const nearTrunk = (x: number, z: number, size: number) => forestTrees().trees.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < (t.radius * 2.3 + size) ** 2);

// Neither in the dig at the face's foot nor on the way to it, where a stone would stand in front of the eye.
const playClear = (x: number, z: number, room = 0) => (Math.abs(x - 0.6) < 3.6 + room && z < 6.5 + room) || onPath(x, z, -1 + room);

const lying = (x: number, z: number, y: number, turn: number, tilt: number, sx: number, sy: number, sz: number, rand: () => number) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * tilt, turn, (rand() - 0.5) * tilt)), new THREE.Vector3(sx, sy, sz));

// ---- Leaves ----------------------------------------------------------------------------------------------------------

// A fallen leaf: a square card cupped a little and curled at its tip; which tree it fell from (its outline: oval, oak,
// maple, willow, round and toothed) is cut in the shader by the leaf's own hash, so one mesh carries them all.
function leafGeometry() {
  const g = new THREE.PlaneGeometry(1, 1, 2, 3);
  g.rotateX(-Math.PI / 2);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    p.setY(i, x * x * 0.3 + Math.max(0, -z - 0.15) ** 2 * 0.6);
  }
  g.computeVertexNormals();
  return g;
}

const LEAF_REACH = 19;
function leaves(tier: QualityTier, made: Made) {
  const geometry = leafGeometry();
  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    roughness: 0.8
  });
  material.lightsNode = outdoorLights;
  const at = uv() as any;
  const x = at.x.sub(0.5).mul(2) as any;
  const across = abs(x) as any;
  const along = at.y as any;
  const own = hash(instanceIndex.toFloat().mul(3.1)) as any;
  const shape = hash(instanceIndex.toFloat().mul(7.3).add(1.7)) as any;
  const body = pow(float(1).sub(pow(abs(along.mul(2).sub(1)), float(2))), float(0.6)) as any;
  const oval = body.mul(0.62) as any;
  // Oak: the oval with rounded lobes down each side.
  const oak = body.mul(
    abs(sin(along.mul(Math.PI * 4.5)))
      .mul(0.22)
      .add(0.45)
  ) as any;
  // Maple: five pointed lobes round a point near the stalk.
  const dy = along.sub(0.38).mul(2) as any;
  const angle = atan(x, dy) as any;
  const lobes = pow(abs(sin(angle.mul(2.5).add(Math.PI / 2))), float(0.7))
    .mul(0.5)
    .add(0.45) as any;
  const maple = smoothstep(0.05, 0, vec2(x, dy).length().sub(lobes.mul(0.95))).mul(smoothstep(-1, -0.7, dy)) as any;
  // Willow: long and narrow. Round: wider, its edge toothed.
  const willow = body.mul(0.3) as any;
  const round = pow(float(1).sub(pow(abs(along.mul(2).sub(1)), float(2))), float(0.45)).mul(float(0.78).add(abs(along.mul(22).fract().sub(0.5)).mul(0.1))) as any;
  const half = select(shape.lessThan(0.3), oval, select(shape.lessThan(0.52), oak, select(shape.lessThan(0.66), willow, round))) as any;
  const outline = smoothstep(half.add(0.02), half.sub(0.04), across) as any;
  material.opacityNode = select(shape.greaterThan(0.86), maple, outline) as any;
  // Mostly browns, then ochre, a few rust-red and still-yellow; greyed and dark where they have lain longest.
  const tone = hash(instanceIndex.toFloat().mul(5.9).add(3.3)) as any;
  const brown = mix(vec3(0.16, 0.09, 0.045), vec3(0.33, 0.19, 0.075), smoothstep(0.1, 0.5, own)) as any;
  const bright = mix(mix(vec3(0.46, 0.3, 0.09), vec3(0.45, 0.12, 0.045), smoothstep(0.55, 0.7, tone)), vec3(0.62, 0.48, 0.1), smoothstep(0.82, 0.95, tone)) as any;
  const base = mix(brown, bright, smoothstep(0.62, 0.75, own)) as any;
  const aged = mix(base, vec3(dot(base, vec3(0.33))).mul(vec3(1.05, 0.95, 0.85)), smoothstep(0.65, 0.95, hash(instanceIndex.toFloat().mul(1.3))).mul(0.6)) as any;
  // The midrib and side veins, a touch paler; darker toward the stalk.
  const rib = smoothstep(0.06, 0, across).mul(0.25) as any;
  const veins = smoothstep(0.1, 0, abs(along.sub(across.mul(0.45)).mul(9).fract().sub(0.5))).mul(0.08) as any;
  material.colorNode = aged.mul(float(1).add(rib).add(veins)).mul(smoothstep(0, 0.3, along).mul(0.3).add(0.7)) as any;
  material.positionNode = positionLocal.sub(vec3(0, sinkPast(LEAF_REACH, 0.15), 0)) as any;
  const matrices: THREE.Matrix4[] = [];
  // Over all the floor near the clearing, thickest under the crowns, thin in the sward (where the grass hides them anyway),
  // a few blown over the trodden way.
  jitterGrid(808, 0.3 / Math.sqrt(tierShare(tier)), -30, 31, -1, 42, (x, z, rand) => {
    const keep = 0.18 + shadeAt(x, z) * 0.8 + (1 - grassAt(x, z)) * 0.35 - pathAt(x, z) * 0.25;
    if (rand() > keep || !beforeFace(x, z, 0.2) || clearingEdge(x, z) > 12) return;
    const s = 0.06 + rand() * 0.06;
    matrices.push(lying(x, z, forestGround(x, z) + 0.012, rand() * 6.28, 0.5, s, s, s, rand));
  });
  place(made, geometry, material, matrices, false, LEAF_REACH);
  made.disposables.push(geometry, material);
  return matrices.length;
}

// ---- Twigs and needles -----------------------------------------------------------------------------------------------

// A tube along a line of points, `sides` round, wound so its faces look outward (ring a → a+1 runs N → B with B = T × N;
// the quad (i, a), (i, a+1), (i+1, a) faces out), each ring wrapped without a seam vertex, so its normals are smooth.
function tube(points: THREE.Vector3[], radii: number[], sides: number) {
  const position: number[] = [];
  const index: number[] = [];
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const ref = new THREE.Vector3().subVectors(points[points.length - 1], points[0]).normalize();
  const helper = Math.abs(ref.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  N.crossVectors(ref, helper).normalize();
  points.forEach((p, i) => {
    T.subVectors(points[Math.min(points.length - 1, i + 1)], points[Math.max(0, i - 1)]).normalize();
    // One reference for the whole tube, made square to this point's tangent.
    const n = N.clone().addScaledVector(T, -N.dot(T)).normalize();
    B.crossVectors(T, n);
    for (let a = 0; a < sides; a++) {
      const t = (a / sides) * Math.PI * 2;
      position.push(p.x + (n.x * Math.cos(t) + B.x * Math.sin(t)) * radii[i], p.y + (n.y * Math.cos(t) + B.y * Math.sin(t)) * radii[i], p.z + (n.z * Math.cos(t) + B.z * Math.sin(t)) * radii[i]);
    }
  });
  for (let i = 0; i < points.length - 1; i++)
    for (let a = 0; a < sides; a++) {
      const v00 = i * sides + a;
      const v01 = i * sides + ((a + 1) % sides);
      const v10 = v00 + sides;
      const v11 = v01 + sides;
      index.push(v00, v01, v10, v01, v11, v10);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// A dead twig a metre long at scale 1 (scaled down when placed): crooked, tapering, with a side shoot, lying flat.
function twigGeometry(seed: number) {
  const rand = mulberry32(seed);
  const main: THREE.Vector3[] = [];
  let a = 0;
  for (let i = 0; i <= 5; i++) {
    a += (rand() - 0.5) * 0.5;
    const prev = main[i - 1] ?? new THREE.Vector3(-0.5, 0, 0);
    main.push(i === 0 ? prev : prev.clone().add(new THREE.Vector3(Math.cos(a) * 0.2, (rand() - 0.3) * 0.015, Math.sin(a) * 0.2)));
  }
  const r = main.map((_, i) => 0.022 * (1 - i * 0.13));
  const from = main[2];
  const side = (rand() < 0.5 ? 1 : -1) * (0.5 + rand() * 0.4);
  const shoot = [0, 1, 2, 3].map((i) => from.clone().add(new THREE.Vector3(Math.cos(a + side) * 0.12 * i, 0.01 * i, Math.sin(a + side) * 0.12 * i)));
  const parts = [tube(main, r, 4), tube(shoot, [0.012, 0.01, 0.008, 0.004], 3)];
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

// A drift of pine needles: a few dozen thin flat strips crossed every way, a hand's width across.
function needleGeometry(seed: number) {
  const rand = mulberry32(seed);
  const position: number[] = [];
  const index: number[] = [];
  for (let n = 0; n < 26; n++) {
    const a = rand() * Math.PI;
    const d = Math.sqrt(rand()) * 0.09;
    const c = rand() * Math.PI * 2;
    const cx = Math.cos(c) * d;
    const cz = Math.sin(c) * d;
    const len = 0.035 + rand() * 0.035;
    const w = 0.0016;
    const y = rand() * 0.008;
    const ux = Math.cos(a) * len;
    const uz = Math.sin(a) * len;
    const vx = -Math.sin(a) * w;
    const vz = Math.cos(a) * w;
    const v = position.length / 3;
    position.push(cx - ux - vx, y, cz - uz - vz, cx - ux + vx, y, cz - uz + vz, cx + ux + vx, y + 0.003, cz + uz + vz, cx + ux - vx, y + 0.003, cz + uz - vz);
    index.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const TWIG_REACH = 18;
function twigsAndNeedles(tier: QualityTier, made: Made) {
  const share = tierShare(tier);
  // Bark-grey to brown by the instance colour, paler where the bark has gone, darker underneath.
  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    roughness: 0.9
  });
  material.lightsNode = outdoorLights;
  const grain = mx_noise_float(positionGeometry.mul(vec3(30, 30, 30)))
    .mul(0.18)
    .add(1) as any;
  material.colorNode = vec3(0.3, 0.24, 0.18).mul(grain).mul(normalLocal.y.mul(0.25).add(0.75)) as any;
  material.positionNode = positionLocal.sub(vec3(0, sinkPast(TWIG_REACH, 0.15), 0)) as any;
  made.disposables.push(material);
  const twigs = [twigGeometry(1)];
  const needles = needleGeometry(4);
  const per = twigs.map(() => [] as THREE.Matrix4[]);
  const twigTint = twigs.map(() => [] as THREE.Color[]);
  const drifts: THREE.Matrix4[] = [];
  const needleTint: THREE.Color[] = [];
  // Not on Low: the leaves carry the litter there.
  if (tier !== "low")
    jitterGrid(1701, 0.9 / Math.sqrt(share), -28, 29, -1, 40, (x, z, rand) => {
      // Under the trees mostly; few in the open sward.
      if (rand() > 0.15 + shadeAt(x, z) * 0.8 - grassAt(x, z) * 0.1 || !beforeFace(x, z, 0.2) || clearingEdge(x, z) > 12 || pathAt(x, z) > 0.4) return;
      const k = Math.floor(rand() * twigs.length);
      const s = 0.18 + rand() * rand() * 0.5;
      // Turned over half the time (the side shoot to the other side), so one twig serves as two: a half turn about its
      // length, not a mirror. (A mirrored instance draws with its normals inverted: three turns the front face per mesh,
      // never per instance.)
      const turn = rand() * 6.28;
      const long = s * (0.8 + rand() * 0.4);
      const over = rand() < 0.5;
      const m = lying(x, z, forestGround(x, z) + 0.008, turn, 0.12, long, s, s, rand);
      per[k].push(over ? m.multiply(new THREE.Matrix4().makeRotationX(Math.PI)) : m);
      const v = 0.75 + rand() * 0.5;
      const grey = rand();
      twigTint[k].push(new THREE.Color(v * (1 - grey * 0.1), v * (1 - grey * 0.05), v * (1 + grey * 0.1)));
    });
  // Needles in drifts where a few pines stand among the broadleaves (noise picks the drifts).
  if (tier !== "low")
    jitterGrid(1703, 0.55 / Math.sqrt(share), -28, 29, -1, 40, (x, z, rand) => {
      const drift = noise(x * 0.09 + 21, z * 0.09 - 5);
      if (drift < 0.15 || rand() > (drift - 0.15) * 2.2 * (0.3 + shadeAt(x, z)) || !beforeFace(x, z, 0.3) || clearingEdge(x, z) > 12 || pathAt(x, z) > 0.3) return;
      const s = 0.9 + rand() * 0.6;
      drifts.push(lying(x, z, forestGround(x, z) + 0.006, rand() * 6.28, 0.15, s, 1, s, rand));
      const v = 0.95 + rand() * 0.3;
      // Rust-brown needles, some fresher and paler.
      needleTint.push(new THREE.Color(v * 1.9, v * 1.05, v * 0.42));
    });
  twigs.forEach((g, k) => place(made, g, material, per[k], false, TWIG_REACH, twigTint[k]));
  place(made, needles, material, drifts, false, TWIG_REACH, needleTint);
  made.disposables.push(...twigs, needles);
  return {
    twigs: per.reduce((n, l) => n + l.length, 0),
    needles: drifts.length
  };
}

// ---- Stones ----------------------------------------------------------------------------------------------------------

// A stone: an icosphere welded (so its normals are smooth), cut by a few planes where it split, its surface lumpy by noise,
// flattened, and lowered so y = 0 is the line where it meets the ground (`buried` of its height below it).
function stoneGeometry(seed: number, detail: number, buried: number, flat = 0.62) {
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute("normal");
  ico.deleteAttribute("uv");
  const g = mergeVertices(ico, 1e-4);
  ico.dispose();
  const p = g.getAttribute("position");
  const rand = mulberry32(seed);
  const cuts = Array.from({ length: 3 + Math.floor(rand() * 3) }, () => ({
    n: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
    d: 0.62 + rand() * 0.25
  }));
  const stretch = new THREE.Vector3(0.85 + rand() * 0.4, flat * (0.85 + rand() * 0.3), 0.85 + rand() * 0.3);
  const o = rand() * 100;
  const v = new THREE.Vector3();
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    let r = 1 + noise3(v.x * 1.6 + o, v.y * 1.6, v.z * 1.6) * 0.16 + noise3(v.x * 4 + o, v.y * 4, v.z * 4) * 0.05;
    // Flat broken faces where a plane cuts it.
    for (const c of cuts) r = Math.min(r, c.d / Math.max(0.3, v.dot(c.n)));
    v.multiplyScalar(r).multiply(stretch);
    p.setXYZ(i, v.x, v.y, v.z);
    low = Math.min(low, v.y);
    high = Math.max(high, v.y);
  }
  g.translate(0, -(low + (high - low) * buried), 0);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// Weathered stone, greyer than the face it fell from: the rock scan's grain seen along the world's axes, each stone its
// own tone by its hash, moss in cushions over its top (more on some, none on others), a little lichen, and dark and
// earthy where it goes into the ground.
function stoneMaterial(t: ForestTextures) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  m.lightsNode = outdoorLights;
  const n = normalWorld.abs() as any;
  const w = n.pow(vec3(4)).div(n.pow(vec3(4)).dot(vec3(1)).add(1e-4)) as any;
  const pw = positionWorld.mul(1.2) as any;
  const scan = texture(t.stone, pw.zy).rgb.mul(w.x).add(texture(t.stone, pw.xz).rgb.mul(w.y)).add(texture(t.stone, pw.xy).rgb.mul(w.z)) as any;
  const grain = dot(scan, vec3(0.33)) as any;
  const pick = hash(instanceIndex.toFloat().mul(4.7).add(0.3)) as any;
  const tone = mix(mix(vec3(0.5, 0.47, 0.42), vec3(0.62, 0.52, 0.4), smoothstep(0.3, 0.6, pick)), vec3(0.4, 0.38, 0.36), smoothstep(0.75, 0.95, pick)) as any;
  const stone = tone.mul(grain.mul(1.3).add(0.35)).mul(mx_noise_float(positionWorld.mul(2.3)).mul(0.12).add(0.95)) as any;
  // Moss: thick on the tops of some stones, a few cushions on others, by each stone's own amount.
  const mossy = hash(instanceIndex.toFloat().mul(2.9).add(8.1)) as any;
  const patches = mx_noise_float(positionWorld.mul(2.4))
    .mul(0.55)
    .add(mx_noise_float(positionWorld.mul(9)).mul(0.22)) as any;
  const cover = smoothstep(0.42, 0.7, normalWorld.y.add(patches).add(mossy.mul(0.75)).sub(0.55)) as any;
  const mossTex = texture(t.moss, positionWorld.xz.mul(2.2)).rgb as any;
  const moss = mossTex.mul(mix(vec3(1.3, 1.05, 1.6), vec3(1.75, 1.2, 1.4), mx_noise_float(positionWorld.mul(0.9)).mul(0.5).add(0.5))) as any;
  const lichen = smoothstep(0.52, 0.58, mx_noise_float(positionWorld.mul(11).add(17))).mul(float(1).sub(cover)) as any;
  // Into the ground: soil-stained and dark below the line it was bedded at.
  const contact = smoothstep(-0.12, 0.25, positionGeometry.y) as any;
  const soil = vec3(0.16, 0.12, 0.085) as any;
  const surface = mix(mix(stone, vec3(0.6, 0.62, 0.52), lichen.mul(0.5)), moss, cover) as any;
  m.colorNode = mix(soil, surface, contact.mul(0.7).add(0.3)).mul(contact.mul(0.45).add(0.55)) as any;
  m.roughnessNode = mix(float(0.86), float(1), cover) as any;
  m.normalNode = bumpMap(grain.mul(float(1).sub(cover.mul(0.7))).add(mossTex.g.mul(cover).mul(0.6)), float(2)) as any;
  return m;
}

// Pebbles: seven stones of a patch together, a few welded icospheres and a few plain ones, coloured each its own by a
// seed per pebble.
function pebbleGeometry(seed: number) {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 6; k++) {
    const g = stoneGeometry(seed * 13 + k, k < 1 ? 1 : 0, 0.3, 0.55 + rand() * 0.25);
    const s = 0.012 + rand() * rand() * 0.04;
    g.scale(s, s, s);
    g.rotateY(rand() * 6.28);
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * 0.35;
    g.translate(Math.cos(a) * d, 0, Math.sin(a) * d);
    g.setAttribute("aSeed", new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count).fill(rand()), 1));
    parts.push(g);
  }
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

const PEBBLE_REACH = 15;
const COBBLE_REACH = 40;
function stones(t: ForestTextures, tier: QualityTier, made: Made) {
  const share = tierShare(tier);
  const material = stoneMaterial(t);
  made.disposables.push(material);
  // Cobbles in three shapes (welded icospheres of 162 points), boulders in two (642 points).
  const cobbles = [stoneGeometry(31, 2, 0.35), stoneGeometry(33, 2, 0.4, 0.75)];
  const boulders = [stoneGeometry(41, 3, 0.4, 0.62)];
  const cobblePer = cobbles.map(() => [] as THREE.Matrix4[]);
  const boulderPer = boulders.map(() => [] as THREE.Matrix4[]);
  const rand = mulberry32(2203);
  const set = (x: number, z: number, s: number) => {
    // Sunk a little more or less than its shape was bedded, and tilted with no regard for the others.
    const y = forestGround(x, z) - s * (0.02 + rand() * 0.12);
    const m = lying(x, z, y, rand() * 6.28, 0.35, s * (0.85 + rand() * 0.3), s * (0.8 + rand() * 0.4), s * (0.85 + rand() * 0.3), rand);
    if (s > 0.55) boulderPer[Math.floor(rand() * boulders.length)].push(m);
    else cobblePer[Math.floor(rand() * cobbles.length)].push(m);
  };
  // In outcrops: a stone of some size and smaller ones round it, more of them where the ground is rocky (a noise of its
  // own) and along the face's foot; small and well sunk inside the clearing, bigger in under the trees.
  jitterGrid(2201, 1.9 / Math.sqrt(share), -30, 31, -1, 44, (x, z, rand2) => {
    const edge = clearingEdge(x, z);
    const rocky = noise(x * 0.07 - 13, z * 0.07 + 2) * 0.6 + 0.35 + dampAt(x, z) * 0.25;
    if (rand2() > rocky || edge > 14 || !beforeFace(x, z, 0.6) || playClear(x, z)) return;
    // Small in the clearing, where you walk; up to boulders only a pace or two into the trees.
    const big = edge < -1.5 ? 0.14 + rand2() * 0.22 : edge < 1.5 ? 0.2 + rand2() * 0.25 : 0.22 + rand2() * (rand2() < 0.3 ? 1.3 : 0.4);
    if (nearTrunk(x, z, big)) return;
    set(x, z, big);
    const n = Math.floor(rand2() * 8);
    for (let k = 0; k < n; k++) {
      const a = rand2() * 6.28;
      const d = big * (0.9 + rand2() * 1.6);
      const cx = x + Math.cos(a) * d;
      const cz = z + Math.sin(a) * d;
      if (playClear(cx, cz) || !beforeFace(cx, cz, 0.3)) continue;
      const s = big * (0.25 + rand2() * 0.45);
      if (!nearTrunk(cx, cz, s)) set(cx, cz, s);
    }
  });
  cobbles.forEach((g, k) => place(made, g, material, cobblePer[k], tier !== "low", COBBLE_REACH, undefined, 20));
  boulders.forEach((g, k) => place(made, g, material, boulderPer[k], true, 60, undefined, 28));
  // Pebbles everywhere, in patches; thickest near the face's foot and where the sward thins, and off the trodden way's
  // middle. Their own plain material: too small for the scan to show.
  const pebbles = [pebbleGeometry(51)];
  const small = new THREE.MeshStandardNodeMaterial({ roughness: 0.78 });
  small.lightsNode = outdoorLights;
  const seed = attribute("aSeed", "float") as any;
  const own = hash(seed.mul(91.7).add(instanceIndex.toFloat().mul(0.37))) as any;
  const pebble = mix(mix(vec3(0.3, 0.28, 0.26), vec3(0.42, 0.35, 0.26), smoothstep(0.35, 0.6, own)), vec3(0.17, 0.16, 0.15), smoothstep(0.8, 0.95, own)) as any;
  const under = smoothstep(-0.01, 0.015, positionGeometry.y) as any;
  small.colorNode = pebble.mul(mx_noise_float(positionWorld.mul(60)).mul(0.12).add(0.95)).mul(under.mul(0.5).add(0.5)) as any;
  small.positionNode = positionLocal.sub(vec3(0, sinkPast(PEBBLE_REACH, 0.12), 0)) as any;
  made.disposables.push(small);
  const patchPer = pebbles.map(() => [] as THREE.Matrix4[]);
  if (tier !== "low")
    jitterGrid(2301, 0.75 / Math.sqrt(share), -26, 27, -1, 38, (x, z, rand2) => {
      const keep = 0.2 + dampAt(x, z) * 0.5 + (1 - grassAt(x, z)) * 0.3 - pathAt(x, z) * 0.6;
      if (rand2() > keep || !beforeFace(x, z, 0.1) || clearingEdge(x, z) > 11) return;
      const s = 0.7 + rand2() * 0.8;
      patchPer[Math.floor(rand2() * pebbles.length)].push(lying(x, z, forestGround(x, z), rand2() * 6.28, 0.1, s, s, s, rand2));
    });
  pebbles.forEach((g, k) => place(made, g, small, patchPer[k], false, PEBBLE_REACH));
  made.disposables.push(...cobbles, ...boulders, ...pebbles);
  return {
    cobbles: cobblePer.reduce((n, l) => n + l.length, 0),
    boulders: boulderPer.reduce((n, l) => n + l.length, 0),
    pebbles: patchPer.reduce((n, l) => n + l.length, 0) * 6
  };
}

// ---- Flowers and clover ----------------------------------------------------------------------------------------------

// A cluster of wildflowers: seven stems of different heights, each with a head of five or six petals round a raised eye
// and two leaves at its foot. `aPart` tells the shader stem (0), petal (1), eye (2).
function flowerGeometry(seed: number) {
  const rand = mulberry32(seed);
  const position: number[] = [];
  const part: number[] = [];
  const up: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, kind: number, h: [number, number, number]) => {
    position.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    part.push(kind, kind, kind);
    up.push(...h);
  };
  for (let f = 0; f < 7; f++) {
    const a0 = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * 0.16;
    const foot = new THREE.Vector3(Math.cos(a0) * d, 0, Math.sin(a0) * d);
    const h = 0.12 + rand() * 0.22;
    const lean = new THREE.Vector3((rand() - 0.5) * 0.08, 0, (rand() - 0.5) * 0.08);
    const head = foot.clone().add(lean).setY(h);
    const mid = foot
      .clone()
      .addScaledVector(lean, 0.35)
      .setY(h * 0.5);
    const w = 0.0022;
    const side = new THREE.Vector3(Math.cos(a0 + 1.57) * w, 0, Math.sin(a0 + 1.57) * w);
    // The stem, two quads.
    for (const [p, q, hp, hq] of [
      [foot, mid, 0, 0.5],
      [mid, head, 0.5, 1]
    ] as [THREE.Vector3, THREE.Vector3, number, number][]) {
      tri(p.clone().sub(side), p.clone().add(side), q.clone().add(side), 0, [hp, hp, hq]);
      tri(p.clone().sub(side), q.clone().add(side), q.clone().sub(side), 0, [hp, hq, hq]);
    }
    // Two narrow leaves at the foot.
    for (let l = 0; l < 2; l++) {
      const a = a0 + l * Math.PI + (rand() - 0.5);
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const across = new THREE.Vector3(-out.z, 0, out.x).multiplyScalar(0.007);
      const len = 0.05 + rand() * 0.04;
      const tip = foot
        .clone()
        .addScaledVector(out, len)
        .setY(len * 0.6);
      const base = foot.clone().setY(0.005);
      const midL = base
        .clone()
        .addScaledVector(out, len * 0.5)
        .setY(len * 0.45);
      tri(base, midL.clone().add(across), tip, 0, [0, 0.2, 0.3]);
      tri(base, tip, midL.clone().sub(across), 0, [0, 0.3, 0.2]);
    }
    // The head: petals splayed up and out round the eye.
    const petals = rand() < 0.5 ? 5 : 6;
    const r = 0.011 + rand() * 0.012;
    const tilt = new THREE.Vector3((rand() - 0.5) * 0.4, 1, (rand() - 0.5) * 0.4).normalize();
    const e1 = new THREE.Vector3().crossVectors(tilt, new THREE.Vector3(1, 0, 0)).normalize();
    const e2 = new THREE.Vector3().crossVectors(tilt, e1);
    const turn = rand() * 6.28;
    for (let k = 0; k < petals; k++) {
      const a = turn + (k / petals) * Math.PI * 2;
      const dir = e1.clone().multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
      const perp = e1.clone().multiplyScalar(-Math.sin(a)).addScaledVector(e2, Math.cos(a));
      const base = head.clone().addScaledVector(dir, r * 0.15);
      const tip = head
        .clone()
        .addScaledVector(dir, r)
        .addScaledVector(tilt, r * 0.25);
      const midP = head
        .clone()
        .addScaledVector(dir, r * 0.6)
        .addScaledVector(tilt, r * 0.12);
      const wP = r * (petals === 5 ? 0.34 : 0.28);
      tri(base, midP.clone().addScaledVector(perp, wP), tip, 1, [1, 1, 1]);
      tri(base, tip, midP.clone().addScaledVector(perp, -wP), 1, [1, 1, 1]);
    }
    const eye = head.clone().addScaledVector(tilt, r * 0.22);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const b = ((k + 1) / 4) * Math.PI * 2;
      const pa = head
        .clone()
        .addScaledVector(e1, Math.cos(a) * r * 0.22)
        .addScaledVector(e2, Math.sin(a) * r * 0.22);
      const pb = head
        .clone()
        .addScaledVector(e1, Math.cos(b) * r * 0.22)
        .addScaledVector(e2, Math.sin(b) * r * 0.22);
      tri(pa, pb, eye, 2, [1, 1, 1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute("aUp", new THREE.Float32BufferAttribute(up, 1));
  g.computeVertexNormals();
  return g;
}

// A patch of clover: trefoils on short unseen stalks, each leaflet a heart cut in the shader with a pale chevron across it.
function cloverGeometry(seed: number) {
  const rand = mulberry32(seed);
  const position: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (let k = 0; k < 14; k++) {
    const a0 = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * 0.16;
    const cx = Math.cos(a0) * d;
    const cz = Math.sin(a0) * d;
    const y = 0.025 + rand() * 0.06;
    const size = 0.016 + rand() * 0.01;
    const turn = rand() * 6.28;
    for (let l = 0; l < 3; l++) {
      const a = turn + (l / 3) * Math.PI * 2;
      const out = new THREE.Vector3(Math.cos(a), 0.25, Math.sin(a)).normalize();
      const across = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      const o = new THREE.Vector3(cx, y, cz);
      const v = position.length / 3;
      for (const [s, t] of [
        [0, -1],
        [0, 1],
        [1, 1],
        [1, -1]
      ]) {
        const p = o
          .clone()
          .addScaledVector(out, s * size * 1.1)
          .addScaledVector(across, t * size * 0.55);
        position.push(p.x, p.y, p.z);
        uvs.push(s, t * 0.5 + 0.5);
      }
      index.push(v, v + 2, v + 1, v, v + 3, v + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const FLOWER_REACH = 24;
const CLOVER_REACH = 15;
function flowersAndClover(sun: THREE.Vector3, tier: QualityTier, made: Made) {
  const share = tierShare(tier);
  const sway = (amount: number) => sin(canopyTime.mul(1.5).add(positionWorld.x.mul(1.7)).add(positionWorld.z.mul(1.1))).mul(amount) as any;
  // Flowers: each cluster one kind, by its hash: white with a yellow eye, buttercup yellow, violet-blue, campion pink.
  const flowers = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    roughness: 0.6
  });
  flowers.lightsNode = outdoorLights;
  const kind = hash(instanceIndex.toFloat().mul(6.1).add(2.2)) as any;
  const petal = select(
    kind.lessThan(0.35),
    vec3(0.82, 0.8, 0.74),
    select(kind.lessThan(0.62), vec3(0.85, 0.62, 0.06), select(kind.lessThan(0.82), vec3(0.36, 0.3, 0.7), vec3(0.78, 0.32, 0.5)))
  ) as any;
  const eye = select(kind.lessThan(0.35), vec3(0.85, 0.6, 0.05), vec3(0.5, 0.42, 0.1)) as any;
  const part = attribute("aPart", "float") as any;
  const height = attribute("aUp", "float") as any;
  const stem = mix(vec3(0.07, 0.1, 0.03), vec3(0.16, 0.24, 0.07), height) as any;
  const colour = select(part.lessThan(0.5), stem, select(part.lessThan(1.5), petal, eye)) as any;
  flowers.colorNode = colour;
  flowers.emissiveNode = colour.mul(backlit(sun).mul(0.6)) as any;
  const s = sway(0.03).mul(height.mul(height)) as any;
  flowers.positionNode = positionLocal.add(vec3(s, sinkPast(FLOWER_REACH, 0.45).mul(-1), s.mul(0.6))) as any;
  // Clover: three hearts a trefoil, each with the pale chevron across its middle.
  const clover = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    roughness: 0.7
  });
  clover.lightsNode = outdoorLights;
  const at = uv() as any;
  const across = abs(at.y.sub(0.5)).mul(2) as any;
  // A heart: widest toward its outer end, notched there, narrowing to the stalk.
  const halfWidth = pow(at.x, float(0.6)).mul(float(1).sub(smoothstep(0.75, 1, at.x).mul(0.35))) as any;
  const notch = smoothstep(0.12, 0.02, across).mul(smoothstep(0.82, 0.98, at.x)) as any;
  clover.opacityNode = smoothstep(halfWidth.add(0.03), halfWidth.sub(0.05), across).mul(float(1).sub(notch)) as any;
  const chevron = smoothstep(0.06, 0, abs(at.x.sub(0.45).sub(across.mul(0.25)))).mul(0.5) as any;
  const leaf = mix(vec3(0.07, 0.15, 0.04), vec3(0.3, 0.36, 0.24), chevron) as any;
  clover.colorNode = leaf;
  clover.emissiveNode = leaf.mul(vec3(0.8, 1.1, 0.4)).mul(backlit(sun).mul(0.5)) as any;
  clover.positionNode = positionLocal.sub(vec3(0, sinkPast(CLOVER_REACH, 0.2), 0)) as any;
  made.disposables.push(flowers, clover);
  const flowerGeoms = [flowerGeometry(61)];
  const flowerPer = flowerGeoms.map(() => [] as THREE.Matrix4[]);
  // Out in the sun, in the sward, in drifts of their own: one kind together (a cluster's hash), more clusters where the
  // drift is.
  jitterGrid(3101, 1.0 / Math.sqrt(share), -24, 25, -1, 36, (x, z, rand) => {
    const drift = noise(x * 0.12 + 40, z * 0.12 - 8) * 0.7 + 0.4;
    const sun = 1 - shadeAt(x, z);
    if (rand() > drift * sun * grassAt(x, z) * 1.6 || pathAt(x, z) > 0.2 || onPath(x, z, -1.6) || clearingEdge(x, z) > 6) return;
    const k = Math.floor(rand() * flowerGeoms.length);
    const sc = 0.8 + rand() * 0.6;
    flowerPer[k].push(lying(x, z, forestGround(x, z) - 0.01, rand() * 6.28, 0.1, sc, sc * (0.8 + rand() * 0.4), sc, rand));
  });
  flowerGeoms.forEach((g, k) => place(made, g, flowers, flowerPer[k], false, FLOWER_REACH, undefined, 20));
  const cloverGeom = cloverGeometry(71);
  const cloverAt: THREE.Matrix4[] = [];
  const cloverTint: THREE.Color[] = [];
  if (tier !== "low")
    jitterGrid(3201, 0.7 / Math.sqrt(share), -22, 23, -1, 34, (x, z, rand) => {
      const drift = noise(x * 0.2 - 30, z * 0.2 + 12);
      if (drift < 0.05 || rand() > drift * 1.6 * grassAt(x, z) || pathAt(x, z) > 0.3 || clearingEdge(x, z) > 5) return;
      const n = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const cx = x + (rand() - 0.5) * 0.5;
        const cz = z + (rand() - 0.5) * 0.5;
        const sc = 0.8 + rand() * 0.5;
        cloverAt.push(lying(cx, cz, forestGround(cx, cz) - 0.005, rand() * 6.28, 0.1, sc, sc, sc, rand));
        const v = 0.85 + rand() * 0.3;
        cloverTint.push(new THREE.Color(v, v * (0.95 + rand() * 0.1), v));
      }
    });
  place(made, cloverGeom, clover, cloverAt, false, CLOVER_REACH, cloverTint);
  made.disposables.push(...flowerGeoms, cloverGeom);
  return {
    flowers: flowerPer.reduce((n, l) => n + l.length, 0),
    clover: cloverAt.length
  };
}

// ---- Mushrooms -------------------------------------------------------------------------------------------------------

// A troop of mushrooms, a few of different sizes together: a stem (open cylinder), a domed cap (a hemisphere flattened),
// and the gills under it (a disc facing down), all three's own primitives so their normals face out. `aPart`: stem 0,
// cap 1, gills 2.
function mushroomGeometry(seed: number) {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const tag = (g: THREE.BufferGeometry, k: number) => {
    g.deleteAttribute("uv");
    g.setAttribute("aPart", new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count).fill(k), 1));
    return g;
  };
  const n = 3 + Math.floor(rand() * 3);
  for (let k = 0; k < n; k++) {
    const R = 0.018 + rand() * 0.035;
    const h = R * (1.2 + rand() * 1.6);
    const a = rand() * 6.28;
    const d = k === 0 ? 0 : 0.03 + rand() * 0.09;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const tiltX = (rand() - 0.5) * 0.35;
    const tiltZ = (rand() - 0.5) * 0.35;
    const stem = tag(new THREE.CylinderGeometry(R * 0.22, R * 0.3, h, 7, 1, true), 0);
    stem.translate(0, h / 2 - 0.01, 0);
    const cap = tag(new THREE.SphereGeometry(R, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2), 1);
    cap.scale(1, 0.45 + rand() * 0.4, 1);
    cap.translate(0, h - 0.01, 0);
    const gills = tag(new THREE.CircleGeometry(R * 0.98, 10), 2);
    gills.rotateX(Math.PI / 2);
    gills.translate(0, h - 0.011, 0);
    for (const g of [stem, cap, gills]) {
      g.rotateX(tiltX);
      g.rotateZ(tiltZ);
      g.translate(x, 0, z);
      parts.push(g);
    }
  }
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

const MUSHROOM_REACH = 20;
function mushrooms(tier: QualityTier, made: Made) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.55 });
  material.lightsNode = outdoorLights;
  const kind = hash(instanceIndex.toFloat().mul(4.3).add(0.9)) as any;
  // Brown, tan, cream, honey; now and then a red one with white flecks.
  const cap = select(
    kind.lessThan(0.3),
    vec3(0.3, 0.18, 0.09),
    select(kind.lessThan(0.55), vec3(0.55, 0.42, 0.28), select(kind.lessThan(0.75), vec3(0.78, 0.72, 0.6), select(kind.lessThan(0.92), vec3(0.6, 0.36, 0.11), vec3(0.62, 0.07, 0.035))))
  ) as any;
  const flecks = smoothstep(0.45, 0.55, mx_noise_float(positionGeometry.mul(90))).mul(smoothstep(0.92, 0.93, kind)) as any;
  const part = attribute("aPart", "float") as any;
  // Darker on the crown of the cap, paler toward its rim.
  const capLook = mix(cap.mul(normalLocal.y.mul(-0.35).add(1.15)), vec3(0.9, 0.88, 0.82), flecks) as any;
  const stem = vec3(0.74, 0.69, 0.58).mul(smoothstep(0, 0.03, positionGeometry.y).mul(0.4).add(0.6)) as any;
  material.colorNode = select(part.lessThan(0.5), stem, select(part.lessThan(1.5), capLook, vec3(0.55, 0.47, 0.37))) as any;
  material.roughnessNode = select(part.lessThan(1.5).and(part.greaterThan(0.5)), float(0.42), float(0.8)) as any;
  material.positionNode = positionLocal.sub(vec3(0, sinkPast(MUSHROOM_REACH, 0.4), 0)) as any;
  made.disposables.push(material);
  const geoms = [mushroomGeometry(81)];
  const per = geoms.map(() => [] as THREE.Matrix4[]);
  const rand = mulberry32(8101);
  // At the feet of the trees round the clearing, in the damp of their roots; a few out on the floor in the shade.
  const share = tierShare(tier);
  for (const tree of forestTrees().trees) {
    if (tree.detail !== 2 || clearingEdge(tree.x, tree.z) > 14 || rand() > 0.75 * share + 0.1) continue;
    const troops = 1 + Math.floor(rand() * 2.5);
    for (let k = 0; k < troops; k++) {
      const a = rand() * 6.28;
      // Out past the buttresses (trees.ts flares the foot to about 2.2 radii).
      const d = tree.radius * 2.3 + 0.1 + rand() * 0.5;
      const x = tree.x + Math.cos(a) * d;
      const z = tree.z + Math.sin(a) * d;
      const s = 0.8 + rand() * 0.9;
      // Half of them a half turn round (never mirrored: a mirrored instance draws inside out, as three turns the front
      // face per mesh, not per instance).
      per[Math.floor(rand() * geoms.length)].push(lying(x, z, forestGround(x, z) - 0.01, rand() * 6.28 + (rand() < 0.5 ? Math.PI : 0), 0.15, s, s * (0.75 + rand() * 0.6), s, rand));
    }
  }
  jitterGrid(8201, 4 / Math.sqrt(share), -26, 27, 0, 38, (x, z, rand2) => {
    if (rand2() > shadeAt(x, z) * 0.6 || !beforeFace(x, z, 0.5) || onPath(x, z) || clearingEdge(x, z) > 12) return;
    const s = 0.7 + rand2() * 0.7;
    per[Math.floor(rand2() * geoms.length)].push(lying(x, z, forestGround(x, z) - 0.01, rand2() * 6.28 + (rand2() < 0.5 ? Math.PI : 0), 0.15, s, s * (0.75 + rand2() * 0.6), s, rand2));
  });
  geoms.forEach((g, k) => place(made, g, material, per[k], false, MUSHROOM_REACH, undefined, 28));
  made.disposables.push(...geoms);
  return per.reduce((n, l) => n + l.length, 0);
}

// Everything above, built once behind the loader. Returns the instance counts, for the record.
export function buildLitter(t: ForestTextures, sun: THREE.Vector3, tier: QualityTier, made: Made) {
  return {
    leaves: leaves(tier, made),
    ...twigsAndNeedles(tier, made),
    ...stones(t, tier, made),
    ...flowersAndClover(sun, tier, made),
    mushrooms: mushrooms(tier, made)
  };
}
