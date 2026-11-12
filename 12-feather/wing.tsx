"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../shared/engine/controls";
import { useSetting, useSettingAction } from "../shared/engine/settings";
import { sound, useBed } from "../shared/engine/sound";
import { KeyLight, StudioEnvironment } from "../shared/engine/studio";
import { OVERLAY_LAYER } from "../shared/engine/Post";
import { narrowScreen } from "../shared/engine/quality";
import { useLook } from "../shared/engine/Stage";
import { air, useBreeze, windAt } from "./air";
import { Airflow, flow, pace } from "./flow";
import { CloudSky, WEATHER } from "./sky";
import { featherGeometry, featherMaterial, type Feather, type Outline, type Plumage } from "./feather";
import { focus } from "./set";
import { attribute, color, abs, dot, float, mix, mx_noise_float, normalView, positionLocal, positionViewDirection, pow, smoothstep, uniform } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A pair of wings, built as a wing is built. Inside each is an arm: the humerus from the shoulder; the ulna, bowed,
// with the knobs the secondaries grow from, and the slim radius beside it; the wrist bones; and the hand, two fused
// metacarpals, a thumb and the finger bones at the tip. Over the bones a skin, bound to them and bending at elbow and
// wrist, and in front of the arm the web of skin from shoulder to wrist that makes the thick, rounded leading edge.
//
// The feathers grow from it as they do on a bird: ten primaries from the hand, the outer ones notched; sixteen
// secondaries from the ulna; tertials by the elbow. Over their bases the coverts lie in rows like roof tiles, each row
// over the one behind it: a greater covert for every flight feather, a row of medians, rows of lesser coverts, and the
// small marginal coverts on the leading edge. Elbow and wrist are tied together by the radius sliding along the ulna,
// so a bird cannot open one without the other; one number, how far the wing is open, sets both. Dragging any part of a
// wing solves for that and for the sweep at the shoulder so that the part you hold follows the cursor.
//
// In a wingbeat every joint also lifts and twists out of the wing's plane. On the downstroke the wing is spread,
// swept forward and turned leading edge down; at the bottom it turns back up; on the upstroke the wrist folds, the hand
// turns up and back, and the forearm and hand trail behind the shoulder, so the tip traces a loop. Each feather is
// sprung, and lifts, twists and bends in the air it moves through.
const deg = THREE.MathUtils.degToRad;
// Humerus, forearm and hand, in the proportions of a gull's.
const LENGTHS = [0.24, 0.29, 0.2];
// Each bone's heading in the wing's plane, folded and spread: outward along the span is 0, toward the head positive.
const FOLDED = [deg(-95), deg(92), deg(-88)];
const SPREAD = [deg(-16), deg(12), deg(-6)];
const ELBOW = LENGTHS[0] / (LENGTHS[0] + LENGTHS[1]);
const ROOT = new THREE.Vector3(0.075, 0.92, 0);
// The wings lie level, as in flight, the bird heading away from the camera, its back up, the tips raised a little.
const BEARING = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.06));
// And the pair turned about so the bird flies toward the camera.
const HEADING = new THREE.Matrix4().makeRotationY(Math.PI);
// Where the neck would be: between the shoulders and forward of them. Carried by the cursor, it takes the shoulders
// with it while the wingtips stay where they were, and each wing works out how to reach its tip from there.
const NECK = new THREE.Vector3(0, ROOT.y + 0.015, 0.17);
type Body = { offset: THREE.Vector3; held: boolean; epoch: number; grip: THREE.Vector3 };
const BEAT = 1.5;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

const smooth = (x: number) => {
  const c = THREE.MathUtils.clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
};
const bump = (t: number, centre: number, width: number) => Math.exp(-(((t - centre) / width) ** 2));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The arm's pose. In the wing's plane: each bone's heading, how far each joint has opened, and the sweep. Out of it:
// how far each bone is raised against the one before it, and how far it is turned about its own length. From those, each
// bone's place and turn in the wing's space.
type Pose = {
  angles: number[];
  reach: number[];
  sweep: number;
  lift: number[];
  twist: number[];
  turns: THREE.Quaternion[];
  joints: THREE.Vector3[];
  local: THREE.Quaternion[];
};
const newPose = (): Pose => ({
  angles: [0, 0, 0],
  reach: [0, 0, 0],
  sweep: 0,
  lift: [0, 0, 0],
  twist: [0, 0, 0],
  turns: [0, 1, 2].map(() => new THREE.Quaternion()),
  joints: [0, 1, 2, 3].map(() => new THREE.Vector3()),
  local: [0, 1, 2].map(() => new THREE.Quaternion())
});
const scratch = { a: new THREE.Quaternion(), b: new THREE.Quaternion(), v: new THREE.Vector3(), w: new THREE.Vector3() };

// The skeleton for an opening between 0 (folded) and 1 (spread): the elbow leads a little and the wrist follows. Lifts
// and twists are taken from the pose as they stand.
function solve(open: number, sweep: number, out: Pose) {
  out.reach[0] = smooth(open * 1.1);
  out.reach[1] = smooth(open);
  out.reach[2] = smooth((open - 0.06) / 0.94);
  out.sweep = sweep;
  out.joints[0].set(0, 0, 0);
  let before = 0;
  for (let b = 0; b < 3; b++) {
    const a = sweep + THREE.MathUtils.lerp(FOLDED[b], SPREAD[b], out.reach[b]);
    out.angles[b] = a;
    // Turned in the plane from the bone before, then raised, then twisted about itself.
    out.local[b]
      .setFromAxisAngle(Z, a - before)
      .multiply(scratch.a.setFromAxisAngle(Y, -out.lift[b]))
      .multiply(scratch.b.setFromAxisAngle(X, out.twist[b]));
    if (b === 0) out.turns[0].copy(out.local[0]);
    else out.turns[b].copy(out.turns[b - 1]).multiply(out.local[b]);
    out.joints[b + 1].set(LENGTHS[b], 0, 0).applyQuaternion(out.turns[b]).add(out.joints[b]);
    before = a;
  }
  return out;
}

// How high the web's skin stands above the plane of the bones: level with the top of the arm, falling a little toward
// the leading edge and rounding over it.
function membraneHeight(u: number, v: number) {
  // A gentle slope, so the coverts lying on it run smoothly back over the arm, as the feathers make a smooth airfoil.
  return girth(u * 2)[2] * (0.85 - 0.3 * v * v - 0.25 * Math.max(0, v - 0.85) / 0.15);
}

// The underside of the web: a shallower curve below the bones, meeting the top at the leading edge.
function membraneUnder(u: number, v: number) {
  const thick = girth(u * 2)[2];
  // Nearly flat, so the underwing coverts lie along it rather than tipping down off it.
  return -thick * (0.62 - 0.05 * v * v) * (1 - (Math.max(0, v - 0.85) / 0.15) * 0.55);
}

// A point on a bone, `t` of the way along it, `side` off it toward the leading edge and `up` above it.
function along(pose: Pose, bone: number, t: number, side: number, up: number, out: THREE.Vector3) {
  return out.set(LENGTHS[bone] * t, side, up).applyQuaternion(pose.turns[bone]).add(pose.joints[bone]);
}

// The web of skin in front of the arm: `u` from shoulder to wrist, `v` from the bones (0) to the leading edge (1),
// which runs nearly straight from shoulder to wrist while the wing is open. `up` lifts off it, square to the bone below.
function web(pose: Pose, u: number, v: number, up: number, out: THREE.Vector3) {
  const [s, e, w] = pose.joints;
  if (u < ELBOW) out.copy(s).lerp(e, u / ELBOW);
  else out.copy(e).lerp(w, (u - ELBOW) / (1 - ELBOW));
  const turn = pose.turns[u < ELBOW ? 0 : 1];
  // The leading edge: the line from shoulder to wrist, bowed a little forward.
  scratch.v.copy(s).lerp(w, u).addScaledVector(scratch.w.copy(Y).applyQuaternion(turn), 0.012 * Math.sin(Math.PI * u) + girth(u * 2)[0] * 0.9);
  out.lerp(scratch.v, v);
  return out.addScaledVector(scratch.w.copy(Z).applyQuaternion(turn), up);
}

// ---------------------------------------------------------------------------------------------------------------
// A wingbeat, as a gull's, slowed. `phase` runs 0 to 1 from the top of the stroke; the downstroke takes a little more
// than half. Returns the shoulder's raise, sweep and pronation, how far the wrist folds, and the twist of forearm and
// hand.
// The positive half of a wave, eased in and out, so that a fold begins and ends without a jolt.
const rise = (x: number) => {
  const m = Math.max(0, x);
  return m * m * (3 - 2 * m);
};

