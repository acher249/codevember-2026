import {
  Fn,
  If,
  abs,
  cameraPosition,
  clamp,
  color,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  instanceIndex,
  int,
  ivec2,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,

  positionWorld,
  pow,
  reflect,
  reflector,
  sin,
  smoothstep,
  sqrt,
  texture,
  texture3D,
  textureLoad,
  textureStore,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import * as THREE from "three/webgpu";
import { R, insideSkin } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The sea. Its waves are ported from Ultra Water by Humpalumps, https://github.com/Humpalumps/Ultra-Water (MIT, see
// ultra-water-LICENSE.txt): a Tessendorf FFT ocean with JONSWAP spectra and Stockham transforms, there in WebGL2 and here in
// WebGPU compute. The surface shading here is written for this scene.

const G = 9.81;
const LOOP = 300;

export type OceanOptions = { size: number; lengths: number[]; wind: number; fetchKm: number; direction: number; height: number };

const jonswap = (w: number, alpha: number, peak: number, gamma: number) => {
  const sigma = w <= peak ? 0.07 : 0.09;
  const r = Math.exp(-((w - peak) * (w - peak)) / (2 * sigma * sigma * peak * peak));
  return alpha * G * G * Math.pow(w, -5) * Math.exp(-1.25 * Math.pow(peak / w, 4)) * Math.pow(gamma, r);
};

const gaussian = () => {
  const r = Math.sqrt(-2 * Math.log(1 - Math.random()));
  const a = Math.random() * Math.PI * 2;
  return [r * Math.cos(a), r * Math.sin(a)];
};

// The starting wave heights: one complex number per wave, drawn from the spectrum.
function bakeSpectrum(size: number, length: number, hi: number, lo: number, options: OceanOptions) {
  const fetch = options.fetchKm * 1000;
  const alpha = 0.076 * Math.pow((G * fetch) / (options.wind * options.wind), -0.22);
  const peak = 22 * Math.pow((options.wind * fetch) / (G * G), -0.33);
  const dk = (2 * Math.PI) / length;
  const spec = new Float32Array(size * size * 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const kx = (x - size / 2) * dk;
      const kz = (y - size / 2) * dk;
      const k = Math.hypot(kx, kz);
      if (k < lo || k > hi) continue;
      const w = Math.sqrt(G * k);
      const theta = Math.atan2(kz, kx) - options.direction;
      const spread = (2 / Math.PI) * Math.cos(theta) * Math.cos(theta) * 0.35 + 0.65 * (Math.pow(Math.abs(Math.cos(theta * 0.5)), 16) * 1.1);
      const s = jonswap(w, alpha, peak, 3.3) * spread * Math.exp(-0.0016 * k * k);
      const amount = options.height * Math.sqrt(((2 * s * (G / (2 * w))) / k) * dk * dk);
      const [a, b] = gaussian();
      spec[(y * size + x) * 2] = a * amount;
      spec[(y * size + x) * 2 + 1] = b * amount;
    }
  }
  const data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 2;
      const j = (((size - y) % size) * size + (size - x) % size) * 2;
      data.set([spec[i], spec[i + 1], spec[j], -spec[j + 1]], (y * size + x) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

const field = (size: number, repeat = false) => {
  const tex = new THREE.StorageTexture(size, size);
  tex.type = THREE.HalfFloatType;
  tex.format = THREE.RGBAFormat;
  tex.minFilter = repeat ? THREE.LinearFilter : THREE.NearestFilter;
  tex.magFilter = repeat ? THREE.LinearFilter : THREE.NearestFilter;
  tex.generateMipmaps = false;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  return tex;
};

const cmul = (a: any, b: any) => vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));
const pack2 = (a: any, b: any) => vec2(a.x.sub(b.y), a.y.add(b.x));

export type Cascade = { length: number; disp: THREE.StorageTexture; slope: THREE.StorageTexture };

