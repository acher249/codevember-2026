"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  attribute,
  cameraPosition,
  clamp,
  cos,
  distance,
  dot,
  exp,
  float,
  floor as floor_,
  fract,
  hash,
  instanceIndex,
  max,
  min,
  mix,
  mx_noise_float,
  mx_noise_vec3,
  normalize,
  normalLocal,
  normalWorld,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  refract,
  sin,
  texture,
  smoothstep,
  step,
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3
} from "three/tsl";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { useDispose } from "../shared/engine/dispose";
import { lehmer } from "../shared/engine/random";
import { cliffDepth, noise3, type Rock } from "./field";
import { caveShade, lamp } from "./fx";
import { rockUniforms, torchLightAt, triplanarNormal, weights, type Textures } from "./rock";
import { panels } from "./panels";
import { PhotoCapture } from "./photos";
import { pickup } from "./sound";
import { finds, TIER } from "./found";
import { glint, Glints, lookOf } from "./glint";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Things to find in the rock: gold, raw gems, fossils, and the odd lost thing. Each sits at a point in its own small
// hashed cell, so there is always more further on; what you take stays taken. They lie buried until the digging comes
// near, so the rock itself hides them, and a glint gives them away once the light catches an exposed edge.

export type ItemKind =
  | "nugget"
  | "quartz"
  | "arrowhead"
  | "coin"
  | "fossil"
  | "trilobite"
  | "tooth"
  | "amber"
  | "emerald"
  | "ruby"
  | "amethyst"
  | "sapphire"
  | "meteorite"
  | "compass"
  | "watch"
  | "shard"
  | "diamond"
  | "idol";
export type Rarity = "Common" | "Uncommon" | "Rare" | "Epic" | "Legendary";

// Sizes are the radius of the thing in metres, about: big enough to read from a few metres off in torchlight.
export const ITEMS: Record<ItemKind, { name: string; plural: string; rarity: Rarity; size: number }> = {
  nugget: { name: "Gold nugget", plural: "Gold nuggets", rarity: "Common", size: 0.16 },
  quartz: { name: "Gold-veined quartz", plural: "Gold-veined quartz", rarity: "Common", size: 0.2 },
  arrowhead: { name: "Flint arrowhead", plural: "Flint arrowheads", rarity: "Uncommon", size: 0.15 },
  coin: { name: "Old coin", plural: "Old coins", rarity: "Uncommon", size: 0.1 },
  fossil: { name: "Ammonite fossil", plural: "Ammonite fossils", rarity: "Uncommon", size: 0.24 },
  trilobite: { name: "Trilobite", plural: "Trilobites", rarity: "Uncommon", size: 0.26 },
  tooth: { name: "Fossil shark tooth", plural: "Fossil shark teeth", rarity: "Rare", size: 0.14 },
  amber: { name: "Amber with an insect", plural: "Amber with insects", rarity: "Rare", size: 0.13 },
  emerald: { name: "Cut emerald", plural: "Cut emeralds", rarity: "Rare", size: 0.09 },
  ruby: { name: "Cut ruby", plural: "Cut rubies", rarity: "Rare", size: 0.08 },
  amethyst: { name: "Amethyst geode", plural: "Amethyst geodes", rarity: "Rare", size: 0.26 },
  sapphire: { name: "Cut sapphire", plural: "Cut sapphires", rarity: "Epic", size: 0.08 },
  meteorite: { name: "Meteorite fragment", plural: "Meteorite fragments", rarity: "Epic", size: 0.18 },
  compass: { name: "Lost compass", plural: "Lost compasses", rarity: "Epic", size: 0.13 },
  watch: { name: "Pocket watch", plural: "Pocket watches", rarity: "Epic", size: 0.11 },
  shard: { name: "Glowing crystal shard", plural: "Glowing crystal shards", rarity: "Epic", size: 0.2 },
  diamond: { name: "Diamond", plural: "Diamonds", rarity: "Legendary", size: 0.1 },
  idol: { name: "Carved idol", plural: "Carved idols", rarity: "Legendary", size: 0.24 }
};
const KINDS = Object.keys(ITEMS) as ItemKind[];

// One line on each, for the inspect view.
export const ABOUT: Record<ItemKind, string> = {
  nugget: "Native gold, washed into a crack in the rock and left there when the water went.",
  quartz: "Milky vein quartz with a thread of gold through it, the way prospectors found most of it.",
  arrowhead: "Knapped from flint by someone who sat here a very long time ago; the flake scars still show.",
  coin: "Struck bronze, worn smooth by hands and green where the ground got into it.",
  fossil: "An ammonite turned to pyrite, its chamber walls drawn in frills across the shell.",
  trilobite: "A sea creature from before the dinosaurs, curled into the shale it lived on.",
  tooth: "A fossil shark tooth the size of a palm: black enamel, a serrated edge, a root that held it in the jaw.",
  amber: "Tree resin, hardened over millions of years, with the fly that got stuck in it still inside.",
  emerald: "A step-cut emerald; the flat facets show its colour rather than throw sparks.",
  ruby: "An oval ruby, red from a trace of chromium, the colour that glows under light.",
  amethyst: "Half a geode: a plain grey rock, broken open on a cave of violet points.",
  sapphire: "A round sapphire, its blue from iron and titanium, deep where the light goes furthest.",
  meteorite: "Iron from space, its skin pocked with thumbprints where it melted on the way down.",
  compass: "Brass and glass. Somebody came down here before you, and lost their way.",
  watch: "A gold pocket watch, stopped at the hour its owner went missing.",
  shard: "Quartz points that glow by themselves, grown in the dark from something in the rock.",
  diamond: "A round brilliant: fifty-seven facets cut to bend the light inside and throw it back as fire.",
  idol: "Gold, carved into a seated figure by people nobody remembers, and left deep in the rock on purpose."
};

// The find under the pointer, for the tag beside it.
export const hovered = {
  kind: null as ItemKind | null,
  // Where the pointer was when it came over it.
  x: 0,
  y: 0,
  listeners: new Set<() => void>(),
  set(kind: ItemKind | null, x?: number, y?: number) {
    if (kind === this.kind) return;
    this.kind = kind;
    if (x !== undefined && y !== undefined) {
      this.x = x;
      this.y = y;
    }
    for (const listener of this.listeners) listener();
  }
};
// The highlight on the find under the pointer: where it is, how far round it, how strongly (eased in and out).
const hoverLight = { at: uniform(new THREE.Vector3(0, -1e5, 0)) as any, reach: uniform(0.3) as any, amount: uniform(0) as any };
// How far a click can take a find from: the arm's reach the scene's strikes use (index.tsx `REACH.arm`).
const PICK_REACH = 4.6;

// How common each is by how deep in the rock it lies: gold, quartz and flint near the surface, fossils through the
// beds, gems and lost things further in, and the strange ones (meteorite, glowing shards, a diamond, an idol) only deep.
function chance(kind: ItemKind, depth: number) {
  const deep = Math.max(0, depth);
  const band = (lo: number, hi: number, weight: number, outside = 0) => (deep >= lo && deep < hi ? weight : outside);
  switch (kind) {
    case "nugget":
      return band(0, 12, 9, 3);
    case "quartz":
      return band(0, 14, 6, 2);
    case "arrowhead":
      return band(0, 8, 5, 0.6);
    case "coin":
      return band(0, 10, 4, 0.8);
    case "fossil":
      return band(2, 30, 4, 1);
    case "trilobite":
      return band(3, 30, 3.5, 0.5);
    case "tooth":
      return band(4, 40, 2.4, 0.3);
    case "amber":
      return band(4, 40, 2, 0.2);
    case "emerald":
      return band(5, 99, 2.4, 0.3);
    case "ruby":
      return band(7, 99, 2.1, 0.2);
    case "amethyst":
      return band(6, 99, 2, 0.2);
    case "sapphire":
      return band(10, 99, 1.5, 0.05);
    case "compass":
      return 0.8;
    case "watch":
      return 0.7;
    case "meteorite":
      return band(12, 99, 1.1, 0);
    case "shard":
      return band(16, 99, 1.2, 0);
    case "diamond":
      return band(18, 99, 0.9, 0);
    case "idol":
      return band(10, 99, 0.35, 0);
  }
}

export type Item = { key: string; kind: ItemKind; p: THREE.Vector3; q: THREE.Quaternion; scale: number };

// The backpack: what has been found, for the panel to show.
export const pack = {
  counts: {} as Partial<Record<ItemKind, number>>,
  // Each kind's picture for the panel and the toasts: the find itself, rendered once at load (see `renderIcons`).
  icons: {} as Partial<Record<ItemKind, string>>,
  last: null as null | { kind: ItemKind; at: number; n: number },
  listeners: new Set<() => void>(),
  version: 0,
  add(kind: ItemKind, n = 1) {
    this.counts = { ...this.counts, [kind]: (this.counts[kind] ?? 0) + n };
    this.last = { kind, at: performance.now(), n };
    this.version++;
    for (const listener of this.listeners) listener();
  }
};

const CELL = 3.6;
const RADIUS = 12;
const cells = new Map<string, Item | null>();
// Finds set out by hand (development only: a row of every kind, to look at them).
const shown: Item[] = [];
const taken = new Set<string>();

function hashCell(i: number, j: number, k: number) {
  let h = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function cellItem(i: number, j: number, k: number): Item | null {
  const key = `${i},${j},${k}`;
  const known = cells.get(key);
  if (known !== undefined) return known;
  let made: Item | null = null;
  if (hashCell(i, j, k) < 0.5) {
    const random = lehmer(Math.floor(hashCell(i + 7, j - 3, k + 11) * 2147483646) + 1);
    const p = new THREE.Vector3((i + 0.15 + random() * 0.7) * CELL, (j + 0.15 + random() * 0.7) * CELL, (k + 0.15 + random() * 0.7) * CELL);
    const depth = cliffDepth(p.x, p.y, p.z);
    // Only in the rock, not out in the air or right on the open surface.
    if (depth > 0.6) {
      const total = KINDS.reduce((sum, kind) => sum + chance(kind, depth), 0);
      let roll = random() * total;
      let kind: ItemKind = "nugget";
      for (const option of KINDS) {
        roll -= chance(option, depth);
        if (roll <= 0) {
          kind = option;
          break;
        }
      }
      // Gold comes in a little cluster along a seam.
      made = {
        key,
        kind,
        p,
        q: new THREE.Quaternion().setFromEuler(new THREE.Euler(random() * 6, random() * 6, random() * 6)),
        scale: ITEMS[kind].size * (0.75 + random() * 0.6 + (noise3(p.x, p.y, p.z) > 0.5 ? 0.3 : 0))
      };
    }
  }
  cells.set(key, made);
  return made;
}

// ---- Shapes and looks ----------------------------------------------------------------------------------------------

// One more level of detail while the inspect view's shapes are being built (see `shapeOf`).
let extra = 0;

function lumpy(detail: number, seed: number, squash: number) {
  const g = new THREE.IcosahedronGeometry(1, detail + extra);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const r = 1 + noise3(v.x * 2.3 + seed, v.y * 2.3, v.z * 2.3) * 0.28;
    pos.setXYZ(i, v.x * r, v.y * r * squash, v.z * r);
  }
  g.deleteAttribute("uv");
  g.computeVertexNormals();
  return g;
}

