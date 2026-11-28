"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import * as THREE from "three/webgpu";
import { attribute, float, mix, mx_noise_float, positionGeometry, sin, smoothstep, uniform, vec3 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import type { Rock } from "./field";
import { caveShade, lamp } from "./fx";
import { shadow } from "./outside";
import { isTouch, touchActions, TOUCH_QUERY, useTouch } from "./touch";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Wooden ladders you carry and lean against a wall: up to a ledge or an opening the wall gives way to, or, with no edge
// in reach, a set length. Pick one (L), and a ghost of it follows the aim, green where it would stand and red where it
// cannot; a click leans it there. Walk into it and press on to climb; step off at the top onto the ledge. A right click
// on one takes it back. Two rails and the rungs between, instanced: three draws for every ladder there is.

export const STARTING_LADDERS = 5;
const MOST = 8;
const RUNGS = 40;
// Between the rails' centres; one rung every RUNG metres.
const WIDTH = 0.44;
const RUNG = 0.3;
// How far the foot stands out per metre of height (about 75 degrees), how far the rails stand past the lip to hold on
// to stepping off, the tallest climb, and the length against a wall that has no edge in reach.
const LEAN = 0.27;
const OVER = 0.75;
const TALLEST = 9;
const SET_HEIGHT = 3.6;
// How far off a wall may be aimed at.
const REACH = 5.5;

export type Ladder = {
  foot: THREE.Vector3;
  top: THREE.Vector3;
  // Out of the wall (level), and along it.
  out: THREE.Vector3;
  across: THREE.Vector3;
  // The height of the edge it reaches, if it reaches one: the top of the climb.
  lip: number | null;
  seed: number;
};

export type Fit = { ok: boolean; reason: string; ladder: Ladder | null };

export const ladders = {
  list: [] as Ladder[],
  left: STARTING_LADDERS,
  placing: false,
  // Where the pointer last was over the scene (the ghost follows it); none, the middle of the view.
  pointer: null as null | { x: number; y: number },
  fit: { ok: false, reason: "", ladder: null } as Fit,
  version: 0,
  // Counts placings and takings back, for the meshes.
  revision: 0,
  listeners: new Set<() => void>(),
  changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  },
  toggle() {
    this.placing = !this.placing;
    if (this.placing && this.left <= 0) {
      this.placing = false;
      notice.say(isTouch() ? "No ladders left. Press and hold one you have placed to take it back." : "No ladders left. Right click one you have placed to take it back.");
    }
    this.changed();
  },
  cancel() {
    if (!this.placing) return;
    this.placing = false;
    this.changed();
  },
  // Leans a ladder where it was fitted (the ghost's, unless given), if it can stand there.
  place(given?: Fit) {
    const fit = given ?? this.fit;
    if (!fit.ok || !fit.ladder || this.left <= 0 || this.list.length >= MOST) {
      notice.say(fit.reason || "A ladder can't stand there");
      return false;
    }
    this.list.push(fit.ladder);
    this.left--;
    this.revision++;
    this.placing = false;
    this.fit = { ok: false, reason: "", ladder: null };
    this.changed();
    return true;
  },
  remove(k: number) {
    const [ladder] = this.list.splice(k, 1);
    this.left++;
    this.revision++;
    this.changed();
    return ladder;
  },
  // The ladder a ray meets first, nearer than `far`: within a hand of its rails' plane, between its foot and top.
  at(ray: THREE.Ray, far: number) {
    let best = -1;
    let nearest = far;
    for (let k = 0; k < this.list.length; k++) {
      const l = this.list[k];
      const along = scratch.a.subVectors(l.top, l.foot);
      const length = along.length();
      along.divideScalar(length);
      const facing = scratch.b.crossVectors(l.across, along);
      // Where the ray crosses the ladder's plane.
      const den = ray.direction.dot(facing);
      if (Math.abs(den) < 1e-4) continue;
      const t = scratch.c.subVectors(l.foot, ray.origin).dot(facing) / den;
      if (t < 0 || t > nearest) continue;
      const p = scratch.c.copy(ray.origin).addScaledVector(ray.direction, t).sub(l.foot);
      const up = p.dot(along);
      const side = p.dot(l.across);
      if (up < 0 || up > length || Math.abs(side) > WIDTH * 0.5 + 0.12) continue;
      nearest = t;
      best = k;
    }
    return best;
  }
};

