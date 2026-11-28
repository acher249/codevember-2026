import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  length,
  reflect,
  select,
  clamp,
  dFdx,
  dFdy,
  dot,
  float,
  floor as floor_,
  fract,
  fwidth,
  hash,
  max,
  min,
  mix,
  mx_noise_float,
  mx_noise_vec3,
  normalize,
  normalWorld,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  texture,
  texture3D,
  transformNormalToView,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vertexStage
} from "three/tsl";
import { loadRetried } from "../shared/engine/retry";
import { BACKDROP_BACK, CAVERNS, SIZE } from "./field";
import { MASK } from "./world";
import { floorNoiseAtVertices, forestFloorLook } from "./forest/floor";
import { outdoorLights } from "./forest/lights";
import { lamp, TORCH_LIGHTS, torchLights } from "./fx";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The rock's look. Outside, a weathered granite wall (the grain of Poly Haven's Rock Face 03, its colour painted); where
// it has been dug, freshly broken rock (Rock Face) coloured by the bed it lies in: pale fresh granite near the face,
// blue-grey shale deeper in, and a dark wet layer deepest. Everything is projected from the world's three axes (triplanar), so the
// texture never stretches over the dug shapes.

const ROOT = "/assets/27-burrow";

async function load(name: string, colour: boolean) {
  const tex = await loadRetried(new THREE.TextureLoader(), `${ROOT}/${name}`);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export async function loadTextures() {
  const [granite, graniteNormal, cliff, cliffNormal, broken, ground, groundNormal, bark, barkNormal, oldLeaves, oldLeavesNormal, moss] = await Promise.all([
    load("rock_face_03_diff_2k.jpg", true),
    load("rock_face_03_nor_gl_2k.jpg", false),
    load("cliff_side_diff_2k.jpg", true),
    load("cliff_side_nor_gl_2k.jpg", false),
    load("rock_face_diff_2k.jpg", true),
    load("dry_decay_leaves_diff_2k.jpg", true),
    load("dry_decay_leaves_nor_gl_2k.jpg", false),
    load("pine_bark_diff_2k.jpg", true),
    load("pine_bark_nor_gl_2k.jpg", false),
    load("forest_leaves_02_diffuse_1k.jpg", true),
    load("forest_leaves_02_nor_gl_1k.jpg", false),
    load("moss_diff_1k.jpg", true)
  ]);
  return { granite, graniteNormal, cliff, cliffNormal, broken, ground, groundNormal, bark, barkNormal, oldLeaves, oldLeavesNormal, moss };
}
export type Textures = Awaited<ReturnType<typeof loadTextures>>;

// Shared by the rock and anything that lights it.
// The nearest lights of whatever the dug caverns hold (fungi, a camp's lantern, molten rock), as position and
// strength and colour, for their light on the rock round them (dressing.tsx fills them).
export const nearGlow = {
  count: 8,
  place: uniformArray(
    Array.from({ length: 8 }, () => new THREE.Vector4(0, -1000, 0, 0)),
    "vec4"
  ) as any,
  colour: uniformArray(
    Array.from({ length: 8 }, () => new THREE.Color(0, 0, 0)),
    "color"
  ) as any
};

export const rockUniforms = {
  // How open each cavern is, in CAVERNS order: 0 sealed, easing to 1 after the breakthrough with a flare of light on
  // the way (its glow then lights its own walls).
  opened: uniformArray(CAVERNS.map(() => 0)) as any,
  time: uniform(0) as any,
  // Where the grotto was broken into, and how long ago: its glow-worms wake in a wave spreading from there.
  breach: uniform(new THREE.Vector3()) as any,
  since: uniform(-1000) as any
};

// How brightly the nearest torches light a point (a single number, for glints).
export function torchLightAt(p: any) {
  let sum = float(0) as any;
  for (let k = 0; k < TORCH_LIGHTS; k++) {
    const t = torchLights.element(k) as any;
    const to = t.xyz.sub(p) as any;
    sum = sum.add(t.w.div(dot(to, to).mul(0.4).add(0.3)));
  }
  return sum as any;
}

// Still water's mirror of the lights near it: each torch and glowing thing a small crisp image where the view, bounced
// off the water, looks back at it. Cheap: no second render, only the few lights that matter.
export function waterGlints(p: any, normal: any) {
  const toEye = normalize(cameraPosition.sub(p)) as any;
  const bounced = reflect(toEye.negate(), normal) as any;
  let sum = vec3(0) as any;
  for (let k = 0; k < TORCH_LIGHTS; k++) {
    const t = torchLights.element(k) as any;
    const to = t.xyz.sub(p) as any;
    const d = length(to) as any;
    // The flame itself, small and sharp, in a faint warm haze.
    const facing = max(dot(bounced, to.div(d)), 0) as any;
    const hit = pow(facing, float(4000))
      .mul(18)
      .add(pow(facing, float(120)).mul(0.5)) as any;
    sum = sum.add(vec3(1.0, 0.6, 0.25).mul(hit.mul(t.w)));
  }
  for (let k = 0; k < nearGlow.count; k++) {
    const g = nearGlow.place.element(k) as any;
    const to = g.xyz.sub(p) as any;
    const d = length(to) as any;
    const hit = pow(max(dot(bounced, to.div(d)), 0), float(160)) as any;
    sum = sum.add(nearGlow.colour.element(k).mul(hit.mul(g.w).mul(3)));
  }
  return sum as any;
}

// Biplanar (after Inigo Quilez): only the two projections the surface faces most squarely, two taps instead of three,
// with no visible difference since the third's weight is all but nothing once the weights are sharpened. The pair
// changes from pixel to pixel, so each tap takes its gradients from `dp` (the position's screen derivatives, taken
// once, where every pixel runs them).
type Derivatives = { dx: any; dy: any };
function biplanar(map: THREE.Texture, p: any, scale: number, n: any, dp: Derivatives) {
  const a = abs(n) as any;
  const ma = select(a.x.greaterThan(a.y).and(a.x.greaterThan(a.z)), float(0), select(a.y.greaterThan(a.z), float(1), float(2))) as any;
  const mi = select(a.x.lessThan(a.y).and(a.x.lessThan(a.z)), float(0), select(a.y.lessThan(a.z), float(1), float(2))) as any;
  const me = float(3).sub(ma).sub(mi) as any;
  const pick2 = (k: any, v: any) => select(k.equal(0), v.zy, select(k.equal(1), v.xz, v.xy)) as any;
  const pick1 = (k: any) => select(k.equal(0), a.x, select(k.equal(1), a.y, a.z)) as any;
  const q = p.mul(scale) as any;
  const dx = dp.dx.mul(scale) as any;
  const dy = dp.dy.mul(scale) as any;
  const tap = (k: any) => texture(map, pick2(k, q)).grad(pick2(k, dx), pick2(k, dy)) as any;
  let w = clamp(
    vec2(pick1(ma), pick1(me))
      .sub(0.5773)
      .div(1 - 0.5773),
    0,
    1
  ) as any;
  w = w.mul(w).mul(w).mul(w);
  w = w.div(w.x.add(w.y).add(1e-5));
  return tap(ma).mul(w.x).add(tap(me).mul(w.y)) as any;
}

// The normal map from each axis, laid onto the surface by the whiteout blend.
export function triplanarNormal(map: THREE.Texture, p: any, scale: number, n: any, w: any, strength: number | any) {
  const s = p.mul(scale) as any;
  const tx = texture(map, s.zy)
    .xyz.mul(2)
    .sub(1)
    .mul(vec3(strength, strength, 1)) as any;
  const ty = texture(map, s.xz)
    .xyz.mul(2)
    .sub(1)
    .mul(vec3(strength, strength, 1)) as any;
  const tz = texture(map, s.xy)
    .xyz.mul(2)
    .sub(1)
    .mul(vec3(strength, strength, 1)) as any;
  const v3 = vec3 as any;
  const nx = v3(abs(tx.z).mul(n.x), tx.y.add(n.y), tx.x.add(n.z)) as any;
  const ny = v3(ty.x.add(n.x), abs(ty.z).mul(n.y), ty.y.add(n.z)) as any;
  const nz = v3(tz.x.add(n.x), tz.y.add(n.y), abs(tz.z).mul(n.z)) as any;
  return normalize(nx.mul(w.x).add(ny.mul(w.y)).add(nz.mul(w.z))) as any;
}

// The weights for the three projections, sharpened so each face takes mostly one.
export function weights(n: any) {
  const a = pow(abs(n), vec3(4)) as any;
  return a.div(a.x.add(a.y).add(a.z).add(1e-5)) as any;
}

// The scale of the one detail layer (a tile every 2.7 m, the granite scan's own size).
const DETAIL = 1 / 2.7;
// How much stronger the face's normal map is from 32 m on than up close (1.3).
const RELIEF_FAR = 0.9;

// Fresh granite where it is broken open near the face: paler than the weathered wall, grey, cream and a little salmon.
const SAND = [
  [0.62, 0.61, 0.58],
  [0.55, 0.55, 0.54],
  [0.68, 0.63, 0.57],
  [0.5, 0.5, 0.5],
  [0.72, 0.69, 0.64],
  [0.6, 0.56, 0.52]
];

// The open face, as a granite wall in the Sierra reads from its foot (El Capitan, the Cathedral Rocks): a pale grey
// stone, speckled close up (white feldspar and quartz, black flecks of biotite, a few salmon crystals), warmer and
// cooler over tens of metres. Black and tan streaks of desert varnish run straight down it from the rim and from
// under ledges and roofs, in sheaves; fresh scars where slabs have fallen are paler and a little salmon; rusty iron
// stains bleed from some cracks. Up close, lichen in crusts and rosettes (pale grey-green, black, now and then
// chartreuse), a few thin wandering fractures, moss and grass on every ledge top, and damp darker rock under the roofs.
// The deep cracks and corners are the field's own (field.ts `faceZ`): the face darkens into them by `open`.
// The fine work runs only within NEAR metres of the eye.
// Worked out only where `skin` (the undug face) is above nothing. `n` is the surface's own normal, `rough` the
// broken-rock scan's grain (already fetched for the dug rock; it breaks up the granite scan's repeat at no cost).
const NEAR = 26;
// The granite scan's mean light (linear luminance), so its grain multiplies about 1.
const SCAN_MEAN = 0.156;
// Where the face's streaks gather in sheaves (about 10 m across) and how their lines wander (tens of metres): slow
// enough to be worked out per vertex even on the far backdrop's coarsest rows. faceLook's `slow` is these two.
const streakNoise = (p: any) => [mx_noise_float(vec2(p.x.mul(0.09).add(p.z.mul(0.09)), p.y.mul(0.012).add(5))), mx_noise_float(vec2(p.y.mul(0.05), p.x.mul(0.02)))];
function faceLook(p: any, scan: any, rough: any, macroTone: any, skin: any, n: any, dp: Derivatives, open: any, slow: any) {
  // Slow fields, per vertex: the broad hue and tone, the fresh scars, and where streaks come down in sheaves.
  const broad = vertexStage(vec3(mx_noise_float(vec2(p.x.mul(0.035), p.y.mul(0.05))), mx_noise_float(p.mul(0.03).add(40)), mx_noise_float(p.mul(0.07).add(70)))) as any;
  // And where the lichen grows (x) and which kind (y), where the face is fractured (z), over a metre or three.
  const life = vertexStage(vec3(mx_noise_float(p.mul(0.38).add(11)), mx_noise_float(p.mul(0.21).add(90)), mx_noise_float(p.mul(0.3).add(130)))) as any;
  return Fn(() => {
    const out = vec3(0).toVar("face") as any;
    If(skin.greaterThan(0.001), () => {
      // The scan's grain, grey: its light and dark only, a little stronger than it is, its brown left out.
      const lum = dot(scan, vec3(0.3, 0.55, 0.15)).div(SCAN_MEAN) as any;
      const grain = mix(float(1), clamp(lum, 0.3, 2), 0.75).mul(mix(float(1), clamp(rough, 0.5, 1.6), life.y.mul(0.15).add(0.25))) as any;
      // Pale grey stone, warmer (tan) in some stretches and cooler in others, lighter and darker over tens of metres.
      const warm = smoothstep(-0.5, 0.6, broad.x) as any;
      const hue = mix(vec3(0.93, 0.97, 1.03), vec3(1.07, 1.0, 0.88), warm) as any;
      let rock = vec3(0.3, 0.295, 0.28)
        .mul(hue)
        .mul(broad.y.mul(0.16).add(1))
        .mul(mix(float(0.9), float(1.08), macroTone))
        .mul(grain) as any;
      // Fresh scars where slabs have come away: paler, a little salmon, not yet streaked.
      const scar = smoothstep(0.38, 0.6, broad.z) as any;
      rock = mix(rock, vec3(0.44, 0.39, 0.33).mul(grain), scar.mul(0.75)) as any;
      // Streaks straight down the face, in sheaves a few metres wide: black varnish, and tan where iron has run.
      const sheaf = smoothstep(-0.25, 0.35, slow.x) as any;
      const fall = p.x.add(p.z.mul(0.7)).add(slow.y.mul(1.2)) as any;
      const black = smoothstep(0.1, 0.55, mx_noise_float(vec2(fall.mul(1.3), p.y.mul(0.03)))).mul(sheaf).mul(float(1).sub(scar)) as any;
      const tan = smoothstep(0.25, 0.65, mx_noise_float(vec2(fall.mul(0.8).add(31), p.y.mul(0.025)))).mul(float(1).sub(scar.mul(0.7))) as any;
      rock = mix(rock, rock.mul(vec3(1.1, 0.86, 0.64)), tan.mul(0.55)) as any;
      rock = mix(rock, rock.mul(vec3(0.2, 0.2, 0.21)), black.mul(0.85)) as any;
      // Into the field's own cracks and corners: darker, stained and in shadow of their walls.
      rock = rock.mul(mix(float(0.35), float(1), smoothstep(0.15, 0.85, open))) as any;
      // Up close: the stone's crystals, a few thin fractures, and the fine edge of each crust of lichen and tuft of moss.
      const fine = float(0).toVar("faceFine") as any;
      const speckle = vec3(1).toVar("faceSpeckle") as any;
      const cracks = float(0).toVar("faceCracks") as any;
      const seen = cameraPosition.sub(p).length() as any;
      If(seen.lessThan(NEAR), () => {
        const fadeOut = float(1).sub(smoothstep(NEAR - 8, NEAR, seen)) as any;
        fine.assign(mx_noise_float(p.mul(8.5)).mul(fadeOut));
        // A pixel's size in metres, from the position's derivatives taken where every pixel runs them.
        const px = max(length(dp.dx), length(dp.dy)) as any;
        // Crystals about a centimetre across: most pale, some black, a few salmon; gone before they would shimmer.
        const crystal = hash(dot(floor_(p.mul(85)) as any, vec3(1, 157, 113)) as any) as any;
        const sharp = float(1).sub(smoothstep(0.004, 0.012, px)).mul(fadeOut) as any;
        const fleck = mix(
          mix(vec3(1), vec3(1.25, 1.22, 1.18), step(0.72, crystal)),
          vec3(0.25, 0.24, 0.24),
          step(0.91, crystal)
        ).mul(mix(vec3(1), vec3(1.2, 0.95, 0.85), step(0.86, crystal).mul(step(crystal, 0.91)))) as any;
        speckle.assign(mix(vec3(1), fleck, sharp.mul(0.6)));
        // Thin fractures: zero crossings of one slow noise, stretched upright and wandering, only in some patches,
        // a few millimetres wide, fading before they would be thinner than a pixel.
        const line = abs(mx_noise_float(p.mul(vec3(0.8, 0.3, 0.8)).add(vec3(broad.x.mul(2), 0, life.z)))) as any;
        const w = px.mul(1.2) as any;
        const thin = float(1).sub(smoothstep(0, w.add(0.012), line)).mul(float(1).sub(smoothstep(0.03, 0.09, w))) as any;
        cracks.assign(thin.mul(smoothstep(0.15, 0.45, life.z)).mul(fadeOut));
      });
      rock = rock.mul(speckle).mul(float(1).sub(cracks.mul(0.5))) as any;
      // Lichen: crusts on the steep rock, not the ledge tops, thinner where the streaks are dark.
      const steep = float(1).sub(smoothstep(0.45, 0.8, abs(n.y))) as any;
      const crust = smoothstep(0.3, 0.52, life.x.add(fine.mul(0.32)).add(grain.sub(1).mul(0.1))).mul(steep).mul(float(1).sub(black.mul(0.6))) as any;
      const kind = life.y.add(fine.mul(0.1)) as any;
      const lichen = mix(mix(vec3(0.035, 0.035, 0.032), vec3(0.36, 0.38, 0.31), smoothstep(-0.5, -0.36, kind)), vec3(0.42, 0.45, 0.1), smoothstep(0.45, 0.55, kind)).mul(
        grain.mul(0.3).add(0.7)
      ) as any;
      rock = mix(rock, lichen, crust.mul(0.7)) as any;
      // Under the roofs: damp and darker, a green film on it.
      const under = smoothstep(-0.25, -0.7, n.y) as any;
      rock = mix(rock, rock.mul(vec3(0.45, 0.52, 0.42)), under.mul(0.8)) as any;
      // On the ledge tops and the domes: moss in the hollows, dry grass and needles over it, edges ragged.
      const top = smoothstep(0.5, 0.78, n.y.add(life.x.mul(0.18)).add(fine.mul(0.12))) as any;
      const mossy = mix(vec3(0.03, 0.055, 0.014), vec3(0.11, 0.15, 0.035), smoothstep(-0.4, 0.5, fine).mul(grain.mul(0.4).add(0.6))) as any;
      const straw = vec3(0.26, 0.2, 0.1).mul(grain.mul(0.5).add(0.5)) as any;
      const growth = mix(mossy, straw, smoothstep(-0.2, 0.4, life.y.add(fine.mul(0.3)))) as any;
      out.assign(mix(rock, growth, top.mul(0.9)));
    });
    return out;
  })() as any;
}

// `cut`: for the plain cliff and ground beyond the meshed chunks, which hide themselves wherever a chunk is drawn.
// `low` (the Low tier): no normal map, no occlusion-roughness map, no fine grain and no glints; half the fetches.
// `groundOnly`: for the far ground ring, never cliff and never dug: the forest floor alone, none of the rock's work.
// `lit`: the lights it takes (three's `lights([...])`) in place of every light in the scene, for chunks that need fewer.
export function createRockMaterial(t: Textures, cut?: THREE.Data3DTexture, low = false, groundOnly = false, lit?: THREE.LightsNode) {
  const m = new THREE.MeshStandardNodeMaterial();
  m.shadowSide = THREE.DoubleSide;
  if (lit) m.lightsNode = lit;
  // The plain cliff and ground beyond the chunks are never underground and lie metres from any torch or the headlamp:
  // lit by the sun and the sky alone (forest/lights.ts), not by every light in the scene (ten, with the torches, the
  // headlamp and the lake's chimney spot, each a loop per pixel).
  if (cut) m.lightsNode = outdoorLights;
  const info = attribute("aInfo", "vec3") as any;
  const depth = info.x as any;
  const open = info.y as any;
  const groundness = info.z as any;
  const p = positionWorld as any;
  const n = normalize(normalWorld) as any;
  const w = weights(n);
  // Hidden where the chunk holding the true surface is drawn (world.ts `MASK`): the chunk's own surface is there
  // instead. The true surface lies a little out from this one (BACKDROP_BACK), toward the air, and may be over a
  // chunk's edge from it: it is that chunk that decides, or a sliver of sky shows through at the edge.
  // Hidden only where both this point's chunk and the true surface's (a little out toward the air) are drawn. If
  // either is not, it stays: drawn 15 cm behind a real surface it is hidden anyway, and where the true surface's chunk
  // is not drawn it is all there is. (Where the two lie in different chunks and only one was drawn, testing one alone
  // left a sliver of sky along the seam.)
  if (cut) {
    const cellOf = (q: any) =>
      floor_(q.div(SIZE))
        .add(0.5)
        .div(vec3(MASK.x, MASK.y, MASK.z)) as any;
    const here = texture3D(cut, cellOf(p), 0).r as any;
    const surface = texture3D(cut, cellOf(p.add(n.mul(BACKDROP_BACK))), 0).r as any;
    m.maskNode = min(here, surface).lessThan(0.5) as any;
  }
  if (groundOnly) {
    const floor = forestFloorLook({ litter: t.ground, litterNormal: t.groundNormal, farLitter: t.oldLeaves, farLitterNormal: t.oldLeavesNormal, moss: t.moss }, p);
    m.colorNode = floor.colour;
    m.roughnessNode = float(0.92);
    m.metalnessNode = float(0);
    m.aoNode = clamp(open, 0, 1) as any;
    m.normalNode = transformNormalToView(normalize(n.add(floor.tilt))) as any;
    return m;
  }

  // Broad changes in tone over metres, so the scans never show their repeat.
  // (One fetch, slanted across all three axes: at this scale nobody sees the stretch.)
  const macro = texture(t.broken, p.xz.add(p.y.mul(0.7)).div(13)).rgb as any;
  const macroTone = dot(macro, vec3(0.33)).div(0.32) as any;

  // The weathered face.
  // One detail layer for the face and the dug rock both, at one scale, so its maps share their coordinates. Read through
  // a slow wander of world space (a dozen metres across, worked out per vertex), so its repeat never lines up into the
  // grid of ledges and seams a straight tiling draws over a whole cliff.
  const q = p.add(vertexStage(mx_noise_vec3(p.mul(0.08)).mul(0.9))) as any;
  const dp: Derivatives = { dx: dFdx(q), dy: dFdy(q) };
  const cliffScan = biplanar(t.granite, q, DETAIL, n, dp).rgb as any;
  // Occlusion and roughness of the face from the scan's own light and dark (its crevices are its darkest parts),
  // rather than three more taps of its ARM map.
  const scanLight = dot(cliffScan, vec3(0.3, 0.55, 0.15)) as any;
  const arm = vec3(smoothstep(0.08, 0.4, scanLight).mul(0.55).add(0.45), float(0.92).sub(scanLight.mul(0.15)), 0) as any;

  // The beds, dipping into the cliff (field.ts `strata`), their edges wavering, each of its own thickness.
  const b = p.y
    .add(p.x.mul(0.03))
    .add(p.z.mul(0.22))
    .add(sin(p.x.mul(0.7).add(p.z.mul(0.5))).mul(0.12))
    .add(sin(p.x.mul(2.3).sub(p.z.mul(1.9))).mul(0.04)) as any;
  const bb = b.mul(1.7).add(sin(b.mul(0.9)).mul(0.7)) as any;
  const bed = floor_(bb) as any;
  const tint = (k: any) => {
    const pick = hash(k.add(37)) as any;
    let c = vec3(...(SAND[0] as [number, number, number])) as any;
    for (let j = 1; j < SAND.length; j++) c = mix(c, vec3(...(SAND[j] as [number, number, number])), step(j / SAND.length, pick)) as any;
    return c;
  };
  // Neighbouring beds meet over a few centimetres, never in a ruled line.
  const sand = mix(tint(bed), tint(bed.add(1)), smoothstep(0.9, 1, fract(bb))) as any;
  // Broken rock up close: the scan's own layering at a finer scale for detail, the broken-rock scan for grain.
  const layered = cliffScan;
  const lay = dot(layered, vec3(0.3, 0.5, 0.2)).div(0.6) as any;
  const broken = (low ? macro : biplanar(t.broken, p, 1 / 1.8, n, dp).rgb) as any;
  const grain = dot(broken, vec3(0.33)).div(0.3) as any;
  const detail = lay.mul(0.75).add(grain.mul(0.25)) as any;
  // Shale splits into thin leaves: fine dark laminations a few centimetres apart.
  // Faded out where they would come closer together than a couple of pixels (they shimmer and ring into a moire
  // there), and on flat floors, where a gentle undulation through dozens of laminae draws them as contour rings.
  const laminaPhase = b.mul(150) as any;
  const laminaSharp = float(1)
    .sub(smoothstep(0.25, 0.9, fwidth(laminaPhase).div(6.283)))
    .mul(float(1).sub(smoothstep(0.2, 0.45, abs(n.y)))) as any;
  const leaves = sin(laminaPhase.add(grain.mul(1.5)))
    .mul(0.5)
    .mul(laminaSharp)
    .add(0.5) as any;
  const shale = vec3(0.25, 0.255, 0.27)
    .mul(float(0.93).add(leaves.mul(0.1)))
    .mul(detail.mul(0.55).add(0.45)) as any;
  const wetRock = vec3(0.08, 0.066, 0.056).mul(detail.mul(0.5).add(0.5)) as any;
  const sandRock = sand.mul(detail.mul(0.8).add(0.2)).mul(0.8) as any;
  const sandAmount = smoothstep(-0.8, -0.3, b) as any;
  const wetAmount = float(1).sub(smoothstep(-4.1, -3.5, b)) as any;
  let inner = mix(mix(shale, sandRock, sandAmount), wetRock, wetAmount) as any;
  // The geode's shell: a rind of finely banded white and grey agate round its hollow, as the cut rim of one shows.
  const geode = CAVERNS.find((c) => c.kind === "geode") as (typeof CAVERNS)[number];
  const fromGeode = p.sub(vec3(...geode.centre)).length() as any;
  const rind = float(1).sub(smoothstep(geode.size[0] + 0.15, geode.size[0] + 0.75, fromGeode)) as any;
  const agate = mix(
    vec3(0.5, 0.5, 0.53),
    vec3(0.9, 0.89, 0.9),
    pow(
      sin(fromGeode.mul(70).add(grain.mul(2)))
        .mul(0.5)
        .add(0.5),
      float(3)
    )
  ).mul(grain.mul(0.2).add(0.8)) as any;
  // Inside it, the wall itself is a druse of tiny points between the crystals: smoky violet, glinting in the lamp.
  const druse = float(1).sub(smoothstep(geode.size[0] - 0.1, geode.size[0] + 0.25, fromGeode)) as any;
  const speck = hash(dot(floor_(p.mul(140)) as any, vec3(1, 157, 113)) as any) as any;
  const amethyst = mix(vec3(0.16, 0.12, 0.2), vec3(0.42, 0.34, 0.52), speck).mul(grain.mul(0.4).add(0.6)) as any;
  inner = mix(mix(inner, agate, rind), amethyst, druse) as any;

  // Dug rock (anything behind the original face) takes the inner colours; a dug lip blends over a few centimetres.
  const fresh = smoothstep(0.06, 0.4, depth) as any;
  // Floors deep in are damp in patches.
  const puddle = smoothstep(0.65, 0.9, n.y)
    .mul(smoothstep(2.5, 6, depth))
    .mul(smoothstep(0.95, 1.2, macroTone)) as any;
  const wet = max(wetAmount, puddle).mul(fresh) as any;
  // Standing water: the flattest low floors deep in, in patches, are pools gone still as glass.
  const pool = smoothstep(0.93, 0.975, n.y)
    .mul(smoothstep(2, 4, depth))
    .mul(smoothstep(1.0, 1.1, macroTone))
    .mul(fresh) as any;
  // Where the outer surface was the ground rather than the cliff, it looks like the ground (until dug into).
  const onGround = groundness.mul(float(1).sub(fresh)) as any;
  // On the chunks (20 cm vertices) the floor's noises are worked out per vertex, only within a metre of the original
  // surface (where any floor or undug face that shows lies), with the face's streak noises in the same varyings; the
  // backdrop never shows floor, so it carries the streak noises alone.
  const atVertices = cut ? null : floorNoiseAtVertices(p, depth.lessThan(1), streakNoise(p));
  const slow = atVertices ? vec2(atVertices.extra[0], atVertices.extra[1]) : (vertexStage(vec2(...(streakNoise(p) as [any, any]))) as any);
  const floor = forestFloorLook({ litter: t.ground, litterNormal: t.groundNormal, farLitter: t.oldLeaves, farLitterNormal: t.oldLeavesNormal, moss: t.moss }, p, onGround, atVertices?.noise);
  const face = faceLook(p, cliffScan, grain, macroTone, float(1).sub(fresh).mul(float(1).sub(onGround)), n, dp, open, slow);
  // Underground only: water running down the dug walls in streaks, and wet patches on the floors (matching the glassy
  // tops of the fallen rock in dressing.tsx). One noise, worked out only where the sky does not reach.
  const runs = Fn(() => {
    const out = float(0).toVar("runs") as any;
    If(float(1).sub(smoothstep(0.5, 3.6, depth)).lessThan(0.97), () => {
      const down = smoothstep(0.62, 0.9, mx_noise_float(vec3(p.x.mul(2.6), p.y.mul(0.22), p.z.mul(2.6))))
        .mul(float(1).sub(abs(n.y)))
        .mul(0.85) as any;
      const floorWet = smoothstep(0.7, 0.95, n.y).mul(smoothstep(0.95, 1.15, macroTone)).mul(0.5) as any;
      out.assign(down.add(floorWet).min(1).mul(fresh));
    });
    return out;
  })() as any;
  m.colorNode = mix(mix(face, inner.mul(float(1).sub(wet.mul(0.35))).mul(float(1).sub(runs.mul(0.3))), fresh), floor.colour, onGround).mul(float(1).sub(pool.mul(0.6))) as any;
  m.roughnessNode = mix(
    mix(mix(arm.g.mul(1.05), mix(mix(mix(mix(float(0.88), float(0.24), wet), float(0.16), runs), float(0.32), rind), speck.mul(0.3).add(0.08), druse), fresh), float(0.92), onGround),
    float(0.03),
    pool
  ) as any;
  m.metalnessNode = float(0);
  // Light from the sky, which reaches only a few metres down a tunnel; and the crevices.
  const sky = float(1).sub(smoothstep(0.5, 3.6, depth)) as any;
  m.aoNode = clamp(mix(arm.r, float(1), max(fresh, onGround)).mul(open).mul(sky.mul(0.96).add(0.04)), 0, 1) as any;
  // The face's relief stronger with distance, where the normal map's mips have smoothed it flat (dug rock as it was).
  const relief = float(1.3).add(smoothstep(8, 32, cameraPosition.sub(p).length()).mul(float(1).sub(fresh)).mul(RELIEF_FAR)) as any;
  const rockNormal = low ? n : triplanarNormal(t.graniteNormal, q, DETAIL, n, w, relief);
  // The ground's own detail tilts its normal round the surface's, so it follows the slope of the land.
  const normal = normalize((mix as any)(mix(rockNormal, normalize(n.add(floor.tilt)), onGround), vec3(0, 1, 0), pool)) as any;
  m.normalNode = transformNormalToView(normal) as any;

  // Light held underground, worked out only where the sky does not reach (the open face and the forest floor skip it).
  // The glows of the caverns and what they hold change over metres, so they are summed at the vertices (every 20 cm)
  // and carried across the triangles, with the surface's own normal, not per pixel.
  const sourceGlow = vertexStage(
    Fn(() => {
      const glow = vec3(0).toVar("sourceGlow") as any;
      If(sky.lessThan(0.97), () => {
        // An open cavern's own light on its walls (field.ts `CAVERNS`): the glow-worms', the geode's, the lake's.
        CAVERNS.forEach((c, k) => {
          if (!c.glow) return;
          // The grotto's light comes from its whole roof, so it is a ring of sources over it (a coarse grid of the worms'
          // light, as Spore's), each weaker; the others are one source each.
          const sources: [number, number, number][] = [c.glow.at];
          if (c.kind === "grotto")
            for (let j = 0; j < 6; j++) {
              const a = (j / 6) * Math.PI * 2 + 0.4;
              sources.push([c.glow.at[0] + Math.cos(a) * c.size[0] * 0.55, c.glow.at[1] - 0.35, c.glow.at[2] + Math.sin(a) * c.size[2] * 0.55]);
            }
          for (const at of sources) {
            const to = vec3(...at).sub(p) as any;
            const d2 = dot(to, to) as any;
            const facing = dot(n, normalize(to)).mul(0.5).add(0.5) as any;
            glow.addAssign(
              vec3(...c.glow.colour)
                .mul(rockUniforms.opened.element(k))
                .mul(facing)
                .div(d2.mul(c.glow.reach).add(1))
                .mul(c.glow.strength / Math.sqrt(sources.length))
            );
          }
        });
        // The light of what the dug caverns hold.
        for (let k = 0; k < nearGlow.count; k++) {
          const g = nearGlow.place.element(k) as any;
          const to = g.xyz.sub(p) as any;
          const d2 = dot(to, to) as any;
          const facing = dot(n, normalize(to)).mul(0.6).add(0.4) as any;
          glow.addAssign(nearGlow.colour.element(k).mul(g.w).mul(facing).div(d2.mul(0.35).add(0.6)));
        }
      });
      return glow;
    })()
  ) as any;
  const glow = Fn(() => {
    const glow = vec3(0).toVar("caveGlow") as any;
    glow.assign(sourceGlow);
    If(sky.lessThan(0.97), () => {
      // The lake throws the chimney's light back up its walls and roof as caustics, rippling with the water.
      const lake = CAVERNS.find((c) => c.kind === "lake") as (typeof CAVERNS)[number];
      const level = lake.water as number;
      const inLake = float(1)
        .sub(
          smoothstep(
            1.0,
            1.35,
            p
              .sub(vec3(...lake.centre))
              .div(vec3(...lake.size))
              .length()
          )
        )
        .mul(smoothstep(level - 0.05, level + 0.15, p.y)) as any;
      const clock = rockUniforms.time as any;
      const cu = p.xz.add(p.y.mul(0.35)).mul(1.3) as any;
      const wave = sin(
        cu.x
          .mul(3)
          .add(clock.mul(0.9))
          .add(sin(cu.y.mul(2.3).sub(clock.mul(0.6))).mul(1.6))
      ).add(
        sin(
          cu.y
            .mul(3.4)
            .sub(clock.mul(1.1))
            .add(sin(cu.x.mul(1.9).add(clock.mul(0.4))).mul(1.6))
        )
      ) as any;
      const caustic = pow(float(1).sub(abs(wave).mul(0.5)).max(0), float(7)) as any;
      const pool = vec3(...lake.glow!.at)
        .sub(p)
        .length() as any;
      glow.addAssign(
        vec3(1.0, 0.8, 0.6)
          .mul(caustic.mul(2.4).add(0.05))
          .mul(inLake)
          .mul(rockUniforms.opened.element(CAVERNS.indexOf(lake)))
          .div(pool.mul(pool).mul(0.18).add(1))
          .mul(0.55)
      );
    });
    return glow;
  })() as any;
  // Underground only: flecks of mica and quartz glinting as the light catches them, and in the still pools, the
  // torches and glows mirrored.
  const sparkle = Fn(() => {
    const out = vec3(0).toVar("sparkle") as any;
    If(sky.lessThan(0.97), () => {
      const cell = floor_(p.mul(38)) as any;
      const h = hash(dot(cell, vec3(1, 57, 113)) as any) as any;
      const toEye = normalize(cameraPosition.sub(p)) as any;
      const twinkle = pow(
        sin(
          rockUniforms.time
            .mul(h.mul(4).add(1.5))
            .add(h.mul(80))
            .add(dot(toEye, vec3(9, 13, 7)))
        ).max(0),
        float(24)
      ) as any;
      const near = lamp.position.sub(p) as any;
      const lit = lamp.strength.div(dot(near, near).mul(0.25).add(1)).add(torchLightAt(p).mul(0.6)) as any;
      If(h.greaterThan(low ? 2 : 0.994), () => {
        out.addAssign(vec3(1, 0.96, 0.88).mul(twinkle.mul(lit).mul(fresh).mul(9)));
      });
      If(pool.greaterThan(0.01), () => {
        out.addAssign(waterGlints(p, normal).mul(pool));
      });
    });
    return out;
  })() as any;
  m.emissiveNode = (m.colorNode as any).mul(glow).add(sparkle).mul(sky.oneMinus()) as any;
  return m;
}

// The forest floor before the cliff: scanned leaf litter (Poly Haven's Dry Decay Leaves), seen from above (world x and
// z as its coordinates), its normal map's tilt decoded in world space, darker and damper in patches.
function groundLook(t: Textures, p: any) {
  const uv = p.xz.div(2.4) as any;
  const macro = texture(t.broken, p.xz.div(19)).rgb as any;
  const tone = dot(macro, vec3(0.33)).div(0.32) as any;
  const scan = texture(t.ground, uv).rgb as any;
  const sand = scan.mul(vec3(0.95, 0.88, 0.8)).mul(mix(float(0.65), float(1.05), tone)) as any;
  // Fallen sandstone gathers at the foot of the face.
  const foot = float(1).sub(smoothstep(0.5, 6, p.z)) as any;
  const scree = texture(t.cliff, p.xz.div(2.2)).rgb.mul(0.85) as any;
  const tn = texture(t.groundNormal, uv).xyz.mul(2).sub(1) as any;
  return { colour: mix(sand, scree, foot.mul(0.6)) as any, tilt: vec3(tn.x.mul(1.1), 0, tn.y.mul(1.1)) as any };
}
