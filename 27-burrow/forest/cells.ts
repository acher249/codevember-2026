import * as THREE from "three/webgpu";
import { mulberry32 } from "../../shared/engine/random";

// What the low growth's builders hand back: the meshes, and what to free when the day goes.
export type Made = {
  group: THREE.Group;
  disposables: { dispose(): void }[];
  counts?: Record<string, number>;
};

// Instances laid out in square cells of the floor, one mesh each, so the cells out of view are skipped, and those
// further than `reach` from the eye are hidden (index.tsx), where the trees and the haze hide them anyway. Sparse kinds
// take bigger cells (`cell`), so a few dozen mushrooms are not spread over twenty draws.
// `colours`: each instance's own colour (multiplying the material's), if given.
export function place(made: Made, geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[], shadows: boolean, reach = Infinity, colours?: THREE.Color[], cell = 14) {
  if (!matrices.length) return;
  const cells = new Map<string, number[]>();
  const at = new THREE.Vector3();
  matrices.forEach((m, i) => {
    at.setFromMatrixPosition(m);
    const key = `${Math.floor(at.x / cell)},${Math.floor(at.z / cell)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key)!.push(i);
  });
  for (const list of cells.values()) {
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    list.forEach((j, i) => {
      mesh.setMatrixAt(i, matrices[j]);
      if (colours) mesh.setColorAt(i, colours[j]);
    });
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    mesh.userData.reach = reach;
    made.group.add(mesh);
  }
}

// How much of each kind a tier draws.
export const tierShare = (tier: string) => (tier === "low" ? 0.25 : tier === "medium" ? 0.6 : 1);

// Points of a jittered grid over a box, one a cell, so a kind covers the floor evenly and the same every visit.
export function jitterGrid(seed: number, spacing: number, x0: number, x1: number, z0: number, z1: number, each: (x: number, z: number, rand: () => number) => void) {
  const rand = mulberry32(seed);
  for (let z = z0; z < z1; z += spacing) for (let x = x0; x < x1; x += spacing) each(x + rand() * spacing, z + rand() * spacing, rand);
}
