"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { CuboidCollider, Physics, useRapier } from "@react-three/rapier";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  atan,
  asin,
  attribute,
  cameraPosition,
  clamp,
  color as tslColor,
  cross,
  dot,
  float,
  floor,
  fract,
  int,
  ivec2,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalGeometry,
  normalize,
  positionGeometry,
  positionPrevious,
  positionWorld,
  pow,
  length,
  reflect,
  reflector,
  sin,
  smoothstep,
  texture,
  textureLoad,
  time,
  transformNormalToView,
  uniform,
  varying,
  vec2,
  vec3,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { useGrabbable } from "../shared/engine/controls";
import { dismissPrompt } from "../shared/engine/prompt";
import { Birds, createSky, type SkyPalette } from "../shared/engine/outdoors";
import { useQuality } from "../shared/engine/quality";
import { useSetting, useSettingAction, useSettingRef } from "../shared/engine/settings";
import { sound, useBed, useEvery } from "../shared/engine/sound";
import { Haze, KeyLight, StudioEnvironment } from "../shared/engine/studio";
import { useLook } from "../shared/engine/Stage";
import type { DayDefinition } from "../shared/engine/types";
import { DEER_LAYER, DeerHerd } from "./deer";
import { buildCellMap, buildDome, DOME_RADIUS } from "./dome";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const SHATTER_BACKGROUND = "#02040c";
const SKIES: Record<string, SkyPalette & { env: string; light: string }> = {
  noon: { zenith: "#2f73c9", horizon: "#d3e6ef", sun: "#fff4dc", cloudLit: "#ffffff", cloudShade: "#9ab4cf", sunDirection: [0.4, 0.7, -0.6], cloudCover: 0.55, env: "#9fc6ea", light: "#fff2dc" },
  dusk: { zenith: "#3b3f78", horizon: "#f59a6c", sun: "#ffb56c", cloudLit: "#ffc9a4", cloudShade: "#6d4a78", sunDirection: [0.3, 0.14, -0.95], cloudCover: 0.6, env: "#c78b84", light: "#ffae72" },
  storm: { zenith: "#39424f", horizon: "#8c97a0", sun: "#d7dee2", cloudLit: "#aeb7bf", cloudShade: "#3a424d", sunDirection: [-0.3, 0.6, -0.7], cloudCover: 0.95, env: "#6b7886", light: "#c9d3dc" }
};

const STATE_ROWS = 5;
const REST_ROTATION = [0, 0, 0, 1];
const INTACT_SCALE = 1.003;
const CEILING = 46;

type Live = {
  body: any | null;
  phase: "intact" | "cracked" | "waiting" | "falling" | "mending";
  breakAt: number;
  mendFrom: THREE.Vector3;
  mendRotation: THREE.Quaternion;
  mendAt: number;
  crack: number;
  vx: number;
  vy: number;
  vz: number;
};

// What is behind the sky. Stars, an aurora, a moon: everything the daylight had been hiding.
function paintNight(direction: any, aurora: any) {
  const grid = direction.mul(380) as any;
  const cell = floor(grid) as any;
  const noise = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;
  const twinkle = sin(time.mul(1.4).add(noise.mul(90))).mul(0.3).add(0.7) as any;
  // A round point in each lucky cell, brighter for the rarer ones.
  const point = smoothstep(0.42, 0.05, (fract(grid).sub(0.5) as any).length()) as any;
  const stars = smoothstep(0.985, 1, noise).mul(point).mul(twinkle).mul(5) as any;
  const band = mx_fractal_noise_float(direction.mul(2.4).add(vec3(9, 0, 3)), 4, 2, 0.5, 1) as any;
  const milky = smoothstep(-0.02, 0.5, band) as any;
  const base = mix(tslColor("#02040c"), tslColor("#0a1538"), milky.mul(0.8));

  const up = max(direction.y, float(0.03)) as any;
  const flat = direction.xz.div(up.add(0.28)) as any;
  const sway = mx_noise_float(vec3(flat.x.mul(0.5), flat.y.mul(0.5), time.mul(0.06))) as any;
  const ribbon = pow(max(float(1).sub(abs(flat.y.add(0.5).add(sway.mul(1.6))).mul(1.15)), float(0)), float(2.4)) as any;
  const curtain = sin(flat.x.mul(13).add(sway.mul(9)).add(time.mul(0.3))).mul(0.3).add(0.7) as any;
  const glow = ribbon.mul(curtain).mul(smoothstep(0.03, 0.32, direction.y)).mul(aurora) as any;
  const veil = mix(tslColor("#21f3a0"), tslColor("#a24bff"), smoothstep(0.1, 0.65, direction.y)).mul(glow.mul(1.5));

  const moonDirection = normalize(vec3(-0.45, 0.5, -0.75)) as any;
  const toMoon = max(dot(direction, moonDirection), float(0)) as any;
  const moon = smoothstep(0.9994, 0.99965, toMoon).mul(4).add(pow(toMoon, float(900)).mul(0.28)) as any;
  return base.add(vec3(stars)).add(veil).add(tslColor("#dbe6ff").mul(moon));
}

