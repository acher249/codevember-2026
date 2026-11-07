"use client";

import { useEffect, useMemo } from "react";
import {
  Break,
  Discard,
  Fn,
  If,
  Loop,
  abs,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  color,
  dot,
  exp,
  float,
  int,
  length,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  transformNormalToView,
  uniformArray,
  vec3,
  vec4
} from "three/tsl";
import * as THREE from "three/webgpu";
import { JUICE_LEVEL, R, inFlesh } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Thick juice, in the same way as Melt: spheres that blend into one surface per pixel. A drop swells out through the cut,
// crawls down it, trailing what follows it, and lets go when it runs out of flesh.

const HEAD_AND_TAIL = 4;
const STICKING = 0;
const FALLING = 1;

type Drip = {
  alive: boolean;
  state: number;
  // On the cut, measured across and up it. Off it, the head's own place.
  across: number;
  up: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  grow: number;
  crawl: number;
  red: number;
  inHollow: boolean;
  tail: { x: number; y: number; z: number }[];
};

const newDrip = (): Drip => ({ alive: false, state: STICKING, across: 0, up: 0, x: 0, y: -50, z: 0, vx: 0, vy: 0, vz: 0, r: 0, grow: 0, crawl: 0, red: 0, inHollow: false, tail: [{ x: 0, y: -50, z: 0 }, { x: 0, y: -50, z: 0 }, { x: 0, y: -50, z: 0 }] });

export type BladeFrame = { normal: THREE.Vector3; along: THREE.Vector3; up: THREE.Vector3; depth: number; speed: number };

export class JuiceSim {
  drips: Drip[];
  private wait = 0.6;
  onPool: ((x: number, z: number, r: number) => void) | null = null;
  onFloor: ((x: number, z: number, r: number, red: number) => void) | null = null;
  onBirth: (() => void) | null = null;

  constructor(count: number) {
    this.drips = Array.from({ length: count }, newDrip);
  }

  private spawn(blade: BladeFrame) {
    const drip = this.drips.find((candidate) => !candidate.alive);
    if (!drip) return;
    // Tries a few places on the cut for one that has flesh in it. Most start high up, so they have further to run.
    for (let attempt = 0; attempt < 8; attempt++) {
      const across = (Math.random() * 2 - 1) * R * 0.92;
      const up = (Math.random() * 1.5 - 0.5) * R * 0.92;
      const x = blade.normal.x * blade.depth + blade.along.x * across + blade.up.x * up;
      const y = blade.normal.y * blade.depth + blade.along.y * across + blade.up.y * up;
      const z = blade.normal.z * blade.depth + blade.along.z * across + blade.up.z * up;
      if (inFlesh(x, y, z) !== "flesh") continue;
      const close = Math.hypot(x, y, z) < R * 0.76;
      Object.assign(drip, { alive: true, state: STICKING, across, up, vx: 0, vy: 0, vz: 0, r: 0, grow: Math.random() < 0.28 ? 0.12 + Math.random() * 0.09 : 0.045 + Math.random() * 0.06, crawl: 0.22 + Math.random() * 0.42, red: close || Math.random() < 0.28 ? 0.7 + Math.random() * 0.3 : Math.random() * 0.25, inHollow: false });
      for (const part of drip.tail) {
        part.x = x;
        part.y = y;
        part.z = z;
      }
      drip.x = x;
      drip.y = y;
      drip.z = z;
      this.onBirth?.();
      return;
    }
  }

  // Something tore. Juice comes sooner.
  hurry() {
    this.wait = Math.min(this.wait, 0);
  }