// A line said for a few seconds at the bottom of the view: why a strike or a ladder did nothing.
export const notice = {
  text: "",
  at: 0,
  listeners: new Set<() => void>(),
  say(text: string) {
    const now = performance.now();
    if (text === this.text && now - this.at < 2600) return;
    this.text = text;
    this.at = now;
    for (const listener of this.listeners) listener();
  }
};

const scratch = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), grad: [0, 0, 0] };

// Where a ladder's axis (between the rails) is at height h over its foot.
export function axisAt(l: Ladder, h: number, out: THREE.Vector3) {
  return out.lerpVectors(l.foot, l.top, h / (l.top.y - l.foot.y));
}

// The highest the feet go: level with the lip, or with no lip, a metre short of the top.
export function climbTop(l: Ladder) {
  return (l.lip ?? l.top.y - 1) - l.foot.y;
}

// Whether walking as the keys say takes hold of a ladder: at its foot (or partway up) facing it and pressing on, or at
// the top, stepping out over the edge onto it. Returns the ladder and the height of the feet on it.
export function grabLadder(eye: THREE.Vector3, eyeHeight: number, forward: THREE.Vector3, wish: THREE.Vector3, ahead: number) {
  const feet = eye.y - eyeHeight;
  for (const l of ladders.list) {
    const top = climbTop(l);
    const h = feet - l.foot.y;
    if (h < -0.45 || h > top + 0.5) continue;
    const at = axisAt(l, THREE.MathUtils.clamp(h, 0, top), scratch.d);
    const dx = eye.x - at.x;
    const dz = eye.z - at.z;
    const out = dx * l.out.x + dz * l.out.z;
    const side = dx * l.across.x + dz * l.across.z;
    if (Math.abs(side) > 0.5) continue;
    // From below, facing it.
    if (ahead > 0 && forward.x * -l.out.x + forward.z * -l.out.z > 0.3 && out > -0.15 && out < 0.95 && h < top - 0.2) return { ladder: l, h: Math.max(0, h) };
    // From the ledge at the top, out over the edge.
    if (l.lip !== null && Math.abs(h - top) < 0.45 && out > -1 && out < 0.5 && wish.x * l.out.x + wish.z * l.out.z > 0.3) return { ladder: l, h: top };
  }
  return null;
}

