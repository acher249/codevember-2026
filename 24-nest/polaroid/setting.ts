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
  floor,
  fract,
  instanceIndex,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalMap,
  normalWorld,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  texture,
  uv,
  vec2,
  vec3
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { lehmer } from "../../shared/engine/random";
import { dappleAt, type Lighting } from "./light";
import { barkTube, type Scans } from "./nest";
import type { World } from "./worlds";

// What each nest sits in: a flowering branch in spring, an air conditioner on a brick wall at golden hour, an old oak
// limb at dusk. Then the sky behind, painted once at load already soft, as a lens would see it far out of focus: the
// render of the next world inside the photograph has no depth of field of its own, so the distance is blurred in the
// picture itself, and the photograph and the live view agree.

type Built = { group: THREE.Group; geometries: THREE.BufferGeometry[]; materials: THREE.Material[]; textures: THREE.Texture[] };

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// A leaf: a plane folded along its midrib and curled at the tip, stem at the origin, running along +x.
function leafGeometry() {
  const g = new THREE.PlaneGeometry(1, 1, 12, 6);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + 0.5;
    const y = p.getY(i) * 0.9;
    p.setXYZ(i, x, y, Math.abs(y) * 0.22 - x * x * 0.18);
  }
  g.computeVertexNormals();
  return g;
}

// A blossom: five cupped petals round a tuft of stamens, facing +y.
function blossomGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 5; k++) {
    const petal = new THREE.PlaneGeometry(1, 1, 5, 5);
    const p = petal.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const r = p.getY(i) + 0.5;
      // Lying out from the middle, cupped up at the edges and rising toward the rim.
      p.setXYZ(i, x * 0.9, 0.25 * r + x * x * 0.35, r);
    }
    petal.rotateY((k / 5) * Math.PI * 2);
    petal.computeVertexNormals();
    parts.push(petal);
  }
  for (const g of parts) {
    // The plane's faces point down once laid flat; turned over so they face up.
    const n = g.getAttribute("normal");
    for (let i = 0; i < n.count; i++) if (n.getY(i) < 0) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  }
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return merged;
}

// The far view, painted. `paint` draws over a gradient in a frame covering the front half of the sky: x across
// -90 to 90 degrees of bearing, y from straight up to straight down.
function sky(paint: (g: CanvasRenderingContext2D, at: (dir: THREE.Vector3) => [number, number], random: () => number) => void, seed: number, glow: number) {
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
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: true });
  const d = normalize(positionLocal) as any;
  const u = clamp(atan(d.x, d.z.negate()).div(Math.PI).add(0.5), 0.001, 0.999) as any;
  const vv = asin(clamp(d.y, -1, 1)).div(Math.PI).add(0.5) as any;
  m.colorNode = texture(tex, vec2(u, vv)).rgb.mul(glow) as any;
  const geometry = new THREE.SphereGeometry(330, 48, 24);
  const mesh = new THREE.Mesh(geometry, m);
  mesh.frustumCulled = false;
  return { mesh, geometry, material: m, texture: tex };
}

// Soft blobs, as out-of-focus things in the distance.
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
// A bokeh disc: a soft-edged, even circle of light, a touch brighter at its rim.
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

// Bark for limbs: the scan, tinted for the world, its normal map for the relief.
function barkMaterial(scans: Scans, tint: string, l: Lighting, lichen: number) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  const scan = uv() as any;
  let c: any = (texture(scans.bark, scan) as any).rgb.mul(color(tint).mul(2.2));
  const N = normalWorld as any;
  const top = smoothstep(-0.1, 0.8, N.y) as any;
  const patch = smoothstep(0.15, 0.35, mx_fractal_noise_float(positionLocal.mul(0.35), 3, 2, 0.5).add(top.mul(0.2)).sub(0.1)) as any;
  c = mix(c, mix(color("#7d8a6c"), color("#a9b494"), mx_noise_float(positionLocal.mul(3)).mul(0.5).add(0.5)), patch.mul(lichen));
  // Moss along the top of a big limb.
  m.colorNode = c as any;
  m.normalNode = normalMap(texture(scans.barkNormal, scan), vec2(1.6, 1.6)) as any;
  m.roughnessNode = (texture(scans.barkRough, scan) as any).r as any;
  // Backlit, a limb's edge glows with the fuzz on it.
  m.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const rim = pow(float(1).sub(dot(normalize(normalWorld), V).abs()), 4) as any;
    return (l.sun as any).mul(rim.mul(pow(max(dot(V.negate(), l.toSun), 0), 2)).mul(0.05)).mul(dappleAt(l, positionWorld));
  })() as any;
  return m;
}

