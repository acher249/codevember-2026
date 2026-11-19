import * as THREE from "three/webgpu";
import { Fn, instanceIndex, instancedArray, uniform, vec4 } from "three/tsl";
import { createPaint, type Paint } from "./paint";
import { rgbToZuv, zuvToLinearRgb, zuvToRgb } from "./zuv";
import { paintColourNode, zuvToLinearNode, zuvToRgbNode } from "./zuv-nodes";

// Manual browser regression harness. Run runMixingGpuTests(canvas, onResult) from a client component and display the
// returned report. This initializes its own renderer, executes the production compute passes, reads actual GPU buffers,
// and disposes the renderer. WebGL fallback is a failure, never a passing GPU test. No scene or animation is required.
export type GpuTestResult = { name: string; passed: boolean; detail: string };
export type GpuTestReport = { passed: boolean; results: GpuTestResult[]; gradients: { name: string; colours: string[] }[] };
type Triple = [number, number, number];
type BufferNode = { value: THREE.BufferAttribute };
type State = { cells: number[]; wet: number[]; zuv: number[] };
const palette: Triple[] = [[0.01, 0.12, 0.9], [1, 0.75, 0.015], [0.7, 0.02, 0.2], [0.05, 0.7, 0.12]];
const mixTriple = (a: Triple, b: Triple, t: number): Triple => a.map((v, k) => v * (1 - t) + b[k] * t) as Triple;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const linearRgbToZuv = (rgb: Triple) => rgbToZuv(rgb.map((v) => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) as Triple);
const css = (rgb: number[]) => `rgb(${rgb.map((v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * clamp(v) : 1.055 * clamp(v) ** (1 / 2.4) - 0.055))).join(" ")})`;

async function read(renderer: THREE.WebGPURenderer, node: BufferNode, components = node.value.itemSize) {
  const raw = new Float32Array(await renderer.getArrayBufferAsync(node.value));
  const stride = raw.length / node.value.count; // WGSL pads vec3 storage to vec4; do not assume packed RGB.
  return Array.from({ length: node.value.count * components }, (_, i) => raw[Math.floor(i / components) * stride + i % components]);
}

async function readState(renderer: THREE.WebGPURenderer, paint: Paint): Promise<State> {
  const [cells, wet, zuv] = await Promise.all([read(renderer, paint.cells, 4), read(renderer, paint.wet, 4), read(renderer, paint.zuv, 3)]);
  return { cells, wet, zuv };
}

function error(actual: number[], expected: number[], keep: (i: number) => boolean = () => true) {
  if (actual.length !== expected.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < actual.length; i++) {
    if (!keep(i)) continue;
    if (!Number.isFinite(actual[i]) || !Number.isFinite(expected[i])) return Infinity;
    worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
  }
  return worst;
}

function seed(paint: Paint) {
  const state: State = { cells: [], wet: [], zuv: [] };
  for (let j = 0; j < paint.N; j++) for (let i = 0; i < paint.N; i++) {
    const edge = i === 0 || j === 0 || i === paint.N - 1 || j === paint.N - 1;
    const rgb = palette[(i + 2 * j) % palette.length];
    const h = edge ? 0 : 0.00025 + ((i * 7 + j * 11) % 9) * 0.0004;
    state.cells.push(h, ...rgb);
    state.wet.push(edge ? 0 : ((i + j * 3) % 5) / 4, 0.5, 0, 0);
    state.zuv.push(...linearRgbToZuv(rgb));
  }
  paint.cells.value.array.set(state.cells);
  paint.wet.value.array.set(state.wet);
  paint.zuv.value.array.set(state.zuv);
  // Match the f32 inputs that are uploaded; the reference calculation itself is independent double precision.
  for (const key of ["cells", "wet", "zuv"] as const) state[key] = Array.from(new Float32Array(state[key]));
  paint.u.yieldStep.value = 0.00007;
  paint.u.mobility.value = 0.16;
  paint.u.drying.value = 0.0003;
  return state;
}

