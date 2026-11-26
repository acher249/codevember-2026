/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { abs, atan, attribute, cameraPosition, clamp, color, cos, exp, float, fract, instanceIndex, length, max, min, mix, mx_noise_float, normalLocal, normalMap, normalView, normalWorld, positionGeometry, positionLocal, positionWorld, pow, sign, sin, smoothstep, step, texture, uniform, uv, vec2, vec3, vec4 } from "three/tsl";

// The first three things drawn on the sidewalk (the rest are in ./drawings/, all listed in kinds.ts), each a real 3D place under (and a little over) the paving: a pit with a
// ladder and a lantern, a swimming pool, and stone stairs down to a lit doorway. Each lives in the real scene, lit by
// the real sun; while it is a drawing it is parked out of sight, brought up only to take the artist's picture of it
// (index.tsx), which the sidewalk shows (ground.ts).
// Metres throughout; the sidewalk at y = 0, running along z, the brownstones off to +x and the road to -x.

// Where the artist stood (eye height) and what they looked at: the middle of the drawing, which the orbit turns about.
export const EYE = new THREE.Vector3(0, 1.65, 4);
export const CENTRE = new THREE.Vector3(0, 0, -1.2);


export type Scans = { rock: THREE.Texture; rockNormal: THREE.Texture; slab: THREE.Texture; tiles: THREE.Texture; tilesNormal: THREE.Texture; granite: THREE.Texture; graniteNormal: THREE.Texture };

export type Drawing = {
  // What is really there, the paving round it as a shadow, and the edge of the hole on the ground.
  real: THREE.Group;
  shade: THREE.Mesh;
  edge: THREE.Vector3[];
  // Points the artist's picture must take in: the edge, and anything standing up out of it.
  extent: THREE.Vector3[];
  // 1 on the ground inside the hole, for the sidewalk to cut it out once real.
  inside: (at: any) => any;
  // Whether a point on the sidewalk lies under the chalk: inside the drawing as the artist saw it, the hole and anything
  // standing up out of it laid flat along their sight lines. Nothing may lie there (a leaf, litter), or it would sit on
  // the chalk and then hang in the air over the real thing.
  covers: (x: number, z: number) => boolean;
  animate: (time: number) => void;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
};

// A cheap smooth noise for building shapes on the processor.
export const wobble = (a: number, b: number, c: number) => Math.sin(a * 1.7 + b * 2.3 + c) * 0.5 + Math.sin(a * 3.1 - b * 1.3 + c * 1.9) * 0.3 + Math.sin(a * 7.3 + b * 5.1 - c) * 0.2;

// Geometry that comes out the same for the same inputs, made once a page and kept by a key; each build gets its own
// copy of the arrays (so its GPU buffers are its own, and it may move or dispose them freely).
const keptGeometries = new Map<string, THREE.BufferGeometry>();
export function kept(key: string, make: () => THREE.BufferGeometry) {
  let master = keptGeometries.get(key);
  if (!master) keptGeometries.set(key, (master = make()));
  const copy = new THREE.BufferGeometry();
  for (const name in master.attributes) copy.setAttribute(name, master.attributes[name].clone());
  if (master.index) copy.setIndex(master.index.clone());
  master.groups.forEach((group) => copy.addGroup(group.start, group.count, group.materialIndex));
  return copy;
}

// A key for an outline on the ground.
const outline = (edge: THREE.Vector3[]) => edge.map((p) => `${p.x},${p.y},${p.z}`).join(";");

// The ground round the hole as a shadow, so the sun lights only what it would through the opening. Invisible in the
// view; for the artist's picture it also hides everything under the paving (index.tsx turns its depth on for that).
// A hair under the paving, so it never shades the paving itself.
export function shadeFor(edge: THREE.Vector3[]) {
  const shape = () => {
    const ground = new THREE.Shape([new THREE.Vector2(-60, -60), new THREE.Vector2(60, -60), new THREE.Vector2(60, 60), new THREE.Vector2(-60, 60)]);
    ground.holes.push(new THREE.Path(edge.map((p) => new THREE.Vector2(p.x, -p.z))));
    return ground;
  };
  const geometry = kept(`shade ${outline(edge)}`, () => new THREE.ShapeGeometry(shape()).rotateX(-Math.PI / 2));
  const material = new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.renderOrder = -1;
  mesh.position.y = -0.005;
  return { mesh, geometry, material };
}

// The drawing's footprint as the artist saw it: its extent seen from the eye (a convex outline on their screen, a little
// enlarged), tested against any point on the ground.
export function footprint(extent: THREE.Vector3[]) {
  const view = new THREE.PerspectiveCamera(90, 1, 0.05, 100);
  view.position.copy(EYE);
  view.lookAt(CENTRE);
  view.updateMatrixWorld();
  const flat = (p: THREE.Vector3) => {
    const q = p.clone().project(view);
    return new THREE.Vector2(q.x, q.y);
  };
  // The convex hull (monotone chain), grown 6% about its middle.
  const points = extent.map(flat).sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: THREE.Vector2[]) => {
    const out: THREE.Vector2[] = [];
    list.forEach((p) => {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    });
    out.pop();
    return out;
  };
  const hull = [...half(points), ...half([...points].reverse())];
  const middle = hull.reduce((sum, p) => sum.add(p), new THREE.Vector2()).divideScalar(hull.length);
  hull.forEach((p) => p.sub(middle).multiplyScalar(1.06).add(middle));
  return (x: number, z: number) => {
    const p = new THREE.Vector3(x, 0, z);
    // Behind the eye nothing is drawn.
    if (p.clone().applyMatrix4(view.matrixWorldInverse).z > -0.05) return false;
    const q = flat(p);
    return hull.every((a, i) => cross(a, hull[(i + 1) % hull.length], q) >= 0);
  };
}

// A rectangle with rounded corners on the ground, as points round it.
export function roundedRect(x0: number, x1: number, z0: number, z1: number, r: number, perCorner = 10) {
  const points: THREE.Vector3[] = [];
  const corners: [number, number, number][] = [
    [x1 - r, z1 - r, 0],
    [x0 + r, z1 - r, Math.PI / 2],
    [x0 + r, z0 + r, Math.PI],
    [x1 - r, z0 + r, (Math.PI * 3) / 2]
  ];
  corners.forEach(([cx, cz, from]) => {
    for (let k = 0; k <= perCorner; k++) {
      const a = from + (k / perCorner) * (Math.PI / 2);
      points.push(new THREE.Vector3(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r));
    }
  });
  return points;
}

// Inside a rounded rectangle on the ground, per pixel.
export const insideRect = (x0: number, x1: number, z0: number, z1: number, r: number) => (at: any) => {
  const centre = vec2((x0 + x1) / 2, (z0 + z1) / 2);
  const half = vec2((x1 - x0) / 2 - r, (z1 - z0) / 2 - r);
  const q = abs(at.sub(centre)).sub(half);
  return step(length(max(q, vec2(0))).add(min(max(q.x, q.y), 0)).sub(r), 0);
};

// Walls straight down from the edge, ring by ring, facing into the hole; `push` moves each point outward from the
// middle (for rock that bulges). uv runs round the edge and down, in metres over `tile`. Made straight into typed
// arrays, with the normals summed as three's computeVertexNormals sums them, so it comes out the same to the bit.
export function walls(edge: THREE.Vector3[], depth: number, tile: number, push: (p: THREE.Vector3, y: number) => number = () => 0, rings = 40) {
  const middle = edge.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(edge.length);
  const n = edge.length;
  const row = n + 1;
  const depths: number[] = [];
  for (let j = 0; j <= rings; j++) depths.push(-depth * Math.pow(j / rings, 1.4));
  // Outward from the middle at each point of the edge, and how far round the edge it lies.
  const outX = new Float64Array(n);
  const outZ = new Float64Array(n);
  const lengths = new Float64Array(n);
  let around = 0;
  edge.forEach((p, k) => {
    const x = p.x - middle.x;
    const z = p.z - middle.z;
    const scale = 1 / (Math.sqrt(x * x + z * z) || 1);
    outX[k] = x * scale;
    outZ[k] = z * scale;
    lengths[k] = around;
    around += p.distanceTo(edge[(k + 1) % n]);
  });
  const count = depths.length * row;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  let v = 0;
  depths.forEach((y) => {
    for (let k = 0; k <= n; k++, v++) {
      const p = edge[k % n];
      const by = push(p, y);
      positions[v * 3] = p.x + outX[k % n] * by;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = p.z + outZ[k % n] * by;
      uvs[v * 2] = (k === n ? around : lengths[k]) / tile;
      uvs[v * 2 + 1] = -y / tile;
    }
  });
  const index = count - 1 >= 65535 ? new Uint32Array((depths.length - 1) * n * 6) : new Uint16Array((depths.length - 1) * n * 6);
  let i = 0;
  for (let j = 0; j < depths.length - 1; j++)
    for (let k = 0; k < n; k++) {
      const a = j * row + k;
      index[i++] = a;
      index[i++] = a + row;
      index[i++] = a + 1;
      index[i++] = a + 1;
      index[i++] = a + row;
      index[i++] = a + row + 1;
    }
  // Faces into the hole: check a normal against the way in, and turn the winding if it points out.
  const at = row * Math.floor(rings / 2) + 3;
  const normal = summedNormal(positions, index, at);
  if (normal[0] * (middle.x - positions[at * 3]) + normal[2] * (middle.z - positions[at * 3 + 2]) < 0)
    for (let f = 0; f < index.length; f += 3) [index[f + 1], index[f + 2]] = [index[f + 2], index[f + 1]];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.setAttribute("normal", new THREE.BufferAttribute(vertexNormals(positions, index), 3));
  return geometry;
}

// One face's contribution to its corners' normals, as computeVertexNormals works it out: (C - B) x (A - B).
function faceNormal(positions: Float32Array, a: number, b: number, c: number, into: number[]) {
  const bx = positions[b * 3];
  const by = positions[b * 3 + 1];
  const bz = positions[b * 3 + 2];
  const cx = positions[c * 3] - bx;
  const cy = positions[c * 3 + 1] - by;
  const cz = positions[c * 3 + 2] - bz;
  const ax = positions[a * 3] - bx;
  const ay = positions[a * 3 + 1] - by;
  const az = positions[a * 3 + 2] - bz;
  into[0] = cy * az - cz * ay;
  into[1] = cz * ax - cx * az;
  into[2] = cx * ay - cy * ax;
}

// computeVertexNormals on the arrays: the same sums in the same order, kept in single floats between, then made unit.
function vertexNormals(positions: Float32Array, index: Uint16Array | Uint32Array) {
  const normals = new Float32Array(positions.length);
  const face = [0, 0, 0];
  for (let f = 0; f < index.length; f += 3) {
    faceNormal(positions, index[f], index[f + 1], index[f + 2], face);
    for (let corner = 0; corner < 3; corner++) {
      const v = index[f + corner] * 3;
      normals[v] += face[0];
      normals[v + 1] += face[1];
      normals[v + 2] += face[2];
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const scale = 1 / (Math.sqrt(normals[v] * normals[v] + normals[v + 1] * normals[v + 1] + normals[v + 2] * normals[v + 2]) || 1);
    normals[v] *= scale;
    normals[v + 1] *= scale;
    normals[v + 2] *= scale;
  }
  return normals;
}

// The normal summed at one point only (for which way a mesh faces), in single floats as vertexNormals sums it.
function summedNormal(positions: Float32Array, index: Uint16Array | Uint32Array, at: number) {
  const sum = new Float32Array(3);
  const face = [0, 0, 0];
  for (let f = 0; f < index.length; f += 3)
    if (index[f] === at || index[f + 1] === at || index[f + 2] === at) {
      faceNormal(positions, index[f], index[f + 1], index[f + 2], face);
      for (let c = 0; c < 3; c++) sum[c] += face[c];
    }
  return sum;
}

// A flat floor filling the edge at a depth, facing up.
export function floorOf(edge: THREE.Vector3[], y: number) {
  return kept(`floor ${y} ${outline(edge)}`, () => {
    const geometry = new THREE.ShapeGeometry(new THREE.Shape(edge.map((p) => new THREE.Vector2(p.x, -p.z))));
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, y, 0);
    return geometry;
  });
}

// The sidewalk slab's cut edge, a few centimetres of concrete at the top of every wall.
export const SLAB = 0.14;

// How far a drawing has woken since it turned real: 0 at the swap (so it is still exactly the chalk), easing to 1.
export const wakeAt = (t: number) => THREE.MathUtils.smootherstep(t, 0, 1.8);

// The wake added up over time: a clock for slow travel (drift, wheeling, traffic), 0 at the swap, that gathers speed
// from rest as the drawing wakes rather than jumping into it, then runs at one second a second.
export const wokenFor = (t: number) => {
  const u = THREE.MathUtils.clamp(t / 1.8, 0, 1);
  return 1.8 * (u ** 6 - 3 * u ** 5 + 2.5 * u ** 4) + Math.max(0, t - 1.8);
};

// A hole laid out as the artist saw it: an outline on their screen (`across` by `up`, as a fraction of their view, its
// reach at each angle round the middle), carried out along their sight lines to the ground. From anywhere else it is a
// long shape running away from them. `reach` and `reachNode` must be the same function, on the processor and per pixel,
// so the edge and the cut in the sidewalk agree.
export function holeInView(across: number, up: number, reach: (a: number) => number, reachNode: (a: any) => any, count = 180) {
  const artist = artistView();
  const edge: THREE.Vector3[] = [];
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2;
    const r = reach(a);
    const sight = new THREE.Vector3(across * Math.cos(a) * r, up * Math.sin(a) * r, 0.5).unproject(artist).sub(EYE).normalize();
    edge.push(EYE.clone().addScaledVector(sight, -EYE.y / sight.y));
  }
  const sees = uniform(new THREE.Matrix4().multiplyMatrices(artist.projectionMatrix, artist.matrixWorldInverse));
  const inside = () => {
    const wide = sees.mul(vec4(positionWorld, 1));
    const x = wide.x.div(wide.w).div(across);
    const y = wide.y.div(wide.w).div(up);
    return step(length(vec2(x, y)), reachNode(atan(y, x))).mul(step(0, wide.w));
  };
  return { edge, inside };
}

// A triangle wave, -1 to 1 and back once a unit, on the processor and per pixel: straight runs with sharp turns, as
// broken concrete has.
export const zigzag = (x: number) => 1 - 4 * Math.abs(x - Math.floor(x) - 0.5);
export const zigzagNode = (x: any) => float(1).sub(abs(fract(x).sub(0.5)).mul(4));

// For a drawing that opens onto great distances (sky, a city far below): the opening's depth, written over whatever
// was seen through it once everything else is drawn. The view's air and focus go by depth, and the chalk lies on the
// ground; seen hundreds of metres off, the real thing would take on far more air than its own chalk does, and the two
// would no longer match. With this they both sit at the ground as far as the air is concerned, and match.
export function nearDepth(edge: THREE.Vector3[]) {
  const geometry = floorOf(edge, -0.01);
  const material = new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: true, depthFunc: THREE.AlwaysDepth, transparent: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 10;
  return { mesh, geometry, material };
}

