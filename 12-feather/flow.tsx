"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { float, instancedDynamicBufferAttribute, mix, smoothstep, uv, vec3, vec4 } from "three/tsl";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { useQuality } from "../shared/engine/quality";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The air the bird flies through. Each wing is a lifting surface: a vortex bound along its bones, and behind it a wake
// laid down as it goes, a ladder of vortex rings, one for each moment of the wing's past, each as strong as the wing was
// lifting then. A steady glide leaves two trailing vortices from the tips; a wingbeat, lifting hard on the way down and
// hardly at all on the way up, leaves a chain of rings. Their field, summed by Biot–Savart, carries whatever is put in
// the air: up ahead of the wing, down behind it, curling round each tip. Near the wing itself the air runs faster over
// the top and slower underneath, and cannot pass through it. The same field can be seen two ways: the vortices
// themselves, or streamlines.

// What each wing tells the air, every frame: shoulder, elbow, wrist and tip in the world, which way is up off it and
// back along it, and its circulation.
export type Lifting = { points: THREE.Vector3[]; up: THREE.Vector3; back: THREE.Vector3; gamma: number; ready: boolean };
export const flow = {
  wings: [0, 1].map<Lifting>(() => ({ points: [0, 1, 2, 3].map(() => new THREE.Vector3()), up: new THREE.Vector3(0, 1, 0), back: new THREE.Vector3(0, 0, -1), gamma: 0, ready: false }))
};

// How fast time runs for the bird and the air round it: 1, or less for slow motion.
export const pace = { current: 1 };

export const AIR_STYLES = ["streamlines", "vortex"] as const;

// Airspeed past the bird, which faces +z, in metres a second.
const SPEED = 1.1;
const DOWNSTREAM = new THREE.Vector3(0, 0, -1);
const CORE = 0.03;
const WAKE = 18;
const WAKE_LIFE = 1.2;
const WAKE_STEP = 1 / 15;
// The wing's depth from leading to trailing edge at shoulder, elbow, wrist and tip.
const CHORD = [0.24, 0.29, 0.26, 0.05];
const AHEAD = 1.1;
const BEHIND = -1.7;
// Speed as a CFD plot colours it: slow air blue, the free stream cyan to green, fast air yellow to red.
const RAMP = ["#2a4dff", "#1fb8ff", "#2ee6a8", "#b8f03a", "#ffd23a", "#ff6a2a", "#ff2e5a"].map((c) => new THREE.Color(c));
function ramp(t: number, out: THREE.Color) {
  const x = THREE.MathUtils.clamp(t, 0, 1) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  return out.copy(RAMP[i]).lerp(RAMP[i + 1], x - i);
}

type Segment = { a: THREE.Vector3; b: THREE.Vector3; gamma: number };
type Shed = { root: THREE.Vector3; tip: THREE.Vector3; gamma: number; time: number };

// The lattice packed flat for the inner loop, seven numbers a segment: its ends, and its strength over 4π.
const PACKED = new Float32Array(7 * 512);
function induceAll(count: number, px: number, py: number, pz: number, out: THREE.Vector3) {
  let vx = 0;
  let vy = 0;
  let vz = 0;
  const c2 = CORE * CORE;
  for (let i = 0, o = 0; i < count; i++, o += 7) {
    const ax = PACKED[o];
    const ay = PACKED[o + 1];
    const az = PACKED[o + 2];
    const bx = PACKED[o + 3];
    const by = PACKED[o + 4];
    const bz = PACKED[o + 5];
    const x0 = bx - ax;
    const y0 = by - ay;
    const z0 = bz - az;
    const x1 = px - ax;
    const y1 = py - ay;
    const z1 = pz - az;
    const x2 = px - bx;
    const y2 = py - by;
    const z2 = pz - bz;
    const cx = y1 * z2 - z1 * y2;
    const cy = z1 * x2 - x1 * z2;
    const cz = x1 * y2 - y1 * x2;
    const n1 = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1) + 1e-6;
    const n2 = Math.sqrt(x2 * x2 + y2 * y2 + z2 * z2) + 1e-6;
    const l0 = x0 * x0 + y0 * y0 + z0 * z0;
    const k = (((x0 * x1 + y0 * y1 + z0 * z1) / n1 - (x0 * x2 + y0 * y2 + z0 * z2) / n2) * PACKED[o + 6]) / (cx * cx + cy * cy + cz * cz + c2 * l0 + 1e-12);
    vx += cx * k;
    vy += cy * k;
    vz += cz * k;
  }
  return out.set(vx, vy, vz);
}

