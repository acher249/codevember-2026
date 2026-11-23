// The pocket's pastry, built once at load in its own frame: a top sheet puffed up over the filling and a flatter bottom
// sheet, both over the same rings (the outline scaled in toward the middle, finer toward the edge), joined round the
// outside by a soft rounded seam, a little uneven, as a real one is.
// A bite never changes this mesh: the shader cuts it away, so biting costs nothing.

import * as THREE from "three/webgpu";
import { LIP, outline, POCKET, SLEEVE, SLEEVE_INNER_HALF, sleeveInnerTop, squeezeAt, topHeight, bottomHeight } from "./shape";

// Fine enough for the crust's relief to be real displacement: about a millimetre between vertices on High.
const RINGS_FINE = 110;
const AROUND_FINE = 640;

// A point round the outline at s (0 to 1 of the way round), from the middle of the +x end, anticlockwise from above.
function rim(s: number): [number, number] {
  const hx = POCKET.length / 2 - POCKET.corner;
  const hz = POCKET.width / 2 - POCKET.corner;
  const c = POCKET.corner;
  const straightX = 2 * hx;
  const straightZ = 2 * hz;
  const arc = (Math.PI / 2) * c;
  const total = 2 * straightX + 2 * straightZ + 4 * arc;
  let d = (((s % 1) + 1) % 1) * total;
  // Up the +x end from its middle, then round each corner and along each side.
  const legs: [number, (t: number) => [number, number]][] = [
    [hz, (t) => [hx + c, t]],
    [arc, (t) => [hx + c * Math.cos(t / c), hz + c * Math.sin(t / c)]],
    [straightX, (t) => [hx - t, hz + c]],
    [arc, (t) => [-hx - c * Math.sin(t / c), hz + c * Math.cos(t / c)]],
    [straightZ, (t) => [-hx - c, hz - t]],
    [arc, (t) => [-hx - c * Math.cos(t / c), -hz - c * Math.sin(t / c)]],
    [straightX, (t) => [-hx + t, -hz - c]],
    [arc, (t) => [hx + c * Math.sin(t / c), -hz - c * Math.cos(t / c)]],
    [hz, (t) => [hx + c, -hz + t]]
  ];
  for (const [length, at] of legs) {
    if (d <= length) return at(d);
    d -= length;
  }
  return [hx + c, 0];
}

// Smooth value noise in 2D, for the pastry's lumps and blisters.
function noise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const h = (a: number, b: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = h(ix, iy) + (h(ix + 1, iy) - h(ix, iy)) * u;
  const b = h(ix, iy + 1) + (h(ix + 1, iy + 1) - h(ix, iy + 1)) * u;
  return a + (b - a) * v;
}

