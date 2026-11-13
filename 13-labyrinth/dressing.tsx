"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import type { QualityTier } from "../shared/engine/types";
import { cardMaterial, growthGeometry, leafGeometry, stoneGeometry, stoneMaterial, vineGeometry } from "./growth";
import { type Air, CELL, tallness, THICK } from "./hedge-look";
import { techGeometry, techMaterial } from "./tech";
import { aim, inSight, sight } from "./view";

// How near the camera a hedge has to be to be dressed: loose leaves standing out of it close up, and what grows on it
// and lies at its foot a little further. Beyond, each shrinks away into the hedge or the ground before it is dropped.
const CLOSE = 7.5;
const MID = 13;
// Vines in full detail this near, and as a few big cards out to FAR.
const VINE = 9;
// Boulders are big enough to be missed further off.
const FAR = 20;
// How far a hedge's dressing reaches from its middle, with room for the bent worlds, which within FAR carry a hedge no
// more than a metre or two from where it stands.
const ROOM = 4;
// Loose leaves to the square metre, by tier.
const LEAVES = { high: 480, medium: 260, low: 0 };

type Slots = { matrix: THREE.InstancedBufferAttribute; rest: THREE.InstancedBufferAttribute; count: number; capacity: number };

function slots(capacity: number): Slots {
  const matrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
  matrix.setUsage(THREE.DynamicDrawUsage);
  const rest = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  rest.setUsage(THREE.DynamicDrawUsage);
  return { matrix, rest, count: 0, capacity };
}

function put(target: Slots, x: number, z: number, turned: boolean, sink: number) {
  if (target.count >= target.capacity) return;
  const i = target.count++;
  // Written in place, not from arrays made for each one.
  const m = target.matrix.array as Float32Array;
  const o = i * 16;
  m.fill(0, o, o + 16);
  // As tall as the hedge it grows on.
  m[o + 5] = tallness(x, z);
  m[o + 15] = 1;
  if (turned) {
    m[o + 2] = -1;
    m[o + 8] = 1;
  } else {
    m[o] = 1;
    m[o + 10] = 1;
  }
  m[o + 12] = x;
  m[o + 13] = -sink;
  m[o + 14] = z;
  const r = target.rest.array as Float32Array;
  r[i * 4] = x;
  r[i * 4 + 1] = z;
  r[i * 4 + 2] = turned ? 1 : 0;
  r[i * 4 + 3] = sink;
}

function dressed(geometry: THREE.BufferGeometry, material: THREE.Material, on: Slots, name: string) {
  geometry.setAttribute("aRest", on.rest);
  const mesh = new THREE.InstancedMesh(geometry, material, on.capacity);
  mesh.name = name;
  mesh.instanceMatrix = on.matrix;
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.count = 0;
  return mesh;
}

