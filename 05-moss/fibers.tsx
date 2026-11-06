"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  color as tslColor,
  cos,
  cross,
  dot,
  float,
  floor,
  Fn,
  fract,
  instanceIndex,
  int,
  ivec2,
  length,
  max,
  mix,
  mod,
  modelWorldMatrix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  sin,
  smoothstep,
  texture,
  textureLoad,
  time,
  transformNormalToView,
  uniform,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { MossAssets } from "./assets";
import { focusDistance } from "../shared/engine/Post";
import { flatnessAt, nearestOnCliff, noise, smooth, surfaceAt } from "./cliff";
import { NOT_REFLECTED } from "./pools";
import { lehmer } from "../shared/engine/random";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Moss as what it is: a great many separate fibres. None of it comes from a repeating image. Every fibre's place, height
// and colour come from where it stands on the cliff, so no two stretches of it are the same.

const BUG_REACH = 6;
const SURFACE_GRID = 520;
const MAP_GRID = 640;

export type MossBake = { surface: THREE.DataTexture; facing: THREE.DataTexture; map: THREE.DataTexture; kinds: THREE.DataTexture };

// Islands of the tall kind in a mostly short carpet.
const grassyAt = (a: number, b: number) => smooth(0.56, 0.61, noise(a * 0.7 + 31, b * 0.7 + 17) * 0.66 + noise(a * 2.3 + 9, b * 2.3 + 41) * 0.26 + noise(a * 8 + 3, b * 8) * 0.08);

