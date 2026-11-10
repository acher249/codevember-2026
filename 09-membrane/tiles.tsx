"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { abs, clamp, cos, cross, dot, fwidth, length, mix, smoothstep, uniform, int, mod, uniformArray, float, instancedDynamicBufferAttribute, max, normalGeometry, normalize, positionGeometry, select, sin, transformNormalToView, varying, vec2, vec3 } from "three/tsl";
import { useGrabbable } from "../shared/engine/controls";
import { useSetting, useSettingAction, useSettingRef } from "../shared/engine/settings";
import { sound } from "../shared/engine/sound";
import { hash, useView } from "./paint";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model swizzles or every operator. */

// The tile mesh is built at this size; the shape's grid sets each flake's real size, and everything is stretched to fit.
const SIZE = 0.15;
const DEPTH = 0.012;
// How long a tile takes to peel off from a ripple, and how long it floats before it is out of sight.
const PEEL = 1.6;
const FLOAT = 8;
// A wide curl, so a tile rolls round into an arc as it comes off rather than folding sharply.
// The curl's radius on average; each tile takes its own, somewhere either side of it.
const CURL = 0.06;
// Where the fold starts and ends, in the tile's own frame, from one edge to past the other.
const FOLD_START = SIZE / 2 + 0.005;
// It stops at the far edge, so the whole tile is left rolled round the curl as it floats away.
const FOLD_END = -SIZE / 2 - 0.002;
// How near the brush a flake has to be to come off, in flake sizes.
const REACH = 1;
// A peeling tile turns grey, at its own layer's brightness made this much darker if the colour is
// light, or this much lighter if it is dark. Every piece of a layer turns the same.
const SHADE_SHIFT = 0.7;
// Below this brightness (linear) a colour counts as dark.
const DARK = 0.12;
// How strongly each flake's outline is drawn: shown while the flake size is being changed, so the change can be seen.
const outlines = uniform(0);
// How far a falling leaf's middle keeps off the core: the skin's height, and about half a curled piece.
const CLEARANCE = DEPTH * 2 + 0.06;
// How long a leaf lies on the ground before it sinks away.
const LIE = 9;

// Layer colours, in turn: matte, like clay, in muted neutrals.
const CLAYS = ["#3b3a3e", "#d8cfc2", "#2d2c2f", "#b59f88", "#9b7a66", "#c4b9aa", "#6e7468", "#8b8580"];
const clays = uniformArray(
  CLAYS.map((hex) => {
    const c = new THREE.Color(hex);
    return new THREE.Vector3(c.r, c.g, c.b);
  }),
  "vec3"
);

export const FORM_OPTIONS = [
  { value: "sphere", label: "Sphere" },
  { value: "torus", label: "Torus" },
  { value: "cube", label: "Cube" },
  { value: "knot", label: "Knot" }
];

// Where one tile sits: its middle on the surface, which way is out, its own across and up, how much it is stretched to
// close the gaps where the surface needs it, and where it falls in the printed picture.
// On a curved shape, span is how much of the surface's two angles a tile covers, so it can be laid exactly on its own
// patch and meet its neighbours edge to edge; its middle's angles are worked back from where it falls in the picture.
// `under` is where the layer below sits, when it has to be drawn in a little from the top layer, as at a cube's edges.
// `extent` is a curved flake's real width and height, so that once it is off the surface it can be drawn as a plain flat
// piece of that size, which is much cheaper than laying it on its patch.
type Spot = { at: THREE.Vector3; normal: THREE.Vector3; across: THREE.Vector3; up: THREE.Vector3; scale: [number, number]; print: [number, number]; span: [number, number]; under?: { at: THREE.Vector3; scale: [number, number] }; extent?: [number, number] };
// For the knot, R is the size of the curve the tube follows and r the tube's radius.
type Surface = { kind: "flat" | "sphere" | "torus" | "knot"; R: number; r: number };

// The trefoil knot: a tube following a curve that winds three times through itself. Its point and direction at a, in
// units of its size, the same here and in the shader. The curve is never vertical, so "across" it is always defined.
const knotPoint = (a: number) => new THREE.Vector3((2 + Math.cos(3 * a)) * Math.cos(2 * a), Math.sin(3 * a), (2 + Math.cos(3 * a)) * Math.sin(2 * a));
const knotHeading = (a: number) =>
  new THREE.Vector3(-3 * Math.sin(3 * a) * Math.cos(2 * a) - 2 * (2 + Math.cos(3 * a)) * Math.sin(2 * a), 3 * Math.cos(3 * a), -3 * Math.sin(3 * a) * Math.sin(2 * a) + 2 * (2 + Math.cos(3 * a)) * Math.cos(2 * a));
// The tube's frame at a: along it, sideways, and out from the curve in the plane that holds the vertical.
function knotFrame(a: number) {
  const along = knotHeading(a).normalize();
  const side = new THREE.Vector3().crossVectors(along, new THREE.Vector3(0, 1, 0)).normalize();
  const out = new THREE.Vector3().crossVectors(side, along);
  return { along, side, out };
}
// `core` builds the solid under the skin, only when it is wanted. `distance` is how far a point is outside the object's skin, writing the way out into `out`: what falling leaves bump into.
// `near` lets a shape remember where on itself a moving point was nearest last time, and start looking from there.
type Form = { spots: Spot[]; core: () => THREE.BufferGeometry; centre: [number, number, number]; view: [number, number, number]; surface: Surface; distance: (p: THREE.Vector3, out: THREE.Vector3, near?: { index: number }) => number };
const FLAT: Surface = { kind: "flat", R: 0, r: 0 };

const spot = (at: THREE.Vector3, normal: THREE.Vector3, across: THREE.Vector3, scale: [number, number], print: [number, number], span: [number, number] = [0, 0]): Spot => ({
  at,
  span,
  normal: normal.clone().normalize(),
  across: across.clone().normalize(),
  up: new THREE.Vector3().crossVectors(normal, across).normalize(),
  scale,
  print
});

// A flat grid of tiles on one face: its middle, its outward normal, its across and up, and how far it reaches each way.
// Where a face's grid runs, across and up, from its middle: [from, to] each way. The top layer and the layer below can
// run to different edges; the grid is the top's, mapped across onto the lower one's.
type Extent = { across: [number, number]; up: [number, number] };

