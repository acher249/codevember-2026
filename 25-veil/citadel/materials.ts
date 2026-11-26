import * as THREE from "three/webgpu";
import { abs, atan, cameraPosition, dot, exp, float, fract, max, min, mix, mx_noise_float, mx_worley_noise_float, normalize, positionWorld, pow, reflector, sin, smoothstep, step, vec2, vec3 } from "three/tsl";
import { bump } from "./bump";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The citadel's surfaces, all worked out from where each point is in the world, so a wall, a tower and a beam laid in
// the same stone line up course for course wherever they meet.

// A number from 0 to 1 that stays the same across a cell and jumps between cells.
export const hash = (v: any) => fract(sin(dot(v, vec2(12.9898, 78.233))).mul(43758.5453)) as any;

// Cast stone, as the fortress is built of: great blocks in courses, each poured on its own and a shade apart, the joints
// between them recessed and the block edges worn round and paler; the face pitted with small holes where the air was
// caught in the pour, and the faint lines of the shuttering it was cast against. Rain has run down it for centuries:
// dark streaks hang from the top of every block, and longer, heavier ones from under each ledge in `drips` (heights in
// metres), where water gathered and spilled. `u` picks which way the courses run: along x (a wall facing z), along z
// (a wall facing x), or both (anything turned).
// `ring` lays it instead as the voussoirs of an arch round that centre (in the wall's plane): joints running out from
// the centre, the courses going round it.
export function castStone(base: [number, number, number], { course = 2.4, block = 5.6, drips = [] as number[], grime = 1, u: along = "xz" as "x" | "z" | "xz", relief = 1, ring = null as [number, number, number] | null } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, side: ring ? THREE.DoubleSide : THREE.FrontSide });
  const p = positionWorld as any;
  const u = (along === "x" ? p.x : along === "z" ? p.z : p.x.add(p.z)) as any;
  const v = p.y as any;
  const toCentre = ring ? vec2(p.x.sub(ring[0]), p.y.sub(ring[1])) : null;
  const ju = (toCentre ? atan(toCentre.y, toCentre.x).mul(9.5) : u) as any;
  const jv = (toCentre ? toCentre.length() : v) as any;
  const row = jv.div(course) as any;
  const ri = row.floor() as any;
  const rf = row.fract() as any;
  // Joints staggered, but not by halves: each course shifted its own amount.
  const a = ju.div(block).add(hash(vec2(ri, 3.7)).mul(0.6).add(ri.mul(0.31))) as any;
  const ai = a.floor() as any;
  const af = a.fract() as any;
  const id = hash(vec2(ri, ai)) as any;
  // How far to the nearest joint, in metres, and above it (the top of the block is where the water runs from).
  const edge = min(min(rf, float(1).sub(rf)).mul(course), min(af, float(1).sub(af)).mul(block)) as any;
  const fromTop = float(1).sub(rf).mul(course) as any;
  const joint = float(1).sub(smoothstep(0.006, 0.016, edge)) as any;
  const arris = smoothstep(0.01, 0.05, edge) as any;
  // The shuttering: boards a third of a metre wide, laid level, a faint step at each.
  const board = v.div(0.32).fract() as any;
  const boardLine = smoothstep(0.0, 0.03, min(board, float(1).sub(board))) as any;
  // Air holes: small pits, many in some blocks, few in others.
  const worley = mx_worley_noise_float(p.mul(3.2)) as any;
  const pitMask = smoothstep(0.35, 0.75, mx_noise_float(p.mul(0.9)).mul(0.5).add(0.5).add(id.mul(0.3))) as any;
  const pit = float(1).sub(smoothstep(0.04, 0.11, worley)).mul(pitMask) as any;
  // Where the face has spalled: shallow scabs eaten into it, more near the joints.
  const scab = smoothstep(0.58, 0.72, mx_noise_float(p.mul(1.3)).mul(0.5).add(0.5).add(float(1).sub(smoothstep(0.0, 0.5, edge)).mul(0.12))) as any;
  // The face: slow swells of the pour, finer roughness, a grain of sand.
  const swell = mx_noise_float(p.mul(0.35)) as any;
  const rough = mx_noise_float(p.mul(4.5)) as any;
  const sand = mx_noise_float(p.mul(38)) as any;
  // Rain streaks: long thin runs, from the top of each block, and heavier from each ledge.
  const runs = mx_noise_float(vec3(ju.mul(2.8), v.mul(0.06), 1)).mul(0.6).add(mx_noise_float(vec3(ju.mul(11), v.mul(0.25), 4)).mul(0.4)) as any;
  // Some stretches of wall run with it and some are nearly clean.
  const wet = smoothstep(0.3, 0.75, mx_noise_float(vec3(ju.mul(0.13), v.mul(0.02), 9)).mul(0.5).add(0.5)) as any;
  const streak = smoothstep(0.05, 0.6, runs).mul(wet.mul(0.8).add(0.2)) as any;
  let stain = streak.mul(exp(fromTop.mul(-0.6))).mul(0.6).add(streak.mul(0.1)) as any;
  for (const h of drips) stain = stain.add(streak.mul(step(v, h)).mul(exp(v.sub(h).mul(0.07))).mul(1.1));
  stain = min(stain.mul(grime), 1);
  // Worn edges, chipped paler where the arris is broken.
  const chip = smoothstep(0.1, 0.6, mx_noise_float(p.mul(3.2)).mul(0.5).add(0.5)) as any;
  const wear = float(1).sub(arris).mul(chip).mul(float(1).sub(joint)) as any;
  // Large slow patches: some blocks have weathered darker and some bleached.
  const weather = mx_noise_float(p.mul(vec3(0.06, 0.03, 0.06))).mul(0.5).add(0.5) as any;
  const mottle = mx_noise_float(p.mul(vec3(0.9, 0.5, 0.9))).mul(0.6).add(mx_noise_float(p.mul(2.6)).mul(0.4)) as any;
  // Paler runs where lime has leached out and dried, here and there among the dark.
  const lime = smoothstep(0.62, 0.9, mx_noise_float(vec3(u.mul(1.3), v.mul(0.035), 7)).mul(0.5).add(0.5)) as any;
  let tone = vec3(...base)
    .mul(id.mul(0.2).add(0.88))
    .mul(mix(vec3(1.04, 1, 0.94), vec3(0.95, 0.98, 1.03), hash(vec2(ai, ri.add(5.1)))))
    .mul(weather.mul(0.45).add(0.78))
    .mul(swell.mul(0.08).add(1))
    .mul(mottle.mul(0.14).add(1))
    .mul(sand.mul(0.05).add(1)) as any;
  tone = mix(tone, tone.mul(0.3), stain);
  tone = mix(tone, tone.mul(vec3(1.12, 1.08, 1.02)), scab.mul(0.6));
  tone = mix(tone, tone.mul(1.3).add(0.02), lime.mul(float(1).sub(stain)).mul(0.5));
  tone = mix(tone, tone.mul(1.25), wear.mul(0.5));
  tone = tone.mul(float(1).sub(joint.mul(0.35))).mul(float(1).sub(pit.mul(0.45))).mul(boardLine.mul(0.05).add(0.95));
  material.colorNode = tone;
  material.roughnessNode = float(0.93).sub(stain.mul(0.18)).sub(id.mul(0.05)) as any;
  // Height in metres: the joint 2 cm down, the arris rounded, the pour and the pits.
  const height = arris
    .mul(0.012)
    .add(swell.mul(0.01))
    .add(rough.mul(0.006))
    .add(mottle.mul(0.006))
    .sub(scab.mul(0.012))
    .add(sand.mul(0.0005))
    .sub(pit.mul(0.012))
    .add(boardLine.mul(0.0008))
    .mul(relief) as any;
  material.normalNode = bump(height) as any;
  return material;
}

