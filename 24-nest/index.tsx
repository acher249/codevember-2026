import type { DayDefinition } from "../shared/engine/types";
import warm from "./warm";

// Takes on Nest, picked with ?v= in the address (development only). Loaded by a pattern rather than by name, so a
// version still being built never stops the others compiling.
const VERSIONS = ["warm", "polaroid", "pet"];

// The version that goes out: Warm, with the day's technical overview.
const day: DayDefinition = {
  ...warm,
  overview: [
    {
      title: "The dial",
      points: [
        "One number drives the whole scene: the room's temperature, easing after the set one. Snow, frost, wet, light, snowfall and the chicks' mood all follow it through shared uniforms, so turning the dial changes no geometry and compiles nothing",
        "The display is drawn by its shader from a sheet of glyphs painted once at load: digits, ticks lit from the room's temperature to the set one, HEATING or a leaf",
        "Left alone, it goes Away: the word blinks, then the dial turns itself back to the coldest setting the way a hand would, clicking through its detents, and the whole scene follows it"
      ]
    },
    {
      title: "Snow and melt",
      points: [
        "Snow lies as a second draw of each limb, the nest's rim and the dial's ring, pushed out along the normals by how upward they face and patchy noise; as it melts the caps thin and break up",
        "Meltwater drips are one instanced draw, swelling and falling in the vertex shader"
      ]
    },
    {
      title: "Nest and chicks",
      points: [
        "The nest is a couple of hundred bark-scanned twigs and fifteen hundred grass strands wound round the cup, merged into a handful of draws",
        "The chicks' down grows in tufts of fine barbs, each a camera-facing ribbon; puffed out in the cold, sleek in the heat"
      ]
    }
  ]
};

export default day;

// In development any version can be picked with ?v= in the address; a production build has only Warm.
export async function loadVersion(): Promise<{ default: DayDefinition }> {
  if (process.env.NODE_ENV !== "production") {
    const asked = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("v");
    const version = asked && VERSIONS.includes(asked) ? asked : VERSIONS[0];
    if (version !== "warm") return (await import(`./${version}/index.tsx`)) as { default: DayDefinition };
  }
  return { default: day };
}
