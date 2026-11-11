"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { dot, float, length, max, mix, modelWorldMatrix, normalize, normalLocal, positionWorld, sign, refract, step, texture, uniform, vec2, vec4 } from "three/tsl";
import { useQuality } from "../shared/engine/quality";
import { lightIsStill, sun, through } from "./light";
import suzanneData from "./suzanne.json";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Suzanne, Blender's monkey, from the three.js examples, about 970 triangles, made smooth: each round of `rounds` splits
// every triangle in four and bows the new points out along the curve the normals describe (Phong tessellation), so one
// round gives some 3,900. She is set so that she is about 1 across from the middle of her head to the edge (her ears
// reach a little further) and her chin rests on the table.
export function suzanne(rounds = 1) {
  let geometry = new THREE.BufferGeometryLoader().parse(suzanneData as any);
  geometry.computeVertexNormals();
  for (let round = 0; round < rounds; round++) geometry = smoothSplit(geometry);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.translate(0, -geometry.boundingBox!.min.y - 1, 0);
  return geometry;
}

// One round: a new point at the middle of every edge, shared by the two triangles either side so nothing cracks open,
// pulled from the straight edge toward the surface each end's normal implies.
function smoothSplit(source: THREE.BufferGeometry) {
  const position = source.getAttribute("position");
  const normal = source.getAttribute("normal");
  const index = source.getIndex()!;
  const points: number[] = Array.from(position.array as ArrayLike<number>);
  const normals: number[] = Array.from(normal.array as ArrayLike<number>);
  const middles = new Map<string, number>();
  const at = (i: number) => new THREE.Vector3(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
  const facing = (i: number) => new THREE.Vector3(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
  const middle = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const known = middles.get(key);
    if (known !== undefined) return known;
    const pa = at(a);
    const pb = at(b);
    const na = facing(a);
    const nb = facing(b);
    const m = pa.clone().add(pb).multiplyScalar(0.5);
    // The middle pressed onto the tangent plane at each end, and the two averaged: how far the surface bows here.
    const onA = m.clone().sub(na.clone().multiplyScalar(m.clone().sub(pa).dot(na)));
    const onB = m.clone().sub(nb.clone().multiplyScalar(m.clone().sub(pb).dot(nb)));
    const curved = m.multiplyScalar(0.25).add(onA.add(onB).multiplyScalar(0.375));
    const n = na.add(nb).normalize();
    const id = points.length / 3;
    points.push(curved.x, curved.y, curved.z);
    normals.push(n.x, n.y, n.z);
    middles.set(key, id);
    return id;
  };
  const faces: number[] = [];
  for (let f = 0; f < index.count; f += 3) {
    const [a, b, c] = [index.getX(f), index.getX(f + 1), index.getX(f + 2)];
    const ab = middle(a, b);
    const bc = middle(b, c);
    const ca = middle(c, a);
    faces.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  out.setIndex(faces);
  return out;
}

// Light through a mesh, which has no formula to trace. Each frame the glass is drawn as the sun sees it, twice, into two
// small maps: once its near side, where light gets in, and once its far side, where it gets out. Each holds the surface's
// outward normal and how far along the sun's direction it lies. A ray reads the near map to find where it enters and how
// it bends; from how thick the glass is there it guesses how far it travels before meeting the far side, reads the far
// map there for the surface it leaves by, and bends again on the way out. One crossing, not every internal bounce, but
// enough for the light a solid piece of glass throws.
// Half as fine on a phone, where four of these at full size cost more than they show.
const SIZE = 1024;
const SIZE_LOW = 512;
// How much of the table, across, the sun's view takes in.
const VIEW = 3.4;
const DEPTH = 8;

export function useSunView(meshes: { current: (THREE.Mesh | null)[] }, count: number) {
  const size = useQuality().tier === "low" ? SIZE_LOW : SIZE;
  const view = useMemo(() => {
    const target = () => new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType });
    const front = target();
    const back = target();
    const camera = new THREE.OrthographicCamera(-VIEW / 2, VIEW / 2, VIEW / 2, -VIEW / 2, 0.5, 30);
    const projection = uniform(new THREE.Matrix4());
    const surface = (side: THREE.Side) => {
      // No blending, and no tone mapping: an opaque material otherwise has its alpha, which holds the depth, set to 1.
      const material = new THREE.MeshBasicNodeMaterial({ side, blending: THREE.NoBlending, toneMapped: false });
      // The mesh's own normal, turned into the world. The pieces are scaled evenly, so no inverse transpose is needed.
      const outward = normalize((modelWorldMatrix as any).mul(vec4(normalLocal, 0)).xyz) as any;
      // Stored as positive numbers, normal from 0 to 1 and depth raised by DEPTH: a negative written here does not come back.
      material.colorNode = vec4(outward.mul(0.5).add(0.5), dot(positionWorld, sun.dir).add(DEPTH)) as any;
      return material;
    };
    const near = surface(THREE.FrontSide);
    const far = surface(THREE.BackSide);
    const scenes = [new THREE.Scene(), new THREE.Scene()];
    const proxies = Array.from({ length: count }, () => {
      const pair = [new THREE.Mesh(undefined, near), new THREE.Mesh(undefined, far)];
      pair.forEach((proxy, i) => {
        proxy.matrixAutoUpdate = false;
        proxy.frustumCulled = false;
        scenes[i].add(proxy);
      });
      return pair;
    });
    return { front, back, camera, projection, near, far, scenes, proxies, clear: new THREE.Color() as THREE.Color & { a: number } };
  }, [count, size]);

  useEffect(
    () => () => {
      view.front.dispose();
      view.back.dispose();
      view.near.dispose();
      view.far.dispose();
    },
    [view]
  );

  useFrame(({ gl }) => {
    // The glass seen from the sun only changes when something has moved.
    if (lightIsStill()) return;
    const renderer = gl as unknown as THREE.WebGPURenderer;
    const { camera } = view;
    camera.position.set(0, 0.15, 0).addScaledVector(sun.dir.value, 12);
    camera.up.copy(sun.up.value);
    camera.lookAt(0, 0.15, 0);
    camera.updateMatrixWorld();
    view.projection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    view.proxies.forEach((pair, i) => {
      const mesh = meshes.current[i];
      pair.forEach((proxy) => {
        proxy.visible = !!mesh;
        if (!mesh) return;
        proxy.geometry = mesh.geometry;
        proxy.matrix.copy(mesh.matrixWorld);
        proxy.matrixWorld.copy(mesh.matrixWorld);
      });
    });
    const before = renderer.getRenderTarget();
    renderer.getClearColor(view.clear);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    [view.front, view.back].forEach((target, i) => {
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(view.scenes[i], camera);
    });
    renderer.setRenderTarget(before);
    renderer.setClearColor(view.clear, alpha);
  });

  // Traces a ray from `o` along `d` through the glass of the piece within `reach` of `centre`, with index `n`.
  const trace = useMemo(
    () => (o: any, d: any, n: any, centre: any, reach: any) => {
      const mapAt = (p: any) => {
        const clip = view.projection.mul(vec4(p, 1)) as any;
        return vec2(clip.x.mul(0.5).add(0.5), clip.y.mul(0.5).add(0.5));
      };
      // The two maps hold the two sides; which is which can come out either way round when drawn to a texture, so at every
      // point the side nearer the sun is taken as where light gets in, and the other as where it gets out.
      const sides = (p: any) => {
        const st = mapAt(p);
        // Back to a normal and a depth; an empty texel reads as nothing found.
        const read = (map: THREE.Texture) => {
          const raw = texture(map, st) as any;
          return vec4(raw.xyz.mul(2).sub(1), raw.w.sub(DEPTH)) as any;
        };
        const raw = texture(view.front.texture, st) as any;
        const a = read(view.front.texture);
        const b = read(view.back.texture);
        const aNearer = step(b.w, a.w) as any;
        return { near: (mix as any)(b, a, aNearer), far: (mix as any)(a, b, aNearer), found: step(DEPTH / 2, raw.w) as any };
      };
      const start = sides(o);
      const entry = start.near;
      // Rays run against the sun, so the distance to a surface is how much further along the sun the start lies.
      const t = dot(o, sun.dir).sub(entry.w) as any;
      const p1 = o.add(d.mul(t)) as any;
      // Each piece's grid of light reaches over its neighbours too; it only counts the glass that is its own.
      const found = start.found.mul(step(length(p1.sub(centre)), reach)) as any;
      // Normals are turned to face the ray before it is bent, whichever way the maps hold them.
      const facing = (v: any, ray: any) => normalize(v).mul(sign(dot(v, ray)).negate());
      const inside = refract(d, facing(entry.xyz, d), float(1).div(n)) as any;
      // Where the bent ray meets the far side: start from how thick the glass is straight on, then walk the ray, each
      // time reading the far side's depth where the ray has got to, and going on to that depth. A few steps settle it.
      const slope = max(dot(inside, d), 0.3) as any;
      const along = dot(p1, sun.dir) as any;
      let s: any = max(entry.w.sub(start.far.w), 0).div(slope);
      let far: any = start.far;
      for (let walk = 0; walk < 2; walk++) {
        const reached = sides(p1.add(inside.mul(s)));
        far = (mix as any)(far, reached.far, reached.found);
        s = mix(s, along.sub(reached.far.w).div(slope), reached.found);
      }
      const p2 = p1.add(inside.mul(s)) as any;
      const leaving = refract(inside, facing(far.xyz, inside), n) as any;
      return { t: mix(float(1e5), t, found) as any, at: p2, dir: leaving, ok: found.mul(through(leaving)) as any, normal: normalize(entry.xyz) as any };
    },
    [view]
  );

  return trace;
}

