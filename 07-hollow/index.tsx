"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { uniform } from "three/tsl";
import * as THREE from "three/webgpu";
import { orbitPoint, useGrabbable } from "../shared/engine/controls";
import { airAmount, airTint, focusDistance } from "../shared/engine/Post";
import { scenePhase, useQuality } from "../shared/engine/quality";
import { useSettingAction, useSettingRef, useSettingsStore } from "../shared/engine/settings";
import { sound, useBed, useEvery, useMusic } from "../shared/engine/sound";
import { Birds } from "../shared/engine/outdoors";
import { KeyLight, StudioEnvironment } from "../shared/engine/studio";
import type { DayDefinition } from "../shared/engine/types";
import { bakeField } from "./field";
import { JuiceSim, useJuice, type BladeFrame } from "./juice";
import { rootMaterial, dropMaterial, cutMaterial, fuzzMaterial, hollowMaterial, leafMaterial, newBlade, poolMaterial, skinMaterial, stemMaterial, stoneMaterial, strandMaterial, type Blade } from "./materials";
import { SUN, buildWaves, oceanMaterial, polarGrid } from "./ocean";
import { Seed } from "./seed";
import { Boats, Dinghies, Dolphins, FarLand, Fish, Planes, Sharks, SkyDome, Skyline, Underwater } from "./world";
import { useReefAssets, type ReefAssets } from "./reef";
import { CENTRE_Y, JUICE_LEVEL, R, cavityAt, cavityMiddleY, cavityRadius, radialSurface, skinRadius, stoneRadius } from "./shape";

const FRAME_WIDE = R * 1.2;
const FRAME_TALL = R * 1.15;
const REACH = R * 1.22;
// One bar outside the middle of each side, a third as long as that side: its centre across and up, and half its length each way.
const BAR_OFFSET = 0.22;
const BARS: [number, number, number, number][] = [
  [0, FRAME_TALL + BAR_OFFSET, FRAME_WIDE / 3, 0],
  [0, -FRAME_TALL - BAR_OFFSET, FRAME_WIDE / 3, 0],
  [FRAME_WIDE + BAR_OFFSET, 0, 0, FRAME_TALL / 3],
  [-FRAME_WIDE - BAR_OFFSET, 0, 0, FRAME_TALL / 3]
];
// However far the blade goes, a piece of the peach is left.
const BLADE_LEAST = -0.62;
const BACKGROUND = "#04232c";
const YELLOW = new THREE.Color("#ffb324");
const RED = new THREE.Color("#c9142a");

