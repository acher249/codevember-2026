import * as THREE from "three/webgpu";
import { type Facet, type Family, edgeDistance } from "./forms";
import { hillsAt, isRiver, PANEL_DEPTH, riverAt, SHEET_WIDTH } from "./map";
import { lehmer } from "../shared/engine/random";

// Everything that lies on the sheet, cut along the current family's creases.

const W = SHEET_WIDTH / 2;
const D = PANEL_DEPTH / 2;
export const RIVER_WIDTH = 0.24;

const GRID = 0.1;
const NX = Math.ceil((2 * W) / GRID) + 1;
const NZ = Math.ceil((2 * D) / GRID) + 1;
let hills: Float32Array | null = null;

const hillGrid = () => {
  if (hills) return hills;
  hills = new Float32Array(NX * NZ);
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) hills[z * NX + x] = hillsAt(x * GRID, z * GRID - D);
  return hills;
};

const sampleHills = (x: number, z: number) => {
  const grid = hillGrid();
  const fx = Math.min(NX - 1.001, Math.max(0, (x + W) / GRID));
  const fz = Math.min(NZ - 1.001, Math.max(0, (z + D) / GRID));
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const a = grid[iz * NX + ix];
  const b = grid[iz * NX + ix + 1];
  const c = grid[(iz + 1) * NX + ix];
  const d = grid[(iz + 1) * NX + ix + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
};

// Keeps the part of a triangle inside a convex facet, as a fan.
function clip(points: number[], facet: Facet) {
  let output = points;
  const poly = facet.poly;
  let area = 0;
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length;
    area += poly[i] * poly[j + 1] - poly[j] * poly[i + 1];
  }
  const winding = Math.sign(area) || 1;
  for (let i = 0; i < poly.length && output.length >= 6; i += 2) {
    const j = (i + 2) % poly.length;
    const ex = poly[j] - poly[i];
    const ez = poly[j + 1] - poly[i + 1];
    const input = output;
    output = [];
    for (let k = 0; k < input.length; k += 2) {
      const l = (k + 2) % input.length;
      const sa = winding * (ex * (input[k + 1] - poly[i + 1]) - ez * (input[k] - poly[i]));
      const sb = winding * (ex * (input[l + 1] - poly[i + 1]) - ez * (input[l] - poly[i]));
      if (sa >= 0) output.push(input[k], input[k + 1]);
      if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) {
        const t = sa / (sa - sb);
        output.push(input[k] + (input[l] - input[k]) * t, input[k + 1] + (input[l + 1] - input[k + 1]) * t);
      }
    }
  }
  return output;
}

const uvOf = (x: number, z: number): [number, number] => [(x + W) / (2 * W), 1 - (z + D) / (2 * D)];

const bounds = (facet: Facet) => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < facet.poly.length; i += 2) {
    minX = Math.min(minX, facet.poly[i]);
    maxX = Math.max(maxX, facet.poly[i]);
    minZ = Math.min(minZ, facet.poly[i + 1]);
    maxZ = Math.max(maxZ, facet.poly[i + 1]);
  }
  return { minX, maxX, minZ, maxZ };
};

