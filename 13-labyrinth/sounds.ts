"use client";

import { sound, useBed, useEvery } from "../shared/engine/sound";
import type { Style } from "./styles";

// What the maze sounds like around you, and what your feet sound like in it, by style. The natural maze is an evening
// garden: a breath of wind, crickets coming up, birds still singing here and there, and gravel underfoot. The Tron maze
// is a machine: a low mains hum and a cold synthetic shimmer over it, data chirping past in short blips, now and then a
// relay clicking somewhere in the walls, and the grid ringing under each step. Changing style glides one into the other.
export const FOOTSTEPS: Record<Style, string> = { natural: "gravel", tron: "grid" };

const anywhere = () => Math.random() * 1.6 - 0.8;

export function useAmbience(style: Style) {
  const tron = style === "tron";
  useBed("wind", tron ? 0 : 0.16);
  useBed("crickets", tron ? 0 : 0.06);
  useBed("hum", tron ? 0.16 : 0);
  useBed("shimmer", tron ? 0.12 : 0);
  useEvery(1.2, 4.5, () => sound.play("chirp", { gain: 0.16 + Math.random() * 0.12, pan: anywhere(), pitch: 0.85 + Math.random() * 0.4 }), !tron);
  useEvery(0.4, 2.2, () => sound.play("blip", { gain: 0.12 + Math.random() * 0.12, pan: anywhere(), pitch: 0.7 + Math.random() * 0.9 }), tron);
  useEvery(3, 9, () => sound.play("click", { gain: 0.25 + Math.random() * 0.2, pan: anywhere(), pitch: 0.5 + Math.random() * 0.4 }), tron);
}
