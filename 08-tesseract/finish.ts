import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { clamp, color, cos, dot, float, Fn, max, mix, normalize, pow, sin, smoothstep, uniform, vec3 } from "three/tsl";
import { useSetting } from "../shared/engine/settings";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Colour schemes, each a whole gradient from Inigo Quilez's cosine palette: base + amount * cos(2π(t + phase)).
export const PALETTES: Record<string, { label: string; swatch: string[]; base: number[]; amount: number[]; phase: number[] }> = {
  oil: { label: "Oil", swatch: ["#e2b04f", "#c23d8e", "#2f6fd6"], base: [0.5, 0.5, 0.5], amount: [0.5, 0.5, 0.5], phase: [0.02, 0.2, 0.42] },
  silver: { label: "Silver", swatch: ["#f2f4f7", "#a9afba", "#4b5059"], base: [0.66, 0.67, 0.7], amount: [0.3, 0.3, 0.3], phase: [0, 0, 0] }
};

// What the shape floats in. Each sets the room the mirrors reflect, and `sky` is how much of it you see directly.
export const BACKDROPS: Record<string, { label: string; low: string; high: string; stripes: string; sky: number; swatch: string[] }> = {
  night: { label: "Night", low: "#0b0824", high: "#25406f", stripes: "#dfe8ff", sky: 0.15, swatch: ["#0b0824", "#25406f"] },
  black: { label: "Black", low: "#0b0824", high: "#25406f", stripes: "#dfe8ff", sky: 0, swatch: ["#000000", "#16161a"] },
  ember: { label: "Ember", low: "#d99a6c", high: "#fff8f2", stripes: "#a8714c", sky: 0.95, swatch: ["#d99a6c", "#fff8f2"] },
  violet: { label: "Violet", low: "#12042a", high: "#5a1f9a", stripes: "#ff9be8", sky: 0.3, swatch: ["#12042a", "#7a35c9"] },
  studio: { label: "Studio", low: "#6d7078", high: "#f2f1ee", stripes: "#ffffff", sky: 0.62, swatch: ["#8b8f98", "#f2f1ee"] }
};

export const backdropOptions = Object.entries(BACKDROPS).map(([value, backdrop]) => ({ value, label: backdrop.label, swatch: backdrop.swatch }));

export const paletteOptions = Object.entries(PALETTES).map(([value, palette]) => ({ value, label: palette.label, swatch: palette.swatch }));

// The light never moves.
const scratch = new THREE.Color();
const KEY = new THREE.Vector3(Math.sin(-0.66), 0.6, Math.cos(-0.66)).normalize();

// One study's look, as uniforms, so that changing colour never rebuilds the shader. `finish` runs from satin at 0 to a mirror at 1.
export function useFinish(prefix: string, finish: number) {
  const name = useSetting<string>(`${prefix}Palette`);
  const backdrop = useSetting<string>("backdrop");
  const start = BACKDROPS[backdrop] ?? BACKDROPS.night;
  const look = useMemo(
    () => ({
      finish: uniform(finish) as any,
      key: uniform(KEY) as any,
      base: uniform(new THREE.Vector3(0.5, 0.5, 0.5)) as any,
      amount: uniform(new THREE.Vector3(0.5, 0.5, 0.5)) as any,
      phase: uniform(new THREE.Vector3(0.02, 0.2, 0.42)) as any,
      // Starts in the chosen room rather than fading into it.
      low: uniform(new THREE.Color(start.low)) as any,
      high: uniform(new THREE.Color(start.high)) as any,
      stripes: uniform(new THREE.Color(start.stripes)) as any,
      sky: uniform(start.sky) as any
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- later changes ease in below.
    [finish]
  );
  const target = useRef(PALETTES.oil);
  target.current = PALETTES[name] ?? PALETTES.oil;
  const room = useRef(BACKDROPS.night);
  room.current = BACKDROPS[backdrop] ?? BACKDROPS.night;
  useFrame((_, delta) => {
    const ease = 1 - Math.exp(-Math.min(delta, 0.05) * 5);
    // Colours slide into one another rather than snapping.
    for (const key of ["base", "amount", "phase"] as const) {
      const [x, y, z] = target.current[key];
      look[key].value.x += (x - look[key].value.x) * ease;
      look[key].value.y += (y - look[key].value.y) * ease;
      look[key].value.z += (z - look[key].value.z) * ease;
    }
    for (const key of ["low", "high", "stripes"] as const) look[key].value.lerp(scratch.set(room.current[key]), ease);
    look.sky.value += (room.current.sky - look.sky.value) * ease;
  });
  return look;
}

export type FinishLook = ReturnType<typeof useFinish>;

// The dark hall both studies live in: no scene, only maths. Soft striped light is what makes metal read as liquid.
export function makeHall(name: string, look: FinishLook, time: any) {
  return Fn(([ray]: any[]) => {
    const stripes = pow(sin(ray.y.mul(5).add(ray.x.mul(1.4)).add(sin(ray.z.mul(3).add(time.mul(0.12))).mul(0.9))).mul(0.5).add(0.5), float(5)) as any;
    const gradient = mix(look.low, look.high, ray.y.mul(0.5).add(0.5)) as any;
    const warm = (color("#ffb186") as any).mul(pow(max(dot(ray, look.key), float(0)), float(5)).mul(3)) as any;
    return gradient.add(look.stripes.mul(stripes).mul(2.1)).add(warm);
  }).setLayout({ name: `${name}Hall`, type: "vec3", inputs: [{ name: "ray", type: "vec3" }] }) as any;
}

// How a surface takes the light, anywhere from satin to a perfect mirror. `reflected` is what a mirror here would see, `held` is the ambient
// occlusion and `lit` is the soft shadow from the key light.
export function shadeSurface({ look, normal, ray, band, reflected, held, lit }: { look: FinishLook; normal: any; ray: any; band: any; reflected: any; held: any; lit: any }) {
  const facing = clamp(dot(normal, ray.negate()), 0, 1) as any;
  const film = look.base.add(look.amount.mul(cos(facing.mul(1.3).add(band).add(look.phase).mul(6.28318)))) as any;
  const edge = pow(float(1).sub(facing), float(5)) as any;
  const grip = smoothstep(0.1, 0.9, held) as any;
  const mirror = reflected.mul(mix(film.mul(0.86).add(0.14), vec3(1), edge)).mul(mix(float(0.18), float(1), grip)) as any;

  const halfway = normalize(look.key.sub(ray)) as any;
  const toLight = max(dot(normal, look.key), float(0)) as any;
  const keyColour = (color("#ffd9b8") as any).mul(1.55) as any;
  const under = mix(color("#0d0a26") as any, color("#2f4a7c") as any, normal.y.mul(0.5).add(0.5)) as any;
  const sheen = pow(max(dot(normal, halfway), float(0)), float(36)).mul(0.42).add(edge.mul(0.3)) as any;
  const satin = film.mul(keyColour.mul(toLight).mul(lit).add(under.mul(mix(float(0.2), float(1), grip)))).add(keyColour.mul(sheen).mul(lit.mul(0.8).add(0.2))) as any;
  return mix(satin, mirror, look.finish);
}

