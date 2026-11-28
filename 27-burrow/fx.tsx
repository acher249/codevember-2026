"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  clamp,
  cos,
  cross,
  dot,
  float,
  Fn,
  fract,
  If,
  instanceIndex,
  length,
  lights,
  mix,
  mx_noise_float,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  pow,
  positionWorld,
  screenUV,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uniformArray,
  uv,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../shared/engine/Post";
import { lehmer } from "../shared/engine/random";
import type { Rock } from "./field";
import type { Textures } from "./rock";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The headlamp, for anything in the air that it lights: where it is and which way it points.
export const lamp = {
  position: uniform(new THREE.Vector3()) as any,
  direction: uniform(new THREE.Vector3(0, 0, -1)) as any,
  // 0 outside in daylight (the lamp is lost in it), 1 underground.
  strength: uniform(0) as any,
  time: uniform(0) as any,
  // How far underground the eye is (0 out in the daylight, 1 underground), for what the sun can still light.
  inside: uniform(0) as any
};

// The torches nearest the eye, as position and brightness, for anything in the air they light (torches.tsx fills it).
export const TORCH_LIGHTS = 6;
export const torchLights = uniformArray(
  Array.from({ length: TORCH_LIGHTS }, () => new THREE.Vector4(0, -1000, 0, 0)),
  "vec4"
) as any;

// The only lights the caverns' dressing is lit by: the sky's fill (dimmed underground by `caveShade`), the headlamp and
// the torches (index.tsx fills it in). Never the sun, whose shadow map says it is dark down there anyway but still costs
// its taps on every pixel, nor the lake's chimney beam.
export const caveLights = lights([]);

// The warm light of the nearest torches at a point in the air.
export function inTorches(p: any) {
  let sum = float(0) as any;
  for (let k = 0; k < TORCH_LIGHTS; k++) {
    const t = torchLights.element(k) as any;
    const d = p.sub(t.xyz).length() as any;
    sum = sum.add(t.w.div(d.mul(d).mul(1.6).add(0.4)));
  }
  return vec3(1.0, 0.62, 0.3).mul(sum) as any;
}

// How strongly the headlamp lights a point in the air: inside its cone, falling off with distance.
function inBeam(p: any) {
  const to = p.sub(lamp.position) as any;
  const d = length(to) as any;
  const cone = smoothstep(0.8, 0.95, dot(to.div(d.add(1e-4)), lamp.direction)) as any;
  return cone.div(d.mul(d).mul(0.18).add(0.25)).mul(lamp.strength) as any;
}

// Sunlit air: in front of the cliff face (roughly z > 0), while the eye is out in it.
const outdoors = (p: any) => smoothstep(-0.3, 1.2, p.z).mul(float(1).sub(lamp.inside)) as any;

// Built with the scene's depth once the overlay pass has it, so what is drawn there hides behind the rock.
export function useOverlay(material: THREE.Material, build: (sceneZ: any) => void) {
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        build(perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the builder closes over the memoised objects that come with the material.
    [material]
  );
}

export function overlayMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  material.colorNode = vec4(0, 0, 0, 0);
  material.positionNode = vec3(0, -1000, 0);
  return material;
}

// ---- Dust ----------------------------------------------------------------------------------------------------------

