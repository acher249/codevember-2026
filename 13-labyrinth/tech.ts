import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  color,
  cos,
  cross,
  dot,
  float,
  fract,
  length,
  max,
  normalize,
  normalWorld,
  positionGeometry,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  time,
  vec3,
  vec4
} from "three/tsl";
import { mulberry32 } from "../shared/engine/random";
import { walkAmount } from "../shared/engine/walk";
import { HEIGHT, made, placement, shape, SPAN } from "./hedge-look";
import { fogged, steady } from "./style-air";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What the Tron maze carries in place of the natural one's vines and stones: chips with their pins, the traces running
// out from them with light pulsing along, panels with their lamps and vents, cables slung over the tops and conduit along
// the foot, and a mast here and there with a lamp on it; and in the sky, craft and packets of light going round. Made
// once in a hedge's own frame and drawn with the hedges' own instances near the camera, as the vines are, in two levels
// of detail; all of it put away in every other style.

const CHIP = 0;
const PIN = 1;
const TRACE = 2;
const PAD = 3;
const PANEL = 4;
const RIM = 5;
const LED = 6;
const VENT = 7;
const CABLE = 8;
const MAST = 9;

const CYAN = color("#27e8ff") as any;
const ORANGE = color("#ff8a2a") as any;
const MAGENTA = color("#ff2fa8") as any;
const AIR = color("#02040a") as any;

type V = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

class Parts {
  list: THREE.BufferGeometry[] = [];
  group = 0;
  chance = 1;

  // A piece, carried on `root` (where it shrinks to far off), of a kind, with a distance along it for light to run on:
  // from `start` in the way of `run`, or `fromUv` to take it from a tube's own length.
  add(geometry: THREE.BufferGeometry, root: V, kind: number, seed: number, start = 0, run: V | null = null, fromUv = 0) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    flat.computeVertexNormals();
    const position = flat.getAttribute("position") as THREE.BufferAttribute;
    const uv = flat.getAttribute("uv") as THREE.BufferAttribute | undefined;
    const count = position.count;
    const roots = new Float32Array(count * 3);
    const tech = new Float32Array(count * 4);
    const groups = new Float32Array(count * 2);
    const p = v3();
    for (let i = 0; i < count; i++) {
      p.fromBufferAttribute(position, i);
      roots.set([root.x, root.y, root.z], i * 3);
      const along = fromUv && uv ? uv.getX(i) * fromUv : run ? start + p.clone().sub(root).dot(run) : start;
      tech.set([kind, seed, along, 0], i * 4);
      groups.set([this.group, this.chance], i * 2);
    }
    flat.setAttribute("aRoot", new THREE.Float32BufferAttribute(roots, 3));
    flat.setAttribute("aTech", new THREE.Float32BufferAttribute(tech, 4));
    flat.setAttribute("aGroup", new THREE.Float32BufferAttribute(groups, 2));
    this.list.push(flat);
  }

  geometry() {
    const names = ["position", "normal", "aRoot", "aTech", "aGroup"];
    const total = this.list.reduce((sum, part) => sum + part.getAttribute("position").count, 0);
    const geometry = new THREE.BufferGeometry();
    for (const name of names) {
      const size = this.list[0].getAttribute(name).itemSize;
      const array = new Float32Array(total * size);
      let offset = 0;
      for (const part of this.list) {
        array.set((part.getAttribute(name) as THREE.BufferAttribute).array as Float32Array, offset * size);
        offset += part.getAttribute("position").count;
      }
      geometry.setAttribute(name, new THREE.Float32BufferAttribute(array, size));
    }
    for (const part of this.list) part.dispose();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

// The faces of a hedge `x` by `z`: which way each looks out, which way runs across it, and how far out it stands.
const OUT = [v3(0, 0, 1), v3(0, 0, -1), v3(1, 0, 0), v3(-1, 0, 0)];
const ACROSS = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, -1), v3(0, 0, 1)];

// A box lying on a face, `w` across and `h` up, standing `d` out from it, `proud` off it, centred at `a` across and `y` up.
function onFace(side: number, half: number, a: number, y: number, w: number, h: number, d: number, proud = 0) {
  const out = OUT[side];
  const across = ACROSS[side];
  const centre = out
    .clone()
    .multiplyScalar(half + proud + d / 2)
    .addScaledVector(across, a)
    .setY(y);
  const box = new THREE.BoxGeometry(w, h, d);
  box.deleteAttribute("uv");
  box.applyMatrix4(new THREE.Matrix4().makeBasis(across, v3(0, 1, 0), out).setPosition(centre));
  return { box, centre };
}