function buildLeaf() {
  const along = 56;
  const across = 12;
  const position: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= along; i++) {
    const u = i / along;
    const half = 0.34 * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.72)), 0.82) + 0.002;
    for (let j = 0; j <= across; j++) {
      const v = (j / across) * 2 - 1;
      const ripple = Math.sin(u * 19 + v * 2) * 0.012 * Math.abs(v);
      position.push(u * 2.7, Math.abs(v) * half * 0.34 - u * u * 1.15 + ripple, v * half);
      if (i < along && j < across) {
        const a = i * (across + 1) + j;
        index.push(a, a + across + 1, a + 1, a + 1, a + across + 1, a + across + 2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

// Small drops: off the ceiling of the hollow, and crawling down the strands.
type Drop = { position: THREE.Vector3; wait: number; swell: number; speed: number; strand: number; along: number; size: number; wall?: THREE.Vector3 };

const fromCeiling = (): Pick<Drop, "position" | "wait" | "swell" | "speed" | "strand" | "along"> => {
  const angle = Math.random() * Math.PI * 2;
  const out = Math.random() * 0.75;
  return { position: cavityAt(Math.cos(angle) * out, 1, Math.sin(angle) * out), wait: Math.random() * 4, swell: 0, speed: 0, strand: -1, along: 0 };
};

// How high the swell has lifted something, for those things that cannot read the waves. Long and slow, like the waves that matter to them.
// What the mirror in the water does not show. Fuzz, hair and everything under the surface would cost a great deal, and be lost in the waves.
const NOT_REFLECTED = 1;
const swell = (x: number, z: number, t: number) => Math.sin(x * 0.31 + z * 0.17 + t * 0.62) * 0.11 + Math.sin(x * 0.13 - z * 0.27 + t * 0.41 + 1.3) * 0.08;

function Peach({ tier, assets }: { tier: "low" | "medium" | "high"; assets: ReefAssets }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const dom = useThree((state) => state.gl.domElement) as HTMLCanvasElement;
  const store = useSettingsStore();
  const cut = useSettingRef<number>("cut");
  const turn = useSettingRef<number>("turn");
  const tilt = useSettingRef<number>("tilt");
  const juice = useSettingRef<number>("juice");
  const field = useMemo(() => bakeField(tier === "low" ? 64 : 96), [tier]);
  const blade: Blade = useMemo(() => newBlade(field), [field]);
  const shells = tier === "high" ? 34 : tier === "medium" ? 22 : 10;
  // Full hair up close. From further off the same fuzz is drawn with far fewer shells, and looks just the same.
  const levels = useMemo(() => uniform(shells), [shells]);
  const rings = useMemo(() => Array.from({ length: 6 }, () => uniform(new THREE.Vector4(0, 0, -100, 0))), []);
  const seed = useMemo(() => new Seed(tier === "high" ? 84 : tier === "medium" ? 56 : 28), [tier]);
  const sim = useMemo(() => new JuiceSim(tier === "high" ? 9 : tier === "medium" ? 6 : 4), [tier]);
  const juiceDraw = useJuice(sim.drips.length * 3, tier === "low" ? 18 : 30);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const under = useMemo(() => uniform(0), []);
  // When quality changes, everything needs its shaders built again. What is hidden would only do that the moment it is first
  // seen, which is the worst moment for it, so it is drawn along with the rest while the frame is stalled anyway.
  const warmUnder = useRef(0);
  const liveTier = useQuality().tier;
  useEffect(() => {
    warmUnder.current = 4;
  }, [liveTier]);
  const follow = useMemo(() => uniform(new THREE.Vector2()), []);
  const gridScale = useMemo(() => uniform(1), []);
  const impacts = useMemo(() => Array.from({ length: 8 }, () => uniform(new THREE.Vector4(0, 0, -100, 0))), []);
  const sea = useMemo(() => buildWaves({ size: tier === "low" ? 128 : 256, lengths: tier === "low" ? [96, 15] : tier === "medium" ? [120, 26] : [140, 34, 6.8], wind: 5.5, fetchKm: 80, direction: 0.7, height: 0.3 }, blade.time), [tier, blade]);
  const seaGrid = useMemo(() => polarGrid(tier === "low" ? 110 : 150, tier === "low" ? 150 : tier === "medium" ? 240 : 360), [tier]);
  const seaMaterials = useMemo(() => {
    const options = { resolutionScale: tier === "high" ? 0.5 : tier === "medium" ? 0.38 : 0.26, cascades: sea.cascades, peachInverse: blade.inverse, bladeNormal: blade.normal, bladeDepth: blade.depth, time: blade.time, noise: field, impacts: impacts as any, gridScale, follow };
    return { above: oceanMaterial(false, options), below: oceanMaterial(true, options) };
  }, [sea, blade, field, impacts, gridScale, follow, tier]);
  // The mirror takes its plane from this, which only works from inside the scene.
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const target = seaMaterials.above.userData.mirror.target;
    scene.add(target);
    return () => {
      scene.remove(target);
    };
  }, [scene, seaMaterials]);
  useEffect(
    () => () => {
      seaMaterials.above.dispose();
      seaMaterials.below.dispose();
      seaGrid.dispose();
      sea.textures.forEach((item) => item.dispose());
    },
    [seaMaterials, seaGrid, sea]
  );

  const geometry = useMemo(() => {
    const scale = tier === "high" ? 1 : tier === "medium" ? 0.6 : 0.3;
    const round = (value: number) => Math.round(value * scale);
    return {
      skin: radialSurface(skinRadius, round(1024), round(768)),
      fuzz: radialSurface(skinRadius, tier === "high" ? 260 : tier === "medium" ? 180 : 112, tier === "high" ? 170 : tier === "medium" ? 120 : 80),
      hollow: radialSurface(cavityRadius, round(640), round(480), cavityMiddleY, true),
      stone: radialSurface(stoneRadius, Math.max(320, round(700)), Math.max(240, round(520))),
      leaf: buildLeaf(),
      stem: new THREE.CylinderGeometry(0.075, 0.12, 0.9, 16, 6)
    };
  }, [tier]);

  const materials = useMemo(
    () => ({
      skin: skinMaterial(blade),
      fuzz: fuzzMaterial(blade, levels, tier !== "low"),
      cut: cutMaterial(blade),
      hollow: hollowMaterial(blade),
      stone: stoneMaterial(blade),
      strand: strandMaterial(blade),
      pool: poolMaterial(blade, rings),
      drop: dropMaterial(),
      stem: stemMaterial(blade),
      leaf: leafMaterial(blade),
      frame: new THREE.MeshBasicNodeMaterial({ color: "#ffe9c8", transparent: true, opacity: 0.2, depthWrite: false }),
      corner: new THREE.MeshBasicNodeMaterial({ color: "#fff2da", transparent: true, opacity: 0.7, depthWrite: false }),
      sheen: new THREE.MeshBasicNodeMaterial({ color: "#ffc98c", transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
      bar: new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.78, depthWrite: false, toneMapped: false })
    }),
    [blade, levels, tier, rings]
  );

  const fuzz = useMemo(() => {
    const mesh = new THREE.InstancedMesh(geometry.fuzz, materials.fuzz, shells);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < shells; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    return mesh;
  }, [geometry.fuzz, materials.fuzz, shells]);

  const drops = useMemo<Drop[]>(() => {
    const list: Drop[] = [];
    for (let i = 0; i < 12; i++) list.push({ ...fromCeiling(), size: 0.024 + Math.random() * 0.02 });
    // The rest crawl the strands.
    const crawlers = tier === "low" ? 10 : 26;
    for (let i = 0; i < crawlers; i++) list.push({ ...fromCeiling(), strand: Math.floor(Math.random() * seed.strands.length), along: Math.random(), wait: Math.random() * 3, size: 0.018 + Math.random() * 0.03 });
    // And some run down the inside walls of the hollow.
    const wallDrops = tier === "low" ? 16 : 44;
    for (let i = 0; i < wallDrops; i++) {
      const angle = Math.random() * Math.PI * 2;
      list.push({ ...fromCeiling(), wall: new THREE.Vector3(Math.cos(angle), 0.2 + Math.random() * 1.6, Math.sin(angle)), wait: Math.random() * 5, size: 0.016 + Math.random() * 0.026 });
    }
    return list;
  }, [tier, seed]);

  const dropMesh = useMemo(() => {
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), materials.drop, drops.length);
    mesh.frustumCulled = false;
    const tint = new THREE.Color();
    for (let i = 0; i < drops.length; i++) mesh.setColorAt(i, tint.copy(Math.random() < 0.5 ? YELLOW : RED));
    return mesh;
  }, [materials.drop, drops.length]);

  useEffect(
    () => () => {
      Object.values(geometry).forEach((item) => item.dispose());
      Object.values(materials).forEach((item) => item.dispose());
      fuzz.dispose();
      field.dispose();
      dropMesh.dispose();
      seed.geometry.dispose();
    },
    [geometry, materials, fuzz, dropMesh, field, seed]
  );

  // A dark ring on the wall of the hollow around the root of every strand, which is what makes it look grown from there.
  const roots = useMemo(() => {
    const mesh = new THREE.InstancedMesh(new THREE.CircleGeometry(0.5, 20), rootMaterial(blade), seed.strands.length);
    const matrix = new THREE.Matrix4();
    const turn = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const inward = new THREE.Vector3();
    const place = new THREE.Vector3();
    const forward = new THREE.Vector3(0, 0, 1);
    seed.strands.forEach((strand, i) => {
      inward.set(0, cavityMiddleY, 0).sub(strand.wall).normalize();
      place.copy(strand.wall).addScaledVector(inward, 0.012);
      turn.setFromUnitVectors(forward, inward);
      scale.setScalar(0.24 + strand.width * 15);
      matrix.compose(place, turn, scale);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.frustumCulled = false;
    mesh.layers.set(NOT_REFLECTED);
    return mesh;
  }, [seed, blade]);
  useEffect(() => () => roots.dispose(), [roots]);

  const face = useRef<THREE.Mesh>(null);
  const frame = useRef<THREE.Group>(null);
  const line = tier === "low" ? 0.024 : 0.01;
  // After the sea, which would otherwise paint over them.
  useEffect(() => {
    frame.current?.traverse((part) => {
      part.renderOrder = 5;
    });
  });
    const stoneMesh = useRef<THREE.Mesh>(null);
  const bars = useRef<(THREE.Mesh | null)[]>([]);
  const peach = useRef<THREE.Group>(null);
  const seaAbove = useRef<THREE.Mesh>(null);
  const onShore = useRef<THREE.Group>(null);
  const seaBelow = useRef<THREE.Mesh>(null);
  const unseen = useRef<THREE.Group>(null);
  const work = useMemo(
    () => ({
      normal: new THREE.Vector3(1, 0, 0),
      along: new THREE.Vector3(0, 0, 1),
      up: new THREE.Vector3(0, 1, 0),
      basis: new THREE.Matrix4(),
      hit: new THREE.Vector3(),
      plane: new THREE.Plane(),
      middle: new THREE.Vector3(),
      from: new THREE.Vector3(),
      slide: new THREE.Vector3(),
      temp: new THREE.Vector3(),
      matrix: new THREE.Matrix4(),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(),
      held: false,
      holdingSeed: false,
      hovering: false,
      grabDepth: 0,
      grabPoint: new THREE.Vector3(),
      seedOffset: new THREE.Vector3(),
      lastDepth: 1.2 * REACH,
      lastSeed: new THREE.Vector3(),
      clock: 0,
      sinceLive: -1,
      inside: false,
      nextRing: 0,
      nextImpact: 0,
      local: new THREE.Ray(),
      inverse: new THREE.Matrix4(),
      glow: 0,
      submerged: false,
      holdingPeach: false,
      body: { position: new THREE.Vector3(0, CENTRE_Y, 0), velocity: new THREE.Vector3(), target: new THREE.Vector3(), tiltX: 0, tiltZ: 0, tiltXSpeed: 0, tiltZSpeed: 0, grabOffset: new THREE.Vector3(), wake: 0, wasIn: true },
      dive: { left: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), fromTarget: new THREE.Vector3(), toTarget: new THREE.Vector3() },
      fitted: false
    }),
    []
  );
  const frameData: BladeFrame = useMemo(() => ({ normal: work.normal, along: work.along, up: work.up, depth: 9, speed: 0 }), [work]);

  const wet = useBed("river", 0);
  useBed("hum", 0.035);
  const breeze = useBed("wind", 0.05);

  // Between the surface and the deep, in one press.
  useSettingAction("dive", () => {
    const point = orbitPoint.current;
    if (!point) return;
    const going = !work.submerged;
    work.dive.left = 1;
    work.dive.from.copy(camera.position);
    work.dive.fromTarget.copy(point);
    if (going) {
      // Under the peach, wherever it has got to, looking down far enough to see the reef too.
      work.dive.to.copy(work.body.position).add(work.temp.set(6.4, -5.6, 9.6)).setY(-5.6);
      work.dive.toTarget.copy(work.body.position).setY(-6.4);
    } else {
      work.dive.to.set(11, 4.6, 16.2);
      work.dive.toTarget.set(0, 1.75, 0);
    }
  });

  useEffect(() => {
    fuzz.layers.set(NOT_REFLECTED);
    dropMesh.layers.set(NOT_REFLECTED);
    juiceDraw.proxy.layers.set(NOT_REFLECTED);
    frame.current?.traverse((part) => part.layers.set(NOT_REFLECTED));
    unseen.current?.traverse((part) => {
      if (part.layers.mask !== 1 << 11) part.layers.set(NOT_REFLECTED);
    });
    camera.layers.enable(NOT_REFLECTED);
    return () => camera.layers.disable(NOT_REFLECTED);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, fuzz, dropMesh, juiceDraw.proxy]);

  useEffect(() => {
    airTint.value.set("#0d6068");
    airAmount.value = 0;
    return () => {
      airTint.value.set("#d8c8b4");
      airAmount.value = 1;
    };
  }, []);

  const ringAt = (x: number, z: number, amount: number) => {
    const ring = rings[work.nextRing];
    work.nextRing = (work.nextRing + 1) % rings.length;
    ring.value.set(x, z, work.clock, amount);
  };

  const splash = (x: number, z: number, amount: number) => {
    const impact = impacts[work.nextImpact];
    work.nextImpact = (work.nextImpact + 1) % impacts.length;
    impact.value.set(x, z, work.clock, amount);
  };

  useEffect(() => {
    seed.onTear = (x, y, z) => {
      sound.play("rustle", { gain: 0.16, pitch: 1.4 + Math.random() * 0.7 });
      sound.play("drip", { gain: 0.1, pitch: 0.7 + Math.random() * 0.4 });
      sim.hurry();
      ringAt(x, z, 0.6);
      void y;
    };
    seed.onSplash = (x, z, speed) => {
      const at = work.body.position;
      const hit = Math.min(2.4, 0.4 + speed * 0.16);
      splash(x + at.x, z + at.z, hit);
      splash(x + at.x + 0.3, z + at.z - 0.2, hit * 0.6);
      sound.play("plop", { gain: Math.min(0.6, 0.12 + speed * 0.04), pitch: 0.62 });
    };
    return () => {
      seed.onTear = null;
      seed.onSplash = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, sim]);

  useEffect(() => {
    sim.onPool = (x, z, r) => {
      ringAt(x, z, 1.4);
      sound.play("plop", { gain: 0.08 + r * 0.7, pitch: 1.2 - r * 1.5 });
    };
    sim.onFloor = (x, z, r) => {
      const at = peach.current?.position;
      splash(x + (at?.x ?? 0), z + (at?.z ?? 0), 0.5 + r * 4);
      sound.play("plop", { gain: 0.05 + r * 0.5, pitch: 0.95 - r });
    };
    return () => {
      sim.onPool = null;
      sim.onFloor = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim]);

  const orient = () => {
    const azimuth = THREE.MathUtils.degToRad(turn.current);
    const pitch = THREE.MathUtils.degToRad(tilt.current);
    work.normal.set(Math.sin(azimuth) * Math.cos(pitch), Math.sin(pitch), Math.cos(azimuth) * Math.cos(pitch));
    work.along.set(0, 1, 0).cross(work.normal).normalize();
    work.up.crossVectors(work.normal, work.along).normalize();
  };

  // The blade: a bar outside the middle of each side of its frame, any of which will carry it.
  useGrabbable({
    pick: (worldRay) => {
      orient();
      const ray = work.local.copy(worldRay).applyMatrix4(blade.inverse.value);
      const depth = cut.current * REACH;
      work.middle.copy(work.normal).multiplyScalar(depth);
      // About the same size under the finger however far away the frame is.
      const reach = THREE.MathUtils.clamp(ray.origin.length() * (window.matchMedia("(hover: none)").matches ? 0.02 : 0.012), 0.08, 0.6);
      let best: THREE.Vector3 | null = null;
      let nearest = reach * reach;
      for (const [cx, cy, hx, hy] of BARS) {
        work.from.copy(work.middle).addScaledVector(work.along, cx).addScaledVector(work.up, cy);
        work.slide.copy(work.along).multiplyScalar(hx).addScaledVector(work.up, hy);
        const start = work.from.clone().sub(work.slide);
        const end = work.from.clone().add(work.slide);
        const onBar = new THREE.Vector3();
        const gap = ray.distanceSqToSegment(start, end, undefined, onBar);
        if (gap < nearest) {
          nearest = gap;
          best = onBar;
        }
      }
      if (!best) return null;
      return { distance: ray.origin.distanceTo(best) * 0.5, point: peach.current!.localToWorld(best.clone()) };
    },
    grab: (point) => {
      work.held = true;
      work.sinceLive = 1e9;
      work.grabDepth = cut.current * REACH;
      work.grabPoint.copy(point).applyMatrix4(blade.inverse.value);
      dom.style.cursor = "grabbing";
      sound.play("click", { gain: 0.1, pitch: 0.8 });
    },
    drag: (point) => {
      // Only movement across the screen is known, so this asks how far along the blade's normal that movement carries it.
      camera.getWorldDirection(work.from);
      const onScreen = work.slide.copy(work.normal).addScaledVector(work.from, -work.normal.dot(work.from));
      // Held back where the blade faces the viewer, where a small movement of the hand would otherwise send it a long way.
      const amount = Math.max(onScreen.lengthSq(), 0.36);
      const moved = point.clone().applyMatrix4(blade.inverse.value).sub(work.grabPoint).dot(onScreen) / amount;
      store.set("cut", THREE.MathUtils.clamp((work.grabDepth + moved) / REACH, BLADE_LEAST, 1.2));
    },
    release: () => {
      work.held = false;
    },
    hover: (hovering) => {
      work.hovering = hovering;
      dom.style.cursor = hovering ? "grab" : "";
    }
  });

  // The stone: reachable only from the side that has been cut away.
  useGrabbable({
    pick: (worldRay) => {
      orient();
      const ray = work.local.copy(worldRay).applyMatrix4(blade.inverse.value);
      const depth = cut.current * REACH;
      // Inside the part that remains, it can only be reached through the cut. Once loose and out in the open, it can be reached from anywhere.
      if (!seed.free && ray.origin.dot(work.normal) < depth && seed.position.dot(work.normal) < depth) return null;
      const alongRay = seed.position.clone().sub(ray.origin).dot(ray.direction);
      if (alongRay < 0 || ray.distanceToPoint(seed.position) > 0.92) return null;
      return { distance: alongRay - 0.3, point: peach.current!.localToWorld(ray.origin.clone().addScaledVector(ray.direction, alongRay)) };
    },
    grab: (point) => {
      seed.held = true;
      work.holdingSeed = true;
      work.sinceLive = 1e9;
      work.seedOffset.copy(seed.position).sub(work.temp.copy(point).applyMatrix4(blade.inverse.value));
      seed.target.copy(seed.position);
      sound.play("creak", { gain: 0.12, pitch: 1.3 });
    },
    drag: (point) => {
      seed.target.copy(point).applyMatrix4(blade.inverse.value).add(work.seedOffset);
    },
    release: (velocity) => {
      seed.letGo(velocity);
      work.holdingSeed = false;
      sound.play("plop", { gain: 0.07, pitch: 0.7 });
    },
    hover: (hovering) => {
      dom.style.cursor = hovering ? "grab" : "";
    }
  });

  // The peach itself. Grip and stone come first: this answers only where neither of them does. On a phone it fills the view,
  // so a press has to rest a moment before it takes the peach, and a quick swipe still turns the camera.
  const restToGrab = useMemo(() => (typeof window !== "undefined" && window.matchMedia("(hover: none)").matches ? 170 : undefined), []);
  useGrabbable({
    holdToGrab: restToGrab,
    pick: (worldRay) => {
      orient();
      const ray = work.local.copy(worldRay).applyMatrix4(blade.inverse.value);
      const toMiddle = -ray.origin.dot(ray.direction);
      const off = Math.sqrt(Math.max(0, ray.origin.lengthSq() - toMiddle * toMiddle));
      if (off > R * 0.98 || toMiddle < 0) return null;
      const entry = toMiddle - Math.sqrt(R * R * 0.96 - off * off);
      const depth = cut.current * REACH;
      let distance = entry;
      const at = ray.origin.clone().addScaledVector(ray.direction, entry);
      if (at.dot(work.normal) > depth) {
        // That part has been cut away, so the ray goes on to the cut, if it meets it inside the peach.
        const along = (depth - ray.origin.dot(work.normal)) / ray.direction.dot(work.normal);
        if (!(along > 0) || ray.origin.clone().addScaledVector(ray.direction, along).length() > R * 0.96) return null;
        distance = along;
      }
      return { distance: distance + 6, point: peach.current!.localToWorld(ray.origin.clone().addScaledVector(ray.direction, distance)) };
    },
    grab: (point) => {
      work.holdingPeach = true;
      work.sinceLive = 1e9;
      work.body.grabOffset.copy(work.body.position).sub(point);
      work.body.target.copy(work.body.position);
      sound.play("rustle", { gain: 0.14, pitch: 0.7 });
    },
    drag: (point) => {
      work.body.target.copy(point).add(work.body.grabOffset);
    },
    release: (velocity) => {
      work.holdingPeach = false;
      if (velocity.length() > work.body.velocity.length()) work.body.velocity.copy(velocity);
      // However hard it was thrown, it stays within reach.
      work.body.velocity.clampLength(0, 24);
    },
    hover: (hovering) => {
      dom.style.cursor = hovering ? "grab" : "";
    }
  });

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    work.clock += delta;
    blade.time.value = work.clock;
    blade.juice.value = juice.current;

    // The sea moves first, and the peach rides on it.
    gl.compute(sea.computes);
    const t = work.clock;
    const group = peach.current;
    if (group) {
      const body = work.body;
      const pos = body.position;
      const vel = body.velocity;
      const before = vel.clone();
      if (work.holdingPeach) {
        // Follows the hand firmly, and stays out from under the sea floor.
        vel.addScaledVector(work.temp.copy(body.target).sub(pos), delta * 70);
        vel.multiplyScalar(Math.exp(-delta * 11));
      } else {
        // Rides at its waterline, rocked by the swell. Once out of the water, only gravity has it.
        const riding = CENTRE_Y + Math.sin(t * 0.66) * 0.17 + Math.sin(t * 1.07 + 1.1) * 0.07;
        const touching = pos.y < R * 0.93;
        vel.y += (touching ? (riding - pos.y) * 13 : -9.8) * delta;
        const drag = touching ? 2.6 : 0.04;
        vel.multiplyScalar(Math.exp(-delta * drag));
        // Drifts slowly back to the middle, so that it is never lost.
        vel.x -= pos.x * delta * 0.05;
        vel.z -= pos.z * delta * 0.05;
      }
      pos.addScaledVector(vel, delta);
      pos.y = Math.max(pos.y, -7);
      const range = Math.hypot(pos.x, pos.z);
      if (range > 42) {
        pos.x *= 42 / range;
        pos.z *= 42 / range;
      }
      // Hitting the water, and pushing through it, both show on the surface.
      const inWater = pos.y < R * 0.93;
      if (inWater !== body.wasIn) {
        body.wasIn = inWater;
        const hit = Math.abs(vel.y);
        if (hit > 1.5) {
          for (let i = 0; i < 4; i++) splash(pos.x + Math.cos(i * 1.6) * R * 0.5, pos.z + Math.sin(i * 1.6) * R * 0.5, Math.min(2.4, hit * 0.34));
          sound.play("plop", { gain: Math.min(0.7, hit * 0.09), pitch: 0.42 });
        }
      }
      body.wake -= delta;
      if (inWater && pos.y > -R && body.wake < 0 && Math.hypot(vel.x, vel.z) > 1) {
        body.wake = 0.22;
        splash(pos.x, pos.z, Math.min(1.5, Math.hypot(vel.x, vel.z) * 0.22));
      }
      // Leans into where it is going, and comes back upright.
      body.tiltXSpeed += (vel.z * 0.05 - body.tiltX) * delta * 7;
      body.tiltZSpeed += (-vel.x * 0.05 - body.tiltZ) * delta * 7;
      body.tiltXSpeed *= Math.exp(-delta * 2.4);
      body.tiltZSpeed *= Math.exp(-delta * 2.4);
      body.tiltX = THREE.MathUtils.clamp(body.tiltX + body.tiltXSpeed * delta, -0.8, 0.8);
      body.tiltZ = THREE.MathUtils.clamp(body.tiltZ + body.tiltZSpeed * delta, -0.8, 0.8);
      group.position.copy(pos);
      group.rotation.set(Math.sin(t * 0.47) * 0.035 + body.tiltX, Math.sin(t * 0.09) * 0.1, Math.sin(t * 0.58 + 0.8) * 0.042 + body.tiltZ);
      group.updateMatrixWorld();
      blade.inverse.value.copy(group.matrixWorld).invert();
      // What the peach goes through, what is inside it feels, the other way.
      seed.jostle(before.sub(vel), work.temp.copy(vel).multiplyScalar(delta), delta);
    }
    // The grid follows the camera, and spreads out as the camera climbs.
    gridScale.value = Math.max(1, Math.abs(camera.position.y) * 0.22);
    follow.value.set(camera.position.x, camera.position.z);

    if (!work.fitted && orbitPoint.current) {
      work.fitted = true;
      const fit = (R * 1.34) / (Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
      const away = camera.position.distanceTo(orbitPoint.current);
      if (fit > away) camera.position.sub(orbitPoint.current).multiplyScalar(fit / away).add(orbitPoint.current);
    }
    if (orbitPoint.current) focusDistance.value = camera.position.distanceTo(orbitPoint.current);

    if (work.dive.left > 0 && orbitPoint.current) {
      work.dive.left = Math.max(0, work.dive.left - delta / 2.2);
      const u = 1 - work.dive.left;
      const eased = u * u * (3 - 2 * u);
      camera.position.lerpVectors(work.dive.from, work.dive.to, eased);
      orbitPoint.current.lerpVectors(work.dive.fromTarget, work.dive.toTarget, eased);
    }
    // Crossing the surface. Fog comes with it, and the sounds of the air go away.
    const nowUnder = camera.position.y < swell(camera.position.x, camera.position.z, work.clock) * 0.6;
    if (nowUnder !== work.submerged) {
      work.submerged = nowUnder;
      sound.play("plop", { gain: 0.3, pitch: nowUnder ? 0.5 : 0.75 });
      sound.play("whoosh", { gain: 0.1, pitch: nowUnder ? 0.6 : 0.9 });
      breeze.current?.level(nowUnder ? 0.008 : 0.05, 0.3);
    }
    // Each side of the water only pays when it can be seen, and the mirror with it.
    if (warmUnder.current > 0) warmUnder.current -= 1;
    if (seaAbove.current) seaAbove.current.visible = camera.position.y > -1.2 || warmUnder.current > 0;
    if (seaBelow.current) seaBelow.current.visible = camera.position.y < 1.4 || warmUnder.current > 0;
    seaMaterials.above.userData.mirror.reflector.getVirtualCamera(camera).layers.set(0);
    // As the peach gets further away, one hair covers fewer pixels, until no hair could be told from the next.
    const away = camera.position.distanceTo(work.body.position) - R;
    const wantShells = Math.round(THREE.MathUtils.clamp(shells * (1.25 - away * 0.075), Math.max(8, shells * 0.3), shells) / 2) * 2;
    if (wantShells !== levels.value) {
      levels.value = wantShells;
      fuzz.count = wantShells;
    }
    if (onShore.current) onShore.current.visible = !nowUnder;
    under.value += ((nowUnder ? 1 : 0) - under.value) * Math.min(1, delta * 9);
    airAmount.value = under.value;

    // The first slice shows what the thing is for, since phones have no hint to say so.
    if (scenePhase.current === "live" && work.sinceLive !== 1e9) {
      work.sinceLive = work.sinceLive < 0 ? 0 : work.sinceLive + delta;
      const t = THREE.MathUtils.clamp((work.sinceLive - 1.8) / 3, 0, 1);
      if (t > 0) store.set("cut", THREE.MathUtils.lerp(1.2, 0.02, t * t * (3 - 2 * t)));
      if (t >= 1) work.sinceLive = 1e9;
    }

    orient();
    const depth = cut.current * REACH;
    blade.normal.value.copy(work.normal);
    blade.depth.value = depth;
    blade.along.value.copy(work.along);
    blade.down.value.copy(work.up).negate();
    work.basis.makeBasis(work.along, work.up, work.normal);
    work.middle.copy(work.normal).multiplyScalar(depth);
    if (face.current) {
      face.current.quaternion.setFromRotationMatrix(work.basis);
      face.current.position.copy(work.middle);
    }
    if (frame.current) {
      frame.current.quaternion.setFromRotationMatrix(work.basis);
      frame.current.position.copy(work.middle);
    }
    const wanted = work.held ? 1 : work.hovering ? 0.7 : 0;
    work.glow += (wanted - work.glow) * Math.min(1, delta * 11);
    materials.frame.opacity = 0.1 + work.glow * 0.5;
    materials.corner.opacity = 0.42 + work.glow * 0.58;
    materials.sheen.opacity = work.glow * 0.05;
    // The bars brighten and thicken under the hand.
    materials.bar.opacity = 0.78 + work.glow * 0.22;
    materials.bar.color.setScalar(1 + work.glow * 1.6);
    const thick = 1 + work.glow * 1.1;
    bars.current.forEach((bar, index) => {
      if (!bar) return;
      const along = BARS[index][3] > 0 ? 1 : 0;
      bar.scale.set(along ? thick : 1, along ? 1 : thick, thick);
    });

    // The sound of the blade: wet, and only while it is moving through something.
    const speed = Math.abs(depth - work.lastDepth) / Math.max(delta, 0.001);
    work.lastDepth = depth;
    const inside = Math.abs(depth) < R * 0.98;
    if (inside !== work.inside) {
      work.inside = inside;
      sound.play("rustle", { gain: 0.16, pitch: inside ? 0.8 : 1.15 });
    }
    const seedSpeed = seed.velocity.length();
    wet.current?.level(Math.min(0.34, (inside ? speed * 0.075 : 0) + (work.holdingSeed ? seedSpeed * 0.022 : 0)), 0.08);

    // The stone and strands, then the thick juice on the cut.
    const seaHere = -(group?.position.y ?? CENTRE_Y);

    if (seed.step(delta, work.normal, depth, seaHere)) {
      ringAt(seed.position.x, seed.position.z, 2);
      sound.play("plop", { gain: 0.26, pitch: 0.55 });
    } else if (seed.position.y < JUICE_LEVEL + 0.45 && seedSpeed > 1 && work.clock % 0.2 < delta) {
      ringAt(seed.position.x, seed.position.z, Math.min(1.4, seedSpeed * 0.3));
    }
    if (stoneMesh.current) {
      stoneMesh.current.position.copy(seed.position);
      stoneMesh.current.quaternion.copy(seed.quaternion);
    }
    frameData.depth = depth;
    frameData.speed = speed;
    sim.step(delta, frameData, juice.current, seaHere);
    if (group) juiceDraw.update(sim, group.matrixWorld);

    for (let i = 0; i < drops.length; i++) {
      const drop = drops[i];
      if (drop.wait > 0) {
        drop.wait -= delta * Math.max(juice.current, 0.05);
        work.scale.setScalar(0);
      } else if (drop.wall) {
        // Clinging to the wall, it stops and starts on its way down.
        const stutter = 0.5 + 0.5 * Math.sin(work.clock * (0.7 + (i % 5) * 0.31) + i);
        drop.wall.y -= delta * (0.03 + stutter * stutter * 0.3) * (drop.size / 0.03);
        drop.position.copy(cavityAt(drop.wall.x, drop.wall.y, drop.wall.z)).multiplyScalar(0.985);
        const here = drop.position.dot(work.normal) < depth;
        const grown = Math.min(1, drop.swell);
        drop.swell += delta * 0.8;
        work.scale.set(drop.size * grown, drop.size * (1.6 + stutter * 1.8) * grown, drop.size * grown);
        if (!here) work.scale.setScalar(0);
        if (drop.position.y < JUICE_LEVEL) {
          if (here) ringAt(drop.position.x, drop.position.z, 0.5);
          const angle = Math.random() * Math.PI * 2;
          drop.wall.set(Math.cos(angle), 0.2 + Math.random() * 1.6, Math.sin(angle));
          drop.swell = 0;
          drop.wait = Math.random() * 3;
        }
      } else if (drop.strand >= 0 && drop.speed === 0) {
        // Crawling down a strand, a little quicker where the strand is swung about.
        drop.along += delta * (0.1 + (i % 5) * 0.03 + Math.min(0.4, seedSpeed * 0.1));
        seed.along(drop.strand, drop.along, drop.position);
        const lean = drop.size * Math.min(1, drop.along * 4);
        work.scale.set(lean, lean * 1.25, lean);
        // A strand that was cut away takes its drops with it.
        if (drop.position.dot(work.normal) > depth && seed.strands[drop.strand].hangs) work.scale.setScalar(0);
        if (drop.along > 0.72) drop.speed = 0.001;
      } else if (drop.strand < 0 && drop.swell < 1) {
        drop.swell = Math.min(1, drop.swell + delta * 0.8);
        work.scale.set(drop.size * drop.swell, drop.size * 1.25 * drop.swell, drop.size * drop.swell);
      } else {
        drop.speed += 6.5 * delta;
        drop.position.y -= drop.speed * delta;
        work.scale.set(drop.size * 0.8, drop.size + Math.min(0.08, drop.speed * 0.012), drop.size * 0.8);
        const onFloor = drop.position.y < seaHere;
        if (drop.position.y < JUICE_LEVEL && (drop.position.dot(work.normal) < depth || onFloor)) {
          if (!onFloor) {
            ringAt(drop.position.x, drop.position.z, 1);
            sound.play("drip", { gain: 0.05, pitch: 0.8 + Math.random() * 0.5 });
          }
          drop.wait = Math.random() * 3;
          drop.speed = 0;
          drop.swell = 0;
          drop.along = 0;
          if (drop.strand >= 0) drop.strand = Math.floor(Math.random() * seed.strands.length);
          else drop.position.copy(fromCeiling().position);
        }
      }
      work.matrix.compose(drop.position, work.quaternion.identity(), work.scale);
      dropMesh.setMatrixAt(i, work.matrix);
    }
    dropMesh.instanceMatrix.needsUpdate = true;

  });

  const corner = 0.42;
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1]
  ];

  return (
    <>
      <group ref={onShore}>
        <Skyline />
        <FarLand />
      </group>
      <mesh ref={seaAbove} geometry={seaGrid} material={seaMaterials.above} frustumCulled={false} renderOrder={3} />
      <mesh ref={seaBelow} geometry={seaGrid} material={seaMaterials.below} frustumCulled={false} renderOrder={3} layers={NOT_REFLECTED} />
      <Boats count={tier === "low" ? 7 : 15} impact={splash} surface={swell} />
      <Dinghies count={tier === "low" ? 10 : 22} impact={splash} surface={swell} />
      <Dolphins count={tier === "low" ? 4 : 8} impact={splash} />
      <group ref={unseen}>
      <Sharks count={tier === "low" ? 2 : 3} time={blade.time} impact={splash} noise={field} />
      <Fish assets={assets} count={tier === "low" ? 48 : 180} time={blade.time} noise={field} />
      <Underwater assets={assets} warm={warmUnder} time={blade.time} noise={field} under={under} specks={tier === "low" ? 160 : 520} shafts={tier === "low" ? 14 : 34} reef={tier === "low" ? 0.42 : tier === "medium" ? 0.65 : 1} />
      </group>
      <group ref={peach}>
      <mesh geometry={geometry.skin} material={materials.skin} castShadow receiveShadow frustumCulled={false} />
      <primitive object={fuzz} />
      <mesh geometry={geometry.hollow} material={materials.hollow} frustumCulled={false} />
      <mesh ref={stoneMesh} geometry={geometry.stone} material={materials.stone} frustumCulled={false} />
      <mesh geometry={seed.geometry} material={materials.strand} frustumCulled={false} layers={NOT_REFLECTED} />
      <primitive object={roots} />
      <primitive object={dropMesh} />
      <primitive object={juiceDraw.proxy} />
      <mesh material={materials.pool} position={[0, JUICE_LEVEL, 0]} rotation={[-Math.PI / 2, 0, 0]} layers={NOT_REFLECTED}>
        <planeGeometry args={[R * 1.4, R * 1.4, 1, 1]} />
      </mesh>
      <mesh ref={face} material={materials.cut} frustumCulled={false}>
        <planeGeometry args={[R * 2.7, R * 2.7, 1, 1]} />
      </mesh>
      <mesh geometry={geometry.stem} material={materials.stem} position={[-0.2, R * 0.76 + 0.32, 0.02]} rotation={[0.06, 0, 0.14]} castShadow />
      <mesh geometry={geometry.leaf} material={materials.leaf} position={[-0.25, R * 0.76 + 0.46, 0.03]} rotation={[0.2, 2.46, 0.3]} castShadow frustumCulled={false} />
      <mesh geometry={geometry.leaf} material={materials.leaf} position={[-0.22, R * 0.76 + 0.58, 0]} rotation={[-0.34, 1.02, 0.5]} scale={0.56} castShadow frustumCulled={false} />
      <group ref={frame}>
        <mesh material={materials.sheen} renderOrder={2}>
          <planeGeometry args={[FRAME_WIDE * 2, FRAME_TALL * 2]} />
        </mesh>
        <mesh material={materials.frame} position={[0, FRAME_TALL, 0]}>
          <boxGeometry args={[FRAME_WIDE * 2, line, line]} />
        </mesh>
        <mesh material={materials.frame} position={[0, -FRAME_TALL, 0]}>
          <boxGeometry args={[FRAME_WIDE * 2, line, line]} />
        </mesh>
        <mesh material={materials.frame} position={[FRAME_WIDE, 0, 0]}>
          <boxGeometry args={[line, FRAME_TALL * 2, line]} />
        </mesh>
        <mesh material={materials.frame} position={[-FRAME_WIDE, 0, 0]}>
          <boxGeometry args={[line, FRAME_TALL * 2, line]} />
        </mesh>
        {corners.map(([x, y]) => (
          <group key={`${x}${y}`} position={[x * FRAME_WIDE, y * FRAME_TALL, 0]}>
            <mesh material={materials.corner} position={[(-x * corner) / 2, 0, 0]}>
              <boxGeometry args={[corner, line * 2.4, line * 2.4]} />
            </mesh>
            <mesh material={materials.corner} position={[0, (-y * corner) / 2, 0]}>
              <boxGeometry args={[line * 2.4, corner, line * 2.4]} />
            </mesh>
          </group>
        ))}
        {BARS.map(([cx, cy, hx, hy], index) => (
          <mesh
            key={index}
            ref={(mesh) => {
              bars.current[index] = mesh;
            }}
            material={materials.bar}
            position={[cx, cy, 0]}
          >
            <boxGeometry args={hx > 0 ? [hx * 2, line * 3, line * 3] : [line * 3, hy * 2, line * 3]} />
          </mesh>
        ))}
      </group>
      </group>
      <SkyDome time={blade.time} noise={field} under={under} />
    </>
  );
}

