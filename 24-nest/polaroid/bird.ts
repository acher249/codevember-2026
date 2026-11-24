/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { attribute, cameraPosition, color, dot, float, mix, mx_noise_float, normalize, normalWorld, positionLocal, positionWorld, smoothstep, texture, uv, vec2, vec3 } from "three/tsl";
import { lehmer } from "../../shared/engine/random";
import type { BirdLook } from "./worlds";

// Mum: an adult bird built of real feather cards over a soft body. Body and head feathers lie in shingled rows along
// the way the plumage flows, head to tail; the wings are bones (arm, forearm, hand) carrying their flight feathers and
// coverts, worked out each frame, so a wing folds into its Z against the flank and opens into a full spread for a beat;
// the tail fans. One look per world (robin, pigeon, little owl), one shape.

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// A feather card: root at the origin, running along +z, width across x, bowed down a little along its length and
// cupped across, so it lies over the one beneath.
function cardGeometry() {
  const g = new THREE.PlaneGeometry(1, 1, 4, 6);
  const p = g.getAttribute("position");
  const uvA = g.getAttribute("uv");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getY(i) + 0.5;
    p.setXYZ(i, x, -0.12 * z * z - 0.08 * x * x, z);
    uvA.setXY(i, x + 0.5, z);
  }
  // The plane's face turned to point up (+y) once laid along z.
  g.computeVertexNormals();
  const n = g.getAttribute("normal");
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  const index = g.getIndex()!;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i + 1);
    index.setX(i + 1, index.getX(i + 2));
    index.setX(i + 2, a);
  }
  return g;
}

type Card = { kind: 0 | 1; colour: THREE.Color; sheen: number; spots: number };
type WingFeather = { bone: 1 | 2 | 3; at: number; open: number; fold: number; length: number; width: number; layer: number; card: number };

export class Bird {
  group = new THREE.Group();
  body = new THREE.Group();
  head = new THREE.Group();
  beakTip = new THREE.Object3D();
  lower = new THREE.Group();
  geometries: THREE.BufferGeometry[] = [];
  materials: THREE.Material[] = [];
  private cards: THREE.InstancedMesh;
  private fixed = 0;
  private wing: WingFeather[] = [];
  private tail: { angle: number; length: number; card: number }[] = [];
  private legs: THREE.Group[] = [];
  private look: BirdLook;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private local: THREE.Matrix4[] = [];
  shoulder: THREE.Vector3;
  tailRoot: THREE.Vector3;
  torso: { centre: THREE.Vector3; radii: THREE.Vector3 };

  // Pose: how far the wings are open (0 folded, 1 spread), their beat angle, how fanned the tail and how far it is
  // raised, the head's turn, the beak, whether the legs are down.
  spread = 0;
  beat = 0;
  fan = 0;
  tailLift = 0;
  gape = 0;
  legsDown = 1;

  constructor(look: BirdLook, atlas: THREE.Texture, seed: number) {
    this.look = look;
    const random = lehmer(seed);
    const L = look.size;
    // The torso: an egg leaning forward, the feet under its middle.
    const radii = v3(L * 0.27, L * 0.28, L * 0.43);
    const centre = v3(0, L * 0.42, 0);
    this.torso = { centre, radii };
    this.shoulder = v3(radii.x * 0.72, centre.y + radii.y * 0.42, centre.z + radii.z * 0.3);
    this.tailRoot = v3(0, centre.y + radii.y * 0.05, centre.z - radii.z * 0.86);
    this.group.add(this.body);
    this.body.add(this.head);
    const headR = L * 0.17 * look.head;
    const neck = v3(0, centre.y + radii.y * 0.78, centre.z + radii.z * 0.52);
    this.head.position.copy(neck);

    const plain = (hex: string, roughness: number) => {
      const m = new THREE.MeshStandardNodeMaterial({ color: hex, roughness });
      this.materials.push(m);
      return m;
    };
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D) => {
      this.geometries.push(g);
      const x = new THREE.Mesh(g, m);
      x.castShadow = true;
      x.receiveShadow = true;
      parent.add(x);
      return x;
    };
    // The soft body under the feathers, in the plumage's own colours, so a gap never shows.
    const under = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    {
      const p = positionLocal as any;
      const up = smoothstep(-0.2, 0.5, p.y.sub(centre.y).div(radii.y)) as any;
      const front = smoothstep(-0.2, 0.6, p.z.sub(centre.z).div(radii.z)) as any;
      under.colorNode = mix(mix(color(look.belly), color(look.breast), front), color(look.back), up).mul(0.75) as any;
    }
    this.materials.push(under);
    const torsoGeometry = new THREE.SphereGeometry(1, 32, 24);
    torsoGeometry.scale(radii.x * 0.96, radii.y * 0.96, radii.z * 0.96);
    torsoGeometry.translate(centre.x, centre.y, centre.z);
    mesh(torsoGeometry, under, this.body);
    const headGeometry = new THREE.SphereGeometry(headR * 0.95, 28, 20);
    headGeometry.scale(1, look.disc ? 0.92 : 0.95, 1.05);
    mesh(headGeometry, plain(look.face, 0.9), this.head);

