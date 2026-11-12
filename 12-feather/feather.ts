import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  color,
  dot,
  float,
  floor,
  fract,
  fwidth,
  hash,
  instanceIndex,
  length,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3
} from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A feather, one unit long from the quill end (y = 0) to the tip (y = 1). The vane is a sheet either side of the shaft;
// its barbs, the gaps and splits between them, the down at the base and the eye of a peacock are all drawn by the
// material, so one mesh does for every kind.
export type Outline = {
  // Half the vane's width at its widest, as a part of the length.
  width: number;
  // How much of the length, from the quill end, is bare shaft.
  stalk: number;
  // How much narrower one side of the vane is than the other, as on a flight feather.
  asym?: number;
  // How far the barbs sweep toward the tip, going out from the shaft.
  lean?: number;
  // The shaft's curve sideways, and its arch out of the vane's plane.
  curve?: number;
  arch?: number;
  // How much the vane is cupped either side of the shaft.
  cup?: number;
  // Lower for a blunt, rounded tip; higher for a pointed one.
  point?: number;
  // How much the narrow vane steps in two thirds of the way up, as on a falcon's outer primaries.
  notch?: number;
};

const SHAFT = (u: number) => 0.0065 * (1 - 0.65 * u) + 0.0012;

export function featherGeometry(o: Outline, segU = 44, segV = 14) {
  const position: number[] = [];
  const vane: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= segU; i++) {
    const u = i / segU;
    const t = THREE.MathUtils.clamp((u - o.stalk) / (1 - o.stalk), 0, 1);
    const sweep = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), o.point ?? 0.55) * (1 - 0.2 * t);
    const half = Math.max(SHAFT(u), o.width * sweep);
    for (let j = 0; j <= segV; j++) {
      const v = -1 + (2 * j) / segV;
      const side = v < 0 ? (1 - (o.asym ?? 0)) * (1 - (o.notch ?? 0) * THREE.MathUtils.smoothstep(t, 0.55, 0.68)) : 1;
      const w = half * side;
      const x = v * w + (o.curve ?? 0) * u * u;
      const y = u + Math.abs(v) * w * (o.lean ?? 0.5);
      const z = -(o.arch ?? 0.04) * u * u + (o.cup ?? 0.15) * v * v * w;
      position.push(x, y, z);
      vane.push(u, v, w);
    }
  }
  const row = segV + 1;
  for (let i = 0; i < segU; i++) {
    for (let j = 0; j < segV; j++) {
      const a = i * row + j;
      index.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("vane", new THREE.Float32BufferAttribute(vane, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

type Colours = { base: string; tip: string; bars?: string; blend?: [number, number] };

export type Plumage = Colours & {
  // A pale fringe at the vane's edge.
  edge?: string;
  edgeAmount?: number;
  // The fringe carried round the tip too, as the white trailing edge of a gull's wing or the scallops of a goose's coverts.
  tipFringe?: number;
  // Small dark flecks scattered over the vanes, from none to plenty.
  speckle?: number;
  // How much of the fringe runs down the sides; 1 by default.
  sideEdge?: number;
  // Dark bands across the vane, this many along the length.
  barring?: number;
  // The shaft's colour, and how strongly it shows against the vane.
  shaft?: string;
  shaftAmount?: number;
  // How far up from the base the vane is fluffy down, as a part of the length; or all of it, for a tuft of down.
  down?: number;
  allDown?: boolean;
  // How far apart the barbs hang, from a tight vane (0) to loose wisps (1), as on a peacock's train.
  wisp?: number;
  barbs?: number;
  ragged?: number;
  splits?: number;
  // A peacock's eye near the tip.
  eye?: boolean;
  iridescence?: number;
  roughness?: number;
  sheen?: number;
  // Light through the vane, when it is between the light and the camera.
  glow?: number;
  light?: THREE.Vector3;
  // A second set of colours, mixed per instance by the instanced attribute `tone` (its x), for a wing of many feathers.
  second?: Colours & { barring?: number };
  // Bending: by hand for one feather, through `bend` (x along its length, y a twist), or a flutter of its own for each
  // instance, this strong, kept going through `time`.
  flex?: boolean;
  flutter?: number;
  // Or each instance bent by its own instanced attribute `bow`: x along its length, y a twist.
  bowed?: boolean;
};

export type Feather = {
  material: THREE.MeshPhysicalNodeMaterial;
  bend: { value: THREE.Vector2 };
  time: { value: number };
  light: { value: THREE.Vector3 };
  // From 0 to 1, the barbs fall away one by one, to show what is under the feathers.
  reveal: { value: number };
};

export function featherMaterial(p: Plumage): Feather {
  const material = new THREE.MeshPhysicalNodeMaterial({
    side: THREE.DoubleSide,
    roughness: p.roughness ?? 0.62,
    metalness: 0,
    sheen: p.sheen ?? 0.6,
    sheenRoughness: 0.45,
    alphaTest: 0.5
  });
  material.shadowSide = THREE.DoubleSide;
  const vane = attribute("vane", "vec3") as any;
  const u = vane.x as any;
  const v = vane.y as any;
  const w = vane.z as any;
  const across = abs(v) as any;
  const seed = hash(instanceIndex) as any;
  const tone = (p.second ? (attribute("tone", "vec2") as any) : vec2(0, 0)) as any;
  // A few numbers of its own for each feather, so that no two are quite alike.
  const own = [11, 23, 37, 53].map((k) => hash(instanceIndex.add(k)) as any);

  // Barbs: a coordinate that counts them along the shaft, each side its own.
  const count = float(p.barbs ?? 150);
  const coord = u.mul(count).sub(across.mul(w).mul(count).mul(0.35)) as any;
  const f = fract(coord) as any;
  const id = floor(coord).add(step(v, 0).mul(517)).add(seed.mul(97)) as any;
  const fine = float(1).sub(smoothstep(0.25, 0.7, fwidth(coord))) as any;

  const eyeDistance = p.eye ? (length(vec2(u.sub(0.86).div(0.1), v.mul(w).div(0.075))) as any) : float(9);
  const eyeMask = float(1).sub(smoothstep(0.95, 1.2, eyeDistance)) as any;
  const downMask = (p.allDown ? float(1) : float(1).sub(smoothstep(0.0, p.down ?? 0.18, u.sub(0.02)))) as any;
  const wisp = float(p.wisp ?? 0).mul(float(1).sub(eyeMask)) as any;

  // The gap between neighbouring barbs, wider where they hang loose.
  const gapWidth = mix(mix(float(0.05), float(0.7), wisp), float(0.6), downMask) as any;
  let alpha = float(1).sub(step(f, gapWidth).mul(fine.max(wisp).max(downMask))) as any;
  // Barbs end raggedly, some short, and here and there a few have come apart.
  const end = float(1).sub(hash(id.add(7.7)).mul(own[1].add(0.5).mul(p.ragged ?? 0.14))).sub(downMask.mul(0.25)) as any;
  alpha = alpha.mul(step(across, end));
  const split = step(float(1).sub(p.splits ?? 0.03), hash(floor(coord.div(3)).add(seed.mul(13)).add(step(v, 0).mul(31)))) as any;
  alpha = alpha.mul(float(1).sub(split.mul(step(0.15, across)).mul(float(1).sub(eyeMask))));
  // Down: wisps of barbules, soft at the edge.
  const fluff = mx_noise_float(vec3(coord.mul(0.6), across.mul(22), seed.mul(40))) as any;
  alpha = alpha.mul(mix(float(1), step(across.mul(0.9).sub(0.15), fluff.mul(0.5).add(0.5)), downMask));
  // To show what is under them the vanes fall away barb by barb; the shafts stay, down to where they root.
  const reveal = uniform(0);
  alpha = alpha.mul(step(reveal, hash(id.add(3.1)).mul(0.92).add(0.04)));
  // The shaft, solid, through the middle.
  const onShaft = step(across.mul(w), float(0.0065).mul(float(1).sub(u.mul(0.65))).add(0.0012)) as any;
  alpha = alpha.max(onShaft);

  const palette = (c: Colours, barring: number) => {
    // Where one colour gives way to the next, and the bars, sit a little differently on every feather.
    const [from, to] = c.blend ?? [0.3, 1];
    const shift = own[0].sub(0.5).mul(0.07) as any;
    let col = mix(color(c.base), color(c.tip), smoothstep(float(from).add(shift), float(to).add(shift), u.add(across.mul(own[2].sub(0.5).mul(0.06))))) as any;
    if (barring > 0) {
      const band = smoothstep(0.35, 0.65, sin(u.mul(own[1].sub(0.5).mul(0.12).add(1).mul(barring)).add(across.mul(own[2].mul(0.4).add(0.3))).add(own[3].mul(0.25)).mul(Math.PI * 2)).mul(0.5).add(0.5)) as any;
      col = mix(col, color(c.bars ?? "#2a2018"), band.mul(0.85).mul(smoothstep(0.15, 0.35, u)));
    }
    return col;
  };
  let tint = palette(p, p.barring ?? 0) as any;
  if (p.second) tint = mix(tint, palette(p.second, p.second.barring ?? 0), tone.x);
  if (p.edge) {
    const rim = smoothstep(own[3].sub(0.5).mul(0.12).add(0.72), 1, across).mul(p.sideEdge ?? 1).max(smoothstep(0.9, 0.985, u.add(across.mul(0.03))).mul(p.tipFringe ?? 0)) as any;
    tint = mix(tint, color(p.edge), rim.mul(p.edgeAmount ?? 0.6));
  }
  if (p.eye) {
    const ring = (inner: number, outer: number) => smoothstep(inner - 0.04, inner + 0.04, eyeDistance).mul(float(1).sub(smoothstep(outer - 0.04, outer + 0.04, eyeDistance)));
    let eye = color("#06092e") as any;
    eye = mix(eye, color("#1f4fe0"), smoothstep(0.3, 0.38, eyeDistance));
    eye = mix(eye, color("#0fa596"), smoothstep(0.52, 0.6, eyeDistance));
    eye = mix(eye, color("#b07a2a"), ring(0.7, 0.8));
    eye = mix(eye, color("#6f9a28"), smoothstep(0.8, 0.9, eyeDistance));
    tint = mix(tint, eye, eyeMask);
  }
  // Each feather a shade lighter or darker, warmer or cooler, than its neighbours.
  tint = tint.mul(own[0].sub(0.5).mul(0.08).add(1)).mul(mix(vec3(0.985, 1, 1.02), vec3(1.02, 1, 0.97), own[1]));
  // Flecks of pigment and grime here and there across the vane, never in the same place twice.
  const fleck = smoothstep(0.55, 0.68, mx_noise_float(vec3(u.mul(64), v.mul(w).mul(64), own[2].mul(91)))) as any;
  const fleckle = smoothstep(0.5, 0.62, mx_noise_float(vec3(u.mul(9), v.mul(w).mul(9), own[3].mul(37)))) as any;
  tint = mix(tint, tint.mul(0.42), fleck.mul(fleckle.mul(0.8).add(0.2)).mul(p.speckle ?? 0.35).mul(float(1).sub(downMask)));
  // Each barb catches the light along its length, darker in the grooves.
  tint = tint.mul(float(0.8).add(sin(f.mul(Math.PI)).mul(0.2))).mul(hash(id).mul(0.12).add(0.94));
  tint = mix(tint, tint.mul(1.35).add(0.06), downMask.mul(0.6));
  tint = mix(tint, color(p.shaft ?? "#e8dcc6"), onShaft.mul(p.shaftAmount ?? 1));
  material.colorNode = tint;
  material.opacityNode = alpha;
  material.sheenNode = mix(tint, vec3(1), 0.35).mul(p.sheen ?? 0.6) as any;

  if (p.iridescence) {
    material.iridescence = p.iridescence;
    material.iridescenceIOR = 1.6;
    material.iridescenceThicknessRange = [220, 640];
    material.iridescenceNode = mix(float(p.iridescence * 0.5), float(p.iridescence), eyeMask.max(float(1).sub(downMask))) as any;
  }

  // Light coming through from behind: a feather is thin enough to glow when the light is past it.
  const light = uniform(p.light ?? new THREE.Vector3(0, 4, -4));
  if (p.glow) {
    const facing = clamp(dot(normalize(positionWorld.sub(cameraPosition)), normalize(positionWorld.sub(light))), 0, 1) as any;
    material.emissiveNode = tint.mul(pow(facing, 5).mul(p.glow).add(0.01));
  }

  const bend = uniform(new THREE.Vector2());
  const time = uniform(0);
  if (p.flex || p.flutter || p.bowed) {
    let lift = float(0) as any;
    if (p.bowed) {
      const bow = attribute("bow", "vec2") as any;
      lift = lift.add(bow.x.mul(u).mul(u)).add(bow.y.mul(v).mul(w).mul(u));
    }
    if (p.flex) lift = lift.add(bend.x.mul(u).mul(u)).add(bend.y.mul(v).mul(w).mul(u));
    if (p.flutter) {
      const phase = seed.mul(40) as any;
      lift = lift.add(sin(time.mul(9).add(phase)).mul(p.flutter).mul(u).mul(u)).add(sin(time.mul(13).add(phase.mul(0.7))).mul(p.flutter * 0.6).mul(v).mul(w).mul(u));
    }
    material.positionNode = positionGeometry.add(vec3(0, 0, lift));
  }
  return { material, bend, time, light, reveal };
}