// Where a ladder would stand, aimed along a ray: against the wall it meets, its foot on the floor below, its top at the
// wall's edge (where the wall gives way to a ledge or an opening) or a set length up a wall with none in reach.
export function fitLadder(rock: Rock, o: THREE.Vector3, d: THREE.Vector3): Fit {
  const no = (reason: string): Fit => ({ ok: false, reason, ladder: null });
  const t = rock.march(o.x, o.y, o.z, d.x, d.y, d.z, REACH);
  if (t <= 0) return no("Aim at a wall within reach");
  const hit = new THREE.Vector3().copy(o).addScaledVector(d, t);
  rock.gradient(hit.x, hit.y, hit.z, scratch.grad, 0.15);
  const out = new THREE.Vector3(-scratch.grad[0], 0, -scratch.grad[2]);
  const level = Math.hypot(scratch.grad[0], scratch.grad[1], scratch.grad[2]) || 1;
  // A floor aimed at: the wall beyond it, along the look, if there is one close.
  if (out.length() / level < 0.45) {
    const flat = new THREE.Vector3(d.x, 0, d.z);
    if (flat.lengthSq() < 1e-4 || -scratch.grad[1] / level < 0.6) return no("Aim at a wall");
    flat.normalize();
    const w = rock.march(hit.x, hit.y + 0.5, hit.z, flat.x, 0, flat.z, 2.5);
    if (w <= 0) return no("Aim at a wall");
    hit.set(hit.x + flat.x * w, hit.y + 0.5, hit.z + flat.z * w);
    rock.gradient(hit.x, hit.y, hit.z, scratch.grad, 0.15);
    out.set(-scratch.grad[0], 0, -scratch.grad[2]);
    if (out.lengthSq() < 1e-6) return no("Aim at a wall");
  }
  out.normalize();
  const across = new THREE.Vector3(-out.z, 0, out.x);
  // The floor under the wall, a little out from it.
  const down = rock.march(hit.x + out.x * 0.45, hit.y, hit.z + out.z * 0.45, 0, -1, 0, 12);
  if (down < 0) return no("No floor under it");
  const base = hit.y - down;
  // Up the wall in 20 cm steps, feeling for it level from out in front: the edge is where it gives way (nothing there,
  // or it steps back a long way, into an opening).
  let wall: THREE.Vector3 | null = null;
  let wallOut = 0;
  let mostOut = -Infinity;
  let lip: number | null = null;
  let atSet: THREE.Vector3 | null = null;
  const from = 1.6;
  for (let y = base + 0.35; y <= base + TALLEST - OVER + 0.2; y += 0.2) {
    const ox = hit.x + out.x * from;
    const oz = hit.z + out.z * from;
    const w = rock.march(ox, y, oz, -out.x, 0, -out.z, 3.4);
    // How far out of the aimed point the wall stands at this height.
    const offset = from - w;
    if (wall && (w < 0 || wallOut - offset > 0.8)) {
      lip = wall.y + 0.1;
      break;
    }
    if (w < 0) return no("No wall to lean it on");
    wall = new THREE.Vector3(ox - out.x * w, y, oz - out.z * w);
    wallOut = offset;
    mostOut = Math.max(mostOut, offset);
    if (!atSet && y >= base + SET_HEIGHT) atSet = wall.clone();
  }
  if (!wall) return no("No wall to lean it on");
  if (lip !== null && lip - base < 1.1) return no("Low enough to climb without one");
  // No edge in reach: a set length, up to where the wall was felt at that height.
  const rest = lip !== null ? wall : (atSet ?? wall);
  const top = new THREE.Vector3(rest.x + out.x * 0.05, lip !== null ? lip + OVER : rest.y, rest.z + out.z * 0.05);
  const rise = top.y - base;
  // The foot stands out by the lean, and clear of the most outward bulge of the wall below the top.
  const restOut = (rest.x - hit.x) * out.x + (rest.z - hit.z) * out.z;
  const footOut = Math.max(restOut + 0.05 + rise * LEAN, mostOut + 0.25);
  const foot = new THREE.Vector3(hit.x + out.x * footOut, base + 1.2, hit.z + out.z * footOut);
  const under = rock.march(foot.x, foot.y, foot.z, 0, -1, 0, 3);
  if (under < 0) return no("No floor for its foot");
  foot.y -= under;
  if (Math.abs(foot.y - base) > 0.8) return no("The ground is too uneven");
  // Clear of rock all the way up, both rails.
  for (let k = 1; k < 9; k++) {
    const p = scratch.c.lerpVectors(foot, top, k / 9).addScaledVector(out, 0.04);
    for (const s of [-1, 1]) if (rock.sample(p.x + across.x * s * WIDTH * 0.5, p.y, p.z + across.z * s * WIDTH * 0.5) > 0.02) return no("Something's in the way");
  }
  if (ladders.left <= 0) return no("No ladders left");
  return { ok: true, reason: "", ladder: { foot, top, out, across, lip, seed: Math.random() } };
}