// Everything that dresses the hedges near the camera. The hedges hand over each wall and post as they place it, with its
// distance from the camera, and `finish` once a frame.
export function useDressing(air: Air, tier: QualityTier) {
  // Made once, not again with each tier, so that a change of tier builds no new shaders.
  const materials = useMemo(
    () => ({ leaves: cardMaterial(air, { fly: 6, walk: CLOSE }), growth: cardMaterial(air, { fly: MID, walk: MID }), stone: stoneMaterial(air, MID), boulder: stoneMaterial(air, FAR), vine: cardMaterial(air, { fly: VINE, walk: VINE }), farVine: cardMaterial(air, { fly: FAR, walk: FAR, from: VINE }), tech: techMaterial({ fly: MID, walk: MID }), farTech: techMaterial({ fly: FAR, walk: FAR, from: MID }) }),
    [air]
  );
  useEffect(() => () => Object.values(materials).forEach((material) => material.dispose()), [materials]);
  const parts = useMemo(() => {
    const perMetre = LEAVES[tier];
    if (!perMetre) return null;
    const close = { walls: slots(140), posts: slots(90) };
    const mid = { walls: slots(320), posts: slots(180) };
    const vine = { walls: slots(200), posts: slots(110) };
    const far = { walls: slots(560), posts: slots(300) };
    const { leaves, growth, stone, boulder, vine: vineCards, farVine, tech, farTech } = materials;
    const span = CELL - THICK;
    const meshes = [
      dressed(leafGeometry(span, THICK, perMetre, false, 101), leaves, close.walls, "leaves"),
      dressed(leafGeometry(THICK, THICK, perMetre * 0.6, true, 103), leaves, close.posts, "leaves"),
      dressed(growthGeometry(span, THICK, false, 211), growth, mid.walls, "growth"),
      dressed(growthGeometry(THICK, THICK, true, 223), growth, mid.posts, "growth"),
      dressed(stoneGeometry(span, THICK, false, 307, false), stone, mid.walls, "stones"),
      dressed(stoneGeometry(THICK, THICK, true, 311, false), stone, mid.posts, "stones"),
      dressed(stoneGeometry(span, THICK, false, 401, true), boulder, far.walls, "boulders"),
      dressed(stoneGeometry(THICK, THICK, true, 409, true), boulder, far.posts, "boulders"),
      dressed(vineGeometry(span, THICK, false, 503, true), vineCards, vine.walls, "vines"),
      dressed(vineGeometry(THICK, THICK, true, 509, true), vineCards, vine.posts, "vines"),
      dressed(vineGeometry(span, THICK, false, 503, false), farVine, far.walls, "vines"),
      dressed(vineGeometry(THICK, THICK, true, 509, false), farVine, far.posts, "vines"),
      // The Tron maze's own, shown only in that style.
      dressed(techGeometry(span, THICK, false, 601, true), tech, mid.walls, "tech"),
      dressed(techGeometry(THICK, THICK, true, 607, true), tech, mid.posts, "tech"),
      dressed(techGeometry(span, THICK, false, 601, false), farTech, far.walls, "tech"),
      dressed(techGeometry(THICK, THICK, true, 607, false), farTech, far.posts, "tech")
    ];
    const on = [close.walls, close.posts, mid.walls, mid.posts, mid.walls, mid.posts, far.walls, far.posts, vine.walls, vine.posts, far.walls, far.posts, mid.walls, mid.posts, far.walls, far.posts];
    return { close, mid, vine, far, meshes, on };
  }, [materials, tier]);

  useEffect(
    () => () => {
      if (!parts) return;
      for (const mesh of parts.meshes) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
    },
    [parts]
  );

  // Where the camera is looking: the dressing is only placed on hedges in or near its view. It is most of what the
  // frame costs, it casts no shadow, and on a hedge out of sight it would only be worked out to be thrown away.
  const eye = useMemo(sight, []);

  return useMemo(() => {
    const inView = (x: number, z: number) => inSight(eye, x, 1.2, z, ROOM);
    return {
      meshes: parts?.meshes ?? [],
      start(camera: THREE.PerspectiveCamera) {
        if (!parts) return;
        aim(eye, camera);
        parts.close.walls.count = parts.close.posts.count = parts.vine.walls.count = parts.vine.posts.count = parts.mid.walls.count = parts.mid.posts.count = parts.far.walls.count = parts.far.posts.count = 0;
      },
      wall(x: number, z: number, turned: boolean, sink: number, distance: number) {
        if (!parts || distance > FAR || !inView(x, z)) return;
        put(parts.far.walls, x, z, turned, sink);
        if (distance > MID) return;
        put(parts.mid.walls, x, z, turned, sink);
        if (distance < VINE) put(parts.vine.walls, x, z, turned, sink);
        if (distance < CLOSE) put(parts.close.walls, x, z, turned, sink);
      },
      post(x: number, z: number, sink: number, distance: number) {
        if (!parts || distance > FAR || !inView(x, z)) return;
        put(parts.far.posts, x, z, false, sink);
        if (distance > MID) return;
        put(parts.mid.posts, x, z, false, sink);
        if (distance < VINE) put(parts.vine.posts, x, z, false, sink);
        if (distance < CLOSE) put(parts.close.posts, x, z, false, sink);
      },
      finish() {
        if (!parts) return;
        for (const target of [parts.close.walls, parts.close.posts, parts.vine.walls, parts.vine.posts, parts.mid.walls, parts.mid.posts, parts.far.walls, parts.far.posts]) {
          for (const attribute of [target.matrix, target.rest]) {
            attribute.clearUpdateRanges();
            attribute.addUpdateRange(0, target.count * attribute.itemSize);
            attribute.needsUpdate = true;
          }
        }
        parts.meshes.forEach((mesh, i) => (mesh.count = parts.on[i].count));
      }
    };
  }, [parts, eye]);
}
