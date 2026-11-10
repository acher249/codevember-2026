"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { color, length, mix, mx_noise_float, normalize, output, positionWorld, pow, smoothstep, vec4 } from "three/tsl";
import { causticLight } from "./light";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The room: a great sphere shaded by height, dark below and a little lighter above.
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

// A floor that takes the caustics, with a little grain so it reads as a surface, fading into the room at its edge.
export function Floor({ albedo, background, grain = 0.12, roughness = 0.8, radius = 12, y = 0 }: { albedo: string; background: string; grain?: number; roughness?: number; radius?: number; y?: number }) {
  const material = useMemo(() => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0 });
    const speck = mx_noise_float(positionWorld.xz.mul(140)).mul(0.5).add(mx_noise_float(positionWorld.xz.mul(9)).mul(0.5)) as any;
    const base = color(albedo).mul(speck.mul(grain).add(1)) as any;
    m.colorNode = base;
    m.emissiveNode = causticLight(base);
    m.outputNode = mix(output, vec4(color(background), 1), smoothstep(radius * 0.4, radius, length(positionWorld.xz))) as any;
    return m;
  }, [albedo, background, grain, roughness, radius]);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} receiveShadow material={material}>
      <circleGeometry args={[radius * 3, 96]} />
    </mesh>
  );
}

// Water or solid glass that refracts what is behind it.
export function clearMaterial({ ior, tint = "#ffffff", depth = 2, thickness = 0.4, roughness = 0.02, dispersion = 0 }: { ior: number; tint?: string; depth?: number; thickness?: number; roughness?: number; dispersion?: number }) {
  const m = new THREE.MeshPhysicalNodeMaterial({
    color: "#ffffff",
    roughness,
    metalness: 0,
    transmission: 1,
    ior,
    thickness,
    attenuationColor: new THREE.Color(tint),
    attenuationDistance: depth,
    dispersion,
    specularIntensity: 1
  });
  // A sheet of water faces the sun, and shadows are drawn from back faces unless told otherwise.
  m.shadowSide = THREE.DoubleSide;
  return m;
}