// `smooth`: shaded round (normals from the indexed mesh, kept); otherwise every face flat, as a cut stone.
function merge(parts: THREE.BufferGeometry[], smooth = false) {
  const flat = parts.map((source) => {
    source.deleteAttribute("uv");
    // A polyhedron comes unindexed: weld it first, or it shades faceted.
    let g = source;
    if (smooth && !g.index) {
      g.deleteAttribute("normal");
      g = mergeVertices(g, 1e-4);
    }
    if (smooth && g.index) g.computeVertexNormals();
    const n = g.index ? g.toNonIndexed() : g;
    if (!smooth || !n.getAttribute("normal")) n.computeVertexNormals();
    return n;
  });
  const total = flat.reduce((sum, g) => sum + g.getAttribute("position").count, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  let at = 0;
  for (const g of flat) {
    position.set(g.getAttribute("position").array as Float32Array, at * 3);
    normal.set(g.getAttribute("normal").array as Float32Array, at * 3);
    at += g.getAttribute("position").count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  return out;
}

// Every shape carries `aPart` per vertex (0 the body; 1 and 2 a second and third material on it: a dial, crystals,
// a root, a band), so one material draws them all.
function parted(parts: [THREE.BufferGeometry, number][], smooth = false) {
  const merged = merge(
    parts.map(([g]) => g),
    smooth
  );
  const part: number[] = [];
  parts.forEach(([g, id]) => {
    const n = (g.index ? g.index.count : g.getAttribute("position").count) as number;
    for (let i = 0; i < n; i++) part.push(id);
  });
  merged.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1));
  return merged;
}

// A cut stone from rings of points, top to bottom: each ring `[radius, y, rotate]` over `sides` points (`shape` gives
// the outline: 1 a circle, or a cut-cornered rectangle for a step cut), joined facet by facet, every facet flat.
function cutStone(rings: [number, number, number][], sides: number, outline: (a: number) => [number, number]) {
  const position: number[] = [];
  const ring = ([r, y, turn]: [number, number, number]) =>
    Array.from({ length: sides }, (_, k) => {
      const [x, z] = outline(((k + turn) / sides) * Math.PI * 2);
      return [x * r, y, z * r];
    });
  const pts = rings.map(ring);
  const tri = (a: number[], b: number[], c: number[]) => position.push(...a, ...b, ...c);
  // The table: a fan.
  const top = pts[0];
  const centre = [0, rings[0][1], 0];
  for (let k = 0; k < sides; k++) tri(centre, top[(k + 1) % sides], top[k]);
  for (let i = 0; i < pts.length - 1; i++)
    for (let k = 0; k < sides; k++) {
      const a = pts[i][k],
        b = pts[i][(k + 1) % sides],
        c = pts[i + 1][k],
        d = pts[i + 1][(k + 1) % sides];
      tri(a, b, c);
      tri(b, d, c);
    }
  // The culet: down to a point.
  const last = pts[pts.length - 1];
  const tip = [0, rings[rings.length - 1][1] - 0.02, 0];
  for (let k = 0; k < sides; k++) tri(last[k], last[(k + 1) % sides], tip);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.computeVertexNormals();
  return g;
}
// The emerald cut: a rectangle with its corners cut, a flat table, stepped facets down both sides, a keel below.
function stepCut() {
  const outline = (a: number): [number, number] => {
    const x = Math.cos(a);
    const z = Math.sin(a);
    const k = Math.max(Math.abs(x) / 0.72, Math.abs(z), (Math.abs(x) / 0.72 + Math.abs(z)) / 1.55);
    return [(x / k) * 0.72, z / k];
  };
  return cutStone(
    [
      [0.62, 0.3, 0.5],
      [0.82, 0.22, 0.5],
      [0.96, 0.1, 0.5],
      [1.0, 0.0, 0.5],
      [0.8, -0.2, 0.5],
      [0.5, -0.42, 0.5],
      [0.2, -0.6, 0.5]
    ],
    8,
    outline
  );
}

// A round brilliant to a real cutter's proportions (girdle radius 1): a 56% table, a 34.5° crown with star, bezel and
// upper girdle facets, a thin girdle, and a 40.75° pavilion of main and lower girdle facets to the culet. Built as the
// convex hull of the facet corners, so every facet is a true flat plane with its normal facing out.
function brilliantCut() {
  const points: THREE.Vector3[] = [];
  const at = (a: number, r: number, y: number) => points.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  const eighth = Math.PI / 4;
  for (let k = 0; k < 8; k++) {
    // The table's corners, and the star facets' points halfway down the crown (just proud of it, so they are corners).
    at(k * eighth, 0.6, 0.33);
    at((k + 0.5) * eighth, 0.79, 0.2);
    // The lower girdle facets' points on the pavilion, three quarters of the way down.
    at((k + 0.5) * eighth, 0.33, -0.62);
  }
  // The girdle: 32 points round, top and bottom.
  for (let k = 0; k < 32; k++) {
    at((k / 32) * Math.PI * 2, 1, 0.025);
    at((k / 32) * Math.PI * 2, 1, -0.025);
  }
  points.push(new THREE.Vector3(0, -0.88, 0));
  return new ConvexGeometry(points);
}

// A quartz point as it grows: a six-sided prism, each face at its own distance (no two crystals alike), tapering a
// little, under a six-faced termination whose apex sits a touch off the axis.
function quartzPoint(length: number, radius: number, random: () => number) {
  const points: THREE.Vector3[] = [];
  const turn = random() * Math.PI;
  const top = radius * 0.9;
  for (let k = 0; k < 6; k++) {
    const a = turn + (k / 6) * Math.PI * 2 + (random() - 0.5) * 0.12;
    const r = 0.85 + random() * 0.3;
    points.push(new THREE.Vector3(Math.cos(a) * radius * r, 0, Math.sin(a) * radius * r));
    points.push(new THREE.Vector3(Math.cos(a) * top * r, length, Math.sin(a) * top * r));
  }
  points.push(new THREE.Vector3((random() - 0.5) * radius * 0.35, length + top * (1.05 + random() * 0.3), (random() - 0.5) * radius * 0.35));
  return new ConvexGeometry(points);
}

// A gold nugget: hackly, folded metal, not a smooth blob. Broad lumps, sharper creases folded into them, and pits; the
// shader reads how far in from round a point lies as how deep it sits in a crease (see pattern 13).
function nuggetShape(seed: number) {
  const g = new THREE.IcosahedronGeometry(1, 4 + extra);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const lumps = noise3(v.x * 1.7 + seed, v.y * 1.7, v.z * 1.7) * 0.3;
    const folds = -Math.abs(noise3(v.x * 3.8, v.y * 3.8 + seed, v.z * 3.8)) * 0.16;
    const pits = -Math.pow(Math.max(0, noise3(v.x * 9 + seed, v.y * 9, v.z * 9)), 2) * 0.12;
    const r = 1 + lumps + folds + pits;
    pos.setXYZ(i, v.x * r * 1.1, v.y * r * 0.62, v.z * r * 0.9);
  }
  g.deleteAttribute("uv");
  g.deleteAttribute("normal");
  const welded = mergeVertices(g, 1e-4);
  welded.computeVertexNormals();
  return welded;
}

// A fossil shark tooth, a big one: a broad triangular blade, lens-shaped in section (fat in the middle, thin to a
// finely serrated edge), the enamel ending in a dark band above a two-lobed root (part 1).
function sharkTooth() {
  const columns = 28;
  const rows = 26;
  const position: number[] = [];
  const index: number[] = [];
  const part: number[] = [];
  for (const side of [1, -1])
    for (let j = 0; j <= rows; j++)
      for (let i = 0; i <= columns; i++) {
        const u = (i / columns) * 2 - 1;
        const v = j / rows;
        // v from -0.3 (bottom of the root) to 1 (the tip).
        const y = v * 1.3 - 0.3;
        const blade = y >= 0;
        const half = blade ? 0.62 * Math.pow(1 - y, 0.85) * (1 + Math.sin(y * 3) * 0.05) : 0.66 + Math.sin(u * Math.PI) * 0.0 - (1 - Math.cos(u * Math.PI * 2)) * 0.05 * (-y / 0.3);
        const edge = 1 - Math.abs(u);
        const serrate = blade ? Math.sin(y * 120) * 0.008 * (1 - edge) : 0;
        const x = u * half + Math.sign(u) * serrate;
        const thick = (blade ? 0.16 * (1 - y * 0.8) : 0.2) * Math.sqrt(Math.max(0, 1 - u * u));
        const lobes = !blade && y < -0.18 && Math.abs(u) < 0.18 ? (y + 0.18) * 1.5 : 0;
        position.push(x, y - lobes, thick * side);
        part.push(y < 0.04 ? 1 : 0);
      }
  const per = (rows + 1) * (columns + 1);
  // i runs along +x and j up +y, so (a, b, c) faces +z: the front sheet (z > 0) takes it, the back sheet the reverse.
  // (Once the other way round, so the tooth was drawn inside out.)
  for (const [base, flip] of [
    [0, true],
    [per, false]
  ] as const)
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < columns; i++) {
        const a = base + j * (columns + 1) + i;
        const b = a + 1;
        const c = a + columns + 1;
        const d = c + 1;
        if (flip) index.push(a, b, c, b, d, c);
        else index.push(a, c, b, b, c, d);
      }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(index);
  g.computeVertexNormals();
  const flat = g.toNonIndexed();
  flat.translate(0, -0.35, 0);
  return flat;
}

// The insect trapped in the amber: a small fly, its body in three parts, six thin legs and two wings, in the middle.
function insect() {
  const parts: THREE.BufferGeometry[] = [];
  const blob = (x: number, z: number, r: number, l: number) => {
    const g = new THREE.SphereGeometry(r, 8, 6);
    g.scale(1, 0.8, l / r);
    g.translate(x, 0, z);
    parts.push(g);
  };
  blob(0, -0.2, 0.08, 0.09);
  blob(0, -0.04, 0.1, 0.11);
  blob(0, 0.2, 0.11, 0.18);
  for (const s of [1, -1])
    for (const z of [-0.1, 0, 0.1]) {
      const leg = new THREE.CylinderGeometry(0.012, 0.008, 0.32, 4);
      leg.rotateZ(s * 1.1);
      leg.rotateY(z * 3);
      leg.translate(s * 0.15, -0.08, z);
      parts.push(leg);
    }
  for (const s of [1, -1]) {
    const wing = new THREE.CircleGeometry(0.16, 10);
    wing.scale(0.55, 1, 1);
    wing.rotateX(-Math.PI / 2 + 0.15);
    wing.rotateY(s * 0.35);
    wing.translate(s * 0.08, 0.07, 0.24);
    parts.push(wing);
  }
  const g = merge(parts);
  g.scale(1.5, 1.5, 1.5);
  return g;
}

