"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  color as tslColor,
  dot,
  float,
  max,
  mix,
  mx_fractal_noise_float,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  time,
  uniform,
  vec2,
  vec3
} from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

export type SkyPalette = {
  zenith: string;
  horizon: string;
  sun: string;
  cloudLit: string;
  cloudShade: string;
  sunDirection: [number, number, number];
  cloudCover?: number;
  // How fast the clouds cross the sky. Most days keep them slow enough to read as still.
  cloudDrift?: number;
};

// A painted sky on a dome: a gradient, a sun, and clouds in perspective. Everything is a uniform,
// so moving between palettes never recompiles. Returns the colour node for reuse in reflections.
export function createSky() {
  const uniforms = {
    zenith: uniform(new THREE.Color()),
    horizon: uniform(new THREE.Color()),
    sun: uniform(new THREE.Color()),
    cloudLit: uniform(new THREE.Color()),
    cloudShade: uniform(new THREE.Color()),
    sunDirection: uniform(new THREE.Vector3(0, 1, 0)),
    cloudCover: uniform(0.5),
    cloudDrift: uniform(0.012)
  };

  const paint = (direction: any) => {
    const y = direction.y as any;
    const gradient = mix(uniforms.horizon, uniforms.zenith, pow(max(y, float(0)), float(0.55)));
    const towardSun = max(dot(direction, uniforms.sunDirection), float(0)) as any;
    const glow = uniforms.sun.mul(pow(towardSun, float(3200)).mul(16).add(pow(towardSun, float(9)).mul(0.28)));

    const flat = direction.xz.div(max(y, float(0.02)).add(0.2)).mul(1.1).add(vec2(time.mul(uniforms.cloudDrift), time.mul(uniforms.cloudDrift).mul(0.33))) as any;
    const noise = mx_fractal_noise_float(vec3(flat.x, time.mul(0.006), flat.y), 5, 2, 0.5, 1) as any;
    const toward = mx_fractal_noise_float(vec3(flat.x.add(uniforms.sunDirection.x.mul(0.18)), time.mul(0.006), flat.y.add(uniforms.sunDirection.z.mul(0.18))), 3, 2, 0.5, 1) as any;
    const edge = float(0.42).sub(uniforms.cloudCover.mul(0.5)) as any;
    const density = smoothstep(edge, edge.add(0.34), noise).mul(smoothstep(0.015, 0.14, y)) as any;
    const cloud = mix(uniforms.cloudLit, uniforms.cloudShade, smoothstep(-0.12, 0.2, toward.sub(noise).mul(-1).add(0.04)));
    return mix(gradient.add(glow), cloud, density.mul(0.94));
  };

  const setPalette = (palette: SkyPalette) => {
    uniforms.zenith.value.set(palette.zenith);
    uniforms.horizon.value.set(palette.horizon);
    uniforms.sun.value.set(palette.sun);
    uniforms.cloudLit.value.set(palette.cloudLit);
    uniforms.cloudShade.value.set(palette.cloudShade);
    uniforms.sunDirection.value.set(...palette.sunDirection).normalize();
    uniforms.cloudCover.value = palette.cloudCover ?? 0.5;
    uniforms.cloudDrift.value = palette.cloudDrift ?? 0.012;
  };

  return { uniforms, paint, setPalette };
}

export function SkyDome({ palette, radius = 100 }: { palette: SkyPalette; radius?: number }) {
  const sky = useMemo(() => createSky(), []);
  const material = useMemo(() => {
    const dome = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    dome.colorNode = sky.paint(normalize(positionWorld)) as any;
    return dome;
  }, [sky]);

  useEffect(() => sky.setPalette(palette), [sky, palette]);
  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh material={material} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[radius, 48, 32]} />
    </mesh>
  );
}

const BIRD_SEPARATION = 0.9;
const BIRD_NEIGHBOURS = 3.2;

