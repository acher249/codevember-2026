/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { attribute, color, float, mix, normalize, smoothstep, transformNormalToView, uniform, uniformArray, varying, vec4 } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { lehmer } from "../../shared/engine/random";
import { downGeometry, downMaterial, tuftsOnEllipsoid } from "./down";
import type { Lighting } from "./light";

export type ChickLook = {
  // Body radii, head radius, beak size.
  body: [number, number, number];
  head: number;
  beak: number;
  // Down: root and tip colours, length, how thick; skin showing between.
  root: string;
  tip: string;
  skin: string;
  down: number;
  density: number;
  // The gape: the flanges at the corners of the mouth and the mouth inside.
  flange: string;
  mouth: string;
  bill: string;
  gape: number;
  eye: number;
  speckle: number;
};

// Songbird nestlings a week or so old: soft grey down, pale tips, yellow flanges.
export const CHICK: ChickLook = {
  body: [2.35, 2.2, 2.6],
  head: 1.55,
  beak: 0.9,
  root: "#7d746b",
  tip: "#efe9e1",
  skin: "#d9b8a8",
  down: 0.68,
  density: 1.7,
  flange: "#ffd84a",
  // The beak's inside faces: a warm, paler yellow-orange; behind them the throat is a dark hole.
  mouth: "#f2b048",
  bill: "#e8c470",
  gape: 0.9,
  eye: 0.44,
  speckle: 0
};

