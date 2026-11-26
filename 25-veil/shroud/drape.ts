import * as THREE from "three/webgpu";
import { turned, untwisted } from "./body";
import { createShroud, type Shroud } from "./cloth";

/* eslint-disable @typescript-eslint/no-explicit-any -- the compute nodes are untyped. */

// How the drape is made: the shroud simulated as it is laid over her, once, ahead of time; the scene shows the result,
// saved (drape.bin), and only lays it itself where the file is missing.

// Laying it over her: dropped flat over her head, falling through thick air at first and smoothed in to her as it settles;
// then a stretch of the hem lying by her left knee taken up flat and carried across her chest and over her right shoulder,
// as a shawl is wrapped, and let go; then slowed over its last second and left lying.
const FELL = 4.5;
// The hand, from where it takes the hem: seconds after taking it, and where it is in her own frame (body.ts).
const PATH: [number, number, number, number][] = [
  [1.0, 0.3, 0.82, 0.5],
  [2.0, 0.06, 1.06, 0.32],
  [2.8, -0.19, 1.17, 0.07],
  [3.4, -0.25, 1.08, -0.15],
  [4.2, -0.24, 0.7, -0.3]
];
const LAID = FELL + PATH[PATH.length - 1][0] + 2.5;
type Wrap = { column: boolean; edge: number; from: number; to: number; start: number[] };

// The hem to take: of the four, the one whose middle lies furthest to her front and left; a stretch of it either side.
function chooseHem(cloth: Shroud, data: Float32Array): Wrap {
  const { N, MID, d } = cloth;
  const ends = [
    { column: true, edge: 0, k: MID * N },
    { column: true, edge: N - 1, k: MID * N + N - 1 },
    { column: false, edge: 0, k: MID },
    { column: false, edge: N - 1, k: (N - 1) * N + MID }
  ].map((e) => ({ ...e, at: [data[e.k * 4], data[e.k * 4 + 1], data[e.k * 4 + 2]] }));
  const score = (p: number[]) => {
    const q = untwisted(p);
    return q[0] + q[2];
  };
  const best = ends.reduce((a, b) => (score(b.at) > score(a.at) ? b : a));
  const half = Math.round(0.42 / d);
  return { column: best.column, edge: best.edge, from: MID - half, to: MID + half, start: best.at };
}

// Laying it, all of it at once.
async function lay(gl: THREE.WebGPURenderer, cloth: Shroud, pairs: number, substeps: number) {
  gl.compute(cloth.reset as any);
  let n = 0;
  for (; n < FELL * 60; n++) {
    laying(gl, cloth, n / 60, null);
    step(gl, cloth, 1 / 60, substeps, pairs, n / 60);
  }
  const wrap = chooseHem(cloth, new Float32Array(await (gl.getArrayBufferAsync(cloth.A.value) as Promise<ArrayBuffer>)));
  for (; n < LAID * 60; n++) {
    laying(gl, cloth, n / 60, wrap);
    step(gl, cloth, 1 / 60, substeps, pairs, n / 60);
  }
  cloth.u.wrapping.value = 0;
}

function laying(gl: THREE.WebGPURenderer, cloth: Shroud, t: number, wrap: Wrap | null) {
  const u = cloth.u;
  u.drag.value = t < 0.8 ? 3 : 1;
  u.hug.value = t > 1 && t < LAID - 1.5 ? 12 : 0;
  u.damp.value = t < LAID - 1.2 ? 0.997 : 0.85;
  const h = t - FELL;
  if (!wrap || h < 0 || h > PATH[PATH.length - 1][0]) {
    u.wrapping.value = 0;
    return;
  }
  if (u.wrapping.value < 0.5) {
    u.edgeIsColumn.value = wrap.column ? 1 : 0;
    u.edge.value = wrap.edge;
    u.from.value = wrap.from;
    u.to.value = wrap.to;
    gl.compute(cloth.takeEdge as any);
    u.wrapping.value = 1;
  }
  const keys = [[0, ...untwisted(wrap.start)], ...PATH];
  let k = 0;
  while (h > keys[k + 1][0]) k++;
  const f = (h - keys[k][0]) / (keys[k + 1][0] - keys[k][0]);
  const e = f * f * (3 - 2 * f);
  const [x, y, z] = turned([1, 2, 3].map((a) => keys[k][a] + (keys[k + 1][a] - keys[k][a]) * e));
  u.target.value.set(x, y, z);
}


function step(gl: THREE.WebGPURenderer, cloth: Shroud, delta: number, substeps: number, pairs: number, time: number) {
  cloth.u.dt.value = delta / substeps;
  for (let k = 1; k <= substeps; k++) {
    cloth.u.time.value = time - (delta * (substeps - k)) / substeps;
    // The last pass of each step keeps the cloth off itself.
    cloth.u.stamp.value = (cloth.u.stamp.value + 1) % 1e6;
    const passes: unknown[] = [cloth.integrate];
    for (let n = 1; n < pairs; n++) passes.push(cloth.forth, cloth.back);
    passes.push(cloth.forth, cloth.mark, cloth.apart);
    gl.compute(passes as any);
  }
}

// The drape, n particles a side: x, y, z for each, row by row.
export async function drape(gl: THREE.WebGPURenderer, n: number, pairs: number, substeps: number) {
  const cloth = createShroud(n);
  await lay(gl, cloth, pairs, substeps);
  const data = new Float32Array(await (gl.getArrayBufferAsync(cloth.A.value) as Promise<ArrayBuffer>));
  const out = new Float32Array(n * n * 3);
  for (let k = 0; k < n * n; k++) out.set(data.subarray(k * 4, k * 4 + 3), k * 3);
  return out;
}
