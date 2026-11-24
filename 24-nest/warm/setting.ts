/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import {
  Fn,
  asin,
  atan,
  attribute,
  cameraPosition,
  clamp,
  color,
  dot,
  float,
  fract,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalMap,
  normalWorld,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  smoothstep,
  step,
  texture,
  time,
  uv,
  vec2,
  vec3
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { lehmer } from "../../shared/engine/random";
import { snowCap, weather, type Lighting } from "./light";
import { barkTube, type Scans } from "./nest";

// The tree: a slim trunk standing just right of the nest, with the thermostat screwed to it; the limb the nest sits in,
// running off it to the left; more limbs and bare winter twigs round the edges of the view. Snow lies along their tops
// and frost on their bark, both melting as the dial warms them, the melt dripping off the undersides. Behind, the sky at
// dusk over a snowy wood, painted once at load already soft, as a lens far out of focus sees it: a cold one and a warm
// one, crossfaded by the heat. Centimetres; the nest's rim at the origin.

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// Where the trunk stands, how thick, and which way the thermostat on it faces (toward the camera, a little left).
export const TRUNK = { x: 23, z: -8, radius: 9.5 };
// Turned round the trunk toward the nest: about 128 degrees round from +x, still well in view from the front. On a phone
// held upright, higher and further round, up beside the prompt where a thumb finds it, clear of the nest below.
export const PHONE = typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;
const DIAL = PHONE ? { round: 131, up: 6.5 } : { round: 128, up: 4.5 };
export const FACING = new THREE.Vector3(Math.cos(THREE.MathUtils.degToRad(DIAL.round)), 0, Math.sin(THREE.MathUtils.degToRad(DIAL.round)));
export const MOUNT = new THREE.Vector3(TRUNK.x, DIAL.up, TRUNK.z).addScaledVector(FACING, TRUNK.radius + 0.1);

type Limb = { points: THREE.Vector3[]; r: [number, number]; twigs: number };

const LIMBS: Limb[] = [
  // The trunk.
  { points: [v(24, -110, -9), v(23.4, -40, -8.3), v(TRUNK.x, -1, TRUNK.z), v(23.6, 50, -8.6), v(25, 130, -10)], r: [TRUNK.radius + 0.55, TRUNK.radius - 0.55], twigs: 0 },
  // The limb the nest sits in, out of the trunk to the left and away.
  { points: [v(19, -10.5, -6.5), v(10, -9.3, -1.2), v(0, -7.6, 0), v(-14, -9.4, -3), v(-38, -13.5, -10), v(-80, -21, -26)], r: [2.6, 1.2], twigs: 9 },
  // A branch off it rising up behind the nest.
  { points: [v(-5, -9.2, -1), v(-11, 1, -13), v(-17, 17, -27), v(-22, 36, -44)], r: [1.5, 0.45], twigs: 5 },
  // A limb high on the trunk going back to the left, over the top of the view.
  { points: [v(19, 30, -9), v(6, 33, -14), v(-20, 39, -22), v(-56, 48, -34)], r: [2.3, 0.7], twigs: 6 },
  // And one off the back of the trunk to the right.
  { points: [v(27, 14, -12), v(40, 19, -20), v(62, 27, -34)], r: [1.9, 0.6], twigs: 4 }
];

// Where limbs leave the trunk: the point on its surface and the limb's radius there, for the crease round each collar.
type Junction = { at: THREE.Vector3; r: number };

// Bark for the tree: the scan, weathered grey-brown, its colour drifting warmer and cooler over the trunk, darker down in
// the fissures, with lichen and patches of moss, under the frost, snow and wet of the weather. On the trunk (radius over
// 5) the scan's height map pushes the plates out and the fissures in, as real relief. Where a limb meets the trunk the
// bark darkens into the crease, on both sides of it. `knot` marks the cut faces of old branch stubs (aFace 1), which show
// weathered grey wood with growth rings instead.
// `relief` false: no displacement, for distant trees whose rings are too far apart to carry it.
function barkMaterial(scans: Scans, l: Lighting, junctions: Junction[], knot = false, relief = true) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  const scan = uv() as any;
  const P = positionWorld as any;
  const R = (knot ? float(1) : attribute("aRadius", "float")) as any;
  const trunk = step(5, R) as any;
  if (!knot && relief) {
    // Built from scratch here, for the vertex stage: never shared with the fragment nodes below.
    const p0 = attribute("position", "vec3") as any;
    const n0 = attribute("normal", "vec3") as any;
    const h = (texture(scans.barkDisp, uv()) as any).level(0).r as any;
    m.positionNode = p0.add(n0.mul(h.sub(0.55).mul(1.1).mul(step(5, attribute("aRadius", "float"))))) as any;
  }
  const height = (texture(scans.barkDisp, scan) as any).r as any;
  let c: any = (texture(scans.bark, scan) as any).rgb.mul(color("#6e6252").mul(2.2));
  // Darker down in the fissures, the plates' faces catching more.
  c = c.mul(mix(float(0.5), float(1.08), smoothstep(0.12, 0.7, height)));
  // A slow drift of tone across the bark.
  c = c.mul(mix(vec3(0.84, 0.88, 0.96), vec3(1.12, 1.02, 0.88), mx_noise_float(P.mul(0.035)).mul(0.5).add(0.5)));
  const N = normalWorld as any;
  const lichen = smoothstep(0.15, 0.35, mx_fractal_noise_float(positionLocal.mul(0.3), 3, 2, 0.5).sub(0.05)) as any;
  c = mix(c, mix(color("#6f7466"), color("#8e9484"), mx_noise_float(positionLocal.mul(3)).mul(0.5).add(0.5)), lichen.mul(0.16));
  // Moss on the trunk, in soft patches, thickest in the fissures.
  const mossy = smoothstep(0.28, 0.5, mx_fractal_noise_float(P.mul(0.07).add(3), 3, 2, 0.5)).mul(smoothstep(0.75, 0.3, height).mul(0.6).add(0.4)).mul(trunk) as any;
  const mossColour = (texture(scans.moss, P.xy.add(P.zy).mul(0.14)) as any).rgb.mul(vec3(0.7, 0.72, 0.55)) as any;
  c = mix(c, mossColour, mossy.mul(0.45));
  // The crease where limb and trunk meet: on a limb, close to the trunk; on the trunk, close round each junction.
  const out = vec2(P.x.sub(TRUNK.x), P.z.sub(TRUNK.z)).length().sub(TRUNK.radius) as any;
  let crease: any = mix(smoothstep(-0.4, 3.2, out), float(1), trunk);
  for (const j of junctions) {
    const d = P.sub(vec3(j.at.x, j.at.y, j.at.z)).length() as any;
    crease = crease.mul(mix(float(1), smoothstep(j.r * 0.95, j.r * 1.45, d).mul(0.6).add(0.4), trunk));
  }
  c = c.mul(mix(float(0.55), float(1), crease));
  // Under the nest where it sits on the limb.
  c = c.mul(mix(float(0.4), float(1), smoothstep(3.2, 8.5, P.sub(vec3(0, -5.6, 0)).length())));
  if (knot) {
    // The cut face: grey weathered wood, growth rings round the stub's middle, split by a few checks.
    const face = attribute("aFace", "float") as any;
    const rr = (attribute("aRing", "float") as any).mul(9) as any;
    const rings = smoothstep(0.35, 0.5, fract(rr.add(mx_noise_float(P.mul(1.5)).mul(0.4))).sub(0.5).abs()) as any;
    const wood = mix(color("#5c5650"), color("#8c857a"), rings).mul(mx_noise_float(P.mul(4)).mul(0.15).add(0.92)) as any;
    c = mix(c, wood, face);
  }
  const w = weather(l, c, (texture(scans.barkRough, scan) as any).r, positionWorld, N);
  m.colorNode = w.colour as any;
  m.roughnessNode = w.rough as any;
  m.normalNode = normalMap(texture(scans.barkNormal, scan), vec2(2, 2)) as any;
  // Against the light, the bark's edge glows a little.
  m.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const rim = pow(float(1).sub(dot(normalize(normalWorld), V).abs()), 4) as any;
    return (l.sun as any).mul(rim.mul(pow(max(dot(V.negate(), l.toSun), 0), 2)).mul(0.06));
  })() as any;
  return m;
}

