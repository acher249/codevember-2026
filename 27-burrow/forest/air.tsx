"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  cos,
  cross,
  dot,
  exp,
  float,
  fract,
  hash,
  instanceIndex,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionView,
  pow,
  sin,
  smoothstep,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { mulberry32 } from "../../shared/engine/random";
import { OVERLAY_LAYER } from "../../shared/engine/Post";
import { overlayMaterial, useOverlay } from "../fx";
import { beforeFace, type TreeSpot } from "./layout";
import { outdoorLights } from "./lights";
import { CLEARING, clearingEdge, forestGround } from "./terrain";
import { canopyTime, type Crown } from "./trees";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What hangs in the air of the clearing: shafts of the midday sun coming down through the gaps in
// the leaves, midges dancing in them, and leaves coming down.

// How much of the forest's air shows (1 out in the clearing, easing to 0 underground).
export const airShown = uniform(1) as any;

// Trunks and crowns by 4 m square of the floor, so a march toward the sun reads only those near each step rather than
// every clump in the wood (that cost seconds at load).
const CELL = 4;
type Near = { trees: Map<number, TreeSpot[]>; crowns: Map<number, Crown[]> };
const cellKey = (i: number, j: number) => (i + 512) * 1024 + (j + 512);
function file<T>(into: Map<number, T[]>, item: T, x: number, z: number, r: number) {
  for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++)
    for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) {
      const k = cellKey(i, j);
      const list = into.get(k);
      if (list) list.push(item);
      else into.set(k, [item]);
    }
}
export function nearIndex(trees: TreeSpot[], crowns: Crown[]): Near {
  const near: Near = { trees: new Map(), crowns: new Map() };
  for (const t of trees) file(near.trees, t, t.x, t.z, 1.6);
  for (const c of crowns) file(near.crowns, c, c.at.x, c.at.z, c.r * 1.6);
  return near;
}
const listAt = <T,>(map: Map<number, T[]>, x: number, z: number) => map.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];

// Whether the sun reaches a point: a line from it toward the sun, checked against every trunk near it and through the
// crowns (where a little leaf is let through, as the canopy's shadow lets through its gaps).
export function sunReaches(p: THREE.Vector3, sun: THREE.Vector3, near: Near) {
  const q = new THREE.Vector3();
  let leaf = 0;
  for (let t = 0.5; t < 70; t += 0.35) {
    q.copy(p).addScaledVector(sun, t);
    if (q.y > 40) break;
    for (const tree of listAt(near.trees, q.x, q.z)) {
      if (Math.abs(tree.x - q.x) > 1.6 || Math.abs(tree.z - q.z) > 1.6) continue;
      const r = tree.radius * (1 + Math.exp(-Math.max(0, q.y - tree.y) / 0.6) * 0.5) + 0.05;
      if ((tree.x - q.x) ** 2 + (tree.z - q.z) ** 2 < r * r && q.y < tree.y + tree.height * 0.8) return false;
    }
    for (const c of listAt(near.crowns, q.x, q.z)) if (c.at.distanceToSquared(q) < (c.r * 0.8) ** 2) leaf += 0.35;
    if (leaf > 1.6) return false;
  }
  return true;
}

