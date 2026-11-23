"use client";

// The counter round the plate, so the pocket is not alone: a stack of folded newspapers (THE DAILY CRUST: "LOCAL MAN
// BITES TOO SOON"), a sweating glass of milk, a quilted oven mitt singed at a fingertip, a folded paper towel under the
// plate, a knife block and a cutting board, and behind it all the microwave it came out of, door ajar, its display
// counting down and then blinking END. All placed off the plate (the lava never leaves it) and behind or beside the pocket, so the bitten end
// stays clear from the start view. Built once at load (geometry, printed canvases); per frame only the lava's glow is
// copied into two uniforms. Every word printed is our own; no brand.

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  float,
  fwidth,
  max,
  min,
  mix,
  mx_noise_float,
  mx_worley_noise_float,
  normalize,
  normalView,
  normalWorld,
  positionGeometry,
  positionView,
  positionWorld,
  reflect,
  screenUV,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  viewportSharedTexture
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { loadRetried, suspendRetried } from "../shared/engine/retry";
import { bump } from "./props/bump";
import { GLASS, glassGeometry, milkGeometry } from "./props/glass";
import { cuttingBoard, knifeBlock } from "./props/knives";
import { ovenMitt } from "./props/mitt";
import { foldedTowel, newspaperStack } from "./props/paper";
import { buildMicrowave, microwaveState } from "./props/microwave";
import { newspaperPrint } from "./props/prints";
import { BACKSPLASH_Z, COUNTER, MICROWAVE, PLATE_LIFT } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Where each thing stands on the wall counter (world x, z) and how it is turned about the vertical. The plate is at the
// origin, the microwave behind it against the backsplash (MICROWAVE, from shape.ts); the default eye at (0, 0.3, 0.86)
// looks toward -z. The space |x| < 0.7, z > -1.1 is kept for the plate, the lava and the camera: the newspapers frame
// the shot on the left; the knife block and board (right of the microwave), the milk and the mitt on the right.
const PLACES = {
  // Square to the counter, in front of the microwave and its ajar door (which reaches z -0.78) and left of the plate's
  // clear space (|x| < 0.7): about x -2.05 to -0.73, z -0.74 to 0.48.
  papers: { x: -1.4, z: -0.1, turn: 0 },
  // Right of the microwave (which ends at x 0.3) and behind the milk, near the backsplash.
  // Just right of the microwave (which ends at MICROWAVE.x + 1.05), the board leaning on the backsplash behind.
  block: { x: MICROWAVE.x + 1.05 + 0.42, z: BACKSPLASH_Z + 1.0, turn: -0.35 },
  board: { x: MICROWAVE.x + 1.05 + 0.7, z: BACKSPLASH_Z + 0.01, turn: 0 },
  glass: { x: 1.55, z: -0.75 },
  // The mitt's frame starts at its cuff; turned so its fingertips point in at the plate.
  mitt: { x: 2.05, z: -0.1, turn: -2.74 },
  towel: { turn: 0.45 }
};

// Where the eye may not go, so no orbit, zoom or flight puts it inside a prop: each a rectangle on the counter (centre,
// turn, half sizes) up to a height. The eye rides up over the low ones on a ramp, and is pushed sideways out of the
// tall ones (the glass, the knife block, the board), so it never jumps. A few centimetres' margin keeps the near plane out of them too.
type KeepOut = { x: number; z: number; turn: number; hx: number; hz: number; top: number; tall: boolean };
const MARGIN = 0.06;
function keepOuts(): KeepOut[] {
  const at = (p: { x: number; z: number; turn?: number }, lx: number, lz: number): [number, number] => {
    const c = Math.cos(p.turn ?? 0);
    const s = Math.sin(p.turn ?? 0);
    return [p.x + lx * c + lz * s, p.z - lx * s + lz * c];
  };
  const mitt = at(PLACES.mitt, 0.57, 0.08);
  return [
    { x: PLACES.papers.x, z: PLACES.papers.z, turn: PLACES.papers.turn, hx: 0.66, hz: 0.62, top: 0.1, tall: false },
    { x: mitt[0], z: mitt[1], turn: PLACES.mitt.turn, hx: 0.6, hz: 0.38, top: 0.11, tall: false },
    { x: PLACES.glass.x, z: PLACES.glass.z, turn: 0, hx: GLASS.lip, hz: GLASS.lip, top: GLASS.height, tall: true },
    { x: PLACES.block.x, z: PLACES.block.z, turn: PLACES.block.turn, hx: 0.3, hz: 0.4, top: 0.9, tall: true },
    { x: PLACES.board.x, z: PLACES.board.z + 0.2, turn: 0, hx: 0.62, hz: 0.22, top: 1.55, tall: true },
  ];
}