function Scene() {
  const { tier } = useQuality();
  const [firstTier] = useState(tier);
  const assets = useReefAssets(firstTier === "low");
  useMusic("/codevember/music/uplifting-cinematic-vlog.mp3", 0.34);
  useEvery(5, 13, () => sound.play("caw", { gain: 0.05, pitch: 1.2 + Math.random() * 0.5, pan: Math.random() * 1.4 - 0.7 }));
  const sunAt = useMemo(() => SUN.clone().multiplyScalar(26).toArray() as [number, number, number], []);
  return (
    <>
      <StudioEnvironment
        ambient="#1a0f12"
        intensity={0.85}
        boxes={[
          { position: [0, 18, 0], scale: [24, 0.2, 24], color: "#b9a6c9", intensity: 1.3 },
          { position: [-13, 2, -19], scale: [18, 5, 0.2], color: "#ffbd84", intensity: 7 },
          { position: [-15, 8, 9], scale: [0.2, 12, 16], color: "#ffe6cf", intensity: 4 },
          { position: [15, 6, 3], scale: [0.2, 9, 13], color: "#ffd2b4", intensity: 3 },
          { position: [10, 5, 15], scale: [14, 8, 0.2], color: "#fff0e4", intensity: 2.4 },
          { position: [0, -10, 0], scale: [24, 0.2, 24], color: "#1a5c62", intensity: 1.6 }
        ]}
      />
      <KeyLight position={[-11, 13, 9]} target={[0, CENTRE_Y, 0]} color="#ffe9d2" intensity={900} angle={0.4} penumbra={0.75} shadowFar={40} />
      <spotLight position={[15, 7, 7]} target-position={[0, CENTRE_Y, 0]} intensity={240} angle={0.44} penumbra={1} color="#fff0e0" decay={2} />
      {/* The low sun, from behind, for the halo that fuzz makes along an edge. */}
      <spotLight position={sunAt} target-position={[0, CENTRE_Y, 0]} intensity={1500} angle={0.3} penumbra={0.9} color="#ffb877" decay={2} />
      <Planes count={firstTier === "low" ? 2 : 4} />
      <group>
        <Birds count={firstTier === "low" ? 20 : 70} centre={[-15, 11, -18]} spread={15} color="#2c2336" size={0.5} groupSize={13} />
        <Birds count={firstTier === "low" ? 14 : 56} centre={[18, 15, -26]} spread={18} color="#2c2336" size={0.56} groupSize={11} />
        <Birds count={firstTier === "low" ? 12 : 46} centre={[-40, 22, -70]} spread={24} color="#3a3048" size={0.86} groupSize={14} />
        <Birds count={firstTier === "low" ? 8 : 34} centre={[30, 18, 12]} spread={22} color="#2c2336" size={0.62} groupSize={10} />
      </group>
      <Peach tier={firstTier} assets={assets} />
    </>
  );
}

