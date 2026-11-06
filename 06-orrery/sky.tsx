"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  attribute,
  cameraPosition,
  color as tslColor,
  cubeTexture,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  instancedBufferAttribute,
  log,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_float,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  texture as tslTexture,
  time,
  uniform,
  uv,
  vec2,
  vec3
} from "three/tsl";
import { mulberry32, pointHash } from "../shared/engine/random";
import { useSettingRef } from "../shared/engine/settings";
import { sound } from "../shared/engine/sound";
import { MONTHS, SEASONS, ZODIAC, bandStrip, makeBandMasks, type Band } from "./bands";
import { SIGNS, SKY_FIGURES } from "./signs";

const DOME = 100;
const v = (x: number, y: number, z: number) => vec3(x, y, z) as any;

// A band of stars over a grid on the sphere: each cell holds at most one, and only the lucky ones do.
function starLayer(direction: any, density: number, rarity: number, brightness: number, size = 0.24) {
  const grid = direction.mul(density) as any;
  const cell = floor(grid) as any;
  const luck = fract(sin(dot(cell, v(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;
  const tone = fract(luck.mul(97.13)) as any;
  const twinkle = sin(time.mul(1.1).add(luck.mul(90))).mul(0.2).add(0.8) as any;
  const point = smoothstep(size, 0.02, (fract(grid).sub(0.5) as any).length()) as any;
  const tint = mix(tslColor("#9dbcff"), tslColor("#ffd8ad"), tone);
  return tint.mul(smoothstep(rarity, 1, luck).mul(point).mul(twinkle).mul(brightness));
}

// Stars that really flicker: most of the time they sit low, with each going on its own uneven beat.
function flickerLayer(direction: any, density: number, rarity: number, brightness: number) {
  const grid = direction.mul(density) as any;
  const cell = floor(grid) as any;
  const luck = fract(sin(dot(cell, v(41.31, 17.77, 93.13))).mul(24634.6345)) as any;
  const beat = sin(time.mul(luck.mul(5).add(1.6)).add(luck.mul(200))).mul(0.5).add(0.5) as any;
  const stutter = sin(time.mul(luck.mul(17).add(7)).add(luck.mul(90))).mul(0.5).add(0.5) as any;
  const point = smoothstep(0.2, 0.02, (fract(grid).sub(0.5) as any).length()) as any;
  const tint = mix(tslColor("#b4ccff"), tslColor("#ffe2c0"), fract(luck.mul(61.7)));
  return tint.mul(smoothstep(rarity, 1, luck).mul(point).mul(pow(beat, float(2.2)).mul(stutter.mul(0.55).add(0.45))).mul(brightness));
}

type Galaxy = { at: [number, number, number]; tilt: number; size: number; squash: number; arms: string };

// Faint and far away, in the greys and tans of a long exposure.
const GALAXIES: Galaxy[] = [
  { at: [-0.988, 0.014, 0.153], tilt: 0.5, size: 0.06, squash: 0.5, arms: "#7f8798" },
  { at: [-0.879, -0.313, -0.361], tilt: 2.1, size: 0.035, squash: 0.72, arms: "#8d8378" },
  { at: [-0.918, -0.276, 0.284], tilt: 1.2, size: 0.045, squash: 0.38, arms: "#7d8592" },
  { at: [-0.3, 0.85, 0.42], tilt: 2.7, size: 0.075, squash: 0.6, arms: "#857f7a" },
  { at: [0.5, 0.3, 0.81], tilt: 0.2, size: 0.05, squash: 0.45, arms: "#7a8496" },
  { at: [-0.2, -0.5, 0.84], tilt: 1.7, size: 0.04, squash: 0.8, arms: "#8a8279" }
];

// A spiral seen at a slant: two arms winding out of a soft core, over a fading disc.
function paintGalaxy(direction: any, galaxy: Galaxy) {
  const centre = new THREE.Vector3(...galaxy.at).normalize();
  const side = new THREE.Vector3(0, 1, 0).cross(centre).normalize().applyAxisAngle(centre, galaxy.tilt);
  const up = centre.clone().cross(side);
  const facing = dot(direction, v(centre.x, centre.y, centre.z)) as any;
  const plane = direction.div(max(facing, float(0.05))) as any;
  const x = dot(plane, v(side.x, side.y, side.z)).div(galaxy.size) as any;
  const y = dot(plane, v(up.x, up.y, up.z)).div(galaxy.size * galaxy.squash) as any;
  const radius = x.mul(x).add(y.mul(y)).sqrt() as any;
  const wave = sin(atan(y, x).mul(2).sub(log(radius.add(0.05)).mul(3.4))).mul(0.5).add(0.5) as any;
  const disc = exp(radius.mul(-2.6)) as any;
  const core = exp(radius.mul(radius).mul(-30)) as any;
  const glow = (tslColor(galaxy.arms) as any).mul(pow(wave, float(1.8)).mul(disc).mul(0.42).add(disc.mul(0.14))).add(tslColor("#b3a48e").mul(core.mul(0.5)));
  return glow.mul(smoothstep(0.9, 0.97, facing));
}

const POLE: any = v(0.288, -0.779, -0.557);
const CORE: any = v(-0.913, -0.049, -0.404);

// The Milky Way as a long exposure shows it: mostly stars, over a dim grey haze that warms to a small tan bulge, split by
// fine dark lanes of dust. Together with the far galaxies it never changes, so it is painted once into a cube map.
function paintMilkyWay(direction: any, detail: number) {
  const height = dot(direction, POLE) as any;
  const bulge = pow(dot(direction, CORE).mul(0.5).add(0.5), float(70)) as any;
  const wander = mx_fractal_noise_float(direction.mul(3.4).add(v(4, 2, 1)), detail, 2, 0.5, 1) as any;
  const offset = height.add(wander.mul(0.035)) as any;
  const width = bulge.mul(0.09).add(0.085) as any;
  const haze = exp(offset.mul(offset).div(width.mul(width)).mul(-1)) as any;
  const tuft = mx_fractal_noise_float(direction.mul(16).add(v(9, 1, 6)), detail, 2.1, 0.6, 1).mul(0.6).add(0.72) as any;
  // Dust lies along the very middle of the band, in ragged strands.
  const strands = mx_fractal_noise_float(direction.mul(22).add(height.mul(18)).add(v(1, 7, 3)), detail + 1, 2.2, 0.6, 1) as any;
  const lane = exp(offset.mul(offset).mul(-520)) as any;
  const dust = float(1).sub(smoothstep(-0.1, 0.18, strands).mul(lane.mul(0.88))) as any;
  // A fine grain, which reads as stars too small and many to see apart.
  const grain = mx_noise_float(direction.mul(170)).mul(0.5).add(0.55) as any;
  const light = haze.mul(tuft).mul(dust).mul(grain).mul(bulge.mul(2.1).add(0.26)) as any;
  const tone = mix(tslColor("#4a5266"), tslColor("#b39a7c"), smoothstep(0.02, 0.5, bulge)) as any;
  let colour: any = tslColor("#01020a").add(tone.mul(light.mul(0.15)));
  for (const galaxy of GALAXIES.slice(0, detail > 3 ? GALAXIES.length : 3)) colour = colour.add(paintGalaxy(direction, galaxy));
  return { colour, crowd: haze.mul(dust) };
}

function makeDome(painted: THREE.CubeTexture, detail: number) {
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  const direction = normalize((positionWorld as any).sub(cameraPosition)) as any;
  const height = dot(direction, POLE) as any;
  const crowd = exp(height.mul(height).mul(-90)) as any;
  let colour: any = cubeTexture(painted, direction);
  colour = colour.add(starLayer(direction, 420, 0.96, 1.8, 0.34)).add(starLayer(direction, 210, 0.975, 3.2)).add(starLayer(direction, 90, 0.985, 7, 0.16));
  // Far more faint stars where the band is.
  colour = colour.add(starLayer(direction, 700, 0.8, 1, 0.34).mul(crowd));
  if (detail > 3) colour = colour.add(starLayer(direction, 1100, 0.84, 0.75, 0.38).mul(crowd));
  colour = colour.add(flickerLayer(direction, 150, 0.982, 8)).add(flickerLayer(direction, 62, 0.986, 12));
  material.colorNode = colour;
  return material;
}

// Renders the unchanging part of the sky once, so that its noise costs nothing per frame.
function usePaintedSky(detail: number) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const target = useMemo(() => new THREE.CubeRenderTarget(detail > 3 ? 1536 : 768, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }), [detail]);
  useEffect(() => {
    const scene = new THREE.Scene();
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    material.colorNode = paintMilkyWay(normalize(positionLocal as any), detail).colour;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 40), material);
    scene.add(ball);
    const lens = new THREE.CubeCamera(0.1, 50, target);
    lens.update(gl as any, scene);
    ball.geometry.dispose();
    material.dispose();
    return () => target.dispose();
  }, [gl, target, detail]);
  return target.texture as THREE.CubeTexture;
}

