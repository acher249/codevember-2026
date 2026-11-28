"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  abs,
  atan,
  attribute,
  cameraPosition,
  clamp,
  cos,
  cross,
  dot,
  exp,
  float,
  floor as floor_,
  Fn,
  fract,
  hash,
  If,
  instanceIndex,
  max,
  mix,
  mx_noise_float,
  normalize,
  normalWorld,
  positionGeometry,
  positionView,
  positionWorld,
  reflector,
  pow,
  sin,
  step,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { OVERLAY_LAYER } from "../shared/engine/Post";
import { lehmer } from "../shared/engine/random";
import { loadRetried, suspendRetried } from "../shared/engine/retry";
import { scenePhase, useQuality } from "../shared/engine/quality";
import { cavernDistance, cavernsNear, type Cavern } from "./field";
import { type Fall, type Sheet } from "./water";
import { BOULDER_SHAPES, dress, GROUP, KIND_SLOTS, PER, POOLS, SLOTS, unpack, type Glow, type Made, type Placed, type PoolName } from "./dress";
import {
  ammoniteGeometry,
  bearSkull,
  breakdownBlock,
  curtain,
  dinoRib,
  dinoSkull,
  dripCluster,
  emberBed,
  fallSheet,
  fireLog,
  flameTongue,
  flowstone,
  longBone,
  moonmilk,
  mushroom,
  quartzPoint,
  ribArc,
  rimstone,
  rootTangle,
  seleniteBlade,
  stormLantern,
  straws,
  trilobiteGeometry,
  vertebra
} from "./shapes";
import { caveLights, caveShade, lamp, overlayMaterial, TorchHaze, useOverlay } from "./fx";
import { nearGlow, rockUniforms, torchLightAt, waterGlints, type Textures } from "./rock";
import { weathered } from "./detail";
import { crackle, rushing } from "./sound";
import { statSources } from "./stats";
import type { World } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What fills the caverns found by digging (the hashed ones, field.ts `cellCavern`), made as each comes within reach and
// let go when it is left far behind: stalactites and stalagmites, rubble, glowing fungi, and each kind's own things
// (giant mushrooms, giant crystals, the bones of cave bears, an explorer's camp, a carved doorway, a river with its
// waterfall, a fissure of molten rock). Everything is drawn from fixed pools of instances, made at load, so a new
// cavern never builds a shader; each cavern being dressed borrows one slot in every pool.

// Each dressed cavern's pool level, and the one mirror they share: a quarter-size reflection of the scene about the
// level of the nearest pools (the others keep only the lights' glints).
const stillLevel = new Map<Cavern, number>();
// And where they lie, so the mirror is drawn only while one of them is in view.
const stillSpread = new Map<Cavern, THREE.Sphere>();
const mirrorLevel = uniform(-1e4);
// Caverns within this of the eye (by their walls) are dressed, nearest first.
const NEAR = 24;
const REACH = 20;
// Drops of spray per fall.
const SPLASH = 72;
const ROOT = "/assets/27-burrow";
// Left out on the lowest tier (they are the finest of the dressing): not drawn at all, so their vertices cost nothing.
const FINE: PoolName[] = ["flowstone", "moonmilk"];
// The nearest open fire's light on what stands round it (a camp's things, its stones): where, and how bright.
const fireLight = uniform(new THREE.Vector4(0, -1000, 0, 0));

type Dressing = {
  cavern: Cavern;
  slot: number;
  // Its slot in its kind's own pools (-1 for a kind with none).
  kindSlot: number;
  glows: Glow[];
  // Not yet back from the dresser, and since when (seconds of frame time).
  waiting: boolean;
  asked: number;
  water?: Made["water"];
  lava?: Made["lava"];
  pond?: Made["pond"];
  fire?: THREE.Vector3;
  // Whether its meshes are showing (null: to be worked out again).
  shown: boolean | null;
};

// ---- Sheets ---------------------------------------------------------------------------------------------------------

// Sheets shaped per cavern (rivers, molten rock): one run of quads per slot in a single mesh, written when a cavern is
// dressed. Quads left over are folded to a point, which draws nothing. Each quad is turned to face up as it is written.
function sheets(quads: number) {
  const vertices = SLOTS * quads * 4;
  const position = new Float32Array(vertices * 3);
  const data = new Float32Array(vertices * 4);
  const normal = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i++) normal[i * 3 + 1] = 1;
  const index = new Uint16Array(SLOTS * quads * 6);
  for (let q = 0; q < SLOTS * quads; q++) index.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 1, q * 4 + 3, q * 4 + 2], q * 6);
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(position, 3);
  const dataAttribute = new THREE.BufferAttribute(data, 4);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("aSheet", dataAttribute);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  const diagonal = new THREE.Vector3();
  const other = new THREE.Vector3();
  const write = (slot: number, sheet: Sheet) => {
    position.fill(0, slot * quads * 12, (slot + 1) * quads * 12);
    data.fill(0, slot * quads * 16, (slot + 1) * quads * 16);
    sheet.slice(0, quads).forEach((quad, k) => {
      const order = [0, 1, 2, 3];
      // Corners 0, 1, 2, 3 make the faces (0, 1, 2) and (1, 3, 2): up when the diagonals cross that way.
      diagonal.subVectors(quad.corners[3], quad.corners[0]).cross(other.subVectors(quad.corners[2], quad.corners[1]));
      if (diagonal.y < 0) [order[1], order[2]] = [2, 1];
      const base = (slot * quads + k) * 4;
      order.forEach((from, to) => {
        quad.corners[from].toArray(position, (base + to) * 3);
        data.set(quad.data[from], (base + to) * 4);
      });
    });
    positionAttribute.needsUpdate = true;
    dataAttribute.needsUpdate = true;
  };
  return { geometry, write };
}

// ---- The pools, and the scene part ---------------------------------------------------------------------------------

async function loadProps() {
  const hatchet = await loadRetried(new GLTFLoader(), `${ROOT}/hatchet/hatchet.gltf`);
  const parts = (scene: THREE.Object3D) => {
    const out: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
    scene.updateMatrixWorld(true);
    scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      out.push({ geometry: g, material: mesh.material as THREE.Material });
    });
    return out;
  };
  // Boulders: Poly Haven's rock set (CC0, already simplified offline for the forest, see CREDITS.txt), its pieces as
  // bare shapes, set down on y = 0 and centred; they take the cave's own rock look, not the scan's moss.
  const rocks = await loadRetried(new GLTFLoader(), `${ROOT}/rock_moss_set_02/rock_moss_set_02.gltf`);
  const boulders: THREE.BufferGeometry[] = [];
  rocks.scene.updateMatrixWorld(true);
  rocks.scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || boulders.length >= BOULDER_SHAPES) return;
    const g = new THREE.BufferGeometry();
    for (const key of ["position", "normal"]) g.setAttribute(key, mesh.geometry.getAttribute(key));
    g.setIndex(mesh.geometry.getIndex());
    g.computeBoundingBox();
    const box = g.boundingBox as THREE.Box3;
    const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    g.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    g.scale(1 / size, 1 / size, 1 / size);
    boulders.push(g);
  });
  return { hatchet: parts(hatchet.scene), boulders };
}

