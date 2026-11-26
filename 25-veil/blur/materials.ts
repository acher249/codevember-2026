import * as THREE from "three/webgpu";
import {
  Fn,
  faceDirection,
  abs,
  cameraPosition,
  clamp,
  color,
  cos,
  dot,
  float,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  reflect,
  refract,
  sin,
  smoothstep,
  time,
  vec3
} from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What the statue can be made of, beyond limestone and chiffon (worlds/common.tsx). Each sees the same bright room, as
// Melt's metal does: a big softbox overhead, a strip of light either side, a band round the horizon, in the colours of
// the world it stands in. That room is what the polished ones reflect and the clear ones bend, so their highlights
// belong to the light behind them.

export type Palette = { key: string; left: string; right: string; zenith: string; horizon: string };
export type Kind = "marble" | "nero" | "calacatta" | "glass" | "neon" | "bubble" | "chrome" | "gold" | "obsidian";
export const KINDS: Kind[] = ["marble", "nero", "calacatta", "glass", "neon", "bubble", "chrome", "gold", "obsidian"];

// The room in a direction, in HDR. Its lights have soft wide edges: a thin hard strip caught on a sharp fold crest
// shows every vertex of the crest as its own highlight, a string of bright dots.
function room(palette: Palette, strips = 1) {
  const key = color(palette.key) as any;
  const left = color(palette.left) as any;
  const right = color(palette.right) as any;
  const zenith = color(palette.zenith) as any;
  const horizon = color(palette.horizon) as any;
  return Fn(([d]: any[]) => {
    const y = d.y as any;
    const base = mix(horizon.mul(0.6), zenith, smoothstep(-0.1, 0.8, y)) as any;
    const box = smoothstep(0.45, 0.75, y).mul(smoothstep(0.8, 0.3, abs(d.x))).mul(smoothstep(0.8, 0.3, abs(d.z))) as any;
    const l = smoothstep(0.3, 0.0, abs(d.x.add(0.82))).mul(smoothstep(0.85, 0.4, abs(y.sub(0.2)))) as any;
    const r = smoothstep(0.3, 0.0, abs(d.x.sub(0.82))).mul(smoothstep(0.85, 0.4, abs(y.sub(0.2)))) as any;
    const band = smoothstep(0.2, 0.0, abs(y.sub(0.05))).mul(0.45) as any;
    return base.add(key.mul(box.mul(6).add(band))).add(left.mul(l.mul(5 * strips))).add(right.mul(r.mul(5 * strips)));
  });
}

// The surface turned toward the eye, whichever side of the cloth it is, and the eye's ray.
function facing() {
  const view = normalize(positionWorld.sub(cameraPosition)) as any;
  // Which side is seen comes from the face being drawn, not from comparing the normal with the eye: at a glancing angle
  // that comparison flips pixel to pixel and strings bright dots along every fold crest.
  const n = normalize(normalWorld.mul(faceDirection)) as any;
  const ndv = clamp(dot(n, view.negate()), 0, 1) as any;
  return { view, n, ndv };
}
const schlick = (ndv: any, f0: number) => float(f0).add(float(1 - f0).mul(pow(float(1).sub(ndv), 5))) as any;

