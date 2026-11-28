import * as THREE from "three/webgpu";
import { OVERLAY_LAYER } from "../shared/engine/Post";

// Numbers for the dev console's `__burrowStats()`: each part of the day may add a source, a function that says what it
// is drawing right now (asked only when the helper runs, never per frame).
export const statSources = new Map<string, () => Record<string, number | string>>();

// How long the frame's own work takes on the page (every useFrame and the render's submission), stamped by two frame
// callbacks in index.tsx at the very first and last priorities.
export const frameClock = { start: 0, total: 0, frames: 0 };

type Pass = { renders: number; draws: number; triangles: number };

// Samples about `seconds` of frames, then logs one table and resolves with it. Draws and triangles are split by pass
// (renderer.info counts the whole frame): each `renderer.render` is told apart by what it draws with, and a pass drawn
// from inside another (the sun's shadow and the mirrors render while the scene does) is taken out of the outer one.
export function sampleStats(gl: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, seconds = 1.5) {
  return new Promise<Record<string, number | string>>((resolve) => {
    const shadowCameras = new Set<THREE.Camera>();
    scene.traverse((object) => {
      const light = object as THREE.DirectionalLight;
      if (light.isLight && light.shadow?.camera) shadowCameras.add(light.shadow.camera);
    });
    const passOf = (what: THREE.Object3D, by: THREE.Camera) => {
      if ((what as { isQuadMesh?: boolean }).isQuadMesh) return "post";
      if (shadowCameras.has(by)) return "shadow";
      if (what !== scene) return "other (icons, studio)";
      if (by === camera) return by.layers.isEnabled(OVERLAY_LAYER) && !by.layers.isEnabled(0) ? "overlay" : "main";
      return "reflection";
    };
    const passes: Record<string, Pass> = {};
    const info = gl.info.render as unknown as { drawCalls: number; triangles: number };
    const stack: { draws: number; triangles: number; innerDraws: number; innerTriangles: number }[] = [];
    const render = gl.render;
    gl.render = function (this: THREE.WebGPURenderer, what: THREE.Object3D, by: THREE.Camera) {
      stack.push({ draws: info.drawCalls, triangles: info.triangles, innerDraws: 0, innerTriangles: 0 });
      const out = render.call(this, what, by);
      const top = stack.pop() as (typeof stack)[number];
      const draws = info.drawCalls - top.draws;
      const triangles = info.triangles - top.triangles;
      const pass = (passes[passOf(what, by)] ??= { renders: 0, draws: 0, triangles: 0 });
      pass.renders++;
      pass.draws += draws - top.innerDraws;
      pass.triangles += triangles - top.innerTriangles;
      const outer = stack[stack.length - 1];
      if (outer) {
        outer.innerDraws += draws;
        outer.innerTriangles += triangles;
      }
      return out;
    } as typeof gl.render;
    frameClock.total = 0;
    frameClock.frames = 0;
    let frames = 0;
    const began = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - began < seconds * 1000) {
        requestAnimationFrame(tick);
        return;
      }
      gl.render = render;
      const elapsed = (performance.now() - began) / 1000;
      const table: Record<string, number | string> = {
        fps: +(frames / elapsed).toFixed(1),
        "frame JS ms (useFrame + render submit)": +(frameClock.total / Math.max(1, frameClock.frames)).toFixed(2),
        "pixel ratio": gl.getPixelRatio(),
        size: `${gl.domElement.width}×${gl.domElement.height}`
      };
      for (const [name, pass] of Object.entries(passes)) {
        table[`${name}: renders/frame`] = +(pass.renders / frames).toFixed(2);
        table[`${name}: draws/frame`] = Math.round(pass.draws / frames);
        table[`${name}: triangles/frame`] = Math.round(pass.triangles / frames);
      }
      for (const [source, read] of statSources)
        for (const [key, value] of Object.entries(read())) table[`${source}: ${key}`] = value;
      console.table(table);
      resolve(table);
    };
    requestAnimationFrame(tick);
  });
}
