"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cameraFar, cameraNear, cameraPosition, cross, dot, exp, float, mx_noise_float, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, screenUV, smoothstep, uv, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";

// Shafts of the low morning sun slanting down through the gaps in the canopy, drawn in the overlay pass (added over
// the finished scene and hidden by its depth, never in the scene itself). Steady: no flicker or drift.
//
// They are kept well away from the drawing: nearer than STOP down the street only out over the road or by the houses
// (further than SIDE from the sidewalk's middle), and none below the sidewalk. So from the artist's eye no shaft lies
// in front of the drawing or the real thing, and the swap between the two stays invisible however the overlay meets
// the scene's depth there.
const STOP = -12;
const SIDE = 3.4;

// Where each shaft crosses the canopy (x, y, z) and its half width.
const SHAFTS: [number, number, number, number][] = [
  [-1.2, 9, -24, 0.9],
  [2.2, 10, -31, 1.3],
  [-3.6, 8.5, -38, 0.8],
  [0.8, 11, -46, 1.6],
  [3.4, 9.5, -55, 1.1],
  [-2.4, 10, -63, 1.4],
  [1.5, 8, -21, 0.6],
  [-5.5, 9, -50, 1.2],
  [4.2, 10.5, -40, 0.7],
  [-0.5, 9.5, -72, 1.8],
  // Nearer, out over the road and in front of the houses.
  [-7.5, 9, 3, 1.1],
  [-6, 10, -7, 1.4],
  [-9.5, 9.5, 13, 1.2],
  [-5.2, 8.5, -16, 0.9],
  [3.6, 9, -4, 0.8],
  [3.9, 10, 8, 1.0]
];

export function Shafts({ sun, colour }: { sun: THREE.Vector3; colour: THREE.Color }) {
  const parts = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    // Each shaft runs from high up toward the sun down to where it meets the sidewalk.
    const way = sun.clone().negate().normalize();
    const starts = new Float32Array(SHAFTS.length * 4);
    const lengths = new Float32Array(SHAFTS.length);
    SHAFTS.forEach(([x, y, z, w], i) => {
      const top = new THREE.Vector3(x, y, z).addScaledVector(way, -14);
      starts.set([top.x, top.y, top.z, w], i * 4);
      lengths[i] = y / -way.y + 14;
    });
    quad.setAttribute("aStart", new THREE.InstancedBufferAttribute(starts, 4));
    quad.setAttribute("aLength", new THREE.InstancedBufferAttribute(lengths, 1));
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    material.colorNode = vec4(0, 0, 0, 0);
    const mesh = new THREE.InstancedMesh(quad, material, SHAFTS.length);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < SHAFTS.length; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { quad, material, mesh, way };
  }, [sun]);
  useDispose(parts.quad, parts.material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const start = attribute("aStart", "vec4") as any;
        const length = attribute("aLength", "float") as any;
        const axis = vec3(parts.way.x, parts.way.y, parts.way.z) as any;
        // A long quad along the light, turned about its length to face the eye.
        const centre = start.xyz.add(axis.mul(positionGeometry.y.mul(length))) as any;
        const toEye = normalize(cameraPosition.sub(centre)) as any;
        const right = normalize(cross(axis, toEye).add(vec3(1e-4, 0, 0))) as any;
        const world = centre.add(right.mul(positionGeometry.x.mul(start.w.mul(2)))) as any;
        parts.material.positionNode = world;
        const at = varying(world) as any;
        const across = uv().x.sub(0.5).mul(2) as any;
        const along = uv().y as any;
        // A soft bell across that reaches nothing before the quad's edge, fading in high up and out near the ground.
        const bell = exp(across.mul(across).mul(-5)) as any;
        const ends = smoothstep(0, 0.35, along).mul(float(1).sub(smoothstep(0.75, 1, along))) as any;
        // Seen along its length its sides would show as hard bands: fade it the more nearly the eye looks along it.
        const view = normalize(at.sub(cameraPosition)) as any;
        const sideOn = float(1).sub(dot(view, axis).abs().pow(6)) as any;
        // Softly cut where it meets the scene, so it never shows in front of what is nearer.
        const soft = smoothstep(0, 3, positionView.z.sub(sceneZ)) as any;
        // Kept clear of the drawing and the ground.
        const away = smoothstep(STOP + 3, STOP - 3, at.z).max(smoothstep(SIDE, SIDE + 1.5, at.x.abs())).mul(smoothstep(0, 1.5, at.y)) as any;
        // Broken up a little along its length, as light through leaves is.
        const dapple = mx_noise_float(at.mul(0.6)).mul(0.35).add(0.75) as any;
        const strength = bell.mul(ends).mul(sideOn).mul(soft).mul(away).mul(dapple).mul(0.7) as any;
        parts.material.colorNode = vec4(vec3(colour.r, colour.g, colour.b).mul(strength), 1) as any;
        parts.material.needsUpdate = true;
      }),
    [parts, colour]
  );

  return <primitive object={parts.mesh} />;
}
