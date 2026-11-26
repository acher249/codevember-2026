"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three/webgpu";
import { attribute, float, max, mx_noise_float, normalize, normalWorld, positionGeometry, vec3, dot } from "three/tsl";
import { orbitPoint } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { StudioEnvironment } from "../../shared/engine/studio";
import { useBed, useMusic } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { drape } from "./drape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Veil: a seated figure under a sheet of white crêpe, in a pale, quiet studio, as still as a sculpture. The sheet was laid
// over her head, smoothed in to her and one hem wrapped across her and over her shoulder: simulated once, ahead of time,
// and kept (drape.bin); here it is only drawn.

// A big soft light from in front and to the left as the eye sees her.
const KEY = new THREE.Vector3(-0.7, 2.6, 2.3);
// Where the eye starts, square on to the room (she is turned in it: body.ts).
const EYE: [number, number, number] = [0, 0.74, 2.75];

// Laid by drape.ts at this size; made into the file with __veil.bake in development.
const SIDE = 340;
const PAIRS = 30;
const SUBSTEPS = 6;

// The cloth as a surface: the grid of particles made into triangles, smoothed a little (Taubin: a step in, a step back
// out, so it softens the grid's own kinks without shrinking), with normals.
function surface(xyz: Float32Array) {
  const n = Math.round(Math.sqrt(xyz.length / 3));
  const p = Float32Array.from(xyz);
  const tmp = new Float32Array(p.length);
  const pass = (f: number) => {
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let c = 0;
        for (const [a, b] of [
          [i - 1, j],
          [i + 1, j],
          [i, j - 1],
          [i, j + 1]
        ]) {
          if (a < 0 || b < 0 || a >= n || b >= n) continue;
          const q = (b * n + a) * 3;
          sx += p[q];
          sy += p[q + 1];
          sz += p[q + 2];
          c++;
        }
        tmp[k * 3] = p[k * 3] + f * (sx / c - p[k * 3]);
        tmp[k * 3 + 1] = p[k * 3 + 1] + f * (sy / c - p[k * 3 + 1]);
        tmp[k * 3 + 2] = p[k * 3 + 2] + f * (sz / c - p[k * 3 + 2]);
      }
    p.set(tmp);
  };
  for (let k = 0; k < 3; k++) {
    pass(0.5);
    pass(-0.53);
  }
  const index = new Uint32Array((n - 1) * (n - 1) * 6);
  const uvs = new Float32Array(n * n * 2);
  let w = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      uvs[k * 2] = i / (n - 1);
      uvs[k * 2 + 1] = j / (n - 1);
      // Diagonals alternating, so a crease running across the grid does not come out as a row of teeth.
      if (i < n - 1 && j < n - 1) index.set((i + j) % 2 ? [k, k + n, k + 1, k + 1, k + n, k + n + 1] : [k, k + n, k + n + 1, k, k + n + 1, k + 1], (w += 6) - 6);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(p, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  return geometry;
}

