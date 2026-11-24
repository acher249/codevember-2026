"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  cross,
  dot,
  exp,
  float,
  fract,
  getViewPosition,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  screenUV,
  sin,
  smoothstep,
  step,
  time,
  uv,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import type { Lighting } from "./light";

// The air round the nest, drawn in the overlay pass and hidden behind whatever is nearer: snow falling through the
// dusk, small sharp flakes round the nest and a few big soft discs drifting past close to the lens; the chicks' breath
// puffing in the cold; and the soft halo of the thermostat's screen.

const APERTURE = 0.4;
const MOST = 0.03;
export const PUFFS = 12;

// Turned square to the eye: a quad's corner from its centre and radius. Built fresh for each use.
function facing(centre: any, radius: any) {
  const toEye = normalize(cameraPosition.sub(centre).add(vec3(0, 0, 1e-5))) as any;
  const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
  const up = cross(toEye, right) as any;
  return centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
}

// `puffs` holds each puff of breath as [x, y, z, age 0 to 1], written by the scene each frame.
// The shafts: where each passes through the scene (they run along the light from behind), and how wide.
const BEAMS: [number, number, number, number][] = [
  [-3, 4, -4, 2.6],
  [7, 6, -9, 4],
  [-14, 2, -6, 3.2],
  [2, -6, 3, 2],
  [-6, 14, -16, 5]
];
const BEAM_LENGTH = 170;