// A trilobite, sculpted: a grid over the animal's outline (u across, -1 to 1; v head to tail, 0 to 1), raised into
// its relief. A half-moon head shield (cephalon) with a swollen middle lobe (glabella), two crescent eyes and long
// spines sweeping back from its corners; a thorax of eleven jointed segments, each with a raised middle and a furrowed
// side lobe ending in a short point; and a small ribbed tail shield. The underside is a shallow cup.
function trilobiteShape() {
  const nu = 48;
  const nv = 96;
  const half = (v: number) => {
    if (v < 0.3) return 0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - Math.pow((0.3 - v) / 0.3, 2)));
    if (v < 0.78) return 0.95 - (v - 0.3) * 0.75;
    return 0.6 * Math.sqrt(Math.max(0, 1 - Math.pow((v - 0.78) / 0.22, 2)));
  };
  const height = (u: number, v: number) => {
    const across = Math.sqrt(Math.max(0, 1 - u * u));
    const along = Math.pow(Math.max(0, Math.sin(Math.min(1, v) * Math.PI)), 0.25);
    let h = 0.09 * across * along;
    const axial = Math.exp(-Math.pow(u / 0.26, 2));
    if (v < 0.3) {
      // The glabella, swelling forward; the eyes, crescents either side of it.
      h += 0.11 * Math.exp(-Math.pow(u / 0.24, 2)) * Math.sin((v / 0.3) * Math.PI * 0.9);
      const eye = Math.exp(-(Math.pow((Math.abs(u) - 0.45) / 0.09, 2) + Math.pow((v - 0.2) / 0.05, 2)));
      h += eye * 0.07;
      h -= 0.02 * Math.exp(-Math.pow((Math.abs(u) - 0.3) / 0.05, 2)) * (v > 0.05 ? 1 : 0);
    } else if (v < 0.78) {
      // Eleven segments: a ridge each across the body, the axis raised and parted from the side lobes by a furrow.
      const seg = ((v - 0.3) / 0.48) * 11;
      const ridge = Math.pow(Math.abs(Math.sin(seg * Math.PI)), 0.7);
      h += 0.05 * axial + ridge * 0.025 * (0.5 + axial);
      h -= 0.018 * Math.exp(-Math.pow((Math.abs(u) - 0.3) / 0.04, 2));
      // A pleural furrow slanting back along each side lobe.
      h -= 0.012 * Math.pow(Math.abs(Math.sin((seg - Math.abs(u) * 0.6) * Math.PI)), 6) * (Math.abs(u) > 0.32 ? 1 : 0);
    } else {
      const ribs = Math.pow(Math.abs(Math.sin(((v - 0.78) / 0.22) * 5 * Math.PI)), 0.8);
      h += 0.035 * axial + ribs * 0.012;
    }
    return h * along;
  };
  const position: number[] = [];
  const index: number[] = [];
  for (const side of [1, -1])
    for (let j = 0; j <= nv; j++)
      for (let i = 0; i <= nu; i++) {
        const u = (i / nu) * 2 - 1;
        const v = j / nv;
        const w = half(v);
        // At the cephalon's back corners the outline runs out into the genal spines.
        const spine = v > 0.24 && v < 0.62 && Math.abs(u) > 0.97 ? Math.pow((v - 0.24) / 0.38, 1.3) * 0.25 : 0;
        const x = u * (w + spine * 0.4);
        const z = (v - 0.5) * 2.2 + spine * 0.5;
        const y = side > 0 ? height(u, v) : -0.025 * Math.sqrt(Math.max(0, 1 - u * u)) * Math.sin(v * Math.PI);
        position.push(x, y, z);
      }
  const per = (nu + 1) * (nv + 1);
  for (const [base, flip] of [
    [0, false],
    [per, true]
  ] as const)
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        const b = a + 1;
        const c = a + nu + 1;
        const d = c + 1;
        if (flip) index.push(a, b, c, b, d, c);
        else index.push(a, c, b, b, c, d);
      }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  g.scale(0.85, 2.6, 0.85);
  return g;
}

// An ammonite, sculpted: a coiled shell on a logarithmic spiral, each whorl wrapping the last, its flanks crossed by
// strong ribs that fork toward the outer edge and swell where they cross it, the aperture open at the end.
function ammoniteShape() {
  const turns = 3.1;
  const steps = 300;
  const around = 18;
  const grow = Math.log(2.3) / (Math.PI * 2);
  const position: number[] = [];
  const index: number[] = [];
  const end = turns * Math.PI * 2;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * end;
    const r = 0.06 * Math.exp(grow * t);
    // Ribs across the flank, twice as many at the outer edge (forking), swelling there.
    const ribs = Math.pow(Math.abs(Math.sin(t * 9)), 2.5);
    const forked = Math.pow(Math.abs(Math.sin(t * 18)), 2.5);
    for (let k = 0; k <= around; k++) {
      const phi = (k / around) * Math.PI * 2;
      const outer = Math.max(0, Math.cos(phi));
      const flank = 1 - outer;
      const tube = r * 0.62 * (1 + (ribs * 0.07 * flank + forked * 0.1 * outer) * Math.min(1, t / 3));
      const radial = r + Math.cos(phi) * tube * 0.9;
      const y = Math.sin(phi) * tube * 0.62;
      position.push(Math.cos(t) * radial, y, Math.sin(t) * radial);
    }
  }
  for (let i = 0; i < steps; i++)
    for (let k = 0; k < around; k++) {
      const a = i * (around + 1) + k;
      const b = a + 1;
      const c = a + around + 1;
      const d = c + 1;
      // Outward: b runs round the tube (out, then up), c along the coil; (a, b, c) faces away from the tube's middle.
      index.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  g.computeBoundingBox();
  const box = g.boundingBox as THREE.Box3;
  const size = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  g.translate(-(box.min.x + box.max.x) / 2, 0, -(box.min.z + box.max.z) / 2);
  g.scale(2 / size, 2 / size, 2 / size);
  return g;
}

// A carved idol: a squat seated figure, a big head with deep-set eyes, arms folded over the chest, on a block.
function idolShape() {
  const profile = [
    [0, 0],
    [0.55, 0],
    [0.55, 0.16],
    [0.42, 0.2],
    [0.4, 0.45],
    [0.34, 0.5],
    [0.44, 0.7],
    [0.26, 0.86],
    [0.3, 0.92],
    [0.4, 1.05],
    [0.4, 1.22],
    [0.3, 1.36],
    [0, 1.42]
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const body = new THREE.LatheGeometry(profile, 16);
  const arms = new THREE.BoxGeometry(0.78, 0.11, 0.18);
  arms.translate(0, 0.64, 0.33);
  const brow = new THREE.BoxGeometry(0.5, 0.06, 0.1);
  brow.translate(0, 1.18, 0.36);
  const nose = new THREE.ConeGeometry(0.06, 0.16, 4);
  nose.rotateX(Math.PI / 2);
  nose.translate(0, 1.1, 0.42);
  const g = parted(
    [
      [body, 0],
      [arms, 0],
      [brow, 0],
      [nose, 0]
    ],
    true
  );
  g.translate(0, -0.7, 0);
  g.scale(0.72, 0.72, 0.72);
  return g;
}

// Half a geode: the rough grey rind outside, the cut face a ring of banded agate, and the hollow lined with amethyst
// points all facing in.
function geodeShape() {
  // The outside: a lumpy, irregular half-ball of grey rock, not a bowl.
  const shell = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const pos = shell.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i),
      y = pos.getY(i),
      z = pos.getZ(i);
    const r = 1 + noise3(x * 1.6, y * 1.6, z * 1.6) * 0.22 + noise3(x * 5, y * 5, z * 5) * 0.06;
    pos.setXYZ(i, x * r * 1.1, y * r * 0.9, z * r);
  }
  // The cut face: a thick band of agate round a hollow that goes well down into the rock.
  const RIND = 0.58;
  const rim = new THREE.RingGeometry(RIND, 1.0, 40, 3);
  rim.rotateX(-Math.PI / 2);
  const rp = rim.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < rp.count; i++) {
    const x = rp.getX(i),
      z = rp.getZ(i);
    const r = Math.hypot(x, z);
    const a = Math.atan2(z, x);
    // Its outer edge follows the lumps of the outside; its inner edge wavers.
    const edge = (r - RIND) / (1 - RIND);
    const outer = 1 + noise3(Math.cos(a) * 1.6, 0, Math.sin(a) * 1.6) * 0.22;
    const inner = RIND * (1 + noise3(Math.cos(a) * 2.5, 3, Math.sin(a) * 2.5) * 0.12);
    const k = inner + (outer - inner) * edge;
    // A lip at the hollow's edge, standing a little proud, so the rind has a visible thickness.
    const lip = edge < 0.14 ? 0.04 * Math.sin((edge / 0.14) * Math.PI) : 0;
    rp.setXYZ(i, Math.cos(a) * k * (edge > 0.99 ? 1.1 : 1 + 0.1 * edge), lip, Math.sin(a) * k);
  }
  const lining = new THREE.SphereGeometry(RIND, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  lining.scale(-1, 1.25, 1);
  const parts: [THREE.BufferGeometry, number][] = [
    [shell, 0],
    [rim, 2],
    [lining, 1]
  ];
  const random = lehmer(77);
  const v = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < 140; k++) {
    // A point on the hollow's wall, and a crystal standing from it toward the middle.
    const a = random() * Math.PI * 2;
    const down = Math.acos(1 - random() * 0.97);
    v.set(Math.sin(down) * Math.cos(a), -Math.cos(down) * 1.25, Math.sin(down) * Math.sin(a)).multiplyScalar(RIND * 0.97);
    const len = 0.07 + random() * 0.14;
    const c = new THREE.ConeGeometry(0.03 + random() * 0.03, len, 6);
    c.translate(0, len / 2 - 0.02, 0);
    c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, v.clone().negate().normalize()));
    c.translate(v.x, v.y, v.z);
    parts.push([c, 1]);
  }
  const g = parted(parts);
  g.translate(0, 0.45, 0);
  return g;
}

// A find still set in the broken slab of host rock it came out with (part 2): `drop` puts the slab's top that far
// below the find's middle, so the find sits half in it.
// A chunk knocked out of the wall: lumpy, with sharp ridges where it fractured and flat-ish broken faces.
function fractured(seed: number) {
  const g = new THREE.IcosahedronGeometry(1, 4 + extra);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const lumps = noise3(v.x * 1.6 + seed, v.y * 1.6, v.z * 1.6) * 0.22;
    const ridges = -Math.abs(noise3(v.x * 3.4, v.y * 3.4 + seed, v.z * 3.4)) * 0.18;
    const chips = noise3(v.x * 9, v.y * 9, v.z * 9 + seed) * 0.03;
    const r = 1 + lumps + ridges + chips;
    pos.setXYZ(i, v.x * r, v.y * r, v.z * r);
  }
  g.deleteAttribute("uv");
  return g;
}

function inMatrix(find: THREE.BufferGeometry, width: number, depth: number, drop: number, seed: number, smooth = false) {
  const slab = fractured(seed);
  slab.scale(width, 0.28, depth);
  slab.translate(0.05, -drop - 0.3, 0.03);
  return parted(
    [
      [find, 0],
      [slab, 2]
    ],
    smooth
  );
}