// A rail: a bevelled length of 45 × 70 mm timber standing from 0 to 1 along y (scaled to its length per instance).
function railGeometry() {
  const w = 0.0225;
  const h = 0.035;
  const r = 0.008;
  const s = new THREE.Shape();
  s.moveTo(-w + r, -h);
  s.lineTo(w - r, -h);
  s.absarc(w - r, -h + r, r, -Math.PI / 2, 0, false);
  s.lineTo(w, h - r);
  s.absarc(w - r, h - r, r, 0, Math.PI / 2, false);
  s.lineTo(-w + r, h);
  s.absarc(-w + r, h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-w, -h + r);
  s.absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5, false);
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false, curveSegments: 3 });
  g.rotateX(-Math.PI / 2);
  g.deleteAttribute("uv");
  return g;
}

// A rung: a round dowel along x, through both rails.
function rungGeometry() {
  const g = new THREE.CylinderGeometry(0.018, 0.018, WIDTH + 0.035, 10, 1);
  g.rotateZ(Math.PI / 2);
  g.deleteAttribute("uv");
  return g;
}

// Weathered pine: long streaks of grain along the piece, finer figure, darker blotches of handling and damp, each piece
// its own tone. `along` says which way the grain runs in the geometry; `aWood` is the piece's length and seed.
function woodMaterial(along: "x" | "y") {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  const w = attribute("aWood", "vec2") as any;
  const g = positionGeometry as any;
  const run = (along === "y" ? g.y.mul(w.x) : g.x) as any;
  const u = (along === "y" ? g.x : g.y) as any;
  const v = g.z as any;
  const s = w.y.mul(97) as any;
  const warp = mx_noise_float(vec3(u.mul(14), run.mul(0.9).add(s), v.mul(14))) as any;
  const streak = sin(u.mul(0.8).add(v).mul(240).add(warp.mul(6)).add(run.mul(2.2)))
    .mul(0.5)
    .add(0.5) as any;
  const fine = mx_noise_float(vec3(u.mul(320), run.mul(9).add(s), v.mul(320))) as any;
  const blotch = mx_noise_float(vec3(run.mul(1.6).add(s), s, 0)) as any;
  const tone = sin(s).mul(0.5).add(0.5) as any;
  const light = mix(vec3(0.5, 0.36, 0.22), vec3(0.46, 0.38, 0.3), tone) as any;
  const dark = mix(vec3(0.27, 0.17, 0.09), vec3(0.24, 0.19, 0.14), tone) as any;
  const grain = smoothstep(0.2, 0.9, streak).mul(0.75).add(fine.mul(0.12)).add(0.12) as any;
  m.colorNode = mix(dark, light, grain.clamp(0, 1)).mul(float(0.88).add(blotch.mul(0.14))) as any;
  m.roughnessNode = float(0.72).add(streak.mul(0.1)).add(blotch.mul(0.06)) as any;
  m.aoNode = caveShade();
  return m;
}

const parked = new THREE.Matrix4().makeScale(1e-4, 1e-4, 1e-4).setPosition(0, -1000, 0);
const basis = { m: new THREE.Matrix4(), along: new THREE.Vector3(), facing: new THREE.Vector3(), at: new THREE.Vector3() };

// Writes one ladder's rails and rungs from slot `rail` and `rung` on; returns the rungs written.
function writeLadder(l: Ladder, rails: THREE.InstancedMesh, rungs: THREE.InstancedMesh, rail: number, rung: number, wood?: { rails: Float32Array; rungs: Float32Array }) {
  const along = basis.along.subVectors(l.top, l.foot);
  const length = along.length();
  along.divideScalar(length);
  const facing = basis.facing.crossVectors(l.across, along);
  for (const s of [-1, 1]) {
    basis.at.copy(l.foot).addScaledVector(l.across, s * WIDTH * 0.5);
    basis.m.makeBasis(l.across, along.clone().multiplyScalar(length), facing).setPosition(basis.at);
    rails.setMatrixAt(rail, basis.m);
    wood?.rails.set([length, l.seed + s * 0.31], rail * 2);
    rail++;
  }
  let n = 0;
  for (let y = 0.28; y < length - 0.12 && n < RUNGS; y += RUNG, n++) {
    basis.at.copy(l.foot).addScaledVector(along, y);
    basis.m.makeBasis(l.across, along, facing).setPosition(basis.at);
    rungs.setMatrixAt(rung + n, basis.m);
    wood?.rungs.set([1, l.seed * 7 + n * 0.137], (rung + n) * 2);
  }
  return n;
}

