"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { max, normalMap, positionGeometry, positionLocal, positionWorld, sin, smoothstep, texture, time, uv, vec2, vec3 } from "three/tsl";
import type { MossAssets, Plant } from "./assets";
import { flatnessAt, poolAt, SHELF_V, surfaceAt, surfaceNormal } from "./cliff";
import { NOT_REFLECTED } from "./pools";
import { mulberry32 } from "../shared/engine/random";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

type Spot = { u: number; v: number; tilt: number };

// Where something can get a hold: behind the shelf, along its lip, on the ledge above, in the joints of the wall, and over the rim.
export function holdingSpot(rand: () => number, reach: number): Spot {
  const pick = rand();
  const u = -16 + Math.pow(rand(), 1.6) * reach;
  // The lip of the cliff above all: this is what the eye goes to.
  if (rand() < 0.42) return { u, v: SHELF_V - 3.3 + rand() * 0.9, tilt: 0.16 };
  if (pick < 0.3) return { u, v: SHELF_V + 1.7 + rand() * 1.2, tilt: 0.05 };
  if (pick < 0.46) return { u, v: SHELF_V - 3.1 + rand() * 0.8, tilt: 0.1 };
  if (pick < 0.62) return { u, v: 3.4 + rand() * 1.1, tilt: 0.08 };
  if (pick < 0.76) return { u, v: 10 + rand() * 2.4, tilt: 0.05 };
  if (pick < 0.9) return { u, v: -1 + rand() * 10, tilt: 0.34 };
  return { u, v: -38 + rand() * 30, tilt: 0.3 };
}

function scatter(plant: Plant, count: number, seed: number, size: [number, number], reach: number, tiltScale: number, clump: number) {
  const rand = mulberry32(seed);
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const up = new THREE.Vector3();
  const lean = new THREE.Quaternion();
  const spin = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 1, 0);
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();

  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.74, side: THREE.DoubleSide, alphaTest: 0.5 });
  const leaf = texture(plant.diffuse, uv()) as any;
  material.colorNode = leaf.rgb;
  // These scans hold their leaf shapes against black, in place of an alpha channel.
  material.opacityNode = smoothstep(0.015, 0.05, max(leaf.r, max(leaf.g, leaf.b))) as any;
  material.normalNode = normalMap(texture(plant.normal, uv()), vec2(1, 1)) as any;
  const height = positionGeometry.y as any;
  const sway = sin(time.mul(1.4).add(positionWorld.x.mul(0.9)).add(positionWorld.z.mul(0.7))).mul(height).mul(height).mul(0.012) as any;
  material.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.7)));

  return plant.scans.map((scan) => {
    const mesh = new THREE.InstancedMesh(scan.geometry, material, count);
    let bush: Spot = holdingSpot(rand, reach);
    for (let i = 0; i < count; i++) {
      // Plants come in clumps, and from here a clump is what reads as a bush.
      if (i % clump === 0) {
        bush = holdingSpot(rand, reach);
        for (let tries = 0; tries < 6 && (poolAt(bush.u, bush.v, 1.5) > 0 || (size[1] > 0.5 && bush.u < -7 && bush.v < 1)); tries++) bush = holdingSpot(rand, reach);
      }
      const spot = { u: bush.u + (rand() - 0.5) * clump * 0.14, v: bush.v + (rand() - 0.5) * clump * 0.1, tilt: bush.tilt };
      surfaceAt(spot.u, spot.v, point);
      surfaceNormal(spot.u, spot.v, normal, 0.25);
      up.set(0, 1, 0).lerp(normal, spot.tilt * tiltScale * (1 - flatnessAt(spot.u, spot.v) * 0.7)).normalize();
      lean.setFromUnitVectors(axis, up);
      spin.setFromAxisAngle(axis, rand() * 6.28);
      const wanted = size[0] + rand() * rand() * (size[1] - size[0]);
      scale.setScalar(wanted / Math.max(0.001, scan.size.y));
      // Sunk a little, so that the stems come out of the ground.
      matrix.compose(point.addScaledVector(up, -wanted * 0.04), lean.multiply(spin), scale);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.layers.set(NOT_REFLECTED);
    return mesh;
  });
}

// Real scanned ferns and weeds in every crack and along the shelf, and bigger clumps of them read as bushes from here.
export function Brush({ assets, density }: { assets: MossAssets; density: number }) {
  const meshes = useMemo(() => {
    const count = (n: number) => Math.max(2, Math.round(n * density));
    return [
      ...scatter(assets.fern, count(170), 1711, [0.32, 0.95], 90, 1, 11),
      ...scatter(assets.weed, count(70), 2719, [0.1, 0.34], 70, 1, 6),
      ...scatter(assets.sorrel, count(150), 3307, [0.07, 0.22], 50, 1, 8),
      ...scatter(assets.shrub, count(70), 4243, [0.28, 1], 70, 1, 4)
    ];
  }, [assets, density]);

  useEffect(
    () => () => {
      for (const mesh of meshes) {
        (mesh.material as THREE.Material).dispose();
        mesh.dispose();
      }
    },
    [meshes]
  );

  return (
    <>
      {meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
    </>
  );
}

