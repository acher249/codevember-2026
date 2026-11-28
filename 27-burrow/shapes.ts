import * as THREE from "three/webgpu";
import { lehmer } from "../shared/engine/random";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { noise3 } from "./field";

// The cave dressing's shapes, made once at load (dressing.tsx and caverns.tsx). Pure geometry, no shaders, so every
// normal can be checked away from the page. Each is built with its faces wound outward and its normals agreeing:
// closed solids are checked by their signed volume (`outward`), convex ones face by face against their centre, sheets
// and extrusions face by face against the way they should look. Nothing here needs DoubleSide.

type Extra = Record<string, number[]>;

// An indexed geometry from plain arrays, its normals smooth across shared vertices.
function indexed(position: number[], index: number[], extra: Extra = {}) {
  const g = new THREE.BufferGeometry();
  const count = position.length / 3;
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  for (const [name, data] of Object.entries(extra)) g.setAttribute(name, new THREE.Float32BufferAttribute(data, data.length / count));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// A closed mesh's signed volume: positive when its faces are wound outward.
export function signedVolume(g: THREE.BufferGeometry) {
  const p = g.getAttribute("position");
  const index = g.getIndex();
  const n = index ? index.count : p.count;
  const at = (i: number) => (index ? index.getX(i) : i);
  let v = 0;
  for (let i = 0; i < n; i += 3) {
    const a = at(i);
    const b = at(i + 1);
    const c = at(i + 2);
    const ax = p.getX(a);
    const ay = p.getY(a);
    const az = p.getZ(a);
    const bx = p.getX(b);
    const by = p.getY(b);
    const bz = p.getZ(b);
    const cx = p.getX(c);
    const cy = p.getY(c);
    const cz = p.getZ(c);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

// Turns a closed mesh outward if it was wound inside out, and makes its normals again.
function outward(g: THREE.BufferGeometry) {
  if (signedVolume(g) >= 0) return g;
  const index = g.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;
  }
  g.computeVertexNormals();
  return g;
}

// Parts merged into one indexed geometry, keeping each part's own normals and attributes (all must have the same set).
export function mergeIndexed(parts: THREE.BufferGeometry[]) {
  const names = Object.keys(parts[0].attributes);
  const total = parts.reduce((sum, g) => sum + g.getAttribute("position").count, 0);
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const size = parts[0].getAttribute(name).itemSize;
    const data = new Float32Array(total * size);
    let at = 0;
    for (const g of parts) {
      const a = g.getAttribute(name);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < size; c++) data[(at + i) * size + c] = a.getComponent(i, c);
      at += a.count;
    }
    out.setAttribute(name, new THREE.BufferAttribute(data, size));
  }
  const index: number[] = [];
  let base = 0;
  for (const g of parts) {
    const count = g.getAttribute("position").count;
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) index.push(ix.getX(i) + base);
    else for (let i = 0; i < count; i++) index.push(base + i);
    base += count;
  }
  out.setIndex(total > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  return out;
}

// Flat faces from polygons (each a list of points), every face turned to look away from `centre`: right for any convex
// solid, whatever order its corners were listed in. `extra(face)` gives per-face attribute values.
function convex(polygons: number[][][], centre: number[], extra?: (face: number) => Record<string, number[]>) {
  const position: number[] = [];
  const more: Extra = {};
  polygons.forEach((poly, face) => {
    const values = extra?.(face) ?? {};
    const c = poly.reduce((s, q) => [s[0] + q[0] / poly.length, s[1] + q[1] / poly.length, s[2] + q[2] / poly.length], [0, 0, 0]);
    const out = [c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]];
    for (let k = 1; k < poly.length - 1; k++) {
      const a = poly[0];
      let b = poly[k];
      let d = poly[k + 1];
      const n = cross3(sub3(b, a), sub3(d, a));
      if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) [b, d] = [d, b];
      position.push(...a, ...b, ...d);
      for (const [name, v] of Object.entries(values)) (more[name] ??= []).push(...v, ...v, ...v);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  for (const [name, data] of Object.entries(more)) g.setAttribute(name, new THREE.Float32BufferAttribute(data, data.length / (position.length / 3)));
  g.computeVertexNormals();
  return g;
}

const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A surface of revolution about y. The profile walks down the outside with the solid on its right (from the top pole
// out to the rim, down the side, in to the bottom pole); a point with r = 0 is a pole, one vertex. Rings wrap with no
// seam, so the normals are smooth all the way round. `x`, `z` set a ring off the axis; `shape(angle, row)` swells a
// vertex in or out; `warp` moves the finished points before the normals are made.
type Ring = { r: number; y: number; x?: number; z?: number; along?: number };
function lathe(profile: Ring[], sides: number, shape?: (angle: number, row: number) => number, warp?: (p: number[], row: number) => void) {
  const position: number[] = [];
  const along: number[] = [];
  const rows: number[][] = [];
  profile.forEach((ring, i) => {
    const row: number[] = [];
    const count = ring.r === 0 ? 1 : sides;
    for (let k = 0; k < count; k++) {
      const a = (k / sides) * Math.PI * 2;
      const s = ring.r === 0 ? 0 : (shape?.(a, i) ?? 1);
      const p = [(ring.x ?? 0) + Math.cos(a) * ring.r * s, ring.y, (ring.z ?? 0) + Math.sin(a) * ring.r * s];
      warp?.(p, i);
      row.push(position.length / 3);
      position.push(...p);
      along.push(ring.along ?? 0);
    }
    rows.push(row);
  });
  const index: number[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const A = rows[i];
    const B = rows[i + 1];
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      if (A.length === 1 && B.length === 1) break;
      if (A.length === 1) index.push(A[0], B[k1], B[k]);
      else if (B.length === 1) index.push(A[k], A[k1], B[0]);
      else index.push(A[k], A[k1], B[k], A[k1], B[k1], B[k]);
    }
  }
  return indexed(position, index, { aAlong: along });
}

// A tube along a path of points, closed at both ends, its cross-section an ellipse (`r` across the path's own `side`
// direction, `r * flat` across the other), the radius given per point.
function tube(path: THREE.Vector3[], up: THREE.Vector3, radius: (t: number) => number, sides: number, flat = 1) {
  const position: number[] = [];
  const index: number[] = [];
  const rings: number[][] = [];
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const other = new THREE.Vector3();
  path.forEach((p, i) => {
    tangent.subVectors(path[Math.min(path.length - 1, i + 1)], path[Math.max(0, i - 1)]).normalize();
    side.crossVectors(tangent, up).normalize();
    other.crossVectors(side, tangent).normalize();
    const t = i / (path.length - 1);
    const r = radius(t);
    const row: number[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      row.push(position.length / 3);
      position.push(p.x + (side.x * Math.cos(a) + other.x * Math.sin(a) * flat) * r, p.y + (side.y * Math.cos(a) + other.y * Math.sin(a) * flat) * r, p.z + (side.z * Math.cos(a) + other.z * Math.sin(a) * flat) * r);
    }
    rings.push(row);
  });
  for (let i = 0; i < rings.length - 1; i++)
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      index.push(rings[i][k], rings[i][k1], rings[i + 1][k], rings[i][k1], rings[i + 1][k1], rings[i + 1][k]);
    }
  // The body turned outward: its first face against the way out from the path there.
  const face = (a: number, b: number, c: number) => {
    const pa = [position[a * 3], position[a * 3 + 1], position[a * 3 + 2]];
    return cross3(sub3([position[b * 3], position[b * 3 + 1], position[b * 3 + 2]], pa), sub3([position[c * 3], position[c * 3 + 1], position[c * 3 + 2]], pa));
  };
  const n0 = face(index[0], index[1], index[2]);
  const out0 = sub3([position[index[0] * 3], position[index[0] * 3 + 1], position[index[0] * 3 + 2]], [path[0].x, path[0].y, path[0].z]);
  if (n0[0] * out0[0] + n0[1] * out0[1] + n0[2] * out0[2] < 0) for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
  // Rounded ends: a pole a little beyond each, every cap face turned toward it.
  for (const [row, from, to, r] of [
    [rings[0], path[0], path[1], radius(0)],
    [rings[rings.length - 1], path[path.length - 1], path[path.length - 2], radius(1)]
  ] as const) {
    const pole = position.length / 3;
    const away = from.clone().sub(to).normalize();
    const beyond = from.clone().addScaledVector(away, r * 0.6);
    position.push(beyond.x, beyond.y, beyond.z);
    for (let k = 0; k < sides; k++) {
      const a = row[k];
      let b = row[(k + 1) % sides];
      let c = pole;
      const n = face(a, b, c);
      if (n[0] * away.x + n[1] * away.y + n[2] * away.z < 0) [b, c] = [c, b];
      index.push(a, b, c);
    }
  }
  return indexed(position, index);
}

