"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, color as tslColor, float, max, mix, sin, smoothstep, step, time, uniform, varying } from "three/tsl";
import { sound } from "../shared/engine/sound";
import type { FoldRig } from "./forms";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const REACH = (70 * Math.PI) / 180;
const DETENT = (15 * Math.PI) / 180;

// Parts of the dial, by aKind.
const RING = 0;
const TRACK = 1;
const TICK = 2;
const ARROW = 3;
const HUB = 4;

// In its own plane, unit radius: a faint full ring, a bright arc along the side you pull, ticks at each detent, and an arrow at each end.
function buildDial() {
  const position: number[] = [];
  const angle: number[] = [];
  const kind: number[] = [];
  const add = (x: number, y: number, theta: number, what: number) => {
    position.push(x, y, 0);
    angle.push(theta);
    kind.push(what);
  };
  const polar = (radius: number, theta: number): [number, number] => [Math.cos(theta) * radius, Math.sin(theta) * radius];
  const quad = (a: [number, number], b: [number, number], c: [number, number], d: [number, number], ta: number, tb: number, what: number) => {
    add(...a, ta, what);
    add(...b, ta, what);
    add(...c, tb, what);
    add(...c, tb, what);
    add(...b, ta, what);
    add(...d, tb, what);
  };
  const arc = (from: number, to: number, width: number, what: number, segments: number) => {
    for (let i = 0; i < segments; i++) {
      const a = from + ((to - from) * i) / segments;
      const b = from + ((to - from) * (i + 1)) / segments;
      quad(polar(1 - width, a), polar(1 + width, a), polar(1 - width, b), polar(1 + width, b), a, b, what);
    }
  };
  arc(0, Math.PI * 2, 0.006, RING, 72);
  arc(-REACH, REACH, 0.022, TRACK, 56);
  for (let k = -4; k <= 4; k++) {
    const theta = k * DETENT;
    const across = 0.012;
    const long = k === 0 ? 0.13 : 0.08;
    const left = theta - across / 1;
    const right = theta + across / 1;
    quad(polar(1 - long, left), polar(1 + long, left), polar(1 - long, right), polar(1 + long, right), theta, theta, TICK);
  }
  // Chevrons, swept back along the arc, pointing the way each end of it goes.
  for (const side of [-1, 1]) {
    const tip = side * (REACH + 0.26);
    const back = side * (REACH + 0.06);
    const notch = side * (REACH + 0.11);
    const wide = 0.15;
    const edge = side * (REACH + 0.06);
    for (const [ax, bx, cx] of [
      [polar(1, tip), polar(1 + wide, back), polar(1, notch)],
      [polar(1, tip), polar(1, notch), polar(1 - wide, back)]
    ] as [number, number][][]) {
      add(...ax, edge, ARROW);
      add(...bx, edge, ARROW);
      add(...cx, edge, ARROW);
    }
  }
  // The axis itself, end on.
  const hub = 20;
  for (let i = 0; i < hub; i++) {
    const a = (i / hub) * Math.PI * 2;
    const b = ((i + 1) / hub) * Math.PI * 2;
    add(0, 0, 0, HUB);
    add(...polar(0.07, a), 0, HUB);
    add(...polar(0.07, b), 0, HUB);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("aTheta", new THREE.Float32BufferAttribute(angle, 1));
  geometry.setAttribute("aKind", new THREE.Float32BufferAttribute(kind, 1));
  return geometry;
}

// Shows how the held crease turns: it sits at the end of the axis, its arc lying along the way the paper
// moves on screen, so its arrows say which way to pull. As you do, the arc fills in and clicks past each detent.
export function FoldDial({ rig }: { rig: FoldRig }) {
  const camera = useThree((state) => state.camera);
  const uniforms = useMemo(() => ({ sweep: uniform(0), presence: uniform(0), held: uniform(0) }), []);

  const built = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
    const theta = varying(attribute("aTheta", "float")) as any;
    const what = varying(attribute("aKind", "float")) as any;
    const is = (value: number) => step(value - 0.5, what).mul(step(what, float(value + 0.5))) as any;
    const sweep = uniforms.sweep as any;
    const way = step(float(0), sweep).mul(2).sub(1) as any;
    // Lit from the middle out to where the fold has reached, on the side it went.
    const passed = step(float(0), theta.mul(way)).mul(step(abs(theta), abs(sweep).add(0.012))) as any;
    const pulse = sin(time.mul(4.2).add(theta.mul(0.6))).mul(0.5).add(0.5) as any;
    const thisArrow = step(float(0), theta.mul(way)) as any;
    // Before you pull, both arrows breathe, inviting it. Once you pull, the one you are following takes over.
    const moved = smoothstep(0.01, 0.06, abs(sweep)) as any;
    const arrow = mix(pulse.mul(0.55).add(0.45), mix(float(0.22), float(1.3), thisArrow), moved.mul(uniforms.held)) as any;
    const level = is(RING).mul(0.2).add(is(TRACK).mul(mix(float(0.42), float(1.6), passed))).add(is(TICK).mul(mix(float(0.42), float(1.5), passed))).add(is(ARROW).mul(arrow)).add(is(HUB).mul(1.1)) as any;
    material.colorNode = mix(tslColor("#ffb648"), tslColor("#fff0c8"), max(passed.mul(is(TRACK).add(is(TICK))), is(HUB))).mul(1.7) as any;
    material.opacityNode = level.mul(uniforms.presence) as any;
    const dial = new THREE.Mesh(buildDial(), material);
    dial.frustumCulled = false;
    dial.renderOrder = 20;
    dial.matrixAutoUpdate = false;
    dial.visible = false;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false }));
    (stem.material as THREE.MeshBasicNodeMaterial).colorNode = tslColor("#ffb648").mul(1.3) as any;
    (stem.material as THREE.MeshBasicNodeMaterial).opacityNode = uniforms.presence.mul(0.55) as any;
    stem.frustumCulled = false;
    stem.renderOrder = 20;
    stem.visible = false;
    return { dial, stem };
  }, [uniforms]);

  useEffect(
    () => () => {
      built.dial.geometry.dispose();
      (built.dial.material as THREE.Material).dispose();
      built.stem.geometry.dispose();
      (built.stem.material as THREE.Material).dispose();
    },
    [built]
  );

  const state = useMemo(
    () => ({
      joint: -1,
      crease: -1,
      end: 0,
      presence: 0,
      wasHeld: false,
      start: 0,
      detent: 0,
      aimAt: 0,
      way: 1,
      sweep: 0,
      centre: new THREE.Vector3(),
      a: { x: 0, y: 0, z: 0 },
      b: { x: 0, y: 0, z: 0 },
      out: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 0, 1),
      along: new THREE.Vector3(0, 1, 0),
      side: new THREE.Vector3(1, 0, 0),
      toEye: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      wantNormal: new THREE.Vector3(),
      wantAlong: new THREE.Vector3(),
      scale: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      quaternion: new THREE.Quaternion(),
      matrix: new THREE.Matrix4()
    }),
    []
  );

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const s = state;
    const holding = rig.held >= 0;
    // Pulling at a crease on the dome is not a rotation, so it has no dial.
    const live = rig.family.nodes ? -1 : holding ? rig.held : rig.hover;
    camera.getWorldDirection(s.forward);

    const snap = live >= 0 && live !== s.joint;
    if (snap) {
      s.joint = live;
      s.crease = rig.family.creases.findIndex((crease) => crease.joint === live);
      s.end = -1;
      s.start = rig.drag[live];
      s.detent = 0;
      if (!holding) sound.play("click", { gain: 0.6, pitch: 0.8 });
    }
    s.presence += ((live >= 0 ? 1 : 0) - s.presence) * (1 - Math.exp(-delta * (live >= 0 ? 14 : 7)));
    uniforms.presence.value = s.presence;
    const showing = s.presence > 0.01 && s.joint >= 0 && s.crease >= 0;
    built.dial.visible = built.stem.visible = showing;
    if (!showing) {
      s.joint = live;
      return;
    }
    const crease = rig.family.creases[s.crease];
    if (!crease || crease.joint !== s.joint) {
      built.dial.visible = built.stem.visible = false;
      return;
    }
    rig.toWorld(crease.facet, crease.a[0], 0, crease.a[1], s.a);
    rig.toWorld(crease.facet, crease.b[0], 0, crease.b[1], s.b);
    // Keep to whichever end was nearer when it appeared, so that it does not jump as the view turns.
    if (s.end < 0) s.end = Math.hypot(s.a.x - camera.position.x, s.a.y - camera.position.y, s.a.z - camera.position.z) < Math.hypot(s.b.x - camera.position.x, s.b.y - camera.position.y, s.b.z - camera.position.z) ? 0 : 1;
    const tip = s.end === 0 ? s.a : s.b;
    const tail = s.end === 0 ? s.b : s.a;
    s.out.set(tip.x - tail.x, tip.y - tail.y, tip.z - tail.z);
    const length = s.out.length() || 1;
    s.out.divideScalar(length);

    if (holding && !s.wasHeld) {
      s.start = rig.drag[s.joint];
      s.detent = 0;
    }
    s.wasHeld = holding;

    // While only hovering, find out now which way this crease would move.
    s.aimAt -= delta;
    if (!holding && live >= 0 && (snap || s.aimAt < 0)) {
      s.aimAt = 0.2;
      rig.aimDrag(s.joint, s.forward.x, s.forward.y, s.forward.z);
    }

    const distance = camera.position.distanceTo(s.centre);
    const radius = Math.max(Math.min(length * 0.14, 0.62), distance * 0.042);
    s.centre.set(tip.x, tip.y, tip.z).addScaledVector(s.out, radius * 1.1);
    s.toEye.copy(camera.position).sub(s.centre).normalize();

    // True to the axis when you look along it, turned toward you as it goes edge on, so that it can always be read.
    const facing = s.out.dot(s.toEye);
    const edgeOn = 1 - Math.abs(facing);
    s.wantNormal
      .copy(s.out)
      .multiplyScalar(facing < 0 ? -1 : 1)
      .lerp(s.toEye, 0.3 + edgeOn * 0.55)
      .normalize();
    const d = rig.dragDirection;
    s.wantAlong.set(d.x, d.y, d.z);
    // Point the arc up the screen wherever it can, and remember which way that makes the angle run.
    s.way = s.wantAlong.dot(s.up) < 0 ? -1 : 1;
    s.wantAlong.multiplyScalar(s.way);
    s.wantAlong.addScaledVector(s.wantNormal, -s.wantAlong.dot(s.wantNormal)).normalize();

    const ease = snap ? 1 : 1 - Math.exp(-delta * 16);
    s.normal.lerp(s.wantNormal, ease).normalize();
    s.along.lerp(s.wantAlong, ease);
    s.along.addScaledVector(s.normal, -s.along.dot(s.normal)).normalize();
    s.side.crossVectors(s.along, s.normal).normalize();
    // Bulge away from the sheet, so that the arc reads as a handle on the end of the axis.
    const flip = s.side.dot(s.out) < 0 && Math.abs(facing) < 0.6 ? -1 : 1;
    const bloom = 0.82 + 0.18 * s.presence;
    s.matrix.makeBasis(s.side.clone().multiplyScalar(flip * radius * bloom), s.along.clone().multiplyScalar(radius * bloom), s.normal.clone().multiplyScalar(radius * bloom));
    s.matrix.setPosition(s.centre);
    built.dial.matrix.copy(s.matrix);
    built.dial.matrixWorldNeedsUpdate = true;

    // The stem, from the end of the crease out to the hub.
    built.stem.position.set(tip.x, tip.y, tip.z).addScaledVector(s.out, radius * 0.55);
    built.stem.quaternion.setFromUnitVectors(s.up, s.out);
    built.stem.scale.set(radius * 0.016, radius * 1.1, radius * 0.016);

    const turned = holding ? (rig.drag[s.joint] - s.start) * s.way : 0;
    s.sweep += (Math.max(-REACH, Math.min(REACH, turned)) - s.sweep) * (1 - Math.exp(-delta * (holding ? 30 : 8)));
    uniforms.sweep.value = s.sweep;
    uniforms.held.value = holding ? 1 : 0;

    // A click past every detent, rising a little the further it goes.
    if (holding) {
      const detent = Math.trunc((rig.drag[s.joint] - s.start) / DETENT);
      if (detent !== s.detent) {
        s.detent = detent;
        sound.play("click", { gain: 1.6, pitch: 1 + Math.min(0.5, Math.abs(detent) * 0.05), pan: s.centre.x / 9 });
      }
    }
  });

  return (
    <>
      <primitive object={built.dial} />
      <primitive object={built.stem} />
    </>
  );
}
