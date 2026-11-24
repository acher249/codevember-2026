// The egg's shape, in centimetres, its front to +z, its top to +y. Two moulded halves meet at a seam round the outline:
// each is a height field over the egg's outline, rounding over to meet the other edge-on. The front's is cut into: a
// flat-floored window for the screen with a soft bevelled wall and a little raised lip, and a socket for each button.
// Built once at load. The grid is a square pulled round into the outline (no point at the middle where rows crowd in),
// and drawn in close at the rim, where the surface turns over fast.

import * as THREE from "three/webgpu";
import { SCREEN } from "./lcd";

export const HALF_W = 2.4;
export const HALF_H = 2.85;
// How far each half bulges from the seam, and how square its rounding is (higher is flatter faced).
const FRONT = { depth: 1.05, power: 3.4 };
const BACK = { depth: 1.3, power: 2.5 };
// Each half stops this far short of the seam's middle; the seam band fills the gap a little inside it.
const LIP = 0.035;

export const BUTTONS = [
  { x: -1.08, y: -1.42 },
  { x: 0, y: -1.64 },
  { x: 1.08, y: -1.42 }
];
export const BUTTON_R = 0.4;
const SOCKET_R = 0.49;
const SOCKET_DEPTH = 0.13;
// On the back (as x, y on the shell, not mirrored): the battery door and the reset pin.
export const BATTERY = { x: 0, y: -0.75, w: 2.1, h: 1.5 };
export const PIN = { x: 1.15, y: 0.35 };
// The tab leaves through the seam low on the right, from the battery behind: the angle round the outline, and how far
// behind the seam it runs.
export const TAB = { angle: -1.13, z: -0.12 };

// Half the egg's width at height y: an egg, narrower to the top.
export const halfWidth = (v: number) => HALF_W * Math.sqrt(Math.max(0, 1 - v * v)) * (1 - 0.1 * v);

// How far out toward the outline (0 middle, 1 rim) a point on the shell's face is.
export function rim(x: number, y: number) {
  const v = y / HALF_H;
  const u = x / (HALF_W * (1 - 0.1 * v));
  return Math.hypot(u, v);
}

const dome = (r: number, d: number, p: number) => LIP + (d - LIP) * Math.pow(Math.max(0, 1 - Math.pow(Math.min(r, 1), p)), 1 / p);
export const frontDome = (x: number, y: number) => dome(rim(x, y), FRONT.depth, FRONT.power);
// The reset pin's hole, on the back's surface.
export const BACK_PIN = new THREE.Vector3(PIN.x, PIN.y, -dome(rim(PIN.x, PIN.y), BACK.depth, BACK.power));

// The screen window as a rounded rectangle: negative inside.
const windowSdf = (x: number, y: number) => {
  const qx = Math.abs(x) - (SCREEN.w / 2 - SCREEN.corner);
  const qy = Math.abs(y - SCREEN.y) - (SCREEN.h / 2 - SCREEN.corner);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - SCREEN.corner;
};

// The window's floor: flat, a little below the lowest the face comes to round it.
export const SCREEN_Z = (() => {
  let lowest = Infinity;
  for (let k = 0; k < 400; k++) {
    const a = (k / 400) * Math.PI * 2;
    const x = Math.cos(a) * (SCREEN.w / 2 + 0.12);
    const y = SCREEN.y + Math.sin(a) * (SCREEN.h / 2 + 0.12);
    lowest = Math.min(lowest, frontDome(Math.sign(x) * Math.min(Math.abs(x), SCREEN.w / 2 + 0.12), y));
  }
  return lowest - 0.09;
})();

// Each button's socket floor, flat at a set depth under the face at its middle.
export const SOCKET_Z = BUTTONS.map((b) => frontDome(b.x, b.y) - SOCKET_DEPTH);

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function frontHeight(x: number, y: number, r: number) {
  let z = dome(r, FRONT.depth, FRONT.power);
  // A raised lip round the window, then the bevelled wall down to its floor.
  const s = windowSdf(x, y);
  z += 0.035 * smooth(0.0, 0.07, s) * (1 - smooth(0.1, 0.3, s));
  z += (SCREEN_Z - z) * (1 - smooth(-0.05, 0.09, s));
  BUTTONS.forEach((b, k) => {
    const d = Math.hypot(x - b.x, y - b.y);
    z += (SOCKET_Z[k] - z) * (1 - smooth(SOCKET_R - 0.07, SOCKET_R, d));
  });
  return z;
}

