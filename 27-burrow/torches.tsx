"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, clamp, cross, exp, float, length, max, mix, normalize, positionGeometry, positionView, pow, sin, smoothstep, uv, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { OVERLAY_LAYER } from "../shared/engine/Post";
import { lehmer } from "../shared/engine/random";
import { lamp, overlayMaterial, TORCH_LIGHTS, torchLights, useOverlay } from "./fx";
import { crackle, ignite } from "./sound";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Torches mounted on the walls, burning for good: a trail home. However many are left behind, only the nearest few
// light the rock (a fixed set of lights, handed to whichever are nearest each frame, so the shaders never change);
// every one keeps its flame and its glow in the air. Sparks rise from the near ones, and smoke curls off.

const MOST = 512;
// Where the flame sits along the stick, from the bracket on the wall.
const STICK = 0.5;

type Torch = { base: THREE.Vector3; flame: THREE.Vector3; seed: number; since: number };

export const torches = {
  list: [] as Torch[],
  // The real lights handed to the nearest (for `caveLights`, fx.tsx).
  lights: [] as THREE.PointLight[],
  // Asked for by the scene; set up once the meshes exist.
  place: (_at: THREE.Vector3, _normal: THREE.Vector3) => {}
};

// How many you carry: sixty to start, one spent with each mounted, five more in every lost explorer's camp you break
// into. `last` is the latest change for the HUD to show (run out, or found more).
export const STARTING_TORCHES = 60;
export const supply = {
  left: STARTING_TORCHES,
  last: null as null | { kind: "empty" | "found"; count: number; at: number },
  version: 0,
  listeners: new Set<() => void>(),
  changed(last?: { kind: "empty" | "found"; count: number }) {
    if (last) this.last = { ...last, at: performance.now() };
    this.version++;
    for (const listener of this.listeners) listener();
  },
  // Takes one if there is one; otherwise says so.
  take() {
    if (this.left <= 0) {
      this.changed({ kind: "empty", count: 0 });
      return false;
    }
    this.left--;
    this.changed();
    return true;
  },
  give(count: number) {
    this.left += count;
    this.changed({ kind: "found", count });
  }
};

// A torch's stick and bracket, standing along +y from its foot: a rough stick, a pitch-soaked head of wrapped rag at
// the top, and an iron ring and plate where it meets the wall.
function torchParts() {
  const stick = new THREE.CylinderGeometry(0.018, 0.024, STICK, 7, 1);
  stick.translate(0, STICK / 2, 0);
  const head = new THREE.CylinderGeometry(0.042, 0.032, 0.11, 9, 2);
  head.translate(0, STICK - 0.04, 0);
  const ring = new THREE.TorusGeometry(0.034, 0.008, 5, 12);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 0.12, 0);
  const plate = new THREE.BoxGeometry(0.07, 0.11, 0.015);
  plate.translate(0, 0.08, -0.035);
  return { stick, head, ring, plate };
}