const MOON_AT = new THREE.Vector3(0.076, -0.229, -0.97).multiplyScalar(86);
const MOON_RADIUS = 4.6;
const MOON_LIGHT = new THREE.Vector3(0.82, 0.3, 0.5).normalize();

function makeMoon() {
  const material = new THREE.MeshBasicNodeMaterial({ fog: false, depthWrite: false });
  const n = (positionLocal as any).div(MOON_RADIUS);
  const lit = smoothstep(-0.06, 0.5, dot(n, v(MOON_LIGHT.x, MOON_LIGHT.y, MOON_LIGHT.z))) as any;
  const seas = smoothstep(-0.02, 0.26, mx_fractal_noise_float(n.mul(2.3).add(v(3, 1, 2)), 6, 2, 0.5, 1)) as any;
  const pits = smoothstep(0.26, 0.03, mx_worley_noise_float(n.mul(11))) as any;
  const fine = smoothstep(0.24, 0.02, mx_worley_noise_float(n.mul(30))) as any;
  const ground = mix(tslColor("#b4b0a6"), tslColor("#6f6e6b"), seas.mul(0.8)).mul(float(1).sub(pits.mul(0.16)).sub(fine.mul(0.1)));
  // Its dark side catches a little light back from the Earth, so that it is never a hole in the sky.
  material.colorNode = ground.mul(lit.mul(0.95)).add(tslColor("#05070f").mul(float(1).sub(lit)));
  return material;
}

