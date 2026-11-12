"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { color, length, mix, mx_noise_float, normalize, output, positionWorld, pow, smoothstep, vec2, vec4 } from "three/tsl";
import { focusBlur, focusDistance } from "../shared/engine/Post";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What the lens is focused on, set by whichever study is out each frame.
export const focus = { point: new THREE.Vector3(0, 1, 0), blur: 1.2 };

export function Focus() {
  const camera = useThree((state) => state.camera);
  useFrame(() => {
    focusDistance.value = Math.max(0.3, camera.position.distanceTo(focus.point));
    focusBlur.value = focus.blur;
  });
  return null;
}

// The room: a great sphere shaded by height.
export function Backdrop({ top, horizon, bottom }: { top: string; horizon: string; bottom: string }) {
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const up = (normalize(positionWorld) as any).y;
    m.colorNode = mix(mix(color(horizon), color(top), pow(smoothstep(-0.05, 0.9, up), 0.8)), color(bottom), smoothstep(0.05, -0.6, up));
    return m;
  }, [top, horizon, bottom]);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh material={material} renderOrder={-1} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[60, 48, 24]} />
    </mesh>
  );
}

// Old boards, worn smooth, fading into the room at the edge.
export function Boards({ albedo = "#2a2019", background, radius = 7, y = 0 }: { albedo?: string; background: string; radius?: number; y?: number }) {
  const material = useMemo(() => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 });
    const plank = positionWorld.x.mul(5.2) as any;
    const grain = mx_noise_float(positionWorld.xz.mul(vec2(60, 3))).mul(0.5).add(mx_noise_float(positionWorld.xz.mul(18)).mul(0.25)) as any;
    const seam = smoothstep(0.0, 0.03, plank.fract()).mul(smoothstep(1, 0.97, plank.fract())) as any;
    const tone = mx_noise_float(vec2(plank.floor().mul(1.7), 0)).mul(0.18).add(1) as any;
    m.colorNode = color(albedo).mul(grain.mul(0.35).add(0.85)).mul(tone).mul(seam.mul(0.5).add(0.5));
    m.roughnessNode = grain.mul(0.2).add(0.5) as any;
    m.outputNode = mix(output, vec4(color(background), 1), smoothstep(radius * 0.35, radius, length(positionWorld.xz))) as any;
    return m;
  }, [albedo, background, radius]);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} receiveShadow material={material}>
      <circleGeometry args={[radius * 3, 96]} />
    </mesh>
  );
}