// The lava's glow, as the scene's lava light has it this frame: how bright and where.
const lava = { glow: uniform(0), at: uniform(new THREE.Vector3(0, 0.4, 0)) };

function newsprintMaterial(map: THREE.Texture) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  const tag = attribute("tag", "float") as any;
  const page = texture(map, uv()).rgb as any;
  // The edges: dozens of sheets, a fine line each, faded out where they would be finer than a pixel.
  const phase = positionWorld.y.mul(1300) as any;
  const lines = sin(phase.mul(Math.PI * 2))
    .mul(0.5)
    .add(0.5) as any;
  const fade = float(1).sub(smoothstep(0.25, 0.7, fwidth(phase))) as any;
  const edgeTone = vec3(0.86, 0.82, 0.72).mul(float(0.93).add(lines.mul(0.1).mul(fade))) as any;
  m.colorNode = mix(page, edgeTone, tag) as any;
  return m;
}

// Glass: the frame behind it, bent through it (the milk seen through the wall, the room through the empty top), with
// the cues that make glass read: a bright rolled lip, a fresnel sheen and darker edges where the wall is seen edge-on, a
// soft vertical streak of the window. Condensation as clear beads where the cold milk is: each a little brighter than
// the glass round it with a highlight at its crown, drawn from the bead's own distance (no bumped normals, which turn
// into flickering dark specks as they cross pixels) and faded out where a bead would be under a pixel or two. The lava's
// glow is caught as a warm reflection. The bending reads the frame drawn so far (one shared copy a frame): three's own
// transmission draws every opaque thing a second time for it, several milliseconds at a retina size.
function glassMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.04, metalness: 0, transparent: true, depthWrite: true });
  const p = positionGeometry as any;
  const r = vec2(p.x, p.z).length() as any;
  const outer = smoothstep(GLASS.wall * 0.3, GLASS.wall * 0.7, r.sub(float(GLASS.foot).add(p.y.mul((GLASS.lip - GLASS.foot) / GLASS.height))).add(GLASS.wall)) as any;
  // Cold below the milk's surface, a few beads above it.
  const cold = float(1)
    .sub(smoothstep(GLASS.milk - 0.01, GLASS.milk + 0.05, p.y))
    .mul(0.8)
    .add(0.2)
    .mul(smoothstep(0.015, 0.035, p.y)) as any;
  // Beads 2 to 4 mm, round, in patches; gone where one would be finer than a couple of pixels.
  const q = p.mul(70) as any;
  const f1 = mx_worley_noise_float(q) as any;
  const size = float(0.16).add(mx_noise_float(q.mul(0.37)).mul(0.07)) as any;
  const inBead = float(1).sub(smoothstep(size.mul(0.8), size, f1)) as any;
  const crown = float(1).sub(smoothstep(0.0, size.mul(0.45), f1)) as any;
  const patches = smoothstep(-0.15, 0.3, mx_noise_float(p.mul(16))) as any;
  const pixel = float(1).sub(smoothstep(0.12, 0.35, fwidth(q.x).add(fwidth(q.y)))) as any;
  const bead = inBead.mul(patches).mul(cold).mul(outer).mul(pixel) as any;
  m.colorNode = vec3(0) as any;
  const view = normalize(positionView.negate()) as any;
  const n = normalView as any;
  const facingEye = max(n.dot(view), 0) as any;
  const edge = float(1).sub(facingEye) as any;
  const fresnel = float(0.04).add(float(0.96).mul(edge.pow(5))) as any;
  const bend = n.xy.mul(0.03).div(max(positionView.z.negate(), 0.2)) as any;
  const behind = viewportSharedTexture(screenUV.sub(bend)).rgb as any;
  const tint = mix(vec3(0.97, 0.985, 0.98), vec3(0.7, 0.74, 0.76), edge.pow(2).mul(0.45)) as any;
  // The lip: a thin bright line round the rolled rim.
  const lip = smoothstep(GLASS.height - 0.014, GLASS.height - 0.004, p.y) as any;
  // The window's reflection: a soft vertical streak a little left of the middle of the glass.
  const streak = smoothstep(0.3, 0.42, n.x.negate())
    .mul(float(1).sub(smoothstep(0.5, 0.62, n.x.negate())))
    .mul(outer) as any;
  // The lava's glow mirrored in the glass, as the reflected view turns toward it.
  const V = normalize(cameraPosition.sub(positionWorld)) as any;
  const R = reflect(V.negate(), normalWorld) as any;
  const L = normalize(lava.at.sub(positionWorld)) as any;
  const facing = max(R.dot(L), 0) as any;
  m.emissiveNode = behind
    .mul(tint)
    .mul(float(1).sub(fresnel))
    .mul(float(1).add(bead.mul(0.12)))
    .add(vec3(0.85, 0.88, 0.9).mul(fresnel.mul(0.55).add(lip.mul(0.45)).add(streak.mul(0.12))))
    .add(vec3(1, 0.98, 0.94).mul(crown.mul(bead).mul(0.6)))
    .add(
      vec3(1, 0.55, 0.18)
        .mul(lava.glow)
        .mul(facing.pow(6).mul(2.2).add(facing.pow(2).mul(0.25)))
    ) as any;
  return m;
}