// ---- Dripstone -----------------------------------------------------------------------------------------------------

// Dripstone, hanging from y = 0 down to y = -1 (a stalagmite is the same turned over). Never a clean cone: the radius
// swells and pinches down its length where the water ran faster or slower, thin rings stand round it where the flow
// paused (the dripstone's growth bands), broad flutes run down it, it bends a little off the vertical, and the tip
// rounds off with a drop of water hanging from it. `aAlong` is how far down a point is (0 at the root, 1 at the tip;
// 1.6 marks the water drop). A cluster: a main one, two to four smaller beside it.
//
// The rings were once wound clockwise seen from outside, so the faces looked inward: three culled the outside and
// drew the far inside wall with inverted normals, lit as a hollow. Every ring here is checked outward (signedVolume).
export function dripCluster(seed: number, column = false, mound = false) {
  const random = lehmer(seed);
  const parts: THREE.BufferGeometry[] = [];
  const one = (x: number, z: number, length: number, radius: number, main: boolean, fused = false) => {
    const rings = main ? 30 : 16;
    const sides = main ? 13 : 9;
    const lean = [(random() - 0.5) * 0.25, (random() - 0.5) * 0.25];
    const s0 = random() * 100;
    const profile: Ring[] = [];
    // Closed at the root, a little up inside the rock, so no gap shows where the roof curves away.
    profile.push({ r: 0, y: 0.12, x, z, along: 0 });
    for (let i = 0; i <= rings; i++) {
      const t = i / rings;
      // Blunt and stubby: thick most of the way, rounding off to the tip. A column (`fused`) is a stalactite and the
      // stalagmite under it grown together: fat at both ends, pinched where they met.
      const body = fused
        ? 0.42 + Math.pow(Math.abs(t - 0.55) * 1.8, 1.6) * 0.75
        : mound
          ? // A stalagmite builds up from splashes: a stack of rounded tiers, domed on top, never a point.
            (1 - t * 0.45) * Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, t - 0.72) / 0.28, 2))) * (1 + Math.max(0, Math.sin(t * 26 + s0)) * 0.12)
          : Math.pow(1 - t, 0.75) * (t > 0.8 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.8) / 0.2, 2))) * 0.7 + 0.3 : 1);
      // Growth rings: thin and sharp, a few per length, stronger on the hanging ones.
      const band = Math.pow(0.5 + 0.5 * Math.sin(t * (main ? 31 : 19) + s0 * 3), 10) * (mound ? 0.035 : 0.075);
      const profileR = body * (1 + Math.sin(t * 17 + s0) * 0.1 + Math.sin(t * 7 + s0 * 2) * 0.14 + band) + (!fused && !mound && t > 0.9 ? Math.sin(((t - 0.9) / 0.1) * Math.PI) * 0.05 : 0);
      profile.push({ r: Math.max(0.012, radius * profileR), y: -t * length, x: x + lean[0] * t * t * length, z: z + lean[1] * t * t * length, along: t });
    }
    const last = profile[profile.length - 1];
    // The tip rounds off; a column's foot closes down inside the floor.
    profile.push({ r: 0, y: last.y - (fused ? 0.12 : last.r * 0.9), x: last.x, z: last.z, along: 1 });
    parts.push(
      lathe(profile, sides, (a, row) => {
        const t = Math.max(0, Math.min(1, (row - 1) / rings));
        // Knobs and lumps round it, broad ones: the drips' own bulges, never spikes; and soft flutes down it.
        return 1 + noise3(Math.cos(a) * 0.8 + s0, t * 4 * length, Math.sin(a) * 0.8) * 0.16 + (main ? Math.sin(a * 5 + t * 2.5 + s0) * 0.035 : 0);
      })
    );
    // The drop hanging from a stalactite's tip, a little long, as it is before it falls (`aAlong` 1.6: water).
    if (main && !mound && !fused) {
      const rx = 0.03;
      const ry = 0.022;
      const top = last.y - last.r * 0.6;
      const drop: Ring[] = [];
      for (let i = 0; i <= 7; i++) {
        const f = (i / 7) * Math.PI;
        // Narrower where it hangs from the stone, fuller at the bottom.
        const r = Math.sin(f) * rx * (0.55 + 0.45 * (i / 7));
        drop.push({ r: i === 0 || i === 7 ? 0 : r, y: top - (1 - Math.cos(f)) * ry, x: last.x, z: last.z, along: 1.6 });
      }
      parts.push(lathe(drop, 10));
    }
  };
  if (column) {
    one(0, 0, 1, 0.5, true, true);
    return mergeIndexed(parts.map(outward));
  }
  one(0, 0, 1, 0.5, true);
  const others = 1 + Math.floor(random() * 3);
  for (let k = 0; k < others; k++) {
    const angle = random() * Math.PI * 2;
    const d = 0.55 + random() * 0.6;
    one(Math.cos(angle) * d, Math.sin(angle) * d, 0.2 + random() * 0.55, 0.18 + random() * 0.22, false);
  }
  return mergeIndexed(parts.map(outward));
}

// Soda straws: a patch of thin hollow tubes, each the width of a drop, hanging from y = 0, the longest a unit long,
// scattered over a unit square. Open at the foot, as they are (the inside shows only as a dark ring).
export function straws(seed: number) {
  const random = lehmer(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 11; k++) {
    const length = 0.15 + Math.pow(random(), 1.5) * 0.85;
    const tube = new THREE.CylinderGeometry(0.012, 0.011, length, 6, 4, true);
    tube.translate((random() - 0.5) * 1, -length / 2, (random() - 0.5) * 1);
    tube.deleteAttribute("uv");
    const pos = tube.getAttribute("position");
    const along: number[] = [];
    for (let i = 0; i < pos.count; i++) along.push(-pos.getY(i) / length);
    tube.setAttribute("aAlong", new THREE.Float32BufferAttribute(along, 1));
    parts.push(tube);
  }
  return mergeIndexed(parts);
}

// A drapery curtain: one sheet of calcite a few centimetres thick, hanging from a crack in the roof (x from -0.5 to 0.5,
// down from y = 0), in broad soft folds that deepen toward its foot, its lower edge wandering and rounded; along the
// top a rounded ridge where it grows from the crack. A closed shell (front, back and the rounded lip), so it is drawn
// one-sided with true normals. `aAlong`: 0 at the crack, 1 at the free edge (for the thinning and the light).
export function curtain() {
  const columns = 64;
  const rows = 12;
  const wave = (u: number, v: number) => Math.sin(u * 19) * 0.07 * (0.35 + v) + Math.sin(u * 7 + 1) * 0.06 + Math.sin(u * 41) * 0.012 * v;
  const position: number[] = [];
  const along: number[] = [];
  const index: number[] = [];
  const at = (i: number, j: number, face: number) => {
    const u = i / columns;
    const depth = 0.6 + Math.sin(u * 9 + 1) * 0.2 + Math.sin(u * 23) * 0.07 + noise3(u * 6, 2, 5) * 0.12;
    // Narrowing toward each end, so it grows out of the crack rather than stopping.
    const end = Math.sin(u * Math.PI);
    const v = j / rows;
    // Thick at the crack, thin at the free edge, thinner toward the ends.
    const thick = (0.035 - v * 0.024) * (0.25 + end * 0.75);
    position.push(u - 0.5, -v * depth * (0.35 + end * 0.65) + 0.02, wave(u, v) + face * thick);
    along.push(v);
  };
  const W = columns + 1;
  const H = rows + 1;
  for (const face of [1, -1]) for (let i = 0; i <= columns; i++) for (let j = 0; j <= rows; j++) at(i, j, face);
  const front = (i: number, j: number) => i * H + j;
  const back = (i: number, j: number) => W * H + i * H + j;
  for (let i = 0; i < columns; i++)
    for (let j = 0; j < rows; j++) {
      // Front faces +z, back faces -z (checked below).
      index.push(front(i, j), front(i, j + 1), front(i + 1, j), front(i + 1, j), front(i, j + 1), front(i + 1, j + 1));
      index.push(back(i, j), back(i + 1, j), back(i, j + 1), back(i + 1, j), back(i + 1, j + 1), back(i, j + 1));
    }
  // The lower lip and the two ends join front to back; the top is closed into the roof by the ridge.
  for (let i = 0; i < columns; i++) index.push(front(i, rows), back(i, rows), front(i + 1, rows), front(i + 1, rows), back(i, rows), back(i + 1, rows));
  for (let j = 0; j < rows; j++) {
    index.push(front(0, j), back(0, j), front(0, j + 1), front(0, j + 1), back(0, j), back(0, j + 1));
    index.push(front(columns, j), front(columns, j + 1), back(columns, j), front(columns, j + 1), back(columns, j + 1), back(columns, j));
  }
  for (let i = 0; i < columns; i++) index.push(front(i, 0), front(i + 1, 0), back(i, 0), front(i + 1, 0), back(i + 1, 0), back(i, 0));
  const sheet = outward(indexed(position, index, { aAlong: along }));
  // The ridge along the crack.
  const path = Array.from({ length: columns + 1 }, (_, i) => new THREE.Vector3(i / columns - 0.5, 0.01, wave(i / columns, 0)));
  const ridge = tube(path, new THREE.Vector3(0, 1, 0), (t) => 0.045 * (0.4 + Math.sin(t * Math.PI) * 0.6), 6);
  ridge.setAttribute("aAlong", new THREE.Float32BufferAttribute(new Float32Array(ridge.getAttribute("position").count), 1));
  return mergeIndexed([sheet, ridge]);
}

