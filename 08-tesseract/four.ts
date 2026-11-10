import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { orbitPoint } from "../shared/engine/controls";
import { focusBlur, focusDistance } from "../shared/engine/Post";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const AXES = 4;
const step = new THREE.Matrix4();

function turnIn(out: THREE.Matrix4, a: number, b: number, angle: number) {
  step.identity();
  const e = step.elements;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  e[a * 5] = c;
  e[b * 5] = c;
  e[b * 4 + a] = -s;
  e[a * 4 + b] = s;
  out.multiply(step);
}

const ease = (t: number) => t * t * (3 - 2 * t);

// A 4D orientation that can turn inside out and yet stays on screen. Stereographic projection only runs off to infinity when an edge
// reaches its pole. Starting with the pole at a cell's centre and turning in one plane carries it through the centre of a square face
// to the next cell's centre, and that path never comes within 35 degrees of an edge. So: one plane at a time, a rest at each cell,
// then a new plane. The tumble only turns X, Y and Z, which leaves the pole alone.
export class Turning {
  matrix = uniform(new THREE.Matrix4()) as any;
  settled = new THREE.Matrix4();
  from = 3;
  to = 0;
  progress = 0;
  push = 0;
  tumble = [0.4, 0.2, 0.3];
  // How fast each tumble is going, and the new whim it is easing towards.
  rates = [0.1, -0.06, 0.05];
  whims = [0.1, -0.06, 0.05];
  nextWhim = 2;
  // Turns towards the pointer. Plain 3D, so like the tumble it leaves the pole alone.
  lean = [0, 0];

  update(delta: number, speed: number) {
    this.progress += (0.085 * speed + this.push) * delta;
    this.push *= Math.exp(-delta * 1.1);
    this.nextWhim -= delta;
    if (this.nextWhim <= 0) {
      this.nextWhim = 2.5 + Math.random() * 4;
      this.whims = this.whims.map(() => (Math.random() * 2 - 1) * 0.3);
    }
    const settle = 1 - Math.exp(-delta * 0.7);
    for (let i = 0; i < 3; i++) {
      this.rates[i] += (this.whims[i] - this.rates[i]) * settle;
      this.tumble[i] += this.rates[i] * speed * delta;
    }
    if (Math.abs(this.progress) >= 1) {
      const direction = Math.sign(this.progress);
      const done = new THREE.Matrix4();
      turnIn(done, this.from, this.to, (direction * Math.PI) / 2);
      // The new cell is exact: no rounding error builds up to walk the pole towards an edge.
      for (let i = 0; i < 16; i++) done.elements[i] = Math.round(done.elements[i]);
      this.settled.premultiply(done);
      this.from = this.to;
      do this.to = Math.floor(Math.random() * AXES);
      while (this.to === this.from);
      this.progress -= direction;
    }
    const out = this.matrix.value as THREE.Matrix4;
    out.identity();
    turnIn(out, this.from, this.to, Math.sign(this.progress) * ease(Math.abs(this.progress)) * (Math.PI / 2));
    out.multiply(this.settled);
    turnIn(out, 0, 1, this.tumble[0]);
    turnIn(out, 0, 2, this.tumble[1]);
    turnIn(out, 1, 2, this.tumble[2]);
    turnIn(out, 0, 2, this.lean[0]);
    turnIn(out, 1, 2, this.lean[1]);
  }
}

// Each study frames itself when it opens. The rig may not be up on the first frame, so this waits for it.
export function useStudyView(position: [number, number, number], target: [number, number, number]) {
  const camera = useThree((state) => state.camera);
  const placed = useRef(false);
  useFrame(() => {
    if (placed.current || !orbitPoint.current) return;
    placed.current = true;
    // A tall screen sees less across, so it stands further back.
    const back = Math.max(1, 1.2 / (camera as THREE.PerspectiveCamera).aspect);
    camera.position.set(target[0] + (position[0] - target[0]) * back, target[1] + (position[1] - target[1]) * back, target[2] + (position[2] - target[2]) * back);
    orbitPoint.current.set(...target);
  });
}

// Keeps the lens on the front of the shape, so its far side falls out of focus.
export function useLens(forward: number) {
  const camera = useThree((state) => state.camera);
  useFrame(() => {
    if (orbitPoint.current) focusDistance.value = Math.max(0.5, camera.position.distanceTo(orbitPoint.current) - forward);
    focusBlur.value = 0.8;
  });
}

const hoverRight = new THREE.Vector3();
const hoverUp = new THREE.Vector3();
const hoverBack = new THREE.Vector3();

// The camera drifts as if handheld. It moves by the change in a slow wobble rather than to a fixed spot, so orbiting and zooming still work.
export function useHover() {
  const camera = useThree((state) => state.camera);
  const last = useRef({ x: 0, y: 0, z: 0, t: 0 });
  const still = useRef(false);
  useEffect(() => {
    still.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);
  useFrame((_, delta) => {
    if (still.current || !orbitPoint.current) return;
    const state = last.current;
    state.t += Math.min(delta, 0.05);
    const t = state.t;
    const reach = camera.position.distanceTo(orbitPoint.current);
    const x = (Math.sin(t * 0.37) + Math.sin(t * 0.61 + 1.3) * 0.5) * reach * 0.045;
    const y = (Math.sin(t * 0.29 + 2.1) + Math.sin(t * 0.53) * 0.5) * reach * 0.032;
    const z = Math.sin(t * 0.23 + 0.7) * reach * 0.03;
    hoverRight.setFromMatrixColumn(camera.matrixWorld, 0);
    hoverUp.setFromMatrixColumn(camera.matrixWorld, 1);
    hoverBack.setFromMatrixColumn(camera.matrixWorld, 2);
    // Straight above or below the shape, the smallest sideways move is a huge turn around the vertical, and the view spins wildly. So it fades out there.
    const side = Math.hypot(camera.position.x - orbitPoint.current.x, camera.position.z - orbitPoint.current.z) / reach;
    const calm = Math.min(1, side / 0.25) ** 2;
    camera.position.addScaledVector(hoverRight, (x - state.x) * calm).addScaledVector(hoverUp, (y - state.y) * calm).addScaledVector(hoverBack, (z - state.z) * calm);
    state.x = x;
    state.y = y;
    state.z = z;
  });
}
