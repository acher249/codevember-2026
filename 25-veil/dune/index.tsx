"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three/webgpu";
import { abs, cameraPosition, dot, float, max, mix, mx_noise_float, normalize, normalWorld, positionGeometry, positionWorld, pow, smoothstep, vec3 } from "three/tsl";
import { orbitPoint } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { Haze, KeyLight } from "../../shared/engine/studio";
import { useBed, useMusic } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { back, body, front, loadFigure, type FigureData } from "../photo/figure";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Veil on another world: the seated figure from the photograph (photo/figure.ts), and others like her further off, each
// shrouded in white, waiting on black ash dunes under a vast pale planet low on the horizon. Its cold light comes from
// behind them, so the cloth glows where it is thin and along every edge while their fronts stay in shadow; dust hangs in
// the air, and far off, dark spires of rock stand in it.

// The planet, low behind them and a little to the left, and the cold light it throws.
const SUN = new THREE.Vector3(-0.3, 0.16, -1).normalize();
const SUN_AT: [number, number, number] = [SUN.x * 18, SUN.y * 18 + 0.6, SUN.z * 18];
const EMBER = new THREE.Color("#bcd2ff");
const DUSK = new THREE.Color("#4d5d80");

// The watchers: the one from the photograph in front, others behind; x, z and which way each is turned (radians).
const WATCHERS: [number, number, number][] = [
  [-1.9, -2.6, 0.35],
  [1.8, -3.4, -0.3],
  [-0.4, -5.8, 0.15],
  [3.3, -7.4, -0.5],
  [-3.7, -6.9, 0.6]
];

// The dunes: long smooth swells across the wind, crossing a second set, rising the further they are from the watchers.
function dune(x: number, z: number) {
  const a = Math.sin(x * 0.21 + z * 0.37 + Math.sin(z * 0.11) * 1.7);
  const b = Math.sin(x * 0.47 - z * 0.19 + Math.cos(x * 0.13) * 1.3);
  const reach = Math.min(1, Math.hypot(x, z + 3) / 16);
  return (a * 0.6 + b * 0.25) * (0.05 + reach * reach * 2.2);
}

// Each of them sits on a little level of sand at the dune's own height where they are, eased into the dunes round it.
const SEATS: [number, number][] = [[0, 0], ...WATCHERS.map(([x, z]) => [x, z] as [number, number])];
const seatHeight = SEATS.map(([x, z]) => dune(x, z));
function groundAt(x: number, z: number) {
  let best = 0;
  let at = 0;
  SEATS.forEach(([sx, sz], n) => {
    const w = Math.min(1, Math.max(0, 1.4 * (1 - Math.hypot(x - sx, z - sz) / 3.2)));
    if (w > best) (best = w), (at = seatHeight[n]);
  });
  const s = best * best * (3 - 2 * best);
  return dune(x, z) * (1 - s) + at * s;
}

// Chiffon in planetlight: white, matte, a soft sheen; the light behind comes through it (its faces turned from the planet
// glow), and its edges, seen against the planet, are lit along their length.
function chiffon(opacity: number) {
  const material = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.85, metalness: 0, transparent: true, opacity });
  material.colorNode = vec3(0.9, 0.89, 0.87);
  material.sheenNode = vec3(0.3, 0.31, 0.33);
  material.sheenRoughnessNode = float(0.4);
  const toSun = vec3(SUN.x, SUN.y, SUN.z) as any;
  const n = normalWorld as any;
  const toEye = normalize(cameraPosition.sub(positionWorld)) as any;
  const through = max(dot(n, toSun).negate(), 0).pow(1.5).mul(0.3) as any;
  const against = max(dot(toEye, toSun).negate(), 0) as any;
  const edge = pow(float(1).sub(abs(dot(n, toEye))), 2.5).mul(against.pow(0.5)).mul(1.4) as any;
  material.emissiveNode = vec3(EMBER.r, EMBER.g, EMBER.b).mul(through.add(edge)) as any;
  return material;
}

