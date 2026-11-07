import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  abs,
  clamp,
  color,
  cross,
  dFdx,
  dFdy,
  dot,
  faceDirection,
  float,
  floor,
  fract,
  fwidth,
  min,
  instanceIndex,
  length,
  mix,
  normalGeometry,
  normalView,
  normalize,
  normalWorld,
  cameraPosition,
  pow,
  positionGeometry,
  positionLocal,
  positionView,
  positionWorld,
  sign,
  sin,
  smoothstep,
  step,
  texture3D,
  uniform,
  varying,
  vec3,
  vec4
} from "three/tsl";
import { JUICE_LEVEL, dentsNode, insideCavity, insideSkin, stoneRidgeNode } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model swizzles or every operator. */

// What every material shares: where the blade is, how wet things are, and the block of baked noise.
export type Blade = { normal: any; depth: any; along: any; down: any; time: any; juice: any; field: THREE.Data3DTexture; inverse: any };

export const newBlade = (field: THREE.Data3DTexture): Blade => ({
  normal: uniform(new THREE.Vector3(1, 0, 0)),
  depth: uniform(10),
  along: uniform(new THREE.Vector3(0, 0, 1)),
  down: uniform(new THREE.Vector3(0, -1, 0)),
  time: uniform(0),
  juice: uniform(1),
  field,
  inverse: uniform(new THREE.Matrix4())
});

// Everything is measured in the peach's own space, because the peach bobs on the sea.
const fromMiddle = (blade: Blade): any => blade.inverse.mul(vec4(positionWorld, 1)).xyz;

export const uncut = (blade: Blade) => (dot(fromMiddle(blade), blade.normal) as any).lessThan(blade.depth);

function cut<T extends THREE.NodeMaterial>(material: T, blade: Blade) {
  material.maskNode = uncut(blade);
  material.maskShadowNode = uncut(blade);
  return material;
}

// Soft noise from about -1 to 1, and cells from 0 at a cell's centre to about 1 at its edge. A frequency is cells per unit.
// Turned off the grid, and for clouds looked up twice at unrelated scales, so that the block's repeat never shows as a weave.
const turned = (p: any): any => vec3(p.x.mul(0.8).add(p.y.mul(0.36)).add(p.z.mul(0.48)), p.y.mul(0.8).sub(p.x.mul(0.6)), p.z.mul(0.8).add(p.x.mul(-0.12)).sub(p.y.mul(0.58)));
const cloud = (blade: Blade, p: any): any => (texture3D(blade.field, turned(p).div(4)) as any).g.add((texture3D(blade.field, turned(turned(p)).mul(0.341).add(0.37)) as any).g).sub(1).mul(2.3);
const cloud2 = (blade: Blade, p: any): any => (texture3D(blade.field, turned(p).div(4)) as any).b.add((texture3D(blade.field, turned(turned(p)).mul(0.341).add(0.71)) as any).b).sub(1).mul(2.3);
const cells = (blade: Blade, p: any): any => (texture3D(blade.field, turned(p).div(8)) as any).r;
// Cells with no pattern to find: their positions are pushed about by soft noise, and two unrelated sets are combined.
const scattered = (blade: Blade, d: any, frequency: number): any => {
  const push = vec3(cloud(blade, d.mul(5.1)), cloud2(blade, d.mul(5.1)), cloud(blade, d.mul(3.7).add(4.4))).mul(0.16);
  const moved = d.add(push);
  return min(cells(blade, moved.mul(frequency)), cells(blade, turned(moved).mul(frequency * 0.731).add(2.9)).add(0.08));
};

// Bump mapping from any height, by Mikkelsen's method, with no texture needed.
export function bumped(height: any, scale: number | any) {
  const sx = dFdx(positionView);
  const sy = dFdy(positionView);
  const r1 = cross(sy, normalView);
  const r2 = cross(normalView, sx);
  const det = (dot(sx, r1) as any).mul(faceDirection);
  const h = (height as any).mul(scale);
  const gradient = sign(det).mul(r1.mul(dFdx(h)).add(r2.mul(dFdy(h))));
  return normalize(abs(det).mul(normalView).sub(gradient));
}

// Finer than a pixel, detail only flickers. This fades it out before it gets there.
const resolved = (p: any, frequency: number): any => float(1).sub(smoothstep(0.3, 0.9, (length(fwidth(p)) as any).mul(frequency)));

