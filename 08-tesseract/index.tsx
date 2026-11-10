"use client";

import { useSetting } from "../shared/engine/settings";
import { useMusic } from "../shared/engine/sound";
import type { DayDefinition } from "../shared/engine/types";
import { backdropOptions, paletteOptions } from "./finish";
import type { FormName } from "./forms";
import { useHover } from "./four";
import { Hypercube } from "./hypercube";

function Scene() {
  useMusic("/codevember/music/across-infinite-worlds.mp3", 0.3);
  useHover();
  return <Hypercube form={useSetting<FormName>("form")} />;
}

const tesseract: DayDefinition = {
  camera: { position: [3.1, 4.3, 15.1], target: [0, 3.6, 0], fov: 36 },
  phonePills: ["form"],
  // The heavier forms can push Auto down, and Low has no depth of field, which every form needs.
  autoFloor: "medium",
  extents: { centre: [0, 3.6, 0], radius: 70, color: "#ffe4c8" },
  passes: { bounce: false, haze: false, depthOfField: { range: 8, sharpSky: true } },
  look: { background: "#07050f", ao: 0.3, aoRadius: 0.5, vignette: 0.42, grain: 0.012, bloomThreshold: 1.15 },
  settings: {
    form: {
      type: "choice",
      label: "Form",
      value: "urchin",
      options: [
        { value: "urchin", label: "Urchin" },
        { value: "one", label: "Pipes" },
        { value: "heart", label: "Fractal" },
        { value: "rings", label: "Rings" }
      ]
    },
    cubeThickness: { type: "range", label: "Thickness", min: 0.4, max: 5, step: 0.05, value: 1.45, when: { setting: "form", is: "one" } },
    ringsThickness: { type: "range", label: "Thickness", min: 0.4, max: 5, step: 0.05, value: 3, when: { setting: "form", is: "rings" } },
    heartThickness: { type: "range", label: "Thickness", min: 0.4, max: 5, step: 0.05, value: 1.45, when: { setting: "form", is: "heart" } },
    urchinThickness: { type: "range", label: "Thickness", min: 0.4, max: 5, step: 0.05, value: 1.45, when: { setting: "form", is: "urchin" } },
    heartSize: { type: "range", label: "Size", min: 0.8, max: 1.7, step: 0.01, value: 1.5, when: { setting: "form", is: "heart" } },
    oneSize: { type: "range", label: "Size", min: 0.8, max: 1.7, step: 0.01, value: 1.5, when: { setting: "form", is: "one" } },
    ringsSize: { type: "range", label: "Size", min: 0.8, max: 1.7, step: 0.01, value: 1.5, when: { setting: "form", is: "rings" } },
    urchinSize: { type: "range", label: "Size", min: 0.8, max: 1.7, step: 0.01, value: 1.3, when: { setting: "form", is: "urchin" } },
    oneSpeed: { type: "range", label: "Speed", min: 0, max: 500, step: 1, value: 90, when: { setting: "form", is: "one" } },
    ringsSpeed: { type: "range", label: "Speed", min: 0, max: 500, step: 1, value: 50, when: { setting: "form", is: "rings" } },
    heartSpeed: { type: "range", label: "Speed", min: 0, max: 500, step: 1, value: 45, when: { setting: "form", is: "heart" } },
    urchinSpeed: { type: "range", label: "Speed", min: 0, max: 500, step: 1, value: 50, when: { setting: "form", is: "urchin" } },
    cubePalette: { type: "choice", label: "Colour", value: "oil", options: paletteOptions },
    backdrop: { type: "choice", label: "Background", value: "ember", options: backdropOptions }
  },
  hint: "Drag to push it through the fourth dimension.",
  notes: "A tesseract, the four-dimensional cube, turning itself inside out as it passes through our three dimensions.",
  overview: [
    {
      title: "Rendering",
      points: [
        "React Three Fiber and three.js r187 on the WebGPU renderer. There are no meshes or models: one inside-out sphere fills the screen.",
        "Its pixel shader, written in TSL and compiled to WGSL, ray marches signed distance fields for every pixel."
      ]
    },
    {
      title: "The fourth dimension",
      points: [
        "The tesseract lives on the 3-sphere, turned by a 4×4 matrix, then brought down by stereographic projection, so straight edges arrive as circles.",
        "Folding by symmetry turns 32 edges into 4 arcs and 16 joints into 1, so each step tests only a handful of shapes."
      ]
    },
    {
      title: "Forms",
      points: [
        "Fractal: a Mandelbulb in every joint, its power drifting between about 5.4 and 8.6, worked out once thanks to the fold.",
        "Urchin: 16 metaballs smooth-unioned into one mass, with needles on a grid wrapped around it, each breathing on its own."
      ]
    },
    {
      title: "Optimisations",
      points: [
        "Sums of squared differences replace 2 − 2cos, which removed a speckle caused by lost float precision on far tubes.",
        "Colour and background change through uniforms without recompiling; Auto lowers resolution first, then quality, never below Medium."
      ]
    }
  ],
  Scene
};

export default tesseract;