// Dust knocked out by each strike: not all at once like a shotgun, but let go over a third of a second, thrown out of
// the hole, then rising as one slow column that widens and leans (as Spore's plumes), lit by the sun outside and by
// the headlamp underground.
export function useDust() {
  const parts = useMemo(() => {
    const COUNT = 420;
    const quad = new THREE.PlaneGeometry(1, 1);
    const place = new Float32Array(COUNT * 4);
    const look = new Float32Array(COUNT * 4);
    const placeAttribute = new THREE.InstancedBufferAttribute(place, 4).setUsage(THREE.DynamicDrawUsage);
    const lookAttribute = new THREE.InstancedBufferAttribute(look, 4).setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute("aPlace", placeAttribute);
    quad.setAttribute("aLook", lookAttribute);
    const material = overlayMaterial();
    const mesh = new THREE.InstancedMesh(quad, material, COUNT);
    const identity = new THREE.Matrix4();
    for (let k = 0; k < COUNT; k++) mesh.setMatrixAt(k, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    const live = Array.from({ length: COUNT }, () => ({ age: 0, life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), size: 0, seed: 0, bright: 1 }));
    const random = lehmer(777);
    let next = 0;
    return {
      quad,
      material,
      mesh,
      // A puff at a point, blown out along `out`, `amount` from 0 to 1 (a breakthrough is several).
      emit(at: THREE.Vector3, out: THREE.Vector3, amount: number) {
        const n = Math.round(14 + amount * 30);
        for (let i = 0; i < n; i++) {
          const w = live[next++ % COUNT];
          // Waiting its turn: a negative age is the delay before it appears.
          w.age = -random() * 0.35;
          w.life = 2.2 + random() * 3.5 * (0.6 + amount * 0.6);
          w.p.copy(at).addScaledVector(out, 0.05 + random() * 0.15);
          w.p.x += (random() - 0.5) * 0.3;
          w.p.y += (random() - 0.5) * 0.3;
          w.p.z += (random() - 0.5) * 0.3;
          const speed = 0.4 + random() * 1.4 * (0.6 + amount);
          w.v.copy(out).multiplyScalar(speed);
          w.v.x += (random() - 0.5) * 0.9;
          w.v.y += (random() - 0.5) * 0.6 - 0.1;
          w.v.z += (random() - 0.5) * 0.9;
          w.size = (0.18 + random() * 0.42) * (0.8 + amount * 0.6);
          w.seed = random();
          w.bright = 0.6 + random() * 0.8;
        }
      },
      update(dt: number) {
        if (!(dt >= 0)) dt = 0;
        let alive = 0;
        for (let k = 0; k < COUNT; k++) {
          const w = live[k];
          if (w.life > 0 && w.age < w.life) alive++;
          if (w.life <= 0 || w.age >= w.life) {
            w.life = 0;
            look[k * 4] = 0;
            place[k * 4 + 3] = 0;
            continue;
          }
          w.age += dt;
          if (w.age < 0) {
            look[k * 4] = 0;
            place[k * 4 + 3] = 0;
            continue;
          }
          // Thrown out fast and stopped by the air, then carried up by its own warmth, swirling a little.
          w.v.multiplyScalar(Math.exp(-dt * 2.2));
          w.v.y += dt * 0.11;
          w.v.x += Math.sin(w.age * 1.7 + w.seed * 20) * 0.03 * dt;
          w.v.z += Math.cos(w.age * 1.3 + w.seed * 30) * 0.03 * dt;
          w.p.addScaledVector(w.v, dt);
          const f = Math.min(1, w.age / w.life);
          place[k * 4] = w.p.x;
          place[k * 4 + 1] = w.p.y;
          place[k * 4 + 2] = w.p.z;
          place[k * 4 + 3] = w.size * (0.5 + Math.sqrt(f) * 2.2);
          look[k * 4] = Math.min(1, w.age * 6) * Math.pow(1 - f, 1.4) * w.bright;
          look[k * 4 + 1] = w.seed;
          look[k * 4 + 2] = f;
        }
        // Sent only while there is dust, and once more as the last settles.
        if (alive || this.dusty) {
          placeAttribute.needsUpdate = true;
          lookAttribute.needsUpdate = true;
        }
        this.dusty = alive > 0;
      },
      dusty: true
    };
  }, []);
  useDispose(parts.quad, parts.material);

  useOverlay(parts.material, (sceneZ) => {
    const s = attribute("aPlace", "vec4") as any;
    const l = attribute("aLook", "vec4") as any;
    const toEye = normalize(cameraPosition.sub(s.xyz).add(vec3(0, 0, 1e-5))) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    const a = l.y.mul(6.28).add(l.z.mul(1.2)) as any;
    const g = positionGeometry as any;
    const turned = vec2(g.x.mul(cos(a)).sub(g.y.mul(sin(a))), g.x.mul(sin(a)).add(g.y.mul(cos(a)))) as any;
    parts.material.positionNode = s.xyz.add(right.mul(turned.x.mul(s.w))).add(up.mul(turned.y.mul(s.w))) as any;
    const q = uv().sub(0.5) as any;
    const r = length(q) as any;
    // A soft blob, its edge broken by a couple of overlapping lobes so no two puffs share a shape.
    const lobes = sin(q.x.mul(9).add(l.y.mul(40)))
      .mul(sin(q.y.mul(8).add(l.y.mul(23))))
      .mul(0.18)
      .add(0.82) as any;
    const shape = float(1)
      .sub(smoothstep(0.05, 0.5, r))
      .mul(lobes) as any;
    // Hidden behind rock, fading softly where it meets it rather than cut in a hard line.
    const behind = clamp(positionView.z.sub(sceneZ).div(0.25).add(1), 0, 1) as any;
    const centre = varying(s.xyz) as any;
    const sunlit = outdoors(centre) as any;
    const light = vec3(1.0, 0.95, 0.86)
      .mul(sunlit.mul(0.45))
      .add(vec3(1.0, 0.86, 0.68).mul(inBeam(centre).mul(0.22)))
      .add(inTorches(centre).mul(0.25))
      .add(vec3(0.03, 0.027, 0.024)) as any;
    parts.material.colorNode = vec4(
      light
        .mul(shape)
        .mul(clamp(l.x, 0, 1))
        .mul(behind)
        .mul(0.05),
      1
    ) as any;
    parts.material.needsUpdate = true;
  });
  return parts;
}