const rotate = (q: any, v: any) => {
  const t = cross(q.xyz, v).mul(2) as any;
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
};

function Sky({ palette, broken }: { palette: SkyPalette; broken: { current: number } }) {
  const { gl, scene, camera } = useThree() as any;
  const { world, rapier } = useRapier();
  const { tier } = useQuality();
  const impact = useSettingRef<number>("impact");
  const gravity = useSettingRef<number>("gravity");

  // Slider moves are held back a moment, because each new size cuts a whole new sky.
  const pieceSize = useSetting<number>("pieces");
  const [settledSize, setSettledSize] = useState(pieceSize);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledSize(pieceSize), 260);
    return () => window.clearTimeout(timer);
  }, [pieceSize]);
  // Fixed by the quality the scene opened on. Cutting a new sky throws away every piece, so a quality change must never do it.
  const [firstTier] = useState(tier);
  const baseCount = firstTier === "high" ? 300 : firstTier === "medium" ? 220 : 130;
  const plateCount = Math.round(Math.min(baseCount * 2.2, baseCount / (settledSize * settledSize)));
  const dome = useMemo(() => buildDome(plateCount), [plateCount]);
  const count = dome.shards.length;

  const sky = useMemo(() => createSky(), []);
  const auroraUniform = useMemo(() => uniform(1), []);

  useEffect(() => sky.setPalette(palette), [sky, palette]);

  // Live plate transforms: position + scale, rotation, then last frame's two for motion vectors, then fall.
  const state = useMemo(() => {
    const data = new Float32Array(count * STATE_ROWS * 4);
    for (let i = 0; i < count; i++) {
      const home = dome.shards[i].home;
      for (const row of [0, 2]) data.set([home.x, home.y, home.z, INTACT_SCALE], (row * count + i) * 4);
      for (const row of [1, 3]) data.set(REST_ROTATION, (row * count + i) * 4);
    }
    const tex = new THREE.DataTexture(data, count, STATE_ROWS, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return { data, tex };
  }, [count, dome]);

  // A latitude-longitude map of the holes, which is all the lake needs to reflect them.
  const holes = useMemo(() => {
    const width = 256;
    const height = 128;
    const cells = buildCellMap(dome.shards, width, height);
    const data = new Uint8Array(width * height * 4).fill(0);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return { data, tex, cells, width, height };
  }, [dome]);

  const mirrorScale = tier === "high" ? 1 : tier === "medium" ? 0.75 : 0;
  const materials = useMemo(() => {
    const id = int(attribute("aShard", "float") as any) as any;
    const load = (row: number) => textureLoad(state.tex, ivec2(id, int(row))) as any;
    const now = load(0);
    const rotation = load(1);
    const before = load(2);
    const beforeRotation = load(3);
    const fall = varying(load(4).x) as any;
    const face = attribute("aFace", "float") as any;
    const direction = attribute("aDirection", "vec3") as any;

    const plate = new THREE.MeshPhysicalNodeMaterial({ roughness: 1, metalness: 0 });
    const place = Fn(() => {
      (positionPrevious as any).assign(rotate(beforeRotation, positionGeometry.mul(before.w)).add(before.xyz));
      return rotate(rotation, positionGeometry.mul(now.w)).add(now.xyz);
    })() as any;
    plate.positionNode = place;
    plate.castShadowPositionNode = rotate(rotation, positionGeometry.mul(now.w)).add(now.xyz) as any;
    plate.normalNode = transformNormalToView(varying(rotate(rotation, normalGeometry))) as any;

    const isInner = float(1).sub(smoothstep(0, 0.5, face)) as any;
    const isSide = float(1).sub(smoothstep(0, 0.5, abs(face.sub(1)))) as any;
    plate.colorNode = mix(tslColor("#0a1320"), tslColor("#000000"), isInner) as any;
    plate.roughnessNode = mix(float(1), float(0.07), fall.mul(float(1).sub(isInner))) as any;

    // The inside of a plate keeps the patch of sky it was cut from, so the fallen pieces still show clouds.
    const painted = sky.paint(normalize(varying(direction))) as any;
    const isOuter = float(1).sub(isInner).sub(isSide) as any;
    const edge = tslColor("#a7d3f2").mul(float(0.12).add(fall.mul(0.42))) as any;
    plate.emissiveNode = painted.mul(isInner.add(isOuter.mul(fall).mul(0.62))).add(edge.mul(isSide)) as any;

    // Ice. It mirrors the sky and whatever has been opened up in it.
    const lake = new THREE.MeshStandardNodeMaterial({ roughness: 0.16, metalness: 0 });
    const reflection = mirrorScale === 0 ? null : (reflector({ resolutionScale: mirrorScale, bounces: false }) as any);
    if (reflection) reflection.target.rotateX(-Math.PI / 2);
    const ripple = vec3(
      mx_noise_float(vec3(positionWorld.xz.mul(0.8), time.mul(0.06))).mul(0.018),
      1,
      mx_noise_float(vec3(positionWorld.xz.mul(0.8).add(31), time.mul(0.06))).mul(0.018)
    ) as any;
    const view = normalize(positionWorld.sub(cameraPosition)) as any;
    const bounce = reflect(view, normalize(ripple)) as any;
    const up = vec3(bounce.x, abs(bounce.y), bounce.z) as any;
    const mapUv = vec2(atan(up.z, up.x).div(6.28318).add(0.5), asin(clamp(up.y, -1, 1)).div(3.14159).add(0.5)) as any;
    const mask = (texture(holes.tex, mapUv) as any).r;
    const mirrored = mix(sky.paint(up), paintNight(up, auroraUniform), mask) as any;
    const fresnel = pow(float(1).sub(max(dot(view.negate(), vec3(0, 1, 0)), float(0))), float(3)) as any;
    // The sky is painted into the ice, so only the deer need a real second look from under it. Where that pass
    // drew nothing it is left holding the background colour, and the painted sky shows through.
    const deerSeen = reflection ? (reflection.rgb as any) : null;
    const deerThere = deerSeen ? (smoothstep(0.002, 0.012, length(deerSeen.sub(tslColor(SHATTER_BACKGROUND)))) as any) : null;
    const scratches = smoothstep(0.016, 0, abs(mx_fractal_noise_float(vec3(positionWorld.xz.mul(0.55), 2), 3, 2, 0.5, 1))) as any;
    lake.colorNode = tslColor("#0f2534");
    const paintedIce = mirrored.mul(fresnel.mul(0.8).add(0.13)) as any;
    const iceSeen = deerSeen ? (mix(paintedIce, deerSeen.mul(fresnel.mul(0.5).add(0.5)), deerThere.mul(0.88)) as any) : paintedIce;
    lake.emissiveNode = iceSeen.add(tslColor("#a6c7dc").mul(scratches.mul(0.05))) as any;

    const night = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    night.colorNode = paintNight(normalize(positionWorld), auroraUniform) as any;
    return { plate, lake, night, mirror: reflection };
  }, [state, holes, sky, auroraUniform, mirrorScale]);

  // The mirror pass looks at one layer, so the sun has to be on it too.
  useEffect(() => {
    if (materials.mirror) materials.mirror.reflector.getVirtualCamera(camera).layers.set(DEER_LAYER);
  }, [materials, camera]);
  const sunCheck = useRef(0);
  useFrame((_, delta) => {
    sunCheck.current -= delta;
    if (sunCheck.current > 0) return;
    sunCheck.current = 1;
    scene.traverse((object: THREE.Object3D) => {
      if ((object as THREE.Light).isLight) object.layers.enable(DEER_LAYER);
    });
  });

  // Only the materials change with quality. The sky's own data has to outlive that, or everything in it is lost.
  useEffect(
    () => () => {
      materials.plate.dispose();
      materials.lake.dispose();
      materials.night.dispose();
    },
    [materials]
  );
  useEffect(
    () => () => {
      state.tex.dispose();
      holes.tex.dispose();
      dome.geometry.dispose();
    },
    [state, holes, dome]
  );

  const live = useRef<Live[]>([]);
  useEffect(() => {
    live.current = dome.shards.map(() => ({ body: null, phase: "intact", breakAt: 0, mendFrom: new THREE.Vector3(), mendRotation: new THREE.Quaternion(), mendAt: 0, crack: 0, vx: 0, vy: 0, vz: 0 }));
    return () => {
      for (const item of live.current) {
        if (item.body) world.removeRigidBody(item.body);
        item.body = null;
      }
    };
  }, [dome, world]);

  const clock = useRef(0);
  const stoneRef = useRef<THREE.Mesh>(null);
  const stone = useRef({ active: false, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 0 });
  const held = useRef({ index: -1, target: new THREE.Vector3(), offset: new THREE.Vector3() });

  const paintHole = useRef(false);
  const lastGravity = useRef(1);
  const heard = useRef({ shatter: 0, crack: 0, tinkle: 0, knock: 0 });

  const crackAround = (point: THREE.Vector3, radius: number) => {
    const aim = point.clone().normalize();
    live.current.forEach((item, index) => {
      if (item.phase !== "intact" && item.phase !== "cracked") return;
      const angle = aim.angleTo(dome.shards[index].direction);
      if (angle < radius) {
        item.phase = "waiting";
        // The break spreads out from the blow, with some plates hanging on a moment longer.
        item.breakAt = clock.current + angle * 1.6 + Math.random() * Math.random() * 1.3;
        item.crack = 1;
      } else if (angle < radius * 1.5) {
        item.phase = "cracked";
        item.crack = Math.max(item.crack, 1 - (angle - radius) / (radius * 0.5));
        state.data[(0 * count + index) * 4 + 3] = INTACT_SCALE - item.crack * 0.018;
      }
    });
    state.tex.needsUpdate = true;
  };

  const strike = (ray: THREE.Ray) => {
    // Where the ray leaves the dome, from inside it.
    const b = ray.origin.dot(ray.direction);
    const c = ray.origin.lengthSq() - DOME_RADIUS * DOME_RADIUS;
    const h = b * b - c;
    if (h < 0) return;
    const reach = -b + Math.sqrt(h);
    if (reach <= 0) return;
    const point = ray.at(reach, new THREE.Vector3());
    if (point.y < 0.5) return;
    dismissPrompt();
    const flight = stone.current;
    flight.active = true;
    flight.from.copy(ray.origin).addScaledVector(ray.direction, 1).add(new THREE.Vector3(0, -0.4, 0));
    flight.to.copy(point);
    flight.t = 0;
  };

  const release = (index: number) => {
    const shard = dome.shards[index];
    const item = live.current[index];
    const rotation = state.data.subarray((1 * count + index) * 4, (1 * count + index) * 4 + 4);
    const desc = rapier.RigidBodyDesc.dynamic()
      .setTranslation(shard.home.x, shard.home.y, shard.home.z)
      .setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] })
      .setLinearDamping(0.05)
      .setAngularDamping(0.25)
      .setGravityScale(gravity.current)
      .setCanSleep(true);
    const body = world.createRigidBody(desc);
    const collider = rapier.ColliderDesc.convexHull(shard.hull) ?? rapier.ColliderDesc.ball(shard.reach * 0.6);
    collider.setRestitution(0.14).setFriction(0.7).setDensity(0.5);
    world.createCollider(collider, body);
    const spin = 0.5;
    body.setAngvel({ x: (Math.random() - 0.5) * spin, y: (Math.random() - 0.5) * spin, z: (Math.random() - 0.5) * spin }, true);
    body.setLinvel({ x: -shard.direction.x * 1.5, y: -2 - Math.random() * 2, z: -shard.direction.z * 1.5 }, true);
    item.body = body;
    item.phase = "falling";
    const thrown = body.linvel();
    item.vx = thrown.x;
    item.vy = thrown.y;
    item.vz = thrown.z;
    // A big break is too many voices to stack, so while one rings out, the plates after it only crack.
    const size = Math.min(1, shard.reach / (DOME_RADIUS * 0.22));
    const now = clock.current;
    if (now >= heard.current.shatter) {
      heard.current.shatter = now + 0.3;
      sound.play("shatter", { gain: 0.35 + size * 0.65, pitch: 1.25 - size * 0.45, pan: shard.home.x / DOME_RADIUS });
    } else if (now >= heard.current.crack) {
      heard.current.crack = now + 0.08;
      sound.play("crack", { gain: 0.2 + size * 0.3, pitch: 1.2 - size * 0.4, pan: shard.home.x / DOME_RADIUS });
    }
    state.data[(0 * count + index) * 4 + 3] = 0.985;
    state.data[(4 * count + index) * 4] = 1;
    paintHole.current = true;
  };

  const setHole = (index: number, open: boolean) => {
    const { cells, data, width, height } = holes;
    const value = open ? 255 : 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (cells[y * width + x] === index) data[(y * width + x) * 4] = value;
      }
    }
    holes.tex.needsUpdate = true;
  };

  const mend = () => {
    const now = clock.current;
    live.current.forEach((item, index) => {
      if (item.phase === "waiting" || item.phase === "cracked") {
        item.phase = "intact";
        item.crack = 0;
        state.data[(0 * count + index) * 4 + 3] = INTACT_SCALE;
      }
      if (item.phase !== "falling" || !item.body) return;
      const at = item.body.translation();
      const rotation = item.body.rotation();
      item.mendFrom.set(at.x, at.y, at.z);
      item.mendRotation.set(rotation.x, rotation.y, rotation.z, rotation.w);
      world.removeRigidBody(item.body);
      item.body = null;
      item.phase = "mending";
      // Nearest the lake first, so the sky rebuilds from the rim upward.
      item.mendAt = now + 0.15 + Math.random() * 1.2;
    });
    held.current.index = -1;
    state.tex.needsUpdate = true;
  };

  useSettingAction("mend", mend);
  useSettingAction("shatterAll", () => {
    for (const aim of [new THREE.Vector3(0, 1, 0)]) crackAround(aim.multiplyScalar(DOME_RADIUS), Math.PI);
  });

  // A tap on the sky throws the stone. A press on a plate takes it, and a drag anywhere else is the orbit.
  // The ray is tested against the plate's own triangles, so a press only takes a plate if it lands on that plate.
  const pickScratch = useMemo(() => ({ ray: new THREE.Ray(), turn: new THREE.Quaternion(), a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), hit: new THREE.Vector3() }), []);
  const pickPlate = (ray: THREE.Ray) => {
    const { ray: local, turn, a, b, c, hit } = pickScratch;
    let best: { index: number; distance: number; point: THREE.Vector3 } | null = null;
    live.current.forEach((item, index) => {
      if (item.phase !== "falling" || !item.body) return;
      const shard = dome.shards[index];
      const at = item.body.translation();
      a.set(at.x, at.y, at.z);
      if (ray.distanceSqToPoint(a) > shard.reach * shard.reach) return;
      const spin = item.body.rotation();
      turn.set(spin.x, spin.y, spin.z, spin.w).invert();
      local.origin.copy(ray.origin).sub(a).applyQuaternion(turn);
      local.direction.copy(ray.direction).applyQuaternion(turn);
      const { faces } = shard;
      for (let f = 0; f < faces.length; f += 9) {
        a.fromArray(faces, f);
        b.fromArray(faces, f + 3);
        c.fromArray(faces, f + 6);
        if (!local.intersectTriangle(a, b, c, false, hit)) continue;
        const distance = hit.distanceTo(local.origin);
        if (!best || distance < best.distance) best = { index, distance, point: ray.at(distance, new THREE.Vector3()) };
      }
    });
    return best as { index: number; distance: number; point: THREE.Vector3 } | null;
  };

  useEffect(() => {
    const dom = gl.domElement as HTMLCanvasElement;
    const press = { x: 0, y: 0, at: 0, armed: false };
    const raycaster = new THREE.Raycaster();
    const rayFrom = (event: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera);
      return raycaster.ray;
    };
    const down = (event: PointerEvent) => {
      press.x = event.clientX;
      press.y = event.clientY;
      press.at = performance.now();
      press.armed = true;
    };
    const up = (event: PointerEvent) => {
      if (!press.armed) return;
      press.armed = false;
      if (held.current.index >= 0) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 7 || performance.now() - press.at > 450) return;
      strike(rayFrom(event).clone());
    };
    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointerup", up);
    return () => {
      dom.removeEventListener("pointerdown", down);
      dom.removeEventListener("pointerup", up);
    };
  }, [gl, camera, dome]);

  const picked = useRef(-1);
  useGrabbable({
    pick(ray) {
      const hit = pickPlate(ray);
      picked.current = hit ? hit.index : -1;
      return hit ? { distance: hit.distance, point: hit.point } : null;
    },
    grab(point) {
      const hit = picked.current;
      if (hit < 0 || !live.current[hit]?.body) return;
      const at = live.current[hit].body.translation();
      held.current.index = hit;
      held.current.target.copy(point);
      held.current.offset.set(at.x - point.x, at.y - point.y, at.z - point.z);
    },
    drag(point) {
      held.current.target.copy(point);
    },
    release() {
      held.current.index = -1;
    }
  });

  const quaternion = useMemo(() => new THREE.Quaternion(), []);
  const home = useMemo(() => new THREE.Vector3(), []);
  const scratch = useMemo(() => new THREE.Vector3(), []);
  const identity = useMemo(() => new THREE.Quaternion(), []);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    clock.current += delta;
    const { data } = state;
    let open = 0;
    let dirty = false;
    let hardest = 0;
    let hardestIndex = -1;
    const gravityMoved = gravity.current !== lastGravity.current;
    lastGravity.current = gravity.current;

    const flight = stone.current;
    if (flight.active) {
      flight.t += delta / 0.34;
      const mesh = stoneRef.current;
      if (mesh) {
        mesh.visible = flight.t < 1;
        mesh.position.lerpVectors(flight.from, flight.to, flight.t * flight.t);
      }
      if (flight.t >= 1) {
        flight.active = false;
        crackAround(flight.to, impact.current);
        sound.play("crack", { gain: 0.8, pan: flight.to.x / DOME_RADIUS });
      }
    }

    for (let i = 0; i < count; i++) {
      const item = live.current[i];
      if (!item) continue;
      const position = (0 * count + i) * 4;
      const rotation = (1 * count + i) * 4;
      if (item.phase === "waiting" && clock.current >= item.breakAt) {
        release(i);
        setHole(i, true);
      }
      if (item.phase === "falling") {
        open += 1;
        const body = item.body;
        if (!body) continue;
        if (i === held.current.index) {
          const at = body.translation();
          scratch.copy(held.current.target).add(held.current.offset).sub(at as THREE.Vector3).multiplyScalar(9).clampLength(0, 40);
          body.setLinvel({ x: scratch.x, y: scratch.y, z: scratch.z }, true);
          body.setAngvel({ x: body.angvel().x * 0.9, y: body.angvel().y * 0.9, z: body.angvel().z * 0.9 }, true);
        } else {
          // Sleeping plates wake when gravity changes, so they all lift off together.
          body.setGravityScale(gravity.current, gravityMoved);
          const risen = body.translation();
          // Sent upward, they drift to a stop out among the stars rather than leave for good.
          if (gravity.current < 0 && risen.y > CEILING) {
            const v = body.linvel();
            body.setLinvel({ x: v.x * 0.94, y: Math.min(v.y * 0.86, (CEILING + 6 - risen.y) * 0.5), z: v.z * 0.94 }, true);
          }
        }
        if (body.isSleeping()) {
          // Already written and not moving, so last frame's position has to match it too.
          data.copyWithin((2 * count + i) * 4, position, position + 4);
          data.copyWithin((3 * count + i) * 4, rotation, rotation + 4);
          continue;
        }
        const t = body.translation();
        const r = body.rotation();
        // A sudden change of speed is something being hit. Gravity alone never changes it this much in a frame.
        const v = body.linvel();
        const hit = Math.hypot(v.x - item.vx, v.y - item.vy, v.z - item.vz);
        item.vx = v.x;
        item.vy = v.y;
        item.vz = v.z;
        if (hit > 2.5 && hit > hardest && i !== held.current.index && !(gravity.current < 0 && t.y > CEILING)) {
          hardest = hit;
          hardestIndex = i;
        }
        data.copyWithin((2 * count + i) * 4, position, position + 4);
        data.copyWithin((3 * count + i) * 4, rotation, rotation + 4);
        data[position] = t.x;
        data[position + 1] = t.y;
        data[position + 2] = t.z;
        data[rotation] = r.x;
        data[rotation + 1] = r.y;
        data[rotation + 2] = r.z;
        data[rotation + 3] = r.w;
        dirty = true;
      } else if (item.phase === "mending") {
        data.copyWithin((2 * count + i) * 4, position, position + 4);
        data.copyWithin((3 * count + i) * 4, rotation, rotation + 4);
        const t = THREE.MathUtils.clamp((clock.current - item.mendAt) / 1.5, 0, 1);
        const eased = t * t * (3 - 2 * t);
        const shard = dome.shards[i];
        home.copy(item.mendFrom).lerp(shard.home, eased);
        quaternion.copy(item.mendRotation).slerp(identity, eased);
        data[position] = home.x;
        data[position + 1] = home.y;
        data[position + 2] = home.z;
        data[rotation] = quaternion.x;
        data[rotation + 1] = quaternion.y;
        data[rotation + 2] = quaternion.z;
        data[rotation + 3] = quaternion.w;
        data[(4 * count + i) * 4] = 1 - eased;
        dirty = true;
        if (t >= 1) {
          item.phase = "intact";
          item.crack = 0;
          data[position + 3] = INTACT_SCALE;
          data[(2 * count + i) * 4 + 3] = INTACT_SCALE;
          setHole(i, false);
        } else {
          open += 1 - eased;
        }
      }
    }
    if (hardestIndex >= 0) {
      // One impact a frame, the hardest. Heavy plates knock as well as ring.
      const now = clock.current;
      const strength = Math.min(1, hardest / 14);
      const size = Math.min(1, dome.shards[hardestIndex].reach / (DOME_RADIUS * 0.22));
      const pan = data[hardestIndex * 4] / DOME_RADIUS;
      if (now >= heard.current.tinkle) {
        heard.current.tinkle = now + 0.06;
        sound.play("tinkle", { gain: 0.25 + strength * 0.75, pitch: 1.2 - size * 0.4, pan });
      }
      if (strength * size > 0.18 && now >= heard.current.knock) {
        heard.current.knock = now + 0.14;
        sound.play("crack", { gain: 0.2 + strength * size * 0.6, pitch: 0.8, pan });
      }
    }
    if (dirty || paintHole.current) state.tex.needsUpdate = true;
    paintHole.current = false;
    broken.current += (open / Math.max(1, count) - broken.current) * (1 - Math.exp(-delta * 2.5));
    (scene as THREE.Scene).environmentIntensity = THREE.MathUtils.lerp(1, 0.14, Math.min(1, broken.current * 1.5));
  });

  return (
    <>
      <mesh material={materials.night} renderOrder={-1} frustumCulled={false}>
        <sphereGeometry args={[90, 48, 32]} />
      </mesh>
      <mesh geometry={dome.geometry} material={materials.plate} frustumCulled={false} castShadow receiveShadow />
      {materials.mirror ? <primitive object={materials.mirror.target} /> : null}
      <mesh material={materials.lake} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[80, 96]} />
      </mesh>
      <DeerHerd count={firstTier === "high" ? 16 : firstTier === "medium" ? 12 : 7} plates={live} />
      <mesh ref={stoneRef} visible={false}>
        <icosahedronGeometry args={[0.22, 1]} />
        <meshStandardMaterial color="#111" emissive="#ffd9a0" emissiveIntensity={9} />
      </mesh>
    </>
  );
}

