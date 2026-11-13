import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  color,
  cameraViewMatrix,
  cos,
  cross,
  dFdx,
  dFdy,
  dot,
  exp,
  faceDirection,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  mix,
  normalGeometry,
  normalView,
  normalWorld,
  normalize,
  output,
  positionGeometry,
  positionView,
  positionWorld,
  pow,
  select,
  sign,
  sin,
  smoothstep,
  texture,
  time,
  uv,
  uniform,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";

import { mulberry32 } from "../shared/engine/random";
import { fractal2, fractal3, hash4, hash43, leafCells, leafLength, noise2, noise3, stoneCells } from "./hedge-noise";
import { bend, drawn } from "./warp";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Where each mesh's vertices come from, for anything that later bends the world. Every material here and in the other
// labyrinth files is made through `made`, so `labyrinthMaterials` holds them all, and any that moves its vertices does
// so once, through `shape`, as a position in the mesh's own space, before its instance or model matrix is applied:
//   hedges, sprigs, leaves, vines, stones   instanced; the hedge's own frame, and the instance matrix stands it in the maze
//   ground, sky                             no position of their own; one mesh slid along under the camera
//   fireflies, birds                        instanced with identity matrices; the position given is already the world's
// The mist is a volume in the post stack's haze pass, made in hedge.tsx, and left out. Every material but the sky's is
// drawn through the bent world of warp.ts, which carries each point, once placed, to where the chosen study puts it.
export const labyrinthMaterials = new Set<THREE.NodeMaterial>();
export function made<T extends THREE.NodeMaterial>(material: T, bends = true): T {
  labyrinthMaterials.add(material);
  material.addEventListener("dispose", () => labyrinthMaterials.delete(material));
  if (bends) bend(material);
  return material;
}
export function shape(material: THREE.NodeMaterial, position: any) {
  material.positionNode = position;
}

// The size of the maze: a cell is a stretch of path with a hedge along two of its sides.
export const CELL = 2.7;
export const THICK = 0.95;
export const HEIGHT = 2.45;
// How far past a post's face a wall reaches, so that its rounded end is always buried in the post.
const TUCK = 0.2;
export const WALL_LENGTH = CELL - THICK + TUCK * 2;
// One copy of the maze, 40 cells across, in metres. Every pattern repeats exactly this often, so that the camera can be
// carried back a copy without anything changing under it. Noise is given how many of its cells span one copy.
export const SPAN = 108;
const COPY_CELLS = 40;

// How tall each hedge stands against the rest: a little over or under, rolling gently across the maze, so that the tops
// are not all one level but neighbours stand nearly even. Waves a whole number of times across a copy of the maze, so a
// hedge is the same height wherever it is seen, walked into or stood on.
export function tallness(x: number, z: number) {
  const u = (x / SPAN) * Math.PI * 2;
  const v = (z / SPAN) * Math.PI * 2;
  const roll =
    Math.sin(2 * u + 1.3) * Math.sin(3 * v + 0.4) * 0.3 +
    Math.sin(5 * u + 4 * v + 2.1) * 0.25 +
    Math.sin(9 * u - 7 * v + 0.7) * 0.25 +
    Math.sin(14 * u + 11 * v + 4.2) * 0.1;
  return 1 + roll * 0.16;
}

// The evening: where the sun is and what colour, and the mist that everything sinks into.
export type Air = ReturnType<typeof createAir>;
// The air last made, for the visual styles in styles.ts, which fog the maze out where this does.
export const sharedAir: { current: Air | null } = { current: null };
export function createAir() {
  const air = {
    sun: uniform(new THREE.Vector3(-0.36, 0.11, -0.93).normalize()),
    sunColour: uniform(new THREE.Color("#ffc07a")),
    mist: uniform(new THREE.Color("#b9a084")),
    glow: uniform(new THREE.Color("#ffc681")),
    zenith: uniform(new THREE.Color("#7f97b6")),
    // Thin air over the hedges, and a thicker mist lying in the paths.
    density: uniform(0.03),
    lying: uniform(0.75),
    clear: uniform(7),
    backlight: uniform(0.9),
    // Where everything has gone into the mist, short of the edge of the maze.
    far: uniform(48),
    // The sky's own: how much cloud and its colours away from the sun, toward it and right by it, how bright the sun's
    // disc is, the stars and the moon, and how much dew lies on the hedges. All as the evening has them; skies.ts
    // changes them for the other times of day.
    cloudCover: uniform(0.05),
    cloudOpacity: uniform(0.75),
    cloudShade: uniform(new THREE.Color("#8a8fa6")),
    cloudLit: uniform(new THREE.Color("#f2a98a")),
    cloudGlow: uniform(new THREE.Color("#ffd9a0")),
    disc: uniform(1),
    stars: uniform(0),
    moon: uniform(0),
    moonAt: uniform(new THREE.Vector3(0.4, 0.55, 0.3).normalize()),
    dew: uniform(1)
  };
  sharedAir.current = air;
  return air;
}

// The mist's colour looking one way: brighter and warmer toward the sun.
export const mistColour = (air: Air, direction: any): any => {
  const toward = max(dot(direction, air.sun), float(0)) as any;
  return mix(air.mist, air.glow, pow(toward, float(6)).mul(0.7).add(pow(toward, float(40)).mul(0.3)));
};

