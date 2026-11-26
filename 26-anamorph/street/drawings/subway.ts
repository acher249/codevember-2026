/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { abs, atan, cameraFar, cameraNear, cameraPosition, clamp, dot, exp, float, floor, fract, fwidth, length, min, mix, normalLocal, normalWorld, normalize, normalView, positionLocal, positionView, positionWorld, pow, round, sin, smoothstep, step, texture, uniform, uv, vec2, vec3, viewZToPerspectiveDepth } from "three/tsl";
import { sound } from "../../../shared/engine/sound";
import { type Drawing, EYE, type Scans, footprint, SLAB, shadeFor, wakeAt, walls, wobble } from "../drawings";

// A hole broken through the sidewalk looks down into a subway station just under the street, across the tracks: the
// platform's edge with its yellow strip, the track bed below, and the old tiled wall beyond. Lit only by its own
// fluorescent tubes, painted into every surface's colour by one shared lighting function (so it costs no scene
// lights). Once real the lamps in the platform's edge start blinking, a train's headlights sweep along the far wall,
// and an original stainless steel train rushes through under the hole and away, the tubes flickering. It comes round
// again every half minute.
// Metres; the sidewalk at y = 0, the tracks running across it along x, the train coming from -x.

// Textures this drawing loads for itself, by name: given to `build` once loaded. `colour` for colour maps.
export const textures: Record<string, { url: string; colour?: boolean }> = {
  tiles: { url: "/assets/26-anamorph/subway/long_white_tiles_diff_2k.jpg", colour: true },
  tilesNormal: { url: "/assets/26-anamorph/subway/long_white_tiles_nor_gl_2k.jpg" },
  gravel: { url: "/assets/26-anamorph/subway/tarred_gravel_diff_2k.jpg", colour: true },
  gravelNormal: { url: "/assets/26-anamorph/subway/tarred_gravel_nor_gl_2k.jpg" }
};

// The hole: a broken-edged near-rectangle (a superellipse, ragged), long down the sidewalk.
const HOLE = { z: -2.2, a: 1.45, b: 2.5, n: 5 };
const ragged = (a: number) => 1 + 0.022 * Math.sin(5 * a + 1) + 0.016 * Math.sin(11 * a + 2) + 0.01 * Math.sin(23 * a + 0.5) + 0.006 * Math.sin(47 * a + 1.3);
// Whether a point on the ground (TSL, world xz) is inside the hole: the same broken superellipse as the edge.
const inHole = (at: any) => {
  const d = at.sub(vec2(0, HOLE.z));
  const a = atan(d.y, d.x);
  const shape = pow(pow(abs(a.cos()).div(HOLE.a), HOLE.n).add(pow(abs(a.sin()).div(HOLE.b), HOLE.n)), -1 / HOLE.n);
  const rough = sin(a.mul(5).add(1)).mul(0.022).add(sin(a.mul(11).add(2)).mul(0.016)).add(sin(a.mul(23).add(0.5)).mul(0.01)).add(sin(a.mul(47).add(1.3)).mul(0.006)).add(1);
  return step(length(d), shape.mul(rough));
};
// The street's sun (as index.tsx has it): where it comes from, and what it gives a white surface square on to it.
const SUN = new THREE.Vector3(-0.3, 0.45, -1).normalize();
const SUNLIGHT = new THREE.Color("#ffe2b8").multiplyScalar(0.95);
const reach = (a: number) => Math.pow(Math.pow(Math.abs(Math.cos(a)) / HOLE.a, HOLE.n) + Math.pow(Math.abs(Math.sin(a)) / HOLE.b, HOLE.n), -1 / HOLE.n) * ragged(a);

// The street's structure is SHAFT thick, the station's ceiling under it. Across the view (z), from the near side: the
// tiled wall behind the express track (under the sidewalk, out of the artist's sight), the express track, the local
// track, the platform from its EDGE to the tiled BACK wall. Along it (x): the station to ±ENDS, tunnels beyond to ±DEEP.
const SHAFT = 0.36;
const CEIL = -SHAFT;
const BED = -5.6;
const RAIL = BED + 0.3;
const PLATFORM = -4.4;
const NEARWALL = 4;
const EXPRESS = -6.0;
const TRACK = -13.8;
const EDGE = -15.4;
const BACK = -18.3;
const ENDS = 45;
const DEEP = 180;
const MOUTH = -1.2;
// The tunnels' sides (z) for each track.
const LOCAL_BORE = [EDGE, TRACK + 1.9];
const EXPRESS_BORE = [EXPRESS - 1.6, EXPRESS + 1.6];
// Fluorescent tubes in rows flush in the ceiling, every GAP metres.
const ROWS = [TRACK + 0.5, -16.9, EXPRESS];
// (The express track's row is half dead: it lies dim under the street.)
const ROW_LEVEL = [1, 1, 0.6];
const GAP = 4.2;
const TUBE = { half: 0.6, y: CEIL - 0.04 };
// Lamps set in the platform's edge facing the track, and caged bulbs down the tunnels.
const EDGE_LAMP = { y: PLATFORM - 0.18, gap: 1.6 };
const BULB = { y: -2.6, gap: 12, z: EDGE + 0.12 };
// Columns down the platform, from the first one every `gap`.
const PILLARS = -16.9;
const COLUMN = { first: -ENDS + 2.3, gap: 4.6 };
// The station's name in mosaic tablets set in the walls above the band, centred `at` and then every `gap`; it is
// lettered too on black enamel signs on every other column, and on the train's amber signs.
const NAME = "CHALK ST";
const TABLET = { at: 1.0, gap: 13.8, half: 1.8, y0: -3.3, y1: -2.5 };
const COLUMN_SIGN = { half: 0.4, y0: -2.78, y1: -2.52 };
// The signals at the far end of the station, past the platform where the tunnels begin, facing the trains coming
// on: a green, a yellow and a red lens, top to bottom, `pitch` apart about `y`.
const SIGNAL = { x: ENDS + 2.5, y: BED + 2.7, pitch: 0.3, local: TRACK + 1.8, express: EXPRESS + 1.35 };

// The train: five cars, each LEN long with a short gap, nose at the group's origin, the body back along its -z.
const CARS = 5;
const LEN = 17.6;
const PITCH = 18.4;
const HALF = 1.27;
const DOORS = [2.4, 6.6, 11.0, 15.2];
const TRAIN = CARS * PITCH - (PITCH - LEN);
// When it comes: first a moment after it turns real, then every `every` seconds, from `from` (out of sight in the
// tunnel) to `to` (gone into the other) at `speed`.
const RUN = { start: 1.0, every: 30, from: -80, to: 160, speed: 18 };

// Where the train's nose is at a time, whether it is running, and how far into its run.
function trainAt(t: number) {
  if (t < RUN.start) return { nose: RUN.from, running: false, s: 0 };
  const pass = Math.floor((t - RUN.start) / RUN.every);
  const s = t - RUN.start - pass * RUN.every;
  const along = s * RUN.speed;
  if (along > RUN.to - RUN.from) return { nose: RUN.from, running: false, s };
  return { nose: RUN.from + along, running: true, s };
}

// The station's name drawn once on a canvas, in three strips: the top half the mosaic tablet (a maroon edge, an ochre
// border of little diamonds, the name dark on cream), then the column signs' white on black under a thin white line,
// then the train's amber destination sign. Kept for every build after (it is the same each time).
let lettering: THREE.CanvasTexture | null = null;
function letteringTexture() {
  if (lettering) return lettering;
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#6e2418";
  c.fillRect(0, 0, 1024, 256);
  c.fillStyle = "#b8893c";
  c.fillRect(12, 12, 1000, 232);
  c.fillStyle = "#6e2418";
  for (let x = 24; x < 1000; x += 24)
    [24, 232].forEach((y) => {
      c.beginPath();
      c.moveTo(x, y - 8);
      c.lineTo(x + 8, y);
      c.lineTo(x, y + 8);
      c.lineTo(x - 8, y);
      c.fill();
    });
  c.fillStyle = "#e9e1c9";
  c.fillRect(44, 44, 936, 168);
  c.fillStyle = "#1d2a3a";
  c.font = "bold 128px Georgia, 'Times New Roman', serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(NAME, 512, 134, 880);
  c.fillStyle = "#0c0c0c";
  c.fillRect(0, 256, 1024, 128);
  c.fillStyle = "#f2f2ee";
  c.fillRect(0, 268, 1024, 5);
  c.font = "bold 74px Helvetica, Arial, sans-serif";
  c.fillText(NAME.replace(/\B\w+/g, (w) => w.toLowerCase()), 512, 330, 900);
  c.fillStyle = "#000000";
  c.fillRect(0, 384, 1024, 128);
  c.fillStyle = "#ffb12e";
  c.font = "bold 92px 'Courier New', monospace";
  c.fillText(NAME, 512, 450, 960);
  lettering = new THREE.CanvasTexture(canvas);
  lettering.colorSpace = THREE.SRGBColorSpace;
  lettering.generateMipmaps = false;
  lettering.minFilter = THREE.LinearFilter;
  return lettering;
}

// A rail's cross-section (across, up) from its foot to its rounded head, the head's top at 0.
function railSection() {
  const s = new THREE.Shape();
  const half = [
    [0.07, -0.145],
    [0.07, -0.134],
    [0.012, -0.118],
    [0.009, -0.052],
    [0.036, -0.042],
    [0.036, -0.009],
    [0.029, 0]
  ];
  s.moveTo(-0.07, -0.145);
  half.forEach(([x, y]) => s.lineTo(x, y));
  half
    .slice()
    .reverse()
    .slice(0, -1)
    .forEach(([x, y]) => s.lineTo(-x, y));
  s.closePath();
  return s;
}