// How many wake lookups a frame may spend, all particles together.
const BUDGET = 60000;

// The field: the vortex lattice for this frame, and the air's velocity anywhere in it.
function makeField() {
  const segments: Segment[] = [];
  const pool: Segment[] = [];
  let used = 0;
  let packed = 0;
  const wakes = [0, 1].map(() => [] as Shed[]);
  const centre = new THREE.Vector3(0, 0.92, 0);
  const t = { d: new THREE.Vector3(), c: new THREE.Vector3(), lead: new THREE.Vector3() };
  const add = (a: THREE.Vector3, b: THREE.Vector3, gamma: number, flip: boolean) => {
    if (Math.abs(gamma) < 1e-4) return;
    if (used === pool.length) pool.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), gamma: 0 });
    const s = pool[used++];
    s.a.copy(flip ? b : a);
    s.b.copy(flip ? a : b);
    s.gamma = gamma;
    segments.push(s);
  };
  return {
    segments,
    wakes,
    centre,
    // Lays down the wakes and builds the lattice. Rings are summed as they meet: the trailing vortices along the paths
    // of tip and shoulder carry each ring's strength, and across the wake only the change in lift between one moment
    // and the next is left, so the lattice is a third smaller than the rings it stands for.
    step(now: number, delta: number) {
      for (const [i, w] of flow.wings.entries()) {
        if (!w.ready) continue;
        const wake = wakes[i];
        for (const s of wake) {
          s.root.addScaledVector(DOWNSTREAM, SPEED * delta);
          s.tip.addScaledVector(DOWNSTREAM, SPEED * delta);
          s.root.y -= 0.12 * s.gamma * delta;
          s.tip.y -= 0.12 * s.gamma * delta;
        }
        if (wake.length && now - wake[0].time < WAKE_STEP) {
          wake[0].root.copy(w.points[0]);
          wake[0].tip.copy(w.points[3]);
          wake[0].gamma = w.gamma;
        } else wake.unshift({ root: w.points[0].clone(), tip: w.points[3].clone(), gamma: w.gamma, time: now });
        while (wake.length > WAKE || (wake.length && now - wake[wake.length - 1].time > WAKE_LIFE)) wake.pop();
      }
      const ready = flow.wings.filter((w) => w.ready);
      if (ready.length) {
        centre.set(0, 0, 0);
        for (const w of ready) centre.addScaledVector(w.points[0], 1 / ready.length);
      }
      used = 0;
      segments.length = 0;
      // For lift upward with the air going toward -z, the ring round the wing runs from tip to shoulder along the wing
      // on the +x side, and the other way on the -x side.
      for (const [index, w] of flow.wings.entries()) {
        if (!w.ready) continue;
        const flip = w.points[3].x < w.points[0].x;
        const wake = wakes[index];
        for (let b = 3; b > 0; b--) add(w.points[b], w.points[b - 1], w.gamma, flip);
        if (!wake.length) continue;
        add(w.points[0], wake[0].root, w.gamma, flip);
        add(wake[0].tip, w.points[3], w.gamma, flip);
        // Across the wake where the lift changed: the bound vortex's strength handed on, less the next ring's.
        add(wake[0].root, wake[0].tip, w.gamma - wake[0].gamma, flip);
        for (let j = 0; j < wake.length - 1; j++) {
          const [n, o] = [wake[j], wake[j + 1]];
          add(n.root, o.root, n.gamma, flip);
          add(o.tip, n.tip, n.gamma, flip);
          add(o.root, o.tip, n.gamma - o.gamma, flip);
        }
        const last = wake[wake.length - 1];
        add(last.root, last.tip, last.gamma, flip);
      }
      const n = Math.min(segments.length, 512);
      for (let i = 0; i < n; i++) {
        const sg = segments[i];
        PACKED.set([sg.a.x, sg.a.y, sg.a.z, sg.b.x, sg.b.y, sg.b.z, sg.gamma / (4 * Math.PI)], i * 7);
      }
      packed = n;
    },
    // How many frames apart each of `count` particles should ask the wake afresh, to stay within the budget.
    every(count: number) {
      return Math.max(1, Math.ceil((count * Math.max(1, packed)) / BUDGET));
    },
    // The air's velocity at p. The wake's part is the costly one, so a particle may keep it in `induced` and only ask
    // for it afresh when `fresh`; the wing's own part, close by, is worked out every time. Near a wing, p itself is
    // moved out of the wing if it has strayed in.
    velocity(p: THREE.Vector3, out: THREE.Vector3, induced?: THREE.Vector3, fresh = true) {
      if (!induced || fresh) {
        const into = induced ?? out;
        induceAll(packed, p.x, p.y, p.z, into);
        into.clampLength(0, 2.5);
      }
      if (induced) out.copy(induced);
      out.addScaledVector(DOWNSTREAM, SPEED);
      for (const w of flow.wings) {
        if (!w.ready) continue;
        for (let b = 0; b < 3; b++) {
          const a = w.points[b];
          t.d.subVectors(w.points[b + 1], a);
          const length = t.d.length() || 1;
          const s = THREE.MathUtils.clamp(t.c.subVectors(p, a).dot(t.d) / (length * length), 0, 1);
          t.lead.copy(a).addScaledVector(t.d, s);
          t.c.subVectors(p, t.lead);
          const chordwise = t.c.dot(w.back);
          const chord = THREE.MathUtils.lerp(CHORD[b], CHORD[b + 1], s);
          if (chordwise < -0.06 || chordwise > chord + 0.06) continue;
          const height = t.c.dot(w.up);
          if (Math.abs(height) > 0.25) continue;
          const within = THREE.MathUtils.smoothstep(chordwise, -0.06, 0.02) * (1 - THREE.MathUtils.smoothstep(chordwise, chord - 0.02, chord + 0.06));
          out.addScaledVector(DOWNSTREAM, SPEED * Math.sign(height) * Math.min(1.2, w.gamma * 0.9) * Math.exp(-Math.abs(height) / 0.05) * within);
          if (Math.abs(height) < 0.014 && chordwise > 0 && chordwise < chord) {
            p.addScaledVector(w.up, (height >= 0 ? 0.014 : -0.014) - height);
            out.addScaledVector(w.up, -out.dot(w.up));
          }
        }
      }
      return out;
    },
    // Whether p has left the stretch of air worth drawing.
    gone(p: THREE.Vector3) {
      return p.z < BEHIND || Math.abs(p.x - centre.x) > 2 || Math.abs(p.y - centre.y) > 1.2;
    }
  };
}
type Field = ReturnType<typeof makeField>;

