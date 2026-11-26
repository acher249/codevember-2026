// The veil in a calm breeze, as the browser unpacks it. Simulated offline at full resolution (veil-sim wind/flow.py: the
// drape remeshed at 5 mm, 209k points, each drawn back to where it rests by a spring, firm where her body lies under the
// cloth and soft in the swags and the hem, edges kept, a slow fluctuating breeze with gentle gusts sweeping across her;
// export_hd.py, which filters the motion over the surface with a 3 cm Gaussian so the folds sway whole and nothing finer
// ripples). Only the cloth that moves is kept, one point per centimetre, with a sparse set of still anchors over the rest
// of her. Nothing of three in here, so a worker can do it (wind-worker.ts).
//
// wind-hd.bin.gz: Uint32 [moving, anchors, keys, key rate x 1000], Float32 [move step m], Float32 xyz rest (moving, then
// anchors), Int8 xyz rest normal (x127), Uint32 x4 neighbours per moving point (east, west, north, south across its normal),
// then per key Int16 planes [x, y, z moves] on that step: the first key as is, the second as its change from the first,
// the rest as what the motion so far did not predict (q[k] - (2 q[k-1] - q[k-2])), each plane's low bytes, then its high.
// In the scene's y-up frame, her seat at the origin.

// The texture rows are this wide.
export const WIDTH = 4096;

// `keys`: half floats, RGBA per moving point per key (xyz moved, a spare), key after key, each key `rows` rows of WIDTH.
// `rest`: float RGBA per point (moving, then anchors). `around`: float RGBA per moving point, its four neighbours.
export type Field = { moving: number; anchors: number; count: number; rate: number; rows: number; keys: Uint16Array; rest: Float32Array; around: Float32Array; normal: Int8Array; points: Float32Array };

// Inflated here, unless the server already did (sent with Content-Encoding: gzip).
export async function inflate(buffer: ArrayBuffer) {
  const head = new Uint8Array(buffer, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buffer;
  return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

// A float as the 16 bits of a half float.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function half(value: number) {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7c00;
  // Rounded to nearest; a carry out of the mantissa steps the exponent up, as it should.
  return sign | ((e << 10) + ((x >>> 13) & 0x3ff) + ((x >>> 12) & 1));
}

// `every`: keep only every so many keys (a phone: fewer keys on its GPU, eased between as before; at a third of them the
// motion is off by 0.2 mm at most points and never over 1.2 mm, well under a pixel there). Only if the loop still closes.
export function parse(buffer: ArrayBuffer, every = 1): Field {
  const [moving, anchors, keys, rate] = new Uint32Array(buffer, 0, 4);
  const thin = every > 1 && keys % every === 0 ? every : 1;
  const [step] = new Float32Array(buffer, 16, 1);
  const count = moving + anchors;
  let at = 20;
  const points = new Float32Array(buffer.slice(at, at + count * 12));
  at += count * 12;
  const normal = new Int8Array(buffer.slice(at, at + count * 3));
  at += count * 3;
  const nb = new Uint32Array(buffer.slice(at, at + moving * 16));
  at += moving * 16;
  const rows = Math.ceil(moving / WIDTH);
  const out = new Uint16Array((keys / thin) * rows * WIDTH * 4);
  const bytes = new Uint8Array(buffer);
  let before = new Int32Array(moving * 3);
  let last = new Int32Array(moving * 3);
  let now = new Int32Array(moving * 3);
  for (let k = 0; k < keys; k++) {
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < moving; i++) {
        let r = bytes[at + i] | (bytes[at + moving + i] << 8);
        if (k > 0 && r > 32767) r -= 65536;
        const j = i * 3 + c;
        now[j] = k === 0 ? (r > 32767 ? r - 65536 : r) : k === 1 ? last[j] + r : r + 2 * last[j] - before[j];
      }
      at += moving * 2;
    }
    const base = (k / thin) * rows * WIDTH * 4;
    if (k % thin === 0)
      for (let i = 0; i < moving; i++) {
        out[base + i * 4] = half(now[i * 3] * step);
        out[base + i * 4 + 1] = half(now[i * 3 + 1] * step);
        out[base + i * 4 + 2] = half(now[i * 3 + 2] * step);
      }
    const spare = before;
    before = last;
    last = now;
    now = spare;
  }
  const rest = new Float32Array(Math.ceil(count / WIDTH) * WIDTH * 4);
  for (let i = 0; i < count; i++) rest.set(points.subarray(i * 3, i * 3 + 3), i * 4);
  const around = new Float32Array(rows * WIDTH * 4);
  for (let i = 0; i < moving * 4; i++) around[i] = nb[i];
  return { moving, anchors, count, rate: rate / 1000 / thin, rows, keys: out, rest, around, normal, points };
}

