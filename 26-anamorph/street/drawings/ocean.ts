/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { abs, atan, attribute, cameraPosition, instanceIndex, clamp, cos, cross, dot, exp, float, instancedBufferAttribute, instancedDynamicBufferAttribute, length, max, mix, mx_noise_float, normalGeometry, normalMap, normalWorld, normalize, output, positionGeometry, positionLocal, positionWorld, pow, sin, smoothstep, step, texture, uniform, uv, varying, vec2, vec3, vec4 } from "three/tsl";
import { type Drawing, type Scans, footprint, shadeFor, SLAB, wakeAt, walls, wobble } from "../drawings";

// A hole broken through the sidewalk, and under the paving there is no ground at all: the slab is a thin crust over the
// sea. Through the hole the water is clear, bright and still, and below it a sunlit coral reef runs away and down into
// the blue: boulders and corals in every colour on pale sand, sea grass, urchins, starfish and anemones, a school of
// fish holding in mid-water. Once real it comes alive: the
// surface ripples, sunlight dances over the reef, the grass and the sea fans sway, the school swims and turns, the
// bigger fish wander, and bubbles rise.
// Underwater everything is lit by hand (light from above, dimming and turning blue with depth, and the dancing
// caustics) and seen through the water, which takes the red out first and fades all of it into the blue with distance.

export const textures: Record<string, { url: string; colour?: boolean }> = {
  sand: { url: "/assets/26-anamorph/ocean/aerial_beach_01_diff_2k.jpg", colour: true },
  coral: { url: "/assets/26-anamorph/ocean/coral_ground_02_diff_2k.jpg", colour: true },
  coralNormal: { url: "/assets/26-anamorph/ocean/coral_ground_02_nor_gl_2k.jpg" }
};

// The hole: a rounded oblong (a superellipse) with a broken edge, round its middle on the ground.
const HOLE = { x: 0, z: -2.3, across: 1.5, along: 2.55 };
const ragged = (a: number) => 1 + 0.03 * Math.sin(5 * a + 1) + 0.022 * Math.sin(9 * a + 2.3) + 0.012 * Math.sin(19 * a + 0.7) + 0.006 * Math.sin(37 * a + 2);
// The sea's surface, a little under the slab.
const WATER = -0.3;
// How fast the water takes each colour out of the light along the way (per metre: red first, then green), and the
// light from above just under the surface.
const ABSORB = new THREE.Vector3(0.12, 0.038, 0.034);
const AMBIENT = new THREE.Vector3(1.32, 1.45, 1.4);

// Reef heads (bommies) rising off the sand: x, z, height, spread, and for the two right under the opening how far they
// have been let down (to low mounds, so from above and from the rim the reef's life is seen, not hidden on their tops).
const BOMMIES: [number, number, number, number, number?][] = [
  [-1.5, -7.2, 2.9, 1.4],
  [1.6, -9.6, 3.2, 1.7],
  [-0.4, -13, 3.4, 2.1],
  [2.6, -5.6, 2.4, 1.2],
  [-3.1, -10.6, 3.0, 1.6],
  [0.4, -3.4, 2.2, 1.2, 0.4],
  [3.8, -13.5, 3.3, 2],
  [-3.9, -15.5, 3.4, 2.2],
  [1.3, -18, 3.6, 2.4],
  [-2.2, -3.2, 1.8, 1.1, 0.42]
]
const ss = THREE.MathUtils.smoothstep;
// (`whole`: as the reef was first drawn, before the two were let down; the corals are still scattered by it, so the
// ones further off stay where they were.)
function reefAt(x: number, z: number, whole = false) {
  let sum = 0;
  // Flat-topped, steep-sided heads, not peaks. (A head more than two and a half spreads off adds nothing to see, so
  // it is skipped: this is asked of every point of the sea floor.)
  for (let k = 0; k < BOMMIES.length; k++) {
    const b = BOMMIES[k];
    const dx = x - b[0];
    const dz = z - b[1];
    const d = (dx * dx + dz * dz) / (b[3] * b[3]);
    if (d < 6) sum = Math.max(sum, b[2] * (whole ? 1 : (b[4] ?? 1)) * Math.exp(-Math.pow(d, 1.6)) * (1 + 0.12 * wobble(x * 1.3, z * 1.3, b[0])));
  }
  return sum;
}
// The sea floor: shallow sand under the hole, reef heads, then the drop-off into the deep; and all round, far off, it
// rises to the surface, so whatever is seen through the hole ends on something of the sea's own.
function seabed(x: number, z: number, reef = reefAt(x, z)) {
  let y = -5.6 - 1.8 * ss(-z, 8, 20) - 6 * ss(-z, 22, 32);
  y += reef + Math.min(1, reef) * (0.16 * wobble(x * 3.1, z * 3.1, 5) + 0.06 * wobble(x * 7.3, z * 7.3, 6));
  y += 0.14 * wobble(x * 0.7, z * 0.7, 1) + 0.05 * wobble(x * 2.7, z * 2.7, 2);
  const rim = Math.max(ss(Math.abs(x), 8, 11.5), ss(z, 2.5, 5.5), ss(-z, 40, 47));
  return THREE.MathUtils.lerp(y, WATER + 0.12, rim);
}

const hash = (i: number, n: number) => {
  const v = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

// Shapes that are the same every time the sea is drawn (the walls, the sea floor, the reef's pieces, the fish) are
// made the first time and kept; each later drawing takes a copy, far quicker than making them again.
const kept = new Map<string, THREE.BufferGeometry>();
const keep = (name: string, make: () => THREE.BufferGeometry) => {
  let g = kept.get(name);
  if (!g) kept.set(name, (g = make()));
  return g.clone();
};

// Two small tiling textures, baked once and sampled everywhere in place of noise worked out afresh for every pixel of
// every frame. The sea's: in red how far a point is from the middle of its cell in a net of cells, in green how far from
// the cell's edge, in blue and alpha two soft swells. The ripples': the slope of a rippled surface, across in red and
// along in green.
let baked: { sea: THREE.DataTexture; ripples: THREE.DataTexture } | undefined;
const bake = () => {
  if (baked) return baked;
  // Waves that each fit a whole number of times across the tile, so their sum tiles: [across, along, phase, height].
  const waves = (count: number, seed: number) =>
    Array.from({ length: count }, (_, k) => {
      const a = hash(k, seed) * Math.PI * 2;
      const f = 2 + Math.floor(hash(k, seed + 1) * 6);
      return [Math.round(Math.cos(a) * f), Math.round(Math.sin(a) * f), hash(k, seed + 2) * 6.28, 1 / f];
    });
  const tile = (size: number, fill: (u: number, v: number, out: Float32Array) => void) => {
    const data = new Uint8Array(size * size * 4);
    const out = new Float32Array(4);
    for (let y = 0, i = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        fill((x + 0.5) / size, (y + 0.5) / size, out);
        for (let c = 0; c < 4; c++) data[i++] = Math.max(0, Math.min(255, Math.round(out[c] * 255)));
      }
    }
    const t = new THREE.DataTexture(data, size, size);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  };
  // A sum of waves at (u, v): its height (-1 to 1) or, with `along` 1 or 2, its slope across or along (-1 to 1).
  const sum = (list: number[][], u: number, v: number, along = 0) => {
    let [h, n] = [0, 0];
    for (let k = 0; k < list.length; k++) {
      const w = list[k];
      const a = Math.PI * 2 * (w[0] * u + w[1] * v) + w[2];
      h += along === 0 ? w[3] * Math.sin(a) : w[3] * w[along - 1] * Math.cos(a);
      n += along === 0 ? w[3] : w[3] * Math.abs(w[along - 1]);
    }
    return h / n;
  };
  const CELLS = 16;
  const [swellA, swellB, rippling] = [waves(6, 211), waves(6, 221), waves(10, 231)];
  const sea = tile(256, (u, v, out) => {
    const cu = u * CELLS;
    const cv = v * CELLS;
    const iu = Math.floor(cu);
    const iv = Math.floor(cv);
    let [f1, f2] = [9, 9];
    for (let dv = -1; dv <= 1; dv++) {
      for (let du = -1; du <= 1; du++) {
        const cell = ((iu + du + CELLS) % CELLS) + ((iv + dv + CELLS) % CELLS) * CELLS;
        const d = Math.hypot(iu + du + 0.15 + 0.7 * hash(cell, 201) - cu, iv + dv + 0.15 + 0.7 * hash(cell, 202) - cv);
        if (d < f1) [f1, f2] = [d, f1];
        else if (d < f2) f2 = d;
      }
    }
    out[0] = f1;
    out[1] = f2 - f1;
    out[2] = 0.5 + 0.5 * sum(swellA, u, v);
    out[3] = 0.5 + 0.5 * sum(swellB, u, v);
  });
  const ripples = tile(128, (u, v, out) => {
    out[0] = 0.5 + 0.5 * sum(rippling, u, v, 1);
    out[1] = 0.5 + 0.5 * sum(rippling, u, v, 2);
    out[2] = 0.5 + 0.5 * sum(rippling, u, v);
    out[3] = 1;
  });
  return (baked = { sea, ripples });
};