// ---- Fungi ---------------------------------------------------------------------------------------------------------

// A mushroom about a unit tall, one closed surface of revolution: a domed cap whose margin rolls under, the gills'
// underside rising to the stem, a slender stem with a ring part way up and a bulb at its foot. `aPart` 1 on the cap's
// top, 0 on the gills and stem. `detail` for the giant ones.
export function mushroom(detail = false) {
  const sides = detail ? 28 : 10;
  const profile: Ring[] = [{ r: 0, y: 1.0, along: 1 }];
  const cap = detail ? 9 : 5;
  for (let i = 1; i <= cap; i++) {
    const f = (i / cap) * Math.PI * 0.5;
    profile.push({ r: Math.sin(f) * 0.5, y: 0.72 + Math.cos(f) * 0.28 * (1 - 0.15 * Math.sin(f * 2)), along: 1 });
  }
  // The margin rolling under, then the gills up to the stem.
  profile.push({ r: 0.5, y: 0.69, along: 1 });
  profile.push({ r: 0.46, y: 0.665 });
  const gills = detail ? 5 : 2;
  for (let i = 1; i <= gills; i++) {
    const t = i / gills;
    profile.push({ r: 0.46 - t * 0.37, y: 0.665 + Math.sin(t * Math.PI * 0.5) * 0.07 });
  }
  // Down the stem: the ring (detail only), then the swelling foot.
  if (detail) profile.push({ r: 0.085, y: 0.6 }, { r: 0.13, y: 0.55 }, { r: 0.12, y: 0.53 }, { r: 0.08, y: 0.52 });
  const stem = detail ? 6 : 3;
  for (let i = 0; i <= stem; i++) {
    const t = i / stem;
    profile.push({ r: 0.075 + t * t * 0.06, y: (detail ? 0.48 : 0.66) * (1 - t) + 0.03 });
  }
  profile.push({ r: 0.1, y: 0.005 }, { r: 0, y: 0 });
  const g = outward(lathe(profile, sides, (a, row) => (row <= cap ? 1 + Math.sin(a * 3 + 1) * 0.03 : 1)));
  const along = g.getAttribute("aAlong");
  g.setAttribute("aPart", along);
  g.deleteAttribute("aAlong");
  return g;
}

// ---- Crystals ------------------------------------------------------------------------------------------------------

// A selenite (gypsum) blade, one unit long along +y: a flattened six-sided prism with a slanted chisel end at each
// end, as gypsum grows (monoclinic, so the ends lean); two small blades sprout beside its root. `aFace` a number per
// face (for the satin sheen to change face to face), `aEnd` 1 on the terminations.
export function seleniteBlade() {
  const hex = (r: number, y: number, skew: number) =>
    [
      [1, 0],
      [0.55, 0.36],
      [-0.55, 0.36],
      [-1, 0],
      [-0.55, -0.36],
      [0.55, -0.36]
    ].map(([x, z]) => [x * r + skew, y, z * r]);
  const blade = (y0: number, y1: number, r: number, end: number) => {
    const a = hex(r, y0 + end, 0);
    const b = hex(r, y1 - end, 0);
    // The chisels: a ridge across the narrow width, set off the axis.
    const top = [
      [-0.35 * r, y1, 0],
      [0.25 * r, y1 - end * 0.35, 0]
    ];
    const bottom = [
      [0.35 * r, y0, 0],
      [-0.25 * r, y0 + end * 0.35, 0]
    ];
    const faces: number[][][] = [];
    for (let k = 0; k < 6; k++) faces.push([a[k], a[(k + 1) % 6], b[(k + 1) % 6], b[k]]);
    faces.push([b[0], b[1], top[1]], [b[1], b[2], top[0], top[1]], [b[2], b[3], top[0]], [b[3], b[4], top[0]], [b[4], b[5], top[1], top[0]], [b[5], b[0], top[1]]);
    faces.push([a[0], a[1], bottom[0]], [a[1], a[2], bottom[1], bottom[0]], [a[2], a[3], bottom[1]], [a[3], a[4], bottom[1]], [a[4], a[5], bottom[0], bottom[1]], [a[5], a[0], bottom[0]]);
    return convex(faces, [0, (y0 + y1) / 2, 0], (f) => ({ aFace: [((f * 7919) % 13) / 13], aEnd: [f >= 6 ? 1 : 0] }));
  };
  const main = blade(0.0, 1.0, 1, 0.07);
  const parts = [main];
  // Two small ones at the root, leaning out.
  for (const [angle, lean, length] of [
    [0.6, 0.35, 0.22],
    [2.9, -0.4, 0.16]
  ]) {
    const small = blade(0, length, 0.45, 0.04);
    small.rotateZ(lean);
    small.rotateY(angle);
    small.translate(Math.cos(angle) * 0.6, 0.03, -Math.sin(angle) * 0.6);
    parts.push(small);
  }
  return mergeIndexed(parts);
}

// A quartz point (the geode's amethyst): a long six-sided prism, its faces of slightly different widths, narrowing a
// little toward the end, capped by six faces meeting in an apex set off the axis, three larger and three smaller as
// the two rhombohedra of real quartz alternate. One unit long and two wide, its root buried below y = 0. `aFace` a
// number per face (for the light inside), `aEnd` 1 on the termination.
export function quartzPoint(seed = 3) {
  const random = lehmer(seed);
  const angles = Array.from({ length: 6 }, (_, k) => ((k + (random() - 0.5) * 0.18) / 6) * Math.PI * 2);
  const radii = angles.map(() => 0.92 + random() * 0.16);
  const corner = (k: number, y: number, r: number) => [Math.cos(angles[k]) * r * radii[k], y, Math.sin(angles[k]) * r * radii[k]];
  // The termination's corners step up and down: the large faces reach further down the prism.
  const shoulder = (k: number) => 0.7 + (k % 2 ? 0.06 : -0.03);
  const apex = [0.14, 1, -0.07];
  const faces: number[][][] = [];
  for (let k = 0; k < 6; k++) {
    const n = (k + 1) % 6;
    faces.push([corner(k, -0.35, 1), corner(n, -0.35, 1), corner(n, shoulder(n), 0.9), corner(k, shoulder(k), 0.9)]);
  }
  for (let k = 0; k < 6; k++) {
    const n = (k + 1) % 6;
    faces.push([corner(k, shoulder(k), 0.9), corner(n, shoulder(n), 0.9), apex]);
  }
  // The root, closed (buried).
  faces.push(Array.from({ length: 6 }, (_, k) => corner(k, -0.35, 1)));
  return convex(faces, [0, 0.3, 0], (f) => ({ aFace: [random()], aEnd: [f >= 6 && f < 12 ? 1 : 0] }));
}

// ---- Bones ---------------------------------------------------------------------------------------------------------

