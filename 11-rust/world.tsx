"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { attribute, cameraPosition, fract, step, positionLocal, color, float, instanceIndex, length, max, min, mix, positionGeometry, positionWorld, sin, smoothstep, texture3D, time, vec3 } from "three/tsl";
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { useSettingRef } from "../shared/engine/settings";
import { bakeField } from "../07-hollow/field";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The sunset haze that everything far off sinks into.
const HAZE = "#c9a59a";

// Seeded, so the boats and birds are where they were last time.
const scatter = (i: number, salt: number) => {
  const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// Boats of a few kinds, each about as long as a real one in units of 0.75 m, facing +x. Against the sunset they are mostly
// shape, so the kinds differ in outline: the cut of the hull, how many masts, and how the sails are set.
const hull = (length: number, height: number, beam: number) => {
  const shape = new THREE.Shape([new THREE.Vector2(-length / 2, height), new THREE.Vector2(length / 2 + length * 0.12, height), new THREE.Vector2(length / 2 - length * 0.05, 0), new THREE.Vector2(-length / 2 + length * 0.06, 0)]);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: beam, bevelEnabled: false });
  geometry.translate(0, 0, -beam / 2);
  return geometry;
};
const mast = (x: number, height: number) => new THREE.CylinderGeometry(0.1, 0.14, height, 5).translate(x, height / 2 + 1, 0);
const sail = (points: [number, number][]) => new THREE.ShapeGeometry(new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y))));
const merge = (parts: THREE.BufferGeometry[]) => {
  const plain = parts.map((part) => (part.index ? part.toNonIndexed() : part));
  plain.forEach((part) => {
    part.deleteAttribute("uv");
    part.deleteAttribute("normal");
  });
  return mergeGeometries(plain);
};
const BOAT_KINDS = [
  // A sloop: one mast, a mainsail and a jib.
  () => merge([hull(13, 1.6, 3.4), mast(0.5, 16), sail([[0.7, 2.2], [5.6, 2.2], [0.7, 16.5]]), sail([[0.3, 2.2], [-5.4, 1.6], [0.3, 14]])]),
  // A ketch: two masts, the one aft shorter, a sail on each and a jib.
  () => merge([hull(16, 1.8, 4), mast(-1, 17), mast(4.5, 11), sail([[-0.8, 2.4], [3.8, 2.4], [-0.8, 17.5]]), sail([[4.7, 2.4], [7.6, 2.4], [4.7, 11.5]]), sail([[-1.2, 2.4], [-7.6, 1.8], [-1.2, 15]])]),
  // A little catboat: a single broad sail on a mast right forward, gaff-headed, so its top is cut square.
  () => merge([hull(8, 1.2, 3), mast(-2, 10), sail([[-1.8, 1.8], [3.6, 1.8], [2.6, 8.8], [-1.8, 10.6]])]),
  // A tall racing yacht: a long low hull and a very tall, narrow mainsail with a big jib.
  () => merge([hull(18, 1.3, 3.6), mast(1, 24), sail([[1.2, 2.2], [6.4, 2.2], [1.2, 24.5]]), sail([[0.8, 2.2], [-8, 1.6], [0.8, 21]])]),
  // A fishing boat under power: a cabin forward, no sails.
  () => merge([hull(12, 2.2, 4.4), new THREE.BoxGeometry(4, 3, 3.2).translate(-1.5, 3.6, 0), mast(-2.5, 6)])
];

