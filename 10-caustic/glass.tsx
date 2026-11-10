"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { dot, float, Fn, If, Loop, max, min, mix, normalize, reflect, refract, select, sign, step, uniform, uniformArray, vec3 } from "three/tsl";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { sound, useBed } from "../shared/engine/sound";
import { bend, Caustics, field, stillness, stir, landing, soften, sphereRoots, spectrum, Sun, through, toLevel, useSlide, type Tracer } from "./light";
import { lightBearing } from "./compass";
import { suzanne, useSunView } from "./mesh";
import { clearMaterial } from "./set";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Pieces of coloured glass on a table in low sun, each throwing its colour of light into its own shadow.
// Drag one about and it shoves the others, which roll or slide away. Letting go just sets it down.
export type GlassKind = "marbles" | "orbs" | "blocks" | "columns" | "monkeys";

type Piece = { size: number; tint: string; tall?: number };

// size is the radius of a ball or column, or the side of a block; tall is a column's height.
const PALETTE = ["#9fd2ff", "#ffb27a", "#f4f8ff", "#8ff0c0", "#ff8fb4", "#ffe680", "#b9a4ff", "#7fe7ff", "#ffcf9e", "#ff7a7a", "#d8ffb0", "#9fb8ff", "#fff0d0", "#ffa6e8"];
const SATURATED = ["#ffb35c", "#5ca8ff", "#62f0a8", "#ff6f91", "#f6f2ff", "#c58bff", "#ffe066", "#5ef0ff", "#ff8a4c", "#9cff6b", "#ff5ca8", "#7b8cff", "#ffd6a8"];

// Colourways the panel offers. "mixed" keeps each study's own colours; the rest deal theirs out among the pieces.
export const COLOURWAYS: Record<string, string[]> = {
  mixed: ["#ffb35c", "#5ca8ff", "#62f0a8", "#ff6f91", "#c58bff", "#ffe066"],
  amber: ["#ffb347", "#ff8a3d", "#ffd27a", "#e8732c", "#ffc061", "#d9561f"],
  sea: ["#4fd1ff", "#2f8cff", "#5ef0d0", "#1fb5a8", "#8fe3ff", "#3a6bff"],
  rose: ["#ff7aa8", "#ff4f81", "#ffb3c7", "#e05cff", "#ff9a8a", "#c94fa0"],
  smoke: ["#b8b0c8", "#8c86a6", "#d6cfc4", "#6f7a8c", "#a99bb8", "#cfc8d8"],
  clear: ["#f6fbff", "#eef6ff", "#fffaf0", "#f4f0ff", "#f0fff8", "#fff6ec"]
};

const SETS: Record<GlassKind, Piece[]> = {
  // A good handful, in every colour, sizes mixed.
  marbles: Array.from({ length: 22 }, (_, i) => ({ size: 0.075 + ((i * 7) % 5) * 0.012, tint: PALETTE[(i * 5) % PALETTE.length] })),
  // Crystal balls, nearly clear, big and small.
  orbs: [0.3, 0.2, 0.15, 0.24, 0.12, 0.18, 0.26, 0.1].map((size, i) => ({ size, tint: ["#f6fbff", "#ffd9a8", "#cfe6ff", "#ffeccf", "#e3d6ff", "#d8fff0", "#fff4e0", "#ffd6e6"][i] })),
  blocks: [0.26, 0.2, 0.22, 0.17, 0.19, 0.15, 0.21, 0.16, 0.18, 0.14, 0.2, 0.17, 0.23].map((size, i) => ({ size, tint: SATURATED[i] })),
  // Short and tall glass cylinders standing on end.
  columns: [
    [0.12, 0.34],
    [0.09, 0.22],
    [0.13, 0.14],
    [0.08, 0.38],
    [0.11, 0.26],
    [0.1, 0.12],
    [0.07, 0.3],
    [0.12, 0.2],
    [0.09, 0.16]
  ].map(([size, tall], i) => ({ size, tall, tint: SATURATED[(i * 3) % SATURATED.length] })),
  // Glass Suzannes, Blender's monkey, big and small, lying as they fell.
  monkeys: [0.22, 0.09, 0.17, 0.11, 0.2, 0.08, 0.14].map((size, i) => ({ size, tint: SATURATED[(i * 4 + 1) % SATURATED.length] }))
};

