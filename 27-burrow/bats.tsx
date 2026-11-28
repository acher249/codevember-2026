"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, cos, cross, float, mix, positionGeometry, sin, smoothstep, vec3 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { lehmer } from "../shared/engine/random";
import { CAVERNS, CavernRock, type Cavern } from "./field";
import { lamp } from "./fx";
import { rockUniforms } from "./rock";
import { flutter, squeaks } from "./sound";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Colonies of bats hang asleep from the roofs of the grotto and the lake. Break in and they wake: a few frantic laps
// of their cavern, then out the only way they know is open, back down your own tunnel, past your head, out of the
// cliff and away over the trees into the daylight.

// Where the eye has been, oldest first, a point every 60 cm: the way the bats take out.
export const trail: THREE.Vector3[] = [];
export function leaveTrail(at: THREE.Vector3) {
  const last = trail[trail.length - 1];
  if (last && last.distanceToSquared(at) < 0.36) return;
  trail.push(at.clone());
  if (trail.length > 160) trail.shift();
}

// Woken from outside the component, at the breakthrough.
export const bats = { scatter: (_kind: Cavern["kind"], _breach: THREE.Vector3) => {} };

// How close a bat in flight may come to the eye.
const CLEAR = 1.15;

const COLONIES: { kind: Cavern["kind"]; count: number }[] = [
  { kind: "grotto", count: 26 },
  { kind: "lake", count: 38 }
];

