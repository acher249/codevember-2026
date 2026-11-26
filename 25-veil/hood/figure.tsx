"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  cross,
  dot,
  exp,
  float,
  fract,
  int,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionWorld,
  select,
  smoothstep,
  transformNormalToView,
  uniform,
  varying,
  vec2,
  vec3,
  vertexIndex
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import type { Cloth } from "./cloth";
import { face, hood, surfaceNets } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The light: the moon behind and above her, cold, outlining the hood; a candle low in front, warm and unsteady, reaching
// the veil's hem and the cloak below it, never into the hood; and the dark.
export const MOON = new THREE.Vector3(-1.1, 2.2, -1.4);
export const CANDLE = new THREE.Vector3(0.1, 1.02, 0.42);
export const light = { flicker: uniform(1) };

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// Her face, lost in the shadow of the hood: there, so the veil lies over it and the dark inside has a shape, but no light
// reaches it to show it.
export function Face() {
  const parts = useMemo(() => {
    const geometry = surfaceNets(face, V(-0.1, 1.33, -0.11), V(0.1, 1.72, 0.13), 0.0025);
    const material = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.48, metalness: 0 });
    const p = positionGeometry as any;
    const mottle = mx_noise_float(p.mul(90)).mul(0.04) as any;
    // Pale, a touch cool; lips a little darker and redder; a darkness round the eyes.
    const lips = float(1)
      .sub(smoothstep(0.004, 0.009, abs(p.y.sub(1.551))))
      .mul(float(1).sub(smoothstep(0.016, 0.024, abs(p.x))))
      .mul(smoothstep(0.08, 0.09, p.z)) as any;
    const sockets = float(1)
      .sub(smoothstep(0.012, 0.03, vec2(abs(p.x).sub(0.031), p.y.sub(1.613)).length()))
      .mul(smoothstep(0.06, 0.08, p.z)) as any;
    const skin = vec3(0.05, 0.04, 0.038).add(mottle.mul(0.08)) as any;
    material.colorNode = mix(mix(skin, vec3(0.035, 0.02, 0.02), lips.mul(0.6)), vec3(0.02, 0.015, 0.015), sockets.mul(0.4));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "face";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { geometry, material, mesh };
  }, []);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// The hood and cloak: heavy black wool with a velvet nap, which catches the moon only along its folds and edges.