// Where a fish may swim: two height fields on a 20 cm grid under the hole and the reef, the highest solid thing at each
// spot (the sea floor, every coral and rock on it, the fans) and the lowest thing hanging over it (the hole's undercut
// walls, else just under the surface). Made once from the meshes themselves, then widened and smoothed, so a
// fish keeping between them glides over a reef head rather than hopping.
const ROOM = { x0: -7, z0: -24, cell: 0.2, nx: 71, nz: 131 };
let room: { floor: Float32Array; roof: Float32Array } | undefined;
const roomAt = (field: Float32Array, x: number, z: number) => {
  const u = Math.min(ROOM.nx - 1.001, Math.max(0, (x - ROOM.x0) / ROOM.cell));
  const v = Math.min(ROOM.nz - 1.001, Math.max(0, (z - ROOM.z0) / ROOM.cell));
  const [i, j] = [Math.floor(u), Math.floor(v)];
  const [fu, fv] = [u - i, v - j];
  const k = j * ROOM.nx + i;
  const a = field[k] + (field[k + 1] - field[k]) * fu;
  const b = field[k + ROOM.nx] + (field[k + ROOM.nx + 1] - field[k + ROOM.nx]) * fu;
  return a + (b - a) * fv;
};
const makeRoom = (solids: ArrayLike<number>[], overhead: ArrayLike<number>) => {
  const { x0, z0, cell, nx, nz } = ROOM;
  const floor = new Float32Array(nx * nz);
  const roof = new Float32Array(nx * nz).fill(WATER - 0.1);
  for (let j = 0, k = 0; j < nz; j++) for (let i = 0; i < nx; i++, k++) floor[k] = seabed(x0 + i * cell, z0 + j * cell);
  const index = (x: number, z: number) => {
    const [i, j] = [Math.round((x - x0) / cell), Math.round((z - z0) / cell)];
    return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i;
  };
  for (const P of solids) {
    for (let v = 0; v < P.length; v += 3) {
      const k = index(P[v], P[v + 2]);
      if (k >= 0 && P[v + 1] > floor[k]) floor[k] = P[v + 1];
    }
  }
  for (let v = 0; v < overhead.length; v += 3) {
    const k = index(overhead[v], overhead[v + 2]);
    if (k >= 0 && overhead[v + 1] < -0.1 && overhead[v + 1] < roof[k]) roof[k] = overhead[v + 1];
  }
  // Widened two cells (the highest or lowest of each 3 by 3, twice), then smoothed once.
  const spread = (field: Float32Array, pick: (a: number, b: number) => number, widen: boolean) => {
    const out = new Float32Array(field.length);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let [v, n] = [widen ? field[j * nx + i] : 0, 0];
        for (let b = Math.max(0, j - 1); b <= Math.min(nz - 1, j + 1); b++) {
          for (let a = Math.max(0, i - 1); a <= Math.min(nx - 1, i + 1); a++) {
            if (widen) v = pick(v, field[b * nx + a]);
            else [v, n] = [v + field[b * nx + a], n + 1];
          }
        }
        out[j * nx + i] = widen ? v : v / n;
      }
    }
    return out;
  };
  return {
    floor: spread(spread(spread(floor, Math.max, true), Math.max, true), Math.max, false),
    roof: spread(spread(spread(roof, Math.min, true), Math.min, true), Math.min, false)
  };
};

// The school's way through the water (it loops and turns, deep enough and near enough the opening to pass under it,
// and at the moment the drawing turns real just where the artist drew it).
const schoolAt = (u: number, out: THREE.Vector3) => out.set(2.1 * Math.sin(u * 0.23), -2 + 0.45 * Math.sin(u * 0.37), -6.3 + 3.4 * Math.sin(u * 0.31 + 0.25));
// How far along its way a fish has come by the drawing's time t: easing in from rest as the drawing wakes (the integral
// of wakeAt), so the school starts from standing.
const swum = (t: number) => {
  if (t >= 1.8) return t - 0.9;
  const x = t / 1.8;
  return 1.8 * (x ** 6 - 3 * x ** 5 + 2.5 * x ** 4);
};