// The floor: great flags of dark polished stone, laid square, each a slightly different stone and none quite level, so
// the light in them breaks from flag to flag; worn duller where feet went, fine pale veins through some, the joints
// between them dull and dark, and a film of pale dust lying along the foot of the walls.
export function polishedFloor({ flag = 3.2, wallZ = -12, mirrorScale = 0.3 } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0 });
  const p = positionWorld as any;
  const gx = p.x.div(flag) as any;
  const gz = p.z.div(flag) as any;
  const cell = vec2(gx.floor(), gz.floor()) as any;
  const fx = gx.fract() as any;
  const fz = gz.fract() as any;
  const id = hash(cell) as any;
  const id2 = hash(cell.add(7.3)) as any;
  const edge = min(min(fx, float(1).sub(fx)), min(fz, float(1).sub(fz))).mul(flag) as any;
  const joint = float(1).sub(smoothstep(0.004, 0.012, edge)) as any;
  const arris = smoothstep(0.004, 0.035, edge) as any;
  // Veins: thin lines where a noise crosses zero, in some flags.
  const vn = mx_noise_float(vec3(p.x.mul(0.7).add(id.mul(30)), p.z.mul(0.9), id2.mul(9))) as any;
  const vein = float(1).sub(smoothstep(0.0, 0.02, abs(vn))).mul(step(0.6, id2)) as any;
  const cloud = mx_noise_float(p.mul(vec3(1.3, 1, 1.3))).mul(0.5).add(0.5) as any;
  // Where people walked: down the middle, toward the door.
  const path = exp(p.x.mul(p.x).div(-14)) as any;
  const scuff = smoothstep(0.2, 0.9, mx_noise_float(vec3(p.x.mul(3), p.z.mul(0.8), 2)).mul(0.5).add(0.5)) as any;
  const dust = smoothstep(4, 0.5, abs(p.z.sub(wallZ))).mul(smoothstep(0.3, 0.7, mx_noise_float(p.mul(1.6)).mul(0.5).add(0.5))) as any;
  let tone = vec3(0.05, 0.048, 0.045).mul(id.mul(0.55).add(0.7)).mul(cloud.mul(0.3).add(0.85)) as any;
  tone = mix(tone, vec3(0.1, 0.095, 0.09), vein.mul(0.35));
  tone = mix(tone, vec3(0.2, 0.18, 0.16), dust.mul(0.4));
  tone = tone.mul(float(1).sub(joint.mul(0.6)));
  material.colorNode = tone;
  const roughness = float(0.1)
    .add(id2.mul(0.12))
    .add(cloud.mul(0.06))
    .add(path.mul(scuff).mul(0.22))
    .add(dust.mul(0.5))
    .add(joint.mul(0.7))
    .min(1) as any;
  material.roughnessNode = roughness;
  // Each flag tilted a hair, so the reflections step at the joints.
  const tilt = fx.sub(0.5).mul(id.sub(0.5)).add(fz.sub(0.5).mul(id2.sub(0.5))).mul(0.006) as any;
  material.normalNode = bump(arris.mul(0.004).add(tilt).add(cloud.mul(0.0004))) as any;
  // What the polish shows: the place drawn upside down from under the floor, small, softened by how dull the stone is
  // there and shifted a little flag by flag; faint looking down, strong at a slant, as on any polished stone.
  const mirror = reflector({ resolutionScale: mirrorScale, generateMipmaps: true, bounces: false }) as any;
  mirror.target.rotateX(-Math.PI / 2);
  mirror.uvNode = mirror.uvNode.add(vec2(id.sub(0.5), id2.sub(0.5)).mul(0.006));
  const view = normalize(cameraPosition.sub(p)) as any;
  const fresnel = pow(float(1).sub(max(view.y, 0)), float(5)).mul(0.96).add(0.04) as any;
  const gloss = float(1).sub(smoothstep(0.1, 0.55, roughness)) as any;
  material.emissiveNode = mirror.level(roughness.mul(8).add(0.3)).rgb.mul(fresnel).mul(gloss).mul(0.9) as any;
  return { material, mirror };
}

