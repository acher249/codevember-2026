"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, exp, float, pow, uv, vec3 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The burst where a find comes out of the rock: a flash and a spray of four-pointed glints that fly out, fall a
// little and shrink away, gold for metal, white-blue for gems, warm white for stone. A fixed pool of sprites, reused
// round and round; nothing is made after load.
const POOL = 48;
const LOOKS = { metal: [1.0, 0.72, 0.28], crystal: [0.65, 0.85, 1.0], warm: [1.0, 0.88, 0.7] } as const;
export type GlintLook = keyof typeof LOOKS;
const COUNT = [8, 11, 15, 22, 30];
const METAL = new Set(["nugget", "coin", "compass", "watch", "idol", "quartz"]);
const GEM = new Set(["emerald", "ruby", "amethyst", "sapphire", "diamond", "shard"]);
export const lookOf = (kind: string): GlintLook => (METAL.has(kind) ? "metal" : GEM.has(kind) ? "crystal" : "warm");

type Spark = { sprite: THREE.Sprite; v: THREE.Vector3; age: number; life: number; size: number; flash: boolean };

const queue: { at: THREE.Vector3; scale: number; tier: number; look: GlintLook }[] = [];

// For the finds to call as one is taken.
export function glint(at: THREE.Vector3, scale: number, tier: number, look: GlintLook) {
  if (queue.length < 8) queue.push({ at: at.clone(), scale, tier, look });
}

export function Glints() {
  const camera = useThree((state) => state.camera);
  const built = useMemo(() => {
    const materials = {} as Record<GlintLook, THREE.SpriteNodeMaterial>;
    for (const key of Object.keys(LOOKS) as GlintLook[]) {
      const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const q = uv().sub(0.5) as any;
      const r = q.length().mul(2) as any;
      const core = pow(float(1).sub(r).max(0), float(4)) as any;
      const star = exp(abs(q.x).mul(-60))
        .mul(exp(abs(q.y).mul(-5)))
        .add(exp(abs(q.y).mul(-60)).mul(exp(abs(q.x).mul(-5)))) as any;
      m.colorNode = vec3(...LOOKS[key]).mul(core.mul(1.4).add(star.mul(1.6))) as any;
      materials[key] = m;
    }
    const looks = Object.keys(LOOKS) as GlintLook[];
    const sparks: Spark[] = Array.from({ length: POOL }, (_, k) => {
      const sprite = new THREE.Sprite(materials[looks[k % looks.length]]);
      // Drawn (unseen) for the first moments, so each look's pipeline is built behind the loader.
      sprite.scale.setScalar(1e-4);
      sprite.frustumCulled = false;
      sprite.renderOrder = 5;
      return { sprite, v: new THREE.Vector3(), age: 0, life: 0, size: 0, flash: false };
    });
    return { materials, sparks };
  }, []);
  useDispose(...Object.values(built.materials));
  const state = useMemo(() => ({ next: 0, warm: 1.5, to: new THREE.Vector3() }), []);

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    if (state.warm > 0) {
      state.warm -= dt;
      if (state.warm <= 0) for (const s of built.sparks) if (s.life <= 0) s.sprite.visible = false;
    }
    while (queue.length) {
      const b = queue.shift()!;
      // Out from the find toward the eye a little, so the rock round it does not hide the burst.
      state.to.copy(camera.position).sub(b.at).normalize();
      const n = COUNT[b.tier] ?? 8;
      for (let i = 0; i <= n; i++) {
        const s = built.sparks[state.next];
        state.next = (state.next + 1) % POOL;
        s.sprite.material = built.materials[b.look];
        s.sprite.position.copy(b.at).addScaledVector(state.to, b.scale * 1.4);
        s.sprite.visible = true;
        s.age = 0;
        s.flash = i === 0;
        if (s.flash) {
          s.v.set(0, 0, 0);
          s.life = 0.32;
          s.size = 0.45 + b.tier * 0.15;
        } else {
          // A random direction, leaning toward the eye and up.
          s.v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().addScaledVector(state.to, 0.6);
          s.v.y += 0.5;
          s.v.multiplyScalar((1.1 + Math.random() * 1.4) * (1 + b.tier * 0.12));
          s.life = 0.45 + Math.random() * 0.4 + b.tier * 0.06;
          s.size = (0.07 + Math.random() * 0.09) * (1 + b.tier * 0.1);
        }
      }
    }
    for (const s of built.sparks) {
      if (s.life <= 0) continue;
      s.age += dt;
      const k = s.age / s.life;
      if (k >= 1) {
        s.life = 0;
        s.sprite.visible = false;
        continue;
      }
      if (s.flash) {
        // Up fast, then away.
        s.sprite.scale.setScalar(s.size * Math.sin(Math.min(1, k * 1.6) * Math.PI) * (1 - k * 0.4));
        continue;
      }
      s.v.multiplyScalar(Math.exp(-dt * 3.2));
      s.v.y -= dt * 2.2;
      s.sprite.position.addScaledVector(s.v, dt);
      // Shrinking away, with a twinkle.
      s.sprite.scale.setScalar(s.size * (1 - k) * (0.75 + 0.25 * Math.sin(s.age * 40 + s.size * 300)));
    }
  });

  return (
    <>
      {built.sparks.map((s, k) => (
        <primitive key={k} object={s.sprite} />
      ))}
    </>
  );
}
