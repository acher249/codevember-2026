"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  PI,
  abs,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraWorldMatrix,
  cos,
  dot,
  float,
  floor,
  fract,
  max,
  min,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  output,
  positionGeometry,
  screenCoordinate,
  screenSize,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { useSetting, useSettingsStore } from "../../shared/engine/settings";
import type { SettingsSchema } from "../../shared/engine/types";
import { parts as figureParts, type FigureData } from "../photo/figure";
import { sculpt, type Kind, type Palette } from "../blur/materials";
import { chiffon, limestone, type Seat } from "../worlds/common";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Glitch art: the statues held in one material for a beat, then corrupted into the others and settling on the next, as
// a broken signal would show them. Every material is the same figure drawn again; each pixel (or each cell of space)
// shows exactly one of them, picked by a glitch mask they all share, and the same tearing moves all of them alike, so
// the materials cut against each other along the glitch's own lines rather than fading. Three kinds of break:
//   tear:    horizontal bands slip sideways, each band another material, fringed and interlaced (a VHS tracking error)
//   mosh:    macroblocks of the next material arrive out of order and slide along their motion vectors, ringing with
//            DCT patterns and crushed colour (a video stream that lost its keyframe)
//   shatter: the mesh itself breaks: cells of space snap to voxels, slabs jolt out, vertices fly off in spikes, each
//            cell another material (a GPU dropping its vertex buffer)

export type Style = "tear" | "mosh" | "shatter";

// Mosh is the one kept: the toggle turns it on.
export const GLITCH_SETTINGS: SettingsSchema = {
  glitch: { type: "toggle", label: "Glitch", value: false }
};

// What the statue can be, in the order the glitch can visit them.
type Any = "stone" | Kind | "chiffon";
const ALL: Any[] = ["marble", "nero", "glass", "obsidian"];

// The glitch's state, shared by every material: the one held, the one coming, two strays the corruption throws in,
// how hot the break is, how far the next has arrived, a seed that re-rolls every glitch frame, how far blocks have
// drifted, and the lens's scale (to move things by a fraction of the screen).
function glitchState() {
  return {
    cur: uniform(0),
    next: uniform(1),
    a: uniform(2),
    b: uniform(3),
    heat: uniform(0),
    progress: uniform(0),
    seed: uniform(0),
    drift: uniform(0),
    sx: uniform(1),
    sy: uniform(1)
  };
}
type State = ReturnType<typeof glitchState>;

