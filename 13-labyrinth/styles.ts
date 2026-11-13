"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { Break, Fn, If, Loop, abs, attribute, color, dot, exp, float, floor, fract, fwidth, max, min, mix, normalGeometry, normalize, normalWorld, positionGeometry, positionWorld, pow, reflect, select, sin, smoothstep, texture, time, vec2, vec3, vec4 } from "three/tsl";
import { useLook } from "../shared/engine/Stage";
import type { Look } from "../shared/engine/types";
import { walking } from "../shared/engine/walk";
import { liveHeights, LOOK, SINK, SIZE } from "./hedge";
import { CELL, HEIGHT, labyrinthMaterials, sharedAir, THICK } from "./hedge-look";
import { away, farOut, fogged, steady, thinned, toEye } from "./style-air";
import { warp } from "./warp";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The same maze, rewriting itself the same way, with the same birds and fireflies, drawn in another manner. A style
// only swaps what the hedges, the ground and the sky are made of: the shapes, their motion and the bending of the world
// are left alone, and so is the maze, which goes on exactly as it was. What grows on the hedges and lies on the ground
// belongs to the natural maze and is put away in the others.
export type Style = "natural" | "tron";
export const STYLES: { value: Style; label: string; swatch: string[] }[] = [
  { value: "natural", label: "Natural", swatch: ["#5d7a2c", "#d9b98a"] },
  { value: "tron", label: "Tron", swatch: ["#02050a", "#27e8ff", "#ff8a2a"] }
];

// The post stack for each, over the natural one. The mist volume belongs to the evening, so the others turn it off.
const LOOKS: Record<Style, Partial<Look>> = {
  natural: LOOK,
  tron: { bloom: 0.75, bloomThreshold: 0.5, haze: 0, gi: 0, ao: 0.35, vignette: 0.55, grain: 0.02 }
};

// Which styles look along the maze for what a surface would reflect.
const TRACED = new Set<Style>(["tron"]);

const SUN = new THREE.Vector3(-0.36, 0.11, -0.93).normalize();

// How far up each wall stands, for the reflections to find: east walls in red, south walls in green.
const heights = new THREE.DataTexture(new Uint8Array(SIZE * SIZE * 4), SIZE, SIZE, THREE.RGBAFormat);
heights.magFilter = heights.minFilter = THREE.NearestFilter;
heights.needsUpdate = true;

// A thin line wherever a coordinate crosses a whole number, the same width on screen near and far.
const lines = (p: any, width: number): any => {
  const d = abs(fract(p.sub(0.5)).sub(0.5));
  return float(1).sub(smoothstep(fwidth(p).mul(width * 0.5), fwidth(p).mul(width * 1.5), d));
};

// How much of a hedge's rounded edge a point is on, from its unrounded normal: 0 across a face, 1 round a corner.
const edgeOf = (sharp: number, soft: number): any => {
  const n = abs(normalGeometry) as any;
  return smoothstep(sharp, soft, max(max(n.x, n.y), n.z));
};

// The two long edges along a hedge's top, on its finely made shape and on the plain far boxes alike, which is what
// keeps the maze legible a long way off, when the bent world lifts it into view.
const topEdge = (): any => smoothstep(0.6, 0.9, normalGeometry.y).mul(smoothstep(0.72, 0.9, abs(positionGeometry.z).div(THICK / 2)));

