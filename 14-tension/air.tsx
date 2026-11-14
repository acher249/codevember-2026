"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, attribute, cameraPosition, color, cross, dot, max, mod, normalize, positionGeometry, pow, sin, smoothstep, time, vec3, vec4 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import type { QualityTier } from "../shared/engine/types";
import { sky } from "./backdrop";
import type { Look } from "./versions";
import { mulberry32 } from "./web";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What drifts through the air in front of and behind the web: dust catching the low sun, pollen, fireflies, or
// rain. All of it moves on the GPU from where it started and how fast, wrapping round a box about the web, so it
// costs nothing on the CPU however much there is.
const BOX = { min: [-3.2, -3, -3], size: [6.4, 6, 5.5] };

export function Air({ look, tier }: { look: Look; tier: QualityTier }) {
  const kind = look.air;
  const full = { motes: 700, pollen: 520, fireflies: 140, rain: 2200 }[kind];
  const count = Math.round(full * (tier === "low" ? 0.4 : tier === "medium" ? 0.7 : 1));
  const { mesh, material } = useMemo(() => {
    const random = mulberry32(5);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const start: number[] = [];
    const drift: number[] = [];
    for (let i = 0; i < count; i++) {
      start.push(BOX.min[0] + random() * BOX.size[0], BOX.min[1] + random() * BOX.size[1], BOX.min[2] + random() * BOX.size[2], random() * 100);
      const fall = kind === "rain" ? -(5 + random() * 2) : (random() - 0.5) * 0.05;
      const sideways = kind === "rain" ? 0.9 : (random() - 0.5) * 0.08;
      drift.push(sideways, fall, (random() - 0.5) * 0.05, 0.5 + random());
    }
    geometry.setAttribute("aStart", new THREE.InstancedBufferAttribute(new Float32Array(start), 4));
    geometry.setAttribute("aDrift", new THREE.InstancedBufferAttribute(new Float32Array(drift), 4));
    geometry.instanceCount = count;

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const s = attribute("aStart", "vec4") as any;
    const v = attribute("aDrift", "vec4") as any;
    const seed = s.w as any;
    // Wandering: fireflies and pollen meander, rain falls straight and slanted.
    const wander = (
      kind === "fireflies"
        ? vec3(sin(time.mul(0.31).add(seed)).mul(0.35), sin(time.mul(0.23).add(seed.mul(1.7))).mul(0.25), sin(time.mul(0.19).add(seed.mul(2.3))).mul(0.3))
        : kind === "rain"
            ? vec3(0, 0, 0)
            : vec3(sin(time.mul(0.2).add(seed)).mul(0.15), sin(time.mul(0.17).add(seed.mul(1.3))).mul(0.12), 0)
    ) as any;
    const moved = s.xyz.add(v.xyz.mul(time)).add(wander) as any;
    const min = vec3(...BOX.min) as any;
    const span = vec3(...BOX.size) as any;
    const centre = mod(moved.sub(min), span).add(min) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const radius = {
      motes: 0.005,
      pollen: 0.008,
      fireflies: 0.014,
      rain: 0.0022
    }[kind] as number;
    let place: any;
    if (kind === "rain") {
      // A streak along the way it falls, as the shutter catches it.
      const along = normalize(v.xyz) as any;
      const side = normalize(cross(along, toEye)) as any;
      place = centre.add(side.mul(positionGeometry.x.mul(radius))).add(along.mul(positionGeometry.y.mul(0.09)));
    } else {
      const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
      const upward = cross(toEye, right) as any;
      const r = v.w.mul(radius) as any;
      place = centre.add(right.mul(positionGeometry.x.mul(r))).add(upward.mul(positionGeometry.y.mul(r)));
    }
    material.positionNode = place;
    const tint = color(kind === "fireflies" ? "#d8ff6a" : kind === "pollen" ? "#fff2b0" : kind === "rain" ? "#dfe9ec" : "#fff0d0") as any;
    material.colorNode = Fn(() => {
      const r = positionGeometry.xy.length() as any;
      const soft = kind === "rain" ? smoothstep(1, 0, positionGeometry.x.abs()).mul(smoothstep(1, 0.3, positionGeometry.y.abs())) : smoothstep(1, 0.1, r);
      // Dust and pollen only show where they catch the light: toward the sun, against the dark behind.
      const toward = max(dot(toEye.negate(), sky.toLight), 0) as any;
      const lit =
        kind === "fireflies"
          ? sin(time.mul(1.3).add(seed.mul(3)))
              .mul(0.5)
              .add(0.5)
              .pow(3)
              .mul(3)
          : kind === "rain"
              ? sky.power.mul(0.12).add(sky.flash.mul(1.5))
              : pow(toward, 4).mul(1.5).add(0.05).mul(sky.power);
      return vec4(tint.mul(soft).mul(lit), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return { mesh, material };
  }, [kind, count]);
  useDispose(mesh.geometry, material);
  return <primitive object={mesh} />;
}