// A long bone, one unit along +y: a shaft that bows a little, swelling to ends that flatten into two knuckles.
export function longBone() {
  const profile: Ring[] = [{ r: 0, y: 1.02 }];
  const rows = 22;
  for (let i = 0; i <= rows; i++) {
    const t = 1 - i / rows;
    const end = Math.max(Math.exp(-(((t - 0.05) / 0.08) ** 2)), Math.exp(-(((t - 0.95) / 0.08) ** 2)));
    const round = Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, Math.abs(t - 0.5) - 0.47) / 0.05, 2)));
    profile.push({ r: Math.max(0.01, (0.042 + end * 0.065) * (0.35 + round * 0.65)), y: t });
  }
  profile.push({ r: 0, y: -0.02 });
  return outward(
    lathe(profile, 10, undefined, (p) => {
      const t = p[1];
      const ends = Math.max(0, Math.abs(t - 0.5) - 0.3) / 0.2;
      // The ends flattened side to side, and notched between the two knuckles.
      p[0] *= 1 + ends * 0.35;
      p[2] *= 1 - ends * 0.3;
      if (ends > 0.6) p[1] -= Math.sign(t - 0.5) * Math.exp(-((p[0] / 0.025) ** 2)) * 0.02 * (ends - 0.6);
      p[0] += Math.sin(t * Math.PI) * 0.025;
    })
  );
}

// A rib: a flattened, tapering arc of bone with a knob where it met the spine, in the xy plane.
export function ribArc() {
  const path = Array.from({ length: 22 }, (_, i) => {
    const a = (i / 21) * 2.1;
    return new THREE.Vector3(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0);
  });
  return tube(path, new THREE.Vector3(0, 0, 1), (t) => 0.026 * (1 - t * 0.55) + Math.exp(-((t / 0.05) ** 2)) * 0.012, 7, 0.55);
}

// A rib hanging from the spine, for the fossil skeleton: one unit long down -y, curving forward (+x) as it goes.
export function hangingRib() {
  const path = Array.from({ length: 14 }, (_, i) => {
    const t = i / 13;
    return new THREE.Vector3(Math.sin(t * 1.6) * 0.18, -t, 0);
  });
  return tube(path, new THREE.Vector3(0, 0, 1), (t) => 0.028 * (1 - t * 0.6), 6, 0.6);
}

// One vertebra of the fossil skeleton, for a spine running along +x: a disc-like centrum (as an ichthyosaur's, wider
// than long, its faces dished), a neural arch and a spine rising from it. About a unit across the centrum.
export function vertebra() {
  const profile: Ring[] = [{ r: 0, y: 0.32 }];
  // The centrum turned on its side: the dished end faces, then its rounded rim.
  for (const [r, y] of [
    [0.25, 0.4],
    [0.45, 0.44],
    [0.5, 0.36],
    [0.52, 0.1],
    [0.5, -0.1],
    [0.52, -0.36],
    [0.45, -0.44],
    [0.25, -0.4]
  ])
    profile.push({ r, y });
  profile.push({ r: 0, y: -0.32 });
  const centrum = outward(lathe(profile, 14));
  centrum.rotateZ(Math.PI / 2);
  // The arch and spine: a tapered blade leaning back toward the tail.
  const spine = convex(
    [
      [
        [-0.22, 0.4, -0.12],
        [0.22, 0.4, -0.12],
        [0.12, 1.25, -0.05],
        [-0.02, 1.25, -0.05]
      ],
      [
        [-0.22, 0.4, 0.12],
        [0.22, 0.4, 0.12],
        [0.12, 1.25, 0.05],
        [-0.02, 1.25, 0.05]
      ],
      [
        [-0.22, 0.4, -0.12],
        [-0.22, 0.4, 0.12],
        [-0.02, 1.25, 0.05],
        [-0.02, 1.25, -0.05]
      ],
      [
        [0.22, 0.4, -0.12],
        [0.22, 0.4, 0.12],
        [0.12, 1.25, 0.05],
        [0.12, 1.25, -0.05]
      ],
      [
        [-0.02, 1.25, -0.05],
        [0.12, 1.25, -0.05],
        [0.12, 1.25, 0.05],
        [-0.02, 1.25, 0.05]
      ],
      [
        [-0.22, 0.4, -0.12],
        [0.22, 0.4, -0.12],
        [0.22, 0.4, 0.12],
        [-0.22, 0.4, 0.12]
      ]
    ],
    [0.04, 0.8, 0]
  );
  centrum.deleteAttribute("aAlong");
  return mergeIndexed([centrum, spine]);
}

// A cave bear's skull, from a signed distance (a braincase and a long muzzle, cheekbones, sockets and a nasal opening,
// a heavy jaw and canines), meshed once by surface nets. About 0.42 m long, muzzle toward +x.
export function bearSkull() {
  const sd = (x: number, y: number, z: number) => {
    const ell = (cx: number, cy: number, cz: number, a: number, b: number, c: number) => {
      const k = Math.hypot((x - cx) / a, (y - cy) / b, (z - cz) / c);
      return (k - 1) * Math.min(a, b, c);
    };
    const smin = (p: number, q: number, k: number) => {
      const h = Math.max(k - Math.abs(p - q), 0) / k;
      return Math.min(p, q) - h * h * k * 0.25;
    };
    let d = ell(-0.06, 0.03, 0, 0.13, 0.085, 0.09);
    d = smin(d, ell(0.1, 0.0, 0, 0.13, 0.055, 0.06), 0.05);
    // The crest along the top of the braincase.
    d = smin(d, ell(-0.07, 0.1, 0, 0.12, 0.03, 0.012), 0.03);
    // Cheekbones swung out to the sides.
    for (const s of [1, -1]) d = smin(d, ell(-0.01, 0.0, 0.085 * s, 0.07, 0.025, 0.02), 0.03);
    // Sockets and the nose.
    for (const s of [1, -1]) d = Math.max(d, -ell(0.04, 0.045, 0.055 * s, 0.03, 0.028, 0.03));
    d = Math.max(d, -ell(0.22, 0.01, 0, 0.03, 0.03, 0.035));
    // The jaw below, and the canines.
    d = smin(d, ell(0.06, -0.075, 0, 0.16, 0.025, 0.055), 0.02);
    for (const s of [1, -1]) {
      const tx = x - 0.19;
      const tz = z - 0.03 * s;
      const r = 0.012 * Math.max(0, 1 - Math.abs(y + 0.03) / 0.05);
      d = Math.min(d, Math.hypot(tx, tz) - r + Math.max(0, Math.abs(y + 0.03) - 0.05));
    }
    return d;
  };
  return meshSdf(sd, [-0.22, -0.13, -0.13], [0.27, 0.14, 0.13], 0.012);
}