// The colour of the skin: yellow in the shade, and a speckled, streaked red blush where the sun reached it.
const skinColour = (blade: Blade, d: any, sample: (p: any) => any): any => {
  const sun: any = dot(d, normalize(vec3(-0.72, 0.34, 0.6)));
  const noise = (p: any) => sample(p.div(4)).g.sub(0.5).mul(3.2);
  const broad = noise(d.mul(1.7).add(4.1));
  const streak = noise(vec3(d.x.mul(13), d.y.mul(1.3), d.z.mul(13)));
  const fleck = noise(d.mul(90));
  const blush: any = smoothstep(-0.18, 0.95, sun.mul(0.95).add(broad.mul(0.34)).add(streak.mul(0.16)).add(fleck.mul(0.07)));
  const ground = mix(color("#ffd257"), color("#ffa342"), smoothstep(-0.9, 0.35, sun.add(noise(d.mul(2.6)).mul(0.4))));
  const rosy = mix(color("#f56a4c"), color("#c8283c"), smoothstep(0.35, 1, blush));
  const skin = mix(ground, rosy, smoothstep(0, 0.8, blush).mul(0.94));
  // Bruises where the dents are, and a scatter of small dark spots.
  const bruise: any = smoothstep(0.012, 0.07, (dentsNode(d) as any).add(noise(d.mul(7)).mul(0.012)));
  const spots: any = smoothstep(0.78, 0.98, noise(d.mul(27)).add(noise(d.mul(83)).mul(0.3)));
  return mix(mix(skin, color("#9a5a2e"), bruise.mul(0.42)), color("#6a3a1e"), spots.mul(0.62));
};

// Two ends on the sphere for each scratch: a peach that hung on a tree and got knocked about a little.
const SCRATCHES: [number, number, number, number, number, number][] = [
  [0.62, 0.42, 0.66, 0.5, 0.2, 0.84],
  [-0.2, 0.3, 0.93, -0.36, 0.17, 0.92],
  [0.86, -0.1, 0.5, 0.92, -0.26, 0.3],
  [-0.78, -0.36, 0.5, -0.66, -0.5, 0.56],
  [0.14, -0.62, 0.77, 0.32, -0.7, 0.64],
  [-0.1, 0.1, -0.99, 0.18, 0.2, -0.96],
  [0.44, 0.74, -0.5, 0.56, 0.62, -0.55]
];

export function skinMaterial(blade: Blade) {
  const material = cut(new THREE.MeshPhysicalNodeMaterial({ sheen: 0.32, sheenRoughness: 0.88, sheenColor: new THREE.Color("#ffc791"), specularIntensity: 0.28 }), blade);
  const d = normalize(fromMiddle(blade)) as any;
  const sample = (p: any) => texture3D(blade.field, p) as any;
  const pores = scattered(blade, d, 140);
  const specks: any = float(1).sub(smoothstep(0.04, 0.12, pores)).mul(smoothstep(0, 0.4, cloud(blade, d.mul(9)))).mul(resolved(d, 140));
  const near: any = float(1).sub(smoothstep(0.84, 0.985, d.y));
  // Hairline scratches, each slightly wandering, and a few patches where the skin has been rubbed dull.
  const shake = vec3(cloud(blade, d.mul(31)), cloud2(blade, d.mul(31)), cloud(blade, d.mul(31).add(5))).mul(0.0036);
  let scratch: any = float(0);
  for (const [ax, ay, az, bx, by, bz] of SCRATCHES) {
    const a = vec3(ax, ay, az);
    const line = vec3(bx - ax, by - ay, bz - az);
    const along: any = clamp((dot(d.add(shake).sub(a), line) as any).div(dot(line, line)), 0, 1);
    const off = length(d.add(shake).sub(a.add(line.mul(along))));
    scratch = scratch.max(float(1).sub(smoothstep(0.0009, 0.0034, off)).mul(smoothstep(0, 0.1, along)).mul(smoothstep(1, 0.86, along)));
  }
  const scuff: any = smoothstep(0.72, 0.98, cloud(blade, d.mul(4.3).add(2.3))).mul(smoothstep(-0.1, 0.5, cloud2(blade, d.mul(70))));
  const worn = scratch.max(scuff.mul(0.55));
  const coloured = mix(mix(color("#b8a044"), skinColour(blade, d, sample), near) as any, color("#ffdf8f"), specks.mul(0.5));
  material.colorNode = mix(coloured, color("#b28a5e"), worn.mul(0.72));
  material.roughnessNode = mix(float(0.84), float(0.95), worn);
  const grain = cloud(blade, d.mul(380)).mul(0.5).mul(resolved(d, 380)).add(cloud2(blade, d.mul(960)).mul(0.3).mul(resolved(d, 960)));
  // The dimples: broad, shallow pits all over, with the finest pores inside them.
  const dimples = smoothstep(0.02, 0.62, scattered(blade, d, 37)).mul(0.62);
  const fine = smoothstep(0.03, 0.2, pores).mul(0.14).mul(resolved(d, 140));
  const pucker = (sin(d.x.mul(110).add(d.z.mul(70))) as any).mul(float(1).sub(near)).mul(0.5).mul(resolved(d, 110));
  material.normalNode = bumped(grain.mul(0.14).add(dimples.mul(0.62)).add(fine).add(pucker).sub(scratch.mul(0.5)), 0.0034);
  return material;
}

