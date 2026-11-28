"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  max,
  mix,
  mx_noise_float,
  normalize,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionView,
  positionWorld,
  pow,
  reflector,
  refract,
  sin,
  smoothstep,
  step,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { weathered } from "./detail";
import { useDispose } from "../shared/engine/dispose";
import { lehmer } from "../shared/engine/random";
import { CAVERNS, CavernRock, CHIMNEY, FOSSIL_PLANE, type Cavern, type Rock } from "./field";
import { caveShade, lamp, overlayMaterial, useOverlay } from "./fx";
import { ammoniteGeometry, fishplates, hangingRib, quartzPoint, railFittings, railGeometry, timber, trilobiteGeometry, vertebra } from "./shapes";
import { pool, sheetGeometry } from "./water";
import { OVERLAY_LAYER } from "../shared/engine/Post";
import { rockUniforms, torchLightAt } from "./rock";
import type { World } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What waits in the caverns, all built at load (and so compiled behind the loader), sealed in the rock until a tunnel
// breaks through: glow-worms on a grotto's roof, a geode's amethyst, an underground lake, an old mine's timbers and
// rails, ammonites in a shale wall.

const byKind = (kind: Cavern["kind"]) => CAVERNS.find((c) => c.kind === kind) as Cavern;
const opened = (kind: Cavern["kind"]) => rockUniforms.opened.element(CAVERNS.indexOf(byKind(kind))) as any;

// The glow-worms wake in a wave spreading from where the grotto was broken into, a little brighter as it passes.
const WAKE_SPEED = 2.4;
function wake(at: any) {
  const front = (rockUniforms.since as any).mul(WAKE_SPEED).sub(at.sub(rockUniforms.breach).length()) as any;
  return smoothstep(0, 0.9, front).add(exp(front.sub(0.3).mul(front.sub(0.3)).div(-0.12)).mul(1.6)) as any;
}

// Where a ray from inside a cavern meets its wall, and the wall's outward (into the cavern) normal.
// `broad` takes the normal over that much of the wall, for things lying across it.
function wallHit(field: Rock, from: THREE.Vector3, dir: THREE.Vector3, far: number, normal: THREE.Vector3, broad = 0.1) {
  const t = field.march(from.x, from.y, from.z, dir.x, dir.y, dir.z, far);
  if (t <= 0) return null;
  const p = from.clone().addScaledVector(dir, t);
  const g = [0, 0, 0];
  field.gradient(p.x, p.y, p.z, g, broad);
  normal.set(-g[0], -g[1], -g[2]).normalize();
  return p;
}

// ---- Glow-worms ----------------------------------------------------------------------------------------------------

