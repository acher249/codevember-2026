"use client";

import { useEffect, useMemo } from "react";
import { suspend } from "suspend-react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  abs,
  cameraPosition,
  color,
  dot,
  exp,
  float,
  fract,
  instanceIndex,
  length,
  max,
  mix,
  normalMap,
  normalWorld,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  step,
  texture,
  texture3D,
  transformNormalToView,
  uv,
  vec2,
  vec3
} from "three/tsl";
import * as THREE from "three/webgpu";
import { lehmer } from "../shared/engine/random";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The sea floor. Rocks and sand are scans from Poly Haven, all CC0 (see public/assets/07-hollow/CREDITS.txt). The living
// things on it are built here, each from many small parts, and they sway with the water.

export const FLOOR = -10.5;
const ROOT = "/assets/07-hollow";

// The shape of the sea floor: dunes, a long trench, and smaller and smaller rises on them.
export function seabed(x: number, z: number) {
  const trench = (x + 0.34 * z - 9) / 8;
  return FLOOR + 1.3 * Math.sin(0.088 * x + 0.7) * Math.cos(0.071 * z + 0.3) + 0.72 * Math.sin(0.2 * x - 0.16 * z + 1) + 0.34 * Math.sin(0.51 * x + 0.43 * z + 2.1) + 0.14 * Math.sin(1.27 * x - 1.13 * z) + 0.07 * Math.sin(2.9 * z + 1.7 * x) + 0.03 * Math.sin(6.1 * x + 3.7 * z) + 0.02 * Math.sin(5.3 * z - 7.9 * x) - 1.5 * Math.exp(-trench * trench);
}

// Water takes the reds first and the blues last, more the further light travels through it, so distance changes colour
// and not only brightness. This is most of why a thing looks underwater.
export function throughWater(base: any): any {
  const path = (length(positionWorld.sub(cameraPosition)) as any).add(max((positionWorld as any).y.negate(), float(0)).mul(0.55));
  return (base as any).mul(exp(path.mul(vec3(-0.034, -0.008, -0.006))));
}

// Light from the surface, wavering over whatever faces up.
export function causticsOn(noise: THREE.Data3DTexture, time: any): any {
  const w = positionWorld as any;
  const layer = (scale: number, rate: number, salt: number): any => (texture3D(noise, vec3(w.x.mul(scale).add(time.mul(rate)), float(salt), w.z.mul(scale).sub(time.mul(rate * 0.7)))) as any).r;
  const net = smoothstep(0.36, 0.05, layer(0.05, 0.004, 0.2).add(layer(0.11, 0.006, 0.6)).mul(0.5)) as any;
  return net.mul(smoothstep(0.1, 0.7, (normalWorld as any).y));
}

async function loadTexture(url: string, colour: boolean, flip: boolean) {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.flipY = flip;
  tex.anisotropy = 8;
  return tex;
}

// Each piece of a scan as plain geometry, standing on y = 0, centred, and one unit at its largest.
async function loadRock(name: string) {
  const [gltf, diffuse, normal] = await Promise.all([new GLTFLoader().loadAsync(`${ROOT}/${name}/${name}.gltf`), loadTexture(`${ROOT}/${name}/textures/${name}_diff_1k.jpg`, true, false), loadTexture(`${ROOT}/${name}/textures/${name}_nor_gl_1k.jpg`, false, false)]);
  const pieces: THREE.BufferGeometry[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", mesh.geometry.getAttribute("position").clone());
    geometry.setAttribute("normal", mesh.geometry.getAttribute("normal").clone());
    geometry.setAttribute("uv", mesh.geometry.getAttribute("uv").clone());
    geometry.setIndex(mesh.geometry.getIndex()!.clone());
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    const middle = box.getCenter(new THREE.Vector3());
    geometry.translate(-middle.x, -box.min.y, -middle.z);
    const largest = Math.max(size.x, size.y, size.z);
    geometry.scale(1 / largest, 1 / largest, 1 / largest);
    pieces.push(geometry);
  });
  return { pieces, diffuse, normal };
}