// A black treeline around the lake, there to give the broken sky some scale.
function Treeline() {
  const mesh = useMemo(() => {
    const count = 640;
    const cone = mergeGeometries(
      [
        [0.82, 1.6, 0.55],
        [0.62, 1.5, 1.55],
        [0.4, 1.35, 2.5]
      ].map(([radius, height, y]) => new THREE.ConeGeometry(radius, height, 7).translate(0, y, 0).toNonIndexed())
    ) as THREE.BufferGeometry;
    const material = new THREE.MeshStandardNodeMaterial({ color: "#07100f", roughness: 1 });
    const trees = new THREE.InstancedMesh(cone, material, count);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const hash = (salt: number) => {
        const s = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
        return s - Math.floor(s);
      };
      const angle = hash(1) * Math.PI * 2;
      const radius = 22 + hash(2) * 9;
      const scale = 0.65 + hash(3) * 1.4;
      matrix.makeScale(scale, scale * (0.9 + hash(4) * 0.8), scale);
      matrix.setPosition(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      trees.setMatrixAt(i, matrix);
    }
    trees.castShadow = true;
    trees.frustumCulled = false;
    return trees;
  }, []);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    },
    [mesh]
  );
  return <primitive object={mesh} />;
}

// Separate flocks, because a bird checks every other bird in its flock, and one huge flock costs far more than three.
const BIRD_CENTRE: [number, number, number] = [0, 13, -4];
const BIRD_CENTRE_WEST: [number, number, number] = [-20, 17, 10];
const BIRD_CENTRE_EAST: [number, number, number] = [22, 10, 6];