function stroke(phase: number) {
  const a = Math.PI * 2 * phase;
  return {
    // High at the start, low a little past half way, the down faster than the up.
    raise: 0.08 + 0.62 * Math.cos(a) + 0.08 * Math.cos(2 * a - 0.6),
    // Forward on the way down, back on the way up.
    sweep: 0.14 * Math.sin(a) - 0.03,
    // Leading edge down on the downstroke, up on the upstroke; the hand turns furthest.
    twist: -0.14 * Math.sin(a),
    handTwist: -0.18 * Math.sin(a + 0.35),
    // The wrist folds on the upstroke.
    tuck: 0.48 * rise(-Math.sin(a + 0.25)),
    // Out of the wing's plane. The downstroke is the power stroke: the wing sweeps down fully spread and nearly flat,
    // the hand only bent up a little at the tip by the load on it. The break comes at the bottom: the wrist flexes, and
    // through the upstroke the elbow and wrist lead upward while the hand trails below them, the tip last; at the top
    // the hand flicks up and out, spread again for the next downstroke.
    armLift: 0.08 * Math.cos(a),
    foreLift: -0.2 * rise(-Math.sin(a + 0.2)),
    handLift: -0.3 * rise(-Math.sin(a - 0.05)) + 0.08 * rise(Math.sin(a - 0.1))
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The arm: bones, and the skin bound to them.

// The skin's half-widths ahead of and behind the bones, and its half-thickness, along the arm (0 shoulder, 1 elbow,
// 2 wrist, 3 tip): heavy with muscle at the shoulder, slimmer down the forearm, thin and flat over the hand.
const GIRTH: [number, number, number, number][] = [
  [0, 0.03, 0.026, 0.024],
  [0.5, 0.026, 0.022, 0.02],
  [1, 0.02, 0.017, 0.015],
  [1.3, 0.019, 0.016, 0.013],
  [2, 0.011, 0.009, 0.008],
  [2.6, 0.007, 0.005, 0.005],
  [3, 0.002, 0.002, 0.002]
];
function girth(s: number) {
  const c = THREE.MathUtils.clamp(s, 0, 3);
  let i = 0;
  while (i < GIRTH.length - 2 && GIRTH[i + 1][0] < c) i++;
  const [a, b] = [GIRTH[i], GIRTH[i + 1]];
  const k = (c - a[0]) / (b[0] - a[0]);
  return [1, 2, 3].map((j) => THREE.MathUtils.lerp(a[j], b[j], k)) as [number, number, number];
}

// A bone along +x, from `from` to `to` of its length: its radius all round at each point (`a` is the angle round it,
// 0 toward the leading edge and a quarter turn up toward the back), and where its middle runs. Capped at both ends.
function boneGeometry(
  length: number,
  radius: (t: number, a: number) => number,
  centre: (t: number) => [number, number] = () => [0, 0],
  from = 0,
  to = 1,
  rows = 72,
  around = 28
) {
  const position: number[] = [];
  const index: number[] = [];
  const grain: number[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = from + ((to - from) * i) / rows;
    const [cy, cz] = centre(t);
    for (let j = 0; j < around; j++) {
      const a = (j / around) * Math.PI * 2;
      const r = Math.max(0.0004, radius(t, a));
      position.push(t * length, cy + Math.cos(a) * r, cz + Math.sin(a) * r);
      grain.push(t, a);
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * around + j;
      const b = i * around + ((j + 1) % around);
      index.push(a, b, a + around, b, b + around, a + around);
    }
  }
  const ends = position.length / 3;
  const [y0, z0] = centre(from);
  const [y1, z1] = centre(to);
  position.push(from * length - radius(from, 0) * 0.5, y0, z0, to * length + radius(to, 0) * 0.5, y1, z1);
  grain.push(from, 0, to, 0);
  for (let j = 0; j < around; j++) {
    index.push(ends, (j + 1) % around, j);
    index.push(ends + 1, rows * around + j, rows * around + ((j + 1) % around));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("grain", new THREE.Float32BufferAttribute(grain, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

// How near an angle round a bone is to `centre`, for a crest or a process on one side of it.
const facing = (a: number, centre: number, width: number) => Math.exp(-((wrap(a - centre) / width) ** 2));

// Where along the ulna the secondaries grow, for its quill knobs.
const SECONDARIES = 16;
const knobAt = (i: number) => 0.97 - (i / (SECONDARIES - 1)) * 0.92;

function buildArm(skinMaterial: THREE.Material, boneMaterial: THREE.Material) {
  const bones = [0, 1, 2, 3].map(() => new THREE.Bone());
  for (let b = 0; b < 3; b++) {
    bones[b].add(bones[b + 1]);
    bones[b + 1].position.x = LENGTHS[b];
  }
  const rest = solve(1, 0, newPose());
  for (let b = 0; b < 3; b++) bones[b].quaternion.copy(rest.local[b]);

  // The skin, a tube round the bones laid out in the spread pose, each ring bound to its bone and, near a joint, half
  // to the next, so that it bends there rather than breaking.
  const position: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  const index: number[] = [];
  const around = 18;
  const steps: number[] = [];
  for (let i = 0; i <= 8; i++) steps.push(-0.1 + (i / 8) * 0.1);
  for (let i = 1; i <= 120; i++) steps.push((i / 120) * 3);
  const centre = new THREE.Vector3();
  for (const s of steps) {
    const b = Math.min(2, Math.max(0, Math.floor(s)));
    const t = s - b;
    along(rest, b, t, 0, 0, centre);
    const a = rest.angles[b];
    // A rounded cap at the shoulder end, where there is no body.
    const cap = s < 0 ? Math.sqrt(Math.max(0, 1 - (s / 0.1) ** 2)) : 1;
    const [fore, aft, thick] = girth(s);
    const d = t * LENGTHS[b];
    const before = b > 0 ? 0.5 * (1 - smooth(d / 0.03)) : 0;
    const after = b < 2 ? 0.5 * (1 - smooth((LENGTHS[b] - d) / 0.03)) : 0;
    for (let j = 0; j < around; j++) {
      const angle = (j / around) * Math.PI * 2;
      const c = Math.cos(angle);
      const reach = c * (c > 0 ? fore : aft) * cap;
      position.push(centre.x - Math.sin(a) * reach, centre.y + Math.cos(a) * reach, Math.sin(angle) * thick * cap);
      skinIndex.push(b, Math.max(0, b - 1), b + 1, 0);
      skinWeight.push(1 - before - after, before, after, 0);
    }
  }
  for (let i = 0; i < steps.length - 1; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * around + j;
      const b = i * around + ((j + 1) % around);
      index.push(a, a + around, b, b, a + around, b + around);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const skin = new THREE.SkinnedMesh(geometry, skinMaterial);
  skin.frustumCulled = false;
  skin.castShadow = true;
  skin.receiveShadow = true;
  skin.add(bones[0]);
  skin.updateMatrixWorld(true);
  skin.bind(new THREE.Skeleton(bones));

  // The bones themselves, each carried by its joint, modelled on a gull's: angles round a bone are 0 toward the
  // leading edge, a quarter turn up to the back of the wing, a half turn to the trailing edge.
  const geometries: THREE.BufferGeometry[] = [];
  const put = (bone: THREE.Bone, shape: THREE.BufferGeometry, x = 0, y = 0, turn = 0, z = 0) => {
    geometries.push(shape);
    const mesh = new THREE.Mesh(shape, boneMaterial);
    mesh.position.set(x, y, z);
    mesh.rotation.z = turn;
    mesh.renderOrder = 30;
    mesh.frustumCulled = false;
    // Drawn in the overlay, added over the finished image: an x-ray takes no part in the shading and shadow of the
    // scene, so as it fades it leaves nothing behind.
    mesh.layers.set(OVERLAY_LAYER);
    bone.add(mesh);
  };
  const [humerus, forearm, hand] = LENGTHS;
  const back = Math.PI;
  const up = Math.PI / 2;
  // The humerus. At the shoulder an oval head, deep from back to belly; running down from it in front the
  // deltopectoral crest, where the flight muscle pulls; behind, the bicipital crest, with the pneumatic opening that lets
  // the air sacs into the bone below it. A shaft with a gentle S, and at the elbow the two condyles, back and belly,
  // that the forearm turns on.
  put(
    bones[0],
    boneGeometry(
      humerus,
      (t, a) =>
        0.0052 * (1 + 0.12 * Math.cos(2 * a)) +
        0.0085 * bump(t, 0.015, 0.06) * (1 + 0.5 * Math.abs(Math.sin(a))) +
        0.0075 * bump(t, 0.17, 0.075) * facing(a, 0.55, 0.5) +
        0.0048 * bump(t, 0.09, 0.05) * facing(a, back + 0.7, 0.5) -
        0.0022 * bump(t, 0.075, 0.018) * facing(a, -1.9, 0.3) +
        0.0026 * bump(t, 0.985, 0.045) +
        0.0026 * bump(t, 0.975, 0.04) * (facing(a, up + 0.3, 0.55) + facing(a, -up - 0.3, 0.55)) +
        0.0016 * bump(t, 0.93, 0.03) * facing(a, 0.2, 0.5),
      (t) => [0.0045 * Math.sin(Math.PI * 2 * t), 0.003 * Math.sin(Math.PI * t) - 0.0015],
      -0.045,
      1.02,
      96,
      32
    )
  );
  // The ulna, the heavier forearm bone, bowed back away from the radius. Its olecranon reaches back past the elbow;
  // down its trailing side, a little toward the back, a quill knob for each secondary.
  put(
    bones[1],
    boneGeometry(
      forearm,
      (t, a) => {
        let knobs = 0;
        for (let i = 0; i < SECONDARIES; i++) knobs += bump(t, knobAt(i), 0.009);
        return (
          0.0041 * (1 + 0.1 * Math.cos(2 * a)) +
          0.0042 * bump(t, 0.01, 0.05) * (1 + 0.3 * Math.cos(2 * a)) +
          0.0035 * bump(t, -0.045, 0.03) * facing(a, back, 0.9) +
          0.0026 * bump(t, 0.985, 0.04) * (1 + 0.45 * Math.cos(2 * a)) +
          0.0013 * Math.min(1, knobs) * facing(a, back - 0.55, 0.45)
        );
      },
      (t) => [-0.0105 * Math.sin(Math.PI * THREE.MathUtils.clamp(t, 0, 1)), 0.0018 * Math.sin(Math.PI * THREE.MathUtils.clamp(t, 0, 1))],
      -0.07,
      1.01,
      110,
      28
    ),
    0.004,
    -0.001
  );
  // The radius, slim and nearly straight, in front, its head at the elbow and a broader end at the wrist.
  put(
    bones[1],
    boneGeometry(
      forearm * 0.96,
      (t) => 0.0023 + 0.0019 * bump(t, 0.02, 0.04) + 0.0016 * bump(t, 0.97, 0.04),
      (t) => [0.0016 * Math.sin(Math.PI * 2 * t), 0.0012 * Math.sin(Math.PI * t)],
      0,
      1,
      72,
      18
    ),
    0.007,
    0.0095
  );
  // The wrist: the radiale, a chunky block in front, and behind it the ulnare, notched like a V.
  put(
    bones[2],
    boneGeometry(0.009, (t, a) => 0.0042 * Math.sin(Math.PI * t) ** 0.6 * (1 + 0.2 * Math.cos(2 * a)), () => [0, 0], 0, 1, 16, 16),
    -0.009,
    0.0055,
    0.3
  );
  put(
    bones[2],
    boneGeometry(0.01, (t, a) => 0.0038 * Math.sin(Math.PI * t) ** 0.6 * (1 + 0.35 * Math.cos(2 * a) - 0.25 * facing(a, 0, 0.5)), () => [0, 0], 0, 1, 16, 16),
    -0.009,
    -0.0065,
    -0.4
  );
  // The carpometacarpus. The major metacarpal, with the rounded trochlea the wrist bones ride on, and in front the
  // extensor process where the thumb is fused on; the minor metacarpal bowing away behind and joining it again at the
  // far end, an open space between.
  const metacarpus = hand * 0.6;
  put(
    bones[2],
    boneGeometry(
      metacarpus,
      (t, a) =>
        0.0032 * (1 + 0.12 * Math.cos(2 * a)) +
        0.0042 * bump(t, 0.03, 0.06) * (1 + 0.35 * Math.cos(2 * a)) +
        0.0048 * bump(t, 0.09, 0.05) * facing(a, 0.25, 0.45) +
        0.0022 * bump(t, 0.12, 0.035) * facing(a, -up, 0.4) +
        0.002 * bump(t, 0.985, 0.035),
      (t) => [0.0006 * Math.sin(Math.PI * t), 0],
      -0.02,
      1.02,
      80,
      24
    ),
    0.003
  );
  put(
    bones[2],
    boneGeometry(
      metacarpus,
      (t) => 0.0015 + 0.0011 * bump(t, 0.985, 0.04) + 0.0011 * bump(t, 0.13, 0.04),
      (t) => [-0.0028 - 0.0085 * Math.sin((Math.PI * (t - 0.12)) / 0.88), -0.0006],
      0.12,
      1,
      64,
      14
    ),
    0.003
  );
  // The thumb's one bone, angled forward off the extensor process, with a tiny claw.
  put(
    bones[2],
    boneGeometry(0.03, (t) => 0.0024 * (1 - t * 0.6) + 0.001 * bump(t, 0, 0.1), (t) => [0.0008 * t * t, 0], 0, 1, 24, 14),
    0.016,
    0.008,
    deg(26)
  );
  put(bones[2], boneGeometry(0.009, (t) => 0.0011 * (1 - t) + 0.0002, (t) => [-0.0012 * t * t, 0], 0, 1, 10, 10), 0.016 + 0.03 * Math.cos(deg(26)), 0.008 + 0.03 * Math.sin(deg(26)), deg(10));
  // The major digit: its first phalanx a broad flat blade with a flange behind, then the slim pointed second. The
  // minor digit is one small bone at the back of the hand's end.
  const first = hand * 0.25;
  put(
    bones[2],
    boneGeometry(
      first,
      (t, a) => (0.0019 + 0.0034 * facing(a, back, 0.75) * Math.sin(Math.PI * (0.15 + t * 0.7)) + 0.0012 * bump(t, 0, 0.08)) * (0.42 + 0.58 * Math.abs(Math.cos(a))),
      (t) => [-0.0005 * Math.sin(Math.PI * t), 0],
      0,
      1,
      40,
      24
    ),
    metacarpus + 0.004
  );
  put(
    bones[2],
    boneGeometry(hand * 0.15, (t) => 0.0019 * (1 - t * 0.88) + 0.0006 * bump(t, 0, 0.12), (t) => [0.0008 * t, 0], 0, 1, 30, 14),
    metacarpus + first + 0.005
  );
  put(bones[2], boneGeometry(0.018, (t) => 0.0012 * (1 - t * 0.7), () => [0, 0], 0, 1, 14, 10), metacarpus + 0.004, -0.0095, deg(-14));

  // The web in front of the arm: a fold of skin from the bones to the leading edge, with a top and an underside
  // that wrap round the leading edge, reshaped every frame.
  const U = 28;
  const V = 6;
  const ROWS = 2 * V + 2;
  const sheet = new THREE.BufferGeometry();
  sheet.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array((U + 1) * ROWS * 3), 3));
  const sheetIndex: number[] = [];
  for (let i = 0; i < U; i++) {
    for (let j = 0; j < ROWS - 1; j++) {
      const a = i * ROWS + j;
      sheetIndex.push(a, a + ROWS, a + 1, a + 1, a + ROWS, a + ROWS + 1);
    }
  }
  sheet.setIndex(sheetIndex);
  const membrane = new THREE.Mesh(sheet, skinMaterial);
  membrane.frustumCulled = false;
  membrane.receiveShadow = true;
  const point = new THREE.Vector3();

  return {
    skin,
    membrane,
    pose: (pose: Pose) => {
      for (let b = 0; b < 3; b++) bones[b].quaternion.copy(pose.local[b]);
      const p = sheet.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i <= U; i++) {
        const u = i / U;
        for (let j = 0; j < ROWS; j++) {
          // Over the top from the arm out to the leading edge, then back underneath.
          const top = j <= V;
          const v = top ? j / V : (ROWS - 1 - j) / V;
          web(pose, u, v, top ? membraneHeight(u, v) : membraneUnder(u, v), point);
          p.setXYZ(i * ROWS + j, point.x, point.y, point.z);
        }
      }
      p.needsUpdate = true;
      sheet.computeVertexNormals();
    },
    dispose: () => {
      geometry.dispose();
      sheet.dispose();
      geometries.forEach((g) => g.dispose());
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The feathers.

// The kinds of feather, each its own instanced mesh: the notched outer primaries, the other flight feathers, the
// larger coverts, and the small coverts of the leading edge.
const KINDS: { outline: Outline; segs: [number, number]; material: 0 | 1 }[] = [
  { outline: { width: 0.095, stalk: 0.05, asym: 0.5, lean: 0.3, curve: 0.025, arch: 0.025, cup: -0.06, point: 0.42, notch: 0.32 }, segs: [64, 14], material: 0 },
  { outline: { width: 0.14, stalk: 0.05, asym: 0.34, lean: 0.36, curve: 0.015, arch: 0.025, cup: -0.06, point: 0.24 }, segs: [52, 14], material: 0 },
  { outline: { width: 0.21, stalk: 0.02, asym: 0.12, lean: 0.48, curve: 0.01, arch: 0.035, cup: -0.025, point: 0.24 }, segs: [26, 10], material: 1 },
  { outline: { width: 0.3, stalk: 0.02, asym: 0.05, lean: 0.55, arch: 0.04, cup: -0.02, point: 0.2 }, segs: [16, 8], material: 1 }
];

type Role = "primary" | "secondary" | "tertial" | "greater" | "primaryCovert" | "median" | "lesser" | "marginal" | "alula" | "humeral";

type Plume = {
  role: Role;
  // Its place within its role, from the body out, 0 to 1.
  k: number;
  kind: number;
  slot: number;
  // Where it grows: `t` along a bone and `side` toward the leading edge, or a place on the web in front of the arm.
  bone: number;
  t: number;
  side: number;
  web?: [number, number];
  // An underwing covert: on the underside of the web, upside down, a mirror of the one above it.
  under?: boolean;
  // Which way it points, spread and folded, measured in the wing's plane as the bones are.
  open: number;
  shut: number;
  length: number;
  z: number;
  // Its place in the stack of flight feathers, those nearer the body lying on top.
  order: number;
  // How far its tip stands off what it lies on.
  rest: number;
  roll: number;
  seed: number;
  // How readily the air moves it.
  give: number;
  lift: number;
  liftSpeed: number;
  twist: number;
  twistSpeed: number;
  bow: number;
  bowSpeed: number;
  // Which way it points this frame, in the wing's plane.
  heading: number;
  base: THREE.Vector2;
  tip: THREE.Vector2;
  last: THREE.Vector3;
  fresh: boolean;
};

function layout() {
  const random = seeded(11);
  const plumes: Plume[] = [];
  const slots = KINDS.map(() => 0);
  const jitter = (amount: number) => (random() - 0.5) * 2 * amount;
  const add = (kind: number, role: Role, f: Partial<Plume> & Pick<Plume, "length" | "open" | "shut">) => {
    const p: Plume = {
      role,
      k: 0,
      kind,
      slot: slots[kind]++,
      bone: 1,
      t: 0,
      side: 0,
      z: 0,
      order: 0,
      rest: 0,
      roll: 0,
      seed: random(),
      give: 1,
      lift: 0,
      liftSpeed: 0,
      twist: 0,
      twistSpeed: 0,
      bow: 0,
      bowSpeed: 0,
      heading: 0,
      base: new THREE.Vector2(),
      tip: new THREE.Vector2(),
      last: new THREE.Vector3(),
      fresh: true,
      ...f
    };
    plumes.push(p);
    return p;
  };

  // Four tertials by the elbow, long and broad, lying over the inner secondaries.
  for (let i = 0; i < 4; i++) add(1, "tertial", { k: i / 3, bone: 0, t: 0.62 + i * 0.1, side: -0.006, open: deg(-114 + i * 5), shut: deg(-97 + i * 0.5), length: 0.25 - i * 0.012, order: i, roll: 0.06, give: 0.7 });
  // Sixteen secondaries, one from each quill knob of the ulna, broad with square tips.
  for (let i = 0; i < SECONDARIES; i++) {
    const k = i / (SECONDARIES - 1);
    add(1, "secondary", { k, bone: 1, t: knobAt(i), side: -0.007, open: deg(-86 - k * 20), shut: deg(-92 - k * 2), length: 0.225 + Math.sin(k * Math.PI) * 0.01, order: 4 + SECONDARIES - 1 - i, roll: 0.07, give: 0.6 });
  }
  // Ten primaries from the hand, fanning out, the outer ones longest and narrowest.
  const primary = [0.235, 0.25, 0.27, 0.295, 0.32, 0.35, 0.38, 0.405, 0.42, 0.405];
  for (let i = 0; i < 10; i++) {
    const k = i / 9;
    add(i < 5 ? 1 : 0, "primary", { k, bone: 2, t: 0.04 + k * 0.94, side: -0.004, open: deg(-88 + k * 70), shut: deg(-90 + k * 1.5), length: primary[i], order: 4 + SECONDARIES + i, roll: 0.06, give: 0.55 });
  }
  const flight = plumes.slice();
  // A greater covert over each flight feather's base, primary coverts on the hand.
  for (const f of flight) {
    const onHand = f.bone === 2;
    add(2, onHand ? "primaryCovert" : "greater", { k: f.k, bone: f.bone, t: Math.min(1, f.t + 0.012), side: 0.012, open: f.open + deg(4), shut: f.shut, length: f.length * (onHand ? 0.36 : 0.46), z: 0.012, rest: 0.05, roll: 0.05, give: 0.9 });
  }
  // Rows on the web in front of the arm, each nearer the leading edge lying over the one behind it, staggered so each
  // feather covers the gap between two below: a row of medians, then lesser coverts, then marginals on the edge.
  const rows: { v: number; count: number; length: number; role: Role; kind: number }[] = [
    { v: 0.16, count: 19, length: 0.095, role: "median", kind: 2 },
    { v: 0.34, count: 19, length: 0.075, role: "lesser", kind: 3 },
    { v: 0.5, count: 20, length: 0.064, role: "lesser", kind: 3 },
    { v: 0.64, count: 22, length: 0.055, role: "lesser", kind: 3 },
    { v: 0.77, count: 24, length: 0.046, role: "lesser", kind: 3 },
    { v: 0.88, count: 27, length: 0.038, role: "marginal", kind: 3 },
    { v: 0.97, count: 30, length: 0.031, role: "marginal", kind: 3 }
  ];
  rows.forEach((row, r) => {
    for (let i = 0; i < row.count; i++) {
      const u = (i + (r % 2) * 0.5 + 0.3) / (row.count + 0.3);
      if (u > 1.02) continue;
      // They point back and out, more outward toward the wrist.
      const open = deg(THREE.MathUtils.lerp(-104, -82, u) + jitter(4));
      const f = { k: u, web: [Math.min(1, u), row.v + jitter(0.015)] as [number, number], open, shut: deg(-93 + jitter(3)), length: row.length * (0.92 + random() * 0.16), z: 0.016 + r * 0.0035, rest: 0.07 + random() * 0.04, give: 1 + r * 0.08 };
      add(row.kind, row.role, f);
    }
  });
  // Underneath, rows rooted from the arm outward with their tips pointing forward to the leading edge: the longest
  // by the arm, the shortest at the front, a little shorter than those above.
  rows.forEach((row, r) => {
    // Pushed forward, so the outer rows reach right to the leading edge.
    const v = Math.min(0.94, 0.22 + (1 - row.v) * 0.8);
    const length = rows[rows.length - 1 - r].length * 0.9;
    for (let i = 0; i < row.count; i++) {
      const u = (i + (r % 2) * 0.5 + 0.3) / (row.count + 0.3);
      if (u > 1.02) continue;
      const open = deg(THREE.MathUtils.lerp(76, 98, u) + jitter(4));
      add(row.kind, row.role, { k: u, web: [Math.min(1, u), v + jitter(0.015)], under: true, open, shut: deg(87 + jitter(3)), length: length * (0.92 + random() * 0.16), z: 0.016 + r * 0.0035, rest: 0.07 + random() * 0.04, give: 1 + r * 0.08 });
    }
  });
  // Median and marginal coverts over the hand.
  for (let i = 0; i < 8; i++) add(2, "median", { k: i / 7, bone: 2, t: 0.04 + i * 0.11, side: 0.02, open: deg(-92 + i * 6), shut: deg(-90), length: 0.07 - i * 0.003, z: 0.017, give: 1 });
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 11; i++) add(3, "marginal", { k: i / 10, bone: 2, t: 0.05 + (i + r * 0.5) * 0.075, side: 0.026 + r * 0.007, open: deg(-84 + i * 4 + jitter(4)), shut: deg(-90), length: 0.034 - r * 0.004, z: 0.02 + r * 0.003, give: 1.4 });
  }
  // The alula: four stiff little feathers on the thumb, along the leading edge at the wrist.
  for (let i = 0; i < 4; i++) add(2, "alula", { k: i / 3, bone: 2, t: 0.02 + i * 0.025, side: 0.03, open: deg(-14 - i * 7), shut: deg(-82), length: 0.12 - i * 0.017, z: 0.026 - i * 0.002, roll: -0.12, give: 0.7 });
  // Humerals at the root, where the wing would meet the body.
  for (let i = 0; i < 6; i++) add(2, "humeral", { k: i / 5, bone: 0, t: 0.02 + i * 0.09, side: 0.006, open: deg(-100 + i * 2 + jitter(3)), shut: deg(-96), length: 0.2 + i * 0.012, z: 0.03, roll: -0.1, give: 0.9 });
  // The flight feathers in one chain from the body to the tip, in the order they grow along the arm. Neighbours in it are held close in angle, so the trailing edge stays whole as the wing folds and bends.
  const rank: Role[] = ["tertial", "secondary", "primary"];
  const chain = plumes.filter((p) => rank.includes(p.role)).sort((a, b) => a.bone + a.t - (b.bone + b.t));
  return { plumes, counts: slots, chain };
}

// ---------------------------------------------------------------------------------------------------------------
// Three birds' colours: flight feathers, then coverts, and for each feather how far toward the second colours.

type Species = { flight: Plumage; covert: Plumage; tone: (role: Role, k: number) => number };
const LIGHT = new THREE.Vector3(0.8, 2.6, -2.6);
const SPECIES: Record<string, Species> = {
  // A herring gull: pale grey, the outer primaries black toward their tips with white spots at the very end, and a
  // white trailing edge along the secondaries.
  gull: {
    flight: { base: "#a3adb7", tip: "#9ba6b0", shaft: "#c4ccd3", edge: "#f4f4f1", edgeAmount: 0.95, sideEdge: 0.08, tipFringe: 1, second: { base: "#a9b3bd", tip: "#121315", blend: [0.5, 0.62] }, down: 0.08, barbs: 210, ragged: 0.04, splits: 0.01, sheen: 0.4, roughness: 0.6, glow: 0.35, light: LIGHT, bowed: true },
    covert: { base: "#8f99a3", tip: "#b3bcc5", blend: [0.15, 0.85], shaft: "#c2c9d0", shaftAmount: 0.35, edge: "#c9d0d6", edgeAmount: 0.25, sideEdge: 0.4, tipFringe: 0.6, down: 0.3, barbs: 130, ragged: 0.08, splits: 0.015, sheen: 0.55, roughness: 0.66, glow: 0.3, light: LIGHT, bowed: true },
    tone: (role, k) => (role === "primary" ? smooth((k - 0.38) / 0.45) : 0),
  },
  // A greylag goose: grey-brown, every covert edged pale so the rows read as scallops; grey primaries darkening to
  // their tips.
  goose: {
    flight: { base: "#6c645b", tip: "#3b352f", shaft: "#cfc6b9", edge: "#d9cfbf", edgeAmount: 0.55, tipFringe: 0.6, second: { base: "#8e959b", tip: "#2a2725", blend: [0.35, 0.85] }, down: 0.08, barbs: 210, ragged: 0.05, splits: 0.012, sheen: 0.45, roughness: 0.6, glow: 0.3, light: LIGHT, bowed: true },
    covert: { base: "#7c7064", tip: "#6b5f54", shaft: "#cbbfae", shaftAmount: 0.35, edge: "#e6dccb", edgeAmount: 0.9, tipFringe: 1, second: { base: "#8a9096", tip: "#6f757b" }, down: 0.3, barbs: 130, ragged: 0.08, splits: 0.015, sheen: 0.55, roughness: 0.66, glow: 0.25, light: LIGHT, bowed: true },
    tone: (role, k) => (role === "primary" ? 1 - k * 0.3 : role === "primaryCovert" || role === "alula" ? 1 : role === "lesser" || role === "marginal" ? 0.25 : 0),
  },
  // A kestrel: rufous coverts barred dark, blackish primaries with pale fringes, rufous tertials.
  kestrel: {
    flight: { base: "#3a2d24", tip: "#1d1712", bars: "#5c4838", barring: 7, edge: "#dcc4a0", edgeAmount: 0.45, tipFringe: 0.8, second: { base: "#a2582c", tip: "#7f4324", bars: "#22140b", barring: 5 }, down: 0.08, barbs: 210, ragged: 0.05, splits: 0.012, sheen: 0.45, roughness: 0.6, glow: 0.35, light: LIGHT, bowed: true },
    covert: { base: "#ad5f2f", tip: "#975029", bars: "#28160b", barring: 2.5, edge: "#e6c49a", edgeAmount: 0.3, tipFringe: 0.5, second: { base: "#4a3a2e", tip: "#2b221b", bars: "#6e5848", barring: 2 }, down: 0.3, barbs: 130, ragged: 0.1, splits: 0.02, sheen: 0.55, roughness: 0.66, glow: 0.3, light: LIGHT, bowed: true, shaftAmount: 0.35 },
    tone: (role) => (role === "tertial" || role === "primaryCovert" || role === "alula" ? 1 : 0)
  }
};

type Ik = {
  open: number;
  openSpeed: number;
  openGoal: number;
  sweep: number;
  sweepSpeed: number;
  sweepGoal: number;
  dragging: boolean;
  bone: number;
  t: number;
  offset: THREE.Vector2;
  target: THREE.Vector2;
  // Time into the wingbeat, and how far into it the wings are, from still (0) to beating (1).
  flap: number;
  flapping: number;
  beat: number;
  rouse: number;
  rustle: number;
  creak: number;
  // The shoulder's raise a moment ago, for how fast it is moving.
  raised: number;
  // Raised at the shoulder to reach a pinned tip, sprung.
  lift: number;
  liftSpeed: number;
  liftGoal: number;
  // Where the tip is held while the body is moved, and where it last was.
  pinned: boolean;
  // The wingbeat's fold, twists, bends, rise and sweep, through two stages of damping.
  soft: number[][];
  pin: THREE.Vector3;
  tip: THREE.Vector3;
  epoch: number;
};
const newIk = (): Ik => ({
  open: 0.95,
  openSpeed: 0,
  openGoal: 0.95,
  sweep: 0,
  sweepSpeed: 0,
  sweepGoal: 0,
  dragging: false,
  bone: 2,
  t: 1,
  offset: new THREE.Vector2(),
  target: new THREE.Vector2(),
  flap: 0,
  flapping: 0,
  beat: -1,
  rouse: 99,
  rustle: 0,
  creak: 0,
  raised: 0,
  lift: 0,
  liftSpeed: 0,
  liftGoal: 0,
  pinned: false,
  soft: [new Array(8).fill(0), new Array(8).fill(0)],
  pin: new THREE.Vector3(),
  tip: new THREE.Vector3(),
  epoch: 0
});

export function Wing() {
  const xray = useSetting<boolean>("bones");
  const beating = useSetting<boolean>("flapping");
  const airflow = useSetting<boolean>("airflow");
  const airStyle = useSetting<string>("airStyle");
  const flock = useSetting<number>("flock");
  const slow = useSetting<number>("pace");
  const sky = useSetting<string>("sky");
  const weather = WEATHER[sky] ?? WEATHER.sunset;
  // The key light is the sun, from wherever the weather puts it.
  const key: [number, number, number] = [weather.sun[0] * 5, 0.9 + weather.sun[1] * 5, weather.sun[2] * 5];
  const species = SPECIES[useSetting<string>("species")] ?? SPECIES.gull;
  useLook({ background: "#0c0e11", exposure: 0.85, bloom: 0.08, bloomThreshold: 0.92, haze: 0, vignette: 0.55, gi: 1 });
  const materials = useMemo(() => [featherMaterial(species.flight), featherMaterial(species.covert)], [species]);
  const tissue = useMemo(() => {
    // Where the skin shows between the smallest coverts it is so thick with tiny feathers it reads as their colour.
    const skin = new THREE.MeshPhysicalNodeMaterial({ color: species.covert.tip, roughness: 0.85, sheen: 1, sheenRoughness: 0.5, side: THREE.DoubleSide });
    skin.sheenColor = new THREE.Color(species.covert.edge ?? species.covert.tip);
    // The bones, seen as by x-ray through skin and feathers: bright where their surface turns away, at the edges of
    // each shaft, faint across it, with the grain of the bone in it and the joint ends glossier.
    const bone = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
    const strength = uniform(1);
    const rim = (float(1).sub(abs(dot(normalView, positionViewDirection))) as any).clamp(0, 1);
    const grain = attribute("grain", "vec2") as any;
    const ends = smoothstep(0.07, 0, grain.x).max(smoothstep(0.93, 1, grain.x)) as any;
    const pores = mx_noise_float(positionLocal.mul(900)).mul(0.5).add(0.5) as any;
    const glow = pow(rim, 1.6).mul(2.6).add(0.3).add(ends.mul(0.4)).mul(pores.mul(0.25).add(0.85)) as any;
    bone.colorNode = mix(color("#3f6c96"), color("#e8f6ff"), pow(rim, 1.2)).mul(glow).mul(strength);
    return { skin, bone, strength };
  }, [species]);
  useEffect(
    () => () => {
      materials.forEach((m) => m.material.dispose());
      tissue.skin.dispose();
      tissue.bone.dispose();
    },
    [materials, tissue]
  );
  const iks = useMemo(() => [newIk(), newIk()], []);
  const shown = useRef(1);
  const body = useMemo<Body>(() => ({ offset: new THREE.Vector3(), held: false, epoch: 0, grip: new THREE.Vector3() }), []);
  const neck = useRef<THREE.Group>(null);
  // The lead bird rides the air too, rising and falling as it glides and beats; its whole body, neck and wings together.
  const carried = useRef<THREE.Group>(null);
  const heaveClock = useRef(0);
  const ball = useMemo(() => {
    const material = new THREE.MeshPhysicalNodeMaterial({ color: "#e4ebf2", roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.15, emissive: "#9fc4e8", emissiveIntensity: 0.12 });
    const geometry = new THREE.SphereGeometry(0.03, 48, 32);
    return { material, geometry };
  }, []);
  // The shoulder girdle, drawn in the x-ray: a strut from the neck back to each shoulder.
  const struts = useMemo(
    () =>
      [1, -1].map((side) => {
        const to = new THREE.Vector3(-ROOT.x * side, ROOT.y, ROOT.z).sub(NECK);
        const geometry = boneGeometry(to.length(), (t) => 0.0032 + 0.0035 * bump(t, 0, 0.12) + 0.004 * bump(t, 1, 0.1), (t) => [0.004 * Math.sin(Math.PI * t), 0], 0, 1, 40, 16);
        return { geometry, turn: new THREE.Quaternion().setFromUnitVectors(X, to.normalize()) };
      }),
    []
  );
  useEffect(
    () => () => {
      ball.material.dispose();
      ball.geometry.dispose();
      struts.forEach((strut) => strut.geometry.dispose());
    },
    [ball, struts]
  );
  const unpin = () =>
    iks.forEach((k) => {
      k.pinned = false;
      k.liftGoal = 0;
    });
  const sphere = useMemo(() => new THREE.Sphere(new THREE.Vector3(), 0.07), []);
  // Seconds since anything was last touched or the wings last beat. After a while left alone, the bird settles back
  // into its glide: the body drifts home, the tips let go, and the wings spread as they began.
  const quiet = useRef(0);
  useGrabbable({
    pick: (ray) => {
      // Only there to be grabbed while the skeleton is shown.
      if (!xray) return null;
      sphere.center.copy(NECK).add(body.offset);
      sphere.center.y += carried.current?.position.y ?? 0;
      const hit = ray.intersectSphere(sphere, new THREE.Vector3());
      // Preferred over the wing behind it.
      return hit ? { distance: hit.distanceTo(ray.origin) - 0.5, point: hit } : null;
    },
    grab: (point) => {
      body.grip.copy(point).sub(NECK).sub(body.offset);
      body.held = true;
      body.epoch++;
      sound.play("click", { gain: 0.2, pitch: 0.8, size: 0.2 });
    },
    drag: (point) => {
      body.offset.copy(point).sub(body.grip).sub(NECK).clampLength(0, 0.75);
    },
    release: () => {
      body.held = false;
    }
  });

  useBreeze(new THREE.Vector3(0, 1.1, 0), false);
  const room = useBed("hum", 0.04);
  useEffect(() => {
    if (beating) iks.forEach((k) => ((k.pinned = false), (k.liftGoal = 0), (k.openGoal = Math.max(k.openGoal, 0.9))));
  }, [beating, iks]);
  useSettingAction("rouse", () => {
    iks.forEach((k) => (k.rouse = 0));
    sound.play("brush", { gain: 1.2, pitch: 0.8, size: 0.7 });
  });

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    // Slow motion for everything: the wings, the air and the clouds. Eased so the change is smooth. Speed 1 on the
    // slider is a little under real time, which reads best.
    pace.current += (slow * 0.7 - pace.current) * Math.min(1, delta * 4);
    shown.current += ((xray ? 1 : 0) - shown.current) * Math.min(1, delta * 3);
    tissue.strength.value = shown.current;
    // Hidden outright when off: the post passes would otherwise still darken the sky around them.
    tissue.bone.visible = shown.current > 0.01;
    room.current?.level(0.03 + Math.min(0.08, air.stir * 0.03));
    const busy = body.held || beating || iks.some((k) => k.dragging || k.flapping > 0);
    quiet.current = busy ? 0 : quiet.current + delta;
    if (quiet.current > 5) {
      if (quiet.current - delta <= 5) unpin();
      const ease = Math.min(1, delta * 1.4);
      body.offset.multiplyScalar(1 - ease);
      iks.forEach((k) => {
        k.openGoal += (0.95 - k.openGoal) * ease;
        k.sweepGoal += (0 - k.sweepGoal) * ease;
      });
    }
    heaveClock.current += delta * pace.current;
    if (carried.current) carried.current.position.y = heave(heaveClock.current, iks[0], 0);
    neck.current?.position.copy(NECK).add(body.offset);
    focus.point.set(0, ROOT.y, 0.15).add(body.offset);
    // The lens keeps the clouds sharp.
    focus.blur = 0.05;
  });

  return (
    <>
      <CloudSky weather={sky} />
      <StudioEnvironment
        ambient="#15181d"
        intensity={0.55}
        boxes={[
          // The floor's bounce, so the undersides of the feathers are lit from below as by the ground.
          { position: [0, -2.5, 0], scale: [8, 0.2, 8], color: "#d9cbb8", intensity: 0.6 },
          { position: [-4, 5, 4], scale: [4, 0.2, 3], color: "#fff4e6", intensity: 1.3 },
          { position: [5, 2, 3], scale: [0.2, 3, 2], color: "#cdd9ff", intensity: 0.6 },
          { position: [0, 3, -6], scale: [6, 3, 0.2], color: "#ffe2c4", intensity: 1.1 }
        ]}
      />
      {/* Daylight raking from above and to the left to pick out every edge and row, a cool fill, and light from
          behind through the vanes. */}
      <KeyLight position={key} target={[0, 0.9, -1]} color={weather.sunColour} intensity={(30 + weather.sunPower * 5) * 0.75} angle={0.95} penumbra={0.9} shadowFar={14} />
      {/* The sun itself, without shadows, so the birds of the flock, out of reach of the spots, are lit as the lead is. */}
      <directionalLight position={key} color={weather.sunColour} intensity={1.1} />
      <KeyLight position={[2.6, 1.6, 2.4]} target={[0, 0.8, 0]} color="#c8d6ff" intensity={12} angle={0.5} penumbra={1} shadowFar={12} />
      <KeyLight position={[0.8, 2.6, -2.6]} target={[0, 0.8, 0]} color="#ffd9b0" intensity={30} angle={0.55} penumbra={0.8} shadowFar={12} />
      {/* Low, soft lights near the floor shining up under the wings, as light comes back off the ground. */}
      <KeyLight position={[1.9, 0.12, 1.7]} target={[0, 1, 0]} color="#ffe6cc" intensity={14} angle={0.6} penumbra={1} shadowFar={12} />
      <KeyLight position={[-1.9, 0.12, -1.5]} target={[0, 1, 0]} color="#d6e2ff" intensity={10} angle={0.6} penumbra={1} shadowFar={12} />
      <group ref={carried}>
      <group ref={neck} position={NECK} visible={xray}>
        <mesh geometry={ball.geometry} material={ball.material} castShadow />
        {struts.map((strut, i) => (
          <mesh key={i} geometry={strut.geometry} material={tissue.bone} quaternion={strut.turn} renderOrder={30} layers={OVERLAY_LAYER} />
        ))}
      </group>
      <group rotation-y={Math.PI}>
        <WingSide side={1} ik={iks[0]} body={body} materials={materials} tissue={tissue} tone={species.tone} />
        <WingSide side={-1} ik={iks[1]} body={body} materials={materials} tissue={tissue} tone={species.tone} />
      </group>
      </group>
      <Airflow on={airflow} style={airStyle} />
      {FLOCK.slice(0, Math.max(0, Math.min(Math.round(flock), narrowScreen() ? 3 : 5) - 1)).map((place, i) => (
        <Follower key={i} place={place} materials={materials} tissue={tissue} tone={species.tone} />
      ))}
    </>
  );
}

// How far a bird's body rises and falls: a slow swell on the air while it glides, and in flight a lift on every
// downstroke, highest as the wings reach the bottom and sinking again as they rise.
function heave(time: number, ik: Ik, phase: number) {
  const ride = 0.035 * Math.sin(time * 0.62) + 0.014 * Math.sin(time * 1.37 + 1);
  const beat = smooth(ik.flapping) * 0.035 * -Math.cos(Math.PI * 2 * (ik.flap / BEAT + phase) - 0.5);
  return ride + beat;
}

// Places for the rest of the flock, behind the lead and either side of its line, each with its own beat.
const FLOCK = (() => {
  const random = seeded(23);
  return Array.from({ length: 9 }, (_, i) => {
    const rank = i + 1;
    const side = rank % 2 ? 1 : -1;
    return {
      // A loose V behind the lead: each step out is most of a wingspan to the side and well back, so no two birds'
      // wings can meet however they beat, jostled a little out of true, with some height between neighbours too.
      at: new THREE.Vector3(side * (Math.ceil(rank / 2) * 1.55 + (random() - 0.5) * 0.4), (rank % 4 < 2 ? 0.15 : -0.15) + (random() - 0.5) * 0.25, -(Math.ceil(rank / 2) * 1.15 - 0.15 + (random() - 0.5) * 0.4)),
      phase: random(),
      drift: random() * Math.PI * 2
    };
  });
})();

// One more bird of the flock: the same pair of wings, out of step with the lead, drifting a little about its place.
function Follower({ place, materials, tissue, tone }: { place: (typeof FLOCK)[number]; materials: Feather[]; tissue: { skin: THREE.Material; bone: THREE.Material }; tone: Species["tone"] }) {
  const iks = useMemo(() => [newIk(), newIk()], []);
  const body = useMemo<Body>(() => ({ offset: new THREE.Vector3(), held: false, epoch: 0, grip: new THREE.Vector3() }), []);
  const group = useRef<THREE.Group>(null);
  const clock = useRef(0);
  // While the lead glides, each follower now and then beats its wings for a few strokes, then glides again.
  const bout = useMemo(() => ({ on: place.phase > 0.5, left: 0.5 + place.drift * 0.6 }), [place]);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20) * pace.current;
    clock.current += delta;
    bout.left -= delta;
    if (bout.left <= 0) {
      bout.on = !bout.on;
      bout.left = bout.on ? 3 + Math.random() * 5 : 1.5 + Math.random() * 4;
    }
    const t = clock.current + place.drift;
    group.current?.position.set(place.at.x + Math.sin(t * 0.31) * 0.08, place.at.y + heave(t, iks[0], place.phase) + Math.sin(t * 0.47) * 0.12 + Math.sin(t * 1.1 + place.drift) * 0.05, place.at.z + Math.sin(t * 0.23) * 0.1);
  });
  return (
    <group ref={group} position={place.at}>
      <group rotation-y={Math.PI}>
        <WingSide side={1} ik={iks[0]} body={body} materials={materials} tissue={tissue} tone={tone} lead={false} phase={place.phase} bout={bout} />
        <WingSide side={-1} ik={iks[1]} body={body} materials={materials} tissue={tissue} tone={tone} lead={false} phase={place.phase} bout={bout} />
      </group>
    </group>
  );
}

