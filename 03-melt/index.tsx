"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  Break,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cos,
  dot,
  exp,
  float,
  Fn,
  If,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  sqrt,
  transformNormalToView,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useGrabbable } from "../shared/engine/controls";
import { useQuality } from "../shared/engine/quality";
import { useSetting, useSettingAction, useSettingRef } from "../shared/engine/settings";
import { sound, useBed, useEvery } from "../shared/engine/sound";
import { useLook } from "../shared/engine/Stage";
import type { DayDefinition, Look } from "../shared/engine/types";
import { BAR_HALF, BAR_RADIUS, BOUND_CENTRE_Y, BOUND_RADIUS, MAX_BLOBS, MAX_RIPPLES, MeltSim, ORB_RADIUS, RING_RADIUS, RING_TUBE, SOURCE_Y, type SourceKind } from "./sim";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

type Backdrop = { zenith: string; horizon: string; floor: string; key: string; left: string; right: string; strip: number; look: Partial<Look> };

// Painted HDR rooms: values well over 1, so that the reflections and the bloom have something to hold on to.
const BACKDROPS: Record<string, Backdrop> = {
  studio: { zenith: "#07090d", horizon: "#343c48", floor: "#040507", key: "#fff4e4", left: "#bcd6ff", right: "#ffd1a3", strip: 0, look: { exposure: 1, bloom: 0.16 } },
  dusk: { zenith: "#14163a", horizon: "#d4703f", floor: "#0c060c", key: "#ffc98c", left: "#ff6f7d", right: "#6f8bff", strip: 0, look: { exposure: 1, bloom: 0.22 } },
  neon: { zenith: "#07040f", horizon: "#3a1466", floor: "#03020a", key: "#b9f2ff", left: "#ff2bb4", right: "#17e8ff", strip: 1, look: { exposure: 1.05, bloom: 0.34 } }
};

const METALS: Record<string, { tint: string; film: number }> = {
  chrome: { tint: "#f4f6f9", film: 0 },
  gold: { tint: "#ffc861", film: 0 },
  copper: { tint: "#f59a72", film: 0 },
  oil: { tint: "#c7ccd6", film: 1 }
};

const SOURCE_MODE: Record<string, number> = { ring: 0, orb: 1, bar: 2 };

const dripped = (x: number, r: number) => sound.play("drip", { gain: 0.5 + r * 0.7, pitch: 1.25 - r * 0.6, pan: x / 8 });
// A crown throws up a lot of droplets, so the small ones share a slot, or it turns into rain.
let dropletAt = 0;
const plopped = (x: number, r: number, hit: number) => {
  if (r < 0.2) {
    const now = performance.now();
    if (now - dropletAt < 140) return;
    dropletAt = now;
  }
  sound.play("plop", { gain: 0.1 + hit * 0.8, pitch: Math.max(0.6, 1.35 - r * 0.8), pan: x / 8 });
};