// Frozen numerical reference for the existing film transport law: outgoing volume limited to 20%, dry underlying
// paint weighted by max(wetness², .02), and the same incoming volumes carrying RGB, signed ZUV, and wetness.
// Keeping this scalar implementation separate from TSL catches buffer ordering, padding, and shader compiler errors.
function referenceFlow(state: State, paint: Paint): State {
  const { N, u } = paint;
  const at = (i: number, j: number) => Math.max(0, Math.min(N - 1, j)) * N + Math.max(0, Math.min(N - 1, i));
  const flux: number[][] = [];
  for (let id = 0; id < N * N; id++) {
    const i = id % N, j = Math.floor(id / N), h = state.cells[4 * id], w = state.wet[4 * id];
    const run = u.mobility.value * Math.min((h / 0.0015) ** 2, 4) * w * w;
    const out = [at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)].map((n) => Math.max(h - state.cells[4 * n] - u.yieldStep.value, 0) * run * 0.5);
    const limit = Math.min(1, h * 0.2 / Math.max(out.reduce((a, b) => a + b, 0), 1e-12));
    flux.push(out.map((v) => v * limit));
  }
  const next: State = { cells: [], wet: [], zuv: [] };
  for (let id = 0; id < N * N; id++) {
    const i = id % N, j = Math.floor(id / N), offset = 4 * id;
    const kept = state.cells[offset] - flux[id].reduce((a, b) => a + b, 0);
    let total = kept, weight = kept * Math.max(state.wet[offset] ** 2, 0.02), water = state.wet[offset] * kept;
    const rgb = state.cells.slice(offset + 1, offset + 4).map((v) => v * weight);
    const zuv = state.zuv.slice(3 * id, 3 * id + 3).map((v) => v * weight);
    const neighbours = [at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)];
    for (let k = 0; k < 4; k++) {
      const n = neighbours[k], part = flux[n][[1, 0, 3, 2][k]];
      total += part; weight += part; water += state.wet[4 * n] * part;
      for (let c = 0; c < 3; c++) { rgb[c] += state.cells[4 * n + c + 1] * part; zuv[c] += state.zuv[3 * n + c] * part; }
    }
    const edge = i < 1 || j < 1 || i > N - 2 || j > N - 2;
    const h = edge ? 0 : total * (1 - u.wipe.value);
    const thin = 1 + 0.0015 / Math.max(total, 0.0015 * 0.05);
    next.cells.push(h, ...rgb.map((v, c) => weight > 1e-12 ? v / weight : state.cells[offset + c + 1]));
    next.zuv.push(...zuv.map((v, c) => weight > 1e-12 ? v / weight : state.zuv[3 * id + c]));
    next.wet.push(Math.max(water / Math.max(total, 1e-12) - u.drying.value * thin, 0) * (1 - u.wipe.value), state.wet[offset + 1] * 0.97, state.wet[offset + 2], state.wet[offset + 3]);
  }
  return next;
}

