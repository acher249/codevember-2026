"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  color as tslColor,
  cross,
  dot,
  float,
  fract,
  Fn,
  int,
  ivec2,
  max,
  mix,
  mx_noise_float,
  normalGeometry,
  normalize,
  positionGeometry,
  positionLocal,
  positionPrevious,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  texture,
  textureLoad,
  time,
  transformNormalToView,
  uniform,
  varying,
  vec3,
  vec4
} from "three/tsl";
import { useGrabbable } from "../shared/engine/controls";
import { Birds, createSky, SkyDome, type SkyPalette } from "../shared/engine/outdoors";
import { useQuality } from "../shared/engine/quality";
import { useSetting, useSettingAction, useSettingRef, useSettingsStore } from "../shared/engine/settings";
import { sound, useBed, useEvery, useMusic } from "../shared/engine/sound";
import { Haze, KeyLight, StudioEnvironment, StudioFloor } from "../shared/engine/studio";
import { useLook } from "../shared/engine/Stage";
import type { DayDefinition, Look } from "../shared/engine/types";
import { Flock, MAX_SHEEP } from "./flock";
import { edgeDistance, type Family, familyFor, FoldRig, groundHeight, MAX_FACETS, SHAPE_FAMILY } from "./forms";
import { paintBack, paintLand, PANEL_WIDTH, SHEET_WIDTH } from "./map";
import { FoldDial } from "./dial";
import { buildBack, buildRiver, buildTerrain, makeGrass, makeProps, RIVER_WIDTH } from "./sheet";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

type Hour = { sky: SkyPalette; look: Partial<Look>; light: string; intensity: number; position: [number, number, number]; floor: string; ambient: string; boxes: string; deep: string; shallow: string };

const HOURS: Record<string, Hour> = {
  morning: {
    sky: { zenith: "#3f7fcf", horizon: "#e3ecef", sun: "#fff1d0", cloudLit: "#ffffff", cloudShade: "#a9bfd6", sunDirection: [0.5, 0.62, 0.45], cloudCover: 0.45 },
    look: { exposure: 1, haze: 0.5, bloom: 0.16 },
    light: "#fff0d8",
    intensity: 5200,
    position: [20, 26, 16],
    floor: "#8fae62",
    ambient: "#8fb3d8",
    boxes: "#dbeeff",
    deep: "#0f5a7a",
    shallow: "#3fb4c4"
  },
  gold: {
    sky: { zenith: "#47618f", horizon: "#f6bd84", sun: "#ffc27a", cloudLit: "#ffd9b0", cloudShade: "#8d6a7f", sunDirection: [0.75, 0.2, 0.32], cloudCover: 0.5 },
    look: { exposure: 1, haze: 1, bloom: 0.26 },
    light: "#ffb672",
    intensity: 6400,
    position: [28, 11, 13],
    floor: "#a79a5a",
    ambient: "#5b6a92",
    boxes: "#ffcfa0",
    deep: "#143f63",
    shallow: "#4f93a8"
  },
  moon: {
    sky: { zenith: "#070d22", horizon: "#27395f", sun: "#cfdcff", cloudLit: "#4d5f8b", cloudShade: "#0c1329", sunDirection: [-0.5, 0.55, 0.4], cloudCover: 0.4 },
    look: { exposure: 1.2, haze: 1.2, bloom: 0.4 },
    light: "#a9c0ff",
    intensity: 2400,
    position: [-18, 22, 14],
    floor: "#1f3044",
    ambient: "#121b35",
    boxes: "#50679c",
    deep: "#06142c",
    shallow: "#1c3a60"
  }
};

const SHAPE_CYCLE = ["pleats", "facets", "plane", "wave", "box", "roll"];
const FLOCK_CENTRE: [number, number, number] = [0, 5.4, -1];
const SHEET_W = SHEET_WIDTH / 2;

// Feet at y = 0, nose along +x. aRig is (0 body, 1 head, 2 leg) and a phase.
function buildSheep() {
  const position: number[] = [];
  const normal: number[] = [];
  const color: number[] = [];
  const rig: number[] = [];
  const add = (geometry: THREE.BufferGeometry, hex: string, kind: number, phase: number) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    flat.computeVertexNormals();
    const shade = new THREE.Color(hex);
    const count = flat.getAttribute("position").count;
    position.push(...(flat.getAttribute("position").array as Float32Array));
    normal.push(...(flat.getAttribute("normal").array as Float32Array));
    for (let i = 0; i < count; i++) {
      color.push(shade.r, shade.g, shade.b);
      rig.push(kind, phase);
    }
  };
  const wool = new THREE.IcosahedronGeometry(1, 2);
  const stretch = wool.getAttribute("position");
  for (let i = 0; i < stretch.count; i++) {
    const bump = 1 + Math.sin(stretch.getX(i) * 11) * Math.sin(stretch.getY(i) * 12) * Math.sin(stretch.getZ(i) * 9) * 0.12;
    stretch.setXYZ(i, stretch.getX(i) * bump, stretch.getY(i) * bump, stretch.getZ(i) * bump);
  }
  wool.scale(0.12, 0.095, 0.09);
  wool.translate(0, 0.15, 0);
  add(wool, "#f6f1e6", 0, 0);
  const head = new THREE.IcosahedronGeometry(0.042, 1);
  head.scale(1.25, 1, 0.9);
  head.translate(0.135, 0.185, 0);
  add(head, "#23201d", 1, 0);
  for (const side of [-1, 1]) {
    const ear = new THREE.IcosahedronGeometry(0.018, 0);
    ear.scale(0.7, 0.5, 1.6);
    ear.translate(0.115, 0.208, side * 0.04);
    add(ear, "#23201d", 1, 0);
  }
  const legs = [
    [0.07, 0.05, 0],
    [0.07, -0.05, Math.PI],
    [-0.07, 0.05, Math.PI],
    [-0.07, -0.05, 0]
  ];
  for (const [x, z, phase] of legs) {
    const leg = new THREE.CylinderGeometry(0.012, 0.009, 0.095, 5);
    leg.translate(x, 0.0475, z);
    add(leg, "#23201d", 2, phase);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
  geometry.setAttribute("aRig", new THREE.Float32BufferAttribute(rig, 2));
  return geometry;
}

