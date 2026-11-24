/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { attribute, color, float, mix, mx_fractal_noise_float, mx_noise_float, normalMap, normalWorld, positionLocal, positionWorld, smoothstep, texture, uv, vec2, vec3 } from "three/tsl";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { lehmer } from "../../shared/engine/random";
import { downGeometry, downMaterial, type Tuft } from "./down";
import { snowCap, weather, type Lighting } from "./light";

// The nest: a deep cup woven from twigs, grass and a little moss, plastered with mud inside and lined with fine dry
// grass, a few down feathers caught in it. Every twig is a bark tube wound round the cup, crossing the others, some
// pushed deep and some standing proud, their ends sticking out where the weave lets them; the grass is flat strands
// following the same surface over the lip and down inside. All of it merged: one draw for the twigs, one for the grass.
// In winter the weave carries frost, and a ring of snow lies on the rim, both melting away as the dial warms it.

// An old nest's colours: weathered grey-brown twigs, bleached grass, dark mud, a little moss.
export const NEST = { twig: "#6e6050", grass: "#9a8a6a", mud: "#3e3228", moss: 1, sticks: 1.35, radius: 8.5 };
export const DOWN = { root: "#cfc6bb", tip: "#fbf8f2" };

export type Scans = { bark: THREE.Texture; barkNormal: THREE.Texture; barkRough: THREE.Texture; barkDisp: THREE.Texture; moss: THREE.Texture };

// The cup's shape: from the rim (h 0) to the bottom (h 1), outside and in.
export function nestShape(radius: number) {
  const depth = radius * 0.62;
  const inner = radius * 0.68;
  const innerDepth = radius * 0.44;
  return {
    radius,
    depth,
    inner,
    innerDepth,
    outer: (h: number) => ({ r: radius * Math.sqrt(Math.max(0.04, 1 - h * h * 0.78)), y: -h * depth }),
    inside: (h: number) => ({ r: inner * Math.sqrt(Math.max(0.0, 1 - h * h * 0.92)) + 0.01, y: -h * innerDepth })
  };
}

// A tube along points, thinning from r0 to r1, its bark wrapped round a whole number of times. `step` sets the ring
// spacing (for a tube that is displaced, so needs fine rings); `flare` swells it where it leaves a trunk (a vertical
// cylinder at x, z of radius R), as a branch's collar does, the swelling dying away over a couple of its own widths.
export type TubeOptions = { step?: number; flare?: { x: number; z: number; R: number } };
export function barkTube(points: THREE.Vector3[], r0: number, r1: number, sides: number, tile: number, seed: number, options: TubeOptions = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
  const length = curve.getLength();
  // Rings no closer than the path's own points need (they are about 0.6 apart), however thin the tube.
  const steps = Math.max(4, Math.round(length / (options.step ?? Math.max(0.45, r0 * 1.5))));
  const flare = options.flare;
  const frames = curve.computeFrenetFrames(steps, false);
  const position: number[] = [];
  const normal: number[] = [];
  const radius: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const n = new THREE.Vector3();
  const offset = (seed * 0.618) % 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const at = curve.getPointAt(t);
    let r = r0 + (r1 - r0) * t;
    const around = Math.max(1, Math.round((2 * Math.PI * Math.max(r, 0.05)) / tile));
    // A rounded end at the tip, a broken one at the base.
    if (t > 0.97) r *= Math.sqrt(Math.max(0.05, (1 - t) / 0.03));
    if (flare) {
      const out = Math.max(0, Math.hypot(at.x - flare.x, at.z - flare.z) - flare.R);
      r *= 1 + 0.65 * Math.exp(-out / (r0 * 1.1));
    }
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      n.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a));
      position.push(at.x + n.x * r, at.y + n.y * r, at.z + n.z * r);
      normal.push(n.x, n.y, n.z);
      radius.push(r);
      uvs.push((j / sides) * around + offset, (t * length) / tile + seed * 0.37);
    }
  }
  // Wound so the outside faces out: along the tube, then round it the way the frame turns.
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute("aRadius", new THREE.Float32BufferAttribute(radius, 1));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  return g;
}

