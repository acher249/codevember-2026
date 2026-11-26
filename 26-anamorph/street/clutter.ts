import * as THREE from "three/webgpu";
import { attribute } from "three/tsl";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

// What stands about on a residential block: trash cans out by the stoops with black bags heaped against them,
// parking signs on posts along the curbs, the odd hydrant. All of it one merged draw, each piece's colour and gloss on its vertices.

export type Clutter = { cans: { x: number; z: number; seed: number }[]; bags: { x: number; z: number; seed: number }[]; posts: { x: number; z: number; way: number }[]; hydrants: { x: number; z: number }[] };

const CANS = ["#2c2e2f", "#5f6264", "#1a1b1c", "#2b4c7e", "#3d4a3c", "#6b6e70"].map((c) => new THREE.Color(c));
const BAG = new THREE.Color("#0c0c0d");
const POST = new THREE.Color("#7c7f80");
const PLATE = new THREE.Color("#b9b8b2");
const RED = new THREE.Color("#a3201d");
const HYDRANT = new THREE.Color("#7e2a20");
const SILVER = new THREE.Color("#8c8f90");

const rand = (i: number, n: number) => {
  const v = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

class Merged {
  positions: number[] = [];
  normals: number[] = [];
  colours: number[] = [];
  gloss: number[] = [];
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, colour: THREE.Color, rough: number) {
    const g = (geometry.index ? geometry.toNonIndexed() : geometry.clone()).applyMatrix4(matrix);
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    for (let i = 0; i < p.count; i++) {
      this.positions.push(p.getX(i), p.getY(i), p.getZ(i));
      this.normals.push(n.getX(i), n.getY(i), n.getZ(i));
      this.colours.push(colour.r, colour.g, colour.b);
      this.gloss.push(rough);
    }
    g.dispose();
  }
}

