import * as THREE from "three/webgpu";
import { abs, exp, float, length, normalize, sin, smoothstep, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The peach is three closed surfaces, each a radius for every direction. Each is written twice, once for building meshes
// and once for shaders, because the cut face has to meet the meshes exactly at any angle of slice.

export const R = 3;
// Its middle, when the sea is flat. A bit over half of it stands out of the water.
export const CENTRE_Y = R * 0.5;
export const CENTRE = new THREE.Vector3(0, CENTRE_Y, 0);
export const JUICE_LEVEL = -1.02;
const CAVITY_CENTRE_Y = -0.1;
export const STONE_CENTRE_Y = -0.72;
const STONE_THIN = 0.5;
const STONE_WIDE = 0.72;
const STONE_LONG = 1.02;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// No peach is a perfect shape: a few big dents where it was knocked on the way down, with a direction, a depth and a width.
export const DENTS: [number, number, number, number, number][] = [
  [0.72, 0.28, 0.63, 0.04, 0.03],
  [-0.46, -0.32, 0.83, 0.055, 0.045],
  [0.2, 0.62, 0.76, 0.03, 0.018],
  [0.85, -0.42, 0.31, 0.045, 0.05],
  [-0.84, 0.3, 0.45, 0.04, 0.022],
  [0.12, -0.58, -0.8, 0.08, 0.06],
  [-0.4, 0.46, -0.79, 0.05, 0.03]
];

const dents = (x: number, y: number, z: number) => {
  let sum = 0;
  for (const [a, b, c, deep, wide] of DENTS) sum += deep * Math.exp(-(1 - (x * a + y * b + z * c)) / wide);
  return sum;
};

// And it is lopsided: one cheek bigger, a broad lump here and there.
const lumps = (x: number, y: number, z: number) => 0.024 * Math.sin(2.3 * x + 1.1 * y + 0.7) + 0.017 * Math.sin(3.1 * z - 1.7 * x + 2.2) + 0.012 * Math.sin(4.7 * y + 2.9 * z + 0.4) + 0.008 * Math.sin(6.3 * x - 5.1 * z + 3.3 * y);

export function dentsNode(d: any): any {
  let sum: any = float(0);
  for (const [a, b, c, deep, wide] of DENTS) sum = sum.add(exp(float(1).sub(d.x.mul(a).add(d.y.mul(b)).add(d.z.mul(c))).negate().div(wide)).mul(deep));
  return sum;
}

// Shoulders above and a taper below, the dimple the stem sits in, the small point at the bottom, and the crease up one side.
export function skinRadius(x: number, y: number, z: number) {
  const t = 1 - y;
  const s = 1 + y;
  let r = 1 + 0.045 * y - 0.07 * y * y + 0.016 * (x * x - z * z) + 0.014 * x * (1 - y * y);
  r -= 0.2 * Math.exp((-t * t) / 0.012);
  r += 0.03 * Math.exp((-(t - 0.3) * (t - 0.3)) / 0.03);
  r += 0.04 * Math.exp((-s * s) / 0.0012);
  const crease = Math.exp((-x * x) / 0.0075);
  r -= crease * (smooth(-0.5, 0.1, z) * (0.032 + 0.046 * smooth(0, 1, y)) + 0.008);
  return R * (r - dents(x, y, z) + lumps(x, y, z));
}

export function skinRadiusNode(d: any): any {
  const t = float(1).sub(d.y);
  const s = float(1).add(d.y);
  const crease = exp(d.x.mul(d.x).negate().div(0.0075));
  const shoulder = t.sub(0.3);
  return float(1)
    .add(d.y.mul(0.045))
    .sub(d.y.mul(d.y).mul(0.07))
    .add(d.x.mul(d.x).sub(d.z.mul(d.z)).mul(0.016))
    .add(d.x.mul(float(1).sub(d.y.mul(d.y))).mul(0.014))
    .sub(exp(t.mul(t).negate().div(0.012)).mul(0.2))
    .add(exp(shoulder.mul(shoulder).negate().div(0.03)).mul(0.03))
    .add(exp(s.mul(s).negate().div(0.0012)).mul(0.04))
    .sub(crease.mul(smoothstep(-0.5, 0.1, d.z).mul(smoothstep(0, 1, d.y).mul(0.046).add(0.032)).add(0.008)))
    .sub(dentsNode(d))
    .add(sin(d.x.mul(2.3).add(d.y.mul(1.1)).add(0.7)).mul(0.024))
    .add(sin(d.z.mul(3.1).sub(d.x.mul(1.7)).add(2.2)).mul(0.017))
    .add(sin(d.y.mul(4.7).add(d.z.mul(2.9)).add(0.4)).mul(0.012))
    .add(sin(d.x.mul(6.3).sub(d.z.mul(5.1)).add(d.y.mul(3.3))).mul(0.008))
    .mul(R);
}

// The hollow: a soft, lumpy room, a little below the middle.
export function cavityRadius(x: number, y: number, z: number) {
  const lumps =
    0.085 * Math.sin(3.1 * x + 1.2 * y + 0.4) +
    0.065 * Math.sin(2.3 * y - 4.1 * z + 1.9) +
    0.045 * Math.sin(5.7 * x + 4.9 * z + 2.7 * y) +
    0.025 * Math.sin(9.1 * y + 7.3 * x - 6 * z);
  return R * 0.57 * (1 + lumps);
}

export function cavityRadiusNode(d: any): any {
  const lumps = sin(d.x.mul(3.1).add(d.y.mul(1.2)).add(0.4))
    .mul(0.085)
    .add(sin(d.y.mul(2.3).sub(d.z.mul(4.1)).add(1.9)).mul(0.065))
    .add(sin(d.x.mul(5.7).add(d.z.mul(4.9)).add(d.y.mul(2.7))).mul(0.045))
    .add(sin(d.y.mul(9.1).add(d.x.mul(7.3)).sub(d.z.mul(6))).mul(0.025));
  return lumps.add(1).mul(R * 0.57);
}

// The stone: a flat almond with a point at the top, its faces worn into the deep looping ridges of a real peach stone.
// One loop on each flat face, wandering, and broken up. 0 is the bottom of a groove and 1 the top of a ridge.
export function stoneRidge(x: number, y: number, z: number) {
  const side = x / (Math.abs(x) + 0.08);
  const rho = Math.hypot((y - 0.1 * side) * 1.1, z + 0.12 * side);
  const wander = 2.2 * Math.sin(3.7 * y + 2.1 * x) + 1.7 * Math.sin(4.3 * z - 1.3 * y + 1.1);
  const wave = Math.sin(rho * 30 + wander);
  return Math.pow(Math.abs(wave), 0.6) * (0.75 + 0.25 * Math.sin(9.7 * y - 8.3 * z + 3.1 * x));
}

export function stoneRidgeNode(d: any): any {
  const side = d.x.div(abs(d.x).add(0.08));
  const a = d.y.sub(side.mul(0.1)).mul(1.1);
  const b = d.z.add(side.mul(0.12));
  const rho = a.mul(a).add(b.mul(b)).sqrt();
  const wander = sin(d.y.mul(3.7).add(d.x.mul(2.1))).mul(2.2).add(sin(d.z.mul(4.3).sub(d.y.mul(1.3)).add(1.1)).mul(1.7));
  const wave = abs(sin(rho.mul(30).add(wander))).max(0.0001);
  return wave.pow(0.6).mul(sin(d.y.mul(9.7).sub(d.z.mul(8.3)).add(d.x.mul(3.1))).mul(0.25).add(0.75));
}

export function stoneRadius(x: number, y: number, z: number) {
  const base = 1 / Math.sqrt((x * x) / (STONE_THIN * STONE_THIN) + (z * z) / (STONE_WIDE * STONE_WIDE) + (y * y) / (STONE_LONG * STONE_LONG));
  const tip = 0.14 * Math.exp((-(1 - y) * (1 - y)) / 0.012);
  return base * (1 + tip) * (0.9 + 0.12 * stoneRidge(x, y, z));
}

// Signed: below zero is inside. q is measured from the middle of the peach.
export const insideSkin = (q: any) => length(q).sub(skinRadiusNode(normalize(q)));

export function insideCavity(q: any) {
  const p = q.sub(vec3(0, CAVITY_CENTRE_Y, 0));
  return length(p).sub(cavityRadiusNode(normalize(p)));
}

// A closed surface from a radius function. Normals are worked out from the shape itself, so the seam never shows.
export function radialSurface(radius: (x: number, y: number, z: number) => number, wide: number, tall: number, centreY = 0, inward = false) {
  const rows = tall + 1;
  const columns = wide + 1;
  const position = new Float32Array(rows * columns * 3);
  const normal = new Float32Array(rows * columns * 3);
  const uv = new Float32Array(rows * columns * 2);
  const at = (theta: number, phi: number, out: number[]) => {
    const sinTheta = Math.sin(theta);
    const x = sinTheta * Math.sin(phi);
    const y = Math.cos(theta);
    const z = sinTheta * Math.cos(phi);
    const r = radius(x, y, z);
    out[0] = x * r;
    out[1] = y * r + centreY;
    out[2] = z * r;
  };
  const here = [0, 0, 0];
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  const d = [0, 0, 0];
  const step = 0.002;
  let write = 0;
  for (let row = 0; row < rows; row++) {
    // Keeps clear of the exact poles, where every column would meet at one point and the normal has no direction.
    const theta = 0.0006 + (row / tall) * (Math.PI - 0.0012);
    for (let column = 0; column < columns; column++) {
      // The seam goes around the back, away from the crease.
      const phi = (column / wide) * Math.PI * 2 - Math.PI;
      at(theta, phi, here);
      at(theta + step, phi, a);
      at(theta - step, phi, b);
      at(theta, phi + step, c);
      at(theta, phi - step, d);
      const tx = c[0] - d[0];
      const ty = c[1] - d[1];
      const tz = c[2] - d[2];
      const sx = a[0] - b[0];
      const sy = a[1] - b[1];
      const sz = a[2] - b[2];
      let nx = sy * tz - sz * ty;
      let ny = sz * tx - sx * tz;
      let nz = sx * ty - sy * tx;
      const size = Math.hypot(nx, ny, nz) || 1;
      const sense = inward ? -1 : 1;
      nx *= sense / size;
      ny *= sense / size;
      nz *= sense / size;
      position[write * 3] = here[0];
      position[write * 3 + 1] = here[1];
      position[write * 3 + 2] = here[2];
      normal[write * 3] = nx;
      normal[write * 3 + 1] = ny;
      normal[write * 3 + 2] = nz;
      uv[write * 2] = column / wide;
      uv[write * 2 + 1] = row / tall;
      write++;
    }
  }
  const index = new Uint32Array(tall * wide * 6);
  let cursor = 0;
  for (let row = 0; row < tall; row++) {
    for (let column = 0; column < wide; column++) {
      const p = row * columns + column;
      const q = p + columns;
      if (inward) index.set([p, p + 1, q, p + 1, q + 1, q], cursor);
      else index.set([p, q, p + 1, p + 1, q, q + 1], cursor);
      cursor += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, centreY, 0), R * 1.2);
  return geometry;
}

export const cavityAt = (x: number, y: number, z: number) => {
  const size = Math.hypot(x, y, z) || 1;
  const r = cavityRadius(x / size, y / size, z / size);
  return new THREE.Vector3((x / size) * r, (y / size) * r + CAVITY_CENTRE_Y, (z / size) * r);
};

export const cavityMiddleY = CAVITY_CENTRE_Y;

// For the things that move: how far inside the peach is this point, measured from the middle of the peach?
export function inFlesh(x: number, y: number, z: number) {
  const size = Math.hypot(x, y, z) || 1;
  if (size >= skinRadius(x / size, y / size, z / size)) return "outside";
  const my = y - CAVITY_CENTRE_Y;
  const inner = Math.hypot(x, my, z) || 1;
  if (inner < cavityRadius(x / inner, my / inner, z / inner)) return "hollow";
  return "flesh";
}

export function hollowReach(x: number, y: number, z: number) {
  const my = y - CAVITY_CENTRE_Y;
  const inner = Math.hypot(x, my, z) || 1;
  return cavityRadius(x / inner, my / inner, z / inner) / inner;
}
