"use client";

import { useThree } from "@react-three/fiber";
import { use, useEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three/webgpu";
import { attribute, dot, float, max, mix, mx_noise_float, normalize, normalWorld, positionGeometry, positionWorld, smoothstep, vec3 } from "three/tsl";
import { orbitPoint } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { Haze, KeyLight, StudioEnvironment } from "../../shared/engine/studio";
import { useBed, useMusic } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { bump } from "../citadel/bump";
import { loadBuilt, parts as figureParts, release, type FigureData } from "../photo/figure";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What the five worlds of Veil share: the seated figure from the photograph (photo/figure.ts), several of her, lit as the
// photograph is lit (a big soft light high to one side, the whole place bright with its bounce, light coming through
// the cloth), on pale sand; each world adds its own architecture round them.

// A seat: x, z, which way she is turned (radians), and whether she is the near one, drawn at full detail.
export type Seat = [number, number, number, boolean?];

// Chiffon as in the photograph: white, matte with a soft sheen. Bright light all round fills even its shaded side (light
// passes through and across thin cloth, so it never goes dark the way solid cloth does), and where it is turned from the
// key the key comes through it. Where her body lies close under it (the front's `under`), it greys over her, as sheer
// cloth does over a figure, and takes less light through; where it hangs free it stays bright.
export function chiffon(key: THREE.Vector3, over: boolean) {
  const material = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.8, metalness: 0 });
  const under = (over ? attribute("under", "float") : float(0)) as any;
  material.colorNode = mix(vec3(0.96, 0.95, 0.93), vec3(0.55, 0.53, 0.51), under.mul(0.6));
  material.sheenNode = vec3(0.55, 0.55, 0.56);
  material.sheenRoughnessNode = float(0.35);
  const toKey = normalize(vec3(key.x, key.y, key.z)) as any;
  const through = max(dot(normalWorld, toKey).negate(), 0).pow(1.1).mul(0.42) as any;
  material.emissiveNode = vec3(1, 0.97, 0.92).mul(through.add(0.1)).mul(float(1).sub(under.mul(0.7))) as any;
  return material;
}

// Or carved: the same figure as a statue of pale limestone, weathered. Patches of tone across the block, a fine grain
// and pitting standing in relief, dark grime gathered where the folds dip and the stone faces down, and a little paler
// where it turns up to the light.
export function limestone() {
  const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
  const p = positionWorld as any;
  const patch = mx_noise_float(p.mul(3)).mul(0.5).add(0.5) as any;
  const vein = mx_noise_float(p.mul(vec3(9, 2.2, 9))).abs() as any;
  const grain = mx_noise_float(p.mul(140)) as any;
  const pits = smoothstep(0.7, 0.9, mx_noise_float(p.mul(90)).mul(0.5).add(0.5)) as any;
  const facing = normalWorld.y as any;
  const grime = smoothstep(0.2, -0.6, facing).mul(0.18) as any;
  const base = mix(vec3(0.66, 0.62, 0.56), vec3(0.76, 0.73, 0.67), patch) as any;
  material.colorNode = base
    .mul(float(1).sub(grime))
    .mul(float(1).sub(smoothstep(0.06, 0.0, vein).mul(0.08)))
    .mul(float(1).sub(pits.mul(0.1)))
    .add(grain.mul(0.02))
    .add(smoothstep(0.5, 1, facing).mul(0.04));
  material.normalNode = bump(grain.mul(0.00015).sub(pits.mul(0.0003))) as any;
  return material;
}

// The ground where none is given: flat. One function, not a new one each time they are drawn, which made them over each
// time (and recompiled their shaders).
const FLAT = () => 0;