function GlowWorms() {
  const built = useMemo(() => {
    const cave = byKind("grotto");
    // Placed against the cavern's own walls alone: far quicker than the whole rock, and the same surfaces.
    const field = new CavernRock(cave);
    const random = lehmer(4401);
    const at: number[] = [];
    const seeds: number[] = [];
    const from = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const normal = new THREE.Vector3();
    for (let n = 0; n < 30000 && at.length < 9000 * 4; n++) {
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(random()) * 0.97;
      from.set(cave.centre[0] + Math.cos(a) * r * cave.size[0], cave.centre[1], cave.centre[2] + Math.sin(a) * r * cave.size[2]);
      if (field.sample(from.x, from.y, from.z) > -0.1) continue;
      const p = wallHit(field, from, up, cave.size[1] * 2.5, normal);
      // Only on the roof, and more of them in its hollows.
      if (!p || normal.y > -0.35) continue;
      // Each hangs its thread of sticky beads below it.
      const drop = 0.03 + Math.pow(random(), 2) * 0.32;
      at.push(p.x, p.y - 0.008, p.z, drop);
      seeds.push(random(), random(), random(), random());
    }
    const count = at.length / 4;
    const dot = new THREE.OctahedronGeometry(1, 0);
    dot.setAttribute("aAt", new THREE.InstancedBufferAttribute(new Float32Array(at), 4));
    dot.setAttribute("aSeed", new THREE.InstancedBufferAttribute(new Float32Array(seeds), 4));
    const material = new THREE.MeshBasicNodeMaterial();
    const s = attribute("aSeed", "vec4") as any;
    const a = attribute("aAt", "vec4") as any;
    // Never smaller than about a pixel and a half across, so the roof reads as stars from the far end of a tunnel.
    const size = max(s.x.mul(0.004).add(0.0025), cameraPosition.sub(a.xyz).length().mul(0.0016)) as any;
    material.positionNode = a.xyz.add(positionGeometry.mul(size)) as any;
    // Each breathes in its own time; some bright, most dim; brighter where they crowd.
    const t = rockUniforms.time as any;
    const pulse = sin(t.mul(s.y.mul(0.6).add(0.2)).add(s.z.mul(40)))
      .mul(0.35)
      .add(0.65) as any;
    const level = pow(s.w, float(2.2)).mul(5).add(0.6).mul(pulse) as any;
    material.colorNode = vec3(0.32, 1.0, 0.84).mul(level).mul(wake(a.xyz)) as any;
    const mesh = new THREE.InstancedMesh(dot, material, count);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // Culled as the grotto: the instances are placed in the shader, so the bounds are given, not measured.
    const bounds = new THREE.Sphere(new THREE.Vector3(...cave.centre), Math.max(...cave.size) + 0.5);
    mesh.boundingSphere = bounds;

    // The threads: thin vertical strips under each worm, beaded with droplets that catch its light.
    const strip = new THREE.PlaneGeometry(1, 1, 1, 4);
    strip.translate(0, -0.5, 0);
    strip.setAttribute("aAt", new THREE.InstancedBufferAttribute(new Float32Array(at), 4));
    strip.setAttribute("aSeed", new THREE.InstancedBufferAttribute(new Float32Array(seeds), 4));
    const silk = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const sa = attribute("aAt", "vec4") as any;
    const ss = attribute("aSeed", "vec4") as any;
    const toEye = normalize(vec3(cameraPosition.x.sub(sa.x), 0, cameraPosition.z.sub(sa.z)).add(vec3(1e-4, 0, 0))) as any;
    const across = vec3(toEye.z.negate(), 0, toEye.x) as any;
    const away = cameraPosition.sub(sa.xyz).length() as any;
    // Never thinner than about a pixel: past that it dims instead.
    const width = max(float(0.0007), away.mul(0.0012)) as any;
    const sway = sin(rockUniforms.time.mul(0.7).add(ss.z.mul(30)))
      .mul(0.004)
      .mul(positionGeometry.y.negate()) as any;
    silk.positionNode = sa.xyz.add(across.mul(positionGeometry.x.mul(width))).add((vec3 as any)(sway, positionGeometry.y.mul(sa.w), 0)) as any;
    const along = positionGeometry.y.negate() as any;
    const beads = pow(
      sin(along.mul(sa.w).mul(260).add(ss.x.mul(20)))
        .mul(0.5)
        .add(0.5),
      float(8)
    ) as any;
    const thin = float(0.0007).div(width) as any;
    silk.colorNode = vec3(0.3, 0.9, 0.8)
      .mul(beads.mul(0.9).add(0.12))
      .mul(float(1).sub(along.mul(0.6)))
      .mul(thin)
      .mul(pow(ss.w, float(1.5)).mul(0.8).add(0.2))
      .mul(wake(sa.xyz))
      .mul(0.5) as any;
    const threads = new THREE.InstancedMesh(strip, silk, count);
    threads.boundingSphere = bounds;

    // A faint halo in the damp air round every tenth worm, so the roof glows rather than only twinkles.
    const haloAt: number[] = [];
    for (let k = 0; k < count; k += 14) haloAt.push(at[k * 4], at[k * 4 + 1] - 0.05, at[k * 4 + 2], 0.15 + seeds[k * 4] * 0.25);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aHalo", new THREE.InstancedBufferAttribute(new Float32Array(haloAt), 4));
    const halo = overlayMaterial();
    const halos = new THREE.InstancedMesh(quad, halo, haloAt.length / 4);
    halos.frustumCulled = false;
    halos.layers.set(OVERLAY_LAYER);
    return { dot, material, mesh, strip, silk, threads, quad, halo, halos };
  }, []);
  useDispose(built.dot, built.material, built.strip, built.silk, built.quad, built.halo);
  useOverlay(built.halo, (sceneZ) => {
    const h = attribute("aHalo", "vec4") as any;
    const toEye = normalize(cameraPosition.sub(h.xyz)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    built.halo.positionNode = h.xyz.add(right.mul(positionGeometry.x.mul(h.w))).add(up.mul(positionGeometry.y.mul(h.w))) as any;
    const r = uv().sub(0.5).length() as any;
    const soft = pow(float(1).sub(smoothstep(0, 0.5, r)), float(2)) as any;
    const behind = clamp(positionView.z.sub(sceneZ).div(0.3).add(1), 0, 1) as any;
    built.halo.colorNode = vec4(
      vec3(0.2, 0.75, 0.62)
        .mul(soft)
        .mul(behind)
        .mul(varying(wake(h.xyz)))
        .mul(0.035),
      1
    ) as any;
    built.halo.needsUpdate = true;
  });
  return (
    <>
      <primitive object={built.mesh} />
      <primitive object={built.threads} />
      <primitive object={built.halos} />
    </>
  );
}

// ---- Geode ---------------------------------------------------------------------------------------------------------

function Geode() {
  const built = useMemo(() => {
    const cave = byKind("geode");
    // Placed against the cavern's own walls alone: far quicker than the whole rock, and the same surfaces.
    const field = new CavernRock(cave);
    const random = lehmer(9271);
    const from = new THREE.Vector3(...cave.centre);
    const dir = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const matrices: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const tilt = new THREE.Quaternion();
    const yAxis = new THREE.Vector3(0, 1, 0);
    // One lining grown inward from the shell, as a real geode: points packed edge to edge over the whole wall, every one
    // aimed at the middle, longer where the wall is deeper in shadow below, with a few big ones breaking the surface.
    const place = (d: THREE.Vector3, length: number, lean: number, wide: number) => {
      const p = wallHit(field, from, d, cave.size[0] * 2, normal);
      if (!p) return;
      const width = length * wide;
      q.setFromUnitVectors(yAxis, normal);
      tilt.setFromEuler(new THREE.Euler((random() - 0.5) * lean, random() * 6.3, (random() - 0.5) * lean));
      q.multiply(tilt);
      p.addScaledVector(normal, -0.02);
      matrices.push(new THREE.Matrix4().compose(p, q.clone(), new THREE.Vector3(width, length, width)));
    };
    const LINING = 2400;
    for (let k = 0; k < LINING; k++) {
      // Spread evenly over the sphere of directions (a Fibonacci spiral), jittered a little.
      const y = 1 - ((k + 0.5) / LINING) * 2;
      const r = Math.sqrt(1 - y * y);
      const a = k * 2.39996 + random() * 0.05;
      dir.set(Math.cos(a) * r + (random() - 0.5) * 0.02, y, Math.sin(a) * r + (random() - 0.5) * 0.02).normalize();
      place(dir, (0.22 + Math.pow(random(), 1.4) * 0.28) * (1.1 - y * 0.2), 0.4, 0.17 + random() * 0.06);
    }
    for (let k = 0; k < 60; k++) {
      dir.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize();
      place(dir, 0.6 + random() * 0.35, 0.3, 0.17);
    }
    // Each point a quartz crystal (`quartzPoint`): a prism of uneven faces under an off-centre termination.
    const geometry = quartzPoint();
    // Clear quartz going violet: smoky and darker at the root, paler toward the point, a little different crystal to
    // crystal. Glassy, with a hard clear coat for sharp highlights.
    const material = new THREE.MeshPhysicalNodeMaterial({ clearcoat: 1, clearcoatRoughness: 0.02 });
    const h = clamp(positionGeometry.y, 0, 1) as any;
    const tint = hash(instanceIndex.add(7)) as any;
    const violet = mix(vec3(0.44, 0.28, 0.68), vec3(0.6, 0.46, 0.8), tint) as any;
    const face = attribute("aFace", "float") as any;
    const end = attribute("aEnd", "float") as any;
    // Quartz's own mark: fine lines across the prism faces (none on the termination), a little rougher in the grooves.
    const striae = pow(
      sin(positionGeometry.y.mul(150).add(face.mul(40)).add(sin(positionGeometry.y.mul(23).add(face.mul(9))).mul(2)))
        .mul(0.5)
        .add(0.5),
      float(4)
    ).mul(float(1).sub(end)) as any;
    // Amethyst's colour zoned in bands toward the point (phantoms), deepest just under the termination.
    const zoning = smoothstep(0.55, 0.95, h).add(smoothstep(0.9, 1, sin(h.mul(19).add(tint.mul(30)))).mul(0.25)) as any;
    material.colorNode = mix(vec3(0.13, 0.1, 0.16), violet, smoothstep(0.0, 0.85, h))
      .mul(tint.mul(0.3).add(0.75))
      .mul(float(1).sub(zoning.mul(0.25))) as any;
    material.roughnessNode = mix(float(0.025), float(0.14), striae) as any;
    material.metalnessNode = float(0);
    // Light passing through (faked): glowing at edges seen side on, at the paler tips, and where the headlamp is behind
    // the crystal rather than in front of it.
    const n = normalize(normalWorld) as any;
    const toEye = normalize(cameraPosition.sub(positionWorld)) as any;
    const edge = pow(float(1).sub(dot(n, toEye).abs()), float(3)) as any;
    const fromLamp = positionWorld.sub(lamp.position) as any;
    const through = dot(n, normalize(fromLamp)).max(0).mul(lamp.strength).div(dot(fromLamp, fromLamp).mul(0.25).add(1)) as any;
    // What is seen through each face: the view bent in (quartz bends light by about 1.54), and that direction hashed into
    // a room of brighter and darker planes per face, so each facet shows its own inner reflections and the stone turns
    // as the eye moves. Longer paths (seen side on) go deeper violet.
    const bent = refract(toEye.negate(), n, 1 / 1.54) as any;
    const inner = hash(dot(floor(bent.mul(3.5).add(face.mul(7))) as any, vec3(1, 31, 97)).add(instanceIndex)) as any;
    const path = float(1).div(dot(n, toEye).abs().max(0.25)) as any;
    const lampNear = lamp.strength.div(dot(fromLamp, fromLamp).mul(0.2).add(1)) as any;
    const torchG = vertexStage(torchLightAt(positionWorld)) as any;
    // Now and then a tip catches the light and flares: a glint for bloom to bloom.
    const phase = hash(instanceIndex.add(91)) as any;
    const glint = pow(sin(rockUniforms.time.mul(phase.mul(1.7).add(0.6)).add(phase.mul(60))).max(0), float(400))
      .mul(smoothstep(0.85, 0.97, h))
      // Only one crystal in ten ever catches the light just so.
      .mul(step(0.9, phase)) as any;
    material.emissiveNode = violet
      .mul(
        edge
          .mul(0.18)
          .add(h.mul(h).mul(0.08))
          .add(through.mul(h.mul(0.6).add(0.2)).mul(0.5))
          .add(pow(inner, float(3)).mul(lampNear).mul(0.12).mul(path.mul(0.4).add(0.6)))
          .add(striae.mul(edge).mul(0.06))
      )
      .add(vec3(1, 0.95, 1).mul(glint.mul(5)))
      // A torch set in the geode: its warmth comes through the crystals round it, amber blending into the violet,
      // brightest at their edges and tips (per vertex: the torches' light changes over metres, not across a crystal).
      .add(mix(vec3(1.0, 0.55, 0.25), violet, 0.35).mul(torchG.mul(edge.mul(0.6).add(h.mul(0.3)).add(0.05)).mul(0.25)))
      .mul(opened("geode")) as any;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return { geometry, material, mesh };
  }, []);
  useDispose(built.geometry, built.material);
  return <primitive object={built.mesh} />;
}

// ---- Lake ----------------------------------------------------------------------------------------------------------

function Lake() {
  const camera = useThree((state) => state.camera);
  const cave = byKind("lake");
  const level = cave.water as number;
  const built = useMemo(() => {
    // The water out to the bowl's own walls at its level (and a little into them), not a disc a sixth wider than the
    // cavern: that one ran on into the rock round it, and any tunnel dug past the lake at its level found the water
    // hanging there.
    const field = new CavernRock(cave);
    const centre = new THREE.Vector3(cave.centre[0], level, cave.centre[2]);
    const geometry = sheetGeometry(pool(field, field, centre, level, 72, 3));
    // A quarter-size reflection: still sharp enough on dark water, and the cavern's rock drawn a second time is the
    // whole cost of the lake.
    const mirror = reflector({ resolutionScale: 0.25, bounces: false }) as any;
    mirror.target.rotateX(-Math.PI / 2);
    mirror.target.position.set(cave.centre[0], level, cave.centre[2]);
    const p = positionWorld as any;
    // A faint shiver on the surface, and slow rings spreading from under the chimney where drips land.
    const t = rockUniforms.time as any;
    const fromDrip = p.xz.sub(vec2(CHIMNEY.from[0], CHIMNEY.from[2])).length() as any;
    const rings = sin(fromDrip.mul(26).sub(t.mul(5)))
      .mul(exp(fromDrip.mul(-1.1)))
      .mul(0.006) as any;
    const ripple = sin(p.x.mul(3.1).add(t.mul(0.8)))
      .mul(sin(p.z.mul(2.7).sub(t.mul(0.6))))
      .mul(0.0008)
      .add(rings.mul(0.5)) as any;
    mirror.uvNode = mirror.uvNode.add(vec2(ripple, ripple.mul(0.7)));
    const material = new THREE.MeshStandardNodeMaterial();
    const toEye = normalize(cameraPosition.sub(p)) as any;
    const fresnel = float(0.1).add(pow(float(1).sub(max(toEye.y, 0)), float(3)).mul(0.9)) as any;
    // Dark, clear water: what shows is what it reflects, the glints of the lights on it, and the pool of day
    // light where the chimney's beam meets it.
    // The bed showing through: how deep the water is over the cavern's bowl at this point, and the wet rock's colour
    // dimmed by that depth of water, red going first (blue-green over the deep middle).
    const [cx, cy, cz] = cave.centre;
    const [sx, sy, sz] = cave.size;
    const rx = p.x.sub(cx).div(sx) as any;
    const rz = p.z.sub(cz).div(sz) as any;
    const bedY = float(cy).sub(float(sy).mul(float(1).sub(rx.mul(rx)).sub(rz.mul(rz)).max(0).sqrt())) as any;
    const deep = float(level).sub(bedY).max(0) as any;
    // A pale limestone bed, so the water over it shows turquoise, deepening to teal and then near black.
    const bed = vec3(0.7, 0.66, 0.56).mul(
      sin(p.x.mul(5.3).add(sin(p.z.mul(4.1)).mul(2)))
        .mul(0.12)
        .add(0.88)
    ) as any;
    material.colorNode = bed
      .mul(exp(vec3(2.2, 0.55, 0.42).mul(deep).mul(-1.6)))
      .mul(float(1).sub(fresnel.mul(0.8)))
      .add(vec3(0.002, 0.01, 0.012)) as any;
    material.roughnessNode = float(0.03);
    material.metalnessNode = float(0);
    // Where the chimney's light lands, a glowing pool on the surface, rippling.
    const fromPool = p.xz.sub(vec2(CHIMNEY.from[0] - (CHIMNEY.to[0] - CHIMNEY.from[0]) * 0.25, CHIMNEY.from[2] - (CHIMNEY.to[2] - CHIMNEY.from[2]) * 0.25)).length() as any;
    const sunlit = exp(fromPool.mul(fromPool).div(-0.6)).mul(rings.mul(25).add(1)).mul(opened("lake")) as any;
    material.emissiveNode = mirror.rgb.mul(fresnel).add(vec3(1.0, 0.78, 0.56).mul(sunlit.mul(0.35))) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = false;

    // Daylight down the chimney: a narrow spot from above the plateau onto the water.
    const [ax, ay, az] = CHIMNEY.from;
    const [bx, by, bz] = CHIMNEY.to;
    const light = new THREE.SpotLight("#fff2e0", 0, 18, 0.3, 0.85, 1);
    light.position.set(bx + (bx - ax) * 0.2, by + 2, bz + (bz - az) * 0.2);
    light.target.position.set(ax - (bx - ax) * 0.25, level, az - (bz - az) * 0.25);

    // The shaft itself, seen in the damp air: a soft cone drawn in the overlay pass, brightest down its middle.
    const height = ay + 0.6 - level;
    const cone = new THREE.CylinderGeometry(0.45, 1.25, height, 32, 1, true);
    cone.translate(0, -height / 2, 0);
    const shaft = overlayMaterial();
    shaft.side = THREE.DoubleSide;
    const beam = new THREE.Mesh(cone, shaft);
    beam.position.set(ax + 0.05, ay + 0.6, az + 0.05);
    beam.lookAt(light.target.position);
    // Its length runs down -y: turned so that points at the water.
    beam.rotateX(-Math.PI / 2);
    beam.frustumCulled = false;
    beam.layers.set(OVERLAY_LAYER);
    return { geometry, material, mesh, mirror, light, cone, shaft, beam, height, centre };
  }, [cave, level]);
  useDispose(built.geometry, built.material, built.cone, built.shaft);
  useOverlay(built.shaft, (sceneZ) => {
    const toEye = normalize(cameraPosition.sub(positionWorld)) as any;
    // Bright where the eye looks through the thick middle, gone at the cone's edges seen side on.
    const through = pow(dot(normalize(normalWorld), toEye).abs(), float(2)) as any;
    const along = positionGeometry.y.negate().div(built.height) as any;
    const fade = smoothstep(0, 0.15, along).mul(float(1).sub(smoothstep(0.75, 1, along))) as any;
    const motes = sin(
      positionWorld.y
        .mul(9)
        .add(rockUniforms.time.mul(0.4))
        .add(sin(positionWorld.x.mul(13)).mul(2))
    )
      .mul(0.15)
      .add(0.85) as any;
    const behind = clamp(positionView.z.sub(sceneZ).div(0.3).add(1), 0, 1) as any;
    // Drawn where it stands (the overlay material parks its vertices out of sight until it is built).
    built.shaft.positionNode = positionLocal;
    built.shaft.colorNode = vec4(vec3(1.0, 0.82, 0.66).mul(through.mul(fade).mul(motes).mul(behind).mul(0.16).mul(opened("lake"))), 1) as any;
    built.shaft.needsUpdate = true;
  });
  const near = useRef(false);
  useFrame(() => {
    // Only drawn (and only reflecting, which draws the scene again) once open and while near.
    const amount = rockUniforms.opened.array[CAVERNS.indexOf(cave)] as number;
    const open = amount > 0;
    const d = camera.position.distanceTo(built.centre);
    near.current = open && d < 18;
    built.mesh.visible = near.current;
    built.light.intensity = 70 * amount;
  });
  return (
    <>
      <primitive object={built.mesh} />
      <primitive object={built.mirror.target} />
      <primitive object={built.light} />
      <primitive object={built.light.target} />
      <primitive object={built.beam} />
    </>
  );
}

// ---- Mine ----------------------------------------------------------------------------------------------------------

function Mine() {
  const built = useMemo(() => {
    const cave = byKind("mine");
    const field = new CavernRock(cave);
    const random = lehmer(5150);
    const [cx, cy, cz] = cave.centre;
    // The passage's real floor and roof at a point (its walls are hewn and uneven, its floor some 15 cm under the box it
    // was drawn from): everything stands on them, never on a level guessed from the outline.
    const floorAt = (x: number, z: number) => {
      const d = field.march(x, cy, z, 0, -1, 0, 3);
      return d >= 0 ? cy - d : (cave.floor as number);
    };
    const roofAt = (x: number, z: number) => {
      const d = field.march(x, cy, z, 0, 1, 0, 3);
      return d >= 0 ? cy + d : cy + cave.size[1];
    };
    const wallAt = (x: number, y: number, side: number) => {
      const d = field.march(x, y, cz, 0, 0, side, 3);
      return d >= 0 ? d : cave.size[2];
    };

    // Every piece of wood as one instanced timber (`timber`: chamfered, its length along y), scaled to its true size,
    // with its look: length and thickness in metres (so the grain is the same scale on every piece), and a seed.
    const wood: { m: THREE.Matrix4; look: number[] }[] = [];
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const add = (x: number, y: number, z: number, w: number, length: number, d: number, rx = 0, ry = 0, rz = 0) =>
      wood.push({
        m: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(rx, ry, rz)).clone(), new THREE.Vector3(w, length, d)),
        look: [length, Math.max(w, d), random(), 0]
      });

    // Sets of timber every couple of metres: two posts on the real floor, standing off the walls, a cap across under
    // the roof, knee braces in most, lagging boards over the caps, and blocking wedged between them and the rock. A few
    // caps sag; one has come down.
    let x = cx - cave.size[0] + 0.8;
    while (x < cx + cave.size[0] - 0.6) {
      const spacing = 1.8 + random() * 0.25;
      const roof = Math.min(roofAt(x, cz - 0.6), roofAt(x, cz), roofAt(x, cz + 0.6));
      const capY = roof - 0.17;
      const sag = random() < 0.15 ? 0.1 + random() * 0.08 : 0;
      const posts: number[] = [];
      for (const side of [-1, 1]) {
        const z = cz + side * Math.min(0.93, wallAt(x, capY - 0.8, side) - 0.14);
        posts.push(z);
        const foot = floorAt(x, z) - 0.06;
        const top = capY - 0.1 - (sag ? 0.02 : 0);
        add(x + (random() - 0.5) * 0.04, (foot + top) / 2, z, 0.2, top - foot, 0.2, (random() - 0.5) * 0.04, (random() - 0.5) * 0.2, (random() - 0.5) * 0.04);
        // A knee brace from post to cap.
        if (random() < 0.7) {
          const run = 0.42;
          add(x, top - run / 2, z - side * run * 0.5, 0.12, run * Math.SQRT2 + 0.08, 0.12, -side * (Math.PI / 4), 0, 0);
        }
      }
      const half = (posts[1] - posts[0]) / 2;
      add(x, capY - sag * 0.5, (posts[0] + posts[1]) / 2, 0.22, half * 2 + 0.36, 0.2, Math.PI / 2 + (random() - 0.5) * 0.03, 0, sag * (random() < 0.5 ? 1 : -1));
      // Lagging over the cap to the next set, boards along the passage, one or two gone or slipped.
      const next = x + spacing;
      if (next < cx + cave.size[0] - 0.6)
        for (let k = -3; k <= 3; k++) {
          if (random() > 0.86) continue;
          const z = cz + k * 0.28 + (random() - 0.5) * 0.03;
          const slip = random() < 0.08 ? 0.12 : 0;
          add((x + next) / 2, capY + 0.125 - slip, z, 0.045, spacing + 0.12, 0.23 + random() * 0.03, slip * 1.5, 0, Math.PI / 2 + (random() - 0.5) * 0.03);
        }
      // Blocking: short wedges between the lagging and the rock where they do not meet.
      for (const z of [cz - 0.56, cz, cz + 0.56]) {
        const gap = roofAt(x, z) - (capY + 0.15);
        if (gap > 0.08 && random() < 0.8) add(x + (random() - 0.5) * 0.1, capY + 0.15 + gap / 2 + 0.03, z, 0.16, gap + 0.1, 0.22, 0, (random() - 0.5) * 0.5, 0);
      }
      x = next;
    }
    // A fallen cap across the floor, and a split post lying by the wall.
    add(cx + 2.3, floorAt(cx + 2.3, cz + 0.1) + 0.1, cz + 0.1, 0.2, 2.1, 0.2, Math.PI / 2 - 0.12, 0.5, 1.5);
    add(cx - 4.1, floorAt(cx - 4.1, cz - 0.6) + 0.09, cz - 0.6, 0.18, 1.5, 0.12, 0, 0.2, Math.PI / 2 - 0.05);

    // The track: narrow gauge, rails in lengths of about four metres, each straight from joint to joint, on tie plates
    // on sleepers half sunk in the floor, spiked down. The bed follows the real floor, smoothed over a metre and a half.
    const gauge = 0.6;
    const x0 = cx - cave.size[0] + 0.5;
    const x1 = cx + cave.size[0] - 0.5;
    const bedStep = 0.25;
    const raw: number[] = [];
    for (let bx = x0; bx <= x1 + 1e-6; bx += bedStep) raw.push((floorAt(bx, cz - 0.45) + floorAt(bx, cz) + floorAt(bx, cz + 0.45)) / 3);
    const bed = raw.map((_, i) => {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, i - 3); k <= Math.min(raw.length - 1, i + 3); k++, count++) sum += raw[k];
      return sum / count;
    });
    const bedAt = (bx: number) => {
      const f = Math.max(0, Math.min(bed.length - 1.001, (bx - x0) / bedStep));
      const i = Math.floor(f);
      return bed[i] + (bed[i + 1] - bed[i]) * (f - i);
    };
    // Where the rails' feet sit: the sleepers' tops (4.5 cm over the bed) and the plates on them.
    const joints: number[] = [];
    for (let jx = x0; jx < x1; jx += 4.0 + random() * 0.4) joints.push(jx);
    joints.push(x1);
    const footAt = (jx: number) => bedAt(jx) + 0.045 + 0.008;
    const railAt = (rx: number) => {
      let k = 0;
      while (k < joints.length - 2 && joints[k + 1] < rx) k++;
      const f = (rx - joints[k]) / (joints[k + 1] - joints[k]);
      return footAt(joints[k]) + (footAt(joints[k + 1]) - footAt(joints[k])) * f;
    };
    const rails: THREE.Matrix4[] = [];
    const plates: THREE.Matrix4[] = [];
    for (let k = 0; k < joints.length - 1; k++) {
      const a = joints[k];
      const b = joints[k + 1];
      const ya = footAt(a);
      const yb = footAt(b);
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(yb - ya, b - a));
      for (const side of [-1, 1]) {
        const z = cz + (side * gauge) / 2 + (random() - 0.5) * 0.006;
        rails.push(new THREE.Matrix4().compose(new THREE.Vector3((a + b) / 2, (ya + yb) / 2, z), tilt, new THREE.Vector3(Math.hypot(b - a, yb - ya) - 0.006, 1, 1)));
        if (k > 0) plates.push(new THREE.Matrix4().compose(new THREE.Vector3(a, ya, z), tilt, new THREE.Vector3(1, 1, 1)));
      }
    }
    const spikes: THREE.Matrix4[] = [];
    for (let tx = x0 + 0.25; tx < x1 - 0.1; tx += 0.6 + (random() - 0.5) * 0.06) {
      const rot = random();
      // A few sleepers rotted away, a few sunk.
      if (rot < 0.05) continue;
      const top = railAt(tx) - 0.008 - (rot > 0.88 ? 0.025 : 0);
      const yaw = (random() - 0.5) * 0.06;
      wood.push({
        m: new THREE.Matrix4().compose(new THREE.Vector3(tx, top - 0.06, cz + (random() - 0.5) * 0.04), q.setFromEuler(e.set(Math.PI / 2, yaw, 0, "YXZ")).clone(), new THREE.Vector3(0.17, rot > 0.88 ? 0.9 : 1.08, 0.12)),
        look: [1.08, 0.17, random(), 1]
      });
      spikes.push(new THREE.Matrix4().compose(new THREE.Vector3(tx, railAt(tx) - 0.008, cz), q.setFromEuler(e.set(0, yaw, 0)).clone(), new THREE.Vector3(1, 1, 1)));
    }

    const box = timber();
    const woodLook = new Float32Array(wood.length * 4);
    wood.forEach((w, k) => woodLook.set(w.look, k * 4));
    box.setAttribute("aWood", new THREE.InstancedBufferAttribute(woodLook, 4));
    // Old pine, greyed and dried: the grain in metres along each piece (streaks along, the rings' figure where the saw
    // cut across them, rings on the ends round an off-centre heart), dry checks split along its length, a knot now and
    // then; the chamfered edges worn pale and smooth; dark, damp and muddy toward the floor; a white bloom of minerals
    // in patches up high.
    const timberMaterial = new THREE.MeshStandardNodeMaterial();
    const look = attribute("aWood", "vec4") as any;
    const g = positionGeometry as any;
    const along = g.y.mul(look.x) as any;
    const across = vec2(g.x, g.z).mul(look.y) as any;
    const seed = look.z as any;
    const endGrain = attribute("aEndGrain", "float") as any;
    const chamfer = attribute("aChamfer", "float") as any;
    const heart = vec2(sin(seed.mul(40)), cos(seed.mul(30))).mul(look.y.mul(0.35)) as any;
    const wobble = mx_noise_float(vec3(across.mul(6), along.mul(0.6).add(seed.mul(50)))) as any;
    const rings = sin(across.sub(heart).length().mul(170).add(wobble.mul(4)))
      .mul(0.5)
      .add(0.5) as any;
    const streaks = mx_noise_float(vec3(across.x.mul(60), along.mul(1.4), across.y.mul(60).add(seed.mul(20)))) as any;
    const checks = smoothstep(0.04, 0, abs(mx_noise_float(vec3(across.mul(8), along.mul(0.35).add(seed.mul(9))))))
      .mul(float(1).sub(endGrain))
      .mul(smoothstep(0.3, 0.6, mx_noise_float(vec3(along.mul(0.5), seed.mul(7), 2)))) as any;
    const knotAt = along.mul(1.4).add(seed.mul(13)) as any;
    const knotSeed = hash(floor(knotAt).add(seed.mul(100))) as any;
    const knotPlace = vec2(sin(knotSeed.mul(60)), cos(knotSeed.mul(60))).mul(look.y.mul(0.5)) as any;
    const knot = smoothstep(0.035, 0.015, vec3(fract(knotAt).sub(0.5).div(1.4), across.sub(knotPlace)).length())
      .mul(step(0.55, knotSeed))
      .mul(float(1).sub(endGrain)) as any;
    const fromFloor = positionWorld.y.sub(0.45) as any;
    const damp = smoothstep(0.7, 0, fromFloor) as any;
    const bloom = smoothstep(0.55, 0.8, mx_noise_float(positionWorld.mul(2.3)))
      .mul(smoothstep(1.3, 2.2, fromFloor))
      .mul(float(1).sub(look.w)) as any;
    const pine = mix(vec3(0.24, 0.18, 0.12), vec3(0.33, 0.26, 0.18), seed)
      .mul(rings.mul(mix(float(0.12), float(0.3), endGrain)).add(0.8))
      .mul(streaks.mul(0.12).add(0.9))
      .mul(float(1).sub(endGrain.mul(0.3))) as any;
    const worn = mix(pine, pine.mul(1.3).add(0.02), chamfer.mul(0.6)) as any;
    const marked = mix(mix(worn, worn.mul(0.25), checks), vec3(0.07, 0.045, 0.03), knot) as any;
    timberMaterial.colorNode = mix(mix(marked, marked.mul(0.45).add(vec3(0.03, 0.025, 0.02)), damp.mul(0.85)), vec3(0.62, 0.6, 0.54), bloom.mul(0.5)) as any;
    timberMaterial.roughnessNode = mix(mix(float(0.88), float(0.7), chamfer), float(0.55), damp) as any;
    const timbers = new THREE.InstancedMesh(box, timberMaterial, wood.length);
    wood.forEach((w, k) => timbers.setMatrixAt(k, w.m));
    timbers.castShadow = true;
    timbers.receiveShadow = true;

    // Iron gone to rust: blotched and flaking, the rail heads darker and smoother where wheels once ran.
    const rust = new THREE.MeshStandardNodeMaterial();
    const pw = positionWorld as any;
    const blotch = mx_noise_float(pw.mul(vec3(2.5, 9, 9))).mul(0.5).add(0.5) as any;
    const flake = smoothstep(0.35, 0.6, mx_noise_float(pw.mul(31))) as any;
    const head = attribute("aTop", "float") as any;
    const rusted = mix(mix(vec3(0.2, 0.09, 0.04), vec3(0.38, 0.19, 0.08), blotch), vec3(0.12, 0.07, 0.05), flake.mul(0.6)) as any;
    rust.colorNode = mix(rusted, vec3(0.14, 0.11, 0.09), head.mul(0.7)) as any;
    rust.roughnessNode = mix(mix(float(0.78), float(0.9), flake), float(0.45), head) as any;
    rust.metalnessNode = mix(float(0.3), float(0.6), head) as any;
    const railShape = railGeometry();
    const fittingShape = railFittings(gauge);
    const plateShape = fishplates();
    for (const shape of [fittingShape, plateShape]) shape.setAttribute("aTop", new THREE.BufferAttribute(new Float32Array(shape.getAttribute("position").count), 1));
    const meshes = [
      [railShape, rails],
      [fittingShape, spikes],
      [plateShape, plates]
    ].map(([shape, list]) => {
      const mesh = new THREE.InstancedMesh(shape as THREE.BufferGeometry, rust, (list as THREE.Matrix4[]).length);
      (list as THREE.Matrix4[]).forEach((m, k) => mesh.setMatrixAt(k, m));
      mesh.receiveShadow = true;
      return mesh;
    });
    for (const m of [timberMaterial, rust]) m.aoNode = caveShade();
    return { shapes: [box, railShape, fittingShape, plateShape], timberMaterial, rust, meshes: [timbers, ...meshes] };
  }, []);
  useDispose(...built.shapes, built.timberMaterial, built.rust);
  return (
    <>
      {built.meshes.map((mesh, k) => (
        <primitive key={k} object={mesh} />
      ))}
    </>
  );
}

