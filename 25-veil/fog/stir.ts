import * as THREE from "three/webgpu";
import { FOG } from "./shape";

// How much fog lies over each patch of the coast, worked out on the processor: a 128 × 128 field over FOG.field. A hand
// drawn through it sweeps the fog aside, pushing the air along with it, so the hole it opens swirls and drifts on the
// wind; the bank rolls back in from upwind and the hole fills again over half a minute or so. The shader reads it as a
// small texture (red: how much fog), filtered, under the fog's own billows.

const N = 128;
const CELL = FOG.field.size / N;

export type Stir = {
  texture: THREE.DataTexture;
  // Sweep the fog aside at a point, moving the way the hand moves (metres a second).
  sweep: (x: number, z: number, vx: number, vz: number, radius: number) => void;
  step: (dt: number, windX: number, windZ: number) => void;
  // How much fog is left round a point, 0 to 1.
  at: (x: number, z: number) => number;
  // The share of the field swept clear, 0 to 1.
  cleared: () => number;
};

export function makeStir(): Stir {
  let fog = new Float32Array(N * N).fill(1);
  let spare = new Float32Array(N * N);
  const u = new Float32Array(N * N);
  const v = new Float32Array(N * N);
  const nu = new Float32Array(N * N);
  const nv = new Float32Array(N * N);
  const data = new Uint8Array(N * N * 4).fill(255);
  const texture = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  // A field read between its cells, off the edge as fog (the bank outside is whole) and still air.
  const sample = (field: Float32Array, x: number, y: number, outside: number) => {
    if (x < 0 || y < 0 || x > N - 1 || y > N - 1) return outside;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const i1 = Math.min(N - 1, i + 1);
    const j1 = Math.min(N - 1, j + 1);
    const a = field[j * N + i];
    const b = field[j * N + i1];
    const c = field[j1 * N + i];
    const d = field[j1 * N + i1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };

  return {
    texture,
    sweep(x, z, vx, vz, radius) {
      const ci = (x - FOG.field.x) / CELL;
      const cj = (z - FOG.field.z) / CELL;
      const r = radius / CELL;
      const reach = Math.ceil(r * 1.6);
      const speed = Math.min(25, Math.hypot(vx, vz));
      for (let j = Math.max(0, Math.floor(cj - reach)); j <= Math.min(N - 1, Math.ceil(cj + reach)); j++)
        for (let i = Math.max(0, Math.floor(ci - reach)); i <= Math.min(N - 1, Math.ceil(ci + reach)); i++) {
          const dx = i - ci;
          const dy = j - cj;
          const d2 = (dx * dx + dy * dy) / (r * r);
          if (d2 > 2.5) continue;
          const w = Math.exp(-d2 * 1.6);
          const k = j * N + i;
          // The hand thins the fog it passes through, more the faster it moves, and drags the air along, a little
          // outward from its path too, so the fog parts to either side.
          fog[k] *= 1 - w * Math.min(0.5, 0.08 + speed * 0.03);
          const out = Math.sqrt(d2) + 1e-3;
          u[k] += w * (vx * 0.5 + (dx / out) * speed * 0.15);
          v[k] += w * (vz * 0.5 + (dy / out) * speed * 0.15);
        }
    },
    step(dt, windX, windZ) {
      if (dt <= 0) return;
      const keep = Math.exp(-dt * 0.7);
      // The air: carried along by itself, slowing, spreading a little to its neighbours.
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const k = j * N + i;
          const x = i - (u[k] * dt) / CELL;
          const y = j - (v[k] * dt) / CELL;
          nu[k] = sample(u, x, y, 0) * keep;
          nv[k] = sample(v, x, y, 0) * keep;
        }
      u.set(nu);
      v.set(nv);
      // The fog: carried by the wind and the stirred air, rolling back in a little everywhere, as a bank does.
      const refill = 1 - Math.exp(-dt * 0.035);
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const k = j * N + i;
          const x = i - ((windX + u[k]) * dt) / CELL;
          const y = j - ((windZ + v[k]) * dt) / CELL;
          const carried = sample(fog, x, y, 1);
          spare[k] = carried + (1 - carried) * refill;
        }
      [fog, spare] = [spare, fog];
      for (let k = 0; k < N * N; k++) data[k * 4] = Math.round(Math.max(0, Math.min(1, fog[k])) * 255);
      texture.needsUpdate = true;
    },
    at(x, z) {
      return sample(fog, (x - FOG.field.x) / CELL, (z - FOG.field.z) / CELL, 1);
    },
    cleared() {
      let sum = 0;
      for (let k = 0; k < N * N; k++) sum += fog[k];
      return 1 - sum / (N * N);
    }
  };
}