// Everything on one hedge. `fine` close up, with every pin, trace and lamp; otherwise only what is big enough to be seen
// further off: the chips, the panels and their rims, the cables and masts.
export function techGeometry(x: number, z: number, ends: boolean, seed: number, fine: boolean) {
  const random = mulberry32(seed);
  const parts = new Parts();
  const ax = x / 2;
  const az = z / 2;
  let group = 0;
  for (let side = 0; side < (ends ? 4 : 2); side++) {
    const half = side < 2 ? az : ax;
    const span = (side < 2 ? ax : az) - 0.06;
    const across = ACROSS[side];
    const out = OUT[side];
    const spot = () => ({ a: (random() * 2 - 1) * span * 0.85, y: 0.25 + random() * (HEIGHT - 0.55) });

    // Chips, each with its pins down two sides or all four, and traces running out from them in right angles.
    for (let c = 0; c < (ends ? 1 : 3); c++) {
      parts.group = group++;
      parts.chance = 0.75;
      const w = 0.1 + random() * 0.2;
      const h = 0.1 + random() * 0.2;
      const { a, y } = spot();
      const at = Math.max(-span + w / 2, Math.min(span - w / 2, a));
      const { box, centre } = onFace(side, half, at, y, w, h, 0.022, 0.004);
      parts.add(box, centre, CHIP, random());
      if (!fine) continue;
      const four = random() < 0.5;
      const pitch = 0.028;
      for (const [along, length, edge] of [
        [true, w, h / 2],
        [true, w, -h / 2],
        ...(four ? ([[false, h, w / 2], [false, h, -w / 2]] as const) : [])
      ] as const) {
        for (let k = -length / 2 + pitch; k < length / 2 - pitch / 2; k += pitch) {
          const pa = along ? at + k : at + edge + Math.sign(edge) * 0.012;
          const py = along ? y + edge + Math.sign(edge) * 0.012 : y + k;
          parts.add(onFace(side, half, pa, py, along ? 0.009 : 0.026, along ? 0.026 : 0.009, 0.006, 0.002).box, centre, PIN, random());
        }
      }
      // The traces: out from a pin, turning at right angles a few times, ending in a pad.
      for (let t = 0; t < 4 + Math.floor(random() * 5); t++) {
        let pa = at + (random() - 0.5) * w;
        let py = y + (random() < 0.5 ? -1 : 1) * (h / 2 + 0.03);
        let vertical = true;
        let travelled = random() * 4;
        const lane = random();
        for (let s = 0; s < 3 + Math.floor(random() * 3); s++) {
          const length = 0.08 + random() * 0.35;
          const way = (vertical ? Math.sign(py - y) || 1 : random() < 0.5 ? -1 : 1) * length;
          const na = vertical ? pa : Math.max(-span, Math.min(span, pa + way));
          const ny = vertical ? Math.max(0.06, Math.min(HEIGHT - 0.06, py + way)) : py;
          const run = vertical ? v3(0, Math.sign(ny - py) || 1, 0) : across.clone().multiplyScalar(Math.sign(na - pa) || 1);
          const seg = onFace(side, half, (pa + na) / 2, (py + ny) / 2, vertical ? 0.007 : Math.abs(na - pa) + 0.007, vertical ? Math.abs(ny - py) + 0.007 : 0.007, 0.002, 0.001);
          const start = out.clone().multiplyScalar(half).addScaledVector(across, pa).setY(py);
          parts.add(seg.box, start, TRACE, lane, travelled, run);
          travelled += Math.abs(na - pa) + Math.abs(ny - py);
          pa = na;
          py = ny;
          vertical = !vertical;
        }
        parts.add(onFace(side, half, pa, py, 0.024, 0.024, 0.003, 0.001).box, out.clone().multiplyScalar(half).addScaledVector(across, pa).setY(py), PAD, random());
      }
    }

    // A panel now and then, ringed in light, with a row of lamps and a vent.
    if (random() < (ends ? 0.3 : 0.6)) {
      parts.group = group++;
      parts.chance = 0.6;
      const w = Math.min(span * 1.6, 0.28 + random() * 0.3);
      const h = 0.4 + random() * 0.4;
      const a = (random() * 2 - 1) * (span - w / 2);
      const y = 0.5 + random() * (HEIGHT - 1.2 - h / 2);
      const { box, centre } = onFace(side, half, a, y, w, h, 0.05, 0.004);
      parts.add(box, centre, PANEL, random());
      parts.add(onFace(side, half, a, y, w + 0.03, h + 0.03, 0.02, 0.002).box, centre, RIM, random());
      if (fine) {
        const lamps = 3 + Math.floor(random() * 4);
        for (let l = 0; l < lamps; l++) parts.add(onFace(side, half, a - w / 2 + 0.05 + (l * (w - 0.1)) / Math.max(1, lamps - 1), y + h / 2 - 0.05, 0.02, 0.02, 0.012, 0.054).box, centre, LED, random());
        for (let v = 0; v < 4; v++) parts.add(onFace(side, half, a, y - h / 2 + 0.07 + v * 0.035, w * 0.7, 0.008, 0.004, 0.054).box, centre, VENT, random());
      }
    }

    // Cables slung from the top edge, sagging down the face and either back up to it or down into the ground.
    for (let c = 0; c < (ends ? 1 : 3); c++) {
      parts.group = group++;
      parts.chance = 0.7;
      const from = (random() * 2 - 1) * span;
      const toGround = random() < 0.5;
      const to = toGround ? from + (random() - 0.5) * 0.6 : (random() * 2 - 1) * span;
      const sag = 0.4 + random() * 1.2;
      const lift = 0.02 + random() * 0.04;
      const point = (a: number, y: number, o: number) => out.clone().multiplyScalar(half + o).addScaledVector(across, Math.max(-span, Math.min(span, a))).setY(y);
      const points = toGround
        ? [point(from, HEIGHT + 0.03, -0.12), point(from, HEIGHT + 0.01, 0.03), point((from + to) / 2, HEIGHT - sag * 0.6, lift + 0.03), point(to, 0.25, lift), point(to, -0.02, 0.06)]
        : [point(from, HEIGHT + 0.03, -0.12), point(from, HEIGHT + 0.01, 0.03), point((from + to) / 2, HEIGHT - sag, lift + 0.04), point(to, HEIGHT + 0.01, 0.03), point(to, HEIGHT + 0.03, -0.12)];
      const curve = new THREE.CatmullRomCurve3(points);
      const radius = 0.01 + random() * 0.014;
      parts.add(new THREE.TubeGeometry(curve, fine ? 28 : 10, radius, fine ? 6 : 3, false), points[2], CABLE, random(), 0, null, curve.getLength());
    }

    // Conduit along the foot of a long face.
    if (!ends && random() < 0.6) {
      parts.group = group++;
      parts.chance = 0.7;
      const y = 0.06 + random() * 0.1;
      const radius = 0.02 + random() * 0.015;
      const tube = new THREE.CylinderGeometry(radius, radius, span * 2, fine ? 8 : 4, 1, true);
      tube.rotateZ(Math.PI / 2);
      tube.applyMatrix4(new THREE.Matrix4().makeBasis(across, v3(0, 1, 0), out).setPosition(out.clone().multiplyScalar(half + radius + 0.01).setY(y)));
      const start = out.clone().multiplyScalar(half).setY(y);
      parts.add(tube, start, CABLE, random(), span, across);
    }
  }

  // A mast on top now and then, with a lamp at its tip.
  parts.group = group++;
  parts.chance = 0.35;
  const mx = (random() * 2 - 1) * (ax - 0.15);
  const mz = (random() * 2 - 1) * (az - 0.15);
  const tall = 0.35 + random() * 0.7;
  const base = new THREE.BoxGeometry(0.14, 0.08, 0.14);
  base.translate(mx, HEIGHT + 0.04, mz);
  const root = v3(mx, HEIGHT, mz);
  parts.add(base, root, MAST, random());
  const pole = new THREE.CylinderGeometry(0.012, 0.018, tall, fine ? 6 : 3);
  pole.translate(mx, HEIGHT + 0.08 + tall / 2, mz);
  parts.add(pole, root, MAST, random());
  const tip = new THREE.OctahedronGeometry(0.035);
  tip.translate(mx, HEIGHT + 0.1 + tall, mz);
  parts.add(tip, root, LED, random());

  return parts.geometry();
}