// A flat grid of tiles on one face: its middle, its outward normal, its across and up, and where the two layers reach.
function face(spots: Spot[], middle: THREE.Vector3, normal: THREE.Vector3, across: THREE.Vector3, up: THREE.Vector3, top: Extent, lower: Extent, printAt: [number, number], pitch: number) {
  // As many whole tiles as fit, each stretched a touch so that together they cover the face exactly.
  const columns = Math.max(1, Math.round((top.across[1] - top.across[0]) / pitch));
  const rows = Math.max(1, Math.round((top.up[1] - top.up[0]) / pitch));
  const wide = (top.across[1] - top.across[0]) / columns;
  const tall = (top.up[1] - top.up[0]) / rows;
  const fitAcross = (lower.across[1] - lower.across[0]) / (top.across[1] - top.across[0]);
  const fitUp = (lower.up[1] - lower.up[0]) / (top.up[1] - top.up[0]);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const s = top.across[0] + (i + 0.5) * wide;
      const t = top.up[0] + (j + 0.5) * tall;
      const at = middle.clone().addScaledVector(across, s).addScaledVector(up, t);
      const tile = spot(at, normal, across, [wide / SIZE, tall / SIZE], [printAt[0] + s, printAt[1] + t]);
      const ls = lower.across[0] + (s - top.across[0]) * fitAcross;
      const lt = lower.up[0] + (t - top.up[0]) * fitUp;
      tile.under = { at: middle.clone().addScaledVector(across, ls).addScaledVector(up, lt), scale: [(wide / SIZE) * fitAcross, (tall / SIZE) * fitUp] };
      spots.push(tile);
    }
}

// `pitch` is how far apart the flakes are, so how big each one is.
function buildForm(name: string, pitch: number): Form {
  const spots: Spot[] = [];
  if (name === "torus") {
    const R = 1.05;
    const r = 0.46;
    const around = Math.round((2 * Math.PI * R) / pitch);
    const tube = Math.round((2 * Math.PI * r) / pitch);
    for (let j = 0; j < tube; j++)
      for (let i = 0; i < around; i++) {
        const a = ((i + (j % 2) * 0.5) / around) * Math.PI * 2;
        const b = (j / tube) * Math.PI * 2;
        const normal = new THREE.Vector3(Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a));
        const at = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(R + r * Math.cos(b)).add(new THREE.Vector3(0, r * Math.sin(b), 0));
        const flake = spot(at, normal, new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)), [1, 1], [a * R, b * r], [(Math.PI * 2) / around, (Math.PI * 2) / tube]);
        flake.extent = [((R + r * Math.cos(b)) * Math.PI * 2) / around, (r * Math.PI * 2) / tube];
        spots.push(flake);
      }
    // three.js builds a ring standing up; this one lies flat, as its tiles do.
    const core = () => new THREE.TorusGeometry(R, r, 48, 128).rotateX(Math.PI / 2);
    const distance = (p: THREE.Vector3, out: THREE.Vector3) => {
      const flat = Math.hypot(p.x, p.z) || 0.0001;
      out.set(p.x - (p.x / flat) * R, p.y, p.z - (p.z / flat) * R);
      const d = out.length();
      out.divideScalar(d || 1);
      return d - r;
    };
    return { spots, core, centre: [0, 1.45, 0], view: [0.5, 3.4, 4.6], surface: { kind: "torus", R, r }, distance };
  }
  if (name === "knot") {
    const S = 0.43;
    const r = 0.27;
    // Tiles go along the tube by equal lengths of it, though the curve runs faster in some places than others.
    const samples = 2000;
    const lengths = [0];
    for (let i = 1; i <= samples; i++) lengths.push(lengths[i - 1] + knotPoint(((i - 1) / samples) * Math.PI * 2).distanceTo(knotPoint((i / samples) * Math.PI * 2)) * S);
    const total = lengths[samples];
    const paramAt = (length: number) => {
      let i = lengths.findIndex((l) => l >= length);
      if (i <= 0) i = 1;
      const f = (length - lengths[i - 1]) / (lengths[i] - lengths[i - 1] || 1);
      return ((i - 1 + f) / samples) * Math.PI * 2;
    };
    const along = Math.round(total / pitch);
    const round = Math.round((Math.PI * 2 * r) / pitch);
    for (let i = 0; i < along; i++) {
      const from = paramAt((i / along) * total);
      const to = i === along - 1 ? Math.PI * 2 : paramAt(((i + 1) / along) * total);
      const a = (from + to) / 2;
      const frame = knotFrame(a);
      for (let j = 0; j < round; j++) {
        const b = (j / round) * Math.PI * 2;
        const normal = frame.out.clone().multiplyScalar(Math.cos(b)).addScaledVector(frame.side, Math.sin(b));
        const at = knotPoint(a).multiplyScalar(S).addScaledVector(normal, r);
        const flake = spot(at, normal, frame.along, [1, 1], [a * 3 * S, b * r], [to - from, (Math.PI * 2) / round]);
        flake.extent = [total / along, (r * Math.PI * 2) / round];
        spots.push(flake);
      }
    }
    const curve = new THREE.CatmullRomCurve3(Array.from({ length: 400 }, (_, i) => knotPoint((i / 400) * Math.PI * 2).multiplyScalar(S)), true);
    // Nearest point on the curve, from a ring of samples: only ever asked for pieces in the air, and only near the knot.
    const samples2 = Array.from({ length: 240 }, (_, i) => knotPoint((i / 240) * Math.PI * 2).multiplyScalar(S));
    const bound = 3 * S + r + 0.3;
    const distance = (p: THREE.Vector3, out: THREE.Vector3, near?: { index: number }) => {
      if (p.length() > bound) return 1;
      const n = samples2.length;
      const at = (i: number) => samples2[(i + n) % n];
      let best = Infinity;
      let index = 0;
      // A point that has barely moved is nearest to about the same part of the curve as last time: look only around
      // there. Otherwise, coarse first, every eighth sample, then either side of the best of those.
      if (near && near.index >= 0) index = near.index;
      else
        for (let i = 0; i < n; i += 8) {
          const d = p.distanceToSquared(samples2[i]);
          if (d < best) {
            best = d;
            index = i;
          }
        }
      const spread = near && near.index >= 0 ? 4 : 8;
      let found = index;
      best = Infinity;
      for (let k = -spread; k <= spread; k++) {
        const d = p.distanceToSquared(at(index + k));
        if (d < best) {
          best = d;
          found = (index + k + n) % n;
        }
      }
      // Still at the edge of the window: it moved further than that, so look again from scratch next time.
      if (near) near.index = Math.abs(((found - index + n + n / 2) % n) - n / 2) >= spread ? -1 : found;
      const nearest = samples2[found];
      out.copy(p).sub(nearest);
      const d = out.length();
      out.divideScalar(d || 1);
      return d - r;
    };
    return { spots, core: () => new THREE.TubeGeometry(curve, 600, r, 32, true), centre: [0, 1.5, 0], view: [0.6, 3.1, 5], surface: { kind: "knot", R: S, r }, distance };
  }
  if (name === "cube") {
    const half = 0.82;
    const faces: [THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)],
      [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1)],
      [new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0)],
      [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1)],
      [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)],
      [new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0)]
    ];
    // Each edge belongs to one of its two faces, the earlier in this list. That face's tiles run out past the edge by
    // their full height above the core and close the corner; the other face's stop just under them. So the outsides meet
    // edge to edge and nothing overlaps. The layer below follows the same rule at its own height.
    const owns = (k: number, toward: THREE.Vector3) => k < faces.findIndex(([normal]) => normal.distanceTo(toward) < 0.01);
    const out = (k: number, toward: THREE.Vector3, top: boolean) => half + (owns(k, toward) ? (top ? DEPTH * 2 : DEPTH) : top ? DEPTH : 0);
    faces.forEach(([normal, across], k) => {
      const up = new THREE.Vector3().crossVectors(normal, across);
      const extent = (top: boolean): Extent => ({
        across: [-out(k, across.clone().negate(), top), out(k, across, top)],
        up: [-out(k, up.clone().negate(), top), out(k, up, top)]
      });
      face(spots, normal.clone().multiplyScalar(half), normal, across, up, extent(true), extent(false), [k * 2, 0], pitch);
    });
    const distance = (p: THREE.Vector3, out: THREE.Vector3) => {
      const qx = Math.abs(p.x) - half;
      const qy = Math.abs(p.y) - half;
      const qz = Math.abs(p.z) - half;
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
      if (outside > 0) {
        out.set(Math.sign(p.x) * Math.max(qx, 0), Math.sign(p.y) * Math.max(qy, 0), Math.sign(p.z) * Math.max(qz, 0)).divideScalar(outside);
        return outside;
      }
      // Inside: out through the nearest face.
      if (qx > qy && qx > qz) out.set(Math.sign(p.x), 0, 0);
      else if (qy > qz) out.set(0, Math.sign(p.y), 0);
      else out.set(0, 0, Math.sign(p.z));
      return Math.max(qx, qy, qz);
    };
    return { spots, core: () => new THREE.BoxGeometry(half * 2, half * 2, half * 2), centre: [0, 1.4, 0], view: [2.3, 3.3, 4.3], surface: FLAT, distance };
  }
  // Sphere: rings of tiles from pole to pole, as many round each ring as fit.
  const R = 1.12;
  const rings = Math.round((Math.PI * R) / pitch);
  for (let j = 0; j < rings; j++) {
    const theta = ((j + 0.5) / rings) * Math.PI;
    const round = Math.PI * 2 * R * Math.sin(theta);
    // Never so few round a ring that its tiles become great wedges.
    const count = Math.max(8, Math.round(round / pitch));
    for (let i = 0; i < count; i++) {
      const phi = ((i + (j % 2) * 0.5) / count) * Math.PI * 2;
      const normal = new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
      const flake = spot(normal.clone().multiplyScalar(R), normal, new THREE.Vector3(-Math.sin(phi), 0, Math.cos(phi)), [1, 1], [phi * R, theta * R], [(Math.PI * 2) / count, Math.PI / rings]);
      flake.extent = [round / count, (Math.PI * R) / rings];
      spots.push(flake);
    }
  }
  const distance = (p: THREE.Vector3, out: THREE.Vector3) => {
    const d = p.length();
    out.copy(p).divideScalar(d || 1);
    return d - R;
  };
  return { spots, core: () => new THREE.SphereGeometry(R, 96, 64), centre: [0, 1.4, 0], view: [0.5, 2.2, 4.6], surface: { kind: "sphere", R, r: 0 }, distance };
}

