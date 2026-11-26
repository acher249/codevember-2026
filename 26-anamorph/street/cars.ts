import * as THREE from "three/webgpu";
import { abs, atan, attribute, cameraPosition, dot, float, fract, length, mix, normalWorld, positionGeometry, positionWorld, pow, reflect, smoothstep, step, uv, vec3 } from "three/tsl";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model swizzles. */

// The cars parked along the block: a sedan, a hatchback, an SUV and a van, each built once from its side profile and
// drawn as one instanced mesh, so a street of them is four draws. Every part of a car (paint, glass, rubber, chrome,
// lamps, plates) is in the one geometry, told apart by a `part` attribute, and each car's paint is its own instance
// attribute. With no environment map in the street, the glass and paint reflect a made-up one: the road below, the
// houses and trees along the horizon, and the sky.

const PART = { paint: 0, glass: 1, black: 2, tyre: 3, rim: 4, plate: 7 };

type Kind = {
  // Length, width, the wheels' radius, the axles' distance either side of the middle and how far the body sits up.
  length: number;
  width: number;
  wheel: number;
  axle: number;
  clearance: number;
  // The body's side profile, as [x, y] from the back bumper (-x) along the top to the front (+x), above the sills.
  top: [number, number][];
  // The glasshouse over it, from the back of the base round to the front of the base.
  cabin: [number, number][];
  // A van's sides are panels behind its front doors, not glass.
  panelled?: boolean;
};

const KINDS: Record<"sedan" | "hatch" | "suv" | "van", Kind> = {
  sedan: {
    length: 4.7,
    width: 1.8,
    wheel: 0.32,
    axle: 1.38,
    clearance: 0.2,
    top: [
      [-2.35, 0.48],
      [-2.33, 0.78],
      [-2.18, 0.9],
      [-1.3, 0.94],
      [0.95, 0.91],
      [2.05, 0.8],
      [2.32, 0.7],
      [2.36, 0.5]
    ],
    cabin: [
      [-1.55, 0.9],
      [-0.85, 1.4],
      [0.1, 1.42],
      [1.0, 0.88]
    ]
  },
  hatch: {
    length: 4.1,
    width: 1.76,
    wheel: 0.31,
    axle: 1.28,
    clearance: 0.19,
    top: [
      [-2.05, 0.46],
      [-2.07, 0.9],
      [-1.95, 0.97],
      [0.8, 0.92],
      [1.8, 0.8],
      [2.04, 0.68],
      [2.06, 0.48]
    ],
    cabin: [
      [-2.0, 0.94],
      [-1.7, 1.44],
      [-0.05, 1.47],
      [0.83, 0.89]
    ]
  },
  suv: {
    length: 4.75,
    width: 1.9,
    wheel: 0.37,
    axle: 1.45,
    clearance: 0.3,
    top: [
      [-2.37, 0.58],
      [-2.38, 1.08],
      [-2.25, 1.12],
      [1.1, 1.08],
      [2.15, 0.98],
      [2.36, 0.85],
      [2.38, 0.6]
    ],
    cabin: [
      [-2.3, 1.1],
      [-2.12, 1.7],
      [0.35, 1.74],
      [1.15, 1.05]
    ]
  },
  van: {
    length: 5.1,
    width: 1.95,
    wheel: 0.34,
    axle: 1.62,
    clearance: 0.24,
    top: [
      [-2.55, 0.52],
      [-2.55, 1.12],
      [1.55, 1.12],
      [2.25, 0.98],
      [2.52, 0.82],
      [2.55, 0.55]
    ],
    cabin: [
      [-2.55, 1.1],
      [-2.53, 2.02],
      [0.95, 2.0],
      [1.6, 1.1]
    ],
    panelled: true
  }
};

// Paint as it is on a street of parked cars: mostly silver, grey, black and white, a few colours, one yellow cab.
const PAINTS = ["#8d9298", "#3a3e44", "#0f1113", "#c9cac6", "#1d2a44", "#5a1517", "#8f8166", "#22352a", "#6d7f93", "#b7b9b6", "#2c2d30", "#d39d12"];

