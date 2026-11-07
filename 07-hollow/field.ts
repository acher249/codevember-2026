import * as THREE from "three/webgpu";

// Noise worked out once and kept in a small block that repeats, so that shaders can look it up instead of computing it for
// every pixel. Red is cells, as in pulp. Green and blue are soft cloudy noise. Alpha is a random value for each cell.
export function bakeField(size: number) {
  const data = new Uint8Array(size * size * size * 4);
  const random = (a: number, b: number, c: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const wrap = (value: number, period: number) => ((value % period) + period) % period;

  const CELLS = 8;
  const seeds = new Float32Array(CELLS * CELLS * CELLS * 4);
  for (let i = 0, k = 0; k < CELLS; k++) {
    for (let j = 0; j < CELLS; j++) {
      for (let h = 0; h < CELLS; h++, i++) {
        seeds[i * 4] = random(h, j, k);
        seeds[i * 4 + 1] = random(h + 11, j + 3, k + 7);
        seeds[i * 4 + 2] = random(h + 5, j + 17, k + 2);
        seeds[i * 4 + 3] = random(h + 23, j + 29, k + 31);
      }
    }
  }
  const cloud = (x: number, y: number, z: number, period: number, salt: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const ease = (t: number) => t * t * (3 - 2 * t);
    const u = ease(x - x0);
    const v = ease(y - y0);
    const w = ease(z - z0);
    const at = (a: number, b: number, c: number) => random(wrap(x0 + a, period) + salt, wrap(y0 + b, period) - salt, wrap(z0 + c, period) + salt * 2);
    const near = (at(0, 0, 0) * (1 - u) + at(1, 0, 0) * u) * (1 - v) + (at(0, 1, 0) * (1 - u) + at(1, 1, 0) * u) * v;
    const far = (at(0, 0, 1) * (1 - u) + at(1, 0, 1) * u) * (1 - v) + (at(0, 1, 1) * (1 - u) + at(1, 1, 1) * u) * v;
    return near * (1 - w) + far * w;
  };

  for (let k = 0, write = 0; k < size; k++) {
    const pz = k / size;
    for (let j = 0; j < size; j++) {
      const py = j / size;
      for (let h = 0; h < size; h++, write += 4) {
        const px = h / size;
        const cx = px * CELLS;
        const cy = py * CELLS;
        const cz = pz * CELLS;
        const hx = Math.floor(cx);
        const hy = Math.floor(cy);
        const hz = Math.floor(cz);
        let nearest = 9;
        let tag = 0;
        for (let c = -1; c <= 1; c++) {
          for (let b = -1; b <= 1; b++) {
            for (let a = -1; a <= 1; a++) {
              const i = (wrap(hz + c, CELLS) * CELLS + wrap(hy + b, CELLS)) * CELLS + wrap(hx + a, CELLS);
              const dx = hx + a + seeds[i * 4] - cx;
              const dy = hy + b + seeds[i * 4 + 1] - cy;
              const dz = hz + c + seeds[i * 4 + 2] - cz;
              const distance = dx * dx + dy * dy + dz * dz;
              if (distance < nearest) {
                nearest = distance;
                tag = seeds[i * 4 + 3];
              }
            }
          }
        }
        let green = 0;
        let blue = 0;
        let amplitude = 0.5;
        for (let period = 4; period <= 32; period *= 2) {
          green += cloud(px * period, py * period, pz * period, period, 1.5) * amplitude;
          blue += cloud(px * period, py * period, pz * period, period, 8.5) * amplitude;
          amplitude *= 0.5;
        }
        data[write] = Math.min(255, Math.sqrt(nearest) * 255);
        data[write + 1] = Math.min(255, (green / 0.9375) * 255);
        data[write + 2] = Math.min(255, (blue / 0.9375) * 255);
        data[write + 3] = tag * 255;
      }
    }
  }
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}
