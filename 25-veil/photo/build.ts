// The figure's meshes as plain arrays (positions, normals, triangles), with nothing of three in them, so they can be built
// in a worker (figure-worker.ts) while the page goes on drawing, as well as on the page itself. figure.ts turns them into
// geometry.

// `clean`: the grid was smoothed offline (veil-sim scripts/front2.py: along the folds, not across them) and trimmed where
// the camera saw it edge-on; the back carries on from its edge. It needs no smoothing here.
export type Meta = { size: [number, number]; K: number[][]; R: number[][]; eye: number[]; r: [number, number]; back: { lo: number[]; hi: number[] }; clean?: boolean };

// A mesh: xyz per point, its normal, triangles, and optionally how near under the cloth her body lies at each point.
export type Arrays = { position: Float32Array; normal: Float32Array; index: Uint32Array; under?: Float32Array };

// Blender's z-up to the scene's y-up.
const up = (x: number, y: number, z: number, out: Float32Array, k: number) => {
  out[k] = x;
  out[k + 1] = z;
  out[k + 2] = -y;
};

// Cloth lying on the floor: everything below this height is eased down onto it, so the hem lies on the ground rather than
// hovering in ragged flaps over it.
const SETTLE = 0.05;
const settle = (y: number) => (y < SETTLE ? 0.004 + (y - 0.004) * Math.max(0, (y - 0.004) / (SETTLE - 0.004)) : y);

// Smooth normals at the points, each the sum of its triangles' (so weighted by their areas), as three's
// computeVertexNormals makes them, but straight over the arrays: through three's attribute accessors this took a
// third of the build.
export function normals(p: Float32Array, index: Uint32Array) {
  const n = new Float32Array(p.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const ex = p[c] - p[b], ey = p[c + 1] - p[b + 1], ez = p[c + 2] - p[b + 2];
    const fx = p[a] - p[b], fy = p[a + 1] - p[b + 1], fz = p[a + 2] - p[b + 2];
    const x = ey * fz - ez * fy, y = ez * fx - ex * fz, z = ex * fy - ey * fx;
    n[a] += x, n[a + 1] += y, n[a + 2] += z;
    n[b] += x, n[b + 1] += y, n[b + 2] += z;
    n[c] += x, n[c + 1] += y, n[c + 2] += z;
  }
  for (let k = 0; k < n.length; k += 3) {
    const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
    n[k] /= l, n[k + 1] /= l, n[k + 2] /= l;
  }
  return n;
}