// How much of the air between the lens and a surface is mist. Lying mist is thickest low down, so it is measured at the
// average height along the way, which is exact for a mist that thins steadily upward and close enough for this one.
// Both are measured to where a surface is drawn, which in a bent world is not where it lies.
export const mistAmount = (air: Air): any => {
  const distance = length(drawn.sub(cameraPosition)) as any;
  const low = max(drawn.y.add(cameraPosition.y).mul(0.5), float(0)) as any;
  const thick = air.density.mul(float(0.45).add(exp(low.div(-1.1)).mul(air.lying).mul(4))) as any;
  // Clear for the first few metres, so what is close keeps its colour and the mist gathers behind it.
  return max(float(1).sub(exp(distance.sub(air.clear).max(0).mul(thick).negate())), smoothstep(air.far.mul(0.6), air.far, distance));
};

// Looking up, the mist is the sky's own blue, so that a bent world's maze high overhead goes into the sky around it.
export const throughMist = (air: Air, lit: any): any => {
  const direction = normalize(drawn.sub(cameraPosition)) as any;
  const sky = mix(mistColour(air, direction), air.zenith, smoothstep(0.02, 0.55, direction.y).mul(0.85));
  return mix(lit, sky, mistAmount(air));
};

// The bounce light in the post stack is worked out from each surface's own colour and added after the mist, so what
// is lost in the mist has to lose its colour too, or the pattern of the far ground shows back through.
export const fading = (air: Air, albedo: any): any => albedo.mul(float(1).sub(mistAmount(air)));

// Bump mapping from any height, by Mikkelsen's method, with no texture needed.
export function bumped(height: any) {
  const sx = dFdx(positionView);
  const sy = dFdy(positionView);
  const r1 = cross(sy, normalView);
  const r2 = cross(normalView, sx);
  const det = (dot(sx, r1) as any).mul(faceDirection);
  const gradient = sign(det).mul(r1.mul(dFdx(height)).add(r2.mul(dFdy(height))));
  return normalize(abs(det).mul(normalView).sub(gradient));
}

// A direction in the world, turned into the view's frame, to tip a normal by.
export const toView = (v: any): any => cameraViewMatrix.mul(vec4(v, 0)).xyz;

// Finer than a pixel, detail only flickers. This fades it out before it gets there.
export const resolved = (p: any, frequency: number): any => float(1).sub(smoothstep(0.15, 0.5, (length(fwidth(p)) as any).mul(frequency)));

const leaves = leafCells(1.9);
const stones = stoneCells(1.25);
const pebbles = stoneCells(1.25, false);
const clumps = stoneCells(1.1);

// Big soft lumps where the shears went round, the same everywhere so a wall and its post meet without a seam. No finer
// than the hedge's corners are apart, about a fifth of a metre, or the low sun picks out the corners in stripes.
const lumps = (p: any): any => fractal3(p.mul(vec3(1, 1.15, 1)), 49, 2).mul(1.6);

// How far the surface bulges out at a point, tidier across the clipped top than down the sides.
const swellFrom = (big: any, up: any): any => big.mul(0.075).mul(float(1).sub(up.max(0).mul(0.85)));
export const swellAt = (p: any, up: any): any => swellFrom(lumps(p), up);

// Where each instance stands grown, and the turn a quarter round that walls running north to south are given. `at` gives
// a point in the maze's own copy, for patterns; `world` gives it where it really stands, for distances from the camera.
export const placement = () => {
  const rest = attribute("aRest", "vec4") as any;
  const turned = rest.z.greaterThan(0.5);
  const turn = (v: any): any => select(turned, vec3(v.z, v.y, v.x.negate()), v);
  // Which copy an instance stands in, worked out from its cell, so a wall and the post its end is buried in agree.
  const copy = floor(rest.xy.div(CELL).sub(0.49).div(COPY_CELLS)).mul(SPAN) as any;
  const origin = vec3(rest.x.sub(copy.x), 0, rest.y.sub(copy.y));
  return {
    rest,
    turn,
    at: (local: any): any => origin.add(turn(local)),
    world: (local: any): any => vec3(rest.x, 0, rest.y).add(turn(local)),
    // A number from 0 to 1 for each hedge, and others from it.
    own: hash4(origin.xz.mul(3.7).floor()) as any
  };
};

