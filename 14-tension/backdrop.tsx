"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, attribute, cameraPosition, color, dot, max, mix, mx_fractal_noise_float, normalize, positionGeometry, positionWorld, pow, sin, smoothstep, time, uniform, vec3, vec4 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import type { QualityTier } from "../shared/engine/types";
import { mulberry32 } from "./web";
import type { Look } from "./versions";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The light and the world behind the web, shared by everything that shows it: the dome behind, and every drop of dew,
// which shows it again small and upside down. Set from the version, so changing version glides rather than rebuilds.
export const sky = {
  zenith: uniform(new THREE.Color()),
  horizon: uniform(new THREE.Color()),
  light: uniform(new THREE.Color()),
  power: uniform(1),
  toLight: uniform(new THREE.Vector3(0, 0, -1)),
  blots: [0, 1, 2, 3].map(() => uniform(new THREE.Color())),
  // A lightning flash, 0 to 1, in the storm.
  flash: uniform(0)
};

// Everything ever eased toward, so a change of version fades over a second or so.
const wanted = {
  zenith: new THREE.Color(),
  horizon: new THREE.Color(),
  light: new THREE.Color(),
  power: 1,
  toLight: new THREE.Vector3(),
  blots: [0, 1, 2, 3].map(() => new THREE.Color())
};
export function aim(look: Look, now: boolean) {
  wanted.zenith.set(look.zenith);
  wanted.horizon.set(look.horizon);
  wanted.light.set(look.light);
  wanted.power = look.lightPower;
  wanted.toLight.set(...look.toLight).normalize();
  look.blots.forEach((c, i) => wanted.blots[i].set(c));
  if (now) ease(1);
}
export function ease(k: number) {
  sky.zenith.value.lerp(wanted.zenith, k);
  sky.horizon.value.lerp(wanted.horizon, k);
  sky.light.value.lerp(wanted.light, k);
  sky.power.value += (wanted.power - sky.power.value) * k;
  sky.toLight.value.lerp(wanted.toLight, k).normalize();
  sky.blots.forEach((b, i) => b.value.lerp(wanted.blots[i], k));
}

// What lies in a direction: the sky from horizon to zenith, the glow round the sun or moon, and out-of-focus leaves and
// flowers in soft blots, darker and denser below where the garden is.
export const environment = Fn(([direction]: [any]) => {
  const d = normalize(direction) as any;
  const up = smoothstep(-0.25, 0.85, d.y) as any;
  let rgb: any = mix(sky.horizon, sky.zenith, up).mul(0.55);
  const toward = max(dot(d, sky.toLight), 0) as any;
  rgb = rgb.add(sky.light.mul(pow(toward, 14).mul(0.3).add(pow(toward, 90).mul(1.2)).add(pow(toward, 1200).mul(8)).mul(sky.power)));
  // Leaves: big soft blots, more of them low down, each with its own of the four colours.
  const n1 = mx_fractal_noise_float(d.mul(2.2), 3, 2, 0.5) as any;
  const n2 = mx_fractal_noise_float(d.mul(3.1).add(vec3(7.1, 2.3, 4.4)), 3, 2, 0.5) as any;
  const low = smoothstep(0.5, -0.4, d.y) as any;
  const cover = smoothstep(-0.12, 0.3, n1.add(low.mul(0.45))) as any;
  const leaf = mix(mix(sky.blots[0], sky.blots[1], smoothstep(-0.2, 0.3, n2)), mix(sky.blots[2], sky.blots[3], smoothstep(-0.1, 0.4, n2)), low) as any;
  // Lit from behind, the leaves toward the light glow through.
  const through = pow(toward, 4).mul(sky.power).mul(0.45).add(0.3) as any;
  rgb = mix(rgb, leaf.mul(through), cover.mul(0.92));
  return rgb.add(vec3(1, 1, 1).mul(sky.flash.mul(0.8)));
});

// The dome behind everything.
export function Backdrop() {
  const { mesh, material } = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({
      side: THREE.BackSide,
      depthWrite: true
    });
    material.colorNode = environment(normalize(positionWorld)) as any;
    material.fog = false;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(40, 48, 24), material);
    mesh.frustumCulled = false;
    return { mesh, material };
  }, []);
  useDispose(mesh.geometry, material);
  return <primitive object={mesh} />;
}

// Out-of-focus highlights far behind: dew and leaves catching the sun, each a soft disc with a brighter rim, as a lens
// draws them, twinkling a little.
export function Bokeh({ look, tier }: { look: Look; tier: QualityTier }) {
  const count = tier === "low" ? 40 : 90;
  const { mesh, material } = useMemo(() => {
    const random = mulberry32(77);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const at: number[] = [];
    const tint: number[] = [];
    for (let i = 0; i < count; i++) {
      // Mostly toward the light, behind the web.
      const spread = random();
      at.push((random() - 0.5) * 22 + look.toLight[0] * 6 * spread, (random() - 0.4) * 12 + look.toLight[1] * 5 * spread, -6 - random() * 16, 0.15 + random() ** 2 * 0.75);
      tint.push(random() * look.bokeh.length, random() * 100, 0.4 + random() * 0.6, 0);
    }
    geometry.setAttribute("aAt", new THREE.InstancedBufferAttribute(new Float32Array(at), 4));
    geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(new Float32Array(tint), 4));
    geometry.instanceCount = count;
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const placed = attribute("aAt", "vec4") as any;
    const t = attribute("aTint", "vec4") as any;
    const centre = placed.xyz as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(vec3(toEye.z, 0, toEye.x.negate())) as any;
    const upward = normalize(toEye.cross(right).negate()) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(placed.w))).add(upward.mul(positionGeometry.y.mul(placed.w))) as any;
    const colours = look.bokeh.map((c) => color(c));
    const pickTint = (k: any) => colours.reduce((acc: any, c: any, i: number) => (i === 0 ? c : mix(acc, c, k.greaterThan(i).select(1, 0))), colours[0]);
    material.colorNode = Fn(() => {
      const r = positionGeometry.xy.length() as any;
      const disc = smoothstep(1, 0.93, r) as any;
      const rim = smoothstep(0.7, 0.97, r).mul(disc).mul(0.6) as any;
      const twinkle = sin(time.mul(0.7).add(t.y)).mul(0.25).add(0.75) as any;
      const toward = max(dot(normalize(centre), sky.toLight), 0) as any;
      const bright = t.z.mul(twinkle).mul(pow(toward, 2).mul(0.8).add(0.2)).mul(sky.power).mul(0.32) as any;
      return vec4(pickTint(t.x).mul(disc.mul(0.55).add(rim)).mul(bright), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    return { mesh, material };
    // Remade with the version.
  }, [look, count]);
  useDispose(mesh.geometry, material);
  return <primitive object={mesh} />;
}

// Eases the shared light toward the version's, each frame.
export function useSkyEase() {
  useFrame((_, delta) => ease(1 - Math.exp(-delta * 2.5)));
}