const STREAKS = 48;
const UP = new THREE.Vector3(0, 1, 0);

// Shooting stars. Each is one long quad turned to face the camera, bright at the head and gone by the tail.
function ShootingStars() {
  const camera = useThree((state) => state.camera);
  const random = useMemo(() => mulberry32(61), []);
  const streaks = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    return Array.from({ length: STREAKS }, () => {
      const brightness = uniform(0);
      const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const along = (uv() as any).x;
      const across = abs((uv() as any).y.sub(0.5)).mul(2) as any;
      material.colorNode = tslColor("#dceaff").mul(pow(along, float(3)).mul(pow(float(1).sub(across), float(2))).mul(brightness).mul(7));
      material.opacityNode = float(1);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      return { mesh, brightness, age: 0, life: 0, power: 1, length: 8, from: new THREE.Vector3(), velocity: new THREE.Vector3() };
    });
  }, []);
  useEffect(
    () => () => {
      streaks[0].mesh.geometry.dispose();
      for (const streak of streaks) (streak.mesh.material as THREE.Material).dispose();
    },
    [streaks]
  );
  const forward = useMemo(() => new THREE.Vector3(), []);
  const side = useMemo(() => new THREE.Vector3(), []);
  const launch = (slow: boolean, quiet: boolean) => {
    const streak = streaks.find((candidate) => !candidate.mesh.visible);
    if (!streak) return;
    const around = random() * Math.PI * 2;
    const height = -0.3 + random() * 1.1;
    const across = Math.sqrt(1 - height * height);
    streak.from.set(Math.cos(around) * across, height, Math.sin(around) * across);
    // Most go where they can be seen.
    camera.getWorldDirection(forward);
    if (streak.from.dot(forward) < 0 && random() < 0.85) streak.from.reflect(forward);
    streak.from.multiplyScalar(82);
    side.crossVectors(streak.from, forward).normalize();
    const speed = slow ? 5 + random() * 9 : 62 + random() * 52;
    streak.velocity.copy(side).multiplyScalar(random() < 0.5 ? 1 : -1).addScaledVector(UP, -0.2 - random() * 0.5).normalize().multiplyScalar(speed);
    streak.age = 0;
    streak.life = slow ? 3 + random() * 4.5 : 0.4 + random() * 0.6;
    streak.power = slow ? 0.35 + random() * 0.3 : 1;
    streak.length = slow ? 3 + random() * 4 : 5 + speed * 0.16;
    streak.mesh.visible = true;
    if (!quiet) sound.play("whoosh", { gain: 0.03, pitch: 1.3 + random() * 0.5, pan: Math.cos(around) * 0.6 });
  };
  // The quick ones, the slow ones that drift across for seconds, and now and then a little shower.
  const amount = useSettingRef<number>("meteors");
  const due = useRef({ fast: 0, slow: 0, shower: 8 });
  const launches = useRef(launch);
  launches.current = launch;
  const toCamera = useMemo(() => new THREE.Vector3(), []);
  const axisX = useMemo(() => new THREE.Vector3(), []);
  const axisZ = useMemo(() => new THREE.Vector3(), []);
  const basis = useMemo(() => new THREE.Matrix4(), []);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const wanted = amount.current;
    if (wanted > 0.001 && !document.hidden) {
      const next = due.current;
      next.fast -= delta * wanted;
      next.slow -= delta * wanted;
      next.shower -= delta * wanted;
      if (next.fast <= 0) {
        next.fast = 0.18 + random() * 0.62;
        launches.current(false, random() < 0.85);
      }
      if (next.slow <= 0) {
        next.slow = 0.5 + random() * 1.3;
        launches.current(true, true);
      }
      if (next.shower <= 0) {
        next.shower = 6 + random() * 8;
        const count = 4 + Math.floor(random() * 5);
        for (let i = 0; i < count; i++) window.setTimeout(() => launches.current(false, i > 0), i * (60 + random() * 120));
      }
    }
    for (const streak of streaks) {
      if (!streak.mesh.visible) continue;
      streak.age += delta;
      const t = streak.age / streak.life;
      if (t >= 1) {
        streak.mesh.visible = false;
        continue;
      }
      streak.mesh.position.copy(streak.from).addScaledVector(streak.velocity, streak.age);
      streak.brightness.value = streak.power * Math.sin(Math.PI * t) ** 0.6;
      axisX.copy(streak.velocity).normalize();
      toCamera.copy(camera.position).sub(streak.mesh.position).normalize();
      side.crossVectors(toCamera, axisX).normalize();
      axisZ.crossVectors(axisX, side).normalize();
      basis.makeBasis(axisX, side, axisZ);
      streak.mesh.quaternion.setFromRotationMatrix(basis);
      streak.mesh.scale.set(streak.length * Math.min(1, 0.3 + t * 3), 0.2, 1);
    }
  });
  return (
    <>
      {streaks.map((streak, index) => (
        <primitive key={index} object={streak.mesh} />
      ))}
    </>
  );
}

