"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { useDispose } from "../../shared/engine/dispose";
import { PhotoLight, Sand, stone, useAir, Watchers, World, world, type Seat } from "../worlds/common";

// Veil on the terraces: giant steps of sandstone, each taller than a man, rising away behind the figures into the haze,
// and at the top, barely there, the flank of something enormous. The figures sit along the lowest terrace.

const KEY = new THREE.Vector3(0.55, 0.8, 0.45).normalize();
const SEATS: Seat[] = [
  [0, 0, 0, true],
  [-2.4, -1.2, 0.25],
  [2.5, -1.5, -0.25],
  [-4.8, -2, 0.4],
  [4.6, -2.4, -0.4]
];

function Steps() {
  const parts = useMemo(() => {
    const rock = stone([0.7, 0.6, 0.48], 0.1, 0.03, 0.25);
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 16; k++) {
      const g = new THREE.BoxGeometry(80, 2.2, 5);
      geometries.push(g);
      const m = new THREE.Mesh(g, rock);
      m.position.set(0, 1.1 + k * 2.2 - 2.2, -6 - k * 5);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
    // What stands above them: a sheer battered wall going up into the haze.
    const top = new THREE.BoxGeometry(60, 60, 20);
    geometries.push(top);
    const crown = new THREE.Mesh(top, rock);
    crown.position.set(0, 60, -96);
    crown.rotation.x = -0.08;
    group.add(crown);
    return { rock, geometries, group };
  }, []);
  useDispose(parts.rock, ...parts.geometries);
  return <primitive object={parts.group} />;
}

function Scene() {
  useAir("#cbbfae", 10, 110);
  return (
    <World>
      {(data) => (
        <>
          <PhotoLight keyDir={KEY} intensity={1.4} hemi={["#fffaf2", "#bfae96", 0.5]} ambient="#b3a796" shadow={5} />
          <Sand color={[0.74, 0.65, 0.53]} />
          <Steps />
          <Watchers data={data} seats={SEATS} keyDir={KEY} />
        </>
      )}
    </World>
  );
}

export default world(Scene, { background: "#cbbfae" }, "Veiled figures seated along the foot of giant sandstone terraces that rise behind them into the haze.", { target: [0, 2.6, -4] });
