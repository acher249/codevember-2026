"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  color as tslColor,
  dot,
  exp,
  float,
  hash,
  instanceIndex,
  length,
  max,
  mix,
  normalize,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  varying,
  vec2,
  vec3
} from "three/tsl";
import { clearOfCliff, noise, smooth, surfaceAt, VALLEY_FLOOR } from "./cliff";
import { NOT_REFLECTED } from "./pools";
import { mulberry32 } from "../shared/engine/random";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

type ValleyLight = { sun: [number, number, number]; sunColor: string; ambient: string; air: string; airAmount: number };

const fbm = (x: number, y: number) => noise(x, y) + noise(x * 2.1 + 9, y * 2.1) * 0.5 + noise(x * 4.3, y * 4.3 + 3) * 0.25 + noise(x * 8.9 + 2, y * 8.9) * 0.12;

// A river wandering across the valley, away from the foot of the cliff.
const riverZ = (x: number) => 150 + Math.sin(x * 0.009 + 1) * 46 + Math.sin(x * 0.023) * 17;

function valleyAt(x: number, z: number) {
  const hills = (fbm(x * 0.0065 + 3, z * 0.0065) - 0.9) * 34;
  const fromRiver = Math.abs(z - riverZ(x));
  const bed = smooth(5, 60, fromRiver);
  const talus = Math.exp(-Math.max(0, 250 - Math.hypot(x, 260 - z)) / 34) * 12;
  const far = Math.hypot(x - 80, z - 150);
  const ridge = smooth(520, 1500, far);
  const peaks = ridge * (24 + fbm(x * 0.0024 + 8, z * 0.0024 + 4) * 52);
  return VALLEY_FLOOR + hills * bed + bed * 5 - (1 - smooth(0, 7, fromRiver)) * 3 + talus + peaks;
}

// Scattering needs a good generator, because a weak one plants its trees in visible rows.

// Colour for things too far off for the key light to reach: sun and sky by the normal, cloud shadow, and then
// the air between here and there, which is what makes a valley look big.
function lit(albedo: any, uniforms: any, shade: any = float(1)) {
  const facing = max(dot(normalize(normalWorld), uniforms.sun), float(0)) as any;
  const cloud = smoothstep(-0.25, 0.45, sin(positionWorld.x.mul(0.013).add(time.mul(0.018))).mul(sin(positionWorld.z.mul(0.017).sub(time.mul(0.012))))) as any;
  const light = uniforms.ambient.mul(1.25).add(uniforms.sunColor.mul(facing).mul(mix(float(0.45), float(1), cloud)).mul(1.1)) as any;
  const away = length(positionWorld.sub(cameraPosition)) as any;
  const haze = float(1).sub(exp(away.mul(uniforms.airAmount).negate())) as any;
  return mix(albedo.mul(light).mul(shade), uniforms.air, haze);
}

