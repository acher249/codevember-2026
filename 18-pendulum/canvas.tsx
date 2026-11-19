"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cameraPosition, color, cos, float, int, max, min, mix, mx_noise_float, normalize, output, positionWorld, sin, smoothstep, transformNormalToView, uniform, varying, vec2, vec3, vec4, vertexIndex } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import type { Paint } from "./paint";
import { CANVAS, FACE, type Pendulum, STAND, STRETCHER } from "./pendulum";
import { paintColourNode } from "./zuv-nodes";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The canvas on the floor and the paint on it, drawn straight from the simulation: one vertex over each column, raised
// by the paint's thickness (a little more than life, so the relief catches the light), its slope worked out from the
// columns either side. Wet paint is glossy under a clear coat that fades as it dries; bare canvas shows its weave.

// How much the paint's relief is raised beyond life.
const RELIEF = 1.6;

export const canvasColours = {
  black: "#101011",
  white: "#e9e5dc",
  linen: "#b59f7c"
};

// How far the canvas has turned on its turntable, for its shadow on the floor.
export const canvasTurn = uniform(0);

// The canvas's shadow on the floor, as a factor to darken the floor by: dark close under the board, fading softly out
// well past its edges, as the light from the whole bright room is kept from the floor beneath it. Worked into the floor's
// own material, so nothing can be drawn over it; turns with the canvas.
export const underCanvas = (p: any) => {
  const c = cos(canvasTurn) as any;
  const s = sin(canvasTurn) as any;
  const local = vec2(p.x.mul(c).sub(p.z.mul(s)), p.x.mul(s).add(p.z.mul(c))) as any;
  const q = local.abs().sub(CANVAS / 2 - 0.12) as any;
  const box = q.max(0).length().add(q.x.max(q.y).min(0)).sub(0.12) as any;
  // Deep and wide: the floor here is lit well past white, so a gentle darkening would not show at all.
  return float(1).sub(float(1).sub(smoothstep(-0.25, 0.6, box)).pow(1.1).mul(0.85)) as any;
};

// Set while the painting is saved: the canvas lit evenly from the upper left in place of the studio's warm lamp, so the
// picture keeps the paint's true colours and its relief.
export const snapshot = uniform(0);

// The canvas, or with \`floor\` set the paint spilt on the floor round it: no canvas of its own, just the paint, sitting on
// the concrete and fading out where there is none.
// The turntable's fixed base under the canvas: a squat steel drum on the floor with the bearing ring on top, worn and
// spattered from years of paintings.
export function Turntable() {
  const { mesh, geometries, materials } = useMemo(() => {
    const steel = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.85 });
    const spatter = smoothstep(0.62, 0.7, mx_noise_float(positionWorld.mul(26))) as any;
    steel.colorNode = mix(color("#2b2b2c"), color("#c9c2b4"), spatter.mul(0.6)) as any;
    steel.roughnessNode = mix(float(0.45), float(0.75), spatter) as any;
    const drumGeometry = new THREE.CylinderGeometry(0.3, 0.34, STAND - 0.022, 48).translate(0, (STAND - 0.022) / 2, 0);
    const ringGeometry = new THREE.CylinderGeometry(0.36, 0.36, 0.004, 48).translate(0, STAND - 0.02, 0);
    const bright = new THREE.MeshStandardNodeMaterial({ roughness: 0.25, metalness: 1 });
    bright.colorNode = color("#9a9a96") as any;
    const group = new THREE.Group();
    const drum = new THREE.Mesh(drumGeometry, steel);
    const ring = new THREE.Mesh(ringGeometry, bright);
    drum.receiveShadow = true;
    group.add(drum, ring);
    return { mesh: group, geometries: [drumGeometry, ringGeometry], materials: [steel, bright] };
  }, []);
  useDispose(...geometries, ...materials);
  return <primitive object={mesh} />;
}

