"use client";

// The fires the lava lights in the crumbs: flames, smoke, sparks and the warm light they throw. Each burning crumb is
// given a fire from a fixed pool (fewer on Low): two crossed sheets of flame round it, one behind and one before it so
// the flame wraps it. Each sheet is a mask of teardrop tongues licking up out of rising noise and torn at their tips:
// a faint blue foot, a thin yellow-white core in each tongue, orange round it and dim red at the tips, falling off fast
// to clear between them. Flames and smoke are drawn over the scene in its own pass, blended by their own opacity rather
// than added, so a fire keeps its colour over the white plate and a cluster never adds up to white; they leave the
// pass's other outputs (normals, motion) as they were, so occlusion and the temporal filter see the plate behind them.
// Fires close together grow into one taller front. Grey-brown smoke rises off them and off smouldering coals, sparks fly
// up (added over the frame in the overlay pass), and a few pooled point lights, always in the scene so nothing
// compiles when the first crumb catches, light the plate, lava and pocket round the biggest fires with a flicker.
// Everything is made at load; nothing is allocated per frame.

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  clamp,
  cos,
  cross,
  float,
  length,
  max,
  mix,
  mrt,
  mx_noise_float,
  normalize,
  output,
  packNormalToRGB,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  pow,
  screenUV,
  sin,
  smoothstep,
  texture,
  time,
  uv,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../shared/engine/Post";
import { lehmer } from "../shared/engine/random";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Sheets of flame per fire: one behind the crumb and one in front of it, so the flame wraps it.
const SHEETS = 2;
// Fires burning at once, smoke wisps, sparks and pooled lights, by the tier the visit starts on: the flames' fill is
// most of the fire's cost, so they are capped hard.
const FIRES = { high: 24, medium: 12, low: 6 } as const;
const SMOKE = { high: 64, medium: 48, low: 24 } as const;
const SPARKS = { high: 48, medium: 40, low: 24 } as const;
const LIGHTS = { high: 2, medium: 2, low: 1 } as const;

// One fire, as the crumbs hand it over each frame: where its foot is, how tall and wide, how strong (0 to 1), a seed.
export type FireSlot = { on: boolean; x: number; y: number; z: number; height: number; width: number; strength: number; seed: number };

// An additive overlay material that draws nothing until its shading is built: never a bare white quad.
function overlayMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  material.colorNode = vec4(0, 0, 0, 0);
  material.positionNode = vec3(0, -1000, 0);
  return material;
}

// A see-through material drawn in the scene pass, blended by its opacity. The pass's other outputs (normals, motion)
// are not blended: whatever a fragment draws replaces them, and see-through panes came out as dark grainy rectangles
// once occlusion read them. So nearly clear fragments are discarded (they write nothing), and the
// rest write a normal facing the eye, which occlusion finds open (the plate's own normal drew a dark line along the
// pocket's foot behind a flame).
// The "" output is for targets without named outputs (the High mirror's), which would otherwise get none and fail.
function veilMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false, alphaTest: 0.03 });
  material.mrtNode = mrt({ output, "": output, normal: packNormalToRGB(vec3(0, 0, 1)) });
  return material;
}