function WingSide({
  side,
  ik,
  body,
  materials,
  tissue,
  tone,
  lead = true,
  phase = 0,
  bout
}: {
  side: 1 | -1;
  ik: Ik;
  body: Body;
  materials: Feather[];
  tissue: { skin: THREE.Material; bone: THREE.Material };
  tone: Species["tone"];
  // The bird in front: the one that can be handled, is heard, and moves the air. The rest of the flock only follow.
  lead?: boolean;
  // How far out of step with the lead this bird's wingbeat and glide are, as a fraction of a beat.
  phase?: number;
  // A follower's own spells of flapping while the lead glides.
  bout?: { on: boolean };
}) {
  const beating = useSetting<boolean>("flapping");
  const plan = useMemo(layout, []);
  const meshes = useMemo(
    () =>
      KINDS.map((kind, k) => {
        const count = plan.counts[k];
        const geometry = featherGeometry(kind.outline, kind.segs[0], kind.segs[1]);
        const tones = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
        const bow = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
        bow.setUsage(THREE.DynamicDrawUsage);
        for (const p of plan.plumes) if (p.kind === k) tones.setXY(p.slot, tone(p.role, p.k), p.seed);
        geometry.setAttribute("tone", tones);
        geometry.setAttribute("bow", bow);
        const mesh = new THREE.InstancedMesh(geometry, materials[kind.material].material, count);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        return { mesh, bow };
      }),
    [plan, materials, tone]
  );
  const arm = useMemo(() => {
    const built = buildArm(tissue.skin, tissue.bone);
    // Only the lead is x-rayed; the rest of the flock never shows its bones.
    if (!lead) built.skin.traverse((part) => {
      if ((part as THREE.Mesh).material === tissue.bone) part.visible = false;
    });
    return built;
  }, [tissue, lead]);
  useEffect(
    () => () => {
      meshes.forEach(({ mesh }) => mesh.geometry.dispose());
      arm.dispose();
    },
    [meshes, arm]
  );

  const wing = useRef<THREE.Group>(null);
  const pose = useMemo(newPose, []);
  const trial = useMemo(newPose, []);
  const work = useMemo(
    () => ({
      mirror: new THREE.Matrix4(),
      wrist: new THREE.Vector3(),
      a3: new THREE.Vector3(),
      b3: new THREE.Vector3(),
      frames: [0, 1, 2].map(() => new THREE.Quaternion()),
      root: new THREE.Matrix4(),
      shoulder: new THREE.Vector3(),
      still: new THREE.Quaternion(),
      flip: new THREE.Vector3(side, 1, 1),
      frame: new THREE.Matrix4(),
      placed: new THREE.Matrix4(),
      local: new THREE.Matrix4(),
      inverse: new THREE.Matrix4(),
      instance: new THREE.Matrix4(),
      turn: new THREE.Quaternion(),
      spin: new THREE.Quaternion(),
      feather: new THREE.Quaternion(),
      euler: new THREE.Euler(0, 0, 0, "ZXY"),
      at: new THREE.Vector3(),
      mid: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      wind: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 0, 1),
      facing: new THREE.Vector3(),
      across: new THREE.Vector3(),
      size: new THREE.Vector3(),
      zero: new THREE.Vector3(),
      one: new THREE.Vector3(1, 1, 1),
      probe: new THREE.Vector3(),
      plane: new THREE.Plane(),
      hit: new THREE.Vector3(),
      point: new THREE.Vector2(),
      a: new THREE.Vector2(),
      b: new THREE.Vector2(),
      held: new THREE.Vector3()
    }),
    [side]
  );

  const toWing = (point: THREE.Vector3, out: THREE.Vector2) => {
    work.probe.copy(point).applyMatrix4(work.inverse);
    return out.set(work.probe.x, work.probe.y);
  };
  const segment = (p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const t = THREE.MathUtils.clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / Math.max(abx * abx + aby * aby, 1e-9), 0, 1);
    return { t, distance: Math.hypot(a.x + abx * t - p.x, a.y + aby * t - p.y) };
  };

  useGrabbable({
    pick: (ray) => {
      if (!lead) return null;
      work.plane.setFromNormalAndCoplanarPoint(work.normal, work.probe.setFromMatrixPosition(work.placed));
      if (!ray.intersectPlane(work.plane, work.hit)) return null;
      const p = toWing(work.hit, work.point);
      const touching = plan.plumes.some((q) => segment(p, q.base, q.tip).distance < 0.015 + q.length * 0.07);
      return touching ? { distance: work.hit.distanceTo(ray.origin), point: work.hit.clone() } : null;
    },
    grab: (point) => {
      const p = toWing(point, work.point);
      // Held by the nearest point of bone; at the shoulder that would only turn the wing, so lean toward the hand.
      let best = Infinity;
      for (let b = 0; b < 3; b++) {
        const hit = segment(p, work.a.set(pose.joints[b].x, pose.joints[b].y), work.b.set(pose.joints[b + 1].x, pose.joints[b + 1].y));
        if (hit.distance < best) {
          best = hit.distance;
          ik.bone = b;
          ik.t = hit.t;
        }
      }
      if (ik.bone === 0 && ik.t < 0.6) ik.t = 0.6;
      along(pose, ik.bone, ik.t, 0, 0, work.held);
      ik.offset.set(p.x - work.held.x, p.y - work.held.y);
      ik.target.set(work.held.x, work.held.y);
      ik.dragging = true;
      ik.pinned = false;
      ik.liftGoal = ik.lift;
      if (lead) sound.play("brush", { gain: 0.6, pitch: 0.9, size: 0.4, pan: side * 0.4 });
    },
    drag: (point) => {
      toWing(point, ik.target).sub(ik.offset);
    },
    release: () => {
      ik.dragging = false;
    }
  });
  const root = useRef<THREE.Group>(null);

  const clock = useRef(0);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20) * pace.current;
    // The wing's own clock, slowed with everything else in slow motion.
    clock.current += delta;
    const time = clock.current + phase * 9;
    const k = ik;

    // The shoulder goes where the body is carried; the pair is turned about, so the carry is too.
    work.shoulder.set(ROOT.x * side - body.offset.x, ROOT.y + body.offset.y, ROOT.z - body.offset.z);
    root.current?.position.copy(work.shoulder);
    work.mirror.copy(HEADING).multiply(work.root.compose(work.shoulder, work.still, work.flip));
    // Picking up the body pins the tip where it is.
    if (body.epoch !== k.epoch) {
      k.epoch = body.epoch;
      k.pinned = true;
      k.pin.copy(k.tip);
    }
    // A pinned tip, seen from the shoulder before the wing is raised: how far to raise the wing to bring the tip's
    // plane round to it, and then where it lies in that plane.
    if (k.pinned && !k.dragging) {
      work.frame.multiplyMatrices(work.mirror, work.local.compose(work.zero, BEARING, work.one)).invert();
      work.held.copy(k.pin).applyMatrix4(work.frame);
      k.liftGoal = THREE.MathUtils.clamp(Math.atan2(work.held.z, work.held.x), -1.15, 1.25);
      k.bone = 2;
      k.t = 1;
      k.target.set(Math.hypot(work.held.x, work.held.z), work.held.y);
    }

    // Inverse kinematics: the opening that puts the held point at the cursor's distance from the shoulder, and the
    // sweep that turns it onto the cursor. The joints follow, sprung, as muscle would move them.
    if (k.dragging || k.pinned) {
      const reach = k.target.length();
      let bestCost = Infinity;
      let bestOpen = k.openGoal;
      let bestAngle = 0;
      trial.lift.fill(0);
      trial.twist.fill(0);
      for (let i = 0; i <= 64; i++) {
        const open = i / 64;
        along(solve(open, 0, trial), k.bone, k.t, 0, 0, work.held);
        const cost = Math.abs(Math.hypot(work.held.x, work.held.y) - reach) + 0.015 * Math.abs(open - k.openGoal);
        if (cost < bestCost) {
          bestCost = cost;
          bestOpen = open;
          bestAngle = Math.atan2(work.held.y, work.held.x);
        }
      }
      k.openGoal = bestOpen;
      k.sweepGoal = THREE.MathUtils.clamp(wrap(Math.atan2(k.target.y, k.target.x) - bestAngle), deg(-40), deg(32));
    }
    // Stiffer while the body is carried, so the wings answer the hand at once: up, and they swing down; down, and they
    // come straight back up.
    const stiffness = body.held ? 520 : 130;
    const damping = 2 * Math.sqrt(stiffness);
    const was = k.open;
    k.openSpeed += ((k.openGoal - k.open) * stiffness - k.openSpeed * damping) * delta;
    k.open = THREE.MathUtils.clamp(k.open + k.openSpeed * delta, 0, 1);
    k.sweepSpeed += ((k.sweepGoal - k.sweep) * stiffness - k.sweepSpeed * damping) * delta;
    k.sweep += k.sweepSpeed * delta;
    k.liftSpeed += ((k.liftGoal - k.lift) * stiffness - k.liftSpeed * damping) * delta;
    k.lift += k.liftSpeed * delta;

    // The wingbeat, running for as long as it is switched on, eased in and out.
    k.flapping = THREE.MathUtils.clamp(k.flapping + (beating || bout?.on ? delta : -delta) * 1.6, 0, 1);
    if (k.flapping > 0) k.flap += delta;
    else {
      k.flap = 0;
      k.beat = -1;
    }
    let raise = Math.sin(time * 0.55) * 0.012 + k.lift;
    let sweep = 0;
    let tuck = 0;
    let armTwist = 0;
    let handTwist = 0;
    let armLift = 0;
    let foreLift = 0;
    let handLift = 0;
    let envelope = 0;
    if (k.flapping > 0) {
      envelope = smooth(k.flapping);
      const s = stroke(k.flap / BEAT + phase);
      // Every part of the stroke, the rise and fall as well as the fold, twists and bends, follows it through two
      // stages of damping, as muscle and tendon would: each eases into its motion and out of it, so down, bend and up
      // run into one another without a corner anywhere.
      const follow = 1 - Math.exp(-delta * 11);
      const goal = [s.tuck, s.twist, s.handTwist, s.armLift, s.foreLift, s.handLift, s.raise, s.sweep];
      const [first, second] = k.soft;
      goal.forEach((g, i) => {
        first[i] += (g - first[i]) * follow;
        second[i] += (first[i] - second[i]) * follow;
      });
      tuck = envelope * second[0];
      armTwist = envelope * second[1];
      handTwist = envelope * second[2];
      armLift = envelope * second[3];
      foreLift = envelope * second[4];
      handLift = envelope * second[5];
      raise += envelope * second[6];
      sweep = envelope * second[7];
      // Heard three quarters of the way down the stroke: a third of the way through the beat, and a little after, as
      // the damped wing lags the stroke.
      const beat = Math.floor(k.flap / BEAT - 0.46);
      if (beat !== k.beat && envelope > 0.5) {
        k.beat = beat;
        // One sound a wingbeat, for the pair.
        if (side === 1 && lead) sound.play("brush", { gain: 1.4, pitch: (0.75 + Math.random() * 0.1) * (0.55 + 0.45 * pace.current), size: 0.8 });
      }
    }
    // Gliding when it is not beating: the wings ride the air, rising and settling a little on a slow swell, the hand a
    // beat behind the arm, and the pair banking a touch now and then.
    const gliding = (1 - envelope) * smooth(k.open) * (k.pinned ? 0 : 1);
    const swell = time * 0.9;
    // Gusts: a slow swell, a quicker chop on top, and the odd sharper bump, each wing a little out of step with the other.
    const gust = Math.sin(time * 2.1 + side * 0.7) * Math.sin(time * 0.53) + 0.6 * Math.max(0, Math.sin(time * 1.3 + side)) ** 6;
    raise += gliding * (0.16 * Math.sin(swell) + 0.05 * Math.sin(swell * 2.3 + 1) + 0.04 * gust + 0.06 * Math.sin(time * 0.37) * side);
    armTwist += gliding * (0.07 * Math.cos(swell) + 0.03 * gust);
    // The bend at elbow and wrist never straightens out: it breathes between a little more and a little less than its
    // rest, a beat behind the rise and fall.
    const flex = Math.max(0.8, 1 + gliding * (0.32 * Math.sin(swell - 0.7) + 0.12 * gust));
    // Forearm and hand trail the shoulder as it rises, hanging back below the line of the arm, the hand most.
    const rate = (raise - k.raised) / Math.max(delta, 1e-3);
    k.raised = raise;
    const trail = Math.max(0, rate) * (1 - envelope);
    // Spread, a gull's wing is never flat: the arm angles up from the body, the forearm runs level and the hand droops,
    // the M seen from in front. In flapping flight the wingbeat sets the bend instead.
    const held = smooth(k.open) * (1 - envelope * 0.8);
    // As the wing folds in, forearm and hand come to lie flat on one another: their bends and twists out of the wing's
    // plane fade with the fold, so the two halves close like a fan rather than opening like a book.
    const flat = 0.15 + 0.85 * THREE.MathUtils.smoothstep(k.open - tuck, 0.35, 0.9);
    pose.lift[0] = held * 0.3 * flex + armLift;
    pose.lift[1] = (held * -0.16 * flex + foreLift - Math.min(0.3, trail * 0.04)) * flat;
    pose.lift[2] = (held * -0.24 * flex + handLift - Math.min(0.5, trail * 0.07)) * flat;
    pose.twist[0] = armTwist * 0.5;
    pose.twist[1] = armTwist * 0.5 * flat;
    pose.twist[2] = handTwist * flat;
    // A shake runs out along the arm when it rouses.
    k.rouse += delta;
    const shake = k.rouse < 1.2 ? Math.sin(k.rouse * 38) * 0.035 * Math.exp(-k.rouse * 3.5) : 0;
    const open = Math.max(0, k.open - tuck);
    solve(open, k.sweep + sweep + shake + Math.sin(time * 0.4 + side) * 0.008, pose);
    arm.pose(pose);

    // Folding fast is heard.
    k.creak -= delta;
    const folding = Math.abs(k.open - was) / Math.max(delta, 1e-3);
    if (folding > 0.9 && k.creak <= 0 && envelope === 0 && !body.held) {
      k.creak = 0.4;
      if (lead) sound.play("brush", { gain: Math.min(0.9, folding * 0.3), pitch: 0.7 + open * 0.3, size: 0.5, pan: side * 0.4, gap: 0.3 });
    }

    // The whole wing raised at the shoulder, about the line of the body.
    work.turn.copy(BEARING).multiply(work.spin.setFromAxisAngle(Y, -raise));
    wing.current?.quaternion.copy(work.turn);
    // Where the wing is in the world, and how hard it is lifting, for the air: a little in a glide, much more as it
    // beats down, almost nothing on the flexed upstroke.
    if (wing.current && lead) {
      wing.current.updateWorldMatrix(true, false);
      const lifting = flow.wings[side === 1 ? 0 : 1];
      const wristWas = work.wrist.copy(lifting.points[2]);
      pose.joints.forEach((joint, j) => lifting.points[j].copy(joint).applyMatrix4(wing.current!.matrixWorld));
      // Up off the wing, and back along it toward the trailing edge, taken across the forearm.
      lifting.up.copy(Z).applyQuaternion(pose.turns[1]).transformDirection(wing.current.matrixWorld);
      lifting.back.set(0, -1, 0).applyQuaternion(pose.turns[1]).transformDirection(wing.current.matrixWorld);
      const sinking = lifting.ready ? (wristWas.y - lifting.points[2].y) / Math.max(delta, 1e-3) : 0;
      const goal = smooth(k.open) * (0.28 * (1 - envelope) + envelope * THREE.MathUtils.clamp(0.1 + sinking * 0.6, 0, 1.3));
      lifting.gamma += (goal - lifting.gamma) * Math.min(1, delta * 10);
      lifting.ready = true;
    }
    const placed = work.placed.multiplyMatrices(work.mirror, work.local.compose(work.zero, work.turn, work.one));
    work.inverse.copy(placed).invert();
    work.normal.copy(Z).transformDirection(placed);
    along(pose, 2, 1, 0, 0, k.tip).applyMatrix4(placed);

    let energy = 0;
    const rel = work.velocity;
    // Each bone's frame with its turn in the wing's plane taken out, so that frames can be blended across a joint.
    for (let b = 0; b < 3; b++) work.frames[b].copy(pose.turns[b]).multiply(work.spin.setFromAxisAngle(Z, -pose.angles[b]));
    for (const p of plan.plumes) p.heading = pose.sweep + THREE.MathUtils.lerp(p.shut, p.open, p.web ? pose.reach[1] : pose.reach[p.bone]);
    // Along the chain of flight feathers, no two neighbours more than a few degrees apart, worked from both ends so
    // the fan closes evenly: as the hand folds back the primaries draw in after the secondaries rather than leaving a
    // wedge of open sky between them.
    const most = deg(10);
    const chain = plan.chain;
    for (let i = 1; i < chain.length; i++) chain[i].heading = THREE.MathUtils.clamp(chain[i].heading, chain[i - 1].heading - most, chain[i - 1].heading + most);
    for (let i = chain.length - 2; i >= 0; i--) chain[i].heading = THREE.MathUtils.clamp(chain[i].heading, chain[i + 1].heading - most, chain[i + 1].heading + most);
    for (const p of plan.plumes) {
      const heading = p.heading;
      // Folded, the flight feathers stack deeper, and the hand and all it carries tuck under the forearm.
      // The layers lie close on one another, as on a real wing, only a centimetre or so deep in all when spread.
      // Coverts lie over the skin, not through it: lifted by the arm's thickness where they grow, less toward the back of
      // the web where it thins. Flight feathers keep to the bone, rooted in it.
      // Coverts are rooted in the skin: on the web, on its domed surface, each row a hair above the one behind; on a
      // bone, on top of the arm. Flight feathers keep to the bone, rooted in it.
      let z: number;
      // On the web, the steepest a covert may dip and still clear the skin under it: checked at points along its length
      // against the dome beneath them, allowing for the feather's own downward curve. It rests there and can only lift
      // away; nothing the air does pushes it through.
      let floor = Infinity;
      if (p.web) {
        const [u, v] = p.web;
        const surface = membraneHeight(u, v);
        // Clear of the skin across the vane too, not only along the shaft: each covert is turned a little about its shaft,
        // and the vane's lower edge must stay above the skin however the air turns it.
        const halfWidth = KINDS[p.kind].outline.width * p.length * 0.5;
        const clearance = 0.0012 + p.z * 0.1 + halfWidth * Math.sin(0.28) + 0.0008;
        // Underneath, the same, mirrored: hung below the underside of the web.
        z = p.under ? membraneUnder(u, v) - clearance : surface + clearance;
        // How far the skin it lies against stands off it, above or below.
        const skin = (at: number) => (p.under ? -membraneUnder(u, at) : membraneHeight(u, at));
        const base = skin(v);
        web(pose, u, 0, 0, work.a3);
        web(pose, u, 1, 0, work.b3);
        const chord = Math.max(0.01, Math.hypot(work.b3.x - work.a3.x, work.b3.y - work.a3.y));
        const toward = (Math.cos(heading) * (work.b3.x - work.a3.x) + Math.sin(heading) * (work.b3.y - work.a3.y)) / chord;
        const arch = KINDS[p.kind].outline.arch ?? 0;
        let need = -Infinity;
        for (const f of [0.25, 0.5, 0.75, 1]) {
          const reachOut = p.length * f;
          const there = skin(THREE.MathUtils.clamp(v + (reachOut * toward) / chord, 0, 1));
          need = Math.max(need, Math.atan2(there - base + arch * p.length * f * f + 0.001, reachOut));
        }
        floor = -need;
      } else {
        const over = p.kind <= 1 ? 0 : girth(p.bone + p.t)[2] * 0.9 + 0.0015 + p.z * 0.15;
        z = over;
        // Coverts on the arm lie on it and the flight feathers behind; they too can lift but not sink.
        if (p.kind > 1) floor = 0;
      }
      // Each flight feather a hair under the one before it, never more: the whole stack, tertials to the outermost
      // primary, is about a centimetre deep, so hand and forearm lie together as one sheet, folded or spread. Folded
      // at rest, the hand's slip a few millimetres further under the forearm's.
      const folded = 1 - THREE.MathUtils.smoothstep(k.open, 0.25, 0.75);
      z -= p.order * (0.00025 + 0.0001 * folded) + (!p.web && p.bone === 2 ? 0.003 * folded : 0);
      // Each feather is carried by its bone, or, on the web, by the bone beneath that part of it.
      const bone = p.web ? (p.web[0] < ELBOW ? 0 : 1) : p.bone;
      if (p.web) web(pose, p.web[0], p.web[1], z, work.at);
      else along(pose, p.bone, p.t, p.side, z, work.at);
      p.base.set(work.at.x, work.at.y);
      p.tip.set(Math.cos(heading), Math.sin(heading)).multiplyScalar(p.length * 0.9).add(p.base);
      // Turned to its heading in the frame of the bone it grows on. Near a joint the frame is blended half way to the
      // next bone's, as the skin is, so where the arm bends out of the wing's plane the feathers on either side of the
      // joint still lie together rather than splitting into two sheets.
      const t = p.web ? (bone === 0 ? p.web[0] / ELBOW : (p.web[0] - ELBOW) / (1 - ELBOW)) : p.t;
      work.feather.copy(work.frames[bone]);
      // Blended over most of each bone, not only near the joint, so that however the hand turns against the forearm the
      // feathers fan smoothly from one to the other with no gap between them.
      // Every bone pulls, by how near along the span it is, so the whole wing bends as one smooth sheet: however the
      // hand turns against the forearm, the feathers between them morph from one to the other with no gap.
      // The fold widens it: folded in, every feather takes much the same frame, and the wing is one closed sheet.
      const reachWidth = 0.75 + 1.8 * (1 - pose.reach[2]);
      const near = (b: number) => Math.exp(-(((bone + t - (b + 0.5)) / reachWidth) ** 2));
      let weight = near(0);
      work.feather.copy(work.frames[0]);
      for (let b = 1; b < 3; b++) {
        weight += near(b);
        work.feather.slerp(work.frames[b], near(b) / weight);
      }
      work.feather.multiply(work.spin.setFromAxisAngle(Z, heading));

      // The air on it, about its middle, against how it is moving: what blows through the vane lifts and bends it,
      // what blows across it twists it.
      work.mid.set(0, p.length * 0.55, 0).applyQuaternion(work.spin.setFromAxisAngle(Z, -Math.PI / 2).premultiply(work.feather)).add(work.at).applyMatrix4(placed);
      windAt(work.mid, work.wind);
      if (p.fresh) {
        rel.set(0, 0, 0);
        p.fresh = false;
      } else rel.subVectors(work.mid, p.last).divideScalar(Math.max(delta, 1e-3));
      p.last.copy(work.mid);
      rel.multiplyScalar(-0.3).add(work.wind).clampLength(0, 4);
      work.facing.copy(Z).applyQuaternion(work.feather).transformDirection(placed);
      work.across.copy(Y).applyQuaternion(work.feather).transformDirection(placed);
      const through = rel.dot(work.facing) * p.give * (0.75 + p.seed * 0.5);
      const sideways = rel.dot(work.across) * p.give;
      const stiff = p.kind <= 1 ? 110 : 70;
      p.liftSpeed += (-p.lift * stiff - p.liftSpeed * 8 + through * 20) * delta;
      p.twistSpeed += (-p.twist * 70 - p.twistSpeed * 7 + sideways * 9) * delta;
      p.bowSpeed += (-p.bow * 140 - p.bowSpeed * 11 + through * (p.kind <= 1 ? 16 : 6)) * delta;
      if (k.rouse < 1.2) {
        // The rouse reaches each feather in turn, from the root outward.
        const reachAt = 0.1 + Math.max(0, work.at.x) * 0.4;
        if (k.rouse - delta < reachAt && k.rouse >= reachAt) {
          p.liftSpeed += (2 + p.seed * 5) * p.give;
          p.twistSpeed += (p.seed - 0.5) * 9 * p.give;
        }
      }
      // Feathers rest on those beneath them and are held down by those above: a covert can ruffle, not stand up through
      // the row over it, and none can turn far enough to cut through its neighbours.
      p.lift = THREE.MathUtils.clamp(p.lift + p.liftSpeed * delta, p.kind <= 1 ? -0.06 : -0.02, p.kind <= 1 ? 0.4 : 0.22);
      p.twist = THREE.MathUtils.clamp(p.twist + p.twistSpeed * delta, -0.22, 0.22);
      p.bow = THREE.MathUtils.clamp(p.bow + p.bowSpeed * delta, -0.22, 0.22);
      energy += Math.abs(p.liftSpeed) + Math.abs(p.twistSpeed) * 0.4;

      const dip = p.roll + p.twist + (p.seed - 0.5) * 0.04;
      // Lying on the skin, lifted only by what the air does to it.
      const pitch = Number.isFinite(floor) ? floor + Math.min(0, dip) : dip;
      // Turned about its shaft, never so far that the vane's edge could reach down through what it lies on.
      // An underwing covert is turned over about its shaft, which mirrors everything else about it too.
      const turn = (p.kind > 1 ? THREE.MathUtils.clamp(p.rest + p.lift, -0.28, 0.28) : p.rest + p.lift) + (p.under ? Math.PI : 0);
      work.euler.set(turn, pitch, -Math.PI / 2);
      work.feather.multiply(work.spin.setFromEuler(work.euler));
      work.size.setScalar(p.length);
      const { mesh, bow } = meshes[p.kind];
      mesh.setMatrixAt(p.slot, work.instance.compose(work.at, work.feather, work.size));
      bow.setXY(p.slot, p.bow, -p.twist * 0.4);
    }
    for (const { mesh, bow } of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      bow.needsUpdate = true;
    }

    // Brushing many feathers is still only a few sounds a second, shared by both wings, louder the more they move.
    k.rustle -= delta;
    if (energy > 160 && k.rustle <= 0 && k.flapping === 0 && !body.held) {
      k.rustle = 0.35;
      if (lead) sound.play("brush", { gain: Math.min(1, energy * 0.002), pitch: 0.95 + Math.random() * 0.2, size: 0.3, pan: side * (0.2 + Math.random() * 0.4), gap: 0.28 });
    }
  });

  // Mirrored for the left wing; inside, everything is laid out as for the right.
  return (
    <group ref={root} position={[ROOT.x * side, ROOT.y, ROOT.z]} scale={[side, 1, 1]}>
      <group ref={wing}>
        {meshes.map(({ mesh }) => (
          <primitive key={mesh.uuid} object={mesh} />
        ))}
        <primitive object={arm.skin} />
        <primitive object={arm.membrane} />
      </group>
    </group>
  );
}
