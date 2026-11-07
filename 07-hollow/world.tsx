"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  abs,
  cameraPosition,
  color,
  dot,
  floor,
  length,
  normalMap,
  texture,
  texture3D,
  fract,
  instanceIndex,
  mix,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  step,
  float,
  vec3,

} from "three/tsl";
import * as THREE from "three/webgpu";
import { OVERLAY_LAYER } from "../shared/engine/Post";
import { Bubbles, FLOOR, Reef, causticsOn, throughWater, type ReefAssets } from "./reef";
import { SUN, sunrise } from "./ocean";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Aeroplanes, a long way up, each drawing a line across the dawn.
export function Planes({ count }: { count: number }) {
  const parts = useMemo(() => {
    const body = new THREE.CapsuleGeometry(0.16, 2.4, 4, 8);
    body.rotateZ(Math.PI / 2);
    const wing = new THREE.BoxGeometry(0.42, 0.03, 2.9);
    const fin = new THREE.BoxGeometry(0.34, 0.5, 0.03);
    fin.translate(-1.28, 0.26, 0);
    const tail = new THREE.BoxGeometry(0.26, 0.03, 1);
    tail.translate(-1.26, 0.03, 0);
    const shapes = [body, wing, fin, tail].map((part) => {
      const flat = part.index ? part.toNonIndexed() : part;
      flat.deleteAttribute("uv");
      return flat;
    });
    const merged = mergeGeometries(shapes) as THREE.BufferGeometry;
    const plane = new THREE.InstancedMesh(merged, new THREE.MeshBasicMaterial({ color: "#55506a" }), count);
    const trailMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const u = (positionGeometry as any).x;
    trailMaterial.colorNode = color("#fff1e4") as any;
    trailMaterial.opacityNode = (smoothstep(0, 1, u) as any).mul(u.mul(u)).mul(0.5) as any;
    const strip = new THREE.BoxGeometry(1, 0.18, 0.18);
    strip.translate(0.5, 0, 0);
    const trail = new THREE.InstancedMesh(strip, trailMaterial, count);
    for (const mesh of [plane, trail]) mesh.frustumCulled = false;
    return { plane, trail };
  }, [count]);
  useEffect(
    () => () => {
      parts.plane.dispose();
      parts.trail.dispose();
    },
    [parts]
  );
  const routes = useMemo(() => Array.from({ length: count }, (_, i) => ({ height: 46 + i * 15, off: -130 - i * 60, heading: -0.4 + i * 0.9, speed: 9 - i * 1.2, along: -180 + i * 170 })), [count]);
  const work = useMemo(() => ({ matrix: new THREE.Matrix4(), turn: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0), at: new THREE.Vector3(), scale: new THREE.Vector3(), back: new THREE.Vector3() }), []);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    routes.forEach((route, i) => {
      route.along += route.speed * delta;
      if (route.along > 260) route.along = -260;
      const cos = Math.cos(route.heading);
      const sin_ = Math.sin(route.heading);
      work.at.set(cos * route.along - sin_ * route.off, route.height, -sin_ * route.along - cos * route.off);
      work.turn.setFromAxisAngle(work.up, route.heading);
      work.scale.setScalar(1.7);
      work.matrix.compose(work.at, work.turn, work.scale);
      parts.plane.setMatrixAt(i, work.matrix);
      // The trail runs back along the way it came, from just behind the tail.
      work.back.set(-cos, 0, sin_);
      const length_ = Math.min(90, route.along + 260);
      work.at.addScaledVector(work.back, 2.4 + length_);
      work.scale.set(length_, 1, 1);
      work.matrix.compose(work.at, work.turn, work.scale);
      parts.trail.setMatrixAt(i, work.matrix);
    });
    parts.plane.instanceMatrix.needsUpdate = true;
    parts.trail.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <primitive object={parts.plane} />
      <primitive object={parts.trail} />
    </>
  );
}

