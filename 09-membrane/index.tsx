"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { color, mix, normalize, positionWorld, pow, smoothstep } from "three/tsl";
import { orbitPoint } from "../shared/engine/controls";
import { focusBlur, focusDistance } from "../shared/engine/Post";
import { useSettingsStore } from "../shared/engine/settings";
import { sound, useBed, useMusic } from "../shared/engine/sound";
import { useLook } from "../shared/engine/Stage";
import { KeyLight, StudioEnvironment, StudioFloor } from "../shared/engine/studio";
import type { DayDefinition } from "../shared/engine/types";
import { FORM_OPTIONS, Tiles } from "./tiles";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A soft studio gradient: warm grey overhead, falling to near black below, with the floor fading into its horizon.
const SKY_TOP = "#6b645c";
const HORIZON = "#2c2926";
const BACKGROUND = "#171516";


const STUDIO_LOOK = { background: BACKGROUND, exposure: 1.15, bloom: 0.1, bloomThreshold: 1.25, ao: 1.25, aoRadius: 0.32, vignette: 0.46, grain: 0.012 };

// The backdrop: a great sphere around everything, shaded by height.
function Backdrop() {
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const up = (normalize(positionWorld) as any).y;
    const above = pow(smoothstep(-0.05, 0.9, up), 0.8) as any;
    const below = smoothstep(0.05, -0.6, up) as any;
    m.colorNode = mix(mix(color(HORIZON), color(SKY_TOP), above), color(BACKGROUND), below);
    return m;
  }, []);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh material={material} renderOrder={-1} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[60, 48, 24]} />
    </mesh>
  );
}

// Keeps the lens on the front of whatever is being peeled, so its far side and the room behind fall softly out of focus.
function Focus() {
  const camera = useThree((state) => state.camera);
  useFrame(() => {
    if (orbitPoint.current) focusDistance.value = Math.max(0.5, camera.position.distanceTo(orbitPoint.current) - 0.9);
    focusBlur.value = 0.9;
  });
  return null;
}

function Scene() {
  return <Studio />;
}

// Choosing a peel sound plays it, so they can be compared one after another.
function PeelPreview() {
  const store = useSettingsStore();
  useEffect(() => {
    let last = store.get("peelSound");
    return store.subscribe(() => {
      const now = store.get("peelSound");
      if (now !== last) sound.play("peel", { variant: String(now), gain: 0.8 });
      last = now;
    });
  }, [store]);
  return null;
}

// A lit studio with a floor, and the object.
function Studio() {
  useBed("hum", 0.09);
  useMusic("/codevember/music/radiant-echoes.mp3", 0.11);
  useLook(STUDIO_LOOK);
  return (
    <>
      <Backdrop />
      <PeelPreview />
      <Focus />
      {/* Soft boxes for the glaze to reflect: a big warm one overhead, cool and warm strips either side, a rim behind. */}
      <StudioEnvironment
        ambient="#1c1a19"
        intensity={1.1}
        boxes={[
          { position: [0, 7, 0], scale: [6, 0.2, 6], color: "#fff3e6", intensity: 2.6 },
          { position: [-7, 2.5, 2], scale: [0.2, 6, 2], color: "#cfdcff", intensity: 1.7 },
          { position: [7, 2.5, -1], scale: [0.2, 6, 2], color: "#ffdcbd", intensity: 1.9 },
          { position: [0, 3, -8], scale: [8, 3, 0.2], color: "#ffffff", intensity: 1.3 },
          { position: [0, 2, 8], scale: [3, 2, 0.2], color: "#ffffff", intensity: 0.3 }
        ]}
      />
      <KeyLight position={[2.8, 6.8, 3.4]} target={[0, 1.2, 0]} color="#fff2e4" intensity={300} angle={0.45} penumbra={0.9} />
      <StudioFloor background={HORIZON} color="#262321" roughness={0.55} radius={14} />
      <Tiles />
    </>
  );
}

const membrane: DayDefinition = {
  camera: { position: [0.5, 2.2, 4.6], target: [0, 1.4, 0], fov: 36 },
  phonePills: ["form"],
  extents: { centre: [0, 2, 0], radius: 30, floor: 0, color: "#ffc6dc" },
  passes: { haze: false, bounce: false, depthOfField: { range: 5 } },
  look: { background: BACKGROUND, exposure: 1.15, bloom: 0.1, bloomThreshold: 1.25, gi: 3, ao: 1.25, aoRadius: 0.32, vignette: 0.46, grain: 0.012 },
  settings: {
    form: { type: "choice", label: "Shape", value: "sphere", options: FORM_OPTIONS },
    flakeSize: { type: "range", label: "Flake size", min: 0.05, max: 0.5, step: 0.01, value: 0.15 },
    peelSound: {
      type: "choice",
      label: "Peel sound",
      value: "paper",
      options: [
        { value: "paper", label: "Paper" },
        { value: "clay", label: "Clay" }
      ]
    },
    auto: { type: "toggle", label: "Peel by itself", value: false },
    peel: { type: "action", label: "Peel one" }
  },
  hint: "Swipe across the skin to peel it off as fast as you move. Click it for a slow ripple.",
  notes: "A smooth clay skin over a sphere, a ring, a cube or a knot, and another skin under it, for ever. Swipe and it peels away in curls that float off.",
  overview: [
    {
      title: "Rendering",
      points: [
        "React Three Fiber and three.js r187 on the WebGPU renderer, with every surface a TSL node material.",
        "Lit by a soft studio of light boxes baked into an environment map, plus one shadow-casting key light."
      ]
    },
    {
      title: "Peeling",
      points: [
        "Each tile bends in the vertex shader: past the fold it rolls over a cylinder, then carries on straight, with its normals turned by hand.",
        "A swipe sets how fast each tile comes off and how hard it is thrown; a click sends a slow ripple out from where it landed."
      ]
    },
    {
      title: "Floating",
      points: [
        "Each tile turns grey as it rolls over, darker if its layer is light and lighter if it is dark.",
        "Loose tiles fall like leaves, swaying as they go, slide off the slippery glaze and settle on the floor before they sink away."
      ]
    },
    {
      title: "Optimisations",
      points: [
        "Two instanced meshes draw every tile and the layer under it; per-tile fold, lift and layer go in instance attributes each frame.",
        "Every layer is printed with the next one's colours underneath, so nothing runs out: a spent tile simply becomes the layer below."
      ]
    }
  ],
  Scene
};

export default membrane;
