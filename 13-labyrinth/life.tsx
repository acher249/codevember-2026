"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  color,
  cos,
  cross,
  exp,
  float,
  fract,
  length,
  max,
  mix,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  positionWorld,
  pow,
  screenUV,
  select,
  sin,
  smoothstep,
  step,
  time,
  uv,
  vec2,
  vec3
} from "three/tsl";
import { OVERLAY_LAYER, overlayLink } from "../shared/engine/Post";
import { mulberry32 } from "../shared/engine/random";
import { walking } from "../shared/engine/walk";
import { skyNow } from "./skies";
import { type Air, made, mistColour, shape, SPAN } from "./hedge-look";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Each firefly keeps to its own spot in a box that repeats across the ground, a whole number of times per copy of the
// maze, so they are the same wherever the camera is carried; the box is always the one round the camera.
const SWARM = SPAN / 4;

// Fireflies drifting low along the paths, each lighting up for a moment every few seconds. They are drawn in the overlay
// pass, added over the finished frame so the bloom takes them, and hidden wherever something solid stands in front.
export function Fireflies({ count }: { count: number }) {
  const { mesh, material, opacity, light } = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1);
    const random = mulberry32(4421);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), Math.pow(random(), 1.6), random(), random() * 100], i * 4);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = made(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    const seed = attribute("aSeed", "vec4") as any;
    const w = seed.w as any;
    const drift = vec3(
      sin(time.mul(0.23).add(w)).mul(1.4).add(sin(time.mul(0.71).add(w.mul(2))).mul(0.3)),
      sin(time.mul(0.41).add(w.mul(3))).mul(0.3).add(sin(time.mul(1.3).add(w)).mul(0.06)),
      sin(time.mul(0.19).add(w.mul(1.7))).mul(1.4).add(sin(time.mul(0.63).add(w.mul(5))).mul(0.3))
    ) as any;
    const home = fract(seed.xz.sub(cameraPosition.xz.div(SWARM))).sub(0.5) as any;
    const centre = vec3(cameraPosition.x.add(home.x.mul(SWARM)), float(0.3).add(seed.y.mul(2.4)), cameraPosition.z.add(home.y.mul(SWARM))).add(drift) as any;
    // Faded at the sides of the box, where one leaves and another comes in on the other side.
    const inside = float(1).sub(smoothstep(0.36, 0.48, max(home.x.abs(), home.y.abs()))) as any;
    // A slow pulse every few seconds, each to its own beat.
    const beat = time.mul(fract(w.mul(0.37)).mul(0.25).add(0.22)).add(w) as any;
    const flash = pow(sin(beat.mul(Math.PI)).abs(), float(6)).add(0.08) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const up = cross(toEye, right) as any;
    const away = length(cameraPosition.sub(centre)) as any;
    // Never smaller than a pixel or two, so a far one is a spark rather than a flicker.
    const size = max(float(0.06), away.mul(0.006)) as any;
    shape(material, centre.add(right.mul(positionGeometry.x.mul(size))).add(up.mul(positionGeometry.y.mul(size))));
    const r = length(uv().sub(0.5)).mul(2) as any;
    const glow = exp(r.mul(r).mul(-14)).add(exp(r.mul(r).mul(-90)).mul(3)) as any;
    // Not right in front of the eye, where one would fill the view.
    const seen = exp(away.mul(-0.03)).mul(inside).mul(smoothstep(0.8, 2.5, away)) as any;
    const light = color("#c6f25a").mul(flash.mul(glow).mul(seen).mul(4).mul(skyNow.fireflies)) as any;
    material.colorNode = light;
    const opacity = glow.mul(seen).mul(skyNow.fireflies.min(1)) as any;
    material.opacityNode = opacity;
    const instanced = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) instanced.setMatrixAt(i, identity);
    instanced.frustumCulled = false;
    instanced.layers.set(OVERLAY_LAYER);
    return { mesh: instanced, material, opacity, light };
  }, [count]);

  // Solid things hide them, found by comparing against the depth of the finished scene.
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const scene = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const open = step(scene, positionView.z) as any;
        material.opacityNode = opacity.mul(open);
        material.colorNode = light.mul(open);
        material.needsUpdate = true;
      }),
    [material, opacity, light]
  );
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
    [mesh, material]
  );
  return <primitive object={mesh} />;
}