// `make`, if given, makes what they are of instead (blur/materials.ts).
export function Watchers({ data, seats, keyDir, groundAt = FLAT, stone = false, make }: { data: FigureData; seats: Seat[]; keyDir: THREE.Vector3; groundAt?: (x: number, z: number) => number; stone?: boolean; make?: () => THREE.Material }) {
  const parts = useMemo(() => {
    // The meshes are the figure's, shared, and freed with the world (World).
    const { near, far, solid, hem } = figureParts(data);
    const solidly = stone || !!make;
    const cloth = make ? make() : stone ? limestone() : chiffon(keyDir, true);
    const behind = solidly ? cloth : chiffon(keyDir, false);
    const group = new THREE.Group();
    for (const [x, z, yaw, hero] of seats) {
      const one = new THREE.Group();
      const f = new THREE.Mesh(hero ? near : far, cloth);
      const b = new THREE.Mesh(solid, behind);
      const h = new THREE.Mesh(hem, behind);
      h.receiveShadow = true;
      // They cast shadows but take none: on cloth, a shadow map from a light far off falls as blotches over its folds.
      f.castShadow = b.castShadow = true;
      // Stone takes its shadows like any stone.
      f.receiveShadow = b.receiveShadow = solidly;
      one.add(b, f, h);
      one.position.set(x, groundAt(x, z), z);
      one.rotation.y = yaw;
      group.add(one);
    }
    return { cloth, behind, group };
  }, [data, seats, keyDir, groundAt, stone, make]);
  // Set as drawn, not in the memo: React's development double call of a memo would leave it pointing at the copy not drawn.
  useDispose(parts.cloth, ...(stone || make ? [] : [parts.behind]));
  return <primitive object={parts.group} />;
}

// Stone, sand and the like: a base colour, broken by slow patches and fine grain so no face is flat.
// With `course` (metres), laid in blocks: courses of that height, joints between blocks staggered course to course.
export function stone(base: [number, number, number], variation = 0.12, grain = 0.04, scale = 0.6, course = 0) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const p = positionWorld as any;
  const patch = mx_noise_float(p.mul(scale)).mul(0.5).add(0.5) as any;
  const fine = mx_noise_float(p.mul(scale * 40)) as any;
  let colour = vec3(...base).mul(float(1 - variation).add(patch.mul(variation * 2))).add(fine.mul(grain)) as any;
  if (course) {
    const row = p.y.div(course) as any;
    const along = p.x.add(p.z).div(course * 2.7).add(row.floor().mul(0.5)) as any;
    const joint = max(float(1).sub(smoothstep(0.0, 0.025, row.fract().min(float(1).sub(row.fract())))), float(1).sub(smoothstep(0.0, 0.012, along.fract().min(float(1).sub(along.fract()))))) as any;
    const block = mx_noise_float(vec3(row.floor(), along.floor(), 0)).mul(0.06) as any;
    colour = colour.mul(float(1).sub(joint.mul(0.45))).add(block);
  }
  material.colorNode = colour;
  return material;
}

// Pale sand, wind-rippled, as far as the eye goes; `height` shapes it.
export function Sand({ size = 160, segments = 320, color = [0.76, 0.68, 0.58] as [number, number, number], height }: { size?: number; segments?: number; color?: [number, number, number]; height?: (x: number, z: number) => number }) {
  const parts = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    if (height) {
      const pos = geometry.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < pos.count; k++) pos.setY(k, height(pos.getX(k), pos.getZ(k)));
    }
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.97, metalness: 0 });
    const p = positionGeometry as any;
    const ripple = mx_noise_float(vec3(p.x.mul(1.4).add(p.z.mul(5)), p.z.mul(0.7), 0)).mul(0.5).add(0.5) as any;
    const patch = mx_noise_float(p.mul(0.06)).mul(0.5).add(0.5) as any;
    material.colorNode = mix(vec3(...color).mul(0.9), vec3(...color).mul(1.06), patch).mul(ripple.mul(0.12).add(0.94));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return { geometry, material, mesh };
  }, [size, segments, color, height]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// The photograph's light: one big soft key, the bounce of a bright place all round it, and soft boxes for the environment.
export function PhotoLight({
  keyDir,
  intensity = 1.35,
  color = "#fff6ec",
  hemi = ["#ffffff", "#d9d1c6", 0.45],
  ambient = "#b0aaa2",
  boxes,
  shadow = 3
}: {
  keyDir: THREE.Vector3;
  intensity?: number;
  color?: string;
  hemi?: [string, string, number];
  ambient?: string;
  boxes?: { position: [number, number, number]; scale: [number, number, number]; color: string; intensity: number }[];
  shadow?: number;
}) {
  const parts = useMemo(() => {
    const key = new THREE.DirectionalLight(color, intensity);
    key.position.copy(keyDir).multiplyScalar(12);
    key.target.position.set(0, 0.7, -2);
    key.castShadow = true;
    key.shadow.mapSize.set(4096, 4096);
    const cam = key.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -shadow * 3;
    cam.right = cam.top = shadow * 3;
    cam.near = 1;
    cam.far = 40;
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 8;
    const room = new THREE.HemisphereLight(hemi[0], hemi[1], hemi[2]);
    return { key, room };
  }, [keyDir, intensity, color, hemi, shadow]);
  return (
    <>
      <StudioEnvironment
        ambient={ambient}
        intensity={1}
        boxes={
          boxes ?? [
            { position: [keyDir.x * 4, keyDir.y * 4, keyDir.z * 4], scale: [4, 3.5, 0.2], color: "#fff6ec", intensity: 3.5 },
            { position: [0, 5, 0], scale: [6, 0.2, 6], color: "#ffffff", intensity: 1 }
          ]
        }
      />
      <primitive object={parts.key} />
      <primitive object={parts.key.target} />
      <primitive object={parts.room} />
    </>
  );
}