// An old coin's face, struck in relief and worn: a raised rim, a ring of beads inside it, and a head in profile in the
// middle, all on a polar grid so the relief is real geometry. Heights are what the shader reads to find the hollows.
function coinFace() {
  const rings = 30;
  const around = 64;
  const position: number[] = [];
  const index: number[] = [];
  const head = (x: number, z: number) => {
    // A bust facing left: the head an oval, a nose, the neck down to a cut line.
    const skull = 1 - Math.hypot((x + 0.02) / 0.3, (z + 0.12) / 0.34);
    const nose = 1 - Math.hypot((x + 0.33) / 0.07, (z + 0.06) / 0.05);
    const neck = z > 0.1 && z < 0.42 && Math.abs(x + 0.02) < 0.15 ? 0.5 : -1;
    return Math.max(0, Math.max(skull, nose, neck));
  };
  for (let i = 0; i <= rings; i++)
    for (let k = 0; k <= around; k++) {
      const r = (i / rings) * 0.97;
      const a = (k / around) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      let h = r > 0.86 ? 0.08 : 0;
      const bead = r > 0.74 && r < 0.82 ? Math.max(0, 1 - Math.hypot((((a * 28) / (Math.PI * 2)) % 1) - 0.5, (r - 0.78) / 0.04) * 2.4) : 0;
      h += bead * 0.045 + Math.min(1, head(x, z) * 3) * 0.075;
      // Worn: the high points rubbed down and rounded, a few knocks.
      h *= 1 - Math.max(0, noise3(x * 6, 1, z * 6)) * 0.35;
      // A hair over the disc's top (y = 0.07), so the field does not fight it for the same depth.
      position.push(x, 0.072 + h, z);
    }
  for (let i = 0; i < rings; i++)
    for (let k = 0; k < around; k++) {
      const a = i * (around + 1) + k;
      const b = a + 1;
      const c = a + around + 1;
      const d = c + 1;
      // Up: b is a step round (from +x toward +z), c a ring out, and (a, b, c) faces +y. (It was wound facing down,
      // so the struck face was culled and only the plain disc showed.)
      index.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// `fine`: one level more detail throughout, for the inspect view, where a find fills the screen.
function shapeOf(kind: ItemKind, fine = false): THREE.BufferGeometry {
  extra = fine ? 1 : 0;
  try {
    return shapeOfKind(kind, fine ? 2 : 1);
  } finally {
    extra = 0;
  }
}

function shapeOfKind(kind: ItemKind, round: number): THREE.BufferGeometry {
  switch (kind) {
    case "nugget":
      return parted([[nuggetShape(3.1), 0]], true);
    case "quartz":
      return parted([[lumpy(3, 8.4, 0.8), 0]], true);
    case "amber":
      return parted([[insect(), 3]]);
    case "meteorite": {
      // Iron, its skin pocked with thumbprint hollows where it melted on the way down.
      const g = new THREE.IcosahedronGeometry(1, 4 + extra);
      const pos = g.getAttribute("position") as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const pits = Math.abs(noise3(v.x * 3.2, v.y * 3.2, v.z * 3.2));
        const r = 1 + noise3(v.x * 1.1 + 4, v.y * 1.1, v.z * 1.1) * 0.25 - Math.pow(Math.max(0, 0.35 - pits), 2) * 1.2;
        pos.setXYZ(i, v.x * r * 1.15, v.y * r * 0.8, v.z * r);
      }
      g.deleteAttribute("uv");
      g.computeVertexNormals();
      return parted([[g, 0]], true);
    }
    case "diamond":
      return parted([[brilliantCut(), 0]]);
    case "emerald":
      return inMatrix(stepCut(), 1.2, 1.4, 0.05, 11);
    case "ruby": {
      // An oval: the brilliant drawn long.
      const g = brilliantCut();
      g.scale(1, 1, 1.32);
      return inMatrix(g, 1.3, 1.6, 0.05, 23);
    }
    case "sapphire":
      return inMatrix(brilliantCut(), 1.3, 1.3, 0.05, 37);
    case "shard": {
      // A cluster of quartz points fanning up out of a lump of host rock (part 2), the biggest in the middle.
      const parts: [THREE.BufferGeometry, number][] = [];
      const random = lehmer(91);
      const up = new THREE.Vector3(0, 1, 0);
      const lean = new THREE.Vector3();
      for (const [x, z, len, r, tilt, toward] of [
        [0, 0, 1.9, 0.34, 0.05, 0],
        [0.32, 0.12, 1.25, 0.24, 0.42, 0.3],
        [-0.3, -0.12, 1.05, 0.22, 0.5, 3.4],
        [0.06, -0.34, 0.85, 0.18, 0.55, 4.7],
        [-0.12, 0.34, 0.7, 0.16, 0.6, 1.7],
        [0.42, -0.22, 0.5, 0.12, 0.75, 5.6],
        [-0.42, 0.2, 0.45, 0.11, 0.8, 2.4]
      ]) {
        const c = quartzPoint(len, r, random);
        lean.set(Math.cos(toward) * Math.sin(tilt), Math.cos(tilt), Math.sin(toward) * Math.sin(tilt));
        c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, lean));
        c.translate(x, -0.72, z);
        parts.push([c, 0]);
      }
      const base = fractured(5);
      base.scale(0.85, 0.3, 0.8);
      base.translate(0, -0.85, 0);
      parts.push([base, 2]);
      return parted(parts);
    }
    case "amethyst":
      return geodeShape();
    case "fossil":
      return inMatrix(ammoniteShape(), 1.35, 1.25, 0.16, 51, true);
    case "trilobite":
      return inMatrix(trilobiteShape(), 1.2, 1.5, 0.08, 63, true);
    case "tooth": {
      const g = sharkTooth();
      const merged = merge([g], true);
      merged.setAttribute("aPart", g.getAttribute("aPart"));
      return merged;
    }
    case "idol":
      return idolShape();
    case "coin": {
      const g = new THREE.CylinderGeometry(1, 1, 0.14, 48 * round);
      return parted(
        [
          [g, 0],
          [coinFace(), 1]
        ],
        true
      );
    }
    case "compass": {
      // A brass case with a raised bezel round the glass, a ring to hang it by, and a real needle (part 4: red north,
      // blued steel south) on a pivot over the painted dial.
      const body = new THREE.CylinderGeometry(1, 1, 0.35, 32 * round);
      const face = new THREE.CircleGeometry(0.84, 32 * round);
      face.rotateX(-Math.PI / 2);
      face.translate(0, 0.178, 0);
      const bezel = new THREE.TorusGeometry(0.91, 0.075, 8, 40 * round);
      bezel.rotateX(Math.PI / 2);
      bezel.translate(0, 0.19, 0);
      const ring = new THREE.TorusGeometry(0.3, 0.08, 6 * round, 14 * round);
      ring.translate(0, 0, 1.05);
      const needle = new ConvexGeometry(
        [
          [0, 0.19, -0.7],
          [0.075, 0.19, 0],
          [0, 0.19, 0.7],
          [-0.075, 0.19, 0],
          [0, 0.225, -0.5],
          [0, 0.225, 0.5]
        ].map(([x, y, z]) => new THREE.Vector3(x, y, z))
      );
      const pivot = new THREE.SphereGeometry(0.055, 10, 6);
      pivot.translate(0, 0.225, 0);
      return parted([
        [body, 0],
        [face, 1],
        [bezel, 0],
        [ring, 0],
        [needle, 4],
        [pivot, 0]
      ]);
    }
    case "arrowhead": {
      // Knapped flint: a leaf-shaped point, thin, its faces scalloped where the flakes came off.
      const g = new THREE.OctahedronGeometry(1, 3);
      const pos = g.getAttribute("position") as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const scallop = 1 + Math.abs(noise3(v.x * 5, v.y * 5, v.z * 5)) * 0.18;
        pos.setXYZ(i, v.x * 0.55, v.y * 0.13 * scallop, v.z * 1.15);
      }
      g.deleteAttribute("uv");
      return parted([[g, 0]]);
    }
    case "watch": {
      const body = new THREE.CylinderGeometry(1, 1, 0.4, 32 * round);
      const face = new THREE.CircleGeometry(0.82, 32 * round);
      face.rotateX(-Math.PI / 2);
      face.translate(0, 0.202, 0);
      const crown = new THREE.CylinderGeometry(0.15, 0.15, 0.3, 10);
      crown.rotateX(Math.PI / 2);
      crown.translate(0, 0, 1.1);
      const bow = new THREE.TorusGeometry(0.3, 0.06, 6, 14);
      bow.translate(0, 0, 1.35);
      return parted([
        [body, 0],
        [face, 1],
        [crown, 0],
        [bow, 0]
      ]);
    }
  }
}

// What each is made of: base colour, metal (0 or 1), roughness, how gem-like (inner fire, rainbow glints), how it
// glows by rarity (0, 1 Epic, 2 Legendary), and which surface pattern it carries (see the material).
type Look = { colour: [number, number, number]; metal: number; rough: number; gem: number; pattern: number };
const LOOK: Record<ItemKind, Look> = {
  nugget: { colour: [1.0, 0.74, 0.3], metal: 1, rough: 0.3, gem: 0, pattern: 13 },
  quartz: { colour: [0.3, 0.29, 0.28], metal: 0, rough: 0.5, gem: 0, pattern: 3 },
  arrowhead: { colour: [0.13, 0.12, 0.12], metal: 0, rough: 0.4, gem: 0, pattern: 0 },
  coin: { colour: [0.42, 0.29, 0.15], metal: 0.6, rough: 0.45, gem: 0, pattern: 10 },
  fossil: { colour: [0.36, 0.33, 0.27], metal: 0.55, rough: 0.45, gem: 0, pattern: 11 },
  trilobite: { colour: [0.07, 0.068, 0.066], metal: 0, rough: 0.5, gem: 0, pattern: 12 },
  tooth: { colour: [0.12, 0.12, 0.13], metal: 0, rough: 0.18, gem: 0, pattern: 9 },
  amber: { colour: [0.3, 0.11, 0.01], metal: 0, rough: 0.08, gem: 0.3, pattern: 4 },
  emerald: { colour: [0.03, 0.4, 0.16], metal: 0, rough: 0.05, gem: 1, pattern: 0 },
  ruby: { colour: [0.42, 0.008, 0.035], metal: 0, rough: 0.05, gem: 1, pattern: 0 },
  amethyst: { colour: [0.18, 0.17, 0.16], metal: 0, rough: 0.85, gem: 0, pattern: 8 },
  sapphire: { colour: [0.008, 0.035, 0.34], metal: 0, rough: 0.05, gem: 1, pattern: 0 },
  meteorite: { colour: [0.08, 0.075, 0.07], metal: 0.6, rough: 0.6, gem: 0, pattern: 5 },
  compass: { colour: [0.78, 0.58, 0.28], metal: 1, rough: 0.32, gem: 0, pattern: 1 },
  watch: { colour: [0.95, 0.75, 0.38], metal: 1, rough: 0.22, gem: 0, pattern: 2 },
  shard: { colour: [0.2, 0.75, 0.85], metal: 0, rough: 0.08, gem: 0.8, pattern: 6 },
  diamond: { colour: [0.42, 0.44, 0.46], metal: 0, rough: 0.03, gem: 1, pattern: 0 },
  idol: { colour: [0.95, 0.72, 0.32], metal: 1, rough: 0.35, gem: 0, pattern: 7 }
};
const GLOW: Record<Rarity, number> = { Common: 0, Uncommon: 0, Rare: 0, Epic: 1, Legendary: 2 };

// A studio to show finds in (the backpack's icons, the inspect view) rather than the cave: lit by its own key light at
// `key` in full, with no cave shade, no torches and no hover.
type StudioLight = { key: any };