// A thrown sheep lands with a proper thump. The flock's own hops back onto the sheet go on all the time, so they stay faint and few.
let hoppedAt = 0;
const sheepLanded = (x: number, speed: number, flung: boolean) => {
  if (speed < 1.5) return;
  if (!flung) {
    const now = performance.now();
    if (now - hoppedAt < 700) return;
    hoppedAt = now;
  }
  sound.play("thud", { gain: flung ? Math.min(0.6, speed * 0.07) : 0.1, size: 0.3, pitch: 1.2, pan: x / 10 });
};

function Sheet({ sheepCount, hour }: { sheepCount: number; hour: Hour }) {
  const { tier } = useQuality();
  const camera = useThree((state) => state.camera);
  const shape = useSettingRef<string>("shape");
  const amount = useSettingRef<number>("amount");
  const breathe = useSettingRef<boolean>("breathe");
  const wind = useSettingRef<number>("wind");
  const cycle = useSettingRef<boolean>("cycle");
  const store = useSettingsStore();

  const rig = useMemo(() => new FoldRig(SHAPE_FAMILY[(shape.current as string) ?? "stair"] ?? "strip"), []); // eslint-disable-line react-hooks/exhaustive-deps
  const flock = useMemo(() => new Flock(rig), [rig]);
  flock.count = Math.min(MAX_SHEEP, sheepCount);
  flock.onLand = sheepLanded;

  // Six rows per facet: this frame's matrix and last frame's, for motion vectors.
  const facetState = useMemo(() => {
    const data = new Float32Array(MAX_FACETS * 6 * 4);
    const tex = new THREE.DataTexture(data, MAX_FACETS, 6, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return { data, tex };
  }, []);

  const uniforms = useMemo(
    () => ({
      wind: uniform(1),
      relief: uniform(1),
      rapids: uniform(1),
      deep: uniform(new THREE.Color()),
      shallow: uniform(new THREE.Color())
    }),
    []
  );
  const sky = useMemo(() => createSky(), []);
  useEffect(() => {
    sky.setPalette(hour.sky);
    uniforms.deep.value.set(hour.deep);
    uniforms.shallow.value.set(hour.shallow);
  }, [sky, hour, uniforms]);

  const land = useMemo(() => paintLand(), []);
  const back = useMemo(() => paintBack(), []);

  const materials = useMemo(() => {
    const id = int(attribute("aFacet", "float") as any) as any;
    const load = (row: number) => textureLoad(facetState.tex, ivec2(id, int(float(row)))) as any;
    const [r0, r1, r2, p0, p1, p2] = [0, 1, 2, 3, 4, 5].map(load);
    const place = (point: any) => {
      const p = vec4(point, 1);
      return vec3(dot(r0, p), dot(r1, p), dot(r2, p)) as any;
    };
    const placeBefore = (point: any) => {
      const p = vec4(point, 1);
      return vec3(dot(p0, p), dot(p1, p), dot(p2, p)) as any;
    };
    const turn = (direction: any) => vec3(dot(r0.xyz, direction), dot(r1.xyz, direction), dot(r2.xyz, direction)) as any;
    const relief = uniforms.relief as any;
    const squash = (point: any) => vec3(point.x, point.y.mul(relief), point.z) as any;
    const placed = (point: any) =>
      Fn(() => {
        (positionPrevious as any).assign(placeBefore(squash(positionPrevious)));
        return place(squash(point));
      })() as any;
    const geometryNormal = normalGeometry as any;
    const flatNormal = normalize(vec3(geometryNormal.x.mul(relief), geometryNormal.y, geometryNormal.z.mul(relief)));

    const dress = (material: any) => {
      material.positionNode = placed(positionGeometry);
      material.castShadowPositionNode = place(squash(positionGeometry));
      material.normalNode = transformNormalToView(varying(normalize(turn(flatNormal)))) as any;
      return material;
    };

    const landMaterial = dress(new THREE.MeshStandardNodeMaterial({ roughness: 0.9 }));
    landMaterial.colorNode = texture(land) as any;

    const paper = dress(new THREE.MeshStandardNodeMaterial({ roughness: 0.82 }));
    paper.colorNode = texture(back) as any;

    const props = dress(new THREE.MeshStandardNodeMaterial({ roughness: 0.82, vertexColors: true }));

    const grass = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, side: THREE.DoubleSide });
    const grassMap = texture(land, attribute("aMap", "vec2")) as any;
    const rise = positionGeometry.y as any;
    grass.colorNode = mix(grassMap.rgb.mul(0.46), grassMap.rgb.mul(1.14).add(vec3(0.03, 0.05, 0)), rise);
    // Each blade carries its foot and size. Bent on the flat sheet, so the wind still blows along the ground when a facet stands on end.
    const foot = attribute("aPlace", "vec4") as any;
    const spin = attribute("aSpin", "vec2") as any;
    const wide = positionGeometry.x.mul(foot.w).mul(0.24) as any;
    const gust = sin(foot.x.mul(1.7).add(time.mul(2.1))).add(sin(foot.z.mul(2.3).add(time.mul(1.3)))) as any;
    const sway = uniforms.wind.mul(rise).mul(rise).mul(gust) as any;
    grass.positionNode = Fn(() => {
      const blade = vec3(foot.x.add(wide.mul(spin.x)).add(sway.mul(0.022)), foot.y.add(rise.mul(foot.w)), foot.z.add(wide.mul(spin.y)).add(sway.mul(0.012)));
      (positionPrevious as any).assign(placeBefore(squash(blade)));
      return place(squash(blade));
    })() as any;
    grass.normalNode = transformNormalToView(varying(normalize(turn(normalGeometry)))) as any;

    // The river. Two layers of noise run down its length; their slope bends the normal.
    const water = new THREE.MeshStandardNodeMaterial({ roughness: 0.1, metalness: 0 });
    water.positionNode = Fn(() => {
      (positionPrevious as any).assign(placeBefore(positionPrevious));
      return place(positionGeometry);
    })() as any;
    water.castShadowPositionNode = place(positionGeometry);
    const flat = varying(positionGeometry) as any;
    const u = flat.x.add(SHEET_W) as any;
    const bend = sin(u.mul(0.62).add(1.1)).mul(1.25).add(sin(u.mul(1.7)).mul(0.34)).sub(0.3) as any;
    const across = flat.z.sub(bend).div(RIVER_WIDTH) as any;
    const wave = (s: any, d: any) => {
      const large = mx_noise_float(vec3(s.mul(2.2).sub(time.mul(1.15)), d.mul(1.5), time.mul(0.22))) as any;
      const fine = mx_noise_float(vec3(s.mul(7).sub(time.mul(2.7)), d.mul(3.4), time.mul(0.4))) as any;
      return large.mul(0.7).add(fine.mul(0.3)) as any;
    };
    const here = wave(u, across) as any;
    const slopeS = wave(u.add(0.05), across).sub(here).mul(0.42) as any;
    const slopeD = wave(u, across.add(0.12)).sub(here).mul(0.42) as any;
    const rowX = varying(r0.xyz) as any;
    const rowY = varying(r1.xyz) as any;
    const rowZ = varying(r2.xyz) as any;
    const flowNormal = normalize(vec3(slopeS.negate(), 1, slopeD.negate())) as any;
    const worldNormal = normalize(vec3(dot(rowX, flowNormal), dot(rowY, flowNormal), dot(rowZ, flowNormal))) as any;
    water.normalNode = transformNormalToView(worldNormal) as any;
    const toEye = normalize(cameraPosition.sub(positionWorld)) as any;
    const fresnel = pow(float(1).sub(max(dot(worldNormal, toEye), float(0))), float(4)).mul(0.92).add(0.08) as any;
    const mirrored = reflect(toEye.negate(), worldNormal) as any;
    const skyward = normalize(vec3(mirrored.x, abs(mirrored.y).add(0.02), mirrored.z)) as any;
    const banks = smoothstep(0.55, 1, abs(across)) as any;
    const streak = mx_noise_float(vec3(u.mul(5.5).sub(time.mul(1.9)), across.mul(4.5), time.mul(0.3))) as any;
    // White water where the river drops across a fold.
    const toCrease = abs(fract(u.div(PANEL_WIDTH)).sub(0.5)).mul(2) as any;
    const rapids = smoothstep(0.9, 1, toCrease).mul(uniforms.rapids) as any;
    const foam = smoothstep(0.42, 0.8, streak.add(banks.mul(0.75)).add(rapids.mul(0.7))) as any;
    water.colorNode = mix(mix(uniforms.deep, uniforms.shallow, banks.add(here.mul(0.5))), tslColor("#f2f7f6"), foam.mul(0.8)) as any;
    water.roughnessNode = mix(float(0.08), float(0.6), foam) as any;
    const glint = pow(max(dot(mirrored, sky.uniforms.sunDirection), float(0)), float(240)).mul(7) as any;
    water.emissiveNode = sky.paint(skyward).mul(fresnel).mul(float(1).sub(foam)).add((sky.uniforms.sun as any).mul(glint)) as any;

    const rod = new THREE.MeshStandardNodeMaterial({ metalness: 1, roughness: 0.28 });
    const hot = attribute("aHot", "float") as any;
    rod.colorNode = mix(tslColor("#d7b26a"), tslColor("#ffdc92"), hot) as any;
    rod.emissiveNode = vec3(1.9, 1.25, 0.42).mul(hot) as any;

    // Sheep are placed on the CPU. The legs and head move here, along each one's own axes.
    const sheep = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, vertexColors: true });
    const pose = attribute("aPose", "vec3") as any;
    const rigging = attribute("aRig", "vec2") as any;
    const axisX = attribute("aAxisX", "vec3") as any;
    const axisY = attribute("aAxisY", "vec3") as any;
    const axisZ = cross(axisX, axisY) as any;
    const isHead = smoothstep(0.5, 0.6, rigging.x).mul(float(1).sub(smoothstep(1.4, 1.5, rigging.x))) as any;
    const isLeg = smoothstep(1.5, 1.6, rigging.x) as any;
    const swing = sin(pose.x.add(rigging.y)).mul(pose.y).mul(0.55) as any;
    const hip = float(0.095).sub(positionGeometry.y) as any;
    const bob = abs(sin(pose.x)).mul(pose.y).mul(0.01).mul(float(1).sub(isLeg)) as any;
    const nibble = sin(time.mul(9).add(pose.x)).mul(0.005).mul(pose.z) as any;
    const dropHead = isHead.mul(pose.z.mul(-0.1).add(nibble)) as any;
    const liftX = isLeg.mul(hip).mul(swing).add(isHead.mul(pose.z).mul(0.025)) as any;
    const animated = positionLocal.add(axisX.mul(liftX)).add(axisY.mul(bob.add(dropHead))).add(axisZ.mul(0)) as any;
    sheep.positionNode = animated;
    sheep.castShadowPositionNode = animated;

    return { land: landMaterial, paper, props, grass, water, rod, sheep };
  }, [facetState, land, back, uniforms, sky]);

  const cell = tier === "high" ? 0.1 : tier === "medium" ? 0.14 : 0.2;
  const grassCount = tier === "high" ? 42000 : tier === "medium" ? 28000 : 8000;

  const built = useRef(new Map<string, { terrain: THREE.BufferGeometry; back: THREE.BufferGeometry; river: THREE.BufferGeometry }>());
  const geometryFor = (family: Family) => {
    const key = `${family.key}-${cell}`;
    let geometry = built.current.get(key);
    if (!geometry) {
      geometry = { terrain: buildTerrain(family, cell), back: buildBack(family), river: buildRiver(family) };
      built.current.set(key, geometry);
    }
    return geometry;
  };

  const grassData = useMemo(() => makeGrass(grassCount), [grassCount]);
  const grass = useMemo(() => {
    const blade = new THREE.BufferGeometry();
    blade.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.33, 0.45, 0, 0.33, 0.45, 0, -0.14, 0.8, 0, 0.14, 0.8, 0, 0, 1, 0]), 3));
    blade.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(Array(7).fill([0, 0.7, 0.7]).flat()), 3));
    blade.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6]);
    const mapUv = new Float32Array(grassData.count * 2);
    for (let i = 0; i < grassData.count; i++) {
      mapUv[i * 2] = (grassData.x[i] + SHEET_W) / SHEET_WIDTH;
      mapUv[i * 2 + 1] = 1 - (grassData.z[i] + 3.6) / 7.2;
    }
    blade.setAttribute("aMap", new THREE.InstancedBufferAttribute(mapUv, 2));
    blade.setAttribute("aFacet", new THREE.InstancedBufferAttribute(new Float32Array(grassData.count), 1));
    blade.setAttribute("aPlace", new THREE.InstancedBufferAttribute(new Float32Array(grassData.count * 4), 4));
    const spin = new Float32Array(grassData.count * 2);
    for (let i = 0; i < grassData.count; i++) {
      spin[i * 2] = Math.cos(grassData.turn[i]);
      spin[i * 2 + 1] = Math.sin(grassData.turn[i]);
    }
    blade.setAttribute("aSpin", new THREE.InstancedBufferAttribute(spin, 2));
    const mesh = new THREE.InstancedMesh(blade, materials.grass, grassData.count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < grassData.count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    return mesh;
  }, [grassData, materials.grass]);

  const propData = useMemo(() => makeProps(), []);
  const propGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(propData.position.length), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(propData.normal, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(propData.color, 3));
    geometry.setAttribute("aFacet", new THREE.BufferAttribute(new Float32Array(propData.position.length / 3), 1));
    return geometry;
  }, [propData]);

  const terrainMesh = useRef<THREE.Mesh>(null);
  const backMesh = useRef<THREE.Mesh>(null);
  const riverMesh = useRef<THREE.Mesh>(null);
  const propMesh = useRef<THREE.Mesh>(null);

  // Re-seats everything on the sheet for a family. Called only with the sheet lying flat, so nothing visibly jumps.
  const seat = (family: Family) => {
    const geometry = geometryFor(family);
    if (terrainMesh.current) terrainMesh.current.geometry = geometry.terrain;
    if (backMesh.current) backMesh.current.geometry = geometry.back;
    if (riverMesh.current) riverMesh.current.geometry = geometry.river;

    const ids = grass.geometry.getAttribute("aFacet") as THREE.InstancedBufferAttribute;
    const feet = grass.geometry.getAttribute("aPlace") as THREE.InstancedBufferAttribute;
    // A sample of the land and all that stands on it, which the rig keeps off the floor along with the paper.
    const guards: number[] = [];
    const sample = Math.ceil(grassData.count / 900);
    let hint = -1;
    for (let i = 0; i < grassData.count; i++) {
      const x = grassData.x[i];
      const z = grassData.z[i];
      hint = rig.locate(x, z, hint);
      const facet = family.facets[Math.max(0, hint)];
      // Mown short along each crease, so the creases can be seen and found.
      const mown = family.creases.length ? Math.min(1, Math.max(0, (edgeDistance(facet, x, z) - 0.05) * 7)) : 1;
      const height = groundHeight(facet, x, z);
      const blade = facet.growth > 0 && facet.upright ? grassData.scale[i] * mown : 0;
      feet.setXYZW(i, x, height, z, blade);
      ids.setX(i, facet.id);
      if (i % sample === 0) guards.push(facet.id, x, height + blade, z, blade > 0 ? 0.03 : 0);
    }
    feet.needsUpdate = true;
    ids.needsUpdate = true;

    const positions = propGeometry.getAttribute("position") as THREE.BufferAttribute;
    const propIds = propGeometry.getAttribute("aFacet") as THREE.BufferAttribute;
    for (const prop of propData.props) {
      const located = rig.locate(prop.x, prop.z);
      const facet = family.facets[Math.max(0, located)];
      const size = facet.growth > 0 && facet.upright ? 1 : 0;
      const y = groundHeight(facet, prop.x, prop.z) - 0.005;
      let top = 0;
      let reach = 0;
      for (let k = 0; k < prop.count; k++) {
        const source = (prop.start + k) * 3;
        top = Math.max(top, propData.position[source + 1]);
        reach = Math.max(reach, Math.hypot(propData.position[source], propData.position[source + 2]));
        positions.setXYZ(prop.start + k, prop.x + propData.position[source] * size, y + propData.position[source + 1] * size, prop.z + propData.position[source + 2] * size);
        propIds.setX(prop.start + k, facet.id);
      }
      if (size > 0) guards.push(facet.id, prop.x, y + top, prop.z, reach);
    }
    rig.guards = Float32Array.from(guards);
    positions.needsUpdate = true;
    propIds.needsUpdate = true;
    propGeometry.computeBoundingSphere();
    uniforms.rapids.value = family.key === "strip" ? 1 : 0;
  };

  // Rods along every crease that can be held. A single draw; only the matrices change.
  const rods = useMemo(() => {
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 8);
    cylinder.setAttribute("aHot", new THREE.InstancedBufferAttribute(new Float32Array(256), 1));
    const mesh = new THREE.InstancedMesh(cylinder, materials.rod, 256);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    return mesh;
  }, [materials.rod]);

  const sheepMesh = useMemo(() => {
    const geometry = buildSheep();
    geometry.setAttribute("aPose", new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHEEP * 3), 3));
    geometry.setAttribute("aAxisX", new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHEEP * 3), 3));
    geometry.setAttribute("aAxisY", new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHEEP * 3), 3));
    const mesh = new THREE.InstancedMesh(geometry, materials.sheep, MAX_SHEEP);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }, [materials.sheep]);

  useEffect(() => {
    rig.update(1 / 60, shape.current as string, amount.current, 0);
    seat(rig.family);
    flock.onFamilySwap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grass, cell]);

  useEffect(
    () => () => {
      for (const geometry of built.current.values()) {
        geometry.terrain.dispose();
        geometry.back.dispose();
        geometry.river.dispose();
      }
      built.current.clear();
      grass.geometry.dispose();
      grass.dispose();
    },
    [grass, cell]
  );

  useEffect(
    () => () => {
      Object.values(materials).forEach((material) => material.dispose());
      land.dispose();
      back.dispose();
      facetState.tex.dispose();
      propGeometry.dispose();
      rods.geometry.dispose();
      rods.dispose();
      sheepMesh.geometry.dispose();
      sheepMesh.dispose();
    },
    [materials, land, back, facetState, propGeometry, rods, sheepMesh]
  );

  const control = useRef({ clock: 0, heldSheep: -1, pending: null as null | { sheep: number } | { crease: number }, last: new THREE.Vector3(), cycleTimer: 0, coarse: false, shape: shape.current as string, creased: 0, foldedAt: 0 });
  useEffect(() => {
    control.current.coarse = window.matchMedia("(pointer: coarse)").matches;
  }, []);

  useSettingAction("flatten", () => {
    rig.smoothing = true;
  });

  useEvery(4, 12, () => {
    const a = Math.floor(Math.random() * flock.count) * 3;
    sound.play("bleat", { gain: 0.25 + Math.random() * 0.25, pitch: 0.85 + Math.random() * 0.4, pan: flock.world[a] / 10 });
  }, sheepCount > 0);

  useGrabbable({
    pick(ray) {
      const state = control.current;
      const { origin: o, direction: d } = ray;
      const crease = rig.pickCrease(o.x, o.y, o.z, d.x, d.y, d.z, state.coarse ? 0.024 : 0.0095);
      const sheep = flock.pick(o.x, o.y, o.z, d.x, d.y, d.z);
      if (sheep && (!crease || sheep.t < crease.t)) {
        const front = rig.raycast(o.x, o.y, o.z, d.x, d.y, d.z, sheep.t - 0.15);
        if (!front) {
          state.pending = { sheep: sheep.sheep };
          if (rig.held < 0) rig.hover = -1;
          return { distance: sheep.t, point: ray.at(sheep.t, new THREE.Vector3()) };
        }
      }
      if (crease) {
        state.pending = { crease: crease.crease };
        if (rig.held < 0) rig.hover = rig.family.creases[crease.crease].joint;
        return { distance: crease.t, point: new THREE.Vector3(crease.x, crease.y, crease.z) };
      }
      state.pending = null;
      if (rig.held < 0) rig.hover = -1;
      return null;
    },
    grab(point) {
      const state = control.current;
      state.last.copy(point);
      const pending = state.pending;
      if (!pending) return;
      if ("sheep" in pending) {
        state.heldSheep = pending.sheep;
        flock.hold(pending.sheep, point.x, point.y - 0.12, point.z);
        sound.play("bleat", { gain: 0.6, pitch: 1.15, pan: point.x / 10 });
      } else {
        rig.held = rig.family.nodes ? pending.crease : rig.family.creases[pending.crease].joint;
        rig.hover = rig.held;
        state.creased = 0;
        state.foldedAt = performance.now();
        sound.play("fold", { gain: 0.55, pan: point.x / 8 });
      }
    },
    drag(point) {
      const state = control.current;
      if (state.heldSheep >= 0) {
        flock.hold(state.heldSheep, point.x, point.y - 0.12, point.z);
        return;
      }
      if (rig.held < 0) return;
      const mx = point.x - state.last.x;
      const my = point.y - state.last.y;
      const mz = point.z - state.last.z;
      state.last.copy(point);
      // Paper crackles per distance dragged, so a faster pull crackles more often, and louder.
      state.creased += Math.hypot(mx, my, mz);
      const now = performance.now();
      if (state.creased > 0.4 && now - state.foldedAt > 110) {
        const speed = state.creased / ((now - state.foldedAt) / 1000);
        sound.play("fold", { gain: Math.min(0.85, 0.25 + speed * 0.07), pitch: 0.9 + Math.min(0.5, speed * 0.04), pan: point.x / 8 });
        state.creased = 0;
        state.foldedAt = now;
      }
      if (rig.family.nodes) {
        rig.dragNodes(rig.held, mx, my, mz);
      } else {
        const forward = camera.getWorldDirection(new THREE.Vector3());
        rig.dragJoint(rig.held, mx, my, mz, forward.x, forward.y, forward.z);
      }
    },
    release(velocity) {
      const state = control.current;
      if (state.heldSheep >= 0) {
        flock.drop(state.heldSheep, velocity.x, velocity.y, velocity.z);
        const thrown = velocity.length();
        if (thrown > 2.5) sound.play("bleat", { gain: Math.min(0.75, 0.35 + thrown * 0.04), pitch: 1.3, pan: flock.x[state.heldSheep] / 10 });
        state.heldSheep = -1;
      }
      rig.held = -1;
    }
  });

  const scratch = useMemo(() => ({ a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 } }), []);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const state = control.current;
    const holding = rig.held >= 0;
    if (breathe.current && !holding) state.clock += delta;
    uniforms.wind.value = wind.current;

    if (shape.current !== state.shape) {
      state.shape = shape.current as string;
      sound.play("whoosh", { gain: 0.7 });
      sound.play("fold", { gain: 0.35, pitch: 0.85 });
    }

    if (cycle.current && !holding) {
      const settled = rig.family === rig.wanted && rig.folded && rig.relief === rig.family.relief;
      if (settled) state.cycleTimer += delta;
      if (state.cycleTimer > 6) {
        state.cycleTimer = 0;
        const at = SHAPE_CYCLE.indexOf(shape.current as string);
        store.set("shape", SHAPE_CYCLE[(at + 1) % SHAPE_CYCLE.length]);
      }
    }

    if (rig.update(delta, shape.current as string, amount.current, state.clock)) {
      seat(rig.family);
      flock.onFamilySwap();
    }
    uniforms.relief.value = Math.max(0.02, rig.relief);

    const { data } = facetState;
    const facets = rig.family.facets.length;
    for (let f = 0; f < facets; f++) {
      const o = f * 12;
      for (let r = 0; r < 12; r++) {
        data[(Math.floor(r / 4) * MAX_FACETS + f) * 4 + (r % 4)] = rig.matrices[o + r];
        data[((Math.floor(r / 4) + 3) * MAX_FACETS + f) * 4 + (r % 4)] = rig.previous[o + r];
      }
    }
    facetState.tex.needsUpdate = true;

    // Creases.
    const { creases } = rig.family;
    const instance = rods.instanceMatrix.array as Float32Array;
    const hot = rods.geometry.getAttribute("aHot") as THREE.InstancedBufferAttribute;
    const active = rig.held >= 0 ? rig.held : rig.hover;
    const isDome = !!rig.family.nodes;
    const radius = isDome ? 0.018 : 0.026;
    const count = Math.min(creases.length, 256);
    for (let c = 0; c < count; c++) {
      const crease = creases[c];
      rig.toWorld(crease.facet, crease.a[0], 0, crease.a[1], scratch.a);
      rig.toWorld(crease.facet, crease.b[0], 0, crease.b[1], scratch.b);
      const dx = scratch.b.x - scratch.a.x;
      const dy = scratch.b.y - scratch.a.y;
      const dz = scratch.b.z - scratch.a.z;
      const length = Math.hypot(dx, dy, dz) || 1;
      const yx = dx / length;
      const yy = dy / length;
      const yz = dz / length;
      const helper = Math.abs(yy) > 0.9 ? 1 : 0;
      let xx = helper ? yy : -yz;
      let xy = helper ? -yx : 0;
      let xz = helper ? 0 : yx;
      if (!helper) {
        // Perpendicular in the horizontal plane.
        xx = yz;
        xy = 0;
        xz = -yx;
      }
      const xl = Math.hypot(xx, xy, xz) || 1;
      xx /= xl;
      xy /= xl;
      xz /= xl;
      const zx = xy * yz - xz * yy;
      const zy = xz * yx - xx * yz;
      const zz = xx * yy - xy * yx;
      const boost = crease.joint === active ? 1.6 : 1;
      const o = c * 16;
      instance[o] = xx * radius * boost;
      instance[o + 1] = xy * radius * boost;
      instance[o + 2] = xz * radius * boost;
      instance[o + 3] = 0;
      instance[o + 4] = dx;
      instance[o + 5] = dy;
      instance[o + 6] = dz;
      instance[o + 7] = 0;
      instance[o + 8] = zx * radius * boost;
      instance[o + 9] = zy * radius * boost;
      instance[o + 10] = zz * radius * boost;
      instance[o + 11] = 0;
      instance[o + 12] = (scratch.a.x + scratch.b.x) / 2;
      instance[o + 13] = (scratch.a.y + scratch.b.y) / 2;
      instance[o + 14] = (scratch.a.z + scratch.b.z) / 2;
      instance[o + 15] = 1;
      hot.setX(c, crease.joint === active ? 1 : 0);
    }
    rods.count = count;
    rods.instanceMatrix.needsUpdate = true;
    hot.needsUpdate = true;

    // Sheep.
    flock.update(delta, performance.now() / 1000);
    const poseAttribute = sheepMesh.geometry.getAttribute("aPose") as THREE.InstancedBufferAttribute;
    const axisXAttribute = sheepMesh.geometry.getAttribute("aAxisX") as THREE.InstancedBufferAttribute;
    const axisYAttribute = sheepMesh.geometry.getAttribute("aAxisY") as THREE.InstancedBufferAttribute;
    const sheepMatrix = sheepMesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < flock.count; i++) {
      const a = i * 3;
      let ux = flock.up[a];
      let uy = flock.up[a + 1];
      let uz = flock.up[a + 2];
      const fx0 = flock.forward[a];
      const fy0 = flock.forward[a + 1];
      const fz0 = flock.forward[a + 2];
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul;
      uy /= ul;
      uz /= ul;
      // Forward made square to up.
      const along = fx0 * ux + fy0 * uy + fz0 * uz;
      let fx = fx0 - ux * along;
      let fy = fy0 - uy * along;
      let fz = fz0 - uz * along;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl;
      fy /= fl;
      fz /= fl;
      let sx = fy * uz - fz * uy;
      let sy = fz * ux - fx * uz;
      let sz = fx * uy - fy * ux;
      const roll = flock.tumble[i];
      if (roll !== 0) {
        const c = Math.cos(roll);
        const s = Math.sin(roll);
        const nux = ux * c + sx * s;
        const nuy = uy * c + sy * s;
        const nuz = uz * c + sz * s;
        sx = sx * c - ux * s;
        sy = sy * c - uy * s;
        sz = sz * c - uz * s;
        ux = nux;
        uy = nuy;
        uz = nuz;
      }
      const o = i * 16;
      sheepMatrix[o] = fx;
      sheepMatrix[o + 1] = fy;
      sheepMatrix[o + 2] = fz;
      sheepMatrix[o + 3] = 0;
      sheepMatrix[o + 4] = ux;
      sheepMatrix[o + 5] = uy;
      sheepMatrix[o + 6] = uz;
      sheepMatrix[o + 7] = 0;
      sheepMatrix[o + 8] = sx;
      sheepMatrix[o + 9] = sy;
      sheepMatrix[o + 10] = sz;
      sheepMatrix[o + 11] = 0;
      sheepMatrix[o + 12] = flock.world[a];
      sheepMatrix[o + 13] = flock.world[a + 1];
      sheepMatrix[o + 14] = flock.world[a + 2];
      sheepMatrix[o + 15] = 1;
      poseAttribute.setXYZ(i, flock.walk[i], flock.stride[i], flock.graze[i]);
      axisXAttribute.setXYZ(i, fx, fy, fz);
      axisYAttribute.setXYZ(i, ux, uy, uz);
    }
    sheepMesh.count = flock.count;
    sheepMesh.instanceMatrix.needsUpdate = true;
    poseAttribute.needsUpdate = true;
    axisXAttribute.needsUpdate = true;
    axisYAttribute.needsUpdate = true;
  }, -2);

  const initial = geometryFor(familyFor(rig.family.key));

  return (
    <>
      <mesh ref={terrainMesh} geometry={initial.terrain} material={materials.land} castShadow receiveShadow frustumCulled={false} />
      <mesh ref={backMesh} geometry={initial.back} material={materials.paper} castShadow receiveShadow frustumCulled={false} />
      <mesh ref={riverMesh} geometry={initial.river} material={materials.water} receiveShadow frustumCulled={false} />
      <mesh ref={propMesh} geometry={propGeometry} material={materials.props} castShadow receiveShadow frustumCulled={false} />
      <primitive object={grass} />
      <primitive object={rods} />
      <FoldDial rig={rig} />
      <primitive object={sheepMesh} />
    </>
  );
}

