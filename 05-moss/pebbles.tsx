"use client";

import { useFrame } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, color as tslColor, float, mix, mx_noise_float, normalMap, normalWorld, positionGeometry, positionLocal, sin, smoothstep, texture, time, uniform, uv, vec2, vec3 } from "three/tsl";
import type { MossAssets } from "./assets";
import { noise, poolAt, SHELF_V, surfaceAt } from "./cliff";
import { hoverBody, hoverLevel, HOVER_SPIN, makeHover, pushers, type Hover } from "./hover";
import { NOT_REFLECTED } from "./pools";
import { mulberry32 } from "../shared/engine/random";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Their own collision group, so that they still knock against everything but deer can ignore them when looking ahead.
export const BIG_ROCKS_ONLY = 0x00010001;
const SMALL_ROCK_GROUPS = 0x0002ffff;

type Piece = { kind: number; x: number; y: number; z: number; size: number; flat: number; turn: number; hover: Hover; parked?: boolean; spun?: number; body?: any };

function buildPebble() {
  const geometry = new THREE.IcosahedronGeometry(1, 3);
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const r = 0.74 + noise(x * 2.4 + 3, y * 2.4 + z) * 0.42 + noise(x * 7 + z, z * 7 + y) * 0.08;
    position.setXYZ(i, x * r, y * r * 0.7, z * r);
  }
  // Shared points, or the facets would show.
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", position);
  merged.computeVertexNormals();
  const normal = merged.getAttribute("normal");
  const seen = new Map<string, THREE.Vector3>();
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i).toFixed(3)},${position.getY(i).toFixed(3)},${position.getZ(i).toFixed(3)}`;
    const sum = seen.get(key) ?? new THREE.Vector3();
    sum.x += normal.getX(i);
    sum.y += normal.getY(i);
    sum.z += normal.getZ(i);
    seen.set(key, sum);
  }
  for (let i = 0; i < position.count; i++) {
    const sum = seen.get(`${position.getX(i).toFixed(3)},${position.getY(i).toFixed(3)},${position.getZ(i).toFixed(3)}`) as THREE.Vector3;
    sum.normalize();
    normal.setXYZ(i, sum.x, sum.y, sum.z);
  }
  merged.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
  return merged;
}

// Green on whichever way a little rock now faces up, in specks with some down its sides.
const mossy = (rock: any) => {
  const speck = mx_noise_float(positionGeometry.mul(5.5)).mul(0.5).add(0.5) as any;
  const amount = smoothstep(0.56, 0.68, (normalWorld as any).y.mul(0.2).add(speck)) as any;
  return mix(rock, mix(tslColor("#0d240d"), tslColor("#34491a"), mx_noise_float(positionGeometry.mul(19)).mul(0.5).add(0.5)), amount) as any;
};

const scratchTurn = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

// All the small rocks: real bodies, so that gravity and a thrown boulder move them like anything else.
// Scattered loose along the shelf, and heaped up here and there in piles.
export function Pebbles({ assets, gravity, loose, piles }: { assets: MossAssets; gravity: { current: number }; loose: number; piles: number }) {
  const { rapier, world } = useRapier();

  const pieces = useMemo(() => {
    const rand = mulberry32(30011);
    const point = new THREE.Vector3();
    const list: Piece[] = [];
    const shelfSpot = () => {
      for (let tries = 0; tries < 10; tries++) {
        const u = -14.5 + Math.pow(rand(), 1.5) * 44;
        const v = rand() < 0.86 ? SHELF_V + (rand() - 0.5) * 5.6 : 3.4 + rand();
        if (poolAt(u, v, 1.1) === 0) return { u, v };
      }
      return { u: -12, v: SHELF_V + 2.4 };
    };
    for (let i = 0; i < loose; i++) {
      const { u, v } = shelfSpot();
      surfaceAt(u, v, point);
      const size = 0.014 + Math.pow(rand(), 3.2) * 0.13;
      list.push({ kind: rand() < 0.14 ? 1 + Math.floor(rand() * 3) : 0, x: point.x, y: point.y + size * 1.2, z: point.z, size, flat: 0.6 + rand() * 0.4, turn: rand() * 6.28, hover: makeHover(rand) });
    }
    for (let p = 0; p < piles; p++) {
      const { u, v } = shelfSpot();
      const stones = 10 + Math.floor(rand() * 16);
      const across = 0.28 + rand() * 0.4;
      for (let i = 0; i < stones; i++) {
        const angle = rand() * 6.28;
        const out = Math.sqrt(rand()) * across;
        surfaceAt(u + Math.cos(angle) * out, v + Math.sin(angle) * out, point);
        // The biggest at the bottom, and the rest resting on them.
        const up = i / stones;
        const size = (0.09 - up * 0.05) * (0.7 + rand() * 0.7);
        list.push({ kind: rand() < 0.22 ? 1 + Math.floor(rand() * 3) : 0, x: point.x, y: point.y + size + up * (0.26 - out * 0.3) + 0.01, z: point.z, size, flat: 0.65 + rand() * 0.35, turn: rand() * 6.28, hover: makeHover(rand) });
      }
    }
    return list;
  }, [loose, piles]);

  const meshes = useMemo(() => {
    const smallest = [...assets.rocks.scans].sort((a, b) => (a.geometry.index as THREE.BufferAttribute).count - (b.geometry.index as THREE.BufferAttribute).count).slice(0, 3);
    const pebbleMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
    const local = positionGeometry as any;
    pebbleMaterial.colorNode = mossy((texture(assets.stoneDiffuse, vec2(local.x.add(local.y.mul(0.6)), local.z.sub(local.y.mul(0.4))).mul(0.34)) as any).rgb.mul(tslColor("#d6cfc2")));
    const scanMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.88 });
    scanMaterial.colorNode = mossy((texture(assets.rocks.diffuse, uv()) as any).rgb.mul(tslColor("#c9c0b4")));
    scanMaterial.normalNode = normalMap(texture(assets.rocks.normal, uv()), vec2(1, 1)) as any;
    const scans = smallest.map((scan) => {
      // Centred on the body, and one unit tall.
      const geometry = scan.geometry.clone();
      const scale = 1 / Math.max(0.001, scan.size.y);
      // Centred on its own middle, because that is what it turns about.
      geometry.center();
      geometry.scale(scale, scale, scale);
      return geometry;
    });
    return [buildPebble(), ...scans].map((geometry, kind) => {
      const count = Math.max(1, pieces.filter((piece) => piece.kind === kind).length);
      const mesh = new THREE.InstancedMesh(geometry, kind === 0 ? pebbleMaterial : scanMaterial, count);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (kind === 0) mesh.layers.set(NOT_REFLECTED);
      mesh.count = pieces.filter((piece) => piece.kind === kind).length;
      return mesh;
    });
  }, [assets, pieces]);

  // Low-poly outlines to collide with: an even sample of each rock's real points.
  const outlines = useMemo(
    () =>
      meshes.map((mesh) => {
        const position = mesh.geometry.getAttribute("position");
        const step = Math.max(1, Math.floor(position.count / 14));
        const points: number[] = [];
        for (let i = 0; i < position.count; i += step) points.push(position.getX(i), position.getY(i), position.getZ(i));
        return new Float32Array(points);
      }),
    [meshes]
  );

  const slots = useMemo(() => {
    const next = [0, 0, 0, 0];
    return pieces.map((piece) => next[piece.kind]++);
  }, [pieces]);

  useEffect(
    () => () => {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        mesh.dispose();
      }
    },
    [meshes]
  );

  const state = useMemo(() => ({ owner: null as Piece[] | null, bodies: null as unknown, rouse: 0, gravity: gravity.current, drawn: false, matrix: new THREE.Matrix4(), p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() }), [gravity]);

  // Bodies are made here in the frame loop, and not in an effect, because the physics world can be torn down and
  // rebuilt underneath effects. Only a change of quality ever needs the old ones cleared, and it is safe to do it here too.
  const makeBodies = () => {
    for (const piece of state.owner ?? []) {
      // A body from a world that has since been torn down has nothing left to remove.
      if (piece.body && state.bodies === world.bodies) world.removeRigidBody(piece.body);
      piece.body = undefined;
    }
    state.owner = pieces;
    state.bodies = world.bodies;
    state.drawn = false;
    const e = new THREE.Euler();
    const rotation = new THREE.Quaternion();
    for (const piece of pieces) {
      e.set(piece.turn * 0.3, piece.turn, piece.turn * 0.2);
      rotation.setFromEuler(e);
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(piece.x, piece.y, piece.z)
          .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
          .setGravityScale(Math.max(0, gravity.current))
          .setLinearDamping(0.12)
          .setAngularDamping(0.7)
          // Falling from a height they would otherwise go straight through the thin rock in a single step.
          .setCcdEnabled(true)
      );
      // A few points of this rock's own shape, at its size.
      const outline = outlines[piece.kind];
      const across = piece.kind === 0 ? piece.size : piece.size * 1.7;
      const points = new Float32Array(outline.length);
      for (let p = 0; p < outline.length; p += 3) {
        points[p] = outline[p] * across;
        points[p + 1] = outline[p + 1] * across * (piece.kind === 0 ? piece.flat : 1);
        points[p + 2] = outline[p + 2] * across;
      }
      const half = piece.size * 0.72;
      const shape = rapier.ColliderDesc.convexHull(points) ?? rapier.ColliderDesc.cuboid(half, half * piece.flat, half);
      world.createCollider(shape.setFriction(0.95).setRestitution(0.04).setDensity(1.4).setCollisionGroups(SMALL_ROCK_GROUPS), body);
      piece.body = body;
      piece.hover.ceiling = null;
      piece.parked = false;
    }
  };

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    if (state.owner !== pieces || state.bodies !== world.bodies) makeBodies();
    const { matrix, p, q, s } = state;
    const changed = gravity.current !== state.gravity;
    state.gravity = gravity.current;
    state.rouse = changed ? 1.2 : Math.max(0, state.rouse - delta);
    const dirty = [false, false, false, false];
    const clock = performance.now() / 1000;
    pieces.forEach((piece, i) => {
      const body = piece.body;
      if (!body) return;
      const unpark = () => {
        // Back to the physics exactly where it was last seen.
        scratchTurn.setFromAxisAngle(UP, piece.spun ?? 0).multiply(q.copy(body.rotation()));
        const at = body.translation();
        body.setEnabled(true);
        body.setTranslation({ x: at.x, y: hoverLevel(piece.hover, clock), z: at.z }, true);
        body.setRotation({ x: scratchTurn.x, y: scratchTurn.y, z: scratchTurn.z, w: scratchTurn.w }, true);
        piece.parked = false;
        piece.spun = 0;
      };
      if (changed) {
        if (gravity.current >= 0 && piece.parked) unpark();
        if (!piece.parked) body.setGravityScale(Math.max(0, gravity.current), true);
        body.setEnabledRotations(gravity.current >= 0, true, gravity.current >= 0, true);
        if (gravity.current >= 0) piece.hover.ceiling = null;
      }
      if (piece.parked) {
        const near = body.translation();
        for (const pusher of pushers) {
          const dx = pusher.x - near.x;
          const dy = pusher.y - near.y;
          const dz = pusher.z - near.z;
          if (dx * dx + dy * dy + dz * dz < pusher.reach * pusher.reach) {
            unpark();
            break;
          }
        }
      }
      // A sleeping rock can drop straight back off, even when woken, so it keeps being woken and is given a nudge the new way.
      if (state.rouse > 0 && gravity.current > 0 && body.isSleeping()) {
        body.wakeUp();
        body.applyImpulse({ x: 0, y: -body.mass() * 0.08, z: 0 }, true);
      }
      if (gravity.current < 0 && !piece.parked) {
        hoverBody(body, piece.hover, gravity.current, clock);
        // Once it has arrived and settled there is no need to go on simulating it. It keeps bobbing and turning for the eye.
        const v = body.linvel();
        if (Math.abs(body.translation().y - hoverLevel(piece.hover, clock)) < 0.03 && v.x * v.x + v.z * v.z < 0.002) {
          piece.parked = true;
          piece.spun = 0;
          body.setEnabled(false);
        }
      }
      if (state.drawn && !piece.parked && body.isSleeping()) return;
      const at = body.translation();
      const r = body.rotation();
      p.set(at.x, at.y, at.z);
      q.set(r.x, r.y, r.z, r.w);
      if (piece.parked) {
        p.y = hoverLevel(piece.hover, clock);
        piece.spun = (piece.spun ?? 0) + HOVER_SPIN * delta;
        q.premultiply(scratchTurn.setFromAxisAngle(UP, piece.spun));
      }
      const across = piece.kind === 0 ? piece.size : piece.size * 1.7;
      s.set(across, across * (piece.kind === 0 ? piece.flat : 1), across);
      matrix.compose(p, q, s);
      meshes[piece.kind].setMatrixAt(slots[i], matrix);
      dirty[piece.kind] = true;
    });
    state.drawn = true;
    meshes.forEach((mesh, kind) => {
      if (dirty[kind]) mesh.instanceMatrix.needsUpdate = true;
    });
  });

  return (
    <>
      {meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
    </>
  );
}

// The finest grit, far too many for bodies of their own. The shader lifts them with the rest when gravity turns over.
export function Grit({ assets, gravity, count, detail, smallest, spread, seed }: { assets: MossAssets; gravity: { current: number }; count: number; detail: number; smallest: number; spread: number; seed: number }) {
  const { mesh, lift } = useMemo(() => {
    const rand = mulberry32(seed);
    const point = new THREE.Vector3();
    const stone = new THREE.IcosahedronGeometry(1, detail);
    const corners = stone.getAttribute("position");
    for (let i = 0; i < corners.count; i++) {
      const r = 0.72 + noise(corners.getX(i) * 3 + 4, corners.getY(i) * 3 + corners.getZ(i)) * 0.56;
      corners.setXYZ(i, corners.getX(i) * r, corners.getY(i) * r * 0.62, corners.getZ(i) * r);
    }
    stone.computeVertexNormals();
    const floats = new Float32Array(count * 3);
    const lift = uniform(0);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.94 });
    const about = attribute("aFloat", "vec3") as any;
    material.colorNode = (texture(assets.stoneDiffuse, vec2(positionGeometry.x, positionGeometry.z).add(about.yz)) as any).rgb.mul(mix(float(0.22), float(1.15), about.z)) as any;
    const bob = sin(time.mul(0.7).add(about.y.mul(6.28))).mul(0.09) as any;
    material.positionNode = positionLocal.add(vec3(0, about.x.add(bob).mul(lift), 0)) as any;
    const instanced = new THREE.InstancedMesh(stone, material, count);
    const matrix = new THREE.Matrix4();
    const turn = new THREE.Quaternion();
    const axis = new THREE.Euler();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      let u = 0;
      let v = 0;
      for (let tries = 0; tries < 8; tries++) {
        u = -15.5 + Math.pow(rand(), 1.5) * 52;
        v = SHELF_V + (rand() - 0.5) * 5.8;
        if (poolAt(u, v, 1.05) === 0) break;
      }
      surfaceAt(u, v, point);
      const size = smallest * (1 + Math.pow(rand(), 2.4) * spread);
      axis.set(rand() * 6.28, rand() * 6.28, rand() * 6.28);
      matrix.compose(position.set(point.x, point.y + size * 0.3, point.z), turn.setFromEuler(axis), scale.set(size, size, size));
      instanced.setMatrixAt(i, matrix);
      floats.set([0.75 + rand() * 1.5, rand(), rand()], i * 3);
    }
    stone.setAttribute("aFloat", new THREE.InstancedBufferAttribute(floats, 3));
    instanced.frustumCulled = false;
    instanced.receiveShadow = true;
    instanced.layers.set(NOT_REFLECTED);
    return { mesh: instanced, lift };
  }, [assets, count, detail, smallest, spread, seed]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const rising = gravity.current < 0;
    const rate = rising ? 0.35 + Math.min(1, -gravity.current) * 1.2 : 3 * Math.max(0.2, gravity.current);
    lift.value += ((rising ? 1 : 0) - lift.value) * (1 - Math.exp(-delta * rate));
  });

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    },
    [mesh]
  );
  return <primitive object={mesh} />;
}