// Follows a ray along the maze, wall to wall, as a 2D walk across the grid of cells: each wall is a slab THICK wide on a
// line between cells, as high as it stands right now. Mirrored walls and floors turn it back and it carries on; otherwise
// it stops at the first thing it meets. Posts are left out. `hit` comes back 0 for running out of steps, 1 for a wall, 2 for
// the ground, 3 for out into the sky.
function trace(origin: any, direction: any, steps: number, mirrorWalls: boolean, mirrorFloor: boolean) {
  const px = float(origin.x).toVar();
  const py = float(origin.y).toVar();
  const pz = float(origin.z).toVar();
  const dx = float(direction.x).toVar();
  const dy = float(direction.y).toVar();
  const dz = float(direction.z).toVar();
  const hit = float(0).toVar();
  const bounces = float(0).toVar();
  const travelled = float(0).toVar();
  const top = float(0).toVar();
  const along = float(0).toVar();
  const t = THICK / 2 / CELL;
  const wallAt = (i: any, j: any): any => {
    const wrap = (c: any): any => c.sub(floor(c.div(SIZE)).mul(SIZE));
    return texture(heights, vec2(wrap(i).add(0.5), wrap(j).add(0.5)).div(SIZE)).level(float(0));
  };
  Loop(steps, () => {
    If(dy.greaterThan(0).and(py.greaterThan(HEIGHT)), () => {
      hit.assign(3);
      Break();
    });
    const cx = px.div(CELL).toVar();
    const cz = pz.div(CELL).toVar();
    const fx = select(dx.greaterThan(0), floor(cx).add(1 - t), floor(cx).add(t));
    const fz = select(dz.greaterThan(0), floor(cz).add(1 - t), floor(cz).add(t));
    const tx = select(abs(dx).greaterThan(1e-5), fx.mul(CELL).sub(px).div(dx), float(1e6)).max(0).toVar();
    const tz = select(abs(dz).greaterThan(1e-5), fz.mul(CELL).sub(pz).div(dz), float(1e6)).max(0).toVar();
    const tg = select(dy.lessThan(-1e-5), py.negate().div(dy), float(1e6)).max(0).toVar();
    const step = min(min(tx, tz), tg);
    px.addAssign(dx.mul(step));
    py.addAssign(dy.mul(step));
    pz.addAssign(dz.mul(step));
    travelled.addAssign(step);
    If(tg.lessThanEqual(min(tx, tz)), () => {
      py.assign(0);
      if (mirrorFloor) {
        dy.assign(dy.negate());
        bounces.addAssign(1);
      } else {
        hit.assign(2);
        Break();
      }
    })
      .ElseIf(tx.lessThan(tz), () => {
        const h = wallAt(select(dx.greaterThan(0), floor(cx), floor(cx).sub(1)), floor(pz.div(CELL))).r;
        const standing = h.mul(SINK).add(HEIGHT - SINK);
        If(h.greaterThan(0.01).and(py.lessThan(standing)), () => {
          top.assign(standing);
          along.assign(fract(pz.div(CELL)));
          if (mirrorWalls) {
            dx.assign(dx.negate());
            bounces.addAssign(1);
          } else {
            hit.assign(1);
            Break();
          }
        }).Else(() => {
          // Through the gap where a wall has sunk, and on into the next cell.
          const skip = float(THICK).div(abs(dx));
          px.addAssign(dx.mul(skip));
          py.addAssign(dy.mul(skip));
          pz.addAssign(dz.mul(skip));
          travelled.addAssign(skip);
        });
      })
      .Else(() => {
        const h = wallAt(floor(px.div(CELL)), select(dz.greaterThan(0), floor(cz), floor(cz).sub(1))).g;
        const standing = h.mul(SINK).add(HEIGHT - SINK);
        If(h.greaterThan(0.01).and(py.lessThan(standing)), () => {
          top.assign(standing);
          along.assign(fract(px.div(CELL)));
          if (mirrorWalls) {
            dz.assign(dz.negate());
            bounces.addAssign(1);
          } else {
            hit.assign(1);
            Break();
          }
        }).Else(() => {
          const skip = float(THICK).div(abs(dz));
          px.addAssign(dx.mul(skip));
          py.addAssign(dy.mul(skip));
          pz.addAssign(dz.mul(skip));
          travelled.addAssign(skip);
        });
      });
  });
  return { point: vec3(px, py, pz), direction: vec3(dx, dy, dz), hit, bounces, travelled, top, along };
}

type Trace = ReturnType<typeof trace>;

// ---- Tron: black glass on a black mirror, every edge a lit tube, the paths drawn out in light.

const CYAN = color("#27e8ff") as any;
const ORANGE = color("#ff8a2a") as any;
const MAGENTA = color("#ff2fa8") as any;

function tronSky(d: any): any {
  const up = d.y as any;
  const toward = dot(normalize(vec3(d.x, 0, d.z)), normalize(vec3(SUN.x, 0, SUN.z))) as any;
  const horizon = exp(abs(up).mul(-14)) as any;
  let sky: any = mix(color("#000208"), color("#05011a"), smoothstep(0, 0.5, up));
  sky = sky.add(MAGENTA.mul(horizon.mul(0.2))).add(CYAN.mul(exp(abs(up).mul(-60)).mul(0.3)));
  // A striped sun, low on the horizon, banded across its lower half.
  const sunAt = normalize(vec3(SUN.x, 0.09, SUN.z));
  const disc = smoothstep(0.9935, 0.9945, dot(d, sunAt)) as any;
  const height = up.sub(0.09).div(0.11).add(0.5) as any;
  const bands = smoothstep(0.35, 0.45, fract(up.mul(70))).max(smoothstep(0.5, 0.62, height)) as any;
  const sunColour = mix(MAGENTA, color("#ffd23f"), smoothstep(0.1, 0.9, height)) as any;
  sky = sky.add(sunColour.mul(disc.mul(bands).mul(2.4))).add(MAGENTA.mul(pow(max(toward, float(0)), float(60)).mul(horizon).mul(0.5)));
  return sky;
}