// Out past the water, the boats sit on the photograph's own sea. Its surface is not level with the scene's: the horizon in
// the photograph lies `dip` degrees below the eye, so each boat goes on that line at its distance from an eye at `eye`.
// `most` is how many the meshes are built for, so the number shown can change without building them again.
export function Boats({ count, most, eye, dip }: { count: number; most: number; eye: number; dip: number }) {
  const boats = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const away = 150 + Math.pow(scatter(i, 1), 1.3) * 170;
        // The view looks out about 5 degrees left of straight down -z: its left edge lies about -0.65 of the way out, the post
        // a little left of -0.1, and its right edge about +0.4.
        // Spread evenly across their side, each in its own lane, rather than bunched: one in three out on the right.
        const left = i % 3 !== 0;
        const lefts = count - Math.ceil(count / 3);
        const lane = left ? (i - Math.floor(i / 3) - 1) / Math.max(1, lefts - 1) : Math.floor(i / 3) / Math.max(1, Math.ceil(count / 3) - 1);
        return { away, middle: left ? -0.62 + lane * 0.5 + (scatter(i, 7) - 0.5) * 0.03 : 0.14 + lane * 0.26, sweep: left ? 0.035 : 0.025, phase: scatter(i, 2) * Math.PI * 2, rate: 0.006 + scatter(i, 4) * 0.008, size: 0.3 + scatter(i, 5) * 0.25, flip: scatter(i, 6) < 0.5 ? 1 : -1 };
      }),
    [count]
  );
  // One instanced mesh for each kind, the boats dealt out among them in turn.
  const meshes = useMemo(
    () =>
      BOAT_KINDS.map((make, kind) => {
        const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
        // Backlit: hulls near black, lifting into the haze with distance. Sails catch a little of the sky, and are not all
        // the same cloth: some pale, some tan, some a rusty red. About one boat in three is darker all over, a shape cut out
        // of the light.
        const sail = smoothstep(2.4, 3, (positionGeometry as any).y);
        const cloth = mix(mix(color("#4a3a3c"), color("#6e5446"), step(0.4, fract(float(instanceIndex).mul(0.618).add(kind * 0.31)))), color("#7a3d33"), step(0.8, fract(float(instanceIndex).mul(0.377).add(kind * 0.17))));
        const dark = step(0.66, fract(float(instanceIndex).mul(0.731).add(kind * 0.23))) as any;
        // Nearly silhouettes against the sun: only a trace of colour in the sails, and only a little haze even far out.
        const own = mix(color("#0e0a0c"), (cloth as any).mul(0.55), sail.mul(mix(float(0.35), float(0.1), dark)));
        const haze = smoothstep(80, 340, length(positionWorld.sub(cameraPosition))).mul(mix(float(0.38), float(0.2), dark));
        material.colorNode = mix(own, color(HAZE), haze) as any;
        const instanced = new THREE.InstancedMesh(make(), material, Math.ceil((most - kind) / BOAT_KINDS.length));
        instanced.frustumCulled = false;
        return instanced;
      }),
    [most]
  );
  useEffect(() => () => meshes.forEach((mesh) => mesh.dispose()), [meshes]);
  const work = useMemo(() => ({ matrix: new THREE.Matrix4(), place: new THREE.Vector3(), scale: new THREE.Vector3(), turn: new THREE.Quaternion(), rock: new THREE.Euler(), clock: 0 }), []);
  useFrame((_, rawDelta) => {
    work.clock += Math.min(rawDelta, 0.05);
    boats.forEach((boat, i) => {
      // Each sails back and forth along its own stretch, coming about at each end:
      // slowing, turning bow-on, and heading back the other way.
      const angle = boat.phase + work.clock * boat.rate;
      const x = boat.away * (boat.middle + boat.sweep * Math.sin(angle));
      const along = Math.cos(angle);
      const heading = Math.PI * (0.5 - 0.5 * THREE.MathUtils.clamp(along * 4, -1, 1));
      work.rock.set(Math.sin(work.clock * 0.7 + i) * 0.05, heading, Math.sin(work.clock * 0.55 + i * 2) * 0.06);
      work.turn.setFromEuler(work.rock);
      work.place.set(x, eye - boat.away * Math.tan(THREE.MathUtils.degToRad(dip)) + Math.sin(work.clock * 0.6 + i * 1.7) * 0.3 - 0.3, -boat.away);
      work.scale.set(boat.size, boat.size, boat.size * boat.flip);
      work.matrix.compose(work.place, work.turn, work.scale);
      meshes[i % BOAT_KINDS.length].setMatrixAt(Math.floor(i / BOAT_KINDS.length), work.matrix);
    });
    meshes.forEach((mesh, kind) => {
      mesh.count = Math.max(0, Math.ceil((count - kind) / BOAT_KINDS.length));
      mesh.instanceMatrix.needsUpdate = true;
    });
  });
  return (
    <>
      {meshes.map((mesh, kind) => (
        <primitive key={kind} object={mesh} />
      ))}
    </>
  );
}