// `cup` is the inside of the nest, round the origin: its radius at the rim. No light gets down there.
export function Air({ l, count, motes, fall, puffs, breath, cup }: { l: Lighting; count: number; motes: number; fall: any; puffs: THREE.InstancedBufferAttribute; breath: any; cup: number }) {
  const parts = useMemo(() => {
    const random = lehmer(4471);
    const draw = () => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
      m.colorNode = vec4(0, 0, 0, 0);
      return m;
    };
    const quad = new THREE.PlaneGeometry(1, 1);
    const flakeQuad = quad.clone();
    const a = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) a.set([random(), random(), random(), random()], i * 4);
    flakeQuad.setAttribute("aA", new THREE.InstancedBufferAttribute(a, 4));
    const flakeMaterial = draw();
    const flakes = new THREE.InstancedMesh(flakeQuad, flakeMaterial, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) flakes.setMatrixAt(i, identity);
    flakes.frustumCulled = false;
    flakes.layers.set(OVERLAY_LAYER);
    // Breath: each puff's centre and age, written each frame.
    const puffQuad = quad.clone();
    puffQuad.setAttribute("aPuff", puffs);
    const puffMaterial = draw();
    const breathMesh = new THREE.InstancedMesh(puffQuad, puffMaterial, PUFFS);
    for (let i = 0; i < PUFFS; i++) breathMesh.setMatrixAt(i, identity);
    breathMesh.frustumCulled = false;
    breathMesh.layers.set(OVERLAY_LAYER);
    // The screen's halo.
    const haloMaterial = draw();
    const halo = new THREE.Mesh(quad, haloMaterial);
    halo.frustumCulled = false;
    halo.layers.set(OVERLAY_LAYER);
    // Shafts: one long quad each, turned about its own length to face the eye.
    const beamQuad = quad.clone();
    beamQuad.setAttribute("aBeam", new THREE.InstancedBufferAttribute(new Float32Array(BEAMS.flat()), 4));
    const beamMaterial = draw();
    const beams = new THREE.InstancedMesh(beamQuad, beamMaterial, BEAMS.length);
    for (let i = 0; i < BEAMS.length; i++) beams.setMatrixAt(i, identity);
    beams.frustumCulled = false;
    beams.layers.set(OVERLAY_LAYER);
    // Motes: pollen and dust adrift in the warm air.
    const moteQuad = quad.clone();
    const m4 = new Float32Array(motes * 4);
    for (let i = 0; i < motes; i++) m4.set([random(), random(), random(), random()], i * 4);
    moteQuad.setAttribute("aA", new THREE.InstancedBufferAttribute(m4, 4));
    const moteMaterial = draw();
    const moteMesh = new THREE.InstancedMesh(moteQuad, moteMaterial, motes);
    for (let i = 0; i < motes; i++) moteMesh.setMatrixAt(i, identity);
    moteMesh.frustumCulled = false;
    moteMesh.layers.set(OVERLAY_LAYER);
    return { quad, flakeQuad, flakes, flakeMaterial, puffQuad, breathMesh, puffMaterial, halo, haloMaterial, beamQuad, beams, beamMaterial, moteQuad, moteMesh, moteMaterial };
  }, [count, motes, puffs]);
  useDispose(parts.quad, parts.flakeQuad, parts.flakeMaterial, parts.puffQuad, parts.puffMaterial, parts.haloMaterial, parts.beamQuad, parts.beamMaterial, parts.moteQuad, parts.moteMaterial);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = () => perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const t = time as any;
        // What lights the air: the key light and the sky, and the thermostat's glow close to it.
        const light = (p: any) => {
          const near = float(1).div(max(p.sub(l.glowAt).length().mul(0.09), 1).pow(2)) as any;
          return (l.sun as any).mul(0.55).add((l.sky as any).mul(0.9)).add((l.glow as any).mul(near.mul(0.5))) as any;
        };

        // Flakes: in a box round the nest, falling and swaying; one in six close to the lens. Each shown only while the
        // snowfall is heavy enough for it.
        {
          const s = attribute("aA", "vec4") as any;
          const box = vec3(150, 90, 120) as any;
          const lo = vec3(-70, -40, -70) as any;
          const speed = s.y.mul(14).add(16) as any;
          const sway = vec3(sin(t.mul(s.x.mul(0.8).add(0.5)).add(s.z.mul(40))).mul(3), t.mul(speed).negate(), sin(t.mul(s.z.mul(0.7).add(0.4)).add(s.x.mul(31))).mul(3)) as any;
          const nearLens = step(s.w, 0.16) as any;
          const lensBox = 26;
          const centre = () => mix(lo.add(fract(s.xyz.add(sway.div(box))).mul(box)), cameraPosition.add(fract(s.xyz.add(sway.mul(0.4).div(lensBox)).sub(cameraPosition.div(lensBox))).sub(0.5).mul(lensBox)), nearLens) as any;
          const sizing = (c: any) => {
            const away = max(cameraPosition.sub(c).length(), 1) as any;
            // Flakes a couple of millimetres to a centimetre, and the blur of the lens on top.
            const sharp = max(float(0.06), away.mul(0.0012)).mul(s.y.mul(1.4).add(0.6)) as any;
            const blur = min(away.sub(focusDistance).abs().mul(APERTURE * 0.5).div(focusDistance), away.mul(MOST)) as any;
            const shown = step(fract(s.w.mul(7.31).add(s.x)), fall) as any;
            return { sharp, blur, radius: sharp.add(blur).mul(shown) };
          };
          const c0 = centre();
          parts.flakeMaterial.positionNode = facing(c0, sizing(c0).radius);
          const c1 = centre();
          const z = sizing(c1);
          const spread = z.sharp.div(z.sharp.add(z.blur)).pow(2).max(0.03) as any;
          const r = uv().sub(0.5).length() as any;
          const soft = smoothstep(0.02, 0.4, z.blur) as any;
          const shape = mix(float(1).sub(smoothstep(0.12, 0.5, r)), float(1).sub(smoothstep(0.38, 0.5, r)).mul(0.8), soft) as any;
          const shown = step(sceneZ(), positionView.z) as any;
          const bright = spread.mul(shape).mul(shown).mul(s.z.mul(0.6).add(0.5)) as any;
          parts.flakeMaterial.colorNode = vec4(light(c1).mul(bright.mul(0.9)), 1) as any;
          parts.flakeMaterial.needsUpdate = true;
        }

        // Breath: a soft cloud swelling and fading from each beak.
        {
          const p = attribute("aPuff", "vec4") as any;
          const age = p.w as any;
          const radius = () => age.mul(2.4).add(0.4).mul(step(0.001, age)).mul(step(age, 0.999)) as any;
          parts.puffMaterial.positionNode = facing(p.xyz, radius());
          const r = uv().sub(0.5).length() as any;
          const wisp = mx_noise_float(vec3(uv().mul(3), age.mul(2).add(p.x))).mul(0.5).add(0.5) as any;
          const fade = smoothstep(0, 0.12, age).mul(float(1).sub(age).pow(2)) as any;
          const shape = float(1).sub(smoothstep(0.1, 0.5, r)).mul(wisp) as any;
          const shown = step(sceneZ(), positionView.z) as any;
          parts.puffMaterial.colorNode = vec4(light(p.xyz).mul(shape.mul(fade).mul(shown).mul(breath).mul(1.3)), 1) as any;
          parts.puffMaterial.needsUpdate = true;
        }

        // Shafts of the light from behind, slanting down through the scene: a soft bell across, fading at the ends, fading
        // where the eye looks along one (its sides would show as hard bands), softly cut where it meets the scene, and
        // breathing a little as if through moving leaves. Dim blue moonlight in the cold, gold once warm.
        {
          const b = attribute("aBeam", "vec4") as any;
          const axis = (l.toBack as any).negate() as any;
          const anchor = b.xyz as any;
          const centreAt = () => anchor.add(axis.mul(positionGeometry.y.mul(BEAM_LENGTH))) as any;
          {
            const c = centreAt();
            const toEye = normalize(cameraPosition.sub(c)) as any;
            const right = normalize(cross(axis, toEye).add(vec3(1e-4, 0, 0))) as any;
            parts.beamMaterial.positionNode = c.add(right.mul(positionGeometry.x.mul(b.w.mul(2)))) as any;
          }
          const c = centreAt();
          const across = uv().x.sub(0.5).mul(2) as any;
          const along = uv().y as any;
          const bell = exp(across.mul(across).mul(-4)) as any;
          const ends = smoothstep(0, 0.3, along).mul(float(1).sub(smoothstep(0.55, 1, along))) as any;
          const view = normalize(c.sub(cameraPosition)) as any;
          const sideOn = float(1).sub(dot(view, axis).abs().pow(3)) as any;
          const soft = smoothstep(0, 4, positionView.z.sub(sceneZ())) as any;
          const breathe = sin(t.mul(0.7).add(b.x.mul(0.3))).mul(0.25).add(sin(t.mul(1.9).add(b.y)).mul(0.1)).add(0.8) as any;
          // None over the inside of the nest: where the scene behind is down in the cup, the shaft is cut, so it stays dark.
          const behind = cameraWorldMatrix.mul(vec4(getViewPosition(screenUV, depth.sample(screenUV).r, cameraProjectionMatrixInverse), 1)).xyz as any;
          const inCup = float(1).sub(smoothstep(cup * 0.8, cup * 1.05, vec3(behind.x, 0, behind.z).length())).mul(float(1).sub(smoothstep(-0.5, 1.5, behind.y))) as any;
          parts.beamMaterial.colorNode = vec4((l.back as any).mul(bell.mul(ends).mul(sideOn).mul(soft).mul(breathe).mul(float(1).sub(inCup)).mul(0.4)), 1) as any;
          parts.beamMaterial.needsUpdate = true;
        }

        // Motes: pollen and dust turning slowly in the warm air round the nest, a few close to the lens as big soft discs;
        // faint in the shade, bright where they cross a shaft. Only once it is warm (the cold has snow instead).
        {
          const s = attribute("aA", "vec4") as any;
          const box = vec3(90, 60, 80) as any;
          const lo = vec3(-35, -25, -45) as any;
          const drift = vec3(sin(t.mul(0.11).add(s.x.mul(40))).mul(4), sin(t.mul(0.07).add(s.y.mul(30))).mul(3).add(t.mul(0.4)), sin(t.mul(0.09).add(s.z.mul(50))).mul(4)) as any;
          const nearLens = step(s.w, 0.12) as any;
          const lensBox = 24;
          const centre = () => mix(lo.add(fract(s.xyz.add(drift.div(box))).mul(box)), cameraPosition.add(fract(s.xyz.add(drift.mul(0.5).div(lensBox)).sub(cameraPosition.div(lensBox))).sub(0.5).mul(lensBox)), nearLens) as any;
          const warm = smoothstep(0.35, 0.7, l.heat) as any;
          const sizing = (c: any) => {
            const away = max(cameraPosition.sub(c).length(), 1) as any;
            const sharp = max(float(0.03), away.mul(0.0009)).mul(s.y.mul(1.6).add(0.4)) as any;
            const blur = min(away.sub(focusDistance).abs().mul(APERTURE * 0.5).div(focusDistance), away.mul(MOST)) as any;
            return { sharp, blur, radius: sharp.add(blur).mul(step(0.01, warm)) };
          };
          const c0 = centre();
          parts.moteMaterial.positionNode = facing(c0, sizing(c0).radius);
          const c1 = centre();
          const z = sizing(c1);
          // How deep in a shaft it floats.
          const axis = (l.toBack as any).negate() as any;
          let inBeam: any = float(0);
          for (const [x, y, zz, w] of BEAMS) {
            const d = c1.sub(vec3(x, y, zz)) as any;
            const off = d.sub(axis.mul(dot(d, axis))).length() as any;
            inBeam = inBeam.add(exp(off.div(w).pow(2).mul(-2.5)));
          }
          const spread = z.sharp.div(z.sharp.add(z.blur)).pow(2).max(0.03) as any;
          const r = uv().sub(0.5).length() as any;
          const soft = smoothstep(0.02, 0.4, z.blur) as any;
          const shape = mix(float(1).sub(smoothstep(0.1, 0.5, r)), float(1).sub(smoothstep(0.36, 0.5, r)).mul(0.8), soft) as any;
          const shown = step(sceneZ(), positionView.z) as any;
          const twinkle = sin(t.mul(s.z.mul(2).add(0.5)).add(s.x.mul(60))).mul(0.3).add(0.7) as any;
          const lit = (l.back as any).mul(inBeam.min(1.5).mul(1.6).add(0.08)).add((l.sun as any).mul(0.05)) as any;
          parts.moteMaterial.colorNode = vec4(lit.mul(spread.mul(shape).mul(shown).mul(twinkle).mul(warm).mul(1.2)), 1) as any;
          parts.moteMaterial.needsUpdate = true;
        }

        // The halo: a wide soft glow in front of the screen, the colour of what it shows.
        {
          const r = uv().sub(0.5).length() as any;
          const shape = float(1).sub(smoothstep(0, 0.5, r)).pow(2.2) as any;
          parts.haloMaterial.positionNode = facing(l.glowAt as any, float(9));
          parts.haloMaterial.colorNode = vec4((l.glow as any).mul(shape.mul(0.07)), 1) as any;
          parts.haloMaterial.needsUpdate = true;
        }
      }),
    [parts, l, fall, breath, cup]
  );

  return (
    <>
      <primitive object={parts.flakes} />
      <primitive object={parts.breathMesh} />
      <primitive object={parts.halo} />
      <primitive object={parts.beams} />
      <primitive object={parts.moteMesh} />
    </>
  );
}
