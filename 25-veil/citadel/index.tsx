"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  cross,
  dot,
  exp,
  float,
  fract,
  normalize,
  positionGeometry,
  sin,
  smoothstep,
  time,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import { orbitPoint } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { Haze, KeyLight, StudioEnvironment } from "../../shared/engine/studio";
import { useAir, Watchers, World, world, type Seat } from "../worlds/common";
import { Citadel, LAMP, SLOT, WALL_Z } from "./architecture";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Veil in the citadel: the figures seated close together on a dark polished floor at the foot of an immense fortress
// wall, small under a colossal carved ring and the tall door in it. The place is dim and cold; a globe lamp burns warm by
// the door, raking its light across the ring, and from a slot far up in the roof a shaft of pale day comes down through
// the dust onto the figures, so that they are the brightest thing there.

// The day through the roof, high behind the eye and to the right; the cloth glows where it comes through.
const AIM: [number, number, number] = [0, 0.7, -1.2];
const KEY = new THREE.Vector3(
  SLOT[0] - AIM[0],
  SLOT[1] - AIM[1],
  SLOT[2] - AIM[2],
).normalize();
// Three, close together, the two behind turned a little in toward the first.
const SEATS: Seat[] = [
  [0, 0, 0, true],
  [-1.15, -0.85, 0.22],
  [1.2, -0.7, -0.28],
];

// The lens stays on whatever the eye is turned about, so the wall and the ring behind them go soft.
function Focus() {
  const camera = useThree((state) => state.camera);
  useFrame(() => {
    if (orbitPoint.current)
      focusDistance.value = Math.max(
        0.6,
        camera.position.distanceTo(orbitPoint.current),
      );
    focusBlur.value = 1.4;
  });
  return null;
}

// Dust hanging in the air: specks drifting slowly, bright where the shaft of day or the lamp's light catches them and
// all but gone in the dark between.
function Motes({ count = 2600 }) {
  const parts = useMemo(() => {
    const seeds = new Float32Array(count * 4);
    let s = 4127;
    const random = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < count * 4; i++) seeds[i] = random();
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const seed = attribute("aSeed", "vec4") as any;
    const box = vec3(9, 7, 12) as any;
    const drift = vec3(
      sin(time.mul(0.07).add(seed.x.mul(30))).mul(0.25),
      time.mul(-0.015),
      sin(time.mul(0.05).add(seed.z.mul(20))).mul(0.25),
    ) as any;
    const centre = fract(seed.xyz.add(drift.div(box)))
      .sub(0.5)
      .mul(box)
      .add(vec3(0.6, 3.3, -4.5)) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    const size = seed.w.mul(0.006).add(0.004) as any;
    material.positionNode = centre
      .add(right.mul(positionGeometry.x.mul(size)))
      .add(upward.mul(positionGeometry.y.mul(size))) as any;
    // How near the shaft's axis, and how near the lamp.
    const a = vec3(...SLOT) as any;
    const d = normalize(
      vec3(AIM[0] - SLOT[0], AIM[1] - SLOT[1], AIM[2] - SLOT[2]),
    ) as any;
    const rel = centre.sub(a) as any;
    const off = rel.sub(d.mul(dot(rel, d))).length() as any;
    const inBeam = exp(off.mul(off).div(-1.6)) as any;
    const toLamp = centre.sub(vec3(...LAMP)).length() as any;
    const byLamp = exp(toLamp.mul(-0.7)) as any;
    const twinkle = sin(time.mul(seed.y.mul(1.5).add(0.4)).add(seed.z.mul(50)))
      .mul(0.35)
      .add(0.65) as any;
    const r = uv().sub(0.5).length() as any;
    const shape = float(1).sub(smoothstep(0.1, 0.5, r)) as any;
    const tint = vec3(0.85, 0.9, 1)
      .mul(inBeam.mul(1.4))
      .add(vec3(1, 0.62, 0.3).mul(byLamp.mul(1.6)))
      .add(0.015) as any;
    material.colorNode = vec4(tint.mul(twinkle).mul(shape), 1) as any;
    const mesh = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    return { quad, material, mesh };
  }, [count]);
  useDispose(parts.quad, parts.material);
  return <primitive object={parts.mesh} />;
}