// The crêpe: white, matte, soft at a slant; thin enough that the key light comes through where it is turned away.
function Cloth({ xyz }: { xyz: Float32Array }) {
  const parts = useMemo(() => {
    const geometry = surface(xyz);
    const material = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
    const uv0 = attribute("uv", "vec2") as any;
    const weave = mx_noise_float(vec3(uv0.x.mul(1200), uv0.y.mul(1200), 0)).mul(0.004) as any;
    material.colorNode = vec3(0.78, 0.77, 0.75).add(weave);
    material.sheenNode = vec3(0.35, 0.35, 0.36);
    material.sheenRoughnessNode = float(0.45);
    const toKey = normalize(vec3(KEY.x, KEY.y, KEY.z)) as any;
    material.emissiveNode = vec3(0.3, 0.29, 0.28).mul(max(dot(normalWorld, toKey).negate(), 0).pow(1.5)) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "shroud";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { geometry, material, mesh };
  }, [xyz]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// The room: a seamless pale grey sweep, floor curving up into the wall behind her.
function Room() {
  const parts = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(10, 1, 1, 96);
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    // Along the sweep, s from 0 (front of the floor) to 1 (top of the wall): floor to z = -1.2, a quarter turn of 1.2 m,
    // then the wall straight up.
    const FLOOR = 5;
    const BEND = (Math.PI / 2) * 1.2;
    const WALL = 4;
    const total = FLOOR + BEND + WALL;
    for (let k = 0; k < pos.count; k++) {
      const s = (0.5 - pos.getY(k)) * total;
      let y: number;
      let z: number;
      if (s < FLOOR) {
        y = 0;
        z = 2.6 - s;
      } else if (s < FLOOR + BEND) {
        const a = (s - FLOOR) / 1.2;
        y = 1.2 - Math.cos(a) * 1.2;
        z = -2.4 - Math.sin(a) * 1.2;
      } else {
        y = 1.2 + (s - FLOOR - BEND);
        z = -3.6;
      }
      pos.setXYZ(k, pos.getX(k), y, z);
    }
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
    material.colorNode = vec3(0.74, 0.73, 0.71).add(mx_noise_float(positionGeometry.mul(2)).mul(0.01));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return { geometry, material, mesh };
  }, []);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// A big soft window light high to her right, and the room's own light all round.
function Lights() {
  const parts = useMemo(() => {
    const key = new THREE.DirectionalLight("#fff8f0", 1.8);
    key.position.copy(KEY);
    key.target.position.set(0, 0.6, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(4096, 4096);
    const cam = key.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -1.2;
    cam.right = cam.top = 1.2;
    cam.near = 1;
    cam.far = 7;
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.015;
    key.shadow.radius = 3;
    const room = new THREE.HemisphereLight("#ffffff", "#d8d4ce", 0.15);
    const back = new THREE.DirectionalLight("#eef2f8", 0.6);
    back.position.set(1.8, 2.2, -1.6);
    return { key, room, back };
  }, []);
  return (
    <>
      {/* The studio round her, for soft light from everywhere: a big window-sized box to the left, a lower one to the right, and pale walls. */}
      <StudioEnvironment
        ambient="#8a8884"
        intensity={1}
        boxes={[
          { position: [-3, 2.6, 2.6], scale: [3.5, 3, 0.2], color: "#fff8f0", intensity: 3 },
          { position: [0, 4, 0], scale: [4, 0.2, 4], color: "#ffffff", intensity: 1.2 },
          { position: [3, 1.2, 1], scale: [0.2, 2, 3], color: "#f4f6fa", intensity: 0.8 }
        ]}
      />
      <primitive object={parts.key} />
      <primitive object={parts.key.target} />
      <primitive object={parts.room} />
      <primitive object={parts.back} />
    </>
  );
}

function Scene() {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera);
  const [xyz, setXyz] = useState<Float32Array | null>(null);

  // The drape as it was saved, or, without the file, laid here (slowly: development only).
  useEffect(() => {
    let gone = false;
    (async () => {
      const saved = await fetch("/assets/25-veil/drape.bin")
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        .catch(() => null);
      const data = saved && saved.byteLength === SIDE * SIDE * 12 ? new Float32Array(saved) : await drape(gl, SIDE, PAIRS, SUBSTEPS);
      if (!gone) setXyz(data);
    })();
    return () => {
      gone = true;
    };
  }, [gl]);

  // The hush of an empty room.
  useBed("wind", 0.006);
  useMusic("/codevember/music/dark-trap-beat.mp3", 0.3);

  if (process.env.NODE_ENV !== "production")
    Object.assign(globalThis, {
      __veil: {
        ready: () => xyz !== null,
        camera,
        // For making the saved file: the drape laid from the start, as it is saved.
        bake: async () => Array.from(await drape(gl, SIDE, PAIRS, SUBSTEPS)),
        // To look at one of several laid, to choose which to keep.
        show: (data: number[]) => setXyz(new Float32Array(data))
      },
      __view: (from: number[], to: number[]) => {
        camera.position.set(from[0], from[1], from[2]);
        orbitPoint.current?.set(to[0], to[1], to[2]);
        camera.lookAt(to[0], to[1], to[2]);
      }
    });

  return (
    <>
      <Lights />
      <Room />
      {xyz && <Cloth xyz={xyz} />}
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: EYE,
    target: [0, 0.6, 0],
    fov: 30,
    phone: { position: [0, 0.8, 4.2], target: [0, 0.62, 0], fov: 32 },
    limits: { turn: { left: 70, right: 70, up: 30, down: 15 }, move: { left: 0.3, right: 0.3, down: 0.3, up: 0.4, nearer: 1.4, further: 1 } }
  },
  hover: true,
  look: { background: "#d9d7d3", exposure: 1.0, bloom: 0.05, bloomThreshold: 1, ao: 0.5, aoRadius: 0.1, vignette: 0.18, grain: 0.02, haze: 0 },
  passes: { bounce: false, haze: false },
  hint: "Turn about her.",
  notes: "A seated figure under a sheet of white crêpe, still as a sculpture: simulated on the graphics card as it was laid over her and wrapped, once, and kept.",
  Scene
};

export default day;