function Watchers({ data }: { data: FigureData }) {
  const parts = useMemo(() => {
    const near = front(data);
    const far = front(data, 3, 2);
    const solid = back(data);
    const inner = body(solid, 0.82);
    const cloth = chiffon(0.95);
    const dark = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    dark.colorNode = vec3(0.22, 0.2, 0.19);
    const group = new THREE.Group();
    const place: [number, number, number, boolean][] = [[0, 0, 0, true], ...WATCHERS.map(([x, z, yaw]) => [x, z, yaw, false] as [number, number, number, boolean])];
    for (const [x, z, yaw, hero] of place) {
      const one = new THREE.Group();
      const f = new THREE.Mesh(hero ? near : far, cloth);
      const b = new THREE.Mesh(solid, cloth);
      const d = new THREE.Mesh(inner, dark);
      b.renderOrder = 1;
      f.renderOrder = 2;
      for (const m of [f, b]) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
      one.add(d, b, f);
      one.position.set(x, groundAt(x, z), z);
      one.rotation.y = yaw;
      group.add(one);
    }
    return { near, far, solid, inner, cloth, dark, group };
  }, [data]);
  useDispose(parts.near, parts.far, parts.solid, parts.inner, parts.cloth, parts.dark);
  return <primitive object={parts.group} />;
}

// The sand: black ash, wind ripples in it, flat where they sit.
function Sand() {
  const parts = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(90, 90, 300, 300);
    geometry.rotateX(-Math.PI / 2);
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) pos.setY(k, groundAt(pos.getX(k), pos.getZ(k)));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.96, metalness: 0 });
    const p = positionGeometry as any;
    const ripple = mx_noise_float(vec3(p.x.mul(1.6).add(p.z.mul(5.5)), p.z.mul(0.8), 0)).mul(0.5).add(0.5) as any;
    const patch = mx_noise_float(p.mul(0.08)).mul(0.5).add(0.5) as any;
    material.colorNode = mix(vec3(0.075, 0.075, 0.08), vec3(0.13, 0.125, 0.125), patch).mul(ripple.mul(0.3).add(0.8));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return { geometry, material, mesh };
  }, []);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// The sky: near black, a faint cold band along the horizon, and the planet: a vast pale disc low behind them, lit on one
// side by a star out of sight, banded with cloud, its rings a thin tilted ellipse across it and a haze of air at its rim.
const PLANET_R = 0.2;
const PU = new THREE.Vector3().crossVectors(SUN, new THREE.Vector3(0, 1, 0)).normalize();
const PV = new THREE.Vector3().crossVectors(PU, SUN).normalize();
function Sky() {
  const parts = useMemo(() => {
    const geometry = new THREE.SphereGeometry(70, 64, 32);
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const d = normalize(positionGeometry) as any;
    const P = vec3(SUN.x, SUN.y, SUN.z) as any;
    const height = max(d.y, 0) as any;
    const zenith = mix(vec3(0.035, 0.045, 0.06), vec3(0.006, 0.007, 0.01), smoothstep(0.0, 0.45, height)) as any;
    const band = float(1).sub(smoothstep(0, 0.1, height)).mul(0.06) as any;
    // Where on the planet's disc, in its own radii.
    const s = Math.sin(PLANET_R);
    const x = dot(d, vec3(PU.x, PU.y, PU.z)).div(s) as any;
    const y = dot(d, vec3(PV.x, PV.y, PV.z)).div(s) as any;
    const front = dot(d, P).greaterThan(0) as any;
    const r2 = x.mul(x).add(y.mul(y)) as any;
    const disc = float(1).sub(smoothstep(0.985, 1.0, r2)).mul(front.select(float(1), float(0))) as any;
    const z = max(float(1).sub(r2), 0).sqrt() as any;
    const lit = max(x.mul(0.62).add(y.mul(0.48)).add(z.mul(0.62)), 0) as any;
    const clouds = mx_noise_float(vec3(x.mul(1.2), y.mul(9), 0)).mul(0.5).add(0.5) as any;
    const face = vec3(0.62, 0.68, 0.78).mul(clouds.mul(0.35).add(0.75)).mul(lit.pow(0.8)).add(vec3(0.012, 0.016, 0.024)) as any;
    const rim = smoothstep(1.25, 1.0, r2).mul(smoothstep(0.92, 1.0, r2)).mul(lit.add(0.25)).mul(front.select(float(1), float(0))) as any;
    // The rings: tilted, seen nearly edge on; in front of the planet's lower half, hidden behind its upper.
    const xr = x.mul(0.94).add(y.mul(0.34)) as any;
    const yr = y.mul(0.94).sub(x.mul(0.34)) as any;
    const e = xr.mul(xr).add(yr.div(0.16).mul(yr.div(0.16))).sqrt() as any;
    const ring = smoothstep(1.45, 1.55, e).mul(float(1).sub(smoothstep(2.1, 2.3, e))).mul(mx_noise_float(vec3(e.mul(14), 0, 0)).mul(0.3).add(0.6)) as any;
    const shown = ring.mul(float(1).sub(disc.mul(yr.greaterThan(0).select(float(1), float(0))))).mul(front.select(float(1), float(0))) as any;
    const sky = zenith.add(vec3(0.3, 0.38, 0.5).mul(band)) as any;
    material.colorNode = mix(sky, face, disc).add(vec3(0.35, 0.45, 0.62).mul(rim.mul(0.5))).add(vec3(0.5, 0.52, 0.56).mul(shown.mul(0.55)));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = -2;
    return { geometry, material, mesh };
  }, []);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// Far off, spires of dark rock standing out of the dunes, half lost in the dust.
function Spires() {
  const parts = useMemo(() => {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    material.colorNode = vec3(0.05, 0.05, 0.055);
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    const spots: [number, number, number, number][] = [
      [-14, -30, 9, 1.6],
      [-8, -38, 14, 2.2],
      [6, -34, 7, 1.3],
      [17, -42, 12, 2],
      [26, -30, 6, 1.4],
      [-24, -36, 8, 1.8]
    ];
    spots.forEach(([x, z, h, w], n) => {
      const g = new THREE.CylinderGeometry(0.15 * w, w, h, 7, 12);
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < pos.count; k++) {
        const y = pos.getY(k);
        const bend = Math.sin(y * 0.4 + n) * 0.25 * w;
        const jag = 1 + 0.25 * Math.sin(y * 2.1 + n * 3) + 0.15 * Math.sin(pos.getX(k) * 5 + y);
        pos.setXYZ(k, pos.getX(k) * jag + bend, y, pos.getZ(k) * jag);
      }
      g.computeVertexNormals();
      geometries.push(g);
      const m = new THREE.Mesh(g, material);
      m.position.set(x, groundAt(x, z) + h / 2 - 0.5, z);
      m.rotation.set(0.05 * Math.sin(n), n, 0.06 * Math.cos(n * 2));
      group.add(m);
    });
    return { material, geometries, group };
  }, []);
  useDispose(parts.material, ...parts.geometries);
  return <primitive object={parts.group} />;
}

