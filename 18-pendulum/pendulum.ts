import * as THREE from "three/webgpu";
import type { StreamPaint } from "./brush-colors";

// The swing and the paint that falls from it, worked out on the processor.
//
// The can hangs from a rope tied to a beam overhead: a spherical pendulum, the rope's end kept on a sphere round the
// pivot each step, so a push sideways makes an ellipse that turns slowly about itself and shrinks as the air slows it, the
// way a real one draws a spirograph. Paint runs from a hole in the can's base by Torricelli's law, faster the fuller the
// can, falling as a stream of small parcels each carrying its share of the flow; a parcel keeps the can's speed as it
// leaves and falls freely, so the stream curves behind a swinging can, thins as it stretches and lands where the paint
// really would.

// The canvas, and the pivot hanging over its middle.
export const CANVAS = 1.4;
// It stands on a turntable, its face about four inches (10 cm) up, so it can turn and has an edge to drip from.
export const FACE = 0.124;
// The stretcher's depth, and how high the turntable stands under it.
export const STRETCHER = 0.022;
export const STAND = FACE - STRETCHER;
export const PIVOT = new THREE.Vector3(0, 2.75, 0);
// The rope, from the pivot to the can's bail; the can below it, and the hole in its base.
export const ROPE = 2.06;
export const CAN = { radius: 0.085, height: 0.19, bail: 0.04 };

// What hangs: a paint can with one hole in the middle of its base, or a wide plastic bucket with three or five holes
// round its base, which flings out as many streams when it spins. Each hole is the size of the can's. Or the three-hole
// bucket with one long thin slot across its base instead, like the outline of a pencil, slot metres long: it pours a
// sheet, share times a round hole's flow, falling as a flat ribbon and laying a band as wide as the slot, turned as
// the bucket is. A divided pail keeps two colours in separate chambers, each with its own outlet; fine variations
// share each outlet's flow like neighbouring brush filaments.
export type VesselName = "can" | "three" | "five" | "slot" | "divided";
export type Vessel = { top: number; bottom: number; height: number; bail: number; holes: number; ring: number; slot?: number; share?: number; partition?: boolean; inward?: number };
export const VESSELS: Record<VesselName, Vessel> = {
  can: { top: CAN.radius, bottom: CAN.radius, height: CAN.height, bail: CAN.bail, holes: 1, ring: 0 },
  three: { top: 0.15, bottom: 0.13, height: 0.24, bail: 0.08, holes: 3, ring: 0.085 },
  five: { top: 0.19, bottom: 0.165, height: 0.305, bail: 0.1, holes: 5, ring: 0.108 },
  slot: { top: 0.15, bottom: 0.13, height: 0.24, bail: 0.08, holes: 1, ring: 0, slot: 0.12, share: 4 },
  // Twenty millimetres between openings, each drilled three degrees toward the other.
  divided: { top: 0.15, bottom: 0.13, height: 0.24, bail: 0.08, holes: 2, ring: 0.01, partition: true, inward: Math.PI / 60 }
};
// The five-hole bucket is the three-hole one made bigger, every measure by the same amount.
export const BIGGER = VESSELS.five.top / VESSELS.three.top;

// The swing is done once it would only go on drawing smaller and smaller rings on top of each other: when it reaches
// no further out than this, the paint stops before it builds a heap in the middle.
const DONE = 0.14;
const G = 9.81;
const STEP = 1 / 240;

// axis: for the slot, half the sheet's width along it, the way the slot lay when the paint left it (else zero).
export type Parcel = { p: THREE.Vector3; v: THREE.Vector3; volume: number; born: number; alive: boolean; stream: number; layout: number; axis: THREE.Vector3; colour: string; paint?: StreamPaint };
export type Landing = { x: number; z: number; volume: number; vx: number; vz: number; ax: number; az: number; floor: boolean; colour: string; paint?: StreamPaint };

// How far round the canvas the floor's paint is simulated, a square this wide.
export const FLOOR = 5;