// Fuzz, as stacked shells: the same skin repeated further and further out, each keeping less of every hair than the last.
export function fuzzMaterial(blade: Blade, levels: any, fine: boolean) {
  const material = cut(new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 }), blade);
  const through = float(instanceIndex).add(1).div(levels);
  const level = varying(through) as any;
  const start = normalize(positionGeometry) as any;
  const root = varying(start) as any;
  const vertexNoise = (p: any) => (texture3D(blade.field, p) as any).level(0);
  // Worked out at the vertices, because a shell's colour hardly changes across a hair.
  const tint = varying(skinColour(blade, start, vertexNoise)) as any;
  // Hairs lean over and wander as they rise, in a pattern that changes slowly across the skin.
  const lean = varying(vec3(sin(start.y.mul(5.1).add(start.z.mul(3.3))).mul(0.5).sub(start.z.mul(0.45)), float(-0.8), sin(start.x.mul(4.3).add(start.y.mul(6.7))).mul(0.5).add(start.x.mul(0.45)))) as any;
  // A straight grid of hairs cut by a sphere shows as rings, so the roots are pushed about, by more than a few hairs' width.
  const shove = varying(vec3(vertexNoise(start.mul(0.53).add(0.1)).g, vertexNoise(start.mul(0.53).add(0.4)).b, vertexNoise(start.mul(0.41).add(0.7)).g).sub(0.5).mul(0.34).add(vec3(vertexNoise(start.mul(1.9)).b, vertexNoise(start.mul(2.3).add(0.2)).g, vertexNoise(start.mul(1.7).add(0.5)).b).sub(0.5).mul(0.07))) as any;
  material.positionNode = positionLocal.add(normalGeometry.mul(through.mul(0.104).add(0.0012)));
  const strand = (frequency: number, thickness: number, rise: number, salt: number): any => {
    const q = turned(root.add(shove).add(salt)).mul(frequency).add(lean.mul(level).mul(level).mul(rise));
    const cell = floor(q);
    const pick = (add: number): any => fract((sin((dot(cell as any, vec3(127.1, 311.7, 74.7)) as any).add(add)) as any).mul(43758.5453));
    const height = pick(0);
    const centre = vec3(pick(1.3), pick(2.7), pick(4.1)).sub(0.5).mul(0.62);
    const off = length(fract(q).sub(0.5).sub(centre));
    const tall = height.mul(1.12).sub(0.12);
    return step(level, tall).mul(step(off, float(thickness).mul(float(1).sub(level.div(tall.max(0.01))).mul(0.88).add(0.12))));
  };
  // Further off than a hair's width, single hairs only sparkle. There the shells close into a soft haze of the skin's own
  // colour, which is far cheaper as well: nothing below works out a hair unless it could be seen as one.
  const close: any = float(1).sub(smoothstep(0.42, 1.5, (length(fwidth(root)) as any).mul(620)));
  material.opacityNode = Fn(() => {
    const kept = (step(level, float(0.42)) as any).mul(float(1).sub(close)).toVar() as any;
    If(close.greaterThan(0.01), () => {
      kept.addAssign(fine ? strand(700, 0.27, 2.2, 0).add(strand(250, 0.08, 1.4, 3.7)) : strand(380, 0.3, 1.8, 0));
    });
    return kept.clamp(0, 1);
  })() as any;
  material.alphaTest = 0.5;
  material.colorNode = mix(tint.mul(1.08), color("#fff6dd"), level.mul(0.8).add(0.1).mul(close.mul(0.9).add(0.08)));
  // Fine hairs scatter light at a glancing angle, which is most of why fuzz looks soft.
  const glance: any = float(1).sub(clamp(dot(normalWorld, normalize(cameraPosition.sub(positionWorld))), 0, 1));
  material.emissiveNode = (color("#ffdcae") as any).mul((pow(glance, float(3)) as any).mul(level).mul(0.3));
  return material;
}