const FIGURE_DISTANCE = 90;

// What makes the constellations show: they light when the Sun is grabbed and stay until the machine goes back together,
// gathered behind what the camera was looking at.
export type SkyLights = { lit: boolean; view: THREE.Vector3 };

// Their lines draw themselves from star to star, as thin ribbons lying on the sky. The figures are laid out around -z, most
// tightly near it, and the whole sky is turned to face the viewer at the moment of the grab, so a good few are always in view.
function Constellations({ lights }: { lights: SkyLights }) {
  const camera = useThree((state) => state.camera);
  const progress = useMemo(() => uniform(0), []);
  const fade = useMemo(() => uniform(0), []);
  const basis = useMemo(() => ({ x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3(), matrix: new THREE.Matrix4() }), []);

  const mesh = useMemo(() => {
    const figures = [...SIGNS, ...SKY_FIGURES];
    const positions: number[] = [];
    const info: number[] = [];
    const home: number[] = [];
    const indices: number[] = [];
    const up = new THREE.Vector3();
    const quad = (corners: THREE.Vector3[], kind: number, along: [number, number], centre: THREE.Vector3, phase: number) => {
      const start = positions.length / 3;
      corners.forEach((corner, index) => {
        positions.push(corner.x, corner.y, corner.z);
        // along the line (or x across a star), across it, whether it is a star, and a little of its own timing.
        info.push(index === 0 || index === 3 ? along[0] : along[1], index < 2 ? -1 : 1, kind, phase);
        home.push(centre.x, centre.y, centre.z);
      });
      indices.push(start, start + 2, start + 1, start, start + 3, start + 2);
    };
    figures.forEach((figure, figureIndex) => {
      const t = (figureIndex + 0.5) / figures.length;
      const away = Math.acos(1 - 2 * t ** 1.6);
      const round = figureIndex * 2.39996;
      const centre = new THREE.Vector3(Math.sin(away) * Math.cos(round), Math.sin(away) * Math.sin(round), -Math.cos(away));
      // Facing outward from the middle, the right hand is clockwise.
      const right = new THREE.Vector3().crossVectors(centre, UP).normalize();
      up.crossVectors(right, centre).normalize();
      const spread = Math.tan((13 * Math.PI) / 180);
      const stars = figure.stars.map(([x, y]) => centre.clone().addScaledVector(right, x * spread).addScaledVector(up, y * spread).normalize().multiplyScalar(FIGURE_DISTANCE));
      figure.lines.forEach(([a, b], line) => {
        const across = new THREE.Vector3().subVectors(stars[b], stars[a]).cross(stars[a]).normalize().multiplyScalar(0.09);
        quad([stars[a].clone().sub(across), stars[b].clone().sub(across), stars[b].clone().add(across), stars[a].clone().add(across)], 0, [0, 1], centre, pointHash(figureIndex, line) * 0.1);
      });
      stars.forEach((star, index) => {
        const out = star.clone().normalize();
        const x = new THREE.Vector3().crossVectors(out, UP).normalize();
        const y = new THREE.Vector3().crossVectors(x, out);
        const size = index === 0 ? 0.95 : 0.7;
        const dx = x.multiplyScalar(size);
        const dy = y.multiplyScalar(size);
        quad(
          [star.clone().sub(dx).sub(dy), star.clone().add(dx).sub(dy), star.clone().add(dx).add(dy), star.clone().sub(dx).add(dy)],
          1,
          [-1, 1],
          centre,
          pointHash(figureIndex, index + 40)
        );
      });
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("info", new THREE.Float32BufferAttribute(info, 4));
    geometry.setAttribute("home", new THREE.Float32BufferAttribute(home, 3));
    geometry.setIndex(indices);

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    const data = attribute("info", "vec4") as any;
    const along = data.x as any;
    const across = abs(data.y) as any;
    const isStar = data.z as any;
    const phase = data.w as any;
    // The ones in front of the viewer begin first and it spreads round from there.
    const delay = float(1).add((attribute("home", "vec3") as any).z).mul(0.34).add(phase.mul(0.12)) as any;
    const drawn = (progress as any).sub(delay).div(0.4).clamp(0, 1) as any;
    const line = smoothstep(along.sub(0.02), along, drawn).mul(pow(float(1).sub(across), float(1.6))).mul(drawn.greaterThan(0).select(float(1), float(0))).mul(fade).mul(1.25) as any;
    const round = along.mul(along).add(data.y.mul(data.y)).sqrt() as any;
    const edge = float(1).sub(round).max(0) as any;
    const twinkle = sin(time.mul(1.6).add(phase.mul(40))).mul(0.14).add(0.86) as any;
    const star = pow(edge, float(9)).mul(2.2).add(pow(edge, float(2.6)).mul(1.3)).mul(smoothstep(0, 0.4, drawn)).mul(fade).mul(twinkle) as any;
    material.colorNode = mix(tslColor("#a9c8ff").mul(line), tslColor("#dfeaff").mul(star), isStar);
    const built = new THREE.Mesh(geometry, material);
    built.frustumCulled = false;
    built.renderOrder = -9;
    return built;
  }, [progress, fade]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
    [mesh]
  );

  const chime = useRef(0);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    // Fixed to the camera's position, so that they stay among the stars, which are as far away as anything can be.
    mesh.position.copy(camera.position);
    if (lights.lit) {
      if (fade.value < 0.02 && progress.value === 0) {
        basis.z.copy(lights.view).negate();
        basis.x.crossVectors(UP, basis.z).normalize();
        basis.y.crossVectors(basis.z, basis.x);
        mesh.quaternion.setFromRotationMatrix(basis.matrix.makeBasis(basis.x, basis.y, basis.z));
      }
      fade.value += (1 - fade.value) * Math.min(1, delta * 6);
      progress.value = Math.min(1.5, progress.value + delta * 0.62);
      chime.current -= delta;
      if (progress.value < 1.1 && chime.current <= 0) {
        chime.current = 0.16 + Math.random() * 0.3;
        sound.play("tinkle", { gain: 0.05, pitch: 1.1 + Math.random() * 0.9, pan: Math.random() * 1.6 - 0.8 });
      }
    } else {
      fade.value += (0 - fade.value) * Math.min(1, delta * 1.3);
      if (fade.value < 0.01) progress.value = 0;
    }
  });

  return <primitive object={mesh} />;
}