export class Pendulum {
  readonly pivot: THREE.Vector3;
  // The rope's end (the can's bail), and its speed.
  end = new THREE.Vector3();
  velocity = new THREE.Vector3();
  held = false;
  // Paint keeps the colour it had when it left the vessel, even if the vessel is refilled mid-flight.
  colour = "#2450b8";
  secondaryColour = "#f1ca35";
  // Immutable paint variants, one row for each physical outlet of the divided bucket.
  outletPaints: readonly (readonly StreamPaint[])[] | null = null;
  // How full the can is, 0 to 1, and how freely paint runs: the hole's size as an area in square metres.
  level = 1;
  hole = 2.2e-5;
  vessel: Vessel = VESSELS.can;
  // How far the vessel has turned about the rope, and how fast it turns (radians a second).
  turn = 0;
  spin = 0;
  // The canvas on its turntable: how far round it has gone, and how fast it turns (radians a second).
  canvasTurn = 0;
  canvasSpin = 0;
  // Stopped pouring because the swing has died down; a new throw starts it again.
  finished = false;
  // Waiting for its first toss: it sways gently with a thumb over the hole, and nothing pours until it is thrown.
  waiting = true;
  // Paused by the visitor: a thumb over the hole while it goes on swinging.
  paused = false;
  // Where the hand is drawing the can to while it is held.
  target = new THREE.Vector3();
  // How quickly the air slows the swing, per second.
  drag = 0.035;
  // The stream: parcels in flight, oldest first, in a ring.
  parcels: Parcel[] = [];
  landings: Landing[] = [];
  time = 0;
  private carry = 0;
  private sinceParcel = 0;
  // How the can was moving while held, for the throw when let go.
  private trail: { t: number; p: THREE.Vector3 }[] = [];