// A tile peeling off from one edge, the same curl as a sheet off a pad: past the fold it rolls over a cylinder and then
// goes on straight. aTile is where it falls in the picture, the way it peels and its layer; aCurl the fold and lift.
// `standoff` is how far out from the surface the tile sits, so its patch is laid at that height and still closes up.
// `turns` is each tile's rotation as a quaternion: the instance matrix moves the points, but a hand-made normal has to be
// turned to match, or every tile would be lit as if it faced the same way.
// `fades`, for the pieces that have come away, is how much of each is still there, so it can fade out rather than vanish.
function tileMaterial(tiles: THREE.InstancedBufferAttribute, curls: THREE.InstancedBufferAttribute, turns: THREE.InstancedBufferAttribute, under: boolean, surface: Surface, standoff: number, fades?: THREE.InstancedBufferAttribute) {
  // Glazed clay: a soft matte body under a thin, slightly rough glaze that catches the studio's light.
  const material = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.55, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.38, sheen: 0.2, sheenRoughness: 0.8, side: THREE.DoubleSide });
  const tile = instancedDynamicBufferAttribute(tiles, "vec4") as any;
  const curl = instancedDynamicBufferAttribute(curls, "vec4") as any;
  // On a curved shape the tile is laid exactly on its own patch of the surface, in its own frame, so it meets its
  // neighbours edge to edge. curl.zw is how much of the surface's two angles it covers.
  const flat = positionGeometry as any;
  const s = flat.x.div(SIZE) as any;
  const t = flat.y.div(SIZE) as any;
  let local = flat;
  let surfaceNormal = vec3(0, 0, 1) as any;
  // How far the tile actually reaches across and up from its middle: on a curved shape tiles vary in size.
  let reachAcross = float(SIZE / 2) as any;
  let reachUp = float(SIZE / 2) as any;
  if (surface.kind !== "flat") {
    const inFrame = (p: any, e: any, u: any, n0: any) => vec3(dot(p, e), dot(p, u), dot(p, n0));
    let e: any, u: any, n0: any, d: any, offset: any;
    if (surface.kind === "sphere") {
      const R = surface.R + standoff;
      const phi0 = tile.x.div(surface.R) as any;
      const theta0 = tile.y.div(surface.R) as any;
      // Near the poles a tile is a wedge, so it is measured across its wider end.
      const widest = max(sin(theta0.sub(curl.w.mul(0.5))), sin(theta0.add(curl.w.mul(0.5)))) as any;
      reachAcross = widest.mul(R).mul(curl.z).mul(0.54);
      reachUp = curl.w.mul(R).mul(0.54);
      const ball = (theta: any, phi: any) => vec3(sin(theta).mul(cos(phi)), cos(theta), sin(theta).mul(sin(phi)));
      n0 = ball(theta0, phi0);
      e = vec3(sin(phi0).negate(), 0, cos(phi0));
      u = cross(n0, e);
      d = ball(theta0.add(t.mul(curl.w)), phi0.add(s.mul(curl.z)));
      offset = d.sub(n0).mul(R);
    } else if (surface.kind === "knot") {
      const S = surface.R;
      const r = surface.r + standoff;
      const a0 = tile.x.div(3 * S) as any;
      const b0 = tile.y.div(surface.r) as any;
      const point = (a: any) => vec3(cos(a.mul(3)).add(2).mul(cos(a.mul(2))), sin(a.mul(3)), cos(a.mul(3)).add(2).mul(sin(a.mul(2)))).mul(S);
      const heading = (a: any) =>
        vec3(
          sin(a.mul(3)).mul(cos(a.mul(2))).mul(-3).sub(cos(a.mul(3)).add(2).mul(sin(a.mul(2))).mul(2)),
          cos(a.mul(3)).mul(3),
          sin(a.mul(3)).mul(sin(a.mul(2))).mul(-3).add(cos(a.mul(3)).add(2).mul(cos(a.mul(2))).mul(2))
        );
      const frame = (a: any) => {
        const forward = normalize(heading(a)) as any;
        const sideways = normalize(cross(forward, vec3(0, 1, 0))) as any;
        return { forward, sideways, outward: cross(sideways, forward) };
      };
      const outOf = (f: any, b: any) => f.outward.mul(cos(b)).add(f.sideways.mul(sin(b)));
      const f0 = frame(a0);
      // The outside of each bend is stretched, so the reach is allowed some extra there.
      reachAcross = length(heading(a0)).mul(S).mul(curl.z).mul(0.5 * 1.45);
      reachUp = curl.w.mul(r).mul(0.54);
      n0 = outOf(f0, b0);
      e = f0.forward;
      u = cross(n0, e);
      const a = a0.add(s.mul(curl.z)) as any;
      const b = b0.sub(t.mul(curl.w)) as any;
      const fa = frame(a);
      d = outOf(fa, b);
      offset = point(a).add(d.mul(r)).sub(point(a0).add(n0.mul(r)));
    } else {
      const r = surface.r + standoff;
      const a0 = tile.x.div(surface.R) as any;
      const b0 = tile.y.div(surface.r) as any;
      const widest = max(cos(b0.sub(curl.w.mul(0.5))), cos(b0.add(curl.w.mul(0.5)))) as any;
      reachAcross = widest.mul(r).add(surface.R).mul(curl.z).mul(0.54);
      reachUp = curl.w.mul(r).mul(0.54);
      const ring = (a: any, b: any) => vec3(cos(a).mul(cos(b).mul(r).add(surface.R)), sin(b).mul(r), sin(a).mul(cos(b).mul(r).add(surface.R)));
      const out = (a: any, b: any) => vec3(cos(b).mul(cos(a)), sin(b), cos(b).mul(sin(a)));
      n0 = out(a0, b0);
      e = vec3(sin(a0).negate(), 0, cos(a0));
      u = cross(n0, e);
      const a = a0.add(s.mul(curl.z)) as any;
      const b = b0.sub(t.mul(curl.w)) as any;
      d = out(a, b);
      offset = ring(a, b).sub(ring(a0, b0));
    }
    surfaceNormal = inFrame(d, e, u, n0);
    local = inFrame(offset, e, u, n0).add(surfaceNormal.mul(flat.z));
  }
  const axis = vec2(cos(tile.z), sin(tile.z)) as any;
  const side = vec2(axis.y.negate(), axis.x) as any;
  const along = dot(local.xy, axis) as any;
  const across = dot(local.xy, side) as any;
  // The fold is given for a tile of the standard size, and stretched to this one's real reach along the way it peels,
  // so that at rest none of it is lifted and a finished peel takes all of it.
  const stretch = (abs(axis.x).mul(reachAcross).add(abs(axis.y).mul(reachUp)) as any).div(SIZE / 2) as any;
  const fold = (under ? float(FOLD_START) : (curl.x as any)).mul(stretch) as any;
  const lift = curl.y as any;
  const a = along.sub(fold) as any;
  // Each tile, each time it peels, rolls round a curl of its own: some tight, some loose.
  const luck = hash(tile.x.mul(7.31).add(tile.y.mul(13.17)).add(tile.w.mul(1.73))) as any;
  // Its radius goes with the flake's size, so small flakes curl as tightly, for their size, as big ones.
  const radius = luck.mul(1.25).add(0.45).mul(CURL).mul(stretch) as any;
  const theta = clamp(a.div(radius), 0, lift) as any;
  const straight = max(a.sub(lift.mul(radius)), 0) as any;
  const lifted = a.greaterThan(0);
  const curledAlong = select(lifted, fold.add(sin(theta).mul(radius)).add(straight.mul(cos(lift))), along) as any;
  const curledUp = select(lifted, radius.mul(float(1).sub(cos(theta))).add(straight.mul(sin(lift))), float(0)) as any;
  // Thickness stands off the bent surface along its own normal.
  const normal2 = vec2(sin(theta).negate(), cos(theta)) as any;
  const at = curledAlong.add(normal2.x.mul(local.z)) as any;
  const up = curledUp.add(normal2.y.mul(local.z)) as any;
  material.positionNode = vec3(axis.mul(at).add(side.mul(across)), up);
  // The box's own normal, its faces following the surface, then turned with the curl.
  const box = normalGeometry as any;
  const n = select(box.z.greaterThan(0.5), surfaceNormal, select(box.z.lessThan(-0.5), surfaceNormal.negate(), box)) as any;
  const na = dot(n.xy, axis) as any;
  const turned = vec3(axis.mul(na.mul(cos(theta)).sub(n.z.mul(sin(theta)))).add(side.mul(dot(n.xy, side))), na.mul(sin(theta)).add(n.z.mul(cos(theta)))) as any;
  const q = instancedDynamicBufferAttribute(turns, "vec4") as any;
  const twice = cross(q.xyz, turned).mul(2) as any;
  const objectNormal = turned.add(twice.mul(q.w)).add(cross(q.xyz, twice)) as any;
  material.normalNode = normalize(varying(transformNormalToView(objectNormal)));
  // The glaze has its own normal, which otherwise would follow the raw mesh and show every tile.
  material.clearcoatNormalNode = material.normalNode;

  const facing = varying(box.z) as any;
  const layerV = varying(under ? tile.w.add(1) : tile.w) as any;
  // One plain colour per layer, each tile a shade either way of it, as clay would be. The underside and cut edges are darker.
  const clay = clays.element(int(mod(layerV.add(800), CLAYS.length))) as any;
  const shade = (varying(luck) as any).sub(0.5).mul(0.03).add(1) as any;
  // A tile turns as it lifts, by how far over it has rolled. The layer underneath stays as it is.
  const turning = under ? float(0) : (smoothstep(0.4, 2.2, lift) as any);
  const brightness = dot(clay, vec3(0.2126, 0.7152, 0.0722)) as any;
  // Always a grey: the layer's own brightness, pushed darker or lighter.
  const grey = select(brightness.greaterThan(DARK), brightness.mul(1 - SHADE_SHIFT), mix(brightness, float(1), SHADE_SHIFT)) as any;
  const accent = vec3(grey, grey, grey) as any;
  const body = mix(clay, accent, varying(turning)).mul(shade).mul(select(facing.greaterThan(0.5), float(1), select(facing.lessThan(-0.5), float(0.8), float(0.68)))) as any;
  if (under) material.colorNode = body;
  else {
    // A fine pale line round each flake's edge, a pixel or so wide whatever the distance.
    const square = varying(vec2(s, t)) as any;
    const edge = float(0.5).sub(max(abs(square.x), abs(square.y))) as any;
    const line = float(1).sub(smoothstep(0, fwidth(edge).mul(1.6), edge)).mul(outlines).mul(select(facing.greaterThan(0.5), float(1), float(0))) as any;
    // Lit from within, bright enough for the bloom to catch, so the preview glows over the clay.
    const ink = vec3(1, 0.86, 0.66) as any;
    material.colorNode = mix(body, ink, line);
    material.emissiveNode = ink.mul(line).mul(3.2);
  }
  if (fades) {
    material.transparent = true;
    material.opacityNode = varying(instancedDynamicBufferAttribute(fades, "float")) as any;
  }
  return material;
}