export function sculpt(kind: Kind, palette: Palette): THREE.Material {
  const { view, n, ndv } = facing();
  const p = positionWorld as any;
  if (kind === "marble" || kind === "nero" || kind === "calacatta") {
    // Polished marble, three kinds: white Carrara with soft grey veins wandering through it; black Nero Marquina struck
    // through with sharp white veins; warm white Calacatta with bold veins of gold and brown. The room is reflected in
    // each, faint face on and strong at a slant.
    const material = new THREE.MeshStandardNodeMaterial({ roughness: kind === "nero" ? 0.22 : 0.32, metalness: 0, side: THREE.DoubleSide });
    const warp = mx_fractal_noise_float(p.mul(2.2), 4, 2, 0.5) as any;
    const vein = smoothstep(0.06, 0.0, abs(sin(p.x.mul(5).add(p.y.mul(3)).add(warp.mul(6))))) as any;
    const fine = smoothstep(0.05, 0.0, abs(sin(p.z.mul(9).sub(p.y.mul(4)).add(warp.mul(9))))).mul(0.5) as any;
    const speck = mx_noise_float(p.mul(30)).mul(0.015) as any;
    if (kind === "marble") material.colorNode = vec3(0.92, 0.91, 0.89).mul(float(1).sub(vein.mul(0.35)).sub(fine.mul(0.18))).add(speck);
    else if (kind === "nero") {
      // Black, the veins crisp and branching, a few broad and bright, many thin.
      const crisp = max(smoothstep(0.1, 0.0, abs(sin(p.x.mul(6).sub(p.y.mul(7)).add(warp.mul(10))))), smoothstep(0.06, 0.0, abs(sin(p.z.mul(8).add(p.y.mul(5)).add(warp.mul(12))))).mul(0.7)) as any;
      material.colorNode = vec3(0.025, 0.024, 0.026).add(vec3(0.85, 0.84, 0.82).mul(max(crisp, fine.mul(0.6)))).add(speck.mul(0.5));
    } else {
      // Warm white, the veins wide, soft-edged and gold-brown, wandering in big sweeps.
      const sweep = mx_fractal_noise_float(p.mul(0.9), 3, 2, 0.5) as any;
      const bold = max(smoothstep(0.3, 0.0, abs(sin(p.y.mul(5).add(p.x.mul(2.6)).add(sweep.mul(9))))), smoothstep(0.12, 0.0, abs(sin(p.x.mul(7).sub(p.z.mul(4)).add(sweep.mul(12))))).mul(0.6)) as any;
      const gold = mix(vec3(0.6, 0.42, 0.2), vec3(0.42, 0.32, 0.22), smoothstep(0.0, 0.2, abs(sin(p.y.mul(5).add(p.x.mul(2.6)).add(sweep.mul(9)))))) as any;
      material.colorNode = mix(vec3(0.95, 0.93, 0.89).sub(fine.mul(0.08)), gold, bold.mul(0.85)).add(speck);
    }
    material.emissiveNode = room(palette)(reflect(view, n)).mul(schlick(ndv, 0.05)).mul(kind === "nero" ? 0.7 : 0.75) as any;
    return material;
  }
  if (kind === "glass") {
    // Clear glass, solid through: the room seen bent through it (a touch of its own green-blue in the thickness), and
    // mirrored at its surface, more so toward the rim, as the light in Bolt's globe sweeps its glass.
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const R = room(palette);
    const F = schlick(ndv, 0.04);
    const bent = R(refract(view, n, 1 / 1.5)) as any;
    const tint = mix(vec3(0.82, 0.95, 0.93), vec3(1, 1, 1), ndv) as any;
    material.colorNode = mix(bent.mul(tint).mul(0.85), R(reflect(view, n)), F) as any;
    return material;
  }
  if (kind === "neon") {
    // As in Melt's neon room: glossy black, lit by a magenta strip one side and a cyan strip the other, the room's
    // halo running round it, and its edges glowing in the two colours.
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const neon: Palette = { ...palette, left: "#ff2bb4", right: "#17e8ff", key: "#b9f2ff", zenith: "#07040f", horizon: "#3a1466" };
    const R = room(neon, 1.4);
    const F = schlick(ndv, 0.06);
    const edge = pow(float(1).sub(ndv), 3) as any;
    const side = n.x.mul(0.5).add(0.5) as any;
    material.colorNode = vec3(0.01, 0.008, 0.015).add(R(reflect(view, n)).mul(F.mul(0.9).add(0.1))).add(mix(color("#ff2bb4"), color("#17e8ff"), side).mul(edge.mul(1.4))) as any;
    return material;
  }
  if (kind === "bubble") {
    // A soap bubble: nearly nothing, a film whose colour runs with the angle and with its slowly swirling thickness,
    // the room reflected in it, brightest at the rim.
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const thick = mx_fractal_noise_float(p.mul(3).add(vec3(0, time.mul(0.08), 0)), 3, 2, 0.5).mul(0.5).add(0.5) as any;
    const phase = ndv.mul(5).add(thick.mul(7)) as any;
    const film = vec3(cos(phase).mul(0.5).add(0.5), cos(phase.add(2.1)).mul(0.5).add(0.5), cos(phase.add(4.2)).mul(0.5).add(0.5)) as any;
    const F = schlick(ndv, 0.04).add(0.05) as any;
    material.colorNode = room(palette)(reflect(view, n)).mul(film).mul(F).mul(1.4) as any;
    return material;
  }
  if (kind === "chrome") {
    // A mirror: the room, almost all of it, faintly warm.
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    material.colorNode = room(palette)(reflect(view, n)).mul(vec3(0.92, 0.92, 0.95)).mul(schlick(ndv, 0.8)).mul(0.5) as any;
    return material;
  }
  if (kind === "gold") {
    // Polished gold, dulled in the hollows: the room reflected in gold, a darker patina where the folds dip.
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const patina = smoothstep(0.2, 0.7, mx_fractal_noise_float(p.mul(6), 3, 2, 0.5).mul(0.5).add(0.5)).mul(smoothstep(0.3, -0.5, n.y)) as any;
    const gold = mix(vec3(1.0, 0.76, 0.33), vec3(1, 0.95, 0.85), pow(float(1).sub(ndv), 5)) as any;
    material.colorNode = room(palette)(reflect(view, n)).mul(gold).mul(float(1).sub(patina.mul(0.55))).mul(0.5) as any;
    return material;
  }
  // Obsidian: black volcanic glass, the room in it hard and bright at a slant, almost nothing face on.
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  material.colorNode = vec3(0.008, 0.008, 0.01).add(room(palette)(reflect(view, n)).mul(schlick(ndv, 0.045))) as any;
  return material;
}
