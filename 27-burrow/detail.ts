import * as THREE from "three/webgpu";
import { caveShade } from "./fx";
import { float, mix, mx_noise_float, mx_noise_vec3, normalize, normalWorld, positionWorld, smoothstep, transformNormalToView } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Old bone and fossil shell, weathered: pitted in its surface (a normal from noise in the world, so
// pieces of one shape do not repeat), rougher in the pits and a touch polished on the high points, and stained dark
// where the dirt sits. `colour` is the material's own colour node; `size` the scale of the pitting in metres.
export function weathered(m: THREE.MeshStandardNodeMaterial, colour: any, rough: number, size = 0.03) {
  const p = positionWorld.div(size) as any;
  const pits = mx_noise_float(p) as any;
  const bump = mx_noise_vec3(p)
    .mul(0.18)
    .add(mx_noise_vec3(p.mul(3.1)).mul(0.06)) as any;
  m.aoNode = caveShade();
  m.normalNode = transformNormalToView(normalize(normalWorld.add(bump))) as any;
  const dirt = smoothstep(0.1, -0.5, pits) as any;
  m.colorNode = mix(colour, colour.mul(0.45), dirt) as any;
  m.roughnessNode = mix(float(rough).mul(0.75), float(Math.min(1, rough * 1.25)), dirt) as any;
}