// The light: the cold dark of the hall all round, a little cool fill from above; the lamp, a warm point by the door and
// a spot from it raking the ring and the door; and the shaft of day down onto the figures.
function Light() {
  const parts = useMemo(() => {
    const room = new THREE.HemisphereLight("#9aa6b8", "#1d1d1e", 0.26);
    const lamp = new THREE.PointLight("#ffb36b", 6, 0, 2);
    lamp.position.set(...LAMP);
    // A faint fill the way the key comes, no shadow, so the far figures and the floor round them are not left black.
    const fill = new THREE.DirectionalLight("#cdd6e4", 0.12);
    fill.position.copy(KEY).multiplyScalar(20);
    // Daylight from high up and to the left, almost along the wall: it grazes down the face, so every streak, pit and
    // joint shows, the tops of the brackets and the beam catch it, and the towers throw long shadows across.
    const sky = new THREE.DirectionalLight("#cfd6e2", 1.5);
    sky.position.set(-16, 50, WALL_Z + 22);
    sky.target.position.set(0, 0, WALL_Z);
    sky.castShadow = true;
    sky.shadow.mapSize.set(2048, 2048);
    const cam = sky.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -45;
    cam.right = cam.top = 45;
    cam.near = 1;
    cam.far = 140;
    sky.shadow.bias = -0.0004;
    sky.shadow.normalBias = 0.04;
    sky.shadow.radius = 4;
    return { room, lamp, fill, sky };
  }, []);
  return (
    <>
      <StudioEnvironment
        ambient="#07080a"
        intensity={0.55}
        boxes={[
          {
            position: [SLOT[0] * 0.15, 6, SLOT[2] * 0.15],
            scale: [0.6, 0.2, 3],
            color: "#e8eef8",
            intensity: 2.2,
          },
          {
            position: [LAMP[0] * 0.4, 0.4, (LAMP[2] - WALL_Z) * 0.4 - 4],
            scale: [0.5, 0.5, 0.5],
            color: "#ffb36b",
            intensity: 9,
          },
          {
            position: [0, 5, 0],
            scale: [8, 0.2, 8],
            color: "#3c4048",
            intensity: 0.5,
          },
        ]}
      />
      <primitive object={parts.room} />
      <primitive object={parts.lamp} />
      <primitive object={parts.fill} />
      <KeyLight
        position={SLOT}
        target={AIM}
        color="#e9eef6"
        intensity={15000}
        angle={0.05}
        penumbra={0.5}
        shadowSize={2048}
        shadowFar={120}
      />
      <primitive object={parts.sky} />
      <primitive object={parts.sky.target} />
      <KeyLight
        position={[LAMP[0] + 0.1, LAMP[1] + 0.05, LAMP[2] + 0.25]}
        target={[-3, 7, WALL_Z]}
        color="#ffad62"
        intensity={42}
        angle={0.75}
        penumbra={0.9}
        shadowSize={1024}
        shadowFar={40}
      />
    </>
  );
}

function Scene({ stone }: { stone: boolean }) {
  useAir("#0c0d0f", 22, 150);
  return (
    <World>
      {(data) => (
        <>
          <Focus />
          <Light />
          <Haze
            size={[66, 62, 70]}
            position={[0, 31, WALL_Z + 35]}
            density={1.8}
          />
          <Citadel />
          <Motes />
          <Watchers data={data} seats={SEATS} keyDir={KEY} stone={stone} />
        </>
      )}
    </World>
  );
}

// The citadel with the figures as they are, veiled in white chiffon; or carved, as statues of pale stone (statue/).
export function citadel(stone: boolean) {
  const day = world(
    () => <Scene stone={stone} />,
    {
      background: "#0c0d0f",
      exposure: 1.1,
      bloom: 0.28,
      bloomThreshold: 1,
      ao: 1,
      aoRadius: 0.3,
      vignette: 0.6,
      grain: 0.014,
      haze: 1,
    },
    "Veiled figures seated together at the foot of a colossal fortress wall, under a carved stone ring and its tall door, a lamp burning by it and a shaft of day falling on them from far up.",
    {
      position: [0.8, 1.0, 2.1],
      target: [-0.05, 1.22, 0],
      fov: 34,
      phone: { position: [0.5, 1.2, 5.2], target: [0, 2.4, -1], fov: 50 },
      limits: {
        turn: { left: 75, right: 75, up: 50, down: 12 },
        move: { left: 3, right: 3, down: 0.4, up: 10, nearer: 1, further: 30 },
      },
    },
  );

  return {
    ...day,
    autoFloor: "medium",
    passes: { ...day.passes, depthOfField: { range: 1.6 } },
  } as typeof day;
}

export default citadel(false);
