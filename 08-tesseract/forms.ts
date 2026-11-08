import * as THREE from "three/webgpu";
import { uniform, uniformArray } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

export type FormName = "one" | "rings" | "heart" | "urchin";

// Forms made of metaballs: how many balls, how big the ones on the joints and the ones running along the bars are, how far they flow into
// each other, and how much the whole mass swells. Thorns are ferrofluid's needles standing out along a magnetic field: how many around a
// face of the field, and how tall.
export type Goo = { balls: number; joint: number; runner: [number, number]; flow: number; swell: number; thorn?: { cells: number; height: number } };
const GOOS: Partial<Record<FormName, Goo>> = {
  urchin: { balls: 16, joint: 0.62, runner: [0, 0], flow: 1.5, swell: 0.03, thorn: { cells: 12, height: 0.6 } }
};
export const gooOf = (form: FormName) => GOOS[form];

export const JOINTS = 16;
// The size the tubes were tuned at.
export const TUNED_SIZE = 1.5;
// The gap each bar stops short of a joint by, which grows further out where the bars are longer. Whatever sits at the joint is sized to float inside it.
export const GAP = 0.36;
export const GAP_GROWTH = 0.6;

const CORNERS = Array.from({ length: JOINTS }, (_, i) => new THREE.Vector4(i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5, i & 8 ? 0.5 : -0.5));
const inverse = new THREE.Matrix4();
const corner = new THREE.Vector4();

// Every joint is a corner of the tesseract, so its place comes from undoing the turn and then projecting it down. Returns r², which sets how big things are out there.
function jointAt(index: number, turn: THREE.Matrix4, size: number, out: THREE.Vector3) {
  corner.copy(CORNERS[index]).applyMatrix4(inverse.copy(turn).transpose());
  const fall = 1 / (1 - corner.w);
  out.set(corner.x * fall, corner.y * fall, corner.z * fall);
  const r2 = out.lengthSq();
  out.multiplyScalar(size);
  return r2;
}

const spot = new THREE.Vector3();
const spun = new THREE.Vector3();
const UPISH = new THREE.Vector3(0.2, 1, 0.35).normalize();

// What moves besides the tesseract itself. Worked out here once a frame, and handed to the shader.
export class Parts {
  form: FormName;
  // xyz is the joint and w the radius of its outermost ring.
  rings: THREE.Vector4[] = [];
  // Each joint has two rings at right angles, like a gyroscope.
  axes: THREE.Vector3[] = [];
  ringsNode: any;
  axesNode: any;
  balls: THREE.Vector4[] = [];
  ballsNode: any;
  clock = Math.random() * 40;
  // The fractal at the heart: its power, and how far it has turned.
  power = uniform(7) as any;
  turn = uniform(new THREE.Vector2(1, 0)) as any;

  constructor(form: FormName) {
    this.form = form;
    const goo = GOOS[form];
    if (goo) {
      for (let i = 0; i < goo.balls; i++) this.balls.push(new THREE.Vector4());
      this.ballsNode = uniformArray(this.balls);
    }
    if (form !== "rings") return;
    for (let i = 0; i < JOINTS; i++) {
      this.rings.push(new THREE.Vector4());
      this.axes.push(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0));
    }
    this.ringsNode = uniformArray(this.rings);
    this.axesNode = uniformArray(this.axes);
  }

  update(delta: number, speed: number, size: number, main: THREE.Matrix4) {
    this.clock += delta * speed;
    const clock = this.clock;
    if (this.form === "heart") {
      this.power.value = 7 + 1.6 * Math.sin(clock * 0.09);
      this.turn.value.set(Math.cos(clock * 0.07), Math.sin(clock * 0.07));
    }
    const grow = size / TUNED_SIZE;
    const goo = GOOS[this.form];
    if (goo) {
      // One ball on every joint, and the rest running up and down the bars.
      for (let i = 0; i < JOINTS; i++) {
        const r2 = jointAt(i, main, size, spot);
        this.balls[i].set(spot.x, spot.y, spot.z, goo.joint * Math.pow(1 + r2, 0.35) * grow);
      }
      for (let i = JOINTS; i < goo.balls; i++) {
        // From a joint to a neighbour, which differs from it along exactly one axis.
        const from = this.balls[i % JOINTS];
        const to = this.balls[(i % JOINTS) ^ (1 << (i % 4))];
        const along = 0.5 + 0.5 * Math.sin(clock * (0.5 + (i % 7) * 0.07) + i * 1.9);
        const pulse = 0.5 + 0.5 * Math.sin(clock * 0.8 + i * 2.7);
        this.balls[i].set(from.x + (to.x - from.x) * along, from.y + (to.y - from.y) * along, from.z + (to.z - from.z) * along, (goo.runner[0] + goo.runner[1] * pulse) * grow);
      }
    }
    for (let i = 0; i < this.rings.length; i++) {
      const r2 = jointAt(i, main, size, spot);
      this.rings[i].set(spot.x, spot.y, spot.z, (GAP / 1.2) * Math.pow(1 + r2, GAP_GROWTH) * grow);
      const a = i * 2.4 + clock * 0.55;
      const b = i * 1.1 + clock * 0.3;
      spun.set(Math.cos(a), Math.sin(a) * Math.cos(b), Math.sin(a) * Math.sin(b));
      this.axes[i * 2].copy(spun);
      this.axes[i * 2 + 1].crossVectors(spun, UPISH).normalize();
    }
  }
}
