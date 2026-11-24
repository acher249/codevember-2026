"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  cross,
  exp,
  float,
  fract,
  max,
  min,
  mix,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  positionWorld,
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
import { dappleAt, type Lighting } from "./light";

// The air round the nest: sunlight showing as soft shafts where it comes through the gaps in the leaves (the same gaps
// that dapple the nest), and specks of dust and pollen turning in it, a few close to the lens drifting past as big soft
// discs. Drawn in the overlay pass, hidden behind whatever is nearer. All of it fades out as the camera dives into the
// photograph and back in after, since the photograph's render has none.

const APERTURE = 0.35;
const MOST = 0.03;

export function Air({ l, fade, amount }: { l: Lighting; fade: any; amount: any }) {
  const parts = useMemo(() => {
    const random = lehmer(9917);
    const draw = () => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
      m.colorNode = vec4(0, 0, 0, 0);
      return m;
    };
    // The shafts: a box round the nest that the eye's ray is marched through.
    const boxMaterial = draw();
    boxMaterial.side = THREE.BackSide;
    const boxGeometry = new THREE.BoxGeometry(110, 80, 110);
    boxGeometry.translate(0, 8, -10);
    const box = new THREE.Mesh(boxGeometry, boxMaterial);
    box.layers.set(OVERLAY_LAYER);
    box.frustumCulled = false;
    // Specks: instanced quads turned to the eye.
    const count = 1600;
    const quad = new THREE.PlaneGeometry(1, 1);
    const a = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) a.set([random(), random(), random(), random()], i * 4);
    quad.setAttribute("aA", new THREE.InstancedBufferAttribute(a, 4));
    const dustMaterial = draw();
    const dust = new THREE.InstancedMesh(quad, dustMaterial, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) dust.setMatrixAt(i, identity);
    dust.frustumCulled = false;
    dust.layers.set(OVERLAY_LAYER);
    return { box, boxMaterial, boxGeometry, dust, dustMaterial, quad };
  }, []);
  useDispose(parts.boxGeometry, parts.boxMaterial, parts.quad, parts.dustMaterial);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const sun = l.sun as any;
        // Shafts: eight steps along the eye's ray to the scene, summing the light where it gets through the canopy.
        parts.boxMaterial.colorNode = Fn(() => {
          const dir = normalize(positionWorld.sub(cameraPosition)) as any;
          const stop = sceneZ.div(normalize(positionView).z) as any;
          let sum: any = float(0);
          const steps = 8;
          const jitter = fract(sin(screenUV.x.mul(91.3).add(screenUV.y.mul(47.1))).mul(4375.5)) as any;
          for (let k = 0; k < steps; k++) {
            const d = min(stop, float(6).add(float(k).add(jitter).mul(7))) as any;
            const p = cameraPosition.add(dir.mul(d)) as any;
            const lit = smoothstep(0.98, 1.15, dappleAt(l, p)) as any;
            // Thinner far from the nest, and nothing below the branch.
            const near = exp(p.length().mul(-0.03)) as any;
            sum = sum.add(lit.mul(near).mul(step(float(6).add(float(k).add(jitter).mul(7)), stop)));
          }
          return vec4(sun.mul(sum.mul(0.0045)).mul(fade).mul(amount), 1);
        })() as any;
        parts.boxMaterial.needsUpdate = true;

        // Specks: in a box round the nest, slowly turning and sinking, bright in the sun's gaps; one in six near the lens.
        const s = attribute("aA", "vec4") as any;
        const t = time as any;
        const box = vec3(70, 46, 60) as any;
        const lo = vec3(-35, -10, -30) as any;
        const drift = vec3(sin(t.mul(0.05).add(s.w.mul(40))).mul(2), t.mul(-0.2).mul(s.w.add(0.4)), sin(t.mul(0.04).add(s.x.mul(31))).mul(2)) as any;
        const nearLens = step(s.w, 0.16) as any;
        const inAir = lo.add(fract(s.xyz.add(drift.div(box))).mul(box)) as any;
        const lensBox = 8;
        const lens = cameraPosition.add(fract(s.xyz.add(drift.div(lensBox)).sub(cameraPosition.div(lensBox))).sub(0.5).mul(lensBox)) as any;
        const centre = mix(inAir, lens, nearLens) as any;
        const toEye = normalize(cameraPosition.sub(centre).add(vec3(0, 0, 1e-5))) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
        const up = cross(toEye, right) as any;
        const away = max(cameraPosition.sub(centre).length(), 1e-3) as any;
        const sharp = max(float(0.01), away.mul(0.0012)).mul(s.y.mul(1.2).add(0.5)) as any;
        const blur = min(away.sub(focusDistance).abs().mul(APERTURE * 0.5).div(focusDistance), away.mul(MOST)) as any;
        const radius = sharp.add(blur) as any;
        parts.dustMaterial.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
        const lit = smoothstep(0.85, 1.1, dappleAt(l, centre)) as any;
        const spread = sharp.div(radius).pow(2).max(0.02) as any;
        const twinkle = sin(t.mul(s.y.mul(2).add(0.6)).add(s.z.mul(50))).mul(0.3).add(0.7) as any;
        const r = uv().sub(0.5).length() as any;
        const soft = smoothstep(0.02, 0.2, blur) as any;
        const shape = mix(float(1).sub(smoothstep(0.1, 0.5, r)), float(1).sub(smoothstep(0.4, 0.5, r)).mul(0.7), soft) as any;
        const shown = step(sceneZ, positionView.z) as any;
        const bright = mix(float(0.04), float(0.9), lit).mul(twinkle).mul(spread).mul(shape).mul(shown) as any;
        parts.dustMaterial.colorNode = vec4(sun.mul(bright.min(3)).mul(0.6).mul(fade), 1) as any;
        parts.dustMaterial.needsUpdate = true;
      }),
    [parts, l, fade, amount]
  );

  return (
    <>
      <primitive object={parts.box} />
      <primitive object={parts.dust} />
    </>
  );
}
