// A sheet of quads over a grid, the props' one building block: every point placed by a function of its grid cell, with a
// texture coordinate and one spare number (`tag`) each part uses its own way. Its triangles are wound so its normals
// face `outward` (checked on the built mesh, and turned round if they do not), never patched with DoubleSide.

import * as THREE from "three/webgpu";

export type Vertex = { p: [number, number, number]; uv: [number, number]; tag?: number };

export function surface(nu: number, nv: number, at: (i: number, j: number) => Vertex, outward?: (p: THREE.Vector3) => THREE.Vector3) {
  const count = (nu + 1) * (nv + 1);
  const position = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const tag = new Float32Array(count);
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const k = j * (nu + 1) + i;
      const v = at(i, j);
      position.set(v.p, k * 3);
      uv.set(v.uv, k * 2);
      tag[k] = v.tag ?? 0;
    }
  const index: number[] = [];
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const b = a + 1;
      const c = a + nu + 1;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(position, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("tag", new THREE.BufferAttribute(tag, 1));
  g.setIndex(index);
  g.computeVertexNormals();
  if (outward && facing(g, outward) < 0) {
    for (let k = 0; k < index.length; k += 3) [index[k + 1], index[k + 2]] = [index[k + 2], index[k + 1]];
    g.setIndex(index);
    g.computeVertexNormals();
  }
  return g;
}

// How far a mesh's normals agree with the way out (positive: outward), summed over its points.
export function facing(g: THREE.BufferGeometry, outward: (p: THREE.Vector3) => THREE.Vector3) {
  const position = g.attributes.position as THREE.BufferAttribute;
  const normal = g.attributes.normal as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  let sum = 0;
  for (let k = 0; k < position.count; k++) {
    p.fromBufferAttribute(position, k);
    n.fromBufferAttribute(normal, k);
    sum += n.dot(outward(p));
  }
  return sum;
}

// Only position, normal, uv and tag, so parts built different ways merge.
export function plain(g: THREE.BufferGeometry) {
  for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv", "tag"].includes(name)) g.deleteAttribute(name);
  if (!g.attributes.tag) g.setAttribute("tag", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
  return g;
}