// Leaves swaying on their stems, lit through from behind.
function leafMaterial(l: Lighting, leafColour: string, dark: number) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.55 });
  m.alphaTest = 0.5;
  const lx = uv().x as any;
  const ly = uv().y.sub(0.5).mul(2) as any;
  const teeth = fract(lx.mul(30)).sub(0.5).abs().mul(0.05) as any;
  const half = pow(lx.mul(Math.PI).sin().max(0), 0.7).mul(float(1).sub(lx.mul(0.3))).mul(0.92).sub(teeth) as any;
  m.opacityNode = smoothstep(0.02, -0.02, ly.abs().sub(half)) as any;
  const midrib = smoothstep(0.04, 0.0, ly.abs()) as any;
  const veins = smoothstep(0.07, 0.0, fract(lx.mul(9).sub(ly.abs().mul(2.4))).sub(0.5).abs()).mul(smoothstep(0.05, 0.2, ly.abs())) as any;
  const seed = (instanceIndex as any).toFloat().mul(0.137) as any;
  const vary = fract(sin(seed.mul(91.7)).mul(4375.5)) as any;
  let c: any = (mix as any)(color(leafColour), (color(leafColour) as any).mul(vec3(1.3, 1.2, 0.7)), vary.mul(0.6).add(lx.mul(0.3)));
  c = c.mul(mx_fractal_noise_float(vec3(lx.mul(10), ly.mul(10), seed), 2, 2, 0.5).mul(0.15).add(1)).mul(dark);
  c = mix(c, c.mul(1.35).add(0.02), midrib.max(veins.mul(0.5)));
  m.colorNode = c as any;
  m.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const through = pow(max(dot(V, (l.toSun as any).negate()), 0), 2) as any;
    return c.mul(l.sun as any).mul(through.mul(0.35).add(0.02)).mul(float(1).sub(midrib.max(veins).mul(0.5))).mul(dappleAt(l, positionWorld));
  })() as any;
  // A slow sway, more toward the tip.
  const phase = seed.mul(13.1) as any;
  const t = l.clock as any;
  const sway = vec3(sin(t.mul(1.1).add(phase)).mul(0.05), sin(t.mul(1.7).add(phase.mul(1.3))).mul(0.08), sin(t.mul(0.9).add(phase.mul(0.7))).mul(0.05)) as any;
  m.positionNode = positionLocal.add(sway.mul(positionLocal.x.mul(positionLocal.x))) as any;
  return m;
}