const hash = (v: any) => fract(sin(dot(v, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;

// Which material a region shows: the corrupted ones a stray (or the next), the rest the held one until the next has
// arrived there; `order` says when it arrives (random, unless given).
function choose(u: State, key: any, order?: any) {
  const corrupt = hash(key.add(vec3(u.seed.mul(1.37), 0.17, 0.31)));
  const arrived = order ?? hash(key.mul(1.31).add(vec3(5.2, 1.3, 9.1)));
  const which = hash(key.mul(0.73).add(vec3(u.seed.mul(2.11), 7.7, 3.3)));
  const wild = which.lessThan(0.34).select(u.a, which.lessThan(0.67).select(u.b, u.next));
  const settled = arrived.lessThan(u.progress).select(u.next, u.cur);
  return corrupt.lessThan(u.heat).select(wild, settled) as any;
}

// A point's place on screen: normalised (0..1, y up) and its depth.
function onScreen(world: any) {
  const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(world, 1))) as any;
  return { uv: clip.xy.div(clip.w).mul(0.5).add(0.5), w: clip.w };
}
// The fragment's place on screen, the same way up.
const here = () => vec2(screenCoordinate.x.div(screenSize.x), float(1).sub(screenCoordinate.y.div(screenSize.y))) as any;

// A move across the screen (in fractions of it), as a move in the mesh's own space at that depth.
function shove(u: State, w: any, dx: any, dy: any) {
  const right = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz as any;
  const up = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz as any;
  const world = right.mul(dx.mul(2).mul(w).div(u.sx)).add(up.mul(dy.mul(2).mul(w).div(u.sy))) as any;
  return modelWorldMatrixInverse.mul(vec4(world, 0)).xyz as any;
}

// Tear: bands across the screen, their number re-rolled every glitch frame, the hot ones slipped sideways, and thin
// slivers between slipped further.
function tear(u: State, y: any) {
  const n = floor(hash(vec3(u.seed, 1, 2)).mul(18)).add(5) as any;
  const band = floor(y.mul(n)) as any;
  const coarse = vec3(band, n, 0) as any;
  const active = hash(coarse.add(vec3(0, 0, u.seed))).lessThan(u.heat) as any;
  const row = floor(y.mul(160)) as any;
  const sliver = hash(vec3(row, u.seed, 5)).lessThan(u.heat.mul(0.16)) as any;
  const slip = active.select(hash(coarse.add(vec3(3, u.seed, 1))).sub(0.5).mul(0.22), float(0)) as any;
  const thin = sliver.select(hash(vec3(row, u.seed, 9)).sub(0.5).mul(0.4), float(0)) as any;
  return { key: sliver.select(vec3(row, 160, 1), coarse) as any, hot: active.or(sliver) as any, shift: slip.add(thin).mul(u.heat.mul(0.5).add(0.5)) as any };
}

// Mosh: macroblocks in the 16 / 32 / 64 px of a codec (at a 900 px tall screen), the size of each chosen per big
// block; the corrupted ones carry a motion vector that grows as the burst drifts on.
function mosh(u: State, uv: any) {
  const px = uv.mul(screenSize).mul(float(900).div(screenSize.y)) as any;
  const big = floor(px.div(64)) as any;
  const level = hash(vec3(big, floor(u.seed.mul(0.25)).add(17))) as any;
  const size = level.lessThan(0.3).select(float(64), level.lessThan(0.7).select(float(32), float(16))) as any;
  const block = floor(px.div(size)) as any;
  const key = vec3(block, size) as any;
  const hot = hash(key.add(vec3(u.seed.mul(1.37), 0.17, 0.31))).lessThan(u.heat) as any;
  const dir = vec2(hash(key.add(vec3(1, 2, 3))), hash(key.add(vec3(4, 5, 6)))).sub(0.5) as any;
  // Most blocks fall together, as a mosh's frames melt downward; the rest go their own way.
  const flow = mix(dir.mul(2), vec2(0.1, -1), 0.55) as any;
  const move = flow.mul(size).mul(u.drift.mul(5).add(0.6)).div(900) as any;
  // Two in five of them move; the rest are only decoded wrong where they are.
  const drifts = hot.and(hash(key.add(vec3(8, 3, 1))).lessThan(0.4)) as any;
  return { key, hot, size, local: fract(px.div(size)) as any, move: drifts.select(move, vec2(0, 0)) as any };
}

// Shatter: cells of space round the figure, re-cut every so often.
function shatter(u: State, home: any) {
  const size = mix(0.07, 0.2, hash(vec3(floor(u.seed.mul(0.34)), 3, 1))) as any;
  const cell = floor(home.div(size).add(hash(vec3(u.seed, 8, 2)))) as any;
  const key = cell.add(vec3(0, 0, 0)) as any;
  const hot = hash(key.add(vec3(u.seed.mul(1.37), 0.17, 0.31))).lessThan(u.heat) as any;
  // The next arrives from her feet up, ragged.
  const order = home.y.sub(0.05).div(1.5).mul(0.75).add(hash(key).mul(0.25)) as any;
  return { key, hot, size, order, inCell: fract(home.div(size).add(hash(vec3(u.seed, 8, 2)))) as any };
}

// The glitch on one material (the `own`th): what moves it, which pixels it keeps, and the damage drawn on them.
// `base`, if given, is where each point stands before the glitch moves it (the breeze, wind/Wind.tsx), not where it was made.
function rig(material: THREE.Material, style: Style, u: State, own: number, base?: () => any) {
  const at = () => (base ? base() : positionGeometry) as any;
  const m = material as THREE.NodeMaterial;
  const mine = (pick: any) => abs(pick.sub(own)).lessThan(0.5);
  const home = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz as any;
  if (style === "tear") {
    m.positionNode = Fn(() => {
      const s = onScreen(home);
      const t = tear(u, s.uv.y);
      return at().add(shove(u, s.w, t.shift, float(0)));
    })() as any;
    const t = tear(u, here().y);
    m.maskNode = mine(choose(u, t.key)) as any;
    m.outputNode = Fn(() => {
      const c = output as any;
      // Fringed magenta or cyan by band, every other line dropped, as a tape's tracking loses the field.
      const tint = hash(t.key.add(vec3(11, 0, 0))).lessThan(0.5).select(vec3(1.35, 0.7, 1.25), vec3(0.65, 1.15, 1.4)) as any;
      const line = fract(screenCoordinate.y.mul(900).div(screenSize.y).div(3)).lessThan(0.5).select(float(1), float(0.45)) as any;
      return vec4(t.hot.select(c.rgb.mul(tint).mul(line).add(vec3(0.02, 0.0, 0.03)), c.rgb), c.a);
    })() as any;
  } else if (style === "mosh") {
    // Each corrupted block's content carried whole along its motion vector: the vertices move by their block's vector,
    // and the vector they moved by comes along with them, so a pixel keeps only what moved rigidly with one block (a
    // triangle torn across two blocks is dropped, not stretched), and the block it left behind is a hole.
    const s = onScreen(home);
    const move = mosh(u, vec2(s.uv.x, float(1).sub(s.uv.y))).move as any;
    m.positionNode = at().add(shove(u, s.w, move.x, move.y.negate())) as any;
    const moved = varying(move) as any;
    const uv = here();
    const b = mosh(u, vec2(uv.x, float(1).sub(uv.y)).sub(moved));
    const whole = b.move.sub(moved).length().lessThan(0.0005) as any;
    m.maskNode = mine(choose(u, b.key)).and(whole) as any;
    m.outputNode = Fn(() => {
      const c = output as any;
      // Colour crushed to a few levels, a DCT basis pattern rung across the block, the block's edge showing; some
      // blocks with their chroma turned, and one in forty decoded as the flat green or magenta of missing data.
      const crushed = floor(c.rgb.mul(6)).div(6) as any;
      const luma = dot(crushed, vec3(0.299, 0.587, 0.114)) as any;
      const chroma = crushed.sub(luma) as any;
      const twist = hash(b.key.add(vec3(2, 9, 4))) as any;
      const turned = twist.lessThan(0.1).select(chroma.zxy.mul(1.3), twist.lessThan(0.2).select(chroma.yzx.mul(1.3), chroma.mul(1.2))) as any;
      const k = floor(hash(b.key.add(vec3(7, 1, 1))).mul(4)).add(1) as any;
      const j = floor(hash(b.key.add(vec3(1, 7, 1))).mul(4)).add(1) as any;
      const ring = cos(PI.mul(k).mul(b.local.x)).mul(cos(PI.mul(j).mul(b.local.y))) as any;
      const edge = smoothstep(0.05, 0.0, min(min(b.local.x, b.local.y), min(float(1).sub(b.local.x), float(1).sub(b.local.y)))) as any;
      let rgb = vec3(luma).add(turned).add(ring.mul(luma.mul(0.18).add(0.015))).mul(float(1).sub(edge.mul(0.3))) as any;
      const lost = hash(b.key.add(vec3(u.seed, 3, 3))) as any;
      rgb = lost.lessThan(0.025).select(mix(vec3(0.0, 0.4, 0.15), vec3(0.45, 0.0, 0.4), lost.mul(40).round()).add(ring.mul(0.05)), rgb);
      return vec4(b.hot.select(max(rgb, vec3(0)), c.rgb), c.a);
    })() as any;
  } else {
    m.positionNode = Fn(() => {
      const s = shatter(u, home);
      // Snapped to a voxel grid, a third to a sixth of the cell.
      const q = s.size.div(floor(hash(s.key.add(vec3(4, 4, 4))).mul(4)).add(3)) as any;
      const snapped = floor(home.div(q).add(0.5)).mul(q).sub(home) as any;
      // Jolted out along one axis.
      const axis = hash(s.key.add(vec3(9, 1, 5))) as any;
      const along = axis.lessThan(0.33).select(vec3(1, 0, 0), axis.lessThan(0.66).select(vec3(0, 1, 0), vec3(0, 0, 1))) as any;
      const jolt = along.mul(hash(s.key.add(vec3(2, 2, 7))).sub(0.5).mul(s.size).mul(1.6)) as any;
      // And a few vertices thrown far off, dragging their triangles into spikes.
      const v = hash(positionGeometry.mul(731.7).add(vec3(u.seed.mul(0.13), 0, 0))) as any;
      const fly = vec3(hash(positionGeometry.mul(97.1)), hash(positionGeometry.mul(53.3)), hash(positionGeometry.mul(71.9))).sub(0.5).normalize() as any;
      const spike = v.lessThan(u.heat.mul(0.0003)).select(fly.mul(v.mul(1200).add(0.12)), vec3(0)) as any;
      const world = s.hot.select(snapped.add(jolt).add(spike), vec3(0)) as any;
      return at().add(modelWorldMatrixInverse.mul(vec4(world, 0)).xyz);
    })() as any;
    const s = shatter(u, varying(home));
    m.maskNode = mine(choose(u, s.key, s.order)) as any;
    m.outputNode = Fn(() => {
      const c = output as any;
      // A broken cell's faces lit along their edges, as a debug view draws the grid.
      const f = s.inCell as any;
      const near = min(min(f.x, f.y), f.z).min(float(1).sub(max(max(f.x, f.y), f.z))) as any;
      const glow = smoothstep(0.035, 0.0, near) as any;
      const tint = hash(s.key.add(vec3(6, 6, 1))).lessThan(0.5).select(vec3(0.2, 1.4, 1.6), vec3(1.6, 0.25, 1.2)) as any;
      return vec4(s.hot.select(c.rgb.mul(1.1).add(tint.mul(glow).mul(0.55)), c.rgb), c.a);
    })() as any;
  }
}

// One figure per material, every one of them under the same glitch, and the glitch's clock: a hold of 1.4–2.6 s, a
// burst of 0.9–1.7 s in which the corruption flares and the next arrives, the glitch frame re-rolled every 40–140 ms
// as a stuttering signal is, and now and then a twitch in the hold.
export function GlitchWatchers({ data, seats, keyDir, palette, style, base }: { data: FigureData; seats: Seat[]; keyDir: THREE.Vector3; palette: Palette; style: Style; base?: () => any }) {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  // The figure's meshes, shared with the statues and freed with the world (worlds/common.tsx).
  const geometry = useMemo(() => figureParts(data), [data]);
  const parts = useMemo(() => {
    const u = glitchState();
    const made = (kind: Any, over: boolean) => (kind === "stone" ? limestone() : kind === "chiffon" ? chiffon(keyDir, over) : sculpt(kind, palette));
    const looks = ALL.map((kind, i) => {
      const cloth = made(kind, true);
      const behind = kind === "chiffon" ? made(kind, false) : cloth;
      rig(cloth, style, u, i, base);
      if (behind !== cloth) rig(behind, style, u, i, base);
      const group = new THREE.Group();
      const casters: THREE.Mesh[] = [];
      for (const [x, z, yaw, hero] of seats) {
        const one = new THREE.Group();
        const f = new THREE.Mesh(hero ? geometry.near : geometry.far, cloth);
        const b = new THREE.Mesh(geometry.solid, behind);
        const h = new THREE.Mesh(geometry.hem, behind);
        h.receiveShadow = true;
        f.receiveShadow = b.receiveShadow = kind !== "chiffon";
        casters.push(f, b);
        one.add(b, f, h);
        one.position.set(x, 0, z);
        one.rotation.y = yaw;
        group.add(one);
      }
      return { cloth, behind, group, casters };
    });
    const group = new THREE.Group();
    looks.forEach((l) => group.add(l.group));
    return { u, looks, group, clock: { phase: "hold" as "hold" | "burst", until: 1.6, at: 0, length: 1, nextStep: 0, step: 0 } };
  }, [geometry, seats, keyDir, palette, style, base]);
  useDispose(...parts.looks.flatMap((l) => (l.behind !== l.cloth ? [l.cloth, l.behind] : [l.cloth])));

  // Every material compiled before it is first needed, so the first burst does not hitch.
  useEffect(() => {
    parts.looks.forEach((l) => (l.group.visible = true));
    gl.compileAsync?.(parts.group, camera, scene).catch(() => {});
  }, [gl, camera, scene, parts]);

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __glitch: parts.u });

  useFrame((state) => {
    const { u, looks, clock } = parts;
    const now = state.clock.elapsedTime;
    const P = camera.projectionMatrix.elements;
    u.sx.value = P[0];
    u.sy.value = P[5];
    const roll = (not: number[]) => {
      let k = 0;
      do k = Math.floor(Math.random() * ALL.length);
      while (not.includes(k));
      return k;
    };
    if (clock.phase === "hold" && now >= clock.until) {
      clock.phase = "burst";
      clock.at = now;
      clock.length = 0.9 + Math.random() * 0.8;
      clock.until = now + clock.length;
      u.a.value = roll([u.cur.value, u.next.value]);
      u.b.value = roll([u.cur.value, u.next.value, u.a.value]);
    } else if (clock.phase === "burst" && now >= clock.until) {
      clock.phase = "hold";
      clock.until = now + 1.4 + Math.random() * 1.2;
      u.cur.value = u.next.value;
      u.next.value = roll([u.cur.value]);
      u.progress.value = u.heat.value = u.drift.value = 0;
    }
    // A new glitch frame: a new seed, and the heat for it.
    if (now >= clock.nextStep) {
      clock.nextStep = now + 0.04 + Math.random() * 0.1;
      u.seed.value = Math.floor(Math.random() * 1000);
      if (clock.phase === "burst") {
        const t = (now - clock.at) / clock.length;
        const flare = Math.sin(Math.PI * Math.min(1, t * 1.15));
        u.heat.value = Math.min(1, flare * (0.35 + Math.random() * 0.75));
        // Arriving in jumps, not a sweep.
        u.progress.value = Math.max(u.progress.value, Math.min(1, t * t * 1.25 + Math.random() * 0.15));
        u.drift.value = t;
      } else {
        u.heat.value = Math.random() < 0.06 ? 0.08 + Math.random() * 0.15 : 0;
        u.drift.value = 0;
      }
    }
    // Only the materials that can show this frame are drawn; only the held one casts a shadow.
    const live = new Set([u.cur.value]);
    if (u.heat.value > 0 || u.progress.value > 0) [u.next.value, u.a.value, u.b.value].forEach((k) => live.add(k));
    looks.forEach((l, i) => {
      l.group.visible = live.has(i);
      l.casters.forEach((m) => (m.castShadow = i === u.cur.value));
    });
  });
  return <primitive object={parts.group} />;
}

// The statues, glitching when the setting is on.
export function useGlitch() {
  const on = useSetting<boolean>("glitch");
  const store = useSettingsStore();
  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __glitchStore: store });
  return on ? ("mosh" as Style) : null;
}