// A swift, as seen from below: a short body with a forked tail and long wings swept back like a sickle. Each vertex knows
// how far out along a wing it is, which is how much it rises and falls with each beat.
function swiftGeometry() {
  // x out to the right wingtip, z forward. Half a bird, mirrored.
  const half = [
    [0, 0.13],
    [0.025, 0.05],
    [0.07, 0.04],
    [0.15, 0.0],
    [0.24, -0.09],
    [0.14, -0.03],
    [0.04, -0.03],
    [0.03, -0.1],
    [0.045, -0.17],
    [0.0, -0.11]
  ];
  const positions: number[] = [];
  const out: number[] = [];
  for (const flip of [1, -1]) {
    for (const [x, z] of half) {
      positions.push(x * flip, 0, z);
      out.push(Math.max(0, (x - 0.03) / 0.21));
    }
  }
  const n = half.length;
  const triangles = [
    [0, 1, 9],
    [1, 6, 9],
    [1, 2, 6],
    [2, 5, 6],
    [2, 3, 5],
    [3, 4, 5],
    [6, 7, 9],
    [7, 8, 9]
  ];
  const index: number[] = [];
  for (const [a, b, c] of triangles) index.push(a, b, c, a + n, c + n, b + n);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aOut", new THREE.Float32BufferAttribute(out, 1));
  geometry.setIndex(index);
  return geometry;
}

// The sky the flocks wheel in repeats four times per copy of the maze, so it too is the same wherever the camera is
// carried, and close enough round the camera that some flock is always in sight.
const SKY = SPAN / 4;