// A flat strand of grass lying along a path on a surface whose normal is given at each point.
function strand(points: THREE.Vector3[], normals: THREE.Vector3[], width: number, tone: number) {
  const position: number[] = [];
  const normal: number[] = [];
  const shade: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const side = new THREE.Vector3();
  const along = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    along.subVectors(points[Math.min(points.length - 1, i + 1)], points[Math.max(0, i - 1)]).normalize();
    side.crossVectors(normals[i], along).normalize();
    const t = i / (points.length - 1);
    const w = width * (t > 0.85 ? Math.max(0.15, (1 - t) / 0.15) : 1);
    for (const s of [-1, 1]) {
      position.push(p.x + side.x * w * s, p.y + side.y * w * s, p.z + side.z * w * s);
      normal.push(normals[i].x, normals[i].y, normals[i].z);
      shade.push(tone);
      uvs.push(s * 0.5 + 0.5, t);
    }
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute("aTone", new THREE.Float32BufferAttribute(shade, 1));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  return g;
}

// How dark it is down in the cup, by where a point is: the deeper and further in, the less sky it sees.
export function cupShade(p: any, shape: ReturnType<typeof nestShape>) {
  const across = vec2(p.x, p.z).length() as any;
  const inside = float(1).sub(smoothstep(shape.inner * 0.75, shape.inner * 1.05, across)) as any;
  const deep = float(1).sub(smoothstep(-shape.innerDepth * 0.9, 0.3, p.y)) as any;
  // Underneath, where it sits on the limb and the light cannot get in.
  const under = smoothstep(-shape.depth - 0.9, -shape.depth + 1.4, p.y).mul(0.5).add(0.5) as any;
  return float(1).sub(inside.mul(deep).mul(0.72)).mul(under) as any;
}

// The limb the nest sits on, in the nest's frame: it runs along x under the cup, its axis this far down, this thick.
export type Perch = { y: number; r: number };