export function buildWaves(options: OceanOptions, clock: any) {
  const N = options.size;
  const steps = Math.round(Math.log2(N));
  const computes: any[] = [];
  const textures: THREE.Texture[] = [];
  const cascades: Cascade[] = [];
  const LAMBDA = 0.85;

  options.lengths.forEach((L, c) => {
    const hi = c === options.lengths.length - 1 ? 1e4 : (6 * 2 * Math.PI) / options.lengths[c + 1];
    const lo = c === 0 ? 1e-4 : (6 * 2 * Math.PI) / L;
    const start = bakeSpectrum(N, L, hi, lo, options);
    const a = [field(N), field(N)];
    const b = [field(N), field(N)];
    const disp = field(N, true);
    const slope = field(N, true);
    textures.push(start, ...a, ...b, disp, slope);
    cascades.push({ length: L, disp, slope });

    const evolve = Fn(() => {
      const index = int(instanceIndex) as any;
      const x = index.mod(N) as any;
      const y = index.div(N) as any;
      const k = vec2(float(x.sub(N / 2)), float(y.sub(N / 2))).mul((2 * Math.PI) / L) as any;
      const kl = length(k) as any;
      const ik = kl.greaterThan(0.000001).select(float(1).div(kl), float(0)) as any;
      const W0 = (2 * Math.PI) / LOOP;
      const phase = fract(floor(sqrt(kl.mul(G)).div(W0)).mul(clock.div(LOOP))).mul(2 * Math.PI) as any;
      const e = vec2(cos(phase), sin(phase)) as any;
      const h0 = textureLoad(start, ivec2(x, y)) as any;
      const h = cmul(h0.xy, e).add(cmul(h0.zw, vec2(e.x, e.y.negate()))) as any;
      const ih = vec2(h.y.negate(), h.x) as any;
      const dx = ih.mul(k.x).mul(ik);
      const dz = ih.mul(k.y).mul(ik);
      const dxdx = h.negate().mul(k.x).mul(k.x).mul(ik);
      const dzdz = h.negate().mul(k.y).mul(k.y).mul(ik);
      const dxdz = h.negate().mul(k.x).mul(k.y).mul(ik);
      const dydx = ih.mul(k.x);
      const dydz = ih.mul(k.y);
      const p0 = pack2(dx, dz) as any;
      const p1 = pack2(h, dxdz) as any;
      const p2 = pack2(dydx, dydz) as any;
      const p3 = pack2(dxdx, dzdz) as any;
      textureStore(a[0], ivec2(x, y), vec4(p0.x, p0.y, p1.x, p1.y)).toWriteOnly();
      textureStore(b[0], ivec2(x, y), vec4(p2.x, p2.y, p3.x, p3.y)).toWriteOnly();
    })().compute(N * N);
    computes.push(evolve);

    // Stockham radix-2 inverse transforms: first along the rows, then the columns.
    let from = 0;
    for (let vertical = 0; vertical < 2; vertical++) {
      for (let s = 1; s <= steps; s++) {
        const sub = 1 << s;
        const half = sub >> 1;
        const inA = a[from];
        const inB = b[from];
        const outA = a[1 - from];
        const outB = b[1 - from];
        const stage = Fn(() => {
          const index = int(instanceIndex) as any;
          const x = index.mod(N) as any;
          const y = index.div(N) as any;
          const i = (vertical ? y : x) as any;
          const even = i.div(sub).mul(half).add(i.mod(half)) as any;
          const odd = even.add(N / 2) as any;
          const pe = (vertical ? ivec2(x, even) : ivec2(even, y)) as any;
          const po = (vertical ? ivec2(x, odd) : ivec2(odd, y)) as any;
          const angle = float(i.mod(sub)).mul((2 * Math.PI) / sub) as any;
          const tw = vec2(cos(angle), sin(angle));
          const e0 = textureLoad(inA, pe) as any;
          const o0 = textureLoad(inA, po) as any;
          const e1 = textureLoad(inB, pe) as any;
          const o1 = textureLoad(inB, po) as any;
          const r0 = e0.xy.add(cmul(tw, o0.xy)) as any;
          const r1 = e0.zw.add(cmul(tw, o0.zw)) as any;
          const r2 = e1.xy.add(cmul(tw, o1.xy)) as any;
          const r3 = e1.zw.add(cmul(tw, o1.zw)) as any;
          textureStore(outA, ivec2(x, y), vec4(r0.x, r0.y, r1.x, r1.y)).toWriteOnly();
          textureStore(outB, ivec2(x, y), vec4(r2.x, r2.y, r3.x, r3.y)).toWriteOnly();
        })().compute(N * N);
        computes.push(stage);
        from = 1 - from;
      }
    }
    const finalA = a[from];
    const finalB = b[from];
    const assemble = Fn(() => {
      const index = int(instanceIndex) as any;
      const x = index.mod(N) as any;
      const y = index.div(N) as any;
      const sign = float(1).sub(float(x.add(y).mod(2)).mul(2)) as any;
      const p = ivec2(x, y);
      const fa = (textureLoad(finalA, p) as any).mul(sign);
      const fb = (textureLoad(finalB, p) as any).mul(sign);
      const dxx = fb.z.mul(LAMBDA);
      const dzz = fb.w.mul(LAMBDA);
      const dxz = fa.w.mul(LAMBDA);
      const jacobian = dxx.add(1).mul(dzz.add(1)).sub(dxz.mul(dxz));
      const sx = fb.x.div(max(dxx.add(1), float(0.2)));
      const sz = fb.y.div(max(dzz.add(1), float(0.2)));
      textureStore(disp, p, vec4(fa.x.mul(LAMBDA), fa.z, fa.y.mul(LAMBDA), jacobian)).toWriteOnly();
      textureStore(slope, p, vec4(sx, sz, 0, 1)).toWriteOnly();
    })().compute(N * N);
    computes.push(assemble);
  });
  return { computes, cascades, textures };
}

