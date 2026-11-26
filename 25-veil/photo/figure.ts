import * as THREE from "three/webgpu";
import { backArrays, buildAll, frontArrays, poolArrays, type Arrays, type Built, type Meta } from "./build";

// The figure from the photograph, as the browser rebuilds it: her front exactly as the photograph has it (its geometry
// read by MoGe-3, one point per pixel, figure-front.bin), the side the camera never saw made as a solid behind it
// (figure-back.bin), and her body inside. Built offline in Blender (veil-sim, scripts/export.py); figure.json holds the
// photograph's camera and how the files are packed. The meshes themselves are made from them here (build.ts).

export type { Meta };
// `built`: the meshes Watchers draws, already made off the page (loadBuilt).
export type FigureData = { meta: Meta; grid: Uint16Array; solid: ArrayBuffer; under?: Uint8Array; built?: Built };

const ROOT = "/assets/25-veil";

export async function loadFigure(): Promise<FigureData> {
  const [meta, grid, solid] = await Promise.all([
    fetch(`${ROOT}/figure.json`).then((r) => r.json() as Promise<Meta>),
    fetch(`${ROOT}/figure-front.bin`).then((r) => r.arrayBuffer()),
    fetch(`${ROOT}/figure-back.bin`).then((r) => r.arrayBuffer())
  ]);
  // How near under the cloth her body lies, per pixel (scripts/fitbody.py), if it has been made.
  const under = await fetch(`${ROOT}/figure-under.bin`)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);
  return { meta, grid: new Uint16Array(grid), solid, under: under ? new Uint8Array(under) : undefined };
}

// A phone (or anything phone-sized): the near figure is built lighter (build.ts), and the scene draws less behind her.
export function lightDevice() {
  if (typeof window === "undefined") return false;
  // ?light=1 or ?light=0 forces it either way, in development, to compare.
  const forced = process.env.NODE_ENV !== "production" ? new URLSearchParams(window.location.search).get("light") : null;
  if (forced) return forced === "1";
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  return window.matchMedia("(max-width: 720px)").matches || (coarse && Math.min(window.innerWidth, window.innerHeight) < 600);
}

// The figure and the meshes Watchers draws, fetched and built in a worker (figure-worker.ts) so the page never stalls
// over them; on the page, as before, where there is no worker to be had.
export function loadBuilt(): Promise<FigureData> {
  if (typeof Worker === "undefined")
    return loadFigure().then((data) => ({ ...data, built: buildAll(data.meta, data.grid, data.solid, data.under, lightDevice()) }));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./figure-worker.ts", import.meta.url));
    worker.onmessage = (event: MessageEvent) => {
      worker.terminate();
      const { meta, grid, solid, under, built, error } = event.data;
      if (error) reject(new Error(error));
      else resolve({ meta, grid: new Uint16Array(grid), solid, under: under ? new Uint8Array(under) : undefined, built });
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "The figure could not be built."));
    };
    worker.postMessage({ light: lightDevice() });
  });
}

// A mesh's arrays as geometry.
function geometry({ position, normal, index, under }: Arrays) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  // How near under the cloth her body is, at each point: the cloth greys over her.
  if (under) g.setAttribute("under", new THREE.BufferAttribute(under, 1));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

export function front({ meta, grid, under }: FigureData, stride = 1, passes = 4) {
  return geometry(frontArrays(meta, grid, under, stride, passes));
}

// The solid behind: settled onto the floor like the front.
export function back({ meta, solid }: FigureData) {
  return geometry(backArrays(meta, solid));
}

// The meshes Watchers draws, made once for the figure and shared by everything that draws her (the statues, the glitch's
// copies of them): rebuilt whenever a component drew again, they froze the page for half a second each time. Freed when
// the world goes (release).
export type Parts = { near: THREE.BufferGeometry; far: THREE.BufferGeometry; solid: THREE.BufferGeometry; hem: THREE.BufferGeometry };
const shared = new WeakMap<FigureData, Parts>();
export function parts(data: FigureData): Parts {
  let made = shared.get(data);
  if (!made) {
    const built = data.built ?? buildAll(data.meta, data.grid, data.solid, data.under, lightDevice());
    made = { near: geometry(built.near), far: geometry(built.far), solid: geometry(built.solid), hem: geometry(built.hem) };
    shared.set(data, made);
  }
  return made;
}
export function release(data: FigureData) {
  const made = shared.get(data);
  if (!made) return;
  shared.delete(data);
  for (const g of Object.values(made)) g.dispose();
}

// Her body: the solid drawn in toward her middle, so it is everywhere well inside the cloth (along its normals it came out
// through the thin cloth in her lap), lowered by as much, and with nothing below the lap (seen through the gaps in the cloth
// on the floor, its underside showed as blots).
export function body(solid: THREE.BufferGeometry, shrink: number) {
  const geometry = solid.clone();
  const p = geometry.attributes.position as THREE.BufferAttribute;
  geometry.computeBoundingBox();
  const c = geometry.boundingBox!.getCenter(new THREE.Vector3());
  for (let k = 0; k < p.count; k++)
    p.setXYZ(k, c.x + (p.getX(k) - c.x) * shrink, p.getY(k) - (1 - shrink) * 0.2, c.z + (p.getZ(k) - c.z) * shrink);
  const index = geometry.index!.array;
  const kept: number[] = [];
  for (let k = 0; k < index.length; k += 3)
    if (p.getY(index[k]) > 0.3 && p.getY(index[k + 1]) > 0.3 && p.getY(index[k + 2]) > 0.3) kept.push(index[k], index[k + 1], index[k + 2]);
  geometry.setIndex(kept);
  geometry.computeVertexNormals();
  return geometry;
}

// The hem's skirt round her footprint (build.ts).
export function pool(...parts: THREE.BufferGeometry[]) {
  return geometry(poolArrays(...parts.map((g) => g.attributes.position.array as Float32Array)));
}
