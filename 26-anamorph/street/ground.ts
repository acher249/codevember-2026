/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { abs, acos, asin, atan, dot, exp, float, floor, Fn, fract, If, length, max, min, mix, mx_noise_float, normalMap, output, positionWorld, smoothstep, step, tan, texture, uniform, uniformArray, vec2, vec3, vec4 } from "three/tsl";
import { EYE } from "./drawings";
import { AWAY, BASE_COURSE, CURB, FRONT, NEAR, sidewalkFeet } from "./street";

// The sidewalk, and the drawing on it. The drawing's picture, taken from the artist's eye with the view's own lens and
// pixel grid (index.tsx), is laid on the sidewalk along that eye's sight lines. So from the eye each pixel of the
// drawing shows exactly the pixel of the real thing behind it, unlit and untouched: swapping one for the other there
// changes nothing on the screen. Away from the eye it shows as chalk: the concrete's pits and the joints come through.

// Big square flags of concrete, each its own shade, with narrow joints, the odd crack and damp patches.
const FLAG = 1.55;

// The worn concrete scan is the flags' grain; a dirty concrete scan stains them, a cracked one breaks some of them up,
// and a granular one roughens the surface into coarse aggregate.
export type Paving = { colour: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture; dirty: THREE.Texture; dirtyNormal: THREE.Texture; cracked: THREE.Texture; crackedNormal: THREE.Texture; granular: THREE.Texture };

// The strokes the chalk is drawn on and wiped off in (the sidewalk's shader and the tools in index.tsx both follow
// them): rows of arcs swung about a pivot behind the drawing's near end, like an arm. More rows for the chalk, fewer
// and broader for the eraser.
export const STROKES = { paint: 16, wipe: 9 };

// The pivot (x, z), the half angle of each swing, and the far radius, for a footprint x0, x1, z0, z1.
export function armFor(spread: THREE.Vector4, out = new THREE.Vector4()) {
  const half = (spread.y - spread.x) / 2;
  const reach = Math.max(1.1, half * 1.15);
  const pz = spread.w + reach;
  return out.set((spread.x + spread.y) / 2, pz, Math.atan2(half, reach), Math.hypot(half, pz - spread.z));
}

// The radius of a row of strokes about the arm's pivot: rows evenly spaced as the artist sees them, not on the ground.
function rowRadius(row: number, rows: number, spread: THREE.Vector4, arm: THREE.Vector4) {
  const rise = (r: number) => Math.atan(EYE.y / (r + EYE.z - arm.y));
  const [far, near] = [rise(arm.w), rise(arm.y - spread.w)];
  return EYE.y / Math.tan(far + ((row + 0.5) / rows) * (near - far)) - (EYE.z - arm.y);
}

// How far each row's swing goes, as angles about the pivot (x from, y to): from where its arc first crosses the
// drawing's outline to where it last does, a little past each, so the tool goes over the drawing and no further. A row
// whose arc misses the outline (past a narrow tip of it) swings as the nearest row that crosses it does.
export function strokeSpans(edge: THREE.Vector3[], spread: THREE.Vector4, arm: THREE.Vector4, rows: number, out: THREE.Vector4[]) {
  for (let row = 0; row < rows; row++) {
    const r = rowRadius(row, rows, spread, arm);
    let [from, to] = [Infinity, -Infinity];
    for (let i = 0, j = edge.length - 1; i < edge.length; j = i++) {
      // Where the circle of radius r about the pivot crosses this side of the outline.
      const [ax, az] = [edge[j].x - arm.x, edge[j].z - arm.y];
      const [dx, dz] = [edge[i].x - edge[j].x, edge[i].z - edge[j].z];
      const a = dx * dx + dz * dz;
      const b = 2 * (ax * dx + az * dz);
      const c = ax * ax + az * az - r * r;
      const disc = b * b - 4 * a * c;
      if (a === 0 || disc < 0) continue;
      for (const t of [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)]) {
        if (t < 0 || t > 1) continue;
        const angle = Math.atan2(ax + t * dx, -(az + t * dz));
        from = Math.min(from, angle);
        to = Math.max(to, angle);
      }
    }
    const pad = 0.04 / r;
    out[row].set(from - pad, to + pad, from > to ? 0 : 1, 0);
  }
  for (let row = 0; row < rows; row++) {
    if (out[row].z) continue;
    let near = -1;
    for (let d = 1; d < rows && near < 0; d++) near = [row - d, row + d].find((k) => k >= 0 && k < rows && out[k].z) ?? -1;
    out[row].set(near < 0 ? -0.5 : out[near].x, near < 0 ? 0.5 : out[near].y, 0, 0);
  }
  return out;
}