// What a reflection meets: the lit top edge and the ends of a wall, its dark glass, the grid of the floor or the sky.
function tronMet(r: Trace): any {
  const below = r.top.sub(r.point.y) as any;
  const t = THICK / 2 / CELL;
  const end = float(1).sub(smoothstep(0.0, 0.04, min(abs(r.along.sub(t)), abs(r.along.sub(1 - t))))) as any;
  const rim = float(1).sub(smoothstep(0.02, 0.09, below)).max(end) as any;
  const wall = color("#02060c").add(CYAN.mul(rim.mul(2.2))) as any;
  const floorAt = r.point.xz.div(CELL) as any;
  const centre = float(1).sub(smoothstep(0.0, 0.03, min(abs(fract(floorAt.x).sub(0.5)), abs(fract(floorAt.y).sub(0.5))))) as any;
  const ground = CYAN.mul(centre.mul(0.6)) as any;
  const met = select(r.hit.equal(1), wall, select(r.hit.equal(2), ground, select(r.hit.equal(3), tronSky(r.direction), vec3(0))));
  return mix(met, color("#02040a"), float(1).sub(exp(r.travelled.mul(-0.03))));
}

function tronHedge() {
  const rest = attribute("aRest", "vec4") as any;
  const moving = smoothstep(0.02, 0.25, rest.w) as any;
  const tube = mix(CYAN, ORANGE, moving) as any;
  const glow = Fn(() => {
    const view = toEye();
    const n = normalWorld as any;
    const facing = abs(dot(view, n)) as any;
    const fresnel = pow(float(1).sub(facing), float(4)) as any;
    const r = trace(positionWorld.add(n.mul(0.02)), reflect(view, n), 10, false, false);
    const edge = edgeOf(0.88, 0.76) as any;
    const scan = smoothstep(0.93, 1, fract(positionWorld.y.mul(7))).mul(0.05) as any;
    let rgb: any = color("#010409").add(tronMet(r).mul(fresnel.mul(0.5).add(0.04)));
    rgb = rgb.add(tube.mul(edge.mul(2.4).add(topEdge().mul(1.6)))).add(CYAN.mul(scan)).add(CYAN.mul(smoothstep(0.6, 0.9, normalGeometry.y).mul(0.05)));
    return vec4(fogged(rgb, color("#02040a"), 0.018).mul(steady), 1);
  })();
  return { colorNode: color("#000000"), outputNode: glow, lights: false };
}

function tronGround() {
  const glow = Fn(() => {
    const p = positionWorld.xz as any;
    const view = toEye();
    const up = vec3(0, 1, 0);
    const facing = abs(view.y) as any;
    const fresnel = float(0.06).add(pow(float(1).sub(facing), float(5)).mul(0.9)) as any;
    const r = trace(positionWorld.add(vec3(0, 0.01, 0)), reflect(view, up), 12, false, false);
    const fine = max(lines(p.x.div(CELL / 3), 1), lines(p.y.div(CELL / 3), 1)) as any;
    const centreX = lines(p.y.div(CELL).sub(0.5), 2.2) as any;
    const centreZ = lines(p.x.div(CELL).sub(0.5), 2.2) as any;
    // Light running along the middles of the paths, as on a circuit: a dash every four cells, staggered from row to row.
    const rowX = fract(sin(floor(p.y.div(CELL)).mul(12.9898)).mul(43758.5)) as any;
    const rowZ = fract(sin(floor(p.x.div(CELL)).mul(78.233)).mul(43758.5)) as any;
    const runX = smoothstep(0.8, 1, fract(p.x.div(CELL * 4).add(rowX).sub(time.mul(0.3)))) as any;
    const runZ = smoothstep(0.8, 1, fract(p.y.div(CELL * 4).add(rowZ).add(time.mul(0.3)))) as any;
    const near = exp(away().mul(-0.05)) as any;
    let rgb: any = color("#010203");
    rgb = rgb.add(CYAN.mul(fine.mul(0.12).mul(near)));
    rgb = rgb.add(CYAN.mul(centreX.add(centreZ).min(1).mul(0.5)));
    rgb = rgb.add(ORANGE.mul(centreX.mul(runX).add(centreZ.mul(runZ)).mul(3)));
    rgb = rgb.add(tronMet(r).mul(fresnel));
    return vec4(fogged(rgb, color("#02040a"), 0.018).mul(steady), 1);
  })();
  return { colorNode: color("#000000"), outputNode: glow, lights: false };
}

