/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { abs, atan, dot, float, fract, length, max, min, mix, mx_noise_float, normalMap, output, positionWorld, sin, smoothstep, step, texture, uniform, vec2, vec3, vec4 } from "three/tsl";
import { EYE, HOLE } from "./pit";

// The paving, and the drawing on it. The pit's picture, taken from the artist's eye with the view's own lens and
// pixel grid (index.tsx), is laid on the ground along that eye's sight lines. So from the eye each pixel of the
// drawing shows exactly the pixel of the real pit behind it, unlit and untouched: swapping one for the other there
// changes nothing on the screen. Away from the eye it shows as chalk: the paving's pits and joints come through it.

// Concrete slabs, laid in a grid with narrow joints.
const SLAB = 1.2;

export type Paving = { colour: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture };

export function buildGround(paving: Paving, picture: THREE.Texture, artist: THREE.PerspectiveCamera) {
  // The picture's camera, set each frame; the artist's wide view, which the hole's edge is laid out in.
  const sweet = uniform(new THREE.Matrix4());
  const laidOut = uniform(new THREE.Matrix4().multiplyMatrices(artist.projectionMatrix, artist.matrixWorldInverse));
  // 1 once the pit is real (the paving inside its edge is gone), and how far the eye is from the artist's: 0 there.
  const real = uniform(0);
  const chalky = uniform(1);

  const at = positionWorld.xz;
  const grainUv = at.div(2.6);
  const slabColour = texture(paving.colour, grainUv).rgb.mul(0.62);
  const lum = dot(slabColour, vec3(0.3, 0.59, 0.11));

  // The joints: a dark groove a centimetre or so wide every slab, a little uneven.
  const toJoint = abs(fract(at.div(SLAB).add(0.5)).sub(0.5)).mul(SLAB);
  const joint = float(1).sub(smoothstep(0.003, 0.011, min(toJoint.x, toJoint.y).add(mx_noise_float(vec3(at.mul(9), 0)).mul(0.002))));
  const paved = mix(slabColour, slabColour.mul(0.3), joint);

  // Where each point of the ground falls in the picture.
  const clip = sweet.mul(vec4(positionWorld, 1));
  const ndc = clip.xy.div(clip.w);
  const inFrame = step(max(abs(ndc.x), abs(ndc.y)), 1).mul(step(0, clip.w));
  const pit = texture(picture, vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)));

  // The hole's edge, worked out exactly as pit.ts lays it out.
  const wide = laidOut.mul(vec4(positionWorld, 1));
  const across = wide.x.div(wide.w).div(HOLE.across);
  const up = wide.y.div(wide.w).div(HOLE.up);
  const a = atan(up, across);
  const edge = sin(a.mul(3).add(1)).mul(0.06).add(sin(a.mul(7).add(2)).mul(0.045)).add(sin(a.mul(17)).mul(0.02)).add(sin(a.mul(41).add(0.4)).mul(0.012)).add(1);
  const inside = step(length(vec2(across, up)), edge).mul(step(0, wide.w));

  // Chalk catches on the grain's tops and skips its pits and the joints (the scan's colour is linear, about 0.1).
  const grain = mx_noise_float(vec3(at.mul(210), 1)).mul(0.5).add(mx_noise_float(vec3(at.mul(55), 2)).mul(0.5));
  const catches = smoothstep(-0.75, -0.1, grain.mul(0.8).add(lum.sub(0.1).mul(4))).mul(float(1).sub(joint.mul(0.85)));
  const drawn = pit.a.mul(inFrame).mul(float(1).sub(real)).mul(mix(float(1), catches, chalky));

  // Footprints where the artist stood, outlined in chalk: stand here.
  const foot = (x: number) => {
    const d = at.sub(vec2(x, EYE.z)).div(vec2(0.055, 0.13));
    return float(1).sub(smoothstep(0.004, 0.01, abs(length(d).sub(1)).mul(0.08)));
  };
  const prints = max(foot(-0.11), foot(0.11)).mul(0.85).mul(catches);

  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  material.colorNode = mix(paved, vec3(0.8, 0.79, 0.76), prints);
  material.roughnessNode = mix(texture(paving.rough, grainUv).r.mul(0.25).add(0.7), float(0.97), prints);
  material.normalNode = normalMap(texture(paving.normal, grainUv));
  // The drawing goes on last, over the lit paving, as the picture's own colour.
  material.outputNode = mix(output, vec4(pit.rgb, 1), drawn) as any;
  material.opacityNode = float(1).sub(inside.mul(real));
  material.alphaTest = 0.5;

  const geometry = new THREE.PlaneGeometry(80, 80);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return { mesh, sweet, real, chalky, geometries: [geometry], materials: [material] };
}