// Where along the strokes the tool is at `progress` 0..1, on the ground; its swing angle in `out.y`.
export function strokeAt(progress: number, rows: number, spread: THREE.Vector4, arm: THREE.Vector4, spans: THREE.Vector4[], out: THREE.Vector3) {
  const row = Math.min(rows - 1, Math.floor(progress * rows));
  const eased = 0.5 - 0.5 * Math.cos(Math.PI * (progress * rows - row));
  const a = row % 2 ? 1 - eased : eased;
  const r = rowRadius(row, rows, spread, arm);
  const angle = spans[row].x + a * (spans[row].y - spans[row].x);
  return out.set(arm.x + r * Math.sin(angle), angle, arm.y - r * Math.cos(angle));
}

// The hole is cut from a mask (`hole`, drawn from each painting's edge by `holeMask`) rather than built into the shader,
// so the sidewalk is built once and a change of painting only swaps a texture. It covers x -3..3, z -8..2.
export const HOLE_AREA = { x0: -3, x1: 3, z0: -8, z1: 2, size: 2048 };

export function holeMask(edge: THREE.Vector3[]) {
  // Filled row by row straight into bytes (a canvas would be read back from the GPU to upload, a frame's worth of time).
  const size = HOLE_AREA.size;
  const data = new Uint8Array(size * size);
  const px = edge.map((p) => ((p.x - HOLE_AREA.x0) / (HOLE_AREA.x1 - HOLE_AREA.x0)) * size);
  const pz = edge.map((p) => ((p.z - HOLE_AREA.z0) / (HOLE_AREA.z1 - HOLE_AREA.z0)) * size);
  const crossings: number[] = [];
  for (let row = 0; row < size; row++) {
    const z = row + 0.5;
    crossings.length = 0;
    for (let i = 0, j = edge.length - 1; i < edge.length; j = i++) {
      if (pz[i] > z !== pz[j] > z) crossings.push(px[i] + ((z - pz[i]) / (pz[j] - pz[i])) * (px[j] - px[i]));
    }
    crossings.sort((m, n) => m - n);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k] - 0.5));
      const to = Math.min(size - 1, Math.floor(crossings[k + 1] - 0.5));
      if (to >= from) data.fill(255, row * size + from, row * size + to + 1);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.generateMipmaps = false;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// How far each point of the sidewalk is from the nearest thing standing on it (stoops, areaway fences, tree pits), in