// ---- Fossils -------------------------------------------------------------------------------------------------------

// An ichthyosaur, four metres of it, weathered out of the hall's back wall: a long-snouted skull, the spine curving to
// a down-turned tail, ribs, and four paddles of small rounded bones. As matrices for three shapes: the vertebrae
// (`vertebra`, disc-like centra with their spines, along the spine), the ribs (`hangingRib`, hanging from it and
// sweeping back), and the rest as one bone shape (a capsule about one unit long along y).
function skeletonPieces(cx: number, cy: number, z: number) {
  const vertebrae: THREE.Matrix4[] = [];
  const ribs: THREE.Matrix4[] = [];
  const bones: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const piece = (x: number, y: number, angle: number, sx: number, sy: number, sz: number, into = bones) =>
    into.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(zAxis, angle).clone(), new THREE.Vector3(sx, sy, sz)));
  const spine = (s: number) => {
    const x = cx - 1.8 + s * 4;
    const y = cy + Math.sin(s * Math.PI * 1.2 + 0.2) * 0.22 - (s > 0.8 ? (s - 0.8) * 1.6 : 0);
    return [x, y] as const;
  };
  const COUNT = 46;
  for (let k = 0; k < COUNT; k++) {
    const s = k / (COUNT - 1);
    const [x, y] = spine(s);
    const [x2, y2] = spine(Math.min(1, s + 0.01));
    const along = Math.atan2(y2 - y, x2 - x);
    const r = 0.06 * (1 - s * 0.6) + 0.015;
    // Each centrum as long as the spacing allows, as wide as the spine is thick there; the tail's spines lower.
    const size = r / 0.52;
    piece(x, y, along, (4 / COUNT) * 0.92, size * (s > 0.75 ? 0.85 : 1), size * 0.9, vertebrae);
    // Ribs down from the chest, sweeping back toward the tail, longest mid-chest.
    if (s > 0.12 && s < 0.5) {
      const len = 0.45 * Math.sin(((s - 0.12) / 0.38) * Math.PI) + 0.12;
      piece(x, y - r * 0.4, along + 0.22, len, len, len * 0.7, ribs);
    }
  }
  // The skull: a long snout and the head behind it, at the front end (left).
  const [hx, hy] = spine(0);
  piece(hx - 0.18, hy + 0.02, Math.PI / 2, 0.13, 0.32, 0.08);
  piece(hx - 0.72, hy - 0.02, Math.PI / 2 + 0.05, 0.04, 0.85, 0.035);
  piece(hx - 0.2, hy + 0.06, 0, 0.05, 0.05, 0.03);
  // Paddles: fore and hind, each a fan of small bones.
  for (const [s, size] of [
    [0.16, 1],
    [0.52, 0.7]
  ])
    for (const side of [1, -1]) {
      const [px, py] = spine(s);
      for (let f = 0; f < 4; f++)
        for (let b = 0; b < 5; b++) {
          const a = -Math.PI / 2 - side * (0.5 + f * 0.18);
          const d = 0.12 + b * 0.09 * size;
          piece(px + Math.cos(a) * d + f * 0.04, py + Math.sin(a) * d * side * (side > 0 ? 1 : -1), a, 0.025 * size, 0.05 * size, 0.02);
        }
    }
  return { vertebrae, ribs, bones };
}