// The pieces' colours, lit by nothing but themselves. Each shrinks into the hedge past `reach` from the camera, and a
// coarse one also nearer than `from`, where the fine one takes over.
export function techMaterial(reach: { fly: number; walk: number; from?: number }) {
  const material = made(new THREE.MeshBasicNodeMaterial());
  // Named for styles.ts, which shows it only in the Tron maze.
  material.name = "tech";
  material.visible = false;
  const { world, own } = placement();
  const rootLocal = attribute("aRoot", "vec3") as any;
  const tech = attribute("aTech", "vec4") as any;
  const group = attribute("aGroup", "vec2") as any;
  const kind = tech.x as any;
  const seed = tech.y as any;
  const along = tech.z as any;
  const far = float(reach.fly).add(float(reach.walk - reach.fly).mul(walkAmount)) as any;
  const away = length(world(rootLocal).sub(cameraPosition)) as any;
  const near = (reach.from ? smoothstep(far, far.mul(0.72), away).mul(smoothstep(reach.from * 0.72, reach.from, away)) : smoothstep(far, far.mul(0.72), away)) as any;
  const shown = select(fract(own.x.add(group.x.mul(0.6180339))).lessThan(group.y), float(1), float(0)) as any;
  shape(material, positionGeometry.sub(rootLocal).mul(near.mul(shown)).add(rootLocal));

  const out = (() => {
    const view = normalize(positionWorld.sub(cameraPosition)) as any;
    const facing = abs(dot(view, normalWorld)) as any;
    const edge = pow(float(1).sub(facing), float(3)) as any;
    // Light running along a trace or cable: a short bright dash every so often, each at its own pace.
    const pulse = smoothstep(0.86, 1, fract(along.mul(0.9).sub(time.mul(float(0.5).add(seed.mul(0.6)))).add(seed.mul(7)))) as any;
    const blink = smoothstep(0.3, 0.5, sin(time.mul(float(1.5).add(seed.mul(5))).add(seed.mul(40))).mul(0.5).add(0.5)) as any;
    const lamp = select(seed.lessThan(0.55), CYAN, select(seed.lessThan(0.85), ORANGE, MAGENTA)) as any;
    const shell = color("#04070d").add(CYAN.mul(edge.mul(0.35))).add(CYAN.mul(max(normalWorld.y, float(0)).mul(0.02))) as any;
    const pick = (values: any[]): any => {
      let result: any = values[values.length - 1];
      for (let k = values.length - 2; k >= 0; k--) result = select(kind.lessThan(k + 0.5), values[k], result);
      return result;
    };
    const rgb = pick([
      shell,
      color("#8a6a3a").mul(0.45).add(ORANGE.mul(edge.mul(0.3))),
      CYAN.mul(0.22).add(select(seed.lessThan(0.7), CYAN, ORANGE).mul(pulse.mul(3))),
      CYAN.mul(1.1),
      shell.mul(1.3),
      CYAN.mul(1.6),
      lamp.mul(blink.mul(2.6).add(0.25)),
      CYAN.mul(0.6),
      color("#03050a").add(CYAN.mul(edge.mul(0.25))).add(select(seed.lessThan(0.6), CYAN, ORANGE).mul(pulse.mul(2.4))),
      shell
    ]);
    return vec4(fogged(rgb, AIR, 0.018).mul(steady), 1);
  })();
  material.colorNode = color("#000000");
  material.outputNode = out;
  return material;
}