export function Torches() {
  const camera = useThree((state) => state.camera);
  const built = useMemo(() => {
    const parts = torchParts();
    const wood = new THREE.MeshStandardNodeMaterial({ color: "#3a2616", roughness: 0.9 });
    const pitch = new THREE.MeshStandardNodeMaterial({ color: "#1a120c", roughness: 0.7 });
    // The burning head glows from within where the flame wraps it.
    const glowing = positionGeometry.y
      .sub(STICK - 0.09)
      .div(0.1)
      .clamp(0, 1) as any;
    pitch.emissiveNode = vec3(1.0, 0.36, 0.08).mul(glowing.mul(glowing).mul(2.5)) as any;
    const iron = new THREE.MeshStandardNodeMaterial({ color: "#26221f", roughness: 0.55, metalness: 0.8 });
    const make = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
      const mesh = new THREE.InstancedMesh(geometry, material, MOST);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      return mesh;
    };
    const sticks = make(parts.stick, wood);
    const heads = make(parts.head, pitch);
    const rings = make(parts.ring, iron);
    const plates = make(parts.plate, iron);

    // The flame: a quad turned to the eye about the torch's upright, shaped and coloured in the shader, its core far
    // past white so the bloom catches it. Cut to shape rather than blended, so it is focused at its own distance.
    const flameData = new Float32Array(MOST * 4);
    const flameAttribute = new THREE.InstancedBufferAttribute(flameData, 4).setUsage(THREE.DynamicDrawUsage);
    const quad = new THREE.PlaneGeometry(1, 1, 1, 6);
    quad.translate(0, 0.42, 0);
    quad.setAttribute("aFlame", flameAttribute);
    const flame = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const f = attribute("aFlame", "vec4") as any;
    const t = lamp.time as any;
    const g = positionGeometry as any;
    const toEye = normalize(vec3(cameraPosition.x.sub(f.x), 0, cameraPosition.z.sub(f.z)).add(vec3(1e-4, 0, 0))) as any;
    const side = vec3(toEye.z.negate(), 0, toEye.x) as any;
    // A lick of flame bending and stretching, never the same twice.
    const sway = sin(t.mul(7.3).add(f.w.mul(40)).add(g.y.mul(5)))
      .mul(0.025)
      .add(sin(t.mul(13.1).add(f.w.mul(13))).mul(0.012))
      .mul(g.y.add(0.1)) as any;
    const stretch = sin(t.mul(9.7).add(f.w.mul(20)))
      .mul(0.08)
      .add(1) as any;
    flame.positionNode = f.xyz.add(side.mul(g.x.mul(0.16).add(sway))).add(vec3(0, g.y.mul(0.34).mul(stretch), 0)) as any;
    const q = uv() as any;
    const h = q.y as any;
    const across = abs(
      q.x.sub(0.5).sub(
        sin(h.mul(6).add(t.mul(8)).add(f.w.mul(9)))
          .mul(0.06)
          .mul(h)
      )
    ) as any;
    // Wide at the root, pinched to a tip, flickering at its edge.
    const width = float(0.42)
      .mul(pow(float(1).sub(h), float(0.8)))
      .mul(smoothstep(0, 0.12, h))
      .mul(
        sin(h.mul(17).sub(t.mul(14)).add(f.w.mul(30)))
          .mul(0.12)
          .add(0.95)
      ) as any;
    const inside = float(1).sub(smoothstep(width.mul(0.7), width, across)) as any;
    flame.maskNode = inside.greaterThan(0.25) as any;
    const core = float(1)
      .sub(smoothstep(0, width.mul(0.8), across))
      .mul(float(1).sub(smoothstep(0.1, 0.7, h))) as any;
    flame.colorNode = mix(vec3(1.0, 0.32, 0.05).mul(3), vec3(1.0, 0.82, 0.5).mul(9), core) as any;
    const flames = new THREE.InstancedMesh(quad, flame, MOST);
    flames.count = 0;
    flames.frustumCulled = false;

    // A soft glow round every flame, in the overlay pass, behind rock where rock is in the way.
    const haloQuad = new THREE.PlaneGeometry(1, 1);
    haloQuad.setAttribute("aFlame", flameAttribute);
    const halo = overlayMaterial();
    const halos = new THREE.InstancedMesh(haloQuad, halo, MOST);
    halos.count = 0;
    halos.frustumCulled = false;
    halos.layers.set(OVERLAY_LAYER);

    // Sparks and smoke: one pool of sprites, shared by the nearest torches.
    const SPRITES = 500;
    const spriteData = new Float32Array(SPRITES * 4);
    const spriteLook = new Float32Array(SPRITES * 4);
    const spriteAttribute = new THREE.InstancedBufferAttribute(spriteData, 4).setUsage(THREE.DynamicDrawUsage);
    const spriteLookAttribute = new THREE.InstancedBufferAttribute(spriteLook, 4).setUsage(THREE.DynamicDrawUsage);
    const spriteQuad = new THREE.PlaneGeometry(1, 1);
    spriteQuad.setAttribute("aSprite", spriteAttribute);
    spriteQuad.setAttribute("aSpriteLook", spriteLookAttribute);
    const sprite = overlayMaterial();
    const sprites = new THREE.InstancedMesh(spriteQuad, sprite, SPRITES);
    sprites.frustumCulled = false;
    sprites.layers.set(OVERLAY_LAYER);
    const live = Array.from({ length: SPRITES }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), age: 0, life: 0, size: 0, smoke: false, seed: 0 }));

    // The lights, always in the scene (at nothing until there is a torch to give them).
    const lights = Array.from({ length: TORCH_LIGHTS }, () => {
      const light = new THREE.PointLight("#ff9a4c", 0, 11, 1.6);
      light.position.set(0, -500, 0);
      return light;
    });
    return {
      parts,
      wood,
      pitch,
      iron,
      sticks,
      heads,
      rings,
      plates,
      quad,
      flame,
      flames,
      flameData,
      flameAttribute,
      haloQuad,
      halo,
      halos,
      spriteQuad,
      sprite,
      sprites,
      spriteData,
      spriteLook,
      spriteAttribute,
      spriteLookAttribute,
      live,
      lights,
      random: lehmer(5151),
      next: 0
    };
  }, []);
  useDispose(
    built.parts.stick,
    built.parts.head,
    built.parts.ring,
    built.parts.plate,
    built.wood,
    built.pitch,
    built.iron,
    built.quad,
    built.flame,
    built.haloQuad,
    built.halo,
    built.spriteQuad,
    built.sprite
  );

  useOverlay(built.halo, (sceneZ) => {
    const f = attribute("aFlame", "vec4") as any;
    const centre = f.xyz.add(vec3(0, 0.12, 0)) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    const size = float(1.4) as any;
    built.halo.positionNode = centre.add(right.mul(positionGeometry.x.mul(size))).add(up.mul(positionGeometry.y.mul(size))) as any;
    const r = uv().sub(0.5).length() as any;
    const soft = exp(r.mul(r).mul(-26)) as any;
    const flicker = sin(lamp.time.mul(11).add(f.w.mul(50)))
      .mul(0.08)
      .add(0.92) as any;
    const behind = clamp(positionView.z.sub(sceneZ).div(0.4).add(1), 0, 1) as any;
    built.halo.colorNode = vec4(vec3(1.0, 0.55, 0.22).mul(soft.mul(flicker).mul(behind).mul(0.22)), 1) as any;
    built.halo.needsUpdate = true;
  });

  useOverlay(built.sprite, (sceneZ) => {
    const s = attribute("aSprite", "vec4") as any;
    const l = attribute("aSpriteLook", "vec4") as any;
    const toEye = normalize(cameraPosition.sub(s.xyz)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    // Sparks are stretched along their flight a little; smoke is round.
    const away = length(cameraPosition.sub(s.xyz)) as any;
    const size = max(s.w, away.mul(0.0012)) as any;
    built.sprite.positionNode = s.xyz.add(right.mul(positionGeometry.x.mul(size))).add(up.mul(positionGeometry.y.mul(size).mul(mix(float(1.8), float(1), l.y)))) as any;
    const r = uv().sub(0.5).mul(2).length() as any;
    const spark = float(1).sub(smoothstep(0.2, 1, r)) as any;
    const puff = pow(float(1).sub(smoothstep(0, 1, r)), float(2)).mul(
      sin(uv().x.mul(9).add(l.z.mul(30)))
        .mul(0.15)
        .add(0.85)
    ) as any;
    const colour = mix(vec3(1.0, 0.55, 0.18).mul(spark).mul(2.2), vec3(0.42, 0.34, 0.28).mul(puff).mul(0.18), l.y) as any;
    const behind = clamp(positionView.z.sub(sceneZ).div(0.2).add(1), 0, 1) as any;
    built.sprite.colorNode = vec4((varying(colour.mul(l.x)) as any).mul(behind), 1) as any;
    built.sprite.needsUpdate = true;
  });

  // (Before the scene's own layout effect hands them to `caveLights`.)
  useLayoutEffect(() => {
    torches.lights = built.lights;
  }, [built]);

  // A fresh visit starts with a full supply.
  useEffect(() => {
    supply.left = STARTING_TORCHES;
    supply.last = null;
    supply.changed();
  }, []);

  // Mounting one: on the wall at `at`, leaning out from it and up.
  torches.place = (at, normal) => {
    if (torches.list.length >= MOST) return;
    const base = at.clone().addScaledVector(normal, 0.04);
    const dir = normal
      .clone()
      .multiplyScalar(0.55)
      .add(new THREE.Vector3(0, 0.85, 0))
      .normalize();
    // On a floor it simply stands upright.
    if (normal.y > 0.7) dir.set(0, 1, 0);
    const k = torches.list.length;
    const torch = { base, flame: base.clone().addScaledVector(dir, STICK - 0.02), seed: built.random(), since: 0 };
    torches.list.push(torch);
    // Upright along the stick, its back (where the plate is) to the wall.
    const away = normal.clone().addScaledVector(dir, -normal.dot(dir));
    if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
    away.normalize();
    const across = new THREE.Vector3().crossVectors(dir, away);
    const m = new THREE.Matrix4().makeBasis(across, dir, away).setPosition(base);
    for (const mesh of [built.sticks, built.heads, built.rings, built.plates]) {
      mesh.setMatrixAt(k, m);
      mesh.count = k + 1;
      mesh.instanceMatrix.needsUpdate = true;
    }
    built.flameData.set([torch.flame.x, torch.flame.y, torch.flame.z, torch.seed], k * 4);
    built.flameAttribute.needsUpdate = true;
    built.flames.count = k + 1;
    built.halos.count = k + 1;
    ignite();
  };

  const order = useMemo(() => ({ near: [] as Torch[], far: [] as number[], crackleAt: 0, sparky: false, kick: new THREE.Vector3() }), []);
  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const now = lamp.time.value as number;
    const list = torches.list;
    // The nearest few get the lights, nearest first (each torch's distance worked out once, not in a sort's every
    // comparison).
    const { near, far } = order;
    near.length = 0;
    far.length = 0;
    for (const torch of list) {
      const d = torch.flame.distanceToSquared(camera.position);
      let at = near.length;
      while (at > 0 && far[at - 1] > d) at--;
      if (at >= TORCH_LIGHTS) continue;
      near.splice(at, 0, torch);
      far.splice(at, 0, d);
      if (near.length > TORCH_LIGHTS) {
        near.pop();
        far.pop();
      }
    }
    for (let k = 0; k < TORCH_LIGHTS; k++) {
      const light = built.lights[k];
      const torch = order.near[k];
      const slot = torchLights.array[k] as THREE.Vector4;
      if (!torch) {
        light.intensity = 0;
        slot.set(0, -1000, 0, 0);
        continue;
      }
      torch.since += dt;
      const s = torch.seed * 50;
      const flicker = 1 + Math.sin(now * 11 + s) * 0.07 + Math.sin(now * 17.3 + s * 2) * 0.05 + Math.sin(now * 4.1 + s) * 0.06;
      const lit = Math.min(1, torch.since * 2);
      light.position.set(torch.flame.x, torch.flame.y + 0.15, torch.flame.z);
      light.intensity = 3.2 * flicker * lit;
      slot.set(light.position.x, light.position.y, light.position.z, 0.35 * flicker * lit);
    }

    // Sparks and smoke from the nearest few.
    const { live, spriteData, spriteLook, random } = built;
    for (let n = 0; n < Math.min(5, order.near.length); n++) {
      const torch = order.near[n];
      if (torch.flame.distanceTo(camera.position) > 14) continue;
      if (random() < dt * 7) {
        const w = live[built.next++ % live.length];
        Object.assign(w, { age: 0, life: 0.8 + random() * 1.4, size: 0.006 + random() * 0.006, smoke: false, seed: random() });
        w.p.copy(torch.flame).add(order.kick.set((random() - 0.5) * 0.06, 0.1, (random() - 0.5) * 0.06));
        w.v.set((random() - 0.5) * 0.4, 0.7 + random() * 0.9, (random() - 0.5) * 0.4);
      }
      if (random() < dt * 3) {
        const w = live[built.next++ % live.length];
        Object.assign(w, { age: 0, life: 2.5 + random() * 2, size: 0.08 + random() * 0.06, smoke: true, seed: random() });
        w.p.copy(torch.flame);
        w.p.y += 0.3;
        w.v.set((random() - 0.5) * 0.08, 0.25 + random() * 0.15, (random() - 0.5) * 0.08);
      }
    }
    let alive = 0;
    for (let k = 0; k < live.length; k++) {
      const w = live[k];
      const i = k * 4;
      if (w.age >= w.life) {
        spriteLook[i] = 0;
        spriteData[i + 3] = 0;
        continue;
      }
      alive++;
      w.age += dt;
      const f = w.age / w.life;
      if (w.smoke) {
        w.v.x += Math.sin(w.age * 1.7 + w.seed * 20) * 0.05 * dt;
        w.size += dt * 0.09;
      } else {
        w.v.x += (random() - 0.5) * 3 * dt;
        w.v.z += (random() - 0.5) * 3 * dt;
        w.v.y -= dt * 0.4;
      }
      w.p.addScaledVector(w.v, dt);
      spriteData[i] = w.p.x;
      spriteData[i + 1] = w.p.y;
      spriteData[i + 2] = w.p.z;
      spriteData[i + 3] = w.size;
      spriteLook[i] = w.smoke ? Math.sin(Math.PI * f) * 0.9 : (1 - f) * (0.6 + Math.sin(w.age * 40 + w.seed * 9) * 0.4);
      spriteLook[i + 1] = w.smoke ? 1 : 0;
      spriteLook[i + 2] = w.seed;
      spriteLook[i + 3] = f;
    }
    // Sent to the GPU only while any are alive, and once more as the last goes out.
    if (alive || order.sparky) {
      built.spriteAttribute.needsUpdate = true;
      built.spriteLookAttribute.needsUpdate = true;
    }
    order.sparky = alive > 0;

    // The nearest torch crackles and spits, louder the closer it is.
    const nearest = order.near[0];
    if (nearest && now > order.crackleAt) {
      const d = nearest.flame.distanceTo(camera.position);
      order.crackleAt = now + 0.08 + random() * 0.35;
      if (d < 9) crackle(Math.max(0, 1 - d / 9));
    }
  });

  return (
    <>
      <primitive object={built.sticks} />
      <primitive object={built.heads} />
      <primitive object={built.rings} />
      <primitive object={built.plates} />
      <primitive object={built.flames} />
      <primitive object={built.halos} />
      <primitive object={built.sprites} />
      {built.lights.map((light, k) => (
        <primitive key={k} object={light} />
      ))}
    </>
  );
}
