"use client";

// The kitchen round the plate, lit as Pendulum's studio is: a bright day, the sky's fill doing most of it, the sun
// coming in through a tall window on the left and laying the window across the counter, its beams showing in the air
// with dust drifting through them. The plate stands on the counter along the back wall, in front of the microwave
// (props.tsx): polished marble that mirrors the room, white cabinets under it, a window over the sink, a kettle, jars
// and a plant. Built once at load from boxes, lathes and a few textures; nothing changes per frame but the dust and the
// beams' stir.

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  mx_fractal_noise_float,
  dot,
  bumpMap,
  cameraFar,
  cameraNear,
  cameraPosition,
  color,
  cross,
  exp,
  float,
  Fn,
  fract,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  normalWorld,
  reflector,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  positionWorld,
  screenUV,
  sin,
  smoothstep,
  step,
  texture,
  time,
  uniform,
  uv,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "../shared/engine/Post";
import { lehmer } from "../shared/engine/random";
import { loadRetried, suspendRetried } from "../shared/engine/retry";
import { BACKSPLASH_Z, COUNTER, MIRROR_LAYER } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// One unit is 25 cm. The counter's top is at COUNTER; the floor 90 cm below it.
const FLOOR = COUNTER - 3.6;
// The room: the back wall behind the table, the left wall with the tall window the sun comes in by.
const BACK = BACKSPLASH_Z;
const LEFT = -6.6;
const RIGHT = 8;
const FRONT = 9.3;
const HEIGHT = 10.4;
// The left window: along the wall from z0 to z1, sill to head (heights over the floor), in panes.
export const WINDOW = { z0: -1.3, z1: 2.9, sill: FLOOR + 3.6, head: FLOOR + 9.6, cols: 2, rows: 3 };
// The window over the sink, in the back wall.
const BACK_WINDOW = { x0: -4.2, x1: -0.6, sill: FLOOR + 4.4, head: FLOOR + 9.2 };
// The sun: low enough in the afternoon to come in across the table from the left and behind.
export const SUN: [number, number, number] = [-16, 8, 2.6];
const SUN_COLOUR = new THREE.Color("#fff0d8");
const SUN_DIR = vec3(...new THREE.Vector3(...SUN).normalize().toArray());

const MARBLE = ["/assets/23-magma/marble012_color_2k.jpg", "/assets/23-magma/marble012_rough_2k.jpg"];
const OAK = ["/assets/23-magma/oak_veneer_05_diff_2k.jpg", "/assets/23-magma/oak_veneer_05_nor_gl_2k.jpg", "/assets/23-magma/oak_veneer_05_rough_2k.jpg"];

// Pale Danish oak: the scan lightened and warmed, a soft satin finish.
function oak(diffuse: THREE.Texture, normal: THREE.Texture, rough: THREE.Texture, repeat: number, lift = 1) {
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const scale = positionWorld.xz.div(repeat) as any;
  const grain = texture(diffuse, scale).rgb as any;
  // Lifted toward a pale tan and partly desaturated, so it reads as light Danish oak rather than orange.
  const lifted = grain.mul(vec3(1.3, 1.22, 1.08).mul(lift)) as any;
  const grey = lifted.dot(vec3(0.3, 0.55, 0.15)) as any;
  m.colorNode = mix(lifted, vec3(grey).mul(vec3(1.06, 1.0, 0.9)), 0.35).min(vec3(0.95)) as any;
  m.normalMap = normal;
  m.normalScale = new THREE.Vector2(0.4, 0.4);
  m.roughnessNode = texture(rough, scale).r.mul(0.3).add(0.42) as any;
  return m;
}

// The countertop's slab: 4 cm thick, its front edge a full bullnose, the plate in its middle. Drawn as a section in the
// z-y plane run out along x, so the rounded edge is true geometry.
const SLAB = { x0: LEFT + 0.05, x1: RIGHT - 0.05, back: BACK, front: BACK + 3, thick: 0.16 };

function slabGeometry() {
  const r = SLAB.thick / 2;
  const shape = new THREE.Shape();
  // Section coordinates (u, v) are (-z, y): the extrusion is turned a quarter about y below, which maps u to -z.
  shape.moveTo(-SLAB.back, COUNTER - SLAB.thick);
  shape.lineTo(-SLAB.front + r, COUNTER - SLAB.thick);
  shape.absarc(-SLAB.front + r, COUNTER - r, r, -Math.PI / 2, -Math.PI * 1.5, true);
  shape.lineTo(-SLAB.back, COUNTER);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: SLAB.x1 - SLAB.x0, bevelEnabled: false, curveSegments: 16 });
  g.rotateY(Math.PI / 2);
  g.translate(SLAB.x0, 0, 0);
  g.computeVertexNormals();
  return g;
}