// Flesh, for the cut face and the walls of the hollow alike, so that they meet without a join. It follows a real halved
// peach: dark red bleeding out from the stone, a pale fibrous band beyond that, then gold, and orange under the skin.
const flesh = (q: any, fromSkin: any, fromHollow: any, blade: Blade): any => {
  const toward: any = clamp(fromHollow.div(fromHollow.add(fromSkin).max(0.001)), 0, 1);
  const d = normalize(q) as any;
  const out = length(q) as any;
  // Stretched outward from the middle, as the fibres run from the stone to the skin.
  const fibres = cloud(blade, d.mul(30).add(out.mul(0.3)));
  const threads = cloud2(blade, d.mul(84).add(out.mul(0.46)));
  const hairline = cloud(blade, d.mul(210).add(out.mul(0.9)));
  const bleed: any = smoothstep(0.34, 0.02, toward.add(fibres.mul(0.07)).add(threads.mul(0.05)).add(hairline.mul(0.016)));
  const golden = mix(color("#ff9d1e"), color("#ffc445"), smoothstep(0.92, 0.5, toward.add(fibres.mul(0.1))));
  const pale: any = smoothstep(0.1, 0.34, toward).mul(smoothstep(0.72, 0.36, toward.add(fibres.mul(0.07)))).mul(smoothstep(-0.65, 0.5, threads.add(fibres.mul(0.5))));
  const bright = mix(golden, color("#ffe7ae"), pale.mul(0.78));
  const bloody = mix(color("#ea4a2c"), color("#930d2b"), smoothstep(0.35, 0.95, bleed.add(hairline.mul(0.08))));
  const body = mix(bright, bloody, smoothstep(0.1, 0.72, bleed));
  const under: any = smoothstep(0.13, 0, fromSkin.sub(fibres.mul(0.035)));
  // Pulp is thousands of tiny bags of juice, each catching the light, and a scatter of little cream flecks.
  const big = cells(blade, q.mul(6.5));
  const small = cells(blade, q.mul(21));
  const tiny = cells(blade, q.mul(64));
  const micro = cells(blade, q.mul(190));
  const height: any = (big as any).mul(-0.14).add(small.mul(-0.07).mul(resolved(q, 21))).add(tiny.mul(-0.02).mul(resolved(q, 64))).add(micro.mul(-0.006).mul(resolved(q, 190))).add(threads.mul(0.026).mul(resolved(d, 84))).add(hairline.mul(0.007).mul(resolved(d, 210)));
  const gleam = float(1).sub(smoothstep(0.04, 0.3, big)).mul(blade.juice);
  const flecks: any = float(1).sub(smoothstep(0.03, 0.1, tiny)).mul(smoothstep(0.15, 0.55, cloud(blade, q.mul(2.7)))).mul(float(1).sub(bleed)).mul(resolved(q, 64));
  const colour = mix(mix(body, color("#ec3f2b"), under.mul(0.66)), color("#fff0c8"), flecks.mul(0.6));
  return { colour, height, toward, gleam };
};

const syrupColour = (blade: Blade, q: any): any => {
  const swirl = cloud(blade, (vec3(q.x.mul(1.6).add(blade.time.mul(0.04)), q.y.mul(3.4), q.z.mul(1.6)) as any).add(cloud2(blade, q.mul(1.1)).mul(0.9)));
  return mix(mix(color("#ffb01e"), color("#f7760f"), smoothstep(-0.7, 0.2, swirl)), color("#c9142a"), smoothstep(0.1, 0.72, swirl));
};