// Which of the field's points carry each of a mesh's points: its four nearest not facing the other way (a point on the
// near side of a thin fold must not follow the far side), weighted softly by nearness (a Gaussian `spread` m wide), so
// points a few millimetres apart, as where the photographed front meets the solid behind it, move alike and no seam
// opens. `at`: Float32 x4 indices (an anchor's index is the moving count or more: it stays still); `by`: Uint8 x4 weights.
export function bind(field: Field, position: Float32Array, normal: Float32Array, spread = 0.009) {
  const CELL = 0.02;
  const { points, count } = field;
  const cells = new Map<number, number[]>();
  const key = (x: number, y: number, z: number) => (x + 512) * 1048576 + (y + 512) * 1024 + (z + 512);
  for (let i = 0; i < count; i++) {
    const k = key(Math.floor(points[i * 3] / CELL), Math.floor(points[i * 3 + 1] / CELL), Math.floor(points[i * 3 + 2] / CELL));
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  }
  const n = position.length / 3;
  const at = new Float32Array(n * 4);
  const by = new Uint8Array(n * 4);
  const best = new Float64Array(4);
  const who = new Int32Array(4);
  const w = new Float64Array(4);
  for (let v = 0; v < n; v++) {
    const x = position[v * 3], y = position[v * 3 + 1], z = position[v * 3 + 2];
    const nx = normal[v * 3], ny = normal[v * 3 + 1], nz = normal[v * 3 + 2];
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
    for (let reach = 1; reach <= 3; reach++) {
      best.fill(Infinity);
      who.fill(-1);
      for (let a = -reach; a <= reach; a++)
        for (let b = -reach; b <= reach; b++)
          for (let c = -reach; c <= reach; c++) {
            const list = cells.get(key(cx + a, cy + b, cz + c));
            if (!list) continue;
            for (const i of list) {
              // Turned away from it (more than 120 degrees): the other side of the cloth.
              if (field.normal[i * 3] * nx + field.normal[i * 3 + 1] * ny + field.normal[i * 3 + 2] * nz < -0.5 * 127) continue;
              const dx = points[i * 3] - x, dy = points[i * 3 + 1] - y, dz = points[i * 3 + 2] - z;
              const d = dx * dx + dy * dy + dz * dz;
              if (d >= best[3]) continue;
              let s = 3;
              while (s > 0 && best[s - 1] > d) {
                best[s] = best[s - 1];
                who[s] = who[s - 1];
                s--;
              }
              best[s] = d;
              who[s] = i;
            }
          }
      if (who[3] >= 0) break;
    }
    let total = 0;
    for (let s = 0; s < 4; s++) total += w[s] = who[s] >= 0 ? Math.exp(-best[s] / (2 * spread * spread)) + 1e-9 : 0;
    let given = 0;
    for (let s = 0; s < 4; s++) {
      at[v * 4 + s] = Math.max(0, who[s]);
      const q = s < 3 ? Math.round((w[s] / (total || 1)) * 255) : 255 - given;
      by[v * 4 + s] = who[s] >= 0 ? Math.max(0, Math.min(255, q)) : 0;
      given += by[v * 4 + s];
    }
  }
  return { at, by };
}