// Polished stone: the scan's cream marble with its grey veins, a fine granite fleck through it (dark grains and a
// little warm mica), nearly mirror-smooth with a faint variation from the scan's roughness. Mapped by world position,
// the top from above and the bullnose from the front, so the veins run on over the edge. On High the planar mirror's
// view of the plate, the pocket and the lava's glow is laid over the room's reflection, strongest at a slant.
function marble(colour: THREE.Texture, rough: THREE.Texture, mirror: any) {
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const onTop = smoothstep(0.5, 0.8, normalWorld.y) as any;
  const at = mix(positionWorld.xy, positionWorld.xz, onTop).div(4) as any;
  const base = mix(texture(colour, at).rgb, vec3(0.93, 0.9, 0.84), 0.35).mul(vec3(1.06, 1.03, 0.96)) as any;
  const p = positionWorld.mul(150) as any;
  const grains = smoothstep(0.42, 0.55, mx_noise_float(p)) as any;
  const mica = smoothstep(0.5, 0.6, mx_noise_float(p.add(31.7))) as any;
  m.colorNode = mix(mix(base, vec3(0.3, 0.29, 0.28), grains.mul(0.4)), vec3(0.86, 0.74, 0.55), mica.mul(0.35)) as any;
  m.roughnessNode = texture(rough, at).r.mul(0.12).add(0.05) as any;
  if (mirror) {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const fresnel = float(1).sub(max(V.y, 0)).pow(5).mul(0.85).add(0.05) as any;
    m.emissiveNode = mirror.level(0.6).rgb.mul(fresnel).mul(onTop) as any;
  }
  return m;
}