// Gathers parts into one geometry with a part number on every vertex.
class Parts {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  parts: number[] = [];
  add(geometry: THREE.BufferGeometry, part: number | ((normal: THREE.Vector3, at: THREE.Vector3) => number), matrix?: THREE.Matrix4) {
    const g = (geometry.index ? geometry.toNonIndexed() : geometry.clone()) as THREE.BufferGeometry;
    if (matrix) g.applyMatrix4(matrix);
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const u = g.getAttribute("uv");
    const normal = new THREE.Vector3();
    const at = new THREE.Vector3();
    // A part for each triangle at once, by its first corner, so no triangle is split between two.
    for (let i = 0; i < p.count; i += 3) {
      normal.fromBufferAttribute(n, i);
      at.fromBufferAttribute(p, i);
      const k = typeof part === "number" ? part : part(normal, at);
      for (let j = i; j < i + 3; j++) {
        this.positions.push(p.getX(j), p.getY(j), p.getZ(j));
        this.normals.push(n.getX(j), n.getY(j), n.getZ(j));
        this.uvs.push(u ? u.getX(j) : 0, u ? u.getY(j) : 0);
        this.parts.push(k);
      }
    }
    g.dispose();
  }
  box(w: number, h: number, d: number, x: number, y: number, z: number, part: number) {
    const g = new THREE.BoxGeometry(w, h, d);
    this.add(g, part, new THREE.Matrix4().makeTranslation(x, y, z));
    g.dispose();
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute("part", new THREE.Float32BufferAttribute(this.parts, 1));
    return g;
  }
}

// A shape pushed out across the car's width (z), centred on it, its long edges rounded by a bevel; then narrowed toward
// the bumpers and toward the top, as a car is rounder in plan and leans its sides in; and shaded smooth across its
// bevels and curves, so its edges read round rather than cut, but kept sharp where the profile turns a real corner
// (smoothing over those, a big flat side's normals were pulled round past square to the faces beside it).
function pushed(shape: THREE.Shape, width: number, bevel: number, pinch: { length: number; ends: number; top?: [number, number, number] }) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 4, steps: 1, curveSegments: 6 });
  g.deleteAttribute("uv");
  g.translate(0, 0, -(width - bevel * 2) / 2);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const [x, y, z] = [p.getX(i), p.getY(i), p.getZ(i)];
    const end = THREE.MathUtils.smoothstep(Math.abs(x) / (pinch.length / 2), 0.72, 1.02);
    let squeeze = 1 - end * end * pinch.ends;
    if (pinch.top) squeeze *= 1 - THREE.MathUtils.smoothstep(y, pinch.top[0], pinch.top[1]) * pinch.top[2];
    p.setZ(i, z * squeeze);
  }
  const shaded = toCreasedNormals(g, THREE.MathUtils.degToRad(40));
  g.dispose();
  return shaded;
}

// A curve through the points of a profile, for the gentle crown of a hood or a roof.
// Centripetal, so it never overshoots a tight corner into a little loop (pushed out by the bevel, a loop folds the
// body inside out there: the crease that was at an SUV's back corner).
const smooth = (points: [number, number][], n: number) => new THREE.CatmullRomCurve3(points.map(([x, y]) => new THREE.Vector3(x, y, 0)), false, "centripetal").getPoints(n);