// Surface nets over a small signed distance, for shapes made once at load; normals from the distance's gradient, the
// faces wound outward by the side the solid lies on.
function meshSdf(sd: (x: number, y: number, z: number) => number, lo: number[], hi: number[], step: number) {
  const n = [0, 1, 2].map((a) => Math.ceil((hi[a] - lo[a]) / step) + 1);
  const at = (i: number, j: number, k: number) => i + n[0] * (j + n[1] * k);
  const v = new Float32Array(n[0] * n[1] * n[2]);
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) v[at(i, j, k)] = sd(lo[0] + i * step, lo[1] + j * step, lo[2] + k * step);
  const cell = new Int32Array(v.length).fill(-1);
  const pts: number[] = [];
  const C = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1]
  ];
  const E: [number, number][] = [];
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) if (Math.abs(C[a][0] - C[b][0]) + Math.abs(C[a][1] - C[b][1]) + Math.abs(C[a][2] - C[b][2]) === 1) E.push([a, b]);
  const c8 = new Float32Array(8);
  for (let k = 0; k < n[2] - 1; k++)
    for (let j = 0; j < n[1] - 1; j++)
      for (let i = 0; i < n[0] - 1; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          c8[c] = v[at(i + C[c][0], j + C[c][1], k + C[c][2])];
          if (c8[c] < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let m = 0;
        for (const [a, b] of E) {
          if (c8[a] < 0 === c8[b] < 0) continue;
          const t = c8[a] / (c8[a] - c8[b]);
          sx += C[a][0] + (C[b][0] - C[a][0]) * t;
          sy += C[a][1] + (C[b][1] - C[a][1]) * t;
          sz += C[a][2] + (C[b][2] - C[a][2]) * t;
          m++;
        }
        cell[at(i, j, k)] = pts.length / 3;
        pts.push(lo[0] + (i + sx / m) * step, lo[1] + (j + sy / m) * step, lo[2] + (k + sz / m) * step);
      }
  const index: number[] = [];
  // Each quad wound by which side of its edge the solid lies (as field.ts meshes the rock), so the whole surface is
  // wound one way. (Turning each triangle on its own to the field's normal left hundreds of them wound against their
  // neighbours wherever the normal and a quad disagreed: the teeth, the windows' edges.)
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, c, b, a, d, c);
    else index.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < n[2] - 1; k++)
    for (let j = 1; j < n[1] - 1; j++)
      for (let i = 1; i < n[0] - 1; i++) {
        const here = v[at(i, j, k)] < 0;
        if (here !== v[at(i + 1, j, k)] < 0) quad(cell[at(i, j - 1, k - 1)], cell[at(i, j, k - 1)], cell[at(i, j, k)], cell[at(i, j - 1, k)], !here);
        if (here !== v[at(i, j + 1, k)] < 0) quad(cell[at(i - 1, j, k - 1)], cell[at(i - 1, j, k)], cell[at(i, j, k)], cell[at(i, j, k - 1)], !here);
        if (here !== v[at(i, j, k + 1)] < 0) quad(cell[at(i - 1, j - 1, k)], cell[at(i, j - 1, k)], cell[at(i, j, k)], cell[at(i - 1, j, k)], !here);
      }
  const normal = new Float32Array(pts.length);
  const e = step * 0.5;
  for (let p = 0; p < pts.length; p += 3) {
    const [x, y, z] = [pts[p], pts[p + 1], pts[p + 2]];
    const gx = sd(x + e, y, z) - sd(x - e, y, z);
    const gy = sd(x, y + e, z) - sd(x, y - e, z);
    const gz = sd(x, y, z + e) - sd(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    normal.set([gx / l, gy / l, gz / l], p);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  g.setIndex(index);
  return g;
}

// An old storm lantern: a base, four wire guards round where the glass was, a cap and a bail handle, about 0.3 m tall.
export function stormLantern() {
  const base = new THREE.CylinderGeometry(0.075, 0.08, 0.05, 14);
  base.translate(0, 0.025, 0);
  const cap = new THREE.ConeGeometry(0.07, 0.06, 14);
  cap.translate(0, 0.25, 0);
  const handle = new THREE.TorusGeometry(0.06, 0.005, 5, 16, Math.PI);
  handle.translate(0, 0.28, 0);
  const guards = [0, 1, 2, 3].map((k) => {
    const g = new THREE.CylinderGeometry(0.005, 0.005, 0.17, 4);
    const a = (k / 4) * Math.PI * 2 + 0.4;
    g.translate(Math.cos(a) * 0.065, 0.135, Math.sin(a) * 0.065);
    return g;
  });
  const parts = [base, cap, handle, ...guards];
  for (const g of parts) g.deleteAttribute("uv");
  return mergeIndexed(parts);
}

// ---- Fossils -------------------------------------------------------------------------------------------------------

// An ammonite: a tube coiled in a logarithmic spiral, growing 2.6 times wider each turn, lying in its own xz plane with
// +y out of the rock, about one unit across. Its ribs are real relief: strong primaries across the flank that fork in
// two toward the outer edge (the venter), a knob where they split, and a keel running round the venter. The body
// chamber's end closes over (no open tube end to look into).
export function ammoniteGeometry() {
  const turns = 3.2;
  const steps = 360;
  const around = 18;
  const grow = Math.log(2.6) / (Math.PI * 2);
  const end = Math.PI * 2;
  const start = end - turns * Math.PI * 2;
  const scale = 0.5 / Math.exp(grow * end);
  const position: number[] = [];
  const index: number[] = [];
  const primaries = 15;
  for (let i = 0; i <= steps; i++) {
    const a = start + (i / steps) * (end - start);
    const R = Math.exp(grow * a) * scale;
    // The last few rings close the aperture.
    const close = Math.sqrt(Math.max(0, Math.min(1, (steps - i) / 3)));
    const wide = R * 0.42 * close;
    const high = R * 0.34 * close;
    // The inner whorls rise toward the outer one's height, so the whole coil shows on a weathered face.
    const lift = (0.5 * 0.34 - R * 0.34) * 0.75;
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    const primary = Math.pow(Math.max(0, Math.sin(a * primaries)), 3);
    const secondary = Math.pow(Math.max(0, Math.sin(a * primaries * 2 + Math.PI / 2)), 3);
    for (let j = 0; j < around; j++) {
      const f = (j / around) * Math.PI * 2;
      const outer = Math.cos(f);
      // Toward the venter the ribs split in two.
      const fork = Math.min(1, Math.max(0, (outer - 0.05) / 0.5));
      const rib = (primary * (1 - fork) + Math.max(primary * 0.6, secondary) * fork) * 0.16 + primary * Math.exp(-(((outer - 0.1) / 0.15) ** 2)) * 0.09;
      const keel = Math.exp(-(1 - outer) * 30) * 0.07;
      const swell = 1 + rib + keel;
      const r = R + outer * wide * swell;
      position.push(ux * r, Math.sin(f) * high * (1 + rib) + lift, uz * r);
    }
  }
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < around; j++) {
      const a = i * around + j;
      const a1 = i * around + ((j + 1) % around);
      const b = a + around;
      const b1 = a1 + around;
      index.push(a, a1, b, a1, b1, b);
    }
  const geometry = indexed(position, index);
  // Outward: compare one ring's normal with the direction from its centre line.
  const n = geometry.getAttribute("normal");
  const mid = Math.floor(steps / 2) * around;
  const a = start + 0.5 * (end - start);
  const R = Math.exp(grow * a) * scale;
  const px = position[mid * 3] - Math.cos(a) * R;
  const pz = position[mid * 3 + 2] - Math.sin(a) * R;
  if (n.getX(mid) * px + n.getZ(mid) * pz < 0) {
    const flipped: number[] = [];
    for (let t = 0; t < index.length; t += 3) flipped.push(index[t], index[t + 2], index[t + 1]);
    geometry.setIndex(flipped);
    geometry.computeVertexNormals();
  }
  return geometry;
}

// A trilobite in relief, about one unit long (along x, head toward +x), lying in its own xz plane with +y out of the
// rock: a half-moon head shield with a raised rim, a bulbous glabella with its side furrows, crescent eyes, and genal
// spines swept back from its corners; a thorax of eleven segments, each a ridge with a pleural furrow along it, split
// into three lobes by the axial furrows; a rounded tail shield. Its edge sinks into the rock.
export function trilobiteGeometry() {
  const nx = 88;
  const nz = 52;
  const position: number[] = [];
  const index: number[] = [];
  const bump = (d: number, w: number) => Math.exp(-((d / w) ** 2));
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const x = -0.55 + (i / nx) * 1.1;
      const z = -0.38 + (j / nz) * 0.76;
      const az = Math.abs(z);
      // The outline's half-width along the body.
      const half =
        x > 0.2
          ? 0.33 * Math.sqrt(Math.max(0, 1 - ((x - 0.2) / 0.3) ** 2))
          : x > -0.3
            ? 0.3 - (0.2 - x) * 0.12
            : 0.24 * Math.sqrt(Math.max(0, 1 - ((x + 0.3) / 0.22) ** 2));
      const inside = Math.max(0, Math.min(1, (half - az) / 0.025));
      const head = x > 0.2;
      const thorax = x <= 0.2 && x > -0.3;
      // Three lobes: the raised axis between two furrows.
      const axisW = head ? 0.1 : 0.085 - Math.max(0, 0.2 - x) * 0.05;
      const axis = Math.max(0, Math.min(1, (axisW - az) / 0.02)) * 0.035;
      const furrow = -bump(az - axisW, 0.012) * 0.014;
      // Thorax segments: a ridge each, a pleural furrow down the middle of each side part.
      const seg = thorax ? Math.pow(Math.abs(Math.sin((x - 0.2) * 57.6)), 0.7) * 0.014 - (az > axisW ? bump(Math.sin((x - 0.2) * 57.6 + Math.PI / 2), 0.25) * 0.006 : 0) : 0;
      // The tail's segments fade back.
      const tail = x <= -0.3 ? Math.pow(Math.abs(Math.sin((x + 0.3) * 50)), 0.8) * 0.008 * (1 - (-0.3 - x) / 0.22) : 0;
      // The head: a raised glabella with two pairs of side furrows, crescent eyes, a rim round its edge.
      const glabella = head ? bump(x - 0.33, 0.11) * bump(z, 0.09) * 0.05 - (bump(x - 0.29, 0.012) + bump(x - 0.36, 0.012)) * bump(az - 0.06, 0.02) * 0.012 : 0;
      const eye = head ? bump(x - 0.31, 0.035) * bump(az - 0.15, 0.022) * 0.035 - bump(x - 0.31, 0.02) * bump(az - 0.165, 0.008) * 0.01 : 0;
      const rim = head ? bump(half - az - 0.022, 0.009) * 0.012 * inside : 0;
      // Genal spines from the head's back corners, trailing past the first segments.
      const spineT = Math.max(0, Math.min(1, (0.22 - x) / 0.42));
      const spineZ = 0.31 + spineT * 0.05;
      const spine = x < 0.24 && x > -0.2 ? bump(az - spineZ, 0.018 * (1 - spineT * 0.8)) * (1 - spineT) : 0;
      const h = inside * (0.025 + axis + furrow + seg + tail + glabella + eye + rim) + spine * 0.02 - (1 - Math.max(inside, spine)) * 0.03;
      position.push(x, h, z);
    }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      // Faces +y (out of the rock).
      index.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
  return indexed(position, index);
}

