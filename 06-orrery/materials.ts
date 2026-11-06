import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  bumpMap,
  cameraPosition,
  color as tslColor,
  dot,
  float,
  fract,
  length,
  max,
  mix,
  modelWorldMatrix,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_float,
  normalGeometry,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  vec3,
  vec4
} from "three/tsl";

const KEY = new THREE.Vector3(-0.5, 0.75, 0.42).normalize();

type MetalOptions = { color: string; shade: string; roughness: number; grain?: "spun" | "straight"; bump?: number; sheen?: number };

// Brushed metal, with no textures. The grain is noise pulled out long along the direction the tool ran: round the axis on
// a turned part and along the length on a bar. It breaks up the highlight without making the metal any more mirror-like.
export function metal({ color, shade, roughness, grain = "spun", bump = 0.0007, sheen = 0.22 }: MetalOptions) {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 1, roughness });
  const p = positionLocal as any;
  let streak: any;
  if (grain === "spun") {
    const r = length(p.xz) as any;
    const round = p.xz.div(r.add(0.001)) as any;
    const along = r.add(p.y) as any;
    streak = mx_noise_float(vec3(along.mul(150), round.x.mul(1.4), round.y.mul(1.4)))
      .add(mx_noise_float(vec3(along.mul(420), round.x.mul(3), round.y.mul(3))).mul(0.55));
    // Turned metal lights up in a bow tie, where the grain lies square to the light. Normal lighting cannot make that without
    // tangents on every part, so it is added by hand, on faces that look along the axis.
    const axis = normalize((modelWorldMatrix as any).mul(vec4(0, 1, 0, 0)).xyz) as any;
    const radial = normalize((modelWorldMatrix as any).mul(vec4(p.x, 0, p.z, 0)).xyz) as any;
    const half = normalize(normalize((cameraPosition as any).sub(positionWorld)).add(vec3(KEY.x, KEY.y, KEY.z))) as any;
    const flat = normalize(half.sub(axis.mul(dot(half, axis)))) as any;
    const lobe = pow(abs(dot(radial, flat)), float(26)) as any;
    const face = smoothstep(0.85, 0.98, abs((normalGeometry as any).y)) as any;
    material.emissiveNode = tslColor(color).mul(lobe.mul(face).mul(sheen));
  } else {
    streak = mx_noise_float(vec3(p.x.mul(4), p.y.mul(240), p.z.mul(240))).add(mx_noise_float(vec3(p.x.mul(14), p.y.mul(620), p.z.mul(620))).mul(0.5));
  }
  const patch = (mx_noise_float(p.mul(2.7)) as any).mul(0.5).add(0.5);
  material.colorNode = mix(tslColor(shade), tslColor(color), patch.mul(0.55).add(0.45).add(streak.mul(0.035)));
  material.roughnessNode = float(roughness).add(streak.mul(0.05)).add(patch.mul(0.06));
  material.normalNode = bumpMap(streak, float(bump)) as any;
  return material;
}

export const brassMaterial = () => metal({ color: "#d9b470", shade: "#a98347", roughness: 0.42 });
export const darkBrassMaterial = () => metal({ color: "#bb9455", shade: "#8a6a38", roughness: 0.46 });
export const steelMaterial = () => metal({ color: "#b4b9bd", shade: "#7b8187", roughness: 0.4, sheen: 0.2 });
export const barMaterial = () => metal({ color: "#d8b06c", shade: "#a98347", roughness: 0.4, grain: "straight" });

const longitudeOf = (p: any) => atan(p.z, p.x) as any;
const latitudeOf = (p: any, radius: number) => p.y.div(radius) as any;

// The Sun: a brass ball cut with meridian grooves, with the light coming out of them.
export function sunMaterial(radius: number) {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 1, roughness: 0.34 });
  const p = positionLocal as any;
  const lat = latitudeOf(p, radius);
  const cut = abs(sin(longitudeOf(p).mul(12))) as any;
  // The grooves run together towards the poles, so they stop short of them.
  const pole = smoothstep(0.96, 0.8, abs(lat)) as any;
  const groove = smoothstep(0.1, 0.02, cut).mul(pole) as any;
  const ring = smoothstep(0.03, 0.012, abs(fract(lat.mul(3.5).add(0.5)).sub(0.5))).mul(0.6) as any;
  const lines = max(groove, ring) as any;
  material.colorNode = mix(tslColor("#e9b75f"), tslColor("#5a3817"), lines);
  material.roughnessNode = float(0.3).add(lines.mul(0.4));
  material.emissiveNode = tslColor("#ff9c3a").mul(lines.mul(2.2)).add(tslColor("#ffb765").mul(0.1));
  material.normalNode = bumpMap(lines.mul(-1), float(0.03)) as any;
  return material;
}

// Earth in cloisonne: blue enamel with raised metal land. The noise is chosen, not a map of the real continents.
export function earthMaterial(radius: number) {
  const material = new THREE.MeshPhysicalNodeMaterial({ metalness: 0.25, roughness: 0.3, clearcoat: 0.9, clearcoatRoughness: 0.15 });
  const n = (positionLocal as any).div(radius);
  const land = smoothstep(0.03, 0.09, mx_fractal_noise_float(n.mul(1.9).add(vec3(4, 1, 7)), 5, 2, 0.5, 1)) as any;
  const ice = smoothstep(0.82, 0.92, abs(n.y)) as any;
  const sea = mix(tslColor("#0e3f96"), tslColor("#1d6fc7"), smoothstep(-0.1, 0.1, mx_noise_float(n.mul(3))));
  const ground = mix(tslColor("#6f8a43"), tslColor("#c2a660"), smoothstep(0, 0.3, mx_noise_float(n.mul(5))));
  material.colorNode = mix(mix(sea, ground, land), tslColor("#e8eef3"), ice);
  material.metalnessNode = land.mul(0.7).add(0.08);
  material.roughnessNode = mix(float(0.2), float(0.5), land);
  return material;
}

// The ones with bands and rings, cut into the metal like the Sun's grooves.
export function bandedMaterial(radius: number, colors: [string, string, string], bands: number, roughness = 0.42, turbulence = 0.3) {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.85, roughness });
  const n = (positionLocal as any).div(radius);
  const wave = n.y.mul(bands).add(mx_noise_float(n.mul(vec3(2, 5, 2))).mul(turbulence)) as any;
  const stripe = sin(wave).mul(0.5).add(0.5) as any;
  const fine = sin(wave.mul(5.3)).mul(0.5).add(0.5) as any;
  material.colorNode = mix(mix(tslColor(colors[0]), tslColor(colors[1]), stripe), tslColor(colors[2]), fine.mul(0.3));
  material.normalNode = bumpMap(stripe, float(0.012)) as any;
  return material;
}

// Dents and craters over a plain metal ball: Mercury, Mars and our Moon.
export function crateredMaterial(radius: number, light: string, dark: string, scale: number, roughness = 0.5, metalness = 0.75) {
  const material = new THREE.MeshStandardNodeMaterial({ metalness, roughness });
  const n = (positionLocal as any).div(radius);
  const pits = mx_worley_noise_float(n.mul(scale)) as any;
  const pit = smoothstep(0.3, 0.05, pits) as any;
  const blotch = mx_fractal_noise_float(n.mul(2.2), 4, 2, 0.5, 1) as any;
  material.colorNode = mix(tslColor(light), tslColor(dark), smoothstep(-0.2, 0.3, blotch).mul(0.7).add(pit.mul(0.3)));
  material.normalNode = bumpMap(pit.mul(-1).add(blotch.mul(0.4)), float(0.018)) as any;
  return material;
}

