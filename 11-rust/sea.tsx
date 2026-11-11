"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { cameraPosition, float, length, positionWorld, smoothstep, texture3D, uniform, vec3 } from "three/tsl";
import * as THREE from "three/webgpu";
import { useQuality } from "../shared/engine/quality";
import { bakeField } from "../07-hollow/field";
import { buildWaves, oceanMaterial, polarGrid } from "../07-hollow/ocean";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Hollow's sea, from its shoreline out to the horizon. The water there keeps clear of a peach, so here the peach is put a
// long way off. The sea starts `shore` units out along -z, its edge wandering, and thins out with distance so the scanned
// sea behind it takes over.
export function Sea({ shore, level = 0, fade = [60, 260] }: { shore: number; level?: number; fade?: [number, number] }) {
  const tier = useQuality().tier;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((state) => state.scene);
  const field = useMemo(() => bakeField(tier === "low" ? 64 : 96), [tier]);
  const time = useMemo(() => uniform(0), []);
  const follow = useMemo(() => uniform(new THREE.Vector2()), []);
  const gridScale = useMemo(() => uniform(1), []);
  const sea = useMemo(() => buildWaves({ size: tier === "low" ? 128 : 256, lengths: tier === "low" ? [96, 15] : [120, 26], wind: 4, fetchKm: 60, direction: 0.4, height: 0.22 }, time), [tier, time]);
  const grid = useMemo(() => polarGrid(tier === "low" ? 110 : 150, tier === "low" ? 150 : 240), [tier]);
  const [fadeFrom, fadeTo] = fade;
  const material = useMemo(() => {
    const water = oceanMaterial(false, {
      resolutionScale: tier === "high" ? 0.5 : tier === "medium" ? 0.38 : 0.26,
      cascades: sea.cascades,
      peachInverse: uniform(new THREE.Matrix4().makeTranslation(0, 0, -1e4)),
      bladeNormal: uniform(new THREE.Vector3(0, 1, 0)),
      bladeDepth: uniform(0),
      time,
      noise: field,
      impacts: [],
      gridScale,
      follow
    });
    const wander = (texture3D(field, vec3(positionWorld.x.mul(0.06), float(0.3), time.mul(0.03))) as any).g.sub(0.5).mul(2.4);
    const past = (positionWorld.z as any).negate().sub(shore).add(wander) as any;
    const dist = length(cameraPosition.sub(positionWorld)) as any;
    water.maskNode = past.greaterThan(0);
    water.opacityNode = (water.opacityNode as any).mul(smoothstep(0, 1.6, past)).mul(float(1).sub(smoothstep(fadeFrom, fadeTo, dist)));
    return water;
  }, [sea, field, time, gridScale, follow, tier, shore, fadeFrom, fadeTo]);

  // The mirror takes its plane from this, which only works from inside the scene.
  useEffect(() => {
    const target = material.userData.mirror.target;
    target.position.y = level;
    scene.add(target);
    return () => {
      scene.remove(target);
    };
  }, [scene, material, level]);
  useEffect(
    () => () => {
      material.dispose();
      grid.dispose();
      field.dispose();
      sea.textures.forEach((item) => item.dispose());
    },
    [material, grid, field, sea]
  );

  useFrame(({ camera }, delta) => {
    time.value += Math.min(delta, 0.05);
    gl.compute(sea.computes);
    follow.value.set(camera.position.x, camera.position.z);
    // The mirror's camera copies the view's layers, so it has to be told again each frame to leave out what is not reflected.
    material.userData.mirror.reflector.getVirtualCamera(camera).layers.set(0);
  });

  return <mesh geometry={grid} material={material} position-y={level} frustumCulled={false} renderOrder={1} />;
}