function Lights() {
  const parts = useMemo(() => {
    const dusk = new THREE.DirectionalLight(DUSK, 0.22);
    dusk.position.set(3, 4, 6);
    const sky = new THREE.HemisphereLight("#2b3550", "#0a0a0c", 0.22);
    return { dusk, sky };
  }, []);
  return (
    <>
      {/* The planet's light, a spot so it lights the dust, low behind them. */}
      <KeyLight position={SUN_AT} target={[0, 0.6, -3]} color="#c4d6ff" intensity={900} angle={0.42} penumbra={0.6} shadowSize={4096} shadowFar={40} />
      <primitive object={parts.dusk} />
      <primitive object={parts.sky} />
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

  // Wind over open sand, and the music.
  useBed("wind", 0.02);
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
      <Sky />
      <Lights />
      <Sand />
      <Spires />
      <Haze size={[60, 10, 60]} position={[0, 4, -12]} density={0.5} />
      {data && <Watchers data={data} />}
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.7, 1.25, 4.6],
    target: [-0.2, 0.85, -1.2],
    fov: 32,
    phone: { position: [0.4, 1.3, 6.2], target: [-0.2, 0.9, -1.6], fov: 40 },
    limits: { turn: { left: 70, right: 70, up: 25, down: 12 }, move: { left: 0.6, right: 0.6, down: 0.3, up: 0.6, nearer: 2.5, further: 2 } }
  },
  hover: true,
  look: { background: "#07080b", exposure: 1.1, bloom: 0.25, bloomThreshold: 0.8, ao: 0.5, aoRadius: 0.15, vignette: 0.35, grain: 0.04, haze: 0.8 },
  passes: { bounce: false, haze: true },
  hint: "Turn about them.",
  notes: "Shrouded figures on black dunes under a vast planet, its cold light through their chiffon: the figure from a photograph, read by MoGe-3 and made whole in Blender.",
  Scene
};

export default day;