// A gull, life size, about 1.8 units from tip to tip, facing +z. Each wing is a strip of quads along its span: the arm
// out to the elbow, broad, with the leading edge pushed forward, and the hand beyond it, swept back to a point. The body is
// two crossed spindles, so it has a shape from the side as well as from below, with a fanned tail. `reach` says how far
// out along the wing each vertex is, which is all the flapping needs.
const ELBOW = 0.36;
// Drawn at twice life size: far out over the sea, a real gull would be lost in a pixel or two.
const BIRD_SIZE = 2;
function gull() {
  const position: number[] = [];
  const reach: number[] = [];
  const put = (x: number, y: number, z: number, r: number) => {
    position.push(x, y, z);
    reach.push(r);
  };
  const stations = [0.04, 0.2, ELBOW, 0.56, 0.74, 0.9];
  const lead = [0.1, 0.13, 0.14, 0.07, -0.04, -0.2];
  const trail = [-0.17, -0.16, -0.13, -0.13, -0.15, -0.22];
  for (const side of [1, -1]) {
    for (let i = 0; i < stations.length - 1; i++) {
      const [s0, s1] = [stations[i], stations[i + 1]];
      const quad: [number, number][] = [[s0, lead[i]], [s1, lead[i + 1]], [s1, trail[i + 1]], [s0, lead[i]], [s1, trail[i + 1]], [s0, trail[i]]];
      for (const [r, z] of quad) put(side * r, 0, z, r);
    }
  }
  // Spindles from tail to beak, one lying flat and one standing up, and the tail fanned out behind.
  const body: [number, number][] = [[-0.3, 0], [-0.18, 0.045], [0.05, 0.055], [0.2, 0.035], [0.3, 0]];
  for (const flat of [true, false]) {
    for (let i = 0; i < body.length - 1; i++) {
      const [[z0, w0], [z1, w1]] = [body[i], body[i + 1]];
      const at = (w: number, z: number) => (flat ? put(w, 0, z, 0) : put(0, w, z, 0));
      at(-w0, z0);
      at(w1, z1);
      at(-w1, z1);
      at(-w0, z0);
      at(w0, z0);
      at(w1, z1);
    }
  }
  put(0, 0, -0.18, 0);
  put(0.08, 0, -0.36, 0);
  put(-0.08, 0, -0.36, 0);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(position), 3));
  geometry.setAttribute("reach", new THREE.BufferAttribute(new Float32Array(reach), 1));
  return geometry;
}

// The panel can ask for up to this many times `count`, so there are that many built, ready.
const BIRDS_MOST = 2;

// Kept out of the water's mirror, where waves smear a flat bird into long dark streaks.
const NOT_REFLECTED = 1;