// The sky for everything that looks at it: the dome, and the reflections in the water.

export const SUN = new THREE.Vector3(-0.56, 0.062, -0.82).normalize();

export function sunrise(direction: any, time: any, withClouds: boolean, noise: THREE.Data3DTexture): any {
  const d = direction as any;
  const sun = vec3(SUN.x, SUN.y, SUN.z);
  const y = max(d.y, float(0)) as any;
  const towards: any = max(dot(d, sun), float(0));
  const gradient = mix(mix(color("#ffb06a"), color("#f47e77"), smoothstep(0.015, 0.11, y)), mix(color("#8d7bb5"), color("#233c7a"), smoothstep(0.26, 0.72, y)), smoothstep(0.08, 0.3, y));
  // The sky brightens toward the sun, and the far side stays a cool lavender.
  const warm = mix(mix(color("#a8a2c9"), color("#7f93c9"), smoothstep(0, 0.4, y)), gradient, smoothstep(-0.5, 0.42, dot(d, sun)));
  const glow = (color("#ff9f5e") as any).mul((pow(towards, float(7)) as any).mul(0.55)).add((color("#ffe0a4") as any).mul((pow(towards, float(140)) as any).mul(1)));
  const disc = (color("#fff6dc") as any).mul(smoothstep(0.99972, 0.9999, dot(d, sun)).mul(30));
  let sky: any = (warm as any).add(glow).add(disc);
  if (withClouds) {
    // Sheets of cloud on a flat ceiling, lit pink and gold from underneath.
    const plane = d.xz.div(y.add(0.09)).mul(0.1) as any;
    const a = (texture3D(noise, vec3(plane.x.add(time.mul(0.016)), float(0.31), plane.y)) as any).g;
    const b = (texture3D(noise, vec3(plane.x.mul(2.6).add(time.mul(0.028)), float(0.57), plane.y.mul(2.6))) as any).b;
    const puff = a.add(b.mul(0.34));
    const thick = smoothstep(0.54, 0.7, puff).mul(smoothstep(0.012, 0.08, y)).mul(float(1).sub(smoothstep(0.6, 0.95, y)));
    const shade = smoothstep(0.56, 0.78, puff);
    const bright = mix(mix(color("#ffe6c8"), color("#ff9f8f"), smoothstep(0.03, 0.34, y)), color("#c6a9d6"), smoothstep(0.35, -0.5, dot(d, sun)));
    const lit = mix(bright, mix(color("#a56d8e"), color("#6c6aa4"), smoothstep(0.05, 0.4, y)), shade.mul(0.74));
    sky = mix(sky, lit, thick.mul(0.9));
  }
  // Under the horizon, the dark of the deep sea, which is what the water shows when looked straight into.
  return mix(sky, color("#04232c"), smoothstep(0, -0.03, d.y));
}