// Swifts wheeling over the maze in the last of the light, in flocks that wheel together, each bird keeping its own place
// in its flock; every half
// minute or so a crowd of them passing straight over; and now and then bigger birds in a long V, high up, going in and
// out of the cloud. Everything about each one is worked out from the time, so they cost nothing on the CPU.
export function Birds({ air, count, flock, skein }: { air: Air; count: number; flock: number; skein: number }) {
  const { mesh, material } = useMemo(() => {
    const geometry = swiftGeometry();
    const random = mulberry32(9029);
    const total = count + flock + skein;
    const seeds = new Float32Array(total * 4);
    const ways = new Float32Array(total * 4);
    // Each bird's place in its flock: ahead or behind, up or down, out to the side, and a phase of its own.
    const places = new Float32Array(total * 4);
    let flockSeed = [0, 0, 0, 0];
    let flockWay = [0, 0, 0, 0];
    let left = 0;
    for (let i = 0; i < total; i++) {
      seeds.set([random(), random(), random(), random() * 100], i * 4);
      places.set([0, 0, 0, random() * 100], i * 4);
      // Height, radius of its circling, which way round, and which group: 0 circling, 1 the crowd, 2 the V. In the V,
      // its place back from the leader and which side.
      if (i >= count + flock) {
        const k = i - count - flock;
        ways.set([16 + random() * 1.5, Math.ceil(k / 2), k % 2 ? 1 : -1, 2], i * 4);
      } else if (i >= count) {
        ways.set([10 + random() * 5, 0, 1, 1], i * 4);
      } else {
        // In flocks of eighteen to three dozen, each wheeling low over the maze, three to ten metres above the hedge tops
        // where they can be seen from among the hedges: one place, height, width, way round and time for the whole flock.
        if (left === 0) {
          left = 18 + Math.floor(random() * 19);
          flockSeed = [random(), random(), random(), random() * 100];
          flockWay = [6 + random() * 6, 8 + random() * 12, random() < 0.5 ? -1 : 1, 0];
        }
        left--;
        seeds.set(flockSeed, i * 4);
        ways.set(flockWay, i * 4);
        places.set([(random() - 0.5) * 8, (random() - 0.5) * 2.4, (random() - 0.5) * 6, random() * 100], i * 4);
      }
    }
    geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    geometry.setAttribute("aWay", new THREE.InstancedBufferAttribute(ways, 4));
    geometry.setAttribute("aPlace", new THREE.InstancedBufferAttribute(places, 4));
    // Drawn where they fly, not through the bend: bent a vertex at a time, one high over a hinge is pulled out many times its
    // length.
    const material = made(new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide }), false);
    // Named for styles.ts, which puts them away in the Tron sky.
    material.name = "birds";
    const seed = attribute("aSeed", "vec4") as any;
    const way = attribute("aWay", "vec4") as any;
    const w = seed.w as any;
    const inFlock = way.w.greaterThan(0.5) as any;
    const inV = way.w.greaterThan(1.5) as any;

    // Circling: round its own centre, which keeps to a spot in a sky that repeats, at a swift's pace.
    // Each flock's centre kept within the middle of its sky, so they wheel round about overhead.
    const home = fract(seed.xy.sub(cameraPosition.xz.div(SKY))).sub(0.5).mul(SKY * 0.6) as any;
    const radius = way.y.max(1) as any;
    const speed = float(9).add(seed.z.mul(5)) as any;
    const angle = time.mul(speed).div(radius).mul(way.z).add(w) as any;
    const swoop = sin(time.mul(0.37).add(w.mul(3))).mul(radius.mul(0.15)) as any;
    const c = cos(angle) as any;
    const s = sin(angle) as any;
    const circling = vec3(cameraPosition.x.add(home.x).add(c.mul(radius)), way.x.add(swoop), cameraPosition.z.add(home.y).add(s.mul(radius))) as any;
    const circlingHeading = vec3(s.negate().mul(way.z), 0, c.mul(way.z)) as any;
    // Its own place in the flock, the flock loosening and closing up slowly, and each bird drifting a little in it.
    const place = attribute("aPlace", "vec4") as any;
    const own = place.w as any;
    const breathe = sin(time.mul(0.23).add(w)).mul(0.3).add(1) as any;
    const drift = vec3(sin(time.mul(0.9).add(own)).mul(0.6), sin(time.mul(0.7).add(own.mul(1.3))).mul(0.35), cos(time.mul(0.8).add(own.mul(0.7))).mul(0.6)) as any;
    const across = normalize(cross(circlingHeading, vec3(0, 1, 0))) as any;
    const inFlockAt = circling
      .add(circlingHeading.mul(place.x.mul(breathe).add(drift.x)))
      .add(vec3(0, 1, 0).mul(place.y.mul(breathe).add(drift.y)))
      .add(across.mul(place.z.mul(breathe).add(drift.z))) as any;

    // The crowd: all on one line across the sky, every half minute or so, in a loose crowd that shifts as it goes. The V
    // on a line of its own, less often and slower, each bird keeping its place back and out from the one ahead.
    const every = select(inV, float(43), float(27)) as any;
    const clock = time.add(select(inV, float(17), float(0))).div(every) as any;
    const pass = clock.floor() as any;
    const along = fract(clock) as any;
    const course = pass.mul(2.39996).add(select(inV, float(2.1), float(0.6))) as any;
    const heading = vec3(cos(course), 0, sin(course)) as any;
    const sideways = vec3(sin(course).negate(), 0, cos(course)) as any;
    const crowd = vec2(seed.x.sub(0.5).mul(20).add(sin(time.mul(0.8).add(w)).mul(1.2)), seed.y.sub(0.5).mul(14).add(sin(time.mul(0.6).add(w.mul(2))).mul(1))) as any;
    const vee = vec2(way.z.mul(way.y).mul(4.2).add(sin(time.mul(0.5).add(w)).mul(0.5)), way.y.mul(-3.6).add(sin(time.mul(0.7).add(w.mul(2))).mul(0.4))) as any;
    const offset = select(inV, vee, crowd) as any;
    const stretch = select(inV, float(520), float(320)) as any;
    const flying = vec3(cameraPosition.x, way.x.add(select(inV, float(0), seed.z.sub(0.5).mul(6))), cameraPosition.z)
      .add(heading.mul(along.sub(0.5).mul(stretch).add(offset.y)))
      .add(sideways.mul(offset.x.add(pass.mul(7.3).sin().mul(25)))) as any;

    // Never nearer the eye than a few metres, low swifts and flocks alike: any that would come closer is pushed out.
    const path = select(inFlock, flying, inFlockAt) as any;
    const fromEye = path.sub(cameraPosition) as any;
    const near = length(fromEye).max(1e-3) as any;
    const centre = cameraPosition.add(fromEye.mul(near.max(4).div(near))) as any;
    const forward = select(inFlock, heading, circlingHeading) as any;
    // Banked into the turn, or level in the flock, and the wings beating in bursts between glides.
    const bank = select(inFlock, sin(time.mul(0.7).add(w)).mul(select(inV, float(0.08), float(0.35))), way.z.mul(0.85)) as any;
    const right = normalize(cross(forward, vec3(0, 1, 0))) as any;
    const lift = cross(right, forward) as any;
    const tippedRight = right.mul(cos(bank)).add(lift.mul(sin(bank))) as any;
    const tippedUp = cross(tippedRight, forward) as any;
    const beating = select(inV, float(1), smoothstep(0.2, 0.6, sin(time.mul(0.9).add(own.mul(7))))) as any;
    const out = attribute("aOut", "float") as any;
    // Held in a shallow V, beating down from it; the big birds slow and steady.
    const flap = sin(time.mul(select(inV, float(5.5), float(17))).add(own.mul(11))).mul(beating).mul(0.16).add(0.03).mul(out) as any;
    const scale = select(inV, float(3), float(1.6)) as any;
    const local = positionGeometry.mul(scale) as any;
    // Gone to roost at night: each shrinks away to nothing, the last ones first.
    // And a circling one shrinks away at the sides of the sky it keeps to, where it leaves and comes in on the other side.
    const edge = select(inFlock, float(1), float(1).sub(smoothstep(SKY * 0.24, SKY * 0.3, max(home.x.abs(), home.y.abs())))) as any;
    const roosting = smoothstep(w.mul(0.01).sub(0.05), w.mul(0.01), skyNow.birds).mul(edge) as any;
    shape(material, centre.add(tippedRight.mul(local.x)).add(tippedUp.mul(local.y.add(flap))).add(forward.mul(local.z)).sub(centre).mul(roosting).add(centre));

    // Dark against the sky, going into it with distance.
    const away = length(positionWorld.sub(cameraPosition)) as any;
    const direction = normalize(positionWorld.sub(cameraPosition)) as any;
    const into = float(1).sub(exp(away.mul(-0.009))) as any;
    material.colorNode = mix(color("#120e0b"), mistColour(air, direction), into.mul(0.75));
    const instanced = new THREE.InstancedMesh(geometry, material, total);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < total; i++) instanced.setMatrixAt(i, identity);
    instanced.frustumCulled = false;
    return { mesh: instanced, material };
  }, [air, count, flock, skein]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
    [mesh, material]
  );
  return <primitive object={mesh} />;
}

// Down in the paths the eye opens up to the shade, as it would, and closes again on rising into the evening light.
export function Adapt({ exposure, down }: { exposure: number; down: number }) {
  const gl = useThree((state) => state.gl);
  useFrame(() => {
    gl.toneMappingExposure = exposure * skyNow.exposure * (1 + walking.amount * (down - 1));
  });
  useEffect(
    () => () => {
      gl.toneMappingExposure = exposure;
    },
    [gl, exposure]
  );
  return null;
}