// `clear` is how far it was from the object when last checked, less how far it has moved since: while that stays above
// nothing, it cannot have reached the object, so the check is skipped.
type Loose = { position: THREE.Vector3; velocity: THREE.Vector3; turn: THREE.Quaternion; rest: THREE.Quaternion | null; spin: THREE.Vector3; scale: THREE.Vector3; span: [number, number]; roll: number; age: number; landed: number; clear: number; near: { index: number } };

// Clay tiles over a whole object, a layer under every tile, meeting so closely they read as one skin. Swipe across it and the tiles peel off in your wake, as
// fast as you swipe; click it and a slow ripple of peeling runs out from where you touched. Each one floats off on the
// air and is gone, and the next layer down is waiting.
export function Tiles() {
  const formName = useSetting<string>("form");
  const pitch = useSetting<number>("flakeSize");
  // The outlines fade in as soon as the slider moves and quickly out again once it stops.
  const changedAt = useRef(-Infinity);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else changedAt.current = performance.now();
  }, [pitch]);
  useFrame((_, delta) => {
    const showing = performance.now() - changedAt.current < 300 ? 1 : 0;
    outlines.value += (showing - outlines.value) * (1 - Math.exp(-Math.min(delta, 0.05) * (showing ? 12 : 9)));
  });
  // A new shape is a fresh set; a new flake size is not, so that dragging the slider is smooth.
  return <Covered key={formName} formName={formName} pitch={pitch} />;
}