// One material for every find: what each kind is made of comes in per instance (`aLook0`: colour and metal;
// `aLook1`: roughness, gem, rarity glow, pattern), with its details drawn by pattern and by `aPart`.
function findMaterial(t: Textures, studio?: StudioLight) {
  const m = new THREE.MeshStandardNodeMaterial();
  const look0 = attribute("aLook0", "vec4") as any;
  const look1 = attribute("aLook1", "vec4") as any;
  const part = attribute("aPart", "float") as any;
  const pattern = look1.w as any;
  const is = (k: number) => float(1).sub(step(0.5, abs(pattern.sub(k)))) as any;
  const partIs = (k: number) => float(1).sub(step(0.5, abs(part.sub(k)))) as any;
  const g = positionGeometry as any;
  const n = normalize(normalWorld) as any;
  const p = positionWorld as any;
  const toEye = normalize(cameraPosition.sub(p)) as any;
  const id = hash(instanceIndex.add(5)) as any;
  const grain = mx_noise_float(g.mul(9)) as any;
  const fine = mx_noise_float(g.mul(31)) as any;

  let colour = look0.xyz as any;
  let metal = look0.w as any;
  let rough = look1.x.mul(fine.mul(0.35).add(1)) as any;

  // 1 compass: a cream dial with a red needle pointing north and a dark one south, and tick marks round it.
  const angle = atan(g.z, g.x) as any;
  const radius = g.xz.length() as any;
  const ticks = step(0.9, cos(angle.mul(16))).mul(step(0.66, radius)) as any;
  const needle = step(abs(g.x), float(0.09).mul(float(1).sub(abs(g.z).div(0.75)))).mul(step(abs(g.z), 0.75)) as any;
  const dial = mix(mix(vec3(0.7, 0.66, 0.56), vec3(0.12, 0.1, 0.08), ticks), mix(vec3(0.15, 0.15, 0.17), vec3(0.75, 0.06, 0.03), step(g.z, 0)), needle) as any;
  // 2 watch: white enamel, black Roman ticks, two hands.
  const hour = step(abs(g.x.sub(g.z.mul(0.5))), 0.025)
    .mul(step(g.z, 0))
    .mul(step(radius, 0.4)) as any;
  const minute = step(abs(g.z.sub(g.x.mul(-0.2))), 0.02)
    .mul(step(0, g.x))
    .mul(step(radius, 0.65)) as any;
  const face = mix(vec3(0.74, 0.73, 0.69), vec3(0.06, 0.06, 0.07), max(max(ticks, hour), minute)) as any;
  colour = mix(colour, dial, partIs(1).mul(is(1)));
  metal = mix(metal, float(0), partIs(1).mul(is(1)));
  colour = mix(colour, face, partIs(1).mul(is(2)));
  metal = mix(metal, float(0), partIs(1).mul(is(2)));
  // Both dials lie under glass: glossy.
  rough = mix(
    rough,
    float(0.07),
    partIs(1)
      .mul(is(2))
      .add(partIs(1).mul(is(1)))
  );
  // The compass's needle (part 4): red to the north, blued steel to the south.
  colour = mix(colour, mix(vec3(0.03, 0.035, 0.05), vec3(0.62, 0.03, 0.02), step(g.z, 0)), partIs(4));
  metal = mix(metal, float(0.4), partIs(4));
  rough = mix(rough, float(0.3), partIs(4));
  // Its case: milled round the edge, old brass gone brown in the knurling and the hollows, bright where it is handled.
  const side = float(1).sub(smoothstep(0.3, 0.6, abs(normalize(normalLocal).y))) as any;
  const knurl = step(0.5, fract(angle.mul(120 / 6.283))).mul(side).mul(step(0.95, radius)) as any;
  const tarnish = smoothstep(-0.1, 0.5, mx_noise_float(g.mul(3.2))).mul(0.55).add(knurl.mul(0.4)) as any;
  const brass = partIs(0).mul(is(1).add(is(2))) as any;
  colour = mix(colour, mix(colour, vec3(0.2, 0.12, 0.05), tarnish), brass);
  rough = mix(rough, mix(float(0.22), float(0.55), tarnish), brass);
  // The coin's struck face: how high a point stands above the field (the geometry is the relief). Green-brown patina
  // fills the field and the hollows; the rim, the beads and the head stand bright where they have worn.
  const relief = smoothstep(0.075, 0.12, g.y) as any;
  const verdigris = float(1)
    .sub(relief)
    .mul(smoothstep(-0.3, 0.4, grain)) as any;
  const coinFace = mix(mix(colour.mul(0.7), vec3(0.17, 0.24, 0.15), verdigris.mul(0.85)), colour.mul(1.2), relief.mul(0.8)) as any;
  colour = mix(colour, coinFace, partIs(1).mul(is(10)));
  metal = mix(metal, float(1).sub(verdigris.mul(0.9)), partIs(1).mul(is(10)));
  rough = mix(rough, mix(float(0.8), float(0.28), relief), partIs(1).mul(is(10)));
  colour = mix(colour, colour.mul(0.75).add(vec3(0.05, 0.07, 0.04).mul(smoothstep(0.0, 0.6, grain))), partIs(0).mul(is(10)));
  // 3 quartz: milky white, a seam of gold wandering through it.
  const vein = float(1).sub(
    smoothstep(
      0.1,
      0.3,
      abs(
        sin(
          dot(g, vec3(2.1, 1.3, 0.7))
            .mul(2.2)
            .add(grain.mul(2.2))
        )
      )
    )
  ) as any;
  colour = mix(colour, mix(colour.mul(grain.mul(0.08).add(0.95)), vec3(1.0, 0.77, 0.33), vein), is(3));
  metal = mix(metal, vein, is(3));
  // 4 amber: deeper toward the middle; a dark insect inside, seen through the top.
  const bug = smoothstep(0.32, 0.18, g.xz.mul(vec2(1.6, 1)).length()).mul(step(0, g.y)) as any;
  const legs = step(abs(sin(g.z.mul(18))), 0.25)
    .mul(smoothstep(0.5, 0.3, g.xz.length()))
    .mul(step(0.25, abs(g.x)))
    .mul(step(0, g.y)) as any;
  colour = mix(colour, vec3(0.08, 0.04, 0.01), max(bug, legs.mul(0.6)).mul(is(4)));
  // 5 meteorite: dark fusion crust, rust in the pits, bright metal where the crust has worn off.
  const worn = smoothstep(0.58, 0.68, grain) as any;
  colour = mix(colour, mix(mix(colour, vec3(0.16, 0.08, 0.04), smoothstep(0.0, -0.4, grain).mul(0.6)), vec3(0.36, 0.36, 0.38), worn), is(5));
  rough = mix(rough, mix(float(0.75), float(0.35), worn), is(5));
  metal = mix(metal, worn, is(5));
  // 7 idol: old gold, green-black where the carving holds the dirt; the eyes deep and dark.
  const patina = smoothstep(0.25, 0.55, mx_noise_float(g.mul(4)).add(fine.mul(0.15))).mul(0.8) as any;
  const eyes = step(abs(abs(g.x).sub(0.1)), 0.05)
    .mul(step(abs(g.y.sub(0.24)), 0.035))
    .mul(step(0.15, g.z)) as any;
  colour = mix(colour, mix(mix(colour, vec3(0.16, 0.22, 0.14), patina.mul(0.7)), vec3(0.02, 0.02, 0.02), eyes), is(7));
  metal = mix(metal, float(1).sub(patina.mul(0.7)), is(7));
  rough = mix(rough, mix(float(0.3), float(0.8), patina), is(7));
  // 8 geode: the grey rind, the banded agate of the cut rim, and violet amethyst points inside.
  const agate = sin(radius.mul(26).add(grain.mul(2.5)).add(fine.mul(0.6)))
    .mul(0.5)
    .add(0.5)
    .mul(0.55) as any;
  // The cut face: grey-blue chalcedony; a few thin crisp white agate lines inside it, near the hollow.
  const cut = radius.div(1.05) as any;
  const line = (at: number, width: number) => float(1).sub(smoothstep(0, width, abs(cut.sub(at).add(fine.mul(0.006))))) as any;
  const agateLines = max(max(line(0.6, 0.008), line(0.635, 0.006)), max(line(0.68, 0.01), line(0.74, 0.006))) as any;
  colour = mix(colour, mix(mix(vec3(0.12, 0.13, 0.16), vec3(0.08, 0.085, 0.12), agate), vec3(0.62, 0.62, 0.64), agateLines), partIs(2).mul(is(8)));
  // The amethyst: pale, greyed lilac near the rim, deepening to violet down in the hollow.
  const downIn = smoothstep(0.42, -0.25, g.y) as any;
  colour = mix(colour, mix(vec3(0.42, 0.36, 0.44), vec3(0.16, 0.05, 0.24), downIn), partIs(1).mul(is(8)));
  rough = mix(rough, float(0.1), partIs(1).mul(is(8)));
  rough = mix(rough, float(0.85), partIs(2).mul(is(8)));
  // 11 ammonite, pyritised: bronze-grey metal, the frilled suture lines where each chamber's wall met the shell
  // drawn dark across the flanks, iridescent nacre in patches where the outer layer flaked off, grime in the hollows
  // between the ribs and wear on their crests. 12 trilobite: black shale fossil, grime in the furrows, the crests
  // rubbed a little paler.
  const upLocal = normalize(normalLocal).y.abs() as any;
  const across = atan(g.z, g.x) as any;
  const spiral = g.xz.length() as any;
  const suture = float(1).sub(
    smoothstep(
      0.0,
      0.06,
      abs(
        sin(
          across
            .mul(11)
            .add(sin(spiral.mul(70)).mul(0.35))
            .add(spiral.mul(6))
        )
      )
    )
  ) as any;
  const nacre = smoothstep(0.35, 0.55, mx_noise_float(g.mul(3).add(9))) as any;
  const sheen = vec3(0.5).add(cos(vec3(0, 2.1, 4.2).add(dot(n, toEye).mul(5).add(grain))).mul(0.5)) as any;
  const hollow = float(1)
    .sub(upLocal)
    .mul(smoothstep(0.0, 0.5, grain.add(0.3))) as any;
  const fossilBody = partIs(0).mul(is(11).add(is(12))) as any;
  colour = mix(colour, colour.mul(0.35), hollow.mul(0.6).mul(fossilBody));
  colour = mix(colour, colour.mul(1.35), smoothstep(0.85, 0.98, upLocal).mul(0.5).mul(fossilBody));
  colour = mix(colour, vec3(0.08, 0.06, 0.04), suture.mul(0.8).mul(partIs(0)).mul(is(11)));
  colour = mix(colour, sheen.mul(0.55), nacre.mul(0.6).mul(partIs(0)).mul(is(11)));
  metal = mix(metal, float(0.2), nacre.mul(partIs(0)).mul(is(11)));
  rough = mix(rough, float(0.2), nacre.mul(partIs(0)).mul(is(11)));
  rough = mix(rough, float(0.75), hollow.mul(fossilBody));

  // 9 tooth: glossy enamel mottled blue-grey to tan, a dark band (the bourlette) dipping to a V where it meets the
  // root, and the root itself dull brown and porous.
  const enamel = mix(vec3(0.05, 0.058, 0.07), vec3(0.17, 0.12, 0.075), smoothstep(-0.35, 0.55, mx_noise_float(g.mul(vec3(3, 1.3, 3))))) as any;
  const bandY = g.y.add(abs(g.x).mul(0.14)) as any;
  const bourlette = smoothstep(-0.34, -0.31, bandY).mul(smoothstep(-0.17, -0.21, bandY)) as any;
  colour = mix(colour, mix(enamel, vec3(0.03, 0.025, 0.02), bourlette), partIs(0).mul(is(9)));
  rough = mix(rough, mix(float(0.12).add(fine.mul(0.04)), float(0.5), bourlette), partIs(0).mul(is(9)));
  colour = mix(colour, mix(vec3(0.3, 0.21, 0.13), vec3(0.16, 0.11, 0.07), smoothstep(0.2, -0.4, grain)), partIs(1).mul(is(9)));
  rough = mix(rough, float(0.8), partIs(1).mul(is(9)));
  // 13 gold nugget: dark iron-stained dirt down in its creases (how far in from round a point lies, and how far its
  // surface turns from facing out), a little white quartz still stuck to it, the high points polished.
  const out = normalize(g.div(vec3(1.1, 0.62, 0.9))) as any;
  const crease = clamp(
    smoothstep(1.0, 0.8, g.div(vec3(1.1, 0.62, 0.9)).length()).add(float(1).sub(dot(normalize(normalLocal), out)).mul(1.6)),
    0,
    1
  ) as any;
  const gangue = smoothstep(0.55, 0.62, fine).mul(float(1).sub(crease)) as any;
  colour = mix(colour, mix(mix(colour, vec3(0.11, 0.055, 0.025), crease.mul(0.85)), vec3(0.55, 0.53, 0.5), gangue), is(13));
  metal = mix(metal, float(1).sub(max(crease.mul(0.9), gangue)), is(13));
  rough = mix(rough, mix(mix(float(0.2), float(0.7), crease), float(0.6), gangue), is(13));
  // 6 crystal shard: striated across its prism faces as quartz grows, milky and clouded toward the root.
  const striae = pow(abs(sin(g.y.mul(70).add(grain.mul(1.5)))), float(6)).mul(side) as any;
  const milky = smoothstep(0.1, -0.75, g.y) as any;
  colour = mix(colour, mix(colour, vec3(0.6, 0.72, 0.76), milky.mul(0.6)), is(6).mul(partIs(0)));
  rough = mix(rough, rough.add(striae.mul(0.25)).add(milky.mul(0.3)), is(6).mul(partIs(0)));

  // The host rock a crystal broke out with: dull, sandy, no fire.
  const matrix = partIs(2).mul(float(1).sub(is(8))) as any;
  // Host rock (the slabs and stubs) and the geode's crust: the cave wall's own broken-rock scan and relief, darker and
  // damp, laid on in the world as the wall's is.
  // (The crust also wraps a little way onto the geode's cut face, round its outer edge.)
  const rocky = matrix.add(partIs(0).mul(is(8))).add(
    partIs(2)
      .mul(is(8))
      .mul(smoothstep(0.88, 0.95, radius))
  ) as any;
  const wr = weights(n);
  const rockScan = texture(t.broken, p.zy.mul(1.6))
    .rgb.mul(wr.x)
    .add(texture(t.broken, p.xz.mul(1.6)).rgb.mul(wr.y))
    .add(texture(t.broken, p.xy.mul(1.6)).rgb.mul(wr.z)) as any;
  colour = mix(colour, rockScan.mul(vec3(0.42, 0.37, 0.32)), rocky);
  rough = mix(rough, mix(float(0.55), float(0.85), smoothstep(0.2, 0.5, dot(rockScan, vec3(0.33)))), rocky);
  const gem = look1.y.add(partIs(1).mul(is(8))).mul(float(1).sub(matrix)) as any;
  // A cut stone: almost all of what you see in one is light that went in, bounced off the back facets and came out.
  // The view is bent going in (refract), and each facet then shows what lies along its bent ray: here a made-up room of
  // bright and dark (a hash of the bent direction), bright toward your lamp, the stone's colour deepened by how far
  // the light went through it. Inclusions sit along the bent ray too, so they shift as you move. The body itself (what
  // the lights see on the surface) is near black: the surface gives only sharp reflections.
  // Dispersion: red, green and blue bend by slightly different amounts, so at the edges of the room's cells the
  // three part and each facet flashes a colour as it turns (a diamond's "fire"). Internal sparkle: tiny bright points
  // along the bent ray that wink on and off as the view moves.
  const facet = hash(dot(floor_(n.mul(3.5).add(4)) as any, vec3(1, 17, 289)) as any) as any;
  const roomOf = (dir: any) => pow(hash(dot(floor_(dir.mul(2.6).add(3)) as any, vec3(1, 31, 961)) as any) as any, float(6)) as any;
  const bent = refract(toEye.negate(), n, 0.42) as any;
  const room = roomOf(bent);
  const fireRoom = vec3(roomOf(refract(toEye.negate(), n, 0.395)), room, roomOf(refract(toEye.negate(), n, 0.448))) as any;
  const lampAt = studio ? studio.key : lamp.position;
  const towardLamp = normalize(lampAt.sub(p)) as any;
  const lampInside = pow(max(dot(bent, towardLamp.negate()), 0), float(60)) as any;
  const through = float(1).sub(dot(n, toEye).abs()) as any;
  const deep = pow(colour.max(0.001), float(1).add(through.mul(1.5))) as any;
  const inside = g.add(bent.mul(0.4)) as any;
  const specks = smoothstep(0.6, 0.68, mx_noise_float(inside.mul(6))) as any;
  const gemAmount = min(gem, 1) as any;
  // The paler the stone, the more of its fire shows (a diamond's most, a ruby's hardly).
  const pale = smoothstep(0.1, 0.4, min(min(colour.x, colour.y), colour.z)) as any;
  const gemInner = deep
    .mul(mix(vec3(room), fireRoom, pale.mul(0.8).add(0.2)).mul(1.1).add(lampInside.mul(0.8)).add(0.02))
    .mul(float(1).sub(specks.mul(0.7)))
    .mul(gemAmount) as any;
  const sparkCellIn = hash(dot(floor_(bent.mul(9).add(g.mul(4)).add(20)) as any, vec3(1, 57, 3249)) as any) as any;
  const sparkleIn = step(0.965, sparkCellIn)
    .mul(
      pow(sin(rockUniforms.time.mul(2.3).add(sparkCellIn.mul(40))).mul(0.5).add(0.5), float(3))
        .mul(0.7)
        .add(0.3)
    )
    .mul(gemAmount) as any;
  // What the surface reflects, by Fresnel (a gem's own refractive index, metals by their colour): a made-up room
  // with a bright soft light overhead, a band round the horizon and a few lit panels, so polished metal and stone have
  // something to show besides the point lights.
  const mirrored = reflect(toEye.negate(), n) as any;
  const envSoft = smoothstep(0.15, 0.85, mirrored.y)
    .add(exp(abs(mirrored.y).mul(-9)).mul(0.35))
    .add(pow(hash(dot(floor_(mirrored.mul(1.7).add(5)) as any, vec3(1, 13, 169)) as any) as any, float(3)).mul(0.45))
    .add(0.03) as any;
  const f0 = mix(float(0.04), mix(float(0.08), float(0.17), pale), gemAmount) as any;
  const fresnel = f0.add(float(1).sub(f0).mul(pow(float(1).sub(dot(n, toEye).abs()), float(5)))) as any;
  const polish = pow(float(1).sub(clamp(rough, 0, 1)), float(2)) as any;
  const surface = vec3(fresnel.mul(gemAmount))
    .add(colour.mul(metal).mul(polish))
    .mul(envSoft) as any;
  colour = mix(colour, colour.mul(0.08), gemAmount);
  rough = mix(rough, float(0.02), gemAmount);
  // 3: the insect inside a piece of amber (the amber itself is drawn over it, see `amberShell`).
  colour = mix(colour, vec3(0.05, 0.03, 0.015), partIs(3));
  rough = mix(rough, float(0.6), partIs(3));
  m.colorNode = colour;
  if (!studio) m.aoNode = caveShade();
  m.metalnessNode = clamp(metal, 0, 1) as any;
  m.roughnessNode = clamp(rough, 0.02, 1) as any;
  // Fine detail in the surface, not on gems (their faces are flat) or the dials.
  const bump = mx_noise_vec3(g.mul(12)).mul(
    float(0.07)
      .mul(float(1).sub(min(gem, 1)))
      .mul(float(1).sub(partIs(1).mul(is(1).add(is(2)))))
  ) as any;
  m.normalNode = transformNormalToView((mix as any)(normalize(n.add(bump)), triplanarNormal(t.cliffNormal, p, 1.6, n, wr, 1.8), rocky)) as any;

  // How lit it is: your lamp and the nearest torches (in the studio, fully).
  const near = lamp.position.sub(p) as any;
  const lit = (studio ? float(1) : lamp.strength.div(dot(near, near).mul(0.12).add(1)).add(torchLightAt(p).mul(0.5))) as any;
  // A glint: a facet turning to throw the light back as you move. Gems: rainbow fire from within as well.
  const facing = dot(n, toEye) as any;
  // A small sharp glint now and then: one facet (a cell of the surface's directions) catching the light for a moment,
  // on metal and gems only, never a line along the outline.
  const sparkCell = hash(dot(floor_(n.mul(11).add(11)) as any, vec3(1, 23, 529)) as any) as any;
  const flash = pow(sin(rockUniforms.time.mul(id.mul(1.5).add(0.8)).add(sparkCell.mul(60))).max(0), float(160))
    .mul(max(metal, min(gem, 1)))
    .mul(step(0.85, sparkCell)) as any;
  // A gem's fire: small spectral flecks, mostly white, each facet its own colour as it turns.
  const hue = fract(
    facing
      .mul(2.2)
      .add(dot(n, vec3(1.7, 2.3, 0.9)))
      .add(facet)
      .add(id)
  ) as any;
  const spectral = vec3(0.5).add(cos(vec3(0, 2.1, 4.2).add(hue.mul(6.283))).mul(0.5)) as any;
  const rainbow = mix(vec3(1), spectral, 0.45) as any;
  const fire = pow(
    sin(
      dot(n, vec3(13, 7, 11))
        .add(facing.mul(14))
        .add(rockUniforms.time.mul(0.7))
    ).max(0),
    float(40)
  ).mul(step(0.5, facet)) as any;
  const inner = pow(facing.abs(), float(1.5)) as any;
  const glint = mix(vec3(1, 0.95, 0.85), colour.add(0.3), metal.mul(0.5)) as any;
  // 6 shards glow by themselves, breathing slowly.
  const own = vec3(0.3, 0.95, 1.0).mul(
    is(6)
      .mul(float(1).sub(partIs(2)))
      .mul(
        sin(rockUniforms.time.mul(1.3).add(id.mul(9)))
          .mul(0.25)
          .add(0.9)
      )
      .mul(inner.mul(0.8).add(0.5))
  ) as any;
  // (Rarity shows in the air round a find, as a halo (see `Halos`), not on the find itself.)
  // The find under the pointer: a warm gold rim and a lift all over, eased in (see `hoverLight`).
  const hoverNear = smoothstep(hoverLight.reach, hoverLight.reach.mul(0.55), distance(p, hoverLight.at)) as any;
  const hoverGlow = vec3(1.0, 0.72, 0.3)
    .mul(pow(float(1).sub(facing.abs()), float(2.2)).mul(1.5).add(0.14))
    .mul(hoverNear.mul(hoverLight.amount)) as any;
  m.emissiveNode = glint
    .mul(flash.mul(1.1))
    .add(rainbow.mul(fire.mul(gem).mul(1.6)))
    .add(gemInner)
    .add(vec3(1, 0.97, 0.92).mul(sparkleIn.mul(1.4)))
    .add(surface.mul(studio ? 1 : 0.45))
    .mul(lit.min(1.1))
    .add(own)
    .add(studio ? vec3(0) : hoverGlow) as any;
  return m;
}

