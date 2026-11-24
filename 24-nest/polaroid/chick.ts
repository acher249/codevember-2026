/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { attribute, color, mix, normalize, positionLocal, smoothstep, vec3 } from "three/tsl";
import { lehmer } from "../../shared/engine/random";
import { downGeometry, downMaterial, tuftsOnEllipsoid } from "./down";
import type { Lighting } from "./light";
import type { ChickLook } from "./worlds";

// A nestling: a fluffy body, a neck of two fluffy beads that stretches when it begs, and a big head with a wide gape:
// soft swollen flanges at the corners of the beak, bright inside. At rest it hunches with its head low, blinks and looks
// about; begging, it shoots its neck up, throws its head back, opens wide and wobbles, peeping.

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
      // The outside faces away from the mouth, the mouth side into it.
      if (lower) {
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

// Everything every chick in one world shares: geometry and materials.
export function chickKit(look: ChickLook, l: Lighting, seed: number) {
  const random = lehmer(seed);
  const [bx, by, bz] = look.body;
  const hr = look.head;
  const back = v3(0, -0.3, -1);
  const per = 9 * look.density;
  const area = (r: THREE.Vector3) => 4 * Math.PI * Math.pow((r.x * r.y + r.y * r.z + r.x * r.z) / 3, 1);
  const bodyRadii = v3(bx, by, bz);
  const speckle = (u: THREE.Vector3) => (look.speckle > 0 && u.z > -0.2 && u.y < 0.4 && random() < 0.22 * look.speckle ? 0.45 : 1);
  const bodyTufts = tuftsOnEllipsoid(random, Math.round(area(bodyRadii) * per), bodyRadii, v3(0, 0, 0), {
    length: look.down,
    spread: 1.2,
    barbs: 12,
    back,
    keep: v3(0, 1, 0),
    cut: -0.55,
    tone: (u) => speckle(u)
  });
  const headTufts = tuftsOnEllipsoid(random, Math.round(area(v3(hr, hr, hr)) * per * 1.1), v3(hr, hr, hr), v3(0, 0, 0), {
    length: look.down * 0.8,
    spread: 1,
    barbs: 9,
    back: v3(0, 0.2, -1),
    keep: v3(0, 0, -1),
    cut: -0.75,
    // Wisps standing up off the crown.
    longer: (u) => 1 + Math.max(0, u.y - 0.4) * 2.2
  });
  const beadR = hr * 0.72;
  const beadTufts = tuftsOnEllipsoid(random, Math.round(area(v3(beadR, beadR, beadR)) * per), v3(beadR, beadR, beadR), v3(0, 0, 0), { length: look.down * 0.8, spread: 0.9, barbs: 8, back: v3(0, -1, -0.3) });
  const width = 0.02;
  const bodyDown = downGeometry(bodyTufts, random, width);
  const headDown = downGeometry(headTufts, random, width);
  const beadDown = downGeometry(beadTufts, random, width);
  const down = downMaterial(l, { root: look.root, tip: look.tip }, l.clock);

  // The skin under the down: pale and warm, darker toward the root colour where the coat is thick.
  const skin = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  skin.colorNode = mix(color(look.skin), color(look.root), 0.8) as any;
  const body = new THREE.SphereGeometry(1, 28, 20);
  body.scale(bx * 0.97, by * 0.97, bz * 0.97);
  const head = new THREE.SphereGeometry(hr * 0.97, 26, 18);
  const bead = new THREE.SphereGeometry(beadR * 0.97, 18, 12);
  // Eyes: dark and glossy, a ring of skin round each.
  const eye = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.04 });
  {
    const d = normalize(positionLocal) as any;
    eye.colorNode = mix(color("#2a1a12"), color("#020101"), smoothstep(0.55, 0.75, d.z)) as any;
  }
  const eyeGeometry = new THREE.SphereGeometry(look.eye, 20, 14);
  const lidGeometry = new THREE.SphereGeometry(look.eye * 1.12, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const lid = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
  lid.colorNode = mix(color(look.skin), color(look.root), 0.45) as any;
  const upper = mandible(look.beak, look.beak * 2.1, look, false);
  const lower = mandible(look.beak * 0.92, look.beak * 2.0, look, true);
  const bill = new THREE.MeshStandardNodeMaterial({ roughness: 0.4 });
  bill.colorNode = attribute("color", "vec3") as any;
  const throat = new THREE.SphereGeometry(look.beak * 0.42, 16, 12);
  const gullet = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
  gullet.colorNode = color(look.mouth).mul(0.3) as any;
  void vec3;
  return {
    look,
    bodyDown,
    headDown,
    beadDown,
    down,
    skin,
    body,
    head,
    bead,
    beadR,
    eye,
    eyeGeometry,
    lidGeometry,
    lid,
    upper,
    lower,
    bill,
    throat,
    gullet,
    geometries: [bodyDown, headDown, beadDown, body, head, bead, eyeGeometry, lidGeometry, upper, lower, throat],
    materials: [down, skin, eye, lid, bill, gullet]
  };
}