// A shaft of sunlight through dust: a hard spot (it lights the haze, so the beam shows) and, if given a box, the dust.
export function Shaft({ from, to, intensity, angle = 0.12, color = "#fff3e2", dust = 0.6, box }: { from: [number, number, number]; to: [number, number, number]; intensity: number; angle?: number; color?: string; dust?: number; box?: { size: [number, number, number]; position: [number, number, number] } }) {
  return (
    <>
      <KeyLight position={from} target={to} color={color} intensity={intensity} angle={angle} penumbra={0.25} shadowSize={2048} shadowFar={120} />
      {box && <Haze size={box.size} position={box.position} density={dust} />}
    </>
  );
}

// Air: the far architecture fading into the pale of the day, as in a dusty desert.
export function useAir(color: string, near: number, far: number) {
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const before = scene.fog;
    scene.fog = new THREE.Fog(color, near, far);
    return () => {
      scene.fog = before;
    };
  }, [scene, color, near, far]);
}

// A world's scene: the figure loaded once, the sound, the development hooks, and the world's own things round her.
// The figure, loaded once and shared. World waits on it (Suspense): the engine keeps its loader up until the statues are
// in the scene, so they are built and their shaders compiled behind it, not in a freeze on the first frames after it.
// It is fetched and its meshes built in a worker, so the loader keeps moving meanwhile.
let figure: Promise<FigureData> | null = null;
function figureOnce() {
  figure ??= loadBuilt().catch((error) => {
    figure = null;
    throw error;
  });
  return figure;
}

export function World({ children }: { children: (data: FigureData) => ReactNode }) {
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  const gl = useThree((state) => state.gl);
  const data = use(figureOnce());
  // The figure's meshes freed when the world goes; not on React's development double mount, which comes straight back.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.setTimeout(() => {
        if (!mounted.current) release(data);
      }, 0);
    };
  }, [data]);
  useBed("wind", 0.012);
  useMusic("/codevember/music/across-the-silent-sands.mp3", 0.3);
  if (process.env.NODE_ENV !== "production")
    Object.assign(globalThis, {
      __veil: { ready: () => true, camera, scene, gl },
      __view: (from: number[], to: number[]) => {
        camera.position.set(from[0], from[1], from[2]);
        orbitPoint.current?.set(to[0], to[1], to[2]);
        camera.lookAt(to[0], to[1], to[2]);
      }
    });
  return <>{children(data)}</>;
}

// The shared framing: a little behind and above where the photograph was taken, so there is room for the place round her.
export function world(Scene: () => ReactNode, look: Partial<DayDefinition["look"]> & { background: string }, notes: string, camera?: Partial<DayDefinition["camera"]>): DayDefinition {
  return {
    camera: {
      position: [0.5, 1.35, 6],
      target: [0, 1.5, -4],
      fov: 36,
      phone: { position: [0.3, 1.4, 7.6], target: [0, 1.5, -4], fov: 44 },
      limits: { turn: { left: 70, right: 70, up: 30, down: 12 }, move: { left: 1, right: 1, down: 0.4, up: 1, nearer: 3, further: 3 } },
      ...camera
    },
    hover: true,
    look: { exposure: 1.0, bloom: 0.05, bloomThreshold: 1, ao: 0.45, aoRadius: 0.15, vignette: 0.2, grain: 0.02, haze: 0.9, ...look } as DayDefinition["look"],
    passes: { bounce: false, haze: true },
    hint: "Turn about them.",
    notes,
    Scene: Scene as DayDefinition["Scene"]
  };
}
