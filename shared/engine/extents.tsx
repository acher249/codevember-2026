"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { abs, cameraPosition, color as tslColor, float, fract, fwidth, length, max, normalize, positionWorld, pow, sin, smoothstep, time, uniform, vec3 } from "three/tsl";
import { orbitPoint } from "./controls";
import type { Extents as ExtentsShape } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const FLOOR_ZONE = 0.8;
const FLOOR_NEAREST = 0.2;
const WALL_NEAREST = 0.35;

// How far an endless world has been carried back under the camera, in all. A shader that patterns things by where they
// lie adds this to the world position, so the pattern does not jump when the world does.
export const worldOffset = uniform(new THREE.Vector3());
// Told whenever an endless world is carried back, with how far everything moved. Anything that keeps world positions of its
// own moves them the same way.
export const worldShifted = new Set<(shift: THREE.Vector3) => void>();

// The edge of a day's world: a sphere the camera eases to a stop inside, and which only shows itself close up.
export function Extents({ centre, radius, floor, color = "#ffffff", endless }: ExtentsShape) {
  const camera = useThree((three) => three.camera);
  const middle = useMemo(() => new THREE.Vector3(...centre), [centre]);
  const reveal = Math.min(9, radius * 0.36);
  const zone = Math.min(4, radius * 0.2);

  const mesh = useMemo(() => {
    const near = float(reveal);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending, fog: false });
    const size = float(radius / 38);
    const world = positionWorld.sub(uniform(middle)).div(size) as any;
    const facing = abs(normalize(world)) as any;
    // Rings of the sphere along each of the three axes, which cross into a lattice with no pinched pole. Each is faded
    // where it runs flat along the surface, as there it would spread into a blob.
    const ring = (at: any, turned: any) => {
      const line = abs(fract(at.sub(0.5)).sub(0.5)) as any;
      return float(1).sub(smoothstep(fwidth(at).mul(0.5), fwidth(at).mul(1.5), line)).mul(float(1).sub(pow(turned, float(5)))) as any;
    };
    const lattice = max(max(ring(world.x, facing.x), ring(world.y, facing.y)), ring(world.z, facing.z)) as any;
    const away = length(positionWorld.sub(cameraPosition)) as any;
    const pool = float(1).sub(smoothstep(near.mul(0.08), near, away)) as any;
    const breath = sin(time.mul(1.4).sub(away.mul(1.6))).mul(0.12).add(0.88) as any;
    material.colorNode = (tslColor(color) as any).mul(vec3(1.6)) as any;
    material.opacityNode = lattice.mul(pool).mul(pool).mul(breath).mul(0.75).add(pool.mul(pool).mul(pool).mul(0.05)) as any;
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), material);
    sphere.position.copy(middle);
    sphere.frustumCulled = false;
    sphere.renderOrder = 10;
    return sphere;
  }, [color, middle, radius, reveal]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
    [mesh]
  );

  const state = useRef({ last: new THREE.Vector3(Infinity, 0, 0), lastPoint: new THREE.Vector3(), speed: 0, floorSpeed: 0, frames: 0 });
  const scratch = useMemo(() => ({ moved: new THREE.Vector3(), out: new THREE.Vector3(), push: new THREE.Vector3(), shift: new THREE.Vector3() }), []);

  useEffect(() => {
    if (!endless) return;
    return () => {
      worldOffset.value.set(0, 0, 0);
    };
  }, [endless]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const s = state.current;
    const point = orbitPoint.current;
    if (s.last.x === Infinity) {
      s.last.copy(camera.position);
      if (point) s.lastPoint.copy(point);
    }
    const { moved, out, push } = scratch;
    moved.subVectors(camera.position, s.last);
    // Flying and panning carry the orbit point along with the camera, so it has to stop with the camera too.
    const flying = point ? point.distanceToSquared(s.lastPoint) > 1e-10 : false;
    push.set(0, 0, 0);

    // Whatever moved the camera, the part heading for the edge fades away as the edge gets near. That only takes speed
    // off, so there is no distance to jump, and nothing can push through it.
    out.subVectors(camera.position, middle);
    const fromMiddle = out.length() || 1;
    out.divideScalar(fromMiddle);
    const room = radius - fromMiddle;
    const heading = moved.dot(out);
    if (endless) {
      // Only a lid: whatever is heading up slows to a stop under it.
      const below = endless.ceiling - camera.position.y;
      if (moved.y > 0) {
        const left = Math.max(0, Math.min(1, (below - WALL_NEAREST) / zone));
        push.y -= moved.y * (1 - left * left * (3 - 2 * left));
      }
      if (below < 0) push.y += below * (1 - Math.exp(-delta * 6));
    } else {
      if (heading > 0) {
        const left = Math.max(0, Math.min(1, (room - WALL_NEAREST) / zone));
        push.addScaledVector(out, -heading * (1 - left * left * (3 - 2 * left)));
      }
      s.speed += (Math.min(radius, Math.max(0, WALL_NEAREST - room) * 3) - s.speed) * (1 - Math.exp(-delta * 6));
      push.addScaledVector(out, -s.speed * delta);
    }

    if (floor !== undefined) {
      const clear = camera.position.y - floor;
      if (moved.y < 0) {
        const left = Math.max(0, Math.min(1, (clear - FLOOR_NEAREST) / FLOOR_ZONE));
        push.y -= moved.y * (1 - left * left * (3 - 2 * left));
      }
      s.floorSpeed += (Math.max(0, FLOOR_NEAREST - clear) * 3 - s.floorSpeed) * (1 - Math.exp(-delta * 6));
      push.y += s.floorSpeed * delta;
    }

    camera.position.add(push);
    if (point && flying) point.add(push);

    if (endless) {
      // Past a period out, everything is carried back by whole periods, which looks exactly the same.
      const { period } = endless;
      const { shift } = scratch;
      const back = (value: number) => (Math.abs(value) > period ? -Math.round(value / period) * period : 0);
      shift.set(back(camera.position.x), 0, back(camera.position.z));
      if (shift.x || shift.z) {
        camera.position.add(shift);
        camera.updateMatrixWorld();
        point?.add(shift);
        worldOffset.value.sub(shift);
        worldShifted.forEach((listener) => listener(shift));
      }
    }

    s.last.copy(camera.position);
    if (point) s.lastPoint.copy(point);

    // Shown for its first frames so that its shader is ready before it is needed, then only when it is close.
    s.frames += 1;
    mesh.visible = !endless && (s.frames < 4 || room < reveal);
  });

  if (endless) return null;
  return <primitive object={mesh} />;
}