// Old knots: raised burls, and the stubs of branches long since broken off, the bark rolled round them in rings and the
// cut face grey. Each a lathe standing on the surface it grows from (embedded in it at the foot), its bark mapped round
// its axis so the pattern swirls round the knot. All in one geometry.
type Knot = { at: THREE.Vector3; normal: THREE.Vector3; r: number; kind: "stub" | "burl"; seed: number };
function knots(list: Knot[]) {
  const parts: THREE.BufferGeometry[] = [];
  for (const k of list) {
    const random = lehmer(k.seed);
    const profile: [number, number, number][] = [];
    const r = k.r;
    if (k.kind === "stub") {
      // Foot, the rolled collar of bark, the stub, then across the cut face to the middle.
      const len = r * (0.35 + random() * 0.5);
      for (const [x, y] of [
        [r * 2.6, -0.8],
        [r * 2.1, -0.2],
        [r * 1.75, 0.02],
        [r * 1.55, r * 0.25],
        [r * 1.3, r * 0.45],
        [r * 1.12, r * 0.5 + len * 0.4],
        [r * 1.05, r * 0.5 + len],
        [r * 0.98, r * 0.55 + len]
      ])
        profile.push([x, y, 0]);
      for (let i = 1; i <= 6; i++) profile.push([r * 0.98 * (1 - i / 6), r * 0.55 + len + Math.sin((i / 6) * Math.PI) * 0.05, 1]);
    } else {
      // A swelling, lumpy, rising gently out of the bark so its edge is lost in it.
      for (let i = 0; i <= 10; i++) {
        const x = r * 2.4 * (1 - i / 10);
        profile.push([Math.max(0.001, x), r * 0.8 * Math.exp(-((x / r) ** 2) * 0.9) - 0.45, 0]);
      }
    }
    const sides = 40;
    const position: number[] = [];
    const uvs: number[] = [];
    const face: number[] = [];
    const ring: number[] = [];
    const index: number[] = [];
    const bumps = Array.from({ length: 5 }, () => [random() * Math.PI * 2, random() * 0.6 + 0.2, random() * 0.25]);
    let along = 0;
    profile.forEach(([x, y, f], i) => {
      if (i > 0) along += Math.hypot(x - profile[i - 1][0], y - profile[i - 1][1]);
      for (let j = 0; j <= sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        let s = 1;
        if (k.kind === "burl") for (const [ba, bh, bs] of bumps) s += bs * Math.exp(-((Math.cos(a - ba) - 1) ** 2) * 8 - ((i / 10 - bh) ** 2) * 20);
        position.push(Math.cos(a) * x * s, y * (k.kind === "burl" ? s : 1), Math.sin(a) * x * s);
        // Round the knot and out from it: the bark's grain runs in rings.
        // Twisted a little as it goes in, so the rings swirl rather than stack.
        uvs.push((j / sides) * Math.max(2, Math.round(x * 1.3)) + along * 0.12, along / 3);
        face.push(f);
        ring.push(x / r);
      }
    });
    const row = sides + 1;
    // Profile runs up from the foot and in, angle round from +x toward +z: wound (checked) so the faces look away from
    // the axis.
    for (let i = 0; i < profile.length - 1; i++)
      for (let j = 0; j < sides; j++) {
        const a = i * row + j;
        index.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute("aFace", new THREE.Float32BufferAttribute(face, 1));
    g.setAttribute("aRing", new THREE.Float32BufferAttribute(ring, 1));
    g.setIndex(index);
    g.computeVertexNormals();
    g.applyMatrix4(new THREE.Matrix4().compose(k.at, new THREE.Quaternion().setFromUnitVectors(v(0, 1, 0), k.normal), v(1, 1, 1)));
    parts.push(g);
  }
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return merged;
}

// The sky, painted: `paint` draws over a gradient in a frame covering the front half of the sky, x across -90 to 90
// degrees of bearing, y from straight up to straight down.
function paintSky(paint: (g: CanvasRenderingContext2D, at: (dir: THREE.Vector3) => [number, number], random: () => number) => void, seed: number) {
  const W = 2048;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const at = (d: THREE.Vector3): [number, number] => {
    const n = d.clone().normalize();
    const u = Math.atan2(n.x, -n.z) / Math.PI + 0.5;
    const vv = Math.asin(n.y) / Math.PI + 0.5;
    return [u * W, (1 - vv) * H];
  };
  paint(g, at, lehmer(seed));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function blob(g: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string, alpha: number, blur: number) {
  g.save();
  g.filter = `blur(${blur}px)`;
  g.globalAlpha = alpha;
  g.fillStyle = colour;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

// A bokeh disc: a soft-edged, even circle of light.
function bokeh(g: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string, alpha: number) {
  g.save();
  g.globalCompositeOperation = "lighter";
  g.filter = "blur(2px)";
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, colour);
  grad.addColorStop(0.85, colour);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.globalAlpha = alpha;
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function gradient(g: CanvasRenderingContext2D, stops: [number, string][]) {
  const grad = g.createLinearGradient(0, 0, 0, g.canvas.height);
  for (const [at, c] of stops) grad.addColorStop(at, c);
  g.fillStyle = grad;
  g.fillRect(0, 0, g.canvas.width, g.canvas.height);
}

// One evening, twice: the same snowy wood under a cold blue dusk and a warm golden one.
function skies() {
  const sun = v(-0.5, 0.06, -0.86);
  const wood = (g: CanvasRenderingContext2D, random: () => number, tree: string, snow: string, glow: string, lights: number) => {
    // A soft band of conifers along the horizon, a nearer, darker band below, snow between.
    for (let k = 0; k < 110; k++) {
      const x = random() * 2048;
      const h = 40 + random() * 90;
      g.save();
      g.filter = "blur(10px)";
      g.fillStyle = tree;
      g.globalAlpha = 0.55 + random() * 0.3;
      g.beginPath();
      g.moveTo(x, 520 - h);
      g.lineTo(x + h * 0.28, 540);
      g.lineTo(x - h * 0.28, 540);
      g.fill();
      g.restore();
    }
    blob(g, 1024, 600, 900, snow, 0.35, 40);
    for (let k = 0; k < 60; k++) blob(g, random() * 2048, 640 + random() * 220, 60 + random() * 120, tree, 0.5, 30);
    // A few lit windows far off, out of focus.
    for (let k = 0; k < lights; k++) bokeh(g, random() * 2048, 548 + random() * 30, 2 + random() * 3, glow, 0.25 + random() * 0.35);
  };
  const cold = paintSky((g, at, random) => {
    gradient(g, [
      [0, "#0b1226"],
      [0.3, "#1c2a4e"],
      [0.44, "#46507c"],
      [0.5, "#8a7a9a"],
      [0.535, "#3a4466"],
      [0.62, "#232c46"],
      [1, "#0e121e"]
    ]);
    const [sx, sy] = at(sun);
    blob(g, sx, sy, 260, "#c89aa8", 0.35, 80);
    wood(g, random, "#0c1020", "#4a5878", "#ffc070", 0);
    for (let k = 0; k < 90; k++) blob(g, random() * 2048, random() * 330, 1.3, "#ffffff", 0.2 + random() * 0.5, 1);
  }, 23);
  const warm = paintSky((g, at, random) => {
    gradient(g, [
      [0, "#2a2a40"],
      [0.28, "#6a5458"],
      [0.43, "#c8905e"],
      [0.5, "#ffc47c"],
      [0.535, "#a07048"],
      [0.62, "#4a3426"],
      [1, "#1a1410"]
    ]);
    const [sx, sy] = at(sun);
    blob(g, sx, sy, 300, "#ffd8a0", 0.75, 80);
    blob(g, sx, sy, 90, "#fff0d0", 0.8, 30);
    wood(g, random, "#2a1a14", "#c09070", "#ffd090", 0);
  }, 23);
  return { cold, warm };
}

// Drops of meltwater, hanging under the limbs and the nest, swelling and falling, while the melt runs.
function drips(l: Lighting, count: number, random: () => number, curves: THREE.CatmullRomCurve3[], radii: [number, number][]) {
  const at = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    // Under the limbs in view, or under the nest.
    let p: THREE.Vector3;
    if (i % 4 === 3) {
      const a = random() * Math.PI * 2;
      p = v(Math.cos(a) * 5.5, -4.4 - random() * 0.6, Math.sin(a) * 5.5);
    } else {
      const k = i % 2 === 0 ? 1 : random() < 0.5 ? 2 : 3;
      const t = k === 1 ? 0.12 + random() * 0.35 : 0.05 + random() * 0.5;
      p = curves[k].getPointAt(t);
      const [r0, r1] = radii[k];
      p.y -= r0 + (r1 - r0) * t;
    }
    at.set([p.x, p.y, p.z, random()], i * 4);
  }
  const geometry = new THREE.SphereGeometry(0.26, 10, 8);
  // A teardrop: pointed at the top where it hangs on.
  const pos = geometry.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const pinch = y > 0 ? 1 - (y / 0.26) * 0.6 : 1;
    pos.setXYZ(i, pos.getX(i) * pinch, y * 1.35, pos.getZ(i) * pinch);
  }
  geometry.computeVertexNormals();
  geometry.setAttribute("aDrip", new THREE.InstancedBufferAttribute(at, 4));
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.04, metalness: 0, clearcoat: 1, transparent: false });
  const a = attribute("aDrip", "vec4") as any;
  // Each drop's own cycle: swelling for most of it, then a fall too quick to follow.
  const period = a.w.mul(1.6).add(1.8) as any;
  const c = fract(time.div(period).add(a.w.mul(7.3))) as any;
  const swell = smoothstep(0, 0.8, c) as any;
  const fall = max(c.sub(0.82), 0).mul(period) as any;
  const size = swell.mul((l.wet as any).mul(1.15).min(1)) as any;
  m.positionNode = positionGeometry.mul(size).add(vec3(a.x, a.y.sub(size.mul(0.2)).sub(fall.mul(fall).mul(490)), a.z)) as any;
  m.colorNode = color("#0e1218") as any;
  // Water: catches the sky and the thermostat's glow.
  m.emissiveNode = (l.glow as any).mul(0.1).add((l.sky as any).mul(0.5)) as any;
  const mesh = new THREE.InstancedMesh(geometry, m, count);
  const identity = new THREE.Matrix4();
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
  mesh.frustumCulled = false;
  return { mesh, geometry, material: m };
}