// Flocks of birds crossing the sky, gulls in loose lines, in and out of view.
// Flocks `near` to `far` units out, flying between `low` and `high` degrees above the horizon.
export function Birds({ count, near, far, low = 2.5, high = 10.5, salt = 0 }: { count: number; near: number; far: number; low?: number; high?: number; salt?: number }) {
  const camera = useThree((state) => state.camera);
  // How many of them are flying, from the panel, as a percentage of `count`.
  const share = useSettingRef<number>("birds");
  const birds = useMemo(
    () =>
      Array.from({ length: count * BIRDS_MOST }, (_, i) => {
        // Each flock shares a distance, a height and a heading; each bird keeps its own place in it, loosely in a line. They
        // are far out over the sea, a few degrees above the horizon, where the eye goes.
        const flock = (i % 9) + salt * 100;
        const away = near + scatter(flock, 7) * (far - near);
        const height = 1.1 + away * Math.tan(THREE.MathUtils.degToRad(low + scatter(flock, 8) * (high - low)));
        return { flock, away, height, speed: (scatter(flock, 9) < 0.5 ? -1 : 1) * (4 + scatter(flock, 10) * 3.5) * Math.max(1, away / 160), start: scatter(flock, 11), dx: (scatter(i, 12) - 0.5) * 18, dy: (scatter(i, 13) - 0.5) * 3, dz: (scatter(i, 14) - 0.5) * 12 };
      }),
    [count, near, far, low, high, salt]
  );
  const mesh = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
    const reach = attribute("reach", "float") as any;
    const own = float(instanceIndex) as any;
    // Gulls flap a few beats and glide, wings held in a shallow M. The arm rises and falls, and the hand follows a moment
    // behind, so the wing bends at the elbow rather than swinging stiff.
    const flapping = smoothstep(-0.2, 0.5, sin(time.mul(0.33).add(own.mul(2.3)))) as any;
    const beat = time.mul(float(13).add(own.mod(4).mul(0.7))).add(own.mul(1.9)) as any;
    const arm = float(0.16).add(sin(beat).mul(0.62).mul(flapping)) as any;
    const hand = arm.add(float(-0.3).add(sin(beat.sub(0.9)).mul(0.5).mul(flapping))) as any;
    const lift = min(reach, float(ELBOW)).mul(arm).add(max(reach.sub(ELBOW), float(0)).mul(hand)) as any;
    // In the bird's own frame, before it is put in its place, so it is scaled with the bird and stays level with it.
    material.positionNode = (positionLocal as any).add(vec3(0, lift, 0)) as any;
    // Against the sunset, a dark grey-violet shape, the body a shade darker than the wings, softening into the haze.
    const tone = mix(color("#2a2128"), color("#463a42"), smoothstep(0.1, 0.5, reach)) as any;
    material.colorNode = mix(tone, color(HAZE), smoothstep(60, 240, length(positionWorld.sub(cameraPosition))).mul(0.45)) as any;
    const instanced = new THREE.InstancedMesh(gull(), material, count * BIRDS_MOST);
    instanced.frustumCulled = false;
    instanced.layers.set(NOT_REFLECTED);
    return instanced;
  }, [count]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  useEffect(() => {
    camera.layers.enable(NOT_REFLECTED);
    return () => camera.layers.disable(NOT_REFLECTED);
  }, [camera]);
  const work = useMemo(() => ({ matrix: new THREE.Matrix4(), place: new THREE.Vector3(), scale: new THREE.Vector3(BIRD_SIZE, BIRD_SIZE, BIRD_SIZE), turn: new THREE.Quaternion(), heading: new THREE.Euler(), clock: 0 }), []);
  useFrame((_, rawDelta) => {
    work.clock += Math.min(rawDelta, 0.05);
    mesh.count = Math.round(count * Math.min(BIRDS_MOST, (share.current ?? 100) / 100));
    birds.forEach((b, i) => {
      const span = b.away * 0.8;
      const x = ((((b.start * 2 * span + b.speed * work.clock + span) % (2 * span)) + 2 * span) % (2 * span)) - span + b.dx;
      // Birds rise and fall as they go: the whole flock in long, slow swoops, a degree or so of sky at its distance, and each
      // bird bobbing a little on its own. They tip their heads into the climb and down into the fall.
      const t = work.clock;
      const swoop = b.away * 0.014;
      const rise = Math.sin(t * 0.35 + b.flock * 1.7) * swoop + Math.sin(t * 0.9 + i * 2.1) * 0.5;
      const climb = Math.cos(t * 0.35 + b.flock * 1.7) * swoop * 0.35 + Math.cos(t * 0.9 + i * 2.1) * 0.45;
      work.heading.set(-Math.atan2(climb, Math.abs(b.speed)), b.speed > 0 ? Math.PI / 2 : -Math.PI / 2, Math.sin(t * 0.7 + i) * 0.08, "YXZ");
      work.turn.setFromEuler(work.heading);
      work.place.set(x, b.height + b.dy + rise, -b.away + b.dz);
      work.matrix.compose(work.place, work.turn, work.scale);
      mesh.setMatrixAt(i, work.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

// A thin sheet of cloud high over the beach, drifting in off the sea, lit pink and gold from the sun going down behind it.
// It thins away toward the horizon, where the photograph's own clouds take over.
export function Clouds() {
  const noise = useMemo(() => bakeField(64), []);
  const mesh = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    // Blown in off the sea at a few units a second, which from down here reads as a slow, steady drift.
    const wind = vec3(time.mul(2.6), time.mul(7.5), 0).xy as any;
    const at = positionWorld.xz.add(wind).mul(0.008) as any;
    const a = (texture3D(noise, vec3(at.x, float(0.21), at.y)) as any).g;
    const b = (texture3D(noise, vec3(at.x.mul(3.1), float(0.63), at.y.mul(3.1).add(time.mul(0.01)))) as any).b;
    const puff = a.add(b.mul(0.45)) as any;
    const thick = smoothstep(0.45, 0.72, puff) as any;
    const away = length(positionWorld.xz.sub(cameraPosition.xz)) as any;
    // Grey-violet in their thick middles, their thin edges lit gold toward the sun.
    const lit = mix(color("#f6caa8"), color("#6f6476"), smoothstep(0.55, 0.9, puff)) as any;
    material.colorNode = mix(lit, color("#ffd59a"), smoothstep(-60, -300, positionWorld.z).mul(0.3)) as any;
    material.opacityNode = thick.mul(0.85).mul(float(1).sub(smoothstep(220, 520, away))) as any;
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), material);
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.set(0, 32, -300);
    sheet.renderOrder = 1;
    sheet.frustumCulled = false;
    return sheet;
  }, [noise]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      noise.dispose();
    },
    [mesh, noise]
  );
  return <primitive object={mesh} />;
}