export function buildClutter(clutter: Clutter) {
  const merged = new Merged();
  // A can: a tapered tub with a ridge round it, its lid a little wider, and a handle each side.
  const tub = new THREE.LatheGeometry(
    [
      [0.0, 0.0],
      [0.24, 0.0],
      [0.25, 0.02],
      [0.28, 0.72],
      [0.295, 0.74],
      [0.29, 0.78],
      [0.0, 0.78]
    ].map(([r, y]) => new THREE.Vector2(r, y)),
    14
  );
  tub.computeVertexNormals();
  const lid = new THREE.CylinderGeometry(0.31, 0.31, 0.06, 14);
  const handle = new THREE.BoxGeometry(0.05, 0.05, 0.16);
  clutter.cans.forEach(({ x, z, seed }) => {
    const colour = CANS[Math.floor(rand(seed, 1) * CANS.length)];
    const turn = rand(seed, 2) * Math.PI * 2;
    const at = new THREE.Matrix4().makeRotationY(turn).setPosition(x, 0, z);
    merged.add(tub, at, colour, 0.7);
    // Some lids on, some left ajar.
    const ajar = rand(seed, 3) < 0.3 ? 0.25 : 0;
    merged.add(lid, at.clone().multiply(new THREE.Matrix4().makeRotationZ(ajar).setPosition(ajar * 0.25, 0.8 + ajar * 0.08, 0)), colour.clone().multiplyScalar(0.85), 0.65);
    [-1, 1].forEach((s) => merged.add(handle, at.clone().multiply(new THREE.Matrix4().makeTranslation(s * 0.3, 0.62, 0)), colour, 0.7));
  });
  tub.dispose();
  lid.dispose();
  handle.dispose();
  // A bag: a lumpy squashed ball, knotted at the top, glossy.
  clutter.bags.forEach(({ x, z, seed }) => {
    const facets = new THREE.IcosahedronGeometry(0.3, 1);
    facets.deleteAttribute("normal");
    facets.deleteAttribute("uv");
    const bag = mergeVertices(facets);
    facets.dispose();
    const p = bag.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      v.multiplyScalar(1 + (Math.sin(v.x * 17 + seed) * Math.sin(v.z * 13 + seed * 2) + Math.sin(v.y * 11 + seed)) * 0.06);
      // Flattened on the ground, pulled up to a neck at the top.
      if (v.y < -0.1) v.y = -0.1 - (v.y + 0.1) * 0.3;
      if (v.y > 0.22) v.multiply(new THREE.Vector3(0.5, 1.15, 0.5));
      p.setXYZ(i, v.x, v.y, v.z);
    }
    bag.computeVertexNormals();
    const size = 0.8 + rand(seed, 4) * 0.45;
    merged.add(bag, new THREE.Matrix4().compose(new THREE.Vector3(x, 0.13 * size, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand(seed, 5) * 6.28, (rand(seed, 6) - 0.5) * 0.4)), new THREE.Vector3(size, size * 0.95, size)), BAG, 0.25);
    bag.dispose();
  });
  // A parking sign: a post of galvanised channel, a white plate with a red band and a smaller one under it.
  const pole = new THREE.BoxGeometry(0.05, 2.7, 0.05);
  // (Facing up and down the street, as they do.)
  const plate = new THREE.BoxGeometry(0.31, 0.46, 0.012);
  const band = new THREE.BoxGeometry(0.29, 0.07, 0.004);
  const small = new THREE.BoxGeometry(0.31, 0.2, 0.012);
  clutter.posts.forEach(({ x, z, way }) => {
    merged.add(pole, new THREE.Matrix4().makeTranslation(x, 1.35, z), POST, 0.5);
    merged.add(plate, new THREE.Matrix4().makeTranslation(x, 2.35, z + 0.03), PLATE, 0.5);
    [-1, 1].forEach((s) => merged.add(band, new THREE.Matrix4().makeTranslation(x, 2.5, z + 0.03 + s * 0.008), RED, 0.5));
    merged.add(small, new THREE.Matrix4().makeTranslation(x, 2.0, z + 0.03), way > 0 ? PLATE : RED, 0.5);
  });
  // A hydrant: a barrel on a flange, a domed bonnet with its nut, and a capped outlet each side and to the front.
  const barrel = new THREE.LatheGeometry(
    [
      [0.0, 0.0],
      [0.17, 0.0],
      [0.17, 0.06],
      [0.12, 0.08],
      [0.12, 0.55],
      [0.14, 0.57],
      [0.14, 0.62],
      [0.1, 0.7],
      [0.04, 0.74],
      [0.0, 0.75]
    ].map(([r, y]) => new THREE.Vector2(r, y)),
    12
  );
  const outlet = new THREE.CylinderGeometry(0.05, 0.05, 0.12, 10).rotateZ(Math.PI / 2);
  const nut = new THREE.CylinderGeometry(0.025, 0.025, 0.05, 5);
  clutter.hydrants.forEach(({ x, z }) => {
    merged.add(barrel, new THREE.Matrix4().makeTranslation(x, 0, z), HYDRANT, 0.6);
    merged.add(nut, new THREE.Matrix4().makeTranslation(x, 0.77, z), SILVER, 0.5);
    [-1, 1].forEach((s) => merged.add(outlet, new THREE.Matrix4().makeTranslation(x, 0.42, z + s * 0.16).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)), SILVER, 0.5));
    merged.add(outlet, new THREE.Matrix4().makeTranslation(x + 0.16, 0.4, z), SILVER, 0.5);
  });
  barrel.dispose();
  outlet.dispose();
  nut.dispose();
  pole.dispose();
  plate.dispose();
  band.dispose();
  small.dispose();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(merged.positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(merged.normals, 3));
  geometry.setAttribute("tint", new THREE.Float32BufferAttribute(merged.colours, 3));
  geometry.setAttribute("gloss", new THREE.Float32BufferAttribute(merged.gloss, 1));
  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = attribute("tint", "vec3");
  material.roughnessNode = attribute("gloss", "float");
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = mesh.receiveShadow = true;
  return { mesh, geometries: [geometry], materials: [material] };
}
