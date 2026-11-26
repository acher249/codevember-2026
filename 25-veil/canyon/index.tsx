"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { useDispose } from "../../shared/engine/dispose";
import { PhotoLight, Sand, stone, useAir, Watchers, World, world, type Seat } from "../worlds/common";

// Veil in the canyon: a narrow gorge between sheer walls of banded rock, cut straight as if quarried, the sky a bright
// strip far overhead; its light comes down soft off the walls onto the figures seated along the sand of its floor.

const KEY = new THREE.Vector3(-0.25, 1, 0.15).normalize();
const SEATS: Seat[] = [
  [0, 0, 0, true],
  [-1.6, -3, 0.2],
  [1.5, -5.5, -0.2],
  [-1.2, -9, 0.15],
  [1.3, -12.5, -0.1]
];

// A wall of the gorge: a tall sheet, its face carved with horizontal bands and a slow wander along its length.
function wall(side: number) {
  const g = new THREE.PlaneGeometry(140, 70, 280, 140);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) {
    const u = pos.getX(k);
    const v = pos.getY(k);
    const band = Math.sin(v * 1.9) * 0.18 + Math.sin(v * 0.43 + 1) * 0.35 + Math.sin(v * 5.3) * 0.05;
    const wander = Math.sin(u * 0.05) * 2 + Math.sin(u * 0.13 + side) * 0.7;
    pos.setXYZ(k, side * (5 + wander + band), v + 35, u - 40);
  }
  g.computeVertexNormals();
  return g;
}

function Gorge() {
  const parts = useMemo(() => {
    const rock = stone([0.66, 0.53, 0.42], 0.14, 0.03, 0.2);
    rock.side = THREE.DoubleSide;
    const geometries = [wall(-1), wall(1)];
    const group = new THREE.Group();
    for (const g of geometries) {
      const m = new THREE.Mesh(g, rock);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
    return { rock, geometries, group };
  }, []);
  useDispose(parts.rock, ...parts.geometries);
  return <primitive object={parts.group} />;
}

function Scene() {
  useAir("#c7b7a3", 8, 90);
  return (
    <World>
      {(data) => (
        <>
          <PhotoLight keyDir={KEY} intensity={1.3} hemi={["#fff4e6", "#a8896a", 0.6]} ambient="#b09d88" shadow={4} />
          <Sand color={[0.75, 0.64, 0.52]} />
          <Gorge />
          <Watchers data={data} seats={SEATS} keyDir={KEY} />
        </>
      )}
    </World>
  );
}

export default world(Scene, { background: "#c7b7a3" }, "Veiled figures seated along the floor of a narrow gorge, light coming down soft off its sheer banded walls.", { target: [0, 2.2, -5] });