// A tree around the nest: limbs given as curves, twigs off them, leaves and blossoms at the twigs' ends.
function tree(world: World, l: Lighting, scans: Scans, opts: { limbs: { points: THREE.Vector3[]; r: [number, number]; twigs: number }[]; leaf: string; dark: number; leaves: number; blossoms: number; leafSize: number; lichen: number; seed: number }): Built {
  const random = lehmer(opts.seed);
  const bark: THREE.BufferGeometry[] = [];
  const leafAt: THREE.Matrix4[] = [];
  const blossomAt: THREE.Matrix4[] = [];
  const twigEnds: { at: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  opts.limbs.forEach((limb, li) => {
    bark.push(barkTube(limb.points, limb.r[0], limb.r[1], limb.r[0] > 1 ? 28 : 14, 6, li * 7));
    const curve = new THREE.CatmullRomCurve3(limb.points, false, "centripetal");
    for (let k = 0; k < limb.twigs; k++) {
      const t = 0.15 + random() * 0.8;
      const at = curve.getPointAt(t);
      // Never into the nest or across the camera's view of it.
      const away = new THREE.Vector3(random() - 0.5, 0.4 + random() * 0.6, random() - 0.6).normalize();
      if (at.clone().addScaledVector(away, 5).length() < 12) away.y -= 0.6;
      const r0 = Math.min(limb.r[0], limb.r[1] + (limb.r[0] - limb.r[1]) * (1 - t)) * 0.45;
      const points = [at.clone()];
      const dir = away.clone();
      const length = 6 + random() * 12;
      for (let s = 1; s <= 4; s++) {
        dir.add(new THREE.Vector3(random() - 0.5, random() * 0.3, random() - 0.5).multiplyScalar(0.35)).normalize();
        points.push(points[s - 1].clone().addScaledVector(dir, length / 4));
      }
      bark.push(barkTube(points, Math.max(0.12, r0), 0.08, 8, 4, 100 + li * 31 + k));
      const twig = new THREE.CatmullRomCurve3(points);
      for (let s = 0; s < 3; s++) twigEnds.push({ at: twig.getPointAt(0.55 + s * 0.2), dir: twig.getTangentAt(0.55 + s * 0.2) });
      twigEnds.push({ at: points[points.length - 1], dir });
    }
  });
  const pick = () => twigEnds[Math.floor(random() * twigEnds.length)];
  for (let k = 0; k < opts.leaves; k++) {
    const end = pick();
    const turn = new THREE.Quaternion().setFromUnitVectors(v(1, 0, 0), end.dir.clone().add(v(random() - 0.5, random() * 0.6 - 0.4, random() - 0.5).multiplyScalar(1.4)).normalize());
    turn.multiply(new THREE.Quaternion().setFromAxisAngle(v(1, 0, 0), (random() - 0.5) * 2.4));
    const size = opts.leafSize * (0.7 + random() * 0.5);
    leafAt.push(new THREE.Matrix4().compose(end.at.clone().add(v(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(0.8)), turn, v(size, size, size)));
  }
  for (let k = 0; k < opts.blossoms; k++) {
    const end = pick();
    const face = end.dir.clone().add(v(random() - 0.5, random() * 0.8, random() - 0.5)).normalize();
    const turn = new THREE.Quaternion().setFromUnitVectors(v(0, 1, 0), face);
    const size = 1.1 + random() * 0.5;
    blossomAt.push(new THREE.Matrix4().compose(end.at.clone().add(v(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(1.6)), turn, v(size, size, size)));
  }
  const group = new THREE.Group();
  const merged = mergeGeometries(bark);
  for (const g of bark) g.dispose();
  const barkM = barkMaterial(scans, world.nest.twig, l, opts.lichen);
  const limbMesh = new THREE.Mesh(merged, barkM);
  limbMesh.castShadow = limbMesh.receiveShadow = true;
  group.add(limbMesh);
  const geometries: THREE.BufferGeometry[] = [merged];
  const materials: THREE.Material[] = [barkM];
  const leafG = leafGeometry();
  const leafM = leafMaterial(l, opts.leaf, opts.dark);
  const leaves = new THREE.InstancedMesh(leafG, leafM, Math.max(1, leafAt.length));
  leafAt.forEach((m, i) => leaves.setMatrixAt(i, m));
  leaves.count = leafAt.length;
  leaves.castShadow = leaves.receiveShadow = true;
  leaves.computeBoundingSphere();
  group.add(leaves);
  geometries.push(leafG);
  materials.push(leafM);
  if (blossomAt.length) {
    const blossomG = blossomGeometry();
    const petal = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.6 });
    petal.alphaTest = 0.5;
    const pu = uv() as any;
    const across = pu.x.sub(0.5).mul(2) as any;
    const out = pu.y as any;
    // A rounded petal with a little notch, white blushing pink toward the middle, fine veins.
    const outline = float(1).sub(pow(out, 3)).mul(0.9).add(0.1).mul(smoothstep(0.0, 0.3, out).mul(0.6).add(0.4)) as any;
    const notch = smoothstep(0.92, 1.0, out).mul(float(1).sub(smoothstep(0.0, 0.15, across.abs()))) as any;
    petal.opacityNode = smoothstep(0.02, -0.02, across.abs().sub(outline)).mul(float(1).sub(notch)) as any;
    const veinsP = smoothstep(0.08, 0, fract(across.mul(6)).sub(0.5).abs()).mul(0.08) as any;
    const pc = mix(color("#f7c8d6"), color("#fff8f6"), smoothstep(0.0, 0.6, out)).sub(veinsP) as any;
    petal.colorNode = pc;
    petal.emissiveNode = Fn(() => {
      const V = normalize(cameraPosition.sub(positionWorld)) as any;
      const through = pow(max(dot(V, (l.toSun as any).negate()), 0), 2) as any;
      return pc.mul(l.sun as any).mul(through.mul(0.3).add(0.03)).mul(dappleAt(l, positionWorld));
    })() as any;
    const t = l.clock as any;
    const phase = (instanceIndex as any).toFloat().mul(1.71) as any;
    petal.positionNode = positionLocal.add(vec3(sin(t.mul(1.3).add(phase)).mul(0.06), 0, sin(t.mul(1.1).add(phase.mul(0.8))).mul(0.06))) as any;
    const blossoms = new THREE.InstancedMesh(blossomG, petal, blossomAt.length);
    blossomAt.forEach((m, i) => blossoms.setMatrixAt(i, m));
    blossoms.castShadow = true;
    blossoms.computeBoundingSphere();
    group.add(blossoms);
    // A few yellow-tipped stamens in each.
    const stamenG = new THREE.SphereGeometry(0.14, 8, 6);
    stamenG.translate(0, 0.45, 0);
    const stamenM = new THREE.MeshStandardNodeMaterial({ color: "#e8c24a", roughness: 0.6 });
    const stamens = new THREE.InstancedMesh(stamenG, stamenM, blossomAt.length * 6);
    const m4 = new THREE.Matrix4();
    blossomAt.forEach((m, i) => {
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        m4.makeTranslation(Math.cos(a) * 0.18, 0, Math.sin(a) * 0.18).premultiply(m);
        stamens.setMatrixAt(i * 6 + k, m4);
      }
    });
    stamens.computeBoundingSphere();
    group.add(stamens);
    geometries.push(blossomG, stamenG);
    materials.push(petal, stamenM);
  }
  return { group, geometries, materials, textures: [] };
}