// One each for looking down on the water and up at it, so that neither pays for the other.
export function oceanMaterial(below: boolean, options: { resolutionScale: number; cascades: Cascade[]; peachInverse: any; bladeNormal: any; bladeDepth: any; time: any; noise: THREE.Data3DTexture; impacts: any[]; gridScale: any; follow: any }) {
  const { resolutionScale, cascades, peachInverse, bladeNormal, bladeDepth, time, noise, impacts, gridScale, follow } = options;
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: true, side: below ? THREE.BackSide : THREE.FrontSide });

  const rest = vec3((positionGeometry as any).x.mul(gridScale).add(follow.x), float(0), (positionGeometry as any).z.mul(gridScale).add(follow.y)) as any;
  const spacing = max(length((positionGeometry as any).xz).mul(gridScale).mul(0.03), float(0.05)) as any;
  let moved: any = vec3(0);
  for (const cascade of cascades) {
    // Waves shorter than the grid here can only make it swim.
    const fade = clamp(float(cascade.length).div(spacing.mul(9)), 0, 1);
    moved = moved.add(((texture(cascade.disp, rest.xz.div(cascade.length)) as any).level(float(0)) as any).xyz.mul(fade as any));
  }
  material.positionNode = rest.add(moved) as any;
  const home = varying(rest.xz) as any;
  const crest = varying(moved.y) as any;

  const toEye = cameraPosition.sub(positionWorld) as any;
  const dist = length(toEye) as any;
  const v = normalize(toEye) as any;
  let sx: any = float(0);
  let sz: any = float(0);
  let lowest: any = float(1);
  for (const cascade of cascades) {
    const uv = home.div(cascade.length);
    const s = texture(cascade.slope, uv) as any;
    const far = float(1).sub(smoothstep(cascade.length * 4, cascade.length * 22, dist)) as any;
    sx = sx.add(s.x.mul(far));
    sz = sz.add(s.y.mul(far));
    lowest = min(lowest, mix(float(1), (texture(cascade.disp, uv) as any).w, far));
  }
  // Rings from anything that has landed in the water.
  let ring: any = float(0);
  for (const impact of impacts) {
    const off = home.sub(impact.xy) as any;
    const reach = max(length(off), float(0.001)) as any;
    const age = time.sub(impact.z) as any;
    const front = reach.sub(age.mul(1.5)) as any;
    const wave = cos(front.mul(16)).mul(exp(abs(front).mul(-3.4))).mul(exp(age.mul(-1))).mul(impact.w) as any;
    sx = sx.add(off.x.div(reach).mul(wave).mul(0.18));
    sz = sz.add(off.y.div(reach).mul(wave).mul(0.18));
    ring = ring.add(exp(abs(front).mul(-9)).mul(exp(age.mul(-1.5))).mul(impact.w));
  }
  const sun = vec3(SUN.x, SUN.y, SUN.z);
  const lace = (texture3D(noise, vec3(home.mul(0.11), float(0.4))) as any).g.add((texture3D(noise, vec3(home.mul(0.47), float(0.7))) as any).b.mul(0.5));
  const churn = smoothstep(0.82, 0.42, lowest).mul(smoothstep(0.62, 0.9, lace)) as any;

  const peach = peachInverse.mul(vec4(positionWorld, 1)).xyz as any;
  // The sea stays out of the half that is left, and closes over where the other half was. What is left is the skin,
  // cut flat by the blade, and the white line of contact runs all the way round it, across the cut face too.
  // Most of the sea is nowhere near the peach, and needn't work its shape out.
  const half = Fn(() => {
    const gap = (length(peach) as any).sub(R * 1.14).toVar() as any;
    If(gap.lessThan(0.3), () => {
      gap.assign(max(insideSkin(peach), (dot(peach, bladeNormal) as any).sub(bladeDepth)));
    });
    return gap;
  })() as any;
  material.maskNode = half.greaterThan(-0.015);
  const wander = (texture3D(noise, vec3(home.mul(0.28), time.mul(0.016))) as any).g.sub(0.5).mul(0.2);
  const lap = smoothstep(0.2, 0.02, half.add(wander)) as any;
  const foam = max(max(churn.mul(0.8), lap.mul(0.92)), ring.clamp(0, 1).mul(0.5)).clamp(0, 1) as any;

  if (below) {
    // From underneath: a bright window straight overhead, where light gets in, and past the critical angle, a mirror of the deep.
    const nb = normalize(vec3(sx, float(-1), sz)) as any;
    const c = clamp(dot(nb, v), 0, 1) as any;
    const k = float(1).sub(float(1.769).mul(float(1).sub(c.mul(c)))) as any;
    const window = smoothstep(0, 0.22, k) as any;
    const out = normalize(v.negate().mul(1.33).add(nb.mul(c.mul(1.33).sub(sqrt(max(k, float(0))))))) as any;
    const overhead = sunrise(vec3(out.x, abs(out.y), out.z), time, false, noise) as any;
    const lightIn = (color("#fff2d0") as any).mul((pow(max(dot(out, sun), float(0)), float(260)) as any).mul(16));
    const mirror = mix(color("#0a4650"), color("#187a80"), clamp(c.mul(1.1).add(sx.mul(0.8)), 0, 1)) as any;
    // A long way off it melts into the blue, leaving no line at the horizon.
    material.colorNode = mix(mix(mirror, overhead.mul(1.15).add(lightIn), window).add((color("#dff5ee") as any).mul(foam.mul(0.35))), color("#0d6068"), smoothstep(30, 110, dist)) as any;
    material.opacityNode = mix(float(1), float(0.62), window) as any;
    return material;
  }

  const n = normalize(vec3(sx.negate(), 1, sz.negate())) as any;
  const facing = clamp(dot(n, v), 0, 1) as any;
  const fresnel = float(0.02).add((pow(float(1).sub(facing), float(5)) as any).mul(0.98)) as any;
  const bounce = reflect(v.negate(), n) as any;
    const up = vec3(bounce.x, abs(bounce.y), bounce.z);
  // A real mirror image of whatever stands on the sea: the peach, the boats, the city, the land. The sky is left out of it,
  // and shows from the painted sky instead, so anything in the mirror that isn't the plain background must be an object.
  // Water stretches a reflection along the line of sight, so waves push it further that way than across.
  const reflection = reflector({ resolutionScale, bounces: false }) as any;
  reflection.target.rotateX(-Math.PI / 2);
  const settle = float(1).sub(smoothstep(30, 120, dist)).mul(0.9).add(0.1) as any;
  reflection.uvNode = reflection.uvNode.add(vec2(sx.mul(0.05), sz.mul(0.13)).mul(settle));
  material.userData.mirror = reflection;
  const mirrored = reflection.rgb as any;
  const found = smoothstep(0.012, 0.05, length(mirrored.sub(color("#04232c")))) as any;
  const seen = mix(sunrise(up, time, true, noise), mirrored, found.mul(0.94)) as any;
  const onSun = max(dot(bounce, sun), float(0)) as any;
  const glitter = (color("#fff0d0") as any).mul((pow(onSun, float(1400)) as any).mul(70)).add((color("#ffc48c") as any).mul((pow(onSun, float(90)) as any).mul(1.15)));
  // Water looks a clear green-blue where light comes back up through a wave facing the sun.
  const through = pow(max(dot(v, sun.negate()), float(0)), float(3)) as any;
  const lifted = clamp(crest.mul(1.1).add(0.28), 0, 1) as any;
  const body = mix(color("#06303d"), color("#177f7f"), lifted.mul(0.55).add(through.mul(lifted).mul(0.7)).clamp(0, 1)).add((color("#c7663a") as any).mul((pow(max(dot(v, sun), float(0)), float(4)) as any).mul(0.11)));
  const lit = mix(mix(body, seen, clamp(fresnel.mul(1.15).add(0.14).add(found.mul(0.5)), 0, 1)).add(glitter.mul(float(1).sub(found.mul(0.96)))), color("#fff0e0"), foam) as any;
  const haze = sunrise(normalize(vec3(v.x.negate(), float(0.012), v.z.negate())), time, false, noise) as any;
  material.colorNode = mix(lit, haze, smoothstep(150, 360, dist).mul(0.8)) as any;
  // Clear enough to see into from above, and a mirror at a low angle or a long way off.
  material.opacityNode = clamp(float(0.46).add(found.mul(0.42)).add(fresnel.mul(1.3)).add(foam).add(dist.mul(0.006)).add(float(1).sub(facing).mul(0.28)), 0, 1) as any;
  return material;
}

// Rings of vertices around the camera, growing with distance.
export function polarGrid(rings: number, spokes: number, first = 0.42, grow = 1.052) {
  const position = new Float32Array((rings * spokes + 1) * 3);
  let r = first;
  let write = 3;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < spokes; j++) {
      const a = (j / spokes) * Math.PI * 2;
      position[write++] = Math.cos(a) * r;
      position[write++] = 0;
      position[write++] = Math.sin(a) * r;
    }
    r = r * grow + 0.04;
  }
  const index: number[] = [];
  for (let j = 0; j < spokes; j++) index.push(0, 1 + ((j + 1) % spokes), 1 + j);
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < spokes; j++) {
      const a = 1 + i * spokes + j;
      const b = 1 + i * spokes + (j + 1) % spokes;
      const c = a + spokes;
      const d = b + spokes;
      index.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return geometry;
}