// One hedge: a box, rounded down its corners and along its top, built as rings stacked up its sides and then drawn in
// across the top. `x` and `z` are its full width and depth. It stands on y = 0 and reaches a little below it.
export function hedgeGeometry(x: number, z: number, detail: number) {
  const ax = x / 2;
  const az = z / 2;
  const corner = 0.12;
  const top = 0.16;
  const spacing = 0.22 / detail;
  const arc = Math.max(2, Math.round(4 * detail));

  // The way round, as corners and straight runs between them. Corners go anticlockwise from +x+z, seen from above.
  type Step = { corner: number; angle: number } | { edge: number; t: number };
  const around: Step[] = [];
  for (let k = 0; k < 4; k++) {
    for (let a = 0; a < arc; a++) around.push({ corner: k, angle: ((k + a / arc) * Math.PI) / 2 });
    const run = (k % 2 === 0 ? ax : az) * 2 - corner * 2;
    const pieces = Math.max(1, Math.round(run / spacing));
    for (let p = 0; p < pieces; p++) around.push({ edge: k, t: p / pieces });
  }
  const signX = [1, -1, -1, 1];
  const signZ = [1, 1, -1, -1];
  const point = (step: Step, inset: number) => {
    const r = Math.max(corner - inset, 0);
    const hx = Math.max(ax - inset - r, 0);
    const hz = Math.max(az - inset - r, 0);
    if ("corner" in step) {
      const nx = Math.cos(step.angle);
      const nz = Math.sin(step.angle);
      return [signX[step.corner] * hx + nx * r, signZ[step.corner] * hz + nz * r, nx, nz];
    }
    const k = step.edge;
    const n = (k + 1) % 4;
    const angle = ((k + 1) * Math.PI) / 2;
    const nx = Math.round(Math.cos(angle));
    const nz = Math.round(Math.sin(angle));
    const cx = THREE.MathUtils.lerp(signX[k] * hx, signX[n] * hx, step.t);
    const cz = THREE.MathUtils.lerp(signZ[k] * hz, signZ[n] * hz, step.t);
    return [cx + nx * r, cz + nz * r, nx, nz];
  };

  // Up the sides, round the top edge, and in across the top.
  const rings: { inset: number; y: number; out: number; up: number }[] = [];
  const side = HEIGHT - top;
  const rows = Math.max(2, Math.round((side + 0.3) / (spacing * 1.3)));
  for (let r = 0; r <= rows; r++) rings.push({ inset: 0, y: -0.3 + ((side + 0.3) * r) / rows, out: 1, up: 0 });
  for (let a = 1; a <= arc + 1; a++) {
    const theta = (a / (arc + 1)) * (Math.PI / 2);
    rings.push({ inset: top * (1 - Math.cos(theta)), y: side + top * Math.sin(theta), out: Math.cos(theta), up: Math.sin(theta) });
  }
  const inward = Math.max(2, Math.round((Math.min(ax, az) - top) / spacing));
  for (let r = 1; r <= inward; r++) rings.push({ inset: top + ((Math.min(ax, az) - top) * r) / inward, y: HEIGHT, out: 0, up: 1 });

  const positions: number[] = [];
  const normals: number[] = [];
  for (const ring of rings) {
    for (const step of around) {
      const [px, pz, nx, nz] = point(step, ring.inset);
      positions.push(px, ring.y, pz);
      const length = Math.hypot(nx * ring.out, ring.up, nz * ring.out) || 1;
      normals.push((nx * ring.out) / length, ring.up / length, (nz * ring.out) / length);
    }
  }
  const count = around.length;
  const index: number[] = [];
  for (let r = 0; r < rings.length - 1; r++) {
    for (let s = 0; s < count; s++) {
      const a = r * count + s;
      const b = r * count + ((s + 1) % count);
      const c = a + count;
      const d = b + count;
      index.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
  // The winding above is worked out for anticlockwise rings. Checked rather than trusted, by the first side face.
  const p = (i: number) => new THREE.Vector3().fromArray(positions, index[i] * 3);
  const face = new THREE.Vector3().crossVectors(p(1).sub(p(0)), p(2).sub(p(0)));
  if (face.dot(new THREE.Vector3().fromArray(normals, index[0] * 3)) < 0) {
    for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
    geometry.setIndex(index);
  }
  geometry.computeBoundingSphere();
  return geometry;
}

// The greens of a clipped hedge, shared with the loose leaves standing out of it: old leaves deep, this year's lighter,
// and some stretches of hedge darker and bluer, like yew, others brighter, like privet.
export const leafGreen = (own: any, young: any, kind: any): any => {
  const old = mix(mix(color("#16270d"), color("#26401a"), own), mix(color("#11220f"), color("#1d351c"), own), kind) as any;
  const fresh = mix(color("#5e7f1f"), color("#3f6a2a"), kind) as any;
  return mix(old, fresh, young);
};

// Every hedge in the maze, walls and posts alike. Each instance carries where it stands when fully grown, whether it
// is turned a quarter round, and how far it has sunk, so that the leaves sink with it rather than sliding over it.
// Far off, where a leaf is smaller than a pixel, the leaves are left out and only the colour they make is kept.
export function hedgeMaterial(air: Air, far = false) {
  // Leaves are no mirrors: a third of the usual sheen, or every leaf tipped up to the sky is turned blue by it.
  const material = made(new THREE.MeshPhysicalNodeMaterial({ roughness: 0.6, metalness: 0, specularIntensity: 0.35 }));
  // Named for styles.ts, which restyles each kind of surface.
  material.name = "hedge";
  const { turn, at: place } = placement();
  const grown = place(positionGeometry);
  // The slow patterns are worked out at the corners and carried across: the lumps, where the hedge has grown thin, and
  // which way its green leans.
  const lumpy = lumps(grown);
  const swell = swellFrom(lumpy, normalGeometry.y);
  shape(material, positionGeometry.add(normalGeometry.mul(swell)));
  const at = varying(grown.add(turn(normalGeometry).mul(swell)), "vHedge") as any;
  const slow = varying(
    vec3(lumpy, noise3(grown.mul(vec3(1, 1.4, 1)), 77).y, fractal2(grown.xz, 4, 2)),
    "vHedgeSlow"
  ) as any;
  const height = at.y as any;

  // Leaves are laid out on whichever face of the box this is: across the top any way at all, down the sides mostly
  // pointing up toward the light.
  const n = abs(normalWorld) as any;
  const onTop = n.y.greaterThan(max(n.x, n.z));
  const facingX = n.x.greaterThan(n.z);
  const plane = select(onTop, at.xz, select(facingX, at.zy, at.xy)) as any;
  const axisU = select(onTop, vec3(1, 0, 0), select(facingX, vec3(0, 0, 1), vec3(1, 0, 0))) as any;
  const axisV = select(onTop, vec3(0, 0, 1), vec3(0, 1, 0)) as any;

  const big = slow.x as any;
  // The lumps again, smooth for shading: carried across from the corners they would light as facets.
  const bulge = noise3(at.mul(vec3(1, 1.15, 1)), 97).x as any;
  const sprays = noise3(at, 362) as any;
  const spray = sprays.x as any;
  // Long stretches darker and bluer, like yew, or brighter, like privet, drifting from one to the other through the maze.
  const kind = smoothstep(-0.35, 0.45, slow.z.mul(1.6)) as any;
  const crown = smoothstep(HEIGHT - 0.45, HEIGHT, height).add(smoothstep(0.4, 0.9, normalWorld.y)).min(1) as any;
  const outward = smoothstep(-0.3, 0.5, big.add(spray.mul(0.35))) as any;
  // Into the hedge, between the clumps, it is dark.
  const into = smoothstep(-0.95, -0.25, big.add(spray.mul(0.4))) as any;
  // Darker toward the foot of the sides, where the corridor shades them and the light comes only from the strip of sky.
  const foot = mix(float(0.65), float(1.1), smoothstep(0, 1.5, height)) as any;

  if (far) {
    let colour: any = leafGreen(spray.mul(0.2).add(0.5), smoothstep(0.55, 1.05, spray.mul(0.2).add(crown.mul(0.5)).add(outward.mul(0.15))).mul(0.6), kind);
    colour = mix(colour, color("#2a2116"), smoothstep(0.55, 0.05, height).mul(0.5));
    material.normalNode = bumped(bulge.mul(0.025).add(spray.mul(0.01)));
    material.colorNode = fading(air, colour.mul(mix(float(0.3), float(0.62), into)).mul(foot).mul(outward.mul(0.3).add(0.85)));
    material.roughnessNode = float(0.84);
    material.outputNode = vec4(throughMist(air, (output as any).rgb), 1) as any;
    return material;
  }

  // Two layers of small leaves a little apart, the upper wherever it reaches and the lower showing between. Where neither
  // does, or where the hedge has grown thin, the eye goes into the dark of the hedge and finds its twigs.
  const density = 46;
  const fine = resolved(plane, density);
  const base = select(onTop, float(0), float(Math.PI / 2)) as any;
  const spread = select(onTop, float(6.283), float(2.4)) as any;
  const upper = leaves(plane.mul(density), float(SPAN * density), base, spread) as any;
  const lower = leaves(plane.mul(40).add(vec2(0.37, 0.61)), float(SPAN * 40), base.add(0.4), spread) as any;
  const thin = smoothstep(0.2, 0.62, slow.y.add(spray.mul(0.25))).mul(float(1).sub(crown.mul(0.7))) as any;
  const blade = (cell: any): any => float(1).sub(smoothstep(0, 0.56, leafLength(cell, 1.9))).add(cell.x.mul(cell.w.sub(0.5)).mul(2.2));
  const top = blade(upper).sub(thin.mul(0.95));
  const under = blade(lower).sub(0.32).sub(thin.mul(0.6));
  const upperWins = top.greaterThan(under);
  const leaf = select(upperWins, upper, lower) as any;
  const leafShape = max(top, under) as any;
  const covered = smoothstep(-0.05, 0.22, leafShape) as any;
  // A rib down the middle of each leaf.
  const rib = float(1).sub(smoothstep(0.012, 0.04, abs(leaf.y))).mul(smoothstep(0.1, 0.3, leafShape)).mul(fine) as any;

  // Twigs inside: lines along the ridges of a stretched noise, running up and out the way a hedge's stems grow.
  // Sprays of leaves a hand across, each a low dome: lit on its crown, dark in the hollows between, which is most of what
  // makes a hedge look deep at a few paces.
  // Pushed about by a slow noise so they are of all sizes and shapes rather than a sheet of bubbles, and softened where
  // they meet, so the hollows between are shade rather than a dark rim round each one.
  const shove = vec2(noise2(plane.mul(1.4), 411).x, noise2(plane.mul(1.4).add(vec2(5.2, 1.7)), 412).x).mul(0.22) as any;
  const clumpCell = clumps(plane.add(shove).mul(3), float(SPAN * 3)) as any;
  const clump = float(1).sub(smoothstep(0.05, 0.85, clumpCell.x)).mul(smoothstep(-0.6, 0.4, spray).mul(0.5).add(0.5)) as any;
  const twigNoise = noise2(vec2(plane.x.add(plane.y.mul(0.37)), plane.y.mul(0.53)), 290).x as any;
  const twig = float(1).sub(smoothstep(0.03, 0.1, abs(twigNoise))).mul(fine) as any;

  // Each leaf tipped its own way, cupped across and arched along, so each catches the low sun differently.
  const tip = (cell: any): any => {
    const direction = vec2(cos(cell.z), sin(cell.z)) as any;
    const side = vec2(direction.y.negate(), direction.x) as any;
    const own = vec2(fract(cell.w.mul(7.31)), fract(cell.w.mul(3.17))).sub(0.5).mul(0.8) as any;
    return own.add(side.mul(cell.y.mul(2.4))).add(direction.mul(cell.x.mul(1.1)));
  };
  const tilt = tip(leaf).mul(covered).mul(fine) as any;
  const relief = clump
    .mul(0.03)
    .add(bulge.mul(0.025))
    .add(spray.mul(0.014))
    .add(leafShape.max(-0.2).mul(0.006).mul(fine))
    .sub(float(1).sub(covered).mul(0.012).mul(fine));
  material.normalNode = normalize(bumped(relief).add(toView(axisU.mul(tilt.x).add(axisV.mul(tilt.y)))));

  // Deep green, lighter where it bulges out to the light, with this year's growth yellow-green along the top.
  const young = smoothstep(0.55, 1.05, leaf.w.mul(0.5).add(spray.mul(0.3)).add(crown.mul(0.5))).mul(0.8) as any;
  let colour: any = leafGreen(leaf.w, young, kind).mul(mix(float(0.74), float(1.08), clump.mul(fine.mul(0.6).add(0.4))));
  colour = colour.mul(outward.mul(0.35).add(0.95));
  // A few leaves gone yellow or brown, paler along the rib, and bare wood near the ground where the light never reaches.
  colour = mix(colour, mix(color("#4a3a1a"), color("#5e5424"), fract(leaf.w.mul(31))), smoothstep(0.986, 0.995, leaf.w).mul(fine).mul(0.7));
  colour = mix(colour, colour.mul(1.5).add(color("#141a06")), rib.mul(0.5));
  colour = mix(colour, color("#2a2116"), smoothstep(0.55, 0.05, height).mul(0.6));
  // Between and under the leaves it is dark, but a twig or two catches some light.
  const lowerShade = select(upperWins, float(1), float(0.5)) as any;
  const between = mix(float(0.62), covered.mul(0.8).add(0.2).mul(lowerShade), fine) as any;
  const leaves1 = colour.mul(mix(float(0.3), float(1), into)).mul(between);
  const wood = mix(color("#26241a"), color("#3d3a2a"), spray.mul(0.5).add(0.5)).mul(0.5) as any;
  const albedo = mix(leaves1, wood, twig.mul(float(1).sub(covered)).mul(0.85)).mul(foot) as any;
  material.colorNode = fading(air, albedo);
  // Waxy leaves, glossier the younger, and the odd bead of dew on top that catches the sun.
  const dew = smoothstep(float(1).sub(air.dew.mul(0.012)), float(1).sub(air.dew.mul(0.005)), fract(leaf.w.mul(13.7))).mul(crown).mul(fine).mul(select(upperWins, float(1), float(0))) as any;
  // Where the leaves are too small to see, the light scatters off a thousand of them at once, and the hedge is matt.
  const glossy = mix(mix(float(0.72), float(0.55), leaf.w), float(0.92), float(1).sub(covered));
  material.roughnessNode = mix(mix(float(0.82), glossy, fine), float(0.08), dew);

  // Light through the leaves along the top and wherever the hedge has grown thin, where the sun is behind them.
  const view = normalize(positionWorld.sub(cameraPosition)) as any;
  const behind = pow(max(dot(view, air.sun), float(0)), float(4)) as any;
  const rim = smoothstep(HEIGHT - 0.7, HEIGHT + 0.05, height).add(thin.mul(0.5)).min(1) as any;
  const through = rim.mul(into).mul(covered).mul(leaf.w.mul(0.6).add(0.4)).mul(fine.mul(0.6).add(0.4)) as any;
  material.emissiveNode = (air.sunColour as any).mul(mix(color("#7fa82a"), color("#b6c83c"), young)).mul(behind.mul(through).mul(air.backlight).mul(1.2));

  material.outputNode = vec4(throughMist(air, (output as any).rgb), 1) as any;
  return material;
}

// The ground: raked gravel down the paths, and a bed of bare earth under each hedge, which stays a while after the hedge
// has sunk and is gravelled over again. `beds` holds, for each cell, how much earth lies along its east side and its south.
// Grass and moss creep out from the foot of each hedge, and the hedges have dropped leaves along the edges of the paths.
export function groundMaterial(air: Air, beds: THREE.DataTexture, size: number) {
  const material = made(new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 }));
  material.name = "ground";
  const world = positionWorld.xz as any;
  // The ground in the maze's own copy: the pattern repeats with the maze.
  const p = world.sub(floor(world.div(SPAN)).mul(SPAN)) as any;
  const cell = floor(p.div(CELL)) as any;
  const f = p.div(CELL).sub(cell) as any;
  const slot = (c: any): any => c.sub(floor(c.div(size)).mul(size)).add(0.5).div(size);
  const bedAt = (i: any, j: any): any => texture(beds, vec2(slot(i), slot(j)));
  const here = bedAt(cell.x, cell.y);
  const west = bedAt(cell.x.sub(1), cell.y).r;
  const north = bedAt(cell.x, cell.y.sub(1)).g;
  const broad = noise2(p, 145) as any;
  const wobble = broad.x.mul(0.05).add(noise2(p, 628).x.mul(0.015)) as any;
  // How much of each kind of ground there is a given way from a line a hedge stands on.
  const within = (d: any, from: number, to: number): any => float(1).sub(smoothstep(from, to, d.mul(CELL).add(wobble)));
  const lines = (from: number, to: number): any =>
    max(max(within(float(1).sub(f.x), from, to).mul(here.r), within(f.x, from, to).mul(west)), max(within(float(1).sub(f.y), from, to).mul(here.g), within(f.y, from, to).mul(north)));
  const bed = lines(THICK / 2 + 0.04, THICK / 2 + 0.1);
  const fringe = lines(THICK / 2 + 0.06, THICK / 2 + 0.42).sub(bed).max(0) as any;
  // Shade along the foot of a hedge, for the tiers with no screen-space occlusion to find it.
  const foot = lines(THICK / 2, THICK / 2 + 0.9) as any;
  // Worn paler and flatter down the middle of each path, where feet go.
  const middle = smoothstep(0.3, 0.05, abs(f.x.sub(0.5)).min(abs(f.y.sub(0.5)))) as any;

  // Gravel at three sizes, down to grit, with the odd flat stone sunk in it.
  const stone = stones(p.mul(24), float(SPAN * 24)) as any;
  const pebble = pebbles(p.mul(57).add(7.7), float(SPAN * 57)) as any;
  const grit = noise2(p, 7728) as any;
  const slab = stones(p.mul(4), float(SPAN * 4)) as any;
  const fineStone = resolved(world, 24);
  const finePebble = resolved(world, 57);
  const fineGrit = resolved(world, 160);
  const dome = float(1).sub(smoothstep(0.1, 0.5, stone.x)) as any;
  const small = float(1).sub(smoothstep(0.1, 0.5, pebble.x)) as any;
  const isSlab = smoothstep(0.86, 0.9, slab.z).mul(smoothstep(0.34, 0.27, slab.x)).mul(float(1).sub(middle.mul(0.6))) as any;
  const clods = fractal2(p, 435, 2) as any;
  const loose = float(1).sub(middle.mul(0.55)) as any;
  const gravelHeight = dome
    .mul(0.009)
    .mul(fineStone)
    .mul(loose)
    .add(small.mul(0.003).mul(finePebble))
    .add(grit.x.mul(0.0008).mul(fineGrit))
    .add(isSlab.mul(0.01).add(isSlab.mul(grit.z).mul(0.0015)));

  let gravel: any = mix(color("#97866b"), color("#d2c19c"), stone.w);
  gravel = mix(gravel, color("#6e6658"), smoothstep(0.9, 0.97, stone.w));
  gravel = mix(gravel, mix(color("#85765d"), color("#bba98a"), pebble.w), smoothstep(0.2, 0.5, stone.x).mul(finePebble));
  gravel = gravel.mul(mix(float(0.72), smoothstep(0, 0.12, stone.y).mul(0.3).add(0.7), fineStone));
  gravel = gravel.mul(grit.y.mul(0.12).mul(fineGrit).add(1));
  gravel = mix(gravel, mix(color("#8c8274"), color("#a89b86"), slab.w).mul(clods.mul(0.3).add(1)), isSlab);
  gravel = gravel.mul(middle.mul(0.12).add(0.94)).mul(float(1).sub(foot.mul(0.4)));
  const earth = mix(color("#2a1e14"), color("#4a3624"), clods.mul(0.5).add(0.5)) as any;

  // Grass and moss along the foot of each hedge, in blades too fine to draw one by one, thinning into the gravel.
  const blades = noise2(p, 10626) as any;
  const fineBlades = resolved(world, 220);
  const patch = smoothstep(-0.3, 0.4, broad.y.add(clods.mul(0.6))) as any;
  const grassy = fringe.mul(patch).add(foot.mul(0.3).mul(patch)).mul(smoothstep(-0.6, 0.2, clods.add(broad.x.mul(0.5)))).min(1) as any;
  let grass: any = mix(color("#243210"), color("#4d5a1e"), blades.x.mul(0.5).add(0.5).mul(fineBlades).add(float(1).sub(fineBlades).mul(0.5)));
  grass = mix(grass, color("#8a7d3a"), smoothstep(0.3, 0.8, blades.y).mul(0.5).mul(fineBlades));
  const moss = mix(color("#3e4a1e"), color("#5f6a26"), broad.z.mul(0.5).add(0.5));

  // Fallen leaves: thickest against the hedges, a few out on the paths, curled, yellow and brown.
  const fallen = leaves(p.mul(11), float(SPAN * 11), float(0), float(6.283)) as any;
  // Pointed at the tip, and narrower toward the stalk.
  const fallenShape = float(1).sub(smoothstep(0.3, 0.36, leafLength(fallen, 1.9).add(fallen.x.mul(0.35)).add(abs(fallen.x).mul(0.25)))) as any;
  const drift = foot.mul(0.6).add(broad.w.mul(0.05)).max(0.01) as any;
  const isLeaf = fallenShape.mul(smoothstep(float(1).sub(drift), float(1).sub(drift).add(0.04), fallen.w)).mul(resolved(world, 11)) as any;
  const leafColour = mix(mix(color("#6b4a1f"), color("#9a7a2c"), fract(fallen.w.mul(17.3))), color("#3b2a17"), smoothstep(0.6, 1, fract(fallen.w.mul(5.1)))) as any;

  let ground: any = mix(gravel, earth, bed);
  ground = mix(ground, moss, fringe.mul(smoothstep(-0.4, 0.4, broad.z)).mul(0.6));
  ground = mix(ground, grass, grassy.mul(0.85));
  ground = mix(ground, leafColour, isLeaf);
  const grassHeight = blades.x.mul(0.0025).mul(fineBlades).mul(grassy) as any;
  const leafHeight = isLeaf.mul(0.002).add(isLeaf.mul(abs(fallen.y)).mul(0.01)) as any;
  material.normalNode = bumped(mix(gravelHeight, clods.mul(0.012), bed).mul(float(1).sub(grassy.mul(0.7))).add(grassHeight).add(leafHeight));
  material.colorNode = fading(air, ground);
  material.roughnessNode = mix(mix(mix(float(0.86), float(0.97), bed), float(0.8), grassy), float(0.65), isLeaf);
  material.outputNode = vec4(throughMist(air, (output as any).rgb), 1) as any;
  return material;
}