// A real fish, turned so that it lies along x with its head at +x, one unit long, as the swimming expects.
async function loadFish() {
  const [gltf, diffuse, normal, surface] = await Promise.all([new GLTFLoader().loadAsync(`${ROOT}/barramundi_fish/fish.gltf`), loadTexture(`${ROOT}/barramundi_fish/fish_diff.jpg`, true, false), loadTexture(`${ROOT}/barramundi_fish/fish_nor.jpg`, false, false), loadTexture(`${ROOT}/barramundi_fish/fish_orm.jpg`, false, false)]);
  let geometry: THREE.BufferGeometry | null = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!(mesh as any).isMesh || geometry) return;
    const shape = new THREE.BufferGeometry();
    shape.setAttribute("position", mesh.geometry.getAttribute("position").clone());
    shape.setAttribute("normal", mesh.geometry.getAttribute("normal").clone());
    shape.setAttribute("uv", mesh.geometry.getAttribute("uv").clone());
    shape.setIndex(mesh.geometry.getIndex()!.clone());
    shape.applyMatrix4(mesh.matrixWorld);
    geometry = shape;
  });
  const shape = geometry as unknown as THREE.BufferGeometry;
  shape.computeBoundingBox();
  const size = shape.boundingBox!.getSize(new THREE.Vector3());
  // The model's longest side is its length.
  if (size.z > size.x) shape.rotateY(FISH_TURN);
  shape.computeBoundingBox();
  const box = shape.boundingBox!;
  const middle = box.getCenter(new THREE.Vector3());
  shape.translate(-middle.x, -middle.y, -middle.z);
  const long = box.max.x - box.min.x;
  shape.scale(1 / long, 1 / long, 1 / long);
  return { geometry: shape, diffuse, normal, surface };
}
const FISH_TURN = Math.PI / 2;

async function loadReef(lowDetail: boolean) {
  const size = lowDetail ? "1k" : "2k";
  const [sandDiffuse, sandNormal, gravelDiffuse, gravelNormal, mossy, rock, boulder, fish] = await Promise.all([
    loadTexture(`${ROOT}/sand_diff_${size}.jpg`, true, true),
    loadTexture(`${ROOT}/sand_nor_${size}.jpg`, false, true),
    loadTexture(`${ROOT}/gravel_diff_1k.jpg`, true, true),
    loadTexture(`${ROOT}/gravel_nor_1k.jpg`, false, true),
    loadRock("rock_moss_set_02"),
    loadRock("rock_09"),
    loadRock("namaqualand_boulder_03"),
    loadFish()
  ]);
  return { sandDiffuse, sandNormal, gravelDiffuse, gravelNormal, mossy, rock, boulder, fish };
}

export type ReefAssets = Awaited<ReturnType<typeof loadReef>>;
export const useReefAssets = (lowDetail: boolean) => suspend(() => loadReef(lowDetail), ["hollow-reef", lowDetail]);

// Things are scattered in clumps, thick near the peach and thinning out with distance.
function scatter(mesh: THREE.InstancedMesh, salt: number, reach: number, clumps: number, size: (r: () => number, out: THREE.Vector3) => void, sink = 0.04, colours?: string[], tilt = 0) {
  const r = lehmer(salt * 7919 + 13);
  const spots = Array.from({ length: clumps }, () => {
    const a = r() * Math.PI * 2;
    const far = Math.pow(r(), 0.72) * reach;
    return { x: Math.cos(a) * far, z: Math.sin(a) * far, spread: 0.8 + r() * 4.6, colour: r() };
  });
  const matrix = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const tint = new THREE.Color();
  for (let i = 0; i < mesh.count; i++) {
    const spot = spots[Math.floor(r() * clumps)];
    const a = r() * Math.PI * 2;
    const out = Math.sqrt(r()) * spot.spread;
    at.x = spot.x + Math.cos(a) * out;
    at.z = spot.z + Math.sin(a) * out;
    size(r, scale);
    at.y = seabed(at.x, at.z) - sink * scale.y;
    euler.set((r() - 0.5) * tilt, r() * Math.PI * 2, (r() - 0.5) * tilt);
    turn.setFromEuler(euler);
    matrix.compose(at, turn, scale);
    mesh.setMatrixAt(i, matrix);
    if (colours) {
      tint.set(colours[Math.floor((spot.colour * 0.7 + r() * 0.3) * colours.length)]);
      tint.offsetHSL((r() - 0.5) * 0.03, (r() - 0.5) * 0.14, (r() - 0.5) * 0.1);
      mesh.setColorAt(i, tint);
    }
  }
  mesh.frustumCulled = false;
}