// A thin line of far-off land, running from the city away to one side, just clear of the water.
export function FarLand() {
  const material = useMemo(() => {
    const land = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    land.colorNode = mix(color("#a78ea9"), color("#c79aa0"), smoothstep(0, 5, (positionWorld as any).y)) as any;
    return land;
  }, []);
  const geometry = useMemo(() => {
    const position: number[] = [];
    const index: number[] = [];
    const steps = 220;
    const middle = Math.atan2(-0.24, -0.97);
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      // From just left of the city, round to the right of it.
      const angle = middle - 0.16 + u * 1.38;
      const edge = Math.min(1, u * 9) * Math.min(1, (1 - u) * 5);
      const ridge = (1.1 + 1.3 * (0.5 + 0.5 * Math.sin(u * 19 + 1)) + 1 * (0.5 + 0.5 * Math.sin(u * 53 + 2)) + 0.32 * Math.sin(u * 141)) * edge;
      const r = 335 + Math.sin(u * 7) * 6;
      position.push(Math.sin(angle) * r, -0.5, Math.cos(angle) * r, Math.sin(angle) * r, Math.max(0.05, ridge), Math.cos(angle) * r);
      if (i < steps) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const shape = new THREE.BufferGeometry();
    shape.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    shape.setIndex(index);
    return shape;
  }, []);
  useEffect(
    () => () => {
      material.dispose();
      geometry.dispose();
    },
    [material, geometry]
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

export function SkyDome({ time, noise, under }: { time: any; noise: THREE.Data3DTexture; under: any }) {
  const camera = useThree((state) => state.camera);
  const mesh = useRef<THREE.Mesh>(null);
  const material = useMemo(() => {
    const dome = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    const look = normalize(positionWorld.sub(cameraPosition)) as any;
    // Under the water there is no sky: only blue-green, going dark with depth.
    const deepWater = mix(color("#0d6068"), color("#06313a"), smoothstep(-0.05, -0.85, look.y));
    dome.colorNode = mix(sunrise(look, time, true, noise), deepWater, under) as any;
    return dome;
  }, [time, noise, under]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(() => mesh.current?.position.copy(camera.position));
  return (
    <mesh ref={mesh} material={material} renderOrder={-10} frustumCulled={false} layers={1}>
      <sphereGeometry args={[370, 48, 32]} />
    </mesh>
  );
}

// A far-off city at dawn: blue with distance, with a few windows still lit.
export function Skyline() {
  const mesh = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial();
    const p = positionGeometry as any;
    const w = positionWorld as any;
    const haze = mix(color("#a98fa8"), color("#e0a698"), smoothstep(0, 26, w.y));
    const cell = floor(vec3(w.x.mul(3.2), w.y.mul(3.6), w.z.mul(3.2)));
    const seed = fract(sin(cell.x.mul(12.9).add(cell.y.mul(78.2)).add(cell.z.mul(37.7))).mul(43758.5)) as any;
    const face = step(0.5, abs(p.y).negate().add(1));
    material.colorNode = mix(haze, color("#ffdca6"), step(0.94, seed).mul(face).mul(0.42)) as any;
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const count = 150;
    const instanced = new THREE.InstancedMesh(box, material, count);
    const matrix = new THREE.Matrix4();
    const place = new THREE.Vector3();
    const size = new THREE.Vector3();
    const turn = new THREE.Quaternion();
    const middle = new THREE.Vector3(-0.24, 0, -0.97).normalize().multiplyScalar(330);
    const sideways = new THREE.Vector3(0.97, 0, -0.24);
    for (let i = 0; i < count; i++) {
      const u = (i / (count - 1)) * 2 - 1;
      const towers = Math.exp(-u * u * 6);
      const random = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      const random2 = Math.abs(Math.sin(i * 78.233) * 12543.19) % 1;
      place.copy(middle).addScaledVector(sideways, u * 62 + (random - 0.5) * 3);
      place.z += (random2 - 0.5) * 24;
      size.set(1.4 + random * 2.8, 2 + towers * (4 + random2 * random2 * 18) + random * 2.5, 1.4 + random2 * 2.8);
      matrix.compose(place, turn, size);
      instanced.setMatrixAt(i, matrix);
    }
    instanced.frustumCulled = false;
    return instanced;
  }, []);
  useEffect(() => () => mesh.dispose(), [mesh]);
  return <primitive object={mesh} />;
}

// A small sailing boat, with its bow along +x.
function boatGeometry() {
  const hull = new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  hull.scale(0.95, 0.26, 0.28);
  const deck = new THREE.CylinderGeometry(1, 1, 0.012, 16);
  deck.scale(0.95, 1, 0.28);
  const cabin = new THREE.BoxGeometry(0.42, 0.14, 0.26);
  cabin.translate(-0.08, 0.07, 0);
  const mast = new THREE.CylinderGeometry(0.012, 0.016, 1.8, 6);
  mast.translate(0.08, 0.9, 0);
  const sail = new THREE.BufferGeometry();
  sail.setAttribute("position", new THREE.Float32BufferAttribute([0.04, 0.2, 0.012, 0.04, 1.72, 0.012, -0.72, 0.2, 0.09, 0.14, 0.2, 0.012, 0.14, 1.6, 0.012, 0.62, 0.22, 0.05], 3));
  sail.setIndex([0, 1, 2, 3, 5, 4]);
  sail.computeVertexNormals();
  const parts = [hull, deck, cabin, mast, sail].map((part) => {
    const flat = part.index ? part.toNonIndexed() : part;
    flat.deleteAttribute("uv");
    flat.computeVertexNormals();
    return flat;
  });
  const merged = mergeGeometries(parts) as THREE.BufferGeometry;
  parts.forEach((part) => part.dispose());
  return merged;
}

// Small boats, close around the peach: little sailing dinghies and open rowing boats, going round it at their own pace.
export function Dinghies({ count, impact, surface }: { count: number; impact: (x: number, z: number, amount: number) => void; surface: (x: number, z: number, t: number) => number }) {
  const parts = useMemo(() => {
    const open = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).toNonIndexed();
    open.scale(0.9, 0.22, 0.32);
    const rim = new THREE.CylinderGeometry(0.9, 0.9, 0.012, 16, 1, true).toNonIndexed();
    rim.scale(1, 1, 0.355);
    const seat = new THREE.BoxGeometry(0.1, 0.02, 0.46).toNonIndexed();
    seat.translate(0.1, -0.03, 0);
    const person = new THREE.CapsuleGeometry(0.075, 0.18, 3, 8).toNonIndexed();
    person.translate(0.1, 0.1, 0);
    const shapes = [open, rim, seat, person];
    shapes.forEach((part) => {
      part.deleteAttribute("uv");
      part.computeVertexNormals();
    });
    const rowing = mergeGeometries(shapes) as THREE.BufferGeometry;
    const paint = () => {
      const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.56, metalness: 0 });
      const y = (positionGeometry as any).y;
      const tag = fract(float(instanceIndex).mul(0.613));
      const hull = mix(mix(mix(color("#e8e2d4"), color("#2f6a9c"), step(0.32, tag)), color("#c9472f"), step(0.62, tag)), color("#2b6a50"), step(0.84, tag));
      material.colorNode = mix(hull, color("#f5ecdc"), smoothstep(0.01, 0.03, y)) as any;
      return material;
    };
    const sailing = new THREE.InstancedMesh(boatGeometry(), paint(), Math.ceil(count * 0.55));
    const rowingMesh = new THREE.InstancedMesh(rowing, paint(), Math.floor(count * 0.45));
    for (const mesh of [sailing, rowingMesh]) {
      mesh.frustumCulled = false;
      mesh.castShadow = true;
    }
    return { sailing, rowingMesh };
  }, [count]);
  useEffect(
    () => () => {
      parts.sailing.dispose();
      parts.rowingMesh.dispose();
    },
    [parts]
  );
  const boats = useMemo(() => {
    const seed = (i: number, n: number) => Math.abs(Math.sin((i + 1) * (9.73 + n)) * 43758.5453) % 1;
    return Array.from({ length: count }, (_, i) => ({ angle: seed(i, 1) * Math.PI * 2, radius: 6.6 + seed(i, 2) * 11, speed: (seed(i, 3) > 0.5 ? 1 : -1) * (0.3 + seed(i, 4) * 0.35), size: 0.3 + seed(i, 5) * 0.26, next: seed(i, 6) * 4 }));
  }, [count]);
  const work = useMemo(() => ({ matrix: new THREE.Matrix4(), place: new THREE.Vector3(), scale: new THREE.Vector3(), turn: new THREE.Quaternion(), rock: new THREE.Euler(), clock: 0 }), []);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    work.clock += delta;
    const sailingCount = parts.sailing.count;
    boats.forEach((boat, i) => {
      boat.angle += (boat.speed * delta) / boat.radius;
      const x = Math.cos(boat.angle) * boat.radius;
      const z = Math.sin(boat.angle) * boat.radius;
      const heading = boat.speed > 0 ? -boat.angle - Math.PI / 2 : -boat.angle + Math.PI / 2;
      work.rock.set(Math.sin(work.clock * 1.2 + i) * 0.14, heading, Math.sin(work.clock * 0.93 + i * 2) * 0.1, "YXZ");
      work.turn.setFromEuler(work.rock);
      work.place.set(x, surface(x, z, work.clock) + 0.015, z);
      work.scale.setScalar(boat.size);
      work.matrix.compose(work.place, work.turn, work.scale);
      if (i < sailingCount) parts.sailing.setMatrixAt(i, work.matrix);
      else parts.rowingMesh.setMatrixAt(i - sailingCount, work.matrix);
      // The rings on the water are few, so each boat only asks for one now and then.
      boat.next -= delta;
      if (boat.next < 0) {
        boat.next = 5 + (i % 5);
        impact(x, z, 0.16);
      }
    });
    parts.sailing.instanceMatrix.needsUpdate = true;
    parts.rowingMesh.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <primitive object={parts.sailing} />
      <primitive object={parts.rowingMesh} />
    </>
  );
}