export async function runMixingGpuTests(canvas: HTMLCanvasElement, onResult: (result: GpuTestResult) => void = () => {}): Promise<GpuTestReport> {
  const results: GpuTestResult[] = [];
  const gradients: GpuTestReport["gradients"] = [];
  const record = (name: string, passed: boolean, detail: string) => { const result = { name, passed, detail }; results.push(result); onResult(result); };
  const close = (name: string, actual: number[], expected: number[], tolerance: number, keep?: (i: number) => boolean) => {
    const worst = error(actual, expected, keep);
    const index = actual.findIndex((value, i) => (!keep || keep(i)) && Math.abs(value - expected[i]) === worst);
    record(name, worst <= tolerance, `Maximum absolute error ${worst.toExponential(3)}; tolerance ${tolerance.toExponential(1)}.${worst > tolerance ? ` Index ${index}: GPU ${actual[index]}, expected ${expected[index]}.` : ""}`);
  };
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  const gpuErrors: string[] = [];
  renderer.onError = (detail) => { gpuErrors.push(typeof detail === "string" ? detail : JSON.stringify(detail)); };
  try {
    await renderer.init();
    const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
    if (!backend.isWebGPUBackend) throw new Error("WebGPU is unavailable. WebGL fallback cannot run this regression suite.");
    record("Real WebGPU backend", true, "Production TSL shaders execute on WebGPU with storage-buffer readback.");

    // Cover the cube, transfer-function boundary, neutral axis, and near-black values.
    const samples: Triple[] = [];
    const levels = [0, 1e-8, 0.0005, 0.04045, 0.1, 0.2, 0.5, 0.9, 1];
    for (const r of levels) for (const g of levels) for (const b of levels) samples.push([r, g, b]);
    const coordinates: Triple[] = samples.map(rgbToZuv);
    coordinates.push([0, 2, -2], [1, -2, 2], [1e-8, 2, -2], [1 - 1e-8, -2, 2], [0.5, -4, 3], [0.2, 3, -4], [-0.1, 2, 3], [1.1, -3, -2]);
    const source = instancedArray(new Float32Array(coordinates.flat()), "vec3");
    const rawDecoded = instancedArray(coordinates.length, "vec4");
    const decoded = instancedArray(coordinates.length, "vec4");
    const transforms = Fn(() => {
      const zuv = source.element(instanceIndex);
      rawDecoded.element(instanceIndex).assign(vec4(zuvToRgbNode(zuv), 1));
      decoded.element(instanceIndex).assign(vec4(zuvToLinearNode(zuv), 1));
    })().compute(coordinates.length);
    await renderer.computeAsync(transforms);
    const gpuZuv = await read(renderer, source, 3), gpuRaw = await read(renderer, rawDecoded, 3), gpuRgb = await read(renderer, decoded, 3);
    close("GPU raw inverse / CPU reference (737 colours)", gpuRaw, coordinates.flatMap(zuvToRgb), 3e-5);
    close("CPU forward / GPU inverse round trip (729 colours)", gpuRaw.slice(0, samples.length * 3), samples.flat(), 3e-5);
    close("GPU gamut mapping + linear decode / CPU reference", gpuRgb, coordinates.flatMap(zuvToLinearRgb), 3e-5);
    record("Finite, display-safe shader output", gpuRgb.every((v) => Number.isFinite(v) && v >= 0 && v <= 1), `Checked ${gpuRgb.length} RGB channels, including black and white.`);
    const signed = gpuZuv.filter((_v, i) => i % 3 !== 0);
    record("Signed chroma survives GPU storage", signed.some((v) => v < -0.01) && signed.some((v) => v > 0.01), `Signed U/V range ${Math.min(...signed).toFixed(5)} to ${Math.max(...signed).toFixed(5)}.`);

    // Seed two identical films, switch only the displayed method, and exercise actual production land + flow passes.
    const original = createPaint(9, 0.09), pigment = createPaint(9, 0.09);
    let expected = seed(original); seed(pigment);
    original.u.mixing.value = 0; pigment.u.mixing.value = 1;
    for (let k = 0; k < 4; k++) expected = referenceFlow(expected, original);
    original.step(renderer, 4); pigment.step(renderer, 4);
    const [a, b] = await Promise.all([readState(renderer, original), readState(renderer, pigment)]);
    close("Original/ZUV identical height, RGB history, wetness", [...a.cells, ...a.wet], [...b.cells, ...b.wet], 0);
    close("Original/ZUV identical signed colour history", a.zuv, b.zuv, 0);
    close("Legacy film height / independent CPU baseline", a.cells, expected.cells, 2e-8, (i) => i % 4 === 0);
    close("Legacy drying and freshness / CPU baseline", a.wet, expected.wet, 2e-6);
    close("Legacy RGB transport / CPU baseline", a.cells, expected.cells, 2e-5, (i) => i % 4 !== 0);
    close("ZUV uses identical transport weights", a.zuv, expected.zuv, 2e-5);

    // No-flow deposits admit a closed-form colour and height calculation, including a partly dry underlying layer.
    const deposited = createPaint(9, 0.09);
    const reference = seed(deposited);
    const pour = (paint: Paint, rgb: Triple, volume: number) => {
      paint.u.colour.value.setRGB(...rgb);
      paint.u.zuvColour.value.set(...linearRgbToZuv(rgb));
      (paint.u.landings.array[0] as THREE.Vector4).set(0.003, -0.002, volume, 0.006);
      (paint.u.moving.array[0] as THREE.Vector4).set(0.7, 0.3, 0, 0);
      paint.u.count.value = 1;
      paint.step(renderer, 0);
      paint.u.count.value = 0;
    };
    let pourIndex = 0;
    for (const rgb of [palette[1], palette[0], palette[1]]) {
      const volume = 1.3e-6, reach = Math.max(0.006 * 1.5, deposited.CELL * 1.1), speed = Math.hypot(0.7, 0.3);
      const along = reach + speed * (1 / 240) * 1.1, area = Math.PI * reach * along, z = linearRgbToZuv(rgb);
      for (let id = 0; id < 81; id++) {
        const x = (id % 9 + 0.5) * 0.01 - 0.045 - 0.003, y = (Math.floor(id / 9) + 0.5) * 0.01 - 0.045 + 0.002;
        const alongDistance = (x * 0.7 + y * 0.3) / speed, acrossDistance = (x * 0.3 - y * 0.7) / speed;
        const added = volume / area * Math.exp(-((alongDistance / along) ** 2) - (acrossDistance / reach) ** 2);
        const offset = 4 * id, height = reference.cells[offset], wetness = reference.wet[offset], under = height * Math.max(wetness ** 2, 0.02);
        for (let c = 0; c < 3; c++) {
          reference.cells[offset + c + 1] = (reference.cells[offset + c + 1] * under + rgb[c] * added) / Math.max(under + added, 1e-12);
          reference.zuv[3 * id + c] = (reference.zuv[3 * id + c] * under + z[c] * added) / Math.max(under + added, 1e-12);
        }
        reference.cells[offset] = height + added;
        // Preserve the original compiled shader's sequencing: cells is assigned before wet, so its numerator reads
        // the newly increased height, while the reused `total` node was cached before the write. This is an inherited
        // behavior, not the ideal pre-landing weighted mean; changing it here would conceal a physics regression.
        reference.wet[offset] = Math.min((wetness * (height + added) + added) / Math.max(height + added, 1e-9), 1);
        reference.wet[offset + 1] = Math.min(reference.wet[offset + 1] + added * 4000, 1);
      }
      pour(deposited, rgb, volume);
      // Readback also separates frames, so updated uniforms are consumed before the next pour.
      const frame = await readState(renderer, deposited);
      if (pourIndex++ === 0) {
        close("First deposit preserves legacy wetness sequencing", frame.wet, reference.wet, 2e-6);
      }
    }
    const poured = await readState(renderer, deposited);
    close("Deposited height / analytic Gaussian", poured.cells, reference.cells, 2e-8, (i) => i % 4 === 0);
    close("Deposited wetness / legacy shader baseline", poured.wet, reference.wet, 2e-6);
    close("Deposited original RGB / analytic weighted layer", poured.cells, reference.cells, 2e-5);
    close("Deposited ZUV / same pre-landing weights", poured.zuv, reference.zuv, 2e-5);
    pour(original, palette[2], 1.3e-6); pour(pigment, palette[2], 1.3e-6);
    original.step(renderer, 3); pigment.step(renderer, 3);
    const [originalPoured, pigmentPoured] = await Promise.all([readState(renderer, original), readState(renderer, pigment)]);
    close("Original/ZUV identical after deposit and flow", [...originalPoured.cells, ...originalPoured.wet, ...originalPoured.zuv], [...pigmentPoured.cells, ...pigmentPoured.wet, ...pigmentPoured.zuv], 0);

    // Two buckets arrive in one dispatch. Their 1:3 volume ratio must become one pair of weighted moments, so neither
    // source is recoloured by the other bucket's last uniform and reversing their order cannot change the painting.
    const together = createPaint(9, 0.09), reversed = createPaint(9, 0.09);
    const togetherExpected = seed(together); seed(reversed);
    const blue = palette[0], yellow = palette[1], blend = mixTriple(blue, yellow, 0.75);
    const blendZuv = mixTriple(linearRgbToZuv(blue), linearRgbToZuv(yellow), 0.75);
    const simultaneous = (paint: Paint, colours: Triple[], reverse = false, perLanding = true) => {
      const sources = [{ rgb: colours[0], volume: 1.3e-6 }, { rgb: colours[1], volume: 3.9e-6 }];
      if (reverse) sources.reverse();
      paint.u.colouredLandings.value = perLanding ? 1 : 0;
      paint.u.colour.value.setRGB(...(perLanding ? palette[2] : colours[0]));
      paint.u.zuvColour.value.set(...linearRgbToZuv(perLanding ? palette[3] : colours[0]));
      for (let k = 0; k < sources.length; k++) {
        const { rgb, volume } = sources[k];
        (paint.u.landings.array[k] as THREE.Vector4).set(0.003, -0.002, volume, 0.006);
        (paint.u.moving.array[k] as THREE.Vector4).set(0.7, 0.3, 0, 0);
        (paint.u.colours.array[k] as THREE.Vector3).set(...rgb);
        (paint.u.zuvColours.array[k] as THREE.Vector3).set(...linearRgbToZuv(rgb));
      }
      paint.u.count.value = sources.length;
      paint.step(renderer, 0);
      paint.u.count.value = 0;
    };
    for (let id = 0; id < 81; id++) {
      const x = (id % 9 + 0.5) * 0.01 - 0.045 - 0.003, y = (Math.floor(id / 9) + 0.5) * 0.01 - 0.045 + 0.002;
      const speed = Math.hypot(0.7, 0.3), reach = 0.011, along = reach + speed * (1 / 240) * 1.1;
      const a = (x * 0.7 + y * 0.3) / speed, b = (x * 0.3 - y * 0.7) / speed;
      const added = 5.2e-6 / (Math.PI * reach * along) * Math.exp(-((a / along) ** 2) - (b / reach) ** 2);
      const offset = 4 * id, h = togetherExpected.cells[offset], w = togetherExpected.wet[offset], under = h * Math.max(w * w, 0.02);
      for (let channel = 0; channel < 3; channel++) {
        togetherExpected.cells[offset + channel + 1] = (togetherExpected.cells[offset + channel + 1] * under + blend[channel] * added) / Math.max(under + added, 1e-12);
        togetherExpected.zuv[3 * id + channel] = (togetherExpected.zuv[3 * id + channel] * under + blendZuv[channel] * added) / Math.max(under + added, 1e-12);
      }
      togetherExpected.cells[offset] = h + added;
    }
    simultaneous(together, [blue, yellow]); simultaneous(reversed, [blue, yellow], true);
    const [both, backwards] = await Promise.all([readState(renderer, together), readState(renderer, reversed)]);
    close("Simultaneous blue/yellow RGB / 1:3 volume reference", both.cells, togetherExpected.cells, 2e-5);
    close("Simultaneous blue/yellow ZUV / signed 1:3 reference", both.zuv, togetherExpected.zuv, 2e-5);
    close("Reversing simultaneous bucket order changes nothing", [...both.cells, ...both.wet, ...both.zuv], [...backwards.cells, ...backwards.wet, ...backwards.zuv], 0);
    const bare = createPaint(9, 0.09);
    simultaneous(bare, [blue, yellow]);
    const bareMixed = await readState(renderer, bare), centreRgb = bareMixed.cells.slice(40 * 4 + 1, 40 * 4 + 4), centreZuv = bareMixed.zuv.slice(40 * 3, 40 * 3 + 3);
    close("Both source colours survive; neither last colour wins", [...centreRgb, ...centreZuv], [...blend, ...blendZuv], 2e-6);
    record("Simultaneous mixture retains signed U/V", centreZuv.slice(1).some((v) => v < -0.01) && centreZuv.slice(1).some((v) => v > 0.01), `Mixed U ${centreZuv[1].toFixed(5)}, V ${centreZuv[2].toFixed(5)}.`);
    // Overflow batches are dispatched synchronously, then their uniform arrays are reused immediately. Do not insert
    // an await between these passes: this catches a later upload accidentally recolouring an already submitted batch.
    const batched = createPaint(9, 0.09);
    batched.u.colouredLandings.value = 1;
    batched.u.count.value = 1;
    for (const [rgb, volume] of [[blue, 1.3e-6], [yellow, 3.9e-6]] as const) {
      (batched.u.landings.array[0] as THREE.Vector4).set(0.003, -0.002, volume, 0.006);
      (batched.u.moving.array[0] as THREE.Vector4).set(0.7, 0.3, 0, 0);
      (batched.u.colours.array[0] as THREE.Vector3).set(...rgb);
      (batched.u.zuvColours.array[0] as THREE.Vector3).set(...linearRgbToZuv(rgb));
      batched.step(renderer, 0);
    }
    batched.u.count.value = 0;
    const batches = await readState(renderer, batched);
    // Ignore only the vanishing Gaussian tails where the production wetness denominator floor prevents a fully wet
    // first batch; height is compared over every cell, including those tails.
    close("Back-to-back batches retain both source colours", [...batches.cells.filter((_v, i) => i % 4 !== 0), ...batches.zuv], [...bareMixed.cells.filter((_v, i) => i % 4 !== 0), ...bareMixed.zuv], 3e-6, (i) => batches.cells[Math.floor((i % 243) / 3) * 4] > 1e-7);
    close("Back-to-back batches retain all deposited volume", batches.cells, bareMixed.cells, 2e-8, (i) => i % 4 === 0);
    close("Back-to-back fresh batches retain wetness", batches.wet, bareMixed.wet, 2e-6, (i) => batches.cells[Math.floor(i / 4) * 4] > 1e-7);
    const homogeneous = createPaint(9, 0.09), legacySources = createPaint(9, 0.09);
    seed(homogeneous); seed(legacySources);
    simultaneous(homogeneous, [yellow, yellow]); simultaneous(legacySources, [yellow, yellow], false, false);
    const [uniformPerLanding, uniformLegacy] = await Promise.all([readState(renderer, homogeneous), readState(renderer, legacySources)]);
    close("Same-colour source arrays match legacy uniform mode", [...uniformPerLanding.cells, ...uniformPerLanding.wet, ...uniformPerLanding.zuv], [...uniformLegacy.cells, ...uniformLegacy.wet, ...uniformLegacy.zuv], 2e-6);
    close("Per-bucket colours leave height and wetness unchanged", [...both.cells.filter((_v, i) => i % 4 === 0), ...both.wet], [...uniformPerLanding.cells.filter((_v, i) => i % 4 === 0), ...uniformPerLanding.wet], 0);
    // The per-landing branch reuses each amount for height and two colour moments, whereas the scalar branch uses it
    // only for height. The GPU can cache/round those equivalent expressions differently. Test colour-choice invariance
    // exactly above, and bound this separate cross-branch comparison by representable f32 steps, not a loose absolute
    // tolerance that could hide lost paint in thin cells. All these physical quantities are nonnegative.
    const physical = (state: State) => [...state.cells.filter((_v, i) => i % 4 === 0), ...state.wet];
    const currentPhysical = physical(uniformPerLanding), legacyPhysical = physical(uniformLegacy);
    const currentBits = new Uint32Array(Float32Array.from(currentPhysical).buffer), legacyBits = new Uint32Array(Float32Array.from(legacyPhysical).buffer);
    const maxFloatSteps = Math.max(...currentPhysical.map((v, i) => Number.isFinite(v) && Number.isFinite(legacyPhysical[i]) && v >= 0 && legacyPhysical[i] >= 0 ? Math.abs(currentBits[i] - legacyBits[i]) : Infinity));
    record("Per-landing height/wetness matches legacy f32 precision", maxFloatSteps <= 4, `Maximum difference ${maxFloatSteps} representable float32 steps; limit 4.`);

    // Test the exact shared display expression used by Canvas, without advancing time or resetting the film.
    const display = instancedArray(81, "vec4");
    const show = Fn(() => display.element(instanceIndex).assign(vec4(paintColourNode(deposited.cells.element(instanceIndex).yzw, deposited.zuv.element(instanceIndex), deposited.u.mixing), 1)))().compute(81);
    deposited.u.mixing.value = 0; await renderer.computeAsync(show);
    const displayedOriginal = await read(renderer, display, 3);
    deposited.u.mixing.value = 1; await renderer.computeAsync(show);
    const displayedZuv = await read(renderer, display, 3);
    close("Paused Original display selects stored linear RGB", displayedOriginal, poured.cells.filter((_v, i) => i % 4 !== 0), 0);
    close("Paused ZUV display selects decoded signed history", displayedZuv, Array.from({ length: 81 }, (_, i) => zuvToLinearRgb(poured.zuv.slice(3 * i, 3 * i + 3) as Triple)).flat(), 3e-4);
    record("Display toggle takes effect without simulation", error(displayedOriginal, displayedZuv) > 0.001, `Maximum changed channel ${error(displayedOriginal, displayedZuv).toFixed(5)}.`);
    const unchanged = await readState(renderer, deposited);
    close("Display toggle leaves stored film unchanged", [...unchanged.cells, ...unchanged.wet, ...unchanged.zuv], [...poured.cells, ...poured.wet, ...poured.zuv], 0);

    const same = createPaint(9, 0.09), one = palette[2];
    pour(same, one, 1.3e-6); await readState(renderer, same);
    pour(same, one, 1.3e-6); same.u.drying.value = 0; same.step(renderer, 6);
    const repeated = await readState(renderer, same), zOne = linearRgbToZuv(one);
    close("Same-colour deposit and flow are idempotent", repeated.zuv, Array.from({ length: 81 }, () => zOne).flat(), 2e-5, (i) => repeated.cells[Math.floor(i / 3) * 4] > 1e-9);
    deposited.u.wipe.value = 1; deposited.step(renderer, 1);
    const wiped = await readState(renderer, deposited);
    close("Wipe removes height and wetness", [...wiped.cells.filter((_v, i) => i % 4 === 0), ...wiped.wet.filter((_v, i) => i % 4 === 0)], Array(162).fill(0), 0);
    pour(deposited, palette[3], 1.3e-6);
    const repainted = await readState(renderer, deposited), freshZuv = linearRgbToZuv(palette[3]);
    close("Fresh paint fully replaces wiped signed history", repainted.zuv, Array.from({ length: 81 }, () => freshZuv).flat(), 2e-5, (i) => repainted.cells[Math.floor(i / 3) * 4] > 1e-9);
    close("Fresh paint fully replaces wiped original RGB", repainted.cells.filter((_v, i) => i % 4 !== 0), Array.from({ length: 81 }, () => palette[3]).flat(), 2e-5, (i) => repainted.cells[Math.floor(i / 3) * 4] > 1e-9);

    // These strips are actual GPU output, encoded to CSS sRGB only after readback for visual review.
    const gradientRgb: number[] = [], gradientZuv: number[] = [];
    for (let i = 0; i <= 64; i++) { gradientRgb.push(...mixTriple(palette[0], palette[1], i / 64)); gradientZuv.push(...mixTriple(linearRgbToZuv(palette[0]) as Triple, linearRgbToZuv(palette[1]) as Triple, i / 64)); }
    const gr = instancedArray(new Float32Array(gradientRgb), "vec3"), gz = instancedArray(new Float32Array(gradientZuv), "vec3");
    const output = instancedArray(65, "vec4"), mode = uniform(0, "int");
    const gradient = Fn(() => output.element(instanceIndex).assign(vec4(paintColourNode(gr.element(instanceIndex), gz.element(instanceIndex), mode), 1)))().compute(65);
    for (const [m, name] of [[0, "Original RGB · blue to yellow"], [1, "ZUV · blue to yellow"]] as const) {
      mode.value = m; await renderer.computeAsync(gradient);
      const values = await read(renderer, output, 3);
      gradients.push({ name, colours: Array.from({ length: 65 }, (_, i) => css(values.slice(3 * i, 3 * i + 3))) });
    }
    record("No uncaptured WebGPU errors", gpuErrors.length === 0, gpuErrors.length ? gpuErrors.join("\n") : "All shader compilation, dispatch, and readback operations completed.");
  } catch (cause) {
    record("GPU harness completed", false, cause instanceof Error ? `${cause.message}\n${cause.stack ?? ""}` : String(cause));
  } finally {
    await renderer.dispose();
  }
  return { passed: results.every((result) => result.passed), results, gradients };
}