function Metal() {
  const { tier } = useQuality();
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const heat = useSettingRef<number>("heat");
  const viscosity = useSettingRef<number>("viscosity");
  const gravity = useSettingRef<number>("gravity");
  const sourceKey = useSetting<string>("source");
  const metalKey = useSetting<string>("metal");
  const backdropKey = useSetting<string>("backdrop");
  const backdrop = BACKDROPS[backdropKey] ?? BACKDROPS.studio;
  const metal = METALS[metalKey] ?? METALS.chrome;

  useLook(backdrop.look);

  const sim = useMemo(() => new MeltSim(), []);
  sim.capacity = tier === "high" ? MAX_BLOBS : tier === "medium" ? 22 : 14;
  sim.onDrip = dripped;
  sim.onPlop = plopped;

  const uniforms = useMemo(
    () => ({
      blobs: uniformArray(Array.from({ length: MAX_BLOBS }, () => new THREE.Vector4(0, -50, 0, 0)), "vec4"),
      count: (uniform as any)(0, "int"),
      ripples: uniformArray(Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -100, 0)), "vec4"),
      clock: uniform(0),
      blend: uniform(0.5),
      mode: uniform(0),
      sourceAt: uniform(new THREE.Vector3(0, SOURCE_Y, 0)),
      tint: uniform(new THREE.Color()),
      film: uniform(0),
      strip: uniform(0),
      zenith: uniform(new THREE.Color()),
      horizon: uniform(new THREE.Color()),
      floor: uniform(new THREE.Color()),
      key: uniform(new THREE.Color()),
      left: uniform(new THREE.Color()),
      right: uniform(new THREE.Color())
    }),
    []
  );

  useEffect(() => {
    uniforms.zenith.value.set(backdrop.zenith);
    uniforms.horizon.value.set(backdrop.horizon);
    uniforms.floor.value.set(backdrop.floor);
    uniforms.key.value.set(backdrop.key);
    uniforms.left.value.set(backdrop.left);
    uniforms.right.value.set(backdrop.right);
    uniforms.strip.value = backdrop.strip;
  }, [uniforms, backdrop]);
  useEffect(() => {
    uniforms.tint.value.set(metal.tint);
    uniforms.film.value = metal.film;
  }, [uniforms, metal]);
  useEffect(() => {
    sim.source = (sourceKey as SourceKind) ?? "ring";
    sim.resetSource();
    sim.moveSource(sim.sourceAt.x, sim.sourceAt.y, sim.sourceAt.z);
    uniforms.mode.value = SOURCE_MODE[sourceKey] ?? 0;
  }, [sim, sourceKey, uniforms]);

  const primarySteps = tier === "high" ? 60 : tier === "medium" ? 42 : 28;
  const bounceSteps = tier === "high" ? 22 : tier === "medium" ? 14 : 0;

  const material = useMemo(() => {
    const u = uniforms as any;
    const centre = vec3(0, BOUND_CENTRE_Y, 0) as any;

    // Polynomial smooth minimum, after Inigo Quilez: https://iquilez.org/articles/smin/
    const smin = Fn(([a, b, k]: any[]) => {
      const h = max(k.sub(abs(a.sub(b))), float(0)).div(k) as any;
      return min(a, b).sub(h.mul(h).mul(k).mul(0.25));
    }).setLayout({ name: "meltBlend", type: "float", inputs: [{ name: "a", type: "float" }, { name: "b", type: "float" }, { name: "k", type: "float" }] }) as any;

    // Everything solid in one function. The lake is part of it, so a drop swells the surface as it lands.
    const map = Fn(([p]: any[]) => {
      const q = p.sub(u.sourceAt) as any;
      const wobble = sin(p.x.mul(2.1).add(u.clock.mul(0.9))).mul(sin(p.z.mul(2.3).sub(u.clock.mul(0.7)))).mul(sin(p.y.mul(2.6).add(u.clock.mul(0.6)))).mul(0.055) as any;
      const ring = length(vec2(length(q.xz).sub(RING_RADIUS), q.y)).sub(RING_TUBE) as any;
      const orb = length(q).sub(ORB_RADIUS) as any;
      const along = clamp(q.x, -BAR_HALF, BAR_HALF) as any;
      const bar = length(vec3(q.x.sub(along), q.y, q.z)).sub(BAR_RADIUS) as any;
      const source = mix(mix(ring, orb, clamp(u.mode, 0, 1)), bar, clamp(u.mode.sub(1), 0, 1)).add(wobble) as any;
      const d = source.toVar() as any;
      Loop({ start: int(0), end: u.count, type: "int" }, ({ i }: any) => {
        const blob = u.blobs.element(i) as any;
        d.assign(smin(d, length(p.sub(blob.xyz)).sub(blob.w), u.blend));
      });
      return smin(d, p.y, u.blend.mul(0.75));
    }).setLayout({ name: "meltMap", type: "float", inputs: [{ name: "p", type: "vec3" }] }) as any;

    const normalAt = Fn(([p]: any[]) => {
      const e = float(0.0016) as any;
      const a = vec3(e, e.negate(), e.negate()) as any;
      const b = vec3(e.negate(), e.negate(), e) as any;
      const c = vec3(e.negate(), e, e.negate()) as any;
      const d = vec3(e, e, e) as any;
      return normalize(a.mul(map(p.add(a))).add(b.mul(map(p.add(b)))).add(c.mul(map(p.add(c)))).add(d.mul(map(p.add(d)))));
    }).setLayout({ name: "meltNormal", type: "vec3", inputs: [{ name: "p", type: "vec3" }] }) as any;

    // The room, in HDR: a sky gradient, a big softbox overhead, two side strips, and a neon ring if the room has one.
    const room = Fn(([direction, lights]: any[]) => {
      const y = direction.y as any;
      const base = mix(mix(u.horizon, u.floor, smoothstep(0, 0.32, y.negate())), u.zenith, smoothstep(0, 0.75, y)) as any;
      const box = smoothstep(0.62, 0.72, y).mul(smoothstep(0.62, 0.42, abs(direction.x))).mul(smoothstep(0.58, 0.4, abs(direction.z.add(0.08)))) as any;
      const leftStrip = smoothstep(0.1, 0.02, abs(direction.x.add(0.8))).mul(smoothstep(0.75, 0.55, abs(y.sub(0.25)))) as any;
      const rightStrip = smoothstep(0.07, 0.015, abs(direction.z.sub(0.8))).mul(smoothstep(0.7, 0.5, abs(y.sub(0.28)))).mul(smoothstep(-0.2, 0.2, direction.x)) as any;
      const halo = smoothstep(0.045, 0.012, abs(y.sub(0.2))).mul(u.strip) as any;
      const stripes = smoothstep(0.86, 0.96, sin(direction.x.mul(9).add(direction.z.mul(6)))).mul(smoothstep(0.02, 0.2, y)).mul(u.strip) as any;
      const lit = u.key.mul(box.mul(7)).add(u.left.mul(leftStrip.mul(7))).add(u.right.mul(rightStrip.mul(6))).add(mix(u.left, u.right, direction.x.mul(0.5).add(0.5)).mul(halo.mul(7).add(stripes.mul(2.4)))) as any;
      return base.add(lit.mul(lights));
    }).setLayout({ name: "meltRoom", type: "vec3", inputs: [{ name: "direction", type: "vec3" }, { name: "lights", type: "float" }] }) as any;

    const fromBound = Fn(([ro, rd]: any[]) => {
      const oc = ro.sub(centre) as any;
      const b = dot(oc, rd) as any;
      const c = dot(oc, oc).sub(BOUND_RADIUS * BOUND_RADIUS) as any;
      const h = b.mul(b).sub(c) as any;
      const root = sqrt(max(h, float(0))) as any;
      return vec3(b.negate().sub(root), b.negate().add(root), h);
    }).setLayout({ name: "meltBound", type: "vec3", inputs: [{ name: "ro", type: "vec3" }, { name: "rd", type: "vec3" }] }) as any;

    const march = (name: string, steps: number) =>
      Fn(([ro, rd, near, far]: any[]) => {
        const t = near.toVar() as any;
        const hit = float(-1).toVar() as any;
        Loop(steps, () => {
          const d = map(ro.add(rd.mul(t))) as any;
          If(d.lessThan(t.mul(0.0007).add(0.0012)), () => {
            hit.assign(t);
            Break();
          });
          t.addAssign(d);
          If(t.greaterThan(far), () => {
            Break();
          });
        });
        return hit;
      }).setLayout({ name, type: "float", inputs: [{ name: "ro", type: "vec3" }, { name: "rd", type: "vec3" }, { name: "near", type: "float" }, { name: "far", type: "float" }] }) as any;
    const marchPrimary = march("meltPrimary", primarySteps);
    const marchBounce = bounceSteps > 0 ? march("meltBounce", bounceSteps) : null;

    // Rings moving out across the surface, as a slope, plus a slow swell that keeps the mirror alive.
    const surfaceSlope = Fn(([p]: any[]) => {
      const slope = vec2(
        sin(p.x.mul(0.9).add(p.z.mul(0.4)).add(u.clock.mul(0.55))).mul(0.006).add(sin(p.x.mul(2.3).sub(p.z.mul(1.9)).add(u.clock.mul(0.8))).mul(0.0045)),
        sin(p.z.mul(1.1).sub(p.x.mul(0.5)).add(u.clock.mul(0.5))).mul(0.006).add(sin(p.z.mul(2.7).add(p.x.mul(1.7)).sub(u.clock.mul(0.7))).mul(0.0045))
      ).toVar() as any;
      Loop({ start: int(0), end: int(MAX_RIPPLES), type: "int" }, ({ i }: any) => {
        const ripple = u.ripples.element(i) as any;
        const age = u.clock.sub(ripple.z) as any;
        const offset = p.xz.sub(ripple.xy) as any;
        const distance = max(length(offset), float(0.001)) as any;
        const front = distance.sub(age.mul(3.4)) as any;
        const height = cos(front.mul(9)).mul(exp(abs(front).mul(-1.1))).mul(exp(age.mul(-1.05))).mul(ripple.w).mul(0.55) as any;
        slope.addAssign(offset.div(distance).mul(height));
      });
      return slope;
    }).setLayout({ name: "meltSlope", type: "vec2", inputs: [{ name: "p", type: "vec3" }] }) as any;

    // How metal answers a view: Fresnel on a tint, or a thin film of oil whose colour runs with the angle.
    const metalAt = Fn(([ndv, p]: any[]) => {
      const edge = pow(float(1).sub(ndv), float(5)) as any;
      const tinted = mix(u.tint, vec3(1), edge) as any;
      const phase = ndv.mul(2.6).add(sin(p.x.mul(1.3).add(p.y.mul(1.9)).add(u.clock.mul(0.2))).mul(0.45)).add(sin(p.z.mul(1.7).sub(p.y)).mul(0.3)) as any;
      const film = vec3(cos(phase.mul(6.283)), cos(phase.add(0.33).mul(6.283)), cos(phase.add(0.67).mul(6.283))).mul(0.5).add(0.5) as any;
      return mix(tinted, film.mul(0.9).add(0.1).mul(mix(float(0.55), float(1), edge)), u.film);
    }).setLayout({ name: "meltMetal", type: "vec3", inputs: [{ name: "ndv", type: "float" }, { name: "p", type: "vec3" }] }) as any;

    // What a reflected ray sees: other metal if it hits some, the room if not. The lake past the bound is a dim mirror.
    const traced = Fn(([ro, rd]: any[]) => {
      const seen = room(rd, float(1)).toVar() as any;
      If(rd.y.lessThan(0), () => {
        seen.assign(room(vec3(rd.x, rd.y.negate(), rd.z), float(1)).mul(0.72));
      });
      if (marchBounce) {
        const bound = fromBound(ro, rd) as any;
        If(bound.z.greaterThan(0).and(bound.y.greaterThan(0)), () => {
          const hit = marchBounce(ro, rd, max(bound.x, float(0.03)), bound.y) as any;
          If(hit.greaterThan(0), () => {
            const point = ro.add(rd.mul(hit)) as any;
            const normal = normalAt(point) as any;
            const twice = reflect(rd, normal) as any;
            const ndv = clamp(dot(normal, rd.negate()), 0, 1) as any;
            seen.assign(room(twice, float(1)).mul(metalAt(ndv, point)).mul(0.92));
          });
        });
      }
      return seen;
    }).setLayout({ name: "meltTraced", type: "vec3", inputs: [{ name: "ro", type: "vec3" }, { name: "rd", type: "vec3" }] }) as any;

    const occlusion = Fn(([p, n]: any[]) => {
      const a = max(map(p.add(n.mul(0.12))).div(0.12), float(0)) as any;
      const b = max(map(p.add(n.mul(0.42))).div(0.42), float(0)) as any;
      const c = max(map(p.add(n.mul(1.1))).div(1.1), float(0)) as any;
      return clamp(a.mul(0.2).add(b.mul(0.35)).add(c.mul(0.45)), 0, 1);
    }).setLayout({ name: "meltOcclusion", type: "float", inputs: [{ name: "p", type: "vec3" }, { name: "n", type: "vec3" }] }) as any;

    const look = new THREE.MeshStandardNodeMaterial({ side: THREE.BackSide, roughness: 1, metalness: 0 });
    look.colorNode = vec3(0) as any;

    // One shading pass, which leaves its answers in variables so the normal, depth and colour share one march.
    const ro = cameraPosition as any;
    const rd = normalize(positionWorld.sub(cameraPosition)) as any;
    const depthOut = float(0.5).toVar("meltDepth") as any;
    const normalOut = vec3(0, 1, 0).toVar("meltWorldNormal") as any;
    const shade = Fn(() => {
      const direction = rd.toVar() as any;
      const distance = float(-1).toVar() as any;
      const bound = fromBound(ro, direction).toVar() as any;
      If(bound.z.greaterThan(0).and(bound.y.greaterThan(0)), () => {
        distance.assign(marchPrimary(ro, direction, max(bound.x, float(0.03)), bound.y));
      });
      const isSky = float(0).toVar() as any;
      const normal = vec3(0, 1, 0).toVar() as any;
      If(distance.lessThan(0), () => {
        // Past where the mirror has dissolved, it may as well be the room: same colour, nothing to shade.
        If(direction.y.lessThan(-0.0005).and(ro.y.negate().div(direction.y).lessThan(80)), () => {
          distance.assign(ro.y.negate().div(direction.y));
        }).Else(() => {
          isSky.assign(1);
          distance.assign(100);
        });
      }).Else(() => {
        normal.assign(normalAt(ro.add(direction.mul(distance))));
      });
      const point = ro.add(direction.mul(distance)).toVar() as any;
      const colour = vec3(0).toVar() as any;
      If(isSky.greaterThan(0.5), () => {
        colour.assign(room(vec3(direction.x, abs(direction.y), direction.z), float(0.3)));
      }).Else(() => {
        const nearSurface = smoothstep(0.16, 0.02, point.y) as any;
        const slope = surfaceSlope(point) as any;
        normal.assign(normalize(normal.add(vec3(slope.x.negate(), 0, slope.y.negate()).mul(nearSurface))));
        const ndv = clamp(dot(normal, direction.negate()), 0, 1) as any;
        const bounce = reflect(direction, normal) as any;
        const reflected = traced(point.add(normal.mul(0.012)), bounce) as any;
        const ao = occlusion(point, normal) as any;
        // Dissolves into the room well before the horizon, so the mirror has no far edge.
        const fade = exp(distance.mul(distance).mul(-0.0011)) as any;
        const shaded = reflected.mul(metalAt(ndv, point)).mul(mix(float(0.32), float(1), ao)) as any;
        colour.assign(mix(room(vec3(direction.x, abs(direction.y), direction.z), float(0.3)), shaded, fade));
      });
      const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(point, 1)) as any;
      depthOut.assign(isSky.greaterThan(0.5).select(float(1), min(clip.z.div(clip.w), float(0.9999))));
      normalOut.assign(normal);
      return colour;
    });
    look.emissiveNode = shade() as any;
    look.normalNode = transformNormalToView(normalOut) as any;
    look.depthNode = depthOut as any;
    return look;
  }, [uniforms, primarySteps, bounceSteps]);

  useEffect(() => () => material.dispose(), [material]);

  const held = useRef({ index: -1, x: 0, y: 0, z: 0, pending: -1, downAt: 0, downX: 0, downY: 0, source: false, pendingSource: false, offsetX: 0, offsetY: 0, offsetZ: 0 });

  useSettingAction("pour", () => {
    sim.pour();
    for (const [i, delay] of [0, 60, 130, 210, 320].entries()) {
      window.setTimeout(() => sound.play("plop", { gain: 0.9 - i * 0.12, pitch: 0.7 + Math.random() * 0.5, pan: Math.random() - 0.5 }), delay);
    }
  });

  // The room hums harder with the heat, and past a point the metal starts to spit.
  const hum = useBed("hum", 0.16);
  useEvery(0.2, 0.6, () => {
    hum.current?.level(0.12 + heat.current * 0.04);
    hum.current?.tone(0.7 + heat.current * 0.5);
    if (heat.current > 1.4) sound.play("sizzle", { gain: 0.15 + ((heat.current - 1.4) / 1.6) * 0.75, pan: Math.random() * 0.8 - 0.4 });
  });

  useGrabbable({
    pick(ray) {
      const { origin: o, direction: d } = ray;
      const hit = sim.pick(o.x, o.y, o.z, d.x, d.y, d.z);
      const onSource = sim.pickSource(o.x, o.y, o.z, d.x, d.y, d.z);
      const state = held.current;
      // Whichever is nearer. A drop hanging off the source can still be pulled away from it.
      state.pendingSource = onSource !== null && (!hit || onSource < hit.t);
      state.pending = hit && !state.pendingSource ? hit.index : -1;
      const distance = state.pendingSource ? onSource : hit?.t;
      return distance != null ? { distance, point: ray.at(distance, new THREE.Vector3()) } : null;
    },
    grab(point) {
      const state = held.current;
      if (state.pendingSource) {
        state.source = true;
        state.offsetX = sim.sourceAt.x - point.x;
        state.offsetY = sim.sourceAt.y - point.y;
        state.offsetZ = sim.sourceAt.z - point.z;
        sound.play("thud", { gain: 0.5, size: 0.4, pitch: 1.3, pan: point.x / 8 });
        return;
      }
      if (state.pending < 0) return;
      state.index = state.pending;
      state.x = point.x;
      state.y = point.y;
      state.z = point.z;
      sim.grab(state.index);
      sound.play("drip", { gain: 0.8, pan: point.x / 8 });
    },
    drag(point) {
      const state = held.current;
      if (state.source) {
        sim.moveSource(point.x + state.offsetX, point.y + state.offsetY, point.z + state.offsetZ);
        return;
      }
      state.x = point.x;
      state.y = Math.max(0.05, point.y);
      state.z = point.z;
    },
    release() {
      const state = held.current;
      state.source = false;
      if (state.index >= 0) {
        sim.release(state.index);
        const blob = sim.blobs[state.index];
        const thrown = Math.hypot(blob.vx, blob.vy, blob.vz);
        if (thrown > 3) sound.play("whoosh", { gain: Math.min(1, 0.3 + thrown * 0.06), pitch: 0.9 + Math.min(0.5, thrown * 0.03), pan: blob.x / 8 });
      }
      state.index = -1;
    }
  });

  // A quick tap on the surface throws up a crown. Dragging stays the orbit.
  useEffect(() => {
    const dom = gl.domElement as HTMLCanvasElement;
    const press = { x: 0, y: 0, at: 0 };
    const down = (event: PointerEvent) => {
      press.x = event.clientX;
      press.y = event.clientY;
      press.at = performance.now();
    };
    const up = (event: PointerEvent) => {
      if (held.current.index >= 0 || held.current.pending >= 0 || held.current.pendingSource) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 7 || performance.now() - press.at > 400) return;
      const rect = dom.getBoundingClientRect();
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera);
      const { origin, direction } = raycaster.ray;
      if (direction.y >= -0.001) return;
      const t = -origin.y / direction.y;
      const x = origin.x + direction.x * t;
      const z = origin.z + direction.z * t;
      if (Math.hypot(x, z) < BOUND_RADIUS - 1) {
        sim.splash(x, z, 0.8);
        sound.play("plop", { gain: 1, pitch: 0.8, pan: x / 8 });
      }
    };
    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointerup", up);
    return () => {
      dom.removeEventListener("pointerdown", down);
      dom.removeEventListener("pointerup", up);
    };
  }, [gl, camera, sim]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const state = held.current;
    sim.update(delta, heat.current, viscosity.current, gravity.current, state.index >= 0 ? state : null);
    uniforms.clock.value = sim.clock;
    uniforms.sourceAt.value.set(sim.sourceAt.x, sim.sourceAt.y, sim.sourceAt.z);
    uniforms.blend.value = 0.22 + viscosity.current * 0.62;

    const blobs = uniforms.blobs.array as THREE.Vector4[];
    let count = 0;
    for (const blob of sim.blobs) {
      if (blob.state === 0 || blob.r <= 0) continue;
      blobs[count].set(blob.x, blob.y, blob.z, blob.r);
      count++;
    }
    uniforms.count.value = count;
    const ripples = uniforms.ripples.array as THREE.Vector4[];
    sim.ripples.forEach((ripple, i) => ripples[i].set(ripple.x, ripple.z, ripple.born, ripple.amp));
  });

  return (
    <mesh material={material} frustumCulled={false}>
      <sphereGeometry args={[100, 32, 24]} />
    </mesh>
  );
}

