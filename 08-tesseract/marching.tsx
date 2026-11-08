"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Break,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  float,
  Fn,
  If,
  Loop,
  max,
  min,
  normalize,
  positionWorld,
  transformNormalToView,
  vec3,
  vec4
} from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const FIELD_INPUTS = [{ name: "p", type: "vec3" }, { name: "w", type: "float" }];

// Everything a study needs from a distance field. `w` is free for a field to use, and the mirror room spends it on how many
// reflections deep the ray has gone.
export function makeMarcher(name: string, map: (p: any, w: any) => any) {
  const field = Fn(([p, w]: any[]) => map(p, w)).setLayout({ name: `${name}Field`, type: "float", inputs: FIELD_INPUTS }) as any;

  const march = (label: string, steps: number) =>
    Fn(([ro, rd, near, far, w]: any[]) => {
      const t = near.toVar() as any;
      const hit = float(-1).toVar() as any;
      const last = float(1).toVar() as any;
      Loop(steps, () => {
        last.assign(field(ro.add(rd.mul(t)), w));
        If(last.lessThan(t.mul(0.0006).add(0.0011)), () => {
          hit.assign(t);
          Break();
        });
        t.addAssign(last);
        If(t.greaterThan(far), () => {
          last.assign(1);
          Break();
        });
      });
      // Out of steps while grazing an edge is a hit, or silhouettes fray into speckle.
      If(hit.lessThan(0).and(last.lessThan(t.mul(0.001).add(0.004))), () => {
        hit.assign(t);
      });
      return hit;
    }).setLayout({
      name: `${name}${label}`,
      type: "float",
      inputs: [{ name: "ro", type: "vec3" }, { name: "rd", type: "vec3" }, { name: "near", type: "float" }, { name: "far", type: "float" }, { name: "w", type: "float" }]
    }) as any;

  const normalAt = Fn(([p, w]: any[]) => {
    const e = 0.0028;
    const a = vec3(e, -e, -e) as any;
    const b = vec3(-e, -e, e) as any;
    const c = vec3(-e, e, -e) as any;
    const d = vec3(e, e, e) as any;
    return normalize(a.mul(field(p.add(a), w)).add(b.mul(field(p.add(b), w))).add(c.mul(field(p.add(c), w))).add(d.mul(field(p.add(d), w))));
  }).setLayout({ name: `${name}Normal`, type: "vec3", inputs: FIELD_INPUTS }) as any;

  // Soft shadow from how nearly the ray to the light grazes something, after Inigo Quilez.
  const softShadow = (steps: number) =>
    Fn(([p, l, k, w]: any[]) => {
      const lit = float(1).toVar() as any;
      const t = float(0.05).toVar() as any;
      Loop(steps, () => {
        const h = field(p.add(l.mul(t)), w) as any;
        lit.assign(min(lit, k.mul(h).div(t)));
        t.addAssign(clamp(h, 0.03, 0.8));
        If(lit.lessThan(0.002).or(t.greaterThan(26)), () => {
          Break();
        });
      });
      const soft = clamp(lit, 0, 1) as any;
      return soft.mul(soft).mul(float(3).sub(soft.mul(2)));
    }).setLayout({
      name: `${name}Shadow`,
      type: "float",
      inputs: [{ name: "p", type: "vec3" }, { name: "l", type: "vec3" }, { name: "k", type: "float" }, { name: "w", type: "float" }]
    }) as any;

  const occlusion = Fn(([p, n, w]: any[]) => {
    const lost = float(0).toVar() as any;
    for (const [reach, weight] of [[0.08, 1], [0.22, 0.5], [0.55, 0.25], [1.2, 0.12]]) {
      lost.addAssign(float(reach).sub(field(p.add(n.mul(reach)), w)).mul(weight));
    }
    return clamp(float(1).sub(lost.mul(1.5)), 0, 1);
  }).setLayout({ name: `${name}Occlusion`, type: "float", inputs: [{ name: "p", type: "vec3" }, { name: "n", type: "vec3" }, { name: "w", type: "float" }] }) as any;

  return { field, march, normalAt, softShadow, occlusion };
}

export type Traced = { colour: any; distance: any; normal: any };

// A sphere around everything that the shader fills in, writing a real depth and normal so the shared post stack still works.
// `shade` gets the camera ray and reports what it found: a negative distance means open sky.
export function useMarchedMaterial(shade: (ro: any, rd: any, out: { depth: any; normal: any }, finish: (distance: any, normal: any) => void) => any, keys: unknown[]) {
  const material = useMemo(() => {
    const look = new THREE.MeshStandardNodeMaterial({ side: THREE.BackSide, roughness: 1, metalness: 0 });
    look.colorNode = vec3(0) as any;
    const ro = cameraPosition as any;
    const rd = normalize(positionWorld.sub(cameraPosition)) as any;
    const depthOut = float(0.5).toVar("tesseractDepth") as any;
    const normalOut = vec3(0, 1, 0).toVar("tesseractNormal") as any;
    const run = Fn(() => {
      const direction = rd.toVar() as any;
      return shade(ro, direction, { depth: depthOut, normal: normalOut }, (distance: any, normal: any) => {
        const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(ro.add(direction.mul(max(distance, float(0.01)))), 1)) as any;
        depthOut.assign(distance.lessThan(0).select(float(1), min(clip.z.div(clip.w), float(0.9999))));
        normalOut.assign(normal);
      });
    });
    look.emissiveNode = run() as any;
    look.normalNode = transformNormalToView(normalOut) as any;
    look.depthNode = depthOut as any;
    return look;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the shader is rebuilt only for what it was given to depend on.
  }, keys);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

export function MarchedShell({ material }: { material: THREE.Material }) {
  return (
    <mesh frustumCulled={false} raycast={() => null} material={material}>
      <sphereGeometry args={[80, 24, 16]} />
    </mesh>
  );
}
