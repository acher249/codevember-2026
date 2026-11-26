/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { abs, atan, attribute, cameraPosition, cross, fract, length, lights, step, clamp, dot, exp, float, max, min, mix, mod, normalMap, normalWorld, positionGeometry, positionWorld, pow, sin, smoothstep, sqrt, texture, uniform, uv, vec2, vec3, vec4 } from "three/tsl";
import { footprint, hangingRoots, holeInView, inward, nearDepth, type Root, shadeFor, SLAB, specks, wakeAt, walls, wobble, wokenFor, type Drawing, type Scans } from "../drawings";

// A hole broken through the sidewalk into a cave: a short throat of earth and rock, then a great dark chamber lined
// with crystals, clusters of them growing out of the floor and the far wall, some taller than a man, every one lit
// from inside. Once real the crystals breathe with light, waves of it running through them and across the rock, motes
// of light drift up, and the roots in the throat stir.

const ROOT = "/assets/26-anamorph/crystal";
// Textures this drawing loads for itself, by name: given to `build` once loaded. `colour` for colour maps.
export const textures: Record<string, { url: string; colour?: boolean }> = {
  rock: { url: `${ROOT}/rock_face_03_diff_2k.jpg`, colour: true },
  rockNormal: { url: `${ROOT}/rock_face_03_nor_gl_2k.jpg` }
};

const reach = (a: number) => 1 + 0.07 * Math.sin(2 * a + 1.3) + 0.05 * Math.sin(5 * a + 0.2) + 0.03 * Math.sin(9 * a + 2) + 0.015 * Math.sin(19 * a) + 0.008 * Math.sin(37 * a + 1);
const reachNode = (a: any) => sin(a.mul(2).add(1.3)).mul(0.07).add(sin(a.mul(5).add(0.2)).mul(0.05)).add(sin(a.mul(9).add(2)).mul(0.03)).add(sin(a.mul(19)).mul(0.015)).add(sin(a.mul(37).add(1)).mul(0.008)).add(1);

// The chamber: an egg of rock under the hole and running away beyond it.
// Its roof is barely a metre of earth and rock over most of the hole, so from the artist's eye the far end shows.
// Its upper half is flattened into a broad low roof (the rock's bulges fading out across it), so it is the same
// everywhere the throat comes down through it.
const CAVE = { centre: new THREE.Vector3(0, -6.2, -12.5), radii: new THREE.Vector3(10.5, 5.85, 15.5) };
const FLAT = 0.25;
// The egg's height at a direction from its middle: its upper half flattened.
const rise = (dy: number) => (dy > 0 ? Math.pow(dy, FLAT) : Math.max(dy, -0.82));
// The roof's underside over a point.
const ceiling = (x: number, z: number) => CAVE.centre.y + CAVE.radii.y * rise(Math.sqrt(Math.max(0, 1 - ((x - CAVE.centre.x) / CAVE.radii.x) ** 2 - ((z - CAVE.centre.z) / CAVE.radii.z) ** 2)));
// The light in the crystals: ice blue, with violet here and there.
const ICE = new THREE.Color(0.3, 0.78, 1.0);
const VIOLET = new THREE.Color(0.58, 0.34, 1.0);

const rand = (i: number, n: number) => {
  const v = Math.sin(i * 91.7 + n * 47.3) * 43758.5453;
  return v - Math.floor(v);
};

// How far the rock of the chamber stands in from its egg, at a direction from its middle.
// Broad swells, then knobs, then small lumps (anything finer is left to the rock's normal map).
const bulge = (d: THREE.Vector3) => (0.9 * wobble(d.x * 3.1, d.y * 2.7, d.z * 2.9) + 0.35 * wobble(d.x * 9.3, d.y * 8.1, d.z * 7.7) + 0.14 * wobble(d.x * 23.1, d.y * 27.3, d.z * 21.7)) * THREE.MathUtils.smoothstep(d.y, 0.55, 0.1);

// The chamber's rock at a direction from its middle.
const surface = (d: THREE.Vector3) => {
  const r = 1 - bulge(d) * 0.06;
  return new THREE.Vector3(CAVE.centre.x + d.x * CAVE.radii.x * r, CAVE.centre.y + rise(d.y) * CAVE.radii.y * (d.y < -0.82 ? 1 : r), CAVE.centre.z + d.z * CAVE.radii.z * r);
};