export function Ladders({ rock }: { rock: Rock }) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const built = useMemo(() => {
    const railShape = railGeometry();
    const rungShape = rungGeometry();
    const railWood = new Float32Array((MOST * 2 + 1) * 2);
    const rungWood = new Float32Array((MOST * RUNGS + 1) * 2);
    const railWoodAttribute = new THREE.InstancedBufferAttribute(railWood, 2);
    const rungWoodAttribute = new THREE.InstancedBufferAttribute(rungWood, 2);
    railShape.setAttribute("aWood", railWoodAttribute);
    rungShape.setAttribute("aWood", rungWoodAttribute);
    const railMaterial = woodMaterial("y");
    const rungMaterial = woodMaterial("x");
    // Never fewer than one instance (parked far below), so every pipeline is built behind the loader.
    const make = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number, cast: boolean) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.setMatrixAt(0, parked);
      mesh.count = 1;
      mesh.frustumCulled = false;
      mesh.castShadow = cast;
      mesh.receiveShadow = cast;
      return mesh;
    };
    const rails = make(railShape, railMaterial, MOST * 2 + 1, true);
    const rungs = make(rungShape, rungMaterial, MOST * RUNGS + 1, true);
    // The ghost: the same shapes, see-through, green or red.
    const ghostColour = uniform(new THREE.Color(0.3, 1, 0.45));
    const ghostAlpha = uniform(0.4);
    const ghost = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    ghost.colorNode = ghostColour as any;
    ghost.opacityNode = ghostAlpha as any;
    const ghostRails = make(railShape, ghost, 2, false);
    const ghostRungs = make(rungShape, ghost, RUNGS, false);
    ghostRails.renderOrder = ghostRungs.renderOrder = 2;
    return { railShape, rungShape, railWood, rungWood, railWoodAttribute, rungWoodAttribute, railMaterial, rungMaterial, rails, rungs, ghost, ghostColour, ghostAlpha, ghostRails, ghostRungs };
  }, []);
  useDispose(built.railShape, built.rungShape, built.railMaterial, built.rungMaterial, built.ghost);

  // A fresh visit starts with a full set and none placed.
  useEffect(() => {
    ladders.list.length = 0;
    ladders.left = STARTING_LADDERS;
    ladders.placing = false;
    ladders.changed();
  }, []);

  // The ghost follows the mouse over the scene. On a touch screen it stands where the middle of the view points, so a
  // drag to look aims it and a tap or the Place button puts it down there.
  useEffect(() => {
    const dom = gl.domElement;
    const move = (event: PointerEvent) => {
      ladders.pointer = event.pointerType === "mouse" ? { x: event.clientX, y: event.clientY } : null;
    };
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerdown", move);
    return () => {
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerdown", move);
    };
  }, [gl]);

  // The placed ladders, written again whenever one is placed or taken back.
  useEffect(() => {
    let seen = -1;
    const write = () => {
      if (seen === ladders.revision) return;
      seen = ladders.revision;
      const { rails, rungs } = built;
      let rung = 0;
      ladders.list.forEach((l, k) => {
        rung += writeLadder(l, rails, rungs, k * 2, rung, { rails: built.railWood, rungs: built.rungWood });
      });
      const railCount = ladders.list.length * 2;
      rails.setMatrixAt(railCount, parked);
      rungs.setMatrixAt(rung, parked);
      rails.count = railCount + 1;
      rungs.count = rung + 1;
      rails.instanceMatrix.needsUpdate = rungs.instanceMatrix.needsUpdate = true;
      built.railWoodAttribute.needsUpdate = built.rungWoodAttribute.needsUpdate = true;
      shadow.redraw();
    };
    ladders.listeners.add(write);
    write();
    return () => {
      ladders.listeners.delete(write);
    };
  }, [built]);

  const aim = useMemo(() => ({ ray: new THREE.Raycaster(), pointer: new THREE.Vector2(), origin: new THREE.Vector3(Infinity, 0, 0), dir: new THREE.Vector3(), again: 0, reason: "", ok: false }), []);
  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const { ghostRails, ghostRungs } = built;
    if (!ladders.placing) {
      if (ghostRails.count !== 1 || ghostRungs.count !== 1) {
        ghostRails.setMatrixAt(0, parked);
        ghostRungs.setMatrixAt(0, parked);
        ghostRails.count = ghostRungs.count = 1;
        ghostRails.instanceMatrix.needsUpdate = ghostRungs.instanceMatrix.needsUpdate = true;
      }
      aim.origin.set(Infinity, 0, 0);
      return;
    }
    const rect = gl.domElement.getBoundingClientRect();
    const p = ladders.pointer;
    if (p) aim.pointer.set(((p.x - rect.left) / rect.width) * 2 - 1, -((p.y - rect.top) / rect.height) * 2 + 1);
    else aim.pointer.set(0, 0);
    aim.ray.setFromCamera(aim.pointer, camera);
    const { origin, direction } = aim.ray.ray;
    // Fitted again only when the aim has moved (or now and then, in case the rock has been dug since).
    aim.again -= dt;
    if (origin.distanceToSquared(aim.origin) > 1e-4 || direction.angleTo(aim.dir) > 0.002 || aim.again <= 0) {
      aim.origin.copy(origin);
      aim.dir.copy(direction);
      aim.again = 0.3;
      ladders.fit = fitLadder(rock, origin, direction);
      // (Told again when it comes to stand or stops, too: the touch Place button follows it.)
      if (ladders.fit.reason !== aim.reason || ladders.fit.ok !== aim.ok) {
        aim.reason = ladders.fit.reason;
        aim.ok = ladders.fit.ok;
        ladders.changed();
      }
      const l = ladders.fit.ladder;
      if (l) {
        const n = writeLadder(l, ghostRails, ghostRungs, 0, 0);
        ghostRails.count = 2;
        ghostRungs.count = Math.max(1, n);
      } else {
        ghostRails.setMatrixAt(0, parked);
        ghostRungs.setMatrixAt(0, parked);
        ghostRails.count = ghostRungs.count = 1;
      }
      ghostRails.instanceMatrix.needsUpdate = ghostRungs.instanceMatrix.needsUpdate = true;
    }
    if (ladders.fit.ok) built.ghostColour.value.setRGB(0.3, 1, 0.45);
    else built.ghostColour.value.setRGB(1, 0.28, 0.2);
    built.ghostAlpha.value = 0.34 + Math.sin((lamp.time.value as number) * 4) * 0.08;
  });

  return (
    <>
      <primitive object={built.rails} />
      <primitive object={built.rungs} />
      <primitive object={built.ghostRails} />
      <primitive object={built.ghostRungs} />
    </>
  );
}