  step(delta: number, blade: BladeFrame, juice: number, sea: number) {
    const cutOpen = Math.abs(blade.depth) < R * 0.95;
    this.wait -= delta * juice * (1 + Math.min(14, blade.speed * 2.6));
    if (this.wait < 0 && cutOpen) {
      this.wait = 0.4 + Math.random() * 1.2;
      this.spawn(blade);
    }
    for (const drip of this.drips) {
      if (!drip.alive) continue;
      if (drip.state === STICKING) {
        drip.r = Math.min(drip.grow, drip.r + delta * 0.09);
        // Runs in fits and starts: bigger drops, heavier and quicker.
        const go = (0.5 + 0.5 * Math.sin(performance.now() * 0.001 * (1.1 + drip.crawl * 3) + drip.grow * 90)) * drip.crawl;
        if (drip.r > drip.grow * 0.82) drip.up -= delta * go * Math.min(1.5, drip.r / 0.07);
        const place = blade.depth + drip.r * 0.48;
        drip.x = blade.normal.x * place + blade.along.x * drip.across + blade.up.x * drip.up;
        drip.y = blade.normal.y * place + blade.along.y * drip.across + blade.up.y * drip.up;
        drip.z = blade.normal.z * place + blade.along.z * drip.across + blade.up.z * drip.up;
        const under = inFlesh(drip.x - blade.normal.x * drip.r * 0.48, drip.y - blade.normal.y * drip.r * 0.48 - drip.r * 0.3, drip.z - blade.normal.z * drip.r * 0.48);
        if (under !== "flesh") {
          drip.state = FALLING;
          drip.inHollow = under === "hollow";
          // It comes away from the cut, out past the blade, as it goes.
          const away = 0.12 + Math.random() * 0.34;
          drip.vx = blade.normal.x * away;
          drip.vy = 0;
          drip.vz = blade.normal.z * away;
        }
      } else {
        drip.vy -= 9 * delta;
        drip.x += drip.vx * delta;
        drip.y += drip.vy * delta;
        drip.z += drip.vz * delta;
        if (drip.inHollow && drip.y < JUICE_LEVEL) {
          drip.alive = false;
          this.onPool?.(drip.x, drip.z, drip.r);
        } else if (!drip.inHollow && drip.y < sea) {
          drip.alive = false;
          this.onFloor?.(drip.x, drip.z, drip.r, drip.red);
        }
      }
      // The tail follows the head: the first part closely, and the last at a distance.
      let leader = drip as { x: number; y: number; z: number };
      for (let i = 0; i < drip.tail.length; i++) {
        const part = drip.tail[i];
        const k = Math.min(1, delta * (drip.state === STICKING ? 2.4 : 10) / (1 + i * 0.4));
        part.x += (leader.x - part.x) * k;
        part.y += (leader.y - part.y) * k;
        part.z += (leader.z - part.z) * k;
        leader = part;
      }
    }
  }
}