// The evening sky, which at the horizon is exactly the mist's colour, so the maze has no edge to it.
export function skyMaterial(air: Air) {
  const material = made(new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false }), false);
  material.name = "sky";
  const direction = normalize(positionWorld.sub(cameraPosition)) as any;
  const up = direction.y as any;
  const toward = max(dot(direction, air.sun), float(0)) as any;
  const horizon = mistColour(air, direction);
  const sky = mix(horizon, air.zenith, smoothstep(0.02, 0.55, up).mul(0.85)) as any;
  const sun = (air.glow as any).mul(pow(toward, float(2400)).mul(6).mul(air.disc).add(pow(toward, float(220)).mul(0.5)).add(pow(toward, float(14)).mul(0.12))) as any;
  // High thin cloud, streaked out by the wind, lit pink and gold from below on the sun's side and going grey-blue away
  // from it. Laid on a flat sheet overhead, so it crowds together toward the horizon, where it is lost in the haze.
  const sheet = direction.xz.div(up.max(0.04)).mul(vec2(0.35, 1.1)) as any;
  const drift = sheet.add(vec2(time.mul(0.004), 0)) as any;
  const body = fractal2(drift, 220, 4) as any;
  const wisps = noise2(drift.mul(vec2(1, 3)), 900).x as any;
  const cloud = smoothstep(air.cloudCover, air.cloudCover.add(0.35), body.add(wisps.mul(0.12))).mul(smoothstep(0.03, 0.2, up)).mul(air.cloudOpacity) as any;
  const lit = mix(air.cloudShade, mix(air.cloudLit, air.cloudGlow, pow(toward, float(4))), pow(toward, float(1.5)).mul(0.9).add(0.1)) as any;
  // Stars, one to a cell of a grid round the sky, most cells empty, twinkling; and the moon with a halo round it.
  const field = direction.mul(160) as any;
  const star = hash43(floor(field)) as any;
  const twinkle = sin(time.mul(star.w.mul(3).add(1)).add(star.x.mul(40))).mul(0.3).add(0.7) as any;
  const stars = smoothstep(0.16, 0.04, length(fract(field).sub(star.xyz.mul(0.6).add(0.2))))
    .mul(smoothstep(0.93, 0.99, star.w))
    .mul(twinkle)
    .mul(smoothstep(0.05, 0.3, up))
    .mul(air.stars)
    .mul(float(1).sub(cloud)) as any;
  const facing = max(dot(direction, air.moonAt), float(0)) as any;
  const moon = smoothstep(0.99985, 0.99992, facing).mul(1.6).add(pow(facing, float(300)).mul(0.25)).add(pow(facing, float(18)).mul(0.05)).mul(air.moon) as any;
  material.colorNode = mix(sky, lit, cloud)
    .add(sun.mul(float(1).sub(cloud.mul(0.7))))
    .add(vec3(stars.mul(1.4)))
    .add(color("#d8e0f0").mul(moon.mul(float(1).sub(cloud.mul(0.6)))));
  return material;
}

