"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  clamp,
  dot,
  exp,
  float,
  fract,
  length,
  max,
  min,
  normalize,
  positionGeometry,
  pow,
  screenCoordinate,
  screenUV,
  select,
  smoothstep,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { overlayLink, VEIL_LAYER } from "../../shared/engine/Post";
import { useQuality } from "../../shared/engine/quality";
import { mulberry32 } from "../../shared/engine/random";
import { FOG } from "./shape";
import type { Stir } from "./stir";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The fog: marched through per pixel (at half size) from the eye to whatever the pixel shows, in the engine's veil
// layer, so that it both glows and hides what lies behind it. Its body is a bank lying on the sea and the land, thick
// low down and tearing into wisps at its top, billowed by baked noise drifting on the wind and thinned wherever a hand
// has swept it (the stirring field). Lit by the moon, dimly, by the lantern's halo, and by the lighthouse's two beams
// sweeping round through it: shafts of light, brightest looking back along them.

// Shared with the scene's own frame loop.
export const veil = {
  time: uniform(0),
  // How far the wind has carried the fog's billows, in metres.
  drift: uniform(new THREE.Vector3()),
  amount: uniform(1),
  // The beams' turn about the tower (radians) and their dip below level.
  turn: uniform(0),
  dip: uniform(0.05),
  lamp: uniform(new THREE.Vector3()),
  moon: uniform(new THREE.Vector3(-0.35, 0.45, -0.82).normalize()),
  // How nearly a beam points at the eye, 0 to 1: the lamp flares as it comes round.
  flare: uniform(0)
};

const N = 64;

// Two tiling noises baked once: red soft billows (smooth fractal under rounded cells), green a finer fractal for the
// edges. Stretched to their 2nd–98th percentiles, so thresholds mean what they say.
let baked: THREE.Data3DTexture | null = null;
export function fogNoise() {
  if (baked) return baked;
  const random = mulberry32(2026_11_25);
  const wrap = (v: number, p: number) => ((v % p) + p) % p;
  const PERIODS = [4, 8, 16, 32];
  const tables = [0, 1].map(() => PERIODS.map((p) => Float32Array.from({ length: p * p * p }, () => random())));
  const smooth = (table: Float32Array, period: number, x: number, y: number, z: number) => {
    const fx = x * period;
    const fy = y * period;
    const fz = z * period;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const e = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    const u = e(fx - x0);
    const v = e(fy - y0);
    const w = e(fz - z0);
    const xa = wrap(x0, period);
    const xb = wrap(x0 + 1, period);
    const ya = wrap(y0, period) * period;
    const yb = wrap(y0 + 1, period) * period;
    const za = wrap(z0, period) * period * period;
    const zb = wrap(z0 + 1, period) * period * period;
    const near = (table[xa + ya + za] * (1 - u) + table[xb + ya + za] * u) * (1 - v) + (table[xa + yb + za] * (1 - u) + table[xb + yb + za] * u) * v;
    const far = (table[xa + ya + zb] * (1 - u) + table[xb + ya + zb] * u) * (1 - v) + (table[xa + yb + zb] * (1 - u) + table[xb + yb + zb] * u) * v;
    return near * (1 - w) + far * w;
  };
  const fbm = (t: Float32Array[], x: number, y: number, z: number, from = 0) => {
    let sum = 0;
    let amplitude = 0.5;
    let norm = 0;
    for (let o = from; o < PERIODS.length; o++) {
      sum += smooth(t[o], PERIODS[o], x, y, z) * amplitude;
      norm += amplitude;
      amplitude *= 0.5;
    }
    return sum / norm;
  };
  const count = N * N * N;
  const channels = [new Float32Array(count), new Float32Array(count)];
  for (let k = 0, o = 0; k < N; k++)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++, o++) {
        const x = i / N;
        const y = j / N;
        const z = k / N;
        const f = fbm(tables[0], x, y, z);
        // Billows: the fractal pushed through a soft curve, so it swells into rounded heaps with thin air between.
        channels[0][o] = f * f * (3 - 2 * f);
        channels[1][o] = fbm(tables[1], x, y, z, 1);
      }
  const data = new Uint8Array(count * 4).fill(255);
  channels.forEach((values, channel) => {
    const sorted = Float32Array.from(values).sort();
    const low = sorted[Math.floor(count * 0.02)];
    const high = sorted[Math.floor(count * 0.98)];
    for (let i = 0; i < count; i++) data[i * 4 + channel] = Math.max(0, Math.min(1, (values[i] - low) / (high - low))) * 255;
  });
  const texture = new THREE.Data3DTexture(data, N, N, N);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  baked = texture;
  return texture;
}