export function useJuice(blobCount: number, steps: number) {
  const uniforms = useMemo(
    () => ({
      blobs: uniformArray(Array.from({ length: blobCount }, () => new THREE.Vector4(0, -50, 0, 0)), "vec4"),
      reds: uniformArray(Array.from({ length: blobCount }, () => 0), "float")
    }),
    [blobCount]
  );

  const material = useMemo(() => {
    const u = uniforms as any;
    const blend = float(0.085) as any;
    // Polynomial smooth minimum, after Inigo Quilez: https://iquilez.org/articles/smin/
    const smin = Fn(([a, b, k]: any[]) => {
      const h = max(k.sub(abs(a.sub(b))), float(0)).div(k) as any;
      return min(a, b).sub(h.mul(h).mul(k).mul(0.25));
    }).setLayout({ name: "juiceBlend", type: "float", inputs: [{ name: "a", type: "float" }, { name: "b", type: "float" }, { name: "k", type: "float" }] }) as any;
    const map = Fn(([p]: any[]) => {
      const d = float(9).toVar() as any;
      Loop({ start: int(0), end: int(blobCount), type: "int" }, ({ i }: any) => {
        const blob = u.blobs.element(i) as any;
        d.assign(smin(d, length(p.sub(blob.xyz)).sub(blob.w), blend));
      });
      return d;
    }) as any;
    const redness = Fn(([p]: any[]) => {
      const sum = float(0.0001).toVar() as any;
      const red = float(0).toVar() as any;
      Loop({ start: int(0), end: int(blobCount), type: "int" }, ({ i }: any) => {
        const blob = u.blobs.element(i) as any;
        const weight = exp(length(p.sub(blob.xyz)).sub(blob.w).mul(-11)) as any;
        sum.addAssign(weight);
        red.addAssign(weight.mul(u.reds.element(i)));
      });
      return red.div(sum);
    }) as any;
    const normalAt = Fn(([p]: any[]) => {
      const e = float(0.0024) as any;
      const a = vec3(e, e.negate(), e.negate()) as any;
      const b = vec3(e.negate(), e.negate(), e) as any;
      const c = vec3(e.negate(), e, e.negate()) as any;
      const d = vec3(e, e, e) as any;
      return normalize(a.mul(map(p.add(a))).add(b.mul(map(p.add(b)))).add(c.mul(map(p.add(c)))).add(d.mul(map(p.add(d)))));
    }) as any;

    const look = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
    look.colorNode = vec3(0) as any;
    const depthOut = float(0.5).toVar("juiceDepth") as any;
    const normalOut = vec3(0, 1, 0).toVar("juiceWorldNormal") as any;
    const shade = Fn(() => {
      const ro = cameraPosition as any;
      const rd = normalize(positionWorld.sub(cameraPosition)).toVar() as any;
      const start = length(positionWorld.sub(cameraPosition)).toVar() as any;
      const t = start.toVar() as any;
      const hit = float(-1).toVar() as any;
      Loop(steps, () => {
        const d = map(ro.add(rd.mul(t))) as any;
        If(d.lessThan(0.0016), () => {
          hit.assign(t);
          Break();
        });
        t.addAssign(d);
        If(t.greaterThan(start.add(3)), () => {
          Break();
        });
      });
      If(hit.lessThan(0), () => {
        Discard();
      });
      const point = ro.add(rd.mul(hit)).toVar() as any;
      const n = normalAt(point).toVar() as any;
      const ndv = clamp(dot(n, rd.negate()), 0, 1).toVar() as any;
      const bounce = reflect(rd, n) as any;
      // A little room to reflect, with a bright window and a strip of warm light.
      const up = bounce.y as any;
      const room = mix(color("#120806"), color("#ffe3bf"), smoothstep(0.1, 0.92, up)).add(color("#fff6e8").mul(smoothstep(0.86, 0.94, dot(bounce, normalize(vec3(-0.5, 0.72, 0.45)))).mul(7))).add(color("#ffc78c").mul(smoothstep(0.82, 0.92, dot(bounce, normalize(vec3(0.84, 0.32, 0.42)))).mul(2.6)));
      const fresnel = float(0.04).add(float(0.96).mul(pow(float(1).sub(ndv), float(5)))) as any;
      const red = redness(point) as any;
      const deep = mix(color("#e8650a"), color("#6c0413"), red);
      const lit = mix(color("#ffc23e"), color("#df1d2b"), red);
      // Light goes in, and comes out glowing on the side away from it, and thin at the edges.
      const glow = smoothstep(-0.7, 0.7, dot(n, normalize(vec3(0.4, -0.7, -0.3))));
      const body = mix(deep, lit, glow.mul(0.72).add(float(1).sub(ndv).mul(0.42)).clamp(0, 1));
      const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(point, 1)) as any;
      depthOut.assign(clip.z.div(clip.w));
      normalOut.assign(n);
      return mix(body.mul(1.08), room, fresnel);
    });
    look.emissiveNode = shade() as any;
    look.normalNode = transformNormalToView(normalOut) as any;
    look.depthNode = depthOut as any;
    return look;
  }, [uniforms, steps, blobCount]);

  useEffect(() => () => material.dispose(), [material]);

  const proxy = useMemo(() => {
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), material, blobCount);
    mesh.frustumCulled = false;
    mesh.count = 0;
    return mesh;
  }, [material, blobCount]);

  useEffect(() => () => proxy.dispose(), [proxy]);

  const scratch = useMemo(() => ({ matrix: new THREE.Matrix4(), scale: new THREE.Vector3(), place: new THREE.Vector3(), world: new THREE.Vector3(), turn: new THREE.Quaternion() }), []);

  const update = (sim: JuiceSim, peach: THREE.Matrix4) => {
    const values = (uniforms.blobs as any).array as THREE.Vector4[];
    const reds = (uniforms.reds as any).array as number[];
    let used = 0;
    for (const drip of sim.drips) {
      if (!drip.alive) continue;
      const parts = [drip, drip.tail[0], drip.tail[1], drip.tail[2]];
      for (let i = 0; i < HEAD_AND_TAIL && used < blobCount; i++) {
        const radius = drip.r * (i === 0 ? 1 : i === 1 ? 0.7 : i === 2 ? 0.46 : 0.26);
        // Moves with the peach, but the shader works in the world.
        scratch.place.set(parts[i].x, parts[i].y, parts[i].z);
        scratch.world.copy(scratch.place).applyMatrix4(peach);
        values[used].set(scratch.world.x, scratch.world.y, scratch.world.z, radius);
        reds[used] = drip.red;
        scratch.scale.setScalar(radius + 0.16);
        scratch.matrix.compose(scratch.place, scratch.turn, scratch.scale);
        proxy.setMatrixAt(used, scratch.matrix);
        used++;
      }
    }
    // Empty places are far below everything, so they add nothing to the surface.
    for (let i = used; i < blobCount; i++) values[i].set(0, -50, 0, 0);
    proxy.count = used;
    proxy.instanceMatrix.needsUpdate = true;
  };

  return { proxy, update };
}
