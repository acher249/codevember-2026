"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useDispose } from "../../shared/engine/dispose";
import { Birds } from "../../shared/engine/outdoors";
import { usePromptDone } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { suspendRetried } from "../../shared/engine/retry";
import type { QualityTier } from "../../shared/engine/types";
import { shadow } from "../outside";
import { uiBlocks } from "../panels";
import { statSources } from "../stats";
import { airShown, FallingLeaves, ForestShafts, Midges } from "./air";
import { loadForest, type ForestTextures } from "./assets";
import { forestTrees, type TreeSpot } from "./layout";
import { applyDevParts, devParts, SHADOW_ONLY_LAYER, woodShown } from "./lights";
import { buildGrowth, bushCrowns } from "./plants";
import { birds, setOutside } from "./sound";
import { CLEARING, forestGround } from "./terrain";
import { bakeCanopyGaps, barkMaterial, buildCanopy, buildTrunks, CANOPY_EYE, canopyTime, leafCluster, leafMaterial, type Crown } from "./trees";

export { forestFloorLook } from "./floor";
export { leafStep } from "./sound";
export { CLEARING, forestGround, keepInClearing } from "./terrain";
export { treeHit, treeSolid } from "./layout";
export { useFrameFocus } from "./focus";
export { loadForest, type ForestTextures } from "./assets";

// Burrow's way in: a clearing in a broadleaf wood at the foot of the cliff, the trees closing round it on both sides
// and behind, the midday sun coming down through the leaves. Everything is built once,
// behind the loader; nothing here changes with the tier once the visit has started.

// Sectors round the clearing, so each part of the wood is its own mesh and those out of view are skipped.
const SECTORS = 10;
function sectorOf(spot: TreeSpot) {
  if (spot.z < -2) return SECTORS + Math.floor((spot.x + 70) / 28);
  const a = Math.atan2(spot.z - 1, spot.x - CLEARING.x);
  return Math.max(0, Math.min(SECTORS - 1, Math.floor((a / Math.PI) * SECTORS)));
}

function buildWood(t: ForestTextures, sun: THREE.Vector3, tier: QualityTier) {
  const planted = forestTrees();
  // On Low the wood is thinned: no far ring, every other tree in the middle distance, half the saplings.
  const trees = tier === "low" ? planted.trees.filter((t, i) => t.detail === 2 || (t.detail === 1 && i % 2 === 0)) : planted.trees;
  const saplings = tier === "low" ? planted.saplings.filter((_, i) => i % 2 === 0) : planted.saplings;
  const bark = barkMaterial(t, sun);
  const cluster = leafCluster();
  const leaves = leafMaterial(cluster, sun);
  const group = new THREE.Group();
  group.name = "forest-wood";
  const disposables: { dispose(): void }[] = [bark, cluster, leaves];
  const allCrowns: Crown[] = [];
  // Fewer cards on Low.
  const scale = tier === "low" ? 0.55 : tier === "medium" ? 0.8 : 1;
  const perClump = (spot: TreeSpot) => Math.round((spot.detail === 2 ? 26 : spot.detail === 1 ? 14 : 8) * scale);
  const bySector = new Map<number, TreeSpot[]>();
  for (const spot of [...trees, ...saplings]) {
    const k = sectorOf(spot);
    if (!bySector.has(k)) bySector.set(k, []);
    bySector.get(k)!.push(spot);
  }
  for (const spots of bySector.values()) {
    const { geometry, crowns } = buildTrunks(spots, forestGround);
    const trunks = new THREE.Mesh(geometry, bark);
    trunks.castShadow = trunks.receiveShadow = true;
    group.add(trunks);
    const canopy = buildCanopy(crowns, leaves, (spot) => (spot.height < 9 ? Math.round(10 * scale) : perClump(spot)), CANOPY_EYE);
    group.add(canopy.mesh);
    disposables.push(geometry, canopy.geometry);
    for (const c of crowns) allCrowns.push(...c.clumps);
  }
  // The understorey's bushes, of the same leaves.
  const bushes = buildCanopy(bushCrowns(), leaves, () => Math.round(12 * scale), CANOPY_EYE);
  bushes.mesh.castShadow = tier !== "low";
  group.add(bushes.mesh);
  disposables.push(bushes.geometry);
  return { group, disposables, trees, crowns: allCrowns };
}

// The pick, for when the pointer is over rock that a click would dig: an icon that follows the pointer (a CSS cursor
// image is drawn small and soft on a sharp screen), PICK_SIZE px, its point at PICK_SPOT px in from its top left, where
// a dot marks it.
const PICK_SIZE = 58;
const PICK_SPOT = 7;
const PICK = `<svg xmlns='http://www.w3.org/2000/svg' width='${PICK_SIZE}' height='${PICK_SIZE}' viewBox='0 0 32 32'><g fill='none' stroke-linecap='round'><path d='M9 23 L24 8' stroke='#2a1a10' stroke-width='5'/><path d='M9 23 L24 8' stroke='#b98a5a' stroke-width='3'/><path d='M14 4 Q25 3 29 14' stroke='#1b1b1e' stroke-width='5'/><path d='M14 4 Q25 3 29 14' stroke='#d8dade' stroke-width='3'/></g><circle cx='3.9' cy='3.9' r='1.5' fill='#fff' stroke='#1b1b1e' stroke-width='0.8'/></svg>`;