// Little points of light adrift in the space around the machine, close enough to pass in front of it and behind it.
function Motes({ count }: { count: number }) {
  const mesh = useMemo(() => {
    const random = mulberry32(83);
    const places = new Float32Array(count * 4);
    const drift = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // Spread through a ball around the machine, thinning out towards the edge.
      const distance = 2.2 + Math.pow(random(), 0.62) * 25;
      const y = random() * 2 - 1;
      const round = random() * Math.PI * 2;
      const flat = Math.sqrt(1 - y * y);
      places.set([distance * flat * Math.cos(round), 2.5 + distance * y * 0.8, distance * flat * Math.sin(round), 0.012 + Math.pow(random(), 3) * 0.045], i * 4);
      drift.set([random() * 100, 0.04 + random() * 0.16, 0.25 + random() * 0.75, random()], i * 4);
    }
    const place = instancedBufferAttribute(new THREE.InstancedBufferAttribute(places, 4)) as any;
    const motion = instancedBufferAttribute(new THREE.InstancedBufferAttribute(drift, 4)) as any;
    const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const phase = motion.x as any;
    const speed = motion.y as any;
    const reach = motion.z as any;
    const clock = time.mul(speed).add(phase) as any;
    // Slow, unrelated waves on each axis, so that nothing moves in step or in a line.
    material.positionNode = place.xyz.add(vec3(sin(clock).add(sin(clock.mul(0.37).add(2))), cos(clock.mul(0.71)).add(sin(clock.mul(0.23).add(5))), sin(clock.mul(0.83).add(1)).add(cos(clock.mul(0.31)))).mul(reach));
    const twinkle = sin(time.mul(speed.mul(14).add(0.6)).add(phase)).mul(0.38).add(0.62) as any;
    material.scaleNode = place.w.mul(twinkle.mul(0.35).add(0.8));
    const middle = (uv() as any).sub(0.5).length().mul(2) as any;
    const tint = mix(tslColor("#b9ccff"), tslColor("#ffe6c6"), motion.w);
    material.colorNode = tint.mul(pow(float(1).sub(middle).max(0), float(2.4))).mul(twinkle).mul(2.1);
    material.opacityNode = float(1);
    const sprite = new THREE.Sprite(material);
    sprite.count = count;
    sprite.frustumCulled = false;
    return sprite;
  }, [count]);
  useEffect(() => () => (mesh.material as THREE.Material).dispose(), [mesh]);
  return <primitive object={mesh} />;
}