// A ladder, for the HUD.
export function LadderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3v18M16 3v18M8 7h8M8 12h8M8 17h8" />
    </svg>
  );
}

const useStore = (store: { listeners: Set<() => void> }, read: () => unknown) =>
  useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    read,
    () => 0
  );

// The ladder count (a button: it picks one up, like L), what to do while placing one, and the notice line.
export function LadderHud() {
  useStore(ladders, () => ladders.version);
  useStore(notice, () => notice.at);
  const touch = useTouch();
  const placing = ladders.placing;
  const reason = ladders.fit.reason;
  return (
    <>
      <style>{`
        .burrow-ladder-count { position: fixed; right: 24px; bottom: 172px; z-index: 29; display: flex; align-items: center; gap: 7px; padding: 7px 13px 7px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.14); background: rgba(22,19,16,0.55); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #f3e7d6; font: inherit; font-size: 13px; cursor: pointer; }
        .burrow-ladder-count:hover { background: rgba(40,34,28,0.65); }
        .burrow-ladder-count b { font-weight: 600; color: #e9c89a; }
        .burrow-ladder-count kbd { font: inherit; font-size: 11px; opacity: 0.6; padding: 0 5px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.2); }
        .burrow-ladder-count.on { border-color: rgba(120,230,150,0.6); background: rgba(30,48,34,0.62); }
        .burrow-ladder-help { position: fixed; left: 50%; bottom: 26%; z-index: 30; transform: translateX(-50%); padding: 8px 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.14); background: rgba(22,19,16,0.6); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #f6ead8; font-size: 14px; white-space: nowrap; pointer-events: none; }
        .burrow-ladder-help em { font-style: normal; color: #ff9c86; margin-left: 8px; }
        .burrow-notice { position: fixed; left: 50%; bottom: 26%; z-index: 30; transform: translateX(-50%); padding: 8px 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); background: rgba(22,19,16,0.55); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #f0e2cf; font-size: 14px; white-space: nowrap; pointer-events: none; animation: burrow-notice 2.6s ease forwards; }
        @keyframes burrow-notice { 0% { opacity: 0; transform: translate(-50%, 8px); } 10% { opacity: 1; transform: translate(-50%, 0); } 78% { opacity: 1; } 100% { opacity: 0; } }
        @media (max-width: 720px) { .burrow-ladder-count { bottom: 192px; right: 16px; } .burrow-ladder-help, .burrow-notice { white-space: normal; width: max-content; max-width: calc(100vw - 32px); text-align: center; } }
        /* A touch screen: the count is one of the round buttons (backpack.tsx); the lines sit over them, clear of the
           stick and the buttons, and placing has its own Place and Cancel. */
        .burrow-ladder-touch { display: none; }
        @media ${TOUCH_QUERY} {
          .burrow-ladder-count { display: none; }
          .burrow-ladder-help, .burrow-notice { bottom: calc(var(--burrow-low) + 150px); white-space: normal; width: max-content; max-width: calc(100vw - 32px); text-align: center; }
          .burrow-ladder-help { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 18px; pointer-events: auto; }
          .burrow-ladder-help em { margin: 0; }
          .burrow-ladder-touch { display: flex; gap: 8px; }
          .burrow-ladder-touch button { min-width: 96px; min-height: 44px; padding: 0 18px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.08); color: inherit; font: inherit; font-size: 14px; font-weight: 600; touch-action: manipulation; }
          .burrow-ladder-touch button.go { border: 0; background: #f4efe4; color: #1a1612; }
          .burrow-ladder-touch button.go:disabled { opacity: 0.4; }
        }
        @media ${TOUCH_QUERY} and (orientation: landscape) and (max-height: 520px) {
          .burrow-ladder-help, .burrow-notice { bottom: calc(max(10px, env(safe-area-inset-bottom)) + 66px); max-width: calc(100vw - 340px); }
        }
      `}</style>
      <button type="button" data-burrow-panel className={`burrow-ladder-count ${placing ? "on" : ""}`} onClick={() => ladders.toggle()} aria-pressed={placing}>
        <LadderIcon />
        Ladders <b>{ladders.left}</b> <kbd>L</kbd>
      </button>
      {placing && touch ? (
        <div className="burrow-ladder-help" data-burrow-panel onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()}>
          <span>
            Look at a wall to stand the ladder there
            {reason ? <em>{reason}</em> : null}
          </span>
          <div className="burrow-ladder-touch">
            <button type="button" onClick={() => ladders.cancel()}>
              Cancel
            </button>
            <button type="button" className="go" disabled={!ladders.fit.ok} onClick={() => touchActions.placeLadder()}>
              Place
            </button>
          </div>
        </div>
      ) : placing ? (
        <div className="burrow-ladder-help">
          Aim at a wall and click to lean the ladder there · right click or Esc to cancel
          {reason ? <em>{reason}</em> : null}
        </div>
      ) : notice.text && performance.now() - notice.at < 2600 ? (
        <div key={notice.at} className="burrow-notice">
          {notice.text}
        </div>
      ) : null}
    </>
  );
}