function Scene() {
  return <Metal />;
}

const melt: DayDefinition = {
  camera: { position: [0, 4, 15.5], target: [0, 3.9, 0], fov: 36 },
  phonePills: ["source"],
  extents: { centre: [0, 4, 0], radius: 26, floor: 0, color: "#d6e2ff" },
  // Nothing here is lit by bounced light: every colour comes from a traced reflection.
  passes: { bounce: false, haze: false },
  look: { background: "#0a0c10", ao: 0.4, aoRadius: 0.5, vignette: 0.3, grain: 0.012, bloomThreshold: 1 },
  settings: {
    source: {
      type: "choice",
      label: "Dripping from",
      value: "ring",
      options: [
        { value: "ring", label: "Ring" },
        { value: "orb", label: "Orb" },
        { value: "bar", label: "Bar" }
      ]
    },
    metal: {
      type: "choice",
      label: "Metal",
      value: "oil",
      options: [
        { value: "chrome", label: "Chrome", swatch: ["#f4f6f9", "#8d939c"] },
        { value: "gold", label: "Gold", swatch: ["#ffc861", "#a8741f"] },
        { value: "copper", label: "Copper", swatch: ["#f59a72", "#964b2f"] },
        { value: "oil", label: "Oil", swatch: ["#7a4bff", "#17e8c0"] }
      ]
    },
    backdrop: {
      type: "choice",
      label: "Room",
      value: "neon",
      options: [
        { value: "studio", label: "Studio", swatch: ["#1a1e26", "#b9c2cc"] },
        { value: "dusk", label: "Dusk", swatch: ["#23264f", "#ff9a5c"] },
        { value: "neon", label: "Neon", swatch: ["#ff2bb4", "#17e8ff"] }
      ]
    },
    heat: { type: "range", label: "Heat", min: 0.2, max: 3, step: 0.01, value: 1 },
    viscosity: { type: "range", label: "Viscosity", min: 0, max: 1, step: 0.01, value: 0.5 },
    gravity: { type: "range", label: "Gravity", min: 0, max: 1.6, step: 0.01, value: 1 },
    pour: { type: "action", label: "Pour" }
  },
  notes: "The metal is ray-marched per pixel as signed distance field metaballs, moved by a custom fluid-like solver and not a physics engine. Reflections are traced in the shader against a procedural HDR room, so it needs no screen-space global illumination, with ambient occlusion from the depth and temporal anti-aliasing on top.",
  hint: "Grab the metal and carry it around, or pull a drop off and throw it. Tap the mirror to splash it.",
  Scene
};

export default melt;