// The air conditioner on the wall: a painted steel case with a louvred front and a grille on its side, streaked with
// grime and the odd white splash from the neighbours; the brick wall behind it and the building's corner.
function city(world: World, l: Lighting, scans: Scans): Built {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const top = -5.1;
  const box = { w: 54, h: 36, d: 44 };
  const centre = v(4, top - box.h / 2, -5);
  const paint = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.15 });
  {
    const p = positionWorld as any;
    const grime = smoothstep(0.1, 0.7, mx_fractal_noise_float(vec3(p.x.mul(0.15), p.y.mul(0.02), p.z.mul(0.15)), 3, 2, 0.5).add(smoothstep(top - 4, top - box.h, p.y).mul(0.3))) as any;
    const streak = smoothstep(0.55, 0.8, mx_noise_float(vec3(p.x.mul(0.6), p.y.mul(0.03), p.z.mul(0.6)))) as any;
    // A few white splashes on top.
    const splash = smoothstep(0.62, 0.68, mx_noise_float(vec3(p.x.mul(0.35), 4, p.z.mul(0.35)))).mul(step(top - 0.1, p.y)) as any;
    let c: any = mix(color("#d9d2c0"), color("#8a7e68"), grime.mul(0.6).add(streak.mul(0.25)));
    c = mix(c, color("#f4f2ea"), splash.mul(0.85));
    paint.colorNode = c;
    paint.roughnessNode = float(0.5).add(grime.mul(0.3)) as any;
  }
  materials.push(paint);
  const caseG = new THREE.BoxGeometry(box.w, box.h, box.d);
  caseG.translate(centre.x, centre.y, centre.z);
  geometries.push(caseG);
  const caseMesh = new THREE.Mesh(caseG, paint);
  caseMesh.castShadow = caseMesh.receiveShadow = true;
  group.add(caseMesh);
  // Louvres across the front, each a bent strip.
  const louvres: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 14; k++) {
    const g = new THREE.BoxGeometry(box.w - 6, 0.25, 2.2);
    g.rotateX(0.6);
    g.translate(centre.x, top - 5 - k * 2.1, centre.z + box.d / 2 + 0.6);
    louvres.push(g);
  }
  const louvreG = mergeGeometries(louvres);
  for (const g of louvres) g.dispose();
  geometries.push(louvreG);
  const dark = new THREE.MeshStandardNodeMaterial({ color: "#5a5246", roughness: 0.6, metalness: 0.2 });
  materials.push(dark);
  const louvreMesh = new THREE.Mesh(louvreG, paint);
  louvreMesh.castShadow = louvreMesh.receiveShadow = true;
  group.add(louvreMesh);
  const slot = new THREE.PlaneGeometry(box.w - 6, 30);
  slot.translate(centre.x, top - 5 - 13 * 1.05, centre.z + box.d / 2 + 0.05);
  geometries.push(slot);
  group.add(new THREE.Mesh(slot, dark));
  // The bracket under it, and the wall.
  const bracket = new THREE.BoxGeometry(2.5, 2.5, box.d + 4);
  bracket.translate(centre.x - box.w / 2 + 6, top - box.h - 1.3, centre.z - 2);
  const bracket2 = bracket.clone().translate(box.w - 12, 0, 0);
  geometries.push(bracket, bracket2);
  const steel = new THREE.MeshStandardNodeMaterial({ color: "#3a3430", roughness: 0.7, metalness: 0.5 });
  materials.push(steel);
  group.add(new THREE.Mesh(bracket, steel), new THREE.Mesh(bracket2, steel));

  const wallZ = centre.z - box.d / 2 - 0.5;
  const brick = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  {
    const p = positionWorld as any;
    const row = floor(p.y.div(7.5)) as any;
    const bx = p.x.div(22.5).add(row.mul(0.5)) as any;
    const cell = vec2(floor(bx), row) as any;
    const f = vec2(fract(bx), fract(p.y.div(7.5))) as any;
    const mortar = float(1).sub(smoothstep(0.0, 0.045, f.x).mul(smoothstep(1.0, 0.955, f.x)).mul(smoothstep(0.0, 0.12, f.y)).mul(smoothstep(1.0, 0.88, f.y))) as any;
    const tone = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453)) as any;
    const face = mx_fractal_noise_float(vec3(p.x.mul(0.8), p.y.mul(0.8), 3), 3, 2, 0.5).mul(0.5).add(0.5) as any;
    let c: any = mix(color("#8a4630"), color("#b0654a"), tone.mul(0.7).add(face.mul(0.3)));
    c = mix(c, color("#5e3426"), smoothstep(0.75, 1, tone).mul(0.6));
    c = mix(c, color("#b8ab98"), mortar);
    // Soot and a damp stain under the unit.
    const stain = smoothstep(0, 1, float(1).sub(p.x.sub(centre.x).abs().div(36))).mul(smoothstep(top - box.h, top - box.h - 40, p.y)).mul(0.55) as any;
    c = c.mul(float(1).sub(stain)).mul(mx_noise_float(vec3(p.x.mul(0.05), p.y.mul(0.01), 0)).mul(0.15).add(0.9));
    brick.colorNode = c;
    // The mortar sits back from the brick faces.
    brick.normalNode = null;
  }
  materials.push(brick);
  const wallG = new THREE.PlaneGeometry(130, 140, 1, 1);
  wallG.translate(-40, -20, wallZ);
  geometries.push(wallG);
  const wall = new THREE.Mesh(wallG, brick);
  wall.receiveShadow = true;
  group.add(wall);
  // The building's corner on the right, the wall turning away from the view.
  const sideG = new THREE.PlaneGeometry(120, 140);
  sideG.rotateY(-Math.PI / 2);
  sideG.translate(25, -20, wallZ - 60);
  geometries.push(sideG);
  const side = new THREE.Mesh(sideG, brick);
  side.receiveShadow = true;
  group.add(side);
  // A drain pipe down the corner.
  const pipeG = new THREE.CylinderGeometry(2.2, 2.2, 160, 20);
  pipeG.translate(21, -10, wallZ + 3);
  geometries.push(pipeG);
  const pipe = new THREE.Mesh(pipeG, steel);
  pipe.castShadow = pipe.receiveShadow = true;
  group.add(pipe);
  void scans;
  void l;
  void world;
  void instanceIndex;
  void attribute;
  return { group, geometries, materials, textures: [] };
}