// Milk: smooth, soft white, as if lit a little from inside (light scattered through it), brighter toward its edges.
function milkMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.38, metalness: 0 });
  m.colorNode = vec3(0.95, 0.945, 0.92) as any;
  const rim = float(1).sub(max(normalView.dot(normalize(positionView.negate())), 0)).pow(2) as any;
  m.emissiveNode = vec3(0.16, 0.157, 0.148).mul(normalWorld.y.mul(0.3).add(0.7)).add(vec3(0.12, 0.12, 0.115).mul(rim)) as any;
  return m;
}

// Quilted cotton: diamonds sewn about 2 cm apart, puffed between the stitching; a fine weave; cream piping round the
// seam and a cream binding at the cuff; and the fingertip on the plate side singed brown to black.
function mittMaterial() {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.92, metalness: 0, sheen: 0.6, sheenRoughness: 0.6, sheenColor: new THREE.Color("#9fc9c4") });
  const q = uv() as any;
  const d = vec2(q.x.add(q.y), q.x.sub(q.y)).mul(1 / 0.085) as any;
  const f = vec2(d.x.fract().sub(0.5), d.y.fract().sub(0.5)) as any;
  const inset = min(float(0.5).sub(abs(f.x)), float(0.5).sub(abs(f.y))) as any;
  const pillow = smoothstep(0.0, 0.4, inset) as any;
  const weavePhase = vec2(q.x, q.y).mul(900) as any;
  const weave = sin(weavePhase.x)
    .mul(sin(weavePhase.y))
    .mul(float(1).sub(smoothstep(0.3, 1.0, max(fwidth(weavePhase.x), fwidth(weavePhase.y))))) as any;
  const tag = attribute("tag", "float") as any;
  const piping = float(1).sub(smoothstep(0.008, 0.016, tag)) as any;
  const cuff = float(1).sub(smoothstep(0.09, 0.1, positionGeometry.x)) as any;
  const trim = max(piping, cuff) as any;
  // The stitches: dashed thread along the diamonds' valleys.
  const valley = float(1).sub(smoothstep(0.0, 0.05, inset)) as any;
  // Faded to an even tone where a diamond is only a few pixels across, or they shimmer into stripes at a slant.
  const fine = float(1).sub(smoothstep(0.08, 0.3, fwidth(d.x).add(fwidth(d.y)))) as any;
  const dash = step(0.5, d.x.add(d.y).mul(6).fract()).mul(float(1).sub(smoothstep(0.02, 0.08, fwidth(d.x).mul(6)))) as any;
  const base = vec3(0.16, 0.36, 0.35)
    .mul(float(0.9).add(pillow.mul(0.12)))
    .mul(float(0.95).add(mx_noise_float(positionGeometry.mul(30)).mul(0.08))) as any;
  const cloth = mix(mix(base, vec3(0.11, 0.25, 0.24), valley.mul(0.6).mul(fine)), vec3(0.85, 0.82, 0.72), valley.mul(dash).mul(0.5)) as any;
  // The singe: round the fingertip on one side, charred in the middle, browned around it, uneven.
  const tip = positionGeometry.xz
    .sub(vec2(1.1, -0.13))
    .length()
    .add(mx_noise_float(positionGeometry.mul(14)).mul(0.05)) as any;
  const brown = float(1).sub(smoothstep(0.06, 0.2, tip)) as any;
  const char = float(1).sub(smoothstep(0.02, 0.1, tip.add(mx_noise_float(positionGeometry.mul(40)).mul(0.02)))) as any;
  const woven = mix(cloth, vec3(0.9, 0.86, 0.76), trim) as any;
  m.colorNode = mix(mix(woven, vec3(0.3, 0.17, 0.07), brown.mul(0.85)), vec3(0.03, 0.025, 0.02), char) as any;
  m.normalNode = bump(mix(pillow.mul(fine), float(1), trim).mul(0.007).add(weave.mul(0.0003)).sub(char.mul(0.003))) as any;
  return m;
}