// Smooth noise that tiles every `period` cells, 0 to 1, for the smoke's texture.
function hash(x: number, y: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function tiled(x: number, y: number, period: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const at = (a: number, b: number) => hash(((ix + a) % period + period) % period, ((iy + b) % period + period) % period);
  return (at(0, 0) * (1 - u) + at(1, 0) * u) * (1 - v) + (at(0, 1) * (1 - u) + at(1, 1) * u) * v;
}
// A billowy, tiling noise for smoke, made once.
function smokeTexture() {
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      let n = 0;
      let amp = 0.5;
      let total = 0;
      for (let o = 0, period = 4; o < 5; o++, period *= 2) {
        n += tiled((i / N) * period, (j / N) * period, period) * amp;
        total += amp;
        amp *= 0.55;
      }
      const v = Math.round((n / total) * 255);
      data.set([v, v, v, 255], (j * N + i) * 4);
    }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export function useFire(tier: "high" | "medium" | "low") {
  const parts = useMemo(() => {
    const fires = FIRES[tier];
    const sheets = SHEETS;
    const random = lehmer(5150);
    const t = time as any;
    const identity = new THREE.Matrix4();
    const instanced = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      for (let k = 0; k < count; k++) mesh.setMatrixAt(k, identity);
      mesh.frustumCulled = false;
      return mesh;
    };

    // Flames: two sheets a fire, each instance told its fire (foot and height) and its look (strength, seed, width,
    // which sheet).
    const quad = new THREE.PlaneGeometry(1, 1);
    const fireData = new Float32Array(fires * sheets * 4);
    const flameData = new Float32Array(fires * sheets * 4);
    const fireAttribute = new THREE.InstancedBufferAttribute(fireData, 4).setUsage(THREE.DynamicDrawUsage);
    const flameAttribute = new THREE.InstancedBufferAttribute(flameData, 4).setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute("aFire", fireAttribute);
    quad.setAttribute("aFlame", flameAttribute);
    const flameMaterial = veilMaterial();
    {
      const s = attribute("aFire", "vec4") as any;
      const f = attribute("aFlame", "vec4") as any;
      const seed = f.y;
      const sheet = f.w;
      const toEye = normalize(cameraPosition.sub(s.xyz)) as any;
      // Facing the eye about the upright, leaning back to face it as the view looks down on the fire, and squat from
      // above as a real flame looks.
      const flat = normalize(vec3(toEye.x, 0, toEye.z).add(vec3(1e-4, 0, 1e-4))) as any;
      const right = normalize(cross(vec3(0, 1, 0), flat)) as any;
      const steep = clamp(toEye.y, 0, 1) as any;
      const up = normalize(mix(vec3(0, 1, 0), flat.negate(), steep.mul(steep).mul(0.85))) as any;
      // The sheets: behind the crumb, and before it (wrapping it), a little narrower and shorter.
      const front = sheet.equal(1).select(float(0.42), float(-0.22)) as any;
      const wide = sheet.equal(1).select(float(0.85), float(1)) as any;
      const tallness = sheet.equal(1).select(float(0.82), float(1)) as any;
      // Breathing: each flame's height swells and drops a little, fast.
      const breathe = mx_noise_float(vec3(seed.mul(17), t.mul(3.1), sheet))
        .mul(0.22)
        .add(1) as any;
      const tall = s.w.mul(tallness).mul(breathe).mul(float(1).sub(steep.mul(0.45))) as any;
      const w = f.z.mul(wide) as any;
      const g = positionGeometry as any;
      const foot = s.xyz.add(flat.mul(w.mul(front))) as any;
      flameMaterial.positionNode = foot.add(right.mul(g.x.mul(w))).add(up.mul(g.y.add(0.5).mul(tall))) as any;

      const q = uv() as any;
      const y = q.y as any;
      const c = q.x.sub(0.5).mul(2) as any;
      // Rising turbulence, coarse and fine; it sways the flame more the higher it goes.
      const n1 = mx_noise_float(vec3(c.mul(1.5).add(seed.mul(7.3)), y.mul(4.2).sub(t.mul(5)), seed.mul(3.1).add(t.mul(0.5)))) as any;
      const n2 = mx_noise_float(vec3(c.mul(3.6).add(seed.mul(2.9)), y.mul(7.5).sub(t.mul(11)), seed.mul(5.7).add(t.mul(1.1)))) as any;
      // Once per vertex, not per pixel: these depend only on the flame and the time.
      const sway = varying(mx_noise_float(vec3(seed.mul(11), t.mul(1.3), 4.2)).mul(0.35)) as any;
      const flicker = varying(mx_noise_float(vec3(seed.mul(31), t.mul(9), 1.7)).mul(0.12).add(0.94)) as any;
      const cx = c.add(n1.mul(0.4).add(n2.mul(0.12)).mul(y).mul(1.2)).add(sway.mul(y.mul(y))) as any;
      // The envelope: a rounded foot, narrowing to the tip, well inside the sheet so no edge of it ever shows.
      const width = float(0.85)
        .mul(pow(float(1).sub(y).max(0), 0.5))
        .mul(smoothstep(-0.08, 0.2, y).sqrt()) as any;
      const field = float(1).sub(abs(cx).div(width.max(0.002))) as any;
      // Tongues: above the foot the flame splits into two or three licks, wandering as they rise, clear between them.
      const licks = sin(cx.mul(4.6).add(seed.mul(9)).add(n1.mul(2.6)))
        .mul(0.5)
        .add(0.5) as any;
      const split = float(1).sub(licks).mul(smoothstep(0.15, 0.7, y)) as any;
      // Torn at the tips: rising noise eats holes into the top, so licks break off and vanish.
      const tear = n2.mul(0.45).mul(smoothstep(0.2, 1, y)).add(n1.mul(0.2)) as any;
      const dens = clamp(field.mul(1.3).sub(y.mul(0.38)).add(tear).sub(split.mul(0.95)), 0, 1) as any;
      // The sheet before the crumb is clear at its foot, so the burning crumb shows through it; every sheet fades to
      // nothing well inside its four edges.
      const foot0 = sheet.equal(1).select(float(0.2), float(0.1)) as any;
      const edges = smoothstep(1, 0.86, abs(c)).mul(smoothstep(1, 0.86, y)) as any;
      const mask = smoothstep(0.03, 0.24, dens)
        .mul(smoothstep(0, foot0, y))
        .mul(edges) as any;
      // Temperature: dim and blue at the very foot, hottest a quarter of the way up in each tongue's thin centre,
      // cooling outward and upward to orange and red.
      const heat = clamp(
        dens
          .mul(pow(clamp(field, 0, 1), 0.8))
          .mul(smoothstep(0.0, 0.2, y).mul(0.8).add(0.2))
          .mul(float(1).sub(smoothstep(0.25, 1, y).mul(0.55)))
          .mul(1.15),
        0,
        1
      ) as any;
      const red = vec3(0.55, 0.09, 0.015);
      const orange = vec3(1.0, 0.33, 0.04);
      const yellow = vec3(1.25, 0.72, 0.18);
      const white = vec3(1.9, 1.45, 0.8);
      let colour: any = mix(red, orange, smoothstep(0.08, 0.36, heat));
      colour = mix(colour, yellow, smoothstep(0.45, 0.75, heat));
      colour = mix(colour, white, smoothstep(0.82, 1.0, heat));
      // Blue where the flame meets the fuel: a low, faint skirt round the base.
      const blue = smoothstep(0.14, 0.02, y).mul(float(1).sub(smoothstep(0.25, 0.6, heat))) as any;
      colour = mix(colour, vec3(0.22, 0.32, 1.0), blue.mul(0.7));
      // Opaque in the hot cores, thin at the edges and tips; never past the fire's strength. Gone right at the lens.
      const near = smoothstep(0.015, 0.05, length(cameraPosition.sub(foot))).mul(smoothstep(0.04, 0.3, length(cameraPosition.sub(foot))).mul(0.35).add(0.65)) as any;
      const opacity = mask
        .mul(mix(float(0.32), float(0.95), smoothstep(0.1, 0.6, heat)))
        .mul(float(1).sub(blue.mul(0.55)))
        .mul(f.x)
        .mul(flicker)
        .mul(near) as any;
      flameMaterial.colorNode = vec4(colour, 1) as any;
      flameMaterial.opacityNode = clamp(opacity, 0, 1) as any;
    }
    const flames = instanced(quad, flameMaterial, fires * sheets);
    flames.renderOrder = 2;

    // Smoke: grey-brown wisps rising off the fires and coals, widening, drifting and thinning as they go; drawn by their
    // opacity, so they veil what is behind them rather than lighten it.
    const smokeQuad = new THREE.PlaneGeometry(1, 1);
    const smokePlace = new Float32Array(SMOKE[tier] * 4);
    const smokeLook = new Float32Array(SMOKE[tier] * 4);
    const smokePlaceAttribute = new THREE.InstancedBufferAttribute(smokePlace, 4).setUsage(THREE.DynamicDrawUsage);
    const smokeLookAttribute = new THREE.InstancedBufferAttribute(smokeLook, 4).setUsage(THREE.DynamicDrawUsage);
    smokeQuad.setAttribute("aSmoke", smokePlaceAttribute);
    smokeQuad.setAttribute("aSmokeLook", smokeLookAttribute);
    const noise = smokeTexture();
    const smokeMaterial = veilMaterial();
    {
      const s = attribute("aSmoke", "vec4") as any;
      const l = attribute("aSmokeLook", "vec4") as any;
      const toEye = normalize(cameraPosition.sub(s.xyz)) as any;
      const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
      const up = cross(toEye, right) as any;
      // Turned a little over its life, so no two wisps look the same.
      const a = l.y.mul(6.28).add(l.z.mul(1.1)) as any;
      const g = positionGeometry as any;
      const turned = vec2(g.x.mul(cos(a)).sub(g.y.mul(sin(a))), g.x.mul(sin(a)).add(g.y.mul(cos(a)))) as any;
      // Taller than wide: a wisp is drawn out upward as it rises.
      smokeMaterial.positionNode = s.xyz.add(right.mul(turned.x.mul(s.w))).add(up.mul(turned.y.mul(s.w.mul(1.5)))) as any;
      const q = uv().sub(0.5) as any;
      const r = length(q) as any;
      // Two reads of a billowy noise, drifting apart as it ages, thinned to wisps.
      const offset = vec2(l.y.mul(7.1), l.y.mul(3.3)) as any;
      const n = (texture(noise, q.mul(0.55).add(offset).add(vec2(0, l.z.mul(-0.25)))) as any).r.mul(
        (texture(noise, q.mul(1.1).add(offset.mul(1.7)).add(vec2(l.z.mul(0.12), 0))) as any).r.mul(0.8).add(0.4)
      ) as any;
      const shape = float(1).sub(smoothstep(0.12, 0.5, r)) as any;
      const wisp = smoothstep(0.22, 0.7, n.mul(shape).mul(1.6)) as any;
      // Darker and browner fresh off the fire, warmed from below by it; paler grey as it spreads.
      const colour = mix(mix(vec3(0.2, 0.17, 0.14), vec3(0.42, 0.41, 0.4), l.z), vec3(0.75, 0.38, 0.12), l.w) as any;
      smokeMaterial.colorNode = vec4(colour, 1) as any;
      smokeMaterial.opacityNode = clamp(wisp.mul(l.x).mul(0.42), 0, 1) as any;
    }
    const smoke = instanced(smokeQuad, smokeMaterial, SMOKE[tier]);
    smoke.renderOrder = 1;
    const smokeLive = Array.from({ length: SMOKE[tier] }, () => ({ age: 0, life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), size: 0, seed: 0, warm: 0 }));

    // Sparks: glowing motes thrown up off the fires, streaked along their flight, added over the frame.
    const sparkQuad = new THREE.PlaneGeometry(1, 1);
    const sparkPlace = new Float32Array(SPARKS[tier] * 4);
    const sparkMotion = new Float32Array(SPARKS[tier] * 4);
    const sparkPlaceAttribute = new THREE.InstancedBufferAttribute(sparkPlace, 4).setUsage(THREE.DynamicDrawUsage);
    const sparkMotionAttribute = new THREE.InstancedBufferAttribute(sparkMotion, 4).setUsage(THREE.DynamicDrawUsage);
    sparkQuad.setAttribute("aSpark", sparkPlaceAttribute);
    sparkQuad.setAttribute("aSparkMotion", sparkMotionAttribute);
    const sparkMaterial = overlayMaterial();
    const sparks = instanced(sparkQuad, sparkMaterial, SPARKS[tier]);
    sparks.layers.set(OVERLAY_LAYER);
    const sparkLive = Array.from({ length: SPARKS[tier] }, () => ({ age: 0, life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), size: 0, seed: 0 }));

    // The fires' light: dark until a fire burns, then moved to the biggest fires and flickered.
    const lights = Array.from({ length: LIGHTS[tier] }, () => {
      const light = new THREE.PointLight(new THREE.Color("#ff9a48"), 0, 0.7, 2);
      light.castShadow = false;
      return light;
    });
    const group = new THREE.Group();
    group.add(flames, sparks, smoke, ...lights);
    const slots: FireSlot[] = Array.from({ length: fires }, () => ({ on: false, x: 0, y: 0, z: 0, height: 0, width: 0, strength: 0, seed: 0 }));
    return {
      sheets,
      group,
      quad,
      smokeQuad,
      sparkQuad,
      noise,
      flameMaterial,
      smokeMaterial,
      sparkMaterial,
      fireData,
      flameData,
      fireAttribute,
      flameAttribute,
      smokePlace,
      smokeLook,
      smokePlaceAttribute,
      smokeLookAttribute,
      smokeLive,
      nextSmoke: 0,
      sparkPlace,
      sparkMotion,
      sparkPlaceAttribute,
      sparkMotionAttribute,
      sparkLive,
      nextSpark: 0,
      lights,
      // Each light's smoothed place and strength, so it glides between fires rather than jumping.
      lightState: lights.map(() => ({ x: 0, y: 0.05, z: 0, power: 0, target: 0, tx: 0, ty: 0, tz: 0 })),
      slots,
      random
    };
  }, [tier]);
  useDispose(parts.quad, parts.smokeQuad, parts.sparkQuad, parts.noise, parts.flameMaterial, parts.smokeMaterial, parts.sparkMaterial);

  // The sparks' shading, built once the overlay pass hands over the scene's depth.
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const s = attribute("aSpark", "vec4") as any;
        const m = attribute("aSparkMotion", "vec4") as any;
        const v = m.xyz as any;
        const speed = length(v) as any;
        const along = normalize(v.add(vec3(0, 1e-4, 0))) as any;
        const toEye = normalize(cameraPosition.sub(s.xyz)) as any;
        const side = normalize(cross(along, toEye).add(vec3(1e-4, 0, 0))) as any;
        const g = positionGeometry as any;
        // Streaked along the flight, about as a frame's exposure would.
        const long = s.w.add(speed.mul(0.014)) as any;
        parts.sparkMaterial.positionNode = s.xyz.add(side.mul(g.x.mul(s.w))).add(along.mul(g.y.mul(long))) as any;
        const q = uv().sub(0.5).mul(2) as any;
        const r = length(vec2(q.x, q.y)) as any;
        const core = pow(float(1).sub(smoothstep(0, 1, r)), 2) as any;
        const shown = clamp(positionView.z.sub(sceneZ).div(0.002).add(1), 0, 1) as any;
        // Hot and yellow when thrown, cooling to a deep orange as it dies.
        const colour = mix(vec3(1.0, 0.36, 0.06), vec3(1.0, 0.8, 0.4), m.w) as any;
        parts.sparkMaterial.colorNode = vec4(clamp(colour.mul(core).mul(m.w.mul(3.2).add(0.4)).mul(max(m.w, 0)).mul(shown), 0, 4) as any, 1) as any;
        parts.sparkMaterial.needsUpdate = true;
      }),
    [parts]
  );

  return useMemo(() => {
    const { slots, fireData, flameData, smokeLive, smokePlace, smokeLook, sparkLive, sparkPlace, sparkMotion, lights, lightState, random } = parts;
    const order: number[] = [];
    const api = {
      group: parts.group,
      slots,
      // Throws n sparks up from a point.
      spark(x: number, y: number, z: number, n: number, kick = 1) {
        for (let i = 0; i < n; i++) {
          const w = sparkLive[parts.nextSpark++ % sparkLive.length];
          w.age = 0;
          w.life = 0.6 + random() * 1.3;
          w.p.set(x + (random() - 0.5) * 0.01, y, z + (random() - 0.5) * 0.01);
          w.v.set((random() - 0.5) * 0.09 * kick, (0.1 + random() * 0.16) * kick, (random() - 0.5) * 0.09 * kick);
          w.size = 0.0008 + random() * 0.0011;
          w.seed = random();
        }
      },
      // A wisp of smoke from a point: size its starting width, warm how much the fire below lights it.
      smoke(x: number, y: number, z: number, size: number, warm: number) {
        const w = smokeLive[parts.nextSmoke++ % smokeLive.length];
        w.age = 0;
        w.life = 2.4 + random() * 2.2;
        w.p.set(x + (random() - 0.5) * 0.006, y, z + (random() - 0.5) * 0.006);
        w.v.set((random() - 0.5) * 0.01, 0.05 + random() * 0.04, (random() - 0.5) * 0.01);
        w.size = size * (0.8 + random() * 0.4);
        w.seed = random();
        w.warm = warm;
      },
      reset() {
        for (const w of smokeLive) w.life = 0;
        for (const s of slots) s.on = false;
        for (const w of sparkLive) w.life = 0;
        for (const l of lightState) l.power = l.target = 0;
        for (const l of lights) l.intensity = 0;
      },
      update(dt: number, now: number) {
        // The flames, from their slots.
        for (let f = 0; f < slots.length; f++) {
          const s = slots[f];
          for (let sheet = 0; sheet < parts.sheets; sheet++) {
            const i = (f * parts.sheets + sheet) * 4;
            if (!s.on || !(s.strength > 0.001)) {
              fireData[i + 3] = 0;
              flameData[i] = 0;
              flameData[i + 2] = 0;
              continue;
            }
            fireData[i] = s.x;
            fireData[i + 1] = s.y;
            fireData[i + 2] = s.z;
            fireData[i + 3] = s.height;
            flameData[i] = Math.min(1, s.strength);
            flameData[i + 1] = s.seed + sheet * 0.371;
            flameData[i + 2] = s.width;
            flameData[i + 3] = sheet;
          }
        }
        parts.fireAttribute.needsUpdate = true;
        parts.flameAttribute.needsUpdate = true;

        // The smoke: rising and slowing, drifting on the room's air and curling, widening, thinning to nothing.
        for (let k = 0; k < smokeLive.length; k++) {
          const w = smokeLive[k];
          if (w.life <= 0 || w.age >= w.life || !Number.isFinite(w.p.x + w.p.y + w.p.z)) {
            w.life = 0;
            smokePlace[k * 4 + 3] = 0;
            smokeLook[k * 4] = 0;
            continue;
          }
          w.age += dt;
          w.v.y += (0.035 - w.v.y) * dt * 0.6;
          w.v.x += (0.012 - w.v.x) * dt * 0.4 + Math.sin(w.age * 1.7 + w.seed * 30) * 0.012 * dt;
          w.v.z += (-0.006 - w.v.z) * dt * 0.4 + Math.cos(w.age * 1.4 + w.seed * 20) * 0.012 * dt;
          w.p.addScaledVector(w.v, dt);
          // Never past its end: a negative base to a fractional power is NaN.
          const f = Math.min(1, w.age / w.life);
          smokePlace[k * 4] = w.p.x;
          smokePlace[k * 4 + 1] = w.p.y;
          smokePlace[k * 4 + 2] = w.p.z;
          smokePlace[k * 4 + 3] = w.size * (1 + f * 3.2);
          smokeLook[k * 4] = Math.min(1, w.age * 3) * Math.pow(1 - f, 1.4);
          smokeLook[k * 4 + 1] = w.seed;
          smokeLook[k * 4 + 2] = f;
          smokeLook[k * 4 + 3] = w.warm * Math.max(0, 1 - f * 3);
        }
        parts.smokePlaceAttribute.needsUpdate = true;
        parts.smokeLookAttribute.needsUpdate = true;

        // The sparks: rising on the hot air, drifting, slowing, cooling.
        for (let k = 0; k < sparkLive.length; k++) {
          const w = sparkLive[k];
          if (w.life <= 0 || w.age >= w.life || !Number.isFinite(w.p.x + w.p.y + w.p.z)) {
            w.life = 0;
            sparkPlace[k * 4 + 3] = 0;
            sparkMotion[k * 4 + 3] = 0;
            continue;
          }
          w.age += dt;
          w.v.y += (0.12 - w.v.y * 0.9) * dt;
          w.v.x += Math.sin(w.age * 7 + w.seed * 40) * 0.25 * dt - w.v.x * 1.2 * dt;
          w.v.z += Math.cos(w.age * 6 + w.seed * 30) * 0.25 * dt - w.v.z * 1.2 * dt;
          w.p.addScaledVector(w.v, dt);
          const f = Math.min(1, w.age / w.life);
          sparkPlace[k * 4] = w.p.x;
          sparkPlace[k * 4 + 1] = w.p.y;
          sparkPlace[k * 4 + 2] = w.p.z;
          sparkPlace[k * 4 + 3] = w.size * (1 - f * 0.5);
          sparkMotion[k * 4] = w.v.x;
          sparkMotion[k * 4 + 1] = w.v.y;
          sparkMotion[k * 4 + 2] = w.v.z;
          // Brightness, twinkling as it tumbles, falling to nothing.
          sparkMotion[k * 4 + 3] = Math.max(0, (1 - f) * (0.75 + 0.25 * Math.sin(w.age * 40 + w.seed * 9)));
        }
        parts.sparkPlaceAttribute.needsUpdate = true;
        parts.sparkMotionAttribute.needsUpdate = true;

        // The light: the strongest fires, each lighting what lies round it; fires near one already lit share it.
        order.length = 0;
        for (let f = 0; f < slots.length; f++) if (slots[f].on && slots[f].strength > 0.02) order.push(f);
        order.sort((a, b) => slots[b].strength * slots[b].height - slots[a].strength * slots[a].height);
        for (const l of lightState) l.target = 0;
        let used = 0;
        for (const f of order) {
          const s = slots[f];
          const power = s.strength * s.height;
          let joined = false;
          for (let k = 0; k < used; k++) {
            const l = lightState[k];
            if (Math.hypot(l.tx - s.x, l.tz - s.z) < 0.07) {
              l.target += power * 0.5;
              joined = true;
              break;
            }
          }
          if (joined || used >= lightState.length) continue;
          const l = lightState[used++];
          l.tx = s.x;
          l.ty = s.y + s.height * 0.8;
          l.tz = s.z;
          l.target = power;
          // A light taking up a new fire starts there, rather than sweeping across the plate.
          if (l.power < 0.002) {
            l.x = l.tx;
            l.y = l.ty;
            l.z = l.tz;
          }
        }
        const ease = Math.min(1, dt * 6);
        for (let k = 0; k < lights.length; k++) {
          const l = lightState[k];
          l.power += (l.target - l.power) * ease;
          l.x += (l.tx - l.x) * ease;
          l.y += (l.ty - l.y) * ease;
          l.z += (l.tz - l.z) * ease;
          const flicker = 0.78 + 0.14 * Math.sin(now * 23 + k * 2.1) + 0.08 * Math.sin(now * 41.3 + k * 5.7);
          const intensity = Math.min(0.0028, Math.max(0, l.power * 0.035 * flicker));
          lights[k].intensity = Number.isFinite(intensity) ? intensity : 0;
          lights[k].position.set(l.x + Math.sin(now * 13 + k) * 0.002, l.y, l.z + Math.cos(now * 11 + k) * 0.002);
        }
      }
    };
    if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __fire: api });
    return api;
  }, [parts]);
}