// The front: each pixel (every `stride`-th, for figures further off) back on its own ray at its distance; smoothed on its
// grid (Taubin: a step in, a step back out, so it does not shrink), never across a step from one layer to another, which
// takes out the little lumps the depth carried without blurring a fold; then made into triangles, except faces the camera
// saw exactly edge-on (they smear when she is turned; taking out more left holes).
export function frontArrays(meta: Meta, grid: Uint16Array, under: Uint8Array | undefined, stride = 1, passes = 4): Arrays {
  const [W0, H0] = meta.size;
  const W = Math.floor(W0 / stride);
  const H = Math.floor(H0 / stride);
  const { K, R, eye } = meta;
  const [r0, r1] = meta.r;
  const dist = new Float32Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const q = grid[j * stride * W0 + i * stride];
      dist[j * W + i] = q ? r0 + ((q - 1) / 65534) * (r1 - r0) : 0;
    }
  // Smoothing the distances along the rays keeps every point on its own ray, so the silhouette stays the photograph's.
  const STEP = 0.02 * stride;
  const tmp = new Float32Array(W * H);
  const pass = (f: number) => {
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const d = dist[k];
        tmp[k] = d;
        if (!d) continue;
        let s = 0;
        let c = 0;
        if (i > 0 && dist[k - 1] && Math.abs(dist[k - 1] - d) < STEP) (s += dist[k - 1]), c++;
        if (i < W - 1 && dist[k + 1] && Math.abs(dist[k + 1] - d) < STEP) (s += dist[k + 1]), c++;
        if (j > 0 && dist[k - W] && Math.abs(dist[k - W] - d) < STEP) (s += dist[k - W]), c++;
        if (j < H - 1 && dist[k + W] && Math.abs(dist[k + W] - d) < STEP) (s += dist[k + W]), c++;
        if (c) tmp[k] = d + f * (s / c - d);
      }
    dist.set(tmp);
  };
  const smooth = meta.clean ? (stride > 1 ? 1 : 0) : passes;
  for (let k = 0; k < smooth; k++) {
    pass(0.5);
    pass(-0.53);
  }
  // Over her head the photograph is nearly featureless and the depth read from it is dented in broad blotches; the folds
  // there all run down from the crown. Smoothed again only up and down there, the blotches go and the folds stay.
  const head = Math.floor(H * 0.42);
  const down = () => {
    for (let j = 1; j < head; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const d = dist[k];
        tmp[k] = d;
        if (!d || !dist[k - W] || !dist[k + W] || Math.abs(dist[k - W] - d) > STEP || Math.abs(dist[k + W] - d) > STEP) continue;
        // Eased off toward the shoulders, so the head's smoothing does not end in a line.
        const f = 0.5 * Math.min(1, (head - j) / (head * 0.25));
        tmp[k] = d + f * ((dist[k - W] + dist[k + W]) / 2 - d);
      }
    for (let j = 1; j < head; j++) for (let i = 0; i < W; i++) dist[j * W + i] = tmp[j * W + i];
  };
  if (!meta.clean) for (let k = 0; k < passes * 4; k++) down();
  // Typed arrays sized for every pixel, filled and then cut to length: growing plain arrays to millions of numbers left
  // so much garbage that collecting it froze the page just as the scene appeared.
  const index = new Int32Array(W * H).fill(-1);
  const p = new Float32Array(W * H * 3);
  const nearAll = new Float32Array(W * H);
  let count = 0;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const r = dist[j * W + i];
      if (!r) continue;
      const x = ((i * stride + 0.5) / W0 - K[0][2]) / K[0][0];
      const y = ((j * stride + 0.5) / H0 - K[1][2]) / K[1][1];
      const n = Math.hypot(x, y, 1);
      // The ray in the camera's frame (x right, y ahead, z up), turned into the levelled world by R.
      const cx = x / n;
      const cy = 1 / n;
      const cz = -y / n;
      const ux = R[0][0] * cx + R[0][1] * cy + R[0][2] * cz;
      const uy = R[1][0] * cx + R[1][1] * cy + R[1][2] * cz;
      const uz = R[2][0] * cx + R[2][1] * cy + R[2][2] * cz;
      index[j * W + i] = count;
      up(eye[0] + ux * r, eye[1] + uy * r, settle(eye[2] + uz * r), p, count * 3);
      nearAll[count] = under ? under[j * stride * W0 + i * stride] / 255 : 0;
      count++;
    }
  const e = [eye[0], eye[2], -eye[1]];
  const tris = new Uint32Array((W - 1) * (H - 1) * 6);
  let t = 0;
  // A cleaned grid keeps its steep faces (the walls of its layer steps): dropped, they left holes the back showed
  // through as rows of dots along the steps.
  const edgeOn = meta.clean ? 0.004 : 0.03;
  const keep = (a: number, b: number, c: number) => {
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
    const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const dx = e[0] - ax, dy = e[1] - ay, dz = e[2] - az;
    return Math.abs(nx * dx + ny * dy + nz * dz) > edgeOn * Math.hypot(nx, ny, nz) * Math.hypot(dx, dy, dz);
  };
  for (let j = 0; j < H - 1; j++)
    for (let i = 0; i < W - 1; i++) {
      const a = index[j * W + i], b = index[(j + 1) * W + i], c = index[(j + 1) * W + i + 1], d = index[j * W + i + 1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      // Split along the shorter diagonal, so a sharp crest runs along triangle edges instead of sawing across them
      // (in polished stone the saw shows as a dotted highlight down every fold).
      const ac = (p[a * 3] - p[c * 3]) ** 2 + (p[a * 3 + 1] - p[c * 3 + 1]) ** 2 + (p[a * 3 + 2] - p[c * 3 + 2]) ** 2;
      const bd = (p[b * 3] - p[d * 3]) ** 2 + (p[b * 3 + 1] - p[d * 3 + 1]) ** 2 + (p[b * 3 + 2] - p[d * 3 + 2]) ** 2;
      if (!meta.clean || ac <= bd) {
        if (keep(a, b, c)) (tris[t++] = a), (tris[t++] = b), (tris[t++] = c);
        if (keep(a, c, d)) (tris[t++] = a), (tris[t++] = c), (tris[t++] = d);
      } else {
        if (keep(a, b, d)) (tris[t++] = a), (tris[t++] = b), (tris[t++] = d);
        if (keep(b, c, d)) (tris[t++] = b), (tris[t++] = c), (tris[t++] = d);
      }
    }
  const position = p.slice(0, count * 3);
  const triangles = tris.slice(0, t);
  return { position, normal: normals(position, triangles), index: triangles, under: nearAll.slice(0, count) };
}