// Kitchen paper towel: white, an embossed dimple pattern, the fold creases across its middle, a faint orange spot.
function towelMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const q = uv() as any;
  const cell = vec2(q.x.mul(60).fract().sub(0.5), q.y.mul(56).fract().sub(0.5)) as any;
  const dimple = float(1).sub(smoothstep(0.1, 0.42, cell.length())) as any;
  const crease = float(1)
    .sub(smoothstep(0.0, 0.006, abs(q.x.sub(0.5))))
    .max(float(1).sub(smoothstep(0.0, 0.006, abs(q.y.sub(0.5))))) as any;
  const spot = float(1).sub(
    smoothstep(
      0.02,
      0.05,
      q
        .sub(vec2(0.86, 0.2))
        .length()
        .add(mx_noise_float(vec3(q.mul(30), 2)).mul(0.012))
    )
  ) as any;
  const tag = attribute("tag", "float") as any;
  m.colorNode = mix(mix(vec3(0.95, 0.95, 0.94).mul(float(1).sub(crease.mul(0.08))), vec3(0.93, 0.62, 0.3), spot.mul(0.55)), vec3(0.9, 0.9, 0.88), tag) as any;
  m.normalNode = bump(dimple.mul(0.0012).sub(crease.mul(0.001))) as any;
  return m;
}

// The oak scan the kitchen uses, loaded again here (the browser has it cached) so the props can wrap it their own way.
const OAK = ["/assets/23-magma/oak_veneer_05_diff_2k.jpg", "/assets/23-magma/oak_veneer_05_nor_gl_2k.jpg", "/assets/23-magma/oak_veneer_05_rough_2k.jpg"];