export function buildTerrain(family: Family, cell: number) {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const ids: number[] = [];
  const vertex = (facet: Facet, x: number, z: number) => {
    const pinch = Math.min(1, edgeDistance(facet, x, z) * 6) * facet.growth;
    position.push(x, sampleHills(x, z) * pinch, z);
    const e = 0.06;
    const dx = (sampleHills(x + e, z) - sampleHills(x - e, z)) / (2 * e);
    const dz = (sampleHills(x, z + e) - sampleHills(x, z - e)) / (2 * e);
    const length = Math.hypot(dx * pinch, 1, dz * pinch);
    normal.push((-dx * pinch) / length, 1 / length, (-dz * pinch) / length);
    uv.push(...uvOf(x, z));
    ids.push(facet.id);
  };
  const tri = (facet: Facet, ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => {
    const cut = clip([ax, az, bx, bz, cx, cz], facet);
    for (let k = 2; k + 3 < cut.length; k += 2) {
      const up = (cut[k + 1] - cut[1]) * (cut[k + 2] - cut[0]) - (cut[k] - cut[0]) * (cut[k + 3] - cut[1]);
      if (Math.abs(up) < 1e-9) continue;
      vertex(facet, cut[0], cut[1]);
      if (up > 0) {
        vertex(facet, cut[k], cut[k + 1]);
        vertex(facet, cut[k + 2], cut[k + 3]);
      } else {
        vertex(facet, cut[k + 2], cut[k + 3]);
        vertex(facet, cut[k], cut[k + 1]);
      }
    }
  };
  for (const facet of family.facets) {
    const box = bounds(facet);
    const x0 = Math.floor((box.minX + W) / cell);
    const x1 = Math.ceil((box.maxX + W) / cell);
    const z0 = Math.floor((box.minZ + D) / cell);
    const z1 = Math.ceil((box.maxZ + D) / cell);
    for (let iz = z0; iz < z1; iz++) {
      for (let ix = x0; ix < x1; ix++) {
        const ax = ix * cell - W;
        const az = iz * cell - D;
        const bx = ax + cell;
        const bz = az + cell;
        tri(facet, ax, az, bx, az, ax, bz);
        tri(facet, bx, az, bx, bz, ax, bz);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute("aFacet", new THREE.Float32BufferAttribute(ids, 1));
  return geometry;
}

export function buildBack(family: Family) {
  const position: number[] = [];
  const uv: number[] = [];
  const ids: number[] = [];
  const normal: number[] = [];
  for (const facet of family.facets) {
    const poly = facet.poly;
    for (let k = 2; k + 3 < poly.length; k += 2) {
      const order = (poly[k + 1] - poly[1]) * (poly[k + 2] - poly[0]) - (poly[k] - poly[0]) * (poly[k + 3] - poly[1]) > 0 ? [0, k + 2, k] : [0, k, k + 2];
      for (const i of order) {
        position.push(poly[i], -0.012, poly[i + 1]);
        normal.push(0, -1, 0);
        // Mirrored across the sheet, because this side is read from underneath.
        const [u, v] = uvOf(poly[i], poly[i + 1]);
        uv.push(1 - u, v);
        ids.push(facet.id);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute("aFacet", new THREE.Float32BufferAttribute(ids, 1));
  return geometry;
}

// A ribbon along the riverbed, cut like the land so it folds with it.
export function buildRiver(family: Family) {
  const position: number[] = [];
  const normal: number[] = [];
  const ids: number[] = [];
  const stepSize = 0.06;
  const push = (facet: Facet, ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => {
    const cut = clip([ax, az, bx, bz, cx, cz], facet);
    for (let k = 2; k + 3 < cut.length; k += 2) {
      const up = (cut[k + 1] - cut[1]) * (cut[k + 2] - cut[0]) - (cut[k] - cut[0]) * (cut[k + 3] - cut[1]);
      if (Math.abs(up) < 1e-9) continue;
      const order = up > 0 ? [0, k, k + 2] : [0, k + 2, k];
      for (const i of order) {
        position.push(cut[i], 0.012, cut[i + 1]);
        normal.push(0, 1, 0);
        ids.push(facet.id);
      }
    }
  };
  for (const facet of family.facets) {
    const box = bounds(facet);
    for (let x = Math.max(-W, box.minX - stepSize); x < Math.min(W, box.maxX + stepSize); x += stepSize) {
      const next = Math.min(W, x + stepSize);
      const r0 = riverAt(x + W);
      const r1 = riverAt(next + W);
      push(facet, x, r0 - RIVER_WIDTH, next, r1 - RIVER_WIDTH, x, r0 + RIVER_WIDTH);
      push(facet, next, r1 - RIVER_WIDTH, next, r1 + RIVER_WIDTH, x, r0 + RIVER_WIDTH);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("aFacet", new THREE.Float32BufferAttribute(ids, 1));
  return geometry;
}

// Blades keep their place on the sheet; only which facet carries them changes between folds.
export function makeGrass(count: number) {
  const rand = lehmer(7907);
  const x = new Float32Array(count);
  const z = new Float32Array(count);
  const scale = new Float32Array(count);
  const turn = new Float32Array(count);
  let placed = 0;
  for (let tries = 0; tries < count * 3 && placed < count; tries++) {
    const px = (rand() - 0.5) * 2 * W;
    const pz = (rand() - 0.5) * 2 * D;
    if (isRiver(px + W, pz)) continue;
    x[placed] = px;
    z[placed] = pz;
    scale[placed] = 0.06 + rand() * 0.08;
    turn[placed] = rand() * Math.PI * 2;
    placed++;
  }
  return { x, z, scale, turn, count: placed };
}

type Prop = { x: number; z: number; start: number; count: number };

const tint = (geometry: THREE.BufferGeometry, hex: string) => {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const shade = new THREE.Color(hex);
  const count = flat.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([shade.r, shade.g, shade.b], i * 3);
  flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  flat.computeVertexNormals();
  return flat;
};

// Trees and cottages in one draw, each stored relative to its foot.
export function makeProps() {
  const rand = lehmer(4243);
  const props: Prop[] = [];
  const position: number[] = [];
  const normal: number[] = [];
  const color: number[] = [];
  const add = (x: number, z: number, parts: THREE.BufferGeometry[]) => {
    const start = position.length / 3;
    for (const part of parts) {
      position.push(...(part.getAttribute("position").array as Float32Array));
      normal.push(...(part.getAttribute("normal").array as Float32Array));
      color.push(...(part.getAttribute("color").array as Float32Array));
    }
    props.push({ x, z, start, count: position.length / 3 - start });
  };
  const at = (geometry: THREE.BufferGeometry, x: number, y: number, z: number, hex: string, sx = 1, sy = 1, sz = 1, spin = 0) => {
    geometry.scale(sx, sy, sz);
    geometry.rotateY(spin);
    geometry.translate(x, y, z);
    return tint(geometry, hex);
  };
  const greens = ["#2f6330", "#3d7a36", "#4e8a3a", "#27552c"];
  for (let t = 0; t < 76; t++) {
    const x = (rand() - 0.5) * (2 * W - 0.4);
    const z = (rand() - 0.5) * (2 * D - 0.5);
    if (isRiver(x + W, z)) continue;
    const size = 0.15 + rand() * 0.15;
    const parts = [at(new THREE.CylinderGeometry(0.018, 0.028, size * 1.1, 6), 0, size * 0.55, 0, "#4a3524")];
    if (rand() > 0.45) {
      parts.push(at(new THREE.IcosahedronGeometry(size * 0.62, 1), 0, size * 1.25, 0, greens[Math.floor(rand() * 4)], 1, 0.95, 1));
      parts.push(at(new THREE.IcosahedronGeometry(size * 0.42, 1), size * 0.3, size, -size * 0.15, greens[Math.floor(rand() * 4)]));
    } else {
      parts.push(at(new THREE.ConeGeometry(size * 0.5, size * 1.7, 8), 0, size * 1.4, 0, "#1f4a2d"));
    }
    add(x, z, parts);
  }
  for (let c = 0; c < 14; c++) {
    const x = (rand() - 0.5) * (2 * W - 0.9);
    const z = (rand() - 0.5) * (2 * D - 1.5);
    if (isRiver(x + W, z)) continue;
    const spin = rand() * Math.PI;
    const roof = new THREE.CylinderGeometry(0, 0.11, 0.09, 4, 1);
    roof.rotateY(Math.PI / 4);
    add(x, z, [at(new THREE.BoxGeometry(0.2, 0.13, 0.13), 0, 0.065, 0, "#efe4cf", 1, 1, 1, spin), at(roof, 0, 0.175, 0, c % 2 ? "#a4492f" : "#59626f", 1.35, 1, 0.9, spin)]);
  }
  return { props, position: Float32Array.from(position), normal: Float32Array.from(normal), color: Float32Array.from(color) };
}