// The colours: moonlight a cold grey-blue, the lamp a warm white.
const MOON = new THREE.Color("#8fa3c4");
const LAMP = new THREE.Color("#fff1d6");

export function Fog({ stir }: { stir: Stir }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const { tier } = useQuality();
  const steps = tier === "low" ? 32 : tier === "medium" ? 48 : 64;
  const noise = useMemo(() => fogNoise(), []);

  const view = useMemo(
    () => ({
      inverseView: uniform(new THREE.Matrix4()),
      inverseProjection: uniform(new THREE.Matrix4()),
      eye: uniform(new THREE.Vector3())
    }),
    []
  );

  const parts = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({ depthWrite: false, depthTest: false, blending: THREE.NoBlending });
    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.layers.set(VEIL_LAYER);
    mesh.renderOrder = 10;
    // Drawn straight over the whole screen.
    material.vertexNode = vec4(positionGeometry.xy, 0, 1);
    return { material, geometry, mesh };
  }, []);
  useDispose(parts.geometry, parts.material);

  // The shader is built once the scene's depth is there to stop each ray at what it meets.
  useEffect(() => {
    const build = (depth: any) => {
      const { material } = parts;
      material.colorNode = shade(depth);
      material.needsUpdate = true;
    };

    const fieldMin = vec2(FOG.field.x, FOG.field.z);
    const fieldScale = float(1 / FOG.field.size);
    const moonColour = vec3(MOON.r, MOON.g, MOON.b).mul(0.07);
    const lampColour = vec3(LAMP.r, LAMP.g, LAMP.b);

    // Henyey–Greenstein, scaled so that light scattered evenly reads 1.
    const hg = (g: number, c: any) => float(1 - g * g).div(pow(float(1 + g * g).sub(c.mul(2 * g)), 1.5));

    // How much fog at a point, as extinction per metre.
    const density = (p: any) => {
      const wind = veil.drift;
      const big = texture3D(noise, p.add(wind).mul(vec3(0.011, 0.02, 0.011)), 0).r;
      const fine = texture3D(noise, p.add(wind.mul(1.6)).mul(vec3(0.045, 0.07, 0.045)), 0).g;
      // The bank's top rises and falls in slow swells, and tears into wisps.
      const swell = texture3D(noise, vec3(p.x.add(wind.x).mul(0.004), 0.37, p.z.add(wind.z).mul(0.004)), 0).g;
      const top = float(FOG.top).add(swell.sub(0.5).mul(16));
      const height = float(1).sub(smoothstep(top.sub(10), top.add(2), p.y.add(fine.sub(0.5).mul(6))));
      const body = smoothstep(0.25, 0.8, big.mul(0.7).add(fine.mul(0.3)));
      // Swept by a hand, the fog thins, its edge ragged.
      const left = texture(stir.texture, p.xz.sub(fieldMin).mul(fieldScale)).r;
      const kept = smoothstep(0.1, 0.8, left.add(fine.sub(0.5).mul(0.5)));
      // Thickest on the water.
      const low = exp(p.y.max(0).mul(-0.12)).mul(0.6).add(0.4);
      const bank = body.mul(0.85).add(0.15).mul(height).mul(low).mul(0.034);
      // Over the bank, a thin wet haze up past the lantern, so the beams show all the way out.
      const haze = float(1).sub(smoothstep(30, 110, p.y)).mul(big.mul(0.6).add(0.4)).mul(0.0035);
      return bank.add(haze).mul(kept).mul(veil.amount);
    };

    // A beam: how lit a point is by the beam leaving the lamp along `along`, a shaft about two metres across at the
    // lantern, opening slowly, and dimmed by the fog it has come through.
    const beam = (p: any, along: any) => {
      const v = p.sub(veil.lamp);
      const forward = dot(v, along);
      const across2 = dot(v, v).sub(forward.mul(forward)).max(0);
      const radius = forward.mul(0.05).add(1.1);
      const shaft = exp(across2.div(radius.mul(radius)).negate());
      return shaft.mul(select(forward.greaterThan(0), float(1), float(0))).mul(exp(forward.max(0).mul(-0.0065)));
    };

    const shade = (depth: any) =>
      Fn(() => {
        const ndc = vec2(screenUV.x, float(1).sub(screenUV.y)).mul(2).sub(1) as any;
        const far = view.inverseProjection.mul(vec4(ndc.x, ndc.y, 1, 1)) as any;
        const d = normalize(view.inverseView.mul(vec4(far.xyz.div(far.w), 0)).xyz).toVar() as any;
        const o = view.eye;
        // How far to what the pixel shows (the sky: as far as the march goes).
        const z = depth.sample(screenUV).r as any;
        const seen = view.inverseProjection.mul(vec4(ndc.x, ndc.y, z, 1)) as any;
        const hit = select(z.greaterThanEqual(0.99999), float(900), length(seen.xyz.div(seen.w))) as any;
        // The slab the fog lies in, from just under the sea to over its highest wisps.
        const ceiling = float(110);
        const safe = select(d.y.abs().lessThan(1e-4), float(1e-4), d.y) as any;
        const a = float(-2).sub(o.y).div(safe) as any;
        const b = ceiling.sub(o.y).div(safe) as any;
        const enter = max(min(a, b), 0) as any;
        const leave = min(min(max(a, b), hit), 900) as any;
        const light = vec3(0).toVar();
        const through = float(1).toVar();
        If(leave.greaterThan(enter), () => {
          const jitter = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189)).toVar();
          const span = leave.sub(enter).toVar();
          // Each beam's way, as it turns.
          const c = veil.turn.cos();
          const s = veil.turn.sin();
          const dip = veil.dip;
          const one = normalize(vec3(c, dip.negate(), s)).toVar();
          const two = normalize(vec3(c.negate(), dip.negate(), s.negate())).toVar();
          const moonPhase = hg(0.4, dot(d, veil.moon)).mul(0.5).add(0.5);
          const phaseOne = hg(0.75, dot(one, d.negate())).mul(0.6).add(0.4);
          const phaseTwo = hg(0.75, dot(two, d.negate())).mul(0.6).add(0.4);
          const previous = float(0).toVar();
          Loop(steps, ({ i }: any) => {
            If(through.lessThan(0.01), () => {
              Break();
            });
            // Steps close together near the eye, spreading out with distance.
            const f = float(i).add(jitter).div(steps);
            const t = enter.add(span.mul(f.mul(f))).toVar();
            // Held in a variable before `previous` moves on: TSL inlines an expression where it is used.
            const dt = t.sub(previous).max(0.05).toVar();
            previous.assign(t);
            const p = o.add(d.mul(t)).toVar();
            const sigma = density(p).toVar();
            If(sigma.greaterThan(0.0001), () => {
              const toLamp = length(p.sub(veil.lamp));
              const halo = float(1).div(toLamp.mul(toLamp).mul(0.01).add(1)).mul(4);
              const beams = beam(p, one).mul(phaseOne).add(beam(p, two).mul(phaseTwo)).mul(24);
              const lit = moonColour.mul(moonPhase).add(lampColour.mul(beams.add(halo)));
              const fade = exp(sigma.mul(dt).negate());
              light.addAssign(lit.mul(through).mul(float(1).sub(fade)));
              through.mulAssign(fade);
            });
          });
        });
        return vec4(light, float(1).sub(clamp(through, 0, 1)));
      })();

    return overlayLink.listen(build);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts, steps, noise, stir]);

  useFrame(() => {
    camera.updateMatrixWorld();
    view.inverseView.value.copy(camera.matrixWorld);
    view.inverseProjection.value.copy(camera.projectionMatrixInverse);
    view.eye.value.setFromMatrixPosition(camera.matrixWorld);
  });

  return <primitive object={parts.mesh} />;
}