// Amber: clear honey, darker where you look through more of it (toward its edges), a soft glow from within where
// light comes through it, glassy on the surface. Drawn over the insect in it, so the insect shows through.
function amberMaterial(studio?: StudioLight) {
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false });
  const n = normalize(normalWorld) as any;
  const toEye = normalize(cameraPosition.sub(positionWorld)) as any;
  const facing = dot(n, toEye).abs() as any;
  const through = float(1).sub(facing) as any;
  const near = lamp.position.sub(positionWorld) as any;
  const lit = (studio ? float(1) : lamp.strength.div(dot(near, near).mul(0.12).add(1)).add(torchLightAt(positionWorld).mul(0.5))) as any;
  m.colorNode = mix(vec3(0.07, 0.025, 0.003), vec3(0.12, 0.035, 0.004), through) as any;
  m.roughnessNode = float(0.06);
  m.opacityNode = mix(float(0.3), float(0.92), pow(through, float(1.6))) as any;
  m.emissiveNode = mix(vec3(1.0, 0.55, 0.12), vec3(0.55, 0.16, 0.01), through).mul(lit.min(1.1).mul(0.32).add(0.02)) as any;
  if (!studio) m.aoNode = caveShade();
  return m;
}

// ---- The scene part ------------------------------------------------------------------------------------------------

const MOST = 16;
// Halo sprites, half for Epic and half for Legendary finds.
const HALOS = 8;

// Gives a shape its kind's look, per instance, for `count` instances.
function dress(g: THREE.BufferGeometry, kind: ItemKind, count: number) {
  const look = LOOK[kind];
  const a = new Float32Array(count * 4);
  const b = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    a.set([...look.colour, look.metal], i * 4);
    b.set([look.rough, look.gem, GLOW[ITEMS[kind].rarity], look.pattern], i * 4);
  }
  g.setAttribute("aLook0", new THREE.InstancedBufferAttribute(a, 4));
  g.setAttribute("aLook1", new THREE.InstancedBufferAttribute(b, 4));
  g.computeBoundingSphere();
  return g;
}

