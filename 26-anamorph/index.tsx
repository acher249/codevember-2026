import type { DayDefinition } from "../shared/engine/types";
import pool from "./pool";

// Takes on Anamorph, picked with ?v= in the address (development only). Loaded by a pattern rather than by name, so a
// version still being built never stops the others compiling.
const VERSIONS = ["pool", "pit", "lava", "ocean", "subway", "crystal", "chalk"];

// The version that goes out: the pool on the brownstone sidewalk (the others are picked from its panel), with the
// day's technical overview.
const day: DayDefinition = {
  ...pool,
  overview: [
    {
      title: "The chalk is a photograph",
      points: [
        "Each painting is a real 3D scene; the chalk is a picture of it rendered from one eye point, projected flat onto the sidewalk.",
        "Taken at twice the view's resolution through the view's own lens, so at the spot the swap to 3D matches to about 3/255.",
        "Chalk strokes and eraser wipes sweep in arcs, kept inside each painting's outline by per-row spans worked out once."
      ]
    },
    {
      title: "Six paintings, kept warm",
      points: [
        "Pool, pit, lava, ocean, crystal and subway are all built once behind the loader, their shaders compiled under the sidewalk.",
        "The view eases through the spot and the painting turns real on that frame; going back, everything glides home as it sweeps in.",
        "Painting lights live on their own layer; the sun's shadow is redrawn only when something casting it moves."
      ]
    },
    {
      title: "A Brooklyn block",
      points: [
        "Brownstone stoops, parked cars, hoop racks and shops, with grime baked into every corner and thousands of instanced leaves.",
        "Depth of field keeps the drawing sharp and lets the block go soft; chalk and eraser sounds loop only while the tools move."
      ]
    }
  ]
};

export default day;

// In development any version can be picked with ?v= in the address; a production build has only the pool.
export async function loadVersion(): Promise<{ default: DayDefinition }> {
  if (process.env.NODE_ENV !== "production") {
    const asked = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("v");
    const version = asked && VERSIONS.includes(asked) ? asked : VERSIONS[0];
    if (version !== "pool") return (await import(`./${version}/index.tsx`)) as { default: DayDefinition };
  }
  return { default: day };
}