// ---- Motes ---------------------------------------------------------------------------------------------------------

// Specks always in the air round the eye, wrapped in a box that moves with it: small sharp ones and big soft ones near
// the lens. Bright specks in the sun outside; underground, seen only where the headlamp's beam catches them.
export function Motes({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(9119);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = overlayMaterial();
    const mesh = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { quad, material, mesh };
  }, [count]);
  useDispose(parts.quad, parts.material);

  useOverlay(parts.material, (sceneZ) => {
    const place = () => {
      const s = attribute("aSeed", "vec4") as any;
      const t = lamp.time as any;
      // One in twenty is a big soft disc close to the lens.
      const lens = step(s.w, 0.05) as any;
      const box = mix(float(7), float(1.2), lens) as any;
      const drift = vec3(sin(t.mul(0.07).add(s.w.mul(40))).mul(0.5), t.mul(s.w.mul(0.03).add(0.012)), sin(t.mul(0.05).add(s.x.mul(30))).mul(0.5)) as any;
      const centre = cameraPosition.add(
        fract(s.xyz.add(drift.div(box)).sub(cameraPosition.div(box)))
          .sub(0.5)
          .mul(box)
      ) as any;
      return { s, lens, centre };
    };
    const a = place();
    const away = length(cameraPosition.sub(a.centre)) as any;
    const radius = mix(a.s.y.mul(0.004).add(0.0016).max(away.mul(0.0011)), a.s.y.mul(0.005).add(0.0035), a.lens) as any;
    const toEye = normalize(cameraPosition.sub(a.centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    parts.material.positionNode = a.centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;

    const b = place();
    const sunlit = outdoors(b.centre) as any;
    const light = vec3(1.0, 0.96, 0.88)
      .mul(sunlit.mul(0.4))
      .add(vec3(1.0, 0.9, 0.75).mul(inBeam(b.centre).mul(0.55)))
      .add(inTorches(b.centre).mul(0.35)) as any;
    // The big discs by the lens only out in the sun: lit by the headlamp at arm's length they read as floating orbs.
    // Now and then a speck turns and flashes as it catches the light: a drifting sparkle.
    const flash = pow(sin(lamp.time.mul(b.s.x.mul(2.5).add(0.7)).add(b.s.y.mul(60))).max(0), float(40))
      .mul(step(b.s.z, 0.05))
      .mul(10) as any;
    const amount = mix(b.s.x.mul(0.8).add(0.2).add(flash), float(0.06).mul(float(1).sub(lamp.strength)), b.lens) as any;
    const colour = varying(light.mul(amount)) as any;
    const r = uv().sub(0.5).length() as any;
    const shape = mix(float(1).sub(smoothstep(0.05, 0.5, r)), float(1).sub(smoothstep(0.36, 0.5, r)), varying(b.lens)) as any;
    const behind = step(sceneZ, positionView.z) as any;
    parts.material.colorNode = vec4(colour.mul(shape).mul(behind), 1) as any;
    parts.material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}

// ---- Torch haze ----------------------------------------------------------------------------------------------------

// The dust hanging in the air round each of the nearest torches, lit by it, so a torch stands in a warm glow of air
// rather than lighting only the rock: one soft sprite per torch light (`torchLights`), a few metres across, turned to the
// eye and brought a little toward it (so the wall the torch is on does not cut the near half), its density a slow
// drifting noise of the world (it stays put as the view turns), its light falling off from the flame. It fades softly
// into the rock (over most of a metre, so it reads as a volume, not a card), as the eye walks into it, and outside.
// One noise per pixel; nothing on the page each frame.
export function TorchHaze({ on }: { on: boolean }) {
  const parts = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1);
    const material = overlayMaterial();
    const mesh = new THREE.InstancedMesh(quad, material, TORCH_LIGHTS);
    const identity = new THREE.Matrix4();
    for (let k = 0; k < TORCH_LIGHTS; k++) mesh.setMatrixAt(k, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { quad, material, mesh };
  }, []);
  useDispose(parts.quad, parts.material);
  useOverlay(parts.material, (sceneZ) => {
    const torch = torchLights.element(instanceIndex) as any;
    const RADIUS = 2.4;
    const toEye = normalize(cameraPosition.sub(torch.xyz).add(vec3(0, 0, 1e-5))) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    const corner = torch.xyz
      .add(toEye.mul(0.45))
      .add(right.mul(positionGeometry.x.mul(RADIUS * 2)))
      .add(up.mul(positionGeometry.y.mul(RADIUS * 2))) as any;
    // An unlit slot (strength 0) is parked far below.
    parts.material.positionNode = mix(vec3(0, -1000, 0), corner, step(1e-4, torch.w)) as any;
    const at = varying(corner) as any;
    const flame = varying(torch.xyz) as any;
    const strength = varying(torch.w) as any;
    const d = at.sub(flame).length() as any;
    const light = strength.div(d.mul(d).mul(1.3).add(0.18)) as any;
    const drift = vec3(lamp.time.mul(0.03), lamp.time.mul(0.06), lamp.time.mul(-0.02)) as any;
    const r = uv().sub(0.5).length().mul(2) as any;
    const edge = float(1).sub(smoothstep(0.55, 1, r)) as any;
    const behind = clamp(positionView.z.sub(sceneZ).div(0.8).add(1), 0, 1) as any;
    const nearEye = smoothstep(0.25, 1.1, cameraPosition.sub(at).length()) as any;
    const amount = light.mul(edge).mul(behind).mul(nearEye).mul(lamp.inside).mul(0.055) as any;
    // The dust's noise only where the haze adds anything (most of each sprite lies behind the rock, or at its faint
    // edge): six sprites metres across near the eye were six screens of noise a frame.
    const haze = Fn(() => {
      const out = vec3(0).toVar("haze") as any;
      If(amount.greaterThan(1e-4), () => {
        const dust = pow(mx_noise_float(at.mul(1.7).add(drift)).mul(0.5).add(0.5), float(2)).mul(1.5).add(0.25) as any;
        out.assign(vec3(1.0, 0.6, 0.3).mul(amount).mul(dust));
      });
      return out;
    })() as any;
    parts.material.colorNode = vec4(haze, 1) as any;
    parts.material.needsUpdate = true;
  });
  parts.mesh.visible = on;
  return <primitive object={parts.mesh} />;
}

// ---- Pebbles -------------------------------------------------------------------------------------------------------

// A chipped stone: an icosphere pushed about by noise and squashed a little, so no two look alike once turned and
// scaled differently.
function pebbleGeometry() {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const p = geometry.getAttribute("position") as THREE.BufferAttribute;
  const random = lehmer(31);
  const bumps = Array.from({ length: 5 }, () => new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize());
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    let r = 1;
    for (const b of bumps) r -= Math.max(0, v.dot(b) - 0.55) * 0.9;
    v.multiplyScalar(r);
    v.y *= 0.7;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.deleteAttribute("uv");
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", p);
  merged.setIndex(geometry.getIndex());
  const flat = merged.toNonIndexed();
  flat.computeVertexNormals();
  geometry.dispose();
  return flat;
}

// Chips of rock knocked out by each strike: they fall, bounce off the field, and stay where they come to rest, so the
// floor of every tunnel gathers the rubble of its digging.
export function usePebbles(field: Rock, textures: Textures, onLand: { current: (size: number, at: THREE.Vector3) => void }) {
  const parts = useMemo(() => {
    const COUNT = 700;
    const geometry = pebbleGeometry();
    const shade = new Float32Array(COUNT * 4);
    const shadeAttribute = new THREE.InstancedBufferAttribute(shade, 4).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aShade", shadeAttribute);
    const material = new THREE.MeshStandardNodeMaterial();
    const s = attribute("aShade", "vec4") as any;
    const p = positionWorld as any;
    const grain = texture(textures.broken, p.xy.mul(3.1).add(p.zx.mul(2.3))).rgb as any;
    material.colorNode = vec3(s.x, s.y, s.z).mul(dot(grain, vec3(0.33)).div(0.3).mul(0.7).add(0.3)) as any;
    material.roughnessNode = float(0.85);
    // How much sky reaches where it lies.
    material.aoNode = s.w;
    const mesh = new THREE.InstancedMesh(geometry, material, COUNT);
    // Too small to matter in the sun's shadow, which is drawn only when the rock changes.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let k = 0; k < COUNT; k++) mesh.setMatrixAt(k, hidden);
    const live = Array.from({ length: COUNT }, () => ({
      p: new THREE.Vector3(),
      v: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      spin: new THREE.Vector3(),
      size: 0,
      moving: false,
      rest: 0,
      used: false
    }));
    const random = lehmer(99);
    let next = 0;
    const m = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const turn = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const grad = [0, 0, 0];
    return {
      geometry,
      material,
      mesh,
      // A few chips from a strike at `at`, thrown out along `out`, coloured like the rock there.
      emit(at: THREE.Vector3, out: THREE.Vector3, count: number, colour: THREE.Color, sky: number) {
        for (let i = 0; i < count; i++) {
          const k = next++ % COUNT;
          const w = live[k];
          w.used = true;
          w.moving = true;
          w.rest = 0;
          w.p.copy(at).addScaledVector(out, 0.12 + random() * 0.1);
          w.v.copy(out).multiplyScalar(0.8 + random() * 2.2);
          w.v.x += (random() - 0.5) * 1.6;
          w.v.y += random() * 1.2;
          w.v.z += (random() - 0.5) * 1.6;
          w.size = 0.012 + Math.pow(random(), 2.2) * 0.07;
          w.q.setFromEuler(euler.set(random() * 6, random() * 6, random() * 6));
          w.spin.set(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(14);
          const tint = 0.75 + random() * 0.4;
          shade.set([colour.r * tint, colour.g * tint, colour.b * tint, sky], k * 4);
        }
        shadeAttribute.needsUpdate = true;
      },
      update(dt: number) {
        if (!(dt > 0)) return;
        let changed = false;
        for (let k = 0; k < COUNT; k++) {
          const w = live[k];
          if (!w.used || !w.moving) continue;
          changed = true;
          w.v.y -= 9.8 * dt;
          w.p.addScaledVector(w.v, dt);
          // Into rock (the ground is rock too): back out along the field's slope, bouncing a little.
          const d = field.sample(w.p.x, w.p.y, w.p.z);
          if (d > -w.size * 0.6) {
            field.gradient(w.p.x, w.p.y, w.p.z, grad);
            let nx = -grad[0];
            let ny = -grad[1];
            let nz = -grad[2];
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len;
            ny /= len;
            nz /= len;
            w.p.x += nx * (d + w.size * 0.6);
            w.p.y += ny * (d + w.size * 0.6);
            w.p.z += nz * (d + w.size * 0.6);
            const into = w.v.x * nx + w.v.y * ny + w.v.z * nz;
            if (into < 0) {
              if (into < -1.2) onLand.current(w.size, w.p);
              w.v.x -= nx * into * 1.35;
              w.v.y -= ny * into * 1.35;
              w.v.z -= nz * into * 1.35;
              w.v.multiplyScalar(0.55);
              w.spin.multiplyScalar(0.6);
            }
            if (w.v.lengthSq() < 0.04) w.rest += dt;
          }
          if (w.rest > 0.25 || w.p.y < -3) {
            w.moving = false;
            w.v.set(0, 0, 0);
          }
          turn.setFromEuler(euler.set(w.spin.x * dt, w.spin.y * dt, w.spin.z * dt));
          w.q.multiply(turn);
          m.compose(w.p, w.q, scale.setScalar(w.size));
          mesh.setMatrixAt(k, m);
        }
        if (changed) mesh.instanceMatrix.needsUpdate = true;
      }
    };
  }, [field, textures, onLand]);
  useDispose(parts.geometry, parts.material);
  return parts;
}

// The sky's light underground: none. Things in the caves take this as their occlusion, so the open sky's fill (the
// hemisphere light, unshadowed) does not light them as if they stood outside. (The rock has its own, by depth.)
export const caveShade = () => float(1).sub(lamp.inside.mul(0.92)) as any;