// ---- The old mine --------------------------------------------------------------------------------------------------

// A sawn timber: a square prism one unit long along y and a unit across, its long edges chamfered. Flat faces (each
// face its own vertices), so the chamfers catch the light as worn edges. Scaled per piece to its true size.
export function timber() {
  const c = 0.11;
  const ring = [
    [0.5 - c, -0.5],
    [0.5, -0.5 + c],
    [0.5, 0.5 - c],
    [0.5 - c, 0.5],
    [-0.5 + c, 0.5],
    [-0.5, 0.5 - c],
    [-0.5, -0.5 + c],
    [-0.5 + c, -0.5]
  ];
  const faces: number[][][] = [];
  for (let k = 0; k < 8; k++) {
    const [ax, az] = ring[k];
    const [bx, bz] = ring[(k + 1) % 8];
    faces.push([
      [ax, -0.5, az],
      [bx, -0.5, bz],
      [bx, 0.5, bz],
      [ax, 0.5, az]
    ]);
  }
  faces.push(ring.map(([x, z]) => [x, 0.5, z]));
  faces.push(ring.map(([x, z]) => [x, -0.5, z]));
  return convex(faces, [0, 0, 0], (f) => ({ aChamfer: [f < 8 && f % 2 === 0 ? 1 : 0], aEndGrain: [f >= 8 ? 1 : 0] }));
}

// A light flat-bottomed mine rail in true size (about 7 cm tall), one unit long along x: the foot, a thin web, the
// head with its corners worn round. Each face wound against the profile's outward side.
export function railGeometry() {
  // The profile in (z, y), anticlockwise.
  const outline = [
    [-0.032, 0],
    [0.032, 0],
    [0.032, 0.005],
    [0.008, 0.013],
    [0.006, 0.046],
    [0.016, 0.052],
    [0.017, 0.063],
    [0.012, 0.069],
    [-0.012, 0.069],
    [-0.017, 0.063],
    [-0.016, 0.052],
    [-0.006, 0.046],
    [-0.008, 0.013],
    [-0.032, 0.005]
  ];
  const position: number[] = [];
  const top: number[] = [];
  const tri = (a: number[], b: number[], c: number[], want: number[], isTop: number) => {
    const n = cross3(sub3(b, a), sub3(c, a));
    if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) [b, c] = [c, b];
    position.push(...a, ...b, ...c);
    top.push(isTop, isTop, isTop);
  };
  for (let k = 0; k < outline.length; k++) {
    const [z0, y0] = outline[k];
    const [z1, y1] = outline[(k + 1) % outline.length];
    // Outward for an anticlockwise profile: (dy, -dz) in (z, y).
    const want = [0, -(z1 - z0), y1 - y0];
    const a = [-0.5, y0, z0];
    const b = [0.5, y0, z0];
    const c = [0.5, y1, z1];
    const d = [-0.5, y1, z1];
    const isTop = y0 > 0.06 && y1 > 0.06 ? 1 : 0;
    tri(a, b, c, want, isTop);
    tri(a, c, d, want, isTop);
  }
  const shape = outline.map(([z, y]) => new THREE.Vector2(z, y));
  for (const [x, sign] of [
    [0.5, 1],
    [-0.5, -1]
  ])
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(shape, []))
      tri([x, outline[i][1], outline[i][0]], [x, outline[j][1], outline[j][0]], [x, outline[k][1], outline[k][0]], [sign, 0, 0], 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("aTop", new THREE.Float32BufferAttribute(top, 1));
  g.computeVertexNormals();
  return g;
}

// What holds the rails to one sleeper (centred on it, the sleeper's top at y = 0, the rails at z = ±gauge / 2 running
// along x): a tie plate under each rail, and four spikes driven beside the rail feet, their heads hooked over them.
export function railFittings(gauge: number) {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, tilt = 0) => {
    const b = new THREE.BoxGeometry(w, h, d);
    b.deleteAttribute("uv");
    if (tilt) b.rotateX(tilt);
    b.translate(x, y, z);
    parts.push(b);
  };
  for (const side of [-1, 1]) {
    const z = (side * gauge) / 2;
    box(0.13, 0.008, 0.15, 0, 0.004, z);
    for (const s of [-1, 1]) {
      // The spike's shank, a little out of true, and its head over the rail's foot.
      box(0.012, 0.035, 0.012, s * 0.02, 0.012, z + s * 0.04, s * 0.06);
      box(0.018, 0.009, 0.026, s * 0.02, 0.032, z + s * 0.033);
    }
  }
  return mergeIndexed(parts);
}

// A rail joint: a fishplate either side of the web, bolted through, centred on the joint (rails along x, the rail's
// foot at y = 0, its middle at z = 0).
export function fishplates() {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const plate = new THREE.BoxGeometry(0.36, 0.03, 0.008);
    plate.translate(0, 0.03, side * 0.011);
    parts.push(plate);
    for (const x of [-0.13, -0.045, 0.045, 0.13]) {
      const bolt = new THREE.CylinderGeometry(0.008, 0.008, 0.012, 6);
      bolt.rotateX(Math.PI / 2);
      bolt.translate(x, 0.03, side * 0.019);
      parts.push(bolt);
    }
  }
  for (const g of parts) g.deleteAttribute("uv");
  return mergeIndexed(parts);
}

// ---- Falling water -------------------------------------------------------------------------------------------------

// A waterfall's sheet: from the lip (y = 0) down to the pool (y = -1), x across from -0.5 to 0.5 at the lip and
// spreading wider as it falls, and thrown out from the rock (+z) along the arc of a jet, z = sqrt of the drop. uv
// across and down. A thin sheet of water seen from both sides, so its own faces point +z (out from the rock).
export function fallSheet() {
  const columns = 12;
  const rows = 28;
  const position: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const u = i / columns;
      const v = j / rows;
      position.push((u - 0.5) * (1 + v * 0.45), -v, Math.sqrt(v));
      uvs.push(u, v);
    }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const a = j * (columns + 1) + i;
      const c = a + columns + 1;
      index.push(a, c, a + 1, a + 1, c, c + 1);
    }
  const g = indexed(position, index);
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

// ---- Cave floor and wall dressing ----------------------------------------------------------------------------------

// A breakdown block: a slab fallen from the roof, sharp-edged and flat-faced as rock breaks along its beds, about a unit
// long, half that high, standing on y = 0. A box whose corners are knocked off at random and whose faces bulge a
// little, closed as a convex hull, so every face is flat and looks out. `aAlong` 0 (the rock look takes it as stone).
export function breakdownBlock(seed: number) {
  const random = lehmer(seed);
  const hx = 0.5;
  const hy = 0.22 + random() * 0.1;
  const hz = 0.32 + random() * 0.12;
  const points: THREE.Vector3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const corner = new THREE.Vector3(sx * hx, hy + sy * hy, sz * hz);
        // Half the corners broken off: three points slid in along its edges instead of the corner.
        if (random() < 0.55) {
          const cut = 0.06 + random() * 0.14;
          points.push(corner.clone().setX(sx * (hx - cut * (0.6 + random()))));
          points.push(corner.clone().setY(hy + sy * (hy - cut * 0.5 * (0.6 + random()))));
          points.push(corner.clone().setZ(sz * (hz - cut * (0.6 + random()))));
        } else points.push(corner.addScaledVector(new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5), 0.05));
      }
  // A few points out on the faces, so the faces are not quite planar: fractures, not sawn stone.
  for (let k = 0; k < 7; k++) {
    const axis = Math.floor(random() * 3);
    const side = random() < 0.5 ? -1 : 1;
    const p = new THREE.Vector3((random() - 0.5) * 1.4 * hx, hy + (random() - 0.5) * 1.4 * hy, (random() - 0.5) * 1.4 * hz);
    const push = 1 + random() * 0.06;
    if (axis === 0) p.x = side * hx * push;
    else if (axis === 1) p.y = side > 0 ? hy * 2 * push : 0;
    else p.z = side * hz * push;
    points.push(p);
  }
  const g = new ConvexGeometry(points);
  const shaped = new THREE.BufferGeometry();
  shaped.setAttribute("position", g.getAttribute("position"));
  shaped.setAttribute("normal", g.getAttribute("normal"));
  shaped.setAttribute("aAlong", new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count), 1));
  g.dispose();
  return shaped;
}