export function buildPocket(fine: boolean) {
  const RINGS = fine ? RINGS_FINE : 60;
  const AROUND = fine ? AROUND_FINE : 340;
  const positions: number[] = [];
  const index: number[] = [];
  const ring = (k: number) => 1 - Math.pow(1 - k / RINGS, 1.7);
  // The outline is not quite true: it wanders in and out a millimetre or so, as pressed dough does.
  const rims = Array.from({ length: AROUND }, (_, a) => {
    const [x, z] = rim(a / AROUND);
    const len = Math.hypot(x, z) || 1;
    const wander = (noise((a / AROUND) * 40, 3.1) - 0.5) * 0.008 + (noise((a / AROUND) * 140, 7.7) - 0.5) * 0.003;
    return [x + (x / len) * wander, z + (z / len) * wander] as [number, number];
  });

  // A sheet over the rings: top (puffed, crimped at the lip) or bottom. The middle is a single point.
  const sheet = (top: boolean) => {
    const start = positions.length / 3;
    positions.push(0, top ? topHeight(-outline(0, 0), 0, 0) : bottomHeight(-outline(0, 0)), 0);
    for (let k = 1; k <= RINGS; k++) {
      const f = ring(k);
      for (let a = 0; a < AROUND; a++) {
        const x = rims[a][0] * f;
        const z = rims[a][1] * f;
        const depth = Math.max(0, -outline(x, z));
        let y: number;
        if (top) {
          y = topHeight(depth, x, z);
          // Blisters and lumps where it is puffed; on the pressed edge, shallow dents and a gentle waviness.
          const puffed = Math.min(1, depth / 0.05);
          y += puffed * (0.007 * (noise(x * 22, z * 22) - 0.5) + 0.003 * (noise(x * 60 + 9, z * 60) - 0.5));
          // The seam is soft and rounded, a little uneven along its length.
          if (depth < LIP) y += (1 - depth / LIP) * 0.002 * (noise((a / AROUND) * 30, 1.3) - 0.5);
        } else y = bottomHeight(depth);
        positions.push(x, y, z);
      }
    }
    // The middle fan, then quads between rings.
    for (let a = 0; a < AROUND; a++) {
      const b = (a + 1) % AROUND;
      if (top) index.push(start, start + 1 + b, start + 1 + a);
      else index.push(start, start + 1 + a, start + 1 + b);
    }
    for (let k = 1; k < RINGS; k++) {
      const r0 = start + 1 + (k - 1) * AROUND;
      const r1 = start + 1 + k * AROUND;
      for (let a = 0; a < AROUND; a++) {
        const b = (a + 1) % AROUND;
        if (top) index.push(r0 + a, r0 + b, r1 + a, r0 + b, r1 + b, r1 + a);
        else index.push(r0 + a, r1 + a, r0 + b, r0 + b, r1 + a, r1 + b);
      }
    }
    return start + 1 + (RINGS - 1) * AROUND;
  };
  const topEdge = sheet(true);
  const bottomEdge = sheet(false);

  // The lip's rounded outer edge, from the top sheet's last ring out and down round to the bottom's.
  const LIP_STEPS = 5;
  const lipStart = positions.length / 3;
  for (let step = 1; step < LIP_STEPS; step++) {
    const t = step / LIP_STEPS;
    for (let a = 0; a < AROUND; a++) {
      const ti = topEdge + a;
      const bi = bottomEdge + a;
      const tx = positions[ti * 3];
      const ty = positions[ti * 3 + 1];
      const tz = positions[ti * 3 + 2];
      const by = positions[bi * 3 + 1];
      // Out a little past the outline, most at the middle of the edge.
      const bulge = Math.sin(t * Math.PI) * 0.008;
      const len = Math.hypot(tx, tz) || 1;
      positions.push(tx + (tx / len) * bulge, ty + (by - ty) * t, tz + (tz / len) * bulge);
    }
  }
  const lipRow = (step: number) => (step === 0 ? topEdge : step === LIP_STEPS ? bottomEdge : lipStart + (step - 1) * AROUND);
  for (let step = 0; step < LIP_STEPS; step++) {
    const r0 = lipRow(step);
    const r1 = lipRow(step + 1);
    for (let a = 0; a < AROUND; a++) {
      const b = (a + 1) % AROUND;
      index.push(r0 + a, r0 + b, r1 + a, r0 + b, r1 + b, r1 + a);
    }
  }

  // Inside the sleeve the pastry is squeezed to fit it: never above the sleeve's inner top or past its inner sides,
  // never through its floor, easing back to its own shape just past the mouth.
  for (let k = 0; k < positions.length; k += 3) {
    const x = positions[k];
    const hold = squeezeAt(x);
    if (hold <= 0) continue;
    const z = positions[k + 2];
    const zMax = SLEEVE_INNER_HALF - 0.0015;
    positions[k + 2] = z + (Math.max(-zMax, Math.min(zMax, z)) - z) * hold;
    const y = positions[k + 1];
    const yMax = sleeveInnerTop(positions[k + 2]) - 0.0015;
    const yMin = SLEEVE.board + 0.0006;
    positions[k + 1] = y + (Math.max(yMin, Math.min(yMax, y)) - y) * hold;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  // The crust's textures lie over the pocket from above: u along its length, v across.
  const uvs: number[] = [];
  for (let k = 0; k < positions.length; k += 3) uvs.push(positions[k] / POCKET.length + 0.5, positions[k + 2] / POCKET.width + 0.5);
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return { geometry };
}
