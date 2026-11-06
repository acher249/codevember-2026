"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { ConvexHullCollider, CuboidCollider, Physics, RigidBody, TrimeshCollider, useRapier, type RapierRigidBody } from "@react-three/rapier";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  bumpMap,
  cameraPosition,
  color as tslColor,
  dot,
  float,
  fract,
  instanceIndex,
  max,
  mix,
  luminance,
  normalGeometry,
  normalWorld,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  texture,
  mx_noise_float,
  time,
  transformNormalToView,
  uniform,
  uv,
  varying,
  vec2,
  vec3
} from "three/tsl";
import { Birds, createSky, SkyDome, type SkyPalette } from "../shared/engine/outdoors";
import { sound, useBed, useEvery, useMusic } from "../shared/engine/sound";
import { orbitPoint } from "../shared/engine/controls";
import { useGrabRigidBody } from "../shared/engine/physics";
import { airTint, focusBlur } from "../shared/engine/Post";
import { scenePhase, useQuality } from "../shared/engine/quality";
import { useSetting, useSettingRef, useSettingsStore } from "../shared/engine/settings";
import { KeyLight, StudioEnvironment } from "../shared/engine/studio";
import { useLook } from "../shared/engine/Stage";
import type { DayDefinition, Look } from "../shared/engine/types";
import { useMossAssets, type MossAssets } from "./assets";
import { ShelfDeer } from "./deer";
import { buildSheet, noise, softClearance, poolAt, SHELF_V, smooth, surfaceAt, VALLEY_FLOOR } from "./cliff";
import { firstMossAt, FIELD_SIZE, makeStrandTile, MossField } from "./field";
import { Grit, Pebbles } from "./pebbles";
import { Brush, holdingSpot } from "./plants";
import { buildPools, createWater, NOT_REFLECTED, ONLY_REFLECTED, type WaterLook } from "./pools";
import { bakeMoss, bugMaterial, mossBed, MossFibers, StoneBugs, stoneFibreGeometry, stoneFibreMaterial, type MossBake } from "./fibers";
import { hoverBody, makeHover, pushers } from "./hover";
import { Rain, Splashes } from "./rain";
import { Valley } from "./valley";
import { lehmer } from "../shared/engine/random";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

type Hour = { sky: SkyPalette; look: Partial<Look>; light: string; intensity: number; ambient: string; fill: string; flies: number; valleySun: string; valleyAmbient: string; air: string; airAmount: number };

const HOURS: Record<string, Hour> = {
  dawn: {
    sky: { zenith: "#5b86b8", horizon: "#f2d3b0", sun: "#ffe0b0", cloudLit: "#fff0dc", cloudShade: "#a59db0", sunDirection: [0.74, 0.26, 0.62], cloudCover: 0.2, cloudDrift: 0.06 },
    look: { exposure: 1, haze: 0.8, bloom: 0.2 },
    light: "#ffcf9a",
    intensity: 9000,
    ambient: "#54667a",
    fill: "#9fb4c8",
    flies: 0,
    valleySun: "#ffc892",
    valleyAmbient: "#6d8a88",
    air: "#e2c7ae",
    airAmount: 0.0008
  },
  noon: {
    sky: { zenith: "#3f7fcf", horizon: "#dbe9ef", sun: "#fff6e0", cloudLit: "#ffffff", cloudShade: "#a9bfd6", sunDirection: [0.26, 0.86, 0.44], cloudCover: 0.2, cloudDrift: 0.06 },
    look: { exposure: 1, haze: 0.5, bloom: 0.14 },
    light: "#fff2d6",
    intensity: 13000,
    ambient: "#6d8a78",
    fill: "#b7d6c0",
    flies: 0,
    valleySun: "#fff0d0",
    valleyAmbient: "#7f9bb0",
    air: "#c8dcec",
    airAmount: 0.0006
  },
  dusk: {
    sky: { zenith: "#32386f", horizon: "#f08a58", sun: "#ff9f62", cloudLit: "#ffb98c", cloudShade: "#5d4470", sunDirection: [-0.72, 0.17, 0.66], cloudCover: 0.24, cloudDrift: 0.06 },
    look: { exposure: 1.05, haze: 0.9, bloom: 0.36 },
    light: "#ff9a5c",
    intensity: 24000,
    ambient: "#3c3f62",
    fill: "#7b6a92",
    flies: 0.55,
    valleySun: "#ff9a62",
    valleyAmbient: "#4b4a78",
    air: "#d98a6c",
    airAmount: 0.0011
  },
  night: {
    sky: { zenith: "#050a1c", horizon: "#16244a", sun: "#cfdcff", cloudLit: "#34456f", cloudShade: "#080d1e", sunDirection: [0.3, 0.72, 0.62], cloudCover: 0.18, cloudDrift: 0.06 },
    look: { exposure: 1.25, haze: 0.8, bloom: 0.6 },
    light: "#9fb8ff",
    intensity: 7000,
    ambient: "#101a33",
    fill: "#26355f",
    flies: 1,
    valleySun: "#44588c",
    valleyAmbient: "#121c38",
    air: "#16244a",
    airAmount: 0.0012
  }
};

const SUN_DISTANCE = 50;

type Shared = {
  assets: MossAssets;
  field: MossField;
  tile: THREE.DataTexture;
  sunDir: any;
  water: WaterLook;
  rain: any;
  bake: MossBake;
};

const CLIFF_TILE = 5;
// Each layer of fibres is coarser and reaches further than the one before it.
const FIBER_LAYERS = {
  high: [
    { cell: 0.0062, radius: 1.3, levels: 3, crossed: true, tall: 0.024, wide: 0.0013 },
    { cell: 0.018, radius: 5, levels: 2, crossed: true, tall: 0.028, wide: 0.0034 },
    { cell: 0.065, radius: 14, levels: 1, crossed: false, tall: 0.04, wide: 0.011 }
  ],
  medium: [
    { cell: 0.0085, radius: 1.2, levels: 3, crossed: true, tall: 0.024, wide: 0.0017 },
    { cell: 0.024, radius: 4.6, levels: 2, crossed: false, tall: 0.028, wide: 0.0048 },
    { cell: 0.085, radius: 14, levels: 1, crossed: false, tall: 0.04, wide: 0.014 }
  ],
  low: [{ cell: 0.15, radius: 10, levels: 1, crossed: false, tall: 0.05, wide: 0.026 }]
};

// Shared colouring: the photograph of real moss, dark down among the stems and bright at the tips, with sun coming through from behind.
function mossColour(level: any, photo: any, sunDir: any, normal: any) {
  const colour = photo.mul(mix(float(0.2), float(1.05), smoothstep(0, 1, level))) as any;
  const toEye = normalize(cameraPosition.sub(positionWorld)) as any;
  const through = pow(max(dot(toEye, sunDir.negate()), float(0)), float(4)).mul(0.22) as any;
  const rim = pow(float(1).sub(max(dot(normal, toEye), float(0))), float(3)).mul(0.1) as any;
  return { colour, glow: colour.mul(level).mul(through.add(rim)) };
}

const span = (from: number, to: number, count: number) => Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count);

// More columns close by than far off, because this cliff goes on a long way.
const stretched = (limit: number, count: number) => span(-1, 1, count).map((t) => Math.sign(t) * Math.pow(Math.abs(t), 2.2) * limit);