    // Feather cards, every one instanced from one card shape: body and head first (fixed to the body), then the wings
    // and tail (placed each frame).
    const cards: Card[] = [];
    const places: THREE.Matrix4[] = [];
    const parentOf: ("body" | "head")[] = [];
    const tint = (base: string, k: number) => new THREE.Color(base).multiplyScalar(0.85 + random() * 0.3 * k);
    // Body feathers over the torso, flowing back and down; colours by region.
    const lay = (count: number, at: (u: THREE.Vector3) => { p: THREE.Vector3; n: THREE.Vector3 } | null, flow: (n: THREE.Vector3, u: THREE.Vector3) => THREE.Vector3, size: (u: THREE.Vector3) => number, paint: (u: THREE.Vector3) => Card, parent: "body" | "head") => {
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < count; i++) {
        const y = 1 - (i / (count - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const u = v3(Math.cos(golden * i) * r, y, Math.sin(golden * i) * r);
        const hit = at(u);
        if (!hit) continue;
        const along = flow(hit.n, u);
        along.addScaledVector(hit.n, -along.dot(hit.n)).normalize();
        const across = new THREE.Vector3().crossVectors(hit.n, along).normalize();
        // Lifted a little off the body at the tip.
        const lift = 0.16 + random() * 0.08;
        const z = along.clone().multiplyScalar(Math.cos(lift)).addScaledVector(hit.n, Math.sin(lift));
        const ny = new THREE.Vector3().crossVectors(z, across).normalize();
        const basis = new THREE.Matrix4().makeBasis(across, ny, z);
        const sz = size(u) * (0.85 + random() * 0.3);
        basis.scale(v3(sz * 0.8, sz, sz));
        basis.setPosition(hit.p.clone().addScaledVector(hit.n, -sz * 0.18).addScaledVector(along, -sz * 0.35));
        places.push(basis);
        cards.push(paint(u));
        parentOf.push(parent);
      }
    };
    // Torso.
    lay(
      Math.round(330 * (L / 13)),
      (u) => ({ p: u.clone().multiply(radii).add(centre), n: u.clone().divide(radii).normalize() }),
      (n, u) => v3(0, -0.25 - Math.max(0, -u.y) * 0.3, -1).add(v3(u.x * 0.2, 0, 0)),
      () => L * 0.15,
      (u) => {
        const up = THREE.MathUtils.smoothstep(u.y, -0.15, 0.45);
        const front = THREE.MathUtils.smoothstep(u.z, -0.3, 0.5);
        const base = new THREE.Color(look.belly).lerp(new THREE.Color(look.breast), front * (1 - Math.max(0, -u.y - 0.4) * 1.2)).lerp(new THREE.Color(look.back), up);
        // The neck of a pigeon shimmers.
        const neck = look.sheen * THREE.MathUtils.smoothstep(u.z, 0.45, 0.8) * THREE.MathUtils.smoothstep(u.y, -0.1, 0.4);
        return { kind: 0, colour: base.multiplyScalar(0.85 + random() * 0.3), sheen: neck, spots: look.spots * (0.4 + up * 0.6) };
      },
      "body"
    );
    // Head: small feathers flowing back from the beak; crown and face colours, and an owl's pale disc round each eye.
    lay(
      Math.round(220 * look.head),
      (u) => (u.z < -0.95 && u.y < 0 ? null : { p: u.clone().multiplyScalar(headR).add(neck), n: u.clone() }),
      (n, u) => v3(0, -0.15 - Math.max(0, u.z) * 0.2, -1).add(v3(0, 0, 0)).add(n.clone().multiplyScalar(-0.1)).add(look.disc ? v3(u.x * 1.4, u.y * 0.6, 0).multiplyScalar(Math.max(0, u.z)) : v3(0, 0, 0)),
      (u) => L * (0.065 + Math.max(0, -u.z) * 0.03),
      (u) => {
        const crown = THREE.MathUtils.smoothstep(u.y, 0.1, 0.6);
        const disc = look.disc * THREE.MathUtils.smoothstep(u.z, 0.2, 0.7);
        const base = new THREE.Color(look.face).lerp(new THREE.Color(look.crown), crown * (1 - disc)).lerp(new THREE.Color(look.belly), disc * 0.5);
        const throat = THREE.MathUtils.smoothstep(-u.y, 0.2, 0.7) * THREE.MathUtils.smoothstep(u.z, 0, 0.6);
        base.lerp(new THREE.Color(look.breast), throat * (look.disc ? 0.3 : 0.6));
        return { kind: 0, colour: base.multiplyScalar(0.88 + random() * 0.24), sheen: 0, spots: look.spots * crown * 0.6 };
      },
      "head"
    );
    this.fixed = cards.length;

    // Wing feathers: primaries on the hand, secondaries along the forearm, tertials at the elbow, and the coverts over
    // their roots in rows. `open` and `fold` are the angles each points in the wing's plane, spread and folded (0 is
    // straight out, -90 straight back).
    const P = 9;
    for (let i = 0; i < P; i++) {
      const k = i / (P - 1);
      this.wing.push({ bone: 3, at: 0.1 + k * 0.85, open: -78 + k * 66, fold: -176 + k * 4, length: L * (0.5 + 0.12 * Math.sin(k * Math.PI * 0.8)), width: L * 0.085, layer: 0, card: 0 });
    }
    const S = 9;
    for (let i = 0; i < S; i++) {
      const k = i / (S - 1);
      this.wing.push({ bone: 2, at: 0.05 + k * 0.95, open: -96 + k * 8, fold: -178, length: L * 0.38, width: L * 0.1, layer: 1, card: 0 });
    }
    for (let i = 0; i < 3; i++) this.wing.push({ bone: 1, at: 0.7 + i * 0.15, open: -110, fold: -182, length: L * (0.34 - i * 0.03), width: L * 0.1, layer: 2, card: 0 });
    for (let i = 0; i < S; i++) {
      const k = i / (S - 1);
      this.wing.push({ bone: 2, at: 0.05 + k * 0.92, open: -100 + k * 10, fold: -178, length: L * 0.2, width: L * 0.09, layer: 3, card: 0 });
    }
    for (let i = 0; i < 6; i++) {
      const k = i / 5;
      this.wing.push({ bone: 3, at: 0.05 + k * 0.55, open: -70 + k * 45, fold: -174, length: L * 0.2, width: L * 0.07, layer: 3, card: 0 });
    }
    for (let i = 0; i < 12; i++) {
      const k = i / 11;
      this.wing.push({ bone: k < 0.4 ? 1 : 2, at: k < 0.4 ? 0.3 + k * 1.6 : (k - 0.4) * 1.5, open: -95, fold: -176, length: L * 0.11, width: L * 0.08, layer: 4, card: 0 });
    }
    // Both wings: right then left.
    const wingCards: WingFeather[] = [];
    for (const side of [1, -1]) {
      for (const f of this.wing) {
        const c = { ...f, card: cards.length };
        wingCards.push(c);
        const flight = f.layer <= 2;
        const bar = look.bars > 0 && f.layer === 3 && f.bone === 2 ? 1 : 0;
        cards.push({ kind: flight ? 1 : 0, colour: tint(bar ? look.bar : f.layer >= 3 ? look.back : look.wing, 1), sheen: 0, spots: look.spots * (flight ? 0.6 : 1) });
        places.push(new THREE.Matrix4());
        parentOf.push("body");
        void side;
      }
    }
    this.wing = wingCards;
    // The tail: twelve feathers fanned from one root.
    for (let i = 0; i < 12; i++) {
      const k = i / 11 - 0.5;
      this.tail.push({ angle: k, length: L * (0.55 - Math.abs(k) * 0.06) * (look.disc ? 0.7 : 1), card: cards.length });
      cards.push({ kind: 1, colour: tint(look.tail, 1), sheen: 0, spots: look.spots * 0.5 });
      places.push(new THREE.Matrix4());
      parentOf.push("body");
    }

    // One instanced mesh for every card. Its positions are in the body's frame; head cards are moved with the head
    // each frame, so the whole plumage is one draw.
    const card = cardGeometry();
    this.geometries.push(card);
    const kind = new Float32Array(cards.length * 4);
    const colours = new Float32Array(cards.length * 3);
    cards.forEach((c, i) => {
      kind.set([c.kind, c.sheen, c.spots, random()], i * 4);
      colours.set([c.colour.r, c.colour.g, c.colour.b], i * 3);
    });
    card.setAttribute("aKind", new THREE.InstancedBufferAttribute(kind, 4));
    card.setAttribute("aColour", new THREE.InstancedBufferAttribute(colours, 3));
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.72, side: THREE.DoubleSide });
    material.alphaTest = 0.45;
    {
      const k = attribute("aKind", "vec4") as any;
      const atlasUV = vec2(uv().x.mul(0.5).add(k.x.mul(0.5)), uv().y) as any;
      const tex = texture(atlas, atlasUV) as any;
      const tone = tex.r.mul(1.35) as any;
      const base = (attribute("aColour", "vec3") as any).mul(tone) as any;
      // Spots and bars: a pale tear near the tip of an owl's feather, dark bands across a barred one.
      const tip = smoothstep(0.62, 0.72, uv().y).mul(float(1).sub(smoothstep(0.8, 0.9, uv().y))) as any;
      const spot = tip.mul(float(1).sub(smoothstep(0.05, 0.14, uv().x.sub(0.5).abs()))).mul(k.z) as any;
      const bands = smoothstep(0.55, 0.8, mx_noise_float(vec3(uv().y.mul(9), k.w.mul(40), 0)).mul(0.5).add(0.5)).mul(k.z).mul(0.35) as any;
      let c: any = mix(base, color(look.belly).mul(tone), spot);
      c = c.mul(float(1).sub(bands));
      // A pigeon's neck: green to violet by the angle it is seen at.
      const V = normalize(cameraPosition.sub(positionWorld)) as any;
      const facing = dot(normalize(normalWorld), V).abs() as any;
      const shimmer = mix(color("#3fae6a"), color("#a24fb8"), smoothstep(0.2, 0.8, facing)) as any;
      c = mix(c, shimmer.mul(tone).mul(0.8), k.y.mul(0.85));
      material.colorNode = c as any;
      material.opacityNode = tex.a as any;
      material.roughnessNode = mix(float(0.75), float(0.4), k.y) as any;
    }
    this.materials.push(material);
    this.cards = new THREE.InstancedMesh(card, material, cards.length);
    this.local = places;
    this.cards.castShadow = true;
    this.cards.receiveShadow = true;
    this.cards.frustumCulled = false;
    this.body.add(this.cards);
    this.parent = parentOf;

    // Eyes: glossy, an iris round a black pupil, set to the sides (or forward, on an owl).
    const eyeR = headR * 0.3 * look.eye;
    const eye = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05 });
    {
      const d = normalize(positionLocal) as any;
      eye.colorNode = mix(color(look.iris), color("#050403"), smoothstep(0.86, 0.9, d.z)).mul(mix(float(1), float(0.5), smoothstep(0.2, -0.4, d.z))) as any;
    }
    this.materials.push(eye);
    const eyeGeometry = new THREE.SphereGeometry(eyeR, 20, 14);
    this.geometries.push(eyeGeometry);
    const side = look.disc ? 0.42 : 0.82;
    for (const s of [1, -1]) {
      const e = new THREE.Mesh(eyeGeometry, eye);
      const dir = v3(s * Math.sin(side), 0.2, Math.cos(side)).normalize();
      e.position.copy(dir).multiplyScalar(headR * 0.86);
      e.quaternion.setFromUnitVectors(v3(0, 0, 1), dir);
      this.head.add(e);
    }

    // The beak: an upper mandible over a lower one hinged beneath it; an owl's hooks down.
    const [beakLength, beakDepth] = look.beak;
    const bill = plain(look.bill, 0.45);
    const upper = new THREE.ConeGeometry(beakDepth, beakLength, 16, 6);
    upper.rotateX(Math.PI / 2);
    upper.translate(0, 0, beakLength / 2);
    {
      const p = upper.getAttribute("position");
      for (let i = 0; i < p.count; i++) {
        const z = p.getZ(i) / beakLength;
        // Flattened beneath, and an owl's tip pulled down into a hook.
        let y = p.getY(i);
        if (y < 0) y *= 0.35;
        if (look.hooked) y -= z * z * beakLength * 0.55;
        p.setXYZ(i, p.getX(i) * 1.05, y, p.getZ(i));
      }
      upper.computeVertexNormals();
    }
    const beakAt = v3(0, -headR * 0.1, headR * 0.88);
    mesh(upper, bill, this.head).position.copy(beakAt);
    const lowerGeometry = new THREE.ConeGeometry(beakDepth * 0.8, beakLength * 0.85, 14, 4);
    lowerGeometry.rotateX(Math.PI / 2);
    lowerGeometry.translate(0, 0, beakLength * 0.42);
    lowerGeometry.scale(0.95, 0.45, 1);
    this.lower.position.copy(beakAt).add(v3(0, -beakDepth * 0.35, 0));
    this.head.add(this.lower);
    mesh(lowerGeometry, bill, this.lower);
    this.beakTip.position.copy(beakAt).add(v3(0, -beakDepth * 0.4 - (look.hooked ? beakLength * 0.5 : 0), beakLength * 0.92));
    this.head.add(this.beakTip);

    // Legs: a scaled shank down to the foot, three toes forward and one back, curled round a perch.
    const leg = plain(look.legs, 0.6);
    for (const s of [1, -1]) {
      const g = new THREE.Group();
      g.position.set(s * radii.x * 0.32, centre.y - radii.y * 0.7, centre.z + radii.z * 0.1);
      const shank = new THREE.CylinderGeometry(L * 0.016, L * 0.02, centre.y - radii.y * 0.7, 8);
      shank.translate(0, -(centre.y - radii.y * 0.7) / 2, 0);
      mesh(shank, leg, g);
      for (const [yaw, len] of [
        [-0.35, 0.16],
        [0, 0.19],
        [0.35, 0.16],
        [Math.PI, 0.12]
      ]) {
        const toe = new THREE.CylinderGeometry(L * 0.009, L * 0.014, L * len, 6);
        toe.translate(0, (L * len) / 2, 0);
        toe.rotateX(Math.PI / 2 + 0.35);
        toe.rotateY(yaw);
        toe.translate(0, -(centre.y - radii.y * 0.7) + L * 0.01, 0);
        mesh(toe, leg, g);
      }
      this.body.add(g);
      this.legs.push(g);
    }
    this.update();
  }

  private parent: ("body" | "head")[] = [];

  // Where each wing bone ends, for a wing on side s (1 right, -1 left) in the body's frame.
  private wingFrame(s: number) {
    const e = this.spread;
    const L = this.look.size;
    const lerp = THREE.MathUtils.lerp;
    const rad = THREE.MathUtils.degToRad;
    // Each bone's angle in the wing's plane, open and folded into a Z.
    const a = [lerp(-120, 12, e), lerp(58, -4, e), lerp(-168, -14, e)].map(rad);
    const lengths = [L * 0.22, L * 0.27, L * 0.22];
    // The plane: folded against the flank, or out level and beating.
    const dihedral = lerp(rad(-62), this.beat, e);
    const q = new THREE.Quaternion().setFromAxisAngle(v3(0, 0, 1), s * dihedral);
    // Folded, the wing lies back along the body, up on the shoulder.
    const pitch = new THREE.Quaternion().setFromAxisAngle(v3(1, 0, 0), lerp(0.18, 0, e));
    q.premultiply(pitch);
    const X = v3(s, 0, 0).applyQuaternion(q);
    const Z = v3(0, 0, 1).applyQuaternion(q);
    const N = v3(0, 1, 0).applyQuaternion(q);
    const joints = [this.shoulder.clone().multiply(v3(s, 1, 1)).add(v3(-s * (1 - e) * L * 0.03, 0, 0))];
    const dirs: THREE.Vector3[] = [];
    for (let i = 0; i < 3; i++) {
      const d = X.clone().multiplyScalar(Math.cos(a[i])).addScaledVector(Z, Math.sin(a[i]));
      dirs.push(d);
      joints.push(joints[i].clone().addScaledVector(d, lengths[i]));
    }
    return { joints, dirs, X, Z, N, e };
  }

  // Place every moving card: wings from their bones, tail from its root, head cards with the head.
  update() {
    const { m4, q, s } = this;
    const headM = new THREE.Matrix4().compose(this.head.position, this.head.quaternion, v3(1, 1, 1));
    const headRest = new THREE.Matrix4().makeTranslation(this.head.position.x, this.head.position.y, this.head.position.z).invert();
    const headFrom = headM.clone().multiply(headRest);
    for (let i = 0; i < this.fixed; i++) {
      if (this.parent[i] === "head") m4.multiplyMatrices(headFrom, this.local[i]);
      else m4.copy(this.local[i]);
      this.cards.setMatrixAt(i, m4);
    }
    const rad = THREE.MathUtils.degToRad;
    const half = this.wing.length / 2;
    for (const side of [1, -1]) {
      const f = this.wingFrame(side);
      const start = side > 0 ? 0 : half;
      for (let k = 0; k < half; k++) {
        const w = this.wing[start + k];
        const bone = w.bone - 1;
        const root = f.joints[bone].clone().lerp(f.joints[bone + 1], w.at);
        const angle = rad(THREE.MathUtils.lerp(w.fold, w.open, f.e));
        const along = f.X.clone().multiplyScalar(Math.cos(angle)).addScaledVector(f.Z, Math.sin(angle)).normalize();
        // Each layer rides a little above the one under it, and the coverts sit forward over the roots.
        const up = f.N.clone().multiplyScalar(side > 0 ? 1 : 1);
        root.addScaledVector(up, w.layer * 0.06 + 0.02).addScaledVector(along, -w.length * (w.layer >= 3 ? 0.15 : 0.05));
        const across = new THREE.Vector3().crossVectors(up, along).normalize();
        const ny = new THREE.Vector3().crossVectors(along, across).normalize();
        m4.makeBasis(across, ny, along);
        m4.scale(s.set(w.width, w.length * 0.6, w.length));
        m4.setPosition(root);
        this.cards.setMatrixAt(w.card, m4);
      }
    }
    const tailDir = new THREE.Vector3();
    for (const t of this.tail) {
      const spread = THREE.MathUtils.lerp(0.18, 1.2, this.fan) * t.angle;
      q.setFromEuler(new THREE.Euler(-0.25 + this.tailLift, spread, 0, "YXZ"));
      tailDir.set(0, 0, -1).applyQuaternion(q);
      const across = v3(-1, 0, 0).applyQuaternion(q);
      const up = new THREE.Vector3().crossVectors(tailDir, across).normalize();
      m4.makeBasis(across, up, tailDir);
      m4.scale(s.set(this.look.size * 0.1, t.length * 0.5, t.length));
      m4.setPosition(this.tailRoot.clone().addScaledVector(up, Math.abs(t.angle) * -0.15));
      this.cards.setMatrixAt(t.card, m4);
    }
    this.cards.instanceMatrix.needsUpdate = true;
    // The beak.
    this.lower.rotation.x = this.gape * 0.5;
    // Legs tucked up and back in flight.
    for (const g of this.legs) {
      g.rotation.x = (1 - this.legsDown) * 1.3;
      g.scale.setScalar(0.55 + this.legsDown * 0.45);
    }
  }
}