export function buildSetting(l: Lighting, scans: Scans, quality: "low" | "medium" | "high") {
  const random = lehmer(77);
  const group = new THREE.Group();
  const bark: THREE.BufferGeometry[] = [];
  const curves: THREE.CatmullRomCurve3[] = [];
  // Keep twigs out of the space round the nest, the thermostat and the line of sight to them.
  // A twig grows in a zigzag: each node turns it a little off its way, alternately to either side, and now and then a
  // sharp kink where a bud died and the next took over. `up` is how much it tends upward.
  const grow = (dir: THREE.Vector3, node: number, up: number) => {
    const side = new THREE.Vector3().crossVectors(dir, v(0, 1, 0));
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize().multiplyScalar((node % 2 === 0 ? 1 : -1) * (0.15 + random() * 0.25));
    const kink = random() < 0.3 ? 0.9 : 0.35;
    dir.add(side).add(v(random() - 0.5, random() * up - 0.1, random() - 0.5).multiplyScalar(kink)).normalize();
  };
  const inTheWay = (p: THREE.Vector3) => (p.y > -6 && p.y < 16 && p.x > -16 && p.x < 34 && p.z > -12) || p.distanceTo(MOUNT) < 10 || (p.z > 6 && p.y > -10);
  const junctions: Junction[] = [];
  // Every twig's path, for the leaves to grow along; the sprigs round the nest apart, as they carry the most.
  const twigs: THREE.CatmullRomCurve3[] = [];
  const sprigTwigs: THREE.CatmullRomCurve3[] = [];
  const flare = { x: TRUNK.x, z: TRUNK.z, R: TRUNK.radius };
  LIMBS.forEach((limb, li) => {
    const curve = new THREE.CatmullRomCurve3(limb.points, false, "centripetal");
    curves.push(curve);
    if (li === 0) {
      // The trunk, in fine rings so its relief can be pushed out of it.
      bark.push(barkTube(limb.points, limb.r[0], limb.r[1], quality === "low" ? 64 : 112, 7, 0, { step: quality === "low" ? 1.8 : 0.9 }));
    } else if (limb.points[0].distanceTo(v(TRUNK.x, limb.points[0].y, TRUNK.z)) < TRUNK.radius) {
      // A limb out of the trunk: its base swells into a collar, and above it the trunk's bark rides up in a ridge.
      bark.push(barkTube(limb.points, limb.r[0], limb.r[1], limb.r[0] > 1 ? 32 : 14, 5, li * 7, { flare }));
      let at = curve.getPointAt(0);
      for (let t = 0; t <= 0.3; t += 0.002) {
        at = curve.getPointAt(t);
        if (Math.hypot(at.x - TRUNK.x, at.z - TRUNK.z) > TRUNK.radius) break;
      }
      junctions.push({ at: at.clone(), r: limb.r[0] * 1.8 });
      const out = Math.atan2(at.z - TRUNK.z, at.x - TRUNK.x);
      const ridge: THREE.Vector3[] = [];
      const span = (limb.r[0] * 1.6) / TRUNK.radius;
      for (let i = 0; i <= 8; i++) {
        const f = i / 8 - 0.5;
        const a = out + f * span * 2;
        // Sunk most of the way into the trunk, so only a low rounded ridge stands out of it.
        const sink = TRUNK.radius - limb.r[0] * 0.12 - Math.abs(f) * 0.6;
        ridge.push(v(TRUNK.x + Math.cos(a) * sink, at.y + limb.r[0] * 2.0 - f * f * 4 * limb.r[0] * 1.2, TRUNK.z + Math.sin(a) * sink));
      }
      bark.push(barkTube(ridge, 0.15 + limb.r[0] * 0.2, 0.15 + limb.r[0] * 0.12, 12, 3, 900 + li));
    } else bark.push(barkTube(limb.points, limb.r[0], limb.r[1], limb.r[0] > 1 ? 24 : 14, 5, li * 7));
    for (let k = 0; k < limb.twigs * (quality === "low" ? 1 : 2); k++) {
      const t = 0.12 + random() * 0.85;
      const at = curve.getPointAt(t);
      const r0 = (limb.r[0] + (limb.r[1] - limb.r[0]) * t) * 0.42;
      // Up and out, crooked, splitting once near the end.
      const dir = v(random() - 0.5, 0.3 + random() * 0.8, random() - 0.6).normalize();
      const points = [at.clone()];
      const length = 7 + random() * 16;
      let blocked = false;
      for (let s = 1; s <= 7; s++) {
        grow(dir, s, 0.45);
        const next = points[s - 1].clone().addScaledVector(dir, length / 7);
        if (inTheWay(next)) blocked = true;
        points.push(next);
      }
      if (blocked) continue;
      bark.push(barkTube(points, Math.max(0.14, r0), 0.06, 7, 3, 100 + li * 31 + k));
      // A fork off the twig.
      const twig = new THREE.CatmullRomCurve3(points);
      twigs.push(twig);
      const from = twig.getPointAt(0.55);
      const fork = twig.getTangentAt(0.55).add(v(random() - 0.5, 0.3, random() - 0.5)).normalize();
      const end = from.clone().addScaledVector(fork, length * 0.35);
      if (!inTheWay(end)) {
        const forkPoints = [from, from.clone().addScaledVector(fork, length * 0.18).add(v(0, 0.3, 0)), end];
        bark.push(barkTube(forkPoints, Math.max(0.1, r0 * 0.5), 0.05, 6, 3, 300 + li * 31 + k));
        twigs.push(new THREE.CatmullRomCurve3(forkPoints));
      }
    }
  });
  // Short leafy sprigs off the nest's limb and the branch behind it, so leaves come and go close to the nest too:
  // hanging below the limb in front, rising beside the nest behind.
  const sprigs: [number, number, THREE.Vector3][] = [
    // Rising behind the nest, a green wall at its back.
    [1, 0.13, v(0.35, 0.75, -0.6)],
    [1, 0.18, v(-0.1, 0.8, -0.6)],
    [1, 0.23, v(-0.4, 0.7, -0.5)],
    // Out to the left of it.
    [1, 0.3, v(-0.8, 0.35, 0.5)],
    [1, 0.33, v(-0.6, 0.6, -0.4)],
    [1, 0.36, v(-0.3, -0.3, 0.85)],
    [1, 0.45, v(-0.5, 0.4, 0.6)],
    // Off the branch behind.
    [2, 0.12, v(0.5, 0.4, 0.6)],
    [2, 0.2, v(-0.7, 0.5, 0.4)],
    [2, 0.3, v(0.7, 0.5, -0.2)],
    [2, 0.38, v(0.6, 0.6, 0.3)],
    [2, 0.5, v(-0.6, 0.5, -0.4)],
    [2, 0.6, v(-0.5, 0.5, 0.6)]
  ];
  for (const [k, t, lean] of sprigs) {
    const c = curves[k];
    const at = c.getPointAt(t);
    const dir = lean.clone().normalize();
    const [r0, r1] = LIMBS[k].r;
    const r = r0 + (r1 - r0) * t;
    const length = 6 + random() * 5;
    const points = [at.clone()];
    for (let s = 1; s <= 6; s++) {
      grow(dir, s, 0.35);
      points.push(points[s - 1].clone().addScaledVector(dir, length / 6));
    }
    bark.push(barkTube(points, Math.max(0.12, r * 0.22), 0.05, 7, 3, 700 + k * 13 + Math.round(t * 100)));
    sprigTwigs.push(new THREE.CatmullRomCurve3(points));
    // A side shoot halfway along, so the leaves come in clusters.
    const mid = points[3];
    const side = dir.clone().cross(v(0, 1, 0)).normalize().multiplyScalar(random() < 0.5 ? 1 : -1).add(v(0, 0.3, 0)).normalize();
    const shoot = [mid.clone(), mid.clone().addScaledVector(side, length * 0.25), mid.clone().addScaledVector(side, length * 0.45).add(v(0, 0.4, 0))];
    bark.push(barkTube(shoot, 0.08, 0.04, 6, 3, 800 + k * 13 + Math.round(t * 100)));
    sprigTwigs.push(new THREE.CatmullRomCurve3(shoot));
  }
  const merged = mergeGeometries(bark);
  for (const g of bark) g.dispose();
  const barkM = barkMaterial(scans, l, junctions);
  const limbs = new THREE.Mesh(merged, barkM);
  limbs.castShadow = true;
  limbs.receiveShadow = true;
  group.add(limbs);

  // Knots, of varied sizes: on the trunk a big stub above the dial, a burl below it and a small stub high up; a stub
  // and a burl out along the limbs.
  const onTrunk = (y: number, angle: number) => {
    const n = v(Math.cos(angle), 0, Math.sin(angle));
    return { at: v(TRUNK.x, y, TRUNK.z).addScaledVector(n, TRUNK.radius - 0.15), normal: n };
  };
  const onLimb = (k: number, t: number, lean: THREE.Vector3) => {
    const c = curves[k];
    const at = c.getPointAt(t);
    const tangent = c.getTangentAt(t);
    const n = lean.clone().addScaledVector(tangent, -lean.dot(tangent)).normalize();
    const [r0, r1] = LIMBS[k].r;
    return { at: at.addScaledVector(n, r0 + (r1 - r0) * t - 0.1), normal: n };
  };
  // The knots keep their places round the trunk wherever the thermostat is.
  const front = THREE.MathUtils.degToRad(128);
  const knotGeometry = knots([
    { ...onTrunk(22, front - 0.45), r: 1.5, kind: "stub", seed: 1 },
    { ...onTrunk(-19, front + 0.25), r: 2.2, kind: "burl", seed: 2 },
    { ...onTrunk(47, front + 0.7), r: 0.8, kind: "stub", seed: 3 },
    { ...onTrunk(8, front + 1.6), r: 1.3, kind: "burl", seed: 6 },
    { ...onLimb(1, 0.42, v(0.1, 0.6, 1)), r: 0.75, kind: "stub", seed: 4 },
    { ...onLimb(3, 0.35, v(0, 0.3, 1)), r: 0.9, kind: "burl", seed: 5 }
  ]);
  const knotM = barkMaterial(scans, l, [], true);
  const knotMesh = new THREE.Mesh(knotGeometry, knotM);
  knotMesh.castShadow = true;
  knotMesh.receiveShadow = true;
  group.add(knotMesh);
  // Snow along their tops, deepest on the thick limbs.
  const cap = snowCap(l, () => (attribute("aRadius", "float") as any).mul(0.4).min(1.3));
  const snow = new THREE.Mesh(merged, cap);
  snow.receiveShadow = true;
  group.add(snow);

  // The sky.
  const { cold, warm } = skies();
  const skyM = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: true });
  {
    const d = normalize(positionLocal) as any;
    const u = clamp(atan(d.x, d.z.negate()).div(Math.PI).add(0.5), 0.001, 0.999) as any;
    const vv = asin(clamp(d.y, -1, 1)).div(Math.PI).add(0.5) as any;
    const st = vec2(u, vv) as any;
    const k = smoothstep(0.15, 0.7, l.heat) as any;
    // Dark at first, brightening with the warmth.
    skyM.colorNode = mix((texture(cold, st) as any).rgb.mul(0.55), (texture(warm, st) as any).rgb.mul(1.2), k) as any;
  }
  const skyG = new THREE.SphereGeometry(330, 48, 24);
  const sky = new THREE.Mesh(skyG, skyM);
  sky.frustumCulled = false;
  group.add(sky);

  // Other trees standing round about, one to three metres off, so every way the view turns there is a wood behind, far
  // out of focus: scanned bark like the hero's (without its relief), limbs forking into branches and twigs, and their
  // twigs carrying leaves of their own that follow the dial with the rest. A few stand far off behind the opening view
  // too, so its sky fills with a canopy as it warms.
  const wood: THREE.BufferGeometry[] = [];
  const canopy: THREE.CatmullRomCurve3[] = [];
  const spots: [number, number][] = [];
  for (let k = 0; k < 14; k++) spots.push([(k / 14) * Math.PI * 2 + random() * 0.3, 110 + random() * 120]);
  for (const a of [-Math.PI / 2 - 0.45, -Math.PI / 2 + 0.05, -Math.PI / 2 + 0.5]) spots.push([a + (random() - 0.5) * 0.15, 230 + random() * 40]);
  // A crooked path: points along a direction, each turned a little off the last.
  const crooked = (from: THREE.Vector3, dir: THREE.Vector3, length: number, n: number, bend: number, rise: number) => {
    const points = [from.clone()];
    const d = dir.clone().normalize();
    for (let i = 1; i <= n; i++) {
      d.add(v(random() - 0.5, (random() - 0.5) * 0.6 + rise, random() - 0.5).multiplyScalar(bend)).normalize();
      points.push(points[i - 1].clone().addScaledVector(d, length / n));
    }
    return points;
  };
  spots.forEach(([a, d], k) => {
    // Near ones keep clear of the opening view's sky.
    const behind = Math.abs(Math.atan2(Math.sin(a + Math.PI / 2), Math.cos(a + Math.PI / 2))) < 0.75;
    if (d < 200 && behind) return;
    const x = 10 + Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const r = 5 + random() * 8;
    // The trunk: tapering, bending a little on its way up.
    const trunk: THREE.Vector3[] = [];
    let off = v(0, 0, 0);
    for (let i = 0; i <= 6; i++) {
      off = off.clone().add(v(random() - 0.5, 0, random() - 0.5).multiplyScalar(9));
      trunk.push(v(x + off.x, -160 + i * 55, z + off.z));
    }
    wood.push(barkTube(trunk, r, r * 0.45, 14, 9, 40 + k, { step: 25 }));
    const trunkCurve = new THREE.CatmullRomCurve3(trunk);
    // Limbs up and out, crooked, each forking into branches and those into twigs. The far ones behind the opening view
    // also send long limbs reaching over toward the nest, so their canopy hangs across the top of that view.
    const limbs = 4 + Math.floor(random() * 3) + (behind ? 1 : 0);
    for (let b = 0; b < limbs; b++) {
      const reaching = behind && b === 0;
      const t = reaching ? 0.6 + random() * 0.1 : 0.5 + random() * 0.35;
      const base = trunkCurve.getPointAt(t);
      // A reaching limb sweeps down and forward from its own tree toward the nest's side of the wood, low enough to cross
      // the top of the view; each keeps to its own side (its aim drawn only part way in), so they never criss-cross.
      const toward = v(10 + (x - 10) * 0.55, 4 + random() * 18, -45 - random() * 25);
      const out = reaching ? toward.clone().sub(base).normalize() : v(Math.cos(b * 2.4 + k), 0.4 + random() * 0.6, Math.sin(b * 2.4 + k));
      const reach = reaching ? base.distanceTo(toward) * 0.85 : 50 + random() * 45;
      const limb = crooked(base, out, reach, reaching ? 9 : 5, reaching ? 0.5 : 0.35, reaching ? -0.03 : 0.15);
      const lr = r * (0.3 + random() * 0.12);
      wood.push(barkTube(limb, lr, lr * 0.25, 9, 6, 60 + k * 7 + b, { step: lr * 3 }));
      const curve = new THREE.CatmullRomCurve3(limb);
      const forks = reaching ? 6 : 3;
      for (let f = 0; f < forks; f++) {
        const at = 0.35 + ((f + random() * 0.5) / forks) * 0.65;
        const from = curve.getPointAt(at);
        const dir = curve.getTangentAt(at).add(v(random() - 0.5, random() * 0.7 - 0.1, random() - 0.5).multiplyScalar(1.3));
        const branch = crooked(from, dir, 20 + random() * 25, 3, 0.4, 0.1);
        wood.push(barkTube(branch, lr * 0.3, 0.25, 6, 6, 90 + k * 13 + b * 7 + f, { step: 6 }));
        canopy.push(new THREE.CatmullRomCurve3(branch));
        // Twigs off the branch, for the leaves to cluster on.
        const bc = new THREE.CatmullRomCurve3(branch);
        for (let g = 0; g < 2; g++) {
          const p = bc.getPointAt(0.5 + g * 0.3);
          const twig = crooked(p, bc.getTangentAt(0.5).add(v(random() - 0.5, 0.3, random() - 0.5)), 10 + random() * 8, 2, 0.5, 0.1);
          wood.push(barkTube(twig, 0.25, 0.12, 5, 6, 400 + k * 31 + b * 7 + f * 2 + g, { step: 5 }));
          canopy.push(new THREE.CatmullRomCurve3(twig));
        }
      }
    }
  });
  const woodGeometry = mergeGeometries(wood);
  for (const g of wood) g.dispose();
  const woodM = barkMaterial(scans, l, [], false, false);
  const woodMesh = new THREE.Mesh(woodGeometry, woodM);
  group.add(woodMesh);

  const drops = drips(l, quality === "low" ? 24 : 56, random, curves, LIMBS.map((limb) => limb.r));
  group.add(drops.mesh);

  return {
    group,
    twigs,
    sprigTwigs,
    canopy,
    // The nest's limb, as points along its top, for falling leaves to come to rest on.
    perch: curves[1],
    perchRadius: LIMBS[1].r,
    geometries: [merged, knotGeometry, woodGeometry, skyG, drops.geometry],
    materials: [barkM, knotM, woodM, cap, skyM, drops.material] as THREE.Material[],
    textures: [cold, warm]
  };
}