const hollow: DayDefinition = {
  // Auto may still lower the resolution, which costs nothing. It stays on its first tier, because changing one rebuilds every
  // shader in the scene, which stops the page for seconds, and this scene's detail is set when it loads anyway.
  autoFloor: "high",
  camera: { position: [11, 4.6, 16.2], target: [0, 1.75, 0], fov: 34 },
  extents: { centre: [0, CENTRE_Y, 0], radius: 90, floor: -7.2, color: "#ffc58a" },
  passes: { bounce: false, haze: false, overlay: true, depthOfField: { range: 36, sharpSky: true, air: 0.96, airRate: 0.016 } },
  look: { background: BACKGROUND, exposure: 1, bloom: 0.16, bloomThreshold: 1.5, ao: 0.5, aoRadius: 0.16, aoReach: 8, vignette: 0.28, grain: 0.012 },
  settings: {
    cut: { type: "range", label: "Blade", min: BLADE_LEAST, max: 1.2, step: 0.001, value: 1.2 },
    turn: { type: "range", label: "Turn", min: 0, max: 360, step: 1, value: 60 },
    tilt: { type: "range", label: "Tilt", min: -80, max: 80, step: 1, value: 0 },
    juice: { type: "range", label: "Juice", min: 0, max: 2, step: 0.01, value: 1 },
    dive: { type: "action", label: "Dive or surface" }
  },
  notes: "A giant peach, afloat at sunrise and cut live. The stone hangs by wet strands, and you can pull it out. Waves ported from Ultra Water by Humpalumps.",
  phonePills: ["dive"],
  hint: "Drag a bar on the frame to slice. Grab the stone and rip it out, or throw the whole peach. Orbit low to go under the water.",
  overview: [
    {
      title: "Simulation",
      points: [
        "Tessendorf FFT ocean ported from Ultra Water: JONSWAP spectra in up to three 256x256 cascades, run as WebGPU compute shaders.",
        "The stone hangs on up to 84 strands of 13 Verlet points each, solved in 5 pull-only constraint rounds so they sag."
      ]
    },
    {
      title: "Shaders",
      points: [
        "The juice is ray-marched per pixel in TSL: up to 27 spheres merged with Inigo Quilez's polynomial smooth minimum, 30 steps.",
        "Slicing is a shader mask: every material discards past the blade plane, and one quad shades the cut face from signed distances."
      ]
    },
    {
      title: "Lighting and materials",
      points: [
        "A planar reflector mirrors boats, city and peach at a quarter to half resolution; fuzz, juice and drops sit on an unreflected layer.",
        "Underwater, Poly Haven CC0 scans and an instanced reef of up to 1,900 grass tufts and 340 kelp take distance-based colour absorption."
      ]
    },
    {
      title: "Optimisations",
      points: [
        "One 96-cubed baked 3D noise texture, with Worley cells and soft noise, replaces per-pixel noise in every shader.",
        "Above-water and below-water sea materials draw only when visible, and the quality tier is fixed at load to avoid shader rebuilds."
      ]
    }
  ],
  Scene
};

export default hollow;