export function Collectibles({ rock, textures }: { rock: Rock; textures: Textures }) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const built = useMemo(() => {
    const material = findMaterial(textures);
    const pools = {} as Record<ItemKind, THREE.InstancedMesh>;
    const fliers = {} as Record<ItemKind, THREE.InstancedMesh>;
    const shapes: THREE.BufferGeometry[] = [];
    KINDS.forEach((kind) => {
      const g = dress(shapeOf(kind), kind, MOST);
      shapes.push(g);
      const mesh = new THREE.InstancedMesh(g, material, MOST);
      mesh.count = 1;
      mesh.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0));
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      pools[kind] = mesh;
      // One more for the find flying to your pack (instanced, so it reads the same looks).
      const flier = new THREE.InstancedMesh(g, material, 1);
      flier.visible = false;
      flier.frustumCulled = false;
      fliers[kind] = flier;
    });
    // Halos: a soft breathing light in the air round each Epic (violet) or Legendary (gold) find near you, a little to
    // your side of it, so it shows once the find is uncovered.
    const haloMaterial = (colour: [number, number, number]) => {
      const h = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      // A small tight glow and a faint four-pointed twinkle, not a cloud.
      const q = uv().sub(0.5) as any;
      const r = q.length().mul(2) as any;
      const core = pow(float(1).sub(r).max(0), float(5)) as any;
      const star = exp(abs(q.x).mul(-70))
        .mul(exp(abs(q.y).mul(-7)))
        .add(exp(abs(q.y).mul(-70)).mul(exp(abs(q.x).mul(-7)))) as any;
      const twinkle = pow(sin(rockUniforms.time.mul(2.7)).mul(0.5).add(0.5), float(3)) as any;
      const breathe = sin(rockUniforms.time.mul(1.8)).mul(0.2).add(0.8) as any;
      h.colorNode = vec3(...colour).mul(core.mul(breathe).mul(0.5).add(star.mul(twinkle).mul(0.25))) as any;
      return h;
    };
    const haloLooks = [haloMaterial([0.55, 0.3, 1.0]), haloMaterial([1.0, 0.68, 0.25])];
    const halos = Array.from({ length: HALOS }, (_, k) => {
      const sprite = new THREE.Sprite(haloLooks[k % 2]);
      // Drawn (unseen) until the first look round, so its pipeline is built behind the loader.
      sprite.scale.setScalar(1e-4);
      sprite.frustumCulled = false;
      return sprite;
    });
    // Amber: the honey-coloured lump drawn over the insect, at the same places.
    const lump = lumpy(3, 1.7, 0.72);
    lump.deleteAttribute("normal");
    const amberGeometry = mergeVertices(lump, 1e-4);
    amberGeometry.computeVertexNormals();
    lump.dispose();
    const amberMat = amberMaterial();
    const amberShell = new THREE.InstancedMesh(amberGeometry, amberMat, MOST);
    amberShell.count = 1;
    amberShell.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0));
    amberShell.frustumCulled = false;
    fliers.amber.add(new THREE.Mesh(amberGeometry, amberMat));
    shapes.push(amberGeometry);
    return { pools, shapes, materials: [material, amberMat, ...haloLooks], fliers, halos, haloLooks, amberShell };
  }, []);
  useDispose(...built.shapes, ...built.materials);
  // The studio: the backpack's icons are drawn in it once, a moment after load (which also builds its pipeline, so the
  // inspect view opens with no hitch), and the inspect view draws in it after.
  useEffect(() => {
    if (!(gl as { isWebGPURenderer?: boolean }).isWebGPURenderer) return;
    const made = makeStudio(gl, textures, built.amberShell.geometry);
    studio.current = made;
    const wait = window.setTimeout(() => void renderIcons(made, built.pools).catch((error) => console.warn("burrow icons", error)), 400);
    return () => {
      window.clearTimeout(wait);
      if (studio.current === made) studio.current = null;
      made.dispose();
    };
  }, [gl, built, textures]);

  const state = useMemo(
    () => ({
      near: [] as Item[],
      check: 0,
      flying: [] as { item: Item; t: number; from: THREE.Vector3 }[],
      // Which instance of its kind's pool each near find is drawn as.
      slot: new Map<Item, number>(),
      // The find under the pointer, and the one drawn lifted (the last one, while its highlight fades).
      hover: null as Item | null,
      lifted: null as Item | null,
      amount: 0,
      pointer: { x: 0, y: 0, over: false }
    }),
    []
  );
  const scratch = useMemo(() => ({ m: new THREE.Matrix4(), s: new THREE.Vector3(), to: new THREE.Vector3(), q: new THREE.Quaternion(), right: new THREE.Vector3(), down: new THREE.Vector3() }), []);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __finds: unknown }).__finds = {
      kinds: KINDS,
      // As if dug out: the sound, the card, and into the pack when it lands.
      give: (kind: ItemKind) => {
        pickup(kind, ITEMS[kind].rarity);
        finds.found(kind);
      },
      // Finds set at given points (each `[kind, x, y, z]`).
      setOut(list: [ItemKind, number, number, number][]) {
        shown.length = 0;
        list.forEach(([kind, x, y, z], k) =>
          shown.push({ key: `set-${k}`, kind, p: new THREE.Vector3(x, y, z), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(k, k * 2, 0.3)), scale: ITEMS[kind].size })
        );
        state.check = 0;
      },
      info: () => ({ ...(gl as unknown as { info: { render: object } }).info.render }),
      take: (key: string) => {
        const item = shown.find((x) => x.key === key);
        if (item) take(item);
      },
      // Every kind in a row from `at` along `along`, `gap` apart, turned to face `face`.
      lineUp(at: THREE.Vector3, along: THREE.Vector3, gap: number, only: ItemKind[] = KINDS) {
        shown.length = 0;
        only.forEach((kind, k) => {
          const p = at.clone().addScaledVector(along, k * gap);
          shown.push({
            key: `shown-${kind}`,
            kind,
            p,
            q: new THREE.Quaternion().setFromEuler(
              kind === "coin" ? new THREE.Euler(0.62, 0.35, 0.3) : kind === "tooth" || kind === "idol" || kind === "shard" ? new THREE.Euler(0.15, 0.4, 0) : new THREE.Euler(1.05, 0.25 - k * 0.25, 0)
            ),
            scale: ITEMS[kind].size
          });
        });
        state.check = 0;
      }
    };
  }, [state, gl]);

  // Takes an item: it leaves the rock, flies to the pack, and is counted.
  const take = (item: Item) => {
    if (taken.has(item.key)) return;
    taken.add(item.key);
    if (state.hover === item) state.hover = null;
    if (state.lifted === item) {
      state.lifted = null;
      state.amount = 0;
      hoverLight.amount.value = 0;
    }
    state.near = state.near.filter((n) => n !== item);
    state.check = 0;
    state.flying.push({ item, t: 0, from: item.p.clone() });
    const rarity = ITEMS[item.kind].rarity;
    pickup(item.kind, rarity);
    glint(item.p, item.scale, TIER[rarity] ?? 0, lookOf(item.kind));
    // Its card (found.tsx) counts it into the pack when it lands there.
    finds.found(item.kind);
  };

  // The nearest find the line passes close to within reach, not hidden behind rock.
  const pickAlong = (ray: THREE.Ray, reach: number) => {
    let best: Item | null = null;
    let bestT = reach;
    for (const item of state.near) {
      const t = scratch.to.copy(item.p).sub(ray.origin).dot(ray.direction);
      if (t < 0 || t > bestT) continue;
      const miss = ray.at(t, scratch.s).distanceTo(item.p);
      if (miss > item.scale * 1.6 + 0.06) continue;
      const wall = rock.march(ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, t + 0.5);
      if (wall >= 0 && wall < t - item.scale * 1.2 - 0.05) continue;
      best = item;
      bestT = t;
    }
    return best;
  };
  collectibles.tryPick = (ray: THREE.Ray, reach: number) => {
    const best = pickAlong(ray, reach);
    if (best) take(best);
    return !!best;
  };

  // Where the mouse is, and whether it is over the scene itself (not a panel, not mid-drag).
  useEffect(() => {
    const dom = gl.domElement;
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      state.pointer.x = event.clientX;
      state.pointer.y = event.clientY;
      state.pointer.over = event.target === dom && event.buttons === 0;
    };
    const leave = () => {
      state.pointer.over = false;
    };
    window.addEventListener("pointermove", move);
    dom.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerleave", leave);
      hovered.set(null);
    };
  }, [gl, state]);
  // Draws a near find a little bigger as its highlight comes up (`lift` 0 to 1).
  const lift = (item: Item, amount: number) => {
    const k = state.slot.get(item);
    if (k === undefined) return;
    const pool = built.pools[item.kind];
    pool.setMatrixAt(k, scratch.m.compose(item.p, item.q, scratch.s.setScalar(item.scale * (1 + 0.14 * amount))));
    pool.instanceMatrix.needsUpdate = true;
    if (item.kind === "amber") {
      built.amberShell.setMatrixAt(k, scratch.m);
      built.amberShell.instanceMatrix.needsUpdate = true;
    }
  };
  const hoverRay = useMemo(() => new THREE.Raycaster(), []);
  const hoverAt = useMemo(() => new THREE.Vector2(), []);
  collectibles.dugOut = (x: number, y: number, z: number, r: number) => {
    for (const item of state.near.slice()) if (item.p.distanceTo(scratch.s.set(x, y, z)) < r * 0.85) take(item);
  };

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const eye = camera.position;
    state.check -= dt;
    if (state.check <= 0) {
      state.check = 0.3;
      // Everything findable within reach of the eye, nearest first, up to what each pool holds.
      const found: Item[] = [];
      const lo = (v: number) => Math.floor((v - RADIUS) / CELL);
      const hi = (v: number) => Math.floor((v + RADIUS) / CELL);
      for (let i = lo(eye.x); i <= hi(eye.x); i++)
        for (let j = lo(eye.y); j <= hi(eye.y); j++)
          for (let k = lo(eye.z); k <= hi(eye.z); k++) {
            const item = cellItem(i, j, k);
            if (item && !taken.has(item.key) && item.p.distanceToSquared(eye) < RADIUS * RADIUS) found.push(item);
          }
      for (const item of shown) if (!taken.has(item.key)) found.push(item);
      found.sort((a, b) => a.p.distanceToSquared(eye) - b.p.distanceToSquared(eye));
      state.near = found;
      const counts = {} as Record<ItemKind, number>;
      for (const kind of KINDS) counts[kind] = 0;
      state.slot.clear();
      for (const item of found) {
        const k = counts[item.kind];
        if (k >= MOST) continue;
        counts[item.kind]++;
        state.slot.set(item, k);
        built.pools[item.kind].setMatrixAt(k, scratch.m.compose(item.p, item.q, scratch.s.setScalar(item.scale)));
      }
      // The nearest rare finds get the halos (even slots violet, odd gold).
      let epic = 0;
      let legendary = 0;
      for (const sprite of built.halos) sprite.visible = false;
      for (const item of found) {
        const rarity = ITEMS[item.kind].rarity;
        const slot = rarity === "Legendary" ? 1 + 2 * legendary : rarity === "Epic" ? 2 * epic : -1;
        if (slot < 0 || slot >= HALOS) continue;
        if (rarity === "Legendary") legendary++;
        else epic++;
        const sprite = built.halos[slot];
        sprite.visible = true;
        sprite.position.copy(item.p).addScaledVector(scratch.to.copy(eye).sub(item.p).normalize(), item.scale * 1.6);
        sprite.scale.setScalar(item.scale * 3.2);
      }
      for (const kind of KINDS) {
        const mesh = built.pools[kind];
        if (!counts[kind]) mesh.setMatrixAt(0, scratch.m.makeScale(0, 0, 0));
        mesh.count = Math.max(1, counts[kind]);
        mesh.instanceMatrix.needsUpdate = true;
      }
      built.amberShell.instanceMatrix.array.set(built.pools.amber.instanceMatrix.array);
      built.amberShell.count = built.pools.amber.count;
      built.amberShell.instanceMatrix.needsUpdate = true;
    }
    // The find under the mouse (only with nothing open over the scene): lit up and lifted a little, its name by the
    // pointer. Tested against the near finds only, as a click would be.
    let under: Item | null = null;
    if (state.pointer.over && panels.modal === 0 && state.near.length) {
      const rect = gl.domElement.getBoundingClientRect();
      hoverAt.set(((state.pointer.x - rect.left) / rect.width) * 2 - 1, -((state.pointer.y - rect.top) / rect.height) * 2 + 1);
      hoverRay.setFromCamera(hoverAt, camera);
      under = pickAlong(hoverRay.ray, PICK_REACH);
    }
    if (under !== state.hover) {
      if (under && state.lifted && state.lifted !== under) {
        lift(state.lifted, 0);
        state.amount = 0;
      }
      if (under) state.lifted = under;
      state.hover = under;
      hovered.set(under ? under.kind : null, state.pointer.x, state.pointer.y);
    }
    if (state.lifted) {
      state.amount += ((state.hover ? 1 : 0) - state.amount) * Math.min(1, dt * 14);
      if (!state.hover && state.amount < 0.01) state.amount = 0;
      hoverLight.at.value.copy(state.lifted.p);
      hoverLight.reach.value = state.lifted.scale * 1.9 + 0.04;
      hoverLight.amount.value = state.amount;
      lift(state.lifted, state.amount);
      if (!state.amount) state.lifted = null;
    }
    // Flying home: up out of the rock with a spin, then down past the bottom right of the view, into the pack.
    for (const f of state.flying) {
      f.t += dt;
      const mesh = built.fliers[f.item.kind];
      const k = Math.min(1, f.t / 0.6);
      camera.getWorldDirection(scratch.to);
      scratch.right.crossVectors(scratch.to, camera.up).normalize();
      scratch.down.copy(camera.up).negate();
      const pack = scratch.s.copy(eye).addScaledVector(scratch.to, 0.5).addScaledVector(scratch.right, 0.32).addScaledVector(scratch.down, 0.3);
      const ease = k * k * (3 - 2 * k);
      mesh.position.lerpVectors(f.from, pack, ease);
      mesh.position.y += Math.sin(k * Math.PI) * 0.35;
      mesh.quaternion.copy(f.item.q).multiply(scratch.q.setFromAxisAngle(camera.up, f.t * 9));
      mesh.scale.setScalar(f.item.scale * (1 + Math.sin(k * Math.PI) * 0.8) * (1 - k * 0.6));
      mesh.visible = k < 1;
      if (k >= 1 && f.t < 10) {
        f.t = 10;
        pack.set(0, 0, 0);
      }
    }
    state.flying = state.flying.filter((f) => f.t < 10);
  });

  return (
    <>
      {KINDS.map((kind) => (
        <primitive key={kind} object={built.pools[kind]} />
      ))}
      {KINDS.map((kind) => (
        <primitive key={`f-${kind}`} object={built.fliers[kind]} />
      ))}
      <primitive object={built.amberShell} />
      {built.halos.map((sprite, k) => (
        <primitive key={`h-${k}`} object={sprite} />
      ))}
      <PhotoCapture />
      <Glints />
    </>
  );
}