// Bronze gone dark: near-black brown metal, its raised parts rubbed back to a dull warm shine, green-grey patina in the
// hollows and streaked down from them.
export function darkBronze({ scale = 1 } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.85 });
  const p = positionWorld.mul(scale) as any;
  const n = mx_noise_float(p.mul(1.7)).mul(0.5).add(0.5) as any;
  const fine = mx_noise_float(p.mul(22)) as any;
  const patina = smoothstep(0.55, 0.85, mx_noise_float(vec3(p.x.mul(2), p.y.mul(0.5), p.z.mul(2))).mul(0.5).add(0.5)) as any;
  const metal = vec3(0.2, 0.13, 0.075).mul(n.mul(0.5).add(0.7)) as any;
  material.colorNode = mix(metal, vec3(0.12, 0.13, 0.11), patina.mul(0.7));
  material.metalnessNode = mix(float(0.88), float(0.25), patina) as any;
  material.roughnessNode = float(0.38).add(n.mul(0.2)).add(patina.mul(0.35)).add(fine.mul(0.05)) as any;
  material.normalNode = bump(fine.mul(0.0006).add(n.mul(0.002))) as any;
  return material;
}

// The door: tall planks of dark timber standing on end, bound in bronze: a groove between plank and plank, the grain
// running up them, and inset in the leaf a pointed outline, a raised bronze strip following the edge of a tall gable.
// `centre` is the middle of the door's foot, `width` and `height` its leaf.
export function doorLeaf(centre: [number, number, number], width: number, height: number) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0 });
  const p = positionWorld as any;
  const x = p.x.sub(centre[0]) as any;
  const y = p.y.sub(centre[1]) as any;
  const plank = x.div(0.42).add(0.5) as any;
  const pi = plank.floor() as any;
  const pf = plank.fract() as any;
  const id = hash(vec2(pi, 1.3)) as any;
  const groove = float(1).sub(smoothstep(0.0, 0.05, min(pf, float(1).sub(pf)))) as any;
  const grain = mx_noise_float(vec3(x.mul(30).add(id.mul(10)), y.mul(0.6), id.mul(7))).mul(0.5).add(mx_noise_float(vec3(x.mul(90), y.mul(2), 3)).mul(0.3)) as any;
  // The gable: straight sides a little in from the edge, rising to a point near the top.
  const half = width / 2 - 0.45;
  const shoulder = height - 3.6;
  const peak = height - 0.7;
  const side = abs(abs(x).sub(half)).mul(step(y, shoulder)).add(step(shoulder, y).mul(999)) as any;
  // The slanted edge: distance to the line from the shoulder to the peak.
  const k = (peak - shoulder) / half;
  const slant = abs(y.sub(float(peak).sub(abs(x).mul(k)))).div(Math.sqrt(1 + k * k)).mul(step(shoulder, y)).add(step(y, shoulder).mul(999)) as any;
  const bottom = abs(y.sub(0.6)).add(step(half, abs(x)).mul(999)) as any;
  const outline = min(min(side, slant), bottom) as any;
  const strip = float(1).sub(smoothstep(0.06, 0.09, outline)).mul(step(0.4, y)) as any;
  // Iron bands across, low and high.
  const bandY = min(abs(y.sub(2.2)), abs(y.sub(height - 2.0))) as any;
  const band = float(1).sub(smoothstep(0.16, 0.19, bandY)) as any;
  const rivet = float(1).sub(smoothstep(0.03, 0.045, vec2(pf.sub(0.5).mul(0.42), bandY).length())).mul(band) as any;
  const metal = max(strip, band) as any;
  const wood = vec3(0.075, 0.048, 0.03).mul(id.mul(0.35).add(0.8)).mul(grain.mul(0.35).add(0.85)).mul(float(1).sub(groove.mul(0.7))) as any;
  const bronze = vec3(0.24, 0.16, 0.09).mul(mx_noise_float(p.mul(3)).mul(0.2).add(0.9)) as any;
  material.colorNode = mix(wood, bronze, metal);
  material.metalnessNode = metal.mul(0.85) as any;
  material.roughnessNode = mix(float(0.78).sub(grain.mul(0.1)), float(0.42), metal) as any;
  const height_ = grain.mul(0.0012).sub(groove.mul(0.012)).add(metal.mul(0.014)).add(rivet.mul(0.01)) as any;
  material.normalNode = bump(height_) as any;
  return material;
}

// What glows: a flat colour past white, unlit, for the lamp's globe and the slot of day.
export function glow(color: [number, number, number], fog = false) {
  const material = new THREE.MeshBasicNodeMaterial({ fog });
  material.colorNode = vec3(...color);
  return material;
}

// The ring's slots catch the light at their edges and are dark inside: a darker cast stone for their backs.
export function soot(base: [number, number, number]) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const p = positionWorld as any;
  material.colorNode = vec3(...base).mul(mx_noise_float(p.mul(2)).mul(0.15).add(0.9)).mul(pow(mx_noise_float(p.mul(9)).mul(0.5).add(0.5), float(0.3)));
  return material;
}