// A nestling: a fluffy body, a neck of two fluffy beads, a big head with a wide gape (soft swollen flanges at the
// corners of the beak, bright inside), and two stubby downy wings. How warm the nest is sets its mood: cold, it puffs
// into a tight ball, head sunk, eyes shut, shivering; warming, it loosens and stretches; just right, it fluffs out, looks
// about and peeps, or dozes; too hot, it pants with its beak open and fans its wings.

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// One mandible: a curved plate from its base (z 0) to its tip, rounded on the outside, flat on the mouth side, thick
// and soft at the corners (the flanges). Coloured by vertex: bill outside, mouth inside, flange at the rim. `down` makes
// it the lower one.
function mandible(length: number, width: number, look: ChickLook, lower: boolean) {
  const U = 10;
  const V = 14;
  const position: number[] = [];
  const colours: number[] = [];
  const index: number[] = [];
  const bill = new THREE.Color(look.bill);
  const mouth = new THREE.Color(look.mouth);
  const flange = new THREE.Color(look.flange);
  const s = lower ? -1 : 1;
  const c = new THREE.Color();
  for (const face of [0, 1]) {
    for (let i = 0; i <= U; i++) {
      const u = i / U;
      for (let j = 0; j <= V; j++) {
        const v = (j / V) * 2 - 1;
        const half = (width / 2) * Math.pow(1 - u, 0.75) * (1 + 0.25 * Math.max(0, 0.3 - u) / 0.3) + 0.02;
        const x = v * half;
        // The flange: a soft swelling along the edge near the base.
        const rim = Math.pow(Math.abs(v), 4) * Math.max(0, 1 - u * 1.4);
        const dome = Math.sqrt(Math.max(0, 1 - v * v)) * length * 0.32 * (1 - u * 0.7);
        const y = face === 0 ? dome + rim * 0.2 : -rim * 0.12 + Math.sqrt(Math.max(0, 1 - v * v)) * 0.03;
        position.push(x, s * y, u * length);
        if (face === 0) c.copy(bill).lerp(flange, Math.min(1, rim * 1.6 + Math.max(0, 0.25 - u) * 2 * Math.pow(Math.abs(v), 2)));
        else c.copy(mouth).lerp(flange, Math.min(1, rim * 2 + Math.pow(Math.abs(v), 4) * 0.8));
        colours.push(c.r, c.g, c.b);
      }
    }
  }
  const row = V + 1;
  const plane = (U + 1) * row;
  for (let i = 0; i < U; i++)
    for (let j = 0; j < V; j++) {
      const a = i * row + j;
      // The outside faces away from the mouth, the mouth side into it (checked: the dome's normals point away from the
      // mouth on both).
      if (!lower) {
        index.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
        index.push(plane + a, plane + a + 1, plane + a + row, plane + a + 1, plane + a + row + 1, plane + a + row);
      } else {
        index.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
        index.push(plane + a, plane + a + row, plane + a + 1, plane + a + 1, plane + a + row, plane + a + row + 1);
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// Where each lens sits, in head radii from the head's middle: in front of the eyes, a little out on the down.
const LENSES = [v3(-0.55, 0.34, 0.98), v3(0.55, 0.34, 0.98)];

// Tiny sunglasses for a head of radius `hr`: two round dark lenses in a thin black frame, a bridge, arms back over the
// head. One geometry, the frame and lenses told apart by a vertex colour's alpha.
function sunglasses(hr: number) {
  const parts: THREE.BufferGeometry[] = [];
  const lens = hr * 0.44;
  const tagged = (g: THREE.BufferGeometry, glass: number) => {
    g.deleteAttribute("uv");
    const n = g.getAttribute("position").count;
    g.setAttribute("aGlass", new THREE.Float32BufferAttribute(new Float32Array(n).fill(glass), 1));
    return g;
  };
  // The eyes sit well round the sides of a chick's head, so the lenses wrap round with it: each turned out a little
  // and set in front of its eye. Built in the head's own frame.
  for (const s of [-1, 1]) {
    const at = new THREE.Matrix4().compose(LENSES[s < 0 ? 0 : 1].clone().multiplyScalar(hr), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, s * 0.55, 0)), v3(1, 1, 1));
    // The lens: a dark disc, slightly domed.
    const glass = new THREE.SphereGeometry(lens * 2.2, 24, 4, 0, Math.PI * 2, 0, 0.47);
    glass.rotateX(Math.PI / 2);
    glass.translate(0, 0, -lens * 2.2 * Math.cos(0.47));
    glass.applyMatrix4(at);
    parts.push(tagged(glass, 1));
    const rim = new THREE.TorusGeometry(lens * 1.0, lens * 0.065, 6, 32);
    rim.applyMatrix4(at);
    parts.push(tagged(rim, 0));
    // The arm, from the outer edge of the frame back along the side of the head.
    // Short, and angled in so it disappears into the down beside the head rather than sticking out past it.
    const arm = new THREE.CylinderGeometry(lens * 0.05, lens * 0.05, hr * 0.6, 6);
    arm.rotateX(Math.PI / 2);
    arm.translate(0, 0, -hr * 0.3);
    arm.rotateY(-s * 0.35);
    arm.translate(s * hr * 0.92, hr * 0.4, hr * 0.78);
    parts.push(tagged(arm, 0));
  }
  const bridge = new THREE.TorusGeometry(hr * 0.14, lens * 0.06, 6, 12, Math.PI);
  bridge.translate(0, hr * 0.4, hr * 1.12);
  parts.push(tagged(bridge, 0));
  const geometry = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  // Thin black metal frames; the lenses dark tinted glass, a gradient from near black at the top to smoky brown below,
  // glossy enough to carry the sky and the light, with a faint oil-slick sheen of a coated lens.
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.25, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 1, iridescenceIOR: 1.7 });
  const glassA = attribute("aGlass", "float") as any;
  const fall = smoothstep(hr * 0.55, hr * 0.05, (attribute("position", "vec3") as any).y) as any;
  m.colorNode = mix(color("#18181b"), mix(color("#040406"), color("#2a1a10"), fall), glassA) as any;
  m.roughnessNode = mix(float(0.3), float(0.03), glassA) as any;
  m.metalnessNode = mix(float(0.85), float(0), glassA) as any;
  m.iridescenceNode = glassA.mul(0.45) as any;
  return { geometry, materials: [m] as THREE.Material[], material: m };
}

// The moving parts of a chick, each placed by its own matrix: every chick's parts are drawn together, one draw per
// material for the whole brood, each vertex finding its part's matrix by index.
const PARTS = ["body", "head", "bead0", "bead1", "wing0", "wing1", "eye0", "eye1", "lid0", "lid1", "top", "jaw", "throat"] as const;
const P = PARTS.length;
const part = (name: (typeof PARTS)[number]) => PARTS.indexOf(name);

// A part's matrix, for the vertex being drawn. Built fresh for each use.
const partMatrix = (parts: any) => parts.element((attribute("aPart", "float") as any).toInt()) as any;

