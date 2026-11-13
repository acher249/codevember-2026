import * as THREE from "three/webgpu";
import {
  abs,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cos,
  float,
  max,
  min,
  modelWorldMatrix,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  velocity
} from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The world bent out of true around the eye. Every surface is lit, shadowed and misted where it really lies, on flat
// ground, and only drawn somewhere else: each point is carried, relative to the eye, to where the bent world puts it, at
// the last step before the screen. So the bend goes wherever the camera goes, flying or walking, without end, and the
// shadow pass, which draws with a material of its own, keeps to the flat world its shadows are looked up in.
export type Study = "flat" | "ring" | "fold" | "twist";
export const STUDIES: { value: Study; label: string }[] = [
  { value: "flat", label: "Flat" },
  { value: "ring", label: "Ring" },
  { value: "fold", label: "Fold" },
  { value: "twist", label: "Twist" }
];

// Ring: the maze runs round the inside of a hoop, eight copies of it round, so where the two ends meet overhead the maze
// carries straight on. It is a band, open to the sky on either side.
const RING_RADIUS = (8 * 108) / (2 * Math.PI);
const RING_HALF_WIDTH = 34;
// Fold: all round, past a rounded square about the eye, the maze turns up a hinge into walls that meet at the corners,
// and at their tops turns again into a lip reaching in overhead, leaving the sky open in the middle.
const FOLD_AT = 44;
const FOLD_HINGE = 8;
const FOLD_WALL = 20;
const FOLD_LIP = 12;
const FOLD_END = FOLD_AT + Math.PI * FOLD_HINGE + FOLD_WALL + FOLD_LIP;
// Twist: the maze turns over about the line of sight, half a turn every this many metres north or south, a ribbon.
const TWIST_HALF_TURN = 70;
const TWIST_HALF_WIDTH = 40;
const TWIST_REACH = 160;

// How far each study has come in, 0 to 1, and where the eye is, both now and a frame ago for the motion vectors.
export const warp = {
  ring: uniform(0),
  fold: uniform(0),
  twist: uniform(0),
  viewer: uniform(new THREE.Vector3()),
  before: uniform(new THREE.Vector3())
};
const studyIn: Record<Exclude<Study, "flat">, number> = { ring: 0, fold: 0, twist: 0 };

// Eases each study in or out, slowly enough to watch the world bend.
// How long one world takes to bend into another.
const BEND_SECONDS = 4.5;
export function stepStudies(study: Study, delta: number) {
  for (const key of Object.keys(studyIn) as (keyof typeof studyIn)[]) {
    const to = key === study ? 1 : 0;
    const now = studyIn[key];
    studyIn[key] = now + Math.sign(to - now) * Math.min(Math.abs(to - now), delta / BEND_SECONDS);
    const t = studyIn[key];
    warp[key].value = t * t * t * (t * (t * 6 - 15) + 10);
  }
}

// The eye is read as each frame is drawn from it, after the camera has moved, and not when the sun draws its shadows.
let eye: THREE.Camera | null = null;
let frameSeen = -1;
export function trackViewer(camera: THREE.Camera) {
  eye = camera;
}
warp.viewer.onRenderUpdate((frame: any) => {
  if (!eye || frame.camera !== eye) return;
  if (frame.frameId !== frameSeen) {
    frameSeen = frame.frameId;
    warp.before.value.copy(warp.viewer.value);
  }
  warp.viewer.value.setFromMatrixPosition(eye.matrixWorld);
});

// How far out a study reaches as it comes in: from far off down to its own size, at `power` of how far in it is.
const reachOf = (amount: any, size: number, power: number): any => float(size).div(pow(amount.max(1e-3), power));