// The sky over the Tron maze, in place of the birds: craft going round on wide circles, banked into their turns, each
// trailing a streak of light, and packets of light higher up and much faster. Drawn where they fly, not bent, as the birds
// are, and never nearer the eye than the birds come.
const SKY = SPAN / 2;
export function trafficGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.OctahedronGeometry(1, 0);
  body.scale(0.7, 0.22, 2.4);
  const fins = new THREE.BoxGeometry(2.6, 0.06, 0.7);
  fins.translate(0, 0, 0.6);
  const trail = new THREE.BoxGeometry(0.16, 0.16, 14);
  trail.translate(0, 0, 9.3);
  for (const [geometry, part] of [
    [body, 0],
    [fins, 0],
    [trail, 1]
  ] as const) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    flat.deleteAttribute("uv");
    flat.computeVertexNormals();
    const count = flat.getAttribute("position").count;
    flat.setAttribute("aPart", new THREE.Float32BufferAttribute(new Array(count).fill(part), 1));
    parts.push(flat);
  }
  const names = ["position", "normal", "aPart"];
  const total = parts.reduce((sum, part) => sum + part.getAttribute("position").count, 0);
  const geometry = new THREE.BufferGeometry();
  for (const name of names) {
    const size = parts[0].getAttribute(name).itemSize;
    const array = new Float32Array(total * size);
    let offset = 0;
    for (const part of parts) {
      array.set((part.getAttribute(name) as THREE.BufferAttribute).array as Float32Array, offset * size);
      offset += part.getAttribute("position").count;
    }
    geometry.setAttribute(name, new THREE.Float32BufferAttribute(array, size));
  }
  return geometry;
}