export function build(scans: Scans, extra: Record<string, THREE.Texture>): Drawing {
  const edge: THREE.Vector3[] = [];
  for (let k = 0; k < 260; k++) {
    const a = (k / 260) * Math.PI * 2;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    const r = ragged(a) / Math.pow(c ** 4 + s ** 4, 0.25);
    edge.push(new THREE.Vector3(HOLE.x + HOLE.across * c * r, 0, HOLE.z + HOLE.along * s * r));
  }
  const real = new THREE.Group();
  const time = uniform(0);
  const stir = uniform(0);
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  // ---- The water's own light and colour
  const p = positionWorld;
  const { sea: seaMap, ripples: rippleMap } = bake();
  const sea = (at: any) => texture(seaMap, at);
  // A face's two dimensions from any point, skewed so that no face of the reef sees the baked textures edge on.
  const skew = (at: any) => vec2(at.x.add(at.y.mul(0.7)), at.z.sub(at.y.mul(0.6)));
  // Sunlight through the moving surface, a bright net rippling over everything below that faces up: two nets of cells
  // drifting across each other, bright where either's cells meet.
  const caustic = (at: any) => {
    const q = at.xz.div(5.5);
    const a = sea(q.add(vec2(time.mul(0.011), time.mul(0.007)))).g;
    const b = sea(q.mul(1.37).add(vec2(0.31, time.mul(0.012).add(0.53))).sub(vec2(time.mul(0.009), 0))).g;
    return pow(float(1).sub(a.mul(5).min(1)), 3).add(pow(float(1).sub(b.mul(5).min(1)), 3).mul(0.6));
  };
  // Light reaching a point below the surface, facing `n`: from above, dimmer and bluer the deeper, and in shallow
  // clear water plenty of it comes round from the sides too.
  const lit = (albedo: any, n: any, glints = 1) => {
    const depth = max(float(WATER).sub(p.y), 0);
    const down = exp(vec3(ABSORB).mul(depth).negate());
    const sky = mix(float(0.38), float(1), pow(clamp(n.y.mul(0.5).add(0.5), 0, 1), 1.6));
    const dance = caustic(p).mul(clamp(n.y, 0, 1)).mul(exp(depth.mul(-0.1))).mul(1.9 * glints);
    return albedo.mul(down).mul(vec3(AMBIENT).mul(sky).add(dance));
  };
  // Seen through the water: the light from the point thinned by the water between it and the eye (red first), and the
  // water's own glow filling in what is lost: a light turquoise near the surface and over the shallows, a deep
  // saturated blue only far down and far off. Nothing above the surface is touched.
  const seen = (rgb: any) => {
    const far = length(p.sub(cameraPosition));
    const wet = clamp(float(WATER).sub(p.y).div(max(cameraPosition.y.sub(p.y), 0.001)), 0, 1);
    const through = exp(vec3(ABSORB).mul(0.8).add(0.006).mul(far.mul(wet)).negate());
    const glow = mix(vec3(0.02, 0.16, 0.36), vec3(0.06, 0.36, 0.42), exp(p.y.sub(WATER).mul(0.2)).mul(exp(far.mul(wet).mul(-0.025))));
    return rgb.mul(through).add(glow.mul(float(1).sub(through)));
  };
  // Living reef over rock, laid over the face `at`: clumps of coral each its own colour (orange, violet, gold, rose, a
  // little green of algae; the reds strong, as the water takes them first), cracks between them, fine polyp grain over
  // all.
  const reefSkin = (base: any, at: any) => {
    const swell = sea(at.div(9));
    const warp = swell.ba.sub(0.5).mul(0.3);
    const cells = sea(at.div(2.4).add(warp));
    const small = sea(at.div(0.9).add(warp.mul(2)).add(0.37));
    const clump = float(1).sub(cells.r.mul(0.8)).clamp(0, 1);
    const hueA = swell.b.sub(0.5).mul(1.4);
    const hueB = swell.a.sub(0.5).mul(1.4);
    // The cracks between clumps deep in places and all but grown over in others, so they do not net the whole reef
    // evenly.
    const deep = smoothstep(-0.35, 0.35, hueB).mul(0.4).add(0.1);
    const crevice = float(1).sub(float(1).sub(smoothstep(0.0, 0.09, cells.g)).mul(deep)).mul(smoothstep(0.0, 0.12, small.g).mul(0.25).add(0.75));
    let colour = mix(vec3(1.25, 0.48, 0.3), vec3(0.85, 0.32, 0.86), smoothstep(0.15, 0.55, hueA));
    colour = mix(colour, vec3(1.15, 0.78, 0.3), smoothstep(0.1, 0.5, hueB));
    colour = mix(colour, vec3(0.5, 0.72, 0.4), smoothstep(0.4, 0.7, hueA.negate()));
    colour = mix(colour, vec3(1.25, 0.45, 0.62), smoothstep(0.2, 0.5, hueB.sub(hueA)));
    const fine = float(1).sub(small.r).mul(0.3).add(0.78);
    return mix(base, colour.mul(fine), 0.85).mul(crevice).mul(clump.mul(0.3).add(0.8));
  };
  const underwater = (albedo: any, n: any, side: THREE.Side = THREE.FrontSide) => {
    const material = new THREE.MeshBasicNodeMaterial({ side });
    material.colorNode = lit(albedo, n);
    material.outputNode = vec4(seen(output.rgb), output.a) as any;
    materials.push(material);
    return material;
  };

  // ---- The walls of the hole: the slab, broken in chunks with its top edge chipped, its top tucked a little under the
  // sidewalk's cut so no hairline opens between them; the crumbling crust under it stepped back beneath the slab, wet
  // below and weedy at the waterline; then under the water an undercut lip and nothing: the open sea under the
  // sidewalk. (How far a point of the wall is pushed out from the edge, at a height.)
  const push = (q: THREE.Vector3, y: number) =>
    y > -SLAB ? 0.012 * wobble(q.x * 23, y * 31, q.z * 19) + 0.02 * Math.max(0, 1 + y / 0.03) : 0.03 + ss(-y, 0.3, 1.1) * (0.32 + 0.18 * wobble(q.x * 1.4, y * 2, q.z * 1.4)) + 0.04 * wobble(q.z * 4, y * 5, q.x * 4);
  const wallGeometry = keep("walls", () => {
    const g = walls(edge, 1.25, 1.4, push, 26);
    // The lip's underside broken and uneven, not a level cut.
    const at = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < at.count; i++) {
      const [x, y, z] = [at.getX(i), at.getY(i), at.getZ(i)];
      if (y < -0.5) at.setY(i, y + (y + 0.5) * 0.5 * wobble(x * 1.7, z * 1.7, 4));
    }
    g.computeVertexNormals();
    return g;
  });
  geometries.push(wallGeometry);
  {
    const y = p.y;
    const crust = texture(scans.rock, uv()).rgb.mul(0.55);
    const slabColour = texture(scans.slab, uv().mul(vec2(1, 2.5))).rgb.mul(0.92);
    const wetness = smoothstep(-0.12, -0.26, y);
    const weed = smoothstep(WATER + 0.05, WATER - 0.04, y).mul(sea(skew(p).mul(0.9)).b.add(0.1).clamp(0, 1));
    let colour = mix(crust, crust.mul(0.5), wetness);
    colour = mix(colour, vec3(0.08, 0.13, 0.05).mul(crust.r.mul(2).add(0.5)), weed.mul(0.85));
    colour = mix(colour, slabColour, smoothstep(-SLAB - 0.03, -SLAB, y));
    const wallMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    wallMaterial.colorNode = colour;
    wallMaterial.roughnessNode = mix(float(0.95), float(0.45), wetness);
    wallMaterial.normalNode = normalMap(texture(scans.rockNormal, uv()), vec2(1.3));
    // Under the water the light reaching it is thinned like everything else's.
    const depth = max(float(WATER).sub(y), 0);
    wallMaterial.outputNode = vec4(seen(output.rgb.mul(exp(vec3(ABSORB).mul(depth.mul(1.6).add(depth.sign().mul(0.6))).negate()))), output.a) as any;
    materials.push(wallMaterial);
    const wall = new THREE.Mesh(wallGeometry, wallMaterial);
    wall.receiveShadow = true;
    real.add(wall);
  }

  // ---- The sea floor: a grid finest under and just beyond the hole, where it is looked at closely (a hand's width
  // between points), coarser out to the sides and the far drop-off, which are only ever seen at a glance through the
  // blue.
  const floorGeometry = keep("floor", () => {
    const g = new THREE.BufferGeometry();
    const axis = (from: number, to: number, step: (v: number) => number) => {
      const out = [from];
      while (out[out.length - 1] < to) out.push(Math.min(to, out[out.length - 1] + step(out[out.length - 1])));
      return out;
    };
    const xs = axis(-12, 12, (x) => 0.095 + 0.55 * ss(Math.abs(x), 2.5, 9));
    const zs = axis(-48, 6, (z) => 0.095 + 0.3 * ss(z, 0.5, 4) + 0.8 * ss(-z, 7.5, 30));
    const [nx, nz] = [xs.length, zs.length];
    const position = new Float32Array(nx * nz * 3);
    const reefs = new Float32Array(nx * nz);
    for (let j = 0, k = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++, k++) {
        const x = xs[i];
        const z = zs[j];
        reefs[k] = reefAt(x, z);
        position[k * 3] = x;
        position[k * 3 + 1] = seabed(x, z, reefs[k]);
        position[k * 3 + 2] = z;
      }
    }
    // Two triangles a cell, wound to face up.
    const index = new Uint32Array((nx - 1) * (nz - 1) * 6);
    for (let j = 0, k = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        index[k++] = a;
        index[k++] = a + nx;
        index[k++] = a + 1;
        index[k++] = a + nx;
        index[k++] = a + nx + 1;
        index[k++] = a + 1;
      }
    }
    g.setAttribute("position", new THREE.BufferAttribute(position, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeVertexNormals();
    // Reef rock on the heads and down the drop-off, sand between.
    const normal = g.getAttribute("normal").array;
    const rocky = new Float32Array(nx * nz);
    for (let k = 0; k < nx * nz; k++) {
      const x = position[k * 3];
      const z = position[k * 3 + 2];
      rocky[k] = THREE.MathUtils.clamp(reefs[k] * 0.9 - 0.3 + (1 - normal[k * 3 + 1]) * 5 + 0.25 * wobble(x * 2.1, z * 2.1, 7), 0, 1);
    }
    g.setAttribute("rocky", new THREE.BufferAttribute(rocky, 1));
    return g;
  });
  geometries.push(floorGeometry);
  {
    const rocky = attribute("rocky", "float");
    const swell = sea(p.xz.div(7));
    const patches = smoothstep(0.1, 0.6, swell.b.sub(0.5).mul(1.4).add(swell.a.sub(0.5).mul(0.45)));
    const sand = mix(texture(extra.sand, p.xz.div(4)).rgb.mul(vec3(2.1, 2, 1.75)), texture(extra.coral, p.xz.div(1.1)).rgb.mul(vec3(0.95, 0.9, 0.75)), patches.mul(0.5));
    const coral = reefSkin(texture(extra.coral, p.xz.div(1.8)).rgb.mul(vec3(1.05, 0.98, 0.92)), skew(p));
    const bump = texture(extra.coralNormal, p.xz.div(1.8)).xyz.mul(2).sub(1);
    const n = normalize(normalWorld.add(vec3(bump.x, 0, bump.y.negate()).mul(rocky.mul(0.7))));
    real.add(new THREE.Mesh(floorGeometry, underwater(mix(sand, coral, smoothstep(0.35, 0.65, rocky)), n)));
  }

  // ---- The reef: boulders, brain corals, branching corals, table corals and sponges, and near the hole the small
  // things of the bottom (urchins, starfish and anemones). Each shape is made once and set down many times, in a finer
  // make where it is near enough the hole to be looked at closely and a plainer one further off, and every placing of
  // every shape is then poured into one mesh, drawn at once with one material. Each point carries what it is (0 rock, 1
  // brain, 2 branching, 3 table, 4 sponge, 5 urchin, 6 starfish, 7 anemone), how far up its shape it is, how far along
  // an anemone's tentacle, and its placing's colour.
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0);
  // (Every piece without uv, so they all merge.)
  const bare = (g: THREE.BufferGeometry) => g.deleteAttribute("uv");
  const ground = (x: number, z: number) => seabed(x, z) - 0.04;
  // Near enough the hole to be seen up close.
  const near = (x: number, z: number) => Math.hypot(x - HOLE.x, z - HOLE.z) < 6;
  // The way the bottom faces at a point, to stand small things square on it.
  const facing = (x: number, z: number, out: THREE.Vector3) => out.set(seabed(x - 0.05, z) - seabed(x + 0.05, z), 0.1, seabed(x, z - 0.05) - seabed(x, z + 0.05)).normalize();
  const reefGeometry = keep("reef", () => {
    type Shape = { geometry: THREE.BufferGeometry; kind: number; matrices: number[]; tints: number[] };
    const shapes: Shape[] = [];
    const shape = (kind: number, g: THREE.BufferGeometry) => {
      const made: Shape = { geometry: g, kind, matrices: [], tints: [] };
      shapes.push(made);
      return made;
    };
    const put = (s: Shape, matrix: THREE.Matrix4, tint: THREE.Color) => {
      s.matrices.push(...matrix.elements);
      s.tints.push(tint.r, tint.g, tint.b);
    };

    // Boulders: lumpy spheres, flat underneath (welded where the sphere was cut, so they shade smoothly all round).
    const boulders = [44, 22].map((around) => shape(0, (() => {
      const g = mergeVertices(bare(new THREE.SphereGeometry(1, around, Math.round(around * 0.6))).deleteAttribute("normal"));
      const at = g.getAttribute("position") as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      for (let i = 0; i < at.count; i++) {
        v.fromBufferAttribute(at, i);
        v.multiplyScalar(1 + 0.22 * wobble(v.x * 1.6, v.y * 1.6, v.z * 1.6) + 0.07 * wobble(v.x * 4.3, v.y * 4.3, v.z * 4.3 + 2));
        at.setXYZ(i, v.x, Math.max(v.y, -0.3), v.z);
      }
      g.computeVertexNormals();
      return g;
    })()));
    // Brain corals: low domes.
    const domes = [30, 16].map((around) => shape(1, new THREE.SphereGeometry(1, around, Math.round(around * 0.36), 0, Math.PI * 2, 0, Math.PI / 2)));
    // Branching coral: tapering limbs forking upward, three shapes to choose from. Close up each limb is rounder, each
    // joint rounded over and each tip capped; further off plainer, the tips just pointed.
    const branchings = [true, false].map((fine) =>
      [0, 1, 2].map((variant) => shape(2, (() => {
        const sides = fine ? 6 : 4;
        const limbs: THREE.BufferGeometry[] = [];
        const toward = new THREE.Quaternion();
        const grow = (from: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number, seed: number) => {
          toward.setFromUnitVectors(Y, dir);
          limbs.push(bare(new THREE.CylinderGeometry(r * 0.72, r, len, sides, 1, true).translate(0, len / 2, 0).applyQuaternion(toward).translate(from.x, from.y, from.z)));
          const end = from.clone().addScaledVector(dir, len);
          if (depth === 0) {
            const tip = fine ? new THREE.SphereGeometry(r * 0.72, sides, 2, 0, Math.PI * 2, 0, Math.PI / 2) : new THREE.ConeGeometry(r * 0.72, r * 1.4, sides, 1, true).translate(0, r * 0.7, 0);
            limbs.push(bare(tip.applyQuaternion(toward).translate(end.x, end.y, end.z)));
            return;
          }
          if (fine) limbs.push(bare(new THREE.SphereGeometry(r * 0.72, 5, 3).translate(end.x, end.y, end.z)));
          const forks = 2 + (hash(seed, 9) > 0.5 ? 1 : 0);
          for (let k = 0; k < forks; k++) {
            const turn = (k / forks) * Math.PI * 2 + hash(seed, k) * 2;
            const lean = 0.35 + hash(seed, k + 4) * 0.45;
            const next = dir.clone().multiplyScalar(1.2).add(new THREE.Vector3(Math.cos(turn) * lean, 0.25, Math.sin(turn) * lean)).normalize();
            grow(end, next, len * (0.75 + hash(seed, k + 7) * 0.2), r * 0.72, depth - 1, seed * 3 + k + 1);
          }
        };
        for (let k = 0; k < 4; k++) {
          const turn = (k / 4) * Math.PI * 2 + variant;
          grow(new THREE.Vector3(Math.cos(turn) * 0.05, 0, Math.sin(turn) * 0.05), new THREE.Vector3(Math.cos(turn) * 0.5, 1, Math.sin(turn) * 0.5).normalize(), 0.16, 0.035, 3, variant * 17 + k);
        }
        const merged = mergeGeometries(limbs);
        limbs.forEach((g) => g.dispose());
        return merged;
      })()))
    );
    // Table corals: a broad plate with a ragged rim on a short stem.
    const tables = [36, 16].map((around) => shape(3, (() => {
      const plate = new THREE.CylinderGeometry(0.55, 0.42, 0.07, around);
      const at = plate.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < at.count; i++) {
        const a = Math.atan2(at.getZ(i), at.getX(i));
        const out = 1 + 0.05 * Math.sin(7 * a) + 0.03 * Math.sin(13 * a + 1);
        at.setX(i, at.getX(i) * out);
        at.setZ(i, at.getZ(i) * out);
      }
      plate.computeVertexNormals();
      plate.translate(0, 0.32, 0);
      const stem = new THREE.CylinderGeometry(0.06, 0.1, 0.32, Math.round(around / 3), 1, true).translate(0, 0.16, 0);
      return mergeGeometries([bare(plate), bare(stem)]);
    })()));
    // Tube sponges: a few tall tubes together.
    const sponges = [14, 7].map((around) => shape(4, (() => {
      const tubes: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 5; k++) {
        const h = 0.25 + hash(k, 3) * 0.3;
        const g = new THREE.CylinderGeometry(0.055, 0.045, h, around);
        g.translate(0, h / 2, 0);
        g.rotateZ((hash(k, 5) - 0.5) * 0.4);
        const off = k > 0 ? 0.08 : 0;
        g.translate(Math.cos(k * 2.4) * off, 0, Math.sin(k * 2.4) * off);
        tubes.push(bare(g));
      }
      return mergeGeometries(tubes);
    })()));
    // Sea urchins: a dark ball bristling with long spines, spread evenly over all but the underside.
    const urchin = shape(5, (() => {
      const pieces = [bare(new THREE.SphereGeometry(0.045, 10, 6).scale(1, 0.75, 1))];
      const SPINES = 46;
      const dir = new THREE.Vector3();
      for (let k = 0; k < SPINES; k++) {
        const y = 1 - ((k + 0.5) / SPINES) * 1.25;
        const r = Math.sqrt(1 - y * y);
        dir.set(Math.cos(k * 2.4) * r, y, Math.sin(k * 2.4) * r);
        const len = 0.07 + hash(k, 91) * 0.05;
        pieces.push(bare(new THREE.ConeGeometry(0.005, len, 3, 1, true).translate(0, len / 2, 0).applyQuaternion(q.setFromUnitVectors(Y, dir)).translate(dir.x * 0.04, dir.y * 0.03, dir.z * 0.04)));
      }
      return mergeGeometries(pieces);
    })());
    // Starfish: five plump arms, flat to the bottom.
    const starfish = shape(6, (() => {
      const outline = new THREE.Shape();
      for (let k = 0; k < 40; k++) {
        const a = (k / 40) * Math.PI * 2;
        const r = 0.028 + 0.075 * Math.pow(0.5 + 0.5 * Math.cos(5 * a), 1.3);
        if (k === 0) outline.moveTo(r * Math.cos(a), r * Math.sin(a));
        else outline.lineTo(r * Math.cos(a), r * Math.sin(a));
      }
      const g = new THREE.ExtrudeGeometry(outline, { depth: 0.006, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2, curveSegments: 1 });
      return g.rotateX(-Math.PI / 2);
    })());

    const stoneTint = new THREE.Color("#e0c8b0");
    const brainTints = ["#f0c860", "#f0a070", "#d8a8e8", "#f4d860", "#f090a8"].map((c) => new THREE.Color(c));
    const branchTints = ["#ff9ab8", "#b890ff", "#ffc888", "#ff8a6a", "#f08ad0", "#ffe08a"].map((c) => new THREE.Color(c));
    const spongeTints = ["#ff8a2e", "#e8cc3a", "#9a5ac8", "#ff6a4a"].map((c) => new THREE.Color(c));
    [[-2.1, -7.3, 0.7], [0.9, -9.8, 0.55], [2.9, -7.1, 0.8], [-0.9, -14.5, 1.1], [1.9, -13.2, 0.9], [-3.3, -6.0, 0.6], [0.2, -6.9, 0.35], [-1.7, -10.4, 0.5], [3.4, -9.6, 0.65], [-2.6, -12.4, 0.8]].forEach(([x, z, s], i) => {
      q.setFromEuler(new THREE.Euler(0, hash(i, 1) * 6.28, 0));
      m.compose(new THREE.Vector3(x, ground(x, z) + s * 0.1, z), q, new THREE.Vector3(s * (1 + hash(i, 2) * 0.4), s * (0.5 + hash(i, 3) * 0.25), s * (1 + hash(i, 4) * 0.3)));
      put(boulders[near(x, z) ? 0 : 1], m, stoneTint);
    });
    // The corals scattered over the reef heads, thinly elsewhere.
    let placed = 0;
    for (let i = 0; placed < 150 && i < 1200; i++) {
      const x = (hash(i, 11) - 0.5) * 9;
      const z = -1 - hash(i, 12) * 17;
      const reef = reefAt(x, z, true);
      if (hash(i, 13) > reef * 0.4 + 0.03) continue;
      placed++;
      const y0 = ground(x, z);
      const pick = hash(i, 14);
      const s = 1.0 + hash(i, 16) * 1.1;
      const lod = near(x, z) ? 0 : 1;
      q.setFromEuler(new THREE.Euler((hash(i, 17) - 0.5) * 0.3, hash(i, 15) * 6.28, (hash(i, 18) - 0.5) * 0.3));
      if (pick < 0.32) {
        m.compose(new THREE.Vector3(x, y0 - 0.05 * s, z), q, new THREE.Vector3(0.3 * s, 0.17 * s, 0.27 * s));
        put(domes[lod], m, brainTints[i % brainTints.length]);
      } else if (pick < 0.7) {
        m.compose(new THREE.Vector3(x, y0, z), q, new THREE.Vector3(s, s * (0.8 + hash(i, 19) * 0.4), s));
        put(branchings[lod][i % 3], m, branchTints[i % branchTints.length]);
      } else if (pick < 0.82) {
        m.compose(new THREE.Vector3(x, y0, z), q, new THREE.Vector3(s * 0.6, s * 0.6, s * 0.6));
        put(tables[lod], m, new THREE.Color("#e0a0d0").offsetHSL((hash(i, 20) - 0.5) * 0.08, 0, 0));
      } else {
        m.compose(new THREE.Vector3(x, y0, z), q, new THREE.Vector3(s * 0.6, s * 0.6, s * 0.6));
        put(sponges[lod], m, spongeTints[i % spongeTints.length]);
      }
    }
    // A garden of corals on the floor under the opening and down the low mounds there, where they are seen from above
    // and from the rim: domes, branching heads, tables and sponge tubes, a little smaller than out on the reef.
    for (let i = 0, n = 0; n < 22 && i < 400; i++) {
      const x = (hash(i, 121) - 0.5) * 4;
      const z = -0.3 - hash(i, 122) * 4.5;
      // Not too close to one another.
      if (hash(i, 123) < 0.35) continue;
      n++;
      const y0 = ground(x, z);
      const pick = hash(i, 124);
      const s = 0.75 + hash(i, 125) * 0.7;
      q.setFromEuler(new THREE.Euler((hash(i, 126) - 0.5) * 0.3, hash(i, 127) * 6.28, (hash(i, 128) - 0.5) * 0.3));
      if (pick < 0.3) {
        m.compose(new THREE.Vector3(x, y0 - 0.05 * s, z), q, new THREE.Vector3(0.3 * s, 0.17 * s, 0.27 * s));
        put(domes[0], m, brainTints[i % brainTints.length]);
      } else if (pick < 0.62) {
        m.compose(new THREE.Vector3(x, y0, z), q, new THREE.Vector3(s, s * (0.8 + hash(i, 129) * 0.4), s));
        put(branchings[0][i % 3], m, branchTints[(i + 2) % branchTints.length]);
      } else if (pick < 0.8) {
        m.compose(new THREE.Vector3(x, y0, z), q, new THREE.Vector3(s * 0.6, s * 0.6, s * 0.6));
        put(tables[0], m, new THREE.Color("#e0a0d0").offsetHSL((hash(i, 130) - 0.5) * 0.12, 0, 0));
      } else {
        m.compose(new THREE.Vector3(x, y0, z), q, new THREE.Vector3(s * 0.6, s * 0.6, s * 0.6));
        put(sponges[0], m, spongeTints[i % spongeTints.length]);
      }
    }
    // Urchins and starfish on the bottom just under the hole, each stood square to the slope it is on.
    {
      const up = new THREE.Vector3();
      const spin = new THREE.Quaternion();
      const urchinTints = ["#3a2340", "#2a2a3e", "#4a2a2a"].map((c) => new THREE.Color(c));
      const starTints = ["#ff6a2c", "#e83a4a", "#ffb43a", "#a050d8"].map((c) => new THREE.Color(c));
      for (let i = 0, urchins = 0, stars = 0; i < 400 && (urchins < 16 || stars < 9); i++) {
        const x = (hash(i, 101) - 0.5) * 5;
        const z = -1.4 - hash(i, 102) * 5.8;
        const star = hash(i, 103) < 0.4;
        if (star ? stars >= 9 : urchins >= 16) continue;
        q.setFromUnitVectors(Y, facing(x, z, up)).multiply(spin.setFromAxisAngle(Y, hash(i, 104) * 6.28));
        const s = 0.8 + hash(i, 105) * 0.6;
        m.compose(up.multiplyScalar(star ? 0.005 : 0.02).add(new THREE.Vector3(x, ground(x, z) + 0.04, z)), q, new THREE.Vector3(s, s, s));
        if (star) put(starfish, m, starTints[stars++ % starTints.length]);
        else put(urchin, m, urchinTints[urchins++ % urchinTints.length]);
      }
    }
    // Anemones on the reef heads near the hole: a stout column crowned with tentacles, which reach and wave once alive,
    // more toward their tips.
    {
      const pieces = [bare(new THREE.CylinderGeometry(0.05, 0.065, 0.07, 12).translate(0, 0.035, 0))];
      pieces[0].setAttribute("bend", new THREE.BufferAttribute(new Float32Array(pieces[0].getAttribute("position").count), 1));
      const TENTACLES = 34;
      for (let k = 0; k < TENTACLES; k++) {
        // Spread over the disc, the outer ones leaning out further.
        const a = k * 2.4;
        const out = Math.sqrt((k + 0.5) / TENTACLES);
        const len = 0.07 + hash(k, 95) * 0.04;
        const g = bare(new THREE.CylinderGeometry(0.0035, 0.007, len, 4, 4, true).translate(0, len / 2, 0));
        const at = g.getAttribute("position") as THREE.BufferAttribute;
        const bend = new Float32Array(at.count);
        for (let i = 0; i < at.count; i++) {
          const t = at.getY(i) / len;
          const reach = out * 0.046 + len * t * (0.2 + 0.7 * out) + 0.03 * out * t * t;
          at.setXYZ(i, at.getX(i) + Math.cos(a) * reach, 0.07 + at.getY(i) * (1 - 0.35 * out * t), at.getZ(i) + Math.sin(a) * reach);
          bend[i] = t;
        }
        g.computeVertexNormals();
        g.setAttribute("bend", new THREE.BufferAttribute(bend, 1));
        pieces.push(g);
      }
      const anemone = shape(7, mergeGeometries(pieces));
      pieces.forEach((g) => g.dispose());
      const tints = ["#b07ae8", "#8fd06a", "#ff8a50", "#f07ab8"].map((c) => new THREE.Color(c));
      const up = new THREE.Vector3();
      const spin = new THREE.Quaternion();
      for (let i = 0, n = 0; n < 7 && i < 400; i++) {
        const x = (hash(i, 111) - 0.5) * 6;
        const z = -1.6 - hash(i, 112) * 6;
        if (reefAt(x, z) < 0.7 || facing(x, z, up).y < 0.75) continue;
        q.setFromUnitVectors(Y, up).multiply(spin.setFromAxisAngle(Y, hash(i, 113) * 6.28));
        const s = 1 + hash(i, 114) * 0.7;
        m.compose(new THREE.Vector3(x, ground(x, z) + 0.02, z), q, new THREE.Vector3(s, s, s));
        put(anemone, m, tints[n++ % tints.length]);
      }
    }

    // Every placing into the one mesh: its points moved into place and its normals turned with it.
    let [points, corners] = [0, 0];
    for (const s of shapes) {
      const placings = s.tints.length / 3;
      points += placings * s.geometry.getAttribute("position").count;
      corners += placings * (s.geometry.index ? s.geometry.index.count : s.geometry.getAttribute("position").count);
    }
    const position = new Float32Array(points * 3);
    const normal = new Float32Array(points * 3);
    const tint = new Float32Array(points * 3);
    const part = new Float32Array(points * 3);
    const index = new Uint32Array(corners);
    const turn = new THREE.Matrix3();
    let [v, c] = [0, 0];
    for (const s of shapes) {
      const g = s.geometry;
      const P = g.getAttribute("position").array;
      const N = g.getAttribute("normal").array;
      const B = g.getAttribute("bend")?.array;
      const I = g.index?.array;
      const count = P.length / 3;
      g.computeBoundingBox();
      const [y0, y1] = [g.boundingBox!.min.y, g.boundingBox!.max.y];
      for (let j = 0; j < s.tints.length / 3; j++) {
        const e = m.fromArray(s.matrices, j * 16).elements;
        const r = turn.getNormalMatrix(m).elements;
        if (I) for (let i = 0; i < I.length; i++) index[c++] = v + I[i];
        else for (let i = 0; i < count; i++) index[c++] = v + i;
        for (let i = 0; i < count; i++, v++) {
          const [x, y, z] = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
          position[v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
          position[v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          position[v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
          const [nx, ny, nz] = [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]];
          const [tx, ty, tz] = [r[0] * nx + r[3] * ny + r[6] * nz, r[1] * nx + r[4] * ny + r[7] * nz, r[2] * nx + r[5] * ny + r[8] * nz];
          const l = Math.hypot(tx, ty, tz) || 1;
          normal[v * 3] = tx / l;
          normal[v * 3 + 1] = ty / l;
          normal[v * 3 + 2] = tz / l;
          tint[v * 3] = s.tints[j * 3];
          tint[v * 3 + 1] = s.tints[j * 3 + 1];
          tint[v * 3 + 2] = s.tints[j * 3 + 2];
          part[v * 3] = s.kind;
          part[v * 3 + 1] = (y - y0) / Math.max(1e-4, y1 - y0);
          part[v * 3 + 2] = B ? B[i] : 0;
        }
      }
      g.dispose();
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.BufferAttribute(position, 3));
    merged.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
    merged.setAttribute("tint", new THREE.BufferAttribute(tint, 3));
    merged.setAttribute("part", new THREE.BufferAttribute(part, 3));
    merged.setIndex(new THREE.BufferAttribute(index, 1));
    return merged;
  });
  geometries.push(reefGeometry);
  {
    const tint = attribute("tint", "vec3");
    const part = attribute("part", "vec3");
    const kind = part.x;
    const up = part.y;
    const bend = part.z;
    const is = (k: number) => step(k - 0.5, kind).mul(step(kind, k + 0.5));
    // Rock textured from all three sides.
    const w = pow(abs(normalWorld), vec3(4));
    const tri = texture(extra.coral, p.yz.div(1.6)).rgb.mul(w.x).add(texture(extra.coral, p.xz.div(1.6)).rgb.mul(w.y)).add(texture(extra.coral, p.xy.div(1.6)).rgb.mul(w.z)).div(w.x.add(w.y).add(w.z));
    const grain = dot(tri, vec3(0.3, 0.59, 0.11));
    const at = skew(p);
    // Brain coral's winding grooves (the contours of a soft swell), the polyps' fine grain (a net of tiny cells).
    const grooves = smoothstep(0.015, 0.06, abs(sea(at.mul(2.5)).b.sub(0.5)));
    const polyps = float(1).sub(sea(at.mul(6).add(0.21)).r).mul(0.3).add(0.75);
    const mouth = smoothstep(0.93, 0.99, up).mul(0.85);
    // Rock under its living crust; brain coral's grooves; branching coral's polyps, paler to the tips; a table's grain;
    // a sponge dark down its mouth; an urchin's spines paler to their points; a starfish's warty dots; an anemone's
    // tentacles glowing toward their tips. Each a little darker low down, where the reef shades itself.
    const albedo = reefSkin(tri.mul(tint).mul(1.3), at)
      .mul(is(0))
      .add(tint.mul(grooves.mul(0.55).add(0.45)).mul(grain.mul(1.1).add(0.65)).mul(is(1)))
      .add(tint.mul(polyps).mul(mix(float(0.8), float(1.2), up)).mul(is(2)))
      .add(tint.mul(grain.mul(0.9).add(0.65)).mul(is(3)))
      .add(tint.mul(float(1).sub(mouth)).mul(polyps).mul(is(4)))
      .add(tint.mul(mix(float(0.6), float(1.6), up.mul(up))).mul(is(5)))
      .add(mix(tint, vec3(1, 0.88, 0.65), smoothstep(0.93, 1.02, polyps).mul(0.55)).mul(is(6)))
      .add(mix(tint.mul(0.4), mix(tint, vec3(1, 0.92, 0.95), 0.35).mul(1.3), pow(bend, 1.5)).mul(is(7)));
    const material = underwater(albedo.mul(mix(float(0.6), float(1), smoothstep(0, 0.6, up))), normalWorld);
    // The anemones' tentacles wave once alive, each its own way.
    const sway = vec3(sin(time.mul(1.6).add(positionLocal.y.mul(20)).add(positionLocal.x.mul(7))), 0, sin(time.mul(1.2).add(positionLocal.x.mul(25)).add(positionLocal.z.mul(5))));
    material.positionNode = positionLocal.add(sway.mul(stir.mul(0.018)).mul(bend.mul(bend)));
    real.add(new THREE.Mesh(reefGeometry, material));
  }

  // ---- Sea fans: lace fans standing on the reef heads, swaying once alive.
  const fanGeometry = new THREE.PlaneGeometry(0.75, 0.6, 6, 6);
  fanGeometry.translate(0, 0.3, 0);
  geometries.push(fanGeometry);
  const FANS = 9;
  const fanTops: number[] = [];
  {
    const u = uv();
    const c = u.sub(vec2(0.5, 0));
    const outline = step(length(c.mul(vec2(1, 0.85))), float(0.5).add(sea(u.mul(0.3)).a.sub(0.5).mul(0.12)));
    // A lace of the contours of two soft swells, and ribs fanning out from the foot.
    const lace = sea(u.mul(vec2(2.4, 2)).add(0.2)).ba.sub(0.5).mul(1.4);
    const veins = max(max(float(1).sub(smoothstep(0.03, 0.08, abs(lace.x))), float(1).sub(smoothstep(0.03, 0.08, abs(lace.y)))), float(1).sub(smoothstep(0.02, 0.06, abs(sin(atan(c.x, c.y.add(0.05)).mul(9))))).mul(0.8));
    const fanMaterial = underwater(vec3(0.78, 0.22, 0.56).mul(veins.mul(0.4).add(0.8)), vec3(0, 0.6, 0), THREE.DoubleSide);
    fanMaterial.opacityNode = outline.mul(veins);
    fanMaterial.alphaTest = 0.5;
    const along = positionGeometry.y;
    fanMaterial.positionNode = positionLocal.add(vec3(sin(time.mul(1.1).add(positionLocal.x.mul(0.8))), 0, sin(time.mul(0.8).add(positionLocal.z.mul(0.6))).mul(0.6)).mul(stir.mul(0.12)).mul(along.mul(along).mul(2.8)));
    const fans = new THREE.InstancedMesh(fanGeometry, fanMaterial, FANS);
    for (let i = 0; i < FANS; i++) {
      const x = (hash(i, 31) - 0.5) * 6.5;
      const z = -4.5 - hash(i, 32) * 9;
      q.setFromEuler(new THREE.Euler((hash(i, 33) - 0.5) * 0.25, (hash(i, 34) - 0.5) * 0.9, 0));
      const s = 0.7 + hash(i, 35) * 0.7;
      m.compose(new THREE.Vector3(x, ground(x, z), z), q, new THREE.Vector3(s, s, s));
      fans.setMatrixAt(i, m);
      // (Its top and either edge, for where the fish may swim.)
      fanTops.push(x, ground(x, z) + 0.6 * s, z, x - 0.37 * s, ground(x, z) + 0.45 * s, z, x + 0.37 * s, ground(x, z) + 0.45 * s, z);
    }
    real.add(fans);
  }

  // ---- Sea grass in meadows on the sand, growing in tufts: thin ribbon blades bowed over by their own weight, each its
  // own length, width and green, darkest at the root and yellowing toward the tip. Once alive they sway, the bend
  // running up each blade from its root.
  const blade = new THREE.PlaneGeometry(0.022, 1, 1, 5);
  blade.translate(0, 0.5, 0);
  {
    // Narrowing to a rounded tip, and bowed.
    const at = blade.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < at.count; i++) {
      const y = at.getY(i);
      at.setXYZ(i, at.getX(i) * (1 - 0.75 * y ** 3), y * (1 - 0.06 * y), 0.16 * y * y);
    }
  }
  geometries.push(blade);
  const BLADES = 1800;
  {
    const along = positionGeometry.y;
    // Each blade's own number, for its own green and its own phase.
    const own = sin(instanceIndex.toFloat().mul(12.9898)).mul(43758.5453).fract();
    const wave = time.mul(1.3).sub(along.mul(2.2)).add(positionLocal.x.mul(1.7)).add(positionLocal.z.mul(0.9)).add(own.mul(2));
    const bend = vec3(sin(wave), 0, sin(wave.mul(0.7).add(1.3)).mul(0.5).add(0.6)).mul(stir.mul(0.09)).mul(along.mul(along));
    // At rest each blade leans a little its own way already (the current's set), and moves from there.
    const lean = vec3(mx_noise_float(vec3(positionLocal.xz.mul(3), 1)), 0, mx_noise_float(vec3(positionLocal.xz.mul(3), 2)).add(0.4)).mul(0.08).mul(along.mul(along));
    const root = vec3(0.05, 0.09, 0.03);
    const green = mix(vec3(0.3, 0.5, 0.14), vec3(0.46, 0.58, 0.16), own);
    const tip = mix(green, vec3(0.7, 0.66, 0.3), smoothstep(0.75, 1, along).mul(step(0.55, own)));
    const grassMaterial = underwater(mix(root, mix(green, tip, smoothstep(0.6, 1, along)), smoothstep(0, 0.45, along)).mul(sea(p.xz.div(3)).b.mul(0.4).add(0.8)), vec3(0, 0.75, 0), THREE.DoubleSide);
    grassMaterial.positionNode = positionLocal.add(bend).add(lean);
    const grass = new THREE.InstancedMesh(blade, grassMaterial, BLADES);
    let n = 0;
    const meadows = [[-0.8, -5.2, 1.2], [0.2, -8.2, 1.2], [-2.0, -12.2, 1.1], [2.9, -8.2, 1.0], [1.2, -14.6, 1.2]];
    // Tufts of eight to sixteen blades about a root, each tuft its own height.
    for (let t = 0; n < BLADES && t < 1200; t++) {
      const [mx, mz, mr] = meadows[t % meadows.length];
      const a = hash(t, 41) * 6.28;
      const r = Math.sqrt(hash(t, 42)) * mr * 1.3;
      const [cx, cz] = [mx + Math.cos(a) * r, mz + Math.sin(a) * r * 1.4];
      if (reefAt(cx, cz) > 1.2) continue;
      const tall = 0.18 + hash(t, 46) * 0.3;
      const blades = 8 + Math.floor(hash(t, 47) * 9);
      for (let k = 0; k < blades && n < BLADES; k++) {
        const i = t * 17 + k;
        const [x, z] = [cx + (hash(i, 48) - 0.5) * 0.09, cz + (hash(i, 49) - 0.5) * 0.09];
        // Fanning out from the tuft's root.
        const turn = hash(i, 44) * 6.28;
        q.setFromEuler(new THREE.Euler((hash(i, 43) - 0.5) * 0.32, turn, (hash(i, 45) - 0.5) * 0.32));
        m.compose(new THREE.Vector3(x, ground(x, z), z), q, new THREE.Vector3(0.6 + hash(i, 50) * 0.9, tall * (0.6 + hash(i, 51) * 0.6), 1));
        grass.setMatrixAt(n++, m);
      }
    }
    grass.count = n;
    real.add(grass);
  }

  // ---- Fish: a school of small blue fish with yellow tails, and bigger ones in reef colours wandering the reef. One
  // mesh; each fish's place, heading and size are set on the processor each frame, and the body is bent, posed and
  // turned on the graphics card.
  const SCHOOL = 150;
  const FISH = SCHOOL + 14;
  // A fish along z (nose forward): a body turned on its length (rings along it, from a rounded snout, deepest a little
  // ahead of the middle, narrowing to a slim stalk at the tail), deep and narrow, with a forked tail and fins along its
  // back, under its belly and at its sides. Each fin is a thin blade (a flattened pyramid), and marked as fin so it is
  // coloured as one.
  const fishGeometry = keep("fish", () => {
    const body = mergeVertices(bare(new THREE.SphereGeometry(0.5, 9, 12).rotateX(Math.PI / 2)).deleteAttribute("normal"));
    const at = body.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < at.count; i++) {
      const [x, y, z] = [at.getX(i), at.getY(i), at.getZ(i)];
      const along = z + 0.5;
      const deep = 0.2 * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(along, 1.3))), 0.7) + 0.03 * (1 - along);
      const round = Math.hypot(x, y) || 1;
      at.setXYZ(i, (x / round) * deep * 0.46, (y / round) * deep, z);
    }
    body.computeVertexNormals();
    const pieces = [body];
    const fin = (length: number, height: number, tilt: number, roll: number, x: number, y: number, z: number) => {
      const g = new THREE.ConeGeometry(length / 2, height, 4).deleteAttribute("uv").translate(0, height / 2, 0).scale(0.1, 1, 1);
      pieces.push(mergeVertices(g.rotateX(tilt).rotateZ(roll).translate(x, y, z)));
    };
    fin(0.16, 0.24, -0.85, 0, 0, 0.02, -0.46);
    fin(0.16, 0.24, -2.29, 0, 0, -0.02, -0.46);
    fin(0.36, 0.12, -0.4, 0, 0, 0.15, -0.02);
    fin(0.2, 0.1, -2.6, 0, 0, -0.13, -0.18);
    fin(0.12, 0.12, -1.9, 1.1, 0.04, -0.03, 0.12);
    fin(0.12, 0.12, -1.9, -1.1, -0.04, -0.03, 0.12);
    const finned = pieces.map((g, k) => g.setAttribute("fin", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count).fill(k > 0 ? 1 : 0), 1)));
    const merged = mergeGeometries(finned);
    finned.forEach((g) => g.dispose());
    return merged;
  });
  const loners = ["#2a4ac0", "#ffd02a", "#ff7a30", "#ffd02a", "#d050b0", "#30a0e0", "#ff9a40"].map((c) => new THREE.Color(c));
  const spots = new THREE.InstancedBufferAttribute(new Float32Array(FISH * 4), 4);
  const aims = new THREE.InstancedBufferAttribute(new Float32Array(FISH * 4), 4);
  spots.setUsage(THREE.DynamicDrawUsage);
  aims.setUsage(THREE.DynamicDrawUsage);
  {
    const looks = new THREE.InstancedBufferAttribute(new Float32Array(FISH * 4), 4);
    for (let i = 0; i < FISH; i++) {
      const school = i < SCHOOL;
      const c = school ? new THREE.Color("#3a7cc8").offsetHSL((hash(i, 51) - 0.5) * 0.03, 0, (hash(i, 52) - 0.5) * 0.06) : loners[i % loners.length];
      looks.setXYZW(i, c.r, c.g, c.b, school ? 1 : 2);
    }
    const material = new THREE.MeshBasicNodeMaterial();
    const spot = instancedDynamicBufferAttribute(spots, "vec4") as any;
    const aim = instancedDynamicBufferAttribute(aims, "vec4") as any;
    const look = instancedBufferAttribute(looks, "vec4") as any;
    const fin = attribute("fin", "float");
    const local = positionGeometry;
    const school = step(look.w, 1.5);
    // Swimming: a wave down the body, growing toward the tail. None at rest.
    const tailward = smoothstep(0.25, -0.6, local.z);
    const beat = sin(time.mul(mix(float(7), float(13), school)).add(aim.w.mul(6.28)).sub(local.z.mul(5))).mul(0.11).mul(tailward).mul(stir);
    const deep = mix(float(1.8), float(1), school);
    // The side fins row, a beat of their own, out at their tips.
    const row = sin(time.mul(9).add(aim.w.mul(11))).mul(abs(local.x).sub(0.05).max(0).mul(fin).mul(0.9)).mul(stir.mul(0.6).add(0.15));
    // (The bigger fish deep-bodied; their fins not stretched with them, or they would stand out as spikes.)
    const body = vec3(local.x.add(beat), local.y.mul(mix(deep, deep.mul(0.4).add(0.6), fin)), local.z.mul(mix(float(0.85), float(1), school)).add(row));
    const forward = normalize(aim.xyz) as any;
    const right = normalize(cross(vec3(0, 1, 0), forward));
    const up = cross(forward, right);
    material.positionNode = right.mul(body.x).add(up.mul(body.y)).add(forward.mul(body.z)).mul(spot.w).add(spot.xyz);
    const n = varying(normalize(right.mul(normalGeometry.x).add(up.mul(normalGeometry.y)).add(forward.mul(normalGeometry.z))));
    // Dark back and silver belly on the school, with yellow tails; the others one colour, darker to the tail, the
    // yellow ones with a dark band through the eye. Fins a shade paler and plainer; a dark eye in a gold ring.
    const belly = smoothstep(0.03, -0.05, local.y).mul(float(1).sub(fin));
    const tail = smoothstep(-0.38, -0.5, local.z);
    const schoolColour = mix(mix(look.rgb, vec3(0.78, 0.82, 0.86), belly), vec3(0.95, 0.75, 0.15), tail);
    const band = smoothstep(0.04, 0.02, abs(local.z.sub(0.29))).mul(step(0.3, look.g));
    const other = mix(mix(look.rgb, look.rgb.mul(0.3), tail.mul(0.6)), vec3(0.03, 0.03, 0.04), band.mul(float(1).sub(fin)));
    const eyeAt = length(vec2(local.z.sub(0.31), local.y.sub(0.04).mul(deep))).div(mix(float(0.05), float(0.04), school));
    const eye = smoothstep(1, 0.85, eyeAt).mul(float(1).sub(fin));
    let albedo = mix(other, schoolColour, school);
    // Countershaded, as fish are: darker along the back, paler under the belly. Over the flanks a fine net of scales.
    const facing = normalGeometry.y;
    albedo = albedo.mul(mix(float(1.18), float(0.62), smoothstep(-0.4, 0.7, facing)));
    const scales = abs(sin(local.z.mul(150).add(local.y.mul(90)))).mul(abs(sin(local.z.mul(150).sub(local.y.mul(90)))));
    albedo = albedo.mul(scales.mul(0.12).add(0.94).mul(float(1).sub(fin)).add(fin));
    albedo = mix(albedo, albedo.mul(0.75).add(0.06), fin);
    albedo = mix(albedo, mix(vec3(0.02, 0.02, 0.02), vec3(0.7, 0.55, 0.2), smoothstep(0.6, 0.75, eyeAt)), eye);
    // The silver flanks flash as they catch the light from above.
    const view = normalize(cameraPosition.sub(p));
    const mirror = n.mul(dot(n, view).mul(2)).sub(view);
    const flash = pow(clamp(mirror.y, 0, 1), 6).mul(school).mul(float(1).sub(fin)).mul(1.6);
    // And a soft sheen round every body's edge, as wet scales catch the light.
    const sheen = pow(float(1).sub(abs(dot(n, view))), 3).mul(float(1).sub(fin)).mul(0.35);
    material.colorNode = lit(albedo.mul(1.2), n, 0.4).add(vec3(0.6, 0.85, 0.95).mul(flash.add(sheen)).mul(exp(float(WATER).sub(p.y).mul(-0.15))));
    material.outputNode = vec4(seen(output.rgb), output.a) as any;
    materials.push(material);
    geometries.push(fishGeometry);
    const mesh = new THREE.InstancedMesh(fishGeometry, material, FISH);
    // Placed on the graphics card, so not where the scene's own reckoning would look for it.
    mesh.frustumCulled = false;
    real.add(mesh);
  }
  const fishSeeds = Array.from({ length: FISH }, (_, i) => ({
    lag: hash(i, 61) * 2.2,
    side: (hash(i, 62) - 0.5) * 1.9,
    rise: (hash(i, 63) - 0.5) * 0.7,
    ahead: (hash(i, 64) - 0.5) * 0.9,
    phase: hash(i, 65),
    size: i < SCHOOL ? 0.2 + hash(i, 66) * 0.05 : 0.27 + hash(i, 66) * 0.06,
    home: BOMMIES[i % BOMMIES.length]
  }));
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const side = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  room ??= makeRoom([reefGeometry.getAttribute("position").array, floorGeometry.getAttribute("position").array, fanTops], wallGeometry.getAttribute("position").array);
  const { floor: below, roof: above } = room;
  // Each fish's way, kept clear of everything solid: lifted over whatever rises under it, kept under the walls' lip.
  const fishAt = (i: number, u: number, out: THREE.Vector3) => {
    wayOf(i, u, out);
    const lowest = roomAt(below, out.x, out.z) + 0.28;
    out.y = Math.max(lowest, Math.min(out.y, roomAt(above, out.x, out.z) - 0.18));
    return out;
  };
  const wayOf = (i: number, u: number, out: THREE.Vector3) => {
    const s = fishSeeds[i];
    if (i < SCHOOL) {
      // A place in the school, carried along its way and turned with it, each fish weaving a little on its own.
      const at = u - s.lag;
      schoolAt(at + 0.05, vb);
      schoolAt(at - 0.05, vc);
      fwd.subVectors(vb, vc).normalize();
      side.crossVectors(UP, fwd).normalize();
      schoolAt(at, out);
      return out.addScaledVector(side, s.side + 0.08 * Math.sin(u * 1.1 + s.phase * 6.28)).addScaledVector(fwd, s.ahead).add(vc.set(0, s.rise + 0.05 * Math.sin(u * 0.9 + s.phase * 9), 0));
    }
    // The bigger fish each wander slowly round their own reef head, low about its flanks.
    const [bx, bz, tall, , sunk] = s.home;
    const h = tall * (sunk ?? 1);
    const w = u * 0.12 * (0.7 + s.phase * 0.6) + s.phase * 6.28;
    return out.set(bx + Math.cos(w) * 1.3, seabed(bx, bz) - h * 0.45 + 0.4 + 0.15 * Math.sin(w * 1.7), bz + Math.sin(w * 1.3) * 1.1);
  };
  const placeFish = (u: number) => {
    for (let i = 0; i < FISH; i++) {
      fishAt(i, u, va);
      const x = va.x;
      const y = va.y;
      const z = va.z;
      fishAt(i, u + 0.04, va);
      spots.setXYZW(i, x, y, z, fishSeeds[i].size);
      aims.setXYZW(i, va.x - x, (va.y - y) * 0.5, va.z - z, fishSeeds[i].phase);
    }
    spots.needsUpdate = true;
    aims.needsUpdate = true;
  };
  placeFish(0);

  // ---- A second school, of tiny dark chromis, sweeping close-packed under the opening, a shimmer of flanks as they
  // turn. All on the graphics card: the school's way is worked out there from how far it has swum (one number, set each
  // frame), each fish keeping its own place in the school, weaving a little and beating its tail. One mesh.
  const CHROMIS = 110;
  const swim = uniform(0);
  {
    const geometry = keep("chromis", () => {
      const body = mergeVertices(bare(new THREE.SphereGeometry(0.5, 6, 6).rotateX(Math.PI / 2)).deleteAttribute("normal"));
      const at = body.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < at.count; i++) {
        const [x, y, z] = [at.getX(i), at.getY(i), at.getZ(i)];
        const deep = 0.24 * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(z + 0.5, 1.2))), 0.7) + 0.03;
        const round = Math.hypot(x, y) || 1;
        at.setXYZ(i, (x / round) * deep * 0.42, (y / round) * deep, z);
      }
      body.computeVertexNormals();
      const tail = new THREE.ConeGeometry(0.17, 0.26, 3).deleteAttribute("uv").scale(0.12, 1, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.58);
      const merged = mergeGeometries([body, mergeVertices(tail)]);
      [body, tail].forEach((g) => g.dispose());
      return merged;
    });
    geometries.push(geometry);
    // Each fish's place in the school (an egg of water half a metre across), size and phase.
    const places = new THREE.InstancedBufferAttribute(new Float32Array(CHROMIS * 4), 4);
    for (let i = 0; i < CHROMIS; i++) {
      const [a, b, r] = [hash(i, 141) * 6.28, Math.acos(2 * hash(i, 142) - 1), Math.cbrt(hash(i, 143))];
      places.setXYZW(i, Math.sin(b) * Math.cos(a) * r * 0.55, Math.cos(b) * r * 0.2, Math.sin(b) * Math.sin(a) * r * 0.55, hash(i, 144));
    }
    const place = instancedBufferAttribute(places, "vec4") as any;
    // The school's way: a slow loop under the opening, clear of the low mounds and the walls' lip.
    const along = swim.sub(place.w.mul(0.6));
    const centre = vec3(sin(along.mul(0.4)).mul(1.1), sin(along.mul(0.53)).mul(0.22).sub(3.15), sin(along.mul(0.29).add(0.7)).mul(1.5).sub(2.6));
    const heading = normalize(vec3(cos(along.mul(0.4)).mul(0.44), cos(along.mul(0.53)).mul(0.06), cos(along.mul(0.29).add(0.7)).mul(0.435)));
    const weave = vec3(sin(time.mul(1.7).add(place.w.mul(31))), sin(time.mul(1.3).add(place.w.mul(17))).mul(0.4), sin(time.mul(1.5).add(place.w.mul(23)))).mul(stir.mul(0.05));
    const spotAt = centre.add(place.xyz).add(weave);
    // Turning a little on their own about the school's heading: the flicker of the shoal.
    const turn = sin(time.mul(2.3).add(place.w.mul(40))).mul(stir.mul(0.35)).add(place.w.sub(0.5).mul(0.3));
    const forward = normalize(heading.add(vec3(heading.z, 0, heading.x.negate()).mul(turn))) as any;
    const right = normalize(cross(vec3(0, 1, 0), forward));
    const up = cross(forward, right);
    const local = positionGeometry;
    const beat = sin(time.mul(16).add(place.w.mul(6.28)).sub(local.z.mul(6))).mul(0.12).mul(smoothstep(0.2, -0.6, local.z)).mul(stir);
    const size = place.w.mul(0.025).add(0.075);
    const material = new THREE.MeshBasicNodeMaterial();
    material.positionNode = right.mul(local.x.add(beat)).add(up.mul(local.y)).add(forward.mul(local.z)).mul(size).add(spotAt);
    const n = varying(normalize(right.mul(normalGeometry.x).add(up.mul(normalGeometry.y)).add(forward.mul(normalGeometry.z))));
    // Near black, a blue-grey sheen on the back, and the flanks flashing as they turn to the light.
    const albedo = mix(vec3(0.09, 0.11, 0.15), vec3(0.03, 0.035, 0.05), smoothstep(-0.4, 0.6, normalGeometry.y));
    const view = normalize(cameraPosition.sub(p));
    const mirror = n.mul(dot(n, view).mul(2)).sub(view);
    const flash = pow(clamp(mirror.y, 0, 1), 5).mul(0.9).add(pow(float(1).sub(abs(dot(n, view))), 3).mul(0.25));
    material.colorNode = lit(albedo, n, 0.3).add(vec3(0.45, 0.65, 0.85).mul(flash).mul(exp(float(WATER).sub(p.y).mul(-0.15))));
    material.outputNode = vec4(seen(output.rgb), output.a) as any;
    materials.push(material);
    const chromis = new THREE.InstancedMesh(geometry, material, CHROMIS);
    // Placed on the graphics card, so not where the scene's own reckoning would look for it.
    chromis.frustumCulled = false;
    real.add(chromis);
  }

  // ---- Bubbles rising from the reef once alive.
  const BUBBLES = 54;
  const bubbleGeometry = new THREE.SphereGeometry(1, 10, 6);
  geometries.push(bubbleGeometry);
  const bubbleMaterial = new THREE.MeshBasicNodeMaterial();
  {
    const view = normalize(cameraPosition.sub(p));
    const rim = pow(float(1).sub(abs(dot(normalWorld, view))), 2);
    bubbleMaterial.colorNode = mix(vec3(0.05, 0.25, 0.3), vec3(1.1, 1.2, 1.2), rim);
    bubbleMaterial.outputNode = vec4(seen(output.rgb), output.a) as any;
  }
  materials.push(bubbleMaterial);
  const bubbles = new THREE.InstancedMesh(bubbleGeometry, bubbleMaterial, BUBBLES);
  const vents = [[-1.1, -6.1], [1.7, -8.4], [-0.2, -11.2]].map(([x, z]) => new THREE.Vector3(x, seabed(x, z) + 0.1, z));
  const bubbleSeeds = Array.from({ length: BUBBLES }, (_, i) => ({ vent: vents[i % vents.length], phase: hash(i, 71), size: 0.008 + hash(i, 72) ** 2 * 0.022, wander: hash(i, 73) * 6.28 }));
  const placeBubbles = (t: number, wake: number) => {
    bubbleSeeds.forEach((b, i) => {
      const rise = WATER - 0.03 - b.vent.y;
      const along = (b.phase + (t * 0.55) / rise) % 1;
      const size = b.size * wake * Math.min(1, along * 8);
      const drift = 0.15 * along;
      m.makeScale(size, size * 0.8, size).setPosition(b.vent.x + Math.sin(t * 2.3 + b.wander) * drift, b.vent.y + along * rise, b.vent.z + Math.cos(t * 1.9 + b.wander) * drift);
      bubbles.setMatrixAt(i, m);
    });
    bubbles.instanceMatrix.needsUpdate = true;
  };
  placeBubbles(0, 0);
  real.add(bubbles);


  // ---- Shafts of sunlight slanting down through the water toward the eye, bent steeper by the surface, shimmering
  // once alive. Each a long ribbon turned to face the artist, glowing over whatever is behind it.
  const SHAFTS = 26;
  const ray = new THREE.Vector3(0.2, -0.72, 0.66).normalize();
  const shaftGeometry = new THREE.PlaneGeometry(1, 1, 1, 8);
  shaftGeometry.translate(0, -0.5, 0);
  geometries.push(shaftGeometry);
  const shaftMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  // Added to the colour, the alpha left alone (the artist's picture uses it as how much is drawn, so it must stay 1).
  shaftMaterial.blending = THREE.CustomBlending;
  shaftMaterial.blendSrc = THREE.OneFactor;
  shaftMaterial.blendDst = THREE.OneFactor;
  shaftMaterial.blendSrcAlpha = THREE.ZeroFactor;
  shaftMaterial.blendDstAlpha = THREE.OneFactor;
  {
    const u = uv();
    const seed = attribute("shaft", "float");
    // Soft across, fading in under the surface and out with depth, flickering as the surface above moves (the flicker
    // the same all along a shaft, so worked out at its corners).
    const across = pow(float(1).sub(abs(u.x.mul(2).sub(1))), 2);
    const down = float(1).sub(u.y);
    const fade = smoothstep(0, 0.08, down).mul(exp(down.mul(-2.6)));
    const flicker = varying(mx_noise_float(vec3(seed.mul(7.3), time.mul(0.35), 0)).mul(0.6).add(0.75).clamp(0.15, 1.4));
    const far = length(p.sub(cameraPosition));
    const wet = clamp(float(WATER).sub(p.y).div(max(cameraPosition.y.sub(p.y), 0.001)), 0, 1);
    const through = exp(vec3(ABSORB).mul(0.6).mul(far.mul(wet)).negate());
    shaftMaterial.colorNode = vec3(0.42, 0.7, 0.66).mul(across).mul(fade).mul(flicker).mul(through);
  }
  materials.push(shaftMaterial);
  {
    const pieces: THREE.BufferGeometry[] = [];
    const look = new THREE.Vector3();
    for (let i = 0; i < SHAFTS; i++) {
      const top = new THREE.Vector3((hash(i, 81) - 0.5) * 9, WATER - 0.02, -5 - hash(i, 82) * 22);
      const len = 6 + hash(i, 83) * 8;
      const wide = 0.25 + hash(i, 84) ** 2 * 1.1;
      // Along the ray, its face turned toward the eye.
      look.set(0, 1.65, 4).sub(top);
      const sideways = new THREE.Vector3().crossVectors(ray, look).normalize();
      const facing = new THREE.Vector3().crossVectors(sideways, ray).normalize();
      const g = shaftGeometry.clone();
      g.applyMatrix4(new THREE.Matrix4().makeBasis(sideways.multiplyScalar(wide), ray.clone().negate().multiplyScalar(len), facing).setPosition(top));
      g.deleteAttribute("normal");
      g.setAttribute("shaft", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count).fill(i), 1));
      pieces.push(g);
    }
    const merged = mergeGeometries(pieces);
    pieces.forEach((g) => g.dispose());
    geometries.push(merged);
    const shafts = new THREE.Mesh(merged, shaftMaterial);
    shafts.renderOrder = 1;
    real.add(shafts);
  }

  // ---- The surface: clear and bright, reflecting the sky more the lower it is seen, glassy as chalk and rippling once alive.
  // Its own faint colour and the light it reflects are added over what is below, which shows through by however much
  // is not reflected.
  // Only as big as the hole at the waterline: traced round the wall there and a few centimetres into it, so it always
  // meets the wall cleanly and shows nowhere else (as it did under the sidewalk, through the cut).
  const waterGeometry = keep("water", () => {
    const middle = edge.reduce((sum, q) => sum.add(q), new THREE.Vector3()).divideScalar(edge.length);
    const ring = edge.map((q) => {
      const by = push(q, WATER) + 0.05;
      const out = new THREE.Vector2(q.x - middle.x, q.z - middle.z).normalize().multiplyScalar(by);
      return new THREE.Vector2(q.x + out.x, -(q.z + out.y));
    });
    return new THREE.ShapeGeometry(new THREE.Shape(ring)).rotateX(-Math.PI / 2).translate(0, WATER, 0);
  });
  geometries.push(waterGeometry);
  const waterMaterial = new THREE.MeshStandardNodeMaterial({ color: "#000000", roughness: 0.04, metalness: 0, transparent: true, depthWrite: false });
  waterMaterial.blending = THREE.CustomBlending;
  waterMaterial.blendSrc = THREE.OneFactor;
  waterMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
  waterMaterial.blendSrcAlpha = THREE.ZeroFactor;
  waterMaterial.blendDstAlpha = THREE.OneFactor;
  {
    // Two sets of baked ripples drifting across each other.
    const slope = (tile: number, drift: [number, number]) => texture(rippleMap, p.xz.div(tile).add(vec2(time.mul(drift[0]), time.mul(drift[1])))).rg.sub(0.5);
    const rippled = slope(3.2, [0.021, 0.013]).add(slope(1.1, [-0.03, 0.024]).mul(0.45)).mul(0.5);
    // A faint set of ripples even when still; more once alive.
    const amount = stir.mul(0.75).add(0.12);
    waterMaterial.normalNode = normalMap(vec4(vec3(rippled.x.mul(amount.negate()).add(0.5), rippled.y.mul(amount).add(0.5), 1), 1) as any);
    const view = normalize(cameraPosition.sub(p));
    const fresnel = float(0.02).add(pow(float(1).sub(clamp(view.y, 0, 1)), 5).mul(0.98));
    // What it reflects is mostly the shaded street, which would make the far water a flat dark teal; so seen low the
    // sky's own bright light is added in, as a sunlit sea's surface shows it.
    const sky = vec3(0.5, 0.78, 0.84).mul(fresnel.mul(0.42));
    waterMaterial.outputNode = vec4(output.rgb.mul(vec3(0.32, 0.5, 0.62)).add(sky).add(vec3(0.008, 0.05, 0.05).mul(float(1).sub(fresnel))), fresnel.mul(0.4).add(0.02)) as any;
  }
  materials.push(waterMaterial);
  const water = new THREE.Mesh(waterGeometry, waterMaterial);
  water.receiveShadow = true;
  water.renderOrder = 2;
  real.add(water);

  const shade = shadeFor(edge);
  geometries.push(shade.geometry);
  materials.push(shade.material);
  const extent = [...edge];
  return {
    real,
    shade: shade.mesh,
    edge,
    extent,
    covers: footprint(extent),
    // Exactly the edge's own shape, per pixel.
    inside: (at) => {
      const u = at.x.sub(HOLE.x).div(HOLE.across);
      const v = at.y.sub(HOLE.z).div(HOLE.along);
      const r = pow(u.mul(u).mul(u.mul(u)).add(v.mul(v).mul(v.mul(v))), 0.25);
      const a = atan(v, u);
      const reach = sin(a.mul(5).add(1)).mul(0.03).add(sin(a.mul(9).add(2.3)).mul(0.022)).add(sin(a.mul(19).add(0.7)).mul(0.012)).add(sin(a.mul(37).add(2)).mul(0.006)).add(1);
      return step(r, reach);
    },
    animate: (t) => {
      // Once real: the surface ripples and the light dances, the grass and fans sway, the fish swim, bubbles rise.
      const wake = wakeAt(t);
      time.value = t;
      stir.value = wake;
      placeFish(swum(t));
      placeBubbles(t, wake);
      swim.value = swum(t);
    },
    geometries,
    materials
  };
}
