"use client";

import { useFrame } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three/webgpu";
import { buildDeerSkin } from "./deerSkin";
import { abs, attribute, bumpMap, cos, cross, float, Fn, length, max, mix, mx_noise_float, normalGeometry, normalize, normalLocal, positionGeometry, positionLocal, sign, sin, smoothstep, time, varying, vec2, vec3, vertexColor } from "three/tsl";
import { sound } from "../shared/engine/sound";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const WANDER_RADIUS = 19;
// As much as a deer will step up onto in one stride. Anything taller it walks around.
const STEP_UP = 0.62;
const NECK = new THREE.Vector2(0.42, 1.04);

// Nose along +x, hooves at y = 0. aRig is (0 body, 0.3 tail, 1 neck and head, 1.2 antlers, 2 leg) and a stride phase.
function buildDeer() {
  const position: number[] = [];
  const normal: number[] = [];
  const color: number[] = [];
  const rig: number[] = [];
  const add = (geometry: THREE.BufferGeometry, hex: string, kind: number, phase = 0) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    const shade = new THREE.Color(hex);
    const count = flat.getAttribute("position").count;
    position.push(...(flat.getAttribute("position").array as Float32Array));
    normal.push(...(flat.getAttribute("normal").array as Float32Array));
    for (let i = 0; i < count; i++) {
      color.push(shade.r, shade.g, shade.b);
      rig.push(kind, phase);
    }
  };
  const blob = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const geometry = new THREE.SphereGeometry(1, 20, 14);
    geometry.scale(sx, sy, sz);
    geometry.translate(x, y, z);
    // Worked out while it is still one surface, so that it shades smoothly.
    geometry.computeVertexNormals();
    return geometry;
  };
  const up = new THREE.Vector3(0, 1, 0);
  const bone = (from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number) => {
    const length = from.distanceTo(to);
    const geometry = new THREE.CylinderGeometry(r1, r0, length, 8);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, to.clone().sub(from).normalize()));
    const middle = from.clone().add(to).multiplyScalar(0.5);
    geometry.translate(middle.x, middle.y, middle.z);
    return geometry;
  };
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  for (const side of [-1, 1]) {
    // Ears, standing up and out, with the eye below them.
    const ear = new THREE.SphereGeometry(1, 14, 10);
    ear.scale(0.03, 0.095, 0.05);
    ear.rotateX(side * 0.65);
    ear.rotateZ(0.25);
    ear.translate(0.69, 1.66, side * 0.115);
    ear.computeVertexNormals();
    add(ear, "#573a22", 1);
    add(blob(0.875, 1.575, side * 0.06, 0.017, 0.016, 0.012), "#060403", 1);
    // A main beam sweeping up and forward, with tines off it.
    const beam = [v(0.75, 1.64, side * 0.05), v(0.7, 1.86, side * 0.17), v(0.76, 2.08, side * 0.26), v(0.9, 2.26, side * 0.27), v(1.06, 2.38, side * 0.2)];
    for (let i = 0; i < beam.length - 1; i++) add(bone(beam[i], beam[i + 1], 0.023 - i * 0.004, 0.019 - i * 0.004), "#d8c7a3", 1.2);
    add(bone(beam[1], v(0.92, 1.96, side * 0.2), 0.016, 0.006), "#d8c7a3", 1.2);
    add(bone(beam[2], v(0.96, 2.2, side * 0.36), 0.014, 0.005), "#d8c7a3", 1.2);
    add(bone(beam[3], v(0.84, 2.46, side * 0.32), 0.012, 0.004), "#d8c7a3", 1.2);
  }

  // A tail: short, dark above and white beneath.
  add(blob(-0.72, 1.04, 0, 0.1, 0.055, 0.045), "#d9cdb8", 0.3);

  // The body, added as an indexed surface in its own right, then the loose parts above folded in with it.
  const skin = buildDeerSkin();
  const start = position.length / 3;
  const allIndex: number[] = [];
  for (let i = 0; i < start; i++) allIndex.push(i);
  for (const i of skin.index) allIndex.push(i + start);
  position.push(...skin.position);
  normal.push(...skin.normal);
  color.push(...skin.color);
  rig.push(...skin.rig);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
  geometry.setAttribute("aRig", new THREE.Float32BufferAttribute(rig, 2));
  geometry.setIndex(allIndex);
  return geometry;
}