// A packed mesh (Uint32 vertex and index counts, Uint16 xyz quantized to a box, Uint32 indices), settled onto the floor
// like the front: the solid behind her.
export function backArrays(meta: Meta, buffer: ArrayBuffer): Arrays {
  const { lo, hi } = meta.back;
  const [nv, ni] = new Uint32Array(buffer, 0, 2);
  const q = new Uint16Array(buffer, 8, nv * 3);
  // Copied out, as the indices need not start on a four-byte boundary.
  const index = new Uint32Array(buffer.slice(8 + nv * 6, 8 + nv * 6 + ni * 4));
  const p = new Float32Array(nv * 3);
  for (let k = 0; k < nv; k++) {
    const z = lo[2] + (q[k * 3 + 2] / 65535) * (hi[2] - lo[2]);
    up(lo[0] + (q[k * 3] / 65535) * (hi[0] - lo[0]), lo[1] + (q[k * 3 + 1] / 65535) * (hi[1] - lo[1]), settle(z), p, k * 3);
  }
  return { position: p, normal: normals(p, index), index };
}

// Where the cloth reaches the floor it should land and spread, as it does in the photograph, not stop in a ragged edge:
// a skirt of the same cloth round her whole footprint, starting just inside the hem a little off the ground and flaring
// out onto the floor in soft folds, further in some places than others.
export function poolArrays(...parts: Float32Array[]): Arrays {
  const BINS = 160;
  const reach = new Float32Array(BINS);
  let cx = 0;
  let cz = 0;
  let n = 0;
  for (const p of parts)
    for (let k = 0; k < p.length; k += 3)
      if (p[k + 1] < 0.08) {
        cx += p[k];
        cz += p[k + 2];
        n++;
      }
  cx /= n;
  cz /= n;
  for (const p of parts)
    for (let k = 0; k < p.length; k += 3) {
      if (p[k + 1] > 0.08) continue;
      const dx = p[k] - cx;
      const dz = p[k + 2] - cz;
      const b = Math.floor(((Math.atan2(dz, dx) / (Math.PI * 2) + 1) % 1) * BINS);
      reach[b] = Math.max(reach[b], Math.hypot(dx, dz));
    }
  // The footprint's edge, smoothed round, with no empty bins.
  const edge = new Float32Array(BINS);
  for (let b = 0; b < BINS; b++) {
    let s = 0;
    let w = 0;
    for (let d = -6; d <= 6; d++) {
      const r = reach[(b + d + BINS) % BINS];
      if (r > 0) (s += r * (7 - Math.abs(d))), (w += 7 - Math.abs(d));
    }
    edge[b] = w ? s / w : 0.3;
  }
  const RINGS = 24;
  const pos = new Float32Array(BINS * RINGS * 3);
  const index = new Uint32Array(BINS * (RINGS - 1) * 6);
  let t = 0;
  for (let b = 0; b < BINS; b++) {
    const a = (b / BINS) * Math.PI * 2;
    // How far it spreads here, and how deep its folds run.
    const spread = 0.12 + 0.1 * (0.5 + 0.5 * Math.sin(a * 3 + 1.3)) * (0.6 + 0.4 * Math.sin(a * 7 + 0.4));
    for (let r = 0; r < RINGS; r++) {
      const t01 = r / (RINGS - 1);
      const radius = edge[b] - 0.05 + (spread + 0.05) * t01;
      // Falling from the hem to the floor, quickly at first, then lying flat.
      const fall = 0.05 * Math.pow(1 - t01, 2.2);
      const fold = 0.018 * Math.pow(Math.max(0, Math.sin(a * 11 + Math.sin(a * 4) * 2)), 2) * (1 - t01) * (0.4 + t01);
      const k = (b * RINGS + r) * 3;
      pos[k] = cx + Math.cos(a) * radius;
      pos[k + 1] = 0.003 + fall + fold;
      pos[k + 2] = cz + Math.sin(a) * radius;
      if (r < RINGS - 1) {
        const i = b * RINGS + r;
        const j = ((b + 1) % BINS) * RINGS + r;
        index.set([i, j, i + 1, i + 1, j, j + 1], t);
        t += 6;
      }
    }
  }
  return { position: pos, normal: normals(pos, index), index };
}

// What Watchers draws: the near figure's front at full detail, the far ones' coarser, the solid behind, and the hem.
// `light` (a phone): the near one from every other pixel, a quarter of the points (about 300k triangles, not 1.2M); at a
// phone's size its folds and outline look the same.
export type Built = { near: Arrays; far: Arrays; solid: Arrays; hem: Arrays };
export function buildAll(meta: Meta, grid: Uint16Array, solid: ArrayBuffer, under?: Uint8Array, light = false): Built {
  const near = frontArrays(meta, grid, under, light ? 2 : 1, light ? 5 : 10);
  const far = frontArrays(meta, grid, under, 3, 2);
  const back = backArrays(meta, solid);
  return { near, far, solid: back, hem: poolArrays(near.position, back.position) };
}