// metres up to 2, worked out once on a 3 cm grid: the grime that gathers round their feet, without the shader measuring
// every one of them (over a hundred) at every pixel. The curb and the house fronts, being straight lines, it still does.
const FEET_STEP = 0.03;
function feetDistance() {
  const feet = sidewalkFeet();
  const w = Math.ceil((FRONT - CURB) / FEET_STEP) + 1;
  const h = Math.ceil((NEAR - AWAY) / FEET_STEP) + 1;
  const data = new Uint16Array(w * h);
  const far = THREE.DataUtils.toHalfFloat(2);
  for (let j = 0; j < h; j++) {
    const z = AWAY + j * FEET_STEP;
    const near = feet.filter(([, , z0, z1]) => z > z0 - 2 && z < z1 + 2);
    for (let i = 0; i < w; i++) {
      if (!near.length) {
        data[j * w + i] = far;
        continue;
      }
      const x = CURB + i * FEET_STEP;
      let d = 2;
      near.forEach(([x0, x1, z0, z1]) => {
        const dx = Math.max(Math.abs(x - (x0 + x1) / 2) - (x1 - x0) / 2, 0);
        const dz = Math.max(Math.abs(z - (z0 + z1) / 2) - (z1 - z0) / 2, 0);
        d = Math.min(d, Math.hypot(dx, dz));
      });
      data[j * w + i] = THREE.DataUtils.toHalfFloat(d);
    }
  }
  const map = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.HalfFloatType);
  map.minFilter = map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = false;
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  return { map, w, h };
}

// Smooth gradient noise, baked once into a small tiling texture (four independent fields, one a channel), read in place
// of noise worked out per pixel: the sidewalk is a great many pixels, and every one of them used to work out half a
// dozen noises. A field repeats every NOISE_PERIOD units of its coordinates, with NOISE_TEXELS texels to the unit; its
// values spread as the per-pixel noise's did, so the thresholds on them read the same.
const NOISE_PERIOD = 8;
const NOISE_TEXELS = 16;
function bakeNoise() {
  const size = NOISE_PERIOD * NOISE_TEXELS;
  const field = new Float32Array(size * size * 4);
  // A gradient at each lattice point of each field, wrapping round the period so the texture tiles.
  const gradients = new Float32Array(4 * NOISE_PERIOD * NOISE_PERIOD * 2);
  for (let c = 0; c < 4; c++)
    for (let j = 0; j < NOISE_PERIOD; j++)
      for (let i = 0; i < NOISE_PERIOD; i++) {
        const v = Math.sin((i + NOISE_PERIOD) * 127.1 + (j + NOISE_PERIOD) * 311.7 + c * 74.7) * 43758.5453;
        const a = (v - Math.floor(v)) * Math.PI * 2;
        const k = ((c * NOISE_PERIOD + j) * NOISE_PERIOD + i) * 2;
        gradients[k] = Math.cos(a);
        gradients[k + 1] = Math.sin(a);
      }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let c = 0; c < 4; c++) {
    let sum = 0;
    let squares = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [u, v] = [x / NOISE_TEXELS, y / NOISE_TEXELS];
        const [i, j] = [Math.floor(u), Math.floor(v)];
        const [fu, fv] = [u - i, v - j];
        const corner = (di: number, dj: number) => {
          const k = ((c * NOISE_PERIOD + ((j + dj) % NOISE_PERIOD)) * NOISE_PERIOD + ((i + di) % NOISE_PERIOD)) * 2;
          return gradients[k] * (fu - di) + gradients[k + 1] * (fv - dj);
        };
        const [sx, sy] = [fade(fu), fade(fv)];
        const n = (corner(0, 0) * (1 - sx) + corner(1, 0) * sx) * (1 - sy) + (corner(0, 1) * (1 - sx) + corner(1, 1) * sx) * sy;
        field[(y * size + x) * 4 + c] = n;
        sum += n;
        squares += n * n;
      }
    }
    // To the per-pixel noise's spread (a standard deviation of about a quarter), about zero.
    const mean = sum / (size * size);
    const scale = 0.27 / Math.sqrt(squares / (size * size) - mean * mean);
    for (let k = c; k < field.length; k += 4) field[k] = (field[k] - mean) * scale;
  }
  const half = new Uint16Array(field.length);
  for (let k = 0; k < field.length; k++) half[k] = THREE.DataUtils.toHalfFloat(field[k]);
  const map = new THREE.DataTexture(half, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.minFilter = THREE.LinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = false;
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  return map;
}

