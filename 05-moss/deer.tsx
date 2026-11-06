"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useRapier, type RapierRigidBody } from "@react-three/rapier";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { sound } from "../shared/engine/sound";
import { createDeerMesh } from "../02-shatter/deer";
import { SHELF_V, surfaceAt } from "./cliff";
import { pushers, type Pusher } from "./hover";
import { BIG_ROCKS_ONLY } from "./pebbles";

// A deer is solid to rocks, big and small, and to nothing else. It does not show up in its own rays or those of the herd.
const DEER_GROUPS = 0x00040003;

const GRAZE = 0;
const LOOK = 1;
const WALK = 2;
const JUMP = 3;

// The shelf, from the lip to well clear of the wall behind it, which pushes out unevenly and carries big lumps.
const SHELF_LIP = 2.55;
const SHELF_BACK = 1.15;
const FAR_END = 28;
// Short of the big boulder under the opening view, so that the herd does not shove it out of the shot.
const NEAR_END = -4.5;
const TALLEST_JUMP = 2.1;

const between = (a: number, b: number) => a + Math.random() * (b - a);

type Deer = ReturnType<typeof makeDeer>;

// No two alike: bucks, does and the odd fawn, each with its own colour, pace and temper.
function makeDeer() {
  const kind = Math.random();
  const fawn = kind < 0.16;
  const doe = !fawn && kind < 0.52;
  return {
    u: between(NEAR_END + 2, FAR_END - 6),
    v: SHELF_V + between(-SHELF_LIP, SHELF_BACK) * 0.8,
    y: 0,
    heading: between(0, Math.PI * 2),
    pace: between(0.42, 0.78) * (fawn ? 1.2 : 1),
    restless: Math.random(),
    size: fawn ? between(0.42, 0.5) : doe ? between(0.58, 0.72) : between(0.72, 0.95),
    rack: fawn || doe ? 0 : between(0.72, 1.12),
    tint: between(1.15, 1.7),
    state: Math.random() < 0.5 ? GRAZE : LOOK,
    timer: between(0, 6),
    goalU: 0,
    goalV: 0,
    goalAge: 0,
    speed: 0,
    trot: 1,
    walk: between(0, 6),
    stride: 0,
    head: 0,
    tuck: 0,
    pitch: 0,
    flick: 0,
    flickAt: between(1, 6),
    // For noticing when it has not got anywhere.
    checkU: 0,
    checkV: 0,
    checkAt: 0,
    stuck: 0,
    // The jump under way.
    fromU: 0,
    fromV: 0,
    fromY: 0,
    toU: 0,
    toV: 0,
    toY: 0,
    flight: 0,
    flightTime: 1,
    peak: 0.5,
    body: null as RapierRigidBody | null,
    pusher: { x: 0, y: 0, z: 0, reach: 2 } as Pusher
  };
}

