"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  color as tslColor,
  float,
  mix,
  positionWorld,
  screenCoordinate,
  smoothstep,
  time,
  uniform,
  vec3,
  length as tslLength,
  output,
  sin,
  vec4
} from "three/tsl";
import { bayer16 } from "three/addons/tsl/math/Bayer.js";
import { HAZE_LAYER, hazeLink } from "./Post";
import { useQuality } from "./quality";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

type SoftBox = { position: [number, number, number]; scale: [number, number, number]; color: string; intensity: number };

// Image-based light from a small procedural studio, so premium materials have something to reflect.
export function StudioEnvironment({ boxes, ambient = "#101218", intensity = 1 }: { boxes: SoftBox[]; ambient?: string; intensity?: number }) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    let target: THREE.RenderTarget | null = null;
    const room = new THREE.Scene();
    room.background = new THREE.Color(ambient);
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const materials = boxes.map((box) => {
      const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(box.color).multiplyScalar(box.intensity) });
      const mesh = new THREE.Mesh(unit, material);
      mesh.position.set(...box.position);
      mesh.scale.set(...box.scale);
      room.add(mesh);
      return material;
    });

    const generator = new THREE.PMREMGenerator(gl as any);
    // The renderer has finished init by the time a scene mounts, so this runs synchronously.
    target = generator.fromScene(room, 0.02);
    scene.environment = target.texture;
    scene.environmentIntensity = intensity;

    return () => {
      scene.environment = null;
      target?.dispose();
      generator.dispose();
      unit.dispose();
      materials.forEach((material) => material.dispose());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene]);

  return null;
}

// A soft-shadowed spot that also lights the haze.
export function KeyLight({
  position,
  target = [0, 0, 0],
  color = "#ffffff",
  intensity = 300,
  angle = 0.45,
  penumbra = 0.8,
  shadowSize,
  shadowFar = 40
}: {
  position: [number, number, number];
  target?: [number, number, number];
  color?: string;
  intensity?: number;
  angle?: number;
  penumbra?: number;
  shadowSize?: number;
  shadowFar?: number;
}) {
  const { tier } = useQuality();
  const light = useMemo(() => {
    const spot = new THREE.SpotLight(color, intensity, 0, angle, penumbra, 2);
    spot.castShadow = true;
    spot.shadow.bias = -0.0004;
    spot.shadow.normalBias = 0.015;
    spot.shadow.radius = 3;
    spot.shadow.camera.near = 0.5;
    spot.shadow.camera.far = shadowFar;
    spot.layers.enable(HAZE_LAYER);
    return spot;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    light.position.set(...position);
    light.target.position.set(...target);
    light.target.updateMatrixWorld();
    light.color.set(color);
    light.intensity = intensity;
    light.angle = angle;
    light.penumbra = penumbra;
  });

  useEffect(() => {
    const size = shadowSize ?? (tier === "low" ? 1024 : 2048);
    light.shadow.mapSize.set(size, size);
    light.shadow.map?.dispose();
    light.shadow.map = null;
  }, [light, shadowSize, tier]);

  useEffect(() => () => light.dispose(), [light]);

  return (
    <>
      <primitive object={light} />
      <primitive object={light.target} />
    </>
  );
}

// Light you can see: a box of drifting fog, raymarched at low resolution by the post stack.
// Only the lights that opted in with the haze layer scatter in it, and shadows carve shafts through it.
export function Haze({
  size = [24, 12, 24],
  position = [0, 3, 0],
  density = 1
}: {
  size?: [number, number, number];
  position?: [number, number, number];
  density?: number;
}) {
  const { tier } = useQuality();
  const amount = useMemo(() => uniform(density), []); // eslint-disable-line react-hooks/exhaustive-deps

  const material = useMemo(() => {
    const volume = new THREE.VolumeNodeMaterial() as any;
    volume.steps = tier === "high" ? 16 : 10;
    volume.offsetNode = bayer16(screenCoordinate);
    volume.scatteringNode = Fn(({ positionRay }: any) => {
      // Cheap procedural billows. A 3D texture would add detail, but this is what runs on every sample.
      const p = positionRay.add(vec3(time.mul(0.05), time.mul(0.02), time.mul(-0.03)));
      const billow = sin(p.x.mul(1.3).add(sin(p.y.mul(0.9).add(p.z.mul(0.7)))))
        .mul(sin(p.z.mul(1.1).add(sin(p.x.mul(0.8)))))
        .mul(0.5)
        .add(0.5);
      return float(amount).mul(0.22).mul(billow.mul(0.8).add(0.2));
    });
    return volume;
  }, [amount, tier]);

  useEffect(() => {
    amount.value = density;
  }, [amount, density]);

  useEffect(() => {
    hazeLink.add(material);
    return () => {
      hazeLink.remove(material);
      material.dispose();
    };
  }, [material]);

  if (tier === "low") return null;

  return (
    <mesh
      position={position}
      material={material}
      receiveShadow
      onUpdate={(mesh) => {
        mesh.layers.disableAll();
        mesh.layers.enable(HAZE_LAYER);
      }}
    >
      <boxGeometry args={size} />
    </mesh>
  );
}

// A large floor that melts into the background colour, so the set has no visible edge.
export function StudioFloor({
  y = 0,
  color = "#15171c",
  background = "#0a0b0e",
  roughness = 0.42,
  metalness = 0,
  radius = 16
}: {
  y?: number;
  color?: string;
  background?: string;
  roughness?: number;
  metalness?: number;
  radius?: number;
}) {
  const material = useMemo(() => {
    const floor = new THREE.MeshStandardNodeMaterial({ roughness, metalness });
    const distance = tslLength(positionWorld.xz);
    floor.colorNode = tslColor(color);
    // Fading the lit result, not opacity, keeps the floor in the depth and shadow passes.
    floor.outputNode = mix(output, vec4(tslColor(background), 1), smoothstep(radius * 0.45, radius, distance)) as any;
    return floor;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} receiveShadow material={material}>
      <circleGeometry args={[radius * 3, 96]} />
    </mesh>
  );
}