// The smallest flake the slider allows: buffers are made big enough for it once, and never rebuilt.
const SMALLEST = 0.05;
const SIZES = Array.from({ length: Math.round((0.5 - SMALLEST) / 0.01) + 1 }, (_, i) => Math.round((SMALLEST + i * 0.01) * 100) / 100);

type Layout = Form & { base: THREE.Quaternion[] };
const layouts = new Map<string, Layout>();
// Where every flake goes for a shape at a size, worked out once and kept.
function layoutFor(name: string, pitch: number): Layout {
  const key = `${name}:${pitch.toFixed(2)}`;
  let layout = layouts.get(key);
  if (!layout) {
    const form = buildForm(name, pitch);
    layout = { ...form, base: form.spots.map((s) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(s.across, s.up, s.normal))) };
    layouts.set(key, layout);
  }
  return layout;
}

// A tile mesh fine enough for flakes of this size: big flakes bend more across themselves, so they need more of it.
// Each one is made once and kept: the GPU may still be drawing with one for a frame after it is swapped out, so none is
// thrown away until the shape itself is.
function tileGeometry(pitch: number, curved: boolean, part: "top" | "under" | "loose", made: Map<string, THREE.BufferGeometry>) {
  const k = pitch / SIZE;
  const fine = (n: number, least: number, most: number) => THREE.MathUtils.clamp(Math.round(n * k), least, most);
  const [across, up] =
    part === "top" ? (curved ? [fine(16, 2, 40), fine(8, 1, 20)] : [fine(6, 2, 16), fine(6, 2, 16)]) : part === "under" ? (curved ? [fine(8, 1, 24), fine(4, 1, 12)] : [1, 1]) : [fine(6, 2, 12), fine(6, 2, 12)];
  const key = `${across}x${up}`;
  let geometry = made.get(key);
  if (!geometry) {
    geometry = new THREE.BoxGeometry(SIZE, SIZE, DEPTH, across, up, 1);
    made.set(key, geometry);
  }
  return geometry;
}