function Ground({ shared, shells, sheet, detail }: { shared: Shared; shells: number; sheet: { current: THREE.Mesh | null }; detail: number }) {
  const { assets, field, tile, water, rain, bake } = shared;
  const half = FIELD_SIZE / 2;

  // The rock near enough to touch, where moss can grow, and the same fur stacked up over it.
  const geometry = useMemo(() => {
    const sheet = buildSheet(span(-half, half, detail), span(-half, half, detail), FIELD_SIZE, firstMossAt);
    const count = sheet.getAttribute("position").count;
    sheet.setAttribute("aPool", new THREE.BufferAttribute(new Float32Array(count), 1));
    sheet.setAttribute("aEdge", new THREE.BufferAttribute(new Float32Array(count), 1));
    return sheet;
  }, [half, detail]);
  const pools = useMemo(buildPools, []);
  const furGeometry = useMemo(() => buildSheet(span(-half, half, Math.floor(detail * 0.6)), span(-half, half, Math.floor(detail * 0.6)), FIELD_SIZE, firstMossAt), [half, detail]);

  // Everything else of the cliff, sunk slightly under the near part so that the two never fight.
  const farGeometry = useMemo(() => {
    const inset = (u: number, v: number) => 0.5 * smooth(half, half - 0.7, Math.abs(u)) * smooth(half, half - 0.7, Math.abs(v));
    const vs = [...span(-125, -half - 0.1, 150), ...span(-half, half, 80), ...span(half + 0.1, 40, 40), ...span(42, 235, 30)];
    return buildSheet(stretched(340, 460), vs, FIELD_SIZE, firstMossAt, inset);
  }, [half]);

  const collider = useMemo(() => {
    const nu = 170;
    const nv = 92;
    const us = span(-20, 36, nu);
    const vs = span(-12, 13, nv);
    const vertices = new Float32Array((nu + 1) * (nv + 1) * 3);
    const indices = new Uint32Array(nu * nv * 6);
    const point = new THREE.Vector3();
    vs.forEach((v, j) =>
      us.forEach((u, i) => {
        surfaceAt(u, v, point);
        vertices.set([point.x, point.y, point.z], (j * (nu + 1) + i) * 3);
      })
    );
    let o = 0;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i;
        indices.set([a, a + 1, a + nu + 1, a + 1, a + nu + 2, a + nu + 1], o);
        o += 6;
      }
    }
    return { vertices, indices };
  }, []);

  const materials = useMemo(() => {
    const flat = varying(uv().sub(0.5).mul(FIELD_SIZE)) as any;
    const mapUv = varying(uv()) as any;
    const fieldHere = texture(field.texture, mapUv) as any;
    const inside = smoothstep(0.5, 0.47, max(abs(mapUv.x.sub(0.5)), abs(mapUv.y.sub(0.5)))) as any;
    const wild = varying(attribute("aWild", "float")) as any;
    const shelf = varying(attribute("aShelf", "float")) as any;
    const mossHere = fieldHere.r.mul(inside).add(float(1).sub(inside).mul(wild)) as any;
    const wet = max(fieldHere.g.mul(inside).add(float(1).sub(inside).mul(0.4)), rain.mul(0.9)) as any;
    const mossMap = texture(bake.map, mapUv) as any;
    const bed = mossBed(assets, flat);
    const strandFine = texture(tile, flat.mul(2.1)) as any;
    const strandWide = texture(tile, vec2(flat.y.mul(0.93).add(0.31), flat.x.mul(0.93).sub(0.2))) as any;
    const cushions = texture(tile, flat.mul(0.11)) as any;

    // The real relief of the scanned rock, pushing the near mesh in and out, and the fur with it.
    const vertexFlat = uv().sub(0.5).mul(FIELD_SIZE) as any;
    const vertexEdge = smoothstep(0.5, 0.46, max(abs(uv().x.sub(0.5)), abs(uv().y.sub(0.5)))) as any;
    const scanHeight = (texture(assets.cliffHeight, vertexFlat.div(CLIFF_TILE)) as any).level(0).r as any;
    const relief = normalGeometry.mul(scanHeight.sub(0.5).mul(mix(float(0.4), float(0.08), attribute("aShelf", "float"))).mul(vertexEdge)) as any;

    const bare = (displaced: boolean) => {
      const rock = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
      const away = cameraPosition.sub(positionWorld).length() as any;
      const distant = smoothstep(18, 60, away) as any;
      const breakup = (texture(tile, flat.mul(0.023)) as any).g as any;
      const seam = smoothstep(0.42, 0.58, breakup) as any;
      // The photographs are projected from all three axes in world space, not laid along the surface. Sculpting pushes
      // that surface in and out by metres, and anything laid along it stretches across the sides of every block.
      const world = positionWorld as any;
      const facing = normalize(varying(normalGeometry)) as any;
      const sharp = (pow as any)(abs(facing), vec3(7, 7, 7)) as any;
      const share = sharp.div(sharp.x.add(sharp.y).add(sharp.z)) as any;
      const projected = (map: THREE.Texture, size: any, offset: any = vec2(0, 0)) => {
        const fromX = texture(map, world.zy.div(size).add(offset)) as any;
        const fromY = texture(map, world.xz.div(size).add(offset)) as any;
        const fromZ = texture(map, world.xy.div(size).add(offset)) as any;
        return { fromX, fromY, fromZ, rgb: fromX.rgb.mul(share.x).add(fromY.rgb.mul(share.y)).add(fromZ.rgb.mul(share.z)) };
      };
      // Each tap of a normal map is turned out to face the way that axis looks, then all three are blended.
      const bent = (sample: { fromX: any; fromY: any; fromZ: any }, strength: any) => {
        const tap = (node: any) => node.xy.mul(2).sub(1).mul(strength) as any;
        const x = tap(sample.fromX) as any;
        const y = tap(sample.fromY) as any;
        const z = tap(sample.fromZ) as any;
        const worldX = vec3(facing.x, x.y.add(facing.y), x.x.add(facing.z)) as any;
        const worldY = vec3(y.x.add(facing.x), facing.y, y.y.add(facing.z)) as any;
        const worldZ = vec3(z.x.add(facing.x), z.y.add(facing.y), facing.z) as any;
        return worldX.mul(share.x).add(worldY.mul(share.y)).add(worldZ.mul(share.z)) as any;
      };
      const cliffNear = projected(assets.cliffDiffuse, float(CLIFF_TILE));
      const cliffFar = projected(assets.cliffDiffuse, float(CLIFF_TILE * 3.7), vec2(0.37, 0.61));
      const faceScan = projected(assets.faceDiffuse, float(4.3));
      const faceAmount = smoothstep(0.46, 0.64, (texture(tile, flat.mul(0.0091).add(0.3)) as any).g).mul(0.72) as any;
      // Up close and far off at different sizes, which is also what stops either one reading as a repeat.
      const close = smoothstep(16, 3, away) as any;
      const cliffFine = projected(assets.cliffDiffuse, float(1.37), vec2(0.13, 0.47));
      const broadPhoto = mix(mix(cliffNear.rgb, cliffFar.rgb, distant.mul(0.8).add(seam.mul(0.2))), faceScan.rgb, faceAmount) as any;
      // A much finer pass of the same rock close to the lens, so that it keeps its grain however near you get.
      const photo = broadPhoto.mul(mix(float(1), luminance(cliffFine.rgb).mul(2), close.mul(0.75))) as any;
      const grey = mix(vec3(luminance(photo)), photo, 0.72) as any;
      // Streaks where water has run down it for years, and crusts of lichen.
      const streak = (texture(tile, vec2(flat.x.mul(0.21), flat.y.mul(0.013))) as any).g as any;
      const stained = grey.mul(mix(float(1), float(0.46), smoothstep(0.52, 0.76, streak))) as any;
      const lichen = smoothstep(0.68, 0.76, (texture(tile, flat.mul(0.19)) as any).g).mul(smoothstep(0.3, 0.6, strandWide.r)) as any;
      const crusted = mix(stained, tslColor("#a7ab78"), lichen.mul(0.5)) as any;
      // Level ground has gathered grit and needles in its hollows.
      const litter = cushions.g.mul(0.45).add(strandWide.g.mul(0.3)).add(strandFine.r.mul(0.25)) as any;
      const leaves = smoothstep(0.62, 0.8, (texture(tile, vec2(flat.x.mul(0.53).add(flat.y.mul(0.2)), flat.y.mul(0.53).sub(flat.x.mul(0.2)))) as any).r) as any;
      const dirt = mix(mix(tslColor("#17120c"), tslColor("#4d3f2e"), litter), mix(tslColor("#5f3a1a"), tslColor("#8a6a2c"), strandFine.b), leaves.mul(0.6)) as any;
      const ground = mix(crusted.mul(0.82), dirt, smoothstep(0.62, 0.86, shelf.mul(0.72).add(cushions.g.mul(0.5)).add(breakup.sub(0.5).mul(0.4)))) as any;
      const underMoss = bed.colour.mul(0.34) as any;
      const covered = smoothstep(0.32, 0.56, mossHere.mul(0.82).add(mossMap.b.sub(0.5).mul(0.85))) as any;
      rock.colorNode = mix(ground.mul(mix(float(1), float(0.52), wet)), underMoss, covered) as any;
      rock.roughnessNode = mix(mix(float(0.97), float(0.84), wet), float(1), covered) as any;
      const rockNormal = projected(assets.cliffNormal, float(CLIFF_TILE));
      const faceNormal = projected(assets.faceNormal, float(4.3));
      const bentRock = mix(bent(rockNormal, float(1.1)), bent(faceNormal, float(1.1)), faceAmount) as any;
      const fineNormal = projected(assets.cliffNormal, float(1.37), vec2(0.13, 0.47));
      rock.normalNode = transformNormalToView(normalize(bentRock.add(bent(fineNormal, float(0.9)).sub(facing).mul(close)))) as any;
      if (displaced) rock.positionNode = positionLocal.add(relief);
      return rock;
    };
    const soil = bare(true);
    const farRock = bare(false);

    // All the water, one material: the pools, and the film lying on the rock as on a street after rain, which
    // gathers in the low places and spreads the harder it rains. Rain raises the pools too, so their shores creep out.
    const wetFilm = new THREE.MeshBasicNodeMaterial({ alphaTest: 0.5, side: THREE.DoubleSide });
    const isPool = attribute("aPool", "float") as any;
    const hollows = (texture(tile, flat.mul(0.19)) as any).g.mul(0.55).add(cushions.g.mul(0.45)) as any;
    const lying = mix(float(0.6), float(0.32), rain) as any;
    const noMoss = float(1).sub(smoothstep(0.3, 0.5, mossHere.mul(0.82).add(mossMap.b.sub(0.5).mul(0.85)))) as any;
    const onRock = smoothstep(lying, lying.add(0.05), hollows).mul(smoothstep(0.55, 0.85, shelf)).mul(noMoss) as any;
    wetFilm.opacityNode = max(varying(isPool), onRock) as any;
    const shallows = mix(tslColor("#100f0c"), tslColor("#2a2a22"), (varying(attribute("aEdge", "float")) as any).mul(varying(isPool))) as any;
    wetFilm.colorNode = mix(shallows, water.seen, water.fresnel.mul(0.92).add(0.06)) as any;
    wetFilm.positionNode = mix(positionLocal.add(relief).add(normalGeometry.mul(0.016)), positionLocal.add(vec3(0, rain.mul(0.055).sub(0.03), 0)), isPool) as any;

    // Fur by shells: the same rock, stacked. Each layer keeps only the strands still tall enough to reach it.
    // Fully rough. A wet gloss here would lie over the fibres like a skin.
    const shell = new THREE.MeshStandardNodeMaterial({ alphaTest: 0.5, roughness: 1, metalness: 0 });
    const level = varying(float(instanceIndex).add(1).div(shells)) as any;
    const vertexUv = uv() as any;
    const edge = smoothstep(0.5, 0.47, max(abs(vertexUv.x.sub(0.5)), abs(vertexUv.y.sub(0.5)))) as any;
    const groundMoss = (texture(field.texture, vertexUv) as any).level(0).r.mul(edge) as any;
    const vertexMap = (texture(bake.map, vertexUv) as any).level(0) as any;
    const height = groundMoss.mul(groundMoss).mul(vertexMap.r.mul(vertexMap.r).mul(2.2).add(0.1)).mul(0.006) as any;
    shell.positionNode = positionLocal.add(relief).add(normalGeometry.mul(height.mul(float(instanceIndex).add(1).div(shells))));
    // Only a soft dark mass for the fibres to stand in, and all that there is beyond where the fibres reach.
    const grainFine = mx_noise_float((positionWorld as any).mul(38)).mul(0.5).add(0.5) as any;
    const patchy = smoothstep(0.32, 0.56, mossHere.mul(0.82).add(mossMap.b.sub(0.5).mul(0.85))) as any;
    shell.opacityNode = smoothstep(level.mul(0.86), level.mul(0.86).add(0.05), grainFine.mul(0.7).add(mossMap.a.mul(0.3)).mul(patchy).add(patchy.mul(0.2))) as any;
    const seenFrom = cameraPosition.sub(positionWorld).length() as any;
    // Beyond the fibres this is all there is, so it brightens to the colour they would have had.
    const reachOut = smoothstep(1.5, 6, seenFrom) as any;
    // Where the moss is short the floor of it shows, so there it carries that moss's own colour.
    const kinds = texture(bake.kinds, mapUv) as any;
    const shortTint = mix(tslColor("#0f3a1c"), tslColor("#3f4d1a"), kinds.g) as any;
    // The photographed bed everywhere, tinted a little toward whichever moss stands on it, and brighter from further off where it has to carry the colour.
    shell.colorNode = bed.colour.mul(mix(vec3(1, 1, 1), shortTint.mul(4.5), float(1).sub(kinds.r).mul(0.5))).mul(mix(float(0.36), float(0.72), level)).mul(mix(float(1), float(1.5), reachOut)) as any;

    // What the water sees of the moss. The fibres are too many to draw twice.
    const mirrored = new THREE.MeshStandardNodeMaterial({ alphaTest: 0.5, roughness: 1, metalness: 0 });
    mirrored.positionNode = positionLocal.add(relief).add(normalGeometry.mul(0.012));
    mirrored.opacityNode = patchy as any;
    mirrored.colorNode = mix(shortTint.mul(0.8), mix(tslColor("#2c5216"), tslColor("#6b8a24"), mossMap.g), kinds.r).mul(mossMap.a.mul(0.7).add(0.6)) as any;
    return { soil, farRock, shell, wetFilm, mirrored };
  }, [assets, field, tile, shells, water, rain, bake]);

  const fur = useMemo(() => {
    const mesh = new THREE.InstancedMesh(furGeometry, materials.shell, shells);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < shells; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.layers.set(NOT_REFLECTED);
    return mesh;
  }, [furGeometry, materials.shell, shells]);

  useEffect(() => () => fur.dispose(), [fur]);
  useEffect(
    () => () => {
      materials.soil.dispose();
      materials.farRock.dispose();
      materials.wetFilm.dispose();
      materials.shell.dispose();
      materials.mirrored.dispose();
    },
    [materials]
  );
  useEffect(
    () => () => {
      geometry.dispose();
      furGeometry.dispose();
      farGeometry.dispose();
      pools.dispose();
    },
    [geometry, furGeometry, farGeometry, pools]
  );

  return (
    <>
      <mesh ref={sheet} geometry={geometry} material={materials.soil} castShadow receiveShadow frustumCulled={false} />
      <mesh geometry={farGeometry} material={materials.farRock} receiveShadow frustumCulled={false} />
      <primitive object={fur} />
      <mesh geometry={furGeometry} material={materials.mirrored} frustumCulled={false} ref={(mesh) => mesh?.layers.set(ONLY_REFLECTED)} />
      {water.target ? <primitive object={water.target} /> : null}
      <mesh geometry={geometry} material={materials.wetFilm} frustumCulled={false} />
      <mesh geometry={pools} material={materials.wetFilm} frustumCulled={false} />
      <RigidBody type="fixed" colliders={false}>
        <TrimeshCollider args={[collider.vertices, collider.indices]} friction={1} />
        {/* Whatever goes over the edge comes to rest down among the trees. */}
        <CuboidCollider args={[600, 2, 600]} position={[0, VALLEY_FLOOR - 2, 300]} />
      </RigidBody>
    </>
  );
}