// A bat, nose toward +z, wings out along x, a few centimetres across (as the outlines here): each wing a membrane
// stretched from the arm to four finger tips, scalloped between them and back to the foot, made as rings out from the
// shoulder so it bends smoothly as it beats; a furred body, a head and two ears. Coloured per vertex: the membrane a
// warm dark brown, thinner and lighter out toward its trailing edge, the finger bones and the body darker.
export function batGeometry() {
  const membrane = new THREE.Color("#3a2a22");
  const thin = new THREE.Color("#5a4034");
  const dark = new THREE.Color("#17110e");
  const parts: THREE.BufferGeometry[] = [];
  const O = new THREE.Vector2(0.004, -0.012);
  const arm = [new THREE.Vector2(0.006, 0.014), new THREE.Vector2(0.075, 0.05), new THREE.Vector2(0.122, 0.036)];
  const tips = [new THREE.Vector2(0.215, -0.012), new THREE.Vector2(0.182, -0.058), new THREE.Vector2(0.134, -0.08), new THREE.Vector2(0.082, -0.082)];
  const foot = new THREE.Vector2(0.01, -0.06);
  const wrist = arm[2];
  // The edge, from the shoulder out along the arm to the first tip, then scalloped from tip to tip and to the foot.
  const edge: { at: THREE.Vector2; bone: number }[] = [];
  const line = (a: THREE.Vector2, b: THREE.Vector2, n: number, bone: number) => {
    for (let i = 0; i < n; i++) edge.push({ at: a.clone().lerp(b, i / n), bone });
  };
  line(arm[0], arm[1], 6, 1);
  line(arm[1], arm[2], 4, 1);
  line(arm[2], tips[0], 7, 1);
  const trailing = [...tips, foot];
  for (let f = 0; f < trailing.length - 1; f++) {
    const a = trailing[f];
    const b = trailing[f + 1];
    const n = 10;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const at = a.clone().lerp(b, t);
      // Pulled in toward the wrist between the tips, the membrane slack between its bones.
      const toward = (f === trailing.length - 2 ? O : wrist).clone().sub(at).normalize();
      at.addScaledVector(toward, Math.sin(t * Math.PI) * a.distanceTo(b) * 0.22);
      edge.push({ at, bone: i === 0 ? 1 : 0 });
    }
  }
  edge.push({ at: foot.clone(), bone: 0 });
  const RINGS = 7;
  // How near a point is to a finger bone (wrist to each tip) or the arm, for its colour.
  const nearBone = (p: THREE.Vector2) => {
    let d = Infinity;
    const segs: [THREE.Vector2, THREE.Vector2][] = [[arm[0], arm[1]], [arm[1], arm[2]], ...tips.map((t): [THREE.Vector2, THREE.Vector2] => [wrist, t])];
    const ab = new THREE.Vector2();
    const ap = new THREE.Vector2();
    segs.forEach(([a, b]) => {
      ab.subVectors(b, a);
      ap.subVectors(p, a);
      const t = THREE.MathUtils.clamp(ap.dot(ab) / ab.lengthSq(), 0, 1);
      d = Math.min(d, ap.sub(ab.multiplyScalar(t)).length());
    });
    return 1 - THREE.MathUtils.smoothstep(d, 0.0015, 0.004);
  };
  [1, -1].forEach((side) => {
    const positions: number[] = [];
    const colours: number[] = [];
    const indices: number[] = [];
    const c = new THREE.Color();
    edge.forEach(({ at }) => {
      for (let k = 0; k <= RINGS; k++) {
        const p = O.clone().lerp(at, k / RINGS);
        positions.push(p.x * side, 0, p.y);
        const out = THREE.MathUtils.smoothstep(p.distanceTo(O) / at.distanceTo(O), 0.5, 1) * (p.y < 0 ? 1 : 0.3);
        c.copy(membrane).lerp(thin, out).lerp(dark, nearBone(p) * 0.85);
        colours.push(c.r, c.g, c.b);
      }
    });
    for (let j = 0; j < edge.length - 1; j++)
      for (let k = 0; k < RINGS; k++) {
        const a = j * (RINGS + 1) + k;
        const b = a + RINGS + 1;
        if (side > 0) indices.push(a, b, a + 1, a + 1, b, b + 1);
        else indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
    g.setIndex(indices);
    parts.push(g);
  });
  // The body, the head and the ears, dark and furred.
  const solid = (g: THREE.BufferGeometry) => {
    g.deleteAttribute("uv");
    g.deleteAttribute("normal");
    const n = g.getAttribute("position").count;
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [dark.r, dark.g, dark.b]), 3));
    parts.push(g);
  };
  solid(new THREE.SphereGeometry(1, 12, 8).scale(0.017, 0.014, 0.042).translate(0, 0.002, -0.008));
  solid(new THREE.SphereGeometry(1, 10, 8).scale(0.013, 0.012, 0.015).translate(0, 0.004, 0.038));
  [1, -1].forEach((side) => solid(new THREE.ConeGeometry(0.006, 0.018, 6).rotateX(-0.35).rotateZ(-side * 0.35).translate(side * 0.007, 0.016, 0.04)));
  const geometry = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  parts.forEach((g) => g.dispose());
  geometry.computeVertexNormals();
  return geometry;
}

// Winged things (bats, swifts, pigeons) as one instanced mesh of thin cards: `outline` is triangles in the xz plane
// (x0, z0, x1, z1, x2, z2), nose toward +z and wings out along x, flapped in the shader from `time`. `place` sets one
// where it is and the way it is heading (a size of 0 hides it); `done` sends the frame's placings.
// A finer `shape` (a geometry with its own vertex colours, as batGeometry's) can be given in place of the outline: its
// wings then bend as they beat, the tips trailing the arms.
export function wings(outline: number[][], count: number, colour: string, time: any, beat: number, shape?: THREE.BufferGeometry) {
  const positions: number[] = [];
  outline.forEach((tri) => {
    for (let k = 0; k < 3; k++) positions.push(tri[k * 2], 0, tri[k * 2 + 1]);
  });
  const geometry = shape ?? new THREE.BufferGeometry();
  if (!shape) {
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
  }
  // Thin cards, seen from above and below.
  const material = new THREE.MeshStandardNodeMaterial({ color: shape ? "#ffffff" : colour, vertexColors: !!shape, roughness: 0.85, side: THREE.DoubleSide });
  const seed = instanceIndex.toFloat();
  const out = abs(positionGeometry.x);
  const phase = time.mul(beat).add(seed.mul(2.3));
  // (The fine shape's wings turn at the shoulder, bending further toward the tips, which trail the beat a little.)
  const turn = float(0.75).add(out.mul(3)).mul(sin(phase.sub(out.mul(9))));
  material.positionNode = shape
    ? vec3(sign(positionGeometry.x).mul(out.mul(cos(turn))), positionLocal.y.add(out.mul(sin(turn))), positionLocal.z)
    : positionLocal.add(vec3(0, out.mul(sin(phase)).mul(1.1), 0));
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.castShadow = true;
  const m = new THREE.Matrix4();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const ahead = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const place = (i: number, at: THREE.Vector3, heading: THREE.Vector3, size: number) => {
    if (size <= 0.0001 || heading.lengthSq() < 1e-10) {
      mesh.setMatrixAt(i, zero);
      return;
    }
    // Facing along its heading (Matrix4.lookAt points +z from the second point toward the first).
    m.lookAt(ahead.copy(at).add(heading), at, up);
    q.setFromRotationMatrix(m);
    mesh.setMatrixAt(i, m.compose(at, q, s.setScalar(size)));
  };
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, zero);
  const done = () => (mesh.instanceMatrix.needsUpdate = true);
  return { mesh, place, done, geometry, material };
}

// Eased travel from one point to another: `into` set to the point `f` (0 to 1) of the way.
export const glide = (into: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3, f: number) => into.lerpVectors(from, to, THREE.MathUtils.smootherstep(f, 0, 1));

// Faces turned to look inward (a dome or bowl seen from inside): the winding reversed and the normals flipped.
export function inward(geometry: THREE.BufferGeometry) {
  const index = geometry.index!;
  for (let i = 0; i < index.count; i += 3) {
    const b = index.getX(i + 1);
    index.setX(i + 1, index.getX(i + 2));
    index.setX(i + 2, b);
  }
  const normal = geometry.getAttribute("normal");
  for (let i = 0; i < normal.count; i++) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  return geometry;
}