export function Kitchen({ mirror = false, sharp = false }: { mirror?: boolean; sharp?: boolean }) {
  // Loaded with retries, so one dropped request never stops the day.
  const urls = [...OAK, ...MARBLE];
  const [diffuse, normal, rough, stone, stoneRough] = suspendRetried(() => Promise.all(urls.map((url) => loadRetried(new THREE.TextureLoader(), url))), ["magma-kitchen", ...urls]);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((state) => state.scene);
  const parts = useMemo(() => {
    for (const t of [diffuse, normal, rough, stone, stoneRough]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
    }
    diffuse.colorSpace = stone.colorSpace = THREE.SRGBColorSpace;
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const keep = <T extends THREE.Material>(m: T) => (materials.push(m), m);
    const block = (material: THREE.Material, size: [number, number, number], at: [number, number, number], shadow = true) => {
      const g = new THREE.BoxGeometry(...size);
      geometries.push(g);
      const mesh = new THREE.Mesh(g, material);
      mesh.position.set(...at);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    const plain = (hex: string, roughness = 0.85) => keep(new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(hex), roughness, metalness: 0 }));

    // The countertop: a polished marble slab with a bullnose front edge.
    const reflection = mirror ? (reflector({ resolutionScale: 0.3, generateMipmaps: true, bounces: false }) as any) : null;
    if (reflection) {
      reflection.target.rotateX(-Math.PI / 2);
      reflection.target.position.y = COUNTER;
      group.add(reflection.target);
      if (process.env.NODE_ENV !== "production") (globalThis as any).__magmaMirror = reflection;
    }
    const slab = new THREE.Mesh(slabGeometry(), keep(marble(stone, stoneRough, reflection)));
    geometries.push(slab.geometry);
    slab.receiveShadow = true;
    slab.castShadow = true;
    group.add(slab);
    // The floor, oak too, a little darker, mostly unseen.
    block(keep(oak(diffuse, normal, rough, 3, 0.9)), [RIGHT - LEFT, 0.1, FRONT - BACK], [(LEFT + RIGHT) / 2, FLOOR - 0.05, (BACK + FRONT) / 2], false);

    // Walls: soft off-white plaster, the left one built round its window so the sun only comes in through it.
    const plaster = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.92 }));
    plaster.colorNode = color("#e9e4db").mul(mx_noise_float(positionWorld.mul(0.8)).mul(0.04).add(0.97)) as any;
    plaster.normalNode = bumpMap(mx_fractal_noise_float(positionWorld.mul(6)), float(0.25)) as any;
    const T = 0.3;
    const W = WINDOW;
    block(plaster, [T, W.sill - FLOOR, FRONT - BACK], [LEFT - T / 2, (W.sill + FLOOR) / 2, (BACK + FRONT) / 2]);
    block(plaster, [T, FLOOR + HEIGHT - W.head, FRONT - BACK], [LEFT - T / 2, (W.head + FLOOR + HEIGHT) / 2, (BACK + FRONT) / 2]);
    block(plaster, [T, W.head - W.sill, W.z0 - BACK], [LEFT - T / 2, (W.sill + W.head) / 2, (BACK + W.z0) / 2]);
    block(plaster, [T, W.head - W.sill, FRONT - W.z1], [LEFT - T / 2, (W.sill + W.head) / 2, (W.z1 + FRONT) / 2]);
    // The back wall, round the window over the sink.
    const B = BACK_WINDOW;
    block(plaster, [RIGHT - LEFT, B.sill - FLOOR, T], [(LEFT + RIGHT) / 2, (B.sill + FLOOR) / 2, BACK - T / 2]);
    block(plaster, [RIGHT - LEFT, FLOOR + HEIGHT - B.head, T], [(LEFT + RIGHT) / 2, (B.head + FLOOR + HEIGHT) / 2, BACK - T / 2]);
    block(plaster, [B.x0 - LEFT, B.head - B.sill, T], [(LEFT + B.x0) / 2, (B.sill + B.head) / 2, BACK - T / 2]);
    block(plaster, [RIGHT - B.x1, B.head - B.sill, T], [(B.x1 + RIGHT) / 2, (B.sill + B.head) / 2, BACK - T / 2]);
    // The right wall and the front wall, so the room is whole from every side the view can turn to; a doorway and a
    // framed print on the front wall, a shelf of cookbooks on the right.
    block(plaster, [T, HEIGHT, FRONT - BACK], [RIGHT + T / 2, FLOOR + HEIGHT / 2, (BACK + FRONT) / 2]);
    block(plaster, [RIGHT - LEFT, HEIGHT, T], [(LEFT + RIGHT) / 2, FLOOR + HEIGHT / 2, FRONT + T / 2]);
    const doorway = plain("#5d5148", 0.7);
    block(doorway, [3.2, 8.2, 0.1], [4.2, FLOOR + 4.1, FRONT - 0.05], false);
    block(plain("#2f2c29", 0.6), [3.0, 2.2, 0.08], [-2.4, FLOOR + 6.4, FRONT - 0.04], false);
    block(plain("#d8c9a8", 0.85), [2.6, 1.8, 0.09], [-2.4, FLOOR + 6.4, FRONT - 0.05], false);
    block(keep(oak(diffuse, normal, rough, 1.6, 0.95)), [1.0, 0.12, 3.6], [RIGHT - 0.5, FLOOR + 6.2, -1.2]);
    const spines = ["#8a3b2b", "#2e4a5e", "#c7a64a", "#3f5d3a", "#d9d2c4", "#6b4a6e"];
    spines.forEach((hex, n) => block(plain(hex, 0.8), [0.8, 0.9 + (n % 3) * 0.12, 0.28], [RIGHT - 0.55, FLOOR + 6.26 + (0.9 + (n % 3) * 0.12) / 2, -2.6 + n * 0.32]));
    // A ceiling, so the sun only comes in by the windows.
    block(plaster, [RIGHT - LEFT, T, FRONT - BACK], [(LEFT + RIGHT) / 2, FLOOR + HEIGHT + T / 2, (BACK + FRONT) / 2]);

    // The windows: slim white frames and glazing bars, and the bright day beyond (sky and a soft garden green, far out of
    // focus), lit from within so it glows.
    const frame = plain("#f4f2ee", 0.5);
    const bar = 0.07;
    for (let c = 0; c <= W.cols; c++) block(frame, [0.12, W.head - W.sill, bar], [LEFT, (W.sill + W.head) / 2, W.z0 + ((W.z1 - W.z0) * c) / W.cols]);
    for (let r = 0; r <= W.rows; r++) block(frame, [0.12, bar, W.z1 - W.z0], [LEFT, W.sill + ((W.head - W.sill) * r) / W.rows, (W.z0 + W.z1) / 2]);
    block(frame, [B.x1 - B.x0, bar, 0.12], [(B.x0 + B.x1) / 2, (B.sill + B.head) / 2, BACK - 0.1]);
    block(frame, [bar, B.head - B.sill, 0.12], [(B.x0 + B.x1) / 2, (B.sill + B.head) / 2, BACK - 0.1]);
    const day = keep(new THREE.MeshBasicNodeMaterial({ toneMapped: true }));
    const up = smoothstep(FLOOR + 2, FLOOR + 10, positionWorld.y) as any;
    const garden = mix(vec3(0.62, 0.72, 0.5), vec3(0.85, 0.9, 0.78), mx_noise_float(positionWorld.mul(0.6)).mul(0.5).add(0.5)) as any;
    day.colorNode = mix(garden, vec3(0.92, 0.96, 1.0), up).mul(1.8) as any;
    const outside = (w: number, h: number, at: [number, number, number], turn: number) => {
      const g = new THREE.PlaneGeometry(w, h);
      geometries.push(g);
      const mesh = new THREE.Mesh(g, day);
      mesh.position.set(...at);
      mesh.rotation.y = turn;
      group.add(mesh);
    };
    outside(12, 9, [LEFT - 2.5, (W.sill + W.head) / 2, (W.z0 + W.z1) / 2], Math.PI / 2);
    outside(9, 8, [(B.x0 + B.x1) / 2, (B.sill + B.head) / 2, BACK - 2.5], 0);

    // The kitchen run along the back wall: white flat-fronted cabinets under the marble, a white tiled splashback, upper
    // cabinets to the right of the window.
    // Painted cabinets: a soft eggshell, the brush's faint grain running down the doors, and a bevelled groove round
    // each door that catches the light.
    const cabinet = keep(new THREE.MeshStandardNodeMaterial({ metalness: 0 }));
    const wp = positionWorld as any;
    const doorU = fract(wp.x.sub(LEFT + 0.4).div(2.4)) as any;
    const groove = smoothstep(0.02, 0.0, doorU).add(smoothstep(0.98, 1, doorU)) as any;
    const brush = mx_noise_float(vec3(wp.x.mul(40), wp.y.mul(2), wp.z.mul(40)))
      .mul(0.5)
      .add(mx_noise_float(wp.mul(6)).mul(0.5)) as any;
    cabinet.colorNode = mix(color("#eeebe4"), color("#dcd7cc"), groove.min(1)).mul(brush.mul(0.025).add(0.99)) as any;
    cabinet.roughnessNode = brush.mul(0.08).add(0.5) as any;
    cabinet.normalNode = bumpMap(brush.mul(0.15).sub(groove.min(1).mul(0.6)), float(0.6)) as any;
    const top = COUNTER;
    const deep = SLAB.front - SLAB.back - 0.1;
    block(cabinet, [RIGHT - LEFT - 0.6, top - FLOOR - 0.16, deep - 0.1], [(LEFT + RIGHT) / 2 + 0.3, (FLOOR + top - 0.16) / 2, BACK + deep / 2]);
    // Door seams: thin dark lines down the cabinets.
    const seam = plain("#c9c5bd", 0.7);
    for (let x = LEFT + 1.6; x < RIGHT - 0.5; x += 2.4) block(seam, [0.025, top - FLOOR - 0.4, 0.02], [x, (FLOOR + top) / 2 - 0.1, BACK + deep + 0.01], false);
    // Glazed tiles: glossy, each a little uneven, the grout sunk between them.
    const tiles = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.18 }));
    const tx = fract(positionWorld.x.div(0.6)) as any;
    const ty = fract(positionWorld.y.div(0.3)) as any;
    const grout = max(smoothstep(0.04, 0, tx).add(smoothstep(0.96, 1, tx)), smoothstep(0.08, 0, ty).add(smoothstep(0.92, 1, ty))) as any;
    const tileWobble = mx_noise_float(vec3(positionWorld.x.div(0.6).floor(), positionWorld.y.div(0.3).floor(), 3)).mul(0.03) as any;
    tiles.colorNode = mix(color("#f4f1ea").mul(tileWobble.add(0.98)), color("#cfc8bb"), grout.min(1)) as any;
    tiles.normalNode = bumpMap(
      grout
        .min(1)
        .negate()
        .add(mx_noise_float(positionWorld.mul(9)).mul(0.08)),
      float(0.8)
    ) as any;
    tiles.roughnessNode = mix(float(0.15), float(0.8), grout.min(1)) as any;
    block(tiles, [RIGHT - B.x1 - 0.3, B.sill - top + 1.2, 0.04], [(B.x1 + RIGHT) / 2, top + (B.sill - top + 1.2) / 2, BACK + 0.03], false);
    // And under the window, from the left wall to it.
    block(tiles, [B.x1 - LEFT, B.sill - top, 0.04], [(LEFT + B.x1) / 2, top + (B.sill - top) / 2, BACK + 0.03], false);
    block(cabinet, [RIGHT - B.x1 - 1.2, 3.2, 1.4], [(B.x1 + 0.6 + RIGHT) / 2, B.head - 1.2, BACK + 0.7]);

    // A kettle, jars, a bowl and a plant along the counter (the microwave behind the plate is props.tsx's).
    const steel = keep(new THREE.MeshStandardNodeMaterial({ color: new THREE.Color("#2b2c2e"), roughness: 0.35, metalness: 0.6 }));
    const white = plain("#f3f2ee", 0.45);
    const lathe = (material: THREE.Material, profile: [number, number][], at: [number, number, number]) => {
      const g = new THREE.LatheGeometry(
        profile.map(([r, y]) => new THREE.Vector2(r, y)),
        40
      );
      geometries.push(g);
      const m = new THREE.Mesh(g, material);
      m.position.set(...at);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
      return m;
    };
    // A white kettle with a dark lid knob.
    lathe(
      white,
      [
        [0.001, 0],
        [0.48, 0],
        [0.55, 0.15],
        [0.56, 0.6],
        [0.48, 1.0],
        [0.3, 1.15],
        [0.001, 1.16]
      ],
      [4.4, top, BACK + 0.9]
    );
    lathe(
      steel,
      [
        [0.001, 1.15],
        [0.1, 1.15],
        [0.1, 1.27],
        [0.001, 1.28]
      ],
      [4.4, top, BACK + 0.9]
    );
    // Glass-like storage jars with pale contents.
    const jar = plain("#e7dcc4", 0.4);
    lathe(
      jar,
      [
        [0.001, 0],
        [0.32, 0],
        [0.33, 0.9],
        [0.28, 0.95],
        [0.001, 0.96]
      ],
      [6.2, top, BACK + 0.7]
    );
    lathe(
      jar,
      [
        [0.001, 0],
        [0.26, 0],
        [0.27, 0.7],
        [0.22, 0.75],
        [0.001, 0.76]
      ],
      [6.9, top, BACK + 0.8]
    );
    lathe(
      plain("#b9b2a5", 0.6),
      [
        [0.001, 0.96],
        [0.3, 0.96],
        [0.3, 1.02],
        [0.001, 1.03]
      ],
      [6.2, top, BACK + 0.7]
    );
    // A terracotta pot with a leafy plant, on the sill.
    lathe(
      plain("#b8714e", 0.8),
      [
        [0.001, 0],
        [0.32, 0],
        [0.42, 0.62],
        [0.001, 0.63]
      ],
      [-2.0, B.sill, BACK + 0.35]
    );
    const leaf = plain("#5d7a46", 0.7);
    const random = lehmer(311);
    const leafGeometry = new THREE.SphereGeometry(1, 10, 6).scale(0.08, 0.22, 0.03);
    geometries.push(leafGeometry);
    const leaves = new THREE.InstancedMesh(leafGeometry, leaf, 46);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 46; i++) {
      const a = random() * Math.PI * 2;
      const r = 0.05 + random() * 0.32;
      const h = 0.65 + random() * 0.7;
      m.compose(
        new THREE.Vector3(-2.0 + Math.cos(a) * r, B.sill + h, BACK + 0.35 + Math.sin(a) * r),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(random() - 0.5, a, (random() - 0.5) * 1.4)),
        new THREE.Vector3(1, 1, 1)
      );
      leaves.setMatrixAt(i, m);
    }
    leaves.castShadow = true;
    group.add(leaves);
    // A bowl of lemons and an orange, an olive-oil bottle, a pepper mill and a stoneware mug.
    const glaze = plain("#e4ddd0", 0.35);
    lathe(
      glaze,
      [
        [0.001, 0],
        [0.5, 0],
        [0.85, 0.32],
        [0.95, 0.45],
        [0.9, 0.45],
        [0.8, 0.34],
        [0.001, 0.08]
      ],
      [-4.6, top, BACK + 1.0]
    );
    const fruitGeometry = new THREE.SphereGeometry(1, 20, 14);
    geometries.push(fruitGeometry);
    const lemon = plain("#e8c53a", 0.45);
    const orange = plain("#e0782a", 0.5);
    for (const [x, y, z, r, m] of [
      [-4.75, 0.4, 0.95, 0.28, lemon],
      [-4.4, 0.42, 1.12, 0.27, lemon],
      [-4.55, 0.62, 1.0, 0.3, orange],
      [-4.95, 0.42, 1.2, 0.26, lemon]
    ] as [number, number, number, number, THREE.Material][]) {
      const fruit = new THREE.Mesh(fruitGeometry, m);
      fruit.scale.set(r, r * 0.92, r);
      fruit.position.set(x, top + y, BACK + z);
      fruit.castShadow = fruit.receiveShadow = true;
      group.add(fruit);
    }
    lathe(
      plain("#4b5a2a", 0.25),
      [
        [0.001, 0],
        [0.28, 0],
        [0.3, 1.2],
        [0.12, 1.6],
        [0.1, 2.0],
        [0.001, 2.01]
      ],
      [-2.6, top, BACK + 0.8]
    );
    lathe(
      keep(oak(diffuse, normal, rough, 0.6, 0.7)),
      [
        [0.001, 0],
        [0.16, 0],
        [0.18, 0.3],
        [0.13, 0.9],
        [0.17, 1.1],
        [0.001, 1.2]
      ],
      [-2.0, top, BACK + 1.2]
    );
    lathe(
      plain("#3f4a52", 0.55),
      [
        [0.001, 0],
        [0.26, 0],
        [0.3, 0.75],
        [0.27, 0.75],
        [0.24, 0.06],
        [0.001, 0.06]
      ],
      [3.4, COUNTER, -1.6]
    );
    // A linen tea towel folded on the counter's far corner, and a wooden board leaning on the splashback.
    block(plain("#d9d2c4", 0.95), [1.6, 0.05, 1.1], [-4.6, COUNTER + 0.025, -1.4]);
    block(keep(oak(diffuse, normal, rough, 1.4, 0.95)), [1.8, 2.4, 0.12], [2.9, top + 1.2, BACK + 0.3]).rotation.x = -0.18;

    // Light: the sky's fill does most of it; the sun through the left window lays it across the table, with soft
    // shadows from the window bars.
    // Contrast as in a sunny room: a cooler, weaker fill in the shade, a warm strong sun.
    group.add(new THREE.HemisphereLight("#dfe7f2", "#c9b9a6", 0.45));
    const sun = new THREE.DirectionalLight("#ffdcae", 4.6);
    sun.position.set(...SUN);
    sun.target.position.set(0, 0, -0.5);
    sun.castShadow = true;
    // Its shadows only over what the view can hold, the plate and the counter round it, about 3 m across: over 18 m (as
    // it was) a texel was 9 mm, coarser than a pizza roll's edge, and the rolls and the pocket barely shaded the plate.
    // Now about a millimetre (sharp: 4096 on High), and a contact shadow under everything that lies on the plate.
    sun.shadow.mapSize.set(sharp ? 4096 : 2048, sharp ? 4096 : 2048);
    const c = sun.shadow.camera;
    c.left = c.bottom = -1.5;
    c.right = c.top = 1.5;
    c.near = 1;
    c.far = 50;
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.002;
    sun.shadow.radius = 5;
    group.add(sun, sun.target);
    // The lava's own light: placed and brightened each frame.
    const lava = new THREE.PointLight(new THREE.Color("#ffa24a"), 0, 2, 2);
    lava.name = "lava-light";
    group.add(lava);
    return { group, geometries, materials, reflection };
  }, [diffuse, normal, rough, stone, stoneRough, mirror, sharp]);
  useDispose(...parts.geometries, ...parts.materials);
  // The mirror's camera sees only the plate and what is on it (MIRROR_LAYER).
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    if (!parts.reflection) return;
    parts.reflection.reflector.getVirtualCamera(camera).layers.set(MIRROR_LAYER);
  }, [parts, camera]);

  // The room's own light for everything to reflect: the kitchen captured once into a cube from just over the plate,
  // blurred into a PMREM, when it mounts. Only the room: the pocket, the plate and the lava are left out of the capture.
  useEffect(() => {
    const parent = parts.group.parent;
    if (!parent) return;
    const room = new THREE.Scene();
    room.add(parts.group);
    const generator = new THREE.PMREMGenerator(gl as any);
    const target = generator.fromScene(room, 0.01, 0.1, 40, { size: 256, position: new THREE.Vector3(0, COUNTER + 0.9, 0.3) } as any);
    parent.add(parts.group);
    scene.environment = target.texture;
    scene.environmentIntensity = 0.4;
    (window as any).__magmaEnv = target;
    return () => {
      if (scene.environment === target.texture) scene.environment = null;
      target.dispose();
      generator.dispose();
    };
  }, [parts, gl, scene]);
  return <primitive object={parts.group} />;
}