// A footprint for knocking into others: a few circles, in the piece's own frame, that together cover its outline on the
// table. A long piece lying down is a row of them along its length, rather than one circle around the whole of it.
type Blob = { x: number; z: number; r: number };
function footprint(geometry: THREE.BufferGeometry, circles: number): Blob[] {
  const p = geometry.getAttribute("position");
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < p.count; i++) {
    xs.push(p.getX(i));
    zs.push(p.getZ(i));
  }
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const mz = zs.reduce((a, b) => a + b, 0) / zs.length;
  // Its long way across the table, from how the points spread.
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  xs.forEach((x, i) => {
    const dx = x - mx;
    const dz = zs[i] - mz;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
  });
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ex = Math.cos(angle);
  const ez = Math.sin(angle);
  const along = xs.map((x, i) => (x - mx) * ex + (zs[i] - mz) * ez);
  const lo = Math.min(...along);
  const span = Math.max(...along) - lo || 1;
  return Array.from({ length: circles }, (_, k) => {
    const inside = along.map((t, i) => [t, i]).filter(([t]) => Math.min(circles - 1, Math.floor(((t - lo) / span) * circles)) === k).map(([, i]) => i);
    if (!inside.length) return { x: mx, z: mz, r: 0 };
    const cx = inside.reduce((a, i) => a + xs[i], 0) / inside.length;
    const cz = inside.reduce((a, i) => a + zs[i], 0) / inside.length;
    // Most of the points, not all: a single ear tip should not push a whole circle out.
    const far = inside.map((i) => Math.hypot(xs[i] - cx, zs[i] - cz)).sort((a, b) => a - b);
    return { x: cx, z: cz, r: far[Math.floor(far.length * 0.85)] };
  });
}

// Resting poses for Suzanne, as quaternions, from dropping her on a table in Rapier with her convex hull: left side,
// right side, and on her back.
const FALLEN: [number, number, number, number][] = [
  [0.426, -0.7928, 0.3924, -0.1897],
  [0.527, 0.8125, -0.2403, 0.0664],
  [0.426, -0.7928, 0.3924, -0.1897],
  [0.527, 0.8125, -0.2403, 0.0664],
  [0.3228, -0.1816, 0.0358, -0.9282],
  [0.527, 0.8125, -0.2403, 0.0664],
  [0.426, -0.7928, 0.3924, -0.1897]
];

// How each kind sits: the height of its middle above the table, and how far it reaches for knocking into others.
const rest = (kind: GlassKind, p: Piece) => (kind === "columns" ? 0 : kind === "blocks" ? p.size / 2 : p.size);
const reach = (kind: GlassKind, p: Piece) => (kind === "blocks" ? p.size * 0.62 : kind === "monkeys" ? p.size * 1.25 : p.size);
const rolls = (kind: GlassKind) => kind === "marbles" || kind === "orbs";

const GLASS = 1.52;
// How hard the table pulls things back towards its middle.
const PULL = 1.6;

// Where a ray meets an upright cylinder through c: the nearer and farther crossings, and whether it touches at all.
function cylinderRoots(o: any, d: any, c: any, r: any) {
  const oc = o.xz.sub(c.xz) as any;
  const a = max(dot(d.xz, d.xz), 1e-6) as any;
  const b = dot(oc, d.xz) as any;
  const h = b.mul(b).sub(a.mul(dot(oc, oc).sub(r.mul(r)))) as any;
  const s = h.max(0).sqrt() as any;
  return { near: b.negate().sub(s).div(a) as any, far: b.negate().add(s).div(a) as any, hit: step(0, h) as any };
}

// The trip through a ball once a ray is in: the point and direction it leaves by, and whether it got out.
function throughBall(p: any, inside: any, c: any, r: any, n: any) {
  const leave = sphereRoots(p, inside, c, r);
  const q = p.add(inside.mul(leave.far)) as any;
  return { at: q, dir: bend(inside, normalize(c.sub(q)), n), ok: float(1) as any };
}