export function buildSetting(world: World, l: Lighting, scans: Scans) {
  let built: Built;
  let painted: ReturnType<typeof sky>;
  const sun = new THREE.Vector3(...world.sun);
  if (world.key === "blossom") {
    built = tree(world, l, scans, {
      limbs: [
        { points: [v(-48, -17, -32), v(-18, -9.8, -7), v(0, -7.7, 0), v(16, -8.4, 3), v(44, -13, -12)], r: [2.6, 1.5], twigs: 8 },
        { points: [v(5, -7.6, -1), v(11, -1, -10), v(15, 12, -24), v(19, 28, -40)], r: [1.3, 0.45], twigs: 6 },
        { points: [v(-14, -9.5, -5), v(-21, -3, 3), v(-27, 2, 11)], r: [0.75, 0.25], twigs: 3 },
        { points: [v(-30, -13, -20), v(-34, -2, -32), v(-30, 12, -50)], r: [1.0, 0.4], twigs: 4 }
      ],
      leaf: "#6f9a3a",
      dark: 1,
      leaves: 150,
      blossoms: 70,
      leafSize: 5.2,
      lichen: 0.35,
      seed: 31
    });
    painted = sky(
      (g, at, random) => {
        gradient(g, [
          [0, "#9cc1f2"],
          [0.38, "#dfe9f2"],
          [0.5, "#e8eadc"],
          [0.62, "#8ea36a"],
          [1, "#3c4a26"]
        ]);
        const [sx, sy] = at(sun);
        blob(g, sx, sy, 170, "#fff6dc", 0.85, 50);
        // Foliage far off, in greens, with blossom.
        for (let k = 0; k < 140; k++) {
          const x = random() * 2048;
          const y = 300 + random() * 724;
          blob(g, x, y, 30 + random() * 110, ["#5e7f34", "#7c9b45", "#46642a", "#93ad62", "#e8c8d4"][Math.floor(random() * 5)], 0.25 + random() * 0.4, 18 + random() * 20);
        }
        // Sun through leaves, out of focus.
        for (let k = 0; k < 70; k++) {
          const x = sx + (random() - 0.5) * 900;
          const y = sy + (random() - 0.3) * 600;
          bokeh(g, x, y, 4 + random() * 11, "#fff3d6", 0.25 + random() * 0.45);
        }
      },
      11,
      1.25
    );
  } else if (world.key === "dusk") {
    built = tree(world, l, scans, {
      limbs: [
        { points: [v(-50, -20, -26), v(-20, -11, -6), v(0, -8.6, 0), v(18, -9.5, 2), v(46, -16, -16)], r: [3.4, 2.0], twigs: 7 },
        { points: [v(-6, -9.5, -2), v(-12, 0, -14), v(-18, 16, -30), v(-22, 34, -46)], r: [1.6, 0.6], twigs: 5 },
        { points: [v(22, -10, 1), v(28, -2, 10), v(34, 4, 16)], r: [0.8, 0.3], twigs: 3 }
      ],
      leaf: "#4a5e2a",
      dark: 0.7,
      leaves: 110,
      blossoms: 0,
      leafSize: 6.5,
      lichen: 0.8,
      seed: 77
    });
    painted = sky(
      (g, at, random) => {
        gradient(g, [
          [0, "#1a2244"],
          [0.3, "#3a4878"],
          [0.44, "#c86a6a"],
          [0.5, "#ffb07a"],
          [0.56, "#4a3040"],
          [1, "#120c10"]
        ]);
        const [sx, sy] = at(sun);
        blob(g, sx, sy, 220, "#ffc890", 0.8, 70);
        // Treeline: dark crowns along the horizon.
        for (let k = 0; k < 90; k++) {
          const x = random() * 2048;
          blob(g, x, 520 + random() * 80, 40 + random() * 90, "#140e14", 0.85, 16);
        }
        // The first stars and a moon.
        for (let k = 0; k < 120; k++) blob(g, random() * 2048, random() * 380, 1.4, "#ffffff", 0.3 + random() * 0.6, 1);
        const [mx, my] = at(v(-0.35, 0.42, -0.84));
        blob(g, mx, my, 16, "#fff8e8", 0.95, 3);
        blob(g, mx, my, 60, "#c8d0ff", 0.18, 30);
        // Lights far off in houses, out of focus.
        for (let k = 0; k < 40; k++) bokeh(g, random() * 2048, 560 + random() * 120, 6 + random() * 14, "#ffc070", 0.5);
      },
      23,
      1
    );
  } else {
    built = city(world, l, scans);
    painted = sky(
      (g, at, random) => {
        gradient(g, [
          [0, "#5a78b0"],
          [0.4, "#f0b48a"],
          [0.5, "#ffcf9a"],
          [0.58, "#7a5a58"],
          [1, "#2a2224"]
        ]);
        // Buildings across the street, soft, windows lit.
        for (let k = 0; k < 26; k++) {
          const x = random() * 2048;
          const w = 80 + random() * 160;
          const h = 120 + random() * 300;
          g.save();
          g.filter = "blur(14px)";
          g.fillStyle = ["#4a3a40", "#5a4648", "#3a3036"][k % 3];
          g.fillRect(x, 560 - h, w, h + 500);
          g.restore();
          for (let j = 0; j < 10; j++) bokeh(g, x + random() * w, 560 - random() * h, 5 + random() * 6, "#ffd08a", random() < 0.5 ? 0.5 : 0.15);
        }
        void at;
      },
      37,
      1.15
    );
  }
  built.group.add(painted.mesh);
  built.geometries.push(painted.geometry);
  built.materials.push(painted.material);
  built.textures.push(painted.texture);
  return built;
}