// `detail` scales how many grass strands it is woven from; `perch` is the limb its base settles round.
export function buildNest(l: Lighting, scans: Scans, seed: number, detail = 1, perch: Perch = { y: -7.6, r: 2.4 }) {
  const world = { nest: NEST };
  const random = lehmer(seed);
  const shape = nestShape(world.nest.radius);
  const twigs: THREE.BufferGeometry[] = [];
  const grass: THREE.BufferGeometry[] = [];
  const surfacePoint = (theta: number, h: number, out: number, inside = false) => {
    const s = inside ? shape.inside(h) : shape.outer(h);
    const r = s.r + (inside ? -out : out);
    return new THREE.Vector3(Math.cos(theta) * r, s.y, Math.sin(theta) * r);
  };
  const surfaceNormal = (theta: number, h: number, inside = false) => {
    const a = inside ? shape.inside(h) : shape.outer(h);
    const b = inside ? shape.inside(h + 0.02) : shape.outer(h + 0.02);
    // Tangent down the profile, turned a quarter round the circle's tangent.
    const dr = b.r - a.r;
    const dy = b.y - a.y;
    const n = new THREE.Vector3(Math.cos(theta) * -dy, dr, Math.sin(theta) * -dy).normalize();
    return inside ? n.negate() : n;
  };
  const noise = (x: number) => Math.sin(x * 1.7 + 1.3) * 0.5 + Math.sin(x * 3.9 + 0.4) * 0.3 + Math.sin(x * 7.3 + 2.1) * 0.2;

  // Twigs round the outside, from the bottom up to the lip, the biggest and most along the upper half.
  const sticks = Math.round(150 * world.nest.sticks);
  for (let k = 0; k < sticks; k++) {
    const thick = random();
    const r0 = (0.07 + thick * thick * 0.2) * (0.8 + world.nest.sticks * 0.25);
    const length = 5 + random() * 11 * (0.7 + thick * 0.6);
    let theta = random() * Math.PI * 2;
    let h = Math.min(0.97, Math.pow(random(), 1.25) * 1.05);
    const turn = (random() < 0.5 ? -1 : 1) * (0.8 + random() * 0.5);
    const climb = (random() - 0.5) * 0.08;
    const depth = (random() - 0.35) * 0.55;
    const points: THREE.Vector3[] = [];
    const step = 0.6;
    const n = Math.max(3, Math.round(length / step));
    const wobble = random() * 100;
    for (let i = 0; i <= n; i++) {
      const s = shape.outer(Math.min(1, h));
      const out = r0 + depth + noise(wobble + i * 0.35) * 0.35;
      points.push(surfacePoint(theta, h, out));
      theta += (turn * step) / Math.max(1, s.r);
      h = Math.max(-0.04, Math.min(1, h + climb + noise(wobble * 1.3 + i * 0.2) * 0.02));
    }
    // Some ends break free of the weave and stick straight out.
    if (random() < 0.45) {
      const last = points[points.length - 1];
      const prev = points[points.length - 2];
      const dir = last.clone().sub(prev).normalize().add(new THREE.Vector3(last.x, 0, last.z).normalize().multiplyScalar(0.3 + random() * 0.5)).add(new THREE.Vector3(0, random() * 0.4, 0)).normalize();
      const reach = 1 + random() * 3.5;
      points.push(last.clone().addScaledVector(dir, reach * 0.5), last.clone().addScaledVector(dir, reach));
    }
    const sides = r0 > 0.16 ? 8 : 6;
    twigs.push(barkTube(points, r0, r0 * (0.55 + random() * 0.3), sides, 2.2, k + seed));
  }
  // The base settled onto the limb: twigs and old grass stalks from the bottom of the cup draped over its sides and
  // down, a few tucked right under, so the nest holds the branch rather than balancing on it.
  for (let k = 0; k < 34; k++) {
    const side = random() < 0.5 ? -1 : 1;
    const x0 = (random() - 0.5) * 7;
    const r0 = 0.06 + random() * 0.12;
    // Leaving the nest low on its side, then round the limb from where it leaves to well down its flank or under it.
    const h = 0.8 + random() * 0.18;
    const s = shape.outer(h);
    const z0 = side * Math.min(s.r * 0.9, 0.5 + random() * 1.8);
    const start = new THREE.Vector3(x0, s.y + 0.05, z0);
    // Pressed to the bark, a little into it.
    const ring = perch.r + r0 * 0.5;
    const from = Math.atan2(Math.abs(z0), start.y - perch.y);
    const to = from + 0.4 + random() * (random() < 0.12 ? 1.1 : 0.5);
    const points = [start];
    const drift = (random() - 0.5) * 3;
    for (let i = 1; i <= 7; i++) {
      const a = from + ((to - from) * i) / 7;
      points.push(new THREE.Vector3(x0 + (drift * i) / 7, perch.y + Math.cos(a) * ring, side * Math.sin(a) * ring));
    }
    twigs.push(barkTube(points, r0, r0 * 0.6, 6, 2.2, 1300 + k));
  }

  // A few crossing the lip, over into the cup.
  for (let k = 0; k < 26; k++) {
    const theta = random() * Math.PI * 2;
    const r0 = 0.06 + random() * 0.08;
    const points: THREE.Vector3[] = [];
    const a = random() * 0.5;
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const th = theta + (t - 0.5) * (0.5 + a);
      // Out over the top of the lip and down the inside.
      const lip = Math.sin(t * Math.PI);
      const r = shape.radius * (1 - t) + shape.inner * t;
      points.push(new THREE.Vector3(Math.cos(th) * r, 0.25 + lip * 0.45 - t * t * 1.6, Math.sin(th) * r));
    }
    twigs.push(barkTube(points, r0, r0 * 0.7, 6, 2.2, 500 + k));
  }

  // Grass: wound round outside, thick over the lip, and lining the cup in fine coils.
  const blades = Math.round(1500 * detail);
  for (let k = 0; k < blades; k++) {
    const where = random();
    const inside = where < 0.6;
    const lip = !inside && where < 0.68;
    let theta = random() * Math.PI * 2;
    let h = inside ? Math.pow(random(), 0.8) * 0.98 : lip ? random() * 0.12 - 0.04 : random() * 0.95;
    const turn = (random() < 0.5 ? -1 : 1) * (0.7 + random() * 0.6);
    const climb = (random() - 0.5) * (inside ? 0.06 : 0.05);
    const length = 3 + random() * 7;
    const width = inside ? 0.025 + random() * 0.035 : 0.03 + random() * 0.045;
    const lift = inside ? 0.02 + random() * 0.08 : 0.06 + random() * 0.3;
    const points: THREE.Vector3[] = [];
    const normals: THREE.Vector3[] = [];
    const step = 0.4;
    const n = Math.round(length / step);
    const wobble = random() * 50;
    const across = (random() - 0.5) * 0.8;
    for (let i = 0; i <= n; i++) {
      const hh = Math.max(lip ? -0.08 : 0, Math.min(1, h));
      if (lip && hh < 0.02) {
        // Over the top of the lip, wandering slowly across it.
        const r = (shape.radius + shape.inner) / 2 + across + noise(wobble + i * 0.12) * (shape.radius - shape.inner) * 0.3;
        points.push(new THREE.Vector3(Math.cos(theta) * r, 0.45 + lift + noise(wobble + i * 0.15) * 0.15, Math.sin(theta) * r));
        normals.push(new THREE.Vector3(0, 1, 0));
      } else {
        points.push(surfacePoint(theta, hh, lift + noise(wobble + i * 0.12) * 0.08, inside));
        normals.push(surfaceNormal(theta, hh, inside));
      }
      const r = (inside ? shape.inside(hh) : shape.outer(hh)).r;
      theta += (turn * step) / Math.max(0.8, r);
      h += climb + noise(wobble + i * 0.07) * 0.006;
    }
    grass.push(strand(points, normals, width, 0.45 + random() * 0.6));
  }

  // The body of the nest under the weave: one surface from the bottom, up the outside, over the lip and down inside,
  // so no gap in the twigs ever shows through to the sky.
  // It starts and ends on the axis, so the underside and the floor of the cup are closed.
  const profile: THREE.Vector2[] = [new THREE.Vector2(0.001, shape.outer(1).y - 0.04)];
  for (let i = 0; i <= 16; i++) {
    const h = 1 - i / 16;
    const s = shape.outer(h);
    profile.push(new THREE.Vector2(Math.max(0.01, s.r - 0.15), s.y));
  }
  for (let i = 1; i < 6; i++) {
    const a = (i / 6) * Math.PI;
    profile.push(new THREE.Vector2((shape.radius + shape.inner) / 2 + Math.cos(a) * (shape.radius - shape.inner) * 0.5, Math.sin(a) * 0.35));
  }
  for (let i = 0; i <= 16; i++) {
    const s = shape.inside(i / 16);
    profile.push(new THREE.Vector2(Math.max(0.01, s.r + 0.05), s.y - 0.05));
  }
  profile.push(new THREE.Vector2(0.001, -shape.innerDepth - 0.08));
  // Points run bottom-out, up, over and down in: a lathe of them faces out (checked with the normals view).
  const lathe = new THREE.LatheGeometry(profile, 72);
  lathe.deleteAttribute("uv");

  // Materials.
  const bark = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  const scan = uv() as any;
  const shade = cupShade(positionWorld, shape);
  {
    const w = weather(l, (texture(scans.bark, scan) as any).rgb.mul(color(world.nest.twig).mul(2.2)), (texture(scans.barkRough, scan) as any).r, positionWorld, normalWorld, 0.8);
    bark.colorNode = w.colour.mul(shade) as any;
    bark.roughnessNode = w.rough as any;
  }
  bark.normalNode = normalMap(texture(scans.barkNormal, scan), vec2(1.4, 1.4)) as any;

  const grassMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, side: THREE.DoubleSide });
  {
    const tone = attribute("aTone", "float") as any;
    const along = uv().y as any;
    // Dry blades: pale straw, some greyed, the odd one still a little green; a fine line down the middle.
    const vary = mx_noise_float(positionLocal.mul(0.9)).mul(0.5).add(0.5) as any;
    let c: any = mix(color(world.nest.grass), color("#8a826e"), vary.mul(0.6));
    c = mix(c, color("#8f9a5a"), smoothstep(0.75, 1, mx_noise_float(positionLocal.mul(0.37).add(9))).mul(0.5));
    c = c.mul(tone).mul(float(1).sub(uv().x.sub(0.5).abs().mul(0.5)));
    c = c.mul(mx_noise_float(vec3(along.mul(40), tone.mul(20), 0)).mul(0.12).add(0.94));
    const w = weather(l, c, float(0.75), positionWorld, normalWorld, 0.8);
    grassMaterial.colorNode = w.colour.mul(shade) as any;
    grassMaterial.roughnessNode = w.rough as any;
  }

  const core = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  {
    const fibres = mx_fractal_noise_float(positionLocal.mul(vec3(1.5, 4, 1.5)), 3, 2, 0.5).mul(0.5).add(0.5) as any;
    const w = weather(l, mix(color(world.nest.mud).mul(0.55), color(world.nest.grass).mul(0.6), fibres.mul(0.5)), float(1), positionWorld, normalWorld);
    core.colorNode = w.colour.mul(shade) as any;
    core.roughnessNode = w.rough as any;
    core.normalNode = null;
  }

  const group = new THREE.Group();
  const twigGeometry = mergeGeometries(twigs);
  const grassGeometry = mergeGeometries(grass);
  for (const g of [...twigs, ...grass]) g.dispose();
  const twigMesh = new THREE.Mesh(twigGeometry, bark);
  const grassMesh = new THREE.Mesh(grassGeometry, grassMaterial);
  const coreMesh = new THREE.Mesh(lathe, core);
  for (const m of [twigMesh, grassMesh, coreMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  // The grass lies on the cup it would shade, so its shadow shows nothing the body's does not.
  grassMesh.castShadow = false;

  // Moss: soft cushions tucked into the outside, the scan on displaced, flattened blobs.
  const geometries: THREE.BufferGeometry[] = [twigGeometry, grassGeometry, lathe];
  const materials: THREE.Material[] = [bark, grassMaterial, core];
  if (world.nest.moss > 0) {
    const cushions: THREE.BufferGeometry[] = [];
    const count = Math.round(4 * world.nest.moss);
    for (let k = 0; k < count; k++) {
      const theta = random() * Math.PI * 2;
      const h = 0.15 + random() * 0.6;
      const at = surfacePoint(theta, h, 0.1);
      const n = surfaceNormal(theta, h);
      const blob = new THREE.IcosahedronGeometry(1, 3);
      blob.deleteAttribute("uv");
      const size = 0.6 + random() * 0.8;
      const p = blob.getAttribute("position");
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        const bump = 1 + Math.sin(x * 7 + k) * Math.sin(y * 6) * Math.sin(z * 8) * 0.18;
        p.setXYZ(i, x * size * bump, Math.max(-0.2, y) * size * 0.45 * bump, z * size * 0.8 * bump);
      }
      // Welded first, or the icosahedron's own split vertices leave every face flat.
      blob.deleteAttribute("normal");
      const welded = mergeVertices(blob);
      blob.dispose();
      welded.computeVertexNormals();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      welded.applyMatrix4(new THREE.Matrix4().compose(at, q, new THREE.Vector3(1, 1, 1)));
      cushions.push(welded);
    }
    const mossGeometry = mergeGeometries(cushions);
    for (const g of cushions) g.dispose();
    const moss = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
    const mp = positionLocal.mul(0.35) as any;
    const scanned = (texture(scans.moss, vec2(mp.x.add(mp.y.mul(0.5)), mp.z.add(mp.y.mul(0.5)))) as any).rgb as any;
    const w = weather(l, scanned.mul(1.1).mul(mx_noise_float(positionLocal.mul(4)).mul(0.25).add(0.9)), float(1), positionWorld, normalWorld);
    moss.colorNode = w.colour as any;
    moss.roughnessNode = w.rough as any;
    moss.normalNode = null;
    const mesh = new THREE.Mesh(mossGeometry, moss);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    geometries.push(mossGeometry);
    materials.push(moss);
  }

  // Down caught in the lining, shed by the chicks: a few loose puffs on the inside of the lip.
  {
    const tufts: Tuft[] = [];
    for (let k = 0; k < 14; k++) {
      const theta = random() * Math.PI * 2;
      const h = random() * 0.35;
      const root = surfacePoint(theta, h, 0.1, true);
      const normal = surfaceNormal(theta, h, true).lerp(new THREE.Vector3(0, 1, 0), 0.5).normalize();
      const lean = new THREE.Vector3(-Math.sin(theta), 0, Math.cos(theta));
      tufts.push({ root, normal, lean, length: 0.7 + random() * 0.6, spread: 1.1, count: 22, tone: 1 });
    }
    const g = downGeometry(tufts, random, 0.012);
    const m = downMaterial(l, DOWN, l.clock);
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    group.add(mesh);
    geometries.push(g);
    materials.push(m);
  }

  // Snow on the rim: the body's own surface pushed up into a soft ring over the lip, only near the top.
  {
    const cap = snowCap(
      l,
      () => float(0.9),
      // Near the top only, in clumps with twigs showing between.
      (p: any) => smoothstep(-2.2, -0.6, p.y).mul(smoothstep(-0.25, 0.2, mx_noise_float(p.mul(0.45))))
    );
    const mesh = new THREE.Mesh(lathe, cap);
    mesh.receiveShadow = true;
    group.add(mesh);
    materials.push(cap);

    // Snow settled in the cup round the chicks: a shallow bowl following the lining, sunk half a centimetre into it, so
    // the cap's push up along its normals is what shows. Melted, it sinks back under the lining and is cut away.
    const R = shape.inside(0.12).r - 0.15;
    const profile: THREE.Vector2[] = [];
    for (let i = 0; i <= 14; i++) {
      const r = (i / 14) * R;
      profile.push(new THREE.Vector2(Math.max(0.001, r), -1.2 + Math.pow(r / R, 2) * 0.6));
    }
    // The profile runs outward from the middle; reversed, the lathe's faces look up out of the cup.
    const cup = new THREE.LatheGeometry(profile.reverse(), 72);
    cup.deleteAttribute("uv");
    const settled = snowCap(l, () => float(1.3));
    const snowIn = new THREE.Mesh(cup, settled);
    snowIn.receiveShadow = true;
    group.add(snowIn);
    geometries.push(cup);
    materials.push(settled);
  }

  return { group, geometries, materials, shape };
}