export function Boats({ count, impact, surface }: { count: number; impact: (x: number, z: number, amount: number) => void; surface: (x: number, z: number, t: number) => number }) {
  const boats = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        // A few close by, and the rest further and further off, down to specks on the horizon.
        radius: i < 5 ? 15 + i * 6 : 48 + (i - 5) * (i - 5) * 3.4 + (i % 2) * 9,
        angle: i * 2.1 + 0.6,
        speed: (i % 2 ? -1 : 1) * (0.05 - i * 0.004),
        size: (0.8 + ((i * 37) % 10) * 0.05) * (i < 5 ? 1 : 1.5),
        next: i * 0.4
      })),
    [count]
  );
  const mesh = useMemo(() => {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.52, metalness: 0 });
    const y = (positionGeometry as any).y;
    const tag = fract(float(instanceIndex).mul(0.37));
    const hull = mix(mix(color("#c84632"), color("#21456f"), step(0.45, tag)), color("#f1e8db"), smoothstep(-0.03, 0.02, y));
    material.colorNode = mix(hull, color("#fff6e8"), smoothstep(0.2, 0.22, y)) as any;
    const instanced = new THREE.InstancedMesh(boatGeometry(), material, count);
    instanced.frustumCulled = false;
    instanced.castShadow = true;
    return instanced;
  }, [count]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  const work = useMemo(() => ({ matrix: new THREE.Matrix4(), place: new THREE.Vector3(), scale: new THREE.Vector3(), turn: new THREE.Quaternion(), rock: new THREE.Euler(), clock: 0 }), []);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    work.clock += delta;
    boats.forEach((boat, i) => {
      boat.angle += boat.speed * delta * (11 / boat.radius);
      const x = Math.cos(boat.angle) * boat.radius;
      const z = Math.sin(boat.angle) * boat.radius;
      const heading = boat.speed > 0 ? -boat.angle - Math.PI / 2 : -boat.angle + Math.PI / 2;
      work.rock.set(Math.sin(work.clock * 0.8 + i) * 0.1, heading, Math.sin(work.clock * 0.63 + i * 2) * 0.07, "YXZ");
      work.turn.setFromEuler(work.rock);
      work.place.set(x, surface(x, z, work.clock) + 0.02, z);
      work.scale.setScalar(boat.size);
      work.matrix.compose(work.place, work.turn, work.scale);
      mesh.setMatrixAt(i, work.matrix);
      boat.next -= delta;
      if (boat.next < 0) {
        boat.next = 1.7;
        impact(x - Math.cos(heading) * boat.size, z + Math.sin(heading) * boat.size, 0.42);
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

// A swimming body along +x, with the tail at -x: a lofted oval, and a few flat fins.
function swimmer(length: number, stations: [number, number, number][], fins: number[][]) {
  const sides = 16;
  const position: number[] = [];
  const index: number[] = [];
  const dense: [number, number, number][] = [];
  const point = (i: number, k: number) => stations[Math.max(0, Math.min(stations.length - 1, i))][k];
  for (let i = 0; i < stations.length - 1; i++) {
    for (let t = 0; t < 4; t++) {
      const f = t / 4;
      const blend = (k: number) => {
        const a = point(i - 1, k);
        const b = point(i, k);
        const c = point(i + 1, k);
        const d = point(i + 2, k);
        return 0.5 * (2 * b + (c - a) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (3 * b - a - 3 * c + d) * f * f * f);
      };
      dense.push([blend(0), Math.max(0.001, blend(1)), Math.max(0.001, blend(2))]);
    }
  }
  dense.push(stations[stations.length - 1]);
  dense.forEach(([u, high, wide]) => {
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      position.push((u - 0.5) * length, Math.sin(a) * high * length, Math.cos(a) * wide * length);
    }
  });
  for (let s = 0; s < dense.length - 1; s++) {
    for (let k = 0; k < sides; k++) {
      const a = s * sides + k;
      const b = s * sides + (k + 1) % sides;
      index.push(a, a + sides, b, b, a + sides, b + sides);
    }
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  body.setIndex(index);
  body.computeVertexNormals();
  const flat = fins.map((fin) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(fin.map((value) => value * length), 3));
    geometry.computeVertexNormals();
    return geometry;
  });
  const smooth = body.toNonIndexed();
  return mergeGeometries([smooth, ...flat]) as THREE.BufferGeometry;
}

const SHARK = () =>
  swimmer(
    1,
    [
      [1, 0.002, 0.002],
      [0.985, 0.012, 0.014],
      [0.96, 0.024, 0.028],
      [0.92, 0.038, 0.044],
      [0.86, 0.054, 0.06],
      [0.78, 0.069, 0.074],
      [0.68, 0.08, 0.083],
      [0.58, 0.078, 0.078],
      [0.48, 0.068, 0.064],
      [0.38, 0.052, 0.046],
      [0.28, 0.036, 0.03],
      [0.19, 0.022, 0.018],
      [0.1, 0.012, 0.01],
      [0, 0.007, 0.005]
    ],
    [
      // dorsal
      [0.2, 0.07, 0, 0.0, 0.07, 0, -0.1, 0.2, 0, 0.0, 0.07, 0, 0.2, 0.07, 0, -0.1, 0.2, 0],
      // tail, up and down
      [-0.44, 0, 0, -0.6, 0.15, 0, -0.5, 0, 0, -0.44, 0, 0, -0.5, 0, 0, -0.56, -0.09, 0, -0.5, 0, 0, -0.6, 0.15, 0, -0.44, 0, 0, -0.56, -0.09, 0, -0.5, 0, 0, -0.44, 0, 0],
      // pectorals
      [0.2, -0.04, 0.06, 0.04, -0.05, 0.06, -0.02, -0.11, 0.27, 0.04, -0.05, -0.06, 0.2, -0.04, -0.06, -0.02, -0.11, -0.27, 0.04, -0.05, 0.06, 0.2, -0.04, 0.06, -0.02, -0.11, 0.27, 0.2, -0.04, -0.06, 0.04, -0.05, -0.06, -0.02, -0.11, -0.27]
    ]
  );

// Dolphins, far off, leaping clear of the water now and then, alone or in twos and threes.
const DOLPHIN = () =>
  swimmer(
    1,
    [
      [1, 0.006, 0.006],
      [0.965, 0.012, 0.012],
      [0.93, 0.016, 0.016],
      [0.895, 0.042, 0.04],
      [0.84, 0.07, 0.066],
      [0.72, 0.092, 0.086],
      [0.56, 0.094, 0.086],
      [0.38, 0.07, 0.062],
      [0.2, 0.034, 0.028],
      [0.08, 0.016, 0.012],
      [0, 0.008, 0.006]
    ],
    [
      // back fin
      [0.1, 0.085, 0, -0.1, 0.075, 0, -0.1, 0.19, 0, -0.1, 0.075, 0, 0.1, 0.085, 0, -0.1, 0.19, 0],
      // tail flukes lie flat
      [-0.46, 0, 0, -0.56, 0, 0.14, -0.51, 0, 0, -0.51, 0, 0, -0.56, 0, 0.14, -0.46, 0, 0, -0.46, 0, 0, -0.51, 0, 0, -0.56, 0, -0.14, -0.51, 0, 0, -0.46, 0, 0, -0.56, 0, -0.14],
      // flippers
      [0.22, -0.05, 0.07, 0.1, -0.06, 0.07, 0.04, -0.11, 0.2, 0.1, -0.06, 0.07, 0.22, -0.05, 0.07, 0.04, -0.11, 0.2, 0.22, -0.05, -0.07, 0.1, -0.06, -0.07, 0.04, -0.11, -0.2, 0.1, -0.06, -0.07, 0.22, -0.05, -0.07, 0.04, -0.11, -0.2]
    ]
  );

export function Dolphins({ count, impact }: { count: number; impact: (x: number, z: number, amount: number) => void }) {
  const camera = useThree((state) => state.camera);
  const mesh = useMemo(() => {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.12, side: THREE.DoubleSide });
    const p = positionGeometry as any;
    const upper = smoothstep(-0.03, 0.03, p.y.add(sin(p.x.mul(14)).mul(0.008)));
    material.colorNode = mix(color("#d9dcdc"), color("#4e5a66"), upper) as any;
    const instanced = new THREE.InstancedMesh(DOLPHIN(), material, count);
    instanced.frustumCulled = false;
    instanced.castShadow = false;
    return instanced;
  }, [count]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  const pod = useMemo(() => Array.from({ length: count }, () => ({ x: 0, z: 0, dx: 1, dz: 0, t: 0, length: 1, height: 1, reach: 1, size: 2, live: false, wait: 0, wet: true })), [count]);
  const work = useMemo(() => ({ next: 3, forward: new THREE.Vector3(), matrix: new THREE.Matrix4(), at: new THREE.Vector3(), scale: new THREE.Vector3(), d: new THREE.Vector3(), side: new THREE.Vector3(), up: new THREE.Vector3(), basis: new THREE.Matrix4(), turn: new THREE.Quaternion() }), []);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    work.next -= delta;
    if (work.next < 0) {
      // Somewhere ahead of whoever is looking, a good way off.
      work.next = 3.5 + Math.random() * 6.5;
      camera.getWorldDirection(work.forward);
      const look = Math.atan2(work.forward.z, work.forward.x) + (Math.random() - 0.5) * 1.1;
      const far = 30 + Math.random() * 42;
      const x = camera.position.x + Math.cos(look) * far;
      const z = camera.position.z + Math.sin(look) * far;
      const heading = Math.random() * Math.PI * 2;
      const wanted = 1 + Math.floor(Math.random() * 3);
      let started = 0;
      for (const dolphin of pod) {
        if (dolphin.live || started >= wanted) continue;
        dolphin.live = true;
        dolphin.wait = started * (0.16 + Math.random() * 0.2);
        dolphin.x = x + (Math.random() - 0.5) * 5;
        dolphin.z = z + (Math.random() - 0.5) * 5;
        dolphin.dx = Math.cos(heading);
        dolphin.dz = Math.sin(heading);
        dolphin.t = 0;
        dolphin.size = 2 + Math.random() * 0.8;
        dolphin.height = 1.8 + Math.random() * 1.7;
        dolphin.reach = 4 + Math.random() * 3;
        dolphin.length = 1.1 + Math.random() * 0.45;
        dolphin.wet = true;
        started++;
      }
    }
    pod.forEach((dolphin, i) => {
      if (!dolphin.live) {
        work.scale.setScalar(0);
        work.matrix.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, work.matrix);
        return;
      }
      if (dolphin.wait > 0) {
        dolphin.wait -= delta;
        work.matrix.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, work.matrix);
        return;
      }
      dolphin.t += delta / dolphin.length;
      const t = dolphin.t;
      const along = (t - 0.5) * dolphin.reach;
      // One arc, starting and ending below the surface.
      const y = dolphin.height * 4 * t * (1 - t) - 0.9;
      const slope = (dolphin.height * 4 * (1 - 2 * t)) / dolphin.reach;
      work.at.set(dolphin.x + dolphin.dx * along, y, dolphin.z + dolphin.dz * along);
      work.d.set(dolphin.dx, slope, dolphin.dz).normalize();
      work.side.set(0, 1, 0).cross(work.d).normalize();
      work.up.crossVectors(work.d, work.side);
      work.basis.makeBasis(work.d, work.up, work.side);
      work.turn.setFromRotationMatrix(work.basis);
      work.scale.setScalar(dolphin.size);
      work.matrix.compose(work.at, work.turn, work.scale);
      mesh.setMatrixAt(i, work.matrix);
      const wet = y < 0;
      if (wet !== dolphin.wet) {
        dolphin.wet = wet;
        impact(work.at.x, work.at.z, wet ? 1.5 : 0.9);
      }
      if (t >= 1) dolphin.live = false;
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

// A shark's skin: slate above and white below with a hard, uneven line between, gill slits and a black eye.
const sharkMaterial = (noise: THREE.Data3DTexture, time: any) => {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.48, metalness: 0, side: THREE.DoubleSide });
  const p = positionGeometry as any;
  const back = smoothstep(0.42, -0.5, p.x);
  const phase = float(instanceIndex).mul(2.3);
  const sway = (sin(p.x.mul(5.2).sub(time.mul(3.1)).add(phase)) as any).mul(back).mul(back).mul(0.13);
  material.positionNode = positionLocal.add(vec3(0, 0, sway)) as any;
  const rough = (texture3D(noise, vec3(p.x.mul(1.7), p.y.mul(1.7), p.z.mul(1.7))) as any).g.sub(0.5);
  const upper = smoothstep(-0.022, 0.01, p.y.add(rough.mul(0.05)));
  const hide = mix(color("#3e4f5c"), color("#6f8390"), (texture3D(noise, vec3(p.x.mul(4.4), p.y.mul(4.4), p.z.mul(4.4))) as any).b);
  const gills = (float(1).sub(smoothstep(0, 0.0045, abs(sin(p.x.mul(180)).mul(0.02)))) as any).mul(step(0.18, p.x)).mul(step(p.x, float(0.27))).mul(smoothstep(0.052, 0.026, abs(p.y)));
  const toEye = length(vec3(p.x.sub(0.385), p.y.sub(0.022), abs(p.z).sub(0.028)));
  const eye = smoothstep(0.012, 0.007, toEye);
  const skin = mix(mix(color("#e6e9e6"), hide, upper), color("#1d2830"), (gills as any).mul(0.8));
  material.colorNode = throughWater(mix(skin, color("#05070a"), eye));
  material.emissiveNode = (color("#d6f6e2") as any).mul(causticsOn(noise, time).mul(0.14));
  material.roughnessNode = mix(float(0.48), float(0.08), eye);
  return material;
};