  constructor(capacity = 2600, pivot = PIVOT) {
    this.pivot = pivot.clone();
    this.end.copy(this.pivot).add(new THREE.Vector3(0, -ROPE, 0));
    for (let i = 0; i < capacity; i++) this.parcels.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), volume: 0, born: 0, alive: false, stream: 0, layout: 0, axis: new THREE.Vector3(), colour: this.colour });
  }

  // From the rope's end down to the base.
  get drop() {
    return this.vessel.bail + this.vessel.height;
  }

  // The middle of the base: straight on down the rope's line from its end.
  nozzle(out: THREE.Vector3) {
    return out.subVectors(this.end, this.pivot).normalize().multiplyScalar(this.drop).add(this.end);
  }

  // The vessel's own axes as it hangs and turns: y up the rope, x and z across its base.
  frame(x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3) {
    y.subVectors(this.pivot, this.end).normalize();
    const e1 = scratch.g.crossVectors(y, Z).normalize();
    const e2 = scratch.h.crossVectors(y, e1);
    x.copy(e1).multiplyScalar(Math.cos(this.turn)).addScaledVector(e2, Math.sin(this.turn));
    z.crossVectors(x, y);
  }

  // Hole k in the base, in the world.
  holeAt(k: number, out: THREE.Vector3) {
    const { x, y, z } = axes;
    this.frame(x, y, z);
    const a = (k / this.vessel.holes) * Math.PI * 2;
    return this.nozzle(out).addScaledVector(x, Math.cos(a) * this.vessel.ring).addScaledVector(z, Math.sin(a) * this.vessel.ring);
  }

  private filamentCount(outlet: number) {
    return this.vessel.partition && this.outletPaints?.[outlet]?.length === 3 ? 3 : 1;
  }

  // Each divided outlet has a stable three-ID block; its filaments sit inside the same physical opening.
  streamAt(stream: number, out: THREE.Vector3) {
    if (!this.vessel.partition) return this.holeAt(stream, out);
    const outlet = Math.floor(stream / 3);
    this.holeAt(outlet, out);
    if (this.filamentCount(outlet) === 3) out.addScaledVector(axes.z, (stream % 3 - 1) * 0.003);
    return out;
  }

  private layoutVessel: Vessel | null = null;
  private layoutFilaments = -1;
  private layoutVersion = 0;
  get streamLayout() {
    const filaments = this.vessel.partition ? (this.filamentCount(0) === 3 ? 1 : 0) | (this.filamentCount(1) === 3 ? 2 : 0) : 0;
    if (this.layoutVessel !== this.vessel || this.layoutFilaments !== filaments) {
      this.layoutVessel = this.vessel;
      this.layoutFilaments = filaments;
      this.layoutVersion++;
    }
    return this.layoutVersion;
  }

  // A stream still falling from an old vessel must not be drawn back up to a newly configured opening.
  streamMatches(parcel: Parcel) {
    return parcel.layout === this.streamLayout;
  }

  // How far out the swing would reach now, from where it is and how fast it goes, as for a simple pendulum.
  get reach() {
    const x = this.end.x - this.pivot.x;
    const z = this.end.z - this.pivot.z;
    const v2 = this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    return Math.sqrt(x * x + z * z + (v2 * ROPE) / G);
  }

  // Held: the can goes where the hand puts it, on the rope's sphere, never more than about 55 degrees out.
  hold(toward: THREE.Vector3) {
    const d = scratch.a.subVectors(toward, this.pivot);
    if (d.y > -0.2) d.y = -0.2;
    d.normalize();
    const most = Math.cos(THREE.MathUtils.degToRad(55));
    if (-d.y < most) {
      const flat = Math.hypot(d.x, d.z) || 1;
      const s = Math.sqrt(1 - most * most) / flat;
      d.set(d.x * s, -most, d.z * s);
    }
    // Only where the hand wants it: the can eases there each step (below), so it never jumps.
    this.target.copy(this.pivot).addScaledVector(d, ROPE);
  }

  // Let go: off with whatever speed the hand was giving it, tangent to the sphere, held to a sensible most.
  release() {
    this.held = false;
    this.finished = false;
    const first = this.trail[0];
    const last = this.trail[this.trail.length - 1];
    if (first && last && last.t > first.t) {
      this.velocity.subVectors(last.p, first.p).divideScalar(last.t - first.t);
      const radial = scratch.a.subVectors(this.end, this.pivot).normalize();
      this.velocity.addScaledVector(radial, -this.velocity.dot(radial));
      const speed = this.velocity.length();
      if (speed > 3.2) this.velocity.multiplyScalar(3.2 / speed);
    }
    this.trail.length = 0;
    // Only a real toss starts the paint: let go with barely a swing and it goes back to waiting.
    this.waiting = this.reach < DONE;
    return !this.waiting;
  }

  // A repeatable throw, with horizontal offsets from this vessel's own pivot and a tangential push.
  launch(x: number, z: number, vx: number, vz: number) {
    const radial = scratch.a.set(x, 0, z);
    const most = ROPE * Math.sin(THREE.MathUtils.degToRad(55));
    if (radial.length() > most) radial.setLength(most);
    radial.y = -Math.sqrt(ROPE * ROPE - radial.lengthSq());
    this.end.copy(this.pivot).add(radial);
    radial.normalize();
    this.velocity.set(vx, 0, vz).addScaledVector(radial, -(vx * radial.x + vz * radial.z));
    this.target.copy(this.end);
    for (const parcel of this.parcels) parcel.alive = false;
    this.landings.length = 0;
    this.trail.length = 0;
    this.carry = 0;
    this.sinceParcel = 0;
    this.cursor = 0;
    this.time = 0;
    this.turn = 0;
    this.level = 1;
    this.held = this.waiting = this.finished = this.paused = false;
  }

  // Back to waiting: a small, slow sway, a little out of round so it reads as alive, kept going without losing height.
  // Paint still falling is gone too, so none lands on a fresh canvas.
  rest() {
    for (const parcel of this.parcels) parcel.alive = false;
    this.waiting = true;
    this.finished = false;
    this.held = false;
    const out = scratch.a.set(0.07, 0, 0);
    out.y = -Math.sqrt(ROPE * ROPE - out.x * out.x);
    this.end.copy(this.pivot).add(out);
    this.velocity.set(0, 0, 0.07 * Math.sqrt(G / ROPE) * 0.55);
  }

  grab() {
    this.held = true;
    this.trail.length = 0;
    this.target.copy(this.end);
  }

  // One step of the swing, as a free spherical pendulum: gravity and the air's drag, then back onto the sphere, the
  // speed along the rope taken away.
  private swing(dt: number, end = this.end, velocity = this.velocity) {
    velocity.y -= G * dt;
    if (!this.waiting) velocity.multiplyScalar(1 - this.drag * dt);
    end.addScaledVector(velocity, dt);
    const r = scratch.b.subVectors(end, this.pivot);
    r.multiplyScalar(ROPE / r.length());
    end.copy(this.pivot).add(r);
    r.normalize();
    velocity.addScaledVector(r, -velocity.dot(r));
  }

  // Where the hole will pass over the canvas in the next few seconds, if let go now with this throw: for the aim line.
  predict(seconds: number, every: number, out: THREE.Vector3[]) {
    const end = scratch.c.copy(this.end);
    const velocity = scratch.d.set(0, 0, 0);
    const first = this.trail[0];
    const last = this.trail[this.trail.length - 1];
    if (first && last && last.t > first.t) velocity.subVectors(last.p, first.p).divideScalar(last.t - first.t);
    let n = 0;
    const steps = Math.round(seconds / STEP);
    for (let k = 0; k < steps && n < out.length; k++) {
      this.swing(STEP, end, velocity);
      if (k % every === 0) {
        out[n++].subVectors(end, this.pivot).normalize().multiplyScalar(this.drop).add(end);
      }
    }
    return n;
  }

  // On by a frame, in fixed steps. Paint runs only while the can hangs free: held, a thumb is over the hole.
  update(delta: number) {
    this.landings.length = 0;
    this.carry = Math.min(this.carry + delta, STEP * 12);
    const nozzle = scratch.e;
    while (this.carry >= STEP) {
      this.carry -= STEP;
      this.time += STEP;
      if (!this.held) this.swing(STEP);
      else {
        // Held: drawn smoothly after the hand, back onto the rope's sphere, its path kept for the throw.
        this.end.lerp(this.target, 1 - Math.exp(-STEP * 14));
        this.end.sub(this.pivot).setLength(ROPE).add(this.pivot);
        this.velocity.set(0, 0, 0);
        this.trail.push({ t: this.time, p: this.end.clone() });
        while (this.trail.length > 2 && this.time - this.trail[0].t > 0.12) this.trail.shift();
      }
      this.turn += this.spin * STEP;
      this.canvasTurn += this.canvasSpin * STEP;
      if (!this.held && !this.waiting && !this.finished && this.reach < DONE) this.finished = true;
      // Torricelli: the paint leaves as fast as it would fall the depth of paint in the vessel.
      const vessel = this.vessel;
      const depth = this.level * vessel.height * 0.85;
      const out = Math.sqrt(2 * G * Math.max(depth, 0));
      const flow = this.held || this.waiting || this.finished || this.paused || this.level <= 0 ? 0 : this.hole * out * (vessel.share ?? 1);
      this.sinceParcel += STEP;
      // A parcel from every hole every step while it runs, carrying the paint that left in that time.
      if (flow > 0 && this.sinceParcel >= STEP) {
        this.sinceParcel = 0;
        const along = scratch.f.subVectors(this.pivot, this.end).normalize().negate();
        const wide = (vessel.top + vessel.bottom) / 2;
        const layout = this.streamLayout;
        for (let k = 0; k < vessel.holes; k++) {
          const filaments = this.filamentCount(k);
          for (let filament = 0; filament < filaments; filament++) {
            const parcel = this.free();
            if (!parcel) break;
            const stream = vessel.partition ? k * 3 + filament : k;
            this.streamAt(stream, nozzle);
            // The vessel's own speed at the hole, as it swings and turns, and the paint's speed out of it.
            parcel.p.copy(nozzle);
            const off = scratch.a.copy(nozzle).sub(this.nozzle(scratch.b));
            // Slightly inward-drilled outlets bring the two independent jets into contact near the canvas.
            const jet = scratch.i.copy(along);
            if (vessel.inward) {
              const around = k / vessel.holes * Math.PI * 2;
              const inward = Math.sin(vessel.inward);
              jet.multiplyScalar(Math.cos(vessel.inward)).addScaledVector(axes.x, -Math.cos(around) * inward).addScaledVector(axes.z, -Math.sin(around) * inward);
            }
            parcel.v.copy(this.velocity).addScaledVector(jet, out * 0.6).add(scratch.b.crossVectors(along, off).multiplyScalar(-this.spin));
            parcel.volume = flow * STEP / filaments;
            parcel.born = this.time;
            parcel.alive = true;
            parcel.stream = stream;
            parcel.layout = layout;
            parcel.colour = vessel.partition && k === 1 ? this.secondaryColour : this.colour;
            parcel.paint = vessel.partition ? this.outletPaints?.[k]?.[filament] : undefined;
            parcel.axis.set(0, 0, 0);
            if (vessel.slot) {
              this.frame(parcel.axis, scratch.a, scratch.b);
              parcel.axis.multiplyScalar(vessel.slot / 2);
            }
            this.level = Math.max(0, this.level - parcel.volume / (Math.PI * wide * wide * vessel.height * 0.85));
          }
        }
      }
      // The parcels fall freely, and land on the canvas (or the floor round it).
      for (const parcel of this.parcels) {
        if (!parcel.alive) continue;
        parcel.v.y -= G * STEP;
        parcel.p.addScaledVector(parcel.v, STEP);
        // Over the canvas it lands on the canvas; past its edge it falls on to the floor.
        // The canvas may be turning on its turntable: where the parcel comes down on it, and how fast it moves across
        // it, in the canvas's own turning frame.
        const local = scratch.c.copy(parcel.p).applyAxisAngle(Y, -this.canvasTurn);
        const onCanvas = Math.abs(local.x) < CANVAS / 2 + 0.01 && Math.abs(local.z) < CANVAS / 2 + 0.01;
        if (parcel.p.y <= (onCanvas ? FACE : 0)) {
          parcel.alive = false;
          if (onCanvas) {
            const moving = scratch.d.set(parcel.v.x - this.canvasSpin * parcel.p.z, 0, parcel.v.z + this.canvasSpin * parcel.p.x).applyAxisAngle(Y, -this.canvasTurn);
            const axis = scratch.e.copy(parcel.axis).setY(0).applyAxisAngle(Y, -this.canvasTurn);
            this.landings.push({ x: local.x, z: local.z, volume: parcel.volume, vx: moving.x, vz: moving.z, ax: axis.x, az: axis.z, floor: false, colour: parcel.colour, paint: parcel.paint });
          } else if (Math.abs(parcel.p.x) < FLOOR / 2 && Math.abs(parcel.p.z) < FLOOR / 2)
            this.landings.push({ x: parcel.p.x, z: parcel.p.z, volume: parcel.volume, vx: parcel.v.x, vz: parcel.v.z, ax: parcel.axis.x, az: parcel.axis.z, floor: true, colour: parcel.colour, paint: parcel.paint });
        }
      }
    }
  }

  // A parcel not in flight, looked for from where the last one was found, so a long ring is not searched from the start.
  private cursor = 0;
  private free() {
    const n = this.parcels.length;
    for (let i = 0; i < n; i++) {
      const parcel = this.parcels[(this.cursor + i) % n];
      if (!parcel.alive) {
        this.cursor = (this.cursor + i + 1) % n;
        return parcel;
      }
    }
    return undefined;
  }

  // Speed of the can, for the sound and the aim.
  get speed() {
    return this.velocity.length();
  }
}

const scratch = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), e: new THREE.Vector3(), f: new THREE.Vector3(), g: new THREE.Vector3(), h: new THREE.Vector3(), i: new THREE.Vector3() };
const axes = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() };
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