function buildConifer(tiers: number, sides: number) {
  const position: number[] = [];
  const index: number[] = [];
  const ring = (y: number, radius: number, jag: number, turn: number) => {
    const start = position.length / 3;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2 + turn;
      const r = radius * (k % 2 ? 1 - jag : 1);
      position.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
    return start;
  };
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers;
    const top = 0.14 + ((t + 1.5) / tiers) * 0.86;
    const bottom = 0.1 + f * 0.82;
    const radius = 0.2 * Math.pow(1 - f, 0.85) + 0.012;
    // A skirt: wide and drooping at the bottom, narrow where it tucks under the tier above.
    const lower = ring(bottom, radius, 0.42, t * 0.7);
    const upper = ring(Math.min(1, top), radius * 0.14, 0, t * 0.7);
    for (let k = 0; k < sides; k++) {
      const n = (k + 1) % sides;
      index.push(lower + k, upper + k, lower + n, lower + n, upper + k, upper + n);
    }
  }
  const trunkBottom = ring(0, 0.022, 0, 0);
  const trunkTop = ring(0.3, 0.012, 0, 0);
  for (let k = 0; k < sides; k++) {
    const n = (k + 1) % sides;
    index.push(trunkBottom + k, trunkTop + k, trunkBottom + n, trunkBottom + n, trunkTop + k, trunkTop + n);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

function buildBroadleaf() {
  const geometry = new THREE.IcosahedronGeometry(1, 2);
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const r = 0.8 + noise(x * 2.2 + y * 1.3 + 4, z * 2.2 - y) * 0.42;
    position.setXYZ(i, x * r * 0.24, 0.5 + y * r * 0.36, z * r * 0.24);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function plantTrees(count: number, seed: number) {
  const rand = mulberry32(seed);
  const spots: { x: number; y: number; z: number; size: number; turn: number }[] = [];
  let tries = 0;
  while (spots.length < count && tries++ < count * 40) {
    // Thick in the part of the valley you look down on, thinner toward the far side, where the ground colour takes over.
    const x = -160 + rand() * 800;
    const z = 8 + Math.pow(rand(), 1.5) * 620;
    if (!clearOfCliff(x, z, 12)) continue;
    if (Math.abs(z - riverZ(x)) < 12) continue;
    if (noise(x * 0.016 + 2, z * 0.016) < 0.26) continue;
    spots.push({ x, y: valleyAt(x, z), z, size: 9 + rand() * 9, turn: rand() * 6.28 });
  }
  return spots;
}

// Trees along the top of the cliff too, where they stand against the sky.
function plantRim(count: number, seed: number) {
  const rand = mulberry32(seed);
  const point = new THREE.Vector3();
  const spots: { x: number; y: number; z: number; size: number; turn: number }[] = [];
  for (let i = 0; i < count; i++) {
    const u = (rand() - 0.5) * 340;
    const v = 12.2 + Math.pow(rand(), 1.5) * 70;
    surfaceAt(u, v, point);
    spots.push({ x: point.x, y: point.y - 0.3, z: point.z, size: 9 + rand() * 11, turn: rand() * 6.28 });
  }
  return spots;
}

export function Valley({ tile, light, trees }: { tile: THREE.Texture; light: ValleyLight; trees: number }) {
  const uniforms = useMemo(
    () => ({
      sun: uniform(new THREE.Vector3(0, 1, 0)),
      sunColor: uniform(new THREE.Color("#ffffff")),
      ambient: uniform(new THREE.Color("#556677")),
      air: uniform(new THREE.Color("#ccddee")),
      airAmount: uniform(0.0016)
    }),
    []
  );

  useEffect(() => {
    uniforms.sun.value.set(...light.sun).normalize();
    uniforms.sunColor.value.set(light.sunColor);
    uniforms.ambient.value.set(light.ambient);
    uniforms.air.value.set(light.air);
    uniforms.airAmount.value = light.airAmount;
  }, [uniforms, light]);

  const built = useMemo(() => {
    // Rows bunch up near the cliff, where they are seen close, and spread out to the far ridges.
    const n = 330;
    const span = 2100;
    const coordinate = (i: number) => {
      const t = i / n - 0.5;
      return Math.sign(t) * Math.pow(Math.abs(t) * 2, 2.1) * span;
    };
    const position = new Float32Array((n + 1) * (n + 1) * 3);
    const tones = new Float32Array((n + 1) * (n + 1) * 2);
    const index: number[] = [];
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = coordinate(i) + 80;
        const z = coordinate(j) + 180;
        position.set([x, valleyAt(x, z), z], (j * (n + 1) + i) * 3);
        tones.set([smooth(0.75, 1.15, fbm(x * 0.012 + 5, z * 0.012)), smooth(0.7, 1.2, fbm(x * 0.06, z * 0.06 + 2))], (j * (n + 1) + i) * 2);
        if (i < n && j < n) {
          const a = j * (n + 1) + i;
          index.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
        }
      }
    }
    const ground = new THREE.BufferGeometry();
    ground.setAttribute("position", new THREE.BufferAttribute(position, 3));
    ground.setAttribute("aTone", new THREE.BufferAttribute(tones, 2));
    ground.setIndex(index);
    ground.computeVertexNormals();

    const groundMaterial = new THREE.MeshBasicNodeMaterial();
    const flat = varying(positionGeometry.xz) as any;
    // From up here, far-off forest is a colour: drifts of different trees, and darker hollows among the crowns.
    const tone = varying(attribute("aTone", "vec2")) as any;
    const grain = (texture(tile, vec2(flat.x.mul(0.013).add(flat.y.mul(0.009)), flat.y.mul(0.013).sub(flat.x.mul(0.009)))) as any).g as any;
    const forest = mix(mix(tslColor("#0c1c10"), tslColor("#1d3a1c"), tone.y), mix(tslColor("#1a2e14"), tslColor("#44602a"), tone.y), tone.x).mul(grain.mul(0.5).add(0.75)) as any;
    const water = mix(tslColor("#2e3f49"), uniforms.air, 0.55) as any;
    groundMaterial.colorNode = lit(forest, uniforms) as any;

    const river = buildRiver();
    const riverMaterial = new THREE.MeshBasicNodeMaterial();
    const ripple = (texture(tile, flat.mul(0.09).add(vec2(time.mul(0.012), 0))) as any).g as any;
    riverMaterial.colorNode = lit(water.add(ripple.mul(0.1)), { ...uniforms, ambient: vec3(0.9, 0.9, 0.9), sunColor: vec3(0, 0, 0) }) as any;

    const treeMaterial = (dark: string, bright: string) => {
      const material = new THREE.MeshBasicNodeMaterial();
      const local = varying(positionGeometry.y) as any;
      const tone = varying(hash(float(instanceIndex))) as any;
      const leaves = mix(mix(tslColor(dark), tslColor(bright), tone), mix(tslColor(dark), tslColor(bright), tone).mul(1.7), smoothstep(0.1, 0.95, local)) as any;
      // Darker lower down, where its neighbours shade it.
      material.colorNode = lit(leaves, uniforms, smoothstep(0, 0.55, local).mul(0.75).add(0.25)) as any;
      const sway = sin(time.mul(0.8).add(positionWorld.x.mul(0.14)).add(positionWorld.z.mul(0.09))).mul(0.02).mul(positionGeometry.y) as any;
      material.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.6)));
      return material;
    };

    const instance = (geometry: THREE.BufferGeometry, material: THREE.Material, spots: ReturnType<typeof plantTrees>) => {
      const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
      const matrix = new THREE.Matrix4();
      const scale = new THREE.Vector3();
      spots.forEach((spot, i) => {
        matrix.makeRotationY(spot.turn);
        scale.setScalar(spot.size);
        matrix.scale(scale);
        matrix.setPosition(spot.x, spot.y, spot.z);
        mesh.setMatrixAt(i, matrix);
      });
      mesh.frustumCulled = false;
      mesh.layers.set(NOT_REFLECTED);
      return mesh;
    };

    const conifers = instance(buildConifer(6, 10), treeMaterial("#0e2214", "#1f4522"), [...plantTrees(Math.floor(trees * 0.68), 7121), ...plantRim(Math.floor(trees * 0.1), 3371)]);
    const broadleaf = instance(buildBroadleaf(), treeMaterial("#16300f", "#3d5a1c"), plantTrees(Math.floor(trees * 0.3), 9133));
    return { ground, groundMaterial, river, riverMaterial, conifers, broadleaf };
  }, [tile, trees, uniforms]);

  // Mist lying in the valley, in thin layers that drift against each other.
  const mist = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const flat = varying(positionGeometry.xz) as any;
    const layer = attribute("aLayer", "float") as any;
    const a = (texture(tile, flat.mul(0.0031).add(vec2(time.mul(0.0011), layer))) as any).g as any;
    const b = (texture(tile, vec2(flat.y.mul(0.0073).add(layer), flat.x.mul(0.0073).sub(time.mul(0.0017)))) as any).g as any;
    const fromHere = length(positionWorld.xz.sub(vec2(40, 60))) as any;
    material.colorNode = mix(uniforms.air, uniforms.sunColor.mul(0.9).add(uniforms.ambient.mul(0.5)), 0.3) as any;
    material.opacityNode = smoothstep(0.42, 0.74, a.mul(0.6).add(b.mul(0.4))).mul(smoothstep(900, 380, fromHere)).mul(0.1) as any;
    const positions: number[] = [];
    const layers: number[] = [];
    [-76, -68, -58, -44, -30].forEach((y, k) => {
      const plane = new THREE.PlaneGeometry(1600, 1600, 1, 1);
      plane.rotateX(-Math.PI / 2);
      plane.translate(40, y, 300);
      const nonIndexed = plane.toNonIndexed().getAttribute("position");
      for (let i = 0; i < nonIndexed.count; i++) {
        positions.push(nonIndexed.getX(i), nonIndexed.getY(i), nonIndexed.getZ(i));
        layers.push(k * 0.37);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("aLayer", new THREE.Float32BufferAttribute(layers, 1));
    return { geometry, material };
  }, [tile, uniforms]);

  useEffect(
    () => () => {
      built.ground.dispose();
      built.groundMaterial.dispose();
      built.river.dispose();
      built.riverMaterial.dispose();
      for (const mesh of [built.conifers, built.broadleaf]) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        mesh.dispose();
      }
      mist.geometry.dispose();
      mist.material.dispose();
    },
    [built, mist]
  );

  return (
    <>
      <mesh geometry={built.ground} material={built.groundMaterial} frustumCulled={false} />
      <mesh geometry={built.river} material={built.riverMaterial} frustumCulled={false} />
      <primitive object={built.conifers} />
      <primitive object={built.broadleaf} />
      <mesh geometry={mist.geometry} material={mist.material} frustumCulled={false} renderOrder={2} />
    </>
  );
}

function buildRiver() {
  const position: number[] = [];
  const index: number[] = [];
  const steps = 300;
  for (let i = 0; i <= steps; i++) {
    const x = -900 + (i / steps) * 1900;
    const z = riverZ(x);
    const width = 7 + noise(x * 0.02, 3) * 5;
    const y = VALLEY_FLOOR + 1.2;
    position.push(x, y, z - width, x, y, z + width);
    if (i < steps) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(position.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geometry.setIndex(index);
  return geometry;
}