// The shafts: long soft strips laid along the light from where it lands, each turned about its own length to face the
// eye, brightest down the middle and gone before their edges, faded where the eye looks along them, hidden behind
// whatever is nearer.
export function ForestShafts({ sun, trees, crowns, count }: { sun: THREE.Vector3; trees: TreeSpot[]; crowns: Crown[]; count: number }) {
  const built = useMemo(() => {
    const random = mulberry32(3131);
    const data: number[] = [];
    const near = nearIndex(trees, crowns);
    // Where they land: under the trees round the clearing, where the midday sun comes down through a gap in the leaves
    // into the shade (out in the open clearing, or across the sunlit face, a shaft would only wash the view milky).
    for (let n = 0; n < 3000 && data.length / 5 < count; n++) {
      const a = random() * Math.PI;
      const d = 8 + Math.sqrt(random()) * 22;
      const x = CLEARING.x + Math.cos(a) * d * 1.15;
      const z = 1 + Math.sin(a) * d;
      const edge = clearingEdge(x, z);
      if (edge < 0.5 || edge > 12 || !beforeFace(x, z, 4)) continue;
      const y = forestGround(x, z);
      const p = new THREE.Vector3(x, y, z);
      // Through the canopy, not past its side: only where there is canopy over the spot.
      if (!listAt(near.crowns, x, z).some((c) => (c.at.x - x) ** 2 + (c.at.z - z) ** 2 < (c.r * 1.6) ** 2)) continue;
      if (!sunReaches(p, sun, near)) continue;
      // How long (up to where it leaves the canopy) and how wide.
      data.push(x, y, z, 0.2 + random() * random() * 0.7, 12 + random() * 10);
    }
    const shafts = data.length / 5;
    // Fine enough along and across that the dapple below can be worked out at its vertices (about 0.7 m apart along a
    // shaft, under its noise's 2 m).
    const quad = new THREE.PlaneGeometry(1, 1, 4, 32);
    quad.translate(0, 0.5, 0);
    const place = new Float32Array(shafts * 4);
    const lengths = new Float32Array(shafts);
    for (let i = 0; i < shafts; i++) {
      place.set(data.slice(i * 5, i * 5 + 4), i * 4);
      lengths[i] = data[i * 5 + 4];
    }
    quad.setAttribute("aShaft", new THREE.InstancedBufferAttribute(place, 4));
    quad.setAttribute("aLength", new THREE.InstancedBufferAttribute(lengths, 1));
    const material = overlayMaterial();
    material.side = THREE.DoubleSide;
    const mesh = new THREE.InstancedMesh(quad, material, Math.max(1, shafts));
    mesh.count = shafts;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { quad, material, mesh };
  }, [sun, trees, crowns, count]);
  useDispose(built.quad, built.material);
  useOverlay(built.material, (sceneZ) => {
    const s = attribute("aShaft", "vec4") as any;
    const length = attribute("aLength", "float") as any;
    const axis = vec3(sun.x, sun.y, sun.z) as any;
    const g = positionGeometry as any;
    const centre = s.xyz.add(axis.mul(g.y.mul(length))) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const side = normalize(cross(axis, toEye).add(vec3(0, 1e-4, 0))) as any;
    const world = centre.add(side.mul(g.x.mul(s.w.mul(2)))) as any;
    built.material.positionNode = world;
    const at = varying(world) as any;
    const across = uv().x.sub(0.5).mul(2) as any;
    const along = uv().y as any;
    const bell = exp(across.mul(across).mul(-5)) as any;
    const ends = smoothstep(0, 0.06, along).mul(float(1).sub(smoothstep(0.35, 1, along))) as any;
    const view = normalize(at.sub(cameraPosition)) as any;
    const sideOn = float(1).sub(pow(abs(dot(view, axis)), float(6))) as any;
    // Toward the sun the air glows: a shaft seen against the light is brighter than one seen across it.
    const forward = pow(dot(view, axis).max(0), float(3)).mul(1.5).add(1) as any;
    const soft = smoothstep(0, 1.5, positionView.z.sub(sceneZ)) as any;
    // Broken up along its length, as light through leaves is, and drifting slowly.
    const dapple = vertexStage(mx_noise_float(world.mul(0.5).add(vec3(canopyTime.mul(0.05), 0, 0))))
      .mul(0.4)
      .add(0.7) as any;
    const strength = bell.mul(ends).mul(sideOn).mul(forward).mul(soft).mul(dapple).mul(0.045) as any;
    built.material.colorNode = vec4(vec3(1.0, 0.95, 0.84).mul(strength).mul(airShown), 1) as any;
    built.material.needsUpdate = true;
  });
  return <primitive object={built.mesh} />;
}

// Midges dancing in the sunlight over the clearing: each loops and jinks about a point of its own in the sun, a
// fleck that glints as it turns.
export function Midges({ sun, count }: { sun: THREE.Vector3; count: number }) {
  const built = useMemo(() => {
    const random = mulberry32(777);
    const seeds = new Float32Array(count * 4);
    // In swarms of a dozen or so, each swarm hanging over a spot in the clearing at head height and above.
    const swarms = Math.ceil(count / 14);
    const centres = Array.from({ length: swarms }, () => {
      const a = random() * Math.PI * 2;
      const d = Math.sqrt(random()) * 13;
      const x = CLEARING.x + Math.cos(a) * d;
      const z = Math.max(1.5, CLEARING.z + Math.sin(a) * d);
      return [x, forestGround(x, z) + 0.9 + random() * 2.6, z];
    });
    for (let i = 0; i < count; i++) {
      const c = centres[i % swarms];
      seeds.set([c[0] + (random() - 0.5) * 0.8, c[1] + (random() - 0.5) * 0.6, c[2] + (random() - 0.5) * 0.8, random()], i * 4);
    }
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = overlayMaterial();
    const mesh = new THREE.InstancedMesh(quad, material, count);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { quad, material, mesh };
  }, [count]);
  useDispose(built.quad, built.material);
  useOverlay(built.material, (sceneZ) => {
    const s = attribute("aSeed", "vec4") as any;
    const t = canopyTime.add(s.w.mul(100)) as any;
    const k = s.w.mul(6.28) as any;
    // Quick loops at different rates on each axis, so the path never closes.
    const dance = vec3(sin(t.mul(float(2.1).add(s.w))).mul(0.32), sin(t.mul(3.3).add(k)).mul(0.18), cos(t.mul(float(1.7).add(s.w.mul(0.5))).add(k)).mul(0.32)).add(
      vec3(sin(t.mul(9.1).add(k)), sin(t.mul(11.3)), cos(t.mul(8.2).add(k))).mul(0.03)
    ) as any;
    const centre = s.xyz.add(dance) as any;
    const away = cameraPosition.sub(centre).length() as any;
    // Never smaller than about a pixel and a half, dimming instead.
    const radius = away.mul(0.0016).max(0.004) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    built.material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
    // Wings catching the light as they turn: a glint now and then.
    const glint = pow(sin(t.mul(23).add(k)).mul(0.5).add(0.5), float(8))
      .mul(1.5)
      .add(0.35) as any;
    const view = normalize(centre.sub(cameraPosition)) as any;
    const against = pow(dot(view, vec3(sun.x, sun.y, sun.z)).max(0), float(4))
      .mul(2)
      .add(0.6) as any;
    const r = uv().sub(0.5).length() as any;
    const shape = float(1).sub(smoothstep(0.1, 0.5, r)) as any;
    const behind = smoothstep(sceneZ.sub(0.05), sceneZ.add(0.05), positionView.z) as any;
    built.material.colorNode = vec4(vec3(1.0, 0.94, 0.8).mul(glint.mul(against).mul(shape).mul(behind).mul(0.6).mul(airShown)), 1) as any;
    built.material.needsUpdate = true;
  });
  return <primitive object={built.mesh} />;
}