// One kind of car, built facing +x with its wheels on the ground (y = 0), across z.
function carGeometry(kind: Kind) {
  const parts = new Parts();
  const { length: L, width: W, wheel: R, axle: A, clearance: C } = kind;
  const half = L / 2;
  const arch = R + 0.07;

  // The body: from the sills up, its wheel arches cut out of the bottom edge.
  const body = new THREE.Shape();
  const bottom = C + 0.06;
  body.moveTo(kind.top[0][0], bottom + 0.06);
  [-A, A].forEach((ax) => {
    body.lineTo(ax - arch - 0.02, bottom);
    for (let s = 0; s <= 10; s++) {
      const a = Math.PI - (s / 10) * Math.PI;
      body.lineTo(ax + Math.cos(a) * arch, R + Math.sin(a) * arch * 0.92);
    }
    body.lineTo(ax + arch + 0.02, bottom);
  });
  const front = kind.top[kind.top.length - 1];
  body.lineTo(front[0] - 0.04, bottom + 0.04);
  smooth([...kind.top].reverse(), 40).forEach((q) => body.lineTo(q.x, q.y));
  const bodyGeometry = pushed(body, W, 0.12, { length: L, ends: 0.1, top: [kind.top[2][1] - 0.3, kind.top[2][1], 0.06] });
  // Its underside and the insides of the arches dark; the rest paint.
  parts.add(bodyGeometry, (n) => (n.y < -0.35 ? PART.black : PART.paint));
  bodyGeometry.dispose();

  // The glasshouse: glass all round, the roof and the pillars at its corners (its bevels) in paint.
  // (The roof crowned a little between its corners, the glass curving into it.)
  const cabin = new THREE.Shape();
  const [c0, c1, c2, c3] = kind.cabin;
  const crown: [number, number] = [(c1[0] + c2[0]) / 2, Math.max(c1[1], c2[1]) + 0.03];
  cabin.moveTo(c0[0], c0[1]);
  smooth([c0, [c0[0] * 0.35 + c1[0] * 0.65, c0[1] * 0.3 + c1[1] * 0.7 + 0.015], c1, crown, c2, [c3[0] * 0.4 + c2[0] * 0.6, c3[1] * 0.4 + c2[1] * 0.6 + 0.02], c3], 32).forEach((q) => cabin.lineTo(q.x, q.y));
  const belt = Math.min(...kind.cabin.map(([, y]) => y));
  const roof = crown[1];
  const cabinGeometry = pushed(cabin, W - 0.1, 0.07, { length: L, ends: 0.06, top: [belt, roof, 0.22] });
  cabinGeometry.translate(0, -0.01, 0);
  const front0 = kind.cabin[kind.cabin.length - 1][0];
  parts.add(cabinGeometry, (n, at) => {
    if (n.y > 0.9) return PART.paint;
    const side = Math.abs(n.z);
    if (side > 0.3 && side < 0.9) return PART.paint;
    if (kind.panelled && side >= 0.9 && at.x < front0 - 0.95) return PART.paint;
    return PART.glass;
  });
  cabinGeometry.dispose();
  // The pillars between the doors' windows, and the trim along the bottom of the windows, black.
  const midY = (belt + roof) / 2;
  const pillarAt = kind.panelled ? [front0 - 0.95] : [(kind.cabin[1][0] + kind.cabin[2][0]) / 2 + 0.15];
  // (Leaning in with the glass: its sides come in by 22% from the belt to the roof.)
  const lean = Math.atan(((W - 0.1) / 2) * 0.22 / (roof - belt));
  const pillar = new THREE.BoxGeometry(0.09, roof - belt - 0.08, 0.02);
  pillarAt.forEach((x) =>
    [-1, 1].forEach((s) => parts.add(pillar, PART.black, new THREE.Matrix4().makeRotationX(-s * lean).setPosition(x, midY - 0.02, s * (((W - 0.1) / 2) * (1 - 0.11) + 0.01))))
  );
  pillar.dispose();
  [-1, 1].forEach((s) => parts.box(front0 - kind.cabin[0][0] - 0.25, 0.035, 0.02, (kind.cabin[0][0] + front0) / 2, belt + 0.03, s * ((W / 2) * 0.96 + 0.005), PART.black));

  // Bumpers, front and back, a shade proud of the body, dark grey plastic low and paint above.
  const lowBumper = (x: number, way: number) => {
    parts.box(0.2, 0.13, W - 0.12, x, C + 0.14, 0, PART.black);
    parts.box(0.18, 0.1, W - 0.16, x, C + 0.25, 0, PART.paint);
    // A plate on it, and a grille above it at the front.
    parts.box(0.02, 0.11, 0.31, x + way * 0.11, C + 0.3, 0, PART.plate);
  };
  lowBumper(half, 1);
  lowBumper(-half, -1);
  const nose = kind.top[kind.top.length - 2];
  const tailTop = kind.top[1];
  parts.box(0.05, 0.14, W * 0.42, nose[0] + 0.04, (nose[1] + C + 0.3) / 2 + 0.03, 0, PART.black);
  // The lamps are drawn flush on the body's paint (see the material), from where they sit on this kind: half its
  // length, the tail lamps' and the headlamps' height, and half its width, on every corner.
  const lamps = [half, tailTop[1] - 0.12, nose[1] - 0.07, W / 2];
  // Mirrors on the doors at the foot of the windscreen.
  const screen = kind.cabin[kind.cabin.length - 1];
  [-1, 1].forEach((s) => {
    parts.box(0.12, 0.11, 0.17, screen[0] - 0.25, belt + 0.1, s * (W / 2 + 0.06), PART.paint);
    parts.box(0.02, 0.09, 0.14, screen[0] - 0.19, belt + 0.1, s * (W / 2 + 0.06), PART.black);
  });
  // Door handles.
  const handles = kind.panelled ? [front0 - 0.55] : [front0 - 0.6, front0 - 1.55];
  handles.forEach((x) => [-1, 1].forEach((s) => parts.box(0.16, 0.03, 0.03, x, belt - 0.1, s * (W / 2 - 0.005), PART.black)));
  // The wheel wells, dark, so the arches are not holes through the car.
  [-A, A].forEach((ax) => parts.box(arch * 2, arch, W - 0.5, ax, R + arch * 0.45, 0, PART.black));

  // The wheels: a tyre, a rim on its outer face (its spokes are drawn on it), each side.
  const tyre = new THREE.CylinderGeometry(R, R, 0.21, 20, 1, true);
  tyre.rotateX(Math.PI / 2);
  const sidewall = new THREE.RingGeometry(R * 0.66, R, 20, 1);
  const rim = new THREE.CircleGeometry(R * 0.68, 20);
  [-A, A].forEach((ax) =>
    [-1, 1].forEach((s) => {
      const z = s * (W / 2 - 0.16);
      parts.add(tyre, PART.tyre, new THREE.Matrix4().makeTranslation(ax, R, z));
      // Facing out on either side (the ring and the disc face +z as made).
      const out = new THREE.Matrix4().makeRotationY(s > 0 ? 0 : Math.PI).setPosition(ax, R, z + s * 0.105);
      parts.add(sidewall, PART.tyre, out);
      parts.add(rim, PART.rim, new THREE.Matrix4().makeRotationY(s > 0 ? 0 : Math.PI).setPosition(ax, R, z + s * 0.09));
    })
  );
  tyre.dispose();
  sidewall.dispose();
  rim.dispose();
  const geometry = parts.build();
  const form = new Float32Array(parts.parts.length * 4);
  for (let i = 0; i < parts.parts.length; i++) form.set(lamps, i * 4);
  geometry.setAttribute("form", new THREE.Float32BufferAttribute(form, 4));
  return geometry;
}