type Plate = { body: any | null; phase: string };

// A small herd on the ice. They wander, graze and keep together, and bolt from anything coming down near them.
// One instanced draw of a herd. Each deer is posed by aPose (stride phase, stride amount, head down) and by its forward and up axes.
export function createDeerMesh(count: number) {
  const geometry = buildDeer();
  // Everything per deer shares one buffer, because WebGPU only allows a mesh eight of them. Pose, two axes, then
  // tuck (legs drawn up in a jump) and flick (ears and tail), then tint and antler size, which stay 1 unless set.
  const stride = 13;
  const data = new Float32Array(count * stride);
  for (let i = 0; i < count; i++) data.fill(1, i * stride + 11, i * stride + 13);
  const shared = new THREE.InstancedInterleavedBuffer(data, stride);
  shared.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aPose", new THREE.InterleavedBufferAttribute(shared, 3, 0));
  geometry.setAttribute("aAxisX", new THREE.InterleavedBufferAttribute(shared, 3, 3));
  geometry.setAttribute("aAxisY", new THREE.InterleavedBufferAttribute(shared, 3, 6));
  geometry.setAttribute("aMotion", new THREE.InterleavedBufferAttribute(shared, 2, 9));
  geometry.setAttribute("aStyle", new THREE.InterleavedBufferAttribute(shared, 2, 11));

  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, vertexColors: true });
  const pose = attribute("aPose", "vec3") as any;
  const rigging = attribute("aRig", "vec2") as any;
  const axisX = attribute("aAxisX", "vec3") as any;
  const axisY = attribute("aAxisY", "vec3") as any;
  const moving = attribute("aMotion", "vec2") as any;
  const style = attribute("aStyle", "vec2") as any;
  const part = rigging.x as any;
  const isNeck = smoothstep(0.5, 0.6, part).mul(float(1).sub(smoothstep(1.4, 1.5, part))) as any;
  const isLeg = smoothstep(1.5, 1.6, part) as any;
  const isRack = smoothstep(1.1, 1.15, part).mul(float(1).sub(smoothstep(1.3, 1.35, part))) as any;
  const isTail = smoothstep(0.2, 0.25, part).mul(float(1).sub(smoothstep(0.4, 0.45, part))) as any;
  // Fur: fine streaks running back along the body, in the colour and in how the surface catches the light.
  const hair = (mx_noise_float(varying(positionGeometry).mul(vec3(38, 190, 190))) as any).mul(0.5).add(0.5) as any;
  const body = float(1).sub(isRack) as any;
  material.colorNode = vertexColor().mul(mix(float(1), style.x, body)).mul(mix(float(1), hair.mul(0.42).add(0.8), body)) as any;
  material.normalNode = bumpMap(hair.mul(body), float(0.32)) as any;
  // A tint above 1 also lifts the shadow side, for a day whose sun sits behind them. At the default of 1 this adds nothing.
  material.emissiveNode = vertexColor().mul(vertexColor()).mul(max(style.x.sub(1), float(0))).mul(body).mul(0.28) as any;

  // Legs swing from the hip, and the lower leg lags behind for a bit of a knee.
  const local = positionGeometry as any;
  const phase = pose.x.add(rigging.y) as any;
  const swing = sin(phase).mul(pose.y).mul(0.42) as any;
  const below = float(0.9).sub(local.y) as any;
  const lowerLeg = float(1).sub(smoothstep(0.1, 0.46, local.y)) as any;
  const knee = lowerLeg.mul(sin(phase.sub(1.2))).mul(pose.y).mul(0.14) as any;
  // The foot only lifts on the way forward. On the way back it is planted, carrying the weight.
  const lift = max(cos(phase), float(0)).mul(pose.y).mul(0.13).mul(smoothstep(0, 0.5, below.mul(1.2))) as any;
  // In a jump the legs fold: fronts up and forward, hinds up and back.
  const tuck = moving.x as any;
  const reach = sign(local.x) as any;
  const folded = below.mul(tuck) as any;
  const legX = isLeg.mul(below.mul(swing).add(knee).add(folded.mul(reach).mul(0.36))) as any;
  const legY = isLeg.mul(lift.add(folded.mul(0.62))) as any;
  // Antlers grow from the top of the head, down to nothing on a doe. Only days that set a size use this, with the side axis as forward cross up.
  // This comes first, in the deer's own frame: done after the neck turns, a doe's antlers open out into a flat sheet on her head.
  const rackBase = vec3(0.72, 1.62, 0) as any;
  const shrink = isRack.mul(style.y.sub(1)) as any;
  const grown = local.add(local.sub(rackBase).mul(shrink)) as any;
  // Neck and head bow around the base of the neck, nodding a little in time with the stride.
  const nod = sin(pose.x.mul(2)).mul(pose.y).mul(0.05) as any;
  const bow = pose.z.mul(1.22).add(sin(time.mul(0.9).add(pose.x)).mul(0.02)).add(nod) as any;
  const fromNeck = grown.xy.sub(vec2(NECK.x, NECK.y)) as any;
  // The angle eases in along the neck, and not the moved position, which would squash the flesh flat as it bends.
  const c = cos(bow.mul(isNeck)) as any;
  const s = sin(bow.mul(isNeck)) as any;
  const neckX = fromNeck.x.mul(c).add(fromNeck.y.mul(s)).sub(fromNeck.x) as any;
  const neckY = fromNeck.y.mul(c).sub(fromNeck.x.mul(s)).sub(fromNeck.y) as any;
  const nibble = sin(time.mul(7).add(pose.x)).mul(0.012).mul(max(pose.z, float(0))).mul(isNeck) as any;
  const bob = abs(sin(pose.x.mul(2))).mul(pose.y).mul(0.022).mul(float(1).sub(isLeg)) as any;
  // A flick of the tail, and a breath moving through the body when standing still.
  const flick = isTail.mul(moving.y).mul(sin(time.mul(30))).mul(0.05) as any;
  const breath = sin(time.mul(1.5).add(rigging.y)).mul(0.005).mul(float(1).sub(isLeg)) as any;
  const scale = length(axisX) as any;
  const axisZ = cross(axisX, axisY).div(max(scale, float(0.001))) as any;
  const rackOffset = axisX.mul(grown.x.sub(local.x)).add(axisY.mul(grown.y.sub(local.y))).add(axisZ.mul(grown.z.sub(local.z))) as any;
  const moved = positionLocal.add(axisX.mul(legX.add(neckX).add(flick))).add(axisY.mul(legY.add(neckY).add(bob).add(nibble).add(breath))).add(rackOffset) as any;
  // The surface's facing turns with the neck, or a bowed head keeps the light of a raised one.
  const facing = normalGeometry as any;
  const turned = axisX.mul(facing.x.mul(c).add(facing.y.mul(s))).add(axisY.mul(facing.y.mul(c).sub(facing.x.mul(s)))).add(axisZ.mul(facing.z)) as any;
  material.positionNode = Fn(() => {
    normalLocal.assign(normalize(turned));
    return moved;
  })();
  material.castShadowPositionNode = moved;

  const instanced = new THREE.InstancedMesh(geometry, material, count);
  instanced.castShadow = true;
  instanced.receiveShadow = true;
  instanced.frustumCulled = false;
  return instanced;
}