export function Hood() {
  const parts = useMemo(() => {
    const geometry = surfaceNets(hood, V(-0.34, 0.96, -0.24), V(0.34, 1.84, 0.26), 0.0042);
    const material = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
    const p = positionGeometry as any;
    const weave = mx_noise_float(p.mul(vec3(900, 260, 900))).mul(0.008) as any;
    material.colorNode = vec3(0.022, 0.02, 0.024).add(weave);
    // Wool's surface: a fine twill running down the cloth, and the nap ruffled in patches.
    const twill = mx_noise_float(p.mul(vec3(1400, 300, 1400)).add(p.y.mul(400))) as any;
    const nap = mx_noise_float(p.mul(60)) as any;
    material.roughnessNode = float(0.88).add(twill.mul(0.06)).add(nap.mul(0.05));
    material.sheenNode = vec3(0.1, 0.105, 0.13);
    material.sheenRoughnessNode = float(0.5);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "hood";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { geometry, material, mesh };
  }, []);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

const clampInt = (k: any, top: number) => (max as any)((min as any)(k, int(top)), int(0));

// The veil: black mourning tulle, sheer, scattered with small velvet dots, and edged with a narrow band; drawn from the
// cloth's own buffer, so nothing is copied back to draw it.
export function Veil({ cloth }: { cloth: Cloth }) {
  const parts = useMemo(() => {
    const { COLS, ROWS, A } = cloth;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(COLS * ROWS * 3);
    const uvs = new Float32Array(COLS * ROWS * 2);
    const index: number[] = [];
    for (let j = 0; j < ROWS; j++)
      for (let i = 0; i < COLS; i++) {
        const k = j * COLS + i;
        uvs[k * 2] = i / (COLS - 1);
        uvs[k * 2 + 1] = j / (ROWS - 1);
        if (i < COLS - 1 && j < ROWS - 1) index.push(k, k + COLS, k + 1, k + 1, k + COLS, k + COLS + 1);
      }
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(index);

    const id = int(vertexIndex);
    const i = id.mod(COLS);
    const j = id.div(COLS);
    const at = (a: any, b: any) => A.element(clampInt(b, ROWS - 1).mul(COLS).add(clampInt(a, COLS - 1))).xyz as any;
    const material = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.55, metalness: 0, transparent: false });
    material.positionNode = at(i, j);
    const sideways = at(i.add(1), j).sub(at(i.sub(1), j)) as any;
    const lengthways = at(i, j.add(1)).sub(at(i, j.sub(1))) as any;
    const normal = varying(normalize(cross(lengthways, sideways).add(vec3(0, 1e-7, 0)))) as any;
    const eye = normalize(cameraPosition.sub(positionWorld)) as any;
    const n = normal.mul(select(dot(normal, eye).greaterThanEqual(0), float(1), float(-1))) as any;
    material.normalNode = transformNormalToView(n);

    // Where on the cloth, in metres.
    const uv0 = attribute("uv", "vec2") as any;
    const m = vec2(uv0.x.mul(cloth.du * (COLS - 1)), uv0.y.mul(cloth.dv * (ROWS - 1))) as any;
    // Point d'esprit: a dot every couple of centimetres, on offset rows.
    const row = m.y.div(0.019).floor() as any;
    const cell = vec2(fract(m.x.div(0.019).add(row.mul(0.5))), fract(m.y.div(0.019))).sub(0.5) as any;
    const dot_ = float(1).sub(smoothstep(0.08, 0.13, cell.length())) as any;
    // A narrow band along the hem and the sides.
    const edge = min(min(uv0.x, float(1).sub(uv0.x)).mul(WIDTH_M), float(1).sub(uv0.y).mul(LENGTH_M)) as any;
    const band = float(1).sub(smoothstep(0.004, 0.006, edge)) as any;
    // Seen at a slant, more threads lie across the line of sight: sheerest face on.
    const slant = float(1).sub(abs(dot(normal, eye))) as any;
    const sheer = float(0.3).add(slant.mul(0.35)) as any;
    material.opacityNode = max(max(sheer, dot_.mul(0.95)), band.mul(0.92));
    material.alphaHash = true;
    material.colorNode = vec3(0.03, 0.028, 0.032);
    // The threads catch the light at a slant: the folds and the dots show against the dark as fine grey.
    material.sheenNode = vec3(0.55, 0.55, 0.62).mul(slant.mul(0.7).add(0.3)).add(vec3(0.25).mul(dot_));
    material.sheenRoughnessNode = float(0.35);
    // A warm glimmer where the candle catches threads turned toward it.
    const toCandle = normalize(vec3(CANDLE.x, CANDLE.y, CANDLE.z).sub(positionWorld)) as any;
    material.emissiveNode = vec3(0.5, 0.25, 0.08)
      .mul(max(dot(n, toCandle), 0).pow(6))
      .mul(light.flicker)
      .mul(0.015) as any;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "veil";
    // Its shadow, cast through its dots and folds, mottled her face in blotches: it casts none.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return { geometry, material, mesh };
  }, [cloth]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

const WIDTH_M = 0.36;
const LENGTH_M = 0.44;

// The dark she stands in: far behind, a faint cold glow where the moon lights the mist, so her outline shows against it.
export function Backdrop() {
  const parts = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(5, 4);
    const material = new THREE.MeshBasicNodeMaterial({ depthWrite: true });
    const p = positionGeometry as any;
    const glow = exp(vec2(p.x.add(0.25), p.y.sub(0.35)).length().mul(-1.6)) as any;
    const drift = mx_noise_float(vec3(p.x.mul(1.4), p.y.mul(1.4), 0.3)).mul(0.3).add(0.85) as any;
    material.colorNode = vec3(0.05, 0.062, 0.085).mul(glow.mul(drift)).add(vec3(0.003, 0.003, 0.005));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0, 1.4, -1.6);
    return { geometry, material, mesh };
  }, []);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// The lights, the candle's flickering.
export function Lights() {
  const parts = useMemo(() => {
    const moon = new THREE.DirectionalLight("#9cb2dc", 6);
    moon.position.copy(MOON);
    moon.target.position.set(0, 1.5, 0);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    const cam = moon.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -0.55;
    cam.right = cam.top = 0.55;
    cam.near = 0.5;
    cam.far = 5;
    moon.shadow.bias = -0.0004;
    moon.shadow.normalBias = 0.002;
    const candle = new THREE.SpotLight("#ffae63", 0.05, 0, 0.22, 1, 2);
    candle.position.copy(CANDLE);
    candle.target.position.set(0, 1.4, 0.1);
    candle.castShadow = true;
    candle.shadow.mapSize.set(1024, 1024);
    candle.shadow.bias = -0.0005;
    candle.shadow.normalBias = 0.002;
    const sky = new THREE.HemisphereLight("#202838", "#050505", 0.03);
    return { moon, candle, sky };
  }, []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const f = 0.82 + 0.1 * Math.sin(t * 7.3) + 0.06 * Math.sin(t * 13.1 + 1) + 0.05 * Math.sin(t * 23.7 + 2);
    parts.candle.intensity = 0.05 * f;
    light.flicker.value = f;
  });
  return (
    <>
      <primitive object={parts.moon} />
      <primitive object={parts.moon.target} />
      <primitive object={parts.candle} />
      <primitive object={parts.candle.target} />
      <primitive object={parts.sky} />
    </>
  );
}

