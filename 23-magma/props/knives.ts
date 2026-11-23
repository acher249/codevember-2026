// A wooden knife block on the counter just right of the microwave, its face raked back, five knives in its slots (dark
// handles, brushed steel bolsters, rivets), and an end-grain cutting board leaning on the backsplash behind it. Real
// wood from the oak scan the kitchen already loads, darkened to walnut for the block. Its frame: y up from the counter,
// the slotted face looking toward +z, raked back by RAKE. Generic: no maker's marks.

import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import * as THREE from "three/webgpu";
import { float, fract, mix, mx_noise_float, positionGeometry, smoothstep, texture, vec2, vec3 } from "three/tsl";
import { bump } from "./bump";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// About 11 cm wide, 23 tall along its rake, 17 deep at the foot; the board 30 × 40 cm, 2.5 cm thick.
export const BLOCK = { width: 0.44, height: 0.82, depth: 0.62, rake: 0.42 };
export const BOARD = { width: 1.2, height: 1.55, thick: 0.1, lean: 0.2 };

// Merges parts built different ways (rounded boxes come unindexed, cylinders indexed): all unindexed, position and
// normal only.
function merge(parts: THREE.BufferGeometry[]) {
  const flat = parts.map((g) => {
    const f = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(f.attributes)) if (name !== "position" && name !== "normal") f.deleteAttribute(name);
    return f;
  });
  const out = mergeGeometries(flat);
  flat.forEach((g) => g.dispose());
  parts.forEach((g) => g.dispose());
  return out;
}

// Walnut-dark or pale oak from the scan, mapped across the part's own coordinates, with a knife-scarred, worn top.
function wood(diffuse: THREE.Texture, normal: THREE.Texture, rough: THREE.Texture, tone: [number, number, number], scale: number, scars: boolean) {
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const p = positionGeometry as any;
  const at = vec2(p.x.add(p.z.mul(0.37)), p.y).div(scale) as any;
  const grain = texture(diffuse, at).rgb as any;
  m.colorNode = grain.mul(vec3(...tone)) as any;
  m.normalMap = normal;
  m.normalScale = new THREE.Vector2(0.5, 0.5);
  m.roughnessNode = texture(rough, at).r.mul(0.25).add(0.5) as any;
  if (scars) {
    // Fine knife marks crossing the board's face, lighter where they cut the surface, and a duller worn middle.
    const cut = (angle: number, freq: number) => {
      const d = p.x.mul(Math.cos(angle)).add(p.y.mul(Math.sin(angle))).mul(freq).add(mx_noise_float(p.mul(7)).mul(2)) as any;
      return float(1).sub(smoothstep(0.0, 0.05, fract(d).sub(0.5).abs())).mul(smoothstep(0.2, 0.6, mx_noise_float(p.mul(3).add(angle)))) as any;
    };
    const marks = cut(0.6, 38).add(cut(-0.9, 31)).add(cut(2.1, 45)).min(1) as any;
    m.colorNode = mix(grain.mul(vec3(...tone)), vec3(0.78, 0.66, 0.5), marks.mul(0.35)) as any;
    m.normalNode = bump(marks.mul(-0.0006)) as any;
  }
  return m;
}