// Where a point on the flat world is drawn, seen from `v`.
const bent = (input: any, v: any): any => {
  let p = input;
  // Fold: outward from the eye, by a measure whose level lines are rounded squares, the ground is a line that turns up
  // through a quarter circle, runs straight up, and turns over again. `s` is how far out along it a point lies, and `p.y`
  // how far it stands off it. Each rounded square is drawn smaller or larger as the line carries it in or out, so the
  // four walls meet round the corners.
  // Where each study ends, the world is gathered in to its edge and what stands on it sinks into the ground over the last
  // few metres, rather than being cut off, so that an edge comes in smoothly from far off as its study does.
  const sides = min(reachOf(warp.ring, RING_HALF_WIDTH, 2), reachOf(warp.twist, TWIST_HALF_WIDTH, 2)) as any;
  // Never past the maze drawn, 450 metres either way.
  const ends = min(min(reachOf(warp.ring, Math.PI * RING_RADIUS, 1), reachOf(warp.twist, TWIST_REACH, 1)), 440) as any;
  const ex = clamp(p.x.sub(v.x), sides.negate(), sides) as any;
  const ez = clamp(p.z.sub(v.z), ends.negate(), ends) as any;
  const round = reachOf(warp.fold, FOLD_END, 1) as any;
  const far = max(max(abs(ex), abs(ez)), 1e-4) as any;
  const level = far.mul(pow(pow(abs(ex).div(far), 4).add(pow(abs(ez).div(far), 4)), 0.25)) as any;
  const inward = min(round.div(level), 1) as any;
  const dx = ex.mul(inward) as any;
  const dz = ez.mul(inward) as any;
  const sink = smoothstep(0, 5, sides.sub(abs(dx)))
    .mul(smoothstep(0, 5, ends.sub(abs(dz))))
    .mul(smoothstep(0, 5, round.sub(level))) as any;
  p = vec3(p.x, p.y.mul(sink), p.z);
  const most = max(max(abs(dx), abs(dz)), 1e-4) as any;
  const ux = dx.div(most) as any;
  const uz = dz.div(most) as any;
  const s = most.mul(pow(ux.mul(ux).mul(ux.mul(ux)).add(uz.mul(uz).mul(uz.mul(uz))), 0.25)) as any;
  const turn = warp.fold.mul(Math.PI / 2) as any;
  const r = float(FOLD_HINGE);
  const flat = min(s, float(FOLD_AT)) as any;
  const first = clamp(s.sub(FOLD_AT), 0, r.mul(turn)).div(r) as any;
  const second0 = r.mul(turn).add(FOLD_AT + FOLD_WALL) as any;
  const wall = clamp(s.sub(r.mul(turn)).sub(FOLD_AT), 0, FOLD_WALL) as any;
  const second = clamp(s.sub(second0), 0, r.mul(turn)).div(r) as any;
  const last = max(s.sub(second0).sub(r.mul(turn)), 0) as any;
  // Each piece's run outward and rise, the second hinge turned by the first.
  const arcF = r.mul(sin(first)).add(r.mul(sin(turn.add(second)).sub(sin(turn)))) as any;
  const arcU = r.mul(float(1).sub(cos(first))).add(r.mul(cos(turn).sub(cos(turn.add(second))))) as any;
  const angle = first.add(second) as any;
  const along = flat.add(arcF).add(wall.mul(cos(turn))).add(last.mul(cos(turn.mul(2)))) as any;
  const rise = arcU.add(wall.mul(sin(turn))).add(last.mul(sin(turn.mul(2)))) as any;
  // What stands off the ground leans in square to the rounded square it is on.
  const out = normalize(vec2(ux.mul(ux).mul(ux), uz.mul(uz).mul(uz)).add(vec2(1e-6, 0))) as any;
  const scale = along.div(max(s, 1e-4)) as any;
  const lean = p.y.mul(sin(angle)) as any;
  let q: any = vec3(v.x.add(dx.mul(scale)).sub(out.x.mul(lean)), rise.add(p.y.mul(cos(angle))), v.z.add(dz.mul(scale)).sub(out.y.mul(lean)));

  // Ring: the ground wrapped round a hoop whose axis runs east to west, high over the eye.
  // Over short arcs sine is worked out from its series, as the GPU's own is too rough there to divide by the angle.
  const ahead = q.z.sub(v.z) as any;
  const theta = ahead.mul(warp.ring.div(RING_RADIUS)) as any;
  const small = abs(theta).lessThan(0.02) as any;
  const t2 = theta.mul(theta) as any;
  const sinc = select(small, float(1).sub(t2.div(6)), sin(theta).div(theta)) as any;
  const versinc = select(small, float(0.5).sub(t2.div(24)), float(1).sub(cos(theta)).div(t2)) as any;
  q = vec3(q.x, q.y.mul(cos(theta)).add(ahead.mul(theta).mul(versinc)), v.z.add(ahead.mul(sinc)).sub(q.y.mul(sin(theta))));

  // Twist: turned about the line north through the eye, further the further off.
  const alpha = q.z.sub(v.z).mul(warp.twist.mul(Math.PI / TWIST_HALF_TURN)) as any;
  const tx = q.x.sub(v.x) as any;
  const ty = q.y.sub(v.y) as any;
  return vec3(v.x.add(tx.mul(cos(alpha))).sub(ty.mul(sin(alpha))), v.y.add(tx.mul(sin(alpha))).add(ty.mul(cos(alpha))), q.z);
};