// Leaves coming down: let go high in the crowns round the clearing, each spinning and swinging from side to side as it
// falls, drifting with the air, and lying a moment on the floor before it is let go again from the top.
export function FallingLeaves({ count, sun }: { count: number; sun: THREE.Vector3 }) {
  const built = useMemo(() => {
    const random = mulberry32(2222);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const a = random() * Math.PI * 2;
      const d = 3 + Math.sqrt(random()) * 17;
      const x = CLEARING.x + Math.cos(a) * d;
      const z = Math.max(1, CLEARING.z + Math.sin(a) * d);
      seeds.set([x, z, forestGround(x, z), random()], i * 4);
    }
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.7 });
    material.lightsNode = outdoorLights;
    const mesh = new THREE.InstancedMesh(quad, material, count);
    mesh.frustumCulled = false;
    // Built twice, once for the vertex position and once for the light (a node must never serve both).
    const fallAt = () => {
      const s = attribute("aSeed", "vec4") as any;
      // Each falls over its own span of 14–22 seconds from 9–14 m up, then lies for a little.
      const period = float(14).add(s.w.mul(8)) as any;
      const phase = fract(canopyTime.div(period).add(s.w.mul(7.3))) as any;
      const fall = smoothstep(0, 0.88, phase) as any;
      const drop = float(9).add(s.w.mul(5)) as any;
      const t = phase.mul(period) as any;
      // The swing side to side, and a slow drift on the air.
      const swing = sin(t.mul(float(1.6).add(s.w)))
        .mul(0.55)
        .mul(float(1).sub(fall.mul(fall))) as any;
      const drift = vec3(t.mul(0.12), 0, t.mul(-0.05)) as any;
      const y = s.z.add(drop.mul(float(1).sub(fall))).add(0.02) as any;
      const centre = vec3(s.x.add(swing), y, s.y.add(swing.mul(0.4))).add(drift.mul(fall.min(0.88).div(0.88))) as any;
      return { s, phase, t, centre };
    };
    const { s, phase, t, centre } = fallAt();
    const resting = smoothstep(0.86, 0.9, phase) as any;
    // Tumbling: turned about two axes as it goes, laid flat once it lands.
    const spin = t.mul(float(2.2).add(s.w.mul(2))) as any;
    const tilt = mix(sin(t.mul(1.6)).mul(0.9), float(Math.PI / 2), resting) as any;
    const p = positionGeometry.mul(vec3(0.07, 0.1, 1)) as any;
    const tx = p.x.mul(cos(spin)).sub(p.y.mul(sin(spin))) as any;
    const ty = p.x.mul(sin(spin)).add(p.y.mul(cos(spin))) as any;
    const local = vec3(tx, ty.mul(cos(tilt)), ty.mul(sin(tilt))) as any;
    // Gone briefly at the very end, before it starts again high up.
    const shown = float(1)
      .sub(smoothstep(0.97, 1.0, phase))
      .mul(smoothstep(0.0, 0.02, phase)) as any;
    material.positionNode = centre.add(local.mul(shown)) as any;
    const at = uv() as any;
    const across = abs(at.x.sub(0.5)).mul(2) as any;
    const half = pow(float(1).sub(pow(abs(at.y.mul(2).sub(1)), float(2))), float(0.6)) as any;
    material.opacityNode = smoothstep(half.add(0.02), half.sub(0.04), across) as any;
    const own = hash(instanceIndex.toFloat().mul(5.3)) as any;
    const colour = mix(mix(vec3(0.5, 0.3, 0.06), vec3(0.62, 0.48, 0.1), own), vec3(0.3, 0.42, 0.1), smoothstep(0.8, 0.95, own)) as any;
    material.colorNode = colour;
    const view = normalize((varying(fallAt().centre) as any).sub(cameraPosition)) as any;
    material.emissiveNode = colour.mul(pow(dot(view, vec3(sun.x, sun.y, sun.z)).max(0), float(4)).mul(1.2)) as any;
    return { quad, material, mesh };
  }, [count, sun]);
  useDispose(built.quad, built.material);
  return <primitive object={built.mesh} />;
}