export function Sharks({ count, time, impact, noise }: { count: number; time: any; impact: (x: number, z: number, amount: number) => void; noise: THREE.Data3DTexture }) {
  const list = useMemo(() => Array.from({ length: count }, (_, i) => ({ angle: i * 2.4, radius: 6.6 + i * 2.1, depth: i === 0 ? -0.62 : -2 - i * 0.9, speed: 0.17 - i * 0.02, size: 2.8 - i * 0.2, next: 0 })), [count]);
  const mesh = useMemo(() => {
    const instanced = new THREE.InstancedMesh(SHARK(), sharkMaterial(noise, time), count);
    instanced.frustumCulled = false;
    return instanced;
  }, [count, time, noise]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  const work = useMemo(() => ({ matrix: new THREE.Matrix4(), place: new THREE.Vector3(), scale: new THREE.Vector3(), turn: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0) }), []);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    list.forEach((shark, i) => {
      shark.angle += delta * shark.speed;
      const wobble = Math.sin(shark.angle * 3.1 + i) * 1.1;
      const x = Math.cos(shark.angle) * (shark.radius + wobble);
      const z = Math.sin(shark.angle) * (shark.radius + wobble);
      work.turn.setFromAxisAngle(work.up, -shark.angle - Math.PI / 2);
      work.place.set(x, shark.depth, z);
      work.scale.setScalar(shark.size);
      work.matrix.compose(work.place, work.turn, work.scale);
      mesh.setMatrixAt(i, work.matrix);
      // The fin of the shallow one cuts the surface.
      if (i === 0) {
        shark.next -= delta;
        if (shark.next < 0) {
          shark.next = 0.55;
          impact(x, z, 0.2);
        }
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

// The scanned fish, tinted into several kinds, swimming: a wave running down the body, growing toward the tail.
const fishMaterial = (fish: ReefAssets["fish"], noise: THREE.Data3DTexture, time: any) => {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.35, roughness: 0.4, side: THREE.DoubleSide });
  const p = positionGeometry as any;
  const id = float(instanceIndex) as any;
  const kind = id.mod(6) as any;
  const tailward = smoothstep(0.22, -0.5, p.x) as any;
  const beat = time.mul(fract(id.mul(0.37)).mul(2.6).add(7)).add(id.mul(2.3)) as any;
  const sway = (sin(p.x.mul(7.5).sub(beat)) as any).mul(tailward).mul(tailward).mul(0.11).add((sin(beat.mul(0.5)) as any).mul(0.008));
  material.positionNode = positionLocal.add(vec3(0, 0, sway)) as any;
  const isKind = (k: number): any => float(1).sub(step(0.5, abs(kind.sub(k))));
  const scan = texture(fish.diffuse) as any;
  const grey = dot(scan.rgb, vec3(0.3, 0.59, 0.11)) as any;
  // The scan's own colour for one school, and its detail in other colours for the rest: silver, yellowtail, blue, copper.
  const upper = smoothstep(-0.02, 0.05, p.y) as any;
  const silver = mix(vec3(0.82, 0.87, 0.9), vec3(0.3, 0.46, 0.56), upper) as any;
  const yellow = mix(vec3(0.92, 0.86, 0.6), vec3(0.5, 0.48, 0.24), upper) as any;
  const blue = mix(vec3(0.62, 0.74, 0.92), vec3(0.16, 0.26, 0.56), upper) as any;
  const copper = mix(vec3(0.94, 0.72, 0.52), vec3(0.62, 0.3, 0.16), upper) as any;
  const tinted = grey.mul(2.1);
  let skin: any = silver.mul(tinted);
  skin = mix(skin, scan.rgb, isKind(1));
  skin = mix(skin, yellow.mul(tinted), isKind(2));
  skin = mix(skin, blue.mul(tinted), isKind(3));
  skin = mix(skin, copper.mul(tinted), isKind(4));
  material.colorNode = throughWater(skin);
  material.normalNode = normalMap(texture(fish.normal)) as any;
  const orm = texture(fish.surface) as any;
  // Silver fish are mirrors, more or less, which is why a school flashes as it turns.
  material.roughnessNode = orm.g.mul(0.75) as any;
  material.metalnessNode = mix(mix(float(0.74), orm.b, isKind(1)), float(0.32), isKind(4).add(isKind(3)).clamp(0, 1)) as any;
  material.emissiveNode = throughWater(skin.mul(0.1)).add((color("#d6f6e2") as any).mul(causticsOn(noise, time).mul(0.1)));
  return material;
};

export function Fish({ assets, count, time, noise }: { assets: ReefAssets; count: number; time: any; noise: THREE.Data3DTexture }) {
  const schools = 6;
  const list = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const school = i % schools;
        const seed = (n: number) => Math.abs(Math.sin((i + 1) * (12.9898 + n)) * 43758.5453) % 1;
        const close = school === 4 ? 1.4 : 1;
        return {
          school,
          offset: new THREE.Vector3((seed(1) - 0.5) * 3 * close, (seed(2) - 0.5) * 1.5 * close, (seed(3) - 0.5) * 3 * close),
          phase: seed(4) * 20,
          size: (school === 1 ? 0.95 : school === 3 ? 0.46 : school === 4 ? 0.66 : school === 2 ? 0.6 : 0.36) * (0.76 + seed(5) * 0.5)
        };
      }),
    [count]
  );
  const mesh = useMemo(() => {
    const instanced = new THREE.InstancedMesh(assets.fish.geometry, fishMaterial(assets.fish, noise, time), count);
    instanced.frustumCulled = false;
    return instanced;
  }, [assets, count, time, noise]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  const work = useMemo(() => ({ matrix: new THREE.Matrix4(), a: new THREE.Vector3(), b: new THREE.Vector3(), d: new THREE.Vector3(), up: new THREE.Vector3(), side: new THREE.Vector3(), basis: new THREE.Matrix4(), turn: new THREE.Quaternion(), scale: new THREE.Vector3(), clock: 0 }), []);
  // Each school follows a wandering path, and each fish keeps loosely to its own place in it, drifting and darting.
  const placeAt = (out: THREE.Vector3, fish: (typeof list)[number], t: number) => {
    const s = fish.school;
    const sense = s % 2 ? -1 : 1;
    const speed = 0.13 + s * 0.012;
    const a = sense * t * speed + s * 1.9 + Math.sin(t * 0.17 + s) * 0.5;
    const r = 6 + s * 2.6 + Math.sin(t * 0.21 + s * 2) * 1.8;
    const depth = -1.5 - (s % 4) * 1.5 + Math.sin(t * 0.31 + s) * 0.7;
    const dart = Math.sin(t * 0.8 + fish.phase) * 0.28;
    out.set(Math.cos(a) * r + fish.offset.x + Math.sin(t * 0.5 + fish.phase) * 0.3 + dart, depth + fish.offset.y + Math.sin(t * 0.7 + fish.phase * 2) * 0.12, Math.sin(a) * r + fish.offset.z + Math.cos(t * 0.43 + fish.phase) * 0.3);
    return out;
  };
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    work.clock += delta;
    const t = work.clock;
    list.forEach((fish, i) => {
      placeAt(work.a, fish, t);
      placeAt(work.b, fish, t + 0.1);
      work.d.subVectors(work.b, work.a).normalize();
      work.side.set(0, 1, 0).cross(work.d).normalize();
      work.up.crossVectors(work.d, work.side);
      work.basis.makeBasis(work.d, work.up, work.side);
      work.turn.setFromRotationMatrix(work.basis);
      work.scale.setScalar(fish.size);
      work.matrix.compose(work.a, work.turn, work.scale);
      mesh.setMatrixAt(i, work.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

// What only shows below the surface: the sea floor, shafts of light coming down from the sun, and drifting specks.
export function Underwater({ assets, time, noise, under, specks, shafts, reef, warm }: { assets: ReefAssets; time: any; noise: THREE.Data3DTexture; under: any; specks: number; shafts: number; reef: number; warm: { current: number } }) {
  const parts = useMemo(() => {
    const fromCamera = (i: any, span: number, salt: number): any => {
      const seed = (n: number) => fract(sin(i.mul(12.9898 + n).add(salt + n * 3.1)).mul(43758.5453));
      return vec3(seed(1), seed(2), seed(3)).mul(span);
    };
    const bed = new THREE.MeshBasicNodeMaterial();
    bed.colorNode = color("#0d6068") as any;
    // Shafts: long flat strips, turned to face the camera, leaning the way the sun's light bends as it enters the water.
    const shaftMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const index = float(instanceIndex) as any;
    const along = normalize(vec3(SUN.x * 0.72, -1, SUN.z * 0.72)) as any;
    const home = fromCamera(index, 56, 2);
    const around = vec3(cameraPosition.x, 0, cameraPosition.z) as any;
    const foot = vec3(fract(home.x.sub(cameraPosition.x).div(56)).mul(-56).add(28), float(0), fract(home.z.sub(cameraPosition.z).div(56)).mul(-56).add(28)).add(around) as any;
    const g = positionGeometry as any;
    const side = normalize(vec3(along.z, 0, along.x.negate()).mul(0.2).add(vec3(foot.z.sub(cameraPosition.z), 0, cameraPosition.x.sub(foot.x)))) as any;
    const breadth = fract(index.mul(0.37)).mul(1).add(0.3);
    const long = fract(index.mul(0.71)).mul(9).add(9);
    shaftMaterial.positionNode = foot.add(along.mul(g.y.mul(long))).add(side.mul(g.x.mul(breadth))) as any;
    const pulse = sin(time.mul(0.34).add(index.mul(1.9))).mul(0.5).add(0.5);
    shaftMaterial.colorNode = color("#fff0c8") as any;
    shaftMaterial.opacityNode = (smoothstep(1, 0.35, g.y) as any).mul(smoothstep(0, 0.1, g.y)).mul(smoothstep(0.5, 0.05, abs(g.x))).mul(pulse.mul(0.032).add(0.012)).mul(under) as any;
    const strip = new THREE.PlaneGeometry(1, 1);
    strip.translate(0, 0.5, 0);
    const shaftMesh = new THREE.InstancedMesh(strip, shaftMaterial, shafts);
    // Specks of drifting matter, kept in a box around the camera.
    const speckMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const spot = fromCamera(index, 22, 7);
    const drift = vec3(sin(time.mul(0.11).add(index)).mul(0.4), time.mul(-0.05), sin(time.mul(0.09).add(index.mul(2))).mul(0.4));
    const place = spot.add(drift).sub(cameraPosition).div(22);
    const box = fract(place).sub(0.5).mul(22).add(cameraPosition) as any;
    speckMaterial.positionNode = box.add(g.mul(fract(index.mul(0.53)).mul(fract(index.mul(0.53))).mul(0.018).add(0.005))) as any;
    speckMaterial.colorNode = color("#e4f7ee") as any;
    speckMaterial.opacityNode = (smoothstep(0.5, 0.05, length(g.xy)) as any).mul(0.34).mul(under).mul(smoothstep(0, -0.4, box.y)) as any;
    const speckMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), speckMaterial, specks);
    const identity = new THREE.Matrix4();
    for (const mesh of [shaftMesh, speckMesh]) {
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, identity);
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      // Past the fog, which would otherwise hide most of them.
      mesh.layers.set(OVERLAY_LAYER);
    }
    return { bed, shaftMesh, speckMesh };
  }, [time, noise, under, specks, shafts]);
  useEffect(
    () => () => {
      parts.bed.dispose();
      parts.shaftMesh.dispose();
      parts.speckMesh.dispose();
    },
    [parts]
  );
  // None of it costs anything from above.
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    if (group.current) group.current.visible = under.value > 0.01 || warm.current > 0;
  });
  return (
    <group ref={group}>
      <mesh material={parts.bed} position={[0, FLOOR - 3.2, 0]} rotation={[-Math.PI / 2, 0, 0]} frustumCulled={false}>
        <circleGeometry args={[340, 48]} />
      </mesh>
      <primitive object={parts.shaftMesh} />
      <primitive object={parts.speckMesh} />
      <Reef assets={assets} time={time} scale={reef} noise={noise} />
      <Bubbles time={time} count={Math.round(reef * 120)} under={under} />
    </group>
  );
}