// A point on the outline at an angle, and the outward direction there.
export function outline(a: number) {
  const v = Math.sin(a);
  const w = halfWidth(v);
  const dw = (halfWidth(v + 1e-4) - halfWidth(v - 1e-4)) / 2e-4;
  const tx = -Math.sin(a) * w + Math.cos(a) * Math.cos(a) * dw;
  const ty = Math.cos(a) * HALF_H;
  const len = Math.hypot(tx, ty) || 1;
  return { x: Math.cos(a) * w, y: v * HALF_H, nx: ty / len, ny: -tx / len };
}

// One half as a grid of n × n squares, pulled round into the outline.
export function shellHalf(front: boolean, n = 360) {
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const s = (i / n) * 2 - 1;
      const t = (j / n) * 2 - 1;
      // Square to disc, then drawn in toward the rim.
      let a = s * Math.sqrt(1 - (t * t) / 2);
      let b = t * Math.sqrt(1 - (s * s) / 2);
      const r = Math.hypot(a, b);
      const pulled = Math.sin((r * Math.PI) / 2);
      if (r > 1e-9) {
        a *= pulled / r;
        b *= pulled / r;
      }
      const y = b * HALF_H;
      const x = a * HALF_W * (1 - 0.1 * b);
      const z = front ? frontHeight(x, y, pulled) : -dome(pulled, BACK.depth, BACK.power);
      positions.set([x, y, z], (j * (n + 1) + i) * 3);
    }
  const index: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      // Counter-clockwise seen from outside: from +z for the front, from -z for the back.
      if (front) index.push(a, b, d, a, d, c);
      else index.push(a, d, b, a, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// The seam: a dark band a little inside the outline, filling the gap where the halves meet.
export function seam(n = 360) {
  const positions: number[] = [];
  const normals: number[] = [];
  const index: number[] = [];
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * Math.PI * 2;
    const v = Math.sin(a);
    const x = Math.cos(a) * halfWidth(v) * 0.994;
    const y = v * HALF_H * 0.994;
    // Outward, square to the outline.
    const dv = Math.cos(a);
    const tx = -Math.sin(a) * halfWidth(v) + Math.cos(a) * ((halfWidth(v + 1e-4) - halfWidth(v - 1e-4)) / 2e-4) * dv;
    const ty = dv * HALF_H;
    const len = Math.hypot(tx, ty) || 1;
    for (const z of [-LIP * 1.6, LIP * 1.6]) {
      positions.push(x, y, z);
      normals.push(ty / len, -tx / len, 0);
    }
    if (k < n) {
      const i = k * 2;
      index.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(index);
  return g;
}

// A button cap: a chunky round button, domed and soft-edged, standing up out of its socket along +z.
export function buttonCap() {
  const points: THREE.Vector2[] = [];
  const height = 0.37;
  points.push(new THREE.Vector2(BUTTON_R * 0.97, -0.05));
  points.push(new THREE.Vector2(BUTTON_R, 0.02));
  for (let k = 0; k <= 12; k++) {
    // A quarter round at the edge, then a low dome over the top.
    const a = (k / 12) * (Math.PI / 2);
    points.push(new THREE.Vector2(BUTTON_R - 0.09 + Math.cos(a) * 0.09, height - 0.11 + Math.sin(a) * 0.09));
  }
  for (let k = 1; k <= 10; k++) {
    const r = (BUTTON_R - 0.09) * (1 - k / 10);
    points.push(new THREE.Vector2(Math.max(r, 0.0001), height - 0.02 + 0.03 * (1 - (r / (BUTTON_R - 0.09)) ** 2)));
  }
  const g = new THREE.LatheGeometry(points, 64);
  // The lathe turns about y; the button stands along z.
  g.rotateX(Math.PI / 2);
  return g;
}

// The tab: a strip of film, rounded at its free end, its length along +y from the slot.
export const TAB_SIZE = { w: 0.72, out: 2.3, inside: 0.7, thick: 0.022 };
export function tabStrip() {
  const { w, out, inside } = TAB_SIZE;
  const shape = new THREE.Shape();
  const r = w / 2;
  shape.moveTo(-r, -inside);
  shape.lineTo(r, -inside);
  shape.lineTo(r, out - r);
  shape.absarc(0, out - r, r, 0, Math.PI, false);
  shape.lineTo(-r, -inside);
  const g = new THREE.ExtrudeGeometry(shape, { depth: TAB_SIZE.thick, bevelEnabled: false, curveSegments: 24 });
  g.translate(0, 0, -TAB_SIZE.thick / 2);
  return g;
}
