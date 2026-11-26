// The figure fetched and built off the page (build.ts), so the loader keeps moving while it is: on the page this held
// every frame for over half a second. Everything is handed back, the files as fetched and the meshes made from them,
// moved rather than copied.
import { buildAll, type Meta } from "./build";

const ROOT = "/assets/25-veil";

self.onmessage = async (event: MessageEvent<{ light?: boolean } | null>) => {
  try {
    const [meta, grid, solid, under] = await Promise.all([
      fetch(`${ROOT}/figure.json`).then((r) => r.json() as Promise<Meta>),
      fetch(`${ROOT}/figure-front.bin`).then((r) => r.arrayBuffer()),
      fetch(`${ROOT}/figure-back.bin`).then((r) => r.arrayBuffer()),
      // How near under the cloth her body lies, per pixel (scripts/fitbody.py), if it has been made.
      fetch(`${ROOT}/figure-under.bin`)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null)
    ]);
    const built = buildAll(meta, new Uint16Array(grid), solid, under ? new Uint8Array(under) : undefined, !!event.data?.light);
    const moved: ArrayBuffer[] = [grid, solid, ...(under ? [under] : [])];
    for (const part of Object.values(built)) for (const array of Object.values(part)) if (array) moved.push((array as Float32Array).buffer as ArrayBuffer);
    self.postMessage({ meta, grid, solid, under, built }, { transfer: moved });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