// What each kind of surface is made of in each style. The sky is lit by nothing, so it is a colour by direction.
type Nodes = Record<string, unknown>;
const skyOf = (paint: (d: any) => any): Nodes => ({ colorNode: paint(toEye()) });

const BUILD: Record<Exclude<Style, "natural">, { hedge: () => Nodes; ground: () => Nodes; sky: () => Nodes }> = {
  tron: { hedge: tronHedge, ground: tronGround, sky: () => skyOf((d) => tronSky(d).mul(steady)) }
};

type Kind = "hedge" | "ground" | "sky" | "life" | "dressing" | "tech";
const kindOf = (material: THREE.NodeMaterial): Kind =>
  material.name === "tech" ? "tech" : material.name === "hedge" || material.name === "ground" || material.name === "sky" ? (material.name as Kind) : material instanceof THREE.MeshBasicNodeMaterial ? "life" : "dressing";

// Each material as the natural maze made it, to go back to, and each style's nodes once built, to swap back in.
const natural = new WeakMap<THREE.NodeMaterial, Nodes>();
const built = new WeakMap<THREE.NodeMaterial, Map<Style, Nodes>>();
const applied = new WeakMap<THREE.NodeMaterial, Style>();

function snapshot(material: THREE.NodeMaterial): Nodes {
  const kept: Nodes = { visible: material.visible, lights: material.lights };
  for (const [key, value] of Object.entries(material)) {
    // The mask is the bent world's, and stays whatever the style.
    if (key.endsWith("Node") && key !== "maskNode" && value) kept[key] = value;
  }
  return kept;
}

function apply(material: THREE.NodeMaterial, style: Style) {
  if (!natural.has(material)) natural.set(material, snapshot(material));
  const original = natural.get(material) as Nodes;
  const kind = kindOf(material);
  // The Tron maze's chips and cables and craft, only there; and the birds, which have no place in its sky.
  if (kind === "tech" || material.name === "birds") {
    material.visible = (kind === "tech") === (style === "tron");
    return;
  }
  if (kind === "life") return;
  // Whatever another style set goes, and the natural nodes come back, before this style's go on.
  for (const key of Object.keys(material)) if (key.endsWith("Node") && key !== "maskNode") (material as any)[key] = null;
  Object.assign(material, original);
  if (style !== "natural") {
    if (kind === "dressing") {
      material.visible = false;
    } else {
      for (const key of Object.keys(original)) if (key.endsWith("Node")) (material as any)[key] = null;
      let cache = built.get(material);
      if (!cache) built.set(material, (cache = new Map()));
      let nodes = cache.get(style);
      if (!nodes) cache.set(style, (nodes = BUILD[style][kind]()));
      Object.assign(material, nodes);
    }
  }
  material.needsUpdate = true;
}

// Keeps every labyrinth material in the chosen style, including any made later, as when the quality tier changes.
export function useStyle(style: Style) {
  useLook(useMemo(() => ({ ...LOOK, ...LOOKS[style] }), [style]));

  useEffect(() => {
    for (const material of labyrinthMaterials) {
      if (applied.get(material) === style) continue;
      apply(material, style);
      applied.set(material, style);
    }
  }, [style]);

  useFrame(() => {
    for (const material of labyrinthMaterials) {
      if (applied.get(material) === style) continue;
      // A material made while natural is already as it should be.
      if (style !== "natural" || applied.has(material)) apply(material, style);
      applied.set(material, style);
    }
    steady.value = 1 / (1 + walking.amount * 1.2);
    // Eased as the natural mist is, so both clear and close in together.
    const eased = (amount: number) => 1 - (1 - amount) ** 4;
    thinned.value = 1 - Math.max(eased(warp.ring.value), eased(warp.fold.value), eased(warp.twist.value)) * 0.88;
    if (sharedAir.current) farOut.value = sharedAir.current.far.value;
    if (!TRACED.has(style) || !liveHeights.current) return;
    const live = liveHeights.current;
    const data = heights.image.data as Uint8Array;
    for (let cell = 0; cell < SIZE * SIZE; cell++) {
      data[cell * 4] = live[cell * 2] * 255;
      data[cell * 4 + 1] = live[cell * 2 + 1] * 255;
    }
    heights.needsUpdate = true;
  });
}