export function knifeBlock(diffuse: THREE.Texture, normal: THREE.Texture, rough: THREE.Texture, fine: boolean) {
  const { width: W, height: H, depth: D, rake } = BLOCK;
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const seg = fine ? 4 : 2;

  // The block: a raked box, bevelled, its foot flat on the counter (tilted back, then sunk so its front-bottom edge
  // touches), plus a wedge foot behind so it stands.
  const body = new RoundedBoxGeometry(W, H, D * 0.62, seg, 0.03);
  body.translate(0, H / 2, 0);
  body.rotateX(-rake);
  const foot = new RoundedBoxGeometry(W, 0.12, D, seg, 0.025);
  foot.translate(0, 0.06, -D * 0.22);
  const block = merge([body, foot]);
  block.computeBoundingBox();
  // Set on the counter: the same lift for the knives.
  const lift = -block.boundingBox!.min.y;
  block.translate(0, lift, 0);
  geometries.push(block);
  const walnut = wood(diffuse, normal, rough, [0.55, 0.4, 0.3], 0.9, false);
  materials.push(walnut);
  const blockMesh = new THREE.Mesh(block, walnut);
  blockMesh.castShadow = blockMesh.receiveShadow = true;
  group.add(blockMesh);

  // The knives: handles out of the block's top face along the rake, a little apart and of different lengths.
  const handle = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0 });
  handle.colorNode = vec3(0.035, 0.032, 0.03).mul(float(0.9).add(mx_noise_float(positionGeometry.mul(60)).mul(0.1))) as any;
  const steel = new THREE.MeshStandardNodeMaterial({ metalness: 1, roughness: 0.32 });
  steel.colorNode = vec3(0.78, 0.78, 0.8) as any;
  steel.roughnessNode = float(0.28).add(mx_noise_float(positionGeometry.mul(vec3(600, 6, 600))).mul(0.06)) as any;
  materials.push(handle, steel);
  const handles: THREE.BufferGeometry[] = [];
  const metal: THREE.BufferGeometry[] = [];
  // The body's top face centre, raked, before the block was set on the counter.
  const top = new THREE.Vector3(0, H, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), -rake);
  const slots = [
    { x: -0.13, z: 0.11, len: 0.42, big: true },
    { x: 0.04, z: 0.13, len: 0.4, big: true },
    { x: 0.15, z: 0.05, len: 0.36, big: false },
    { x: -0.06, z: -0.04, len: 0.34, big: false },
    { x: 0.1, z: -0.12, len: 0.3, big: false }
  ];
  for (const s of slots) {
    const w = s.big ? 0.085 : 0.07;
    const h = new RoundedBoxGeometry(w, s.len, s.big ? 0.06 : 0.05, seg, 0.022);
    h.translate(0, s.len / 2 + 0.05, 0);
    const bolster = new RoundedBoxGeometry(w * 1.05, 0.05, s.big ? 0.064 : 0.054, 2, 0.012);
    bolster.translate(0, 0.025, 0);
    const parts = [h];
    const studs: THREE.BufferGeometry[] = [bolster];
    for (const ry of [0.14, 0.26, 0.38].slice(0, s.big ? 3 : 2)) {
      for (const side of [-1, 1]) {
        const rivet = new THREE.CylinderGeometry(0.009, 0.009, 0.006, 10);
        rivet.rotateX(Math.PI / 2);
        rivet.translate(0, 0.05 + s.len * ry * 2.2, side * ((s.big ? 0.03 : 0.025) + 0.001));
        studs.push(rivet);
      }
    }
    for (const g of [...parts, ...studs]) {
      g.rotateX(-rake);
      g.translate(s.x, top.y + lift, top.z + s.z);
    }
    handles.push(...parts);
    metal.push(...studs);
  }
  const handleGeo = merge(handles);
  const metalGeo = merge(metal);
  geometries.push(handleGeo, metalGeo);
  for (const [g, m] of [
    [handleGeo, handle],
    [metalGeo, steel]
  ] as const) {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, geometries, materials };
}

// The cutting board, standing on its long edge on the counter and leaning back against the backsplash.
export function cuttingBoard(diffuse: THREE.Texture, normal: THREE.Texture, rough: THREE.Texture, fine: boolean) {
  const { width: W, height: H, thick: T, lean } = BOARD;
  const g = new RoundedBoxGeometry(W, H, T, fine ? 5 : 2, 0.035);
  g.translate(0, H / 2, T / 2);
  g.rotateX(-lean);
  g.computeBoundingBox();
  // Its top edge back against the wall (z = 0 here), its foot forward on the counter.
  g.translate(0, -g.boundingBox!.min.y, -g.boundingBox!.min.z);
  const material = wood(diffuse, normal, rough, [1.15, 1.02, 0.86], 0.7, true);
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = mesh.receiveShadow = true;
  return { mesh, geometry: g, material };
}