function Ambience() {
  const wind = useSetting<number>("wind");
  useMusic("/codevember/music/the-journey-home.mp3", 0.37);
  useBed("river", 0.15);
  useBed("wind", wind * 0.1);
  useEvery(1.2, 4.5, () => sound.play("chirp", { gain: 0.3 + Math.random() * 0.4, pitch: 0.85 + Math.random() * 0.35, pan: Math.random() * 1.6 - 0.8 }));
  return null;
}

function Scene() {
  const hourKey = useSetting<string>("hour");
  const sheepCount = useSetting<number>("sheep");
  const hour = HOURS[hourKey] ?? HOURS.gold;
  useLook(hour.look);

  return (
    <>
      <Ambience />
      <SkyDome palette={hour.sky} />
      <StudioEnvironment
        key={hourKey}
        ambient={hour.ambient}
        intensity={0.9}
        boxes={[
          { position: [0, 10, 0], scale: [24, 0.2, 24], color: hour.sky.zenith, intensity: 1.7 },
          { position: [hour.sky.sunDirection[0] * 12, hour.sky.sunDirection[1] * 12 + 2, hour.sky.sunDirection[2] * 12], scale: [4, 4, 4], color: hour.light, intensity: 7 },
          { position: [-10, 2.5, 0], scale: [0.2, 7, 26], color: hour.boxes, intensity: 1.2 },
          { position: [0, 2.5, -10], scale: [26, 7, 0.2], color: hour.boxes, intensity: 1.2 }
        ]}
      />
      <KeyLight position={hour.position} target={[0, 1, 0]} color={hour.light} intensity={hour.intensity} angle={0.36} penumbra={0.55} shadowFar={70} />
      <Haze size={[46, 16, 40]} position={[0, 7, 0]} density={0.7} />
      <StudioFloor background={hour.sky.horizon} color={hour.floor} roughness={0.95} radius={34} />
      <Birds count={Math.round((90) * 2.4)} centre={FLOCK_CENTRE} spread={11} color={hourKey === "moon" ? "#aab8df" : "#1a1a22"} size={0.13} />
      <Sheet sheepCount={sheepCount} hour={hour} />
    </>
  );
}