// The only thing the lake's mirror pass draws.
export const DEER_LAYER = 2;

export function DeerHerd({ count, plates }: { count: number; plates: RefObject<Plate[]> }) {
  const herd = useMemo(() => {
    const hash = (n: number) => {
      const s = Math.sin(n * 57.31) * 43758.5453;
      return s - Math.floor(s);
    };
    return Array.from({ length: count }, (_, i) => {
      const group = i % 3;
      const angle = group * 2.1 + 0.7 + hash(i) * 0.6;
      const reach = 8 + group * 3.4 + hash(i + 9) * 2.5;
      return {
        x: Math.cos(angle) * reach,
        z: Math.sin(angle) * reach - 7,
        heading: hash(i + 2) * Math.PI * 2,
        group,
        scale: 0.62 + hash(i + 4) * 0.22,
        walk: hash(i + 5) * 6,
        stride: 0,
        graze: hash(i + 6),
        grazing: hash(i + 7) > 0.5,
        timer: hash(i + 8) * 5,
        fear: 0,
        fleeX: 0,
        fleeZ: 0,
        scan: hash(i + 10) * 0.3,
        y: 0,
        ux: 0,
        uy: 1,
        uz: 0
      };
    });
  }, [count]);

  const mesh = useMemo(() => {
    const herd = createDeerMesh(count);
    herd.layers.enable(DEER_LAYER);
    return herd;
  }, [count]);
  const { rapier, world } = useRapier();
  const ray = useMemo(() => new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }), [rapier]);

  // What is underfoot, found by asking the physics world: the top of a fallen plate, or the ice.
  const groundAt = (x: number, z: number, from: number) => {
    ray.origin.x = x;
    ray.origin.y = from + 1.1;
    ray.origin.z = z;
    const hit = world.castRayAndGetNormal(ray, from + 1.3, true);
    if (!hit || hit.timeOfImpact <= 0) return hit ? { y: from + 1.1, nx: 0, ny: 1, nz: 0, inside: true } : { y: 0, nx: 0, ny: 1, nz: 0, inside: false };
    return { y: Math.max(0, ray.origin.y - hit.timeOfImpact), nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z, inside: false };
  };

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    },
    [mesh]
  );

  const scratch = useMemo(() => new THREE.Matrix4(), []);
  const nextHoof = useRef(1);

  useFrame(({ camera }, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const pose = mesh.geometry.getAttribute("aPose") as THREE.InterleavedBufferAttribute;
    const axisX = mesh.geometry.getAttribute("aAxisX") as THREE.InterleavedBufferAttribute;
    const axisY = mesh.geometry.getAttribute("aAxisY") as THREE.InterleavedBufferAttribute;
    const clock = performance.now() / 1000;

    for (let i = 0; i < count; i++) {
      const deer = herd[i];
      deer.scan -= delta;
      if (deer.scan < 0) {
        deer.scan = 0.3;
        let awayX = 0;
        let awayZ = 0;
        for (const plate of plates.current ?? []) {
          if (plate.phase !== "falling" || !plate.body) continue;
          const at = plate.body.translation();
          if (at.y > 9 || at.y < 0.8) continue;
          const dx = deer.x - at.x;
          const dz = deer.z - at.z;
          const squared = dx * dx + dz * dz;
          if (squared > 42 || squared < 1e-4) continue;
          awayX += dx / squared;
          awayZ += dz / squared;
        }
        if (awayX !== 0 || awayZ !== 0) {
          deer.fear = 1;
          deer.fleeX = awayX;
          deer.fleeZ = awayZ;
          deer.grazing = false;
        }
      }
      deer.fear = Math.max(0, deer.fear - delta * 0.45);
      const fleeing = deer.fear > 0;

      deer.timer -= delta;
      if (deer.timer < 0 && !fleeing) {
        deer.grazing = !deer.grazing;
        deer.timer = deer.grazing ? 3 + ((i * 7 + Math.floor(clock)) % 6) : 3 + ((i * 3 + Math.floor(clock)) % 5);
      }
      const speed = fleeing ? 3.2 : deer.grazing ? 0 : 0.62;
      deer.graze += ((deer.grazing && !fleeing ? 1 : 0) - deer.graze) * (1 - Math.exp(-delta * 2.6));

      let turn = Math.sin(clock * 0.27 + i * 1.9) * 0.28;
      let wanted: number | null = null;
      if (fleeing) wanted = Math.atan2(deer.fleeZ, deer.fleeX);
      else {
        let cx = 0;
        let cz = 0;
        let near = 0;
        for (const other of herd) {
          if (other === deer || other.group !== deer.group) continue;
          cx += other.x - deer.x;
          cz += other.z - deer.z;
          near++;
        }
        if (near && Math.hypot(cx / near, cz / near) > 3) wanted = Math.atan2(cz, cx);
      }
      // The treeline and the near shore are the edges of their world.
      const r = Math.hypot(deer.x, deer.z);
      if (r > WANDER_RADIUS - 2.5 || deer.z > 2) wanted = Math.atan2(-7 - deer.z, -deer.x);
      if (wanted !== null) turn = Math.atan2(Math.sin(wanted - deer.heading), Math.cos(wanted - deer.heading)) * (fleeing ? 4 : 1.2);
      deer.heading += turn * delta;
      // Looks a stride ahead: a low plate is walked up onto, and a tall one or a steep face is walked around.
      const lookX = deer.x + Math.cos(deer.heading) * (0.5 + speed * 0.2);
      const lookZ = deer.z + Math.sin(deer.heading) * (0.5 + speed * 0.2);
      const ahead = groundAt(lookX, lookZ, deer.y);
      const wall = ahead.inside || ahead.y - deer.y > STEP_UP || ahead.ny < 0.45;
      if (wall) {
        deer.heading += (i % 2 ? 1 : -1) * 3.2 * delta;
      } else {
        deer.x += Math.cos(deer.heading) * speed * delta;
        deer.z += Math.sin(deer.heading) * speed * delta;
      }
      const limit = WANDER_RADIUS / Math.max(WANDER_RADIUS, Math.hypot(deer.x, deer.z));
      deer.x *= limit;
      deer.z *= limit;
      deer.stride += (Math.min(1, speed * 1.3) - deer.stride) * (1 - Math.exp(-delta * 6));
      deer.walk += speed * delta * (fleeing ? 3.4 : 6.6);

      // Rises onto what is underfoot quickly, comes down off it at a walk, and leans with the slope.
      const under = groundAt(deer.x, deer.z, deer.y);
      const towards = under.y - deer.y;
      deer.y += Math.max(-1.6 * delta, Math.min(4 * delta, towards));
      const lean = 1 - Math.exp(-delta * 7);
      const flatEnough = under.inside || under.ny < 0.45;
      deer.ux += ((flatEnough ? 0 : under.nx * 0.8) - deer.ux) * lean;
      deer.uy += ((flatEnough ? 1 : under.ny * 0.8 + 0.2) - deer.uy) * lean;
      deer.uz += ((flatEnough ? 0 : under.nz * 0.8) - deer.uz) * lean;
      const upLength = Math.hypot(deer.ux, deer.uy, deer.uz) || 1;
      const ux = deer.ux / upLength;
      const uy = deer.uy / upLength;
      const uz = deer.uz / upLength;
      let fx = Math.cos(deer.heading);
      let fz = Math.sin(deer.heading);
      const along = fx * ux + fz * uz;
      let fy = -along * uy;
      fx -= along * ux;
      fz -= along * uz;
      const forwardLength = Math.hypot(fx, fy, fz) || 1;
      fx /= forwardLength;
      fy /= forwardLength;
      fz /= forwardLength;
      const s = deer.scale;
      // Forward crossed with up, so that the deer is not mirrored and its faces wind outward.
      const sx = fy * uz - fz * uy;
      const sy = fz * ux - fx * uz;
      const sz = fx * uy - fy * ux;
      scratch.set(fx * s, ux * s, sx * s, deer.x, fy * s, uy * s, sy * s, deer.y, fz * s, uz * s, sz * s, deer.z, 0, 0, 0, 1);
      mesh.setMatrixAt(i, scratch);
      pose.setXYZ(i, deer.walk, deer.stride, deer.graze);
      axisX.setXYZ(i, fx * s, fy * s, fz * s);
      axisY.setXYZ(i, ux * s, uy * s, uz * s);
    }
    mesh.instanceMatrix.needsUpdate = true;
    pose.data.needsUpdate = true;

    // Now and then a hoof on the ice, from whichever deer is moving. A bolting herd is a clatter.
    nextHoof.current -= delta;
    if (nextHoof.current < 0) {
      const deer = herd[Math.floor(Math.random() * count)];
      const bolting = deer.fear > 0;
      nextHoof.current = bolting ? 0.08 + Math.random() * 0.1 : 0.3 + Math.random() * 1.2;
      if (bolting || !deer.grazing) {
        const near = Math.min(1.3, 18 / Math.hypot(deer.x - camera.position.x, deer.z - camera.position.z));
        sound.play("hoof", { gain: near * (bolting ? 1 : 0.6), pitch: 0.85 + Math.random() * 0.3, pan: (deer.x - camera.position.x) / 22 });
      }
    }
  });

  return <primitive object={mesh} />;
}