// The world as the cars' glass and paint see it in reflection: the road under them, the houses and the trees along the
// horizon, the sky above, brightest toward the low sun.
export function streetReflection(normal: any, sunWay: any) {
  const view = positionWorld.sub(cameraPosition).normalize();
  const r: any = reflect(view, normal);
  const sky = mix(vec3(0.78, 0.82, 0.84), vec3(0.4, 0.56, 0.78), smoothstep(0.25, 0.8, r.y)).add(vec3(1, 0.85, 0.6).mul(smoothstep(0.7, 1, dot(r, sunWay)).mul(0.8)));
  const horizon = mix(vec3(0.07, 0.065, 0.06), vec3(0.12, 0.14, 0.09), smoothstep(0.08, 0.25, r.y));
  const env = mix(mix(vec3(0.05, 0.05, 0.05), horizon, smoothstep(-0.06, 0.0, r.y)), sky, smoothstep(0.22, 0.42, r.y));
  const facing = dot(view.negate(), normal).clamp(0, 1);
  const fresnel = pow(float(1).sub(facing), 5);
  return { env, fresnel };
}

export function buildCars(places: { x: number; z: number; turn: number; seed: number }[], y: number, sunWay: THREE.Vector3) {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.4 });
  const part = attribute("part", "float");
  const paint = attribute("paint", "vec3");
  const is = (k: number) => float(1).sub(step(0.5, abs(part.sub(k))));
  // The rim's spokes and the dark between them, by the angle round its middle (its uv is 0 to 1 across it).
  const fromHub = uv().sub(0.5);
  const spokes = smoothstep(0.25, 0.45, abs(fract(atan(fromHub.y, fromHub.x).mul(5 / (Math.PI * 2))).sub(0.5))).mul(step(0.16, length(fromHub))).mul(step(length(fromHub), 0.43));
  const rimColour = mix(vec3(0.55, 0.56, 0.57), vec3(0.03), spokes);
  // The lamps, flush in the paint at the corners: a band at the back (wrapping round onto the sides) and at the front.
  const form = attribute("form", "vec4");
  const g = positionGeometry;
  const across = abs(g.z);
  const tailLamp = step(g.x, form.x.negate().add(0.1)).mul(step(abs(g.y.sub(form.y)), 0.04)).mul(step(form.w.sub(0.42), across));
  const headLamp = step(form.x.sub(0.15), g.x).mul(step(abs(g.y.sub(form.z)), 0.045)).mul(step(form.w.sub(0.48), across)).mul(step(across, form.w.sub(0.05)));
  const isHead = is(PART.paint).mul(headLamp);
  const isTail = is(PART.paint).mul(tailLamp).mul(float(1).sub(headLamp));
  const isPaint = is(PART.paint).sub(isHead).sub(isTail);
  let colour: any = paint.mul(isPaint);
  colour = colour.add(vec3(0.015, 0.018, 0.02).mul(is(PART.glass)));
  colour = colour.add(vec3(0.025).mul(is(PART.black)));
  colour = colour.add(vec3(0.02).mul(is(PART.tyre)));
  colour = colour.add(rimColour.mul(is(PART.rim)));
  colour = colour.add(vec3(0.55, 0.56, 0.55).mul(isHead));
  colour = colour.add(vec3(0.32, 0.015, 0.015).mul(isTail));
  colour = colour.add(vec3(0.8, 0.76, 0.55).mul(is(PART.plate)));
  material.colorNode = colour;
  material.roughnessNode = float(0.32).mul(isPaint).add(float(0.06).mul(is(PART.glass))).add(float(0.75).mul(is(PART.black))).add(float(0.92).mul(is(PART.tyre))).add(float(0.35).mul(is(PART.rim))).add(float(0.15).mul(isHead.add(isTail))).add(float(0.6).mul(is(PART.plate)));
  material.metalnessNode = float(0.75).mul(is(PART.rim)).mul(float(1).sub(spokes));
  // The made-up world in the glass (strongly, more so at a glance) and in the clear coat of the paint and lamps.
  const { env, fresnel } = streetReflection(normalWorld, vec3(sunWay.x, sunWay.y, sunWay.z));
  const shine = is(PART.glass).mul(fresnel.mul(0.75).add(0.18)).add(is(PART.paint).mul(fresnel.mul(0.6).add(0.025)));
  material.emissiveNode = env.mul(shine);

  const byKind = new Map<keyof typeof KINDS, typeof places>();
  const names = Object.keys(KINDS) as (keyof typeof KINDS)[];
  places.forEach((place) => {
    // Mostly sedans and hatchbacks, a fair few SUVs, the odd van.
    const r = rand(place.seed, 1);
    const kind = r < 0.38 ? "sedan" : r < 0.62 ? "hatch" : r < 0.88 ? "suv" : "van";
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(place);
  });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const tone = new THREE.Color();
  names.forEach((name) => {
    const list = byKind.get(name);
    if (!list?.length) return;
    const geometry = carGeometry(KINDS[name]);
    const paints = new Float32Array(list.length * 3);
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    list.forEach(({ x, z, turn, seed }, i) => {
      // Parked a little crooked, some nearer the curb than others.
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn + (rand(seed, 2) - 0.5) * 0.04);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(i, m);
      // The odd cab, and only as a sedan.
      let pick = Math.floor(rand(seed, 3) * PAINTS.length);
      if (PAINTS[pick] === "#d39d12" && name !== "sedan") pick = 0;
      tone.set(PAINTS[pick]);
      paints.set([tone.r, tone.g, tone.b], i * 3);
    });
    geometry.setAttribute("paint", new THREE.InstancedBufferAttribute(paints, 3));
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    geometries.push(geometry);
  });
  return { group, geometries, materials: [material] };
}

const rand = (i: number, n: number) => {
  const v = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
  return v - Math.floor(v);
};