// A rimstone pool (a gour): a low dam of calcite round a shallow basin of still water, its outline lobed as the rim grew
// where the overflow ran, about two units across, the water surface at y = 0.02. One closed surface of revolution:
// from the middle of the water out to the dam's inner foot, up and over its crest, down its outside and back under to
// the axis below the floor. In the shallows a few cave pearls, polished round by the drips. `aAlong` 0 on the dam, 1 on
// the water, 2 on the pearls.
export function rimstone(seed: number) {
  const random = lehmer(seed);
  const s0 = random() * 100;
  const profile: Ring[] = [
    { r: 0, y: 0.02, along: 1 },
    { r: 0.45, y: 0.02, along: 1 },
    { r: 0.78, y: 0.02, along: 1 },
    { r: 0.86, y: 0.05 },
    { r: 0.9, y: 0.085 },
    { r: 0.95, y: 0.095 },
    { r: 1.0, y: 0.075 },
    { r: 1.05, y: 0.02 },
    { r: 1.1, y: -0.06 },
    // Down into the floor, so the fold under it (where smooth normals cannot follow) is buried.
    { r: 1.1, y: -0.16 },
    { r: 0.6, y: -0.18 },
    { r: 0, y: -0.19 }
  ];
  const lobes = (a: number) => 1 + Math.sin(a * 3 + s0) * 0.08 + Math.sin(a * 7 + s0 * 2) * 0.04 + noise3(Math.cos(a) * 1.5 + s0, Math.sin(a) * 1.5, 3) * 0.12;
  const pool = outward(
    lathe(profile, 40, (a) => lobes(a), (p, row) => {
      // The crest wanders in height, lower where the overflow spills.
      if (row >= 3 && row <= 6) p[1] += noise3(p[0] * 2 + s0, p[2] * 2, 1) * 0.02;
    })
  );
  const parts = [pool];
  const pearls = 3 + Math.floor(random() * 4);
  for (let k = 0; k < pearls; k++) {
    const a = random() * Math.PI * 2;
    const d = 0.25 + random() * 0.4;
    const r = 0.035 + random() * 0.035;
    const ball: Ring[] = [];
    for (let i = 0; i <= 6; i++) {
      const f = (i / 6) * Math.PI;
      ball.push({ r: i === 0 || i === 6 ? 0 : Math.sin(f) * r, y: 0.02 + r * 0.4 + Math.cos(f) * r, x: Math.cos(a) * d, z: Math.sin(a) * d, along: 2 });
    }
    parts.push(outward(lathe(ball, 9)));
  }
  return mergeIndexed(parts);
}

// Flowstone: a sheet of calcite poured down a wall, narrow where it leaves the crack (y = 0) and spreading as it runs
// down to the floor (y = -1), in terraced ripples, its foot scalloped where it pooled. Stands out of the wall along +z
// (the wall is the plane z = 0; what is behind it lies in the rock). A flattened lathe, so it is closed and outward.
// `aAlong` from 0.35 at the crack to 0.7 at the foot: the dripstone's calcite look without its root or tip.
export function flowstone(seed: number) {
  const random = lehmer(seed);
  const s0 = random() * 100;
  const rows = 22;
  const profile: Ring[] = [{ r: 0, y: 0.04, along: 0.35 }];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    // Ripples: small terraces where the film thickened, more of them low down.
    const terrace = Math.pow(0.5 + 0.5 * Math.sin(t * 38 + s0), 6) * 0.045 * (0.4 + t);
    const r = (0.12 + Math.pow(t, 0.65) * 0.42) * (1 + terrace) * (t > 0.9 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.9) / 0.1, 2))) * 0.6 + 0.4 : 1);
    profile.push({ r, y: -t, along: 0.35 + t * 0.35 });
  }
  profile.push({ r: 0, y: -1.02, along: 0.7 });
  return outward(
    lathe(
      profile,
      16,
      (a, row) => 1 + noise3(Math.cos(a) + s0, row * 0.3, Math.sin(a)) * 0.15,
      (p) => {
        // Pressed flat to the wall, and its foot draped in lobes.
        const lobe = Math.sin(Math.atan2(p[2], p[0]) * 4 + s0) * 0.04 * Math.max(0, -p[1] - 0.6);
        p[1] -= lobe;
        p[2] *= 0.38;
      }
    )
  );
}

// Moonmilk: a soft, lumpy crust of white mineral paste on a wall or roof, a unit across, standing out along +y from
// the rock (y = 0), most of it a thin skin with a few curd-like lumps. A squashed dome (closed, its base under the
// rock's surface), lobed round its edge.
export function moonmilk(seed: number) {
  const random = lehmer(seed);
  const s0 = random() * 100;
  const profile: Ring[] = [{ r: 0, y: 0.16 }];
  for (let i = 1; i <= 6; i++) {
    const f = (i / 6) * Math.PI * 0.5;
    profile.push({ r: Math.sin(f) * 0.5, y: Math.cos(f) * 0.16 * (1 - Math.sin(f) * 0.3) });
  }
  profile.push({ r: 0.46, y: -0.08 }, { r: 0, y: -0.1 });
  return outward(
    lathe(
      profile,
      18,
      (a) => 1 + Math.sin(a * 3 + s0) * 0.14 + noise3(Math.cos(a) * 2 + s0, Math.sin(a) * 2, 5) * 0.22,
      (p, row) => {
        if (row > 0 && row < 6) p[1] *= 0.6 + noise3(p[0] * 7 + s0, p[2] * 7, 2) * 0.9 + 0.4;
      }
    )
  );
}

// Roots come down through the roof where the surface is near: a tangle hanging from y = 0, the longest a unit, each a
// tapering tube that kinks and twists as it felt its way, a few thin rootlets beside them. `aAlong` 0 at the roof,
// 1 at each tip.
export function rootTangle(seed: number) {
  const random = lehmer(seed);
  const parts: THREE.BufferGeometry[] = [];
  const one = (x: number, z: number, length: number, r0: number, sides: number) => {
    const path: THREE.Vector3[] = [];
    const steps = 9;
    let px = x;
    let pz = z;
    const s0 = random() * 100;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      px += noise3(s0, t * 3, 1) * 0.06 * length;
      pz += noise3(s0, t * 3, 7) * 0.06 * length;
      path.push(new THREE.Vector3(px, 0.06 - t * length, pz));
    }
    const g = tube(path, new THREE.Vector3(1, 0, 0), (t) => r0 * (1 - t * 0.8), sides);
    const pos = g.getAttribute("position");
    const along = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) along[i] = Math.min(1, Math.max(0, -pos.getY(i) / length));
    g.setAttribute("aAlong", new THREE.BufferAttribute(along, 1));
    parts.push(g);
  };
  const thick = 3 + Math.floor(random() * 3);
  for (let k = 0; k < thick; k++) one((random() - 0.5) * 0.7, (random() - 0.5) * 0.7, 0.45 + random() * 0.55, 0.018 + random() * 0.018, 6);
  for (let k = 0; k < 5; k++) one((random() - 0.5) * 0.9, (random() - 0.5) * 0.9, 0.2 + random() * 0.5, 0.006 + random() * 0.004, 4);
  return mergeIndexed(parts);
}

// ---- A dinosaur ----------------------------------------------------------------------------------------------------