const BAND_DISTANCE = 92;

// The months, the zodiac and the seasons, as fine lines on the inside of the sky. Like the stars they keep their distance as
// the camera moves, so they are always behind everything else.
function CelestialBands({ picked, hovered, lights, textureWidth }: { picked: { value: number }; hovered: { value: number }; lights: SkyLights; textureWidth: number }) {
  const camera = useThree((state) => state.camera);
  const glow = useMemo(() => uniform(0), []);
  const built = useMemo(() => {
    const masks = makeBandMasks(textureWidth);
    const group = new THREE.Group();
    const make = (band: Band, mask: THREE.Texture, panels: boolean) => {
      const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
      const line = smoothstep(0.04, 0.6, tslTexture(mask, uv()).r) as any;
      // Only the lines: anything filling the band would show its straight edges against the sky.
      let colour: any = tslColor("#c8d8ff").mul(line.mul(float(0.42).add(glow.mul(0.5))));
      if (panels) {
        const around = (uv() as any).x.mul(Math.PI * 2) as any;
        const direction = vec2(cos(around), sin(around)) as any;
        const panel = (angle: any) => smoothstep(Math.cos((15.2 * Math.PI) / 180), Math.cos((14.6 * Math.PI) / 180), dot(direction, vec2(cos(angle), sin(angle)))).mul(angle.greaterThan(-50).select(float(1), float(0)));
        const lit = (panel(picked as any).mul(0.8).add(panel(hovered as any).mul(0.5)) as any).min(1);
        colour = colour.add(tslColor("#ffc27a").mul(lit.mul(line.mul(1.1).add(0.035))));
      }
      material.colorNode = colour;
      const mesh = new THREE.Mesh(bandStrip(band, BAND_DISTANCE), material);
      mesh.frustumCulled = false;
      mesh.renderOrder = -8;
      group.add(mesh);
      return mesh;
    };
    const meshes = [make(SEASONS, masks.seasons, false), make(ZODIAC, masks.zodiac, true), make(MONTHS, masks.months, false)];
    return { masks, group, meshes };
  }, [picked, hovered, textureWidth, glow]);
  useEffect(
    () => () => {
      for (const mask of Object.values(built.masks)) mask.dispose();
      for (const mesh of built.meshes) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    },
    [built]
  );
  useFrame((_, rawDelta) => {
    built.group.position.copy(camera.position);
    glow.value += ((lights.lit ? 1 : 0) - glow.value) * Math.min(1, Math.min(rawDelta, 1 / 20) * 2.5);
  });
  return <primitive object={built.group} />;
}

export function Space({ lights, picked, hovered, textureWidth, detail }: { lights: SkyLights; picked: { value: number }; hovered: { value: number }; textureWidth: number; detail: number }) {
  const painted = usePaintedSky(detail);
  const dome = useMemo(() => makeDome(painted, detail), [painted, detail]);
  const moon = useMemo(() => makeMoon(), []);
  useEffect(
    () => () => {
      dome.dispose();
      moon.dispose();
    },
    [dome, moon]
  );
  return (
    <>
      <mesh material={dome} renderOrder={-10} frustumCulled={false}>
        <sphereGeometry args={[DOME, 40, 24]} />
      </mesh>
      <mesh material={moon} position={MOON_AT} frustumCulled={false} renderOrder={-9.5}>
        <sphereGeometry args={[MOON_RADIUS, 64, 40]} />
      </mesh>
      <CelestialBands picked={picked} hovered={hovered} lights={lights} textureWidth={textureWidth} />
      <Constellations lights={lights} />
      <ShootingStars />
      <Motes count={detail > 3 ? 4500 : 1200} />
    </>
  );
}
