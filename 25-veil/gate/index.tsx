"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { vec3 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { PhotoLight, Sand, stone, useAir, Watchers, World, world, type Seat } from "../worlds/common";

// Veil at the gate: a sheer cliff of dark stone across the whole view, cut through by one doorway many storeys tall, and
// the day beyond it pouring in; the figures sit in rows on the sand before it, the light from the door behind them.

const KEY = new THREE.Vector3(-0.45, 0.75, 0.5).normalize();
const SEATS: Seat[] = [
  [0, 0, 0, true],
  [-2.3, -1.6, 0.2],
  [2.3, -1.9, -0.2],
  [-1.2, -4.6, 0.1],
  [1.4, -5, -0.1],
  [-3.8, -5.4, 0.3],
  [3.9, -5.8, -0.3]
];

function Cliff() {
  const parts = useMemo(() => {
    const rock = stone([0.32, 0.29, 0.26], 0.12, 0.02, 0.2);
    const glow = new THREE.MeshBasicNodeMaterial({ fog: false });
    glow.colorNode = vec3(1.4, 1.32, 1.18);
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    // The cliff, in three blocks round the doorway: left, right, and over it.
    const W = 9;
    const H = 34;
    const side = new THREE.BoxGeometry(80, 90, 12);
    const lintel = new THREE.BoxGeometry(W, 90 - H, 12);
    const door = new THREE.PlaneGeometry(W, H);
    geometries.push(side, lintel, door);
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(side, rock);
      m.position.set(s * (40 + W / 2), 45, -32);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
    const top = new THREE.Mesh(lintel, rock);
    top.position.set(0, H + (90 - H) / 2, -32);
    top.castShadow = top.receiveShadow = true;
    group.add(top);
    // The day beyond the door, bright.
    const light = new THREE.Mesh(door, glow);
    light.position.set(0, H / 2, -40);
    group.add(light);
    return { rock, glow, geometries, group };
  }, []);
  useDispose(parts.rock, parts.glow, ...parts.geometries);
  return <primitive object={parts.group} />;
}

function Scene() {
  useAir("#a99c8c", 10, 80);
  return (
    <World>
      {(data) => (
        <>
          <PhotoLight keyDir={KEY} intensity={1.3} hemi={["#f4ece0", "#8a7c6a", 0.45]} ambient="#a39888" shadow={5} />
          <Sand color={[0.7, 0.62, 0.52]} />
          <Cliff />
          <Watchers data={data} seats={SEATS} keyDir={KEY} />
        </>
      )}
    </World>
  );
}

export default world(Scene, { background: "#a99c8c", bloom: 0.15, bloomThreshold: 0.9 }, "Veiled figures seated in rows before a doorway many storeys tall cut through a cliff of dark stone, the day pouring in behind them.", { target: [0, 3, -6] });