type StoneSpec = { position: [number, number, number]; size: [number, number, number]; seed: number; turn: number; lift?: number };

// Boulders this big, near enough to the lens, are the ones that get the full moss.
const isHero = (spec: StoneSpec) => Math.max(...spec.size) > 0.95 && spec.position[0] < 9;

// Cairns balanced along the shelf, and loose boulders to carry around, or to send over the edge.
function layoutStones(): StoneSpec[] {
  const rand = lehmer(4177);
  const stones: StoneSpec[] = [];
  const point = new THREE.Vector3();
  const cairn = (u: number, v: number, levels: number, base: number) => {
    surfaceAt(u, v, point);
    const x = point.x;
    const z = point.z;
    let y = point.y - 0.02;
    for (let k = 0; k < levels; k++) {
      const radius = base * (1 - k * 0.15) * (0.92 + rand() * 0.12);
      const flat = 0.5 + rand() * 0.12;
      y += radius * flat * (k === 0 ? 0.9 : 1);
      stones.push({ position: [x + (rand() - 0.5) * 0.05, y, z + (rand() - 0.5) * 0.05], size: [radius, radius * flat, radius * (0.9 + rand() * 0.15)], seed: stones.length * 3 + 11, turn: rand() * 6 });
      y += radius * flat * 0.86;
    }
  };
  cairn(-1.2, SHELF_V + 0.3, 5, 0.72);
  cairn(4.4, SHELF_V + 1.7, 4, 0.66);
  cairn(8.9, SHELF_V + 1.3, 3, 0.52);
  const placed: [number, number, number][] = [];
  const place = (u: number, v: number, r: number) => {
    const point = surfaceAt(u, v, new THREE.Vector3());
    // Never right under the lens, where it would fill the opening view.
    if (Math.hypot(point.x + 10.6, point.z - 1.1) - r < 2.6) return;
    placed.push([u, v, r]);
    stones.push({ position: [point.x, point.y + r * 0.46, point.z], size: [r, r * (0.62 + rand() * 0.24), r * (0.78 + rand() * 0.3)], seed: stones.length * 3 + 11, turn: rand() * 6 });
  };
  // The big one right under the lens, which comes up close beneath you when the gravity turns.
  surfaceAt(-8.2, -7.2, point);
  stones.push({ position: [point.x, point.y + 0.6, point.z], size: [1.9, 1.02, 1.6], seed: 977, turn: 0.7, lift: 0.5 });
  placed.push([-8.2, -7.2, 1.9]);
  for (const [u, v, r] of [
    [-3.3, -6.6, 1.15],
    [0.9, -2.5, 1.3],
    [6.4, -2.7, 1.05],
    [9.9, -6.2, 1.2],
    [-8.2, -2.5, 1.45],
    [-11.8, -5.8, 1.35],
    [-5.2, -5.4, 1.2],
    [-4.4, -1.6, 0.85],
    [-6.3, -0.4, 0.7],
    [-2.2, -4.1, 0.8],
    [0.8, 3.95, 0.5],
    [6, 3.95, 0.42]
  ]) {
    place(u, v, r);
  }
  // And plenty more, in all sizes, wherever they do not sit in a pool or on top of each other.
  for (let tries = 0; tries < 1100 && placed.length < 95; tries++) {
    const onLedge = rand() < 0.14;
    // Thick around the camera, thinning out along the shelf.
    const u = -14.5 + Math.pow(rand(), 1.9) * 46;
    const v = onLedge ? 3.5 + rand() * 0.9 : SHELF_V + (rand() - 0.5) * 5.5;
    const r = onLedge ? 0.16 + rand() * 0.26 : 0.2 + Math.pow(rand(), 2) * 1.05;
    if (poolAt(u, v, 1 + (r + 0.2) / 1.2) > 0) continue;
    if (Math.abs(u + 1.2) < 1.3 && Math.abs(v - SHELF_V) < 1.3) continue;
    if (Math.abs(u - 4.4) < 1.2 && Math.abs(v - SHELF_V - 1.7) < 1.2) continue;
    if (Math.abs(u - 8.9) < 1 && Math.abs(v - SHELF_V - 1.3) < 1) continue;
    if (placed.some(([pu, pv, pr]) => Math.hypot(u - pu, v - pv) < pr + r + 0.12)) continue;
    place(u, v, r);
  }
  return stones;
}