export function bakeMoss(fieldSize: number): MossBake {
  const surface = new Float32Array(SURFACE_GRID * SURFACE_GRID * 4);
  const facing = new Float32Array(SURFACE_GRID * SURFACE_GRID * 4);
  const point = new THREE.Vector3();
  for (let j = 0; j < SURFACE_GRID; j++) {
    for (let i = 0; i < SURFACE_GRID; i++) {
      surfaceAt((i / (SURFACE_GRID - 1) - 0.5) * fieldSize, (j / (SURFACE_GRID - 1) - 0.5) * fieldSize, point);
      surface.set([point.x, point.y, point.z, 1], (j * SURFACE_GRID + i) * 4);
    }
  }
  const across = new THREE.Vector3();
  const along = new THREE.Vector3();
  const reach = 3;
  const texel = (i: number, j: number) => (Math.max(0, Math.min(SURFACE_GRID - 1, j)) * SURFACE_GRID + Math.max(0, Math.min(SURFACE_GRID - 1, i))) * 4;
  for (let j = 0; j < SURFACE_GRID; j++) {
    for (let i = 0; i < SURFACE_GRID; i++) {
      across.fromArray(surface, texel(i + reach, j)).sub(point.fromArray(surface, texel(i - reach, j)));
      along.fromArray(surface, texel(i, j + reach)).sub(point.fromArray(surface, texel(i, j - reach)));
      across.cross(along).normalize();
      facing.set([across.x, across.y, across.z, flatnessAt((i / (SURFACE_GRID - 1) - 0.5) * fieldSize, (j / (SURFACE_GRID - 1) - 0.5) * fieldSize)], texel(i, j));
    }
  }
  const map = new Uint8Array(MAP_GRID * MAP_GRID * 4);
  const byte = (x: number) => Math.max(0, Math.min(255, x * 255));
  for (let j = 0; j < MAP_GRID; j++) {
    for (let i = 0; i < MAP_GRID; i++) {
      const u = (i / (MAP_GRID - 1) - 0.5) * fieldSize;
      const v = (j / (MAP_GRID - 1) - 0.5) * fieldSize;
      // Cushions at several sizes, the tint of a colony, how thickly it has taken, and a fine grain.
      const cushion = noise(u * 0.8 + 3, v * 0.8) * 0.45 + noise(u * 2.7, v * 2.7 + 9) * 0.35 + noise(u * 8.3 + 5, v * 8.3) * 0.2;
      const tone = noise(u * 0.23 + 11, v * 0.23) * 0.6 + noise(u * 1.3, v * 1.3 + 4) * 0.28 + noise(u * 5.1 + 2, v * 5.1) * 0.12;
      const clump = noise(u * 0.5 + 7, v * 0.5 + 2) * 0.5 + noise(u * 1.9 + 1, v * 1.9) * 0.32 + noise(u * 6.7, v * 6.7 + 3) * 0.18;
      const grain = noise(u * 17 + 2, v * 17) * 0.6 + noise(u * 41, v * 41 + 6) * 0.4;
      map.set([byte(cushion), byte(tone), byte(clump), byte(grain)], (j * MAP_GRID + i) * 4);
    }
  }
  // Which moss grows where. Red is the tall grassy kind against the short kinds, in patches a metre or two across with
  // ragged edges. Green picks between the short kinds, deep velvet or golden.
  const kinds = new Uint8Array(MAP_GRID * MAP_GRID * 4);
  for (let j = 0; j < MAP_GRID; j++) {
    for (let i = 0; i < MAP_GRID; i++) {
      const u = (i / (MAP_GRID - 1) - 0.5) * fieldSize;
      const v = (j / (MAP_GRID - 1) - 0.5) * fieldSize;
      kinds.set([byte(grassyAt(u, v)), byte(smooth(0.4, 0.6, noise(u * 0.8 + 77, v * 0.8 + 13))), 0, 255], (j * MAP_GRID + i) * 4);
    }
  }
  const kindTexture = new THREE.DataTexture(kinds, MAP_GRID, MAP_GRID, THREE.RGBAFormat, THREE.UnsignedByteType);
  kindTexture.minFilter = kindTexture.magFilter = THREE.LinearFilter;
  kindTexture.needsUpdate = true;
  const make = (data: Float32Array) => {
    const tex = new THREE.DataTexture(data, SURFACE_GRID, SURFACE_GRID, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  };
  const mapTexture = new THREE.DataTexture(map, MAP_GRID, MAP_GRID, THREE.RGBAFormat, THREE.UnsignedByteType);
  mapTexture.minFilter = mapTexture.magFilter = THREE.LinearFilter;
  mapTexture.needsUpdate = true;
  return { surface: make(surface), facing: make(facing), map: mapTexture, kinds: kindTexture };
}

// What lies down among the fibres: the real moss photograph, at two sizes at an angle to each other and warped so it
// never lines up with itself, with dark hollows between its clumps and dead brown straw lying through it.
export function mossBed(assets: MossAssets, flat: any) {
  const warp = (texture(assets.mossHeight, flat.mul(0.31)) as any).r as any;
  const wide = flat.mul(0.83).add(vec2(warp.mul(0.37), warp.mul(0.21))) as any;
  const close = vec2(flat.y.mul(2.3).add(0.4), flat.x.mul(2.3).sub(0.2)) as any;
  const clumps = (texture(assets.mossHeight, wide) as any).r as any;
  const fine = (texture(assets.mossHeight, close) as any).r as any;
  const photo = mix((texture(assets.mossDiffuse, wide) as any).rgb, (texture(assets.mossDiffuse, close) as any).rgb, 0.45) as any;
  const straw = smoothstep(0.6, 0.72, warp.mul(0.55).add(fine.mul(0.45))) as any;
  const withStraw = mix(photo, (tslColor("#6a5230") as any).mul(fine.mul(0.8).add(0.5)), straw.mul(0.55)) as any;
  // A third, much finer pass for the grain of it, up close.
  const grain = (texture(assets.mossDiffuse, vec2(flat.x.mul(6.1).sub(flat.y.mul(2.3)), flat.y.mul(6.1).add(flat.x.mul(2.3)))) as any).rgb as any;
  const contrast = dot(grain, vec3(0.3, 0.6, 0.1)).mul(2.6).add(0.1) as any;
  const colour = withStraw.mul(mix(float(0.07), float(1.5), smoothstep(0.3, 0.66, clumps))).mul(fine.mul(1.1).add(0.4)).mul(contrast) as any;
  return { colour, height: clumps.mul(0.7).add(fine.mul(0.3)) };
}

// A tiny black beetle, nose along +x, about a unit long, with a head and three legs a side.
let beetle: THREE.BufferGeometry | null = null;
function bugShape() {
  if (beetle) return beetle;
  const body = new THREE.SphereGeometry(0.5, 8, 6);
  body.scale(1, 0.5, 0.62);
  const head = new THREE.SphereGeometry(0.2, 6, 5);
  head.translate(0.56, 0.02, 0);
  const parts: THREE.BufferGeometry[] = [body, head];
  for (const side of [-1, 1]) {
    for (const along of [-0.28, 0, 0.28]) {
      const leg = new THREE.BoxGeometry(0.05, 0.05, 0.42);
      leg.rotateX(side * 0.5);
      leg.rotateY(side * along * 1.6);
      leg.translate(along, -0.12, side * 0.42);
      parts.push(leg);
    }
  }
  const merged = mergeGeometries(parts.map((part) => (part.index ? part.toNonIndexed() : part)).map((part) => {
    part.deleteAttribute("uv");
    return part;
  })) as THREE.BufferGeometry;
  beetle = merged;
  return merged;
}

export function bugMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.32, metalness: 0.1 });
  material.colorNode = tslColor("#050403") as any;
  return material;
}