// A bat seen from above, nose toward -z: a small furred body with ears, and each wing a membrane stretched over the
// arm and three long fingers, its trailing edge scalloped between the finger tips. `aWing` is how far out along the
// wing a point lies (0 on the body); `aEdge` is 1 on the membrane's free edge and 0 along the bones (for a soft edge and
// for the bones to read darker), so the fan of triangles from the wrist shades as skin between fingers.
function batGeometry() {
  const position: number[] = [];
  const wing: number[] = [];
  const edge: number[] = [];
  const add = (p: number[], e: number) => {
    position.push(p[0], p[1], p[2]);
    wing.push(Math.min(1, Math.abs(p[0]) / 0.165));
    edge.push(e);
  };
  const tri = (a: number[], b: number[], c: number[], ea = 0, eb = 0, ec = 0) => {
    add(a, ea);
    add(b, eb);
    add(c, ec);
  };
  // The body, a little diamond, with two pointed ears.
  const nose = [0, 0, -0.046];
  const top = [0, 0.016, -0.008];
  const belly = [0, -0.012, -0.004];
  const tail = [0, 0, 0.042];
  for (const s of [1, -1]) {
    const side = [0.014 * s, 0, -0.004];
    tri(nose, side, top);
    tri(nose, belly, side);
    tri(tail, top, side);
    tri(tail, side, belly);
    tri([0.004 * s, 0.012, -0.03], [0.013 * s, 0.034, -0.024], [0.01 * s, 0.011, -0.018]);
  }
  for (const s of [1, -1]) {
    const shoulder = [0.012 * s, 0.002, -0.018];
    const elbow = [0.052 * s, 0.006, -0.034];
    const wrist = [0.088 * s, 0.006, -0.03];
    const thumb = [0.094 * s, 0.006, -0.042];
    const hip = [0.01 * s, 0, 0.03];
    const tips = [
      [0.165 * s, 0, -0.008],
      [0.135 * s, 0, 0.034],
      [0.092 * s, 0, 0.052]
    ];
    // The leading flap of skin in front of the arm, and the thumb.
    tri(shoulder, [0.03 * s, 0.006, -0.036], elbow, 0, 1, 0);
    tri(elbow, thumb, wrist, 0, 1, 0);
    // Between the arm, the last finger and the body: the main membrane, its edge sagging in between.
    const scallop = (from: number[], to: number[], pull: number[], k: number) => {
      const u = k / 4;
      const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
      const c = [mid[0] + (pull[0] - mid[0]) * 0.28, mid[1], mid[2] + (pull[2] - mid[2]) * 0.28];
      return [0, 1, 2].map((i) => (1 - u) * (1 - u) * from[i] + 2 * (1 - u) * u * c[i] + u * u * to[i]);
    };
    for (let k = 0; k < 4; k++) {
      const a = scallop(tips[2], hip, wrist, k);
      const b2 = scallop(tips[2], hip, wrist, k + 1);
      tri(elbow, a, b2, 0, k === 0 ? 0 : 1, k + 1 === 4 ? 0 : 1);
    }
    tri(shoulder, elbow, hip);
    tri(elbow, wrist, tips[2]);
    // Between the fingers.
    for (const [f0, f1] of [
      [tips[0], tips[1]],
      [tips[1], tips[2]]
    ])
      for (let k = 0; k < 4; k++) tri(wrist, scallop(f0, f1, wrist, k), scallop(f0, f1, wrist, k + 1), 0, k === 0 ? 0 : 1, k + 1 === 4 ? 0 : 1);
    tri(wrist, thumb, tips[0], 0, 1, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("aWing", new THREE.Float32BufferAttribute(wing, 1));
  geometry.setAttribute("aEdge", new THREE.Float32BufferAttribute(edge, 1));
  return geometry;
}

type Bat = {
  colony: Cavern;
  roost: THREE.Vector3;
  p: THREE.Vector3;
  v: THREE.Vector3;
  // 0 asleep, 1 circling, 2 leaving, 3 gone.
  mode: number;
  t: number;
  laps: number;
  speed: number;
  phase: number;
  path: THREE.Vector3[];
  step: number;
  offset: THREE.Vector3;
  heard: number;
};

export function Bats() {
  const camera = useThree((state) => state.camera);
  const built = useMemo(() => {
    const random = lehmer(8128);
    const list: Bat[] = [];
    const from = new THREE.Vector3();
    for (const { kind, count } of COLONIES) {
      const cave = CAVERNS.find((c) => c.kind === kind) as Cavern;
      const own = new CavernRock(cave);
      for (let n = 0; n < 400 && list.filter((b) => b.colony === cave).length < count; n++) {
        // Packed in a couple of clusters on the roof.
        const cluster = n % 2;
        const a = random() * Math.PI * 2;
        const r = Math.sqrt(random()) * 0.25 + (cluster ? 0.2 : -0.25);
        from.set(cave.centre[0] + Math.cos(a) * 0.5 + r * cave.size[0], cave.centre[1], cave.centre[2] + Math.sin(a) * 0.5 + r * cave.size[2] * 0.6);
        if (own.sample(from.x, from.y, from.z) > -0.1) continue;
        const t = own.march(from.x, from.y, from.z, 0, 1, 0, cave.size[1] * 2.5);
        if (t <= 0) continue;
        const roost = from.clone().setY(from.y + t - 0.05);
        list.push({ colony: cave, roost, p: roost.clone(), v: new THREE.Vector3(), mode: 0, t: 0, laps: 0, speed: 0, phase: random() * 6.3, path: [], step: 0, offset: new THREE.Vector3(), heard: 0 });
      }
    }
    const count = list.length;
    const geometry = batGeometry();
    const place = new Float32Array(count * 4);
    const turn = new Float32Array(count * 4);
    const flap = new Float32Array(count * 2);
    const placeAttribute = new THREE.InstancedBufferAttribute(place, 4).setUsage(THREE.DynamicDrawUsage);
    const turnAttribute = new THREE.InstancedBufferAttribute(turn, 4).setUsage(THREE.DynamicDrawUsage);
    const flapAttribute = new THREE.InstancedBufferAttribute(flap, 2).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aPlace", placeAttribute);
    geometry.setAttribute("aTurn", turnAttribute);
    geometry.setAttribute("aFlap", flapAttribute);

    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
    const g = positionGeometry as any;
    const w = attribute("aWing", "float") as any;
    const at = attribute("aPlace", "vec4") as any;
    const q = attribute("aTurn", "vec4") as any;
    const f = attribute("aFlap", "vec2") as any;
    // Folded at rest; beating hard in flight, the stroke bending the wing more toward its tip.
    const fold = f.y as any;
    const beat = sin(rockUniforms.time.mul(17).add(f.x)).mul(float(1).sub(fold)) as any;
    const angle = beat.mul(0.95).mul(w.mul(0.4).add(0.6)) as any;
    const x = g.x.mul(mix(float(1), float(0.22), fold)) as any;
    const local = (vec3 as any)(x.mul(cos(angle)), g.y.add(abs(x).mul(sin(angle))), g.z) as any;
    const scaled = local.mul(at.w) as any;
    const rotated = scaled.add(cross(q.xyz, cross(q.xyz, scaled).add(scaled.mul(q.w))).mul(2)) as any;
    material.positionNode = at.xyz.add(rotated) as any;
    // Near black fur and bone; the membrane between, caught by the headlamp up close, glows a thin warm brown where the
    // light comes through it, and by the daylight once out of the cliff. Its free edge fades out, and a bat that
    // passes close to the eye thins to a soft shadow rather than a hard black shape across the view.
    const toEye = cameraPosition.sub(at.xyz).length() as any;
    const lit = lamp.strength.mul(0.5).div(toEye.mul(toEye).mul(0.6).add(1)) as any;
    const sky = smoothstep(0, 2, at.z) as any;
    const e = attribute("aEdge", "float") as any;
    const skin = smoothstep(0.05, 0.5, e).mul(smoothstep(0.02, 0.3, w)) as any;
    material.colorNode = mix(vec3(0.04, 0.035, 0.035), vec3(0.2, 0.09, 0.05), skin.mul(0.7))
      .mul(lit.mul(0.8).add(0.12))
      .add(vec3(0.05, 0.035, 0.04).mul(sky)) as any;
    material.opacityNode = float(1)
      .sub(smoothstep(0.8, 1, e))
      .mul(mix(float(0.9), float(0.96), skin.oneMinus()))
      .mul(smoothstep(0.7, 2.2, toEye).mul(0.75).add(0.25)) as any;

    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const identity = new THREE.Matrix4();
    for (let k = 0; k < count; k++) mesh.setMatrixAt(k, identity);
    mesh.frustumCulled = false;
    return { list, geometry, material, mesh, place, turn, flap, placeAttribute, turnAttribute, flapAttribute, random };
  }, []);
  useDispose(built.geometry, built.material);

  useEffect(() => {
    bats.scatter = (kind, breach) => {
      const { random } = built;
      // Back the way the eye came, newest first, then up out of the cliff and far off toward the sun.
      const back = trail.slice().reverse();
      const last = back[back.length - 1] ?? breach;
      const out = [breach.clone(), ...back, last.clone().add(new THREE.Vector3(1, 3, 9)), last.clone().add(new THREE.Vector3(45, 26, 70))];
      let woke = 0;
      for (const b of built.list) {
        if (b.colony.kind !== kind || b.mode !== 0) continue;
        b.mode = 1;
        // Not all at once: the colony stirs over a second.
        b.t = -random() * 1.1;
        b.laps = 1.4 + random() * 2.6;
        b.speed = 5 + random() * 2.2;
        b.path = out;
        b.step = 0;
        b.offset.set(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(0.7);
        woke++;
      }
      if (woke) {
        squeaks(18, 2.6);
        window.setTimeout(() => squeaks(12, 2), 1800);
      }
    };
    return () => {
      bats.scatter = () => {};
    };
  }, [built]);

  const scratch = useMemo(
    () => ({
      want: new THREE.Vector3(),
      m: new THREE.Matrix4(),
      q: new THREE.Quaternion(),
      ahead: new THREE.Vector3(),
      down: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
      // Frames left to send the bats to the GPU: a few at first, and on after any has flown (still hanging, nothing
      // changes).
      send: 3
    }),
    []
  );

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const { want, m, q, ahead, down } = scratch;
    const { list, place, turn, flap } = built;
    if (scratch.send <= 0 && !list.some((b) => b.mode === 1 || b.mode === 2)) return;
    scratch.send = 2;
    for (let k = 0; k < list.length; k++) {
      const b = list[k];
      let scale = 1;
      if (b.mode === 0) {
        // Asleep, hanging head down, swaying a little.
        b.p.copy(b.roost);
        q.copy(down);
        flap[k * 2 + 1] = 1;
      } else if (b.mode === 3) {
        scale = 0;
      } else {
        b.t += dt;
        if (b.t < 0) {
          b.p.copy(b.roost);
          q.copy(down);
          flap[k * 2 + 1] = 1;
        } else {
          const c = b.colony;
          if (b.mode === 1) {
            // Laps of the cavern, each its own ellipse and height.
            const a = b.t * (b.speed / (c.size[0] * 0.55)) + b.phase;
            want.set(c.centre[0] + Math.cos(a) * c.size[0] * 0.55, c.centre[1] + 0.4 + Math.sin(a * 1.7 + b.phase) * c.size[1] * 0.3, c.centre[2] + Math.sin(a) * c.size[2] * 0.55);
            if (b.t > b.laps) b.mode = 2;
          } else {
            const target = b.path[Math.min(b.step, b.path.length - 1)];
            want.copy(target).addScaledVector(b.offset, b.step < b.path.length - 2 ? 0.5 : 4);
            if (b.p.distanceTo(want) < 0.8) b.step++;
            if (b.step >= b.path.length) b.mode = 3;
          }
          want.sub(b.p).normalize().multiplyScalar(b.speed);
          // A little flutter in the line, never a straight glide.
          want.x += Math.sin(b.t * 9 + b.phase) * 1.2;
          want.y += Math.sin(b.t * 7.3 + b.phase * 2) * 0.9;
          b.v.lerp(want, Math.min(1, dt * 5));
          b.p.addScaledVector(b.v, dt);
          // Never through the head: they swerve round it, at a metre and a bit.
          ahead.copy(b.p).sub(camera.position);
          const gap = ahead.length();
          if (gap < CLEAR && gap > 1e-4) {
            b.p.copy(camera.position).addScaledVector(ahead, CLEAR / gap);
            b.v.addScaledVector(ahead, ((CLEAR - gap) / gap) * 6);
          }
          ahead.copy(b.p).add(b.v);
          m.lookAt(b.p, ahead, THREE.Object3D.DEFAULT_UP);
          q.setFromRotationMatrix(m);
          flap[k * 2 + 1] = Math.max(0, flap[k * 2 + 1] - dt * 4);
          // Past the ear: a flutter of wings.
          const near = b.p.distanceTo(camera.position);
          if (near < 1.4 && b.t - b.heard > 1.5) {
            b.heard = b.t;
            flutter(1 - near / 1.4, 0);
          }
        }
      }
      flap[k * 2] = b.phase;
      place[k * 4] = b.p.x;
      place[k * 4 + 1] = b.p.y;
      place[k * 4 + 2] = b.p.z;
      place[k * 4 + 3] = scale;
      turn[k * 4] = q.x;
      turn[k * 4 + 1] = q.y;
      turn[k * 4 + 2] = q.z;
      turn[k * 4 + 3] = q.w;
    }
    scratch.send--;
    built.placeAttribute.needsUpdate = true;
    built.turnAttribute.needsUpdate = true;
    built.flapAttribute.needsUpdate = true;
  });

  return <primitive object={built.mesh} />;
}