// A single blade, curved over and tapering to a point, from a strip of many short quads.
function bladeStrip(position: number[], normal: number[], uvs: number[], index: number[], base: THREE.Vector3, facing: number, length_: number, wide: number, bend: number, segments: number) {
  const start = position.length / 3;
  const cos = Math.cos(facing);
  const sin_ = Math.sin(facing);
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const w = wide * Math.pow(1 - u, 0.72) * (0.55 + 0.45 * Math.min(1, u * 5));
    const lean = bend * u * u;
    const x = base.x + cos * lean;
    const y = base.y + length_ * u * (1 - bend * 0.3 * u);
    const z = base.z + sin_ * lean;
    position.push(x - sin_ * w, y, z + cos * w, x + sin_ * w, y, z - cos * w);
    normal.push(cos, 0.5, sin_, cos, 0.5, sin_);
    uvs.push(0, u, 1, u);
    if (i < segments) {
      const a = start + i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
}

const strips = (build: (position: number[], normal: number[], uvs: number[], index: number[]) => void) => {
  const position: number[] = [];
  const normal: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  build(position, normal, uvs, index);
  const shape = new THREE.BufferGeometry();
  shape.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  shape.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  shape.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  shape.setIndex(index);
  shape.computeVertexNormals();
  return shape;
};

export function Reef({ assets, time, scale, noise }: { assets: ReefAssets; time: any; scale: number; noise: THREE.Data3DTexture }) {
  const parts = useMemo(() => {
    const out: (THREE.Mesh | THREE.InstancedMesh)[] = [];
    const count = (n: number) => Math.max(4, Math.round(n * scale));
    const light = () => causticsOn(noise, time);
    const glow = (base: any, amount = 0.16): any => (color("#d6f6e2") as any).mul(light().mul(amount)).add((base as any).mul(0.12));

    // Plants: dark at the root, light at the tip, with a rib down the middle and fine lines along the blade.
    const plant = (dark: string, mid: string, tip: string, amount: number, rate = 1) => {
      const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.56, metalness: 0, side: THREE.DoubleSide });
      const p = positionGeometry as any;
      const phase = float(instanceIndex).mul(1.7);
      const h = p.y as any;
      const bend = h.mul(h);
      const swayX = (sin(time.mul(0.82 * rate).add(phase).add(h.mul(1.8))) as any).add((sin(time.mul(1.9 * rate).add(phase.mul(2.3)).add(h.mul(5))) as any).mul(0.2)).mul(bend).mul(amount);
      const swayZ = (sin(time.mul(0.61 * rate).add(phase.mul(1.6)).add(h.mul(1.4))) as any).mul(bend).mul(amount * 0.75);
      material.positionNode = positionLocal.add(vec3(swayX, 0, swayZ)) as any;
      const across = abs((uv() as any).x.sub(0.5)).mul(2) as any;
      const along = (uv() as any).y as any;
      const lines = sin((uv() as any).x.mul(46).add(sin(along.mul(9)))).mul(0.5).add(0.5) as any;
      const body = mix(mix(color(dark), color(mid), smoothstep(0, 0.42, along)), color(tip), smoothstep(0.45, 1, along));
      const ribbed = (body as any).mul(lines.mul(0.2).add(0.86)).mul(float(1).sub(smoothstep(0.1, 0.02, across).mul(-0.28)));
      const worn = smoothstep(0.82, 1, along.add((texture3D(noise, vec3(p.mul(0.4))) as any).g.sub(0.5).mul(0.5)));
      material.colorNode = throughWater(mix(ribbed, color("#a88a52"), (worn as any).mul(0.55)));
      // Thin strips lit as what they are would flash dark and light as they turn. Lit as if facing mostly up, they read as soft leaves.
      material.normalNode = transformNormalToView(normalize(vec3(p.x.mul(0.5), float(1), p.z.mul(0.5)))) as any;
      // A thin leaf glows where light comes through it from the surface above.
      const through = (body as any).mul(smoothstep(0.1, 1, along).mul(0.34).add(0.06));
      material.emissiveNode = glow(throughWater(through), 0.07);
      return material;
    };

    // Tufts of grass: a handful of blades from one root, each its own length and lean.
    const tuft = strips((position, normal, uvs, index) => {
      const r = lehmer(77);
      for (let b = 0; b < 9; b++) {
        const a = r() * Math.PI * 2;
        bladeStrip(position, normal, uvs, index, new THREE.Vector3(Math.cos(a) * r() * 0.1, 0, Math.sin(a) * r() * 0.1), a, 0.55 + r() * 0.45, 0.018 + r() * 0.012, 0.12 + r() * 0.42, 7);
      }
    });
    const grass = new THREE.InstancedMesh(tuft, plant("#143c26", "#3f8a4e", "#a7cf6a", 0.34), count(1900));
    scatter(grass, 2, 52, 80, (r, s) => s.setScalar(0.5 + r() * 1.25));
    out.push(grass);

    // Kelp: a thin stem with a long wavy frond every so often, up both sides.
    const frond = strips((position, normal, uvs, index) => {
      const r = lehmer(31);
      for (let i = 0; i < 16; i++) {
        const h = 0.08 + (i / 16) * 0.9;
        const side = i % 2 ? 1 : -1;
        bladeStrip(position, normal, uvs, index, new THREE.Vector3(0, h, 0), (side > 0 ? 0 : Math.PI) + (r() - 0.5) * 0.7, 0.12 + r() * 0.05, 0.03 + r() * 0.012, 0.14, 6);
      }
      bladeStrip(position, normal, uvs, index, new THREE.Vector3(), 0.3, 1, 0.008, 0.02, 14);
    });
    const kelp = new THREE.InstancedMesh(frond, plant("#2d3a12", "#6f7a1e", "#c1b43c", 0.9, 0.8), count(340));
    scatter(kelp, 1, 44, 26, (r, s) => {
      const tall = 2.4 + r() * 5.6;
      s.set(tall * 0.42, tall, tall * 0.42);
    });
    out.push(kelp);

    // Hard coral: each branch forks, and forks again, into blunt tips dotted with polyps.
    const coralTree = () => {
      const tubes: THREE.BufferGeometry[] = [];
      const r = lehmer(41);
      const grow = (from: THREE.Vector3, dir: THREE.Vector3, length_: number, radius: number, depth: number) => {
        const to = from.clone().addScaledVector(dir, length_);
        const tube = new THREE.CylinderGeometry(radius * 0.72, radius, length_, 7, 1);
        tube.translate(0, length_ / 2, 0);
        tube.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
        tube.translate(from.x, from.y, from.z);
        tubes.push(tube);
        if (depth <= 0) return;
        const arms = depth > 2 ? 3 : 2 + Math.floor(r() * 2);
        for (let i = 0; i < arms; i++) {
          const next = dir.clone().add(new THREE.Vector3(r() - 0.5, r() * 0.32, r() - 0.5).multiplyScalar(1.15)).normalize();
          grow(to, next, length_ * (0.62 + r() * 0.2), radius * 0.72, depth - 1);
        }
      };
      grow(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 0.34, 0.07, 3);
      const merged = mergeGeometries(tubes.map((t) => {
        t.deleteAttribute("uv");
        return t;
      })) as THREE.BufferGeometry;
      return merged;
    };
    const coralMaterial = () => {
      const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0 });
      const p = positionWorld as any;
      // A skeleton pitted with thousands of tiny cups, and paler where it has grown most recently.
      const near = (texture3D(noise, vec3(p.x.mul(1.1), p.y.mul(1.1), p.z.mul(1.1))) as any).r;
      const fine = (texture3D(noise, vec3(p.x.mul(3.7), p.y.mul(3.7), p.z.mul(3.7))) as any).r;
      const mottled = (texture3D(noise, vec3(p.x.mul(0.31), p.y.mul(0.31), p.z.mul(0.31))) as any).g;
      const cups = smoothstep(0.04, 0.26, fine).mul(0.36).add(smoothstep(0.03, 0.2, near).mul(0.26)).add(0.46);
      material.colorNode = throughWater((cups as any).mul(mix(float(0.62), float(1), mottled)).mul(vec3(1)));
      material.emissiveNode = (color("#d6f6e2") as any).mul(light().mul(0.08));
      return material;
    };
    const coral = new THREE.InstancedMesh(coralTree(), coralMaterial(), count(240));
    scatter(coral, 3, 34, 30, (r, s) => s.setScalar(0.7 + r() * 1.5), 0.02, ["#b86a55", "#c79a62", "#a85f78", "#8d6c94", "#d9cfb2", "#9c4f52", "#b8a888"]);
    out.push(coral);

    // Brain coral: a dome worn into winding ridges.
    const brainShape = new THREE.IcosahedronGeometry(1, 28);
    const brain = brainShape.getAttribute("position");
    const ridge = (x: number, y: number, z: number) => Math.sin(13 * x + 5 * Math.sin(5.1 * z + 2 * y)) * Math.sin(13 * z + 5 * Math.sin(4.7 * x - 2 * y) + 1.1);
    for (let i = 0; i < brain.count; i++) {
      const x = brain.getX(i);
      const y = brain.getY(i);
      const z = brain.getZ(i);
      const lump = 1 + 0.07 * Math.sin(3.1 * x + 1) * Math.sin(2.7 * z) + 0.042 * Math.abs(ridge(x, y, z));
      brain.setXYZ(i, x * lump, Math.max(y, -0.15) * lump, z * lump);
    }
    brainShape.computeVertexNormals();
    const domes = new THREE.InstancedMesh(brainShape, coralMaterial(), count(90));
    scatter(domes, 4, 32, 18, (r, s) => {
      const size = 0.26 + r() * r() * 0.8;
      s.set(size, size * (0.55 + r() * 0.25), size);
    }, 0.04, ["#a98d68", "#8f9a68", "#b08070", "#7f7a92", "#bfae88"]);
    out.push(domes);

    // Sea fans: a flat net of fine branches, swaying from the foot.
    const fanMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.74, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5 });
    const f = uv() as any;
    const out_ = length(f.sub(vec2(0.5, 0))) as any;
    const rays = abs(sin((f.x.sub(0.5) as any).div(out_.add(0.02)).mul(30))) as any;
    const rings = abs(sin(out_.mul(70).add(sin(f.x.mul(30))))) as any;
    fanMaterial.opacityNode = (step(out_, float(0.96)) as any).mul(step(float(0.8), max(rays, rings))).add(smoothstep(0.09, 0.03, abs(f.x.sub(0.5))).mul(smoothstep(0.42, 0.1, f.y)).mul(0.6)) as any;
    fanMaterial.positionNode = positionLocal.add(vec3(0, 0, (sin(time.mul(0.7).add(float(instanceIndex))) as any).mul((positionGeometry as any).y.mul((positionGeometry as any).y)).mul(0.1))) as any;
    fanMaterial.colorNode = throughWater(vec3(1));
    const fanPlane = new THREE.PlaneGeometry(1.1, 1, 1, 8);
    fanPlane.translate(0, 0.5, 0);
    const fan = new THREE.InstancedMesh(fanPlane, fanMaterial, count(70));
    scatter(fan, 7, 30, 16, (r, s) => s.setScalar(0.6 + r() * 1.2), 0, ["#8f5590", "#b4694c", "#b5a660"]);
    out.push(fan);

    // Tube sponges, standing in little groups.
    const sponges: THREE.BufferGeometry[] = [];
    const sr = lehmer(95);
    for (let i = 0; i < 6; i++) {
      const tall = 0.42 + sr() * 0.56;
      const outline: THREE.Vector2[] = [];
      for (let k = 0; k <= 12; k++) {
        const u = k / 12;
        outline.push(new THREE.Vector2(0.056 + 0.03 * Math.sin(u * 2.6 + i) + 0.014 * u, u * tall));
      }
      // Over the lip, and down inside, so that each one is a tube you can see into.
      outline.push(new THREE.Vector2(0.05, tall + 0.008), new THREE.Vector2(0.038, tall - 0.04), new THREE.Vector2(0.03, tall - 0.22));
      const tube = new THREE.LatheGeometry(outline, 14);
      const place_ = tube.getAttribute("position");
      for (let k = 0; k < place_.count; k++) {
        const x = place_.getX(k);
        const y = place_.getY(k);
        const z = place_.getZ(k);
        const fold = 1 + 0.09 * Math.sin(Math.atan2(z, x) * 7 + y * 6);
        place_.setXYZ(k, x * fold, y, z * fold);
      }
      tube.computeVertexNormals();
      const a = (i / 6) * Math.PI * 2 + sr();
      tube.rotateZ((sr() - 0.5) * 0.3);
      tube.translate(Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12);
      tube.deleteAttribute("uv");
      sponges.push(tube);
    }
    const spongeMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
    const sp = positionWorld as any;
    const pores = (texture3D(noise, vec3(sp.x.mul(2.1), sp.y.mul(2.1), sp.z.mul(2.1))) as any).r;
    spongeMaterial.colorNode = throughWater((smoothstep(0.02, 0.2, pores) as any).mul(0.55).add(0.5).mul(vec3(1)));
    spongeMaterial.emissiveNode = (color("#d6f6e2") as any).mul(light().mul(0.08));
    const sponge = new THREE.InstancedMesh(mergeGeometries(sponges) as THREE.BufferGeometry, spongeMaterial, count(70));
    scatter(sponge, 8, 32, 14, (r, s) => s.setScalar(0.6 + r() * 1), 0.02, ["#b89350", "#a87a4e", "#927090", "#a8604a"]);
    out.push(sponge);

    // Anemones: a low crown of many short tentacles, each waving by itself.
    const crown = strips((position, normal, uvs, index) => {
      const r = lehmer(55);
      for (let i = 0; i < 46; i++) {
        const a = r() * Math.PI * 2;
        const at = r() * 0.14;
        bladeStrip(position, normal, uvs, index, new THREE.Vector3(Math.cos(a) * at, 0.04, Math.sin(a) * at), a, 0.26 + r() * 0.14, 0.012, 0.1 + at * 1.4, 4);
      }
    });
    const anemones = new THREE.InstancedMesh(crown, plant("#5e2a40", "#b5748c", "#ecd2d8", 0.2, 1.8), count(120));
    scatter(anemones, 9, 28, 16, (r, s) => s.setScalar(0.6 + r() * 1), 0);
    out.push(anemones);

    // The scanned rocks.
    const rockMaterial = (asset: { diffuse: THREE.Texture; normal: THREE.Texture }) => {
      const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
      const scan = texture(asset.diffuse) as any;
      const p = positionWorld as any;
      const growth = smoothstep(0.32, 0.84, (normalWorld as any).y).mul(smoothstep(0.44, 0.62, (texture3D(noise, vec3(p.x.mul(0.21), p.y.mul(0.21), p.z.mul(0.21))) as any).g));
      const wet = (scan.rgb as any).mul(1.5);
      material.colorNode = throughWater(mix(wet, (color("#4c6a2c") as any).mul(scan.g.mul(1.5).add(0.3)), (growth as any).mul(0.72)));
      material.normalNode = normalMap(texture(asset.normal)) as any;
      material.emissiveNode = (color("#d6f6e2") as any).mul(light().mul(0.2)).add(throughWater(wet).mul(0.34));
      return material;
    };
    const rocks = (asset: { pieces: THREE.BufferGeometry[]; diffuse: THREE.Texture; normal: THREE.Texture }, each: number, salt: number, reach: number, size: (r: () => number, s: THREE.Vector3) => void) => {
      const material = rockMaterial(asset);
      asset.pieces.forEach((piece, i) => {
        const mesh = new THREE.InstancedMesh(piece, material, count(each));
        scatter(mesh, salt + i * 3, reach, 14, size, 0.16, undefined, 0.7);
        out.push(mesh);
      });
    };
    rocks(assets.mossy, 7, 11, 40, (r, s) => s.setScalar(0.5 + r() * r() * 2.6));
    rocks(assets.rock, 26, 31, 44, (r, s) => {
      const size = 0.28 + r() * r() * 1.5;
      s.set(size, size * (0.6 + r() * 0.5), size);
    });
    rocks(assets.boulder, 4, 41, 54, (r, s) => {
      const size = 2.2 + r() * 3.4;
      s.set(size, size * (0.55 + r() * 0.35), size * (0.8 + r() * 0.4));
    });

    // Thousands of small stones: real broken shapes, not spheres, in a few sizes down to grit.
    const stoneShape = (seed: number, detail: number) => {
      const r = lehmer(seed);
      const shape = new THREE.IcosahedronGeometry(1, detail).toNonIndexed();
      const place = shape.getAttribute("position");
      const a = [r() * 3 + 1, r() * 3 + 1, r() * 3 + 1, r() * 6];
      const seen = new Map<string, number>();
      for (let i = 0; i < place.count; i++) {
        const x = place.getX(i);
        const y = place.getY(i);
        const z = place.getZ(i);
        const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
        let k = seen.get(key);
        if (k === undefined) {
          k = 0.68 + 0.42 * Math.abs(Math.sin(a[0] * x + a[3]) * Math.cos(a[1] * y + a[3]) + 0.5 * Math.sin(a[2] * z + 2 * x));
          seen.set(key, k);
        }
        place.setXYZ(i, x * k * (0.7 + 0.5 * a[0] / 4), Math.max(-0.3, y) * k * 0.72, z * k);
      }
      shape.computeVertexNormals();
      shape.deleteAttribute("uv");
      return shape;
    };
    const stoneMaterial = () => {
      const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0 });
      const p = positionWorld as any;
      // The surface of the scanned rock, wrapped around each stone from the side and from above.
      const scanned = (texture(assets.rock.diffuse, vec2(p.x.mul(0.9).add(p.y.mul(0.7)), p.z.mul(0.9).sub(p.y.mul(0.7)))) as any).rgb.mul(3.1);
      material.colorNode = throughWater(scanned);
      material.emissiveNode = (color("#d6f6e2") as any).mul(light().mul(0.1)).add(throughWater(scanned).mul(0.3));
      return material;
    };
    const stoneColours = ["#6b675e", "#8c8474", "#55524c", "#a89a80", "#3f3e3c", "#b9ad94", "#7a6a56", "#9b8d74"];
    [
      { shape: stoneShape(5, 1), n: 1500, size: (r: () => number, s: THREE.Vector3) => s.setScalar(0.05 + r() * r() * 0.2) },
      { shape: stoneShape(9, 1), n: 1500, size: (r: () => number, s: THREE.Vector3) => s.set(0.05 + r() * 0.14, 0.03 + r() * 0.07, 0.05 + r() * 0.11) },
      { shape: stoneShape(17, 0), n: 2600, size: (r: () => number, s: THREE.Vector3) => s.setScalar(0.015 + r() * 0.038) }
    ].forEach((kind, i) => {
      const mesh = new THREE.InstancedMesh(kind.shape, stoneMaterial(), count(kind.n));
      scatter(mesh, 51 + i, 42, 60, kind.size, 0.22, stoneColours, 2);
      out.push(mesh);
    });

    // A few starfish, for anyone who looks closely.
    const starShape = new THREE.ExtrudeGeometry(
      (() => {
        const shape = new THREE.Shape();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          const reach = i % 2 ? 0.34 : 1;
          shape[i ? "lineTo" : "moveTo"](Math.cos(a) * reach, Math.sin(a) * reach);
        }
        shape.closePath();
        return shape;
      })(),
      { depth: 0.08, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.1, bevelSegments: 2 }
    );
    starShape.rotateX(Math.PI / 2);
    const stars = new THREE.InstancedMesh(starShape, stoneMaterial(), count(50));
    scatter(stars, 61, 30, 12, (r, s) => s.setScalar(0.09 + r() * 0.14), -0.2, ["#d9593a", "#e08a3c", "#b84466", "#7d5ab0"]);
    out.push(stars);

    // The floor itself, in relief, with scanned sand and gravel, tiled at two scales so that no repeat shows.
    const span = 200;
    const cells = Math.round(320 * Math.max(0.45, scale));
    const ground = new THREE.PlaneGeometry(span, span, cells, cells);
    ground.rotateX(-Math.PI / 2);
    const place = ground.getAttribute("position");
    const tile = ground.getAttribute("uv");
    for (let i = 0; i < place.count; i++) {
      const x = place.getX(i);
      const z = place.getZ(i);
      // Runs out into a flat bed far away, so that it has no edge.
      const off = Math.min(1, Math.max(0, (Math.hypot(x, z) - 72) / 24));
      place.setY(i, seabed(x, z) * (1 - off) + (FLOOR - 3) * off);
      tile.setXY(i, x * 0.17, -z * 0.17);
    }
    ground.computeVertexNormals();
    const floor = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.94 });
    const p = positionWorld as any;
    const uvAt = uv() as any;
    const cloud = (s: number, salt: number, channel: "g" | "b" = "g"): any => (texture3D(noise, vec3(p.x.mul(s), float(salt), p.z.mul(s))) as any)[channel].sub(0.5).mul(2.4);
    const broad = cloud(0.019, 0.1);
    const patch = cloud(0.062, 0.3, "b");
    const sand = (texture(assets.sandDiffuse, uvAt) as any).rgb.mul((texture(assets.sandDiffuse, uvAt.mul(0.23).add(0.31)) as any).rgb.mul(1.5));
    const gravel = (texture(assets.gravelDiffuse, uvAt.mul(1.4)) as any).rgb;
    const stony = smoothstep(0.08, 0.5, patch.add(broad.mul(0.5))) as any;
    const weedy = smoothstep(0.26, 0.72, cloud(0.11, 0.55).sub(broad.mul(0.3))).mul(float(1).sub(stony)) as any;
    const silt = smoothstep(FLOOR - 0.5, FLOOR - 2.2, p.y) as any;
    const seabedColour = mix(mix(sand, gravel.mul(0.92), stony), (color("#3c5a2a") as any).mul(sand.g.mul(1.5)), weedy.mul(0.62));
    floor.colorNode = throughWater(mix(seabedColour, (color("#6d6450") as any).mul(sand.g.mul(1.2)), silt.mul(0.6)));
    floor.normalNode = normalMap(mix(texture(assets.sandNormal, uvAt), texture(assets.gravelNormal, uvAt.mul(1.4)), stony) as any, vec2(1.3)) as any;
    floor.emissiveNode = (color("#d6f6e2") as any).mul(light().mul(0.22)).add(throughWater(seabedColour).mul(0.26));
    const floorMesh = new THREE.Mesh(ground, floor);
    floorMesh.frustumCulled = false;
    out.push(floorMesh);
    return out;
  }, [assets, time, scale, noise]);
  useEffect(() => () => parts.forEach((part) => (part as any).dispose?.()), [parts]);
  return (
    <>
      {parts.map((part, index) => (
        <primitive key={index} object={part} />
      ))}
    </>
  );
}