// Moss keeps mostly to the top of a stone, with scattered patches down its sides.
const mossOnStone = (x: number, y: number, z: number, facing: number, seed: number, generous: boolean) =>
  Math.max(stoneMossAt(facing, noise(x * 1.5 + seed, z * 1.5 + y), generous), smooth(0.6, 0.7, noise(x * 2.3 + seed * 0.7, z * 2.3 + y * 2.1)) * 0.8 * smooth(-0.55, -0.2, facing));

const stoneMossAt = (facing: number, patch: number, generous = false) => Math.max(0, Math.min(1, (facing * 0.72 + (patch - 0.5) * 1.5 - (generous ? 0.26 : 0.48)) * (generous ? 1.5 : 2.6)));

// The closed, merged sphere at each resolution, worked out once, since this is the slow part and every stone needs one.
const unitSpheres = new Map<number, { position: Float32Array; index: number[] }>();
function unitSphere(detail: number) {
  const known = unitSpheres.get(detail);
  if (known) return known;
  const position = new THREE.IcosahedronGeometry(1, detail).getAttribute("position");
  const seen = new Map<string, number>();
  const unique: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${Math.round(x * 4096)},${Math.round(y * 4096)},${Math.round(z * 4096)}`;
    let at = seen.get(key);
    if (at === undefined) {
      at = unique.length / 3;
      seen.set(key, at);
      unique.push(x, y, z);
    }
    index.push(at);
  }
  const sphere = { position: new Float32Array(unique), index };
  unitSpheres.set(detail, sphere);
  return sphere;
}

function buildStone(spec: StoneSpec, quality: number) {
  const cutRand = lehmer(spec.seed * 31 + 7);
  const cuts = Array.from({ length: 9 }, () => {
    const direction = new THREE.Vector3(cutRand() - 0.5, (cutRand() - 0.5) * 0.7, cutRand() - 0.5).normalize();
    return [direction.x, direction.y, direction.z, 0.6 + cutRand() * 0.28];
  });
  const shaped = (detail: number, fine: boolean, lift: number) => {
    const sphere = unitSphere(detail);
    const unique = new Float32Array(sphere.position.length);
    const cavity = new Float32Array(unique.length / 3);
    const cut = new THREE.Vector3();
    for (let i = 0; i < unique.length; i += 3) {
      const x = sphere.position[i];
      const y = sphere.position[i + 1];
      const z = sphere.position[i + 2];
      let rough = 1 + (noise(x * 1.7 + spec.seed, y * 1.7 + z) - 0.5) * 0.42 + (noise(y * 5 + spec.seed, z * 5 + x) - 0.5) * 0.12;
      let pit = 0;
      if (fine) {
        // Only on the rock you see: grain and pits, and cracks where two fields of noise cross.
        const crack = Math.abs(noise(x * 6 + y * 3 + spec.seed, z * 6 - y * 2) - 0.5);
        const crackDepth = crack < 0.035 ? (0.035 - crack) / 0.035 : 0;
        pit = crackDepth;
        rough += (noise(x * 14 + z, y * 14 + spec.seed) - 0.5) * 0.05 + (noise(x * 31 + y, z * 31 + spec.seed) - 0.5) * 0.022 + (noise(y * 67 + x, z * 67 - x) - 0.5) * 0.009 - crackDepth * 0.035;
      }
      rough += lift;
      // Cut flatter top and bottom, so that they stack.
      const flatten = Math.abs(y) > 0.72 ? 0.72 / Math.abs(y) : 1;
      // Real stones have broken faces, so each is sliced by a few planes of its own.
      cut.set(x * rough, y * flatten * rough, z * rough);
      for (const [a, b, c, limit] of cuts) {
        const over = cut.x * a + cut.y * b + cut.z * c - limit - lift;
        if (over > 0) {
          cut.x -= a * over * 0.92;
          cut.y -= b * over * 0.92;
          cut.z -= c * over * 0.92;
        }
      }
      unique[i] = cut.x * spec.size[0];
      unique[i + 1] = cut.y * spec.size[1];
      unique[i + 2] = cut.z * spec.size[2];
      cavity[i / 3] = pit;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.BufferAttribute(unique, 3));
    merged.setAttribute("aCavity", new THREE.BufferAttribute(cavity, 1));
    merged.setIndex(sphere.index);
    merged.computeVertexNormals();
    return merged;
  };
  const radius = Math.max(...spec.size);
  // The bigger the stone, the more of it there is to see. The moss only needs enough to follow its shape.
  const geometry = shaped(Math.round((12 + radius * 44) * quality), true, 0);
  const hero = isHero(spec);
  const furGeometry = shaped(Math.round((hero ? 12 + radius * 14 : 6 + radius * 12) * Math.max(0.6, quality)), false, 0.012);
  const count = furGeometry.getAttribute("position").count;
  const moss = new Float32Array(count);
  const normal = furGeometry.getAttribute("normal");
  const position = furGeometry.getAttribute("position");
  for (let i = 0; i < count; i++) {
    // Already grown over wherever it has been facing the sky.
    moss[i] = mossOnStone(position.getX(i), position.getY(i), position.getZ(i), normal.getY(i), spec.seed, hero);
    if (spec.lift) moss[i] = Math.max(moss[i], smooth(0.05, 0.4, normal.getY(i)));
  }
  furGeometry.setAttribute("aMoss", new THREE.BufferAttribute(moss, 1));
  const rockNormal = geometry.getAttribute("normal");
  const rockPosition = geometry.getAttribute("position");
  const rockMoss = new Float32Array(rockPosition.count);
  for (let i = 0; i < rockMoss.length; i++) {
    rockMoss[i] = mossOnStone(rockPosition.getX(i), rockPosition.getY(i), rockPosition.getZ(i), rockNormal.getY(i), spec.seed, hero);
    if (spec.lift) rockMoss[i] = Math.max(rockMoss[i], smooth(0.05, 0.4, rockNormal.getY(i)));
  }
  geometry.setAttribute("aRockMoss", new THREE.BufferAttribute(rockMoss, 1));
  // A coarse copy of this same stone, as what it collides with.
  const hull = shaped(2, false, 0);
  // What a press has to land on to pick it up: this same rock at a coarser grain.
  const picked = shaped(Math.round(5 + radius * 7), true, 0);
  const pick = { position: picked.getAttribute("position").array as Float32Array, index: (picked.index as THREE.BufferAttribute).array };
  return { geometry, furGeometry, hull: hull.getAttribute("position").array as Float32Array, radius, pick };
}

function Stone({ spec, materials, shells, sprigs, gravity, quality }: { spec: StoneSpec; materials: { rock: THREE.Material; fur: THREE.Material; sprig: THREE.Material; mirrored: THREE.Material; bug: THREE.Material }; shells: number; sprigs: number; gravity: { current: number }; quality: number }) {
  const built = useMemo(() => buildStone(spec, quality), [spec, quality]);
  const body = useRef<RapierRigidBody>(null);
  // A rock round the far side of the cliff is not there to be picked up, whatever the ray says.
  const { rapier, world } = useRapier();
  const behindCliff = useMemo(() => new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), [rapier]);
  const grab = useGrabRigidBody(body, built.radius * 1.15, undefined, built.pick, (ray, distance) => {
    behindCliff.origin.x = ray.origin.x;
    behindCliff.origin.y = ray.origin.y;
    behindCliff.origin.z = ray.origin.z;
    behindCliff.dir.x = ray.direction.x;
    behindCliff.dir.y = ray.direction.y;
    behindCliff.dir.z = ray.direction.z;
    return world.castRay(behindCliff, distance, true, rapier.QueryFilterFlags.ONLY_FIXED) !== null;
  });

  const fur = useMemo(() => {
    const mesh = new THREE.InstancedMesh(built.furGeometry, materials.fur, shells);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < shells; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.layers.set(NOT_REFLECTED);
    return mesh;
  }, [built, materials.fur, shells]);

  useEffect(
    () => () => {
      fur.dispose();
      built.geometry.dispose();
      built.furGeometry.dispose();
    },
    [fur, built]
  );

  const camera = useThree((three) => three.camera);
  const fibres = useRef<{ geometry: THREE.InstancedBufferGeometry; made: number } | null>(null);

  // Moss grows on whatever faces up now, and dies back slowly on whatever has been turned under.
  const heldGravity = useRef(1);
  const rouse = useRef(0);
  const pusher = useMemo(() => ({ x: 0, y: 0, z: 0, reach: built.radius + 0.5 }), [built]);
  useEffect(() => () => void pushers.delete(pusher), [pusher]);
  const floating = useMemo(() => {
    const hover = makeHover(lehmer(spec.seed * 97 + 5));
    // The big ones are the heavy ones, and lift only a little.
    const share = (hover.height - 0.75) / 1.5;
    hover.height += (0.5 + share * 0.25 - hover.height) * smooth(0.45, 0.85, Math.max(...spec.size));
    if (spec.lift) hover.height = spec.lift;
    return hover;
  }, [spec]);
  useFrame((_, rawDelta) => {
    const rigid = body.current;
    if (!rigid) return;
    // The slider, down through zero and into reverse, where the stone stops being moved by gravity at all and hovers.
    if (gravity.current !== heldGravity.current) {
      heldGravity.current = gravity.current;
      rigid.setGravityScale(Math.max(0, gravity.current), true);
      if (gravity.current >= 0) floating.ceiling = null;
      // Afloat, it only ever turns slowly about its own upright. Brushing a neighbour must not send it tumbling.
      rigid.setEnabledRotations(gravity.current >= 0, true, gravity.current >= 0, true);
      rouse.current = 1.2;
    }
    // A sleeping rock can drop straight back off, even when woken, so it keeps being woken and is given a nudge the new way.
    rouse.current = Math.max(0, rouse.current - rawDelta);
    if (rouse.current > 0 && gravity.current > 0 && rigid.isSleeping()) {
      rigid.wakeUp();
      rigid.applyImpulse({ x: 0, y: -rigid.mass() * 0.08, z: 0 }, true);
    }
    if (gravity.current < 0 && !grab.current.held) hoverBody(rigid, floating, gravity.current, performance.now() / 1000);
    // Moving, it can hit small rocks that have come to rest in the air, so it wakes them as it comes.
    if (gravity.current < 0) {
      const v = rigid.linvel();
      const at = rigid.translation();
      if (v.x * v.x + v.y * v.y + v.z * v.z > 0.04) {
        pusher.x = at.x;
        pusher.y = at.y;
        pusher.z = at.z;
        pushers.add(pusher);
      } else pushers.delete(pusher);
    } else pushers.delete(pusher);
    const stood = fibres.current;
    if (stood) {
      // Far off, fewer fibres, and the stone's own fur carries the colour.
      const at = rigid.translation();
      const distance = Math.hypot(at.x - camera.position.x, at.y - camera.position.y, at.z - camera.position.z);
      stood.geometry.instanceCount = Math.max(0, Math.floor(stood.made * Math.min(1, Math.pow(7 / Math.max(distance, 1), 1.6))));
    }
  });

  // The smaller stones add little to a reflection for what they would cost in it.
  const rockMesh = useRef<THREE.Mesh>(null);
  useEffect(() => {
    if (built.radius < 0.45) rockMesh.current?.layers.set(NOT_REFLECTED);
  }, [built]);
  // Separate fibres over all its moss, which is what gives a close boulder its soft edge.
  const shoots = useMemo(() => {
    if (sprigs === 0 || built.radius < 0.1) return null;
    const { geometry, made } = stoneFibreGeometry(built.geometry, Math.round(Math.max(120, sprigs * Math.min(1, (built.radius * built.radius) / 1.4) * (spec.lift ? 3 : 1))), spec.seed);
    const mesh = new THREE.Mesh(geometry, materials.sprig);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.layers.set(NOT_REFLECTED);
    return { mesh, geometry, made };
  }, [built, materials.sprig, spec, sprigs]);
  fibres.current = shoots;
  useEffect(() => () => shoots?.geometry.dispose(), [shoots]);

  const lastKnock = useRef(0);
  const knock = () => {
    const rigid = body.current;
    if (!rigid) return;
    const v = rigid.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    const now = performance.now();
    if (speed < 0.7 || now - lastKnock.current < 90) return;
    lastKnock.current = now;
    // Quiet once it has gone over the edge and landed far below.
    const far = rigid.translation().y < -30 ? 0.22 : 1;
    sound.play("thud", { size: Math.min(1, built.radius), gain: Math.min(1, speed / 6) * far, pan: rigid.translation().x / 16 });
    if (speed > 2.5) sound.play("crack", { gain: Math.min(0.5, speed / 18) * far });
  };

  return (
    <RigidBody ref={body} ccd onCollisionEnter={knock} gravityScale={Math.max(0, gravity.current)} colliders={false} position={spec.position} rotation={[0, spec.turn, 0]} linearDamping={0.15} angularDamping={0.4} friction={1.1} restitution={0.05} canSleep>
      <ConvexHullCollider args={[built.hull]} />
      <mesh ref={rockMesh} geometry={built.geometry} material={materials.rock} castShadow={built.radius > 0.28} receiveShadow />
      {shoots ? null : <primitive object={fur} />}
      {built.radius >= 0.45 ? <mesh geometry={built.furGeometry} material={materials.mirrored} ref={(mesh) => mesh?.layers.set(ONLY_REFLECTED)} /> : null}
      {shoots ? <primitive object={shoots.mesh} /> : null}
      {sprigs > 0 && built.radius > 0.55 ? <StoneBugs surface={built.geometry} count={Math.round(14 + built.radius * built.radius * 34)} material={materials.bug} seed={spec.seed} /> : null}
    </RigidBody>
  );
}

function Stones({ shared, shells, sprigs, gravity, quality }: { shared: Shared; shells: number; sprigs: number; gravity: { current: number }; quality: number }) {
  const { assets, sunDir, rain: rainLevel } = shared;
  const specs = useMemo(layoutStones, []);
  const materials = useMemo(() => {
    const local = varying(positionGeometry) as any;
    const normal = varying(normalGeometry) as any;
    const amount = varying(attribute("aMoss", "float")) as any;
    // Planes chosen by whichever way the surface faces, so strands stand straight all round a stone.
    const weight = abs(normal) as any;
    const planar = mix(mix(local.xz, local.zy.add(0.37), smoothstep(0.5, 0.56, weight.x)), local.xy.add(0.71), smoothstep(0.55, 0.62, weight.z)).mul(4.4) as any;

    const rock = new THREE.MeshStandardNodeMaterial({ roughness: 0.86 });
    // The photograph projected along all three axes, each fading in where the surface faces it, so that no seam shows.
    const blend = (pow as any)(abs(normal), vec3(6, 6, 6)) as any;
    const weights = blend.div(blend.x.add(blend.y).add(blend.z)) as any;
    const across = 0.62 as number;
    const fromX = (texture(assets.stoneDiffuse, local.zy.mul(across).add(0.37)) as any).rgb as any;
    const fromY = (texture(assets.stoneDiffuse, local.xz.mul(across)) as any).rgb as any;
    const fromZ = (texture(assets.stoneDiffuse, local.xy.mul(across).add(0.71)) as any).rgb as any;
    const scan = fromX.mul(weights.x).add(fromY.mul(weights.y)).add(fromZ.mul(weights.z)) as any;
    const cavity = varying(attribute("aCavity", "float")) as any;
    const fine = (texture(assets.stoneDiffuse, local.xz.mul(across * 3.1).add(local.y.mul(0.9))) as any).rgb as any;
    const shaded = scan.mul(mix(float(1), float(0.3), cavity)) as any;
    // Green under where the moss is, worked out from which way the stone faces now.
    // Exactly where the fibres stand, and only while that side faces up.
    const undergrowth = smoothstep(0.2, 0.42, varying(attribute("aRockMoss", "float"))).mul(smoothstep(-0.25, 0.15, normalWorld.y)) as any;
    // Dark under the fibres, and no image here, so nothing on the stone repeats.
    // From further off it comes up to the colour of the fibres standing on it, so that they do not glitter against the dark.
    const fromLens = smoothstep(1.5, 6, cameraPosition.sub(positionWorld).length()) as any;
    const stoneBed = mossBed(assets, planar.div(4.4));
    rock.colorNode = mix(shaded, stoneBed.colour.mul(mix(float(0.55), float(0.85), fromLens)), undergrowth) as any;
    rock.roughnessNode = mix(float(0.96), float(0.84), rainLevel) as any;
    rock.normalNode = bumpMap(luminance(scan).mul(0.8).add(luminance(fine).mul(0.25)).add(stoneBed.height.mul(undergrowth).mul(1.4)), float(1.6)) as any;

    const fur = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, alphaTest: 0.5 });
    const shellCount = float(shells);
    const level = varying(float(instanceIndex).add(1).div(shellCount)) as any;
    const raw = attribute("aMoss", "float") as any;
    fur.positionNode = positionLocal.add(normalGeometry.mul(raw.mul(raw).mul(0.008).mul(float(instanceIndex).add(1).div(shellCount))));
    const strand = (texture(assets.mossHeight, planar.mul(0.2)) as any).r as any;
    const reach = strand.mul(smoothstep(0.05, 0.5, amount)) as any;
    fur.opacityNode = smoothstep(level.mul(0.86), level.mul(0.86).add(0.05), reach) as any;
    const tones = mossColour(level, (texture(assets.mossDiffuse, planar.mul(0.18)) as any).rgb, sunDir, normal);
    fur.colorNode = tones.colour.mul(0.3) as any;
    fur.emissiveNode = tones.glow.mul(0.4) as any;

    const sprig = stoneFibreMaterial(sunDir);
    const mirrored = new THREE.MeshStandardNodeMaterial({ alphaTest: 0.5, roughness: 1, metalness: 0 });
    mirrored.opacityNode = smoothstep(0.2, 0.42, amount) as any;
    mirrored.colorNode = mix(tslColor("#2a5016"), tslColor("#6a8a26"), mx_noise_float(local.mul(3.1)).mul(0.5).add(0.5)) as any;
    return { rock, fur, sprig, mirrored, bug: bugMaterial() };
  }, [assets, sunDir, shells, rainLevel]);

  useEffect(
    () => () => {
      materials.rock.dispose();
      materials.fur.dispose();
      materials.sprig.dispose();
      materials.bug.dispose();
      materials.mirrored.dispose();
    },
    [materials]
  );

  return (
    <>
      {specs.map((spec, index) => (
        <Stone key={index} spec={spec} materials={materials} shells={shells} sprigs={sprigs} gravity={gravity} quality={quality} />
      ))}
    </>
  );
}

// What has found a hold on the rock: ferns along the shelf, and a few old pines leaning out over the drop.
function Plants({ extra, saplingCount }: { extra: number; saplingCount: number }) {
  const { pines, saplings } = useMemo(() => {
    const rand = lehmer(811);
    const matrix = new THREE.Matrix4();
    const point = new THREE.Vector3();

    const buildPine = (whorls: number, sprays: number, tufts: number) => {
      const parts: number[] = [];
      const normals: number[] = [];
      const needles: number[] = [];
      const shades: number[] = [];
      // Every needle is lit as part of the whole bough, so that the tree shades as a soft mass and not as glitter.
      const needleAt = (a: number[], b: number[], c: number[], normal: number[], shade: number) => {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const facing = (uy * vz - uz * vy) * normal[0] + (uz * vx - ux * vz) * normal[1] + (ux * vy - uy * vx) * normal[2];
        const [second, third] = facing >= 0 ? [b, c] : [c, b];
        parts.push(...a, ...second, ...third);
        for (let k = 0; k < 3; k++) {
          normals.push(...normal);
          needles.push(1);
          shades.push(shade);
        }
      };
      for (let w = 0; w < whorls; w++) {
        const f = w / whorls;
        const y = 0.13 + Math.pow(f, 0.96) * 0.87;
        const boughs = 8 - Math.floor(f * 4);
        const whorlLong = 0.7 + rand() * 0.55;
        for (let b = 0; b < boughs; b++) {
          // The odd bough is missing or short, so the outline is not a clean cone.
          if (rand() < 0.1 * (1 - f)) continue;
          const turn = (b / boughs) * Math.PI * 2 + rand() * 1.2;
          const length = (0.3 * Math.pow(1 - f, 0.82) + 0.022) * whorlLong * (0.72 + rand() * 0.46);
          const droop = 0.1 + (1 - f) * 0.16;
          const c = Math.cos(turn);
          const n = Math.sin(turn);
          // Out and down from the trunk, and the tip lifting again, the way a spruce holds its branches.
          const atSpine = (t: number) => [c * length * t, y - droop * length * 2.4 * t * (1 - t * 0.62), n * length * t];
          for (let k = 0; k < sprays; k++) {
            const t0 = k / sprays;
            const t1 = (k + 1) / sprays;
            const a0 = atSpine(t0);
            const a1 = atSpine(t1);
            const width = length * 0.3 * (1 - t0 * 0.72) * (0.7 + rand() * 0.6);
            for (const side of [-1, 1]) {
              for (let tuft = 0; tuft < tufts; tuft++) {
                const m = (tuft + rand()) / tufts;
                const base = [a0[0] + (a1[0] - a0[0]) * m, a0[1] + (a1[1] - a0[1]) * m, a0[2] + (a1[2] - a0[2]) * m];
                const reach = width * (0.55 + rand() * 0.45);
                const forward = 0.5 * reach;
                const tip = [base[0] + c * forward - n * reach * side, base[1] - 0.008 - rand() * 0.02, base[2] + n * forward + c * reach * side];
                const thick = 0.0052;
                const out = [c * 0.72 + (rand() - 0.5) * 0.3, 0.62 + (rand() - 0.5) * 0.3, n * 0.72 + (rand() - 0.5) * 0.3];
                const size = Math.hypot(out[0], out[1], out[2]);
                needleAt([base[0] - c * thick, base[1], base[2] - n * thick], [base[0] + c * thick, base[1], base[2] + n * thick], tip, [out[0] / size, out[1] / size, out[2] / size], Math.min(1, (t0 + m / sprays) * 0.8 + rand() * 0.28));
              }
            }
            const spineWide = 0.0026 * (1 - t0);
            parts.push(a0[0] - n * spineWide, a0[1], a0[2] + c * spineWide, a0[0] + n * spineWide, a0[1], a0[2] - c * spineWide, a1[0], a1[1], a1[2]);
            for (let v = 0; v < 3; v++) {
              normals.push(0, 1, 0);
              needles.push(0);
              shades.push(0);
            }
          }
        }
      }
      // Flared at the root and tapering to nothing, with enough sides to hold the bark.
      const trunk = new THREE.CylinderGeometry(0.003, 0.03, 1, 12, 8);
      trunk.translate(0, 0.5, 0);
      const flat = trunk.toNonIndexed();
      const trunkPosition = flat.getAttribute("position");
      const trunkNormal = flat.getAttribute("normal");
      for (let i = 0; i < trunkPosition.count; i++) {
        const py = trunkPosition.getY(i);
        const flare = 1 + Math.pow(Math.max(0, 1 - py / 0.07), 2) * 0.9;
        parts.push(trunkPosition.getX(i) * flare, py, trunkPosition.getZ(i) * flare);
        normals.push(trunkNormal.getX(i), trunkNormal.getY(i), trunkNormal.getZ(i));
        needles.push(0);
        shades.push(0);
      }
      const pineGeometry = new THREE.BufferGeometry();
      pineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(parts, 3));
      pineGeometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      pineGeometry.setAttribute("aNeedle", new THREE.Float32BufferAttribute(needles, 1));
      pineGeometry.setAttribute("aShade", new THREE.Float32BufferAttribute(shades, 1));
      return pineGeometry;
    };
    const pineGeometry = buildPine(40, 8, 3);
    const pineMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, side: THREE.DoubleSide });
    const needle = attribute("aNeedle", "float") as any;
    const shade = attribute("aShade", "float") as any;
    const up = positionGeometry.y as any;
    // Black in among the boughs and fresh at their tips, with each tree a little its own colour.
    const treeTone = fract(sin(float(instanceIndex).mul(12.9898)).mul(43758.5453)) as any;
    const foliage = mix(mix(tslColor("#07130d"), tslColor("#1f4429"), smoothstep(0, 0.55, shade)), mix(tslColor("#2f5a30"), tslColor("#4f7a3c"), treeTone), smoothstep(0.55, 1, shade)) as any;
    const bark = mix(tslColor("#17100b"), tslColor("#4b3729"), sin(up.mul(150).add(sin(positionGeometry.x.mul(420)).mul(2))).mul(0.5).add(0.5)) as any;
    pineMaterial.colorNode = mix(bark, foliage.mul(treeTone.mul(0.34).add(0.82)).mul(smoothstep(0, 0.7, up).mul(0.3).add(0.8)), needle) as any;
    const lean = sin(time.mul(0.9).add(positionWorld.x)).mul(0.012).mul(up).mul(up) as any;
    pineMaterial.positionNode = positionLocal.add(vec3(lean, 0, lean.mul(0.7)));
    const stands = [
      [12, SHELF_V - 2.3, 11],
      [17, SHELF_V - 2, 15],
      [6.4, 4.1, 8],
      [24, 4, 12]
    ];
    // And young ones all over the cliff, wherever a seed got a hold.
    for (let i = 0; i < extra; i++) {
      const spot = holdingSpot(rand, 220);
      // Nothing tall right in front of the lens.
      if (poolAt(spot.u, spot.v, 1.5) > 0 || (spot.u < 8 && spot.v < 14)) continue;
      stands.push([spot.u, spot.v, 3 + rand() * rand() * 11]);
    }
    const pines = new THREE.InstancedMesh(pineGeometry, pineMaterial, stands.length);
    stands.forEach(([u, v, size], i) => {
      surfaceAt(u, v, point);
      matrix.makeRotationY(rand() * 6.28);
      const girth = 0.85 + rand() * 0.32;
      matrix.scale(new THREE.Vector3(size * girth, size, size * girth));
      matrix.setPosition(point.x, point.y - 0.1, point.z);
      pines.setMatrixAt(i, matrix);
    });
    pines.castShadow = true;
    pines.receiveShadow = true;
    pines.frustumCulled = false;

    // Baby trees, no taller than a person and mostly far shorter, seeded all along the shelf and the ledges.
    const saplingStands: number[][] = [];
    for (let i = 0; i < saplingCount * 3 && saplingStands.length < saplingCount; i++) {
      const spot = holdingSpot(rand, 110);
      if (poolAt(spot.u, spot.v, 1.3) > 0 || (spot.u < -7 && spot.v < 1 && spot.v > SHELF_V - 2.4)) continue;
      saplingStands.push([spot.u, spot.v, 0.32 + rand() * rand() * 1.5]);
    }
    const saplings = new THREE.InstancedMesh(buildPine(12, 5, 2), pineMaterial, Math.max(1, saplingStands.length));
    saplingStands.forEach(([u, v, size], i) => {
      surfaceAt(u, v, point);
      matrix.makeRotationY(rand() * 6.28);
      matrix.scale(new THREE.Vector3(size, size, size));
      matrix.setPosition(point.x, point.y - 0.02, point.z);
      saplings.setMatrixAt(i, matrix);
    });
    saplings.count = saplingStands.length;
    saplings.receiveShadow = true;
    saplings.frustumCulled = false;
    saplings.layers.set(NOT_REFLECTED);
    return { pines, saplings };
  }, [extra, saplingCount]);

  useEffect(
    () => () => {
      for (const mesh of [pines, saplings]) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        mesh.dispose();
      }
    },
    [pines, saplings]
  );

  return (
    <>
      <primitive object={pines} />
      <primitive object={saplings} />
    </>
  );
}

// Fine red-capped stalks standing out of the moss, wherever the moss under them is thick.
function Sporophytes({ field, count }: { field: MossField; count: number }) {
  const mesh = useMemo(() => {
    const stalk = new THREE.CylinderGeometry(0.0018, 0.003, 1, 4);
    stalk.translate(0, 0.5, 0);
    const cap = new THREE.SphereGeometry(0.008, 6, 5);
    cap.scale(0.8, 1.5, 0.8);
    cap.translate(0, 1, 0);
    const position = [...(stalk.toNonIndexed().getAttribute("position").array as Float32Array), ...(cap.toNonIndexed().getAttribute("position").array as Float32Array)];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    geometry.computeVertexNormals();
    const rand = lehmer(917);
    const foot = new Float32Array(count * 4);
    const map = new Float32Array(count * 2);
    const point = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const u = (rand() - 0.5) * (FIELD_SIZE - 1);
      const v = (rand() - 0.5) * (FIELD_SIZE - 1);
      surfaceAt(u, v, point);
      foot.set([point.x, point.y, point.z, 0.045 + rand() * 0.05], i * 4);
      map.set([u / FIELD_SIZE + 0.5, v / FIELD_SIZE + 0.5], i * 2);
    }
    geometry.setAttribute("aFoot", new THREE.InstancedBufferAttribute(foot, 4));
    geometry.setAttribute("aMap", new THREE.InstancedBufferAttribute(map, 2));
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.55 });
    const at = attribute("aFoot", "vec4") as any;
    const thick = (texture(field.texture, attribute("aMap", "vec2")) as any).level(0).r as any;
    const up = smoothstep(0.82, 1, thick) as any;
    const bend = sin(time.mul(1.7).add(at.x.mul(3)).add(at.z)).mul(positionGeometry.y).mul(0.012) as any;
    const isCap = smoothstep(0.93, 0.97, positionGeometry.y) as any;
    material.colorNode = mix(tslColor("#a9ab50"), tslColor("#8c3a22"), isCap) as any;
    const stem = positionGeometry as any;
    material.positionNode = vec3(stem.x.mul(up).add(bend).add(at.x), stem.y.mul(at.w).mul(up).add(at.y), stem.z.mul(up).add(at.z)) as any;
    const instanced = new THREE.InstancedMesh(geometry, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) instanced.setMatrixAt(i, identity);
    instanced.frustumCulled = false;
    instanced.receiveShadow = true;
    return instanced;
  }, [field, count]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    },
    [mesh]
  );
  return <primitive object={mesh} />;
}

function Fireflies({ strength, count }: { strength: number; count: number }) {
  const level = useMemo(() => uniform(0), []);
  const mesh = useMemo(() => {
    const dot1 = new THREE.SphereGeometry(0.026, 6, 5);
    const rand = lehmer(6607);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seed.set([(rand() - 0.5) * 24 + 2, 0.2 + rand() * 3.4, rand() * 8 - 2, rand() * 40], i * 4);
    dot1.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 4));
    const material = new THREE.MeshBasicNodeMaterial();
    const at = attribute("aSeed", "vec4") as any;
    const wander = vec3(sin(time.mul(0.31).add(at.w)).mul(1.1).add(sin(time.mul(0.77).add(at.w.mul(2))).mul(0.3)), sin(time.mul(0.47).add(at.w.mul(3))).mul(0.42), sin(time.mul(0.27).add(at.w.mul(1.7))).mul(1.1)) as any;
    const blink = smoothstep(0.1, 0.8, sin(time.mul(1.4).add(at.w)).mul(0.5).add(0.5)) as any;
    // Unlit, a firefly is nothing at all, rather than a black dot against the sky.
    material.positionNode = positionGeometry.mul(level).mul(blink).add(at.xyz).add(wander) as any;
    material.colorNode = vec3(2.8, 5.2, 0.9).mul(blink).mul(level) as any;
    const instanced = new THREE.InstancedMesh(dot1, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) instanced.setMatrixAt(i, identity);
    instanced.frustumCulled = false;
    return instanced;
  }, [count, level]);
  useEffect(() => {
    level.value = strength;
    mesh.visible = strength > 0;
  }, [level, strength, mesh]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    },
    [mesh]
  );
  return <primitive object={mesh} />;
}

function Clearing({ hour, tile, assets }: { hour: Hour; tile: THREE.DataTexture; assets: MossAssets }) {
  const { tier } = useQuality();
  const camera = useThree((state) => state.camera);
  const rain = useSettingRef<number>("rain");
  const gravity = useSettingRef<number>("gravity");

  const field = useMemo(() => new MossField(), []);
  const rainLevel = useMemo(() => uniform(rain.current), []); // eslint-disable-line react-hooks/exhaustive-deps
  const sky = useMemo(() => createSky(), []);
  const water = useMemo(() => createWater(rainLevel, sky, tier !== "low"), [rainLevel, sky, tier]);
  const sunDir = useMemo(() => uniform(new THREE.Vector3(0, 1, 0)), []);
  const bake = useMemo(() => bakeMoss(FIELD_SIZE), []);
  useEffect(
    () => () => {
      bake.surface.dispose();
      bake.facing.dispose();
      bake.map.dispose();
      bake.kinds.dispose();
    },
    [bake]
  );
  const shared = useMemo<Shared>(() => ({ assets, field, tile, sunDir, water, rain: rainLevel, bake }), [assets, field, tile, sunDir, water, rainLevel, bake]);
  const fiberLayers = useMemo(() => FIBER_LAYERS[tier], [tier]);
  const sheet = useRef<THREE.Mesh>(null);

  useEffect(() => {
    sunDir.value.set(...hour.sky.sunDirection).normalize();
  }, [sunDir, hour]);
  useEffect(() => () => field.dispose(), [field]);
  useEffect(() => sky.setPalette(hour.sky), [sky, hour]);
  useEffect(() => water.limit(camera), [water, camera]);

  useFrame(() => {
    rainLevel.value = rain.current;
  });

  // The sounds of the place: rain, wind over the edge, birds below, crickets when it gets dark.
  useMusic("/codevember/music/cinematic-uplifting.mp3", 0.41);
  const rainBed = useBed("rain", rain.current * 0.5);
  useBed("wind", 0.2);
  useBed("crickets", hour.flies * 0.3);
  useEvery(1.5, 6, () => sound.play("chirp", { gain: 0.5, pan: Math.random() * 1.6 - 0.6, pitch: 0.8 + Math.random() * 0.5 }));
  useEvery(8, 22, () => sound.play("caw", { gain: 0.22, pan: Math.random() * 1.2 - 0.2, pitch: 0.85 + Math.random() * 0.3 }));
  useEvery(0.7, 2.8, () => {
    if (rain.current > 0.03) sound.play(Math.random() < 0.4 ? "plop" : "drip", { gain: 0.25 + rain.current * 0.3, pan: Math.random() * 1.6 - 0.8, pitch: 0.75 + Math.random() * 0.7 });
  });
  const heard = useRef(-1);
  useFrame(() => {
    if (Math.abs(heard.current - rain.current) > 0.01) {
      heard.current = rain.current;
      rainBed.current?.level(rain.current * 0.5);
    }
  });

  const shells = tier === "low" ? 5 : 3;
  const stoneShells = tier === "high" ? 7 : tier === "medium" ? 5 : 3;

  return (
    <>
      <Physics gravity={[0, -9.81, 0]}>
        <Ground shared={shared} shells={shells} sheet={sheet} detail={tier === "high" ? 540 : tier === "medium" ? 340 : 160} />
        <Stones shared={shared} shells={stoneShells} sprigs={tier === "high" ? 70000 : tier === "medium" ? 36000 : 9000} gravity={gravity} quality={tier === "high" ? 1 : tier === "medium" ? 0.55 : 0.28} />
        <ShelfDeer count={tier === "low" ? 4 : 9} gravity={gravity} />
        <Pebbles assets={assets} gravity={gravity} loose={tier === "high" ? 520 : tier === "medium" ? 300 : 100} piles={tier === "high" ? 14 : tier === "medium" ? 8 : 3} />
      </Physics>
      {fiberLayers.length ? <MossFibers bake={bake} field={field} assets={assets} sunDir={sunDir} fieldSize={FIELD_SIZE} cliffTile={CLIFF_TILE} layers={fiberLayers} bugCell={tier === "low" ? 0 : tier === "medium" ? 0.3 : 0.22} /> : null}
      <Sporophytes field={field} count={tier === "high" ? 4000 : tier === "medium" ? 2500 : 700} />
      <Grit assets={assets} gravity={gravity} count={tier === "high" ? 9000 : tier === "medium" ? 3500 : 1500} detail={1} smallest={0.011} spread={4.5} seed={70123} />
      <Grit assets={assets} gravity={gravity} count={tier === "high" ? 45000 : tier === "medium" ? 20000 : 7000} detail={0} smallest={0.005} spread={1.6} seed={40961} />
      <Rain amount={rain} strength={rainLevel} count={tier === "high" ? 24000 : tier === "medium" ? 15000 : 4000} />
      <Splashes strength={rainLevel} count={tier === "high" ? 500 : tier === "medium" ? 260 : 80} />
      <Fireflies strength={hour.flies} count={tier === "low" ? 40 : 110} />
    </>
  );
}

const SOFT_ZONE = 2.3;
const NEAREST = 0.55;
const moved = new THREE.Vector3();

// The valley is a long way off, so this day needs a longer view than the others.
function LongView() {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  useEffect(() => {
    const { near, far } = camera;
    camera.near = 0.1;
    camera.far = 3200;
    camera.layers.enable(NOT_REFLECTED);
    camera.updateProjectionMatrix();
    return () => {
      camera.near = near;
      camera.far = far;
      camera.layers.disable(NOT_REFLECTED);
      camera.updateProjectionMatrix();
    };
  }, [camera]);
  // Orbiting, zooming and flying all slow against the rock and slide along it. Nothing here ever moves the camera by a
  // distance: it only ever sets a speed, and that speed and its direction are both eased, so there is nothing to jump.
  const away = useMemo(() => ({ wanted: new THREE.Vector3(), smooth: new THREE.Vector3(0, 0, 1), clearance: 10, speed: 0, v: null as number | null, last: new THREE.Vector3(Infinity, 0, 0) }), []);
  const blur = useSettingRef<number>("focus");
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    focusBlur.value = blur.current;
    if (away.speed < 0.001 && camera.position.equals(away.last)) return;
    const clearance = softClearance(camera.position, away.wanted, away);
    if (away.last.x === Infinity) {
      away.clearance = clearance;
      away.smooth.copy(away.wanted);
      away.last.copy(camera.position);
    }
    away.clearance += (clearance - away.clearance) * (1 - Math.exp(-delta * 16));
    away.smooth.lerp(away.wanted, 1 - Math.exp(-delta * 5)).normalize();
    // Whatever moved the camera since last frame, the part of it heading into the rock fades out as the rock gets near.
    // It only ever takes speed away, so there is no distance to jump, and however hard it is pushed it cannot get through.
    moved.subVectors(camera.position, away.last);
    const into = -moved.dot(away.smooth);
    const ahead = Math.max(0, Math.min(1, away.clearance / SOFT_ZONE));
    const held = into > 0 ? into * (1 - ahead * ahead * (3 - 2 * ahead)) : 0;
    // And a slow drift back out if it ever does end up too close.
    const pressed = Math.max(0, NEAREST - away.clearance);
    away.speed += (Math.min(14, pressed * 2.4 + pressed * pressed * 3) - away.speed) * (1 - Math.exp(-delta * 6));
    // The point it orbits comes along, or flying would carry on into the rock without the camera, ever faster.
    const push = held + away.speed * delta;
    camera.position.addScaledVector(away.smooth, push);
    orbitPoint.current?.addScaledVector(away.smooth, push);
    camera.position.y = Math.max(camera.position.y, VALLEY_FLOOR + 40);
    away.last.copy(camera.position);
  });
  return null;
}

// Scattered wide over the valley at every distance, and at every height from below the shelf to well above it.
const FLOCKS: { centre: [number, number, number]; spread: number; size: number; share: number }[] = [
  { centre: [22, -14, 44], spread: 26, size: 0.3, share: 150 },
  { centre: [78, -22, 92], spread: 60, size: 0.5, share: 300 },
  { centre: [12, 6, 88], spread: 62, size: 0.46, share: 230 },
  { centre: [170, -8, 170], spread: 120, size: 0.9, share: 280 },
  { centre: [-30, 22, 120], spread: 90, size: 0.7, share: 190 },
  { centre: [110, 18, 60], spread: 70, size: 0.6, share: 170 }
];

// The page opens at normal gravity, holds there a moment, and then the rocks lift off. Touching the slider ends this.
const INTRO_WAIT = 5;
const INTRO_RAMP = 5;
function GravityIntro() {
  const store = useSettingsStore();
  const intro = useRef({ time: 0, last: store.get("gravity") as number, done: false });
  useFrame((_, rawDelta) => {
    const state = intro.current;
    if (state.done || scenePhase.current !== "live") return;
    if (store.get("gravity") !== state.last) {
      state.done = true;
      return;
    }
    state.time += Math.min(rawDelta, 1 / 20);
    const t = Math.max(0, Math.min(1, (state.time - INTRO_WAIT) / INTRO_RAMP));
    const next = Math.round((1 - 2 * t * t * (3 - 2 * t)) * 100) / 100;
    if (next !== state.last) {
      state.last = next;
      store.set("gravity", next);
    }
    if (t === 1) state.done = true;
  });
  return null;
}

function Scene() {
  const { tier } = useQuality();
  const hourKey = useSetting<string>("hour");
  const hour = HOURS[hourKey] ?? HOURS.dusk;
  useEffect(() => void airTint.value.set(hour.air), [hour]);
  useLook(hour.look);
  // Chosen once: dropping a quality tier later on should not fetch every texture again.
  const [assetTier] = useState(tier);
  const assets = useMossAssets(assetTier);
  const tile = useMemo(() => makeStrandTile(), []);
  useEffect(() => () => tile.dispose(), [tile]);
  const [sx, sy, sz] = hour.sky.sunDirection;
  const length = Math.hypot(sx, sy, sz);
  const position = useMemo<[number, number, number]>(() => [(sx / length) * SUN_DISTANCE, (sy / length) * SUN_DISTANCE, (sz / length) * SUN_DISTANCE], [sx, sy, sz, length]);
  const valleyLight = useMemo(() => ({ sun: hour.sky.sunDirection, sunColor: hour.valleySun, ambient: hour.valleyAmbient, air: hour.air, airAmount: hour.airAmount }), [hour]);
  return (
    <>
      <LongView />
      <GravityIntro />
      <SkyDome palette={hour.sky} radius={2900} />
      <StudioEnvironment
        key={hourKey}
        ambient={hour.ambient}
        intensity={1.7}
        boxes={[
          { position: [0, 11, 0], scale: [22, 0.2, 22], color: hour.fill, intensity: 2.6 },
          { position: [hour.sky.sunDirection[0] * 12, hour.sky.sunDirection[1] * 12 + 2, hour.sky.sunDirection[2] * 12], scale: [4, 4, 4], color: hour.light, intensity: 5 }
        ]}
      />
      <KeyLight position={position} target={[0, 0.5, 0]} color={hour.light} intensity={hour.intensity} angle={0.42} penumbra={0.5} shadowFar={110} />
      <Valley tile={tile} light={valleyLight} trees={tier === "high" ? 11000 : tier === "medium" ? 6000 : 2200} />
      <Plants extra={tier === "high" ? 30 : tier === "medium" ? 16 : 6} saplingCount={tier === "high" ? 150 : tier === "medium" ? 80 : 24} />
      <Brush assets={assets} density={tier === "high" ? 1 : tier === "medium" ? 0.5 : 0.16} />
      {FLOCKS.map(({ centre, spread, size, share }, index) => (
        <group key={index} ref={(group) => group?.traverse((child) => child.layers.set(NOT_REFLECTED))}>
          <Birds count={Math.round(share * (tier === "high" ? 1 : tier === "medium" ? 0.6 : 0.2))} centre={centre} spread={spread} size={size} groupSize={3} separation={2.8} />
        </group>
      ))}
      <Clearing hour={hour} tile={tile} assets={assets} />
    </>
  );
}

const moss: DayDefinition = {
  // Fur is expensive enough already. Its colour comes from the sun and sky, with occlusion in the creases.
  autoFloor: "medium",
  autoStart: "medium",
  passes: { bounce: false, haze: false, overlay: true, depthOfField: { range: 20, air: 0.24 } },
  camera: { position: [-10.6, 2.3, 1.1], target: [2.5, -0.5, 5.2], fov: 44 },
  phonePills: ["hour"],
  extents: { centre: [6, 2, 14], radius: 48, color: "#eaf3cf" },
  look: { background: "#10160c", gi: 3.4, ao: 1, aoRadius: 0.5, aoReach: 22, vignette: 0.5, grain: 0.012 },
  settings: {
    hour: {
      type: "choice",
      label: "Hour",
      value: "dusk",
      options: [
        { value: "dawn", label: "Dawn", swatch: ["#5b86b8", "#f2d3b0"] },
        { value: "noon", label: "Noon", swatch: ["#3f7fcf", "#dbe9ef"] },
        { value: "dusk", label: "Dusk", swatch: ["#32386f", "#f08a58"] },
        { value: "night", label: "Night", swatch: ["#050a1c", "#16244a"] }
      ]
    },
    rain: { type: "range", label: "Rain", min: 0, max: 1, step: 0.01, value: 0.35 },
    gravity: { type: "range", label: "Gravity", min: -1, max: 2, step: 0.01, value: 1 },
    focus: { type: "range", label: "Depth of field", min: 0, max: 4, step: 0.01, value: 3 }
  },
  notes: "The moss is hundreds of thousands of separate fibres placed by the GPU from baked maps of the cliff, with no repeating texture, in patches of tall grassy moss and short velvet and golden mosses. Rocks are Rapier rigid bodies on a collider of the sculpted cliff, with CC0 photo-scanned textures and plants. On High the water has true planar reflections, with a shadow-mapped sun, ambient occlusion, temporal anti-aliasing and depth of field.",
  hint: "Get close to the moss. Carry a stone, or send one over the edge. The rocks hang in the air until you turn gravity back up.",
  Scene
};

export default moss;