export function Props({ fine }: { fine: boolean }) {
  const scene = useThree((state) => state.scene);
  const [oakColour, oakNormal, oakRough] = suspendRetried(() => Promise.all(OAK.map((url) => loadRetried(new THREE.TextureLoader(), url))), ["magma-props-oak", ...OAK]);
  const parts = useMemo(() => {
    const group = new THREE.Group();
    group.name = "magma-props";
    const textures = { paper: newspaperPrint() };
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const place = (geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], x: number, y: number, z: number, turn = 0, shadow = true) => {
      geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.rotation.y = turn;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    const keep = <T extends THREE.Material>(m: T) => (materials.push(m), m);

    const stack = newspaperStack(fine);
    place(stack.geometry, keep(newsprintMaterial(textures.paper)), PLACES.papers.x, COUNTER + 0.0004, PLACES.papers.z, PLACES.papers.turn).name = "props-papers";
    // The glass casts no shadow of its own (light passes through it); the milk does.
    place(glassGeometry(fine), keep(glassMaterial()), PLACES.glass.x, COUNTER + 0.0003, PLACES.glass.z, 0, false).name = "props-glass";
    place(milkGeometry(fine), keep(milkMaterial()), PLACES.glass.x, COUNTER + 0.0003, PLACES.glass.z).name = "props-milk";
    place(ovenMitt(fine), keep(mittMaterial()), PLACES.mitt.x, COUNTER, PLACES.mitt.z, PLACES.mitt.turn).name = "props-mitt";

    // The paper towel the plate stands on, exactly PLATE_LIFT thick.
    place(foldedTowel(0.78, 0.7, PLATE_LIFT, fine), keep(towelMaterial()), 0, COUNTER, 0, PLACES.towel.turn).name = "props-towel";

    // The knife block and the cutting board, right of the microwave.
    for (const t of [oakColour, oakNormal, oakRough]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
    }
    oakColour.colorSpace = THREE.SRGBColorSpace;
    const knives = knifeBlock(oakColour, oakNormal, oakRough, fine);
    knives.group.position.set(PLACES.block.x, COUNTER, PLACES.block.z);
    knives.group.rotation.y = PLACES.block.turn;
    knives.group.name = "props-knives";
    group.add(knives.group);
    geometries.push(...knives.geometries);
    materials.push(...knives.materials);
    const board = cuttingBoard(oakColour, oakNormal, oakRough, fine);
    board.mesh.position.set(PLACES.board.x, COUNTER, PLACES.board.z);
    board.mesh.name = "props-board";
    group.add(board.mesh);
    geometries.push(board.geometry);
    materials.push(board.material);

    // The microwave, against the backsplash behind the plate.
    const microwave = buildMicrowave({ width: MICROWAVE.width, height: MICROWAVE.height, depth: MICROWAVE.front - MICROWAVE.back }, fine);
    microwave.group.position.set(MICROWAVE.x, COUNTER, MICROWAVE.front);
    microwave.group.name = "props-microwave";
    group.add(microwave.group);
    geometries.push(...microwave.geometries);
    materials.push(...microwave.materials);

    return { group, geometries, materials, textures: [...Object.values(textures), ...microwave.textures], microwave };
  }, [fine, oakColour, oakNormal, oakRough]);
  useDispose(...parts.geometries, ...parts.materials, ...parts.textures);

  // After the orbit, the hover and the day's own floor have placed the eye, and before the frame is drawn (at 1): out
  // of every prop.
  const camera = useThree((state) => state.camera);
  const zones = useMemo(() => keepOuts(), []);
  useFrame(() => {
    const e = camera.position;
    for (const k of zones) {
      const c = Math.cos(k.turn);
      const s = Math.sin(k.turn);
      const dx = e.x - k.x;
      const dz = e.z - k.z;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      const ox = Math.abs(lx) - (k.hx + MARGIN);
      const oz = Math.abs(lz) - (k.hz + MARGIN);
      const top = COUNTER + k.top + MARGIN;
      if (k.tall) {
        if (ox >= 0 || oz >= 0 || e.y >= top) continue;
        // Out by the nearer side.
        let nx = lx;
        let nz = lz;
        if (ox > oz) nx = Math.sign(lx) * (k.hx + MARGIN);
        else nz = Math.sign(lz) * (k.hz + MARGIN);
        e.x = k.x + nx * c + nz * s;
        e.z = k.z - nx * s + nz * c;
      } else {
        const out = Math.hypot(Math.max(ox, 0), Math.max(oz, 0));
        const floor = top - out;
        if (e.y < floor) e.y = floor;
      }
    }
  }, 0.75);

  // The lava's light, found once it exists, copied into the glass's glow each frame.
  const light = useRef<THREE.PointLight | null>(null);
  useFrame(() => {
    parts.microwave.update(performance.now());
    if (!light.current || !light.current.parent) light.current = scene.getObjectByName("lava-light") as THREE.PointLight | null;
    const l = light.current;
    if (!l) return;
    lava.glow.value = Number.isFinite(l.intensity) ? Math.min(1, l.intensity * 4) : 0;
    lava.at.value.set(l.position.x, l.position.y - 0.4, l.position.z);
  });

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __magmaProps: { ...parts, lava, microwaveState } });
  return <primitive object={parts.group} />;
}