// Place a material's vertices and normals by their part's matrix (the mesh itself sits at the origin).
function placed(m: THREE.MeshStandardNodeMaterial, parts: any) {
  m.positionNode = partMatrix(parts).mul(vec4(attribute("position", "vec3"), 1)).xyz as any;
  const n = varying(partMatrix(parts).mul(vec4(attribute("normal", "vec3"), 0)).xyz) as any;
  m.normalNode = transformNormalToView(normalize(n)) as any;
  return m;
}

// Everything the chicks share: geometry, materials, and one mesh per material drawing all `count` of them.
// `detail` scales how many tufts the down has (fewer on a slow machine).
export function chickKit(look: ChickLook, l: Lighting, seed: number, detail = 1, count = 3) {
  const matrices = Array.from({ length: count * P }, () => new THREE.Matrix4());
  // How far each chick has its sunglasses on, to press its down flat under them.
  const wearing = new Array(count).fill(0);
  // Each chick's head frame (world to head) and how wide its beak is open, so no down shows inside the open mouth.
  const heads = Array.from({ length: count }, () => new THREE.Matrix4());
  const gapes = new Array(count).fill(0);
  const parts = uniformArray(matrices, "mat4");
  const random = lehmer(seed);
  const [bx, by, bz] = look.body;
  const hr = look.head;
  const back = v3(0, -0.3, -1);
  const per = 9 * look.density * detail;
  const area = (r: THREE.Vector3) => 4 * Math.PI * Math.pow((r.x * r.y + r.y * r.z + r.x * r.z) / 3, 1);
  const bodyRadii = v3(bx, by, bz);
  const speckle = (u: THREE.Vector3) => (look.speckle > 0 && u.z > -0.2 && u.y < 0.4 && random() < 0.22 * look.speckle ? 0.45 : 1);
  // Many small tufts of few barbs: a soft even coat, not a field of little stars.
  const bodyTufts = tuftsOnEllipsoid(random, Math.round(area(bodyRadii) * per * 1.6), bodyRadii, v3(0, 0, 0), {
    length: look.down,
    spread: 1.45,
    barbs: 7,
    back,
    keep: v3(0, 1, 0),
    cut: -0.55,
    tone: (u) => speckle(u)
  });
  const headTufts = tuftsOnEllipsoid(random, Math.round(area(v3(hr, hr, hr)) * per * 2.6), v3(hr, hr, hr), v3(0, 0, 0), {
    length: look.down * 0.8,
    spread: 1.2,
    barbs: 6,
    back: v3(0, 0.2, -1),
    keep: v3(0, 0, -1),
    cut: -1.01,
    // Wisps standing up off the crown.
    longer: (u) => 1 + Math.max(0, u.y - 0.4) * 2.2
  });
  const beadR = hr * 0.72;
  const beadTufts = tuftsOnEllipsoid(random, Math.round(area(v3(beadR, beadR, beadR)) * per), v3(beadR, beadR, beadR), v3(0, 0, 0), { length: look.down * 0.8, spread: 0.9, barbs: 8, back: v3(0, -1, -0.3) });
  // A wing: a flat downy paddle, hinged at its front top corner on the body's side, lying back along the flank.
  const wingR = v3(0.34, bx * 0.55, bz * 0.6);
  const wingTufts = tuftsOnEllipsoid(random, Math.round(area(wingR) * per * 1.3), wingR, v3(0, -wingR.y * 0.8, -wingR.z * 0.75), { length: look.down * 0.7, spread: 0.9, barbs: 9, back: v3(0, -0.6, -1) });
  const width = 0.024;
  const bodyDown = downGeometry(bodyTufts, random, width);
  const headDown = downGeometry(headTufts, random, width);
  const beadDown = downGeometry(beadTufts, random, width);
  const wingDown = downGeometry(wingTufts, random, width);
  // How far the down stands out: puffed in the cold, sleek in the heat. Shared by every chick.
  const fluff = uniform(1);
  const down = downMaterial(l, { root: look.root, tip: look.tip }, l.clock, fluff, parts, { wear: uniformArray(wearing, "float"), part: part("head"), P, lenses: LENSES.map((p) => p.clone().normalize()) }, { heads: uniformArray(heads, "mat4"), gapes: uniformArray(gapes, "float"), count, base: new THREE.Vector3(0, -hr * 0.2, hr * 0.86), beak: look.beak });

  // The skin under the down: pale and warm, darker toward the root colour where the coat is thick.
  const skin = placed(new THREE.MeshStandardNodeMaterial({ roughness: 0.85 }), parts);
  skin.colorNode = mix(color(look.root), color(look.tip), 0.35) as any;
  const body = new THREE.SphereGeometry(1, 28, 20);
  body.scale(bx * 0.97, by * 0.97, bz * 0.97);
  const head = new THREE.SphereGeometry(hr * 0.97, 26, 18);
  const bead = new THREE.SphereGeometry(beadR * 0.97, 18, 12);
  // Eyes: dark and glossy, a ring of skin round each.
  const eye = placed(new THREE.MeshPhysicalNodeMaterial({ roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.04 }), parts);
  {
    const d = normalize(attribute("position", "vec3")) as any;
    eye.colorNode = mix(color("#2a1a12"), color("#020101"), smoothstep(0.55, 0.75, d.z)) as any;
  }
  const eyeGeometry = new THREE.SphereGeometry(look.eye, 20, 14);
  const lidGeometry = new THREE.SphereGeometry(look.eye * 1.12, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const lid = placed(new THREE.MeshStandardNodeMaterial({ roughness: 0.8 }), parts);
  // Shut, the eye is a crease in the down.
  lid.colorNode = mix(color(look.root), color(look.tip), 0.4) as any;
  const upper = mandible(look.beak, look.beak * 2.1, look, false);
  const lower = mandible(look.beak * 0.92, look.beak * 2.0, look, true);
  const bill = placed(new THREE.MeshStandardNodeMaterial({ roughness: 0.4 }), parts);
  bill.colorNode = attribute("color", "vec3") as any;
  // The dark inside of the mouth takes no shine, so it reads as depth; the bill outside keeps its gloss.
  bill.roughnessNode = mix(float(1), float(0.4), smoothstep(0.02, 0.12, (attribute("color", "vec3") as any).r)) as any;
  // The throat: big enough to fill the open gape with dark, not the face's skin.
  const throat = new THREE.SphereGeometry(look.beak * 0.6, 16, 12);
  throat.scale(1.1, 0.9, 1);
  const gullet = placed(new THREE.MeshStandardNodeMaterial({ roughness: 0.6 }), parts);
  gullet.colorNode = color("#030101") as any;
  gullet.roughnessNode = float(1) as any;
  const wingCore = new THREE.SphereGeometry(1, 16, 12);
  wingCore.scale(wingR.x * 0.8, wingR.y * 0.85, wingR.z * 0.85);
  wingCore.translate(0, -wingR.y * 0.8, -wingR.z * 0.75);
  const shades = sunglasses(hr);

  // Every chick's copy of each piece, tagged with its part, merged by material.
  const brood = (pieces: [THREE.BufferGeometry, (typeof PARTS)[number]][]) => {
    const copies: THREE.BufferGeometry[] = [];
    for (let c = 0; c < count; c++)
      for (const [g, name] of pieces) {
        const copy = g.clone();
        if (copy.getAttribute("uv")) copy.deleteAttribute("uv");
        copy.setAttribute("aPart", new THREE.Float32BufferAttribute(new Float32Array(copy.getAttribute("position").count).fill(c * P + part(name)), 1));
        copies.push(copy);
      }
    const merged = mergeGeometries(copies);
    for (const g of copies) g.dispose();
    return merged;
  };
  const pieces = [
    { g: brood([[body, "body"], [head, "head"], [bead, "bead0"], [bead, "bead1"], [wingCore, "wing0"], [wingCore, "wing1"]]), m: skin, shadow: true },
    { g: brood([[bodyDown, "body"], [headDown, "head"], [beadDown, "bead0"], [beadDown, "bead1"], [wingDown, "wing0"], [wingDown, "wing1"]]), m: down, shadow: false },
    { g: brood([[eyeGeometry, "eye0"], [eyeGeometry, "eye1"]]), m: eye, shadow: false },
    { g: brood([[lidGeometry, "lid0"], [lidGeometry, "lid1"]]), m: lid, shadow: false },
    { g: brood([[upper, "top"], [lower, "jaw"]]), m: bill, shadow: false },
    { g: brood([[throat, "throat"]]), m: gullet, shadow: false }
  ];
  const meshes = pieces.map(({ g, m, shadow }) => {
    const mesh = new THREE.Mesh(g, m);
    // Placed in the shader, so its bounds mean nothing here.
    mesh.frustumCulled = false;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    return mesh;
  });
  for (const g of [bodyDown, headDown, beadDown, wingDown, wingCore, body, head, bead, eyeGeometry, lidGeometry, upper, lower, throat]) g.dispose();
  return {
    look,
    matrices,
    wearing,
    heads,
    gapes,
    meshes,
    fluff,
    shades,
    geometries: [...pieces.map((p) => p.g), shades.geometry],
    materials: [down, skin, eye, lid, bill, gullet, ...shades.materials]
  };
}

export type ChickKit = ReturnType<typeof chickKit>;

// How the nest feels to the chicks, each 0 to 1: cold, just right, too hot.
export type Mood = { cold: number; happy: number; hot: number };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
// How long each kind of chirp lasts, in seconds; the sound plays the same.
export const CHIRP_LENGTH = [0.16, 0.32, 0.42];
const scratch = { a: new THREE.Vector3(), b: new THREE.Vector3() };

// Points round the wing's edge, as sines and cosines about the middle of its paddle: down, back and between.
const WING_EDGE = [[-1, 0], [-0.7, -0.7], [0, -1], [-0.7, 0.7]];

export class Chick {
  group = new THREE.Group();
  body = new THREE.Group();
  head = new THREE.Group();
  beads: THREE.Group[] = [];
  jaw = new THREE.Group();
  top = new THREE.Group();
  wings: THREE.Group[] = [];
  lids: THREE.Object3D[] = [];
  private slots: THREE.Object3D[] = [];
  private index: number;
  shades: THREE.Mesh | null = null;
  // Whether a point in the world is clear of the nest: set by the scene, and the wings fold in to stay clear of it.
  clear: ((p: THREE.Vector3) => boolean) | null = null;
  gape = 0;
  pulse = 0;
  // Set for a frame when it peeps, and when it breathes out (for the puff of breath in the cold).
  peeps = 0;
  breathed = false;
  pitch: number;
  // Asleep, once the nest has been just right a while; only the sleepy one does.
  doze = false;
  private sleepy: boolean;
  private kit: ChickKit;
  private random: () => number;
  private nextPeep = 2;
  private nextBlink = 2;
  private blink = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private time = 0;
  private wanderAt = 0;
  private wander = new THREE.Vector2();
  private comfy = 0;
  private stretch = 0;
  private warmed = false;
  private breath = 0;
  private wear = 0;
  private shadesAt = 0.5;
  private hop = 0;
  // The chirp being sung (-1 a thin peep, 0 one note, 1 two, 2 a trill) and how far into it.
  chirp = -1;
  chirpTime = 9;
  // For checking the mouth in development: hold the beak this far open.
  wide = 0;
  private hopVel = 0;

  // `index` is this chick's place among the brood the kit draws.
  constructor(kit: ChickKit, index: number, seed: number, sleepy: boolean, glasses: boolean) {
    this.kit = kit;
    this.index = index;
    this.random = lehmer(seed);
    this.sleepy = sleepy;
    this.pitch = 0.9 + this.random() * 0.25;
    this.time = this.random() * 10;
    this.breath = this.random() * 3;
    this.shadesAt = 0.3 + index * 0.22 + this.random() * 0.08;
    const [bx, by, bz] = kit.look.body;
    this.group.add(this.body);
    this.body.position.y = by * 0.85;
    // The wings, hinged high on each flank; the paddle is the same either side, so neither is mirrored.
    for (const s of [1, -1]) {
      const w = new THREE.Group();
      w.position.set(s * bx * 0.86, by * 0.3, bz * 0.3);
      w.userData.side = s;
      this.body.add(w);
      this.wings.push(w);
    }
    for (let k = 0; k < 2; k++) {
      const b = new THREE.Group();
      this.group.add(b);
      this.beads.push(b);
    }
    this.group.add(this.head);
    const hr = kit.look.head;
    // Eyes, set wide on the head and a touch forward.
    const eyes: THREE.Object3D[] = [];
    for (const s of [1, -1]) {
      const dir = v3(s * 0.78, 0.32, 0.55).normalize();
      const e = new THREE.Object3D();
      e.position.copy(dir).multiplyScalar(hr * 0.9);
      e.quaternion.setFromUnitVectors(v3(0, 0, 1), dir);
      this.head.add(e);
      eyes.push(e);
      const lid = new THREE.Object3D();
      // The lid closes down over the eye from above: a half shell turned about the eye's own side axis.
      lid.rotation.x = -Math.PI / 2;
      e.add(lid);
      this.lids.push(lid);
    }
    // The beak at the front of the head, the jaw hinged under it, and the throat behind.
    const beakAt = v3(0, -hr * 0.2, hr * 0.86);
    this.top.position.copy(beakAt);
    this.head.add(this.top);
    this.jaw.position.copy(beakAt).add(v3(0, -0.04, -0.02));
    this.head.add(this.jaw);
    const throat = new THREE.Object3D();
    throat.position.copy(beakAt).add(v3(0, -0.14, -0.28));
    this.head.add(throat);
    // Sunglasses, for the one who wears them when it gets hot: across the eyes, over the top of the beak.
    if (glasses) {
      const g = new THREE.Mesh(kit.shades.geometry, kit.shades.material);
      g.receiveShadow = true;
      g.visible = false;
      this.head.add(g);
      this.shades = g;
    }
    this.slots = [this.body, this.head, this.beads[0], this.beads[1], this.wings[0], this.wings[1], eyes[0], eyes[1], this.lids[0], this.lids[1], this.top, this.jaw, throat];
    this.pose({ cold: 1, happy: 0, hot: 0 }, 0);
    this.sync();
  }

  // Chirp back soon, if warm enough to chirp at all.
  answer(after: number) {
    this.nextPeep = Math.min(this.nextPeep, after * 2);
  }

  // Hand the parts' places to the shared meshes.
  sync() {
    this.group.updateWorldMatrix(true, true);
    const at = this.index * P;
    for (let k = 0; k < P; k++) this.kit.matrices[at + k].copy(this.slots[k].matrixWorld);
    this.kit.heads[this.index].copy(this.head.matrixWorld).invert();
    this.kit.gapes[this.index] = this.gape;
  }

  // Place everything for the mood and the moment.
  private pose(mood: Mood, t: number) {
    const k = this.kit.look;
    const [bx, by, bz] = k.body;
    const hr = k.head;
    const cold = mood.cold;
    // A stretch: neck up and wings out for a moment, once, as the warmth first comes through.
    const st = this.stretch > 0 ? Math.sin(clamp01(1 - this.stretch / 1.6) * Math.PI) : 0;
    // Shivering: a fast tremble of the whole bird, worse the colder.
    const shiver = cold * (Math.sin(t * 47 + this.pitch * 20) * 0.6 + Math.sin(t * 31.3 + this.pitch * 7) * 0.4) * 0.05;
    const doze = this.doze ? 1 : 0;
    // Breathing; quick and shallow in the cold, slow asleep.
    const breathe = 1 + Math.sin(t * (doze ? 1.5 : 2.6 + cold * 2) + this.pitch * 9) * (0.018 + doze * 0.01);
    const puff = 1 + cold * 0.1;
    this.body.scale.set(breathe * puff * 1.03, breathe * puff, breathe * puff);
    // A happy chick bobs up a little with each peep.
    const hop = this.hop;
    this.body.position.set(shiver, by * 0.85 - cold * 0.15 + hop * 0.35, 0);
    // The base of the neck, high on the front of the body.
    const base = scratch.a.set(shiver, by * 0.85 + by * 0.62 - cold * 0.3, bz * 0.42);
    // Where the head goes: sunk into the shoulders when cold, up and about when warm, up high in a stretch or a pant.
    const lift = st * 1 + mood.hot * 0.35;
    const head = this.head.position.set(
      this.wander.x * 0.3 * (1 - cold) + shiver * 1.2,
      hop * 0.45 + by * 0.85 + by * 0.95 - cold * hr * 0.55 - doze * 0.3 + lift * hr * 0.9,
      bz * 0.75 + hr * 0.25 - cold * 0.7 - lift * 0.3
    );
    for (let i = 0; i < 2; i++) {
      const s = (i + 1) / 3;
      const p = this.beads[i].position.lerpVectors(base, head, s);
      p.z += Math.sin(s * Math.PI) * 0.25;
      this.beads[i].scale.setScalar(THREE.MathUtils.lerp(0.95, 0.88, s) * (1 - cold * 0.25));
    }
    // The head's turn: tucked down and still in the cold, looking about when warm, nodding off asleep, beak up to pant.
    const pitch = THREE.MathUtils.lerp(-0.25 + this.lookPitch, 0.35, cold) + doze * 0.45 - st * 0.6 - mood.hot * 0.25;
    this.head.rotation.set(pitch, this.lookYaw * (1 - cold * 0.8), shiver * 0.6 + doze * 0.12, "YXZ");
    this.jaw.rotation.x = this.gape * 1.05;
    this.top.rotation.x = -this.gape * 0.32;
    // Wings: clamped tight in the cold, resting when warm, out wide in a stretch, fanning when hot.
    const fan = mood.hot * (0.75 + Math.sin(t * 15 + this.pitch * 3) * 0.45);
    for (const w of this.wings) {
      const s = w.userData.side as number;
      const rest = 0.06 - cold * 0.08;
      const out = Math.max(st * 1.3, fan) + rest;
      w.rotation.set(-st * 0.4, 0, s * out, "XYZ");
      // Never through the nest: if the wing's edge would be out through the wall, it flaps higher instead, up over the
      // rim, at the least lift that clears it. Only if no angle up there is clear does it fold in, never tighter than
      // at rest.
      if (this.clear && out > rest && !this.wingClear(w)) {
        let up = -1;
        for (let a = out + 0.15; a <= 2.6; a += 0.15) {
          w.rotation.z = s * a;
          if (this.wingClear(w)) {
            up = a;
            break;
          }
        }
        let lo = up < 0 ? rest : up - 0.15;
        let hi = up < 0 ? out : up;
        // Bisect for the edge: the clear end is `hi` going up, `lo` folding in.
        for (let n = 0; n < 5; n++) {
          const mid = (lo + hi) / 2;
          w.rotation.z = s * mid;
          if (this.wingClear(w) === (up >= 0)) {
            if (up >= 0) hi = mid;
            else lo = mid;
          } else if (up >= 0) lo = mid;
          else hi = mid;
        }
        // Lifted, it keeps flapping on top of the lift, higher still, rather than holding still at it.
        w.rotation.z = s * (up >= 0 ? Math.min(2.6, hi + (out - rest) * 0.45) : lo);
      }
    }
    // Eyelids: a blink now and then, squeezed in the cold, shut asleep.
    const shut = Math.max(this.blink, cold * 0.9, doze, st * 0.7);
    for (const lid of this.lids) lid.rotation.x = -Math.PI / 2 + shut * 2.95;
    // The shades pop on, a little big at first.
    if (this.shades) {
      const s = this.wear;
      this.shades.visible = s > 0.01;
      this.shades.scale.setScalar(Math.max(0.001, s * (1 + Math.sin(s * Math.PI) * 0.25)));
      this.kit.wearing[this.index] = s;
    }
    void bx;
  }

  // Whether a wing's edge, from its hinge round the bottom to the back, is clear of the nest.
  private wingClear(w: THREE.Group) {
    const [bx, , bz] = this.kit.look.body;
    const ry = bx * 0.55;
    const rz = bz * 0.6;
    const tuft = this.kit.look.down * 0.7;
    w.updateWorldMatrix(true, false);
    for (const [y, z] of WING_EDGE) {
      const p = scratch.b.set(0, -ry * 0.8 + y * (ry * 0.85 + tuft), -rz * 0.75 + z * (rz * 0.85 + tuft)).applyMatrix4(w.matrixWorld);
      if (!this.clear!(p)) return false;
    }
    return true;
  }

  // Step on by dt with the nest's mood; `at` is a point in the chick's frame to look toward, or null to look about.
  step(dt: number, mood: Mood, at: THREE.Vector3 | null) {
    const r = this.random;
    this.time += dt;
    const t = this.time;
    this.peeps = 0;
    this.breathed = false;

    // Comfort builds while the nest is just right; the sleepy one nods off after a while, and wakes if it changes.
    this.comfy = mood.happy > 0.6 ? this.comfy + dt : Math.max(0, this.comfy - dt * 4);
    if (this.sleepy && this.comfy > 5) this.doze = true;
    if (mood.happy < 0.4) this.doze = false;
    // The first warmth: a big stretch. It comes again only after the nest has been cold.
    if (!this.warmed && mood.cold < 0.35) {
      this.warmed = true;
      this.stretch = 1.6 + r() * 0.3;
    }
    if (mood.cold > 0.8) this.warmed = false;
    this.stretch = Math.max(0, this.stretch - dt);
    // The shades: on when it is properly hot, off again when it cools.
    // Each puts them on at its own moment as it gets hot, and takes them off as it cools.
    this.wear += ((mood.hot > this.shadesAt ? 1 : 0) - this.wear) * (1 - Math.exp(-dt * 7));

    // Peeps: happy chirps now and then when comfortable, thin ones when chilly, none when frozen stiff or asleep.
    // Cold: thin, quiet peeps now and then (none frozen stiff). Warm: cheerful chirps, more often the warmer it is,
    // still between pants when hot. Asleep: nothing.
    const cheer = Math.max(mood.happy, mood.hot * 0.7);
    const chatty = this.doze ? 0 : cheer * (1.6 + mood.happy * 1.4) + (1 - mood.cold) * (1 - cheer) * 0.4;
    this.nextPeep -= dt * chatty;
    if (this.nextPeep <= 0) {
      this.peeps = 1;
      this.pulse = 1;
      this.nextPeep = 1.2 + r() * 3.5;
      // A chirp's shape: one rising note, a quick two, or a trill; the beak follows it.
      this.chirp = cheer > 0.3 ? (r() < 0.45 ? 0 : r() < 0.6 ? 1 : 2) : -1;
      this.chirpTime = 0;
    }
    this.pulse = Math.max(0, this.pulse - dt * 6);
    this.chirpTime += dt;
    // The bob: up quick on a happy peep, down soft.
    const lift = this.peeps && cheer > 0.3 ? 1 : 0;
    if (lift) this.hopVel = 3.2;
    this.hopVel -= dt * 22;
    this.hop = Math.max(0, this.hop + this.hopVel * dt);
    if (this.hop === 0) this.hopVel = Math.max(0, this.hopVel);
    // The mouth: a peep snaps it open; panting holds it a little open, quick and shallow.
    const pant = mood.hot * (0.42 + Math.abs(Math.sin(t * 9 + this.pitch * 4)) * 0.25);
    // A chirp opens the beak for each of its notes: once, twice, or fluttering through a trill.
    const length = CHIRP_LENGTH[this.chirp] ?? 0;
    let sing = 0;
    if (this.chirp >= 0 && this.chirpTime < length) {
      const notes = this.chirp === 0 ? 1 : this.chirp === 1 ? 2 : 6;
      sing = Math.abs(Math.sin((this.chirpTime / length) * notes * Math.PI)) * (this.chirp === 2 ? 0.45 : 0.75);
    }
    const peepOpen = this.chirp < 0 ? this.pulse * 0.5 * this.kit.look.gape : 0;
    const wantOpen = Math.max(peepOpen, sing * this.kit.look.gape, pant * (sing > 0 ? 0.3 : 1), this.wide);
    this.gape += (wantOpen - this.gape) * (1 - Math.exp(-dt * 18));
    // Breath: out every second and a bit.
    this.breath -= dt;
    if (this.breath <= 0) {
      this.breathed = true;
      this.breath = 1.4 + r() * 0.8;
    }
    // Blinks.
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      this.blink = 1;
      this.nextBlink = 1.8 + r() * 4;
    }
    this.blink = Math.max(0, this.blink - dt * 7);
    // Looking: at the point given, or wandering idly.
    if (t > this.wanderAt) {
      this.wanderAt = t + 1.2 + r() * 2.5;
      this.wander.set((r() - 0.5) * 1.6, (r() - 0.5) * 0.4);
    }
    let yaw = this.wander.x;
    let pitch = this.wander.y;
    if (at) {
      yaw = Math.atan2(at.x - this.head.position.x, at.z - this.head.position.z);
      pitch = -Math.atan2(at.y - this.head.position.y, Math.hypot(at.x - this.head.position.x, at.z - this.head.position.z)) * 0.8;
    }
    yaw = THREE.MathUtils.clamp(yaw, -1.2, 1.2);
    pitch = THREE.MathUtils.clamp(pitch, -0.6, 0.6);
    // Birds turn their heads in quick little steps.
    const snap = 1 - Math.exp(-dt * 9);
    this.lookYaw += (yaw - this.lookYaw) * snap;
    this.lookPitch += (pitch - this.lookPitch) * snap;
    this.pose(mood, t);
  }
}