// Roots hanging from a hole's wall: each a tapering tube from a point on the wall, out a little and down, as one mesh
// (made once a page for each set of roots).
// Once the drawing wakes they sway in the draught, more the further they hang.
export type Root = { at: THREE.Vector3; out: THREE.Vector3; length: number; thick: number };
export function hangingRoots(list: Root[], time: any, wake: any, sway = 0.05) {
  const key = list.map((root) => [root.at.x, root.at.y, root.at.z, root.out.x, root.out.y, root.out.z, root.length, root.thick].join(",")).join(";");
  const geometry = kept(`roots ${key}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    list.forEach((root, i) => {
      const s = (n: number) => wobble(i * 1.3, n, i * 0.7);
      const points = [0, 0.15, 0.35, 0.6, 0.8, 1].map((u) => {
        const outward = Math.min(1, u * 4) * 0.06 + u * 0.05 * s(1);
        return root.at.clone().addScaledVector(root.out, outward).add(new THREE.Vector3(s(u * 3 + 2) * 0.05 * u, -root.length * u * (0.9 + 0.1 * u), s(u * 3 + 5) * 0.05 * u));
      });
      const path = new THREE.CatmullRomCurve3(points);
      const segments = 14;
      const radial = 5;
      const geometry = new THREE.TubeGeometry(path, segments, root.thick, radial);
      const p = geometry.getAttribute("position");
      const hang: number[] = [];
      const phase: number[] = [];
      const centre = new THREE.Vector3();
      for (let k = 0; k <= segments; k++) {
        path.getPointAt(k / segments, centre);
        const taper = 1 - 0.85 * (k / segments);
        for (let j = 0; j <= radial; j++) {
          const v = k * (radial + 1) + j;
          p.setXYZ(v, centre.x + (p.getX(v) - centre.x) * taper, centre.y + (p.getY(v) - centre.y) * taper, centre.z + (p.getZ(v) - centre.z) * taper);
          hang.push(Math.pow(k / segments, 1.6) * root.length);
          phase.push(i * 2.39);
        }
      }
      geometry.setAttribute("hang", new THREE.Float32BufferAttribute(hang, 1));
      geometry.setAttribute("phase", new THREE.Float32BufferAttribute(phase, 1));
      geometry.computeVertexNormals();
      parts.push(geometry);
    });
    return mergeWith(parts, ["hang", "phase"]);
  });
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  const hang = attribute("hang", "float");
  const phase = attribute("phase", "float");
  material.colorNode = mix(vec3(0.06, 0.042, 0.03), vec3(0.15, 0.105, 0.07), mx_noise_float(positionLocal.mul(9)).mul(0.5).add(0.5));
  const swing = vec3(sin(time.mul(1.3).add(phase)).add(sin(time.mul(2.9).add(phase.mul(1.7))).mul(0.3)), 0, cos(time.mul(1.1).add(phase.mul(0.6))));
  material.positionNode = positionLocal.add(swing.mul(hang.mul(hang).mul(wake).mul(sway)));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = mesh.receiveShadow = true;
  return { mesh, geometry, material };
}

// Specks of light drifting up through a drawing once it is real (embers, dust in a lamp's light): none while it is
// chalk, growing in as it wakes.
export function specks(count: number, box: [number, number, number, number, number, number], colour: THREE.Color, rise: number) {
  const [x0, x1, y0, y1, z0, z1] = box;
  const geometry = new THREE.SphereGeometry(1, 6, 4);
  const material = new THREE.MeshBasicNodeMaterial({ color: colour });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const seeds = Array.from({ length: count }, (_, i) => {
    const r = (n: number) => {
      const v = Math.sin(i * 73.1 + n * 19.7) * 43758.5453;
      return v - Math.floor(v);
    };
    return { x: x0 + r(1) * (x1 - x0), z: z0 + r(2) * (z1 - z0), phase: r(3), size: 0.006 + Math.pow(r(4), 3) * 0.014, wander: r(5) * 6.28, speed: 0.6 + r(6) * 0.8 };
  });
  const m = new THREE.Matrix4();
  const update = (t: number, wake: number) => {
    seeds.forEach((seed, i) => {
      const along = (seed.phase + (t * rise * seed.speed) / (y1 - y0)) % 1;
      const y = y0 + along * (y1 - y0);
      const fade = Math.sin(along * Math.PI) * wake;
      const size = seed.size * fade;
      m.makeScale(size, size, size).setPosition(seed.x + Math.sin(t * 0.7 + seed.wander) * 0.15, y, seed.z + Math.cos(t * 0.5 + seed.wander) * 0.15);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0, 0);
  return { mesh, update, geometry, material };
}

// For the pit and the pool: noise, and small textures painted on the processor.

// A hashed value, -1 to 1, for each whole point.
const hash3 = (x: number, y: number, z: number) => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) & 0xffff) / 32767.5 - 1;
};

// A smooth value noise for baking on the processor, about -1 to 1: the hashed values at the whole points round a
// point, eased between.
function noise3(x: number, y: number, z: number) {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const k = Math.floor(z);
  let u = x - i;
  let v = y - j;
  let w = z - k;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  w = w * w * (3 - 2 * w);
  // Along x on each of the four edges of the cell round the point.
  const h0 = hash3(i, j, k);
  const h1 = hash3(i, j + 1, k);
  const h2 = hash3(i, j, k + 1);
  const h3 = hash3(i, j + 1, k + 1);
  const a = h0 + (hash3(i + 1, j, k) - h0) * u;
  const b = h1 + (hash3(i + 1, j + 1, k) - h1) * u;
  const c = h2 + (hash3(i + 1, j, k + 1) - h2) * u;
  const d = h3 + (hash3(i + 1, j + 1, k + 1) - h3) * u;
  const near = a + (b - a) * v;
  return near + (c + (d - c) * v - near) * w;
}

// A small texture painted on the processor, once: `paint` gives each texel's colour (0 to 1, with an alpha), and it
// repeats and mips like a scan.
function baked(width: number, height: number, colour: boolean, paint: (x: number, y: number, out: number[]) => void) {
  const data = new Uint8Array(width * height * 4);
  const out = [0, 0, 0, 1];
  const byte = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
  for (let y = 0, i = 0; y < height; y++)
    for (let x = 0; x < width; x++, i += 4) {
      paint(x, y, out);
      data[i] = byte(out[0]);
      data[i + 1] = byte(out[1]);
      data[i + 2] = byte(out[2]);
      data[i + 3] = byte(out[3]);
    }
  const map = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = 8;
  if (colour) map.colorSpace = THREE.SRGBColorSpace;
  map.needsUpdate = true;
  return map;
}

// Parts into one geometry, as mergeBoxes but copying whole arrays at a time (quicker); the parts are let go.
function joined(parts: THREE.BufferGeometry[]) {
  // (Some of three's shapes come without an index, as RoundedBoxGeometry: each given the plain one.)
  parts.forEach((g) => g.index || g.setIndex(new THREE.BufferAttribute(Uint32Array.from({ length: g.getAttribute("position").count }, (_, i) => i), 1)));
  const geometry = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return geometry;
}

// A normal map (tangent space, y up the texture) from a height field over a repeating grid, `strength` its slope.
function normalsOf(width: number, height: number, heights: Float32Array, strength: number) {
  const at = (x: number, y: number) => heights[((y + height) % height) * width + ((x + width) % width)];
  return baked(width, height, false, (x, y, out) => {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
    const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1);
    out[0] = 0.5 - (0.5 * dx) / l;
    out[1] = 0.5 - (0.5 * dy) / l;
    out[2] = 0.5 + 0.5 / l;
    out[3] = 1;
  });
}

// ---------------------------------------------------------------------------------------------------------------- Pit

const HOLE = { across: 0.44, up: 0.2 };
const ragged = (a: number) => 1 + 0.06 * Math.sin(3 * a + 1) + 0.045 * Math.sin(7 * a + 2) + 0.02 * Math.sin(17 * a) + 0.012 * Math.sin(41 * a + 0.4);
const raggedNode = (a: any) => sin(a.mul(3).add(1)).mul(0.06).add(sin(a.mul(7).add(2)).mul(0.045)).add(sin(a.mul(17)).mul(0.02)).add(sin(a.mul(41).add(0.4)).mul(0.012)).add(1);

// The artist's view, for laying out an edge as they saw it (holeInView).
function artistView() {
  const camera = new THREE.PerspectiveCamera(64, 1, 0.05, 80);
  camera.position.copy(EYE);
  camera.lookAt(CENTRE);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

// The pit's rock walls, as walls() makes them but with the rings laid at the depths given (close together where they
// are seen, far apart down in the dark), facing into the hole. `push` moves the v'th point outward from the middle.
// uv runs round the edge and down, in metres over `tile`.
function rockWalls(edge: THREE.Vector3[], depths: number[], tile: number, push: (p: THREE.Vector3, y: number, v: number) => number) {
  const n = edge.length;
  const row = n + 1;
  const middle = edge.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(n);
  const outX = new Float32Array(n);
  const outZ = new Float32Array(n);
  const along = new Float32Array(row);
  edge.forEach((p, k) => {
    const l = Math.hypot(p.x - middle.x, p.z - middle.z);
    outX[k] = (p.x - middle.x) / l;
    outZ[k] = (p.z - middle.z) / l;
    along[k + 1] = along[k] + p.distanceTo(edge[(k + 1) % n]);
  });
  const positions = new Float32Array(depths.length * row * 3);
  const uvs = new Float32Array(depths.length * row * 2);
  let v = 0;
  depths.forEach((y) => {
    for (let k = 0; k <= n; k++, v++) {
      const p = edge[k % n];
      const by = push(p, y, v);
      positions[v * 3] = p.x + outX[k % n] * by;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = p.z + outZ[k % n] * by;
      uvs[v * 2] = along[k] / tile;
      uvs[v * 2 + 1] = -y / tile;
    }
  });
  // Wound so the faces look into the hole: down a ring then along the edge faces in when the middle lies to the
  // edge's left (seen from above), and the other way round otherwise.
  const left = (edge[1].x - edge[0].x) * (middle.z - edge[0].z) - (edge[1].z - edge[0].z) * (middle.x - edge[0].x) > 0;
  const index = new Uint32Array((depths.length - 1) * n * 6);
  let i = 0;
  for (let j = 0; j < depths.length - 1; j++)
    for (let k = 0; k < n; k++) {
      const a = j * row + k;
      if (left) index.set([a, a + row, a + 1, a + 1, a + row, a + row + 1], i);
      else index.set([a, a + 1, a + row, a + 1, a + row + 1, a + row], i);
      i += 6;
    }
  // Normals straight from the grid (across the neighbours round the ring and up and down it), the same way in as the faces.
  const normals = new Float32Array(positions.length);
  const last = depths.length - 1;
  for (let j = 0; j <= last; j++)
    for (let k = 0; k <= n; k++) {
      const at = (jj: number, kk: number) => (jj * row + kk) * 3;
      const [l, r] = [at(j, k === 0 ? n - 1 : k - 1), at(j, k === n ? 1 : k + 1)];
      const [u, d] = [at(Math.max(j - 1, 0), k), at(Math.min(j + 1, last), k)];
      const ax = positions[r] - positions[l];
      const ay = positions[r + 1] - positions[l + 1];
      const az = positions[r + 2] - positions[l + 2];
      const bx = positions[d] - positions[u];
      const by = positions[d + 1] - positions[u + 1];
      const bz = positions[d + 2] - positions[u + 2];
      // Down the wall crossed with along it.
      let nx = by * az - bz * ay;
      let ny = bz * ax - bx * az;
      let nz = bx * ay - by * ax;
      const size = (left ? 1 : -1) / Math.hypot(nx, ny, nz);
      nx *= size;
      ny *= size;
      nz *= size;
      const v = at(j, k);
      normals[v] = nx;
      normals[v + 1] = ny;
      normals[v + 2] = nz;
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

// Old weathered pine for the pit's ladder, along the texture's height: the grain wandering in long streaks with darker
// late wood between, greyed where it has dried, and a normal map of its grain raised as old wood weathers. Baked once
// and kept, as every pit uses the same.
let pine: { map: THREE.DataTexture; normal: THREE.DataTexture } | undefined;
function weatheredPine() {
  if (pine) return pine;
  const [W, H] = [64, 512];
  const heights = new Float32Array(W * H);
  const light = [0.6, 0.46, 0.32];
  const dark = [0.3, 0.2, 0.13];
  const grey = [0.46, 0.43, 0.4];
  const map = baked(W, H, true, (x, y, out) => {
    const u = x / W;
    const v = y / H;
    // Rings as stripes across the width, bent along the length by slow noise so they run in and out like flat-sawn grain.
    const ring = u * 9 + 1.4 * noise3(u * 3, v * 4, 1) + 0.2 * noise3(u * 10, v * 12, 2);
    const f = ring - Math.floor(ring);
    const late = THREE.MathUtils.smoothstep(f, 0.55, 0.7) * (1 - THREE.MathUtils.smoothstep(f, 0.85, 1));
    const weather = 0.5 + 0.5 * noise3(u * 4, v * 10, 3);
    const fleck = 0.06 * noise3(u * 40, v * 160, 4);
    heights[y * W + x] = -late * 0.6 + fleck;
    for (let c = 0; c < 3; c++) out[c] = THREE.MathUtils.lerp(THREE.MathUtils.lerp(light[c], dark[c], late), grey[c], weather * 0.45) * (1 + fleck);
    out[3] = 1;
  });
  pine = { map, normal: normalsOf(W, H, heights, 2.5) };
  return pine;
}

// Copies of small shapes moved to places, straight into one geometry (much quicker than cloning and merging them).
function stamped(copies: { shape: THREE.BufferGeometry; at: [number, number, number] }[]) {
  let verts = 0;
  let count = 0;
  copies.forEach(({ shape }) => {
    verts += shape.getAttribute("position").count;
    count += shape.index!.count;
  });
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  const index = new Uint32Array(count);
  let v = 0;
  let i = 0;
  copies.forEach(({ shape, at }) => {
    const p = shape.getAttribute("position").array;
    const n = p.length / 3;
    for (let c = 0; c < p.length; c++) positions[v * 3 + c] = p[c] + at[c % 3];
    normals.set(shape.getAttribute("normal").array, v * 3);
    uvs.set(shape.getAttribute("uv").array, v * 2);
    const from = shape.index!.array;
    for (let c = 0; c < from.length; c++) index[i + c] = from[c] + v;
    v += n;
    i += from.length;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

// The ladder: two rails with their corners worn round, rungs a little uneven as if cut by hand, each lashed to the rails
// with twine. One mesh of wood and one of twine. uv in metres along the wood (and round it), for the grain.
function ladder(foot: THREE.Vector3, top: THREE.Vector3, wood: THREE.Material, twine: THREE.Material) {
  const frame = new THREE.Group();
  const along = top.clone().sub(foot);
  const length = along.length();
  const metres = (g: THREE.BufferGeometry, across: number, long: number) => {
    const uvs = g.getAttribute("uv");
    for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * across, uvs.getY(i) * long);
    return g;
  };
  // The same for every pit, so made once a page (kept by where it stands). Rungs every 0.3 m.
  const key = `ladder ${foot.toArray()} ${top.toArray()}`;
  const rungs: number[] = [];
  for (let y = 0.3; y < length - 0.1; y += 0.3) rungs.push(y);
  const woodGeometry = kept(`${key} wood`, () => {
    const rail = metres(new RoundedBoxGeometry(0.05, length, 0.07, 2, 0.012), 0.07, length).translate(-0.27, length / 2, 0);
    // The second rail cut from further along the board, so the two do not match.
    const other = rail.clone().translate(0.54, 0, 0);
    const uvs = other.getAttribute("uv");
    for (let j = 0; j < uvs.count; j++) uvs.setY(j, uvs.getY(j) + 0.7);
    const parts: THREE.BufferGeometry[] = [rail, other];
    rungs.forEach((y, k) => {
      const r = 0.017 + 0.003 * wobble(k, 1, 2);
      const rung = metres(new THREE.CylinderGeometry(r, r * 0.92, 0.56, 8, 1, true), 2 * Math.PI * r, 0.56);
      rung.rotateZ(Math.PI / 2 + 0.03 * wobble(k, 3, 1));
      rung.rotateY(0.04 * wobble(k, 5, 2));
      rung.translate(0, y, 0.004 * wobble(k, 7, 3));
      parts.push(rung);
    });
    return joined(parts);
  });
  // Twine round each rail just over each rung.
  const twineGeometry = kept(`${key} twine`, () => {
    const wrap = new THREE.CylinderGeometry(0.047, 0.047, 0.04, 6, 1, true);
    const geometry = stamped(rungs.flatMap((y) => [-0.27, 0.27].map((x) => ({ shape: wrap, at: [x, y + 0.004, 0] as [number, number, number] }))));
    wrap.dispose();
    return geometry;
  });
  [new THREE.Mesh(woodGeometry, wood), new THREE.Mesh(twineGeometry, twine)].forEach((mesh) => {
    mesh.castShadow = mesh.receiveShadow = true;
    frame.add(mesh);
  });
  frame.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.normalize());
  frame.position.copy(foot);
  return { frame, geometries: [woodGeometry, twineGeometry] };
}

export function buildPit(scans: Scans): Drawing {
  const { edge, inside } = holeInView(HOLE.across, HOLE.up, ragged, raggedNode);
  const DEPTH = 7;
  const real = new THREE.Group();

  // The slab's cut edge, dark soil under it, then rock fading into the dark with depth. The rock lies in beds, the
  // harder ones standing out as ledges over softer ones worn back under them, each bed its own shade.
  const SPLIT = 3.6;
  const rockFrom = (y: number) => THREE.MathUtils.smoothstep(-y, 0.6, 1.4);
  // Each bed tilts and wanders a little round the hole (worked out once for each point round the edge).
  const tilt = new Map(edge.map((p) => [p, 0.4 * wobble(p.x * 1.3, 0.5, p.z * 1.3)]));
  const bed = (p: THREE.Vector3, y: number) => y * 1.8 + tilt.get(p)!;
  const hardness = (s: number) => 0.5 + 0.5 * hash3(Math.floor(s), 3, 7);
  // How far the rock is worn back into the wall at a point: under each hard bed's ledge (sharp beneath, sloping off
  // above), and in small hollows and knobs all over; smoothing out down where the lantern no longer reaches, below which
  // the rings of the wall are laid far apart.
  const worn = (s: number, p: THREE.Vector3, y: number) => {
    const f = s - Math.floor(s);
    const ledge = THREE.MathUtils.smoothstep(f, 0, 0.12) - THREE.MathUtils.smoothstep(f, 0.45, 0.75);
    return (-0.09 * ledge * hardness(s) + 0.03 * wobble(p.x * 7, y * 5, p.z * 7)) * (1 - THREE.MathUtils.smoothstep(-y, 2.9, SPLIT));
  };
  // What each point of the rock is like, worked out here once rather than per pixel: its bed's shade, damp seeping down
  // it, moss near the top, how worn back it is (shadowed), and rust bleeding down from iron in the rock.
  const S = THREE.MathUtils.smoothstep;
  const DEPTHS = [...Array.from({ length: 50 }, (_, j) => -SPLIT * Math.pow(j / 49, 1.4)), ...Array.from({ length: 7 }, (_, j) => -SPLIT - (DEPTH - SPLIT) * Math.pow((j + 1) / 7, 1.4))];
  // The same every time (the pit's edge never changes), so made once a page.
  const wallGeometry = kept("pit wall", () => {
    const count = DEPTHS.length * (edge.length + 1);
    const marks = new Float32Array(count * 4);
    const rust = new Float32Array(count);
    const geometry = rockWalls(edge, DEPTHS, 1.6, (p, y, v) => {
      const rock = rockFrom(y);
      const s = bed(p, y);
      const back = rock > 0 && y > -SPLIT ? rock * worn(s, p, y) : 0;
      marks[v * 4] = 0.65 * hardness(s) + 0.35 * (0.5 + 0.5 * Math.sin(y * 3.2 + p.x * 0.6 - p.z * 0.6));
      marks[v * 4 + 1] = S(noise3(p.x * 5, y * 0.45, p.z * 5) + 0.25 * S(-y, 0.6, 4), 0.15, 0.55);
      marks[v * 4 + 2] = y < -0.25 && y > -1.3 ? S(noise3(p.x * 3.1, y * 3.1, p.z * 3.1), 0.2, 0.6) * S(-y, 0.25, 0.5) * (1 - S(-y, 0.8, 1.3)) : 0;
      marks[v * 4 + 3] = THREE.MathUtils.clamp(back / 0.05, 0, 1);
      rust[v] = y < -0.9 && y > -SPLIT ? S(noise3(p.x * 8, y * 0.35, p.z * 8), 0.3, 0.75) * S(-y, 0.9, 1.6) : 0;
      return rock * (0.25 * wobble(p.x * 0.9, y * 0.8, p.z * 0.7) + 0.12 * wobble(p.z * 2.6, y * 2.2, p.x * 2.1) + 0.2 * Math.sin(-y * 0.5)) + back;
    });
    geometry.setAttribute("mark", new THREE.BufferAttribute(marks, 4));
    geometry.setAttribute("rust", new THREE.BufferAttribute(rust, 1));
    return geometry;
  });
  const y = positionWorld.y;
  const mark = attribute("mark", "vec4");
  const rockColour = texture(scans.rock, uv()).rgb.mul(0.75);
  const slabColour = texture(scans.slab, uv().mul(vec2(1, 3))).rgb.mul(0.9);
  const soil = vec3(0.09, 0.065, 0.045).mul(texture(scans.rock, uv().mul(2.3)).r.mul(0.8).add(0.6));
  const banded = rockColour.mul(mix(vec3(0.6, 0.56, 0.52), vec3(1.25, 1.18, 1.08), mark.x));
  // Grit and earth fallen onto the tops of the ledges.
  const ledgeTop = smoothstep(0.3, 0.7, normalLocal.y).mul(step(y, -0.9));
  const earthy = mix(mix(banded, soil, max(smoothstep(-1.4, -0.6, y), ledgeTop.mul(0.75))), vec3(0.045, 0.06, 0.025), mark.z.mul(0.45));
  const rusty = mix(earthy, earthy.mul(vec3(1.5, 0.95, 0.6)), attribute("rust", "float").mul(0.6));
  const damp = mark.y;
  const wallMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  wallMaterial.colorNode = mix(rusty.mul(mix(float(1), float(0.55), damp)).mul(float(1).sub(mark.w.mul(0.6))), slabColour, smoothstep(-SLAB - 0.03, -SLAB, y)).mul(mix(float(0.04), float(1), clamp(exp(y.mul(0.75)), 0, 1)));
  wallMaterial.roughnessNode = mix(float(0.95), float(0.28), damp.mul(step(y, -SLAB - 0.05)));
  // The scan's relief, and the same again finer over it, so it holds up close without the repeat showing.
  const broad = texture(scans.rockNormal, uv()).xyz.mul(2).sub(1);
  const grain = texture(scans.rockNormal, uv().mul(3.7).add(0.31)).xyz.mul(2).sub(1);
  wallMaterial.normalNode = normalMap(vec4(vec3(broad.xy.add(grain.xy.mul(0.6)), broad.z).normalize().mul(0.5).add(0.5), 1) as any, vec2(1.2));
  const wall = new THREE.Mesh(wallGeometry, wallMaterial);
  wall.castShadow = wall.receiveShadow = true;
  real.add(wall);

  const floorGeometry = new THREE.CircleGeometry(12, 24);
  floorGeometry.rotateX(-Math.PI / 2);
  const floorMaterial = new THREE.MeshBasicNodeMaterial({ color: "#020203" });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.position.y = -DEPTH + 0.3;
  real.add(floor);

  // The ladder against the far wall, its top standing up out of the hole.
  const far = edge.reduce((best, p) => (p.z < best.z ? p : best), edge[0]);
  const pineWood = weatheredPine();
  const wood = new THREE.MeshStandardNodeMaterial({ roughness: 0.82 });
  const grainAt = uv().div(vec2(0.2, 1.5));
  wood.colorNode = texture(pineWood.map, grainAt).rgb;
  wood.normalNode = normalMap(texture(pineWood.normal, grainAt));
  // Twine wound round and round, its strands catching the light.
  const twine = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  twine.colorNode = mix(vec3(0.08, 0.06, 0.04), vec3(0.3, 0.24, 0.15), smoothstep(-0.6, 0.8, sin(uv().y.mul(Math.PI * 2 * 11).add(uv().x.mul(Math.PI * 2)))));
  // Its top no higher than a little over half a metre, so the chalk of it lands on the sidewalk just past the hole
  // rather than far down the street.
  const top = new THREE.Vector3(far.x + 0.1, 0.6, far.z + 0.25);
  const foot = new THREE.Vector3(far.x + 0.1, -5.5, far.z + 1.45);
  const steps = ladder(foot, top, wood, twine);
  real.add(steps.frame);

  // A storm lantern hung from a rung a couple of metres down: a glass globe in a wire guard between a tin base and a
  // hood, with a bail to hang it by. The flame fills the glass, brightest at its heart, with a faint halo round it in
  // the damp air.
  const hang = foot.clone().lerp(top, 0.62).add(new THREE.Vector3(0.3, -0.25, 0.08));
  const caseMaterial = new THREE.MeshStandardNodeMaterial({ color: "#2a2520", roughness: 0.45, metalness: 0.7 });
  // Made once a page.
  const caseGeometry = kept("lantern case", () => {
    const tinParts: THREE.BufferGeometry[] = [];
    const tin = (g: THREE.BufferGeometry, y: number) => tinParts.push(g.translate(0, y, 0));
    tin(new THREE.CylinderGeometry(0.068, 0.072, 0.03, 20), -0.085);
    tin(new THREE.CylinderGeometry(0.05, 0.068, 0.012, 20, 1, true), -0.064);
    tin(new THREE.CylinderGeometry(0.074, 0.074, 0.006, 20, 1, true), 0.072);
    tin(new THREE.CylinderGeometry(0.03, 0.074, 0.045, 20), 0.097);
    tin(new THREE.CylinderGeometry(0.018, 0.022, 0.03, 10, 1, true), 0.133);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      tin(new THREE.CylinderGeometry(0.0035, 0.0035, 0.14, 4, 1, true).translate(Math.cos(a) * 0.066, 0, Math.sin(a) * 0.066), 0);
    }
    [-0.025, 0.03].forEach((y) => tin(new THREE.TorusGeometry(0.066, 0.0035, 4, 24).rotateX(Math.PI / 2), y));
    tin(new THREE.TorusGeometry(0.078, 0.004, 4, 16, Math.PI), 0.075);
    return joined(tinParts);
  });
  const glassGeometry = kept("lantern glass", () => new THREE.LatheGeometry([[0.044, -0.06], [0.056, -0.04], [0.062, -0.01], [0.06, 0.02], [0.052, 0.045], [0.038, 0.07]].map(([r, y]) => new THREE.Vector2(r, y)), 20));
  const glassMaterial = new THREE.MeshBasicNodeMaterial();
  {
    // Seen straight on, the flame behind the glass; toward the globe's rim, only the glass lit by it.
    const facing = max(normalWorld.dot(cameraPosition.sub(positionWorld).normalize()), 0);
    glassMaterial.colorNode = color("#ffc27a").mul(float(1.6).add(pow(facing, 3).mul(3.2)).mul(float(1).sub(abs(positionLocal.y).mul(5))));
  }
  const lantern = new THREE.Group();
  lantern.add(new THREE.Mesh(caseGeometry, caseMaterial), new THREE.Mesh(glassGeometry, glassMaterial));
  const glow = uniform(1);
  const haloMaterial = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  haloMaterial.colorNode = color("#ffa458");
  haloMaterial.opacityNode = pow(max(float(1).sub(length(uv().sub(0.5)).mul(2)), 0), 2.6).mul(glow).mul(0.32);
  const halo = new THREE.Sprite(haloMaterial);
  halo.scale.setScalar(0.85);
  lantern.add(halo);
  // Hung on a short rope from the rung above, so once it is real it can swing.
  const swing = new THREE.Group();
  swing.position.copy(hang).add(new THREE.Vector3(0, 0.32, 0));
  const ropeGeometry = new THREE.CylinderGeometry(0.005, 0.005, 0.17, 6);
  ropeGeometry.translate(0, -0.085, 0);
  const rope = new THREE.Mesh(ropeGeometry, twine);
  lantern.position.set(0, -0.32, 0);
  swing.add(rope, lantern);
  real.add(swing);
  const flame = new THREE.PointLight("#ffb066", 6, 0, 2);
  flame.position.set(0, -0.32, 0);
  swing.add(flame);
  // Embers rising out of the dark.
  const embers = specks(70, [-1.3, 1.3, -5, 0.9, far.z + 0.6, -0.3], new THREE.Color("#ffb070").multiplyScalar(3), 0.35);
  real.add(embers.mesh);

  // Roots: out of the earth under the slab all round, some just stubs, some hanging a metre or more down the rock,
  // stirring in the air that rises out of the pit once it is real.
  const time = uniform(0);
  const wakeU = uniform(0);
  const middle = edge.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(edge.length);
  const rootList: Root[] = [];
  for (let k = 0; k < 30; k++) {
    const p = edge[Math.floor(((k + 0.4 * wobble(k, 2, 1)) / 30) * edge.length + edge.length) % edge.length];
    const out = middle.clone().sub(p).setY(0).normalize();
    const f = 0.5 + 0.5 * wobble(k * 1.7, 4, 2);
    rootList.push({ at: p.clone().setY(-0.3 - f * 0.6).addScaledVector(out, -0.03), out, length: 0.1 + Math.pow(f, 2.5) * 1.6, thick: 0.004 + f * 0.012 });
  }
  const roots = hangingRoots(rootList, time, wakeU, 0.05);
  real.add(roots.mesh);

  // Water seeping out of the rock and dripping from a few points by the lantern, each drop glinting as it falls
  // through the light. None fall while it is chalk.
  const dripGeometry = new THREE.SphereGeometry(1, 6, 4);
  const dripMaterial = new THREE.MeshStandardNodeMaterial({ color: "#b8c4c8", roughness: 0.05, metalness: 0.2 });
  dripMaterial.emissiveNode = vec3(1, 0.75, 0.45).mul(0.6);
  const DRIPS = 6;
  const drips = new THREE.InstancedMesh(dripGeometry, dripMaterial, DRIPS);
  const dripFrom = Array.from({ length: DRIPS }, (_, i) => {
    // Points on the walls either side of the lantern, a little below the earth.
    const a = Math.floor(((0.2 + i * 0.1) % 1) * edge.length);
    const p = edge[a];
    const out = middle.clone().sub(p).setY(0).normalize();
    return { at: p.clone().addScaledVector(out, 0.12 + 0.04 * i).setY(-1.2 - (i % 3) * 0.35), every: 1.6 + ((i * 0.37) % 1) * 1.9, phase: (i * 0.61) % 1 };
  });
  const dripMatrix = new THREE.Matrix4();
  const placeDrips = (t: number, w: number) => {
    dripFrom.forEach((d, i) => {
      const cycle = (t / d.every + d.phase) % 1;
      // Swelling on the rock for most of the cycle, then letting go and falling.
      const fall = Math.max(0, cycle - 0.7) * d.every;
      const swell = Math.min(1, cycle / 0.7);
      const size = 0.0055 * w * (fall > 0 ? 1 : 0.4 + 0.6 * swell);
      dripMatrix.makeScale(size, size * (fall > 0 ? 2.4 : 1.3), size).setPosition(d.at.x, d.at.y - 4.9 * fall * fall, d.at.z);
      drips.setMatrixAt(i, dripMatrix);
    });
    drips.instanceMatrix.needsUpdate = true;
  };
  placeDrips(0, 0);
  real.add(drips);

  // Bats: once it is real, a few burst up out of the pit, flutter round over the sidewalk and up toward the trees,
  // and dive back in; then after a while out they come again. Each is wherever its own clock puts it (nothing is
  // carried from frame to frame), so it runs as well backwards as forwards.
  const R1 = [0.02, 0.02];
  const R2 = [0.02, -0.05];
  const ELBOW = [0.1, 0.05];
  const TIP = [0.19, 0.0];
  const A = [0.07, -0.055];
  const B = [0.14, -0.04];
  const half = (sx: number) =>
    [
      [R1, ELBOW, R2],
      [R2, ELBOW, A],
      [ELBOW, B, A],
      [ELBOW, TIP, B]
    ].map((tri) => tri.flatMap(([x, z]) => [x * sx, z]));
  const batOutline = [[0, 0.07, 0.022, 0.0, -0.022, 0.0], [0.022, 0.0, 0, -0.07, -0.022, 0.0], ...half(1), ...half(-1)];
  const BATS = 7;
  const bats = wings(batOutline, BATS, "#1b1714", time, 19, batGeometry());
  real.add(bats.mesh);
  const BAT_CYCLE = 17;
  const batDeep = new THREE.Vector3();
  const batOver = new THREE.Vector3();
  const batRound = new THREE.Vector3();
  const batAt = new THREE.Vector3();
  const batNext = new THREE.Vector3();
  // Where bat i is, `u` seconds into its outing: up out of the dark to just over the hole, out round in loops over
  // the sidewalk, rising toward the canopy and falling back, then back over the hole and down into the dark.
  const batPosition = (into: THREE.Vector3, i: number, u: number) => {
    batDeep.set(middle.x + 0.3 * Math.sin(i * 2.1), -4, middle.z + 0.5 * Math.cos(i * 1.7));
    batOver.set(middle.x + 0.2 * Math.sin(i), 1.3, middle.z);
    const turn = i * 0.9 + u * (1.4 + 0.12 * i) * (i % 2 ? 1 : -1);
    const reach = 1.7 + 0.4 * Math.sin(u * 0.7 + i);
    batRound.set(-0.5 + Math.cos(turn) * reach, 3 + 1.8 * Math.sin(u * 0.45 + i * 1.3) + 0.2 * Math.sin(u * 3.1 + i), middle.z - 0.3 + Math.sin(turn) * reach * 0.85);
    const up = THREE.MathUtils.smootherstep(u, 0, 1.1) * (1 - THREE.MathUtils.smootherstep(u, 9.6, 10.7));
    const out = THREE.MathUtils.smootherstep(u, 0.9, 2.1) * (1 - THREE.MathUtils.smootherstep(u, 8.4, 9.8));
    return into.lerpVectors(batDeep, batOver, up).lerp(batRound, out);
  };
  const placeBats = (t: number) => {
    for (let i = 0; i < BATS; i++) {
      const since = t - (2.4 + i * 0.4);
      if (since < 0) {
        bats.place(i, batAt, batNext, 0);
        continue;
      }
      const u = since % BAT_CYCLE;
      batPosition(batAt, i, u);
      batPosition(batNext, i, u + 0.04).sub(batAt);
      bats.place(i, batAt, batNext, 1.25 * THREE.MathUtils.smoothstep(u, 0, 0.3) * (1 - THREE.MathUtils.smoothstep(u, 10.4, 10.7)));
    }
    bats.done();
  };

  const shade = shadeFor(edge);
  const extent = [...edge, top.clone().setX(top.x - 0.4), top.clone().setX(top.x + 0.4)];
  return {
    real,
    shade: shade.mesh,
    edge,
    extent,
    covers: footprint(extent),
    inside,
    animate: (t) => {
      // Once real: the lantern sways on its rope, its flame flickers and now and then gutters, embers rise, drips
      // fall, the roots stir, and bats burst up out of the pit into the street and back.
      const wake = wakeAt(t);
      swing.rotation.set(wake * 0.07 * Math.sin(t * 1.4 + 0.8), 0, wake * 0.16 * Math.sin(t * 1.9));
      const gutter = Math.max(0, Math.sin(t * 0.61) * Math.sin(t * 2.3 + 1));
      flame.intensity = 6 * (1 + wake * (0.14 * Math.sin(t * 7.3) + 0.09 * Math.sin(t * 17.9 + 1.3) - 0.4 * gutter));
      glow.value = flame.intensity / 6;
      embers.update(t, wake);
      time.value = wokenFor(t);
      wakeU.value = wake;
      placeDrips(t, wake);
      placeBats(t);
    },
    geometries: [wallGeometry, floorGeometry, caseGeometry, glassGeometry, ropeGeometry, embers.geometry, shade.geometry, roots.geometry, dripGeometry, bats.geometry, ...steps.geometries],
    materials: [wallMaterial, floorMaterial, wood, twine, caseMaterial, glassMaterial, haloMaterial, embers.material, shade.material, roots.material, dripMaterial, bats.material]
  };
}

// --------------------------------------------------------------------------------------------------------------- Pool

// Small value noise that repeats every `period` units, for textures that must tile.
function loopNoise(x: number, y: number, period: number, seed: number) {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const u = (x - i) * (x - i) * (3 - 2 * (x - i));
  const v = (y - j) * (y - j) * (3 - 2 * (y - j));
  const i0 = ((i % period) + period) % period;
  const i1 = (((i + 1) % period) + period) % period;
  const j0 = ((j % period) + period) % period;
  const j1 = (((j + 1) % period) + period) % period;
  const lerp = THREE.MathUtils.lerp;
  return lerp(lerp(hash3(i0, j0, seed), hash3(i1, j0, seed), u), lerp(hash3(i0, j1, seed), hash3(i1, j1, seed), u), v);
}

// The pool's textures, painted once and kept, as every pool uses the same.
// tiles: glazed tiles eight to the metre, pale aqua, each a shade off the next and its glaze a little uneven, with
// grout between (the alpha, for roughness), and a normal map of each tile's rounded edge falling to the grout.
// caustics: the net of bright lines sunlight makes through moving water (the gaps between cells, red), and two
// channels of slow noise (green, blue) to bend it with, so it can be made to wander.
// ripples: a normal map of small waves running every way across the surface, made of whole waves so it repeats.
let poolBakes: { tiles: THREE.DataTexture; tilesNormal: THREE.DataTexture; caustics: THREE.DataTexture; ripples: THREE.DataTexture } | undefined;
function poolTextures() {
  if (poolBakes) return poolBakes;
  const S = THREE.MathUtils.smoothstep;
  const T = 512;
  const cell = T / 8;
  const heights = new Float32Array(T * T);
  // Within a tile (the same for each): the grout, and the tile's edge rounding down into it, by distance in to the
  // tile's nearest edge in metres. And for each tile, its own shade and tint.
  const groutIn = new Float64Array(cell * cell);
  const bevelIn = new Float64Array(cell * cell);
  for (let b = 0; b < cell; b++)
    for (let a = 0; a < cell; a++) {
      const [u, v] = [(a + 0.5) / cell, (b + 0.5) / cell];
      const edge = Math.min(u, 1 - u, v, 1 - v) / 8;
      groutIn[b * cell + a] = 1 - S(edge, 0.0016, 0.0026);
      bevelIn[b * cell + a] = S(edge, 0.0016, 0.0065);
    }
  const each = (seed: number) => Float64Array.from({ length: 64 }, (_, t) => hash3(t % 8, Math.floor(t / 8), seed));
  const [base, across, down, tint] = [each(1), each(3), each(4), each(2)];
  const tiles = baked(T, T, true, (x, y, out) => {
    const t = Math.floor(y / cell) * 8 + Math.floor(x / cell);
    const a = x % cell;
    const b = y % cell;
    const u = (a + 0.5) / cell;
    const v = (b + 0.5) / cell;
    // Grit in the grout.
    const grout = groutIn[b * cell + a];
    const grit = hash3(x, y, 9);
    heights[y * T + x] = bevelIn[b * cell + a] - 0.015 * grout * grit;
    // Each tile a shade off the next, a touch greener or bluer, and its glaze a little uneven across it.
    const shade = 1 + 0.045 * base[t] + 0.02 * (across[t] * (u - 0.5) + down[t] * (v - 0.5));
    const hue = 0.025 * tint[t];
    const sand = 0.92 + 0.05 * grit;
    out[0] = THREE.MathUtils.lerp((0.7 - hue) * shade, 0.66 * sand, grout);
    out[1] = THREE.MathUtils.lerp(0.86 * shade, 0.67 * sand, grout);
    out[2] = THREE.MathUtils.lerp((0.88 + hue) * shade, 0.64 * sand, grout);
    out[3] = grout;
  });
  const C = 256;
  const CELLS = 5;
  // A point in each cell, wandered off its middle; the cells repeat across the texture's edges.
  const jitter = Array.from({ length: CELLS * CELLS * 2 }, (_, k) => 0.42 * hash3(k >> 1, k & 1, 3));
  const caustics = baked(C, C, false, (x, y, out) => {
    const px = ((x + 0.5) / C) * CELLS;
    const py = ((y + 0.5) / C) * CELLS;
    const ci = Math.floor(px);
    const cj = Math.floor(py);
    let f1 = 9;
    let f2 = 9;
    for (let a = ci - 1; a <= ci + 1; a++)
      for (let b = cj - 1; b <= cj + 1; b++) {
        const k = (((a + CELLS) % CELLS) * CELLS + ((b + CELLS) % CELLS)) * 2;
        const dx = a + 0.5 + jitter[k] - px;
        const dy = b + 0.5 + jitter[k + 1] - py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) f2 = d;
      }
    out[0] = Math.exp(-(f2 - f1) * 7);
    out[1] = 0.5 + 0.5 * loopNoise((x / C) * 4, (y / C) * 4, 4, 5);
    out[2] = 0.5 + 0.5 * loopNoise((x / C) * 4, (y / C) * 4, 4, 6);
  });
  const R = 128;
  const waves = Array.from({ length: 11 }, (_, k) => {
    const turn = k * 2.39996 + 0.3;
    const reach = 2 + (k % 5) * 1.4;
    return { kx: Math.round(Math.cos(turn) * reach), ky: Math.round(Math.sin(turn) * reach), size: 1 / (1 + 0.35 * k), phase: k * 1.7 };
  });
  const ripples = baked(R, R, false, (x, y, out) => {
    let dx = 0;
    let dy = 0;
    for (const w of waves) {
      const slope = Math.cos(Math.PI * 2 * ((w.kx * x) / R + (w.ky * y) / R) + w.phase) * w.size;
      dx += slope * w.kx * 0.02;
      dy += slope * w.ky * 0.02;
    }
    const l = Math.hypot(dx, dy, 1);
    out[0] = 0.5 - (0.5 * dx) / l;
    out[1] = 0.5 - (0.5 * dy) / l;
    out[2] = 0.5 + 0.5 / l;
  });
  poolBakes = { tiles, tilesNormal: normalsOf(T, T, heights, 6), caustics, ripples };
  return poolBakes;
}

// Painted while the page is idle after it loads, so building the pit or the pool later need not wait on them.
if (typeof window !== "undefined" && "requestIdleCallback" in window)
  window.requestIdleCallback(() => {
    weatheredPine();
    window.requestIdleCallback(() => poolTextures());
  });

// Bullnose coping round the pool's edge: stone a few centimetres thick, its top flush with the paving, its rounded nose
// standing a little out over the water. uv runs round the edge and over the nose, in metres.
function coping(edge: THREE.Vector3[]) {
  const profile = [[0, 0], [0.028, 0], [0.042, -0.006], [0.052, -0.02], [0.054, -0.036], [0.048, -0.052], [0.034, -0.062], [0.012, -0.066], [0, -0.066]];
  const n = edge.length;
  const middle = edge.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(n);
  const positions: number[] = [];
  const uvs: number[] = [];
  let around = 0;
  for (let k = 0; k <= n; k++) {
    const p = edge[k % n];
    const tangent = edge[(k + 1) % n].clone().sub(edge[(k + n - 1) % n]).setY(0).normalize();
    const inward = new THREE.Vector3(-tangent.z, 0, tangent.x);
    if (inward.dot(middle.clone().sub(p)) < 0) inward.negate();
    if (k) around += p.distanceTo(edge[k - 1]);
    let over = 0;
    profile.forEach(([d, y], j) => {
      if (j) over += Math.hypot(d - profile[j - 1][0], y - profile[j - 1][1]);
      positions.push(p.x + inward.x * d, y, p.z + inward.z * d);
      uvs.push(around, over);
    });
  }
  const index: number[] = [];
  const m = profile.length;
  for (let k = 0; k < n; k++)
    for (let j = 0; j < m - 1; j++) {
      const a = k * m + j;
      index.push(a, a + 1, a + m, a + 1, a + m + 1, a + m);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  // Faces out of the stone: check the top's normal points up, and turn the winding if not.
  if (geometry.getAttribute("normal").getY(m * 3) < 0) {
    for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
    geometry.setIndex(index);
    geometry.computeVertexNormals();
  }
  return geometry;
}

export function buildPool(scans: Scans): Drawing {
  const [x0, x1, z0, z1, r] = [-1.55, 1.55, -4.9, 0.3, 0.3];
  const edge = roundedRect(x0, x1, z0, z1, r);
  const DEPTH = 2;
  const WATER = -0.3;
  const time = uniform(0);
  // How stirred the water is: glassy and still as chalk, rippling once it wakes.
  const stir = uniform(0);
  const real = new THREE.Group();

  // Sunlight through the moving surface, rippling over the tiles below the water: a net of bright lines, bent by slow
  // noise that drifts with the water, at two sizes. Cast down the slant of the sun, so it lies on the walls as on the
  // floor rather than running straight down them.
  const bakes = poolTextures();
  const caustic = (p: any) => {
    const at = p.xz.add(vec2(p.y.mul(0.6), p.y.mul(0.45)));
    const net = (scale: number, drift: any, warp: number) => {
      const bend = texture(bakes.caustics, at.mul(scale * 0.31).add(drift)).gb.sub(0.5).mul(warp);
      return texture(bakes.caustics, at.mul(scale).add(bend).add(drift.mul(-0.4))).r;
    };
    const lines = net(0.62, vec2(time.mul(0.021), time.mul(0.014)), 0.55).add(net(1.37, vec2(time.mul(-0.017), time.mul(0.026)), 0.4).mul(0.55));
    return pow(lines, 2.2).mul(1.25).mul(stir.mul(0.75).add(0.25));
  };
  const under = smoothstep(WATER + 0.02, WATER - 0.08, positionWorld.y);
  // Light through water loses its reds first: the deeper below the surface, the more blue-green what is seen there.
  const absorb = exp(vec3(0.42, 0.11, 0.07).mul(min(positionWorld.y.sub(WATER), 0)));
  // The pool light's glow on the tiles round it, falling off over a metre or so.
  const LAMP = new THREE.Vector3(x1, -0.95, -2.6);
  const lampGlow = color("#7fd8ee").mul(pow(max(float(1).sub(length(positionWorld.sub(vec3(LAMP.x, LAMP.y, LAMP.z))).div(1.1)), 0), 2.5).mul(0.35));

  // Tiles down the walls under the coping, a band of dark blue ones at the waterline, a dark line where the water
  // sits on them.
  const LIP = 0.066;
  // The tiles set out from the middle of each wall, so the targets on the end walls sit on whole tiles and the cut ones
  // fall in the corners, the difference eased out round each corner. The rows start under the coping.
  const along = [0];
  edge.forEach((p, k) => along.push(along[k] + p.distanceTo(edge[(k + 1) % edge.length])));
  // Each corner's eleven points; wall c runs from the end of corner c to the start of the next.
  const PER = 11;
  const mids = [0, 1, 2, 3].map((c) => (along[c * PER + PER - 1] + along[(c + 1) * PER]) / 2);
  const shift = mids.map((mid) => Math.round(mid * 8) / 8 - mid);
  const ends = [0, 2].map((c) => mids[c] + shift[c]);
  // (The same for every pool, so made once a page.)
  const wallGeometry = kept("pool wall", () => {
    const geometry = walls(edge, DEPTH, 1, undefined, 12);
    const uvs = geometry.getAttribute("uv");
    const n = edge.length;
    for (let i = 0; i < uvs.count; i++) {
      const k = (i % (n + 1)) % n;
      const [c, m] = [Math.floor(k / PER), k % PER];
      uvs.setXY(i, uvs.getX(i) + THREE.MathUtils.lerp(shift[(c + 3) % 4], shift[c], m / (PER - 1)), uvs.getY(i) - LIP);
    }
    return geometry;
  });
  const tileAt = uv();
  const wallMaterial = new THREE.MeshStandardNodeMaterial();
  const tile = texture(bakes.tiles, tileAt);
  const coped = step(tileAt.y, 0);
  const line = float(1).sub(smoothstep(0.0, 0.05, abs(positionWorld.y.sub(WATER - 0.02)))).mul(0.35);
  // Dark tile targets on the end walls, a stripe down to a cross-bar, as the lane line ends in; whole tiles each.
  const onEnd = min(abs(tileAt.x.sub(ends[0])), abs(tileAt.x.sub(ends[1])));
  const stem = step(onEnd, 0.125).mul(step(0.5, tileAt.y));
  const bar = step(abs(tileAt.y.sub(1)), 0.125).mul(step(onEnd, 0.375));
  const band = step(tileAt.y, 0.25);
  const deep = vec3(0.13, 0.27, 0.52);
  const tiled = mix(tile.rgb, deep.mul(tile.rgb.mul(1.2)), max(max(stem, bar), band).mul(float(1).sub(tile.a).mul(0.9)));
  // (Behind the coping, out of sight but for a sliver.)
  const stone = vec3(0.62, 0.6, 0.56);
  wallMaterial.colorNode = mix(tiled.mul(float(1).sub(line)).mul(mix(vec3(1), absorb, under)).mul(under.mul(caustic(positionWorld)).add(1)), stone, coped);
  wallMaterial.roughnessNode = mix(mix(float(0.12), float(0.75), tile.a), float(0.7), coped);
  wallMaterial.normalNode = normalMap(texture(bakes.tilesNormal, tileAt));
  wallMaterial.emissiveNode = lampGlow;
  const wall = new THREE.Mesh(wallGeometry, wallMaterial);
  wall.castShadow = wall.receiveShadow = true;
  real.add(wall);

  // The coping: pale stone laid in lengths with mortar between.
  const copingGeometry = kept("pool coping", () => coping(edge));
  const copingMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.75 });
  const joint = float(1).sub(smoothstep(0.003, 0.006, abs(fract(uv().x.div(0.6).add(0.5)).sub(0.5)).mul(0.6)));
  copingMaterial.colorNode = texture(scans.slab, uv().mul(vec2(0.8, 0.8)).add(vec2(0, 0.3))).rgb.mul(vec3(1.3, 1.27, 1.2)).mul(float(1).sub(joint.mul(0.35)));
  const copingStone = new THREE.Mesh(copingGeometry, copingMaterial);
  copingStone.castShadow = copingStone.receiveShadow = true;
  real.add(copingStone);

  // The floor: tiles, with a dark lane line down the middle, two tiles wide.
  const floorGeometry = floorOf(edge, -DEPTH);
  const floorMaterial = new THREE.MeshStandardNodeMaterial();
  const floorTile = texture(bakes.tiles, positionWorld.xz);
  // The lane line ends a little short of each wall in a T; a pair of round drain grates sits either side of it.
  const run = step(-4.125, positionWorld.z).mul(step(positionWorld.z, -0.5));
  const tee = max(step(abs(positionWorld.z.add(4.125)), 0.125), step(abs(positionWorld.z.add(0.5)), 0.125)).mul(step(abs(positionWorld.x), 0.5));
  const lane = max(step(abs(positionWorld.x), 0.125).mul(run), tee).mul(float(1).sub(floorTile.a));
  const drainAt = vec2(abs(positionWorld.x).sub(0.62), positionWorld.z.add(3.1));
  const drainR = length(drainAt);
  const slots = step(0.5, fract(atan(drainAt.y, drainAt.x).mul(14 / (Math.PI * 2))));
  const grate = mix(vec3(0.82, 0.83, 0.82), mix(vec3(0.03, 0.035, 0.04), vec3(0.7, 0.72, 0.72), slots.mul(step(0.03, drainR))), step(drainR, 0.14));
  const drain = step(drainR, 0.17);
  floorMaterial.colorNode = mix(mix(floorTile.rgb, deep.mul(floorTile.rgb.mul(1.2)), lane), grate, drain).mul(absorb).mul(caustic(positionWorld).mul(1.1).add(1));
  floorMaterial.roughnessNode = mix(mix(float(0.12), float(0.75), floorTile.a), float(0.3), drain);
  floorMaterial.normalNode = normalMap(texture(bakes.tilesNormal, positionWorld.xz));
  floorMaterial.emissiveNode = lampGlow;
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.receiveShadow = true;
  real.add(floor);

  // The water: clear, tinted, its surface rippling, reflecting the sky and the sun; more of the sky off it the lower
  // it is seen, more of the pool through it from above.
  const waterGeometry = floorOf(roundedRect(x0 - 0.05, x1 + 0.05, z0 - 0.05, z1 + 0.05, r), WATER);
  const waterMaterial = new THREE.MeshPhysicalNodeMaterial({ color: "#3cb7cf", roughness: 0.05, metalness: 0, transparent: true, depthWrite: false });
  const wave = (scale: number, drift: any) => texture(bakes.ripples, positionWorld.xz.mul(scale).add(drift)).xy.sub(0.5);
  const slope = wave(0.42, vec2(time.mul(0.031), time.mul(0.019))).add(wave(0.77, vec2(time.mul(-0.022), time.mul(0.034))).mul(0.7));
  waterMaterial.normalNode = normalMap(vec4(slope.mul(stir.mul(1.6)).add(0.5), 1, 1) as any);
  const view = cameraPosition.sub(positionWorld).normalize();
  waterMaterial.opacityNode = mix(float(0.42), float(0.9), pow(float(1).sub(abs(view.y)), 3));
  // Once it stirs, points of sun glinting off the ripples, thickest toward the far end, under the low sun.
  // Where two drifting nets of crests cross, a point of light.
  const sparkle = texture(bakes.caustics, positionWorld.xz.mul(2.1).add(vec2(time.mul(0.11), 0))).r.mul(texture(bakes.caustics, positionWorld.xz.mul(2.9).add(vec2(0.37, time.mul(-0.13)))).r);
  waterMaterial.emissiveNode = vec3(1, 0.95, 0.85).mul(pow(max(sparkle.sub(0.8), 0).mul(5), 3).mul(14)).mul(stir).mul(smoothstep(z1, z0, positionWorld.z).mul(0.8).add(0.2));
  const water = new THREE.Mesh(waterGeometry, waterMaterial);
  real.add(water);

  // The skimmer's mouth in the side wall at the waterline, its weir flap hanging in it, and a return jet in the far
  // wall, an eyeball in a flange: white plastic, dark inside. And a light set in the near side wall, its lens glowing
  // (its glow on the tiles round it is painted on them, LAMP below, rather than costing a light).
  const plastic = new THREE.MeshStandardNodeMaterial({ color: "#e9e9e4", roughness: 0.4 });
  const dark = new THREE.MeshStandardNodeMaterial({ color: "#0b0e10", roughness: 0.8 });
  const fittingParts: THREE.BufferGeometry[] = [];
  const mouthParts: THREE.BufferGeometry[] = [];
  const at = (g: THREE.BufferGeometry, x: number, y: number, z: number, list: THREE.BufferGeometry[]) => {
    g.translate(x, y, z);
    list.push(g);
  };
  at(new RoundedBoxGeometry(0.03, 0.24, 0.44, 1, 0.012), x0 + 0.012, WATER + 0.01, -1.3, fittingParts);
  at(new THREE.BoxGeometry(0.034, 0.15, 0.33), x0 + 0.014, WATER + 0.02, -1.3, mouthParts);
  const weir = new THREE.BoxGeometry(0.008, 0.11, 0.3);
  weir.rotateZ(-0.35);
  at(weir, x0 + 0.03, WATER + 0.0, -1.3, fittingParts);
  const flange = new THREE.CylinderGeometry(0.06, 0.064, 0.016, 20);
  flange.rotateX(Math.PI / 2);
  at(flange, 0.95, -0.8, z0 + 0.008, fittingParts);
  const eyeball = new THREE.SphereGeometry(0.03, 14, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  eyeball.rotateX(Math.PI / 2);
  at(eyeball, 0.95, -0.8, z0 + 0.012, fittingParts);
  const nozzle = new THREE.CylinderGeometry(0.012, 0.012, 0.05, 10, 1, true);
  nozzle.rotateX(Math.PI / 2);
  at(nozzle, 0.95, -0.8, z0 + 0.02, mouthParts);
  const rim = new THREE.TorusGeometry(0.115, 0.014, 6, 24);
  rim.rotateY(Math.PI / 2);
  at(rim, LAMP.x - 0.008, LAMP.y, LAMP.z, fittingParts);
  const lens = new THREE.CircleGeometry(0.104, 24);
  lens.rotateY(-Math.PI / 2);
  at(lens, LAMP.x - 0.006, LAMP.y, LAMP.z, fittingParts);
  // The lens is frosted glass lit from behind, brightest in the middle.
  const fromLamp = length(positionLocal.yz.sub(vec2(LAMP.y, LAMP.z)));
  plastic.emissiveNode = color("#d8f6ff").mul(float(2.2).sub(fromLamp.mul(9))).mul(step(fromLamp, 0.1)).mul(step(LAMP.x - 0.05, positionLocal.x));
  const fittingGeometry = joined(fittingParts);
  real.add(new THREE.Mesh(fittingGeometry, plastic));

  // A few leaves blown in off the street trees: three afloat, drifting on the surface once it stirs, one sunk.
  const leafShape = new THREE.Shape();
  leafShape.moveTo(0, -0.5);
  [[0.4, -0.1], [0.5, 0.25], [0.15, 0.2], [0, 0.55], [-0.15, 0.2], [-0.5, 0.25], [-0.4, -0.1]].forEach(([x, y]) => leafShape.lineTo(x, y));
  const leafGeometry = new THREE.ShapeGeometry(leafShape);
  leafGeometry.rotateX(-Math.PI / 2);
  // Thin cards, seen from either side.
  const leafMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, side: THREE.DoubleSide });
  // Paler veins: the midrib, and ribs off it slanting out toward the tip.
  const across = abs(positionLocal.x);
  const vein = max(float(1).sub(smoothstep(0.012, 0.03, across)), float(1).sub(smoothstep(0.02, 0.06, abs(fract(positionLocal.z.add(across.mul(0.9)).mul(5)).sub(0.5)))).mul(0.6));
  leafMaterial.colorNode = mix(vec3(1), vec3(1.45, 1.3, 1.05), vein);
  const leaves = [
    { x: 0.55, z: -1.4, y: WATER + 0.004, size: 0.13, turn: 0.6, colour: "#8a4f1c", afloat: true },
    { x: -0.9, z: -3.6, y: WATER + 0.004, size: 0.11, turn: 2.2, colour: "#a8772a", afloat: true },
    { x: 1.05, z: -3.0, y: WATER + 0.004, size: 0.12, turn: 4.1, colour: "#6e3b18", afloat: true },
    { x: -0.3, z: -2.2, y: -DEPTH + 0.004, size: 0.12, turn: 1.3, colour: "#4a3220", afloat: false }
  ];
  const leafMesh = new THREE.InstancedMesh(leafGeometry, leafMaterial, leaves.length);
  leaves.forEach((leaf, i) => leafMesh.setColorAt(i, new THREE.Color(leaf.colour)));
  leafMesh.castShadow = leafMesh.receiveShadow = true;
  real.add(leafMesh);
  const leafMatrix = new THREE.Matrix4();
  const leafTurn = new THREE.Quaternion();
  const leafEuler = new THREE.Euler();
  const leafAt = new THREE.Vector3();
  const leafSize = new THREE.Vector3();
  const placeLeaves = (t: number, go: number, wake: number) => {
    leaves.forEach((leaf, i) => {
      const drift = leaf.afloat ? 1 : 0;
      leafAt.set(leaf.x + Math.sin(go * 0.06 + i * 2) * 0.35 * drift, leaf.y + Math.sin(t * 1.3 + i) * 0.006 * wake * drift, leaf.z + (Math.cos(go * 0.045 + i * 1.3) - Math.cos(i * 1.3)) * 0.4 * drift);
      leafEuler.set(Math.sin(t * 1.1 + i) * 0.05 * wake * drift, leaf.turn + go * 0.04 * drift * (i % 2 ? 1 : -1), Math.cos(t * 0.9 + i) * 0.05 * wake * drift);
      leafMesh.setMatrixAt(i, leafMatrix.compose(leafAt, leafTurn.setFromEuler(leafEuler), leafSize.setScalar(leaf.size)));
    });
    leafMesh.instanceMatrix.needsUpdate = true;
  };
  placeLeaves(0, 0, 0);

  // A beach ball afloat by the steps. Once real, a surge in the water slops over the coping: the ball is thrown out
  // onto the sidewalk on the street side (OUT, -x: the stoops are the other way) and bounces to rest there, drops fly,
  // and a wet patch spreads over the paving. Each is wherever
  // its clock puts it, so it all runs as well backwards as forwards.
  const BALL = 0.2;
  const ballGeometry = new THREE.SphereGeometry(BALL, 32, 20);
  const ballMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.32 });
  {
    // Six gores round it, red, yellow and blue between white ones, and white caps at the poles.
    const gore = atan(positionLocal.z, positionLocal.x).div(Math.PI * 2).add(0.5).mul(6).floor();
    const hue = mix(mix(color("#e8392e"), color("#f4c430"), step(1.5, gore)), color("#2f6fd6"), step(3.5, gore));
    const white = color("#f4f1ea");
    ballMaterial.colorNode = mix(mix(hue, white, step(0.5, fract(gore.div(2)))), white, step(BALL * 0.86, abs(positionLocal.y)));
  }
  const ball = new THREE.Mesh(ballGeometry, ballMaterial);
  ball.castShadow = ball.receiveShadow = true;
  real.add(ball);
  const SURGE = 3.2;
  const OUT = -1;
  // Afloat, then its flight and three bounces (each [where it lands, how long, how high]), then a roll to rest.
  const ballStops = [
    new THREE.Vector3(OUT * 0.95, WATER + 0.12, -1.3),
    new THREE.Vector3(OUT * 1.95, BALL, -1.8),
    new THREE.Vector3(OUT * 2.3, BALL, -2.0),
    new THREE.Vector3(OUT * 2.5, BALL, -2.12)
  ];
  const ballHops: [number, number][] = [
    [0.75, 0.75],
    [0.45, 0.24],
    [0.26, 0.07]
  ];
  const ballRest = new THREE.Vector3(OUT * 2.66, BALL, -2.2);
  const ballAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), ballRest.clone().sub(ballStops[0]).setY(0).normalize());
  const ballSpin = new THREE.Quaternion();
  const placeBall = (t: number, wake: number) => {
    let since = t - SURGE;
    let rolled = 0;
    if (since <= 0) {
      ball.position.copy(ballStops[0]).y += Math.sin(t * 1.3) * 0.015 * wake;
    } else {
      let k = 0;
      while (k < ballHops.length && since > ballHops[k][0]) {
        rolled += ballStops[k].distanceTo(ballStops[k + 1]);
        since -= ballHops[k][0];
        k++;
      }
      if (k < ballHops.length) {
        const f = since / ballHops[k][0];
        ball.position.lerpVectors(ballStops[k], ballStops[k + 1], f);
        ball.position.y += 4 * ballHops[k][1] * f * (1 - f);
        rolled += ballStops[k].distanceTo(ballStops[k + 1]) * f;
      } else {
        const f = 1 - Math.pow(1 - Math.min(1, since / 1.4), 2);
        ball.position.lerpVectors(ballStops[3], ballRest, f);
        rolled += ballStops[3].distanceTo(ballRest) * f;
      }
    }
    ball.quaternion.copy(ballSpin.setFromAxisAngle(ballAxis, rolled / BALL));
  };
  placeBall(0, 0);

  const DROPS = 36;
  const dropGeometry = new THREE.SphereGeometry(1, 6, 4);
  const dropMaterial = new THREE.MeshStandardNodeMaterial({ color: "#cfe6ee", roughness: 0.05 });
  const drops = new THREE.InstancedMesh(dropGeometry, dropMaterial, DROPS);
  const dropSeeds = Array.from({ length: DROPS }, (_, i) => {
    const r = (n: number) => {
      const v = Math.sin(i * 51.7 + n * 17.3) * 43758.5453;
      return v - Math.floor(v);
    };
    return { from: new THREE.Vector3(OUT * (1.25 + r(1) * 0.25), WATER, -1.1 - r(2) * 0.9), v: new THREE.Vector3(OUT * (1 + r(3) * 1.6), 1.6 + r(4) * 1.8, (r(5) - 0.5) * 1.2), size: 0.008 + r(6) * 0.014, delay: r(7) * 0.15 };
  });
  const dropMatrix = new THREE.Matrix4();
  const dropAt = new THREE.Vector3();
  const placeDrops = (t: number) => {
    dropSeeds.forEach((d, i) => {
      const f = t - SURGE - d.delay;
      dropAt.copy(d.from).addScaledVector(d.v, f);
      dropAt.y -= 4.9 * f * f;
      // Gone once it falls back onto the paving or into the water.
      const floor = dropAt.x * OUT > x1 ? 0 : WATER;
      const size = f > 0 && dropAt.y > floor ? d.size : 0;
      drops.setMatrixAt(i, dropMatrix.makeScale(size, size, size).setPosition(dropAt));
    });
    drops.instanceMatrix.needsUpdate = true;
  };
  placeDrops(0);
  real.add(drops);

  // The wet patch: darker and glossy on the paving beside the pool, spreading from where the water came over, and the
  // ball's damp marks where it bounced. It dries off very slowly.
  const wetGeometry = new THREE.PlaneGeometry(2.2, 2.0);
  wetGeometry.rotateX(-Math.PI / 2);
  wetGeometry.translate(OUT * 2.15, 0.003, -1.85);
  const spread = uniform(0);
  const wetMaterial = new THREE.MeshStandardNodeMaterial({ color: "#151412", roughness: 0.12, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  {
    const at = positionWorld.xz;
    const ragged = mx_noise_float(vec3(at.mul(3.2), 2)).mul(0.14).add(mx_noise_float(vec3(at.mul(9), 4)).mul(0.04));
    const reach = spread.mul(0.95).add(0.05);
    const puddle = smoothstep(reach.add(ragged), reach.add(ragged).sub(0.14), length(at.sub(vec2(OUT * 1.55, -1.6)).mul(vec2(0.9, 1.15))));
    const marks = max(smoothstep(0.15, 0.08, length(at.sub(vec2(OUT * 1.95, -1.8)))), smoothstep(0.12, 0.06, length(at.sub(vec2(OUT * 2.3, -2.0))))).mul(step(0.3, spread));
    wetMaterial.opacityNode = max(puddle, marks).mul(spread.mul(0.55)).mul(float(1).sub(insideRect(x0, x1, z0, z1, r)(at)));
  }
  const wet = new THREE.Mesh(wetGeometry, wetMaterial);
  wet.receiveShadow = true;
  wet.visible = false;
  real.add(wet);

  // A steel ladder at the far end, its rails curving up over the coping and down onto the sidewalk into cover plates,
  // capped where they end under the water, held off the wall there by rubber bumpers.
  const steel = new THREE.MeshStandardNodeMaterial({ color: "#d9dde0", metalness: 1, roughness: 0.18 });
  const railGeometries: THREE.BufferGeometry[] = [];
  const railParts: THREE.BufferGeometry[] = [];
  // Low over the coping, so its chalk lands on the sidewalk close past the pool.
  const ladderX = 0.65;
  [-0.25, 0.25].forEach((dx) => {
    const x = ladderX + dx;
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x, -1.25, z0 + 0.16),
      new THREE.Vector3(x, 0.3, z0 + 0.16),
      new THREE.Vector3(x, 0.58, z0 - 0.04),
      new THREE.Vector3(x, 0.4, z0 - 0.32),
      new THREE.Vector3(x, 0.0, z0 - 0.38)
    ]);
    railParts.push(new THREE.TubeGeometry(path, 48, 0.024, 10));
    const cap = new THREE.SphereGeometry(0.024, 10, 3, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    railParts.push(cap.translate(x, -1.25, z0 + 0.16));
    const plate = new THREE.CylinderGeometry(0.04, 0.046, 0.012, 16);
    railParts.push(plate.translate(x, 0.006, z0 - 0.38));
    const bumper = new THREE.CylinderGeometry(0.014, 0.014, 0.14, 8, 1, true);
    bumper.rotateX(Math.PI / 2);
    mouthParts.push(bumper.translate(x, -1.1, z0 + 0.075));
    const pad = new THREE.CylinderGeometry(0.03, 0.03, 0.016, 12);
    pad.rotateX(Math.PI / 2);
    mouthParts.push(pad.translate(x, -1.1, z0 + 0.008));
  });
  // Treads with ribs across their tops for grip.
  const tread = new THREE.BoxGeometry(0.5, 0.03, 0.1);
  [-0.35, -0.7, -1.05].forEach((ty) => railParts.push(tread.clone().translate(ladderX, ty, z0 + 0.12)));
  tread.dispose();
  const rib = step(0.55, fract(positionLocal.z.mul(70))).mul(step(0.9, normalLocal.y)).mul(step(positionLocal.y, -0.2));
  steel.colorNode = mix(color("#d9dde0"), color("#8d9396"), rib);
  steel.roughnessNode = mix(float(0.18), float(0.5), rib);
  const railGeometry = joined(railParts);
  railGeometries.push(railGeometry);
  const rails = new THREE.Mesh(railGeometry, steel);
  rails.castShadow = rails.receiveShadow = true;
  real.add(rails);
  const mouthGeometry = joined(mouthParts);
  real.add(new THREE.Mesh(mouthGeometry, dark));

  // A striped float, drifting and bobbing.
  const ringGeometry = new THREE.TorusGeometry(0.36, 0.12, 16, 48);
  ringGeometry.rotateX(Math.PI / 2);
  const ringMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.3 });
  const stripe = step(0, sin(atan(positionLocal.z, positionLocal.x).mul(4)));
  ringMaterial.colorNode = mix(color("#f4f1ea"), color("#e0412f"), stripe);
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.castShadow = ring.receiveShadow = true;
  real.add(ring);

  const shade = shadeFor(edge);
  const top = new THREE.Vector3(ladderX, 0.64, z0 - 0.05);
  const extent = [...edge, top.clone().setX(ladderX - 0.32), top.clone().setX(ladderX + 0.32)];
  return {
    real,
    shade: shade.mesh,
    edge,
    extent,
    covers: footprint(extent),
    inside: insideRect(x0, x1, z0, z1, r),
    animate: (t) => {
      // Once real: the surface stirs into ripples, the light on the tiles starts to dance, the float bobs and drifts,
      // leaves drift, and a surge throws the beach ball out onto the sidewalk with a splash that wets the paving.
      const wake = wakeAt(t);
      time.value = t;
      stir.value = wake;
      ring.position.set(-0.55 + Math.sin(t * 0.11) * 0.25 * wake, WATER - 0.02 + Math.sin(t * 1.3) * 0.012 * wake, -2.6 + (Math.cos(t * 0.08) - 1) * 0.3 * wake);
      ring.rotation.set(Math.sin(t * 0.9) * 0.04 * wake, t * 0.05 * wake, Math.cos(t * 0.7) * 0.04 * wake);
      placeLeaves(t, wokenFor(t), wake);
      placeBall(t, wake);
      placeDrops(t);
      const wetness = THREE.MathUtils.smoothstep(t, SURGE + 0.3, SURGE + 2.6) * (1 - THREE.MathUtils.smoothstep(t, 60, 150));
      spread.value = wetness;
      wet.visible = wetness > 0;
    },
    geometries: [wallGeometry, copingGeometry, floorGeometry, waterGeometry, ringGeometry, shade.geometry, fittingGeometry, mouthGeometry, leafGeometry, ballGeometry, dropGeometry, wetGeometry, ...railGeometries],
    materials: [wallMaterial, copingMaterial, floorMaterial, waterMaterial, steel, ringMaterial, shade.material, plastic, dark, leafMaterial, ballMaterial, dropMaterial, wetMaterial]
  };
}

// ------------------------------------------------------------------------------------------------------------- Stairs

export function buildStairs(scans: Scans): Drawing {
  const [x0, x1, z0, z1, r] = [-1.15, 1.15, -5.3, 0.25, 0.04];
  const edge = roundedRect(x0, x1, z0, z1, r, 3);
  // A gentle flight whose top tread is flush with the paving: from the artist's eye the line of sight over the
  // sidewalk's edge then clears every step's nosing, so the whole flight shows (any steeper, or starting a step down,
  // and it hides behind the sidewalk's edge, leaving only the far wall).
  const RISE = 0.125;
  const TREAD = 0.36;
  const COUNT = 14;
  const LANDING = -RISE * COUNT;
  const real = new THREE.Group();
  const y = positionWorld.y;
  // Less of the sky reaches the deeper it goes.
  const deep = mix(float(0.55), float(1), clamp(exp(y.mul(0.4)), 0, 1));

  // Concrete: the steps and the side walls, worn and stained. Each tread darker toward the riser behind it and paler
  // where feet have worn its middle, so that from up on the sidewalk every step shows as its own band.
  const concreteColour = texture(scans.slab, uv().mul(0.6)).rgb.mul(vec3(0.95, 0.93, 0.9));
  const concrete = new THREE.MeshStandardNodeMaterial({ roughness: 0.88 });
  const intoTread = fract(float(z1).sub(positionWorld.z).div(TREAD));
  const upward = step(0.5, normalLocal.y);
  const treadShade = mix(float(1), mix(float(1.18), float(0.5), smoothstep(0.25, 1, intoTread)).mul(mix(float(1), float(1.12), exp(positionWorld.x.mul(positionWorld.x).div(-0.18)))), upward);
  const grime = smoothstep(0.2, 0.7, mx_noise_float(positionWorld.mul(vec3(2.2, 0.5, 2.2)))).mul(float(1).sub(upward));
  concrete.colorNode = concreteColour.mul(treadShade).mul(mix(float(1), float(0.6), grime)).mul(deep);
  const parts: THREE.BufferGeometry[] = [];
  const stoneParts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, into = parts) => {
    const g = new THREE.BoxGeometry(w, h, d);
    // uv in metres on every face, so the concrete is the same size everywhere.
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const u = g.getAttribute("uv");
    for (let i = 0; i < p.count; i++) {
      const [px, py, pz] = [p.getX(i) + x, p.getY(i) + y, p.getZ(i) + z];
      const ax = Math.abs(n.getX(i));
      const ay = Math.abs(n.getY(i));
      u.setXY(i, ax > 0.5 ? pz / 1.2 : px / 1.2, ay > 0.5 ? pz / 1.2 : py / 1.2);
    }
    g.translate(x, y, z);
    into.push(g);
  };
  const nosings: THREE.BufferGeometry[] = [];
  // (Each nosing's top just 2 mm proud of its tread.)
  for (let i = 0; i < COUNT; i++) {
    const top = -RISE * i;
    const front = z1 - TREAD * i;
    box(x1 - x0, 3 + top, TREAD + 0.02, (x0 + x1) / 2, top - (3 + top) / 2, front - TREAD / 2);
    // A steel nosing on every step's edge, worn bright where it is walked on: it catches the light, step by step.
    const nose = new THREE.BoxGeometry(x1 - x0 - 0.06, 0.012, 0.055);
    nose.translate((x0 + x1) / 2, top - 0.004, front - 0.026);
    nosings.push(nose);
  }
  const landingFront = z1 - TREAD * COUNT;
  box(x1 - x0, 0.4, landingFront - z0 + 0.6, (x0 + x1) / 2, LANDING - 0.2, (landingFront + z0 - 0.6) / 2);
  const solid = mergeBoxes(parts);
  const steps = new THREE.Mesh(solid, concrete);
  steps.castShadow = steps.receiveShadow = true;
  // Side walls and the near wall under the first step; the far side is left open for the doorway.
  const sides = walls(edge, -LANDING + 0.05, 1.2, undefined, 8);
  {
    const p = sides.getAttribute("position");
    const index = sides.index!;
    const kept: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const a = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      if (a.every((v) => p.getZ(v) < z0 + 0.05)) continue;
      kept.push(...a);
    }
    sides.setIndex(kept);
  }
  const wallMesh = new THREE.Mesh(sides, concrete);
  wallMesh.castShadow = wallMesh.receiveShadow = true;
  const steel = new THREE.MeshStandardNodeMaterial({ color: "#9a9893", metalness: 0.85, roughness: 0.38 });
  const noseGeometry = mergeBoxes(nosings);
  const noseMesh = new THREE.Mesh(noseGeometry, steel);
  noseMesh.receiveShadow = true;
  real.add(steps, wallMesh, noseMesh);

  // The far wall: dressed granite round a doorway into a low room.
  const graniteColour = texture(scans.granite, uv()).rgb.mul(0.85);
  const granite = new THREE.MeshStandardNodeMaterial({ roughness: 0.75 });
  granite.colorNode = graniteColour.mul(1.1).mul(deep);
  granite.normalNode = normalMap(texture(scans.graniteNormal, uv()));
  // A low cellar doorway, its head under the paving.
  const door = { half: 0.5, top: LANDING + 1.6 };
  box(x1 - x0 + 0.6, -door.top, 0.3, (x0 + x1) / 2, door.top / 2, z0 - 0.15, stoneParts);
  box((x1 - x0) / 2 - door.half + 0.3, door.top - LANDING, 0.3, x0 - 0.3 + ((x1 - x0) / 2 - door.half + 0.3) / 2, (LANDING + door.top) / 2, z0 - 0.15, stoneParts);
  box((x1 - x0) / 2 - door.half + 0.3, door.top - LANDING, 0.3, x1 + 0.3 - ((x1 - x0) / 2 - door.half + 0.3) / 2, (LANDING + door.top) / 2, z0 - 0.15, stoneParts);
  const stoneGeometry = mergeBoxes(stoneParts);
  const stone = new THREE.Mesh(stoneGeometry, granite);
  stone.castShadow = stone.receiveShadow = true;
  real.add(stone);

  // The room beyond the doorway: old plaster, grimy low down, and in its far wall a great window that looks out
  // onto deep space: a spiral galaxy, glowing nebulae and stars beyond counting. Its light spills out through the
  // door and up the steps.
  const plaster = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  plaster.colorNode = mix(vec3(0.2, 0.17, 0.13), vec3(0.42, 0.37, 0.3), smoothstep(LANDING + 0.1, LANDING + 0.9, y)).mul(mx_noise_float(positionWorld.mul(4)).mul(0.12).add(0.94));
  const roomParts: THREE.BufferGeometry[] = [];
  const plane = (w: number, h: number, at: THREE.Vector3, turn: THREE.Euler) => {
    const g = new THREE.PlaneGeometry(w, h);
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(turn));
    g.translate(at.x, at.y, at.z);
    roomParts.push(g);
  };
  // Its ceiling a little above the door's head, still under the paving; its sides tucked behind the doorway's stone.
  const ROOM = { near: z0 - 0.3, far: z0 - 3.3, half: 1.4, high: door.top - LANDING + 0.1 };
  const th = ROOM.high;
  const rmid = (ROOM.near + ROOM.far) / 2;
  const rlen = ROOM.near - ROOM.far;
  const wide = ROOM.half * 2;
  plane(wide, rlen, new THREE.Vector3(0, LANDING, rmid), new THREE.Euler(-Math.PI / 2, 0, 0));
  plane(wide, rlen, new THREE.Vector3(0, LANDING + th, rmid), new THREE.Euler(Math.PI / 2, 0, 0));
  plane(rlen, th, new THREE.Vector3(-ROOM.half, LANDING + th / 2, rmid), new THREE.Euler(0, Math.PI / 2, 0));
  plane(rlen, th, new THREE.Vector3(ROOM.half, LANDING + th / 2, rmid), new THREE.Euler(0, -Math.PI / 2, 0));
  // The far wall round the window.
  const WINDOW = { half: 1.1, sill: LANDING + 0.25, head: LANDING + th - 0.14 };
  plane(wide, WINDOW.sill - LANDING, new THREE.Vector3(0, (LANDING + WINDOW.sill) / 2, ROOM.far), new THREE.Euler(0, 0, 0));
  plane(wide, LANDING + th - WINDOW.head, new THREE.Vector3(0, (WINDOW.head + LANDING + th) / 2, ROOM.far), new THREE.Euler(0, 0, 0));
  [-1, 1].forEach((side) => plane(ROOM.half - WINDOW.half, WINDOW.head - WINDOW.sill, new THREE.Vector3((side * (ROOM.half + WINDOW.half)) / 2, (WINDOW.sill + WINDOW.head) / 2, ROOM.far), new THREE.Euler(0, 0, 0)));
  const roomGeometry = mergeBoxes(roomParts);
  const roomMesh = new THREE.Mesh(roomGeometry, plaster);
  roomMesh.receiveShadow = true;
  real.add(roomMesh);
  // The window's iron frame: an outer frame, two mullions and a transom.
  const frameParts: THREE.BufferGeometry[] = [];
  const bar = (w: number, h: number, x: number, yy: number) => {
    const g = new THREE.BoxGeometry(w, h, 0.07);
    g.translate(x, yy, ROOM.far + 0.02);
    frameParts.push(g);
  };
  const [wy, wh] = [(WINDOW.sill + WINDOW.head) / 2, WINDOW.head - WINDOW.sill];
  bar(WINDOW.half * 2 + 0.1, 0.05, 0, WINDOW.sill);
  bar(WINDOW.half * 2 + 0.1, 0.05, 0, WINDOW.head);
  [-WINDOW.half, -WINDOW.half / 3, WINDOW.half / 3, WINDOW.half].forEach((x) => bar(0.04, wh, x, wy));
  bar(WINDOW.half * 2, 0.035, 0, WINDOW.sill + wh * 0.62);
  const frameGeometry = mergeBoxes(frameParts);

  // Space, out past the window: a closed box well under the paving, coloured only by the way it is looked at, so it
  // is as far off as the stars are from wherever it is seen through the window. Nebulae, and two fields of stars that
  // twinkle once it is real.
  const time = uniform(0);
  const wakeU = uniform(0);
  const spaceGeometry = inward(new THREE.BoxGeometry(20, 14, 22));
  spaceGeometry.translate(0, -7.1, ROOM.far - 0.05 - 11);
  const spaceMaterial = new THREE.MeshBasicNodeMaterial();
  {
    const way = positionWorld.sub(cameraPosition).normalize();
    const cloud = mx_noise_float(way.mul(2.6)).mul(0.6).add(mx_noise_float(way.mul(6.1).add(3)).mul(0.3)).add(mx_noise_float(way.mul(13)).mul(0.12));
    const hue = mx_noise_float(way.mul(1.7).add(7)).mul(0.5).add(0.5);
    const nebula = mix(vec3(0.42, 0.07, 0.3), vec3(0.05, 0.22, 0.34), hue).mul(smoothstep(0.05, 0.75, cloud).mul(0.32));
    const stars = (scale: number, chance: number, size: number, bright: number) => {
      const q = way.mul(scale);
      const cell = q.floor();
      const h = fract(sin(cell.dot(vec3(127.1, 311.7, 74.7))).mul(43758.5453));
      const jitter = vec3(fract(h.mul(13.7)), fract(h.mul(71.3)), fract(h.mul(29.1))).sub(0.5).mul(0.6).add(0.5);
      const d = length(fract(q).sub(jitter));
      const twinkle = float(1).add(sin(time.mul(h.mul(5).add(2)).add(h.mul(90))).mul(0.55).mul(wakeU));
      const tint = mix(vec3(0.7, 0.8, 1.2), vec3(1.2, 0.95, 0.75), fract(h.mul(7.3)));
      return tint.mul(smoothstep(size, 0, d).mul(step(chance, h)).mul(bright).mul(twinkle));
    };
    spaceMaterial.colorNode = vec3(0.004, 0.005, 0.012).add(nebula).add(stars(90, 0.9, 0.09, 3.5)).add(stars(240, 0.8, 0.16, 1.2));
  }
  real.add(new THREE.Mesh(spaceGeometry, spaceMaterial));

  // The galaxy: a disc of light seen at a slant, a bright yellow-white core, blue arms wound in a spiral with dark dust
  // lanes along their inner edges and pink knots of new stars; once real it slowly turns.
  const galaxyGeometry = new THREE.CircleGeometry(6.5, 96);
  const galaxyMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  {
    const spin = time.mul(0.035);
    const p = uv().sub(0.5).mul(2);
    const rr = length(p);
    const angle = atan(p.y, p.x).add(spin);
    const wind = angle.mul(2).sub(rr.add(0.02).log().mul(4.6));
    const arms = pow(cos(wind).mul(0.5).add(0.5), 2.5);
    const lane = pow(cos(wind.sub(0.7)).mul(0.5).add(0.5), 6);
    const turned = vec2(cos(angle), sin(angle)).mul(rr);
    const grain = mx_noise_float(vec3(turned.mul(9), 0.5)).mul(0.5).add(0.5);
    const knots = smoothstep(0.72, 0.9, mx_noise_float(vec3(turned.mul(26), 1.5)).mul(0.5).add(0.5)).mul(arms);
    const core = exp(rr.div(-0.05)).mul(3).add(exp(rr.div(-0.2)).mul(0.7));
    const disc = exp(rr.div(-0.36)).mul(arms.mul(grain.mul(0.9).add(0.4))).mul(float(1).sub(lane.mul(0.75)));
    const edge = smoothstep(1, 0.6, rr);
    galaxyMaterial.colorNode = vec3(1, 0.84, 0.6).mul(core).add(vec3(0.5, 0.66, 1).mul(disc.mul(1.5))).add(vec3(1, 0.35, 0.65).mul(knots.mul(exp(rr.div(-0.45))).mul(2))).mul(edge);
  }
  const galaxy = new THREE.Mesh(galaxyGeometry, galaxyMaterial);
  // Set where the view down through the door and the window finds it.
  galaxy.position.set(0.6, -4.2, ROOM.far - 12.5);
  galaxy.rotation.set(-0.95, 0.2, 0.5);
  real.add(galaxy);

  // Now and then a shooting star across the window, once it is real.
  const streakGeometry = new THREE.PlaneGeometry(1, 0.035);
  streakGeometry.translate(-0.5, 0, 0);
  const streakMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  streakMaterial.colorNode = vec3(0.9, 0.95, 1).mul(pow(float(1).sub(uv().x), 3).mul(4));
  const streaks = [
    { from: new THREE.Vector3(-3.5, -1.2, ROOM.far - 6), way: new THREE.Vector3(1, -0.35, 0).normalize(), every: 11, phase: 0.35 },
    { from: new THREE.Vector3(3, -0.8, ROOM.far - 8), way: new THREE.Vector3(-1, -0.5, 0).normalize(), every: 17, phase: 0.8 }
  ].map((s) => {
    const mesh = new THREE.Mesh(streakGeometry, streakMaterial);
    mesh.rotation.z = Math.atan2(s.way.y, s.way.x);
    mesh.scale.setScalar(0);
    real.add(mesh);
    return { ...s, mesh };
  });

  // The galaxy's light in the room, out through the door and up the lower steps; short in reach, so it lights
  // nothing up in the street. It shifts slowly between violet and blue once real.
  const glow = new THREE.PointLight("#8a6cff", 5, 6.2, 2);
  glow.position.set(0, LANDING + 0.85, ROOM.far + 0.5);
  real.add(glow);
  const glowFrom = new THREE.Color("#8a6cff");
  const glowTo = new THREE.Color("#5f8dff");

  // A bare bulb hung on its flex just inside the doorway, its light falling out through the door and up the steps.
  // Once real a draught sets it swaying, and now and then it sputters.
  const ceiling = LANDING + th;
  const hang = new THREE.Group();
  hang.position.set(0.05, ceiling, z0 - 0.5);
  const FLEX = 0.5;
  const flexGeometry = new THREE.CylinderGeometry(0.004, 0.004, FLEX, 5);
  flexGeometry.translate(0, -FLEX / 2, 0);
  const holderGeometry = new THREE.CylinderGeometry(0.016, 0.019, 0.06, 10);
  holderGeometry.translate(0, -FLEX - 0.03, 0);
  const bulbGeometry = new THREE.SphereGeometry(0.032, 14, 10);
  bulbGeometry.scale(1, 1.25, 1);
  bulbGeometry.translate(0, -FLEX - 0.09, 0);
  const black = new THREE.MeshStandardNodeMaterial({ color: "#121110", roughness: 0.6 });
  const bulbColour = new THREE.Color("#ffd49a").multiplyScalar(6);
  const bulbMaterial = new THREE.MeshBasicNodeMaterial({ color: bulbColour.clone() });
  hang.add(new THREE.Mesh(flexGeometry, black), new THREE.Mesh(holderGeometry, black), new THREE.Mesh(bulbGeometry, bulbMaterial));
  // Short in reach as well: down here it lights the steps, the landing and the doorway, not the houses.
  const bulb = new THREE.PointLight("#ffc27e", 7, 5.4, 2);
  bulb.position.set(0, -FLEX - 0.12, 0);
  hang.add(bulb);
  real.add(hang);

  // Dust turning in the bulb's light at the doorway and over the lower steps.
  const dust = specks(110, [-0.9, 0.9, LANDING, LANDING + 2.2, z0 - 0.8, z0 + 2.2], new THREE.Color("#ffe2b8").multiplyScalar(1.6), 0.05);
  real.add(dust.mesh);

  // A scrap of paper on the landing, a little curled. The draught out of the room lifts it now and then and
  // skitters it a few centimetres across the concrete, back and forth.
  const paperGeometry = new THREE.PlaneGeometry(0.2, 0.14, 6, 1);
  {
    const p = paperGeometry.getAttribute("position");
    for (let i = 0; i < p.count; i++) p.setZ(i, 0.018 * Math.pow(p.getX(i) / 0.1, 2));
    paperGeometry.rotateX(-Math.PI / 2);
    paperGeometry.computeVertexNormals();
  }
  // A thin card, seen from either side.
  const paperMaterial = new THREE.MeshStandardNodeMaterial({ color: "#d8d2c2", roughness: 0.9, side: THREE.DoubleSide });
  const paper = new THREE.Mesh(paperGeometry, paperMaterial);
  paper.castShadow = paper.receiveShadow = true;
  const PAPER = new THREE.Vector3(0.32, LANDING + 0.004, z0 + 0.6);
  paper.position.copy(PAPER);
  paper.rotation.y = 0.5;
  real.add(paper);

  // Black iron handrails down both walls, each one piece: a newel post on the sidewalk at the top, a short level run
  // at knee height (so their chalk lands on the sidewalk close past the drawing), a rounded bend into the stairs'
  // pitch, two balusters to every tread, and at the foot a bend back to level and a rounded return down to the
  // landing.
  const iron = new THREE.MeshStandardNodeMaterial({ color: "#151515", roughness: 0.45, metalness: 0.6 });
  const railParts: THREE.BufferGeometry[] = [];
  const pitch = RISE / TREAD;
  const RAIL = 0.86;
  const KNEE = 0.62;
  const pitchY = (z: number) => RAIL + (z - z1) * pitch;
  const newelZ = z1 + 0.16;
  const meet = z1 - (RAIL - KNEE) / pitch;
  const low = LANDING + RAIL;
  const endZ = z0 + 0.16;
  const railXs = [x0 + 0.19, x1 - 0.19];
  railXs.forEach((x) => {
    const at = (yy: number, zz: number) => new THREE.Vector3(x, yy, zz);
    const path = new THREE.CurvePath<THREE.Vector3>();
    path.add(new THREE.LineCurve3(at(KNEE, newelZ), at(KNEE, meet + 0.22)));
    path.add(new THREE.QuadraticBezierCurve3(at(KNEE, meet + 0.22), at(KNEE, meet), at(pitchY(meet - 0.22), meet - 0.22)));
    path.add(new THREE.LineCurve3(at(pitchY(meet - 0.22), meet - 0.22), at(pitchY(landingFront + 0.22), landingFront + 0.22)));
    path.add(new THREE.QuadraticBezierCurve3(at(pitchY(landingFront + 0.22), landingFront + 0.22), at(low, landingFront), at(low, landingFront - 0.16)));
    path.add(new THREE.LineCurve3(at(low, landingFront - 0.16), at(low, endZ + 0.12)));
    path.add(new THREE.QuadraticBezierCurve3(at(low, endZ + 0.12), at(low, endZ), at(low - 0.12, endZ)));
    path.add(new THREE.LineCurve3(at(low - 0.12, endZ), at(LANDING + 0.005, endZ)));
    railParts.push(new THREE.TubeGeometry(path, 260, 0.024, 10));
    // The rail's height over a point along it (its run down the stairs, not the return), for the balusters.
    const along = path.getSpacedPoints(800).filter((p) => p.z > endZ + 0.05);
    const railAt = (zz: number) => along.reduce((best, p) => (Math.abs(p.z - zz) < Math.abs(best.z - zz) ? p : best), along[0]).y;
    // The newel post: a flange on the sidewalk, the post, a ball on top that the rail runs out of.
    const newel = new THREE.CylinderGeometry(0.03, 0.032, KNEE, 12);
    newel.translate(x, KNEE / 2, newelZ);
    const flange = new THREE.CylinderGeometry(0.055, 0.06, 0.02, 16);
    flange.translate(x, 0.01, newelZ);
    const ball = new THREE.SphereGeometry(0.042, 16, 12);
    ball.translate(x, KNEE + 0.01, newelZ);
    railParts.push(newel, flange, ball);
    // Balusters, each from a collar on its tread up into the rail.
    const baluster = (zz: number, floor: number) => {
      const h = railAt(zz) - floor;
      const g = new THREE.CylinderGeometry(0.011, 0.011, h, 8);
      g.translate(x, floor + h / 2, zz);
      const collar = new THREE.CylinderGeometry(0.018, 0.021, 0.025, 10);
      collar.translate(x, floor + 0.0125, zz);
      railParts.push(g, collar);
    };
    for (let i = 0; i < COUNT; i++) [0.09, 0.27].forEach((back) => baluster(z1 - TREAD * i - back, -RISE * i));
    baluster(landingFront - 0.14, LANDING);
  });
  const railGeometry = mergeWith(railParts, []);
  const rail = new THREE.Mesh(railGeometry, iron);
  rail.castShadow = rail.receiveShadow = true;
  real.add(rail);
  const frame = new THREE.Mesh(frameGeometry, iron);
  real.add(frame);

  // Stardust: once real, motes of the galaxy's light drift in at the window, out through the door, up the stairs
  // and out of the opening into the street air, spreading and fading as they rise. Each is wherever its own clock puts
  // it along the way, so it runs as well backwards.
  const route = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, LANDING + 0.7, ROOM.far + 0.2),
    new THREE.Vector3(0, LANDING + 0.8, z0 - 0.2),
    new THREE.Vector3(0, LANDING + 1.1, landingFront + 0.6),
    new THREE.Vector3(0, -0.5, z1 - 2.2),
    new THREE.Vector3(0, 0.35, z1 - 0.4),
    new THREE.Vector3(-0.3, 1.6, z1 - 0.2),
    new THREE.Vector3(-0.6, 3.6, z1 - 0.8)
  ]);
  const MOTES = 110;
  const moteGeometry = new THREE.SphereGeometry(1, 6, 4);
  const moteMaterial = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(3) });
  const motes = new THREE.InstancedMesh(moteGeometry, moteMaterial, MOTES);
  const moteSeeds = Array.from({ length: MOTES }, (_, i) => {
    const r = (n: number) => {
      const v = Math.sin(i * 37.9 + n * 11.3) * 43758.5453;
      return v - Math.floor(v);
    };
    motes.setColorAt(i, new THREE.Color().setHSL(0.62 + r(1) * 0.2, 0.75, 0.6 + r(2) * 0.3));
    return { phase: r(3), speed: 0.03 + r(4) * 0.03, side: new THREE.Vector3(r(5) - 0.5, r(6) - 0.5, r(7) - 0.5), size: 0.006 + Math.pow(r(8), 3) * 0.014, wander: r(9) * 6.28 };
  });
  const moteMatrix = new THREE.Matrix4();
  const moteAt = new THREE.Vector3();
  const placeMotes = (go: number, wake: number) => {
    moteSeeds.forEach((m, i) => {
      const f = (m.phase + go * m.speed) % 1;
      route.getPointAt(f, moteAt);
      // Kept within the stairway below the paving; spreading out once they are up in the open.
      const spreadOut = 0.35 + 2.2 * THREE.MathUtils.smoothstep(f, 0.7, 1);
      moteAt.addScaledVector(m.side, spreadOut);
      moteAt.x += Math.sin(go * 0.8 + m.wander) * 0.08;
      moteAt.y += Math.sin(go * 0.6 + m.wander * 1.3) * 0.06;
      const size = m.size * wake * Math.sqrt(Math.sin(Math.PI * f));
      motes.setMatrixAt(i, moteMatrix.makeScale(size, size, size).setPosition(moteAt));
    });
    motes.instanceMatrix.needsUpdate = true;
  };
  placeMotes(0, 0);
  real.add(motes);

  // And its light thrown up out of the opening onto the paving and the trees, flickering: dark until it is real.
  const spill = new THREE.PointLight("#8a6cff", 0, 7.5, 2);
  spill.position.set(-0.4, 0.9, (z0 + z1) / 2 + 0.6);
  real.add(spill);

  // As far as the view's air and focus go, everything seen down through the opening is at the ground, as its chalk is.
  const cap = nearDepth(edge);
  real.add(cap.mesh);

  const shade = shadeFor(edge);
  const extent = [...edge, ...railXs.flatMap((x) => [new THREE.Vector3(x, KNEE + 0.055, newelZ), new THREE.Vector3(x, KNEE + 0.03, meet + 0.22)])];
  const paperAt = new THREE.Vector3();
  return {
    real,
    shade: shade.mesh,
    edge,
    extent,
    covers: footprint(extent),
    inside: insideRect(x0, x1, z0, z1, r),
    animate: (t) => {
      // Once real: the galaxy turns, its stars twinkle and now and then one shoots across, its light in the room
      // shifts, the bulb sways in the draught and sputters, dust turns in the light, and the paper skitters.
      const wake = wakeAt(t);
      const go = wokenFor(t);
      time.value = go;
      wakeU.value = wake;
      const shift = 0.5 + 0.5 * Math.sin(go * 0.15);
      glow.color.copy(glowFrom).lerp(glowTo, shift * wake);
      glow.intensity = 5 * (1 + wake * 0.12 * Math.sin(go * 0.4 + 1));
      placeMotes(go, wake);
      spill.color.copy(glow.color);
      spill.intensity = wake * 2.4 * (1 + 0.25 * Math.sin(go * 7.3) * Math.sin(go * 2.9 + 1) + 0.12 * Math.sin(go * 0.4 + 1));
      streaks.forEach((s) => {
        const f = (go / s.every + s.phase) % 1;
        const flight = f * s.every;
        const on = flight < 0.9 && go > 1 ? wake : 0;
        s.mesh.position.copy(s.from).addScaledVector(s.way, flight * 9);
        s.mesh.scale.set(2.4 * on * Math.sin(Math.PI * Math.min(1, flight / 0.9)), on, on);
      });
      hang.rotation.set(wake * (0.09 * Math.sin(go * 1.2) + 0.03 * Math.sin(go * 3.1 + 1)), 0, wake * (0.06 * Math.sin(go * 0.9 + 2) + 0.02 * Math.sin(go * 2.6)));
      // The bulb's own sputter, rarer and shorter, on another rhythm.
      const blink = (t * 0.13 + 0.4) % 1;
      const flick = blink < 0.035 ? 0.5 + 0.5 * Math.sin(t * 71) : 0;
      const bright = 1 - wake * (0.03 * Math.sin(t * 3.3) + 0.75 * flick);
      bulb.intensity = 7 * bright;
      bulbMaterial.color.copy(bulbColour).multiplyScalar(Math.max(0.1, bright));
      dust.update(t, wake);
      // Every few seconds a gust: the paper lifts a little and slides, this way one time, back the next.
      const every = 6.5;
      const gust = go / every;
      const n = Math.floor(gust);
      const f = gust - n;
      const hop = THREE.MathUtils.smootherstep(f, 0, 0.35);
      const from = n % 2 ? 1 : 0;
      const slide = wake * (from + (1 - 2 * from) * hop);
      paper.position.copy(PAPER).add(paperAt.set(-0.12 * slide, 0.03 * Math.sin(Math.PI * Math.min(1, f / 0.35)) * wake * (f < 0.35 ? 1 : 0), 0.09 * slide));
      paper.rotation.set(0.25 * Math.sin(Math.PI * Math.min(1, f / 0.35)) * wake * (f < 0.35 ? 1 : 0), 0.5 + 0.5 * slide, 0);
    },
    geometries: [solid, sides, noseGeometry, stoneGeometry, roomGeometry, frameGeometry, spaceGeometry, galaxyGeometry, streakGeometry, moteGeometry, flexGeometry, holderGeometry, bulbGeometry, paperGeometry, railGeometry, dust.geometry, shade.geometry, cap.geometry],
    materials: [concrete, steel, granite, plaster, spaceMaterial, galaxyMaterial, streakMaterial, moteMaterial, black, bulbMaterial, paperMaterial, iron, dust.material, shade.material, cap.material]
  };
}

// Boxes and planes into one geometry: position, normal and uv only.
export function mergeBoxes(parts: THREE.BufferGeometry[]) {
  return mergeWith(parts, []);
}

// Geometries into one: position, normal and uv, and any `extra` attributes they all carry.
export function mergeWith(parts: THREE.BufferGeometry[], extra: string[]) {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const more: number[][] = extra.map(() => []);
  const index: number[] = [];
  let base = 0;
  parts.forEach((g) => {
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const u = g.getAttribute("uv");
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      normals.push(n.getX(i), n.getY(i), n.getZ(i));
      uvs.push(u.getX(i), u.getY(i));
    }
    extra.forEach((name, k) => {
      const a = g.getAttribute(name);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) more[k].push(a.getComponent(i, c));
    });
    if (g.index) for (let i = 0; i < g.index.count; i++) index.push(g.index.getX(i) + base);
    else for (let i = 0; i < p.count; i++) index.push(i + base);
    base += p.count;
    g.dispose();
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  extra.forEach((name, k) => merged.setAttribute(name, new THREE.Float32BufferAttribute(more[k], parts[0].getAttribute(name).itemSize)));
  merged.setIndex(index);
  return merged;
}