// Shapes that come out the same every build (nothing they hang on ever changes): made once, then each build handed
// a new geometry over the same arrays, which nothing alters.
const shapes = new Map<string, THREE.BufferGeometry>();
function kept(name: string, make: () => THREE.BufferGeometry) {
  let made = shapes.get(name);
  if (!made) shapes.set(name, (made = make()));
  const geometry = new THREE.BufferGeometry();
  for (const [key, a] of Object.entries(made.attributes)) geometry.setAttribute(key, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  if (made.index) geometry.setIndex(new THREE.BufferAttribute(made.index.array, 1));
  return geometry;
}

export function build(scans: Scans, extra: Record<string, THREE.Texture>): Drawing {
  const y = positionWorld.y;
  const { edge, inside } = holeInView(0.425, 0.2, reach, reachNode, 240);
  const time = uniform(0);
  // Inclusions, veils and the like inside the crystals, and glints in the rock: a small patch of noise, made here.
  const grain = noisePatch(128);
  const wake = uniform(0);
  const real = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const middle = edge.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(edge.length);

  // Waves of light running through the crystals and over the rock once real: brightness at a point and time.
  const glowAt = (p: any, seed: any) => {
    const wave = sin(dot(p, vec3(0.31, 0.12, -0.22)).sub(time.mul(1.1))).mul(0.5).add(0.5);
    const breath = sin(time.mul(0.7).add(seed.mul(2.4))).mul(0.5).add(0.5);
    return float(1).add(wake.mul(wave.mul(0.55).add(breath.mul(0.35)).sub(0.4)));
  };

  // ---- The throat: the slab, then earth with roots, then rock, down through the roof to below its underside (so
  // there is no gap between them from anywhere), flaring as it goes.
  const rockColour = texture(extra.rock, uv().mul(vec2(1.2, 1.2))).rgb;
  const throatGeometry = kept("throat", () => {
    const geometry = walls(edge, 1, 1.6, (p, y) => {
      const rock = THREE.MathUtils.smoothstep(-y, 0.3, 0.6);
      return rock * (0.1 * wobble(p.x * 2.1, y * 1.7, p.z * 1.9) + 0.05 * wobble(p.z * 6.1, y * 5.3, p.x * 5.9)) + Math.pow(-y, 3) * 0.5;
    }, 20);
    // Each ring's depth so far, laid down to the roof's underside under each point and half a metre past it.
    const p = geometry.getAttribute("position");
    const uvs = geometry.getAttribute("uv");
    for (let i = 0; i < p.count; i++) {
      const depth = 0.15 - ceiling(p.getX(i), p.getZ(i));
      p.setY(i, p.getY(i) * depth);
      uvs.setY(i, uvs.getY(i) * depth);
    }
    geometry.computeVertexNormals();
    return geometry;
  });
  const throatMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  const slabColour = texture(scans.slab, uv().mul(vec2(1, 3))).rgb.mul(0.9);
  const earth = vec3(0.1, 0.075, 0.05).mul(texture(scans.rock, uv().mul(2.1)).r.mul(0.8).add(0.55));
  const stone = rockColour.mul(vec3(0.42, 0.44, 0.5));
  throatMaterial.colorNode = mix(mix(stone, earth, smoothstep(-1.3, -0.7, y)), slabColour, smoothstep(-SLAB - 0.03, -SLAB, y));
  throatMaterial.normalNode = normalMap(texture(extra.rockNormal, uv().mul(vec2(1.2, 1.2))), vec2(1.1));
  // The crystals' light coming up the throat from below.
  throatMaterial.emissiveNode = vec3(ICE.r, ICE.g, ICE.b).mul(smoothstep(-0.6, -2.5, y).mul(0.08)).mul(stone.add(0.05)).mul(glowAt(positionWorld, float(0)));
  const throat = new THREE.Mesh(throatGeometry, throatMaterial);
  throat.castShadow = throat.receiveShadow = true;
  real.add(throat);
  geometries.push(throatGeometry);
  materials.push(throatMaterial);

  const roots: Root[] = [];
  for (let k = 0; k < 18; k++) {
    const p = edge[Math.floor((k / 18 + 0.02 * wobble(k, 1, 3)) * edge.length + edge.length) % edge.length];
    const out = middle.clone().sub(p).setY(0).normalize();
    const f = 0.5 + 0.5 * wobble(k * 2.3, 1, 2);
    roots.push({ at: p.clone().setY(-0.25 - f * 0.3).addScaledVector(out, -0.02), out, length: 0.2 + Math.pow(f, 2) * 1.0, thick: 0.005 + f * 0.01 });
  }
  const hanging = hangingRoots(roots, time, wake, 0.04);
  real.add(hanging.mesh);
  geometries.push(hanging.geometry);
  materials.push(hanging.material);

  // ---- The chamber: the egg, turned to face in, its rock standing in and out.
  // Its rings packed where the rock stands in and out, the walls; few across the flat floor and the low roof, where
  // more would show nothing. (Each ring's height down the egg from the roof's middle, 0 to 1, moved so; its texture
  // mapping kept as it was.)
  const caveGeometry = kept("cave", () => {
    const geometry = new THREE.SphereGeometry(1, 112, 52);
    const p = geometry.getAttribute("position");
    const uvs = geometry.getAttribute("uv");
    const packed = (t: number) => (t < 0.15 ? (t / 0.15) * 0.31 : t < 0.85 ? 0.31 + ((t - 0.15) / 0.7) * 0.5 : 0.81 + ((t - 0.85) / 0.15) * 0.19);
    for (let i = 0; i < p.count; i++) {
      const theta = packed(1 - uvs.getY(i)) * Math.PI;
      const phi = uvs.getX(i) * Math.PI * 2;
      p.setXYZ(i, -Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
      uvs.setY(i, 1 - theta / Math.PI);
    }
    inward(geometry);
    const d = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      d.set(p.getX(i), p.getY(i), p.getZ(i));
      // A floor flattened under the crystals, a broad low roof; between them the rock bulging in and out.
      const at = surface(d);
      p.setXYZ(i, at.x, at.y, at.z);
    }
    geometry.computeVertexNormals();
    return geometry;
  });
  const caveMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  // Wet and dark, the rock scan tinted cool, glints where it is wettest.
  // The egg's own mapping on the walls; across the flat floor (where that mapping gathers to a point) the rock laid
  // flat instead.
  const caveUv = uv().mul(vec2(14, 9));
  const floorUv = positionWorld.xz.mul(0.3);
  const onFloor = smoothstep(-10.2, -10.8, y);
  const caveRock = mix(texture(extra.rock, caveUv).rgb, texture(extra.rock, floorUv).rgb, onFloor).mul(vec3(0.3, 0.32, 0.38));
  // Dark rock: what little of the street's light reaches it hardly shows, while the crystals' own lights (made
  // strong to match) bring it out where they fall.
  const caveAlbedo = caveRock.mul(0.22);
  // (Where it is wet, and the rippling light below, read from the small patch of noise rather than worked out for
  // every pixel.)
  const wet = smoothstep(0.45, 0.8, (texture(grain, positionWorld.xz.mul(0.13).add(positionWorld.y.mul(0.04))) as any).r);
  caveMaterial.colorNode = caveAlbedo.mul(mix(float(1), float(0.6), wet));
  caveMaterial.roughnessNode = mix(float(0.85), float(0.25), wet);
  // The scan's grain, and over it the same finer still, so the rock holds up seen from close.
  const rockGrain = mix(texture(extra.rockNormal, caveUv), texture(extra.rockNormal, floorUv), onFloor);
  const rockFine = texture(extra.rockNormal, mix(caveUv, floorUv, onFloor).mul(4.3).add(0.37));
  caveMaterial.normalNode = normalMap(mix(rockGrain, rockFine, 0.35), vec2(1.6));
  // Light rippling over the rock, as through water: the crystals' waves thrown on the walls.
  const ripple = (texture(grain, positionWorld.xz.mul(0.09).add(vec2(0.02, 0.013).mul(time))) as any).r.add((texture(grain, positionWorld.zx.mul(0.13).sub(vec2(0.017, 0.025).mul(time))) as any).r).mul(0.5);
  // Flecks of mica in the rock catching the crystals' light, each only from some ways, so they wink as the eye moves.
  const toward = cameraPosition.sub(positionWorld).normalize();
  // (Laid flat across the floor and stood up the walls, so they stay points and are never drawn out into streaks.)
  const fleckAt = mix(positionWorld.xz, vec2(positionWorld.x.add(positionWorld.z), positionWorld.y), step(abs(normalWorld.y), 0.6));
  const fleck = (texture(grain, fleckAt.mul(0.85)) as any).b;
  const wink = pow(max(sin(dot(toward, vec3(31, 23, 37)).add(positionWorld.x.mul(17)).add(positionWorld.z.mul(13))), 0), 6);
  // And the floor lit round the feet of the great crystals.
  const pool = (x: number, z: number, r: number) => exp(positionWorld.xz.sub(vec2(x, z)).dot(positionWorld.xz.sub(vec2(x, z))).div(-r * r));
  const pools = pool(-0.6, -14.5, 3.2).add(pool(3.6, -18, 2.6).mul(0.8)).add(pool(-4, -19, 2.4).mul(0.7)).mul(smoothstep(-9.8, -10.8, y));
  caveMaterial.emissiveNode = vec3(ICE.r, ICE.g, ICE.b).mul(caveRock.mul(pow(ripple, 3).mul(wake).mul(0.9).add(0.04).add(pools.mul(0.9))).add(fleck.mul(wink).mul(0.9))).mul(glowAt(positionWorld, float(0.5)));
  const cave = new THREE.Mesh(caveGeometry, caveMaterial);
  cave.receiveShadow = true;
  real.add(cave);
  geometries.push(caveGeometry);
  materials.push(caveMaterial);

  // ---- The crystals: quartz, each a six-sided column ending in a six-faced point, in clusters growing out of the
  // rock, each lit from inside. One shape for all of them, its corners placed for each crystal as it is drawn.
  const crystalGeometry = quartz();
  // Points on the chamber's rock to grow from: [direction from its middle, cluster size, how big, violet].
  const clusters: [THREE.Vector3, number, number, boolean][] = [
    [new THREE.Vector3(0.05, -0.75, -0.62), 11, 1.35, false],
    [new THREE.Vector3(-0.42, -0.72, -0.5), 8, 1.0, true],
    [new THREE.Vector3(0.48, -0.7, -0.48), 9, 1.1, false],
    [new THREE.Vector3(0.1, -0.2, -0.97), 8, 1.0, false],
    [new THREE.Vector3(-0.55, -0.15, -0.8), 6, 0.8, true],
    [new THREE.Vector3(0.62, -0.1, -0.75), 6, 0.8, false],
    [new THREE.Vector3(-0.25, -0.88, -0.2), 7, 0.9, false],
    [new THREE.Vector3(0.3, -0.86, -0.1), 6, 0.75, true],
    [new THREE.Vector3(-0.85, -0.45, 0.1), 6, 0.8, false],
    [new THREE.Vector3(0.85, -0.45, 0.05), 6, 0.8, false],
    [new THREE.Vector3(0.0, -0.9, 0.35), 5, 0.7, false],
    [new THREE.Vector3(-0.2, 0.25, -0.95), 5, 0.6, true],
    [new THREE.Vector3(0.3, 0.3, -0.9), 4, 0.55, false]
  ];
  const pieces: Piece[] = [];
  clusters.forEach(([direction, count, size, violet], c) => {
    const d = direction.clone().normalize();
    const base = surface(d);
    // Growing inward, toward the chamber's middle and a little up.
    const inwardAxis = CAVE.centre.clone().add(new THREE.Vector3(0, 2.5, 0)).sub(base).normalize();
    for (let j = 0; j < count; j++) {
      const i = c * 31 + j;
      const spread = j === 0 ? 0.05 : 0.25 + rand(i, 1) * 0.55;
      const axis = inwardAxis.clone().add(new THREE.Vector3(rand(i, 2) - 0.5, rand(i, 3) - 0.5, rand(i, 4) - 0.5).multiplyScalar(spread * 2)).normalize();
      const length = size * (j === 0 ? 4.2 : 0.8 + Math.pow(rand(i, 5), 1.5) * 3);
      const at = base.clone().add(new THREE.Vector3(rand(i, 6) - 0.5, 0, rand(i, 7) - 0.5).multiplyScalar(size * 2.2)).addScaledVector(axis, -0.3);
      pieces.push({ at, axis, length, radius: length * (0.1 + rand(i, 8) * 0.05), violet: violet && rand(i, 9) < 0.7 });
    }
    // And round their feet a crust of small ones, every way up, as a geode's lining.
    for (let j = 0; j < count * 2; j++) {
      const i = 300 + c * 41 + j;
      const axis = inwardAxis.clone().add(new THREE.Vector3(rand(i, 2) - 0.5, rand(i, 3) - 0.5, rand(i, 4) - 0.5).multiplyScalar(2.2)).normalize();
      const length = size * (0.25 + Math.pow(rand(i, 5), 2) * 0.9);
      const at = surface(d.clone().add(new THREE.Vector3(rand(i, 6) - 0.5, rand(i, 7) - 0.5, rand(i, 8) - 0.5).multiplyScalar(0.16 * size)).normalize()).addScaledVector(axis, -0.08);
      pieces.push({ at, axis, length, radius: length * (0.12 + rand(i, 9) * 0.06), violet: violet && rand(i, 10) < 0.6 });
    }
  });
  // And out on the floor, in the middle of the view down through the hole, a few great ones taller than a house,
  // leaning up toward the opening.
  const floorY = CAVE.centre.y - 0.82 * CAVE.radii.y;
  const giants: [THREE.Vector3, THREE.Vector3, number, number, boolean][] = [
    [new THREE.Vector3(-0.6, floorY, -14.5), new THREE.Vector3(0.15, 1, 0.55), 7, 1.75, false],
    [new THREE.Vector3(3.6, floorY, -18), new THREE.Vector3(-0.35, 1, 0.45), 6, 1.4, true],
    [new THREE.Vector3(-4, floorY, -19), new THREE.Vector3(0.4, 1, 0.4), 5, 1.25, false]
  ];
  giants.forEach(([base, lean, count, size, violet], c) => {
    const main = lean.clone().normalize();
    for (let j = 0; j < count; j++) {
      const i = 700 + c * 31 + j;
      const axis = main.clone().add(new THREE.Vector3(rand(i, 2) - 0.5, rand(i, 3) * 0.3, rand(i, 4) - 0.5).multiplyScalar(j === 0 ? 0 : 1.1)).normalize();
      const length = size * (j === 0 ? 4.4 : 1 + Math.pow(rand(i, 5), 1.3) * 2.6);
      const at = base.clone().add(new THREE.Vector3(rand(i, 6) - 0.5, 0, rand(i, 7) - 0.5).multiplyScalar(size * 1.6)).addScaledVector(axis, -0.4);
      pieces.push({ at, axis, length, radius: length * (0.09 + rand(i, 8) * 0.04), violet: violet && rand(i, 9) < 0.7 });
    }
    // Small ones packed round their feet.
    for (let j = 0; j < count * 2; j++) {
      const i = 800 + c * 37 + j;
      const axis = main.clone().add(new THREE.Vector3(rand(i, 2) - 0.5, rand(i, 3) * 0.5, rand(i, 4) - 0.5).multiplyScalar(2)).normalize();
      const length = size * (0.3 + Math.pow(rand(i, 5), 2) * 0.9);
      const a = rand(i, 6) * Math.PI * 2;
      const at = base.clone().add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(size * (0.6 + rand(i, 7) * 1.1))).addScaledVector(axis, -0.1);
      pieces.push({ at, axis, length, radius: length * (0.12 + rand(i, 8) * 0.05), violet: violet && rand(i, 9) < 0.6 });
    }
  });
  // Pieces broken off and lying about the floor.
  for (let i = 0; i < 46; i++) {
    const a = rand(i, 40) * Math.PI * 2;
    const at = new THREE.Vector3(-0.4 + Math.cos(a) * (1 + rand(i, 41) * 6.5), floorY + 0.01, -15.5 + Math.sin(a) * (1 + rand(i, 41) * 5.5));
    const axis = new THREE.Vector3(Math.cos(rand(i, 42) * 6.28), 0.15 + rand(i, 43) * 0.25, Math.sin(rand(i, 42) * 6.28)).normalize();
    const length = 0.12 + Math.pow(rand(i, 44), 2) * 0.45;
    pieces.push({ at, axis, length, radius: length * (0.14 + rand(i, 45) * 0.05), violet: rand(i, 46) < 0.25 });
  }
  // Small ones crusting the rock between the clusters.
  for (let i = 0; i < 260; i++) {
    const d = new THREE.Vector3(rand(i, 11) - 0.5, -0.2 - rand(i, 12) * 0.7, -0.15 - rand(i, 13) * 0.85).normalize();
    const base = surface(d);
    const axis = CAVE.centre.clone().sub(base).normalize().add(new THREE.Vector3(rand(i, 14) - 0.5, rand(i, 15) - 0.3, rand(i, 16) - 0.5)).normalize();
    const length = 0.12 + Math.pow(rand(i, 17), 2) * 0.6;
    pieces.push({ at: base.addScaledVector(axis, -0.05), axis, length, radius: length * (0.12 + rand(i, 19) * 0.05), violet: rand(i, 18) < 0.25 });
  }
  // The crystals' material, lit from within; how each is placed it reads from its geometry (see `lookOf`).
  const glowing = () => {
    const hue = attribute("crystalTint", "vec3") as any;
    const turn = attribute("crystalTurn", "vec4") as any;
    const place = attribute("crystalPlace", "vec4") as any;
    const size = attribute("crystalSize", "vec4") as any;
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.1, metalness: 0, envMapIntensity: 0.3, flatShading: true } as any);
    const seed = place.w;
    const h = (n: number) => hashed(seed, n);

    // Where each corner goes, in the crystal's own frame (metres; up its length): the column a little narrower at
    // its end than its foot, and its end zigzagging, every other face of the point larger as on quartz and each
    // corner a little off, the point's tip off the middle, so no two crystals are alike.
    const corner = attribute("corner", "vec2") as any;
    const side = corner.x;
    const ring = corner.y;
    const onEnd = step(0.5, ring).mul(step(ring, 1.5));
    const onTip = step(1.5, ring);
    const point = size.w;
    const columnEnd = size.y.sub(point);
    const zig = mod(side, 2).mul(h(1).mul(0.7)).add(hashed(seed.mul(0.31), side.mul(0.221)).sub(0.5).mul(0.3)).mul(point);
    const narrow = mix(float(1), float(0.93), onEnd).mul(float(1).sub(onTip)) as any;
    const off = vec2(h(2).sub(0.5), h(3).sub(0.5)).mul(0.45).mul(onTip);
    const across = positionGeometry.xz.mul(narrow).add(off).mul(size.xz);
    const shape = vec3(across.x, columnEnd.add(zig).max(0.01).mul(onEnd).add(size.y.mul(onTip)), across.y);
    material.positionNode = place.xyz.add(rotate(turn, shape));
    const local = shape.toVarying("crystalLocal");

    // Seen from here: the way to the eye in the crystal's frame, and the same with the crystal squeezed round, so
    // its column is the unit one.
    const toward = cameraPosition.sub(positionWorld).normalize();
    const facing = abs(dot(normalWorld, toward));
    const look = rotate(vec4(turn.xyz.negate(), turn.w), toward);
    const at = local.div(vec3(size.x, 1, size.z));
    const into = look.negate().div(vec3(size.x, 1, size.z));
    // The sight line through the column: how far it runs inside before it leaves (in metres, as `look` is a unit
    // way), and where it passes nearest the middle.
    const a = max(dot(into.xz, into.xz), 1e-4);
    const b = dot(at.xz, into.xz);
    const c = min(dot(at.xz, at.xz).sub(1), 0);
    const through = clamp(sqrt(max(b.mul(b).sub(a.mul(c)), 0)).sub(b).div(a), 0, size.y);
    const nearest = clamp(b.negate().div(a), 0, through);
    const closest = length(at.xz.add(into.xz.mul(nearest)));
    const coreHeight = local.y.sub(look.y.mul(nearest));
    // A milky core up the middle, narrowing into the point: bright where the sight line passes through it.
    const coreWidth = clamp(size.y.sub(coreHeight).div(point), 0.12, 1).mul(0.42);
    const core = exp(closest.div(coreWidth).pow(2).mul(-2.5)).mul(step(0, coreHeight));
    // Halfway along the sight line: clouds and veils of inclusions there, which shift as the eye moves, as things
    // seen through glass do; and the ghosts of earlier points (phantoms) nested inside the real one.
    const middle = at.add(into.mul(through.mul(0.5)));
    const middleHeight = local.y.sub(look.y.mul(through.mul(0.5)));
    const radius = size.x.add(size.z).mul(0.5);
    const deep = texture(grain, vec2(middle.x.mul(0.4).add(middle.z.mul(0.27)).add(seed.mul(0.137)), middleHeight.div(radius).mul(0.11))) as any;
    const shallow = texture(grain, vec2(at.x.mul(0.23).sub(at.z.mul(0.31)).add(seed.mul(0.291)), local.y.div(radius).mul(0.19)).add(look.xz.mul(0.04))) as any;
    // (Two or three of them, spaced unevenly and fading as they go deeper, some crystals hardly any.)
    const phantomAt = size.y.sub(middleHeight).sub(length(middle.xz).mul(point)).div(point.mul(mix(float(1.1), float(1.8), h(4)))).add(deep.r.mul(0.3));
    const phantom = pow(float(1).sub(abs(fract(phantomAt).sub(0.5)).mul(2)), 10).mul(step(0.5, phantomAt)).mul(exp(phantomAt.mul(-0.9))).mul(h(5).mul(1.6));
    // How much of the glow the sight line gathers: more the thicker the crystal it crosses.
    const body = float(1).sub(exp(through.div(radius).mul(-0.9)));
    // Brightest toward the foot, where it grows out of the light below, and clearer into the point.
    const along = clamp(middleHeight.div(size.y), 0, 1);
    // A face seen square on is clearer, so darker; seen at a slant it holds more of the light.
    const slant = mix(float(0.4), float(1), pow(float(1).sub(facing), 1.5));
    const inner = body.mul(0.18).add(core.mul(0.75)).add(pow(deep.r, 2).mul(0.45)).add(shallow.g.mul(0.2)).add(phantom.mul(0.4)).mul(slant).mul(mix(float(1.2), float(0.4), along));
    // The six long edges of each column, where the light inside gathers into bright lines; fainter up the point.
    const around = atan(at.z, at.x).div(Math.PI / 3);
    const ridge = pow(float(1).sub(abs(fract(around.add(0.5)).sub(0.5)).mul(2)), 12).mul(mix(float(1), float(0.4), step(columnEnd, local.y)));
    // The fine level lines etched across a column's faces, as on quartz, dulling it in bands.
    const etched = smoothstep(0.6, 0.85, (texture(grain, vec2(seed.mul(0.071), local.y.mul(5.3))) as any).g).mul(step(local.y, columnEnd));
    // Its faces catching the light at a slant, whiter than the glow inside.
    const sheen = pow(float(1).sub(facing), 5).mul(0.96).add(0.04);
    const sparkle = pow(max(sin(time.mul(2.3).add(seed.mul(7.7))), 0), 30).mul(wake).mul(1.2).mul(smoothstep(0.7, 1, along).add(0.3));
    material.colorNode = hue.mul(0.14);
    material.roughnessNode = mix(float(0.06), float(0.32), etched);
    const glow = hue.mul(inner.mul(float(1).sub(etched.mul(0.1))).mul(1.4).add(ridge.mul(1.2)).add(sparkle));
    material.emissiveNode = glow.add(mix(hue, vec3(1), 0.55).mul(sheen.mul(0.4))).mul(glowAt(positionWorld, seed));
    return material;
  };
  const crystalMaterial = glowing();
  geometries.push(crystalGeometry);
  materials.push(crystalMaterial);
  crystalMaterial.addEventListener("dispose", () => grain.dispose());

  // The crystals' light on the rock: a few lights among the clusters, short in reach so they light only the cave.
  const lamps = [
    { at: surface(clusters[0][0].clone().normalize()).add(new THREE.Vector3(0, 2.5, 2)), colour: ICE, power: 260 },
    { at: surface(clusters[1][0].clone().normalize()).add(new THREE.Vector3(0.8, 2, 1.5)), colour: VIOLET, power: 140 },
    { at: surface(clusters[2][0].clone().normalize()).add(new THREE.Vector3(-0.8, 2, 1.5)), colour: ICE, power: 160 },
    { at: surface(clusters[3][0].clone().normalize()).add(new THREE.Vector3(0, 0, 3)), colour: ICE, power: 180 }
  ].map(({ at, colour, power }) => {
    const light = new THREE.PointLight(colour, power, 12, 2);
    light.position.copy(at);
    real.add(light);
    return { light, power, at };
  });
  // Down here only the crystals light the rock: the street's sun and sky are kept out of it.
  caveMaterial.lightsNode = crystalMaterial.lightsNode = lights(lamps.map(({ light }) => light));

  // Motes of light drifting up through the chamber.
  const motes = specks(140, [-6, 6, -12, -2, -20, -2], new THREE.Color(0.6, 0.95, 1).multiplyScalar(4), 0.3);
  // Each mote a twenty-faced ball, not a sphere of forty-eight: a speck a centimetre or two across shows no difference.
  const speck = new THREE.IcosahedronGeometry(1, 0);
  motes.geometry.dispose();
  (motes.mesh as THREE.InstancedMesh).geometry = speck;
  real.add(motes.mesh);
  geometries.push(speck);
  materials.push(motes.material);

  // ---- Breaking out, once it is real: cracks glowing open in the paving all round the edge, and crystals growing up
  // out of them onto the sidewalk itself, a wave of them running round the hole; and motes of their light floating up
  // out of the opening into the street. Each is set by its own clock alone, so it runs as well backwards.
  const SHARDS = 46;
  const shardPieces = Array.from({ length: SHARDS }, (_, i) => {
    const k = Math.floor(((i + 0.5 * rand(i, 30)) / SHARDS) * edge.length) % edge.length;
    const p = edge[k];
    const out = p.clone().sub(middle).setY(0).normalize();
    const away = 0.04 + Math.pow(rand(i, 31), 1.5) * 0.45;
    const axis = out.clone().multiplyScalar(0.55 + rand(i, 32) * 0.5).add(new THREE.Vector3(rand(i, 33) - 0.5, 1, rand(i, 34) - 0.5).multiplyScalar(0.9)).normalize();
    const length = (0.07 + Math.pow(rand(i, 35), 2) * 0.38) * (1 - away * 0.8);
    // Round the edge in a wave, from the far side first.
    const start = 2.2 + (k / edge.length) * 2.6 + rand(i, 36) * 0.5;
    return { at: p.clone().addScaledVector(out, away).setY(-0.03), axis, length, radius: length * (0.11 + rand(i, 37) * 0.04), start, violet: rand(i, 38) < 0.2 };
  });
  // All the crystals, the cave's and these, drawn at once (these last, grown from nothing as each one's time comes).
  // Placed by the vertex stage alone: their matrices left as they are (the instance matrix is applied after it).
  const look = lookOf([...pieces, ...shardPieces], 0, crystalGeometry);
  const crystals = new THREE.InstancedMesh(crystalGeometry, crystalMaterial, pieces.length + SHARDS);
  crystals.frustumCulled = false;
  real.add(crystals);
  const placeShards = (t: number) => {
    shardPieces.forEach((piece, i) => look.grow(pieces.length + i, THREE.MathUtils.smootherstep(t, piece.start, piece.start + 2.4)));
    look.size.needsUpdate = true;
  };
  placeShards(0);

  // The cracks: a band of paving round the edge, lit along a web of fine lines that open outward from the hole.
  const crackPositions: number[] = [];
  const crackUvs: number[] = [];
  const crackIndex: number[] = [];
  edge.forEach((p, k) => {
    const out = p.clone().sub(middle).setY(0).normalize();
    crackPositions.push(p.x, 0.004, p.z, p.x + out.x * 1.0, 0.004, p.z + out.z * 1.0);
    crackUvs.push(k / edge.length, 0, k / edge.length, 1);
    const a = k * 2;
    const b = ((k + 1) % edge.length) * 2;
    crackIndex.push(a, a + 1, b, b, a + 1, b + 1);
  });
  const crackGeometry = new THREE.BufferGeometry();
  crackGeometry.setAttribute("position", new THREE.Float32BufferAttribute(crackPositions, 3));
  crackGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(crackUvs, 2));
  crackGeometry.setIndex(crackIndex);
  crackGeometry.computeVertexNormals();
  // Faces up: check, and turn the winding if not.
  if (crackGeometry.getAttribute("normal").getY(0) < 0) {
    for (let i = 0; i < crackIndex.length; i += 3) [crackIndex[i + 1], crackIndex[i + 2]] = [crackIndex[i + 2], crackIndex[i + 1]];
    crackGeometry.setIndex(crackIndex);
    crackGeometry.computeVertexNormals();
  }
  const opened = uniform(0);
  const crackMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2 });
  {
    const at = positionWorld.xz;
    // (Its lines the ridges in the small patch of noise: two layers of them, the finer one turned.)
    const line = (where: any, from: number) => smoothstep(from, 0.95, (texture(grain, where) as any).g);
    const web = max(line(at.mul(0.42).add(0.3), 0.62), line(vec2(at.x.mul(0.7).sub(at.y.mul(0.85)), at.x.mul(0.85).add(at.y.mul(0.7))).add(0.61), 0.66).mul(0.6));
    const out = uv().y;
    const reach = opened.mul((texture(grain, at.mul(0.3).add(0.77)) as any).r.sub(0.5).mul(0.6).add(0.8));
    crackMaterial.colorNode = vec3(ICE.r, ICE.g, ICE.b).mul(web.mul(step(out, reach)).mul(float(1).sub(out)).mul(2.6)).mul(glowAt(positionWorld, float(0.2)));
  }
  const cracks = new THREE.Mesh(crackGeometry, crackMaterial);
  cracks.visible = false;
  real.add(cracks);
  geometries.push(crackGeometry);
  materials.push(crackMaterial);

  const rising = specks(80, [-1.6, 1.6, -1.2, 3.4, -4.6, 0.3], new THREE.Color(0.6, 0.95, 1).multiplyScalar(4), 0.32);
  // The same ball and the same light as the motes below.
  rising.geometry.dispose();
  rising.material.dispose();
  (rising.mesh as THREE.InstancedMesh).geometry = speck;
  rising.mesh.material = motes.material;
  real.add(rising.mesh);

  const capped = nearDepth(edge);
  real.add(capped.mesh);
  const shade = shadeFor(edge);
  geometries.push(shade.geometry, capped.geometry);
  materials.push(shade.material, capped.material);
  const extent = [...edge];
  return {
    real,
    shade: shade.mesh,
    edge,
    extent,
    covers: footprint(extent),
    inside,
    animate: (t) => {
      // Once real: the crystals breathe with light and waves of it run through them and over the rock, the lights
      // among them swell and ebb with them, motes rise, the roots stir; cracks glow open round the edge, crystals grow
      // up out of them onto the sidewalk, and motes of light float up into the street.
      const w = wakeAt(t);
      const go = wokenFor(t);
      time.value = go;
      wake.value = w;
      lamps.forEach(({ light, power, at }, i) => {
        const wave = 0.5 + 0.5 * Math.sin(at.x * 0.31 + at.y * 0.12 - at.z * 0.22 - go * 1.1);
        const breath = 0.5 + 0.5 * Math.sin(go * 0.7 + i * 2.4);
        light.intensity = power * (1 + w * (wave * 0.55 + breath * 0.35 - 0.4));
      });
      motes.update(t, w);
      placeShards(t);
      const crack = THREE.MathUtils.smoothstep(t, 1.6, 5.5);
      opened.value = crack;
      cracks.visible = crack > 0;
      rising.update(t, w);
    },
    geometries,
    materials
  };
}