export type ChickKit = ReturnType<typeof chickKit>;

const scratch = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Quaternion() };

export class Chick {
  group = new THREE.Group();
  body = new THREE.Group();
  head = new THREE.Group();
  beads: THREE.Group[] = [];
  jaw = new THREE.Group();
  top = new THREE.Group();
  lids: THREE.Mesh[] = [];
  // Begging (0 to 1, eased), its target, and the mouth.
  beg = 0;
  want = 0;
  gape = 0;
  pulse = 0;
  // Asked to beg by a tap, for this long.
  tapped = 0;
  doze: boolean;
  private kit: ChickKit;
  private random: () => number;
  private nextPeep = 0;
  private nextBlink = 2;
  private blink = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private time = 0;
  private wanderAt = 0;
  private wander = new THREE.Vector2();
  // Somewhere in the cup to look at while nothing is going on.
  peeps = 0;
  pitch: number;

  constructor(kit: ChickKit, seed: number, doze: boolean) {
    this.kit = kit;
    this.random = lehmer(seed);
    this.doze = doze;
    this.pitch = 0.9 + this.random() * 0.25;
    const [, by] = kit.look.body;
    const add = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, shadow = true) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    this.group.add(this.body);
    this.body.position.y = by * 0.85;
    add(kit.body, kit.skin, this.body);
    const fluff = add(kit.bodyDown, kit.down, this.body, false);
    fluff.frustumCulled = false;
    for (let k = 0; k < 2; k++) {
      const b = new THREE.Group();
      add(kit.bead, kit.skin, b);
      const f = add(kit.beadDown, kit.down, b, false);
      f.frustumCulled = false;
      this.group.add(b);
      this.beads.push(b);
    }
    this.group.add(this.head);
    add(kit.head, kit.skin, this.head);
    const hf = add(kit.headDown, kit.down, this.head, false);
    hf.frustumCulled = false;
    const hr = kit.look.head;
    // Eyes, set wide on the head and a touch forward.
    for (const s of [1, -1]) {
      const dir = v3(s * 0.78, 0.32, 0.55).normalize();
      const e = add(kit.eyeGeometry, kit.eye, this.head, false);
      e.position.copy(dir).multiplyScalar(hr * 0.9);
      e.quaternion.setFromUnitVectors(v3(0, 0, 1), dir);
      const lid = add(kit.lidGeometry, kit.lid, e, false);
      // The lid closes down over the eye from above: a half shell turned about the eye's own side axis.
      lid.rotation.x = -Math.PI / 2;
      this.lids.push(lid);
    }
    // The beak at the front of the head, the jaw hinged under it, and the throat behind.
    const beakAt = v3(0, -hr * 0.18, hr * 0.78);
    this.top.position.copy(beakAt);
    this.head.add(this.top);
    add(kit.upper, kit.bill, this.top, false);
    this.jaw.position.copy(beakAt).add(v3(0, -0.04, -0.02));
    this.head.add(this.jaw);
    add(kit.lower, kit.bill, this.jaw, false);
    const throat = add(kit.throat, kit.gullet, this.head, false);
    throat.position.copy(beakAt).add(v3(0, -0.12, -0.35));
    this.pose(0);
  }

  // Place the neck and head for the current begging, look and wobble.
  private pose(t: number) {
    const k = this.kit.look;
    const [bx, by, bz] = k.body;
    const hr = k.head;
    const b = THREE.MathUtils.smootherstep(this.beg, 0, 1);
    // Breathing.
    const breathe = 1 + Math.sin(t * (this.doze ? 1.6 : 2.6) + this.pitch * 9) * 0.018;
    this.body.scale.set(breathe, breathe, breathe);
    // The base of the neck, high on the front of the body.
    const base = scratch.a.set(0, by * 0.85 + by * 0.62, bz * 0.42);
    // Where the head goes: low and forward at rest, straight up and wobbling when begging.
    const wobble = Math.sin(t * 6.3 + this.pitch * 5) * 0.45 * b;
    const rest = scratch.b.set(this.wander.x * 0.3, by * 0.85 + by * 0.95 + (this.doze ? -0.25 : 0), bz * 0.75 + hr * 0.25);
    const up = scratch.c.set(wobble, by * 0.85 + by * 1.2 + hr * 2.4 * k.gape + hr * 0.7, bz * 0.3);
    this.head.position.lerpVectors(rest, up, b);
    // The beads along a soft curve from the neck's base to under the head.
    for (let i = 0; i < 2; i++) {
      const s = (i + 1) / 3;
      const p = this.beads[i].position.lerpVectors(base, this.head.position, s);
      p.z += Math.sin(s * Math.PI) * 0.25 * (1 - b);
      const r = THREE.MathUtils.lerp(0.95, 0.85 + b * 0.1, s);
      this.beads[i].scale.setScalar(r);
    }
    // The head's turn: looking about at rest; thrown back, beak to the sky, begging.
    const pitchRest = -0.25 + this.lookPitch + (this.doze ? 0.35 : 0);
    const pitchBeg = -1.15 * (0.5 + k.gape * 0.5) + Math.sin(t * 4.1) * 0.12;
    this.head.rotation.set(THREE.MathUtils.lerp(pitchRest, pitchBeg, b), THREE.MathUtils.lerp(this.lookYaw, wobble * 0.5, b), wobble * 0.3, "YXZ");
    // The mouth.
    const open = this.gape;
    this.jaw.rotation.x = open * 1.05;
    this.top.rotation.x = -open * 0.32;
    // Eyelids: a blink now and then, shut while dozing, squeezed while begging.
    const shut = Math.max(this.blink, this.doze && this.beg < 0.3 ? 1 : 0, b * 0.6);
    for (const lid of this.lids) lid.rotation.x = -Math.PI / 2 + shut * 2.95;
    void bx;
  }

  // `call` is how hard the nest is begging (Mum is here), `at` a point in the chick's frame to look toward.
  step(dt: number, call: number, at: THREE.Vector3 | null) {
    const r = this.random;
    this.time += dt;
    const t = this.time;
    this.tapped = Math.max(0, this.tapped - dt);
    if (call > 0.5 || this.tapped > 0) this.doze = false;
    this.want = Math.max(call, this.tapped > 0 ? 1 : 0);
    this.beg += (this.want - this.beg) * (1 - Math.exp(-dt * (this.want > this.beg ? 7 : 2.2)));
    // Peeps: quick and ragged while begging, the mouth snapping wider on each.
    this.peeps = 0;
    if (this.beg > 0.55) {
      this.nextPeep -= dt;
      if (this.nextPeep <= 0) {
        this.peeps = 1;
        this.pulse = 1;
        this.nextPeep = 0.13 + r() * 0.3;
      }
    } else this.nextPeep = r() * 0.2;
    this.pulse = Math.max(0, this.pulse - dt * 7);
    const wantOpen = this.beg > 0.4 ? (0.55 + this.pulse * 0.45) * this.kit.look.gape + 0.15 : 0;
    this.gape += (wantOpen - this.gape) * (1 - Math.exp(-dt * 18));
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
    yaw = THREE.MathUtils.clamp(yaw, -1.3, 1.3);
    pitch = THREE.MathUtils.clamp(pitch, -0.6, 0.7);
    // Birds turn their heads in quick little steps.
    const snap = 1 - Math.exp(-dt * 9);
    this.lookYaw += (yaw - this.lookYaw) * snap;
    this.lookPitch += (pitch - this.lookPitch) * snap;
    this.pose(t);
    void scratch;
  }
}