export function buildGround(paving: Paving, picture: THREE.Texture, firstHole: THREE.Texture) {
  // The baked noise: one of its fields (0 to 3) at p, shifted by `shift` so two reads of a field don't line up.
  const noiseMap = bakeNoise();
  const noise = (p: any, ch: 0 | 1 | 2 | 3, shift: any = vec2(0)) => {
    const n = texture(noiseMap, p.div(NOISE_PERIOD).add(shift));
    return [n.x, n.y, n.z, n.w][ch];
  };
  // The picture's camera, set each frame; 1 once the drawing is real (the sidewalk inside its edge is gone); and how
  // far the eye is from the artist's, 0 there.
  const sweet = uniform(new THREE.Matrix4());
  const real = uniform(0);
  const chalky = uniform(1);

  const at = positionWorld.xz;
  const grainUv = at.div(2.4);
  const flag = floor(at.div(FLAG));
  const hash = fract(dot(flag, vec2(12.9898, 78.233)).sin().mul(43758.5453));
  const base = texture(paving.colour, grainUv).rgb.mul(hash.mul(0.16).add(0.7));
  // Grey, a touch warm in the morning light, as city concrete is, each flag weathered its own way.
  const concrete = mix(vec3(dot(base, vec3(0.3, 0.59, 0.11))), base, 0.3).mul(vec3(1.0, 0.99, 0.965));
  const lum = dot(concrete, vec3(0.3, 0.59, 0.11));

  const hash2 = fract(dot(flag, vec2(39.346, 11.135)).sin().mul(24634.6345));
  const hash3 = fract(dot(flag, vec2(73.156, 52.235)).sin().mul(13758.937));

  // Joints a little ragged, packed with dirt; their edges chipped away in places down to the aggregate.
  const toJoint = abs(fract(at.div(FLAG)).sub(0.5)).mul(FLAG).sub(FLAG / 2).abs();
  const nearJoint = min(toJoint.x, toJoint.y);
  // (The costlier noises are worked out only where they can show: these near the joints, the cracks in the flags that
  // have them. Elsewhere their result is known.)
  const ragged = Fn(() => {
    const out = float(0).toVar();
    If(nearJoint.lessThan(0.03), () => {
      out.assign(noise(at.mul(14), 0).mul(0.004));
    });
    return out;
  })();
  const joint = float(1).sub(smoothstep(0.006, 0.018, nearJoint.add(ragged)));
  const chip = Fn(() => {
    const out = float(0).toVar();
    If(nearJoint.lessThan(0.24), () => {
      const chipNoise = noise(at.mul(6), 1).add(noise(at.mul(23), 2).mul(0.4));
      out.assign(float(1).sub(smoothstep(0.02, 0.05, nearJoint.sub(chipNoise.sub(0.12).max(0).mul(0.14)))).mul(step(0.12, chipNoise)).mul(float(1).sub(joint)));
    });
    return out;
  })();
  // Cracks: a thin wandering line through some flags, and in others a whole branching break from the cracked scan,
  // laid at its own offset in each flag and fading out across part of it.
  const hairline = Fn(() => {
    const out = float(0).toVar();
    If(hash.greaterThanEqual(0.7), () => {
      const shift = vec2(hash.mul(3.7), hash.mul(1.3));
      const crackField = noise(at.mul(0.9), 3, shift).add(noise(at.mul(7), 0, shift).mul(0.06));
      out.assign(float(1).sub(smoothstep(0.004, 0.018, abs(crackField))));
    });
    return out;
  })();
  const crackUv = at.div(2.1).add(vec2(hash.mul(7.31), hash2.mul(3.17)));
  const broken = Fn(() => {
    const out = float(0).toVar();
    If(hash2.greaterThanEqual(0.62), () => {
      out.assign(smoothstep(-0.1, 0.35, noise(at.mul(0.7), 1, vec2(hash3.mul(2.9), hash3.mul(5.3)))));
    });
    return out;
  })();
  const scanCrack = float(1).sub(smoothstep(0.3, 0.4, dot(texture(paving.cracked, crackUv).rgb, vec3(0.3, 0.59, 0.11)))).mul(broken);
  const crack = max(hairline, scanCrack);
  // Damp patches, darker and glossier, drying at their edges.
  const damp = smoothstep(0.35, 0.65, noise(at.mul(0.22), 2, vec2(0.31, 0.17)).mul(0.5).add(0.5));

  // Each flag its own tone, a little warmer or cooler, then stained with the dirty scan's grime and debris.
  const dirty = texture(paving.dirty, at.div(2.3).add(vec2(hash3.mul(0.37), 0))).rgb;
  const toned = concrete.mul(hash2.mul(0.18).add(0.9)).mul(mix(vec3(1.02, 1, 0.96), vec3(0.97, 0.99, 1.02), hash3));
  const stained = toned.mul(mix(vec3(1), dirty.div(0.24), 0.75));
  // The aggregate's pits hold dirt: darker wherever the granular scan dips.
  const pits = smoothstep(0.85, 0.6, texture(paving.granular, at.div(0.75)).z);
  // Old spills: broad soft dark stains, and here and there a flattened grey-black disc of gum.
  const spill = smoothstep(0.45, 0.8, noise(at.mul(0.45), 3, vec2(0.53, 0.71)).add(noise(at.mul(2.2), 0, vec2(0.29, 0.61)).mul(0.25)));
  const gumCell = floor(at.mul(2.5));
  const gumHash = fract(dot(gumCell, vec2(17.13, 91.7)).sin().mul(31731.1));
  const gumAt = fract(at.mul(2.5)).sub(vec2(fract(gumHash.mul(13.7)).mul(0.6).add(0.2), fract(gumHash.mul(7.9)).mul(0.6).add(0.2)));
  const gum = float(1).sub(smoothstep(0.03, 0.045, length(gumAt))).mul(step(0.86, gumHash));
  // Grime gathers where the sidewalk meets anything standing on it: the curb, the house fronts, stoops, the areaway
  // curbs and the tree pits.
  const feet = feetDistance();
  const toFeet = texture(feet.map, vec2(at.x.sub(CURB).div(FEET_STEP).add(0.5).div(feet.w), at.y.sub(AWAY).div(FEET_STEP).add(0.5).div(feet.h))).r;
  const standing = min(min(at.x.sub(CURB), float(FRONT - BASE_COURSE).sub(at.x)), toFeet);
  const grime = exp(standing.div(-0.16)).mul(noise(at.mul(3), 1, vec2(0.67, 0.13)).mul(0.35).add(0.75)).clamp(0, 1);
  // And right in the corner, a tight dark band where little light reaches and the dirt is packed in, broken up by the
  // dirty scan already read.
  // Two parts: a near-black contact line in the first few centimetres, and a band of blotchy dirt and leaf grit
  // fading out over thirty or so.
  const contact = exp(standing.div(-0.1));
  const blotch = smoothstep(-0.2, 0.2, noise(at.mul(3.5), 3, vec2(0.19, 0.47))).mul(0.6).add(smoothstep(1.3, 0.7, dot(dirty, vec3(0.3, 0.59, 0.11)).div(0.24)).mul(0.4));
  const band = exp(standing.div(-0.4)).mul(blotch.mul(0.7).add(0.3)).add(exp(standing.div(-0.15)).mul(0.5)).clamp(0, 1);

  const dirt = vec3(0.07, 0.06, 0.045);
  let surface = mix(stained, stained.mul(vec3(0.55, 0.5, 0.45)), spill.mul(0.45));
  surface = surface.mul(pits.mul(-0.35).add(1));
  surface = mix(surface, surface.mul(0.62), chip);
  surface = mix(surface, dirt, grime.mul(0.75));
  surface = mix(surface, vec3(0.045, 0.03, 0.016), band);
  surface = mix(surface, vec3(0.011, 0.009, 0.007), contact.mul(0.95));
  surface = mix(surface, surface.mul(vec3(0.3, 0.27, 0.23)), joint.mul(0.85));
  surface = mix(surface, vec3(0.05, 0.045, 0.04), crack.mul(0.8));
  surface = mix(surface, vec3(0.16, 0.16, 0.155), gum.mul(0.85));
  // Lifted after `lum` is taken, so the chalk catches the grain as before while the flags read as pale city concrete.
  const paved = surface.mul(1.32).mul(mix(float(1), float(0.72), damp));

  // Where each point of the sidewalk falls in the picture.
  const clip = sweet.mul(vec4(positionWorld, 1));
  const ndc = clip.xy.div(clip.w);
  const inFrame = step(max(abs(ndc.x), abs(ndc.y)), 1).mul(step(0, clip.w));
  const pit = texture(picture, vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)));

  // Chalk catches on the grain's tops and skips its pits, the joints and the cracks.
  // (Only where there is chalk to show it, or the footprints: elsewhere it changes nothing.)
  const printsNear = step(abs(at.x), 0.4).mul(step(abs(at.y.sub(EYE.z)), 0.4));
  const catches = Fn(() => {
    const out = float(1).toVar();
    If(pit.a.mul(inFrame).mul(chalky).add(printsNear).greaterThan(0), () => {
      const grain = noise(at.mul(210), 2, vec2(0.41, 0.83)).mul(0.5).add(noise(at.mul(55), 3, vec2(0.77, 0.37)).mul(0.5));
      out.assign(smoothstep(-0.75, -0.1, grain.mul(0.8).add(lum.sub(0.12).mul(4))).mul(float(1).sub(joint.mul(0.85))).mul(float(1).sub(crack.mul(0.8))));
    });
    return out;
  })();
  // Drawn on in strokes and wiped off with an eraser (index.tsx runs both). `paint` 0..1 lays the strokes as an arm
  // would, pivoting at a point behind the drawing's near end (`arm`, see armFor): arcs back and forth across the
  // drawing's ground footprint (`spread`: x0, x1, z0, z1), each swing slowing at its ends, from the far end toward the
  // artist; `wipe` 0..1 takes them off the same way in broader swings, leaving a faint smear that fades as it ends.
  // (The strokes' ragged ends are worked out only while either is under way.) strokeAt follows the same arcs.
  const paint = uniform(1);
  const wipe = uniform(0);
  const spread = uniform(new THREE.Vector4(-2, 2, -6, 1));
  const arm = uniform(new THREE.Vector4(0, 2, 0.7, 8));
  const rel = at.sub(arm.xy);
  const reach = arm.y.sub(spread.w);
  // Rows evenly spaced as the artist sees them (see rise), not on the ground, so the far end isn't most of the time.
  const off = float(EYE.z).sub(arm.y);
  const riseOf = (r: Parameters<typeof float>[0]) => atan(float(EYE.y).div(float(r).add(off)));
  const [farRise, nearRise] = [riseOf(arm.w), riseOf(reach)];
  const down = riseOf(length(rel)).sub(farRise).div(nearRise.sub(farRise)).clamp(0, 1);
  const angle = atan(rel.x, rel.y.negate());
  // Each row's swing as far as the drawing's outline goes along it (see strokeSpans).
  const spans = { paint: uniformArray(Array.from({ length: STROKES.paint }, () => new THREE.Vector4(-0.7, 0.7, 0, 0)), "vec4"), wipe: uniformArray(Array.from({ length: STROKES.wipe }, () => new THREE.Vector4(-0.7, 0.7, 0, 0)), "vec4") };
  const strokes = (rows: number, span: typeof spans.paint) => {
    const row = min(floor(down.mul(rows)), rows - 1);
    const reach = span.element(row.toInt()) as unknown as ReturnType<typeof vec4>;
    const across = angle.sub(reach.x).div(reach.y.sub(reach.x)).clamp(0, 1);
    const a = mix(across, float(1).sub(across), row.mod(2));
    return row.add(acos(float(1).sub(a.mul(2)).clamp(-1, 1)).div(Math.PI)).div(rows);
  };
  const laid = Fn(() => {
    const out = float(1).toVar();
    If(paint.lessThan(1), () => {
      out.assign(step(strokes(STROKES.paint, spans.paint).add(mx_noise_float(vec3(at.mul(6), 7)).mul(0.012)), paint.mul(1.02)));
    });
    return out;
  })();
  const gone = Fn(() => {
    const out = float(0).toVar();
    If(wipe.greaterThan(0), () => {
      out.assign(step(strokes(STROKES.wipe, spans.wipe).add(mx_noise_float(vec3(at.mul(6), 8)).mul(0.016)), wipe.mul(1.02)));
    });
    return out;
  })();
  const smear = float(0.2).mul(float(1).sub(smoothstep(0.75, 1, wipe)));
  const shown = laid.mul(float(1).sub(gone.mul(float(1).sub(smear))));
  const drawn = pit.a.mul(inFrame).mul(float(1).sub(real)).mul(mix(float(1), catches, chalky)).mul(shown);

  // Footprints where the artist stood, outlined in chalk: stand here.
  const foot = (x: number) => {
    const d = at.sub(vec2(x, EYE.z)).div(vec2(0.055, 0.13));
    return float(1).sub(smoothstep(0.004, 0.01, abs(length(d).sub(1)).mul(0.08)));
  };
  const prints = max(foot(-0.11), foot(0.11)).mul(0.85).mul(catches);

  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  material.colorNode = mix(paved, vec3(0.85, 0.84, 0.82), prints);
  material.roughnessNode = mix(texture(paving.rough, grainUv).r.mul(0.2).add(0.74).sub(damp.mul(0.35)).add(grime.mul(0.1)).sub(gum.mul(0.3)).clamp(0.3, 1), float(0.97), prints);
  // Relief: the grain, coarse aggregate over it (more where the edges are chipped), the cracked scan's broken edges, and
  // each flag heaved a little out of level by the roots.
  const grainN = texture(paving.normal, grainUv).xyz.mul(2).sub(1);
  const coarseN = texture(paving.granular, at.div(0.75)).xyz.mul(2).sub(1);
  const brokenN = texture(paving.crackedNormal, crackUv).xyz.mul(2).sub(1);
  const dirtyN = texture(paving.dirtyNormal, at.div(2.3).add(vec2(hash3.mul(0.37), 0))).xyz.mul(2).sub(1);
  const heave = vec2(hash2.sub(0.5), hash3.sub(0.5)).mul(0.05);
  const relief = grainN.xy.add(coarseN.xy.mul(chip.mul(0.9).add(0.75))).add(brokenN.xy.mul(broken.mul(0.8))).add(dirtyN.xy.mul(0.25)).add(heave);
  material.normalNode = normalMap(vec3(relief, grainN.z).normalize().mul(0.5).add(0.5), vec2(1.9));
  // The drawing goes on last, over the lit sidewalk, as the picture's own colour.
  material.outputNode = mix(output, vec4(pit.rgb, 1), drawn) as any;
  const hole = texture(firstHole, vec2(at.x.sub(HOLE_AREA.x0).div(HOLE_AREA.x1 - HOLE_AREA.x0), at.y.sub(HOLE_AREA.z0).div(HOLE_AREA.z1 - HOLE_AREA.z0)));
  material.opacityNode = float(1).sub(step(0.5, hole.r).mul(real));
  material.alphaTest = 0.5;

  const geometry = new THREE.PlaneGeometry(FRONT - CURB, NEAR - AWAY);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((FRONT + CURB) / 2, 0, (NEAR + AWAY) / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return { mesh, sweet, real, chalky, paint, wipe, spread, arm, spans, hole, geometries: [geometry], materials: [material] };
}