// A number from 0 to 1 that looks random, for each crystal's number and a salt, on the graphics card.
const hashed = (seed: any, n: any) => fract(sin(seed.mul(12.9898).add(float(n).mul(78.233))).mul(43758.5453));

// A vector turned by a rotation (as a quaternion), on the graphics card.
const rotate = (q: any, v: any) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2));

// One crystal's corners, for the vertex stage to place (see `glowing`): round a unit hexagon, the column's foot
// (ring 0) and its end (ring 1), then the point (ring 2), each corner marked with its side and ring. No normals: its
// faces are lit flat, each its own, as cut crystal is.
function quartz() {
  const positions: number[] = [];
  const corners: number[] = [];
  const put = (k: number, ring: number) => {
    const a = ((k % 6) * Math.PI) / 3;
    positions.push(ring === 2 ? 0 : Math.cos(a), ring, ring === 2 ? 0 : Math.sin(a));
    corners.push(k % 6, ring);
  };
  for (let k = 0; k < 6; k++) {
    // A face of the column, as two triangles wound to face out, then the face of the point above it.
    put(k, 0), put(k, 1), put(k + 1, 1);
    put(k, 0), put(k + 1, 1), put(k + 1, 0);
    put(k, 1), put(k, 2), put(k + 1, 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("corner", new THREE.Float32BufferAttribute(corners, 2));
  return geometry;
}

type Piece = { at: THREE.Vector3; axis: THREE.Vector3; length: number; radius: number; violet: boolean };

// How each of a set of crystals is placed, for the vertex stage (one to each instance, on the set's geometry): its
// colour, its turn (up its axis, and spun about it), where its foot is (and a number of its own), and its size: across
// (two ways, as few are regular), its whole length, and the length of its point. `salt` keeps one set's crystals
// unlike another's.
function lookOf(pieces: Piece[], salt: number, geometry: THREE.BufferGeometry) {
  const n = pieces.length;
  const tint = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  const turn = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const place = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const size = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const sizes: number[][] = [];
  const up = new THREE.Vector3(0, 1, 0);
  pieces.forEach((piece, i) => {
    const r = (k: number) => rand(i + salt, k);
    const c = (piece.violet ? VIOLET : ICE).clone().lerp(new THREE.Color(0.85, 0.95, 1), r(20) * 0.3);
    tint.setXYZ(i, c.r, c.g, c.b);
    const q = new THREE.Quaternion().setFromUnitVectors(up, piece.axis).multiply(new THREE.Quaternion().setFromAxisAngle(up, r(21) * Math.PI * 2));
    turn.setXYZW(i, q.x, q.y, q.z, q.w);
    place.setXYZW(i, piece.at.x, piece.at.y, piece.at.z, i + salt + 1);
    // As long overall as the old pointed columns stood; the point a few times as long as the column is wide, as
    // quartz's is, some longer and some shorter.
    const flat = 0.75 + r(22) * 0.5;
    const whole = piece.length * 1.45;
    const point = Math.min(piece.radius * (1.7 + r(23) * 1.4), whole * 0.6);
    sizes.push([piece.radius * Math.sqrt(flat), whole, piece.radius / Math.sqrt(flat), point]);
    size.setXYZW(i, ...(sizes[i] as [number, number, number, number]));
  });
  geometry.setAttribute("crystalTint", tint);
  geometry.setAttribute("crystalTurn", turn);
  geometry.setAttribute("crystalPlace", place);
  geometry.setAttribute("crystalSize", size);
  return {
    size,
    // One grown to a part of its size (0 to 1).
    grow: (i: number, grown: number) => {
      const [x, y, z, w] = sizes[i];
      size.setXYZW(i, x * grown, y * grown, z * grown, w * grown);
    }
  };
}

// A small square of noise that tiles, as a texture: soft clouds (red), thin veils (green) and scattered points
// (blue), made on the processor.
let grainData: Uint8Array | null = null;
function noisePatch(n: number) {
  // (Its texels worked out once, the first build; every build after makes its texture from them.)
  if (!grainData || grainData.length !== n * n * 4) {
    const data = new Uint8Array(n * n * 4);
    // Smooth noise that tiles: random values on grids of 4, 8, 16 and 32 cells across, eased between.
    const grid = (cells: number, salt: number) => Float32Array.from({ length: cells * cells }, (_, k) => rand(k % cells, Math.floor(k / cells) * 0.37 + salt));
    const octaves = (salt: number) => [4, 8, 16, 32].map((cells) => ({ cells, values: grid(cells, salt) }));
    const weights = [0.5, 0.27, 0.15, 0.08];
    const fbm = (x: number, y: number, layers: { cells: number; values: Float32Array }[]) => {
      let sum = 0;
      for (let o = 0; o < 4; o++) {
        const { cells, values } = layers[o];
        const s = (cells * x) / n;
        const t = (cells * y) / n;
        const i = Math.floor(s);
        const j = Math.floor(t);
        const ex = (s - i) * (s - i) * (3 - 2 * (s - i));
        const ey = (t - j) * (t - j) * (3 - 2 * (t - j));
        const i1 = (i + 1) % cells;
        const j1 = (j + 1) % cells;
        const top = values[j * cells + i] + (values[j * cells + i1] - values[j * cells + i]) * ex;
        const bottom = values[j1 * cells + i] + (values[j1 * cells + i1] - values[j1 * cells + i]) * ex;
        sum += (top + (bottom - top) * ey) * weights[o];
      }
      return sum;
    };
    const clouds = octaves(3.1);
    const veils = octaves(7.7);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const o = (y * n + x) * 4;
        data[o] = Math.round(THREE.MathUtils.smoothstep(fbm(x, y, clouds), 0.35, 0.75) * 255);
        data[o + 1] = Math.round(Math.pow(1 - Math.abs(2 * fbm(x, y, veils) - 1), 4) * 255);
        data[o + 2] = rand(x, y * 1.31 + 11) > 0.985 ? 255 : 0;
        data[o + 3] = 255;
      }
    grainData = data;
  }
  const data = grainData;
  const patch = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  patch.wrapS = patch.wrapT = THREE.RepeatWrapping;
  patch.magFilter = THREE.LinearFilter;
  patch.minFilter = THREE.LinearMipmapLinearFilter;
  patch.generateMipmaps = true;
  patch.needsUpdate = true;
  return patch;
}
