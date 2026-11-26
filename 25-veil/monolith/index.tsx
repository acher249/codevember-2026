"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { useDispose } from "../../shared/engine/dispose";
import { PhotoLight, Sand, stone, useAir, Watchers, World, world, type Seat } from "../worlds/common";

// Veil before the monolith: pale open desert under a bright overcast, and far behind the figures a vast dark slab of
// stone standing out of the sand, so tall the dust half takes it, leaning a little as if set there long ago.

const KEY = new THREE.Vector3(-0.6, 0.75, 0.5).normalize();
const SEATS: Seat[] = [
  [0, 0, 0, true],
  [-2.6, -2.4, 0.3],
  [2.4, -3.2, -0.25],
  [-0.9, -6, 0.1],
  [3.6, -7.5, -0.4],
  [-4.2, -7, 0.45]
];

// Low swells far off, flat where they sit.
const height = (x: number, z: number) => {
  const reach = Math.min(1, Math.hypot(x, z + 4) / 30);
  return (Math.sin(x * 0.11 + z * 0.07) * 0.6 + Math.sin(x * 0.05 - z * 0.13) * 0.4) * reach * reach * 3;
};

function Slab() {
  const parts = useMemo(() => {
    const rock = stone([0.16, 0.15, 0.14], 0.15, 0.02, 0.15);
    const geometry = new THREE.BoxGeometry(34, 90, 5);
    const mesh = new THREE.Mesh(geometry, rock);
    mesh.position.set(8, 40, -95);
    mesh.rotation.set(0.04, -0.25, 0.03);
    mesh.castShadow = true;
    return { rock, geometry, mesh };
  }, []);
  useDispose(parts.rock, parts.geometry);
  return <primitive object={parts.mesh} />;
}

function Scene() {
  useAir("#d6cec3", 15, 160);
  return (
    <World>
      {(data) => (
        <>
          <PhotoLight keyDir={KEY} intensity={1.3} hemi={["#ffffff", "#cfc4b4", 0.55]} ambient="#bdb5aa" shadow={5} />
          <Sand size={400} segments={360} height={height} />
          <Slab />
          <Watchers data={data} seats={SEATS} keyDir={KEY} groundAt={height} />
        </>
      )}
    </World>
  );
}

export default world(Scene, { background: "#d6cec3" }, "Veiled figures seated in pale open desert, a vast dark slab of stone standing far behind them in the dust.", { target: [0, 2.2, -4] });