export function ShelfDeer({ count, gravity }: { count: number; gravity: { current: number } }) {
  const mesh = useMemo(() => createDeerMesh(count), [count]);
  const { rapier, world } = useRapier();
  const ray = useMemo(() => new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), [rapier]);
  const herd = useMemo(() => Array.from({ length: count }, makeDeer), [count]);
  const camera = useThree((state) => state.camera);
  const scratch = useMemo(() => ({ matrix: new THREE.Matrix4(), at: new THREE.Vector3(), probe: new THREE.Vector3(), ahead: new THREE.Vector3(), up: new THREE.Vector3(), side: new THREE.Vector3() }), []);

  useEffect(() => {
    const style = mesh.geometry.getAttribute("aStyle") as THREE.InterleavedBufferAttribute;
    herd.forEach((deer, i) => style.setXY(i, deer.tint, deer.rack));
    style.data.needsUpdate = true;
  }, [mesh, herd]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    },
    [mesh]
  );

  // Rocks only: the cliff itself is walked on, not jumped.
  const rockAhead = (x: number, y: number, z: number, dx: number, dz: number, reach: number) => {
    ray.origin.x = x;
    ray.origin.y = y;
    ray.origin.z = z;
    ray.dir.x = dx;
    ray.dir.y = 0;
    ray.dir.z = dz;
    const hit = world.castRay(ray, reach, true, rapier.QueryFilterFlags.EXCLUDE_FIXED, BIG_ROCKS_ONLY);
    return hit ? hit.timeOfImpact : -1;
  };
  // The height of whatever rock is at this spot, above the ground there. Zero means clear.
  const rockHeight = (x: number, ground: number, z: number) => {
    ray.origin.x = x;
    ray.origin.y = ground + 3.2;
    ray.origin.z = z;
    ray.dir.x = 0;
    ray.dir.y = -1;
    ray.dir.z = 0;
    const hit = world.castRay(ray, 3.4, true, rapier.QueryFilterFlags.EXCLUDE_FIXED, BIG_ROCKS_ONLY);
    return hit ? Math.max(0, 3.2 - hit.timeOfImpact) : 0;
  };

  const newGoal = (deer: Deer, away = false) => {
    if (away) {
      // Somewhere off to one side, or behind. Arriving there means going around.
      const angle = deer.heading + (Math.random() < 0.5 ? 1 : -1) * between(1.1, 2.4);
      deer.goalU = deer.u + Math.cos(angle) * between(3, 7);
      deer.goalV = deer.v + Math.sin(angle) * between(2, 4);
    } else {
      deer.goalU = between(NEAR_END, FAR_END);
      deer.goalV = SHELF_V + between(-SHELF_LIP, SHELF_BACK) * 0.85;
    }
    deer.goalU = Math.max(NEAR_END, Math.min(FAR_END, deer.goalU));
    deer.goalV = Math.max(SHELF_V - SHELF_LIP, Math.min(SHELF_V + SHELF_BACK, deer.goalV));
    deer.goalAge = 0;
  };

  const leap = (deer: Deer, over: number) => {
    const { probe } = scratch;
    const cos = Math.cos(deer.heading);
    const sin = Math.sin(deer.heading);
    // The nearest clear ground past the rock, and failing that, as far as it can go.
    let landing = 3.4;
    for (let d = 1.1; d <= 3.4; d += 0.3) {
      const u = deer.u + cos * d;
      const v = deer.v + sin * d;
      if (v - SHELF_V > SHELF_BACK || v - SHELF_V < -SHELF_LIP - 0.1) break;
      surfaceAt(u, v, probe);
      if (rockHeight(probe.x, probe.y, probe.z) < 0.08) {
        landing = d;
        break;
      }
    }
    deer.fromU = deer.u;
    deer.fromV = deer.v;
    deer.fromY = deer.y;
    deer.toU = Math.max(NEAR_END - 1, Math.min(FAR_END + 1, deer.u + cos * landing));
    deer.toV = Math.max(SHELF_V - SHELF_LIP - 0.1, Math.min(SHELF_V + SHELF_BACK, deer.v + sin * landing));
    deer.toY = surfaceAt(deer.toU, deer.toV, probe).y;
    const pull = Math.sqrt(Math.max(0.3, gravity.current));
    deer.peak = Math.max(0.55, over + 0.35);
    deer.flightTime = (0.46 + deer.peak * 0.24 + landing * 0.06) / pull;
    deer.flight = 0;
    deer.state = JUMP;
    deer.speed = 0;
    deer.stuck = 0;
  };

  // Made here in the frame loop, as the physics world can be rebuilt underneath effects. Driven along with the deer and
  // never moved by what it hits, so whatever it walks into is shoved out of the way.
  const solid = useMemo(() => ({ bodies: null as unknown, turn: new THREE.Quaternion(), basis: new THREE.Matrix4() }), []);
  const makeBodies = () => {
    solid.bodies = world.bodies;
    const along = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const neck = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.75);
    for (const deer of herd) {
      const s = deer.size;
      const body = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased());
      const add = (shape: ReturnType<typeof rapier.ColliderDesc.capsule>, x: number, y: number, turn?: THREE.Quaternion) => {
        shape.setTranslation(x * s, y * s, 0).setCollisionGroups(DEER_GROUPS).setFriction(0.6).setRestitution(0.15);
        if (turn) shape.setRotation({ x: turn.x, y: turn.y, z: turn.z, w: turn.w });
        world.createCollider(shape, body);
      };
      add(rapier.ColliderDesc.capsule(0.42 * s, 0.24 * s), -0.08, 1.0, along);
      add(rapier.ColliderDesc.capsule(0.3 * s, 0.12 * s), 0.6, 1.25, neck);
      add(rapier.ColliderDesc.capsule(0.34 * s, 0.13 * s), 0.38, 0.47);
      add(rapier.ColliderDesc.capsule(0.34 * s, 0.13 * s), -0.47, 0.47);
      deer.body = body;
      pushers.add(deer.pusher);
    }
  };
  useEffect(() => {
    const all = herd.map((deer) => deer.pusher);
    return () => all.forEach((pusher) => pushers.delete(pusher));
  }, [herd]);

  useFrame((_, rawDelta) => {
    if (solid.bodies !== world.bodies) makeBodies();
    const delta = Math.min(rawDelta, 1 / 20);
    const pose = mesh.geometry.getAttribute("aPose") as THREE.InterleavedBufferAttribute;
    const motion = mesh.geometry.getAttribute("aMotion") as THREE.InterleavedBufferAttribute;
    const axisX = mesh.geometry.getAttribute("aAxisX") as THREE.InterleavedBufferAttribute;
    const axisY = mesh.geometry.getAttribute("aAxisY") as THREE.InterleavedBufferAttribute;
    const { matrix, at, ahead, up, side } = scratch;

    herd.forEach((deer, i) => {
      deer.timer -= delta;
      deer.flickAt -= delta;
      if (deer.flickAt < 0) {
        deer.flickAt = between(1.5, 9);
        deer.flick = 1;
      }
      deer.flick *= Math.exp(-delta * 3.4);

      let wantHead = 0;
      if (deer.state === GRAZE) {
        wantHead = 1;
        if (deer.timer < 0) {
          deer.state = Math.random() < 0.35 ? LOOK : WALK;
          deer.timer = between(1.2, 4);
          if (deer.state === WALK) newGoal(deer);
        }
      } else if (deer.state === LOOK) {
        wantHead = -0.22;
        if (deer.timer < 0) {
          const moves = Math.random() < 0.55 + deer.restless * 0.3;
          deer.state = moves ? WALK : GRAZE;
          deer.timer = between(3, 11);
          if (moves) newGoal(deer);
        }
      }

      if (deer.state === WALK) {
        deer.goalAge += delta;
        const toU = deer.goalU - deer.u;
        const toV = deer.goalV - deer.v;
        // Keep a little room from the others.
        let awayU = 0;
        let awayV = 0;
        for (const other of herd) {
          if (other === deer) continue;
          const du = deer.u - other.u;
          const dv = deer.v - other.v;
          const squared = du * du + dv * dv;
          if (squared > 2 || squared < 1e-4) continue;
          awayU += du / squared;
          awayV += dv / squared;
        }
        const wanted = Math.atan2(toV + awayV * 0.5, toU + awayU * 0.5);
        const off = Math.atan2(Math.sin(wanted - deer.heading), Math.cos(wanted - deer.heading));
        // Always under way when turning, and never faster than a stride allows, so it walks in an arc and cannot spin on the spot.
        const pace = deer.pace * deer.trot;
        const turnRate = 0.55 + pace * 0.9;
        deer.heading += Math.max(-turnRate, Math.min(turnRate, off * 2)) * delta;
        const eased = 0.45 + 0.55 * Math.max(0, Math.cos(off));
        deer.speed += (pace * eased - deer.speed) * (1 - Math.exp(-delta * 3));

        surfaceAt(deer.u, deer.v, at);
        const cos = Math.cos(deer.heading);
        const sin = Math.sin(deer.heading);
        surfaceAt(deer.u + cos * 0.3, deer.v + sin * 0.3, ahead).sub(at);
        ahead.y = 0;
        ahead.normalize();

        // A rock ahead: over it if it can be cleared, and otherwise off around it, with a jump as the last resort.
        const hit = rockAhead(at.x, at.y + 0.38, at.z, ahead.x, ahead.z, 0.8 + deer.speed * 0.9);
        if (hit >= 0) {
          surfaceAt(deer.u + cos * (hit + 0.35), deer.v + sin * (hit + 0.35), scratch.probe);
          const height = rockHeight(scratch.probe.x, scratch.probe.y, scratch.probe.z);
          if (height < TALLEST_JUMP || hit < 0.3) leap(deer, Math.min(height, TALLEST_JUMP));
          else if (deer.goalAge > 0.7) newGoal(deer, true);
        }

        if (deer.state === WALK) {
          deer.u += cos * deer.speed * delta;
          deer.v += sin * deer.speed * delta;
          // The edge is a line it will not cross. Anything heading over it just turns inward.
          const from = deer.v - SHELF_V;
          if (from > SHELF_BACK || from < -SHELF_LIP - 0.1) {
            deer.v = SHELF_V + Math.max(-SHELF_LIP - 0.1, Math.min(SHELF_BACK, from));
            newGoal(deer);
          }
          // The ground rising sharply ahead means rock, and falling away means an edge. Either way, turn off before getting there.
          surfaceAt(deer.u + cos * 1.15, deer.v + sin * 1.15, scratch.probe);
          const rise = scratch.probe.y - at.y;
          if ((rise > 0.42 || rise < -0.7) && deer.goalAge > 0.5) newGoal(deer, true);

          // Not getting anywhere: go elsewhere the first time, and jump clear the next.
          deer.checkAt += delta;
          if (deer.checkAt > 2.6) {
            const moved = Math.hypot(deer.u - deer.checkU, deer.v - deer.checkV);
            deer.checkU = deer.u;
            deer.checkV = deer.v;
            deer.checkAt = 0;
            if (moved < 0.45) {
              deer.stuck += 1;
              if (deer.stuck >= 2) leap(deer, 1.1);
              else newGoal(deer, true);
            } else {
              deer.stuck = 0;
            }
          }

          const arrived = Math.hypot(toU, toV) < 0.9 + deer.speed * 0.7;
          if (deer.state === WALK && (arrived || deer.goalAge > 18 || deer.timer < -14)) {
            if (Math.random() < 0.25 + deer.restless * 0.25) {
              newGoal(deer);
              deer.trot = Math.random() < 0.3 ? between(1.9, 2.6) : 1;
            } else {
              deer.state = Math.random() < 0.7 ? GRAZE : LOOK;
              deer.timer = deer.state === GRAZE ? between(3, 13) : between(1.5, 5);
              deer.trot = 1;
            }
          }
          // Once in a while, a jump for the sake of it.
          if (deer.state === WALK && deer.trot > 1 && Math.random() < delta * 0.06) leap(deer, 0.3);
        }
      } else if (deer.state !== JUMP) {
        deer.speed *= Math.exp(-delta * 5);
        deer.u += Math.cos(deer.heading) * deer.speed * delta;
        deer.v += Math.sin(deer.heading) * deer.speed * delta;
      }

      let pitchWanted = 0;
      let tuckWanted = 0;
      if (deer.state === JUMP) {
        deer.flight = Math.min(1, deer.flight + delta / deer.flightTime);
        const t = deer.flight;
        deer.u = deer.fromU + (deer.toU - deer.fromU) * t;
        deer.v = deer.fromV + (deer.toV - deer.fromV) * t;
        deer.y = deer.fromY + (deer.toY - deer.fromY) * t + 4 * deer.peak * t * (1 - t);
        pitchWanted = (0.5 - t) * 0.5;
        tuckWanted = Math.sin(Math.min(1, t * 1.15) * Math.PI);
        wantHead = -0.12;
        if (t >= 1) {
          deer.state = WALK;
          deer.speed = deer.pace;
          deer.checkAt = 0;
          deer.checkU = deer.u;
          deer.checkV = deer.v;
          deer.timer = between(2, 7);
          newGoal(deer);
          surfaceAt(deer.u, deer.v, at);
          const near = 1 - Math.min(1, at.distanceTo(camera.position) / 26);
          if (near > 0) {
            sound.play("hoof", { gain: near, pitch: 0.75 });
            sound.play("thud", { gain: near * 0.22, size: 0.3 });
          }
        }
      }

      deer.head += (wantHead - deer.head) * (1 - Math.exp(-delta * 2.6));
      deer.tuck += (tuckWanted - deer.tuck) * (1 - Math.exp(-delta * 14));
      deer.pitch += (pitchWanted - deer.pitch) * (1 - Math.exp(-delta * 10));
      deer.stride += (Math.min(1, deer.speed * 1.5) - deer.stride) * (1 - Math.exp(-delta * 6));
      const before = Math.floor(deer.walk / (Math.PI / 2));
      deer.walk += (deer.speed / Math.max(0.3, deer.size)) * delta * 5.2;
      surfaceAt(deer.u, deer.v, at);
      if (deer.state !== JUMP) deer.y += (at.y - deer.y) * (1 - Math.exp(-delta * 9));
      if (deer.stride > 0.25 && Math.floor(deer.walk / (Math.PI / 2)) !== before) {
        const near = 1 - Math.min(1, at.distanceTo(camera.position) / 22);
        if (near > 0) sound.play("hoof", { gain: near * 0.4, pitch: between(0.85, 1.15) });
      }

      // Facing along the ground, tilted with the slope, and nose up then down through a jump.
      surfaceAt(deer.u + Math.cos(deer.heading) * 0.5, deer.v + Math.sin(deer.heading) * 0.5, ahead).sub(at);
      const rise = Math.max(-0.4, Math.min(0.4, ahead.y / 0.5));
      ahead.y = 0;
      ahead.normalize();
      const tilt = Math.atan(rise) * (deer.state === JUMP ? 0 : 1) + deer.pitch;
      const c = Math.cos(tilt);
      const n = Math.sin(tilt);
      up.set(-ahead.x * n, c, -ahead.z * n);
      ahead.multiplyScalar(c).setY(n);
      side.crossVectors(ahead, up);
      const s = deer.size;
      if (deer.body) {
        solid.basis.makeBasis(ahead, up, side);
        solid.turn.setFromRotationMatrix(solid.basis);
        deer.body.setNextKinematicTranslation({ x: at.x, y: deer.y, z: at.z });
        deer.body.setNextKinematicRotation({ x: solid.turn.x, y: solid.turn.y, z: solid.turn.z, w: solid.turn.w });
        deer.pusher.x = at.x;
        deer.pusher.y = deer.y + s;
        deer.pusher.z = at.z;
      }
      matrix.set(ahead.x * s, up.x * s, side.x * s, at.x, ahead.y * s, up.y * s, side.y * s, deer.y, ahead.z * s, up.z * s, side.z * s, at.z, 0, 0, 0, 1);
      mesh.setMatrixAt(i, matrix);
      pose.setXYZ(i, deer.walk, deer.stride, deer.head);
      motion.setXY(i, deer.tuck, deer.flick);
      axisX.setXYZ(i, ahead.x * s, ahead.y * s, ahead.z * s);
      axisY.setXYZ(i, up.x * s, up.y * s, up.z * s);
    });
    mesh.instanceMatrix.needsUpdate = true;
    pose.data.needsUpdate = true;
  });

  return <primitive object={mesh} />;
}