function Covered({ formName, pitch }: { formName: string; pitch: number }) {
  // Everything that does not change with the flake size: big enough for the smallest flakes, built and compiled once.
  const capacity = useMemo(() => layoutFor(formName, SMALLEST).spots.length, [formName]);
  const shape = useMemo(() => layoutFor(formName, 0.15), [formName]);
  useView(shape.view, shape.centre);
  const auto = useSettingRef<boolean>("auto");
  const peelSound = useSettingRef<string>("peelSound");
  // Where the floor is, in the object's own space, for leaves to land on.
  const floor = -shape.centre[1] + DEPTH;
  const data = useMemo(() => {
    const buffer = () => new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    return {
      tiles: buffer(),
      curls: buffer(),
      turns: buffer(),
      start: new Float32Array(capacity).fill(-1),
      axis: new Float32Array(capacity),
      layer: new Float32Array(capacity),
      // How long each tile's peel takes, and how hard it is sent off: slow from a ripple, as fast as the swipe from a brush.
      duration: new Float32Array(capacity).fill(PEEL),
      kick: new Float32Array(capacity).fill(1),
      // Whether each tile's peel has been heard yet.
      heard: new Uint8Array(capacity),
      // How far over each tile rolls, chosen afresh for every peel.
      roll: new Float32Array(capacity).fill(3.1),
      // Pieces in the air are kept apart from the tiles they came off, so a tile can peel again straight away. They are
      // kept packed at the front, so only those still in the air are drawn.
      floaters: buffer(),
      floaterTurns: buffer(),
      floaterCurls: buffer(),
      floaterFades: new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1).setUsage(THREE.DynamicDrawUsage),
      loose: [] as Loose[]
    };
  }, [capacity]);
  const group = useMemo(() => new THREE.Group(), []);
  const made = useMemo(() => new Map<string, THREE.BufferGeometry>(), []);
  const meshes = useMemo(() => {
    const curved = shape.surface.kind !== "flat";
    const top = new THREE.InstancedMesh(tileGeometry(0.15, curved, "top", made), tileMaterial(data.tiles, data.curls, data.turns, false, shape.surface, DEPTH * 1.5), capacity);
    const under = new THREE.InstancedMesh(tileGeometry(0.15, curved, "under", made), tileMaterial(data.tiles, data.curls, data.turns, true, shape.surface, DEPTH / 2), capacity);
    const floating = new THREE.InstancedMesh(tileGeometry(0.15, curved, "loose", made), tileMaterial(data.floaters, data.floaterCurls, data.floaterTurns, false, FLAT, DEPTH * 1.5, data.floaterFades), capacity);
    for (const mesh of [top, under, floating]) {
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    top.castShadow = true;
    floating.castShadow = true;
    // Nothing is drawn until the first skin is laid.
    top.count = under.count = floating.count = 0;
    const core = new THREE.Mesh(shape.core(), new THREE.MeshStandardMaterial({ color: "#1d1b22", roughness: 0.6 }));
    core.castShadow = true;
    core.receiveShadow = true;
    return { top, under, floating, core };
  }, [data, capacity, shape, made]);
  useEffect(() => {
    group.position.set(...shape.centre);
    group.add(meshes.core, meshes.under, meshes.top, meshes.floating);
    group.updateMatrixWorld(true);
    return () => {
      group.remove(meshes.core, meshes.under, meshes.top, meshes.floating);
      for (const mesh of [meshes.top, meshes.under, meshes.floating, meshes.core]) (mesh.material as THREE.Material).dispose();
      meshes.core.geometry.dispose();
      made.forEach((geometry) => geometry.dispose());
      made.clear();
    };
  }, [group, meshes, shape, made]);

  // The flakes at this size. Changing it lays a fresh skin in place: the same buffers, rewritten, and no shader rebuilt.
  const layout = layoutFor(formName, pitch);
  const count = layout.spots.length;
  const lay = (all: Layout) => {
    const m = new THREE.Matrix4();
    const at = new THREE.Vector3();
    const size = new THREE.Vector3();
    all.spots.forEach((s, i) => {
      const q = all.base[i];
      data.turns.setXYZW(i, q.x, q.y, q.z, q.w);
      data.tiles.setXYZW(i, s.print[0], s.print[1], 0, data.layer[i]);
      data.curls.setXYZW(i, FOLD_START, 0.3, s.span[0], s.span[1]);
      size.set(s.scale[0], s.scale[1], 1);
      meshes.top.setMatrixAt(i, m.compose(at.copy(s.at).addScaledVector(s.normal, DEPTH * 1.5), q, size));
      const lower = s.under ?? s;
      meshes.under.setMatrixAt(i, m.compose(at.copy(lower.at).addScaledVector(s.normal, DEPTH / 2), q, size.set(lower.scale[0], lower.scale[1], 1)));
    });
    meshes.top.count = meshes.under.count = all.spots.length;
    for (const attribute of [data.turns, data.tiles, data.curls, meshes.top.instanceMatrix, meshes.under.instanceMatrix]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, all.spots.length * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  };
  useEffect(() => {
    data.start.fill(-1);
    data.layer.fill(0);
    lay(layout);
    // Finer tiles for bigger flakes, coarser for small: swapping the mesh keeps the same shader.
    const curved = shape.surface.kind !== "flat";
    for (const [mesh, part] of [
      [meshes.top, "top"],
      [meshes.under, "under"],
      [meshes.floating, "loose"]
    ] as const) {
      mesh.geometry = tileGeometry(pitch, curved, part, made);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lay only writes into what these name.
  }, [layout, meshes, data, pitch, shape, made]);
  // Every other size for this shape is worked out while nothing else is happening, so the slider never waits on one.
  useEffect(() => {
    let cancelled = false;
    const queue = [...SIZES];
    const next = () => {
      if (cancelled || queue.length === 0) return;
      layoutFor(formName, queue.shift()!);
      setTimeout(next, 30);
    };
    const wait = setTimeout(next, 800);
    return () => {
      cancelled = true;
      clearTimeout(wait);
    };
  }, [formName]);

  const state = useRef({ time: 0, idle: 0, last: new THREE.Vector3(), lastTime: 0, moved: 0, ticks: 0 });
  const peel = (i: number, at: number, axis: number, duration = PEEL, kick = 1) => {
    if (data.start[i] >= 0) return;
    data.start[i] = at;
    data.axis[i] = axis + (Math.random() - 0.5) * 0.8;
    data.roll[i] = 2 + Math.random() * 2;
    data.duration[i] = duration;
    data.heard[i] = 0;
    data.kick[i] = kick;
  };
  // The way a direction in the object's space lies across a tile, as an angle in the tile's own frame.
  const angleOn = (i: number, direction: THREE.Vector3) => {
    const s = layout.spots[i];
    return Math.atan2(direction.dot(s.up), direction.dot(s.across));
  };
  const offset = useMemo(() => new THREE.Vector3(), []);
  const wave = (from: THREE.Vector3) => {
    const now = state.current.time;
    for (let i = 0; i < count; i++) {
      offset.copy(layout.spots[i].at).sub(from);
      // Each lifts from the edge facing away from the touch, and folds back towards it.
      peel(i, now + offset.length() * 1.4, angleOn(i, offset));
    }
    sound.play("whoosh", { gain: 0.12, pitch: 1.3 });
  };
  const brush = (from: THREE.Vector3, to: THREE.Vector3, seconds: number) => {
    const along = to.clone().sub(from);
    const length = along.length();
    // The faster the swipe, the faster they come off and the harder they fly.
    const speed = length / Math.max(seconds, 0.008);
    const duration = THREE.MathUtils.clamp(1 / Math.max(speed, 0.05), 0.5, 1.6);
    const kick = THREE.MathUtils.clamp(speed * 0.3, 0.6, 1.8);
    const back = along.clone().negate();
    const reach = REACH * Math.max(0.12, pitch);
    for (let i = 0; i < count; i++) {
      const at = layout.spots[i].at;
      const t = length > 0 ? THREE.MathUtils.clamp(offset.copy(at).sub(from).dot(along) / (length * length), 0, 1) : 0;
      if (offset.copy(from).addScaledVector(along, t).distanceTo(at) < reach) peel(i, state.current.time, angleOn(i, back), duration, kick);
    }
  };
  useSettingAction("peel", () => wave(layout.spots[Math.floor(Math.random() * count)].at));
  // Reset clears the air of every floating piece, calls off any peel still to come, and lays the first skin back on.
  useSettingAction("reset", () => {
    data.loose.length = 0;
    meshes.floating.count = 0;
    data.start.fill(-1);
    data.layer.fill(0);
    lay(layout);
  });

  const camera = useThree((three) => three.camera);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const toLocal = (point: THREE.Vector3) => group.worldToLocal(point.clone());
  // Where a point under the pointer falls on the object itself, if it does.
  const onSurface = (point: THREE.Vector3) => {
    raycaster.ray.origin.copy(camera.position);
    raycaster.ray.direction.copy(point).sub(camera.position).normalize();
    const hit = raycaster.intersectObject(meshes.core, false)[0];
    return hit ? toLocal(hit.point) : null;
  };
  useGrabbable({
    pick: (ray) => {
      raycaster.ray.copy(ray as THREE.Ray);
      const hit = raycaster.intersectObject(meshes.core, false)[0];
      return hit ? { distance: hit.distance, point: hit.point.clone() } : null;
    },
    grab: (point) => {
      const st = state.current;
      st.last.copy(toLocal(point));
      st.lastTime = st.time;
      st.moved = 0;
      st.idle = 0;
    },
    drag: (point) => {
      const st = state.current;
      // The drag point is on a plane facing the camera; what counts is where that falls on the object.
      const local = onSurface(point);
      if (!local || local.distanceTo(st.last) < 0.01) return;
      brush(st.last, local, st.time - st.lastTime);
      st.moved += local.distanceTo(st.last);
      st.last.copy(local);
      st.lastTime = st.time;
      st.idle = 0;
    },
    release: () => {
      const st = state.current;
      if (st.moved < 0.04) wave(st.last.clone());
    }
  });

  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const place = useMemo(() => new THREE.Vector3(), []);
  const step = useMemo(() => new THREE.Quaternion(), []);
  const spinAxis = useMemo(() => new THREE.Vector3(), []);
  const away = useMemo(() => new THREE.Vector3(), []);
  // Send only the rows from..to of each buffer to the GPU, not the whole buffer, which is sized for the smallest flakes.
  const send = (attributes: THREE.BufferAttribute[], from: number, to: number) => {
    for (const attribute of attributes) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(from * attribute.itemSize, (to - from) * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  };
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    const st = state.current;
    st.time += delta;
    st.idle += delta;
    if (auto.current && st.idle > 3.5) {
      st.idle = 0;
      wave(layout.spots[Math.floor(Math.random() * count)].at);
    }
    let began = 0;
    let changed = false;
    // The span of tiles touched this frame, so only that much goes up to the GPU.
    let lowest = count;
    let highest = -1;
    // Only tiles that are peeling change; the rest lie still and are left alone.
    for (let i = 0; i < count; i++) {
      const start = data.start[i];
      if (start < 0 || st.time < start) continue;
      const s = layout.spots[i];
      changed = true;
      if (i < lowest) lowest = i;
      highest = i;
      // Heard halfway through, as it comes up off the surface, not when it starts: it eases in, and before then there is
      // little to see.
      if (!data.heard[i] && st.time >= start + data.duration[i] * 0.5) {
        data.heard[i] = 1;
        began++;
      }
      const k = Math.min(1, (st.time - start) / data.duration[i]);
      const eased = k * k * (3 - 2 * k);
      let fold = FOLD_START + (FOLD_END - FOLD_START) * eased;
      let lift = 0.3 + eased * (data.roll[i] - 0.3);
      if (k >= 1) {
        // Off: carried on outwards, the way it was peeled, harder for a fast swipe.
        data.start[i] = -1;
        if (data.loose.length < capacity) {
          away.copy(s.across).multiplyScalar(Math.cos(data.axis[i])).addScaledVector(s.up, Math.sin(data.axis[i]));
          const kick = data.kick[i];
          data.floaters.setXYZW(data.loose.length, s.print[0], s.print[1], data.axis[i], data.layer[i]);
          data.loose.push({
            position: s.at.clone().addScaledVector(s.normal, DEPTH * 1.5),
            velocity: s.normal
              .clone()
              .multiplyScalar(0.38 + Math.random() * 0.22)
              .addScaledVector(away, -0.18)
              .add(new THREE.Vector3((Math.random() - 0.5) * 0.12, 0.1, (Math.random() - 0.5) * 0.12))
              .multiplyScalar(kick),
            turn: layout.base[i].clone(),
            rest: null,
            spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar((0.4 + Math.random() * 0.8) * (0.5 + kick * 0.5)),
            scale: s.extent ? new THREE.Vector3(s.extent[0] / SIZE, s.extent[1] / SIZE, 1) : new THREE.Vector3(s.scale[0], s.scale[1], 1),
            span: s.span,
            roll: data.roll[i],
            landed: -1,
            age: 0,
            clear: 0,
            near: { index: -1 }
          });
        }
        // The tile itself is now the layer that was under it, flat and ready to peel again, with a new layer under that.
        data.layer[i]++;
        fold = FOLD_START;
        lift = 0.3;
      }
      data.tiles.setXYZW(i, s.print[0], s.print[1], data.axis[i], data.layer[i]);
      data.curls.setXYZW(i, fold, lift, s.span[0], s.span[1]);
    }
    if (changed) send([data.tiles, data.curls], lowest, highest + 1);
    // The pieces in the air fall like leaves, swinging side to side, and come to rest flat on the floor.
    // Run backwards, so that one gone can be replaced by the last, already moved this frame, and the list stays packed.
    for (let f = data.loose.length - 1; f >= 0; f--) {
      const loose = data.loose[f];
      loose.age += delta;
      const t = loose.age;
      let gone = t > FLOAT;
      if (loose.landed < 0) {
        // Gravity and the swing come on gradually, so it lifts away as a drifting piece does before it starts to fall.
        const settle = THREE.MathUtils.smoothstep(t, 0, 0.9);
        const swing = Math.sin(t * 3.1 + f) * 1.1 * settle;
        loose.velocity.x += swing * delta;
        loose.velocity.z += Math.cos(t * 2.3 + f * 0.7) * 0.8 * settle * delta;
        loose.velocity.y -= 1.1 * settle * delta;
        // Air holds a leaf back hard, so it falls slowly, faster when it is edge on.
        loose.velocity.multiplyScalar(Math.exp(-delta * 1.6));
        loose.position.addScaledVector(loose.velocity, delta);
        // It cannot fall through the object: touching the skin, it is pushed back out and loses the speed it had
        // going in. The glaze is slippery, so there is next to no friction, and gravity along the slope pulls it
        // downhill: it slides down the side and off, and carries on to the floor.
        loose.clear -= loose.velocity.length() * delta;
        const gap = loose.clear > 0 ? 1 : shape.distance(loose.position, away, loose.near) - CLEARANCE;
        if (loose.clear <= 0) loose.clear = gap * 0.9;
        if (gap < 0) {
          // Eased out rather than shoved: a piece that has only just come off starts closer than this, and should not jump.
          loose.position.addScaledVector(away, Math.min(-gap, 0.35 * delta));
          const into = loose.velocity.dot(away);
          if (into < 0) loose.velocity.addScaledVector(away, -into);
          loose.velocity.x += away.x * away.y * 2.4 * delta;
          loose.velocity.y -= (1 - away.y * away.y) * 2.4 * delta;
          loose.velocity.z += away.z * away.y * 2.4 * delta;
          loose.velocity.multiplyScalar(0.995);
          // Only one that comes to rest right on the very top, where there is no slope, stays there.
          if (away.y > 0.985 && loose.velocity.lengthSq() < 0.002) {
            loose.landed = t;
            // Curl side out, or the curl would bend down into the skin. Turned over gently, below.
            spinAxis.set(0, 0, 1).applyQuaternion(loose.turn);
            loose.rest = new THREE.Quaternion().setFromUnitVectors(spinAxis.clone(), away.clone()).multiply(loose.turn);
          }
        }
        step.setFromAxisAngle(spinAxis.copy(loose.spin).normalize(), loose.spin.length() * delta * (1 + Math.abs(swing) * 0.5));
        loose.turn.multiply(step);
        if (loose.position.y <= floor) {
          // Down: it settles flat with its curl upward, as a curl bending down would go through the floor. Turned over
          // gently, below, rather than snapped.
          loose.landed = t;
          loose.position.y = floor;
          spinAxis.set(0, 0, 1).applyQuaternion(loose.turn);
          loose.rest = new THREE.Quaternion().setFromUnitVectors(spinAxis.clone(), new THREE.Vector3(0, 1, 0)).multiply(loose.turn);
        }
      }
      // Older pieces still in the air fade away too, rather than vanish.
      let fade = 1 - THREE.MathUtils.smoothstep(t, FLOAT - 1, FLOAT);
      if (loose.landed >= 0) {
        const lying = t - loose.landed;
        gone = lying > LIE;
        if (loose.rest) loose.turn.slerp(loose.rest, 1 - Math.exp(-delta * 10));
        // At last it fades away where it lies.
        fade = 1 - THREE.MathUtils.smoothstep(lying, LIE - 1.5, LIE);
      }
      data.floaterFades.setX(f, fade);
      if (gone) {
        // The last one takes its place, picture and all.
        const last = data.loose.length - 1;
        if (f !== last) {
          data.loose[f] = data.loose[last];
          const from = data.floaters.array as Float32Array;
          from.copyWithin(f * 4, last * 4, last * 4 + 4);
          const moved = data.loose[f];
          matrix.compose(moved.position, moved.turn, place.copy(moved.scale));
          meshes.floating.setMatrixAt(f, matrix);
          data.floaterTurns.setXYZW(f, moved.turn.x, moved.turn.y, moved.turn.z, moved.turn.w);
          data.floaterCurls.setXYZW(f, FOLD_END, moved.roll, moved.span[0], moved.span[1]);
          data.floaterFades.setX(f, data.floaterFades.getX(last));
        }
        data.loose.pop();
        continue;
      }
      data.floaterTurns.setXYZW(f, loose.turn.x, loose.turn.y, loose.turn.z, loose.turn.w);
      matrix.compose(loose.position, loose.turn, place.copy(loose.scale));
      meshes.floating.setMatrixAt(f, matrix);
      // Still curled as it floats.
      data.floaterCurls.setXYZW(f, FOLD_END, loose.roll, loose.span[0], loose.span[1]);
    }
    meshes.floating.count = data.loose.length;
    // A crowd of tiny pieces casts only a haze of shadow, and costs a great deal to cast, so past a point they cast none.
    meshes.floating.castShadow = data.loose.length < 2500;
    if (data.loose.length > 0) send([meshes.floating.instanceMatrix, data.floaterTurns, data.floaters, data.floaterCurls, data.floaterFades], 0, data.loose.length);
    // The peel is heard as tiles start to come away: one at a time from a swipe, a quiet texture from a ripple.
    if (began > 0 && st.ticks <= 0) {
      st.ticks = 0.1;
      sound.play("peel", { variant: peelSound.current, gain: Math.min(0.9, 0.45 + began * 0.04), pitch: 0.9 + Math.random() * 0.25 });
    }
    st.ticks -= delta;
  });

  return <primitive object={group} />;
}