export function Canvas({ paint, ground, floor = false }: { paint: Paint; ground: string; floor?: boolean }) {
  const tone = useMemo(() => uniform(new THREE.Color(canvasColours.black)), []);
  tone.value.set(ground);
  const { mesh, frame, geometries, materials } = useMemo(() => {
    const { N, SIZE, CELL, cells, zuv, wet } = paint;
    const lift = floor ? 0.0008 : FACE;
    // One vertex a column, each sitting over its column's middle.
    const geometry = new THREE.PlaneGeometry(SIZE - CELL, SIZE - CELL, N - 1, N - 1);
    geometry.rotateX(-Math.PI / 2);
    const id = int(vertexIndex);
    const i = id.mod(N);
    const j = id.div(N);
    const clampI = (k: any) => (max as any)((min as any)(k, int(N - 1)), int(0));
    const heightAt = (a: any, b: any) => cells.element(clampI(b).mul(N).add(clampI(a))).x.mul(RELIEF) as any;
    const own = cells.element(id) as any;
    const h = own.x.mul(RELIEF) as any;
    const base = attribute("position", "vec3") as any;
    const material = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.85, metalness: 0, clearcoatRoughness: 0.08 });
    material.positionNode = vec3(base.x, h.add(lift), base.z) as any;
    // The slope from the columns either side.
    const dx = heightAt(i.add(1), j).sub(heightAt(i.sub(1), j)).div(CELL * 2) as any;
    const dz = heightAt(i, j.add(1)).sub(heightAt(i, j.sub(1))).div(CELL * 2) as any;
    const normal = varying(normalize(vec3(dx.negate(), 1, dz.negate()))) as any;
    const rgbColour = varying(own.yzw) as any;
    const zuvColour = varying(zuv.element(id));
    // Interpolate signed ZUV before decoding it. A uniform branch makes comparison immediate and leaves the RGB view
    // free of the display conversion's trigonometry; both histories keep evolving in the simulation either way.
    const paintColour = paintColourNode(rgbColour, zuvColour, paint.u.mixing) as any;
    const thick = varying(own.x) as any;
    const wetness = varying(wet.element(id).x) as any;
    const fresh = varying(wet.element(id).y) as any;

    // Bare canvas: a fine weave, faded out where it would be smaller than a pixel; paint covers it as it thickens.
    const p = positionWorld as any;
    const away = p.sub(cameraPosition).length() as any;
    const weaveFade = smoothstep(2.6, 0.9, away) as any;
    const weave = sin(p.x.mul(1400)).mul(sin(p.z.mul(1400))).mul(0.5).add(0.5) as any;
    const slub = mx_noise_float(vec3(p.x.mul(60), 0, p.z.mul(90))).mul(0.06) as any;
    const canvasTone = tone.mul(float(1).add(weave.mul(0.12).mul(weaveFade)).add(slub)) as any;
    const cover = smoothstep(0.00001, 0.00012, thick) as any;
    // Paint: its own colour, a touch deeper where it pools, with the skin's faint ripple as it dries.
    const pooled = smoothstep(0.0008, 0.004, thick) as any;
    const ripple = mx_noise_float(vec3(p.x.mul(220), wetness.mul(3), p.z.mul(220))).mul(float(1).sub(wetness)).mul(0.04) as any;
    const paintTone = paintColour.mul(float(1).sub(pooled.mul(0.12))).mul(float(1).add(ripple)) as any;
    const albedo = mix(canvasTone, paintTone, cover) as any;
    material.colorNode = albedo;
    material.normalNode = transformNormalToView(normal) as any;
    // Wet paint glossy, drying to satin; the canvas matte.
    material.roughnessNode = mix(float(0.86), mix(float(0.42), float(0.06), wetness), cover) as any;
    material.clearcoatNode = cover.mul(wetness).mul(0.9) as any;
    // Paint just landed glints a moment.
    material.emissiveNode = paintColour.mul(fresh.mul(cover).mul(0.25)) as any;
    const even = normal.dot(normalize(vec3(-0.45, 1, -0.55))).max(0) as any;
    const sheen = even.pow(40).mul(cover).mul(wetness.mul(0.35).add(0.1)) as any;
    if (floor) {
      // Only the paint shows; the concrete underneath is the studio's own floor.
      material.transparent = true;
      material.opacityNode = cover as any;
    } else material.outputNode = mix(output, vec4(albedo.mul(even.mul(0.55).add(0.5)).add(sheen), 1), snapshot) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    // The stretcher under it: a shallow box with the canvas wrapped round its sides.
    // Its top a millimetre under the painted surface, so the two never fight for the same pixels.
    const frameGeometry = new THREE.BoxGeometry(CANVAS + 0.02, STRETCHER - 0.001, CANVAS + 0.02).translate(0, STAND + (STRETCHER - 0.001) / 2, 0);
    const frameMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
    frameMaterial.colorNode = tone.mul(0.9) as any;
    const frame = new THREE.Mesh(frameGeometry, frameMaterial);
    frame.receiveShadow = true;
    // The canvas casts no hard shadow from the windows' sun; it sits in a soft, diffuse one of its own (below), as a
    // raised board does under bright, even light.
    frame.castShadow = false;
    // The turntable's top, turning with the canvas: a plywood disc under the stretcher, paint-spattered at its edge.
    const discGeometry = new THREE.CylinderGeometry(0.42, 0.42, 0.018, 64).translate(0, STAND - 0.009, 0);
    const discMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
    const grain = mx_noise_float(positionWorld.mul(vec3(30, 2, 3))).mul(0.5).add(0.5) as any;
    discMaterial.colorNode = mix(color("#5b4630"), color("#7a6043"), grain) as any;
    const disc = new THREE.Mesh(discGeometry, discMaterial);
    disc.receiveShadow = true;
    frame.add(disc);
    return { mesh, frame, geometries: [geometry, frameGeometry, discGeometry], materials: [material, frameMaterial, discMaterial] };
  }, [paint, tone, floor]);
  useDispose(...geometries, ...materials);
  return (
    <>
      <primitive object={mesh} />
      {!floor && <primitive object={frame} />}
    </>
  );
}

// Where the hole will pass if let go now: a dotted line just over the canvas, shown while the can is held, fading
// along its length, as a slingshot shows its aim.
const DOTS = 120;
export function Aim({ pendulum }: { pendulum: Pendulum }) {
  const { mesh, geometry, material, points } = useMemo(() => {
    const geometry = new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    material.colorNode = color("#fff2d6").mul(0.9) as any;
    const mesh = new THREE.InstancedMesh(geometry, material, DOTS);
    mesh.frustumCulled = false;
    // One to start with, so it is built while loading; hidden from the first frame until the can is held.
    mesh.count = 1;
    mesh.renderOrder = 5;
    const points = Array.from({ length: DOTS }, () => new THREE.Vector3());
    return { mesh, geometry, material, points };
  }, []);
  useDispose(geometry, material);
  const m = useMemo(() => new THREE.Matrix4(), []);
  useFrame(() => {
    if (!pendulum.held) {
      mesh.count = 0;
      return;
    }
    const n = pendulum.predict(6, 12, points);
    for (let k = 0; k < n; k++) {
      const s = 0.006 * (1 - (k / DOTS) * 0.7);
      m.makeScale(s, 1, s).setPosition(points[k].x, FACE + 0.012, points[k].z);
      mesh.setMatrixAt(k, m);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}
