/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { attribute, color, float, mix, mx_fractal_noise_float, mx_noise_float, normalLocal, normalMap, positionLocal, positionWorld, smoothstep, texture, uv, vec2, vec3 } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { lehmer } from "../../shared/engine/random";
import { downGeometry, downMaterial, type Tuft } from "./down";
import type { Lighting } from "./light";
import type { World } from "./worlds";

// The nest: a deep cup woven from twigs, grass and a little moss, plastered with mud inside and lined with fine dry
// grass, a few down feathers caught in it. Every twig is a bark tube wound round the cup, crossing the others, some
// pushed deep and some standing proud, their ends sticking out where the weave lets them; the grass is flat strands
// following the same surface over the lip and down inside. All of it merged: one draw for the twigs, one for the grass.

export type Scans = { bark: THREE.Texture; barkNormal: THREE.Texture; barkRough: THREE.Texture; moss: THREE.Texture };

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

// A tube along points, thinning from r0 to r1, its bark wrapped round a whole number of times.
export function barkTube(points: THREE.Vector3[], r0: number, r1: number, sides: number, tile: number, seed: number) {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
  const length = curve.getLength();
  const steps = Math.max(4, Math.round(length / Math.max(0.25, r0 * 1.5)));
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
    // A rounded end at the tip, a broken one at the base.
    if (t > 0.97) r *= Math.sqrt(Math.max(0.05, (1 - t) / 0.03));
    const around = Math.max(1, Math.round((2 * Math.PI * Math.max(r, 0.05)) / tile));
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
  const deep = smoothstep(0.3, -shape.innerDepth * 0.9, p.y) as any;
  return float(1).sub(inside.mul(deep).mul(0.72)) as any;
}

export function buildNest(world: World, l: Lighting, scans: Scans, seed: number) {
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
  const blades = 1500;
  for (let k = 0; k < blades; k++) {
    const where = random();
    const inside = where < 0.5;
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
  const profile: THREE.Vector2[] = [];
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
  // Points run bottom-out, up, over and down in: a lathe of them faces out (checked with the normals view).
  const lathe = new THREE.LatheGeometry(profile, 72);
  lathe.deleteAttribute("uv");

  // Materials.
  const bark = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  const scan = uv() as any;
  const shade = cupShade(positionWorld, shape);
  bark.colorNode = (texture(scans.bark, scan) as any).rgb.mul(color(world.nest.twig).mul(2.2)).mul(shade) as any;
  bark.normalNode = normalMap(texture(scans.barkNormal, scan), vec2(1.4, 1.4)) as any;
  bark.roughnessNode = (texture(scans.barkRough, scan) as any).r as any;

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
    grassMaterial.colorNode = c.mul(shade) as any;
  }

  const core = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  {
    const fibres = mx_fractal_noise_float(positionLocal.mul(vec3(1.5, 4, 1.5)), 3, 2, 0.5).mul(0.5).add(0.5) as any;
    core.colorNode = mix(color(world.nest.mud).mul(0.55), color(world.nest.grass).mul(0.6), fibres.mul(0.5)).mul(shade) as any;
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

  // Moss: soft cushions tucked into the outside, the scan on displaced, flattened blobs.
  const geometries: THREE.BufferGeometry[] = [twigGeometry, grassGeometry, lathe];
  const materials: THREE.Material[] = [bark, grassMaterial, core];
  if (world.nest.moss > 0) {
    const cushions: THREE.BufferGeometry[] = [];
    const count = Math.round(7 * world.nest.moss);
    for (let k = 0; k < count; k++) {
      const theta = random() * Math.PI * 2;
      const h = 0.15 + random() * 0.6;
      const at = surfacePoint(theta, h, 0.1);
      const n = surfaceNormal(theta, h);
      const blob = new THREE.IcosahedronGeometry(1, 3);
      blob.deleteAttribute("uv");
      const size = 0.9 + random() * 1.4;
      const p = blob.getAttribute("position");
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        const bump = 1 + Math.sin(x * 7 + k) * Math.sin(y * 6) * Math.sin(z * 8) * 0.18;
        p.setXYZ(i, x * size * bump, Math.max(-0.2, y) * size * 0.45 * bump, z * size * 0.8 * bump);
      }
      blob.computeVertexNormals();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      blob.applyMatrix4(new THREE.Matrix4().compose(at, q, new THREE.Vector3(1, 1, 1)));
      cushions.push(blob);
    }
    const mossGeometry = mergeGeometries(cushions);
    for (const g of cushions) g.dispose();
    const moss = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
    const mp = positionLocal.mul(0.35) as any;
    const scanned = (texture(scans.moss, vec2(mp.x.add(mp.y.mul(0.5)), mp.z.add(mp.y.mul(0.5)))) as any).rgb as any;
    moss.colorNode = scanned.mul(1.1).mul(mx_noise_float(positionLocal.mul(4)).mul(0.25).add(0.9)) as any;
    moss.normalNode = null;
    const mesh = new THREE.Mesh(mossGeometry, moss);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    geometries.push(mossGeometry);
    materials.push(moss);
    void normalLocal;
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
    const m = downMaterial(l, { root: world.chick.root, tip: world.chick.tip }, l.clock);
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    group.add(mesh);
    geometries.push(g);
    materials.push(m);
  }

  // City pigeons build with what they find: a length of twine and a strip of plastic, woven in.
  if (world.nest.litter) {
    const twine: THREE.Vector3[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      twine.push(surfacePoint(0.6 + t * 2.4, 0.1 + Math.sin(t * 9) * 0.06, 0.25));
    }
    const g = barkTube(twine, 0.09, 0.09, 6, 1, 3);
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
    // A red and white twist.
    m.colorNode = mix(color("#c8302a"), color("#efe6dc"), smoothstep(0.4, 0.6, uv().y.mul(6).add(uv().x).fract())) as any;
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    group.add(mesh);
    geometries.push(g);
    materials.push(m);
  }

  return { group, geometries, materials, shape };
}
