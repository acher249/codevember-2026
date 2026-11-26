"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three/webgpu";
import { dot, float, max, mx_noise_float, normalize, normalWorld, positionGeometry, vec3 } from "three/tsl";
import { orbitPoint } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { StudioEnvironment } from "../../shared/engine/studio";
import { useBed, useMusic } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { back, body, front, loadFigure, type FigureData } from "./figure";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Veil from a photograph, in a pale studio as the photograph was: a seated figure under white chiffon (figure.ts), lit by
// a big soft light high to the left, on a seamless warm sweep.

// A big soft light high to the left, as in the photograph.
const KEY = new THREE.Vector3(-2.6, 3.2, 2.6);
// The photograph's own camera (figure.json, in this scene's y-up frame).
const EYE: [number, number, number] = [-0.008, 1.139, 3.615];
const AIM: [number, number, number] = [-0.013, 0.732, 0.038];

// Chiffon: white, matte, a soft sheen at a slant; light comes through it where it is turned from the key; and a little
// of what is behind shows.
function chiffon(opacity: number) {
  const material = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.85, metalness: 0, transparent: true, opacity });
  const p = positionGeometry as any;
  material.colorNode = vec3(0.93, 0.92, 0.9).add(mx_noise_float(p.mul(900)).mul(0.002));
  material.sheenNode = vec3(0.45, 0.45, 0.46);
  material.sheenRoughnessNode = float(0.4);
  const toKey = normalize(vec3(KEY.x, KEY.y, KEY.z)) as any;
  material.emissiveNode = vec3(0.32, 0.31, 0.3).mul(max(dot(normalWorld, toKey).negate(), 0).pow(1.2)) as any;
  return material;
}

function Figure({ data }: { data: FigureData }) {
  const parts = useMemo(() => {
    const fg = front(data);
    const bg = back(data);
    const dg = body(bg, 0.82);
    const fm = chiffon(0.94);
    const bm = chiffon(0.94);
    const dm = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    dm.colorNode = vec3(0.6, 0.59, 0.57);
    const frontMesh = new THREE.Mesh(fg, fm);
    const backMesh = new THREE.Mesh(bg, bm);
    const bodyMesh = new THREE.Mesh(dg, dm);
    frontMesh.name = "front";
    backMesh.name = "back";
    bodyMesh.name = "body";
    backMesh.renderOrder = 1;
    frontMesh.renderOrder = 2;
    for (const m of [frontMesh, backMesh]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    return { fg, bg, dg, fm, bm, dm, frontMesh, backMesh, bodyMesh };
  }, [data]);
  useDispose(parts.fg, parts.bg, parts.dg, parts.fm, parts.bm, parts.dm);
  return (
    <>
      <primitive object={parts.bodyMesh} />
      <primitive object={parts.backMesh} />
      <primitive object={parts.frontMesh} />
    </>
  );
}

// The room: a seamless pale warm sweep, floor curving up into the wall behind her.
function Room() {
  const parts = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(12, 1, 1, 96);
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const FLOOR = 6;
    const BEND = (Math.PI / 2) * 1.2;
    const WALL = 5;
    const total = FLOOR + BEND + WALL;
    for (let k = 0; k < pos.count; k++) {
      const s = (0.5 - pos.getY(k)) * total;
      let y: number;
      let z: number;
      if (s < FLOOR) {
        y = 0;
        z = 4.5 - s;
      } else if (s < FLOOR + BEND) {
        const a = (s - FLOOR) / 1.2;
        y = 1.2 - Math.cos(a) * 1.2;
        z = -1.5 - Math.sin(a) * 1.2;
      } else {
        y = 1.2 + (s - FLOOR - BEND);
        z = -2.7;
      }
      pos.setXYZ(k, pos.getX(k), y, z);
    }
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
    material.colorNode = vec3(0.86, 0.84, 0.81).add(mx_noise_float(positionGeometry.mul(2)).mul(0.008));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return { geometry, material, mesh };
  }, []);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

function Lights() {
  const parts = useMemo(() => {
    const key = new THREE.DirectionalLight("#fff7ee", 1.35);
    key.position.copy(KEY);
    key.target.position.set(0, 0.7, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(4096, 4096);
    const cam = key.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -1.4;
    cam.right = cam.top = 1.4;
    cam.near = 1;
    cam.far = 9;
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 6;
    const room = new THREE.HemisphereLight("#ffffff", "#e2ddd6", 0.4);
    return { key, room };
  }, []);
  return (
    <>
      {/* The studio round her: a window-sized soft box high to the left, the ceiling, and pale walls. */}
      <StudioEnvironment
        ambient="#b4b0aa"
        intensity={1}
        boxes={[
          { position: [-3.2, 3, 2.6], scale: [4, 3.5, 0.2], color: "#fff6ec", intensity: 3.5 },
          { position: [0, 4.5, 0], scale: [5, 0.2, 5], color: "#ffffff", intensity: 1.1 },
          { position: [3.2, 1.4, 1.2], scale: [0.2, 2.4, 3.5], color: "#f3f2f0", intensity: 0.7 }
        ]}
      />
      <primitive object={parts.key} />
      <primitive object={parts.key.target} />
      <primitive object={parts.room} />
    </>
  );
}

function Scene() {
  const camera = useThree((state) => state.camera);
  const [data, setData] = useState<FigureData | null>(null);

  useEffect(() => {
    let gone = false;
    loadFigure().then((d) => !gone && setData(d));
    return () => {
      gone = true;
    };
  }, []);

  useBed("wind", 0.006);
  useMusic("/codevember/music/dark-trap-beat.mp3", 0.3);

  if (process.env.NODE_ENV !== "production")
    Object.assign(globalThis, {
      __veil: { ready: () => data !== null, camera },
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
      {data && <Figure data={data} />}
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: EYE,
    target: AIM,
    fov: 28.8,
    phone: { position: [0, 1.1, 4.6], target: [0, 0.72, 0], fov: 32 },
    limits: { turn: { left: 70, right: 70, up: 25, down: 12 }, move: { left: 0.3, right: 0.3, down: 0.3, up: 0.4, nearer: 2, further: 1 } }
  },
  hover: true,
  look: { background: "#e9e5df", exposure: 1.0, bloom: 0.04, bloomThreshold: 1, ao: 0.45, aoRadius: 0.1, vignette: 0.15, grain: 0.015, haze: 0 },
  passes: { bounce: false, haze: false },
  hint: "Turn about her.",
  notes: "A seated figure under white chiffon, from a photograph: its geometry read by MoGe-3, made whole in Blender, and drawn here.",
  Scene
};

export default day;
