/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { attribute, cameraPosition, cameraViewMatrix, color, dot, float, max, mix, modelWorldMatrix, mx_fractal_noise_float, mx_noise_float, normalize, positionWorld, pow, smoothstep, step, uniform, varying, vec3, vec4 } from "three/tsl";

// The weather of the branch, as uniforms every material shares, all driven by the dial: `heat` 0 (freezing) to 1
// (sweltering); how much snow is lying, how much frost, how wet things are from the melt; the key light's direction and
// colour, the sky and ground fill, and a clock. Centimetres throughout.
export type Lighting = ReturnType<typeof lighting>;

export function lighting() {
  return {
    // From the front left and a little more to the side, so its highlight on the dial's steel and glass falls away from
    // the opening view.
    toSun: uniform(new THREE.Vector3(-0.78, 0.55, 0.32).normalize()),
    sun: uniform(new THREE.Color("#9db8ff")),
    sky: uniform(new THREE.Color("#3a4f86")),
    ground: uniform(new THREE.Color("#1a2238")),
    clock: uniform(0),
    heat: uniform(0),
    snow: uniform(1),
    frost: uniform(1),
    wet: uniform(0),
    // The thermostat's glow: its colour (heating orange, idle cold white) times its strength, and where it is.
    glow: uniform(new THREE.Color("#ffffff")),
    glowAt: uniform(new THREE.Vector3()),
    // Light from behind and above, low through the far trees: the moon in the cold, the sun once warm. It is what
    // shows in the air as shafts and lights the leaves through.
    toBack: uniform(new THREE.Vector3(-0.55, 0.62, -0.56).normalize()),
    back: uniform(new THREE.Color("#000000"))
  };
}

// How upward a surface must face for snow to lie on it (with patchy noise added): high as it melts away.
function snowLine(l: Lighting, reach: number) {
  return mix(float(1.05), float(0.42), (l.snow as any).mul(reach).min(1)) as any;
}

// Where snow lies thicker or thinner: drifts of a hand's width, and smaller breaks in them.
function patches(p: any) {
  return mx_fractal_noise_float(p.mul(0.16), 3, 2, 0.55).mul(0.55) as any;
}

// The fill from the sky above and the ground below, for a normal.
export function fillAt(l: Lighting, n: any) {
  return mix(l.ground as any, l.sky as any, (n as any).y.mul(0.5).add(0.5)) as any;
}

// Snow lying on whatever faces up, in drifts that thin and break into patches as it melts; rime frost on everything
// else, catching the light at grazing angles; and the dark sheen of wet wood once the melt starts. Returns the colour and
// roughness to use instead of a surface's own. `reach` scales how far up the sides the snow comes (twigs hold less).
export function weather(l: Lighting, base: any, rough: any, p: any, n: any, reach = 1) {
  const up = (n as any).y as any;
  const patch = patches(p);
  const fine = mx_noise_float(p.mul(1.7)) as any;
  // Where the snow still lies: the edge creeps up the side as it melts. A little wider than the caps below, so a cap's
  // edge always sits on white.
  const edge = snowLine(l, reach).sub(0.16) as any;
  // ...and none at all once it has melted, however upward or patchy.
  const cover = smoothstep(edge, edge.add(0.14), up.add(patch).add(fine.mul(0.04))).mul(smoothstep(0.02, 0.25, l.snow)) as any;
  const snowColour = mix(color("#cfdcf0"), color("#f4f7fc"), smoothstep(-0.2, 0.6, fine)) as any;
  // Rime: pale feathery crystals, densest on edges facing the eye's grazing view.
  const V = normalize(cameraPosition.sub(p)) as any;
  const graze = pow(float(1).sub(max(dot(n, V), 0)), 2) as any;
  const rime = (l.frost as any).mul(smoothstep(-0.1, 0.5, mx_noise_float(p.mul(3.1)).add(up.mul(0.3)))).mul(graze.mul(0.6).add(0.25)) as any;
  // Wet wood: darker and glossier while the melt runs off.
  const wet = (l.wet as any).mul(float(1).sub(cover)) as any;
  let c: any = base.mul(float(1).sub(wet.mul(0.45)));
  c = mix(c, color("#dfe8f6"), rime.min(0.85));
  c = mix(c, snowColour, cover);
  const r = mix(mix(rough, float(0.3), wet), float(0.8), cover) as any;
  return { colour: c, rough: r, cover };
}

// For a cap of snow built over a surface: how thick it is at this point, by how upward the surface faces and the same
// patches as above. 0 where there is none.
export function snowDepth(l: Lighting, p: any, n: any, most: any, reach = 1) {
  const up = (n as any).y as any;
  const patch = patches(p);
  const edge = snowLine(l, reach) as any;
  // Mounded: deepest along the top, thinning to nothing at the edge.
  const k = smoothstep(edge, float(1.08), up.add(patch)) as any;
  // Lumpy, as snow lies: soft clumps a few centimetres across.
  const lumps = mx_noise_float(p.mul(0.42).add(5)).mul(0.4).add(0.9) as any;
  return pow(k, 1.3).mul(most).mul(lumps).mul(smoothstep(0.04, 0.35, l.snow)) as any;
}

// A cap of snow over a surface: the surface's own geometry pushed out along its normals by the depth above, so it has
// real thickness on top of a branch or a rim and thins to nothing round the sides, cut away wherever there is none.
// `most` is the deepest it gets (a node, so it can follow a twig's radius), `keep` limits it to part of the surface.
export function snowCap(l: Lighting, most: () => any, keep: (p: any) => any = () => float(1)) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
  // Built twice, once for the vertex position and once for the fragment: a node shared between the two goes wrong.
  const depth = () => {
    const p0 = attribute("position", "vec3") as any;
    const n0 = attribute("normal", "vec3") as any;
    const pW = modelWorldMatrix.mul(vec4(p0, 1)).xyz as any;
    const nW = normalize(modelWorldMatrix.mul(vec4(n0, 0)).xyz) as any;
    return snowDepth(l, pW, nW, most().mul(keep(pW))) as any;
  };
  {
    const p0 = attribute("position", "vec3") as any;
    const n0 = attribute("normal", "vec3") as any;
    const d = depth();
    m.positionNode = p0.add(n0.mul(d.add(step(0.001, d).mul(0.05)))) as any;
  }
  const shown = varying(depth()) as any;
  m.alphaTest = 0.5;
  m.opacityNode = step(0.03, shown) as any;
  // Rounded on top: the normal leans up toward the sky the deeper the snow.
  const nW = varying(normalize(modelWorldMatrix.mul(vec4(attribute("normal", "vec3"), 0)).xyz)) as any;
  // Rounded on top, the normal leaning up the deeper the snow, and tipped about by the lumps so the light models them.
  const q = positionWorld.mul(0.5) as any;
  const tilt = vec3(mx_noise_float(q.add(7)), 0, mx_noise_float(q.add(13))).mul(0.55) as any;
  const bent = normalize(normalize(nW).add(vec3(0, 0.7, 0)).add(tilt)) as any;
  m.normalNode = normalize(cameraViewMatrix.mul(vec4(bent, 0)).xyz) as any;
  const grain = mx_noise_float(positionWorld.mul(2.3)) as any;
  // Thin at its edges, where it lets the dark through and goes a little blue.
  const body = smoothstep(0.03, 0.6, shown) as any;
  m.colorNode = mix(color("#dfe7f4"), color("#f4f7fc"), smoothstep(-0.5, 0.5, grain)).mul(mix(vec3(0.62, 0.7, 0.85), vec3(1, 1, 1), body)) as any;
  return m;
}