function Scene() {
  const { tier } = useQuality();
  const skyKey = useSetting<string>("sky");
  const palette = SKIES[skyKey] ?? SKIES.noon;
  const broken = useRef(0);
  const [night, setNight] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const stepped = Math.round(Math.min(1, broken.current * 1.6) * 12) / 12;
      setNight((current) => (current === stepped ? current : stepped));
    }, 180);
    return () => window.clearInterval(timer);
  }, []);

  useLook({ haze: 0.5 - night * 0.2, bloom: 0.14 + night * 0.26 });

  // As the sky comes down, the wind drops away and the night behind it starts to ring.
  useBed("wind", 0.26 - night * 0.12);
  useBed("shimmer", 0.08 + night * 0.22);
  useEvery(0.5, 2.2, () => sound.play("chirp", { gain: 0.25 + Math.random() * 0.45, pitch: 0.8 + Math.random() * 0.45, pan: Math.random() * 1.8 - 0.9 }));
  useEvery(5, 15, () => sound.play("caw", { gain: 0.3 + Math.random() * 0.4, pitch: 0.85 + Math.random() * 0.3, pan: Math.random() * 1.6 - 0.8 }));

  const lightColor = useMemo(() => new THREE.Color(palette.light).lerp(new THREE.Color("#8fb2ff"), night).getStyle(), [palette, night]);

  return (
    <>
      <StudioEnvironment
        key={skyKey}
        ambient={palette.env}
        boxes={[
          { position: [0, 12, 0], scale: [30, 0.2, 30], color: palette.zenith, intensity: 2.4 },
          { position: [10, 2.5, -12], scale: [0.2, 8, 24], color: palette.horizon, intensity: 1.6 },
          { position: [-10, 2.5, -12], scale: [0.2, 8, 24], color: palette.horizon, intensity: 1.2 }
        ]}
      />
      <KeyLight position={[5, 30, -3]} target={[0, 0, -2]} color={lightColor} intensity={THREE.MathUtils.lerp(4200, 1500, night)} angle={0.62} penumbra={0.75} shadowFar={60} />
      <Haze size={[60, 26, 60]} position={[0, 13, 0]} density={0.55} />
      <Treeline />
      <Birds count={tier === "high" ? 170 : tier === "medium" ? 110 : 50} centre={BIRD_CENTRE} spread={27} size={0.34} color={night > 0.5 ? "#c9d6f2" : "#141820"} />
      <Birds count={tier === "high" ? 170 : tier === "medium" ? 110 : 50} centre={BIRD_CENTRE_WEST} spread={30} size={0.34} color={night > 0.5 ? "#c9d6f2" : "#141820"} />
      <Birds count={tier === "high" ? 150 : tier === "medium" ? 90 : 40} centre={BIRD_CENTRE_EAST} spread={32} size={0.3} color={night > 0.5 ? "#c9d6f2" : "#141820"} />
      <Physics gravity={[0, -13, 0]}>
        <Sky palette={palette} broken={broken} />
        <CuboidCollider args={[90, 0.5, 90]} position={[0, -0.5, 0]} />
      </Physics>
    </>
  );
}

