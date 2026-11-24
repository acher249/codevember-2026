/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { cross, dot, float, mix, mx_noise_float, normalize, smoothstep, uniform, vec2, vec3 } from "three/tsl";
import type { World } from "./worlds";

// The light of one world, as uniforms its materials share: toward the sun, the sun's colour times its strength, the sky
// and ground fill, and the world's own clock, which stands still while the world is only a photograph.
export type Lighting = ReturnType<typeof lighting>;

export function lighting(world: World) {
  const toSun = new THREE.Vector3(...world.sun).normalize();
  return {
    world,
    toSun: uniform(toSun),
    sun: uniform(new THREE.Color(world.sunColour).multiplyScalar(world.sunPower)),
    sky: uniform(new THREE.Color(world.sky).multiplyScalar(world.fill)),
    ground: uniform(new THREE.Color(world.ground).multiplyScalar(world.fill * 0.6)),
    clock: uniform(0),
    dapple: uniform(world.dapple),
    size: uniform(world.dappleSize)
  };
}

// Sunlight broken up by a canopy overhead: soft gaps in the leaves, drifting as they sway, seen on whatever the light
// falls on. Worked out across the beam, so every surface in it agrees.
export function dappleAt(l: Lighting, p: any) {
  const s = l.toSun as any;
  const a = normalize(cross(s, vec3(0, 1, 0.0001))) as any;
  const b = cross(a, s) as any;
  const q = vec2(dot(p, a), dot(p, b)).div(l.size) as any;
  const t = (l.clock as any).mul(0.22);
  const leaves = mx_noise_float(vec3(q.x, q.y, t)).add(mx_noise_float(vec3(q.x.mul(2.3).add(7), q.y.mul(2.3), t.mul(1.6))).mul(0.45)) as any;
  const open = smoothstep(-0.02, 0.32, leaves) as any;
  return mix(float(1).sub((l.dapple as any).mul(0.88)), float(1).add((l.dapple as any).mul(0.2)), open) as any;
}

// The fill from the sky above and the ground below, for a normal.
export function fillAt(l: Lighting, n: any) {
  return mix(l.ground as any, l.sky as any, (n as any).y.mul(0.5).add(0.5)) as any;
}

// The world's sun, as a light: its colour worked out where it lands, through the canopy.
export function sunLight(l: Lighting, p: any, shadowSize: number) {
  const light = new THREE.DirectionalLight(0xffffff, 1);
  (light as any).colorNode = (l.sun as any).mul(dappleAt(l, p));
  light.position.copy(l.toSun.value).multiplyScalar(60);
  light.target.position.set(0, 0, 0);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  const c = light.shadow.camera as THREE.OrthographicCamera;
  c.left = c.bottom = -shadowSize;
  c.right = c.top = shadowSize;
  c.near = 10;
  c.far = 140;
  light.shadow.bias = -0.0004;
  light.shadow.normalBias = 0.03;
  light.shadow.radius = 4;
  return light;
}