// Now and then a thread of bubbles from a crack in the floor.
export function Bubbles({ time, count, under }: { time: any; count: number; under: any }) {
  const mesh = useMemo(() => {
    const material = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.04, metalness: 0, transparent: true, depthWrite: false });
    const index = float(instanceIndex) as any;
    const vent = index.mod(9) as any;
    const seed = fract(sin(index.mul(12.9898)).mul(43758.5453)) as any;
    const ax = sin(vent.mul(5.3)).mul(16) as any;
    const az = (sin(vent.mul(9.1).add(1.3)) as any).mul(16);
    const rise = fract(time.mul(seed.mul(0.05).add(0.05)).add(seed)) as any;
    const y = rise.mul(10).add(FLOOR) as any;
    const wander = vec3(sin(y.mul(1.7).add(seed.mul(9))).mul(0.12).add(ax), y, sin(y.mul(2.1).add(seed.mul(5))).mul(0.12).add(az));
    material.positionNode = wander.add((positionLocal as any).mul(seed.mul(0.05).add(0.018))) as any;
    const toEye = (positionWorld.sub(cameraPosition) as any).normalize();
    const edge = (float(1).sub(abs(dot(normalWorld, toEye))) as any).pow(2.2);
    material.colorNode = color("#e6fbf4") as any;
    material.opacityNode = (edge.mul(0.72).add(0.05) as any).mul(under) as any;
    const instanced = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) instanced.setMatrixAt(i, identity);
    instanced.frustumCulled = false;
    return instanced;
  }, [time, count, under]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  return <primitive object={mesh} />;
}
