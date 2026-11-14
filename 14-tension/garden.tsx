"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  color,
  dot,
  float,
  fract,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalLocal,
  normalMap,
  normalWorld,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { useDispose } from "../shared/engine/dispose";
import { sky } from "./backdrop";
import { KINDS, type Look, LOOKS, type Version } from "./versions";
import { anchorPoint, mulberry32 } from "./web";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The twigs and stems the web is strung between. Each is grown as a real one is: a tapering limb through the points its
// frame threads are tied to, swelling at knots and where side twigs fork from it, the side twigs ending in buds and
// leaves. The bark is in the shape itself: a dense tube pushed in along long, mostly lengthwise cracks between plates,
// then coloured by them, darkest in the cracks, greyer and weathered on the plates, crusted with lichen and with moss
// in the cracks; wet in the storm.

const v = (p: [number, number, number]) => new THREE.Vector3(...p);

type Limb = {
  points: THREE.Vector3[];
  from: number;
  to: number;
  twigs: number;
  leaves: number;
};
// The tree: a trunk rising from far below and behind, heavy limbs spreading out round the edges of the view, and the
// branches the web hangs from growing out of those, each passing through the points its frame threads are tied to.
const LIMBS: Limb[] = [
  // The trunk.
  { points: [v([-3.4, -11, -2.9]), v([-3.1, -6, -2.5]), v([-2.9, -3, -2.3]), v([-2.8, 0, -2.4]), v([-3.0, 3, -2.6]), v([-3.4, 6.5, -3.1])], from: 0.6, to: 0.3, twigs: 4, leaves: 0 },
  // A low limb sweeping out under the web to the right.
  { points: [v([-2.85, -2.6, -2.3]), v([-1.5, -2.95, -1.6]), v([0.5, -3.05, -1.0]), v([2.6, -2.65, -0.5]), v([4.6, -2.0, -0.6]), v([6.8, -1.3, -1.3])], from: 0.3, to: 0.07, twigs: 6, leaves: 4 },
  // A high limb arching over it.
  { points: [v([-2.85, 1.2, -2.4]), v([-1.6, 2.35, -1.7]), v([0.5, 2.95, -1.2]), v([2.8, 3.15, -1.0]), v([5.0, 3.65, -1.4]), v([7.2, 4.5, -2.1])], from: 0.28, to: 0.06, twigs: 6, leaves: 4 },
  // Back and away to the left, up from the high one, and down from the low one.
  { points: [v([-3.0, -0.5, -2.45]), v([-4.6, 0.6, -3.5]), v([-6.8, 2.0, -5.2])], from: 0.24, to: 0.07, twigs: 4, leaves: 2 },
  { points: [v([1.5, 3.05, -1.1]), v([2.2, 4.7, -2.4]), v([3.0, 6.8, -4.2])], from: 0.15, to: 0.04, twigs: 3, leaves: 2 },
  { points: [v([2.6, -2.65, -0.5]), v([3.6, -4.6, -1.5]), v([4.6, -7.2, -3.2])], from: 0.14, to: 0.04, twigs: 3, leaves: 2 },
  // The branches the web is strung between, out of the limbs.
  { points: [v([-1.6, -2.9, -1.6]), v([-2.0, -1.8, -0.6]), v(anchorPoint(4)), v(anchorPoint(5)), v(anchorPoint(0)), v([0.7, 1.85, -0.2]), v([1.4, 2.95, -1.1])], from: 0.14, to: 0.09, twigs: 7, leaves: 4 },
  { points: [v([3.6, 3.3, -1.1]), v([2.4, 1.5, -0.35]), v(anchorPoint(1)), v([0.85, 1.12, 0.06])], from: 0.08, to: 0.012, twigs: 4, leaves: 3 },
  { points: [v([2.0, -2.8, -0.65]), v([1.5, -1.8, -0.2]), v(anchorPoint(2)), v([1.25, -0.25, 0.03])], from: 0.05, to: 0.009, twigs: 2, leaves: 2 },
  { points: [v([-0.4, -3.0, -1.2]), v([-0.5, -2.0, -0.3]), v(anchorPoint(3)), v([0.12, -0.92, 0.05])], from: 0.032, to: 0.006, twigs: 1, leaves: 1 }
];