// The backpack's icons and the inspect view, from the finds themselves: each kind alone, under a warm key light, a
// cool rim and a soft fill that turn with the camera (so the side you look at is always lit), rendered into a target,
// read back and kept as a picture.
const ICON = 192;
// The studio's targets carry a stencil buffer they never use. three shares one render context among every target with
// the same attachments (count, format, type, samples, depth, stencil), and a plain half-float target with depth matches
// the frame buffer target that the warm-up's `compileAsync` builds the scene against. A compile still running when a
// studio target was disposed then built scene pipelines with that target's freed depth texture (depthStencil format
// undefined: "Async render pipeline creation failed"). With a stencil they never share it.
export const studioTarget = (width: number, height: number) =>
  new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType, stencilBuffer: true });
const fromHalf = THREE.DataUtils.fromHalfFloat;
// Draws `scene` into `target` alone, with every piece of renderer state it touches put back exactly as it was, whatever
// happens: the bound target (and its face and level), the frame's extra outputs (MRT), the clear colour and alpha,
// autoClear. Synchronous, so no frame can run in the middle of it.
const keptClear = new THREE.Color();
function renderAlone(renderer: THREE.WebGPURenderer, target: THREE.RenderTarget, scene: THREE.Scene, camera: THREE.Camera) {
  const before = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace();
  const level = renderer.getActiveMipmapLevel();
  const mrt = renderer.getMRT();
  renderer.getClearColor(keptClear);
  const alpha = renderer.getClearAlpha();
  const autoClear = renderer.autoClear;
  try {
    renderer.setMRT(null);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;
    renderer.clear();
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(before, face, level);
    renderer.setMRT(mrt);
    renderer.setClearColor(keptClear, alpha);
    renderer.autoClear = autoClear;
  }
}

// Half floats straight to display bytes: a gentle filmic curve, then sRGB, for colour; clamped for alpha. One lookup
// per channel, so a whole frame of the inspect view converts in a few milliseconds.
let toneTable: Uint8Array | null = null;
let alphaTable: Uint8Array | null = null;
function tables() {
  if (!toneTable || !alphaTable) {
    toneTable = new Uint8Array(65536);
    alphaTable = new Uint8Array(65536);
    for (let h = 0; h < 65536; h++) {
      const v = fromHalf(h);
      const ok = Number.isFinite(v) ? Math.max(0, v) : 0;
      const c = (ok * (2.51 * ok + 0.03)) / (ok * (2.43 * ok + 0.59) + 0.14);
      const x = Math.min(1, Math.max(0, c));
      toneTable[h] = Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255);
      alphaTable[h] = Math.round(Math.min(1, ok) * 255);
    }
  }
  return { tone: toneTable, alpha: alphaTable };
}
// Writes a half-float RGBA readback into `image` (the same size).
export function toImage(pixels: Uint16Array, image: ImageData) {
  const { tone, alpha } = tables();
  const out = image.data;
  const n = Math.min(out.length, pixels.length);
  for (let i = 0; i < n; i += 4) {
    out[i] = tone[pixels[i]];
    out[i + 1] = tone[pixels[i + 1]];
    out[i + 2] = tone[pixels[i + 2]];
    out[i + 3] = alpha[pixels[i + 3]];
  }
}

// The kinds that lie flat (a coin, a dial, the geode's cut face) are shown tipped toward you; the rest turned three
// quarters on.
const FLAT = new Set<ItemKind>(["coin", "compass", "watch", "amethyst"]);

export type Studio = ReturnType<typeof makeStudio>;
// The studio the inspect view draws in (set while the scene is up).
export const studio = { current: null as Studio | null };

// `material` and `shellMaterial` are the studio's own, never the scene's, so nothing compiled for this plain target is
// ever shared with what the frame draws.
function makeStudio(renderer: THREE.WebGPURenderer, textures: Textures, shellGeometry: THREE.BufferGeometry) {
  const keyAt = uniform(new THREE.Vector3()) as any;
  const material = findMaterial(textures, { key: keyAt });
  const shellMaterial = amberMaterial({ key: keyAt });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 50);
  const key = new THREE.DirectionalLight("#fff1dc", 3.2);
  key.position.set(1.5, 2.5, 2);
  const rim = new THREE.DirectionalLight("#bcd4ff", 2.2);
  rim.position.set(-2, 1, -2.5);
  const fill = new THREE.DirectionalLight("#ffe2c4", 0.6);
  fill.position.set(0.6, -1.2, 1.6);
  camera.add(key, rim, fill);
  scene.add(camera, new THREE.AmbientLight("#ffffff", 0.45));
  const holder = new THREE.Group();
  scene.add(holder);
  const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), material, 1);
  mesh.frustumCulled = false;
  const shell = new THREE.Mesh(shellGeometry, shellMaterial);
  shell.frustumCulled = false;
  mesh.add(shell);
  holder.add(mesh);
  const placeholder = mesh.geometry;
  // The inspect view's shapes, built once each, one level finer than the world's.
  const fine = new Map<ItemKind, THREE.BufferGeometry>();
  return {
    renderer,
    shape(kind: ItemKind) {
      let g = fine.get(kind);
      if (!g) {
        g = dress(shapeOf(kind, true), kind, 1);
        fine.set(kind, g);
      }
      return g;
    },
    // Draws `geometry` (a `kind`) into `target`, seen from `yaw` and `pitch` round it, `zoom` times the framing distance.
    draw(kind: ItemKind, geometry: THREE.BufferGeometry, target: THREE.RenderTarget, yaw = 0, pitch = 0, zoom = 1) {
      mesh.geometry = geometry;
      shell.visible = kind === "amber";
      const sphere = geometry.boundingSphere as THREE.Sphere;
      mesh.position.copy(sphere.center).negate();
      const flat = FLAT.has(kind);
      holder.rotation.set(flat ? 0.95 : 0.35, flat ? 0.2 : 0.7, flat ? 0 : 0.15);
      const distance = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(14))) * 0.78 * zoom;
      camera.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(distance);
      camera.lookAt(0, 0, 0);
      camera.aspect = target.width / target.height;
      camera.updateProjectionMatrix();
      scene.updateMatrixWorld(true);
      key.getWorldPosition(keyAt.value);
      renderAlone(renderer, target, scene, camera);
    },
    dispose() {
      material.dispose();
      shellMaterial.dispose();
      for (const g of fine.values()) g.dispose();
      fine.clear();
      mesh.geometry = placeholder;
      placeholder.dispose();
    }
  };
}

// Then, a little at a time, every kind's finer inspect shape is built and drawn once (uploading its buffers), so the
// first look at any find opens without a stall.
async function renderIcons(made: Studio, pools: Record<ItemKind, THREE.InstancedMesh>) {
  const target = studioTarget(ICON, ICON);
  try {
    if (!Object.keys(pack.icons).length) await drawIcons(made, pools, target);
    for (const kind of KINDS) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (studio.current !== made) return;
      made.draw(kind, made.shape(kind), target);
    }
  } finally {
    // Not while a read of it may still be in flight.
    window.setTimeout(() => target.dispose(), 300);
  }
}

async function drawIcons(made: Studio, pools: Record<ItemKind, THREE.InstancedMesh>, target: THREE.RenderTarget) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ICON;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  const image = context.createImageData(ICON, ICON);
  const hasPixels = (pixels: Uint16Array) => pixels.some((h, i) => i % 4 === 3 && h !== 0);
  // A kind whose pipeline is still being built comes back empty. It used to get one retry and was then stored blank, so
  // its backpack slot showed nothing (owner, 27 Nov: "some of the thumbnails don't show up"). Now each kind is tried
  // again with longer waits; one still empty is left out (the slot keeps its drawn fallback) and tried again in a later
  // round, after the rest.
  let left: ItemKind[] = [...KINDS];
  for (let round = 0; round < 4 && left.length; round++) {
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, 1500 * round));
    const missed: ItemKind[] = [];
    for (const kind of left) {
      if (studio.current !== made) return;
      const geometry = pools[kind].geometry;
      let pixels: Uint16Array | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 120 * attempt));
        if (studio.current !== made) return;
        made.draw(kind, geometry, target);
        pixels = (await made.renderer.readRenderTargetPixelsAsync(target, 0, 0, ICON, ICON)) as Uint16Array;
        if (hasPixels(pixels)) break;
      }
      if (!pixels || !hasPixels(pixels)) {
        missed.push(kind);
        continue;
      }
      toImage(pixels, image);
      context.putImageData(image, 0, 0);
      pack.icons[kind] = canvas.toDataURL();
    }
    pack.version++;
    for (const listener of pack.listeners) listener();
    left = missed;
  }
}

// For the scene to call: try to pick up what a click points at, and take what a dig has broken out.
export const collectibles = {
  tryPick: (_ray: THREE.Ray, _reach: number) => false,
  dugOut: (_x: number, _y: number, _z: number, _r: number) => {}
};