// The first time the pointer comes over the cliff, a small tag by it says what a click does; the cursor turns to a
// pick whenever it is over rock within a pick's reach (see aim), and back as you walk out of it.
function useCliffHint(aim: (clientX: number, clientY: number) => THREE.Vector3 | null, inside: () => number) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const aimRef = useRef({ aim, inside });
  aimRef.current = { aim, inside };
  const dug = usePromptDone();
  const dugRef = useRef(dug);
  useEffect(() => {
    dugRef.current = dug;
  }, [dug]);
  useEffect(() => {
    const dom = gl.domElement;
    const tag = document.createElement("div");
    tag.className = "burrow-dig-tag";
    tag.textContent = "Click to dig";
    const pick = document.createElement("div");
    pick.className = "burrow-pick";
    pick.innerHTML = PICK;
    const style = document.createElement("style");
    style.textContent = `
      .burrow-dig-tag { position: fixed; left: 0; top: 0; pointer-events: none; z-index: 30; padding: 6px 11px; border-radius: 999px; background: rgba(18, 14, 10, 0.62); backdrop-filter: blur(6px); color: #f6ead8; font-size: 13px; letter-spacing: 0.04em; white-space: nowrap; opacity: 0; transform: translate(18px, 14px) scale(0.92); transition: opacity 0.35s ease, transform 0.35s ease; }
      .burrow-dig-tag.on { opacity: 1; transform: translate(18px, 14px) scale(1); }
      .burrow-pick { position: fixed; left: 0; top: 0; z-index: 30; pointer-events: none; display: none; width: ${PICK_SIZE}px; height: ${PICK_SIZE}px; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.45)); }
      .burrow-pick svg { display: block; }
      .burrow-pick.on { display: block; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(tag);
    document.body.appendChild(pick);
    let shownAt = 0;
    let over = false;
    let pending: PointerEvent | null = null;
    let frame = 0;
    const check = () => {
      frame = 0;
      const event = pending;
      if (!event) return;
      const hit = aimRef.current.aim(event.clientX, event.clientY);
      // Out in the clearing, only the cliff's face (not the floor at your feet); underground, any rock in reach.
      const outside = aimRef.current.inside() < 0.5;
      // Never over a panel or with one open.
      over = !!hit && (!outside || hit.y - forestGround(hit.x, hit.z) > 0.6) && !uiBlocks(event);
      dom.style.cursor = over ? "none" : "";
      pick.classList.toggle("on", over);
      pick.style.transform = `translate(${event.clientX - PICK_SPOT}px, ${event.clientY - PICK_SPOT}px)`;
      tag.style.left = `${event.clientX + PICK_SIZE - 2 * PICK_SPOT}px`;
      tag.style.top = `${event.clientY}px`;
      // Once, for a few seconds or until the first strike.
      if (over && !shownAt && !dugRef.current) shownAt = performance.now();
      const on = over && shownAt > 0 && performance.now() - shownAt < 4500 && !dugRef.current;
      tag.classList.toggle("on", on);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      pending = event;
      if (!frame) frame = requestAnimationFrame(check);
    };
    const leave = () => {
      pending = null;
      tag.classList.remove("on");
      pick.classList.remove("on");
      dom.style.cursor = "";
    };
    // Still over the rock while the tag is up: let it go when its time is over even if the pointer rests. And a pointer
    // at rest while you walk or turn: whether it is in reach again.
    const timer = window.setInterval(() => {
      if (shownAt && (performance.now() - shownAt > 4500 || dugRef.current)) tag.classList.remove("on");
      if (pending && !frame) frame = requestAnimationFrame(check);
    }, 150);
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerleave", leave);
    return () => {
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerleave", leave);
      window.clearInterval(timer);
      if (frame) cancelAnimationFrame(frame);
      dom.style.cursor = "";
      tag.remove();
      pick.remove();
      style.remove();
    };
  }, [gl]);
}

export type ForestProps = {
  // The sun's direction (toward it).
  sun: THREE.Vector3;
  // The rock's scan of broken rock face, for the scree (rock.ts `broken`); loaded again here if not given.
  stone?: THREE.Texture;
  // How far underground the visitor is: 0 out in the clearing, 1 underground.
  inside: () => number;
  // Where a click at this point of the screen would dig, or null.
  aim: (clientX: number, clientY: number) => THREE.Vector3 | null;
};

export function Forest({ sun, inside, aim, stone }: ForestProps) {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const t = suspendRetried(() => loadForest(stone), ["burrow-forest", stone ? "shared" : "own"]);
  const wood = useMemo(() => buildWood(t, sun, startTier), [t, sun, startTier]);
  const growth = useMemo(() => buildGrowth(t, sun, startTier), [t, sun, startTier]);
  useDispose(...wood.disposables, ...growth.disposables);
  useCliffHint(aim, inside);
  const scene = useThree((state) => state.scene);
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __forest: { wood, growth, scene, gl } });

  // The sun's shadow drawn again with the wood in it while the loader is still up, so its shadow pipelines are built
  // then, not on the first step that moves the shadow.
  useEffect(() => shadow.redraw(), [wood, growth]);

  // What the wood and the low growth draw right now, for `__burrowStats()` (stats.ts; development only).
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    statSources.set("forest", () => {
      const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const count = (meshes: THREE.Object3D[]) => {
        let draws = 0;
        let instances = 0;
        let vertices = 0;
        let cards = 0;
        for (const object of meshes) {
          const mesh = object as THREE.InstancedMesh;
          if (!mesh.visible || !mesh.layers.isEnabled(0) || !mesh.geometry) continue;
          const sphere = mesh.isInstancedMesh ? mesh.boundingSphere : mesh.geometry.boundingSphere;
          if (sphere && !frustum.intersectsSphere(sphere)) continue;
          const n = mesh.isInstancedMesh ? mesh.count : 1;
          draws++;
          instances += n;
          if (mesh.isInstancedMesh) cards += n;
          vertices += mesh.geometry.getAttribute("position").count * n;
        }
        return { draws, instances, vertices, cards };
      };
      const trees = count(wood.group.children);
      const low = count(growth.group.children);
      return {
        shown: wood.group.visible ? "yes" : "no",
        "wood draws in view": trees.draws,
        "leaf cards in view": trees.cards,
        "wood vertices in view": trees.vertices,
        "growth draws in view": low.draws,
        "growth instances in view": low.instances,
        "growth vertices in view": low.vertices
      };
    });
    return () => void statSources.delete("forest");
  }, [wood, growth, camera]);

  // Development only: the outdoors' parts by name for `__burrowHide` (forest/lights.ts).
  const air = useRef<THREE.Group>(null);
  const low = useRef<THREE.Group>(null);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const canopy = () => wood.group.children.filter((child) => (child as THREE.InstancedMesh).isInstancedMesh);
    devParts.set("canopy", canopy);
    devParts.set("trunks", () => wood.group.children.filter((child) => !(child as THREE.InstancedMesh).isInstancedMesh));
    devParts.set("growth", () => (low.current ? [low.current] : []));
    devParts.set("air", () => (air.current ? [air.current] : []));
    return () => ["canopy", "trunks", "growth", "air"].forEach((name) => devParts.delete(name));
  }, [wood, growth]);

  const clock = useRef({ time: 0, next: 0 });
  useFrame((_, raw) => {
    // The canopy's gaps for the sun's shadow (trees.ts), drawn once the renderer can; the shadow again when they are in.
    bakeCanopyGaps(gl as unknown as THREE.WebGPURenderer, shadow.redraw);
    if (process.env.NODE_ENV !== "production" && applyDevParts()) shadow.redraw();
    const dt = Number.isFinite(raw) ? Math.min(raw, 1 / 20) : 1 / 60;
    const c = clock.current;
    c.time += dt;
    canopyTime.value = c.time;
    const out = 1 - inside();
    airShown.value = out;
    setOutside(out);
    birds(c.time);
    if (c.time > c.next) {
      c.next = c.time + 0.2;
      // The low growth only as far as it can be made out.
      // A cell that casts a shadow is never hidden, only moved off the eye's layer, so the shadow map keeps it.
      for (const mesh of growth.group.children as THREE.Mesh[]) {
        const sphere = mesh.geometry && (mesh as THREE.InstancedMesh).boundingSphere;
        if (!sphere) continue;
        const near = camera.position.distanceTo(sphere.center) - sphere.radius < mesh.userData.reach;
        if (mesh.castShadow) mesh.layers.set(near ? 0 : SHADOW_ONLY_LAYER);
        else mesh.visible = near;
      }
    }
    // Nothing of the wood is drawn deep underground.
    const show = out > 0.002;
    if (show !== wood.group.visible) {
      wood.group.visible = growth.group.visible = woodShown.current = show;
      // The trees' shade on the cliff and the floor comes and goes with them.
      shadow.redraw();
    }
  });

  return (
    <>
      <primitive object={wood.group} />
      <group ref={low}>
        <primitive object={growth.group} />
      </group>
      <group ref={air}>
        {startTier === "low" ? null : <ForestShafts sun={sun} trees={wood.trees} crowns={wood.crowns} count={22} />}
        <Midges sun={sun} count={startTier === "low" ? 40 : 140} />
        <FallingLeaves sun={sun} count={startTier === "low" ? 20 : 60} />
      </group>
      {/* Small birds crossing over the clearing between the crowns, in twos and threes. */}
      <Birds count={9} centre={[CLEARING.x, 17, CLEARING.z + 2]} spread={9} color="#1a1610" size={0.09} groupSize={3} separation={1.4} />
    </>
  );
}