// One fibre: a stem that narrows to a point, with a second crossing it up close so that it has body from every side.
function fibreGeometry(levels: number, crossed: boolean) {
  const position: number[] = [];
  const index: number[] = [];
  for (let blade = 0; blade < (crossed ? 2 : 1); blade++) {
    const start = position.length / 3;
    for (let l = 0; l <= levels; l++) {
      const y = l / levels;
      position.push(-1, y, blade, 1, y, blade);
    }
    for (let l = 0; l < levels; l++) {
      const a = start + l * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  return geometry;
}

// Three random numbers for a grid cell. The cell is first spread out along Martin Roberts' R2 sequence, so neighbours
// land far apart, and each channel then scrambles the result with its own sine.
const R2_A = 0.7548776662;
const R2_B = 0.569840291;
const hash3 = Fn(([p]: any[]) => {
  const q = mod(p, float(1021)) as any;
  const a = fract(q.x.mul(R2_A).add(q.y.mul(R2_B))) as any;
  const b = fract(q.y.mul(R2_A).add(q.x.mul(R2_B)).add(0.31)) as any;
  const scramble = (x: number, y: number, shift: number, gain: number) => fract(sin(a.mul(x).add(b.mul(y)).add(shift)).mul(gain)) as any;
  return vec3(scramble(91.7, 37.3, 0, 7919.13), scramble(71.1, 53.9, 1.7, 6151.37), scramble(83.3, 83.3, 4.1, 8837.71));
}) as any;

// How a fibre stands and how it is lit, for any base point, facing and size.
function dressFibre(material: THREE.MeshStandardNodeMaterial, parts: { base: any; up: any; tall: any; wide: any; angle: any; lean: any; tone: any; bright: any; grassy: any; short: any; sunDir: any }) {
  const { base, up, tall, wide: narrow, angle, lean, tone, bright, grassy, short, sunDir } = parts;
  // Never thinner than a pixel can hold, or far-off fibres break up into flecks. Keeping them wide is also what closes the gaps.
  const fromLens = length(cameraPosition.sub((modelWorldMatrix.mul(vec4(base, 1)) as any).xyz)) as any;
  // The short kinds are not blades at all: fat rounded stubs, packed shoulder to shoulder into a bumpy cushion.
  const wide = max(narrow.mul(mix(float(2.2), float(1), grassy)), fromLens.mul(0.00085).mul(smoothstep(0, 0.004, tall))) as any;
  // Further off, each fibre is under a pixel across, and any difference between neighbours flickers as the camera moves.
  // So they settle toward the same colour and the same lighting with distance, and the moss reads as a soft mass.
  const settled = smoothstep(1.2, 5, fromLens) as any;
  const shape = positionGeometry as any;
  const y = shape.y as any;
  const a = normalize(cross(up, vec3(0.31, 0.27, 0.91))) as any;
  const b = cross(up, a) as any;
  const toward = a.mul(cos(angle)).add(b.mul(sin(angle))) as any;
  const beside = a.mul(sin(angle).negate()).add(b.mul(cos(angle))) as any;
  const across = mix(beside, toward, shape.z) as any;
  // Narrow at the root, fullest a third of the way up, and coming to a point.
  const pointed = sin(pow(y, float(0.62)).mul(3.14159)).mul(0.86).add(float(1).sub(y).mul(0.14)) as any;
  const rounded = float(1).sub(pow(y, float(5))).max(float(0)).sqrt() as any;
  const profile = mix(rounded, pointed, grassy) as any;
  const sway = sin(time.mul(1.3).add(base.x.mul(3)).add(base.z.mul(2.3))).mul(0.004).mul(y).mul(y) as any;
  material.positionNode = base.add(up.mul(tall.mul(y))).add(toward.mul(lean.mul(grassy.mul(0.9).add(0.1)).mul(tall).mul(y).mul(y)).add(toward.mul(sway.mul(grassy)))).add(across.mul(shape.x.mul(wide).mul(profile))) as any;
  // Lit as a rounded stem, without the flicker that a flat blade turning to the light would have.
  material.normalNode = transformNormalToView(normalize(varying(mix(up.mul(0.62).add(toward.mul(lean.mul(y).mul(0.5))).add(across.mul(shape.x.mul(0.5))), up, settled) as any) as any)) as any;
  const height = varying(y) as any;
  const hue = varying(mix(tone, float(0.5), settled.mul(0.65)) as any) as any;
  const shade = varying(mix(bright, float(0.72), settled.mul(0.92)) as any) as any;
  const calm = varying(float(1).sub(settled.mul(0.85)) as any) as any;
  // Near black among the stems, deep green through the body, and yellow-green only at the growing tips.
  const isGrassy = varying(grassy) as any;
  const whichShort = varying(short) as any;
  const body = mix(mix(tslColor("#0f3a1c"), tslColor("#3f4d1a"), whichShort), mix(tslColor("#21430f"), tslColor("#4f7016"), hue), isGrassy) as any;
  const tip = mix(mix(tslColor("#1f6b34"), tslColor("#6f7a2c"), whichShort), mix(tslColor("#467a1a"), tslColor("#7f9a28"), hue), isGrassy) as any;
  const colour = mix(mix(tslColor("#050803"), body, smoothstep(0.05, 0.5, height)), tip, (smoothstep(0.5, 1, height) as any).mul(calm)).mul(shade) as any;
  const toEye = normalize(cameraPosition.sub(positionWorld)) as any;
  const through = pow(max(dot(toEye, sunDir.negate()), float(0)), float(3)).mul(0.35).mul(calm) as any;
  material.colorNode = colour;
  material.emissiveNode = colour.mul(height).mul(through) as any;
}

// As rough as a surface can be, so that moss has no sheen, wet or dry.
function fibreMaterial() {
  return new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 1, metalness: 0 });
}

