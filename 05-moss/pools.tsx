"use client";

import * as THREE from "three/webgpu";
import { cameraPosition, dot, float, floor, fract, length, max, normalize, positionWorld, pow, reflect, reflector, sin, smoothstep, step, time, vec2, vec3 } from "three/tsl";
import { createSky } from "../shared/engine/outdoors";
import { POOLS, poolLevel, surfaceAt } from "./cliff";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Each drop makes a ring. A grid of cells, each with its own spot and its own moment, gives a steady patter of them,
// and the harder it rains, the more of the cells are in use.
function rings(flat: any, rain: any, scale: number, rate: number, seed: number) {
  const p = flat.mul(scale).add(seed) as any;
  const cell = floor(p) as any;
  const f = fract(p) as any;
  const hashed = fract(sin(dot(cell, vec2(127.1, 311.7))).mul(43758.5453)) as any;
  const hashedB = fract(sin(dot(cell, vec2(269.5, 183.3))).mul(43758.5453)) as any;
  const away = f.sub(vec2(hashed.mul(0.6).add(0.2), hashedB.mul(0.6).add(0.2))) as any;
  const distance = length(away) as any;
  const age = fract(time.mul(rate).add(hashed.mul(7))) as any;
  const front = age.mul(0.5) as any;
  const gap = distance.sub(front) as any;
  const falling = step(hashedB, rain.mul(1.5)) as any;
  const ring = sin(gap.mul(48)).mul(smoothstep(0.1, 0, max(gap, gap.negate()))).mul(float(1).sub(age)).mul(falling) as any;
  return away.div(max(distance, float(0.001))).mul(ring);
}

// Drawn for the eye, but left out of reflections: what a pool would barely show, and what would cost the most to draw twice.
export const NOT_REFLECTED = 1;
// And the reverse: simple stand-ins for the fibres, which only the reflections see.
export const ONLY_REFLECTED = 3;

export type WaterLook = { tilt: any; fresnel: any; seen: any; target: THREE.Object3D | null; limit: (camera: THREE.Camera) => void };

// How water looks from here, for the pools and for the film on wet ground alike: the rain's rings disturb it,
// and at a glance almost all you see in it is what it reflects.
export function createWater(rain: any, sky: ReturnType<typeof createSky>, mirror: boolean): WaterLook {
  const flat = positionWorld.xz as any;
  const drops = rings(flat, rain, 4.6, 1.1, 0.3).add(rings(flat, rain, 7.3, 1.4, 7.1)) as any;
  const breeze = vec2(sin(flat.x.mul(9).add(time.mul(1.1)).add(sin(flat.y.mul(6)))), sin(flat.y.mul(11).sub(time.mul(0.9)))).mul(0.006) as any;
  const tilt = drops.mul(0.24).add(breeze) as any;
  const normal = normalize(vec3(tilt.x, 1, tilt.y)) as any;
  const toEye = normalize(cameraPosition.sub(positionWorld)) as any;
  const fresnel = float(0.1).add(pow(float(1).sub(max(dot(toEye, normal), float(0))), float(3.2)).mul(0.9)) as any;
  if (!mirror) return { tilt, fresnel, seen: sky.paint(normalize(reflect(toEye.negate(), normal))), target: null, limit: () => {} };
  const reflection = reflector({ resolutionScale: 0.45, bounces: false }) as any;
  reflection.uvNode = reflection.uvNode.add(tilt.mul(0.16));
  reflection.target.rotateX(-Math.PI / 2);
  const shelf = POOLS.filter((pool) => pool.v < 0);
  reflection.target.position.y = shelf.reduce((sum, pool) => sum + poolLevel(pool), 0) / shelf.length;
  return { tilt, fresnel, seen: reflection.rgb, target: reflection.target, limit: (camera) => {
      const seen = reflection.reflector.getVirtualCamera(camera).layers;
      seen.set(0);
      seen.enable(ONLY_REFLECTED);
    } };
}

// The pools, as geometry. The water material is shared with the film on wet ground, because the reflector hides only
// one material while it draws, and any other showing the reflection would be reading the image being drawn.
export function buildPools() {
  const point = new THREE.Vector3();
  const position: number[] = [];
  const edge: number[] = [];
  const index: number[] = [];
  for (const pool of POOLS) {
    const level = poolLevel(pool);
    const start = position.length / 3;
    surfaceAt(pool.u, pool.v, point);
    position.push(point.x, level, point.z);
    edge.push(0);
    const segments = 48;
    for (let k = 0; k <= segments; k++) {
      const a = (k / segments) * Math.PI * 2;
      surfaceAt(pool.u + Math.cos(a) * pool.r * 1.2, pool.v + (Math.sin(a) * pool.r * 1.2) / 1.15, point);
      position.push(point.x, level, point.z);
      edge.push(1);
      if (k < segments) index.push(start, start + k + 1, start + k + 2);
    }
  }
  const count = position.length / 3;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(count * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  geometry.setAttribute("aWild", new THREE.Float32BufferAttribute(new Float32Array(count), 1));
  geometry.setAttribute("aShelf", new THREE.Float32BufferAttribute(new Float32Array(count).fill(1), 1));
  geometry.setAttribute("aPool", new THREE.Float32BufferAttribute(new Float32Array(count).fill(1), 1));
  geometry.setAttribute("aEdge", new THREE.Float32BufferAttribute(edge, 1));
  geometry.setIndex(index);
  return geometry;
}
