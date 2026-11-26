import type { DayDefinition } from "../shared/engine/types";
import ember from "./ember";

// Takes on Veil, each its own world, picked with ?v= in the address (development only). Loaded by a pattern rather than
// by name, so a version still being built never stops the others compiling.
const VERSIONS = ["ember", "storm", "neon", "gold", "eclipse", "citadel", "statue", "hall", "monolith", "terraces", "canyon", "gate", "dune", "photo", "shroud", "hood", "fog"];

// The version that goes out: the statues before a blurred world (its colour, material and the rest chosen in the panel),
// with the day's technical overview.
const day: DayDefinition = {
  ...ember,
  overview: [
    {
      title: "Cloth in Blender",
      points: [
        "Blender's cloth solver first draped sheets over a seated CC0 body, headless: pinned at the crown, colliding, baked offline.",
        "None held the wrapped layers we wanted, so the front was built from a depth map; the unseen back is a cloth sim on a shell.",
        "A 5 mm cloth sim in a slow breeze, its folds kept whole, baked as a 14 s loop into a GPU texture the vertex shader reads."
      ]
    },
    {
      title: "Structure from a depth map",
      points: [
        "MoGe-3 ViT-G gives metric depth and normals for the front; smoothed along its folds, not across, and deepened where they read faint.",
        "The front ships as a 16-bit depth grid, built into a mesh in a worker off the main thread; phones build every other pixel."
      ]
    },
    {
      title: "Stone, glass and light",
      points: [
        "Marble, glass and obsidian are TSL nodes reflecting or bending a procedural room in the background's colours; the floor is the same.",
        "Behind them, Tension's recipe: a sky of soft blots and drifting bokeh, held out of focus by depth of field on the statues.",
        "Glitch moshes between materials: each is drawn behind one shared mask of macroblocks that corrupt, drift and decode wrong."
      ]
    }
  ]
};

export default day;

// In development any version can be picked with ?v= in the address; a production build has only the one above.
export async function loadVersion(): Promise<{ default: DayDefinition }> {
  if (process.env.NODE_ENV !== "production") {
    const asked = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("v");
    const version = asked && VERSIONS.includes(asked) ? asked : VERSIONS[0];
    if (version !== "ember") return (await import(`./${version}/index.tsx`)) as { default: DayDefinition };
  }
  return { default: day };
}
