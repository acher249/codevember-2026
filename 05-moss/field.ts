import * as THREE from "three/webgpu";
import { flatnessAt, noise, poolAt, smooth } from "./cliff";
import { pointHash } from "../shared/engine/random";

// The moss on the rock, held in the cliff's own (u, v) metres. It keeps to where water gathers.

export const FIELD_SIZE = 26;
const GRID = 260;

// How much water a spot holds on its own: level ground keeps it, and on the walls it runs down the joints.
function dampAt(u: number, v: number) {
  const seep = smooth(0.56, 0.78, noise(u * 0.3 + 40, v * 0.028 + 3));
  const patch = noise(u * 0.5 + 20, v * 0.5);
  return 0.24 + flatnessAt(u, v) * 0.13 + seep * 0.34 + (patch - 0.5) * 0.26;
}

// Where moss can live at all. On a real cliff that is only some of it: shelves, wet joints and shaded pockets, with bare rock between.
function habitatAt(u: number, v: number) {
  if (poolAt(u, v, 1.1) > 0) return 0;
  const seep = smooth(0.56, 0.78, noise(u * 0.3 + 40, v * 0.028 + 3));
  const pocket = noise(u * 0.19 + 3, v * 0.19 + 13) * 0.62 + noise(u * 0.71, v * 0.71 + 6) * 0.38;
  return smooth(0.6, 0.76, pocket + seep * 0.26 + flatnessAt(u, v) * 0.05);
}

// Where the moss is. It has been here a long time, and it stays as it is.
export const firstMossAt = (u: number, v: number) => habitatAt(u, v);

// Where the moss is and how wet the rock is, as a texture, in the cliff's own (u, v) metres.
export class MossField {
  texture: THREE.DataTexture;

  constructor() {
    const pixels = new Uint8Array(GRID * GRID * 4);
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        const wx = (x / (GRID - 1) - 0.5) * FIELD_SIZE;
        const wz = (z / (GRID - 1) - 0.5) * FIELD_SIZE;
        pixels.set([firstMossAt(wx, wz) * 255, dampAt(wx, wz) * 255, 0, 255], (z * GRID + x) * 4);
      }
    }
    this.texture = new THREE.DataTexture(pixels, GRID, GRID, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}

// A repeating tile of little rounded strands: red is how tall a strand stands at each point, green the cushions they form.
export function makeStrandTile() {
  const size = 256;
  const cells = 42;
  const data = new Uint8Array(size * size * 4);
  const jitter: [number, number, number][] = [];
  for (let i = 0; i < cells * cells; i++) jitter.push([pointHash(i, 1), pointHash(i, 2), 0.45 + pointHash(i, 3) * 0.55]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * cells;
      const v = (y / size) * cells;
      const cx = Math.floor(u);
      const cy = Math.floor(v);
      let best = 0;
      let tint = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = (cx + dx + cells) % cells;
          const gy = (cy + dy + cells) % cells;
          const [jx, jy, tall] = jitter[gy * cells + gx];
          const distance = Math.hypot(cx + dx + jx - u, cy + dy + jy - v);
          const strand = Math.max(0, 1 - distance / 0.72) * tall;
          if (strand > best) {
            best = strand;
            tint = tall;
          }
        }
      }
      // Tileable cushions from a few whole-number waves.
      const a = (x / size) * Math.PI * 2;
      const b = (y / size) * Math.PI * 2;
      const cushion = 0.5 + 0.22 * Math.sin(a * 3 + 1) * Math.cos(b * 2) + 0.17 * Math.sin(a * 5 + b * 4 + 2) + 0.11 * Math.cos(a * 9 - b * 7);
      const i = (y * size + x) * 4;
      data[i] = Math.min(255, best * 255);
      data[i + 1] = Math.min(255, Math.max(0, cushion) * 255);
      data[i + 2] = tint * 255;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