export function Dressings({ world, textures }: { world: World; textures: Textures }) {
  const props = suspendRetried(loadProps, ["burrow-props"]);
  const camera = useThree((state) => state.camera);
  const built = useMemo(() => {
    const p = positionWorld as any;
    const t = rockUniforms.time as any;
    const tint = hash(instanceIndex.add(13)) as any;
    const grain = texture(textures.broken, p.xy.mul(1.7).add(p.zy.mul(1.3))).rgb as any;
    const shade = dot(grain, vec3(0.33)).div(0.3) as any;

    // Dripstone: calcite stained by the rock it ran through, the same grain as the walls (triplanar in the world), banded
    // with flowstone where each season's water left its layer, wet and glistening, the mica-like glints of the walls on
    // it, darker toward the root, paler and translucent at the dripping tip.
    const calcite = new THREE.MeshStandardNodeMaterial();
    const down = attribute("aAlong", "float") as any;
    const wn = normalize(normalWorld) as any;
    const tw = pow(abs(wn), vec3(4)) as any;
    const tws = tw.div(tw.x.add(tw.y).add(tw.z)) as any;
    const tri = (scale: number, map: THREE.Texture = textures.broken) =>
      texture(map, p.zy.mul(scale))
        .rgb.mul(tws.x)
        .add(texture(map, p.xz.mul(scale)).rgb.mul(tws.y))
        .add(texture(map, p.xy.mul(scale)).rgb.mul(tws.z)) as any;
    const wallGrain = dot(tri(0.9), vec3(0.33)).div(0.3) as any;
    const bands = sin(
      down
        .mul(46)
        .add(sin(down.mul(9).add(tint.mul(20))).mul(2))
        .add(p.y.mul(8))
    )
      .mul(0.5)
      .add(0.5) as any;
    // In the walls' own colour (their scan, laid on in the world), darker; dark and wet at the root where the water
    // gathers, paler toward the tip, and only the tip pale and thin enough to let the light through.
    const wallScan = tri(0.45, textures.cliff) as any;
    const root = float(1).sub(smoothstep(0, 0.3, down)) as any;
    const tip = smoothstep(0.72, 1, down) as any;
    const stain = wallScan.mul(mix(vec3(0.62, 0.55, 0.47), vec3(0.8, 0.7, 0.58), tint)) as any;
    const calciteTone = stain.mul(bands.mul(0.12).add(0.94)).mul(float(1).sub(root.mul(0.4))) as any;
    // The drop of water at a stalactite's tip (`aAlong` 1.6): near black, all reflection.
    const drop = step(1.3, down) as any;
    calcite.colorNode = mix(mix(calciteTone, vec3(0.7, 0.62, 0.5), tip.mul(0.65)).mul(wallGrain.mul(0.25).add(0.75)), vec3(0.02, 0.024, 0.028), drop) as any;
    // Wet: glassy at the root and in the runnels, a touch drier on the bands' ridges, and the tip wet where the water
    // runs off it.
    calcite.roughnessNode = mix(mix(mix(float(0.12), float(0.42), bands.mul(wallGrain.mul(0.5))), float(0.08), root), float(0.05), max(tip.mul(0.8), drop)) as any;
    const flecks = hash(dot(floor_(p.mul(42)) as any, vec3(1, 57, 113)) as any) as any;
    const toEyeC = normalize(cameraPosition.sub(p)) as any;
    const glint = pow(
      sin(
        t
          .mul(flecks.mul(4).add(1.5))
          .add(flecks.mul(80))
          .add(dot(toEyeC, vec3(9, 13, 7)))
      ).max(0),
      float(24)
    ).mul(step(0.985, flecks)) as any;
    const lampTo = lamp.position.sub(p) as any;
    // Per vertex: the lamp and the torches change over metres, and the six-torch loop per pixel was most of the cost of
    // the calcite's light (every dripstone, flowstone and curtain takes it).
    const litC = vertexStage(lamp.strength.div(dot(lampTo, lampTo).mul(0.25).add(1)).add(torchLightAt(p).mul(0.5))) as any;
    // The drop: a bright point where it faces the lamp (which is at the eye) and a rim of light round it.
    const facingC = dot(wn, toEyeC).abs() as any;
    const dropShine = pow(facingC, float(40))
      .mul(3)
      .add(pow(float(1).sub(facingC), float(3)).mul(0.5))
      .mul(drop) as any;
    // The tip: an amber glow where the light comes through it.
    calcite.emissiveNode = vec3(1, 0.95, 0.85)
      .mul(glint.mul(6).add(dropShine))
      .add(vec3(0.9, 0.5, 0.18).mul(tip.mul(0.35).mul(float(1).sub(drop))))
      .mul(litC) as any;

    // Drapery: the same calcite as one sheet, thick and dark where it leaves the crack, thinning toward its edge, the
    // faintest banding across, and amber where the light comes through the thin of it. A closed shell, so one-sided.
    const drapery = new THREE.MeshStandardNodeMaterial();
    const stripes = sin(positionGeometry.y.mul(38).add(sin(positionGeometry.x.mul(11)).mul(1.2)))
      .mul(0.5)
      .add(0.5) as any;
    const thin = smoothstep(0.25, 1, down) as any;
    drapery.colorNode = mix(stain.mul(0.85), vec3(0.62, 0.5, 0.36), thin.mul(0.5))
      .mul(stripes.mul(0.12).add(0.94))
      .mul(wallGrain.mul(0.25).add(0.75)) as any;
    drapery.roughnessNode = mix(float(0.3), float(0.15), thin) as any;
    drapery.emissiveNode = vec3(1.0, 0.52, 0.16)
      .mul(thin.mul(thin).mul(0.55))
      .mul(stripes.mul(0.25).add(0.85))
      .add(vec3(1, 0.95, 0.85).mul(glint.mul(4)))
      .mul(litC) as any;

    // Fungi: pale stems, caps glowing from within, each cluster its own shade of blue-green.
    const fungus = new THREE.MeshStandardNodeMaterial();
    const partA = attribute("aPart", "float") as any;
    const hue = mix(vec3(0.2, 1.0, 0.6), vec3(0.3, 0.7, 1.0), tint) as any;
    const pulse = sin(t.mul(0.9).add(tint.mul(30)))
      .mul(0.25)
      .add(0.75) as any;
    fungus.colorNode = mix(vec3(0.5, 0.55, 0.5), hue.mul(0.4), partA) as any;
    fungus.emissiveNode = hue.mul(mix(float(0.8), float(2.6), partA)).mul(pulse) as any;
    fungus.roughnessNode = float(0.5);
    // Giant mushrooms: the same shape, caps a deep translucent blue with pale spots, gills glowing.
    const shroom = new THREE.MeshStandardNodeMaterial();
    const spots = smoothstep(
      0.92,
      0.97,
      sin(positionGeometry.x.mul(41))
        .mul(sin(positionGeometry.z.mul(37)))
        .mul(0.5)
        .add(0.5)
    ) as any;
    // Velvety, dark caps with a few pale flecks; the light is in the gills underneath and the stem.
    shroom.colorNode = mix(mix(vec3(0.55, 0.6, 0.58), vec3(0.05, 0.08, 0.12), partA), vec3(0.45, 0.55, 0.6), spots.mul(partA).mul(0.5)) as any;
    // The gills: fine radial plates under the cap, glowing between them.
    const gillsAt = float(1)
      .sub(partA)
      .mul(smoothstep(0.6, 0.665, positionGeometry.y)) as any;
    const gillLines = pow(
      sin(atan(positionGeometry.z, positionGeometry.x).mul(72))
        .mul(0.5)
        .add(0.5),
      float(3)
    ) as any;
    shroom.emissiveNode = mix(
      vec3(0.2, 0.65, 0.9).mul(mix(float(1.3), gillLines.mul(1.6).add(0.5), gillsAt)),
      vec3(0.04, 0.16, 0.3)
        .mul(0.4)
        .add(vec3(0.3, 0.6, 0.8).mul(spots.mul(0.4))),
      partA
    ).mul(pulse) as any;
    shroom.roughnessNode = float(0.8);

    // Selenite: clear and milky gypsum, faintly warm. Its fibres run along the blade, so each face has a satin sheen in
    // fine lines along it, a little different face to face; faint phantoms (old growth faces) cross it; the light it
    // takes in is carried along it and comes out brightest at its ends and its edges seen side on. A hard glossy face.
    const selenite = new THREE.MeshPhysicalNodeMaterial({ clearcoat: 1, clearcoatRoughness: 0.03 });
    const toEye = normalize(cameraPosition.sub(p)) as any;
    const edge = pow(float(1).sub(dot(normalize(normalWorld), toEye).abs()), float(2.5)) as any;
    const along = positionGeometry.y as any;
    const sFace = attribute("aFace", "float") as any;
    const sEnd = attribute("aEnd", "float") as any;
    const fibres = sin(
      positionGeometry.x
        .mul(70)
        .add(positionGeometry.z.mul(110))
        .add(sin(along.mul(6).add(sFace.mul(20))).mul(1.6))
        .add(sFace.mul(9))
    )
      .mul(0.5)
      .add(0.5) as any;
    const phantom = smoothstep(0.93, 1, sin(along.mul(17).add(tint.mul(40)))) as any;
    const lampS = lamp.position.sub(p) as any;
    const litS = vertexStage(lamp.strength.div(dot(lampS, lampS).mul(0.06).add(1)).add(torchLightAt(p).mul(0.4))) as any;
    // The torches' own warmth carried through the blade (amber on the milky gypsum, against the cool of the lamp).
    const torchS = vertexStage(torchLightAt(p)) as any;
    selenite.colorNode = mix(vec3(0.78, 0.76, 0.7), vec3(0.95, 0.93, 0.86), tint).mul(fibres.mul(0.1).add(0.9)) as any;
    selenite.roughnessNode = mix(float(0.05), float(0.24), fibres.mul(float(1).sub(sEnd))) as any;
    selenite.emissiveNode = vec3(1.0, 0.9, 0.72)
      .mul(
        edge
          .mul(0.12)
          .add(0.012)
          .add(phantom.mul(0.05))
          .add(sEnd.mul(0.07))
          .add(fibres.mul(edge).mul(0.06))
      )
      .mul(litS.mul(0.8).add(0.35))
      .add(vec3(1.0, 0.6, 0.28).mul(torchS.mul(edge.mul(0.5).add(sEnd.mul(0.3)).add(0.04)).mul(0.12))) as any;

    // Bone: old ivory gone brown, darker where it lay in the dirt.
    const bone = new THREE.MeshStandardNodeMaterial();
    weathered(bone, mix(vec3(0.42, 0.35, 0.26), vec3(0.6, 0.53, 0.42), shade.mul(0.5).add(tint.mul(0.3))), 0.7, 0.025);

    // Rubble: the rock's own broken grain, tinted like the beds.
    const rubble = new THREE.MeshStandardNodeMaterial();
    // Drip-wet: where water falls from the roof the tops of fallen rock are dark and glassy, in patches (a slow pattern
    // of the world, so neighbours share their wet), the sides dry.
    const dripWet = smoothstep(0.35, 0.85, sin(p.x.mul(1.3).add(sin(p.z.mul(0.9)).mul(2))).mul(sin(p.z.mul(1.1).add(p.y))).mul(0.5).add(0.5))
      .mul(smoothstep(0.45, 0.9, wn.y)) as any;
    rubble.colorNode = mix(vec3(0.22, 0.18, 0.15), vec3(0.42, 0.31, 0.21), tint)
      .mul(shade.mul(0.6).add(0.4))
      .mul(float(1).sub(dripWet.mul(0.4))) as any;
    rubble.roughnessNode = mix(float(0.85), float(0.2), dripWet) as any;
    // Boulders: the walls' own scan laid over them in the world (so they match where they fell from), darker, damp low
    // down where they sit in the wet floor.
    const stone = new THREE.MeshStandardNodeMaterial();
    const low = float(1).sub(smoothstep(0.0, 0.35, positionGeometry.y)) as any;
    const stoneWet = max(low, dripWet) as any;
    stone.colorNode = wallScan
      .mul(mix(vec3(0.66, 0.58, 0.5), vec3(0.84, 0.72, 0.6), tint))
      .mul(wallGrain.mul(0.3).add(0.7))
      .mul(float(1).sub(stoneWet.mul(0.35))) as any;
    // Wet rock glints in the torchlight: low roughness where wet, and the grain's high points drier.
    stone.roughnessNode = mix(float(0.82), mix(float(0.35), float(0.14), dripWet), stoneWet).add(wallGrain.mul(0.08)) as any;

    // Rimstone: the dam of calcite stained like the dripstone, cream and glassy at its crest where the overflow runs;
    // inside it a few centimetres of clear water over a pale floor, deeper toward the middle (turquoise where deep,
    // the red taken first), glassy, mirroring the lights; and the cave pearls, polished ivory.
    const rimMat = new THREE.MeshStandardNodeMaterial();
    const rimA = attribute("aAlong", "float") as any;
    const pearl = step(1.5, rimA) as any;
    const basin = smoothstep(0.6, 0.95, rimA).mul(float(1).sub(pearl)) as any;
    const rimCrest = smoothstep(0.06, 0.095, positionGeometry.y).mul(float(1).sub(basin)) as any;
    const shallow = float(0.8).sub(positionGeometry.xz.length()).max(0).mul(0.12).add(0.01) as any;
    const bedTone = vec3(0.6, 0.55, 0.45).mul(wallGrain.mul(0.2).add(0.8)) as any;
    const dam = mix(stain.mul(bands.mul(0.1).add(0.95)), vec3(0.74, 0.68, 0.58), rimCrest.mul(0.6)) as any;
    rimMat.colorNode = mix(mix(dam, bedTone.mul(exp(vec3(2.2, 0.55, 0.42).mul(shallow).mul(-14))), basin), vec3(0.8, 0.76, 0.68), pearl) as any;
    rimMat.roughnessNode = mix(mix(mix(float(0.4), float(0.12), rimCrest), float(0.02), basin), float(0.12), pearl) as any;
    // The lights in the water, only where there is water (the loop over the lights skipped on the dam and the pearls).
    rimMat.emissiveNode = Fn(() => {
      const out = vec3(0).toVar("rimGlints") as any;
      If(basin.greaterThan(0.01), () => {
        out.assign(waterGlints(p, vec3(0, 1, 0)).mul(basin));
      });
      return out;
    })() as any;

    // Moonmilk: soft, white and wet like cottage cheese, curds in it, damp grey at its edge where it thins on the rock.
    const milkMat = new THREE.MeshStandardNodeMaterial();
    const curds = smoothstep(0.25, 0.75, wallGrain.mul(0.5).add(hash(floor_(p.mul(18)) as any).mul(0.25))) as any;
    const thinMilk = smoothstep(0.0, 0.08, positionGeometry.y) as any;
    milkMat.colorNode = mix(vec3(0.3, 0.29, 0.26), mix(vec3(0.6, 0.59, 0.55), vec3(0.72, 0.7, 0.65), curds), thinMilk).mul(tint.mul(0.12).add(0.9)) as any;
    milkMat.roughnessNode = mix(float(0.5), float(0.85), curds) as any;

    // Roots: dark wet bark, fibrous along its length, paler and fresher toward the growing tips, mud where it comes
    // through the roof.
    const rootMat = new THREE.MeshStandardNodeMaterial();
    const rootA = attribute("aAlong", "float") as any;
    const fibre = sin(positionGeometry.x.mul(160).add(positionGeometry.z.mul(140)).add(positionGeometry.y.mul(9)))
      .mul(0.5)
      .add(0.5) as any;
    const muddy = float(1).sub(smoothstep(0.0, 0.15, rootA)) as any;
    rootMat.colorNode = mix(mix(vec3(0.15, 0.1, 0.065), vec3(0.42, 0.33, 0.23), smoothstep(0.55, 1, rootA)).mul(fibre.mul(0.25).add(0.8)), vec3(0.13, 0.1, 0.08), muddy) as any;
    rootMat.roughnessNode = mix(float(0.45), float(0.75), fibre.mul(0.5).add(muddy.mul(0.5))) as any;

    // Carved stone: dressed blocks with a band of worn glyphs; the sealed door darker.
    const carved = new THREE.MeshStandardNodeMaterial();
    const g2 = positionGeometry as any;
    const glyph = smoothstep(0.42, 0.46, abs(fract(g2.y.mul(9)).sub(0.5)))
      .mul(smoothstep(0.38, 0.45, abs(fract(g2.x.mul(7).add(sin(g2.y.mul(30)).mul(0.1))).sub(0.5))))
      .mul(step01(abs(g2.y).lessThan(0.38))) as any;
    carved.colorNode = mix(vec3(0.55, 0.5, 0.42), vec3(0.3, 0.27, 0.24), tint)
      .mul(float(1).sub(glyph.mul(0.35)))
      .mul(shade.mul(0.4).add(0.6)) as any;
    carved.roughnessNode = float(0.8);

    const tin = new THREE.MeshStandardNodeMaterial({ color: "#3a332a", roughness: 0.5, metalness: 0.75 });
    // A still pool: black, glassy water over the rock, fading out at its edge into the wet floor, with the lights
    // mirrored crisply in it, a dim sheen of the lit roof at a glancing look, and now and then a ring from a drip.
    const mirror = reflector({ resolutionScale: 0.25, bounces: false }) as any;
    const puddleShape = new THREE.CircleGeometry(1, 28);
    puddleShape.rotateX(-Math.PI / 2);
    const still = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false });
    const local = positionGeometry.xz.length().add(sin(positionGeometry.x.mul(9).add(positionGeometry.z.mul(7))).mul(0.05)) as any;
    still.colorNode = vec3(0.012, 0.014, 0.016);
    still.roughnessNode = float(0.02);
    still.opacityNode = smoothstep(1, 0.6, local).mul(0.94) as any;
    const dripAt = fract(t.mul(0.23).add(tint.mul(7))) as any;
    const rings = sin(local.sub(dripAt.mul(1.2)).mul(40))
      .mul(float(1).sub(dripAt))
      .mul(smoothstep(0.15, 0, abs(local.sub(dripAt.mul(1.2))))) as any;
    const surface = normalize(vec3(rings.mul(0.15), 1, rings.mul(0.1))) as any;
    still.normalNode = transformNormalToView(surface) as any;
    const glance = pow(float(1).sub(normalize(cameraPosition.sub(p)).y.max(0)), float(4)) as any;
    const lampNear = lamp.position.sub(p) as any;
    const roof = vec3(0.5, 0.32, 0.18)
      .mul(lamp.strength.div(dot(lampNear, lampNear).mul(0.15).add(1)))
      .mul(glance.mul(0.8).add(0.08)) as any;
    mirror.target.rotateX(-Math.PI / 2);
    // Ripples bend what it mirrors, a little.
    mirror.uvNode = mirror.uvNode.add(vec2(rings.mul(0.012), rings.mul(0.008)));
    const onPlane = float(1).sub(smoothstep(0.03, 0.09, abs(p.y.sub(mirrorLevel)))) as any;
    const fresnel = float(0.25).add(glance.mul(0.75)) as any;
    still.emissiveNode = waterGlints(p, surface)
      .add(mix(roof, mirror.rgb.mul(fresnel).mul(1.1), onPlane))
      .mul(smoothstep(1, 0.6, local)) as any;
    const flameMaterial = new THREE.MeshBasicNodeMaterial();
    flameMaterial.colorNode = vec3(1.0, 0.62, 0.25).mul(sin(t.mul(13)).mul(0.08).add(5)) as any;
    // The light of a camp's fire on what stands round it: warm, by how much each face turns to it, per vertex for its
    // falloff (it changes over metres). Zero where no fire is near.
    const toFire = fireLight.xyz.sub(p) as any;
    const fireNear = vertexStage(fireLight.w.div(dot(toFire, toFire).mul(1.6).add(0.3))) as any;
    const fireOn = (albedo: any) =>
      albedo
        .mul(vec3(1.0, 0.52, 0.22))
        .mul(fireNear)
        .mul(max(dot(wn, normalize(toFire)), 0).mul(0.85).add(0.15)) as any;
    const wood = new THREE.MeshStandardNodeMaterial({ color: "#5a3c22", roughness: 0.85 });
    const cloth = new THREE.MeshStandardNodeMaterial({ color: "#4a4a3a", roughness: 0.95 });
    const hemp = new THREE.MeshStandardNodeMaterial({ color: "#8a7350", roughness: 0.9 });
    wood.emissiveNode = fireOn(vec3(0.1, 0.045, 0.017));
    cloth.emissiveNode = fireOn(vec3(0.066, 0.066, 0.042));
    hemp.emissiveNode = fireOn(vec3(0.25, 0.17, 0.08));
    tin.emissiveNode = fireOn(vec3(0.04, 0.03, 0.02));
    rubble.emissiveNode = fireOn(rubble.colorNode);
    stone.emissiveNode = fireOn(stone.colorNode);

    // Logs on a fire: ridged bark, charred black toward the end in the coals, the char split into glowing cracks that
    // breathe.
    const logMat = new THREE.MeshStandardNodeMaterial();
    const burnt = smoothstep(0.5, 0.95, attribute("aAlong", "float")) as any;
    const barkLines = sin(positionGeometry.y.mul(37).add(sin(atan(positionGeometry.z, positionGeometry.x).mul(9)).mul(2)))
      .mul(0.5)
      .add(0.5) as any;
    const logAlbedo = mix(vec3(0.2, 0.13, 0.08).mul(barkLines.mul(0.45).add(0.65)), vec3(0.025, 0.02, 0.018), burnt) as any;
    logMat.colorNode = logAlbedo;
    logMat.roughnessNode = mix(float(0.85), float(0.95), burnt) as any;
    const charCracks = smoothstep(0.55, 0.85, abs(mx_noise_float(positionGeometry.mul(vec3(11, 4, 11)).add(tint.mul(7)))).oneMinus()) as any;
    const breathe = mx_noise_float(vec3(positionGeometry.y.mul(5), t.mul(1.1), tint.mul(9)))
      .mul(0.35)
      .add(0.8) as any;
    logMat.emissiveNode = vec3(1.0, 0.3, 0.05)
      .mul(charCracks.mul(burnt).mul(breathe).mul(3.4))
      .add(fireOn(logAlbedo)) as any;
    // The coals under them: grey ash at the rim, black coal toward the middle, glowing in a slowly crawling pattern.
    const emberMat = new THREE.MeshStandardNodeMaterial();
    const hotness = attribute("aAlong", "float") as any;
    const coals = mx_noise_float(vec3(p.x.mul(16), p.z.mul(16), t.mul(0.35)))
      .mul(0.5)
      .add(0.5) as any;
    emberMat.colorNode = mix(vec3(0.17, 0.16, 0.15), vec3(0.03, 0.025, 0.02), smoothstep(0.15, 0.6, hotness)) as any;
    emberMat.roughnessNode = float(0.95);
    emberMat.emissiveNode = vec3(1.0, 0.28, 0.04).mul(smoothstep(0.45, 0.8, coals).mul(smoothstep(0.1, 0.7, hotness)).mul(breathe).mul(3)) as any;
    // Flames: tongues drawn additively, white-gold at the foot reddening toward the tip, licked away by noise rising
    // through them, never twice the same.
    const fireMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const fh = attribute("aAlong", "float") as any;
    const lick = mx_noise_float(
      vec3(
        positionGeometry.x.mul(4.5),
        positionGeometry.y.mul(2.6).sub(t.mul(3.6)),
        positionGeometry.z.mul(4.5).add(tint.mul(13))
      )
    ) as any;
    const fireTone = mix(vec3(1.0, 0.72, 0.32), vec3(0.85, 0.18, 0.02), smoothstep(0.05, 0.85, fh)) as any;
    fireMat.colorNode = fireTone
      .mul(float(1).sub(fh).mul(1.3).add(0.25))
      .mul(smoothstep(-0.25, 0.35, lick.sub(fh.mul(0.55)).add(0.2)))
      .mul(sin(t.mul(17).add(tint.mul(30))).mul(0.12).add(1)) as any;

    // Fossil bone: mineralised dark brown, darker in its pores and hollows; a dinosaur's teeth paler, their enamel kept.
    const speck = fract(sin(dot(p.mul(83), vec3(12.9898, 78.233, 37.719))).mul(43758.5)) as any;
    const fossilTone = mix(vec3(0.25, 0.18, 0.12), vec3(0.45, 0.35, 0.24), speck.mul(0.45).add(tint.mul(0.35))) as any;
    const fossilBone = new THREE.MeshStandardNodeMaterial();
    weathered(fossilBone, fossilTone, 0.55, 0.04);
    const skullBone = new THREE.MeshStandardNodeMaterial();
    weathered(skullBone, mix(fossilTone, vec3(0.56, 0.47, 0.34), attribute("aPart", "float")), 0.55, 0.04);
    // Ammonite and trilobite shell: pale weathered calcite, some turned to pyrite (brassy, metallic).
    const shell = new THREE.MeshStandardNodeMaterial();
    const pyrite = smoothstep(0.6, 0.62, hash(instanceIndex.add(3))) as any;
    weathered(shell, mix(mix(vec3(0.62, 0.56, 0.46), vec3(0.78, 0.72, 0.6), speck.mul(0.5)), vec3(0.8, 0.64, 0.34), pyrite), 0.65, 0.012);
    shell.metalnessNode = pyrite.mul(0.85) as any;
    shell.roughnessNode = mix(shell.roughnessNode as any, float(0.3), pyrite) as any;
    // Quartz round a crystal pool: clear and glassy, the pool's cool light caught in its edges and points.
    const quartz = new THREE.MeshStandardNodeMaterial({ roughness: 0.06, metalness: 0 });
    const qEnd = attribute("aEnd", "float") as any;
    quartz.colorNode = mix(vec3(0.5, 0.56, 0.58), vec3(0.72, 0.78, 0.8), tint) as any;
    quartz.emissiveNode = vec3(0.4, 0.85, 0.9)
      .mul(edge.mul(0.22).add(qEnd.mul(0.1)).add(0.02))
      .mul(litS.mul(0.5).add(0.5))
      .add(vec3(1, 0.97, 0.9).mul(glint.mul(5).mul(litS))) as any;

    const stalactite = dripCluster(11);
    const stalactiteB = dripCluster(29);
    const stalagmite = dripCluster(47, false, true);
    const column = dripCluster(83, true);
    const boneShape = longBone();
    const pebble = new THREE.IcosahedronGeometry(1, 1);
    pebble.deleteAttribute("uv");
    const geometries: Record<PoolName, { geometry: THREE.BufferGeometry; material: THREE.Material }[]> = {
      stalactite: [{ geometry: stalactite, material: calcite }],
      stalactiteB: [{ geometry: stalactiteB, material: calcite }],
      stalagmite: [{ geometry: stalagmite, material: calcite }],
      column: [{ geometry: column, material: calcite }],
      straw: [{ geometry: straws(5), material: calcite }],
      curtain: [{ geometry: curtain(), material: drapery }],
      fungus: [{ geometry: mushroom(), material: fungus }],
      shroom: [{ geometry: mushroom(true), material: shroom }],
      rubble: [{ geometry: pebble, material: rubble }],
      boulder0: [{ geometry: props.boulders[0], material: stone }],
      boulder1: [{ geometry: props.boulders[1], material: stone }],
      boulder2: [{ geometry: props.boulders[2], material: stone }],
      selenite: [{ geometry: seleniteBlade(), material: selenite }],
      bone: [{ geometry: boneShape, material: bone }],
      skull: [{ geometry: bearSkull(), material: bone }],
      rib: [{ geometry: ribArc(), material: bone }],
      block: [{ geometry: new THREE.BoxGeometry(1, 1, 1), material: carved }],
      puddle: [{ geometry: puddleShape, material: still }],
      lantern: [{ geometry: stormLantern(), material: tin }],
      flame: [{ geometry: new THREE.SphereGeometry(1, 10, 8), material: flameMaterial }],
      hatchet: props.hatchet,
      crate: [{ geometry: new THREE.BoxGeometry(0.55, 0.4, 0.4), material: wood }],
      bedroll: [{ geometry: new THREE.CylinderGeometry(0.14, 0.14, 0.75, 12), material: cloth }],
      rope: [{ geometry: new THREE.TorusGeometry(0.16, 0.025, 6, 20), material: hemp }],
      breakdown0: [{ geometry: breakdownBlock(3), material: stone }],
      breakdown1: [{ geometry: breakdownBlock(17), material: stone }],
      rimstone: [{ geometry: rimstone(5), material: rimMat }],
      flowstone: [{ geometry: flowstone(9), material: calcite }],
      moonmilk: [{ geometry: moonmilk(13), material: milkMat }],
      roots: [{ geometry: rootTangle(19), material: rootMat }],
      log: [{ geometry: fireLog(), material: logMat }],
      embers: [{ geometry: emberBed(), material: emberMat }],
      fire: [{ geometry: flameTongue(), material: fireMat }],
      dinoSkull: [{ geometry: dinoSkull(), material: skullBone }],
      dinoVert: [{ geometry: vertebra(), material: fossilBone }],
      dinoRib: [{ geometry: dinoRib(), material: fossilBone }],
      limb: [{ geometry: boneShape, material: fossilBone }],
      ammonite: [{ geometry: ammoniteGeometry(), material: shell }],
      trilobite: [{ geometry: trilobiteGeometry(), material: shell }],
      quartz: [{ geometry: quartzPoint(7), material: quartz }]
    };
    // One mesh per pool per slot (and per part, for a prop of several), all of a pool's sharing its geometry and
    // material, so one shader serves them. Each draws exactly what its cavern placed, is culled by its own bounds, and
    // is hidden while its cavern is sealed in the rock: hidden instances in one big mesh still ran their whole vertex
    // work, every slot's, wherever the eye looked.
    const pools = {} as Record<PoolName, THREE.InstancedMesh[][]>;
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const name of POOLS) {
      const group = GROUP[name];
      pools[name] = Array.from({ length: group ? (KIND_SLOTS[group] as number) : SLOTS }, () =>
        geometries[name].map(({ geometry, material }) => {
          const mesh = new THREE.InstancedMesh(geometry, material, PER[name]);
          for (let k = 0; k < PER[name]; k++) mesh.setMatrixAt(k, hidden);
          mesh.count = 1;
          mesh.userData.placed = 0;
          mesh.visible = false;
          // Not culled until the scene is live, so the engine's warm-up draws (and builds) every pool.
          mesh.frustumCulled = false;
          mesh.castShadow = false;
          mesh.receiveShadow = true;
          return mesh;
        })
      );
    }

    // The rivers' water: shaped to each passage (see `river`), one strip per slot. Clear water over a pale bed, deeper
    // and greener mid-stream; the current carries its ripples and its foam downstream, white water boiling where the
    // fall lands and fading away from it, a little along the banks. The lights it mirrors, at the cost of a few dot
    // products (no second render).
    const water = sheets(48);
    const waterMaterial = new THREE.MeshStandardNodeMaterial();
    const flow = attribute("aSheet", "vec4") as any;
    const flowDir = normalize(vec2(flow.x, flow.y).add(vec2(1e-4, 0))) as any;
    // Along the river in metres downstream of the fall, and across it from bank (-1) to bank (1).
    const downstream = flow.w as any;
    const bankAt = flow.z as any;
    const moving = downstream.sub(t.mul(1.2)) as any;
    const swirl = mx_noise_float(vec3(moving.mul(1.6), bankAt.mul(2.2), t.mul(0.25))) as any;
    const chop = mx_noise_float(vec3(moving.mul(4.5), bankAt.mul(5), t.mul(0.6).add(4))) as any;
    const crest = sin(moving.mul(7).add(swirl.mul(3))) as any;
    const slopeAlong = crest.mul(0.045).add(chop.mul(0.06)) as any;
    const slopeAcross = swirl.mul(0.05) as any;
    const current = normalize(vec3(flowDir.x.mul(slopeAlong).sub(flowDir.y.mul(slopeAcross)), 1, flowDir.y.mul(slopeAlong).add(flowDir.x.mul(slopeAcross)))) as any;
    const nearFall = exp(abs(downstream).mul(-0.5)) as any;
    const churn = mx_noise_float(vec3(moving.mul(3), bankAt.mul(6), t.mul(0.9))) as any;
    const foamField = nearFall
      .mul(1.3)
      .add(smoothstep(0.72, 1, abs(bankAt)).mul(0.4))
      .add(smoothstep(0.3, 0.8, swirl).mul(0.22)) as any;
    const foam = smoothstep(0.38, 0.78, foamField.mul(churn.mul(0.5).add(0.72))) as any;
    const deep = float(1).sub(bankAt.mul(bankAt)).mul(0.45) as any;
    const clear = vec3(0.32, 0.28, 0.21)
      .mul(exp(vec3(2.2, 0.55, 0.42).mul(deep).mul(-1.8)))
      .add(vec3(0.004, 0.012, 0.014)) as any;
    waterMaterial.colorNode = mix(clear, vec3(0.8, 0.84, 0.82), foam) as any;
    waterMaterial.roughnessNode = mix(float(0.035), float(0.55), foam) as any;
    waterMaterial.metalnessNode = float(0);
    waterMaterial.normalNode = transformNormalToView(normalize(mix(current, vec3(0, 1, 0), foam.mul(0.6)))) as any;
    waterMaterial.emissiveNode = waterGlints(p, current)
      .mul(float(1).sub(foam))
      .add(vec3(0.7, 0.75, 0.75).mul(foam.mul(litC).mul(0.12))) as any;

    // The fall: a sheet of water arcing out from a crack in the roof (`fallSheet`), drawn twice over the same shape. Its
    // streaks are noise laid along how long the water has been falling, so they run down speeding up and stretch as
    // they go; it frays at its sides and breaks into strands lower down, aerates white toward the foot (and at the lip),
    // and sparkles where the light catches it. Once cut to its strands in the scene (so it has depth, and is focused
    // with the water round it), once as a soft translucent veil over them.
    const fallShape = fallSheet();
    const fallLook = new Float32Array(SLOTS * 4);
    const fallLookAttribute = new THREE.InstancedBufferAttribute(fallLook, 4);
    fallShape.setAttribute("aFallLook", fallLookAttribute);
    const look = attribute("aFallLook", "vec4") as any;
    const fu = uv() as any;
    const tau = fu.y.mul(look.y).mul(2 / 9.8).add(0.0004).sqrt() as any;
    const fallen = tau.sub(t) as any;
    const acrossF = fu.x.sub(0.5).mul(look.x) as any;
    const strands = mx_noise_float(vec3(acrossF.mul(7), fallen.mul(6), look.z))
      .mul(0.6)
      .add(mx_noise_float(vec3(acrossF.mul(19), fallen.mul(13), look.z.add(5))).mul(0.4)) as any;
    const sides = smoothstep(0, 0.2, float(0.5).sub(abs(fu.x.sub(0.5)))) as any;
    const density = strands.mul(0.5).add(0.56).mul(sides).sub(fu.y.mul(0.22)) as any;
    const aerated = clamp(smoothstep(0.78, 1, fu.y).mul(look.w.mul(0.6).add(0.4)).add(smoothstep(0.1, 0, fu.y).mul(0.5)).add(fu.y.mul(0.25)), 0, 1) as any;
    const lampF = lamp.position.sub(p) as any;
    const litF = vertexStage(lamp.strength.div(dot(lampF, lampF).mul(0.12).add(1)).add(torchLightAt(p).mul(0.6)).add(0.05)) as any;
    const sparkle = pow(mx_noise_float(vec3(acrossF.mul(40), fallen.mul(30), 3)).mul(0.5).add(0.5), float(10)).mul(3) as any;
    const fallTone = mix(vec3(0.42, 0.52, 0.55), vec3(0.88, 0.92, 0.94), aerated) as any;
    const fallMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    fallMaterial.colorNode = fallTone
      .mul(density.mul(0.5).add(0.35))
      .add(sparkle)
      .mul(litF) as any;
    fallMaterial.maskNode = density.greaterThan(aerated.mul(-0.1).add(0.6)) as any;
    const veilMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
    veilMaterial.colorNode = fallTone
      .mul(0.75)
      .add(sparkle.mul(0.5))
      .mul(litF) as any;
    veilMaterial.opacityNode = clamp(density.mul(0.4).add(aerated.mul(0.35)), 0, 0.85).mul(sides) as any;
    const falls = new THREE.InstancedMesh(fallShape, fallMaterial, SLOTS);
    const veils = new THREE.InstancedMesh(fallShape, veilMaterial, SLOTS);
    for (const m of [falls, veils]) {
      for (let k = 0; k < SLOTS; k++) m.setMatrixAt(k, hidden);
      m.frustumCulled = false;
    }
    veils.instanceMatrix = falls.instanceMatrix;

    // Spray where the fall lands: drops thrown up and out on short arcs, drawn in the overlay pass, a set per slot.
    const splashData = new Float32Array(SLOTS * SPLASH * 4);
    const splashAttribute = new THREE.InstancedBufferAttribute(splashData, 4);
    const splashQuad = new THREE.PlaneGeometry(1, 1);
    splashQuad.setAttribute("aSplash", splashAttribute);
    const splash = overlayMaterial();
    const splashes = new THREE.InstancedMesh(splashQuad, splash, SLOTS * SPLASH);
    splashes.frustumCulled = false;
    splashes.layers.set(OVERLAY_LAYER);

    // Mist off the falls, and heat off the lava: soft sprites in the overlay pass.
    const MIST = 260;
    const mistData = new Float32Array(MIST * 4);
    const mistLook = new Float32Array(MIST * 4);
    const mistAttribute = new THREE.InstancedBufferAttribute(mistData, 4).setUsage(THREE.DynamicDrawUsage);
    const mistLookAttribute = new THREE.InstancedBufferAttribute(mistLook, 4).setUsage(THREE.DynamicDrawUsage);
    const mistQuad = new THREE.PlaneGeometry(1, 1);
    mistQuad.setAttribute("aMist", mistAttribute);
    mistQuad.setAttribute("aMistLook", mistLookAttribute);
    const mist = overlayMaterial();
    const mists = new THREE.InstancedMesh(mistQuad, mist, MIST);
    mists.frustumCulled = false;
    mists.layers.set(OVERLAY_LAYER);
    const puffs = Array.from({ length: MIST }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), age: 0, life: 0, size: 0, hot: 0 }));

    // Lava: crusted, glowing rock pooled in a fissure's floor (shaped to it, see `pool`), its cracks slowly crawling,
    // the crust thicker and darker toward its edge where it has cooled.
    const lavas = sheets(72);
    const lavaMaterial = new THREE.MeshStandardNodeMaterial();
    const lp = p.xz.mul(1.3) as any;
    const crack = abs(sin(lp.x.mul(2.1).add(sin(lp.y.mul(1.7).add(t.mul(0.15))).mul(1.8))).mul(sin(lp.y.mul(2.6).sub(sin(lp.x.mul(1.3).sub(t.mul(0.1))).mul(1.6))))) as any;
    const cooled = smoothstep(0.7, 1, attribute("aSheet", "vec4").z) as any;
    const heat = pow(float(1).sub(crack), float(5)).mul(float(1).sub(cooled.mul(0.85))) as any;
    lavaMaterial.colorNode = vec3(0.05, 0.035, 0.03) as any;
    lavaMaterial.roughnessNode = float(0.85);
    lavaMaterial.emissiveNode = mix(vec3(0.5, 0.06, 0.01), vec3(4.0, 1.6, 0.4), heat).mul(heat.mul(0.95).add(float(0.05).mul(float(1).sub(cooled)))) as any;
    const lava = new THREE.Mesh(lavas.geometry, lavaMaterial);
    const stream = new THREE.Mesh(water.geometry, waterMaterial);

    // A crystal pool's water (shaped to its basin, see `pool`): still and clear, blue-green deepening toward the middle
    // over a pale bed, lit from within, a slow shiver on it, the lights mirrored in it.
    const ponds = sheets(96);
    const pondMaterial = new THREE.MeshStandardNodeMaterial();
    const pondRing = attribute("aSheet", "vec4").z as any;
    const pondDeep = float(1).sub(pondRing.mul(pondRing)) as any;
    const shiver = vec2(mx_noise_float(vec3(p.x.mul(2.5), p.z.mul(2.5), t.mul(0.25))), mx_noise_float(vec3(p.z.mul(2.5).add(7), p.x.mul(2.5), t.mul(0.25)))).mul(0.035) as any;
    const pondNormal = normalize(vec3(shiver.x, 1, shiver.y)) as any;
    pondMaterial.colorNode = vec3(0.5, 0.56, 0.52).mul(exp(vec3(2.2, 0.55, 0.42).mul(pondDeep.mul(-1.5)))) as any;
    pondMaterial.roughnessNode = float(0.03);
    pondMaterial.metalnessNode = float(0);
    pondMaterial.normalNode = transformNormalToView(pondNormal) as any;
    pondMaterial.emissiveNode = waterGlints(p, pondNormal).add(
      vec3(0.04, 0.3, 0.32)
        .mul(pondDeep.mul(0.7).add(0.12))
        .mul(sin(t.mul(0.6).add(p.x.mul(0.8))).mul(0.08).add(0.92))
    ) as any;
    const pond = new THREE.Mesh(ponds.geometry, pondMaterial);
    for (const m of [lava, stream, pond]) m.frustumCulled = false;
    stream.receiveShadow = true;
    pond.receiveShadow = true;

    // None of them lit by the open sky's fill underground.
    const lit = [calcite, drapery, fungus, shroom, selenite, bone, rubble, stone, carved, tin, wood, cloth, hemp, waterMaterial, rimMat, milkMat, rootMat, logMat, emberMat, fossilBone, skullBone, shell, quartz, pondMaterial];
    for (const m of lit) if (!m.aoNode) m.aoNode = caveShade();
    for (const m of [...lit, still, lavaMaterial]) m.lightsNode = caveLights;
    const materials = [...lit, still, flameMaterial, fallMaterial, veilMaterial, mist, splash, lavaMaterial, fireMat];
    const shapes = [...new Set([...Object.values(geometries).flatMap((list) => list.map((x) => x.geometry)), water.geometry, fallShape, mistQuad, splashQuad, lavas.geometry, ponds.geometry])];
    return {
      mirror,
      pools,
      hidden,
      water,
      stream,
      falls,
      veils,
      fallLook,
      fallLookAttribute,
      splash,
      splashes,
      splashData,
      splashAttribute,
      lava,
      mist,
      mists,
      mistData,
      mistLook,
      mistAttribute,
      mistLookAttribute,
      puffs,
      lavas,
      ponds,
      pond,
      materials,
      shapes,
      random: lehmer(31337),
      next: 0
    };
  }, [props, textures]);
  useDispose(...built.materials, ...built.shapes);
  const { tier } = useQuality();

  useOverlay(built.mist, (sceneZ) => {
    const s = attribute("aMist", "vec4") as any;
    const l = attribute("aMistLook", "vec4") as any;
    const toEye = normalize(cameraPosition.sub(s.xyz)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    built.mist.positionNode = s.xyz.add(right.mul(positionGeometry.x.mul(s.w))).add(up.mul(positionGeometry.y.mul(s.w))) as any;
    const r = uv().sub(0.5).mul(2).length() as any;
    const soft = pow(float(1).sub(smoothstep(0, 1, r)), float(2)) as any;
    const behind = clamp(positionView.z.sub(sceneZ).div(0.4).add(1), 0, 1) as any;
    // Mist is lit by the headlamp; the heat off lava glows orange by itself.
    const colour = mix(vec3(0.5, 0.55, 0.58).mul(lamp.strength.mul(0.6).add(0.1)), vec3(1.0, 0.4, 0.1).mul(0.8), l.y) as any;
    built.mist.colorNode = vec4(colour.mul(soft).mul(l.x).mul(behind).mul(0.06), 1) as any;
    built.mist.needsUpdate = true;
  });

  // The spray: each drop on its own short arc from the foot of the fall, again and again, worked out in the shader
  // from its number alone (no state on the page); gone back below the surface it came out of.
  useOverlay(built.splash, (sceneZ) => {
    const s = attribute("aSplash", "vec4") as any;
    const seed = hash(instanceIndex.add(5)) as any;
    const seed2 = hash(instanceIndex.add(71)) as any;
    const seed3 = hash(instanceIndex.add(313)) as any;
    const life = seed.mul(0.5).add(0.55) as any;
    const phase = fract((rockUniforms.time as any).div(life).add(seed2)) as any;
    const tau = phase.mul(life) as any;
    const angle = seed3.mul(Math.PI * 2) as any;
    const out = vec3(cos(angle), 0, sin(angle)) as any;
    const centre = s.xyz
      .add(out.mul(seed2.mul(0.35).add(0.1)))
      .add(out.mul(seed.mul(0.9).add(0.3).mul(tau)))
      .add(vec3(0, seed2.mul(1.4).add(0.7).mul(tau).sub(tau.mul(tau).mul(4.9)), 0)) as any;
    const away = cameraPosition.sub(centre).length() as any;
    const size = max(seed.mul(0.012).add(0.008), away.mul(0.0016)) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    built.splash.positionNode = centre.add(right.mul(positionGeometry.x.mul(size))).add(up.mul(positionGeometry.y.mul(size))) as any;
    const r = uv().sub(0.5).mul(2).length() as any;
    const soft = pow(float(1).sub(smoothstep(0, 1, r)), float(2)) as any;
    const behind = clamp(positionView.z.sub(sceneZ).div(0.2).add(1), 0, 1) as any;
    const above = step(s.y.sub(0.02), centre.y) as any;
    const toLamp = lamp.position.sub(centre) as any;
    const lit = lamp.strength.div(dot(toLamp, toLamp).mul(0.15).add(1)).add(torchLightAt(centre).mul(0.5)).add(0.05) as any;
    built.splash.colorNode = vec4(
      vec3(0.8, 0.88, 0.92)
        .mul(soft)
        .mul(lit)
        .mul(behind)
        .mul(above)
        .mul(s.w)
        .mul(float(1).sub(phase))
        .mul(0.9),
      1
    ) as any;
    built.splash.needsUpdate = true;
  });

  const state = useMemo(
    () => ({
      dressed: new Map<Cavern, Dressing>(),
      free: Array.from({ length: SLOTS }, (_, k) => SLOTS - 1 - k),
      // Each kind's own free slots.
      kindFree: Object.fromEntries(Object.entries(KIND_SLOTS).map(([kind, n]) => [kind, Array.from({ length: n as number }, (_, k) => (n as number) - 1 - k)])) as Record<string, number[]>,
      check: 0,
      glowList: [] as Glow[],
      crackleAt: 0,
      gone: false,
      // Whether the finest pools are drawn (not on the lowest tier), and whether the scene was live last frame.
      fine: true,
      live: false,
      settle: 0,
      misty: false
    }),
    []
  );
  useEffect(() => {
    state.fine = tier !== "low";
    for (const d of state.dressed.values()) d.shown = null;
  }, [tier, state]);
  useEffect(
    () => () => {
      state.gone = true;
    },
    [state]
  );
  const scratch = useMemo(() => ({ list: [] as Cavern[], v: new THREE.Vector3(), at: new THREE.Vector3(), off: new THREE.Vector3(), frustum: new THREE.Frustum(), m4: new THREE.Matrix4(), black: new THREE.Color(0, 0, 0) }), []);
  // For `__burrowStats()`: the caverns dressed and shown, and the pools' meshes and instances in view.
  useEffect(() => {
    statSources.set("dressing", () => {
      const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      let meshes = 0;
      let instances = 0;
      let vertices = 0;
      let shown = 0;
      for (const name of POOLS)
        for (const slot of built.pools[name])
          for (const mesh of slot) {
            if (!mesh.visible || !mesh.boundingSphere || !frustum.intersectsSphere(mesh.boundingSphere)) continue;
            meshes++;
            instances += mesh.count;
            vertices += mesh.count * mesh.geometry.getAttribute("position").count;
          }
      for (const d of state.dressed.values()) if (d.shown) shown++;
      return { "caverns dressed": state.dressed.size, "caverns shown (not sealed)": shown, "dressing meshes in view": meshes, "dressing instances in view": instances, "dressing vertices in view": vertices, "puddle mirror": built.pools.puddle.some((list) => list.some((mesh) => mesh.visible)) ? "on" : "off" };
    });
    return () => {
      statSources.delete("dressing");
    };
  }, [built, state, camera]);

  // Puts a cavern's dressing in its slots (or takes it away, with `placed` empty): the common pools in its slot, its
  // kind's own pools in its kind slot. Each mesh then draws exactly what was placed in it, and is culled by its own
  // bounds.
  const fill = (d: Dressing, placed: Placed[]) => {
    const kind = d.cavern.kind;
    const counts = {} as Record<PoolName, number>;
    for (const name of POOLS) counts[name] = 0;
    const meshes = (name: PoolName) => {
      const slot = GROUP[name] ? (GROUP[name] === kind ? d.kindSlot : -1) : d.slot;
      return slot < 0 ? null : built.pools[name][slot];
    };
    for (const piece of placed) {
      const list = meshes(piece.pool);
      const k = counts[piece.pool]++;
      if (!list || k >= PER[piece.pool]) continue;
      for (const mesh of list) mesh.setMatrixAt(k, piece.m);
    }
    for (const name of POOLS) {
      const list = meshes(name);
      if (!list) continue;
      const n = Math.min(counts[name], PER[name]);
      for (const mesh of list) {
        // Never none, so the warm-up still has an instance to draw (at zero scale).
        if (!n) mesh.setMatrixAt(0, built.hidden);
        mesh.count = Math.max(1, n);
        mesh.userData.placed = n;
        mesh.instanceMatrix.needsUpdate = true;
        if (n) mesh.computeBoundingSphere();
      }
    }
    d.shown = null;
  };

  // Shows or hides everything a dressed cavern has in the pools, and its fall (cut to its strands, it is shaded even
  // where rock hides it).
  const show = (d: Dressing, on: boolean) => {
    if (d.shown !== on && d.water?.fall) placeFall(d.slot, on ? d.water.fall : undefined);
    d.shown = on;
    const kind = d.cavern.kind;
    for (const name of POOLS) {
      const group = GROUP[name];
      const slot = group ? (group === kind ? d.kindSlot : -1) : d.slot;
      if (slot < 0) continue;
      // (The puddles show with the mirror, in the frame loop.)
      if (name === "puddle") continue;
      const draw = on && (state.fine || !FINE.includes(name));
      for (const mesh of built.pools[name][slot]) mesh.visible = draw && mesh.userData.placed > 0;
    }
  };

  // Lets a cavern's dressing go, its slots back to the free lists.
  const release = (d: Dressing) => {
    fill(d, []);
    show(d, false);
    for (const mesh of built.pools.puddle[d.slot]) mesh.visible = false;
    built.water.write(d.slot, []);
    built.lavas.write(d.slot, []);
    built.ponds.write(d.slot, []);
    placeFall(d.slot);
    stillLevel.delete(d.cavern);
    stillSpread.delete(d.cavern);
    state.dressed.delete(d.cavern);
    state.free.push(d.slot);
    state.free.sort((a, b) => b - a);
    if (d.kindSlot >= 0) {
      const list = state.kindFree[d.cavern.kind];
      list.push(d.kindSlot);
      list.sort((a, b) => b - a);
    }
  };

  // A cavern's dressing come back from the dresser (or worked out here, without one): into its slots, if it is still
  // wanted. Copying it in is a few hundred matrices, nothing a frame would notice.
  const apply = (d: Dressing, made: Made) => {
    if (state.gone || state.dressed.get(d.cavern) !== d) return;
    d.waiting = false;
    d.glows = made.glows;
    d.water = made.water;
    d.lava = made.lava;
    d.pond = made.pond;
    d.fire = made.fire;
    if (made.still) {
      stillLevel.set(d.cavern, made.still.level);
      stillSpread.set(d.cavern, made.still.spread);
    }
    fill(d, made.placed);
    built.water.write(d.slot, made.water?.sheet ?? []);
    built.lavas.write(d.slot, made.lava?.sheet ?? []);
    built.ponds.write(d.slot, made.pond?.sheet ?? []);
    placeFall(d.slot, d.shown ? made.water?.fall : undefined);
  };

  const group = useRef<THREE.Group>(null);
  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const eye = camera.position;
    const now = rockUniforms.time.value as number;
    // Behind the loader the engine draws everything hidden for a few frames, the pools and so the shared mirror too, so
    // its pipelines (a render of the whole scene into its own target) are built there rather than the first time a
    // pool comes into view underground. Its plane then lies at the ground under the eye, so that render takes in the
    // rock and the wood (about the default far below, it saw nothing and built nothing).
    const warming = scenePhase.current !== "live";
    // Nothing in a cavern is seen from the open air until one is broken into.
    if (group.current) group.current.visible = lamp.inside.value > 0.15 || world.opened.size > 0;
    // Once live, the pools are culled by their own bounds (until then every one is drawn, so all are built).
    if (state.live !== !warming) {
      state.live = !warming;
      for (const name of POOLS) for (const slot of built.pools[name]) for (const mesh of slot) mesh.frustumCulled = state.live;
    }
    // What a sealed cavern holds is hidden: nothing can see into it. (Set again every frame through the warm-up and a
    // little after, since the engine hides again whatever it unhid for its warm frames.)
    if (warming) state.settle = 10;
    const again = state.settle-- > 0;
    for (const d of state.dressed.values()) {
      const on = !d.waiting && !world.sealed(d.cavern);
      if (again || d.shown !== on) show(d, on);
    }
    // The mirror at the level of the nearest dressed cavern's pools that can be seen into.
    let best = Infinity;
    let seen = false;
    scratch.frustum.setFromProjectionMatrix(scratch.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const d of state.dressed.values()) {
      const level = stillLevel.get(d.cavern);
      if (level === undefined || !d.shown) continue;
      const far = scratch.v.set(...d.cavern.centre).distanceToSquared(eye);
      if (far < best) {
        best = far;
        mirrorLevel.value = level;
        seen = scratch.frustum.intersectsSphere(stillSpread.get(d.cavern) as THREE.Sphere);
      }
    }
    if (warming) mirrorLevel.value = eye.y - 1.7;
    built.mirror.target.position.set(eye.x, mirrorLevel.value, eye.z);
    // No pools near, no mirror drawn (it costs a second, smaller render of the scene). The puddles of caverns that
    // cannot be seen into stay hidden with their caverns.
    // (And only from underground: out in the daylight a pool deep in a dug cavern is never made out, and the mirror
    // would draw the whole forest again.)
    const mirrorOn = seen && best < 28 * 28 && (warming || lamp.inside.value > 0.15);
    for (const d of state.dressed.values()) for (const mesh of built.pools.puddle[d.slot]) mesh.visible = mirrorOn && !!d.shown && mesh.userData.placed > 0;
    // A few times a second: ask for the nearest undressed cavern in reach to be dressed (one at a time), letting go of
    // any left far behind, and of the furthest dressed when a nearer one needs its slot.
    state.check -= dt;
    if (state.check <= 0) {
      state.check = 0.25;
      const near = cavernsNear(eye.x - NEAR, eye.y - NEAR, eye.z - NEAR, eye.x + NEAR, eye.y + NEAR, eye.z + NEAR, 0, scratch.list).filter((c) => c.seed !== undefined);
      const away = (c: Cavern) => Math.max(0, cavernDistance(c, eye.x, eye.y, eye.z));
      for (const d of [...state.dressed.values()]) if (!near.includes(d.cavern) || away(d.cavern) > REACH + 6) release(d);
      // (Should the dresser never answer, worked out here after a few seconds.)
      for (const d of state.dressed.values()) if (d.waiting && now - d.asked > 4) apply(d, dress(d.cavern, world.rock));
      const waiting = [...state.dressed.values()].some((d) => d.waiting);
      const next = waiting
        ? undefined
        : near
            .filter((c) => !state.dressed.has(c) && away(c) < REACH)
            .map((c) => ({ c, far: away(c) }))
            .sort((a, b) => a.far - b.far)[0];
      if (next) {
        const kind = next.c.kind;
        const own = KIND_SLOTS[kind] !== undefined;
        // The furthest dressed holding what it needs gives it up, if it is clearly further.
        const furthest = (of: (d: Dressing) => boolean) => [...state.dressed.values()].filter(of).sort((a, b) => away(b.cavern) - away(a.cavern))[0];
        if (!state.free.length) {
          const f = furthest(() => true);
          if (f && away(f.cavern) > next.far + 3) release(f);
        }
        if (own && !state.kindFree[kind].length) {
          const f = furthest((d) => d.cavern.kind === kind);
          if (f && away(f.cavern) > next.far + 3) release(f);
        }
        if (state.free.length && (!own || state.kindFree[kind].length)) {
          const d: Dressing = { cavern: next.c, slot: state.free.pop() as number, kindSlot: own ? (state.kindFree[kind].pop() as number) : -1, glows: [], waiting: true, asked: now, shown: null };
          state.dressed.set(next.c, d);
          world
            .dress(next.c)
            .then((packed) => apply(d, packed ? unpack(packed) : dress(next.c, world.rock)))
            .catch(() => apply(d, dress(next.c, world.rock)));
        }
      }
    }

    // The nearest lights of all that is dressed, for the rock round them; each only once its cavern is open. A fire's
    // flickers.
    const glows = state.glowList;
    glows.length = 0;
    for (const d of state.dressed.values()) if (world.opened.has(d.cavern)) for (const g of d.glows) glows.push(g);
    glows.sort((a, b) => a.p.distanceToSquared(eye) - b.p.distanceToSquared(eye));
    const flame = (amount: number, k: number) => 1 + amount * (Math.sin(now * 11 + k * 1.7) * 0.5 + Math.sin(now * 17.3 + k) * 0.3 + Math.sin(now * 4.1 + k * 2.3) * 0.2);
    for (let k = 0; k < nearGlow.count; k++) {
      const g = glows[k];
      const flicker = g ? flame(g.flicker ?? 0, k) : 1;
      (nearGlow.place.array[k] as THREE.Vector4).set(g ? g.p.x : 0, g ? g.p.y : -1000, g ? g.p.z : 0, g ? g.strength * flicker : 0);
      (nearGlow.colour.array[k] as THREE.Color).copy(g ? g.colour : scratch.black);
    }

    // The nearest open fire: its light on the camp round it, heat rising off it, and its crackle as you come near.
    let fire: THREE.Vector3 | undefined;
    for (const d of state.dressed.values()) if (d.fire && world.opened.has(d.cavern) && (!fire || d.fire.distanceToSquared(eye) < fire.distanceToSquared(eye))) fire = d.fire;
    const fireValue = fireLight.value as THREE.Vector4;
    if (fire) {
      fireValue.set(fire.x, fire.y, fire.z, 1.5 * flame(0.25, 0));
      const near = 1 - Math.min(1, fire.distanceTo(eye) / 11);
      state.crackleAt -= dt;
      if (near > 0 && state.crackleAt <= 0) {
        state.crackleAt = 0.06 + Math.random() * 0.35;
        crackle(near * near * 0.8);
      }
      if (built.random() < dt * 5)
        emit(
          scratch.at.copy(fire).add(scratch.off.set((built.random() - 0.5) * 0.3, 0.35, (built.random() - 0.5) * 0.3)),
          scratch.off.set((built.random() - 0.5) * 0.15, 0.5 + built.random() * 0.4, (built.random() - 0.5) * 0.15),
          0.2 + built.random() * 0.2,
          1
        );
    } else fireValue.set(0, -1000, 0, 0);

    // Mist at the foot of the falls, heat over the lava; and the river heard through the rock as you come near.
    let roar = 0;
    for (const d of state.dressed.values()) {
      const fall = d.water?.fall;
      if (fall) {
        const foot = fall.foot;
        // Heard only once its cavern is open. (At full strength from 30 m through solid rock it read as a loud wind, then
        // as static over the forest, the owner, 27 Nov.)
        const open = world.opened.has(d.cavern);
        if (open) roar = Math.max(roar, 1 - Math.min(1, foot.distanceTo(eye) / 24));
        // Mist boiling up off the foot, and drifting off the lower part of the sheet.
        if (world.opened.has(d.cavern) && built.random() < dt * 40) {
          const high = built.random() < 0.3 ? built.random() * fall.height * 0.4 : 0;
          emit(
            scratch.at.copy(foot).add(scratch.off.set((built.random() - 0.5) * fall.width * 1.2, 0.15 + high, (built.random() - 0.5) * 1.2)),
            scratch.off.set((built.random() - 0.5) * 0.7, 0.25 + built.random() * 0.5, (built.random() - 0.5) * 0.7),
            0.4 + built.random() * 0.8,
            0
          );
        }
      }
      if (d.lava && world.opened.has(d.cavern) && built.random() < dt * 14) {
        const c = d.cavern;
        emit(
          scratch.at.set(c.centre[0] + (built.random() - 0.5) * c.size[0] * 1.6, d.lava.level + 0.2, c.centre[2] + (built.random() - 0.5) * c.size[2]),
          scratch.off.set(0, 0.5 + built.random() * 0.5, 0),
          0.4 + built.random() * 0.6,
          1
        );
      }
    }
    rushing(roar);
    // (Sent to the GPU only while there is mist, and once more as the last puff goes.)
    const { puffs, mistData, mistLook } = built;
    let alive = 0;
    for (let k = 0; k < puffs.length; k++) {
      const w = puffs[k];
      const i = k * 4;
      if (w.age >= w.life) {
        mistLook[i] = 0;
        mistData[i + 3] = 0;
        continue;
      }
      alive++;
      w.age += dt;
      w.v.multiplyScalar(Math.exp(-dt * 0.8));
      w.p.addScaledVector(w.v, dt);
      w.size += dt * 0.3;
      mistData[i] = w.p.x;
      mistData[i + 1] = w.p.y;
      mistData[i + 2] = w.p.z;
      mistData[i + 3] = w.size;
      mistLook[i] = Math.sin(Math.PI * Math.min(1, w.age / w.life));
      mistLook[i + 1] = w.hot;
    }
    if (alive || state.misty) {
      built.mistAttribute.needsUpdate = true;
      built.mistLookAttribute.needsUpdate = true;
    }
    state.misty = alive > 0;
  });

  // A slot's fall and its spray put in place, or taken away.
  const placeFall = (slot: number, fall?: Fall) => {
    built.falls.setMatrixAt(slot, fall ? new THREE.Matrix4().compose(fall.lip, fall.turn, new THREE.Vector3(fall.width, fall.height, 0.55)) : built.hidden);
    built.falls.instanceMatrix.needsUpdate = true;
    built.fallLook.set(fall ? [fall.width, fall.height, slot * 3.7, fall.wet ? 1 : 0] : [0, 0, 0, 0], slot * 4);
    built.fallLookAttribute.needsUpdate = true;
    for (let k = 0; k < SPLASH; k++) built.splashData.set(fall ? [fall.foot.x, fall.foot.y, fall.foot.z, 1] : [0, -1000, 0, 0], (slot * SPLASH + k) * 4);
    built.splashAttribute.needsUpdate = true;
  };

  const emit = (p: THREE.Vector3, v: THREE.Vector3, size: number, hot: number) => {
    const w = built.puffs[built.next++ % built.puffs.length];
    w.p.copy(p);
    w.v.copy(v);
    w.age = 0;
    w.life = 2 + built.random() * 2.5;
    w.size = size;
    w.hot = hot;
  };

  return (
    <group ref={group}>
      {Object.values(built.pools)
        .flat(2)
        .map((mesh, k) => (
          <primitive key={k} object={mesh} />
        ))}
      <primitive object={built.mirror.target} />
      <primitive object={built.stream} />
      <primitive object={built.falls} />
      <primitive object={built.veils} />
      <primitive object={built.lava} />
      <primitive object={built.pond} />
      <primitive object={built.mists} />
      <primitive object={built.splashes} />
      <TorchHaze on={tier !== "low"} />
    </group>
  );
}

// A boolean node as 0 or 1.
const step01 = (b: any) => (b as any).select(float(1), float(0)) as any;