// Smooth value noise in three dimensions, for shaping on the CPU.
function makeNoise(seed: number) {
  const random = mulberry32(seed);
  const table = new Float32Array(512).map(() => random() * 2 - 1);
  const hash = (x: number, y: number, z: number) => table[(((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0) & 511];
  const fade = (t: number) => t * t * (3 - 2 * t);
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const u = fade(x - xi);
    const w = fade(y - yi);
    const t = fade(z - zi);
    const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz);
    return lerp(lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), w), lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), w), t);
  };
}

// How much bark one copy of the scan covers, in scene units, so its fissures are the right size on a twig.
const TILE = 0.3;

// A limb along a curve: thinning from one end to the other, swelling at knots and where twigs fork from it, and
// rounding off at its tip. Its bark is the scan, wrapped round a whole number of times so it meets itself with no seam,
// and pushed in by the scan's own heights in proportion to how thick the limb is there (aRadius).
function barkTube(curve: THREE.Curve<THREE.Vector3>, from: number, to: number, seed: number, swellings: number[], fine: number) {
  const noise = makeNoise(seed);
  const length = curve.getLength();
  const steps = Math.min(420, Math.max(24, Math.round((length / 0.01) * fine)));
  const sides = Math.max(10, Math.round((from > 0.2 ? 64 : from > 0.03 ? 40 : from > 0.012 ? 24 : 14) * fine));
  const frames = curve.computeFrenetFrames(steps, false);
  const position: number[] = [];
  const normal: number[] = [];
  const radius: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const n = new THREE.Vector3();
  // Turned a different way on each limb, so no two show the same stretch of bark.
  const offset = noise(seed, 1, 2) * 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const at = curve.getPointAt(t);
    const s = t * length;
    let r = from + (to - from) * t ** 0.75;
    for (const k of swellings) r *= 1 + 0.35 * Math.exp(-((((t - k) * length) / (r * 2.5)) ** 2));
    r *= 1 + 0.07 * noise(s * 3, 0, seed);
    if (t > 0.985) r *= Math.sqrt(Math.max(0, (1 - t) / 0.015));
    const around = Math.max(1, Math.round((2 * Math.PI * r) / TILE));
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      n.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a));
      position.push(at.x + n.x * r, at.y + n.y * r, at.z + n.z * r);
      normal.push(n.x, n.y, n.z);
      radius.push(r);
      uvs.push((j / sides) * around, s / TILE + offset);
    }
  }
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("aRadius", new THREE.Float32BufferAttribute(radius, 1));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}

// A bud at a twig's tip: a pointed cone of scales.
function budGeometry() {
  const g = new THREE.ConeGeometry(1, 3, 10, 4);
  g.translate(0, 1.5, 0);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 3;
    const swell = Math.sin(Math.PI * Math.min(1, y * 1.3)) * 0.6 + 0.4;
    p.setXYZ(i, p.getX(i) * swell, p.getY(i), p.getZ(i) * swell);
  }
  g.computeVertexNormals();
  return g;
}