// The sun's beams through the left window, seen in the air, and dust drifting through the room that glints where it
// crosses one: Pendulum's window light, for this room. Each beam is a slanted box; each pixel of it is lit by how far the
// eye's line runs through it (cut short by the scene's depth), soft at the window's edges, with the glazing bars as
// gaps, fading as it leaves the window. Drawn in the overlay pass, after the lens blur.
const LONG = 26;

function beams() {
  const down = new THREE.Vector3(...SUN).negate().normalize();
  const W = WINDOW;
  const corner = new THREE.Vector3(LEFT, W.sill, W.z0);
  const across = new THREE.Vector3(0, 0, W.z1 - W.z0);
  const up = new THREE.Vector3(0, W.head - W.sill, 0);
  const along = down.clone().multiplyScalar(LONG);
  const toBox = new THREE.Matrix4().makeBasis(across, up, along).setPosition(corner);
  return [{ toBox, fromBox: toBox.clone().invert() }];
}

const inBox = (fromBox: any, p: any) => fromBox.mul(vec4(p, 1)).xyz as any;

export function WindowLight({ dust }: { dust: number }) {
  const parts = useMemo(() => {
    const list = beams();
    const fromBoxes = list.map((b) => uniform(b.fromBox));
    const geometries: THREE.BufferGeometry[] = [];
    const draw = () => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
      // Nothing until the overlay's depth is in and the shading built: never a bare white quad.
      m.colorNode = vec4(0, 0, 0, 0);
      return m;
    };
    const beamMaterials = list.map(() => {
      const m = draw();
      m.side = THREE.BackSide;
      return m;
    });
    const meshes = list.map((b, n) => {
      const g = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5).applyMatrix4(b.toBox);
      geometries.push(g);
      const mesh = new THREE.Mesh(g, beamMaterials[n]);
      mesh.layers.set(OVERLAY_LAYER);
      mesh.frustumCulled = false;
      return mesh;
    });
    const random = lehmer(9187);
    const seeds = new Float32Array(dust * 4);
    for (let i = 0; i < dust; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    geometries.push(quad);
    const dustMaterial = draw();
    dustMaterial.positionNode = vec3(0, -1000, 0);
    const specks = new THREE.InstancedMesh(quad, dustMaterial, dust);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < dust; i++) specks.setMatrixAt(i, identity);
    specks.frustumCulled = false;
    specks.layers.set(OVERLAY_LAYER);
    return { fromBoxes, meshes, beamMaterials, dustMaterial, specks, geometries };
  }, [dust]);
  useDispose(...parts.geometries, ...parts.beamMaterials, parts.dustMaterial);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const t = time as any;
        parts.beamMaterials.forEach((material, n) => {
          const fromBox = parts.fromBoxes[n] as any;
          material.colorNode = Fn(() => {
            const dir = normalize(positionWorld.sub(cameraPosition)) as any;
            const o = inBox(fromBox, cameraPosition) as any;
            const d = fromBox.mul(vec4(dir, 0)).xyz as any;
            const safe = d.sign().mul(d.abs().max(1e-5)) as any;
            const t0 = o.negate().div(safe) as any;
            const t1 = float(1).sub(o).div(safe) as any;
            const near = min(t0, t1) as any;
            const far = max(t0, t1) as any;
            const into = max(max(near.x, near.y), max(near.z, 0)) as any;
            const stop = sceneZ.div(normalize(positionView).z) as any;
            const out = min(min(far.x, far.y), min(far.z, stop)) as any;
            const length = max(out.sub(into), 0) as any;
            const mid = o.add(d.mul(into.add(out).mul(0.5))) as any;
            const edges = smoothstep(0, 0.08, mid.x)
              .mul(float(1).sub(smoothstep(0.92, 1, mid.x)))
              .mul(smoothstep(0, 0.05, mid.y))
              .mul(float(1).sub(smoothstep(0.95, 1, mid.y))) as any;
            const leaving = exp(mid.z.mul(-2.2)).mul(smoothstep(0, 0.04, mid.z)) as any;
            const barU = fract(mid.x.mul(WINDOW.cols)) as any;
            const barV = fract(mid.y.mul(WINDOW.rows)) as any;
            const bars = smoothstep(0.0, 0.035, min(barU, float(1).sub(barU))).mul(smoothstep(0.0, 0.045, min(barV, float(1).sub(barV)))) as any;
            const atWorld = cameraPosition.add(dir.mul(into.add(out).mul(0.5))) as any;
            const stir = mx_noise_float(atWorld.mul(0.4).add(vec3(t.mul(0.05), t.mul(-0.03), 0)))
              .mul(0.25)
              .add(0.9) as any;
            // In these units a beam is four times as long as Pendulum's: its glow per unit is a quarter.
            // Looked at along the beam, its whole length piles up into a glare: fade it by how nearly the eye looks along it.
            const along = abs(dot(dir, SUN_DIR)) as any;
            const sideOn = float(1).sub(smoothstep(0.55, 0.95, along).mul(0.8)) as any;
            const glow = length.mul(edges).mul(leaving).mul(bars.mul(0.7).add(0.3)).mul(stir).mul(0.04).mul(sideOn) as any;
            return vec4(color(SUN_COLOUR).mul(glow.min(0.6)), 1);
          })() as any;
          material.needsUpdate = true;
        });

        // Dust: specks wandering slowly in the room's left half where the light comes in, glinting in the beam; about
        // one in seven kept near the lens, floating past as big soft blooms.
        const s = attribute("aSeed", "vec4") as any;
        const lo = vec3(LEFT + 0.3, COUNTER, -4.5) as any;
        const size = vec3(9, 5, 6) as any;
        const drift = vec3(sin(t.mul(0.07).add(s.w.mul(40))).mul(0.3), t.mul(-0.02).mul(s.w.add(0.5)), sin(t.mul(0.05).add(s.x.mul(31))).mul(0.3)) as any;
        const close = step(s.w, 0.15) as any;
        const roomPlace = lo.add(fract(s.xyz.add(drift.div(size))).mul(size)) as any;
        const nearPlace = cameraPosition.add(
          fract(s.xyz.add(drift.div(1.6)).sub(cameraPosition.div(1.6)))
            .sub(0.5)
            .mul(1.6)
        ) as any;
        const centre = mix(roomPlace, nearPlace, close) as any;
        const toEye = normalize(cameraPosition.sub(centre).add(vec3(0, 0, 1e-5))) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
        const up = cross(toEye, right) as any;
        const away = max(cameraPosition.sub(centre).length(), 1e-4) as any;
        const fleck = step(s.w, 0.3).mul(1.6).add(1) as any;
        const sharp = max(float(0.0016), away.mul(0.0009)).mul(fleck) as any;
        const blur = away.sub(focusDistance).abs().div(away).mul(0.03) as any;
        const radius = sharp.add(blur) as any;
        const spread = sharp.div(radius).pow(2).max(0.05) as any;
        const soft = smoothstep(0.004, 0.03, blur) as any;
        parts.dustMaterial.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
        let lit: any = float(0);
        for (const fromBox of parts.fromBoxes) {
          const p = inBox(fromBox as any, centre) as any;
          const inside = smoothstep(0, 0.05, p.x)
            .mul(float(1).sub(smoothstep(0.95, 1, p.x)))
            .mul(smoothstep(0, 0.04, p.y))
            .mul(float(1).sub(smoothstep(0.96, 1, p.y)))
            .mul(step(0, p.z))
            .mul(exp(p.z.mul(-1.6))) as any;
          lit = lit.add(inside);
        }
        const twinkle = sin(t.mul(s.y.mul(2).add(0.6)).add(s.z.mul(50)))
          .mul(0.3)
          .add(0.7) as any;
        const r = uv().sub(0.5).length() as any;
        const point = float(1).sub(smoothstep(0.15, 0.5, r)) as any;
        const disc = float(1)
          .sub(smoothstep(0.4, 0.5, r))
          .mul(0.75)
          .add(
            smoothstep(0.3, 0.46, r)
              .mul(float(1).sub(smoothstep(0.46, 0.5, r)))
              .mul(0.4)
          ) as any;
        const speck = mix(point, disc, soft).mul(spread) as any;
        const shown = step(sceneZ, positionView.z) as any;
        const brightness = mix(float(0.18), float(2.2), lit.min(1)).mul(twinkle).mul(speck).mul(shown) as any;
        parts.dustMaterial.colorNode = vec4(color(SUN_COLOUR).mul(brightness.min(3)), 1) as any;
        parts.dustMaterial.needsUpdate = true;
      }),
    [parts]
  );

  return (
    <>
      {parts.meshes.map((mesh, n) => (
        <primitive key={n} object={mesh} />
      ))}
      <primitive object={parts.specks} />
    </>
  );
}