// Flocks wheeling over a wide area. Craig Reynolds' boids on the CPU, one instanced draw, flapping in the vertex shader.
// Each bird only heeds those near it, so a big count breaks into groups instead of a single ring.
export function Birds({
  count = 26,
  centre = [0, 8, 0],
  spread = 13,
  color = "#14161c",
  size = 0.22,
  groupSize = 14,
  separation = BIRD_SEPARATION
}: {
  count?: number;
  centre?: [number, number, number];
  spread?: number;
  color?: string;
  size?: number;
  groupSize?: number;
  separation?: number;
}) {
  const flock = useMemo(() => {
    const position = new Float32Array(count * 3);
    const velocity = new Float32Array(count * 3);
    const hash = (n: number) => {
      const v = Math.sin(n * 12.9898) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let i = 0; i < count; i++) {
      const group = i % Math.max(1, Math.ceil(count / groupSize));
      const angle = hash(group + 1) * Math.PI * 2;
      const reach = Math.sqrt(hash(group + 40)) * spread;
      position[i * 3] = centre[0] + Math.cos(angle) * reach + (hash(i + 7) - 0.5) * 2.4;
      position[i * 3 + 1] = centre[1] + (hash(group + 90) - 0.5) * 3 + (hash(i + 11) - 0.5) * 0.8;
      position[i * 3 + 2] = centre[2] + Math.sin(angle) * reach + (hash(i + 13) - 0.5) * 2.4;
      velocity[i * 3] = Math.cos(angle + 1.6) * 2.4;
      velocity[i * 3 + 2] = Math.sin(angle + 1.6) * 2.4;
    }
    return { position, velocity, clock: 0 };
  }, [count, centre, spread, groupSize]);

  const mesh = useMemo(() => {
    // Swept wings out along X, a body and a tail, with the beak along -Z.
    const geometry = new THREE.BufferGeometry();
    const shape = [
      [0, 0, -0.34, 0, 0, 0.18, -0.55, 0, 0.02],
      [0, 0, -0.34, 0.55, 0, 0.02, 0, 0, 0.18],
      [-0.55, 0, 0.02, 0, 0, 0.18, -1.15, 0, 0.3],
      [0.55, 0, 0.02, 1.15, 0, 0.3, 0, 0, 0.18],
      [-0.06, 0.03, -0.6, 0.06, 0.03, -0.6, 0, 0.03, 0.42],
      [0, 0, 0.3, 0.2, 0, 0.72, -0.2, 0, 0.72]
    ].flat();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(shape), 3));
    geometry.computeVertexNormals();
    const phases = new Float32Array(count);
    for (let i = 0; i < count; i++) phases[i] = (i * 2.399) % 6.283;
    geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));

    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    material.colorNode = tslColor(color);
    const flap = sin(time.mul(11).add(attribute("aPhase", "float"))).mul(abs(positionGeometry.x)).mul(0.55) as any;
    material.positionNode = positionLocal.add(vec3(0, flap.mul(size), 0));

    const instanced = new THREE.InstancedMesh(geometry, material, count);
    instanced.frustumCulled = false;
    return instanced;
  }, [count, color, size]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    },
    [mesh]
  );

  const scratch = useMemo(() => ({ matrix: new THREE.Matrix4(), from: new THREE.Vector3(), to: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), scale: new THREE.Vector3(size, size, size) }), [size]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const { position, velocity } = flock;
    flock.clock += delta;
    for (let i = 0; i < count; i++) {
      const a = i * 3;
      let ax = 0;
      let ay = 0;
      let az = 0;
      let mx = 0;
      let my = 0;
      let mz = 0;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let others = 0;
      for (let j = 0; j < count; j++) {
        if (j === i) continue;
        const b = j * 3;
        const dx = position[b] - position[a];
        const dy = position[b + 1] - position[a + 1];
        const dz = position[b + 2] - position[a + 2];
        const squared = dx * dx + dy * dy + dz * dz;
        if (squared > BIRD_NEIGHBOURS * BIRD_NEIGHBOURS) continue;
        others++;
        mx += velocity[b];
        my += velocity[b + 1];
        mz += velocity[b + 2];
        cx += dx;
        cy += dy;
        cz += dz;
        if (squared < separation * separation && squared > 1e-4) {
          ax -= dx / squared;
          ay -= dy / squared;
          az -= dz / squared;
        }
      }
      if (others) {
        ax += (mx / others - velocity[a]) * 0.7 + (cx / others) * 0.28;
        ay += (my / others - velocity[a + 1]) * 0.7 + (cy / others) * 0.28;
        az += (mz / others - velocity[a + 2]) * 0.7 + (cz / others) * 0.28;
      }

      // Free to roam anywhere inside the spread, then a firm turn home. A slow drift keeps each group moving.
      const hx = centre[0] - position[a];
      const hy = centre[1] - position[a + 1];
      const hz = centre[2] - position[a + 2];
      const out = Math.max(0, Math.hypot(hx, hz) - spread);
      ax += hx * out * 0.05 + Math.sin(flock.clock * 0.13 + i * 0.07) * 0.5;
      ay += hy * 0.35;
      az += hz * out * 0.05 + Math.cos(flock.clock * 0.11 + i * 0.05) * 0.5;

      velocity[a] += ax * delta;
      velocity[a + 1] += ay * delta;
      velocity[a + 2] += az * delta;
      const speed = Math.hypot(velocity[a], velocity[a + 1], velocity[a + 2]) || 1;
      const clamped = Math.min(3.6, Math.max(1.8, speed)) / speed;
      velocity[a] *= clamped;
      velocity[a + 1] *= clamped;
      velocity[a + 2] *= clamped;
      position[a] += velocity[a] * delta;
      position[a + 1] += velocity[a + 1] * delta;
      position[a + 2] += velocity[a + 2] * delta;

      scratch.from.set(position[a], position[a + 1], position[a + 2]);
      scratch.to.set(position[a] + velocity[a], position[a + 1] + velocity[a + 1], position[a + 2] + velocity[a + 2]);
      scratch.matrix.lookAt(scratch.from, scratch.to, scratch.up);
      scratch.matrix.scale(scratch.scale);
      scratch.matrix.setPosition(scratch.from);
      mesh.setMatrixAt(i, scratch.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <primitive object={mesh} />;
}