// A leaf: a plane folded along its midrib and curled at the tip; its outline, teeth, veins and bites are in the shader.
function leafGeometry() {
  const geometry = new THREE.PlaneGeometry(1, 1, 18, 8);
  const p = geometry.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + 0.5;
    const y = p.getY(i) * 0.9;
    p.setXYZ(i, x, y, Math.abs(y) * 0.28 - x * x * 0.16 + Math.sin(x * 9 + y * 3) * 0.008);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// The bark scan (CC0, Poly Haven: bark_brown_02; see public/assets/14-tension/CREDITS.txt), finer on bigger screens.
type Scans = { colour: THREE.Texture; normal: THREE.Texture; height: THREE.Texture; rough: THREE.Texture };
function loadScans(fine: number): Scans {
  const size = fine < 0.75 ? "1k" : "2k";
  const load = (name: string, colour: boolean) => {
    const t = new THREE.TextureLoader().load(`/assets/14-tension/bark_brown_02_${name}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  return { colour: load(`diff_${size}`, true), normal: load(`nor_gl_${size}`, false), height: load("disp_1k", false), rough: load("rough_1k", false) };
}

// The garden's shapes, the same in every weather: grown once, and dressed by the version's materials.
function grow(fine: number) {
  const random = mulberry32(31);
  const bark: THREE.BufferGeometry[] = [];
  const leafGeo = leafGeometry();
  const budGeo = budGeometry();
  const geometries: THREE.BufferGeometry[] = [leafGeo, budGeo];
  const leaves: { at: THREE.Vector3; along: THREE.Vector3; size: number }[] = [];
  const tips: { at: THREE.Vector3; along: THREE.Vector3; r: number }[] = [];

  // How many times twigs fork again: twice on a big screen, once on a phone.
  const depth = fine < 0.75 ? 1 : 2;
  // A twig from a point, heading roughly one way and wandering as it grows, thinning to a bud, and forking into up to
  // three smaller twigs of its own, each turned off it by thirty to sixty degrees.
  const twig = (start: THREE.Vector3, heading: THREE.Vector3, r: number, length: number, level: number, seed: number) => {
    const dir = heading.clone();
    // Never across the web.
    if (Math.hypot(start.x, start.y) < 1.75) dir.z -= 0.7;
    dir.normalize();
    const points = [start.clone()];
    for (let p = 1; p <= 5; p++) {
      dir.add(new THREE.Vector3(random() - 0.5, random() * 0.35, random() - 0.5).multiplyScalar(0.3)).normalize();
      if (Math.hypot(points[p - 1].x, points[p - 1].y) < 1.75 && dir.z > -0.3) dir.z -= 0.25;
      points.push(points[p - 1].clone().addScaledVector(dir.normalize(), length / 5));
    }
    const curve = new THREE.CatmullRomCurve3(points);
    const end = Math.max(0.0018, r * 0.22);
    const forks = level < depth ? Array.from({ length: 1 + Math.floor(random() * 3) }, () => 0.25 + random() * 0.6).sort() : [];
    const g = barkTube(curve, r, end, seed, [0.02, ...forks], fine * (level ? 0.6 : 0.8));
    geometries.push(g);
    bark.push(g);
    tips.push({ at: curve.getPointAt(1), along: curve.getTangentAt(1), r: end });
    forks.forEach((t, n) => {
      const along = curve.getTangentAt(t);
      // Off to one side of the parent, by thirty to sixty degrees.
      const side = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).cross(along).normalize();
      const turn = 0.5 + random() * 0.5;
      const heading = along.clone().multiplyScalar(Math.cos(turn)).addScaledVector(side, Math.sin(turn)).add(new THREE.Vector3(0, 0.15, 0));
      twig(curve.getPointAt(t), heading, (r + (end - r) * t) * 0.62, length * (0.45 + random() * 0.25), level + 1, seed * 3 + n + 1);
    });
    // Leaves toward the ends of the finest twigs.
    if (level === depth || random() < 0.4) leaves.push({ at: curve.getPointAt(0.7 + random() * 0.25), along: curve.getTangentAt(0.85), size: 0.16 + random() * 0.16 });
  };

  LIMBS.forEach((limb, li) => {
    const curve = new THREE.CatmullRomCurve3(limb.points, false, "centripetal");
    const forks = Array.from({ length: limb.twigs }, () => 0.12 + random() * 0.8).sort();
    const knots = Array.from({ length: 2 }, () => 0.1 + random() * 0.8);
    const geometry = barkTube(curve, limb.from, limb.to, 100 + li, [...forks, ...knots], fine);
    geometries.push(geometry);
    bark.push(geometry);
    tips.push({
      at: curve.getPointAt(1),
      along: curve.getTangentAt(1),
      r: limb.to
    });
    // Side twigs out from the limb, each forking again into smaller ones, away from the web's face and a little up.
    forks.forEach((t, k) => {
      const at = curve.getPointAt(t);
      const r = (limb.from + (limb.to - limb.from) * t ** 0.75) * 0.5;
      const away = new THREE.Vector3(at.x, at.y, 0).normalize().multiplyScalar(0.6).add(new THREE.Vector3(0, 0.35, -0.6)).addScaledVector(curve.getTangentAt(t), random() - 0.3);
      // A heavy limb puts out branches, not twigs: the thicker, the longer.
      twig(at, away, r, (0.3 + random() * 0.5) * Math.max(1, r / 0.03), 0, 200 + li * 37 + k * 5);
    });
    for (let k = 0; k < limb.leaves; k++) {
      const t = 0.1 + random() * 0.85;
      const at = curve.getPointAt(t);
      if (at.length() < 1.75 && at.z > -0.3) continue;
      leaves.push({
        at,
        along: curve.getTangentAt(t),
        size: 0.25 + random() * 0.22
      });
    }
  });

  // Buds at every tip, and leaves on short stalks, each turned its own way, behind the web.
  const place = (at: THREE.Vector3, turn: THREE.Quaternion, size: number) => new THREE.Matrix4().compose(at, turn, new THREE.Vector3(size, size, size));
  const buds = tips.map((tip) => place(tip.at, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.along), Math.max(0.004, tip.r * 1.3)));
  const leafAt = leaves.map((l) => {
    const turn = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(1, 0, 0),
      l.along
        .clone()
        .add(new THREE.Vector3(random() - 0.5, random() - 0.2, -0.8))
        .normalize()
    );
    turn.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (random() - 0.5) * 2.4));
    return place(l.at, turn, l.size);
  });
  return {
    bark,
    leafGeo,
    budGeo,
    buds,
    leafAt,
    geometries: [...geometries, ...bark]
  };
}

// What it is made of in one version's weather.
function dress(look: Look, scans: Scans) {
  const wet = look.air === "rain";

  // Bark: the scan, its colour tinted to the version's light, its heights pushing the surface in, its normals for the
  // fine relief and its roughness for where it shines. On top: lichen on the upper side, a wet
  // darkening and sheen in the storm.
  const bark = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  const scan = uv() as any;
  const height = texture(scans.height, scan).r as any;
  bark.positionNode = positionLocal.add(normalLocal.mul(height.sub(0.75).mul(attribute("aRadius", "float")).mul(0.35))) as any;
  bark.normalNode = normalMap(texture(scans.normal, scan), vec2(2, 2)) as any;
  const deep = smoothstep(0.55, 0.15, height) as any;
  const N = normalWorld as any;
  const facingUp = smoothstep(-0.3, 0.7, N.y.add(N.z.mul(0.35))) as any;
  // The scan's own colour: the version's light does the rest.
  let wood: any = texture(scans.colour, scan).rgb.mul(1.1);
  // Lichen: grey-green rosettes on the upper side, and pale crust dots, never down in the cracks.
  const patch = smoothstep(0.2, 0.36, mx_fractal_noise_float(positionLocal.mul(14), 3, 2, 0.55).add(facingUp.mul(0.25)).sub(0.15)) as any;
  const lobes = smoothstep(0.0, 0.25, mx_noise_float(positionLocal.mul(90))) as any;
  wood = mix(wood, mix(color("#7d8a6c"), color("#a9b494"), lobes).mul(height.mul(0.5).add(0.6)), patch.mul(deep.oneMinus()).mul(0.75));
  if (wet) wood = wood.mul(0.55);
  bark.colorNode = wood;
  const rough = texture(scans.rough, scan).r as any;
  bark.roughnessNode = (wet ? rough.mul(0.45) : rough) as any;
  // Backlit, the edge of a twig glows with the fine fuzz and lichen on it.
  bark.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const rim = pow(dot(normalize(normalWorld), V).abs().oneMinus(), 4) as any;
    return sky.light.mul(
      rim
        .mul(pow(max(dot(V.negate(), sky.toLight), 0), 2))
        .mul(sky.power)
        .mul(0.06)
    );
  })() as any;

  // Leaves.
  const leafMaterial = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    roughness: look.spider === "golden" ? 0.38 : 0.6
  });
  leafMaterial.alphaTest = 0.5;
  const lx = uv().x as any;
  const ly = uv().y.sub(0.5).mul(2) as any;
  const teeth = fract(lx.mul(26)).sub(0.5).abs().mul(0.08) as any;
  const half = pow(lx.mul(Math.PI).sin().max(0), 0.75)
    .mul(float(1).sub(lx.mul(0.25)))
    .mul(0.95)
    .sub(teeth) as any;
  const inside = smoothstep(0.02, -0.02, ly.abs().sub(half)) as any;
  // Insect bites, different on every leaf by where it hangs.
  const bites = smoothstep(0.62, 0.6, mx_noise_float(vec3(lx.mul(7), ly.mul(4), positionWorld.x.mul(3).add(positionWorld.y.mul(5))))) as any;
  leafMaterial.opacityNode = inside.mul(bites) as any;
  const midrib = smoothstep(0.035, 0.0, ly.abs()) as any;
  const veins = smoothstep(
    0.06,
    0.0,
    fract(lx.mul(8).sub(ly.abs().mul(2.2)))
      .sub(0.5)
      .abs()
  ).mul(smoothstep(0.05, 0.2, ly.abs())) as any;
  const edgeBrown = smoothstep(0.75, 1, ly.abs().div(half.max(0.01))).mul(
    mx_noise_float(vec3(lx.mul(5), ly.mul(5), 3))
      .mul(0.5)
      .add(0.5)
  ) as any;
  let leaf: any = mix(color(look.leaf) as any, (color(look.leaf) as any).mul(vec3(1.25, 1.2, 0.8)), lx);
  leaf = leaf.mul(
    mx_fractal_noise_float(vec3(lx.mul(12), ly.mul(12), 1), 3, 2, 0.5)
      .mul(0.18)
      .add(1)
  );
  leaf = mix(leaf, leaf.mul(1.45).add(0.04), midrib.max(veins.mul(0.6)));
  leaf = mix(leaf, color("#8a6a30"), edgeBrown.mul(0.7));
  leafMaterial.colorNode = leaf;
  // Lit from behind, a leaf glows through, its veins dark against it.
  leafMaterial.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const through = pow(max(dot(V, sky.toLight.negate()), 0), 3) as any;
    return leaf
      .mul(sky.light)
      .mul(sky.power)
      .mul(through.mul(0.4).add(0.03))
      .mul(float(1).sub(midrib.max(veins).mul(0.5)));
  })() as any;

  const budMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.55 });
  budMaterial.colorNode = mix(color("#5a3a22"), color("#8a6a3a"), smoothstep(0, 3, positionLocal.y)) as any;

  return { bark, leafMaterial, budMaterial };
}

// The tree once, dressed for every web up front so that changing web is only a matter of which is shown, and one set of
// lights whose colours change with it, since a new light would rebuild every lit shader.
export function Garden({ version, fine = 1 }: { version: Version; fine?: number }) {
  const look = LOOKS[version];
  const shapes = useMemo(() => grow(fine), [fine]);
  const scans = useMemo(() => loadScans(fine), [fine]);
  const dressed = useMemo(() => KINDS.map((v) => dress(LOOKS[v], scans)), [scans]);
  useDispose(scans.colour, scans.normal, scans.height, scans.rough);
  // Three draws for each: every limb and twig merged into one, and the buds and leaves each instanced.
  const merged = useMemo(() => mergeGeometries(shapes.bark), [shapes]);
  const groups = useMemo(
    () =>
      dressed.map((materials) => {
        const group = new THREE.Group();
        group.add(new THREE.Mesh(merged, materials.bark));
        const instanced = (geometry: THREE.BufferGeometry, material: THREE.Material, at: THREE.Matrix4[]) => {
          const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, at.length));
          at.forEach((m, i) => mesh.setMatrixAt(i, m));
          mesh.count = at.length;
          mesh.computeBoundingSphere();
          group.add(mesh);
        };
        instanced(shapes.budGeo, materials.budMaterial, shapes.buds);
        instanced(shapes.leafGeo, materials.leafMaterial, shapes.leafAt);
        return group;
      }),
    [shapes, dressed, merged]
  );
  useDispose(merged);
  useDispose(...shapes.geometries);
  useDispose(...dressed.flatMap((m) => [m.bark, m.leafMaterial, m.budMaterial]));

  const sun = useMemo(() => new THREE.Vector3(...look.toLight).normalize().multiplyScalar(10), [look]);
  return (
    <>
      {groups.map((group, i) => (
        <primitive key={KINDS[i]} object={group} visible={KINDS[i] === version} />
      ))}
      <directionalLight position={sun.toArray()} intensity={look.lightPower * 1.4} color={look.light} />
      {/* Fill from the front, so the bark is seen and not only its backlit rim. */}
      <directionalLight position={[1.5, 2, 6]} intensity={1.3} color={look.horizon} />
      <hemisphereLight color={look.zenith} groundColor={look.blots[1]} intensity={1.4} />
    </>
  );
}