// `onReady` is told once the new pieces have drawn a few frames without a stall, so their shaders are built. A stall is
// a frame of over a quarter of a second, well beyond a slow machine's ordinary frame.
// `warming` builds a study out of sight, while the page first loads, so that its shaders are ready before it is ever
// chosen: its pieces are hidden, its light adds nothing, and it makes no sound and brings no sun of its own.
export function Glass({ kind, colourway = "mixed", onReady, warming = false }: { kind: GlassKind; colourway?: string; onReady?: () => void; warming?: boolean }) {
  const set = SETS[kind];
  useBed("hum", warming ? 0 : 0.05);

  const u = useMemo(() => {
    // Laid out in a sunflower spiral, so they start close together without touching.
    const gap = kind === "marbles" ? 0.13 : kind === "orbs" ? 0.34 : kind === "columns" ? 0.24 : kind === "monkeys" ? 0.42 : 0.28;
    const spots = set.map((p, i) => {
      const a = i * 2.39996 + 0.6;
      const r = gap * Math.sqrt(i + 0.6);
      return new THREE.Vector4(Math.cos(a) * r, rest(kind, p), Math.sin(a) * r, p.size);
    });
    return {
      at: uniformArray(spots, "vec4"),
      // How each block is turned, and how tall each column stands.
      shape: uniformArray(
        set.map((p, i) => new THREE.Vector4(i * 1.3 + 0.4, p.tall ?? 0, 0, 0)),
        "vec4"
      ),
      tints: uniformArray(
        set.map((p) => new THREE.Color(p.tint)),
        "color"
      ),
      velocity: set.map(() => new THREE.Vector2()),
      // Where each piece was when the light was last worked out.
      was: set.map(() => new THREE.Vector2(Infinity, Infinity)),
      held: -1,
      under: 0,
      goal: new THREE.Vector2(),
      offset: new THREE.Vector2(),
      knock: 0
    };
  }, [set, kind]);

  // Blocks throw broad flat patches, which read best soft-edged; balls focus to points, which want to stay sharp.
  useEffect(() => {
    field.centre.value.set(0, 0);
    field.size.value = 3.6;
    soften.value = kind === "blocks" ? 0.016 : kind === "monkeys" ? 0.02 : kind === "columns" ? 0.008 : 0.005;
  }, [kind]);

  const meshes = useRef<(THREE.Mesh | null)[]>([]);

  // For the monkeys, which have no formula: the sun's view of the glass, read by each ray.
  const throughMesh = useSunView(meshes, kind === "monkeys" ? set.length : 0);

  // One grid of light for each piece, held close around it, so every piece gets the full detail: in, across and out
  // of it, taking on its colour.
  const traces = useMemo<Tracer[]>(() => {
    // Each piece is found by a uniform rather than a number written into the shader, so that every piece's light
    // compiles to the same shader, once.
    const path = (o: any, d: any, spread: any, slot: any) => {
      const n = float(GLASS).add(spread) as any;
      const at = u.at.element(slot) as any;
      const centre = at.xyz as any;
      const size = at.w as any;
      const shape = u.shape.element(slot) as any;
      const turn = shape.x as any;
      let t: any;
      let normal: any;
      let out: { at: any; dir: any; ok: any };
      if (kind === "monkeys") {
        const m = throughMesh(o, d, n, centre, size.mul(1.5));
        t = m.t;
        normal = m.normal;
        out = { at: m.at, dir: m.dir, ok: m.ok };
      } else if (kind === "blocks") {
        // A box in its own frame: in by slabs, then from face to face, bouncing off any met too steeply, until out.
        const ax = vec3(turn.cos(), 0, turn.sin()) as any;
        const az = vec3(turn.sin().negate(), 0, turn.cos()) as any;
        const toLocal = (v: any) => vec3(dot(v, ax), v.y, dot(v, az));
        const toWorld = (v: any) => ax.mul(v.x).add(vec3(0, v.y, 0)).add(az.mul(v.z));
        const half = size.mul(0.5) as any;
        const ol = toLocal(o.sub(centre)) as any;
        const dl0 = toLocal(d) as any;
        const inv = vec3(1, 1, 1).div(dl0.add(sign(dl0).mul(1e-6)).add(1e-7)) as any;
        const t1 = half.negate().sub(ol).mul(inv) as any;
        const t2 = half.sub(ol).mul(inv) as any;
        const tn = min(t1, t2) as any;
        const tf = max(t1, t2) as any;
        const near = max(tn.x, max(tn.y, tn.z)) as any;
        const far = min(tf.x, min(tf.y, tf.z)) as any;
        t = near.add(step(far, near).mul(1e5)) as any;
        const nl = sign(dl0).negate().mul(step(near, tn)) as any;
        normal = normalize(toWorld(nl));
        const pl = ol.add(dl0.mul(t)).toVar() as any;
        const dl = refract(dl0, nl, float(1).div(n)).toVar() as any;
        const leaving = vec3(0, -1, 0).toVar() as any;
        const done = float(0).toVar() as any;
        Loop({ start: 0, end: 3, type: "int", name: "bounce" } as any, () => {
          If(done.lessThan(0.5), () => {
            const steps = sign(dl).mul(half).sub(pl).div(dl.add(sign(dl).mul(1e-6)).add(1e-7)) as any;
            const tExit = min(steps.x, min(steps.y, steps.z)) as any;
            const outward = sign(dl).mul((step as any)(steps, vec3(tExit, tExit, tExit))) as any;
            pl.assign(pl.add(dl.mul(tExit)));
            const bent = refract(dl, outward.negate(), n) as any;
            If(dot(bent, bent).greaterThan(0.25), () => {
              leaving.assign(bent);
              done.assign(1);
            }).Else(() => {
              dl.assign(reflect(dl, outward));
            });
          });
        });
        out = { at: centre.add(toWorld(pl)), dir: toWorld(leaving), ok: done };
      } else if (kind === "columns") {
        // In through the flat top or the curved side; then across, off any wall met too steeply, and out through the
        // side, or down through the base straight onto the table. Whatever leaves by the top is lost to the sky.
        const tall = shape.y as any;
        const top = toLevel(o, d, tall);
        const viaTop = step(top.at.xz.sub(centre.xz).length(), size).mul(top.ok) as any;
        const side = cylinderRoots(o, d, centre, size);
        const ps = o.add(d.mul(side.near)) as any;
        const viaSide = side.hit.mul(step(0, ps.y)).mul(step(ps.y, tall)).mul(step(0, side.near)) as any;
        const tTop = tall.sub(o.y).div(min(d.y, -1e-4)) as any;
        t = mix(mix(float(1e5), side.near, viaSide), tTop, viaTop) as any;
        normal = normalize(mix(vec3(ps.x.sub(centre.x), 0, ps.z.sub(centre.z)), vec3(0, 1, 0), viaTop));
        const pl = o.add(d.mul(t)).toVar() as any;
        const dl = refract(d, normal, float(1).div(n)).toVar() as any;
        const leaving = vec3(0, -1, 0).toVar() as any;
        const done = float(0).toVar() as any;
        const lost = float(0).toVar() as any;
        Loop({ start: 0, end: 3, type: "int", name: "bounce" } as any, () => {
          If(done.lessThan(0.5), () => {
            const tWall = cylinderRoots(pl, dl, centre, size).far as any;
            const tBase = select(dl.y.lessThan(0), pl.y.negate().div(dl.y), float(1e5)) as any;
            const tCap = select(dl.y.greaterThan(0), tall.sub(pl.y).div(dl.y), float(1e5)) as any;
            const tExit = min(tWall, min(tBase, tCap)) as any;
            pl.assign(pl.add(dl.mul(tExit)));
            If(tBase.lessThanEqual(tExit), () => {
              leaving.assign(dl);
              done.assign(1);
            })
              .ElseIf(tCap.lessThanEqual(tExit), () => {
                lost.assign(1);
                done.assign(1);
              })
              .Else(() => {
                const outward = normalize(vec3(pl.x.sub(centre.x), 0, pl.z.sub(centre.z))) as any;
                const bent = refract(dl, outward.negate(), n) as any;
                If(dot(bent, bent).greaterThan(0.25), () => {
                  leaving.assign(bent);
                  done.assign(1);
                }).Else(() => {
                  dl.assign(reflect(dl, outward));
                });
              });
          });
        });
        out = { at: pl, dir: leaving, ok: done.mul(lost.oneMinus()) };
      } else {
        const r = sphereRoots(o, d, centre, size);
        t = r.near.add(r.hit.oneMinus().mul(1e5)) as any;
        const p = o.add(d.mul(t)) as any;
        normal = normalize(p.sub(centre));
        out = throughBall(p, bend(d, normal, float(1).div(n)), centre, size, n);
      }
      const hit = step(t, 9e3).mul(step(0, t)) as any;
      const ground = toLevel(out.at, out.dir, 0);
      const weight = hit.mul(through(out.dir)).mul(ground.ok).mul(out.ok).mul(0.9) as any;
      return { hit: landing(ground.at, weight) };
    };
    return set.map((_, index) => {
      const slot = (uniform as any)(index, "int");
      return (o: any, d: any, spread: any) => ({ hit: Fn(() => path(o, d, spread, slot).hit)(), tint: u.tints.element(slot) });
    });
  }, [u, kind, set, throughMesh]);

  const looks = useMemo(() => {
    const materials = set.map((p) => clearMaterial({ ior: GLASS, tint: p.tint, depth: kind === "orbs" ? 2 : 0.7, thickness: p.size * 2, dispersion: 1.2 }));
    let geometries: THREE.BufferGeometry[];
    if (kind === "blocks") {
      geometries = set.map((p) => new RoundedBoxGeometry(p.size, p.size, p.size, 4, p.size * 0.06));
    } else if (kind === "monkeys") {
      const monkey = suzanne();
      // Each lies as she fell. These are where Suzannes came to rest when dropped, tumbling, onto a table in Rapier:
      // on her left side or her right, cheek and ear down, and one tipped onto the back of her head.
      geometries = set.map((p, i) => {
        const fallen = monkey.clone();
        fallen.applyQuaternion(new THREE.Quaternion(...FALLEN[i % FALLEN.length]));
        fallen.computeBoundingBox();
        fallen.translate(0, -fallen.boundingBox!.min.y - 1, 0);
        return fallen.scale(p.size, p.size, p.size);
      });
      monkey.dispose();
    } else if (kind === "columns") {
      geometries = set.map((p) => new THREE.CylinderGeometry(p.size, p.size, p.tall ?? 0.2, 72, 1).translate(0, (p.tall ?? 0.2) / 2, 0));
    } else {
      geometries = set.map((p) => new THREE.IcosahedronGeometry(p.size, 12));
    }
    // Footprints for knocking: Suzannes by their outline, everything else by its one round reach.
    const blobs: Blob[][] = set.map((p, i) => (kind === "monkeys" ? footprint(geometries[i], 4) : [{ x: 0, z: 0, r: reach(kind, p) }]));
    return { materials, geometries, blobs };
  }, [set, kind]);
  useEffect(
    () => () => {
      looks.materials.forEach((m) => m.dispose());
      looks.geometries.forEach((g) => g.dispose());
    },
    [looks]
  );

  // The colourway, laid onto glass and light alike. Both take their colour as a value, not as part of a shader, so a
  // change needs nothing rebuilt; the light is told to redraw.
  useEffect(() => {
    const colours = COLOURWAYS[colourway];
    set.forEach((p, i) => {
      const tint = colourway === "mixed" || !colours ? p.tint : colours[(i * 5 + 1) % colours.length];
      (u.tints.array[i] as THREE.Color).set(tint);
      (looks.materials[i] as THREE.MeshPhysicalNodeMaterial).attenuationColor.set(tint);
    });
    stir();
  }, [colourway, set, u, looks]);

  useSlide({
    pick: (ray) => {
      let found: { distance: number; point: THREE.Vector3; index: number } | null = null;
      (u.at.array as THREE.Vector4[]).forEach((s, index) => {
        const tall = set[index].tall ?? 0;
        const bound = kind === "columns" ? Math.max(s.w, tall / 2) * 1.1 : kind === "blocks" ? s.w * 0.8 : kind === "monkeys" ? s.w * 1.3 : s.w * 1.1;
        const point = ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(s.x, kind === "columns" ? tall / 2 : Math.max(s.y, s.w * 0.4), s.z), bound), new THREE.Vector3());
        if (point && (!found || point.distanceTo(ray.origin) < found.distance)) found = { distance: point.distanceTo(ray.origin), point, index };
      });
      // Picking also runs on hover, so it only notes which piece is under the pointer; a press picks it up.
      if (found) u.under = (found as { index: number }).index;
      return found;
    },
    height: () => (kind === "columns" ? (set[u.under].tall ?? 0.2) / 2 : Math.max(rest(kind, set[u.under]), set[u.under].size * 0.4)),
    onGrab: (point) => {
      u.held = u.under;
      const s = u.at.array[u.held] as THREE.Vector4;
      u.offset.set(s.x - point.x, s.z - point.z);
      u.goal.set(s.x, s.z);
    },
    onMove: (point) => u.goal.set(point.x + u.offset.x, point.z + u.offset.y),
    // Setting a piece down never throws it: it stops where it is.
    onRelease: () => {
      if (u.held >= 0) u.velocity[u.held].set(0, 0);
      u.held = -1;
    }
  });

  // The sun's height is the study's; where it stands around the table is the compass's, read each frame.
  const aim = useMemo(() => ({ current: { elevation: kind === "orbs" ? 36 : 30, azimuth: lightBearing.get() } }), [kind]);
  const settled = useRef(0);
  useFrame((_, delta) => {
    // A study built ahead of time waits longer, as the loader draws hidden things only once it is warming up.
    const enough = warming ? 40 : 4;
    if (settled.current < enough) {
      settled.current = delta < 0.25 ? settled.current + 1 : 0;
      if (settled.current === enough) onReady?.();
    }
    aim.current.azimuth = lightBearing.get();
    const dt = Math.min(delta, 1 / 30);
    const pieces = u.at.array as THREE.Vector4[];
    const drag = rolls(kind) ? 0.9 : 4;
    u.knock -= dt;
    for (let i = 0; i < pieces.length; i++) {
      const s = pieces[i];
      const v = u.velocity[i];
      if (i === u.held) {
        const nx = s.x + (u.goal.x - s.x) * Math.min(1, dt * 16);
        const nz = s.z + (u.goal.y - s.z) * Math.min(1, dt * 16);
        v.set((nx - s.x) / dt, (nz - s.z) / dt).clampLength(0, 3);
        s.x = nx;
        s.z = nz;
      } else {
        // No edge, only a gentle pull to the middle, as if the table were a very shallow bowl: whatever rolls off
        // slows, stops and drifts back into the pool of light.
        v.x -= s.x * PULL * dt;
        v.y -= s.z * PULL * dt;
        v.multiplyScalar(Math.exp(-dt * drag));
        s.x += v.x * dt;
        s.z += v.y * dt;
      }
    }
    // Where a circle of a footprint lies on the table: turned with its piece, about the piece's middle.
    const turned = (blob: Blob, index: number, at: THREE.Vector4) => {
      const turn = rolls(kind) ? 0 : -(u.shape.array[index] as THREE.Vector4).x;
      const c = Math.cos(turn);
      const sn = Math.sin(turn);
      return [at.x + blob.x * c + blob.z * sn, at.z - blob.x * sn + blob.z * c];
    };
    // Knocks between pieces, mass going as the cube of size. The one in hand is immovable.
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i];
        const b = pieces[j];
        // The deepest overlap between any circle of one and any of the other, each turned as its piece is turned.
        let push = 0;
        let nx = 0;
        let nz = 0;
        for (const ba of looks.blobs[i]) {
          const [ax, az] = turned(ba, i, a);
          for (const bb of looks.blobs[j]) {
            const [bx, bz] = turned(bb, j, b);
            const gap = Math.hypot(bx - ax, bz - az);
            const into = ba.r + bb.r - gap;
            if (into > push && gap > 1e-6) {
              push = into;
              nx = (bx - ax) / gap;
              nz = (bz - az) / gap;
            }
          }
        }
        if (push <= 0) continue;
        const ma = i === u.held ? 1e6 : a.w ** 3;
        const mb = j === u.held ? 1e6 : b.w ** 3;
        a.x -= nx * push * (mb / (ma + mb));
        a.z -= nz * push * (mb / (ma + mb));
        b.x += nx * push * (ma / (ma + mb));
        b.z += nz * push * (ma / (ma + mb));
        const va = u.velocity[i];
        const vb = u.velocity[j];
        const closing = (va.x - vb.x) * nx + (va.y - vb.y) * nz;
        if (closing <= 0) continue;
        const impulse = (1.8 * closing) / (1 / ma + 1 / mb);
        va.x -= (impulse / ma) * nx;
        va.y -= (impulse / ma) * nz;
        vb.x += (impulse / mb) * nx;
        vb.y += (impulse / mb) * nz;
        if (closing > 0.12 && u.knock <= 0 && !warming) {
          u.knock = 0.05;
          sound.play(kind === "blocks" || kind === "columns" || kind === "monkeys" ? "tinkle" : "click", { gain: Math.min(0.95, closing * 0.55), pitch: 1.2 + Math.random() * 0.4, size: 0.2 });
        }
      }
    }
    // The light is worked out again once any piece has moved a millimetre from where it was when the light was last
    // worked out, or is in hand; otherwise the table counts towards stillness. Pieces resting against each other are
    // pulled gently together all the time and creep a fraction of a millimetre a frame, which the light need not follow.
    if (!warming) {
      const moved = pieces.some((s, i) => Math.abs(s.x - u.was[i].x) + Math.abs(s.z - u.was[i].y) > 1e-3);
      if (moved || u.held >= 0) {
        stir();
        pieces.forEach((s, i) => u.was[i].set(s.x, s.z));
      } else stillness.frames += 1;
    }
    pieces.forEach((s, i) => {
      const mesh = meshes.current[i];
      if (!mesh) return;
      const v = u.velocity[i];
      mesh.position.set(s.x, s.y, s.z);
      const shape = u.shape.array[i] as THREE.Vector4;
      if (rolls(kind)) {
        // Roll: turn about the axis across the motion, by the distance over the radius.
        const speed = v.length();
        if (speed > 1e-4) mesh.rotateOnWorldAxis(new THREE.Vector3(v.y, 0, -v.x).normalize(), (speed * dt) / s.w);
      } else {
        // Sliding things turn a little as they are shoved.
        shape.x += (v.x * 0.4 - v.y * 0.3) * dt * 0.6;
        mesh.rotation.set(0, -shape.x, 0);
      }
    });
  });

  return (
    <>
      {warming ? null : <Sun elevation={aim.current.elevation} azimuth={aim.current.azimuth} follow={aim} colour="#ffd6a3" power={6} reach={2.4} pool={1.7} />}
      {set.map((_, i) => (
        <mesh key={i} ref={(mesh) => void (meshes.current[i] = mesh)} geometry={looks.geometries[i]} material={looks.materials[i]} castShadow visible={!warming} />
      ))}
      {set.map((piece, i) => (
        <Caustics
          key={i}
          trace={traces[i]}
          centre={(u.at.element(i) as any).xyz.add(vec3(0, (piece.tall ?? 0) / 2, 0))}
          span={kind === "columns" ? (piece.size * 2 + (piece.tall ?? 0)) * 1.1 : piece.size * (kind === "blocks" ? 1.9 : kind === "monkeys" ? 3.2 : 2.15)}
          bands={spectrum(3, 0.012)}
          detail={kind === "marbles" ? 150 : kind === "monkeys" ? 210 : 230}
          strength={kind === "monkeys" ? 3 : 1}
          quiet={warming}
          limit={kind === "blocks" ? 12 : kind === "columns" ? 40 : 60}
          fixed
        />
      ))}
    </>
  );
}