const fold: DayDefinition = {
  camera: { position: [7.46, 5.33, -8.54], target: [-1.14, 2.03, -0.84], fov: 36 },
  phonePills: ["shape"],
  extents: { centre: [0, 2, 0], radius: 24, floor: 0, color: "#ffe6c4" },
  look: { background: "#f6bd84", gi: 2.2, ao: 0.9, aoRadius: 0.4, vignette: 0.28, grain: 0.018 },
  settings: {
    shape: {
      type: "choice",
      label: "Fold",
      value: "stair",
      options: [
        { value: "pleats", label: "Pleats" },
        { value: "roll", label: "Roll" },
        { value: "wave", label: "Wave" },
        { value: "stair", label: "Stair" },
        { value: "facets", label: "Facets" },
        { value: "plane", label: "Plane" },
        { value: "box", label: "Box" }
      ]
    },
    amount: { type: "range", label: "Amount", min: 0, max: 1, step: 0.01, value: 0.62 },
    cycle: { type: "toggle", label: "Keep transforming", value: false },
    hour: {
      type: "choice",
      label: "Hour",
      value: "gold",
      options: [
        { value: "morning", label: "Morning", swatch: ["#3f7fcf", "#e3ecef"] },
        { value: "gold", label: "Gold", swatch: ["#47618f", "#f6bd84"] },
        { value: "moon", label: "Moon", swatch: ["#070d22", "#27395f"] }
      ]
    },
    wind: { type: "range", label: "Wind", min: 0, max: 3, step: 0.01, value: 1 },
    sheep: { type: "range", label: "Sheep", min: 0, max: MAX_SHEEP, step: 1, value: 60 },
    breathe: { type: "toggle", label: "Breathe", value: true },
    flatten: { type: "action", label: "Smooth my creases" }
  },
  notes: "A strip of countryside printed on a paper map, with a river and a flock of sheep. Fold it along its creases and the land folds with it.",
  hint: "Grab a gold crease and pull the way its arrows point. Drag anywhere else to look around. Pick up a sheep.",
  overview: [
    {
      title: "Simulation",
      points: [
        "A custom fold rig, with no physics engine, solves up to 256 flat facets on the CPU every frame.",
        "Up to 160 sheep walk the sheet in its own flat coordinates, climbing walls and falling under gravity when a face turns down."
      ]
    },
    {
      title: "Shaders",
      points: [
        "Facet matrices stream to the GPU in a 256 by 6 float DataTexture, read per vertex with textureLoad in TSL.",
        "The river shader bends its normal using two layers of moving mx_noise, with Fresnel sky reflection and foam where it crosses folds."
      ]
    },
    {
      title: "Rendering",
      points: [
        "Up to 42,000 instanced grass blades sway in TSL wind and follow their facet as it folds.",
        "Land and paper back are 2048 pixel canvas-painted survey maps, with the grass taking its colour from the land map."
      ]
    },
    {
      title: "Optimisations",
      points: [
        "A 48 by 26 spatial grid speeds facet lookups when seating grass, props and sheep.",
        "Grass count drops from 42,000 to 28,000 or 8,000, and families only swap while the sheet lies flat."
      ]
    }
  ],
  Scene
};

export default fold;