// Geometries into one (position, normal and uv), counted first and copied straight into typed arrays, then the parts
// let go.
function packed(parts: THREE.BufferGeometry[]) {
  let vertices = 0;
  let indices = 0;
  parts.forEach((g) => {
    vertices += g.getAttribute("position").count;
    indices += g.index ? g.index.count : g.getAttribute("position").count;
  });
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  let base = 0;
  let at = 0;
  parts.forEach((g) => {
    const count = g.getAttribute("position").count;
    position.set(g.getAttribute("position").array as Float32Array, base * 3);
    normal.set(g.getAttribute("normal").array as Float32Array, base * 3);
    uvs.set(g.getAttribute("uv").array as Float32Array, base * 2);
    if (g.index) for (let i = 0, a = g.index.array; i < a.length; i++) index[at++] = a[i] + base;
    else for (let i = 0; i < count; i++) index[at++] = i + base;
    base += count;
    g.dispose();
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(position, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  merged.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  return merged;
}

// Parts of one solid, as boxes from their corners.
const span = (parts: THREE.BufferGeometry[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  parts.push(g);
};

export function build(scans: Scans, extra: Record<string, THREE.Texture>): Drawing {
  const edge: THREE.Vector3[] = [];
  for (let k = 0; k < 720; k++) {
    const a = (k / 720) * Math.PI * 2;
    const r = reach(a);
    edge.push(new THREE.Vector3(Math.cos(a) * r, 0, HOLE.z + Math.sin(a) * r));
  }
  const real = new THREE.Group();
  const materials: THREE.Material[] = [];

  // What moves: the drawing's clock, how far it has woken, the train's nose, its headlights, the colour of the lamps in
  // the platform's edge, and how far the tubes dip as the train draws its power.
  const time = uniform(0);
  const wake = uniform(0);
  const nose = uniform(RUN.from);
  const head = uniform(0);
  const edgeColour = uniform(new THREE.Color(1, 0.84, 0.6));
  const dip = uniform(1);
  // The local track's signal: which lens is lit (0 green, 1 yellow, 2 red) and that lens's colour.
  const aspect = uniform(0);
  const aspectColour = uniform(new THREE.Color(0.1, 1, 0.45));

  // ------------------------------------------------------------------------------------------------- The lighting
  const hash = (a: any, b: number) => fract(sin(a.mul(12.9898).add(b * 78.233)).mul(43758.5453));
  // A cheap smooth noise (0 to 1) over a plane: four hashed corners eased between, far lighter than a gradient noise.
  const smooth = (at: any) => {
    const i: any = floor(at);
    const f: any = fract(at);
    const u = f.mul(f).mul(f.mul(-2).add(3));
    const corner = (dx: number, dy: number) => hash(i.x.add(dx).add(i.y.add(dy).mul(57.13)), 13);
    return mix(mix(corner(0, 0), corner(1, 0), u.x), mix(corner(0, 1), corner(1, 1), u.x), u.y);
  };
  // One tube in ten is failing: once awake it now and then stutters off and on.
  const flicker = (index: any, row: number) => {
    const h = hash(index, row + 1);
    const failing = step(0.9, h);
    const burst = step(0.6, fract(time.mul(0.11).add(h.mul(3.7))));
    const off = step(0.45, hash(floor(time.mul(14).add(h.mul(31))), row + 7));
    return float(1).sub(failing.mul(burst).mul(off).mul(wake).mul(0.88));
  };
  const inStation = (x: any) => step(abs(x), ENDS);
  // Whether the sun's ray at a point on the ground gets through the hole: its smooth outline, without the broken
  // edge's raggedness (a few centimetres, lost in a patch of light metres away) or its arctangent.
  const through = (at: any) => {
    const q = abs(at.x).div(HOLE.a);
    const r = abs(at.y.sub(HOLE.z)).div(HOLE.b);
    return step(q.mul(q).mul(q).mul(q).mul(q).add(r.mul(r).mul(r).mul(r).mul(r)), 1);
  };
  // Everything about each light that depends only on where the point is (its direction, falloff and level) is built
  // once here and shared by every material; `light` adds up only what depends on each surface's facing.
  const at = positionWorld;
  const toEye = normalize(cameraPosition.sub(at));
  const sunDir = vec3(SUN.x, SUN.y, SUN.z);
  const sunGets = vec3(SUNLIGHT.r, SUNLIGHT.g, SUNLIGHT.b).mul(through(at.xz.add(sunDir.xz.mul(at.y.negate().div(SUN.y))))).mul(through(at.xz.add(sunDir.xz.mul(float(-SHAFT).sub(at.y).div(SUN.y)))));
  const tube = vec3(0.96, 1.0, 0.97).mul(10);
  const rows = ROWS.map((z, row) => {
    const xi = round(at.x.div(GAP));
    const fx = xi.mul(GAP);
    const to = vec3(fx.add(clamp(at.x.sub(fx), -TUBE.half, TUBE.half)), TUBE.y, z).sub(at);
    const d2 = dot(to, to).max(0.02);
    const l = to.div(d2.sqrt());
    const level = flicker(xi, row).mul(inStation(fx)).mul(dip).mul(ROW_LEVEL[row]);
    const line = vec3(at.x, TUBE.y, z).sub(at);
    const e2 = dot(line, line).add(0.01);
    return {
      l,
      half: normalize(l.add(toEye)),
      diffuse: tube.mul(level.div(d2.add(0.5))),
      glint: tube.mul(level.div(d2.mul(0.1).add(1))),
      line: line.div(e2.sqrt()),
      glow: tube.mul(0.3 * ROW_LEVEL[row]).mul(inStation(at.x).mul(dip).div(e2.add(2)))
    };
  });
  // Point lamps: the lamps in the platform's edge, low over the track; caged bulbs down the tunnels on the platform
  // side, dim and warm, one or two failing; and the local track's signal tinting the rails, the tunnel's mouth and the
  // end of the platform round it.
  const pointLamp = (where: any, colour: any, soft: number, least = 0.01) => {
    const to = where.sub(at);
    const d2 = dot(to, to).max(least);
    return { l: to.div(d2.sqrt()), gives: colour.div(d2.add(soft)) };
  };
  const edgeX = round(at.x.div(EDGE_LAMP.gap)).mul(EDGE_LAMP.gap);
  const bulbI = round(at.x.div(BULB.gap));
  const pointLamps = [
    pointLamp(vec3(edgeX, EDGE_LAMP.y, EDGE + 0.03), edgeColour.mul(0.08).mul(inStation(at.x)), 0.02),
    pointLamp(vec3(bulbI.mul(BULB.gap), BULB.y, BULB.z), vec3(1.0, 0.72, 0.42).mul(1.4).mul(flicker(bulbI, 5)).mul(step(ENDS - 0.5, abs(at.x))), 0.3),
    pointLamp(vec3(SIGNAL.x - 0.3, float(SIGNAL.y + SIGNAL.pitch).sub(aspect.mul(SIGNAL.pitch)), SIGNAL.local), aspectColour.mul(0.35), 0.2)
  ];
  // The train's headlights, a cone ahead of the nose along the track, and its windows' light spilling out sideways
  // while it is alongside.
  const headTo = vec3(nose.add(0.1), RAIL + 1.2, TRACK).sub(at);
  const headD2 = dot(headTo, headTo).max(0.05);
  const headL = headTo.div(headD2.sqrt());
  const cone = smoothstep(0.4, 0.95, headL.x.negate()).add(smoothstep(0.0, 0.4, headL.x.negate()).mul(0.06));
  const beam = vec3(1.0, 0.95, 0.85).mul(head.mul(620)).mul(cone).div(headD2.add(4));
  const headHalf = normalize(headL.add(toEye));
  const out = abs(at.z.sub(TRACK)).sub(HALF).max(0);
  const tail = nose.sub(TRAIN);
  const alongside = smoothstep(tail.sub(0.5), tail.add(1.5), at.x).mul(smoothstep(nose.add(0.5), nose.sub(1.5), at.x)).mul(head.min(1));
  const window = vec3(at.x, RAIL + 2.1, at.z.sub(TRACK).sign().mul(HALF).add(TRACK)).sub(at);
  const w2 = dot(window, window).add(0.02);
  const windowL = window.div(w2.sqrt());
  const windowGives = vec3(1.0, 0.95, 0.82).mul(1.4).mul(alongside).div(out.mul(out).mul(1.5).add(w2.mul(0.3)).add(0.6));
  // The light reaching a point facing n: the nearest tube in each row and the glow of the rest of the row, the point
  // lamps, the train's headlights ahead of it and its lit windows beside it. `shine` adds a glint of the nearest tube
  // for glazed and polished things; `train` leaves out the train's own light; `sunlit` lets in the sun, where it comes
  // in through the hole (past the cut's depth too), out of the artist's sight on the wall under the sidewalk.
  const light = (n: any, shine: any, train = false, sunlit = false) => {
    let sum: any = vec3(0.02, 0.02, 0.019);
    if (sunlit) sum = sum.add(sunGets.mul(dot(n, sunDir).max(0)));
    rows.forEach((r) => {
      sum = sum.add(r.diffuse.mul(dot(n, r.l).max(0)));
      if (typeof shine !== "number" || shine > 0) sum = sum.add(r.glint.mul(pow(dot(n, r.half).max(0), 50)).mul(shine));
      sum = sum.add(r.glow.mul(dot(n, r.line).max(0)));
    });
    pointLamps.forEach((k) => (sum = sum.add(k.gives.mul(dot(n, k.l).max(0)))));
    if (!train) {
      // (The beam wrapped round a little: down a long straight track it grazes everything it lights.)
      sum = sum.add(beam.mul(dot(n, headL).mul(0.75).add(0.25).max(0)));
      sum = sum.add(beam.mul(pow(dot(n, headHalf).max(0), 24)).mul(float(shine).mul(2).add(0.3)));
      sum = sum.add(windowGives.mul(dot(n, windowL).max(0).mul(0.7).add(0.3)));
    }
    return sum;
  };
  // The dusty air: further things fade into a dim haze.
  const hazed = (colour: any, p: any) => mix(vec3(0.05, 0.048, 0.042), colour, exp(length(cameraPosition.sub(p)).mul(-0.026)));
  // World-laid texture coordinates (in metres) on the face a normal points out of, and a scan's normal bent onto it.
  const laid = (p: any, n: any) => {
    const ax = step(0.5, abs(n.x));
    const ay = step(0.5, abs(n.y));
    return mix(mix(vec2(p.x, p.y), vec2(p.z, p.y), ax), vec2(p.x, p.z), ay);
  };
  const bent = (n: any, map: THREE.Texture, at: any, strength: any) => {
    const t = texture(map, at).xyz.mul(2).sub(1);
    const ax = step(0.5, abs(n.x));
    const ay = step(0.5, abs(n.y));
    const u = mix(mix(vec3(1, 0, 0), vec3(0, 0, 1), ax), vec3(1, 0, 0), ay);
    const v = mix(vec3(0, 1, 0), vec3(0, 0, 1), ay);
    return normalize(n.add(u.mul(t.x.mul(strength))).add(v.mul(t.y.mul(strength))));
  };
  // The view's haze of air (Post) thickens with depth, and the chalk lies on the sidewalk, much nearer than the station
  // it shows: so everything down here gives a depth only a little past where its sight line leaves the cut in the
  // street (still in order along the line), and the haze over it is the haze over the chalk. Flown down into the
  // station, under the street, there is no cut to look through: its true depth.
  const SEEN = 0.42;
  const nearer = cameraPosition.y.add(SEEN).div(cameraPosition.y.sub(positionWorld.y).max(0.001)).mul(0.995).add(0.005).min(1);
  const shallow = viewZToPerspectiveDepth(positionView.z.mul(mix(float(1), nearer, step(0, cameraPosition.y))), cameraNear, cameraFar);
  const unlit = (colour: any) => {
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = colour;
    material.depthNode = shallow;
    materials.push(material);
    return material;
  };
  const p = positionWorld;
  const n = normalWorld;

  // ------------------------------------------------------------------------------------------------- The station
  const tileParts: THREE.BufferGeometry[] = [];
  const concreteParts: THREE.BufferGeometry[] = [];
  const bedParts: THREE.BufferGeometry[] = [];
  // The tiled walls behind the platform and behind the express track; the station's ends, tiled above the tunnel
  // mouths and the platform, concrete between the mouths.
  span(tileParts, -ENDS, ENDS, PLATFORM, CEIL, BACK - 0.3, BACK);
  span(tileParts, -ENDS, ENDS, BED, CEIL, NEARWALL, NEARWALL + 0.3);
  [-1, 1].forEach((s) => {
    const [x0, x1] = s < 0 ? [-ENDS - 0.3, -ENDS] : [ENDS, ENDS + 0.3];
    span(tileParts, x0, x1, MOUTH, CEIL, BACK, NEARWALL);
    span(tileParts, x0, x1, PLATFORM, MOUTH, BACK, EDGE);
    span(concreteParts, x0, x1, BED, MOUTH, LOCAL_BORE[1], EXPRESS_BORE[0]);
    span(concreteParts, x0, x1, BED, MOUTH, EXPRESS_BORE[1], NEARWALL);
    // The tunnels beyond: walls, roof and far end, and the track bed in them. The local's long (the train waits and
    // leaves in it), the express's short.
    [
      [LOCAL_BORE, DEEP],
      [EXPRESS_BORE, ENDS + 40]
    ].forEach(([bore, deep]: any) => {
      const [z0, z1] = bore as number[];
      const [a, b] = s < 0 ? [-deep, -ENDS] : [ENDS, deep];
      span(concreteParts, a, b, BED, MOUTH, z0 - 0.3, z0);
      span(concreteParts, a, b, BED, MOUTH, z1, z1 + 0.3);
      span(concreteParts, a, b, MOUTH, MOUTH + 0.3, z0 - 0.3, z1 + 0.3);
      span(concreteParts, s < 0 ? a - 0.3 : b, s < 0 ? a : b + 0.3, BED, MOUTH, z0, z1);
      span(bedParts, a, b, BED - 0.3, BED, z0, z1);
    });
  });
  span(concreteParts, -ENDS, ENDS, BED, PLATFORM, BACK, EDGE);
  // The columns' concrete collars.
  for (let x = COLUMN.first; x < ENDS; x += COLUMN.gap) span(concreteParts, x - 0.26, x + 0.26, PLATFORM, PLATFORM + 0.1, PILLARS - 0.24, PILLARS + 0.24);
  span(bedParts, -ENDS, ENDS, BED - 0.3, BED, EDGE, NEARWALL);

  const tileUv = laid(p, n).div(1.27);
  const grime = smooth(vec2(p.x.add(p.z).mul(0.6), p.y.mul(2.5)));
  // Little square tesserae, `size` metres, over a place on the wall (metres, across and up): which one, where in it,
  // and the grout round it (faded out where it would shimmer).
  const tesserae = (at: any, size: number) => {
    const cell: any = floor(at.div(size));
    const inCell: any = fract(at.div(size));
    const rim = min(min(inCell.x, float(1).sub(inCell.x)), min(inCell.y, float(1).sub(inCell.y)));
    const grout = float(1).sub(smoothstep(0.05, 0.13, rim)).mul(float(1).sub(smoothstep(0.15, 0.4, fwidth(at.x.div(size)))));
    return { cell, grout, tint: hash(cell.x.add(cell.y.mul(57.1)), 11).mul(0.14).add(0.9) };
  };
  // Along the wall as someone facing it reads it, left to right.
  const across = laid(p, n).x.mul(mix(n.z.sign(), n.x.sign().negate(), step(0.5, abs(n.x))));
  // Old white tiles, a mosaic frieze of cream diamonds on deep teal with a thin maroon line under it, a base course of
  // brown tiles along the platform, soot creeping up from the track and down from the ceiling, and long streaks where
  // water has seeped through.
  const tileAlbedo = texture(extra.tiles, tileUv).rgb.mul(0.92);
  const band = step(-3.72, p.y).mul(step(p.y, -3.48));
  const pinline = step(-3.82, p.y).mul(step(p.y, -3.77));
  const frieze = tesserae(vec2(across, p.y.add(3.72)), 0.03);
  const motif: any = frieze.cell.add(0.5).mul(0.03);
  const diamond = step(abs(fract(motif.x.div(0.24)).sub(0.5)).mul(0.24).add(abs(motif.y.sub(0.12))), 0.075);
  const friezeColour = mix(vec3(0.07, 0.3, 0.3), vec3(0.78, 0.72, 0.58), diamond).mul(frieze.tint).mul(float(1).sub(frieze.grout.mul(0.55)));
  const base = step(PLATFORM, p.y).mul(step(p.y, PLATFORM + 0.16)).mul(step(0.5, n.z));
  let banded: any = mix(mix(tileAlbedo, friezeColour, band), tileAlbedo.mul(vec3(0.5, 0.12, 0.1)), pinline);
  banded = mix(banded, tileAlbedo.mul(vec3(0.42, 0.26, 0.15)), base);
  // The name tablets: the lettering's top half laid in tesserae two centimetres across, each a slightly different
  // shade, in the walls facing the tracks.
  const tabletX = p.x.sub(round(p.x.sub(TABLET.at).div(TABLET.gap)).mul(TABLET.gap).add(TABLET.at));
  const tabletAt = vec2(tabletX.mul(n.z.sign()).add(TABLET.half), p.y.sub(TABLET.y0));
  const inTablet = step(abs(tabletX), TABLET.half).mul(step(TABLET.y0, p.y)).mul(step(p.y, TABLET.y1)).mul(step(0.5, abs(n.z)));
  const tablet = tesserae(tabletAt, 0.02);
  const tabletSize = vec2(TABLET.half * 2, TABLET.y1 - TABLET.y0);
  const tabletUv = tablet.cell.add(0.5).mul(0.02).div(tabletSize).mul(vec2(1, 0.5)).add(vec2(0, 0.5));
  const lettered = letteringTexture();
  const tabletColour = texture(lettered, tabletUv).level(float(0)).rgb.mul(tablet.tint).mul(float(1).sub(tablet.grout.mul(0.5)));
  banded = mix(banded, tabletColour, inTablet);
  // Streaks the water has drawn down the wall: white lime from the ceiling, and rust run down from the tablets' iron
  // fixings.
  const streak = texture(extra.gravel, vec2(across.mul(0.7), p.y.mul(0.035))).r;
  const lime = smoothstep(0.5, 0.75, streak).mul(smoothstep(CEIL - 2.4, CEIL - 0.1, p.y)).mul(0.55);
  const rust = smoothstep(0.45, 0.7, texture(extra.gravel, vec2(across.mul(1.3), p.y.mul(0.06).add(0.4))).g).mul(step(abs(tabletX), TABLET.half)).mul(smoothstep(TABLET.y0 - 1.1, TABLET.y0, p.y)).mul(step(p.y, TABLET.y0)).mul(0.6);
  banded = mix(mix(banded, vec3(0.8, 0.78, 0.72), lime), banded.mul(vec3(0.62, 0.36, 0.18)), rust);
  const seep = smoothstep(0.72, 0.9, smooth(vec2(p.x.add(p.z).mul(1.8), p.y.mul(0.12)))).mul(0.5);
  const soot = smoothstep(BED + 2.2, BED, p.y).mul(0.75).add(smoothstep(CEIL - 0.9, CEIL, p.y).mul(0.4)).add(seep).mul(grime.mul(0.6).add(0.5)).clamp(0, 0.85);
  const tileColour = mix(banded, banded.mul(vec3(0.3, 0.26, 0.2)), soot);
  // The mosaics lie flat (the long tiles' relief is not theirs), only their grout sunk a little.
  const tileN = (mix as any)(bent(n, extra.tilesNormal, tileUv, 0.9), n, inTablet.add(band).clamp(0, 1));
  const tileMaterial = unlit(hazed(tileColour.mul(light(tileN, mix(float(0.6), float(0.25), inTablet), false, true)), p));
  const tileGeometry = packed(tileParts);
  real.add(new THREE.Mesh(tileGeometry, tileMaterial));

  // Concrete: the platform's worn top, with its yellow strip of tactile domes at the edge, its sooty face, and the
  // tunnels.
  const concreteTex = texture(scans.slab, laid(p, n).div(2.2)).rgb;
  const onTop = step(0.5, n.y).mul(step(PLATFORM - 0.01, p.y));
  const strip = onTop.mul(step(EDGE - 0.62, p.z)).mul(step(p.z, EDGE - 0.06));
  const domes = float(1).sub(smoothstep(0.011, 0.016, length(fract(p.xz.div(0.06)).sub(0.5).mul(0.06))));
  const yellow = vec3(0.66, 0.48, 0.04).mul(float(1).sub(domes.mul(0.3))).mul(grime.mul(0.35).add(0.7));
  const lip = onTop.mul(step(EDGE - 0.06, p.z));
  const worn = concreteTex.mul(0.85).mul(smooth(p.xz.mul(0.4)).mul(0.36).add(0.7));
  const sooty = concreteTex.mul(0.38).mul(grime.mul(0.5).add(0.6));
  const tunnelDark = smoothstep(ENDS, ENDS + 6, abs(p.x));
  // The platform's face: deep shadow under the lip's overhang, then cast concrete in pours with joints between.
  const face = step(0.5, n.z).mul(step(p.y, PLATFORM - 0.01)).mul(step(EDGE - 0.05, p.z));
  const underLip = smoothstep(PLATFORM - 0.3, PLATFORM - 0.12, p.y).mul(face);
  const pourJoint = float(1).sub(smoothstep(0.008, 0.02, abs(fract(p.x.div(1.8)).sub(0.5)).mul(1.8).sub(0.88).abs())).mul(face);
  const dribble = smoothstep(0.65, 0.9, smooth(vec2(p.x.mul(3), p.y.mul(0.4)))).mul(face).mul(0.5);
  let concreteColour: any = mix(sooty, worn, onTop);
  concreteColour = mix(concreteColour, concreteColour.mul(0.5), dribble.add(pourJoint.mul(0.6)).clamp(0, 1));
  concreteColour = mix(concreteColour, vec3(0.012, 0.011, 0.01), underLip.mul(0.7));
  concreteColour = mix(concreteColour, yellow, strip);
  concreteColour = mix(concreteColour, vec3(0.42, 0.4, 0.37).mul(concreteTex.r.add(0.5)), lip);
  concreteColour = mix(concreteColour, concreteColour.mul(0.45), tunnelDark);
  // The domes catch the light on their tops.
  const domeN = normalize(n.add(vec3(fract(p.x.div(0.06)).sub(0.5), 0, fract(p.z.div(0.06)).sub(0.5)).mul(domes.mul(strip).mul(1.4))));
  // Each lamp in the edge lights the concrete round it.
  const lampAt = vec2(p.x.sub(round(p.x.div(EDGE_LAMP.gap)).mul(EDGE_LAMP.gap)), p.y.sub(EDGE_LAMP.y));
  const halo = exp(dot(lampAt, lampAt).mul(-40)).mul(face).mul(inStation(p.x));
  const concreteMaterial = unlit(hazed(concreteColour.mul(light(domeN, 0.15, false, true)).add(edgeColour.mul(halo.mul(0.35))), p));
  const concreteGeometry = packed(concreteParts);
  real.add(new THREE.Mesh(concreteGeometry, concreteMaterial));

  // What polished steel, glass and standing water mirror: the ceiling over them with its rows of tubes, or the dim
  // track and platform below.
  const mirrored = (normal: any) => {
    const r = normalize(positionWorld.sub(cameraPosition)).reflect(normal);
    const up = r.y.max(0.02);
    const hit = positionWorld.xz.add(r.xz.mul(float(CEIL).sub(positionWorld.y).div(up)));
    const near = hit.x.sub(round(hit.x.div(GAP)).mul(GAP));
    const tubes = ROWS.reduce((sum: any, z) => sum.add(smoothstep(0.14, 0.06, abs(hit.y.sub(z)))), float(0)).mul(smoothstep(TUBE.half + 0.06, TUBE.half - 0.06, abs(near))).mul(inStation(hit.x));
    const ceiling = vec3(0.1, 0.1, 0.095).add(vec3(1.0, 0.98, 0.92).mul(tubes.mul(5)).mul(dip));
    return mix(vec3(0.07, 0.066, 0.058), ceiling, smoothstep(-0.04, 0.04, r.y));
  };

  // The track bed: tarred ballast, black with oil and brake dust, a little rust-brown along the rails, and here and
  // there off the tracks standing water, black and still, holding the tubes overhead.
  const gravelUv = p.xz.div(1.6);
  const gravel = texture(extra.gravel, gravelUv).rgb;
  const nearRail = [TRACK - 0.72, TRACK + 0.72, EXPRESS - 0.72, EXPRESS + 0.72].reduce((m: any, z) => min(m, abs(p.z.sub(z))), float(9));
  const bedColour = mix(gravel.mul(0.36), gravel.mul(vec3(0.55, 0.32, 0.18)), smoothstep(0.4, 0.0, nearRail).mul(0.6));
  const puddle = smoothstep(0.78, 0.84, smooth(vec2(p.x.mul(0.12), p.z.mul(0.9))).add(gravel.r.mul(0.1))).mul(inStation(p.x.mul(0.8))).mul(smoothstep(1.5, 1.9, min(abs(p.z.sub(TRACK)), abs(p.z.sub(EXPRESS)))));
  const bedLit = bedColour.mul(light(bent(n, extra.gravelNormal, gravelUv, mix(float(1.2), float(0.1), puddle)), 0.05, false, true));
  const view = normalize(cameraPosition.sub(p));
  const water = bedColour.mul(0.15).add(mirrored(vec3(0, 1, 0)).mul(pow(float(1).sub(view.y.max(0)), 3).mul(0.6).add(0.12)));
  const bedMaterial = unlit(hazed(mix(bedLit, water, puddle), p));
  const bedGeometry = packed(bedParts);
  real.add(new THREE.Mesh(bedGeometry, bedMaterial));

  // Ties under the rails, creosoted timber every 0.65 m, each its own shade, the oldest weathered grey. Under each
  // rail on each tie a rusted steel plate, painted on, spiked down at its corners.
  const tieGeometry = new THREE.BoxGeometry(0.24, 0.175, 2.5);
  // (Never seen from under the ballast: its bottom face is left out.)
  tieGeometry.setIndex(Array.from(tieGeometry.index!.array).filter((_, i) => i < 18 || i >= 24));
  const tieShade = hash(round(p.x.div(0.65)), 21);
  const tieGrain = texture(extra.gravel, p.xz.mul(vec2(2.5, 0.4))).r;
  let tieColour: any = mix(vec3(0.11, 0.08, 0.06), vec3(0.2, 0.19, 0.17), step(0.75, tieShade).mul(0.8)).mul(tieGrain.mul(1.2).add(0.4)).mul(tieShade.mul(0.5).add(0.75));
  const fromRail = [TRACK - 0.7175, TRACK + 0.7175, EXPRESS - 0.7175, EXPRESS + 0.7175].reduce((d: any, z) => min(d, abs(p.z.sub(z))), float(9));
  const alongTie = abs(p.x.sub(round(p.x.div(0.65)).mul(0.65)));
  const plate = step(0.5, n.y).mul(step(fromRail, 0.18)).mul(step(alongTie, 0.1));
  const spike = float(1).sub(smoothstep(0.01, 0.016, length(vec2(abs(alongTie.sub(0.055)), abs(fromRail.sub(0.11)))))).mul(plate);
  tieColour = mix(tieColour, vec3(0.13, 0.075, 0.045).mul(tieGrain.mul(0.6).add(0.7)), plate);
  tieColour = mix(tieColour, vec3(0.22, 0.13, 0.08), spike);
  const tieMaterial = unlit(hazed(tieColour.mul(light(n, plate.mul(0.2).add(0.02))), p));
  const tieX: number[] = [];
  for (let x = -ENDS - 20; x < ENDS + 20; x += 0.65) tieX.push(x);
  const ties = new THREE.InstancedMesh(tieGeometry, tieMaterial, tieX.length * 2);
  const m = new THREE.Matrix4();
  tieX.forEach((x, i) => [TRACK, EXPRESS].forEach((z, j) => ties.setMatrixAt(i * 2 + j, m.makeRotationY(Math.sin(i * 7.1 + j) * 0.012).setPosition(x, BED + 0.0675, z))));
  real.add(ties);

  // The rails, true to their section: polished bright along the top where the wheels run, the head's sides worn
  // clean, rust-brown down the web and foot. The third rail stands on porcelain insulators every sixth tie, a strap
  // up the outside of each carrying its weathered board.
  const railParts: THREE.BufferGeometry[] = [];
  const railShape = railSection();
  const laidRail = (z: number, top: number) => {
    const g = new THREE.ExtrudeGeometry(railShape, { depth: DEEP * 2, bevelEnabled: false, curveSegments: 1 });
    g.rotateY(Math.PI / 2);
    g.translate(-DEEP, top, z);
    railParts.push(g);
  };
  [TRACK, EXPRESS].forEach((z) => {
    [-0.7175, 0.7175].forEach((g) => laidRail(z + g, RAIL));
    const third = z + 1.08;
    laidRail(third, RAIL + 0.095);
    span(railParts, -DEEP, DEEP, RAIL + 0.18, RAIL + 0.21, third - 0.2, third + 0.2);
    tieX.forEach((x, i) => {
      if (i % 6 !== 2) return;
      span(railParts, x - 0.065, x + 0.065, BED + 0.155, BED + 0.25, third - 0.065, third + 0.065);
      span(railParts, x - 0.02, x + 0.02, BED + 0.155, RAIL + 0.18, third + 0.2, third + 0.215);
    });
  });
  const railTop = step(0.9, n.y).mul(step(RAIL - 0.004, p.y)).mul(step(p.y, RAIL + 0.004));
  const railHead = step(RAIL - 0.04, p.y).mul(step(p.y, RAIL + 0.01));
  const board = step(RAIL + 0.15, p.y);
  const porcelain = step(abs(p.z.sub(TRACK + 1.08)).min(abs(p.z.sub(EXPRESS + 1.08))), 0.07).mul(step(p.y, BED + 0.251));
  const boardGrain = texture(extra.gravel, vec2(p.x.mul(0.25), p.z.mul(5))).r;
  const railRust = vec3(0.12, 0.07, 0.045).mul(texture(extra.gravel, p.xz.mul(vec2(0.5, 4))).g.mul(0.6).add(0.7));
  let railColour: any = mix(mix(mix(railRust, vec3(0.2, 0.17, 0.15), railHead), vec3(0.62, 0.62, 0.64), railTop), vec3(0.2, 0.17, 0.13).mul(boardGrain.mul(0.7).add(0.6)), board);
  railColour = mix(railColour, vec3(0.42, 0.3, 0.2), porcelain);
  const railMaterial = unlit(hazed(railColour.mul(light(n, mix(float(0.2), float(1.5), railTop.add(railHead.mul(0.3))).add(porcelain.mul(0.6)))), p));
  const railGeometry = packed(railParts);
  real.add(new THREE.Mesh(railGeometry, railMaterial));

  // Steel I-beam columns down the platform, painted a dark blue-grey long ago, chipped and rusting at the foot.
  // Each stands on a low concrete collar, its flanges riveted on in two rows; a knee brace at the top to the girder.
  // On every other column a black enamel sign with the name in white under a thin white line, readable from either
  // side. (The fittings of the tubes and the signals' heads are this steel too.)
  const columnParts: THREE.BufferGeometry[] = [];
  for (let x = COLUMN.first, k = 0; x < ENDS; x += COLUMN.gap, k++) {
    span(columnParts, x - 0.16, x + 0.16, PLATFORM, CEIL, PILLARS + 0.13, PILLARS + 0.15);
    span(columnParts, x - 0.16, x + 0.16, PLATFORM, CEIL, PILLARS - 0.15, PILLARS - 0.13);
    span(columnParts, x - 0.012, x + 0.012, PLATFORM, CEIL, PILLARS - 0.13, PILLARS + 0.13);
    span(columnParts, x - 0.5, x + 0.5, CEIL - 0.3, CEIL, PILLARS - 0.1, PILLARS + 0.1);
    if (k % 2 === 1) [-1, 1].forEach((s) => span(columnParts, x - COLUMN_SIGN.half, x + COLUMN_SIGN.half, COLUMN_SIGN.y0, COLUMN_SIGN.y1, PILLARS + Math.min(s * 0.15, s * 0.17), PILLARS + Math.max(s * 0.15, s * 0.17)));
  }
  ROWS.forEach((z) => {
    for (let k = -Math.floor(ENDS / GAP); k * GAP <= ENDS; k++) span(columnParts, k * GAP - TUBE.half - 0.06, k * GAP + TUBE.half + 0.06, TUBE.y + 0.02, CEIL, z - 0.15, z + 0.15);
  });
  // The signals, at the far end where the tunnels begin: a black head on a post by each track, a hood over each lens.
  // The local's shows green until the train passes it, then red behind it while it clears the block, then yellow,
  // then green again; the express's stays green.
  const lampParts: THREE.BufferGeometry[] = [];
  [SIGNAL.local, SIGNAL.express].forEach((z) => {
    const x = SIGNAL.x;
    span(columnParts, x - 0.05, x + 0.05, BED, SIGNAL.y - 0.5, z - 0.05, z + 0.05);
    span(columnParts, x - 0.14, x + 0.14, SIGNAL.y - 0.5, SIGNAL.y + 0.5, z - 0.17, z + 0.17);
    [-1, 0, 1].forEach((k) => {
      const y = SIGNAL.y + k * SIGNAL.pitch;
      span(columnParts, x - 0.34, x - 0.14, y + 0.1, y + 0.12, z - 0.12, z + 0.12);
      [-1, 1].forEach((s) => span(columnParts, x - 0.34, x - 0.14, y - 0.06, y + 0.12, z + s * 0.12 - 0.01, z + s * 0.12 + 0.01));
      const lens = new THREE.CircleGeometry(0.085, 12);
      lens.rotateY(-Math.PI / 2);
      lens.translate(x - 0.145, y, z);
      lampParts.push(lens);
    });
  });
  const columnX = p.x.sub(round(p.x.sub(COLUMN.first).div(COLUMN.gap)).mul(COLUMN.gap).add(COLUMN.first));
  const rivetAt = vec2(abs(columnX).sub(0.11), fract(p.y.div(0.14)).sub(0.5).mul(0.14));
  const rivet = float(1).sub(smoothstep(0.008, 0.013, length(rivetAt))).mul(step(0.5, abs(n.z))).mul(step(abs(abs(p.z.sub(PILLARS)).sub(0.15)), 0.004)).mul(step(p.y, CEIL - 0.35));
  const chips = smoothstep(0.35, 0.6, smooth(vec2(p.y.mul(3), p.x.add(p.z).mul(9))).mul(2).sub(1).add(smoothstep(PLATFORM + 1.0, PLATFORM, p.y)));
  let columnColour: any = mix(vec3(0.15, 0.2, 0.22), vec3(0.12, 0.08, 0.06), chips.mul(0.7)).mul(rivet.mul(0.25).add(1));
  const inSign = step(0.155, abs(p.z.sub(PILLARS))).mul(step(COLUMN_SIGN.y0 - 0.001, p.y)).mul(step(p.y, COLUMN_SIGN.y1 + 0.001)).mul(step(abs(p.z.sub(PILLARS)), 0.18));
  const signUv = vec2(columnX.mul(n.z.sign()).div(COLUMN_SIGN.half * 2).add(0.5), p.y.sub(COLUMN_SIGN.y0).div(COLUMN_SIGN.y1 - COLUMN_SIGN.y0).mul(0.25).add(0.25));
  columnColour = mix(columnColour, mix(vec3(0.03), texture(lettered, signUv).rgb.mul(0.85), step(0.5, abs(n.z))), inSign);
  columnColour = mix(columnColour, vec3(0.025, 0.025, 0.027), step(ENDS + 1, p.x));
  // A rivet's dome tips the normal outward from its middle, catching the tubes' light on its top.
  const rivetN = normalize(n.add(vec3(rivetAt.x.mul(columnX.sign()), rivetAt.y, 0).mul(rivet.mul(60))));
  const columnMaterial = unlit(hazed(columnColour.mul(light(rivetN, mix(float(0.5), float(0.9), inSign))), p));
  const columnGeometry = packed(columnParts);
  real.add(new THREE.Mesh(columnGeometry, columnMaterial));

  // Wooden benches against the back wall between every other pair of columns: slatted seat and back on steel legs.
  // (And, in the same mesh, litter thrown down onto the tracks over the years: flattened cups and wrappers,
  // newspaper, cans, each piece its own colour.)
  const benchParts: THREE.BufferGeometry[] = [];
  for (let x = -ENDS + 4.6; x < ENDS - 2; x += 9.2) {
    const z = BACK + 0.32;
    [0, 1, 2].forEach((k) => span(benchParts, x - 0.95, x + 0.95, PLATFORM + 0.44, PLATFORM + 0.47, z - 0.2 + k * 0.13 - 0.05, z - 0.2 + k * 0.13 + 0.05));
    [0, 1].forEach((k) => span(benchParts, x - 0.95, x + 0.95, PLATFORM + 0.6 + k * 0.14, PLATFORM + 0.7 + k * 0.14, BACK + 0.08, BACK + 0.1));
    [-0.8, 0.8].forEach((dx) => span(benchParts, x + dx - 0.025, x + dx + 0.025, PLATFORM, PLATFORM + 0.9, z - 0.22, z + 0.12));
  }
  const turned = new THREE.Euler();
  for (let i = 0; i < 90; i++) {
    const r = (k: number) => Math.abs(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1;
    const can = r(1) < 0.25;
    const piece = new THREE.BoxGeometry(can ? 0.12 : 0.1 + r(4) * 0.2, can ? 0.065 : 0.004, can ? 0.065 : 0.08 + r(5) * 0.2);
    piece.applyMatrix4(m.makeRotationFromEuler(turned.set(can ? 0 : (r(6) - 0.5) * 0.3, r(7) * Math.PI, can ? 0 : (r(8) - 0.5) * 0.3)));
    // (Each in the middle of its own square metre, which gives it its colour.)
    piece.translate(Math.floor((r(2) - 0.5) * 2 * (ENDS + 8)) + 0.5, BED + (can ? 0.04 : 0.02), Math.floor(THREE.MathUtils.lerp(EDGE + 0.2, -1, r(3))) + 0.5);
    benchParts.push(piece);
  }
  const benchColour = mix(vec3(0.3, 0.17, 0.08), vec3(0.08), step(0.03, abs(fract(p.x.add(0.8).div(9.2)).sub(0.5)).sub(0.4).max(0)));
  const scrap = hash(floor(p.x).add(floor(p.z).mul(13.1)), 41);
  const litterColour = mix(mix(vec3(0.72, 0.69, 0.6), vec3(0.62, 0.2, 0.12), step(0.55, scrap)), mix(vec3(0.2, 0.35, 0.6), vec3(0.85, 0.75, 0.3), step(0.88, scrap)), step(0.75, scrap));
  const wood = benchColour.mul(texture(scans.slab, p.xz.mul(vec2(0.3, 4))).r.mul(0.5).add(0.7));
  const benchMaterial = unlit(hazed(mix(wood, litterColour, step(p.y, PLATFORM - 0.5)).mul(light(n, 0.3)), p));
  const benchGeometry = packed(benchParts);
  real.add(new THREE.Mesh(benchGeometry, benchMaterial));

  // The lamps themselves, all in one: the tubes (two to a fitting), the lamps in the platform's edge, the caged
  // bulbs down the tunnels, and the signals' lenses.
  ROWS.forEach((z) => {
    for (let k = -Math.floor(ENDS / GAP); k * GAP <= ENDS; k++) [-0.065, 0.065].forEach((dz) => span(lampParts, k * GAP - TUBE.half, k * GAP + TUBE.half, TUBE.y - 0.02, TUBE.y + 0.02, z + dz - 0.02, z + dz + 0.02));
  });
  for (let k = -Math.floor(ENDS / EDGE_LAMP.gap); k * EDGE_LAMP.gap <= ENDS; k++) span(lampParts, k * EDGE_LAMP.gap - 0.07, k * EDGE_LAMP.gap + 0.07, EDGE_LAMP.y - 0.02, EDGE_LAMP.y + 0.02, EDGE, EDGE + 0.012);
  for (let k = Math.ceil(ENDS / BULB.gap); k * BULB.gap < DEEP; k++)
    [-1, 1].forEach((s) => span(lampParts, s * k * BULB.gap - 0.06, s * k * BULB.gap + 0.06, BULB.y - 0.06, BULB.y + 0.06, EDGE, EDGE + 0.12));
  const tubeIndex = round(p.x.div(GAP));
  const tubeFlicker = ROWS.reduce((f: any, z, row) => f.mul(mix(float(1), flicker(tubeIndex, row), step(abs(p.z.sub(z)), 0.5))), float(1));
  const tubeGlow = vec3(0.96, 1.0, 0.97).mul(3.2).mul(tubeFlicker).mul(dip);
  const bulbGlow = vec3(1.0, 0.7, 0.38).mul(4).mul(flicker(round(p.x.div(BULB.gap)), 5));
  const lensIndex = round(float(SIGNAL.y + SIGNAL.pitch).sub(p.y).div(SIGNAL.pitch));
  const lensHue = mix(mix(vec3(0.1, 1, 0.45), vec3(1, 0.62, 0.08), step(0.5, lensIndex)), vec3(1, 0.06, 0.04), step(1.5, lensIndex));
  const lensLit = mix(step(abs(lensIndex), 0.5), step(abs(lensIndex.sub(aspect)), 0.5), step(p.z, (SIGNAL.local + SIGNAL.express) / 2));
  const lensGlass = length(vec2(p.y.sub(round(p.y.sub(SIGNAL.y).div(SIGNAL.pitch)).mul(SIGNAL.pitch).add(SIGNAL.y)), p.z.sub(mix(float(SIGNAL.express), float(SIGNAL.local), step(p.z, (SIGNAL.local + SIGNAL.express) / 2))))).div(0.085);
  const lensGlow = lensHue.mul(mix(float(0.05), float(7).mul(float(1).sub(lensGlass.mul(lensGlass).mul(0.5))), lensLit));
  const isLens = step(ENDS + 1, p.x).mul(step(EDGE + 1, p.z));
  const isBulb = step(ENDS + 1, abs(p.x)).mul(float(1).sub(isLens));
  const isLamp = step(p.y, TUBE.y - 1).mul(float(1).sub(isBulb)).mul(float(1).sub(isLens));
  const glow = mix(mix(mix(tubeGlow, edgeColour.mul(2.4), isLamp), bulbGlow, isBulb), lensGlow, isLens);
  const lampMaterial = unlit(glow);
  const lampGeometry = packed(lampParts);
  real.add(new THREE.Mesh(lampGeometry, lampMaterial));

  // ------------------------------------------------------------------------------------------- The street's cut
  // The broken edge of the slab and the concrete deck under it, lit by the daylight coming in.
  const y = positionWorld.y;
  const shaftMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  const slabColour = texture(scans.slab, uv().mul(vec2(1, 3))).rgb.mul(0.9);
  const deck = texture(scans.slab, uv().mul(1.7).add(0.3)).rgb.mul(0.55).mul(smooth(positionWorld.xz.mul(4)).mul(0.5).add(0.55));
  shaftMaterial.colorNode = mix(mix(deck, vec3(0.06, 0.055, 0.05), smoothstep(CEIL + 0.08, CEIL + 0.06, y)), slabColour, smoothstep(-SLAB - 0.03, -SLAB, y));
  materials.push(shaftMaterial);
  const shaftGeometry = walls(edge.filter((_, k) => k % 2 === 0), SHAFT + 0.02, 1.2, (at, yy) => (yy < -SLAB ? 0.025 * wobble(at.x * 3, yy * 5, at.z * 3) + 0.025 : 0.01 * wobble(at.x * 9, yy * 9, at.z * 9)), 6);
  const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
  shaft.receiveShadow = false;
  real.add(shaft);

  // ------------------------------------------------------------------------------------------------- The train
  // Built nose-first along its own +z, then turned to run along +x.
  const train = new THREE.Group();
  train.position.set(RUN.from, RAIL, TRACK);
  train.rotation.y = Math.PI / 2;
  real.add(train);
  // The body's cross-section: straight sides, a shallow curved roof.
  const section = new THREE.Shape();
  section.moveTo(-HALF, 0.6);
  section.lineTo(HALF, 0.6);
  section.lineTo(HALF, 3.45);
  section.quadraticCurveTo(HALF, 3.85, 0.75, 3.9);
  section.lineTo(-0.75, 3.9);
  section.quadraticCurveTo(-HALF, 3.85, -HALF, 3.45);
  section.closePath();
  const bodyParts: THREE.BufferGeometry[] = [];
  const underParts: THREE.BufferGeometry[] = [];
  const roofParts: THREE.BufferGeometry[] = [];
  for (let c = 0; c < CARS; c++) {
    const end = -c * PITCH - LEN;
    const g = new THREE.ExtrudeGeometry(section, { depth: LEN, bevelEnabled: false, curveSegments: 6 });
    g.translate(0, 0, end);
    bodyParts.push(g);
    // Trucks at each end with their wheels on the rails, equipment boxes slung between, and a black bellows to the
    // next car.
    [end + 2.4, end + LEN - 2.4].forEach((z) => {
      span(underParts, -1.0, 1.0, 0.2, 0.62, z - 1.3, z + 1.3);
      [-1, 1].forEach((s) =>
        [-0.9, 0.9].forEach((dz) => {
          const wheel = new THREE.CylinderGeometry(0.38, 0.38, 0.1, 12);
          wheel.rotateZ(Math.PI / 2);
          wheel.translate(s * 0.69, 0.38, z + dz);
          underParts.push(wheel);
        })
      );
    });
    span(underParts, -1.1, 1.1, 0.25, 0.62, end + 4.2, end + LEN - 4.2);
    if (c < CARS - 1) span(underParts, -1.0, 1.0, 0.7, 3.3, end - (PITCH - LEN), end);
    // On the roof: an air-conditioning housing toward each end, low vents along the middle.
    [end + 2.0, end + LEN - 4.6].forEach((z) => span(roofParts, -0.82, 0.82, 3.86, 4.14, z, z + 2.6));
    for (let k = 0; k < 4; k++) span(roofParts, -0.3, 0.3, 3.86, 3.98, end + 6.0 + k * 1.6, end + 6.8 + k * 1.6);
  }
  const bodyGeometry = packed(bodyParts);
  const underGeometry = packed(underParts.concat(roofParts));

  // The body, all painted on: stainless steel fluted below and above a band of lit windows, four doors a side, the
  // cab's dark windscreen and headlights on the nose, red tail lamps on the last car.
  const q = positionLocal;
  const nl = normalLocal;
  const back = q.z.negate();
  const car = floor(back.div(PITCH));
  const cz = back.sub(car.mul(PITCH));
  const ly = q.y;
  const lx = q.x;
  const side = step(0.7, abs(nl.x));
  const front = step(0.7, nl.z).mul(step(back, 0.05));
  const rear = step(0.7, nl.z.negate()).mul(step(TRAIN - 0.05, back));
  const roof = step(0.5, nl.y);
  const doorOff = DOORS.reduce((d: any, at) => min(d, abs(cz.sub(at))), float(9));
  const inDoor = step(doorOff, 0.65);
  const pane = cz.div(1.05);
  const paneAt = fract(pane);
  const windowBand = step(1.55, ly).mul(step(ly, 2.5)).mul(step(0.08, paneAt)).mul(step(paneAt, 0.92)).mul(float(1).sub(step(doorOff, 0.9))).mul(step(0.7, cz)).mul(step(cz, LEN - 0.7));
  const doorWindow = inDoor.mul(step(1.5, ly)).mul(step(ly, 2.6)).mul(step(0.12, doorOff)).mul(step(doorOff, 0.52));
  const doorLine = inDoor.mul(step(abs(doorOff.sub(0.64)), 0.012)).add(step(abs(doorOff), 0.008).mul(inDoor)).add(step(doorOff, 0.66).mul(step(abs(ly.sub(2.95)), 0.012))).clamp(0, 1);
  const glass = windowBand.add(doorWindow).clamp(0, 1).mul(side);
  // Inside, looked into through the glass: the view's ray carried on across the car (its frame is the world's turned
  // a quarter round: along it is down -x, across it is -z) to the first thing it meets: the far side with its dark
  // windows, orange seats and advertisement cards, the lit ceiling with its two strips of diffusers, the floor, or the
  // car's end. Between, someone standing in the aisle or sitting across, and the steel poles by the doors.
  const ray = normalize(positionWorld.sub(cameraPosition));
  const into = ray.z.mul(lx.sign()).max(0.04);
  const rise = ray.y;
  const runs = ray.x.negate();
  const width = HALF * 2 - 0.12;
  const toSide = float(width).div(into);
  const toLevel = mix(float(1.08).sub(ly).div(rise.min(-0.0001)), float(3.42).sub(ly).div(rise.max(0.0001)), step(0, rise));
  const toEnd = mix(float(0.25).sub(cz).div(runs.min(-0.0001)), float(LEN - 0.25).sub(cz).div(runs.max(0.0001)), step(0, runs));
  const met = min(toSide, min(toLevel, toEnd));
  const hitY = ly.add(rise.mul(met));
  const hitC = cz.add(runs.mul(met));
  const hitX = into.mul(met);
  const onSide = step(toSide, met.add(0.001));
  const onLevel = step(toLevel, met.add(0.001)).mul(float(1).sub(onSide));
  const onEnd = float(1).sub(onSide).sub(onLevel).max(0);
  // The far side.
  const farPane = fract(hitC.div(1.05));
  const farDoor = step(DOORS.reduce((d: any, at) => min(d, abs(hitC.sub(at))), float(9)), 0.65);
  const farGlass = step(1.55, hitY).mul(step(hitY, 2.5)).mul(step(0.08, farPane)).mul(step(farPane, 0.92)).mul(float(1).sub(farDoor));
  const card = floor(hitC.div(0.74));
  const cardColour = mix(mix(vec3(0.85, 0.3, 0.2), vec3(0.2, 0.45, 0.8), hash(card, 31)), vec3(0.95, 0.82, 0.3), step(0.7, hash(card, 33)));
  const inCard = step(2.58, hitY).mul(step(hitY, 2.92)).mul(step(0.04, fract(hitC.div(0.74)))).mul(step(fract(hitC.div(0.74)), 0.96)).mul(float(1).sub(farDoor));
  let farSide: any = vec3(0.78, 0.76, 0.7);
  // (The bench in moulded buckets, the lip of each seat dark under it.)
  const bucket = smoothstep(0.0, 0.04, abs(fract(hitC.div(0.46)).sub(0.5)).mul(0.46).sub(0.19).negate());
  const benchSeat = vec3(0.74, 0.46, 0.15).mul(bucket.mul(0.3).add(0.7)).mul(step(1.15, hitY).mul(0.6).add(0.4)).mul(smoothstep(1.55, 1.2, hitY).mul(0.25).add(0.8));
  farSide = mix(farSide, benchSeat, step(hitY, 1.55).mul(float(1).sub(farDoor)));
  farSide = mix(farSide, vec3(0.55, 0.56, 0.58), farDoor.mul(step(hitY, 3.0)));
  farSide = mix(farSide, vec3(0.03, 0.03, 0.035), farGlass.add(farDoor.mul(step(1.5, hitY)).mul(step(hitY, 2.6)).mul(step(0.12, fract(hitC)))).clamp(0, 1));
  farSide = mix(farSide, cardColour, inCard);
  // The ceiling, the floor, the end with its storm door's window.
  const diffuser = step(abs(abs(hitX.sub(width / 2)).sub(0.55)), 0.09).mul(step(0.08, fract(hitC.div(1.4))));
  const level = mix(vec3(0.26, 0.25, 0.24).mul(step(abs(hitX.sub(width / 2)), 0.4).mul(-0.25).add(1)), mix(vec3(0.86, 0.85, 0.8), vec3(2.4, 2.35, 2.2), diffuser), step(0, rise));
  const endWall = mix(vec3(0.7, 0.69, 0.65), vec3(0.04), step(abs(hitX.sub(width / 2)), 0.32).mul(step(1.7, hitY)).mul(step(hitY, 2.7)));
  let interior: any = farSide.mul(onSide).add(level.mul(onLevel)).add(endWall.mul(onEnd));
  interior = interior.mul(smoothstep(1.0, 3.4, hitY).mul(0.45).add(0.6));
  // Those sitting across, on the far bench.
  const toSeated = float(width - 0.42).div(into);
  const seatedC = cz.add(runs.mul(toSeated));
  const seatedY = ly.add(rise.mul(toSeated));
  const seat = floor(seatedC.div(0.62)).add(car.mul(41)).add(step(0, lx).mul(17));
  const seatAt = vec2(fract(seatedC.div(0.62)).sub(0.5).mul(0.62), seatedY.sub(hash(seat, 6).mul(0.1).add(2.12)));
  // A figure about a point at the head's centre: the head, round shoulders, a body down from them to the hips, and
  // two legs.
  const figure = (at: any, broad: number) =>
    step(length(at.mul(vec2(1, 0.8))), 0.095)
      .add(step(length(at.sub(vec2(0, -0.4)).mul(vec2(1, 1.6))), broad))
      .add(step(abs(at.x), broad - 0.03).mul(step(at.y, -0.4)).mul(step(-0.95, at.y)))
      .add(step(abs(abs(at.x).sub(0.08)), 0.06).mul(step(at.y, -0.95)))
      .clamp(0, 1);
  // Lit from the strips overhead, rounding off toward its sides.
  const rounded = (at: any, broad: number) => float(1).sub(at.x.div(broad).pow(2).mul(0.45)).mul(smoothstep(-1.2, 0, at.y).mul(0.35).add(0.75));
  const seated = figure(seatAt, 0.2).mul(step(-0.85, seatAt.y))
    .clamp(0, 1).mul(step(0.55, hash(seat, 7))).mul(float(1).sub(step(DOORS.reduce((d: any, at) => min(d, abs(seatedC.sub(at))), float(9)), 0.8))).mul(step(toSeated, met));
  const clothes = mix(mix(vec3(0.12, 0.14, 0.22), vec3(0.32, 0.12, 0.1), hash(seat, 8)), vec3(0.3, 0.3, 0.26), step(0.7, hash(seat, 9)));
  interior = mix(interior, mix(clothes, vec3(0.4, 0.27, 0.2).mul(hash(seat, 10).mul(0.8).add(0.4)), step(-0.1, seatAt.y)).mul(rounded(seatAt, 0.2)), seated);
  // Those standing in the aisle, and the poles.
  const toAisle = float(width / 2).div(into);
  const aisleC = cz.add(runs.mul(toAisle));
  const aisleY = ly.add(rise.mul(toAisle));
  const stander = floor(aisleC.div(1.3)).add(car.mul(31)).add(step(0, lx).mul(13));
  const standAt = vec2(fract(aisleC.div(1.3)).sub(0.5).add(hash(stander, 4).sub(0.5).mul(0.5)).mul(1.3), aisleY.sub(hash(stander, 5).mul(0.16).add(2.62)));
  const standing = figure(standAt, 0.22).mul(step(0.62, hash(stander, 3))).mul(step(toAisle, met));
  const coat = mix(mix(vec3(0.1, 0.1, 0.12), vec3(0.45, 0.35, 0.22), hash(stander, 8)), vec3(0.15, 0.25, 0.32), step(0.75, hash(stander, 9)));
  interior = mix(interior, mix(coat, vec3(0.42, 0.29, 0.22).mul(hash(stander, 10).mul(0.8).add(0.4)), step(-0.11, standAt.y)).mul(rounded(standAt, 0.22)), standing);
  const pole = step(DOORS.reduce((d: any, at) => min(d, abs(aisleC.sub(at))), float(9)), 0.022).mul(step(toAisle, met));
  interior = mix(interior, vec3(0.75, 0.76, 0.78).mul(step(0.5, fract(aisleY.mul(0.7))).mul(0.25).add(0.8)), pole);
  // The glass: a black rubber frame round each pane, and a faint reflection of the station over it.
  const paneEdge = min(min(paneAt.sub(0.08), float(0.92).sub(paneAt)).mul(1.05), min(ly.sub(1.55), float(2.5).sub(ly)));
  const gasket = float(1).sub(smoothstep(0.018, 0.03, paneEdge)).mul(windowBand);
  interior = mix(interior.mul(0.8).add(mirrored(n).mul(0.12)), vec3(0.015), gasket);
  // Stainless steel: fluted (the flutes fading out where they would alias), grimier toward the bottom.
  const flute = sin(ly.mul(Math.PI * 2).div(0.045)).mul(float(1).sub(smoothstep(0.25, 0.8, fwidth(ly).div(0.045))));
  const fluted = step(0.75, ly).mul(step(ly, 1.45)).add(step(2.65, ly).mul(step(ly, 3.25)));
  const streaks = smooth(vec2(cz.mul(3).add(car.mul(7.3)).add(lx.sign().mul(3.1)), ly.mul(0.25)));
  const steelBase = vec3(0.5, 0.51, 0.53).mul(flute.mul(fluted).mul(0.12).add(1)).mul(smoothstep(0.6, 1.4, ly).mul(0.35).add(0.65)).mul(streaks.mul(0.25).add(0.82));
  const bodyN = normalize(n.add(vec3(0, flute.mul(fluted).mul(0.25), 0)));
  const bodyLit = light(bodyN, 0.6, true);
  const steelLit = steelBase.mul(bodyLit).mul(0.9).add(mirrored(bodyN).mul(0.32));
  // The nose: windscreen, headlamps, marker lamps.
  const screen = step(1.85, ly).mul(step(ly, 2.75)).mul(step(abs(lx), 1.12)).mul(float(1).sub(step(abs(lx), 0.05)));
  const lamp = (x: number, yy: number, radius: number) => step(length(vec2(lx.sub(x), ly.sub(yy))), radius);
  const headlamps = lamp(-0.8, 1.2, 0.1).add(lamp(0.8, 1.2, 0.1));
  const bezels = lamp(-0.8, 1.2, 0.15).add(lamp(0.8, 1.2, 0.15)).sub(headlamps);
  const markers = lamp(-1.0, 3.4, 0.05).add(lamp(1.0, 3.4, 0.05));
  const tails = lamp(-0.9, 1.2, 0.08).add(lamp(0.9, 1.2, 0.08));
  const bumper = step(ly, 0.85);
  // The amber signs, dot by dot: on each side over the windows by the second door, and over the windscreen.
  const leds = (u: any, v: any) => {
    const dot = vec2(u.mul(160), v.mul(20));
    const lit = texture(lettered, vec2(floor(dot.x).add(0.5).div(160), floor(dot.y).add(0.5).div(20).mul(0.25))).level(float(0)).r;
    const disc = float(1).sub(smoothstep(0.25, 0.42, length(fract(dot).sub(0.5))));
    return vec3(1.0, 0.62, 0.12).mul(lit.mul(disc).mul(3.5)).add(vec3(0.02, 0.015, 0.01));
  };
  const sideSign = side.mul(step(3.8, cz)).mul(step(cz, 5.2)).mul(step(2.7, ly)).mul(step(ly, 2.92));
  const sideLeds = leds(mix(float(1).sub(cz.sub(3.8).div(1.4)), cz.sub(3.8).div(1.4), step(0, lx)), ly.sub(2.7).div(0.22));
  const frontSign = step(abs(lx), 0.62).mul(step(2.86, ly)).mul(step(ly, 3.12));
  const frontLeds = leds(lx.add(0.62).div(1.24), ly.sub(2.86).div(0.26));
  let bodyColour: any = mix(steelLit, interior, glass);
  bodyColour = mix(bodyColour, bodyColour.mul(0.25), doorLine.mul(side));
  bodyColour = mix(bodyColour, sideLeds, sideSign);
  // The roof: dull, ribbed across every half metre, streaked with brake dust.
  const rib = step(0.9, fract(cz.div(0.5)));
  bodyColour = mix(bodyColour, vec3(0.1, 0.1, 0.11).mul(streaks.mul(0.4).add(0.8)).mul(rib.mul(0.35).add(1)).mul(bodyLit), roof.mul(0.6));
  let cab: any = mix(steelLit, vec3(0.02, 0.025, 0.03).add(bodyLit.mul(0.05)), screen);
  cab = mix(cab, frontLeds, frontSign);
  cab = mix(cab, vec3(0.03).mul(bodyLit), bumper);
  cab = mix(cab, vec3(0.3).mul(bodyLit), bezels);
  cab = mix(cab, vec3(1.0, 0.96, 0.86).mul(head.mul(14)), headlamps);
  cab = mix(cab, vec3(1.6, 0.9, 0.3), markers);
  bodyColour = mix(bodyColour, cab, front);
  bodyColour = mix(bodyColour, mix(steelLit.mul(0.8), vec3(2.2, 0.1, 0.05), tails), rear);
  bodyColour = mix(bodyColour, vec3(0.04).mul(bodyLit), step(0.7, abs(nl.z)).mul(float(1).sub(front)).mul(float(1).sub(rear)));
  const body = new THREE.Mesh(bodyGeometry, unlit(hazed(bodyColour, p)));
  // Underneath, dark; and (the same mesh) the roof's housings: galvanised steel, louvred down their sides, two fan grilles in each top.
  const unit = cz.sub(2.0);
  const fanC = mix(float(0.65), float(1.95), step(1.3, fract(unit.div(LEN - 6.6)).mul(LEN - 6.6)));
  const fanAt = vec2(lx, fract(unit.div(LEN - 6.6)).mul(LEN - 6.6).sub(fanC));
  const fan = step(length(fanAt), 0.36).mul(step(0.5, nl.y)).mul(step(4.1, ly));
  const louvre = step(0.5, fract(ly.mul(40))).mul(step(0.5, abs(nl.x)));
  const roofKit = vec3(0.3, 0.31, 0.32).mul(float(1).sub(louvre.mul(0.35))).mul(float(1).sub(fan.mul(step(0.5, fract(length(fanAt).mul(28)))).mul(0.6))).mul(streaks.mul(0.4).add(0.7));
  const onRoof = step(3.8, ly);
  const underMaterial = unlit(hazed(mix(vec3(0.035, 0.033, 0.03), roofKit, onRoof).mul(light(n, onRoof.mul(0.2).add(0.2), true)), p));
  train.add(body, new THREE.Mesh(underGeometry, underMaterial));

  // The headlights' beam in the dusty air ahead of it: a long soft cone, brightest at the lamps, fading out along its
  // length and toward its edges.
  const glareGeometry = new THREE.ConeGeometry(2.6, 34, 24, 1, true);
  glareGeometry.rotateX(-Math.PI / 2);
  glareGeometry.translate(0, 1.2, 17.1);
  const glareMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const beamAlong = uv().y;
  const facing = abs(dot(normalize(positionView), normalView));
  glareMaterial.colorNode = vec3(1.0, 0.94, 0.82).mul(head).mul(pow(beamAlong, 1.6).mul(0.15).add(pow(beamAlong, 30).mul(0.8))).mul(facing.mul(facing));
  glareMaterial.depthNode = shallow;
  materials.push(glareMaterial);
  train.add(new THREE.Mesh(glareGeometry, glareMaterial));

  // ------------------------------------------------------------------------------------------------- The sound
  // The rumble of a train coming through: low noise swelling as it nears, holding while it passes and dying away.
  let noise: AudioBuffer | null = null;
  const rumble = () =>
    sound.custom((context, out, at) => {
      if (!noise || noise.sampleRate !== context.sampleRate) {
        noise = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
        const data = noise.getChannelData(0);
        let b = 0;
        for (let i = 0; i < data.length; i++) {
          b = (b + 0.04 * (Math.random() * 2 - 1)) / 1.02;
          data[i] = b * 3;
        }
      }
      const source = context.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      const low = context.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.setValueAtTime(90, at);
      low.frequency.linearRampToValueAtTime(420, at + 3.2);
      low.frequency.linearRampToValueAtTime(260, at + 8);
      low.frequency.linearRampToValueAtTime(80, at + 11);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.7, at + 3.2);
      gain.gain.setValueAtTime(0.7, at + 8);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 11);
      source.connect(low);
      low.connect(gain);
      gain.connect(out);
      source.start(at);
      source.stop(at + 11.1);
    });
  // Where the trucks' wheels are, back from the nose, for the clack of each over a rail joint under the hole.
  const trucks: number[] = [];
  for (let c = 0; c < CARS; c++) trucks.push(c * PITCH + 1.5, c * PITCH + 3.3, c * PITCH + LEN - 3.3, c * PITCH + LEN - 1.5);
  let last = 0;

  // The shade lies a hair under the paving: its hole is the edge carried on along the artist's sight lines to that
  // depth, so from the spot the two line up exactly and no sliver of the station shows past the edge in the chalk.
  const shade = shadeFor(edge.map((at) => at.clone().sub(EYE).multiplyScalar((EYE.y + 0.005) / EYE.y).add(EYE)));
  materials.push(shade.material);
  const restEdge = edgeColour.value.clone();
  const amber = new THREE.Color(2.6, 1.2, 0.12);
  const amberOff = new THREE.Color(0.2, 0.09, 0.015);
  return {
    real,
    shade: shade.mesh,
    edge,
    extent: edge,
    covers: footprint(edge),
    inside: inHole,
    animate: (t) => {
      // Once real: the tubes wake into their flicker, and the train comes, the edge lamps blinking amber and its
      // headlights sweeping along the far wall; it rushes through under the hole and away.
      time.value = t;
      wake.value = wakeAt(t);
      const run = trainAt(t);
      nose.value = run.nose;
      const on = run.running ? THREE.MathUtils.smoothstep(run.s, 0, 0.8) : 0;
      head.value = on;
      // It rocks a little on the rails as it goes.
      train.position.set(run.nose, RAIL, TRACK + on * 0.012 * Math.sin(t * 2.3 + 1));
      train.rotation.set(0, Math.PI / 2, on * 0.006 * Math.sin(t * 3.1));
      const coming = run.running && run.nose - TRAIN < 8;
      const blink = Math.sin(run.s * Math.PI * 2 * 1.4) > 0;
      edgeColour.value.copy(coming ? (blink ? amber : amberOff) : restEdge);
      // The signal: green until the nose passes it, then red until a few seconds after it is gone, yellow a while,
      // and green.
      const since = run.s - (SIGNAL.x - RUN.from) / RUN.speed;
      const shown = t < RUN.start || since < 0 ? 0 : since < (RUN.to - RUN.from) / RUN.speed - (SIGNAL.x - RUN.from) / RUN.speed + 3 ? 2 : since < 16 ? 1 : 0;
      if (aspect.value !== shown) {
        aspect.value = shown;
        aspectColour.value.setRGB(...([[0.1, 1, 0.45], [1, 0.62, 0.08], [1, 0.06, 0.04]][shown] as [number, number, number]));
      }
      // The tubes sag a little as it draws its power through the station.
      dip.value = 1 - on * 0.08 * THREE.MathUtils.smoothstep(run.nose, -ENDS - 10, -ENDS + 10) * (1 - THREE.MathUtils.smoothstep(run.nose - TRAIN, ENDS - 10, ENDS + 10));
      // Sound, only while the clock runs on (not on a jump).
      if (t > last && t - last < 0.3) {
        const was = trainAt(last);
        if (run.running && was.nose < -55 && run.nose >= -55) rumble();
        if (run.running && was.nose < -6 && run.nose >= -6) sound.play("whoosh", { gain: 0.6, pitch: 0.45, size: 1 });
        if (run.running && was.running)
          trucks.forEach((b) => {
            if (was.nose - b < 0 && run.nose - b >= 0) sound.play("thud", { gain: 0.16, pitch: 1.6, size: 0.2, gap: 0.05 });
          });
      }
      last = t;
    },
    geometries: [tileGeometry, concreteGeometry, benchGeometry, bedGeometry, tieGeometry, railGeometry, columnGeometry, lampGeometry, shaftGeometry, bodyGeometry, underGeometry, glareGeometry, shade.geometry],
    materials
  };
}