export function cutMaterial(blade: Blade) {
  const material = new THREE.MeshPhysicalNodeMaterial({ metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.22 });
  const q = fromMiddle(blade);
  const skin = insideSkin(q);
  const hollow: any = insideCavity(q);
  material.maskNode = skin.lessThan(0).and(hollow.greaterThan(0).or(q.y.lessThan(JUICE_LEVEL)));
  const fromSkin = skin.negate().max(0);
  const fromHollow = hollow.max(0);
  const pulp = flesh(q, fromSkin, fromHollow, blade);
  const inJuice = step(hollow, float(0)) as any;
  const bubbles = float(1).sub(smoothstep(0.03, 0.1, cells(blade, q.mul(11).add(vec3(0, blade.time.negate().mul(0.5), 0))))).mul(step(0.2, cloud(blade, q.mul(2.6))));
  const down = clamp(q.y.sub(JUICE_LEVEL).negate().div(0.75), 0, 1);
  const syrup = mix(syrupColour(blade, q), color("#8f2208"), down.mul(0.55)).add(bubbles.mul(0.3));
  const skinLine = float(1).sub(smoothstep(0.016, 0.04, fromSkin));
  material.colorNode = mix(mix(pulp.colour, color("#a8152b"), skinLine), syrup, inJuice);
  const lip = smoothstep(0, 0.14, fromHollow).mul(0.045).add(smoothstep(0, 0.07, fromSkin).mul(0.018));
  material.normalNode = bumped(mix(pulp.height.mul(0.075).add(lip), cloud(blade, q.mul(5).add(blade.time.mul(0.2))).mul(0.006), inJuice), 1);
  material.roughnessNode = mix(mix(float(0.24), float(0.07), pulp.gleam.mul(0.6).clamp(0, 1)), float(0.05), inJuice);
  // Light soaks through the flesh, so the thin parts glow.
  const soak: any = smoothstep(1.1, 0, fromSkin);
  material.emissiveNode = mix(pulp.colour.mul(soak.mul(0.24).add(0.1)), syrup.mul(0.34), inJuice);
  return material;
}

export function hollowMaterial(blade: Blade) {
  const material = cut(new THREE.MeshPhysicalNodeMaterial({ metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.18 }), blade);
  const q = fromMiddle(blade);
  const pulp = flesh(q, insideSkin(q).negate().max(0), float(0.02), blade);
  const below = smoothstep(JUICE_LEVEL + 0.02, JUICE_LEVEL - 0.02, q.y);
  material.colorNode = mix(pulp.colour, color("#c1450c"), below);
  const streak = cloud(blade, vec3(q.x.mul(9), q.y.mul(1.2).add(blade.time.mul(0.03)), q.z.mul(9)));
  const wet: any = (smoothstep(0, 0.55, streak) as any).mul(blade.juice);
  material.roughnessNode = mix(float(0.34), float(0.14), wet.add(pulp.gleam.mul(0.3)).clamp(0, 1));
  material.normalNode = bumped(pulp.height.mul(0.09), 1);
  material.emissiveNode = pulp.colour.mul(0.2);
  return material;
}

// Sits in stone space, because the stone moves. Ridges are tan and dry on top, and the grooves are dark and full of red juice.
export function stoneMaterial(blade: Blade) {
  const material = new THREE.MeshPhysicalNodeMaterial({ metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.2 });
  const p = positionGeometry as any;
  const ridge: any = stoneRidgeNode(normalize(p));
  const noise = cloud(blade, p.mul(13));
  const pits = cells(blade, p.mul(26));
  const ground = mix(color("#4a1a0e"), mix(color("#8a4120"), color("#c78a55"), smoothstep(-0.5, 0.8, noise.add(pits.mul(0.8)))), smoothstep(0.34, 0.86, ridge));
  material.colorNode = mix(color("#2b0509"), ground, smoothstep(0.03, 0.42, ridge));
  material.roughnessNode = mix(float(0.16), float(0.62), smoothstep(0.2, 0.85, ridge));
  material.normalNode = bumped(noise.mul(0.012).add(pits.mul(0.018).mul(resolved(p, 26))).add(cloud2(blade, p.mul(70)).mul(0.004).mul(resolved(p, 70))), 1);
  return material;
}