// Where a surface is drawn, for the mist, which lies in the air between the eye and what it sees.
export const drawn = varying(bent(positionWorld, warp.viewer), "vDrawn") as any;

// Every labyrinth material but the sky's is drawn through the bend, from `made`, all the time: flat, it carries every
// point to where it already is, so that a study comes in or goes out with no shader built anew.
const bending = new WeakSet<THREE.NodeMaterial>();
export function bend(material: THREE.NodeMaterial) {
  bending.add(material);
  (material as any).setupModelViewProjection = () => cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(bent(modelWorldMatrix.mul(positionLocal).xyz, warp.viewer), 1));
}

// Motion bent too, worked out at the corners, so that the temporal filter follows what is drawn.
const motion = velocity as any;
if (!motion.__bent) {
  motion.__bent = true;
  const setup = motion.setup;
  motion.setup = function (this: any, builder: any) {
    if (!bending.has(builder.material)) return setup.call(this, builder);
    const now = varying(this.currentProjectionMatrix.mul(cameraViewMatrix).mul(vec4(bent(positionWorld, warp.viewer), 1)), "vNow") as any;
    const then = varying(this.previousProjectionMatrix.mul(this.previousCameraViewMatrix).mul(vec4(bent(positionWorld, warp.before), 1)), "vThen") as any;
    return now.xy.div(now.w).sub(then.xy.div(then.w));
  };
}

// The stretch of maze beyond the usual reach that the bent world brings into view, as metres east-west either side of
// the eye and north and south of it, or null when nothing is bent that far.
export function farReach() {
  let side = 0;
  let north = 0;
  let south = 0;
  const on = (w: number) => w > 0.002;
  if (on(warp.ring.value)) {
    const half = Math.min(RING_HALF_WIDTH / warp.ring.value ** 2, 140);
    const round = Math.min((Math.PI * RING_RADIUS) / warp.ring.value, 450);
    side = Math.max(side, half);
    north = Math.max(north, round);
    south = Math.max(south, round);
  }
  if (on(warp.fold.value)) {
    const out = Math.min(FOLD_END / warp.fold.value, 150);
    side = Math.max(side, out);
    north = Math.max(north, out);
    south = Math.max(south, out);
  }
  if (on(warp.twist.value)) {
    side = Math.max(side, Math.min(TWIST_HALF_WIDTH / warp.twist.value ** 2, 140));
    north = Math.max(north, TWIST_REACH);
    south = Math.max(south, TWIST_REACH);
  }
  return side ? { side, north, south } : null;
}
