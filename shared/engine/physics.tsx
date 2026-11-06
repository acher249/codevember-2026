"use client";

import { useFrame } from "@react-three/fiber";
import type { RapierRigidBody } from "@react-three/rapier";
import { useRef, type RefObject } from "react";
import * as THREE from "three";
import { useGrabbable } from "./controls";

const toTarget = new THREE.Vector3();
const toCentre = new THREE.Vector3();

// Makes a Rapier body something the shared camera rig can pick up. It stays dynamic while held,
// driven toward the pointer by velocity, so it still shoves other bodies and throws on release.
type GrabShape = { position: ArrayLike<number>; index: ArrayLike<number> };

const localRay = new THREE.Ray();
const turnBack = new THREE.Quaternion();
const cornerA = new THREE.Vector3();
const cornerB = new THREE.Vector3();
const cornerC = new THREE.Vector3();
const crossing = new THREE.Vector3();

// Where the ray first meets this shape, as it sits on the body now, or nothing. Far tighter than any sphere.
function hitShape(ray: THREE.Ray, rigid: RapierRigidBody, shape: GrabShape) {
  const at = rigid.translation();
  const spin = rigid.rotation();
  turnBack.set(spin.x, spin.y, spin.z, spin.w).invert();
  localRay.origin.set(ray.origin.x - at.x, ray.origin.y - at.y, ray.origin.z - at.z).applyQuaternion(turnBack);
  localRay.direction.copy(ray.direction).applyQuaternion(turnBack);
  const { position, index } = shape;
  let best = Infinity;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3;
    const b = index[t + 1] * 3;
    const c = index[t + 2] * 3;
    cornerA.set(position[a], position[a + 1], position[a + 2]);
    cornerB.set(position[b], position[b + 1], position[b + 2]);
    cornerC.set(position[c], position[c + 1], position[c + 2]);
    if (localRay.intersectTriangle(cornerA, cornerB, cornerC, true, crossing)) best = Math.min(best, crossing.distanceTo(localRay.origin));
  }
  return best;
}

export function useGrabRigidBody(body: RefObject<RapierRigidBody | null>, radius: number, onHover?: (hovering: boolean) => void, shape?: GrabShape, hidden?: (ray: THREE.Ray, distance: number) => boolean) {
  const state = useRef({ held: false, target: new THREE.Vector3(), offset: new THREE.Vector3() });

  useGrabbable({
    pick(ray) {
      const rigid = body.current;
      if (!rigid) return null;
      const position = rigid.translation();
      toCentre.set(position.x, position.y, position.z);
      const along = toCentre.clone().sub(ray.origin).dot(ray.direction);
      if (along < 0 || ray.distanceSqToPoint(toCentre) > radius * radius) return null;
      if (shape) {
        const distance = hitShape(ray, rigid, shape);
        if (distance === Infinity || hidden?.(ray, distance)) return null;
        return { distance, point: ray.at(distance, new THREE.Vector3()) };
      }
      const point = ray.at(along, new THREE.Vector3());
      return { distance: along, point };
    },
    grab(point) {
      const rigid = body.current;
      if (!rigid) return;
      const position = rigid.translation();
      state.current.held = true;
      state.current.target.copy(point);
      state.current.offset.set(position.x - point.x, position.y - point.y, position.z - point.z);
      rigid.wakeUp();
    },
    drag(point) {
      state.current.target.copy(point);
    },
    release() {
      state.current.held = false;
    },
    hover: onHover
  });

  useFrame(() => {
    const rigid = body.current;
    if (!state.current.held || !rigid) return;
    const position = rigid.translation();
    const velocity = rigid.linvel();
    toTarget.copy(state.current.target).add(state.current.offset).sub(position as THREE.Vector3).multiplyScalar(14);
    toTarget.clampLength(0, 30);
    rigid.setLinvel(
      {
        x: THREE.MathUtils.lerp(velocity.x, toTarget.x, 0.5),
        y: THREE.MathUtils.lerp(velocity.y, toTarget.y, 0.5),
        z: THREE.MathUtils.lerp(velocity.z, toTarget.z, 0.5)
      },
      true
    );
  });

  return state;
}
