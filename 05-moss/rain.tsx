"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cameraFar, cameraNear, cameraPosition, cross, float, fract, length, max, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, screenUV, sin, smoothstep, step, time, vec2, vec3 } from "three/tsl";
import { OVERLAY_LAYER, overlayLink } from "../shared/engine/Post";
import { poolAt, SHELF_V, surfaceAt } from "./cliff";
import { mulberry32 } from "../shared/engine/random";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const BOX = 20;

// Solid things hide it, found by comparing against the depth of the finished scene.
function useHiddenBehindScene(material: THREE.MeshBasicNodeMaterial, opacity: any) {
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const scene = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        material.opacityNode = opacity.mul(step(scene, positionView.z)) as any;
        material.needsUpdate = true;
      }),
    [material, opacity]
  );
}

// Streaks at the speed real rain falls, soft at both ends, in a box that travels with the camera.
// They are thin but never thinner than a pixel can show, which is what stops them flickering.
export function Rain({ amount, count, strength }: { amount: { current: number }; count: number; strength: any }) {
  const { mesh, opacity } = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1);
    const rand = mulberry32(5381);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seed.set([rand(), rand(), rand(), rand()], i * 4);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 4));
    const material = new THREE.MeshBasicNodeMaterial({ color: "#c9d6dd", transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const at = attribute("aSeed", "vec4") as any;
    const speed = at.w.mul(2.4).add(7.2) as any;
    const fall = vec3(0.035, -1, 0.02) as any;
    const travelled = fall.mul(time.mul(speed).div(BOX)) as any;
    const wrapped = fract(at.xyz.add(travelled).sub(cameraPosition.div(BOX))).sub(0.5).mul(BOX) as any;
    const centre = cameraPosition.add(wrapped) as any;
    const toEye = cameraPosition.sub(centre) as any;
    const side = normalize(cross(fall, toEye)) as any;
    const away = length(toEye) as any;
    const width = max(away.mul(0.0011), float(0.0035)) as any;
    const long = at.w.mul(0.34).add(0.3) as any;
    material.positionNode = centre.add(normalize(fall).mul(positionGeometry.y.mul(long))).add(side.mul(positionGeometry.x.mul(width))) as any;
    const along = float(1).sub(positionGeometry.y.mul(2).abs()) as any;
    const near = smoothstep(1.2, 5, away) as any;
    const heavier = smoothstep(at.w.sub(0.06), at.w.add(0.06), strength.mul(1.25)) as any;
    const opacity = along.mul(near).mul(heavier).mul(0.26) as any;
    material.opacityNode = opacity;
    const instanced = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) instanced.setMatrixAt(i, identity);
    instanced.frustumCulled = false;
    instanced.layers.set(OVERLAY_LAYER);
    return { mesh: instanced, opacity };
  }, [count, strength]);
  useHiddenBehindScene(mesh.material as THREE.MeshBasicNodeMaterial, opacity);
  useFrame(() => {
    mesh.visible = amount.current > 0.01;
  });
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    },
    [mesh]
  );
  return <primitive object={mesh} />;
}

// Where each drop lands on the rock: a small crown of light, gone in a moment.
export function Splashes({ count, strength }: { count: number; strength: any }) {
  const { mesh, opacity } = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.rotateX(-Math.PI / 2);
    const rand = mulberry32(9973);
    const point = new THREE.Vector3();
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      let u = 0;
      let v = 0;
      for (let tries = 0; tries < 8; tries++) {
        u = -14 + rand() * 40;
        v = SHELF_V + (rand() - 0.5) * 5.6;
        if (poolAt(u, v, 1.1) === 0) break;
      }
      surfaceAt(u, v, point);
      seed.set([point.x, point.y + 0.03, point.z, rand()], i * 4);
    }
    quad.setAttribute("aSpot", new THREE.InstancedBufferAttribute(seed, 4));
    const material = new THREE.MeshBasicNodeMaterial({ color: "#dfe8ec", transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const at = attribute("aSpot", "vec4") as any;
    const age = fract(time.mul(0.9).add(at.w.mul(13))) as any;
    const size = age.mul(0.2).add(0.03) as any;
    const local = positionGeometry as any;
    material.positionNode = at.xyz.add(vec3(local.x.mul(size), 0, local.z.mul(size))) as any;
    const from = length(vec2(local.x, local.z).mul(2)) as any;
    const ring = smoothstep(0.62, 0.88, from).mul(smoothstep(1, 0.9, from)) as any;
    const gone = smoothstep(0.34, 0, age) as any;
    const raining = step(at.w, strength.mul(1.4)) as any;
    const opacity = ring.mul(gone).mul(raining).mul(0.34).mul(sin(age.mul(3.14)).add(0.2)) as any;
    material.opacityNode = opacity;
    const instanced = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) instanced.setMatrixAt(i, identity);
    instanced.frustumCulled = false;
    instanced.layers.set(OVERLAY_LAYER);
    return { mesh: instanced, opacity };
  }, [count, strength]);
  useHiddenBehindScene(mesh.material as THREE.MeshBasicNodeMaterial, opacity);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    },
    [mesh]
  );
  return <primitive object={mesh} />;
}