// Tendrils stick out past the blade when they are pulled, so they are never cut by it.
export function strandMaterial(blade: Blade) {
  const material = new THREE.MeshPhysicalNodeMaterial({ metalness: 0, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.06 });
  const q = fromMiddle(blade);
  const seam = cloud(blade, q.mul(2.3));
  material.colorNode = mix(mix(color("#ffb136"), color("#f0601c"), smoothstep(-0.6, 0.15, seam)), color("#a8112a"), smoothstep(0.05, 0.6, seam));
  material.emissiveNode = mix(color("#b0480f"), color("#6e0a18"), smoothstep(-0.2, 0.5, seam)).mul(0.34);
  return material;
}

// The surface of the juice in the hollow. The drops that land make the rings.
export function poolMaterial(blade: Blade, rings: any[]) {
  const material = new THREE.MeshPhysicalNodeMaterial({ transparent: true, roughness: 0.1, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.14 });
  const q = fromMiddle(blade);
  material.maskNode = uncut(blade).and(insideCavity(q).lessThan(0));
  let height: any = cloud(blade, vec3(q.x.mul(1.4), blade.time.mul(0.1), q.z.mul(1.4))).mul(0.03);
  for (const ring of rings) {
    const reach: any = length(q.xz.sub(ring.xy));
    const age = blade.time.sub(ring.z);
    const crest = sin(reach.mul(30).sub(age.mul(13)));
    const faded = ring.w.mul(smoothstep(age.mul(2.4).add(0.08), age.mul(2.4), reach)).mul(float(1).sub(smoothstep(0, 3.2, age))).mul(float(1).sub(smoothstep(0, 1.6, reach)));
    height = height.add(crest.mul(faded).mul(0.03));
  }
  material.normalNode = bumped(height, 1);
  const shallow: any = smoothstep(-0.34, -0.02, insideCavity(q));
  material.colorNode = mix(mix(color("#9c1f0a"), color("#c0550a"), smoothstep(-0.4, 0.5, cloud(blade, q.mul(1.4).add(blade.time.mul(0.03))))), syrupColour(blade, q), shallow);
  material.opacityNode = mix(float(0.74), float(0.94), shallow);
  material.emissiveNode = mix(color("#5a1c02"), color("#d9600c"), shallow).mul(0.42);
  return material;
}

// A soft dark shadow on the wall where a strand grows out of it, with the flesh a little darker and redder around it.
export function rootMaterial(blade: Blade) {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const reach = (length((positionGeometry as any).xy) as any).mul(2);
  const wobble = cloud(blade, fromMiddle(blade).mul(6)).mul(0.12);
  const fall = smoothstep(1, 0.08, reach.add(wobble)) as any;
  material.colorNode = mix(color("#6a0c20"), color("#26050d"), smoothstep(0.3, 0.95, fall)) as any;
  material.opacityNode = fall.mul(fall).mul(0.42) as any;
  material.maskNode = uncut(blade);
  return material;
}

export function dropMaterial() {
  return new THREE.MeshPhysicalNodeMaterial({ roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, emissive: new THREE.Color("#8a2b08"), emissiveIntensity: 0.4 });
}

export function stemMaterial(blade: Blade) {
  const material = cut(new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.82 }), blade);
  const bark = cloud(blade, (positionGeometry as any).mul(vec3(12, 2.4, 12)));
  material.colorNode = mix(color("#3d2a14"), color("#7c5a2b"), smoothstep(-0.5, 0.6, bark));
  material.normalNode = bumped(bark.mul(0.03), 1);
  return material;
}

export function leafMaterial(blade: Blade) {
  const material = cut(new THREE.MeshPhysicalNodeMaterial({ metalness: 0, roughness: 0.42, side: THREE.DoubleSide, clearcoat: 0.35, clearcoatRoughness: 0.4 }), blade);
  const u = (positionGeometry as any).x;
  const v = (positionGeometry as any).z;
  const veins = abs(sin(u.mul(26).add(abs(v).mul(16))));
  const rib: any = smoothstep(0.024, 0.006, abs(v));
  const side: any = smoothstep(0.1, 0, veins);
  material.colorNode = mix(mix(color("#2f6a22"), color("#5c9630"), smoothstep(-0.5, 0.6, cloud(blade, (positionGeometry as any).mul(4)))), color("#a7c95c"), rib.add(side.mul(0.45)).clamp(0, 1));
  material.normalNode = bumped(side.mul(-0.015).add(rib.mul(-0.03)), 1);
  material.emissiveNode = color("#1f4d12").mul(0.14);
  return material;
}