function fatLines(count: number, width: number) {
  const positions = new Float32Array(count * 6);
  const colours = new Float32Array(count * 6);
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  geometry.setColors(colours);
  const material = new THREE.Line2NodeMaterial({ vertexColors: true, linewidth: width, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const lines = new LineSegments2(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = 20;
  const refresh = () => {
    ((geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute).data as THREE.InterleavedBuffer).needsUpdate = true;
    ((geometry.attributes.instanceColorStart as THREE.InterleavedBufferAttribute).data as THREE.InterleavedBuffer).needsUpdate = true;
  };
  return { positions, colours, geometry, material, lines, refresh, dispose: () => (geometry.dispose(), material.dispose()) };
}

// Camera-facing sprites, one draw for all of them: where each is, how big, its colour and how opaque. Each a bright
// bead: a white-hot centre in its own colour, with a soft rim.
function sprites(count: number) {
  const position = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const size = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
  const colour = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.NormalBlending });
  // Set again after construction: the sprite material's defaults would otherwise have them write depth.
  material.depthWrite = false;
  material.transparent = true;
  material.positionNode = instancedDynamicBufferAttribute(position, "vec3");
  material.scaleNode = instancedDynamicBufferAttribute(size, "float");
  const tint = instancedDynamicBufferAttribute(colour, "vec4") as any;
  const r = uv().sub(0.5).length().mul(2) as any;
  const alpha = smoothstep(1, 0.1, r).mul(tint.a) as any;
  material.colorNode = vec4(mix(tint.rgb, vec3(1, 1, 1), smoothstep(0.45, 0, r).mul(0.55)).mul(float(1.15)), alpha) as any;
  material.opacityNode = alpha;
  const sprite = new THREE.Sprite(material);
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.renderOrder = 21;
  const refresh = () => {
    position.needsUpdate = true;
    size.needsUpdate = true;
    colour.needsUpdate = true;
  };
  return { position, size, colour, sprite, refresh, dispose: () => material.dispose() };
}

// Somewhere to release from: across the span ahead of the bird, in rows close about the wing's plane.
function release(field: Field, random: () => number, out: THREE.Vector3) {
  const rows = [-0.22, -0.1, -0.04, 0.03, 0.08, 0.16];
  return out.set(field.centre.x + (random() * 2 - 1) * 1.25, field.centre.y + rows[Math.floor(random() * rows.length)] + (random() - 0.5) * 0.02, AHEAD);
}

export function Airflow({ on, style }: { on: boolean; style: string }) {
  const { tier } = useQuality();
  const scale = tier === "low" ? 0.45 : tier === "medium" ? 0.7 : 1;
  const shown = useRef(0);
  // The air's own clock, which runs slow in slow motion.
  const clock = useRef(0);
  const field = useMemo(() => makeField(), []);
  const random = useMemo(() => mulberry(7), []);

  const view = useMemo(() => {
    // Vortex cores: the lattice drawn as glowing filaments, and sparks set spinning round the tip vortices.
    const cores = fatLines(400, 7);
    const coreLines = fatLines(400, 2.2);
    const swirlCount = Math.round(2200 * scale);
    const swirl = sprites(swirlCount);
    const swirlers = Array.from({ length: swirlCount }, () => ({ at: new THREE.Vector3(), induced: new THREE.Vector3(), age: 99, life: 1 }));
    // Streamlines: the paths of particles from the rakes, drawn as fading streaks.
    const lineCount = Math.round(1920 * scale);
    const TRAIL = 36;
    const streaks = fatLines(lineCount * (TRAIL - 1), 1.6);
    const tracers = Array.from({ length: lineCount }, () => ({ at: new THREE.Vector3(), induced: new THREE.Vector3(), trail: Array.from({ length: TRAIL }, () => new THREE.Vector3()), speed: SPEED, fresh: true }));
    return { cores, coreLines, swirl, swirlers, streaks, tracers, TRAIL };
  }, [scale]);

  useEffect(
    () => () => {
      for (const v of [view.cores, view.coreLines, view.swirl, view.streaks]) v.dispose();
    },
    [view]
  );

  const work = useMemo(() => ({ v: new THREE.Vector3(), colour: new THREE.Color(), a: new THREE.Vector3(), frame: 0 }), []);

  useFrame((_, rawDelta) => {
    const real = Math.min(rawDelta, 1 / 30);
    const delta = real * pace.current;
    shown.current = THREE.MathUtils.clamp(shown.current + (on ? real : -real) * 1.5, 0, 1);
    clock.current += delta;
    const now = clock.current;
    field.step(now, delta);
    const visible = shown.current > 0;
    view.cores.lines.visible = visible && style === "vortex";
    view.coreLines.lines.visible = visible && style === "vortex";
    view.swirl.sprite.visible = visible && style === "vortex";
    view.streaks.lines.visible = visible && style === "streamlines";
    if (!visible) return;
    const fade = shown.current;
    const { v, colour } = work;
    const frame = (work.frame = (work.frame + 1) % 1200);

    if (style === "vortex") {
      const { cores, coreLines, swirl, swirlers } = view;
      const swirlEvery = field.every(swirlers.length);
      // The vortices as unbroken filaments: each tip's trailing vortex along the whole path the tip has taken, and the
      // bound vortex along each wing that it runs from. Dimmer where it is weaker, but never gone, so each line runs on
      // without a break, fading only at the far end of the wake. Where the lift changed sharply, the vortex shed across
      // the wake is drawn too.
      for (const l of [cores, coreLines]) {
        l.positions.fill(0);
        l.colours.fill(0);
      }
      let k = 0;
      const line = (a: THREE.Vector3, b: THREE.Vector3, strength: number, ageing = 1) => {
        if (k >= 400) return;
        const g = (0.3 + 0.7 * Math.min(1, Math.abs(strength) * 2)) * fade * ageing;
        const at = [a.x, a.y, a.z, b.x, b.y, b.z];
        cores.positions.set(at, k * 6);
        coreLines.positions.set(at, k * 6);
        const glow = g * 0.35;
        cores.colours.set([0.25 * glow, 0.6 * glow, glow, 0.25 * glow, 0.6 * glow, glow], k * 6);
        coreLines.colours.set([0.8 * g, 0.95 * g, g, 0.8 * g, 0.95 * g, g], k * 6);
        k++;
      };
      for (const [i, w] of flow.wings.entries()) {
        if (!w.ready) continue;
        const wake = field.wakes[i];
        for (let b = 0; b < 3; b++) line(w.points[b], w.points[b + 1], w.gamma);
        if (!wake.length) continue;
        line(w.points[3], wake[0].tip, w.gamma);
        for (let j = 0; j < wake.length - 1; j++) {
          // Fading out over the last third of the wake's life, so the line ends softly rather than stopping.
          const ageing = 1 - THREE.MathUtils.smoothstep(j / (wake.length - 1), 0.66, 1);
          line(wake[j].tip, wake[j + 1].tip, wake[j].gamma, ageing);
          const shed = wake[j].gamma - wake[j + 1].gamma;
          if (Math.abs(shed) > 0.12) line(wake[j].root, wake[j].tip, shed, ageing);
        }
      }
      cores.refresh();
      coreLines.refresh();
      // Sparks let go close round the tips, which the tip vortices wind into spirals as they are carried off, and all
      // along the trailing edge of each wing, where the wake leaves it and rolls up toward the tips.
      swirlers.forEach((p, i) => {
        p.age += delta;
        if (p.age > p.life || field.gone(p.at)) {
          const w = flow.wings[i % 2];
          if (!w.ready) return;
          if (i % 5 < 2) {
            const angle = random() * Math.PI * 2;
            const radius = 0.02 + random() * 0.07;
            p.at.copy(w.points[3]).addScaledVector(w.up, Math.cos(angle) * radius).add(work.a.set(Math.sin(angle) * radius * Math.sign(w.points[3].x || 1), 0, 0));
            p.at.addScaledVector(w.back, random() * 0.05);
          } else {
            // Somewhere along the span, just behind the trailing edge there.
            const along = random() * 3;
            const b = Math.min(2, Math.floor(along));
            const t = along - b;
            p.at.copy(w.points[b]).lerp(w.points[b + 1], t);
            p.at.addScaledVector(w.back, THREE.MathUtils.lerp(CHORD[b], CHORD[b + 1], t) + 0.01 + random() * 0.03);
            p.at.addScaledVector(w.up, (random() - 0.5) * 0.02);
          }
          p.age = 0;
          p.life = 0.8 + random() * 0.9;
        }
        p.at.addScaledVector(field.velocity(p.at, v, p.induced, (i + frame) % swirlEvery === 0), delta);
        const life = p.age / p.life;
        ramp(0.25 + 0.5 * life, colour);
        swirl.position.setXYZ(i, p.at.x, p.at.y, p.at.z);
        swirl.size.setX(i, 0.014);
        swirl.colour.setXYZW(i, colour.r, colour.g, colour.b, fade * Math.sin(Math.PI * Math.min(1, life)) * 0.9);
      });
      swirl.refresh();
    }

    if (style === "streamlines") {
      const { tracers, streaks, TRAIL } = view;
      const lineEvery = field.every(tracers.length);
      let o = 0;
      tracers.forEach((p, n) => {
        if (p.fresh || field.gone(p.at)) {
          release(field, random, p.at);
          if (p.fresh) p.at.z = AHEAD - random() * (AHEAD - BEHIND);
          for (const t of p.trail) t.copy(p.at);
          p.fresh = false;
        }
        field.velocity(p.at, v, p.induced, (n + frame) % lineEvery === 0);
        p.speed += (v.length() - p.speed) * Math.min(1, delta * 10);
        p.at.addScaledVector(v, delta);
        if (delta > 0) {
          for (let i = TRAIL - 1; i > 0; i--) p.trail[i].copy(p.trail[i - 1]);
          p.trail[0].copy(p.at);
        }
        const change = p.speed / SPEED - 1;
        ramp(0.36 + change * 1.1, colour);
        const enter = THREE.MathUtils.clamp((AHEAD - p.at.z) / 0.4, 0, 1) * THREE.MathUtils.clamp((p.at.z - BEHIND) / 0.5, 0, 1);
        const bright = fade * enter * (0.13 + Math.min(0.75, Math.abs(change) * 2));
        for (let i = 0; i < TRAIL - 1; i++) {
          const a = p.trail[i];
          const b = p.trail[i + 1];
          const f0 = bright * (1 - i / (TRAIL - 1));
          const f1 = bright * (1 - (i + 1) / (TRAIL - 1));
          streaks.positions.set([a.x, a.y, a.z, b.x, b.y, b.z], o);
          streaks.colours.set([colour.r * f0, colour.g * f0, colour.b * f0, colour.r * f1, colour.g * f1, colour.b * f1], o);
          o += 6;
        }
      });
      streaks.refresh();
    }
  });

  return (
    <>
      <primitive object={view.cores.lines} />
      <primitive object={view.coreLines.lines} />
      <primitive object={view.swirl.sprite} />
      <primitive object={view.streaks.lines} />
    </>
  );
}

function mulberry(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