// Where the waves run up the beach: a thin edge of foam lying on the sand at the photograph's surf line, washing in and
// drawing back, lacy and broken, catching the pink of the sky.
export function Surf({ distance, level, width }: { distance: number; level: number; width: number }) {
  const noise = useMemo(() => bakeField(64), []);
  const mesh = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const p = positionWorld as any;
    // Each wave runs in, slows, and slides back, and the next follows a few seconds later, the line of it wavering along
    // the beach.
    const along = (texture3D(noise, vec3(p.x.mul(0.03), float(0.4), time.mul(0.02))) as any).g.sub(0.5).mul(1.6);
    const reach = sin(time.mul(0.55).add(p.x.mul(0.02))).mul(0.5).add(0.5).pow(2).mul(1.4).add(along) as any;
    const edge = p.z.negate().sub(distance).add(reach) as any;
    const line = smoothstep(0.35, 0.05, edge.abs()) as any;
    const trail = smoothstep(-1.6, 0, edge).mul(smoothstep(0.1, 0, edge)).mul(0.35) as any;
    const lace = smoothstep(0.42, 0.72, (texture3D(noise, vec3(p.x.mul(0.35), p.z.mul(0.9), time.mul(0.05))) as any).b) as any;
    material.colorNode = color("#fff1e6") as any;
    material.opacityNode = line.max(trail).mul(lace.mul(0.6).add(0.4)).mul(0.95).mul(smoothstep(width * 0.5, width * 0.3, p.x.abs())) as any;
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(width, 6, 1, 1), material);
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.set(0, level, -distance);
    sheet.renderOrder = 1;
    sheet.frustumCulled = false;
    return sheet;
  }, [noise, distance, level, width]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      noise.dispose();
    },
    [mesh, noise]
  );
  return <primitive object={mesh} />;
}