export function trafficMesh(craft: number, packets: number) {
  const geometry = trafficGeometry();
  const random = mulberry32(7717);
  const total = craft + packets;
  const seeds = new Float32Array(total * 4);
  const ways = new Float32Array(total * 4);
  for (let i = 0; i < total; i++) {
    const packet = i >= craft;
    seeds.set([random(), random(), random(), random() * 100], i * 4);
    // Height, radius of its circle, which way round, and whether a packet.
    ways.set([packet ? 75 + random() * 40 : 32 + random() * 45, packet ? 60 + random() * 70 : 22 + random() * 45, random() < 0.5 ? -1 : 1, packet ? 1 : 0], i * 4);
  }
  geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.setAttribute("aWay", new THREE.InstancedBufferAttribute(ways, 4));
  const material = made(new THREE.MeshBasicNodeMaterial(), false);
  material.name = "tech";
  material.visible = false;
  const seed = attribute("aSeed", "vec4") as any;
  const way = attribute("aWay", "vec4") as any;
  const part = attribute("aPart", "float") as any;
  const packet = way.w.greaterThan(0.5) as any;
  const w = seed.w as any;
  const home = fract(seed.xy.sub(cameraPosition.xz.div(SKY))).sub(0.5).mul(SKY) as any;
  const radius = way.y as any;
  const speed = select(packet, float(55).add(seed.z.mul(25)), float(16).add(seed.z.mul(14))) as any;
  const angle = time.mul(speed).div(radius).mul(way.z).add(w) as any;
  const c = cos(angle) as any;
  const s = sin(angle) as any;
  const path = vec3(cameraPosition.x.add(home.x).add(c.mul(radius)), way.x.add(sin(time.mul(0.3).add(w.mul(2))).mul(4)), cameraPosition.z.add(home.y).add(s.mul(radius))) as any;
  const fromEye = path.sub(cameraPosition) as any;
  const distance = length(fromEye).max(1e-3) as any;
  const centre = cameraPosition.add(fromEye.mul(distance.max(40).div(distance))) as any;
  // Heading round the circle; the model's nose is its -z, its trail behind along +z.
  const forward = vec3(s.negate().mul(way.z), 0, c.mul(way.z)) as any;
  const right = normalize(cross(forward, vec3(0, 1, 0))) as any;
  const bank = select(packet, float(0), way.z.mul(0.5)) as any;
  const up = cross(right, forward) as any;
  const tippedRight = right.mul(cos(bank)).add(up.mul(sin(bank))) as any;
  const tippedUp = cross(tippedRight, forward) as any;
  const scale = select(packet, float(0.6), float(1.4)) as any;
  const local = positionGeometry.mul(scale) as any;
  // Packets are all streak and no body.
  const kept = select(packet.and(part.lessThan(0.5)), float(0), float(1)) as any;
  shape(material, centre.add(tippedRight.mul(local.x).add(tippedUp.mul(local.y)).sub(forward.mul(local.z)).mul(kept)));
  const glow = select(seed.x.lessThan(0.6), CYAN, select(seed.x.lessThan(0.85), ORANGE, MAGENTA)) as any;
  const view = normalize(positionWorld.sub(cameraPosition)) as any;
  const rim = pow(float(1).sub(abs(dot(view, normalWorld))), float(2)) as any;
  // The streak fades out behind, from where the craft is.
  const behind = smoothstep(16.5, 2.4, positionGeometry.z) as any;
  const rgb = select(part.greaterThan(0.5), glow.mul(behind.mul(select(packet, float(4), float(2.2)))), color("#05080f").add(glow.mul(rim.mul(2.5)))) as any;
  material.colorNode = color("#000000");
  // Not into the maze's air, which closes off well short of the sky, only a light haze of its own.
  const haze = float(1).sub(pow(float(2.718), length(positionWorld.sub(cameraPosition)).mul(-0.004))) as any;
  material.outputNode = vec4(rgb.mix(AIR, haze.mul(0.8)).mul(steady), 1);
  const mesh = new THREE.InstancedMesh(geometry, material, total);
  const identity = new THREE.Matrix4();
  for (let i = 0; i < total; i++) mesh.setMatrixAt(i, identity);
  mesh.frustumCulled = false;
  return { mesh, material };
}