// Sprigs that have grown out since the last clipping, as small cards standing out of a hedge's surface, which give its
// edges and top the fuzz no smooth surface can. They are made in the hedge's own frame and drawn with the same instances.
export function sprigGeometry(x: number, z: number, density: number, seed: number) {
  const random = mulberry32(seed);
  const ax = x / 2;
  const az = z / 2;
  const positions: number[] = [];
  const uvs: number[] = [];
  const roots: number[] = [];
  const normals: number[] = [];
  const index: number[] = [];
  const root = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const up = new THREE.Vector3();
  const side = new THREE.Vector3();
  const add = () => {
    // Sprigs lean upward and outward, each its own way.
    up.copy(normal).multiplyScalar(0.8).add(new THREE.Vector3(random() - 0.5, random() - 0.5 + 0.55, random() - 0.5).multiplyScalar(0.9)).normalize();
    side.set(random() - 0.5, random() - 0.5, random() - 0.5).cross(up).normalize();
    const width = 0.07 + random() * 0.06;
    const height = 0.07 + random() * 0.07;
    const base = positions.length / 3;
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ]) {
      positions.push(
        root.x - normal.x * 0.025 + side.x * (u - 0.5) * width + up.x * v * height,
        root.y - normal.y * 0.025 + side.y * (u - 0.5) * width + up.y * v * height,
        root.z - normal.z * 0.025 + side.z * (u - 0.5) * width + up.z * v * height
      );
      uvs.push(u, v);
      roots.push(root.x, root.y, root.z);
      normals.push(normal.x, normal.y, normal.z);
    }
    index.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  };
  // Over the top, thickest along its edges, then down the sides, thinning toward the ground.
  const top = Math.round(x * z * density * 1.6);
  for (let i = 0; i < top; i++) {
    const edge = random() < 0.55;
    const across = edge ? (random() < 0.5 ? -1 : 1) * (0.78 + random() * 0.22) : random() * 2 - 1;
    const along = random() * 2 - 1;
    const lengthwise = x >= z;
    root.set(lengthwise ? along * ax : across * ax, HEIGHT - (edge ? 0.06 : 0), lengthwise ? across * az : along * az);
    normal.set(lengthwise ? 0 : across * 0.6, 1, lengthwise ? across * 0.6 : 0).normalize();
    if (!edge) normal.set(0, 1, 0);
    add();
  }
  for (const [nx, nz, span] of [
    [0, 1, x],
    [0, -1, x],
    [1, 0, z],
    [-1, 0, z]
  ]) {
    const count = Math.round(span * HEIGHT * density * 0.22);
    for (let i = 0; i < count; i++) {
      const y = HEIGHT - 0.12 - Math.pow(random(), 1.6) * (HEIGHT - 0.25);
      const along = (random() * 2 - 1) * (nx ? az : ax);
      root.set(nx ? nx * ax : along, y, nz ? nz * az : along);
      normal.set(nx, 0, nz);
      add();
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("aRoot", new THREE.Float32BufferAttribute(roots, 3));
  geometry.setAttribute("aSurface", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

export function sprigMaterial(air: Air) {
  // As little sheen as the hedge, or each sprig facing the low sun flashes like a drop of water.
  const material = made(new THREE.MeshPhysicalNodeMaterial({ roughness: 0.7, metalness: 0, specularIntensity: 0.3, side: THREE.DoubleSide, alphaTest: 0.5 }));
  const { turn, at: place, world } = placement();
  const rootLocal = attribute("aRoot", "vec3") as any;
  const surface = attribute("aSurface", "vec3") as any;
  const root = place(rootLocal);
  const v = uv().y as any;
  // Each sprig stirs a little in the evening air, more at its tip.
  const stir = sin(time.mul(1.7).add(root.x.mul(1.3)).add(root.z.mul(0.9))).mul(0.006).mul(v) as any;
  // Further off they shrink back into the hedge, where they would only be a costly shimmer.
  const near = smoothstep(17, 11, length(world(rootLocal).sub(cameraPosition))) as any;
  const card = positionGeometry.sub(rootLocal).mul(near).add(rootLocal) as any;
  shape(material, card.add(surface.mul(swellAt(root, surface.y))).add(vec3(stir, 0, stir.mul(0.6))));

  // A spray of small leaves, cut out of the card: the same leaves as on the hedge, kept inside a rounded outline.
  const own = hash4(floor(root.xz.mul(97.3))).x as any;
  const cell = leaves(uv().mul(vec2(3.2, 3)).add(own.mul(17)), float(4096), float(Math.PI / 2), float(2.6)) as any;
  const blade = float(1).sub(smoothstep(0, 0.55, leafLength(cell, 1.9))).add(cell.x.mul(cell.w.sub(0.5)).mul(1.6)) as any;
  const outline = float(1).sub(length(uv().sub(vec2(0.5, 0.42)).mul(vec2(2.1, 1.9)))) as any;
  material.opacityNode = blade.mul(0.9).add(outline.mul(1.2)).sub(0.35) as any;

  // Lit as the hedge around it is, turned a little each leaf, so a sprig never shows itself as a flat card.
  const facing = normalize(turn(surface).add(vec3(cell.w.sub(0.5), cell.x.mul(0.5), own.sub(0.5)).mul(0.9))) as any;
  material.normalNode = normalize(toView(facing)) as any;
  const height = root.y as any;
  const kind = smoothstep(-0.35, 0.45, fractal2(root.xz, 4, 2).mul(1.6)) as any;
  const colour = leafGreen(cell.w, smoothstep(0.4, 1, v.mul(0.7).add(own.mul(0.5))).mul(0.85), kind).mul(1.5) as any;
  material.colorNode = fading(air, colour.mul(v.mul(0.6).add(0.4)).mul(smoothstep(0.2, 1.2, height).mul(0.5).add(0.5)));
  material.roughnessNode = mix(float(0.78), float(0.6), cell.w) as any;
  const view = normalize(positionWorld.sub(cameraPosition)) as any;
  const behind = pow(max(dot(view, air.sun), float(0)), float(5)) as any;
  material.emissiveNode = (air.sunColour as any).mul(color("#8db232")).mul(behind.mul(v).mul(smoothstep(HEIGHT - 0.5, HEIGHT, height)).mul(air.backlight).mul(0.5));
  material.outputNode = vec4(throughMist(air, (output as any).rgb), 1) as any;
  return material;
}