const shatter: DayDefinition = {
  camera: { position: [0, 2.6, 15], target: [0, 8.4, -6], fov: 58 },
  extents: { centre: [0, 0, 0], radius: 19.8, floor: 0, color: "#bfe2ff" },
  look: { background: SHATTER_BACKGROUND, exposure: 1, gi: 1.6, ao: 0.8, aoRadius: 0.6, vignette: 0.32, grain: 0.02, bloomThreshold: 1 },
  settings: {
    sky: {
      type: "choice",
      label: "Sky",
      value: "noon",
      options: [
        { value: "noon", label: "Noon", swatch: ["#2f73c9", "#d3e6ef"] },
        { value: "dusk", label: "Dusk", swatch: ["#3b3f78", "#f59a6c"] },
        { value: "storm", label: "Storm", swatch: ["#39424f", "#8c97a0"] }
      ]
    },
    impact: { type: "range", label: "Impact", min: 0.12, max: 0.9, step: 0.01, value: 0.42 },
    gravity: { type: "range", label: "Gravity", min: -1, max: 1.6, step: 0.01, value: 1 },
    pieces: { type: "range", label: "Piece size", min: 0.55, max: 2, step: 0.01, value: 1 },
    shatterAll: { type: "action", label: "Break all of it" },
    mend: { type: "action", label: "Mend the sky" }
  },
  notes: "Each piece of sky is a Rapier rigid body with its own convex hull collider, picked by ray against its exact triangles, and the deer read those colliders to walk on top of the fallen ice. The ice paints the sky and adds a planar reflection pass for the deer. On High it uses screen-space global illumination and ambient occlusion, volumetric haze, shadow maps and temporal anti-aliasing, over a procedural sky shader.",
  hint: "Grab a fallen piece and throw it. Turn gravity past zero and they rise.",
  prompt: { title: "Shoot the sky", detail: "Click or tap anywhere up there" },
  Scene
};

export default shatter;