function Fossils() {
  const built = useMemo(() => {
    const cave = byKind("fossil");
    // Placed against the cavern's own walls alone: far quicker than the whole rock, and the same surfaces.
    const field = new CavernRock(cave);
    const random = lehmer(6620);
    const from = new THREE.Vector3(...cave.centre);
    const normal = new THREE.Vector3();
    const matrices: THREE.Matrix4[] = [];
    const yAxis = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion();
    const spin = new THREE.Quaternion();
    // Over the back wall, a bedding plane, as they lay on the old sea floor; a few more round the sides.
    const back = new THREE.Vector3(0, 0, -1);
    for (let n = 0; n < 1600 && matrices.length < 44; n++) {
      const onBack = n < 1200;
      const start = onBack ? new THREE.Vector3(cave.centre[0] + (random() - 0.5) * cave.size[0] * 1.7, (cave.floor as number) + 0.2 + random() * cave.size[1] * 1.5, cave.centre[2]) : from.clone();
      const d = onBack ? back : new THREE.Vector3(Math.cos(random() * 6.3), (random() - 0.6) * 0.6, Math.sin(random() * 6.3)).normalize();
      const p = wallHit(field, start, d, 8, normal, 0.35);
      if (!p || Math.abs(normal.y) > 0.5) continue;
      const size = 0.16 + Math.pow(random(), 2.2) * 0.75;
      if (onBack && Math.abs(p.x - cave.centre[0]) < 2.6 && Math.abs(p.y - SKELETON_Y) < 0.9) continue;
      if (matrices.some((m) => new THREE.Vector3().setFromMatrixPosition(m).distanceTo(p) < size * 0.5 + 0.2)) continue;
      q.setFromUnitVectors(yAxis, normal);
      spin.setFromAxisAngle(yAxis, random() * Math.PI * 2);
      q.multiply(spin);
      // Part sunk in the rock, as it weathered out.
      p.addScaledVector(normal, -size * 0.12);
      matrices.push(new THREE.Matrix4().compose(p, q.clone(), new THREE.Vector3(size, size * (0.7 + random() * 0.3), size)));
    }
    const geometry = ammoniteGeometry();
    const material = new THREE.MeshStandardNodeMaterial();
    const kind = hash(instanceIndex.add(3)) as any;
    const pyrite = smoothstep(0.6, 0.62, kind) as any;
    const pw = positionWorld as any;
    const speck = fract(sin(dot(pw.mul(83), vec3(12.9898, 78.233, 37.719))).mul(43758.5)) as any;
    weathered(material, mix(mix(vec3(0.62, 0.56, 0.46), vec3(0.78, 0.72, 0.6), speck.mul(0.5)), vec3(0.8, 0.64, 0.34), pyrite), 0.65, 0.012);
    material.metalnessNode = pyrite.mul(0.85) as any;
    material.roughnessNode = mix(material.roughnessNode as any, float(0.3), pyrite) as any;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.receiveShadow = true;

    // Trilobites among them, flat to the bedding plane.
    const trilobites: THREE.Matrix4[] = [];
    for (let n = 0; n < 900 && trilobites.length < 26; n++) {
      const start = new THREE.Vector3(cave.centre[0] + (random() - 0.5) * cave.size[0] * 1.7, (cave.floor as number) + 0.2 + random() * cave.size[1] * 1.5, cave.centre[2]);
      const p = wallHit(field, start, back, 8, normal, 0.35);
      if (!p || Math.abs(normal.y) > 0.5) continue;
      // Not over the skeleton.
      if (Math.abs(p.x - cave.centre[0]) < 2.6 && Math.abs(p.y - SKELETON_Y) < 0.9) continue;
      const size = 0.1 + Math.pow(random(), 1.8) * 0.3;
      if ([...trilobites, ...matrices].some((m) => new THREE.Vector3().setFromMatrixPosition(m).distanceTo(p) < size * 0.6 + 0.15)) continue;
      q.setFromUnitVectors(yAxis, normal);
      spin.setFromAxisAngle(yAxis, random() * Math.PI * 2);
      q.multiply(spin);
      p.addScaledVector(normal, -0.012 * (size / 0.2));
      trilobites.push(new THREE.Matrix4().compose(p, q.clone(), new THREE.Vector3(size, size, size)));
    }
    const triloGeometry = trilobiteGeometry();
    const triloMesh = new THREE.InstancedMesh(triloGeometry, material, trilobites.length);
    trilobites.forEach((m, k) => triloMesh.setMatrixAt(k, m));
    triloMesh.receiveShadow = true;

    // The skeleton across the middle of the back wall, half freed from the shale: dark, mineralised bone.
    const pieces = skeletonPieces(cave.centre[0], SKELETON_Y, FOSSIL_PLANE + 0.02);
    const boneShape = new THREE.CapsuleGeometry(0.5, 0.5, 4, 8);
    const vertebraShape = vertebra();
    const ribShape = hangingRib();
    const boneMaterial = new THREE.MeshStandardNodeMaterial();
    weathered(boneMaterial, mix(vec3(0.24, 0.17, 0.11), vec3(0.42, 0.32, 0.22), speck.mul(0.6).add(hash(instanceIndex).mul(0.4))), 0.55, 0.04);
    const skeleton = (
      [
        [boneShape, pieces.bones],
        [vertebraShape, pieces.vertebrae],
        [ribShape, pieces.ribs]
      ] as const
    ).map(([shape, list]) => {
      const part = new THREE.InstancedMesh(shape, boneMaterial, list.length);
      list.forEach((m, k) => part.setMatrixAt(k, m));
      part.receiveShadow = true;
      return part;
    });
    return { geometry, material, mesh, triloGeometry, triloMesh, shapes: [boneShape, vertebraShape, ribShape], boneMaterial, skeleton };
  }, []);
  useDispose(built.geometry, built.material, built.triloGeometry, ...built.shapes, built.boneMaterial);
  return (
    <>
      <primitive object={built.mesh} />
      <primitive object={built.triloMesh} />
      {built.skeleton.map((part, k) => (
        <primitive key={k} object={part} />
      ))}
    </>
  );
}

// The height of the skeleton's spine on the fossil hall's back wall.
const SKELETON_Y = 2.75;

// Drawn only from underground (the caverns' contents run to millions of triangles, none of them visible from the
// forest); the lake looks after itself, since its light falls down the chimney.
// Nor, from underground, from further off than the rock is loaded round the eye (world.ts, about 38 m): the rock that
// hid them is let go there, and they would float in the dark. (Out in the clearing a tunnel's mouth may show them.)
const HOME = new THREE.Vector3(0.5, 2.5, -15);
const HOME_REACH = 46;
export function Caverns({ world }: { world: World }) {
  const group = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);
  useFrame(() => {
    if (group.current) group.current.visible = (lamp.inside.value > 0.15 || world.opened.size > 0) && (lamp.inside.value < 0.5 || camera.position.distanceTo(HOME) < HOME_REACH);
  });
  return (
    <>
      <group ref={group}>
        <GlowWorms />
        <Geode />
        <Mine />
        <Fossils />
      </group>
      <Lake />
    </>
  );
}