// A big theropod's skull, from a signed distance, meshed once: a deep, narrow skull a little over a metre long (snout
// toward +x), its sides opened by the great windows of a dinosaur's skull (the eye socket, the larger antorbital
// opening in front of it, the temporal opening behind, the nostril), the lower jaw a little dropped from its hinge with
// its own opening, and a row of curved, saw-edged teeth along each jaw. `aPart` 1 on the teeth.
export function dinoSkull() {
  const ell = (x: number, y: number, z: number, cx: number, cy: number, cz: number, a: number, b: number, c: number) => {
    const k0 = Math.hypot((x - cx) / a, (y - cy) / b, (z - cz) / c);
    const k1 = Math.hypot((x - cx) / (a * a), (y - cy) / (b * b), (z - cz) / (c * c));
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(a, b, c);
  };
  // An opening right through the skull's side: an ellipse in x and y, any z.
  const window = (x: number, y: number, cx: number, cy: number, a: number, b: number) => (Math.hypot((x - cx) / a, (y - cy) / b) - 1) * Math.min(a, b);
  const smin = (p: number, q: number, k: number) => {
    const h = Math.max(k - Math.abs(p - q), 0) / k;
    return Math.min(p, q) - h * h * k * 0.25;
  };
  const tooth = (x: number, y: number, z: number, tx: number, ty: number, tz: number, len: number, down: number) => {
    // A cone from its root at (tx, ty) pointing `down` (1 down, -1 up), curving back toward the throat as it goes.
    const t = Math.min(1, Math.max(0, ((ty - y) * down) / len));
    const cx = tx - t * t * len * 0.35;
    const r = len * 0.2 * (1 - t);
    return Math.max(Math.hypot((x - cx) * 1.25, z - tz) - r, (y - ty) * down - len, (ty - y) * down - len * 1.2);
  };
  // The upper teeth in the skull's frame, the lower in the jaw's (dropped with it).
  const upper = (x: number, y: number, z: number) => {
    let d = 1e9;
    for (let k = 0; k < 9; k++) {
      const tx = 0.52 - k * 0.075;
      if (Math.abs(x - tx) > 0.06) continue;
      const len = 0.075 - k * 0.004 + (k % 2) * 0.012;
      for (const s of [1, -1]) d = Math.min(d, tooth(x, y, z, tx, -0.105 + k * 0.004, 0.058 * s * (1 - k * 0.02), len, 1));
    }
    return d;
  };
  const lower = (x: number, y: number, z: number) => {
    let d = 1e9;
    for (let k = 1; k < 9; k++) {
      const tx = 0.49 - k * 0.075;
      if (Math.abs(x - tx) > 0.06) continue;
      const len = (0.075 - k * 0.004 + (k % 2) * 0.012) * 0.75;
      for (const s of [1, -1]) d = Math.min(d, tooth(x, y, z, tx, -0.17 + k * 0.004, 0.05 * s * (1 - k * 0.03), len, -1));
    }
    return d;
  };
  const skull = (x: number, y: number, z: number) => {
    // The braincase and the deep back of the skull, the long snout tapering forward, the brow over each eye.
    let d = ell(x, y, z, -0.3, 0.06, 0, 0.22, 0.2, 0.16);
    d = smin(d, ell(x, y, z, 0.12, 0.0, 0, 0.5, 0.14 - Math.max(0, x) * 0.08, 0.095 - Math.max(0, x) * 0.03), 0.09);
    for (const s of [1, -1]) d = smin(d, ell(x, y, z, -0.2, 0.17, 0.08 * s, 0.09, 0.035, 0.04), 0.04);
    // The upper jaw's edge, a little flared where the teeth sit.
    d = smin(d, ell(x, y, z, 0.12, -0.08, 0, 0.47, 0.035, 0.085), 0.04);
    // The windows through its sides: the eye, the antorbital opening, the temporal behind, the nostril.
    d = Math.max(d, -window(x, y, -0.2, 0.08, 0.06, 0.075));
    d = Math.max(d, -window(x, y, 0.07, 0.02, 0.15, 0.06));
    d = Math.max(d, -window(x, y, -0.4, 0.04, 0.045, 0.09));
    d = Math.max(d, -window(x, y, 0.5, 0.03, 0.035, 0.022));
    // Hollow inside, so the windows show the dark through them.
    d = Math.max(d, -ell(x, y, z, -0.1, 0.03, 0, 0.6, 0.1, 0.06));
    return d;
  };
  const jaw = (x: number, y: number, z: number) => {
    // Dropped 0.12 rad about its hinge at the back of the skull.
    const hx = -0.42;
    const hy = -0.1;
    const a = 0.12;
    const qx = hx + (x - hx) * Math.cos(a) - (y - hy) * Math.sin(a);
    const qy = hy + (x - hx) * Math.sin(a) + (y - hy) * Math.cos(a);
    let d = 1e9;
    for (const s of [1, -1]) d = Math.min(d, ell(qx, qy, z, 0.06, -0.2, 0.07 * s * (1 - Math.max(0, qx) * 0.5), 0.52, 0.05 - Math.max(0, qx) * 0.03, 0.022));
    // Joined at the chin.
    d = smin(d, ell(qx, qy, z, 0.53, -0.2, 0, 0.05, 0.03, 0.06), 0.03);
    d = Math.max(d, -window(qx, qy, -0.18, -0.2, 0.09, 0.025));
    return { d, qx, qy };
  };
  const teeth = (x: number, y: number, z: number, j = jaw(x, y, z)) => (y > -0.34 && y < 0 && x > -0.2 && Math.abs(z) < 0.1 ? Math.min(upper(x, y, z), lower(j.qx, j.qy, z)) : 1e9);
  const sd = (x: number, y: number, z: number) => {
    const j = jaw(x, y, z);
    return Math.min(skull(x, y, z), j.d, teeth(x, y, z, j));
  };
  const g = meshSdf(sd, [-0.56, -0.4, -0.19], [0.66, 0.3, 0.19], 0.018);
  // The teeth, for their paler enamel.
  const pos = g.getAttribute("position");
  const part = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    part[i] = teeth(x, y, z) < 0.006 && teeth(x, y, z) <= Math.min(skull(x, y, z), jaw(x, y, z).d) ? 1 : 0;
  }
  g.setAttribute("aPart", new THREE.BufferAttribute(part, 1));
  return g;
}

// One of a dinosaur's ribs, for a skeleton lying belly down: from its head at the spine (the origin) it springs out
// along +z and curves down through -y, about a metre, flattened, tapering, with a knob where it met the spine.
export function dinoRib() {
  const path = Array.from({ length: 16 }, (_, i) => {
    const t = i / 15;
    return new THREE.Vector3(0, -0.95 * Math.pow(t, 1.15) + 0.12 * Math.sin(Math.PI * t), 0.06 + 0.42 * Math.sin(Math.PI * t * 0.78));
  });
  return tube(path, new THREE.Vector3(1, 0, 0), (t) => 0.032 * (1 - t * 0.6) + Math.exp(-((t / 0.06) ** 2)) * 0.018, 6, 0.55);
}

// ---- A campfire ----------------------------------------------------------------------------------------------------

// A log, one unit long up y, half a unit across: bark that is ridged and uneven round it, the ends cut square. `aAlong`
// from 0 at one end to 1 at the other (the end that lay in the fire).
export function fireLog() {
  const profile: Ring[] = [{ r: 0, y: 1, along: 1 }, { r: 0.42, y: 1, along: 1 }];
  for (let i = 0; i <= 8; i++) profile.push({ r: 0.5 - Math.sin((i / 8) * Math.PI) * 0.02 * ((i % 3) - 1), y: 0.97 - (i / 8) * 0.94, along: 0.97 - (i / 8) * 0.94 });
  profile.push({ r: 0.42, y: 0, along: 0 }, { r: 0, y: 0, along: 0 });
  return outward(lathe(profile, 12, (a, row) => 1 + Math.sin(a * 7 + row * 0.7) * 0.045 + Math.sin(a * 3 + 2) * 0.03));
}

// The bed of a fire: a low heap of ash and coals a unit across (radius one), lumpy, about 0.15 high. `aAlong` 1 at the
// middle, 0 at the rim (how hot).
export function emberBed() {
  const profile: Ring[] = [{ r: 0, y: 0.15, along: 1 }];
  for (let i = 1; i <= 7; i++) {
    const t = i / 7;
    profile.push({ r: t, y: 0.15 * Math.cos(t * Math.PI * 0.5) ** 1.6 + 0.005, along: 1 - t });
  }
  profile.push({ r: 0.98, y: -0.04, along: 0 }, { r: 0, y: -0.04, along: 0 });
  return outward(lathe(profile, 18, (a, row) => (row > 0 && row < 8 ? 1 + Math.sin(a * 5 + row) * 0.05 + Math.sin(a * 11) * 0.03 : 1)));
}

// A tongue of flame: a teardrop one unit tall up y, wide and round at its foot, drawn out to a point. `aAlong` its height.
export function flameTongue() {
  const profile: Ring[] = [{ r: 0, y: 1, along: 1 }];
  for (let i = 1; i <= 9; i++) {
    const t = i / 10;
    profile.push({ r: 0.5 * Math.pow(Math.sin(Math.PI * Math.pow(t, 2.1)), 0.8), y: 1 - t, along: 1 - t });
  }
  profile.push({ r: 0, y: 0, along: 0 });
  return outward(lathe(profile, 10));
}