type Layer = { cell: number; radius: number; levels: number; crossed: boolean; tall: number; wide: number };

// Three grids of fibres fixed to the rock, each coarser and reaching further than the last. They travel with the camera
// one whole cell at a time, and because a fibre comes from the cell it stands in, nothing moves or repeats as they go.
export function MossFibers({ bake, field, assets, sunDir, fieldSize, cliffTile, layers, bugCell }: { bugCell: number; bake: MossBake; field: { texture: THREE.Texture }; assets: MossAssets; sunDir: any; fieldSize: number; cliffTile: number; layers: Layer[] }) {
  const { camera } = useThree();
  const centre = useMemo(() => uniform(new THREE.Vector2()), []);
  const meshes = useMemo(
    () =>
      layers.map((layer) => {
        const side = Math.ceil((layer.radius * 2) / layer.cell);
        const geometry = fibreGeometry(layer.levels, layer.crossed);
        geometry.instanceCount = side * side;
        const material = fibreMaterial();
        const index = float(instanceIndex) as any;
        const grid = vec2(mod(index, float(side)), floor(index.div(side))).sub(side / 2) as any;
        const cell = floor(centre.div(layer.cell)).add(grid) as any;
        const dice = hash3(cell) as any;
        const dice2 = hash3(cell.add(vec2(57.3, 11.9))) as any;
        const spot = cell.add(vec2(dice.x, dice.y)).mul(layer.cell) as any;
        const place = spot.div(fieldSize).add(0.5) as any;
        const texel = place.mul(SURFACE_GRID - 1) as any;
        const whole = floor(texel) as any;
        const part = fract(texel) as any;
        const corner = (x: number, y: number) => (textureLoad(bake.surface, ivec2(int(whole.x.add(x)), int(whole.y.add(y)))) as any).xyz as any;
        const base = mix(mix(corner(0, 0), corner(1, 0), part.x), mix(corner(0, 1), corner(1, 1), part.x), part.y) as any;
        const facing = textureLoad(bake.facing, ivec2(int(whole.x), int(whole.y))) as any;
        const up = normalize(facing.xyz) as any;
        const map = (texture(bake.map, place) as any).level(0) as any;
        const here = (texture(field.texture, place) as any).level(0) as any;
        const edge = smoothstep(0.5, 0.47, max(abs(place.x.sub(0.5)), abs(place.y.sub(0.5)))) as any;
        // The same shape of patch as the rock under it, so a fibre never stands on bare stone.
        const patch = smoothstep(0.32, 0.56, here.r.mul(edge).mul(0.82).add(map.b.sub(0.5).mul(0.85))) as any;
        const fade = smoothstep(layer.radius, layer.radius * 0.8, length(spot.sub(centre))) as any;
        const relief = (texture(assets.cliffHeight, spot.div(cliffTile)) as any).level(0).r.sub(0.5).mul(mix(float(0.4), float(0.08), facing.w)).mul(edge) as any;
        const grow = patch.mul(fade) as any;
        const cushion = map.r.mul(map.r).mul(1.9).add(0.72) as any;
        const kinds = (texture(bake.kinds, place) as any).level(0) as any;
        // Each fibre is one kind or the other, so that patches mingle at their edges and never blend.
        const grassy = smoothstep(dice2.z.sub(0.04), dice2.z.add(0.04), kinds.r) as any;
        // Short moss follows mounds and lumps of its own, and the hollows between them go dark.
        const lump = map.r.mul(map.r).mul(1.5).add(map.a.mul(0.7)) as any;
        const shortness = mix(lump.mul(0.8).add(0.12), float(1), grassy) as any;
        dressFibre(material, {
          base: base.add(up.mul(relief.add(0.002))),
          up: normalize(up.add(vec3(dice2.x.sub(0.5), dice2.y.sub(0.5), dice2.z.sub(0.5)).mul(0.5))),
          tall: float(layer.tall).mul(cushion).mul(dice.z.mul(0.5).add(0.75)).mul(grow).mul(shortness),
          wide: float(layer.wide).mul(grow).mul(dice2.z.mul(0.7).add(0.65)),
          angle: dice.x.mul(6.283),
          lean: dice2.x.mul(0.7).add(0.15),
          tone: map.g.mul(1.5).sub(0.25).add(dice.y.sub(0.5).mul(0.3)),
          bright: mix(lump.mul(lump).mul(1.1).add(0.3).mul(dice2.y.mul(0.35).add(0.85)), map.a.mul(0.9).add(0.4).mul(dice2.y.mul(dice2.y).mul(1.1).add(0.45)), grassy),
          grassy,
          short: kinds.g,
          sunDir
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.receiveShadow = true;
        mesh.layers.set(NOT_REFLECTED);
        return mesh;
      }),
    [layers, bake, field, assets, sunDir, fieldSize, cliffTile, centre]
  );

  // Beetles going about on the moss near wherever you are looking. Like the fibres, each belongs to a patch of rock, and
  // finds its way around that patch from the clock alone, stopping and starting, always on top of the moss.
  const bugs = useMemo(() => {
    if (bugCell === 0) return null;
    const cell = bugCell;
    const side = Math.ceil(BUG_REACH * 2 / cell);
    const shape = bugShape();
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", shape.getAttribute("position"));
    geometry.setAttribute("normal", shape.getAttribute("normal"));
    geometry.instanceCount = side * side;
    const material = bugMaterial();
    const index = float(instanceIndex) as any;
    const grid = vec2(mod(index, float(side)), floor(index.div(side))).sub(side / 2) as any;
    const home = floor(centre.div(cell)).add(grid) as any;
    const dice = hash3(home) as any;
    const dice2 = hash3(home.add(vec2(13.7, 71.3))) as any;
    const clock = time.mul(dice.z.mul(0.5).add(0.25)).add(sin(time.mul(0.6).add(dice2.x.mul(6.28))).mul(1.2)) as any;
    const a = dice.x.mul(0.8).add(0.5) as any;
    const b = dice2.y.mul(0.8).add(0.4) as any;
    const wander = (t: any) => vec2(sin(t.mul(a).add(dice.y.mul(6.28))), sin(t.mul(b).add(dice2.z.mul(6.28)))).mul(cell * 0.7) as any;
    const spotAt = (t: any) => home.add(vec2(dice.x, dice.y)).mul(cell).add(wander(t)) as any;
    const surfaceOf = (spot: any) => {
      const texel = spot.div(fieldSize).add(0.5).mul(SURFACE_GRID - 1) as any;
      const whole = floor(texel) as any;
      const part = fract(texel) as any;
      const corner = (x: number, y: number) => (textureLoad(bake.surface, ivec2(int(whole.x.add(x)), int(whole.y.add(y)))) as any).xyz as any;
      return mix(mix(corner(0, 0), corner(1, 0), part.x), mix(corner(0, 1), corner(1, 1), part.x), part.y) as any;
    };
    const spot = spotAt(clock) as any;
    const place = spot.div(fieldSize).add(0.5) as any;
    const whole = floor(place.mul(SURFACE_GRID - 1)) as any;
    const up = normalize((textureLoad(bake.facing, ivec2(int(whole.x), int(whole.y))) as any).xyz) as any;
    const map = (texture(bake.map, place) as any).level(0) as any;
    const here = (texture(field.texture, place) as any).level(0) as any;
    const kinds = (texture(bake.kinds, place) as any).level(0) as any;
    const edge = smoothstep(0.5, 0.47, max(abs(place.x.sub(0.5)), abs(place.y.sub(0.5)))) as any;
    const patch = smoothstep(0.42, 0.6, here.r.mul(edge).mul(0.82).add(map.b.sub(0.5).mul(0.85))) as any;
    const reach = smoothstep(BUG_REACH, BUG_REACH * 0.8, length(spot.sub(centre))) as any;
    const size = dice2.x.mul(0.006).add(0.01).mul(patch).mul(reach).mul(smoothstep(0.35, 0.45, dice.z)) as any;
    const onTop = map.r.mul(map.r).mul(1.9).add(0.72).mul(mix(map.r.mul(map.r).mul(1.2).add(map.a.mul(0.56)).add(0.12), float(1), kinds.r)).mul(0.026) as any;
    const relief = (texture(assets.cliffHeight, spot.div(cliffTile)) as any).level(0).r.sub(0.5).mul(mix(float(0.4), float(0.08), (textureLoad(bake.facing, ivec2(int(whole.x), int(whole.y))) as any).w)).mul(edge) as any;
    const at = surfaceOf(spot).add(up.mul(onTop.add(relief))) as any;
    const going = surfaceOf(spotAt(clock.add(0.05))).sub(surfaceOf(spot)) as any;
    const ahead = normalize(going.sub(up.mul(dot(going, up))).add(vec3(0.0001, 0, 0))) as any;
    const across = cross(ahead, up) as any;
    const shape3 = positionGeometry as any;
    material.positionNode = at.add(ahead.mul(shape3.x.mul(size))).add(up.mul(shape3.y.mul(size))).add(across.mul(shape3.z.mul(size))) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.layers.set(NOT_REFLECTED);
    return mesh;
  }, [bugCell, bake, field, assets, fieldSize, cliffTile, centre]);
  useEffect(
    () => () => {
      bugs?.geometry.dispose();
      (bugs?.material as THREE.Material | undefined)?.dispose();
    },
    [bugs]
  );

  const search = useMemo(() => ({ v: null as number | null, lookV: null as number | null, u: 0, foundV: 0, best: 0, tick: 0, point: new THREE.Vector3(), ahead: new THREE.Vector3(), seen: new THREE.Vector3(), focus: 6 }), []);
  useFrame((_, rawDelta) => {
    // Most of the fibres go where the camera is looking: the first place its line of sight comes close to the rock.
    search.tick += 1;
    if (search.tick % 2 === 0) {
      camera.getWorldDirection(search.ahead);
      search.best = Infinity;
      search.v = search.lookV;
      for (let t = 0.7; t < 18; t *= 1.42) {
        search.point.copy(camera.position).addScaledVector(search.ahead, t);
        const at = nearestOnCliff(search.point, search);
        const gap = surfaceAt(at.u, at.v, search.seen).distanceTo(search.point);
        if (gap < search.best) {
          search.best = gap;
          search.u = at.u;
          search.foundV = at.v;
        }
        if (gap < t * 0.12) break;
      }
      search.lookV = search.foundV;
    }
    const found = { u: search.u, v: search.foundV };
    centre.value.set(found.u, found.v);
    surfaceAt(found.u, found.v, search.seen);
    const distance = search.seen.distanceTo(camera.position);
    meshes.forEach((mesh, i) => {
      mesh.visible = distance < layers[i].radius * 2.6;
    });
    // The lens settles on whatever is being looked at, so that close moss is sharp.
    search.focus += (Math.max(2.5, Math.min(7, distance)) - search.focus) * (1 - Math.exp(-Math.min(rawDelta, 1 / 20) * 2.5));
    focusDistance.value = search.focus;
  });

  useEffect(
    () => () => {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    },
    [meshes]
  );
  return (
    <>
      {meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
      {bugs ? <primitive object={bugs} /> : null}
    </>
  );
}

// The same fibres on a stone. They ride with it, and only stand on whichever side now faces up.
export function stoneFibreMaterial(sunDir: any) {
  const material = fibreMaterial();
  const foot = attribute("aFoot", "vec4") as any;
  const aim = attribute("aAim", "vec4") as any;
  const tone = attribute("aTone", "vec3") as any;
  const faces = (modelWorldMatrix.mul(vec4(aim.xyz, 0)) as any).y as any;
  const stand = smoothstep(-0.25, 0.15, faces) as any;
  const dice = fract(aim.w.mul(vec3(1, 7.13, 31.7))) as any;
  dressFibre(material, {
    base: foot.xyz,
    up: normalize(aim.xyz.add(vec3(dice.y.sub(0.5), dice.z.sub(0.5), dice.x.sub(0.5)).mul(0.45))),
    tall: foot.w.mul(stand),
    wide: foot.w.mul(0.05).add(0.0012).mul(stand),
    angle: aim.w.mul(6.283),
    lean: dice.y.mul(0.7).add(0.15),
    tone: dice.z.mul(0.3).add(tone.x.mul(1.1).sub(0.2)),
    bright: dice.x.mul(dice.x).mul(1.1).add(0.42).mul(tone.x.mul(0.9).add(0.55)),
    grassy: tone.y,
    short: tone.z,
    sunDir
  });
  return material;
}

// Scatter fibres over a stone's real surface, the one that is drawn, so that every root is in the rock. The order is random, so showing fewer at a distance only thins them.
export function stoneFibreGeometry(surface: THREE.BufferGeometry, count: number, seed: number) {
  const rand = lehmer(seed * 2971 + 13);
  const position = surface.getAttribute("position");
  const normal = surface.getAttribute("normal");
  const moss = surface.getAttribute("aRockMoss");
  const index = surface.getIndex() as THREE.BufferAttribute;
  const triangles = index.count / 3;
  const foot = new Float32Array(count * 4);
  const aim = new Float32Array(count * 4);
  const tone = new Float32Array(count * 3);
  let made = 0;
  for (let tries = 0; tries < count * 12 && made < count; tries++) {
    const t = Math.floor(rand() * triangles) * 3;
    const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    let p = rand();
    let q = rand();
    if (p + q > 1) {
      p = 1 - p;
      q = 1 - q;
    }
    const r = 1 - p - q;
    const amount = moss.getX(a) * r + moss.getX(b) * p + moss.getX(c) * q;
    if (amount < 0.22 + rand() * 0.25) continue;
    const blend = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, get: "getX" | "getY" | "getZ") => attr[get](a) * r + attr[get](b) * p + attr[get](c) * q;
    const x = blend(position, "getX");
    const y = blend(position, "getY");
    const z = blend(position, "getZ");
    const cushion = noise(x * 2.6 + seed, z * 2.6 + y) * 0.6 + noise(x * 9 + y, z * 9 + seed) * 0.4;
    const grassy = rand() < grassyAt(x + seed * 3.1, z + y * 0.7) ? 1 : 0;
    foot.set([x - blend(normal, "getX") * 0.003, y - blend(normal, "getY") * 0.003, z - blend(normal, "getZ") * 0.003, (grassy ? 0.01 + cushion * cushion * 0.04 : 0.009 + cushion * cushion * 0.012) * Math.min(1, amount * 1.6) * (0.6 + rand() * 0.7)], made * 4);
    aim.set([blend(normal, "getX"), blend(normal, "getY"), blend(normal, "getZ"), rand()], made * 4);
    tone.set([noise(x * 1.1 + seed * 0.7, z * 1.1 - y) * 0.7 + noise(x * 5, z * 5 + seed) * 0.3, grassy, smooth(0.4, 0.6, noise(x * 1.7 + seed, z * 1.7 + y))], made * 3);
    made++;
  }
  const geometry = fibreGeometry(3, true);
  geometry.setAttribute("aFoot", new THREE.InstancedBufferAttribute(foot, 4));
  geometry.setAttribute("aAim", new THREE.InstancedBufferAttribute(aim, 4));
  geometry.setAttribute("aTone", new THREE.InstancedBufferAttribute(tone, 3));
  geometry.instanceCount = made;
  return { geometry, made };
}

// A few beetles walking from one mossy spot to the next on a stone's real surface, riding along with it.
export function StoneBugs({ surface, count, material, seed }: { surface: THREE.BufferGeometry; count: number; material: THREE.Material; seed: number }) {
  const camera = useThree((three) => three.camera);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const crawl = useMemo(() => {
    const rand = lehmer(seed * 1907 + 31);
    const moss = surface.getAttribute("aRockMoss");
    const mossy: number[] = [];
    for (let i = 0; i < moss.count; i++) if (moss.getX(i) > 0.55) mossy.push(i);
    if (mossy.length < 40) return null;
    const position = surface.getAttribute("position");
    const normal = surface.getAttribute("normal");
    const read = (i: number, out: THREE.Vector3) => out.set(position.getX(i), position.getY(i), position.getZ(i));
    const pick = () => mossy[Math.floor(rand() * mossy.length)];
    const near = (from: number) => {
      const a = read(from, new THREE.Vector3());
      const b = new THREE.Vector3();
      let best = pick();
      for (let tries = 0; tries < 24; tries++) {
        const next = pick();
        const gap = read(next, b).distanceTo(a);
        if (gap > 0.03 && gap < 0.22) return next;
        if (gap > 0.03 && gap < read(best, b).distanceTo(a)) best = next;
      }
      return best;
    };
    const bugs = Array.from({ length: count }, () => {
      const from = pick();
      return { from, to: near(from), t: rand(), speed: 0.012 + rand() * 0.03, rest: 0, size: 0.009 + rand() * 0.006 };
    });
    return { bugs, rand, near, read, normal };
  }, [surface, count, seed]);
  const scratch = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), up: new THREE.Vector3(), upB: new THREE.Vector3(), side: new THREE.Vector3(), basis: new THREE.Matrix4(), world: new THREE.Vector3(), scale: new THREE.Vector3() }), []);
  useFrame((_, rawDelta) => {
    const instanced = mesh.current;
    if (!instanced || !crawl) return;
    instanced.getWorldPosition(scratch.world);
    if (scratch.world.distanceTo(camera.position) > 16) return;
    const delta = Math.min(rawDelta, 1 / 20);
    const { a, b, up, upB, side, basis, scale } = scratch;
    crawl.bugs.forEach((bug, i) => {
      crawl.read(bug.from, a);
      crawl.read(bug.to, b);
      if (bug.rest > 0) bug.rest -= delta;
      else bug.t += (delta * bug.speed) / Math.max(0.01, a.distanceTo(b));
      if (bug.t >= 1) {
        bug.from = bug.to;
        bug.to = crawl.near(bug.from);
        bug.t = 0;
        bug.rest = crawl.rand() < 0.3 ? crawl.rand() * 2.5 : 0;
        crawl.read(bug.from, a);
        crawl.read(bug.to, b);
      }
      const n = crawl.normal;
      up.set(n.getX(bug.from), n.getY(bug.from), n.getZ(bug.from)).lerp(upB.set(n.getX(bug.to), n.getY(bug.to), n.getZ(bug.to)), bug.t).normalize();
      const ahead = b.sub(a);
      a.addScaledVector(ahead, bug.t).addScaledVector(up, 0.03);
      ahead.addScaledVector(up, -ahead.dot(up)).normalize();
      side.crossVectors(ahead, up);
      basis.makeBasis(ahead, up, side).scale(scale.setScalar(bug.size)).setPosition(a);
      instanced.setMatrixAt(i, basis);
    });
    instanced.instanceMatrix.needsUpdate = true;
  });
  if (!crawl) return null;
  return <instancedMesh ref={mesh} args={[bugShape(), material, count]} frustumCulled={false} layers={NOT_REFLECTED} />;
}
