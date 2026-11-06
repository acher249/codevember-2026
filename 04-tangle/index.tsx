"use client";

import { useFrame } from "@react-three/fiber";
import { CuboidCollider, Physics, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  float,
  mix,
  positionLocal,
  positionPrevious,
  pow,
  sin,
  smoothstep,
  time,
  uniform
} from "three/tsl";
import { useGrabbable } from "../shared/engine/controls";
import { useGrabRigidBody } from "../shared/engine/physics";
import { useQuality } from "../shared/engine/quality";
import { useSetting, useSettingAction, useSettingRef } from "../shared/engine/settings";
import { sound, useBed } from "../shared/engine/sound";
import { Haze, KeyLight, StudioEnvironment, StudioFloor } from "../shared/engine/studio";
import type { DayDefinition } from "../shared/engine/types";
import { useLook } from "../shared/engine/Stage";
import { TangleSim, type Sphere } from "./sim";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const CENTRE: [number, number, number] = [0, 1.22, 0];
const BACKGROUND = "#08090c";
const RING_SIDES = 12;
const CAP_RINGS = 3;

const COLOURWAYS: Record<string, string[]> = {
  ember: ["#e8320f", "#f7a513", "#f2e8d8", "#12306b", "#b3122a", "#1c1c20"],
  abyss: ["#19c8c0", "#1660d8", "#d7f3ee", "#0a3a5c", "#6fe3b5", "#7a5cff"],
  orchid: ["#ff4fa3", "#8d5cff", "#ffd9ec", "#ff9d5c", "#3f2dbd", "#46e0d0"],
  bone: ["#efe7da", "#c9bda8", "#8b8478", "#ffffff", "#a89a84", "#3b3833"]
};

const BEADS = [
  { position: [0.55, 2.7, 0.4], radius: 0.34 },
  { position: [-0.7, 2.1, 0.25], radius: 0.26 },
  { position: [0.2, 1.55, -0.55], radius: 0.3 },
  { position: [-0.25, 3.05, -0.5], radius: 0.2 },
  { position: [0.95, 1.9, -0.25], radius: 0.18 }
] as const;

// Skins the sim's particles with a tube. Rebuilt on the CPU each frame, because shadows, velocity
// and the picking all need the same positions. One mesh and one draw call for every cord.
class CordGeometry {
  readonly geometry = new THREE.BufferGeometry();
  private readonly positions: THREE.BufferAttribute;
  private readonly normals: THREE.BufferAttribute;
  private readonly before: THREE.BufferAttribute;
  private readonly colors: THREE.BufferAttribute;
  private readonly rings: number;
  private readonly sim: TangleSim;
  private readonly smooth: Float32Array;

  constructor(sim: TangleSim) {
    this.sim = sim;
    this.smooth = new Float32Array(sim.position.length);
    this.rings = sim.perCord + CAP_RINGS * 2;
    const vertices = sim.cords * this.rings * RING_SIDES;

    this.positions = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3);
    this.normals = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3);
    this.before = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3);
    this.colors = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.normals.setUsage(THREE.DynamicDrawUsage);
    this.before.setUsage(THREE.DynamicDrawUsage);

    // Static per-vertex data: arc length along the cord, around the tube, and which cord.
    const data = new Float32Array(vertices * 3);
    const quads = sim.cords * (this.rings - 1) * RING_SIDES;
    const indices = new Uint32Array(quads * 6);
    let d = 0;
    let n = 0;
    for (let cord = 0; cord < sim.cords; cord++) {
      const base = cord * this.rings * RING_SIDES;
      for (let ring = 0; ring < this.rings; ring++) {
        for (let side = 0; side < RING_SIDES; side++) {
          data[d++] = (ring - CAP_RINGS) * sim.spacing;
          data[d++] = (side / RING_SIDES) * Math.PI * 2;
          data[d++] = cord;
          if (ring === this.rings - 1) continue;
          const a = base + ring * RING_SIDES + side;
          const b = base + ring * RING_SIDES + ((side + 1) % RING_SIDES);
          const c = a + RING_SIDES;
          const e = b + RING_SIDES;
          indices[n++] = a;
          indices[n++] = b;
          indices[n++] = c;
          indices[n++] = b;
          indices[n++] = e;
          indices[n++] = c;
        }
      }
    }

    const { geometry } = this;
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("normal", this.normals);
    geometry.setAttribute("aBefore", this.before);
    geometry.setAttribute("aColor", this.colors);
    geometry.setAttribute("aData", new THREE.BufferAttribute(data, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(...CENTRE), 50);
    this.update();
    this.before.array.set(this.positions.array);
  }

  setColors(colors: string[]) {
    const array = this.colors.array as Float32Array;
    const c = new THREE.Color();
    let k = 0;
    for (let cord = 0; cord < this.sim.cords; cord++) {
      c.set(colors[cord % colors.length]);
      for (let v = 0; v < this.rings * RING_SIDES; v++) {
        array[k++] = c.r;
        array[k++] = c.g;
        array[k++] = c.b;
      }
    }
    this.colors.needsUpdate = true;
  }

  update() {
    const { sim, rings } = this;
    // One pass of smoothing on a copy: the collisions that keep cords apart leave a fine zigzag.
    const raw = sim.position;
    const p = this.smooth;
    p.set(raw);
    for (let cord = 0; cord < sim.cords; cord++) {
      const first = cord * sim.perCord;
      for (let k = 1; k < sim.perCord - 1; k++) {
        const b = (first + k) * 3;
        for (let axis = 0; axis < 3; axis++) {
          p[b + axis] = raw[b + axis] * 0.5 + (raw[b - 3 + axis] + raw[b + 3 + axis]) * 0.25;
        }
      }
    }
    const out = this.positions.array as Float32Array;
    const normals = this.normals.array as Float32Array;
    (this.before.array as Float32Array).set(out);
    const radius = sim.radius;
    const perCord = sim.perCord;
    let k = 0;

    for (let cord = 0; cord < sim.cords; cord++) {
      const first = cord * perCord;
      // Parallel-transported frame, so the mesh never twists or pops as the cord moves.
      let nx = 0;
      let ny = 0;
      let nz = 0;

      for (let ring = 0; ring < rings; ring++) {
        const along = Math.max(0, Math.min(perCord - 1, ring - CAP_RINGS));
        const i = (first + along) * 3;
        const prior = (first + Math.max(0, along - 1)) * 3;
        const after = (first + Math.min(perCord - 1, along + 1)) * 3;
        let tx = p[after] - p[prior];
        let ty = p[after + 1] - p[prior + 1];
        let tz = p[after + 2] - p[prior + 2];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl;
        ty /= tl;
        tz /= tl;

        if (ring === 0) {
          // Any vector not parallel to the tangent will do to start the frame.
          const ax = Math.abs(tx) < 0.8 ? 1 : 0;
          const ay = ax === 1 ? 0 : 1;
          nx = ay * tz;
          ny = -ax * tz;
          nz = ax * ty - ay * tx;
        }
        const projection = nx * tx + ny * ty + nz * tz;
        nx -= projection * tx;
        ny -= projection * ty;
        nz -= projection * tz;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        const bx = ty * nz - tz * ny;
        const by = tz * nx - tx * nz;
        const bz = tx * ny - ty * nx;

        // Rounded ends: the outer rings step along the tangent and pinch in like a hemisphere.
        const capIndex = ring < CAP_RINGS ? CAP_RINGS - ring : ring >= rings - CAP_RINGS ? ring - (rings - CAP_RINGS - 1) : 0;
        const capAngle = (capIndex / CAP_RINGS) * (Math.PI / 2) * 0.98;
        const capSign = ring < CAP_RINGS ? -1 : 1;
        const shift = capIndex ? Math.sin(capAngle) * radius * capSign : 0;
        const size = capIndex ? Math.cos(capAngle) : 1;
        const tilt = capIndex ? Math.sin(capAngle) * capSign : 0;
        const flat = capIndex ? Math.cos(capAngle) : 1;
        const cx = p[i] + tx * shift;
        const cy = p[i + 1] + ty * shift;
        const cz = p[i + 2] + tz * shift;

        for (let side = 0; side < RING_SIDES; side++) {
          const angle = (side / RING_SIDES) * Math.PI * 2;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const dx = nx * cos + bx * sin;
          const dy = ny * cos + by * sin;
          const dz = nz * cos + bz * sin;
          out[k] = cx + dx * radius * size;
          out[k + 1] = cy + dy * radius * size;
          out[k + 2] = cz + dz * radius * size;
          normals[k] = dx * flat + tx * tilt;
          normals[k + 1] = dy * flat + ty * tilt;
          normals[k + 2] = dz * flat + tz * tilt;
          k += 3;
        }
      }
    }
    this.positions.needsUpdate = true;
    this.normals.needsUpdate = true;
    this.before.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
  }
}

function useCordMaterial() {
  const current = useMemo(() => uniform(1), []);
  const held = useMemo(() => uniform(-1), []);
  const material = useMemo(() => {
    const cord = new THREE.MeshPhysicalNodeMaterial({
      roughness: 0.34,
      metalness: 0,
      clearcoat: 0.9,
      clearcoatRoughness: 0.18
    });
    const data = attribute("aData", "vec3") as any;
    const arc = data.x;
    const around = data.y;
    const index = data.z;
    const base = attribute("aColor", "vec3") as any;

    // The tube's position is set on the CPU, so motion vectors need last frame's position by hand.
    cord.positionNode = Fn(() => {
      (positionPrevious as any).assign(attribute("aBefore", "vec3"));
      return positionLocal;
    })() as any;

    // A woven twist running the length of the cord, in colour and in sheen.
    const twist = sin(around.mul(3).add(arc.mul(70))) as any;
    const ridge = smoothstep(-0.3, 0.8, twist) as any;
    cord.colorNode = mix(base.mul(0.62), base, ridge);
    cord.roughnessNode = mix(float(0.52), float(0.24), ridge);

    // Pulses of light running along each cord. They are what the screen-space bounce picks up.
    const wave = sin(arc.mul(2.4).sub(time.mul(1.1)).add(index.mul(2.399))) as any;
    const pulse = pow(wave.mul(0.5).add(0.5), 40) as any;
    const isHeld = float(1).sub(smoothstep(0.1, 0.5, index.sub(held).abs())) as any;
    cord.emissiveNode = base.mul(pulse.mul(current).mul(3.2).add(isHeld.mul(0.22))) as any;
    return cord;
  }, [current, held]);

  useEffect(() => () => material.dispose(), [material]);
  return { material, current, held };
}

function Bead({ position, radius, spheres, index, stirred }: { position: readonly number[]; radius: number; spheres: Sphere[]; index: number; stirred: { current: number } }) {
  const body = useRef<RapierRigidBody>(null);
  const grip = useGrabRigidBody(body, radius);
  const tension = useSettingRef<number>("tension");
  const gravity = useSettingRef<number>("gravity");
  const motion = useRef({ speed: 0, held: false });

  useFrame(() => {
    const rigid = body.current;
    const sphere = spheres[index];
    if (!rigid || !sphere) return;
    const at = rigid.translation();
    const mass = rigid.mass();

    // Kept from before the physics step, because by the time a contact is reported it has already taken the speed off.
    const velocity = rigid.linvel();
    motion.current.speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (motion.current.speed > 1) stirred.current = performance.now() + 600;
    if (motion.current.held && !grip.current.held && motion.current.speed > 3) {
      sound.play("whoosh", { gain: Math.min(1, 0.3 + motion.current.speed * 0.06), pitch: 0.9 + Math.min(0.5, motion.current.speed * 0.03), pan: at.x / 3 });
    }
    motion.current.held = grip.current.held;

    // Hand the cords' push to the rigid body, and the rigid body's new position back to the cords.
    rigid.applyImpulse({ x: sphere.impulseX * 0.002, y: sphere.impulseY * 0.002, z: sphere.impulseZ * 0.002 }, true);
    sphere.impulseX = sphere.impulseY = sphere.impulseZ = 0;
    sphere.x = at.x;
    sphere.y = at.y;
    sphere.z = at.z;

    if (!grip.current.held) {
      const pull = (0.25 + tension.current * 0.6) * mass * (1 / 60);
      rigid.applyImpulse(
        {
          x: (CENTRE[0] - at.x) * pull,
          y: (CENTRE[1] - at.y) * pull - gravity.current * 9 * mass * (1 / 60),
          z: (CENTRE[2] - at.z) * pull
        },
        true
      );
    }
  });

  return (
    <RigidBody
      ref={body}
      colliders="ball"
      position={[...position] as [number, number, number]}
      linearDamping={1.4}
      angularDamping={1.2}
      gravityScale={0}
      onCollisionEnter={() => {
        const { speed } = motion.current;
        if (speed < 0.3) return;
        const pan = (body.current?.translation().x ?? 0) / 3;
        sound.play("tick", { gain: Math.min(1, 0.4 + speed * 0.25), pitch: 1.2 - radius, pan });
        if (speed > 0.8) sound.play("thud", { gain: Math.min(0.5, speed * 0.1), size: radius, pitch: 1.3, pan });
      }}
    >
      <mesh castShadow receiveShadow>
        <sphereGeometry args={[radius, 48, 32]} />
        <meshStandardMaterial color="#d8d4cc" metalness={1} roughness={0.07} />
      </mesh>
    </RigidBody>
  );
}

function Cords() {
  const { tier } = useQuality();
  const cords = useSetting<number>("cords");
  const thickness = useSetting<number>("thickness");
  const colourway = useSetting<string>("colourway");
  const current = useSettingRef<number>("current");
  const tension = useSettingRef<number>("tension");
  const gravity = useSettingRef<number>("gravity");
  const { material, current: currentUniform, held } = useCordMaterial();
  const seed = useRef(4);
  const rope = useRef({ last: new THREE.Vector3(), pulled: 0, creakedAt: 0, nextTick: 0, nextThud: 0, draggedAt: 0, speed: 0 });
  const stirred = useRef(0);

  const spheres = useMemo<Sphere[]>(
    () =>
      BEADS.map((bead) => ({
        x: bead.position[0],
        y: bead.position[1],
        z: bead.position[2],
        radius: bead.radius,
        impulseX: 0,
        impulseY: 0,
        impulseZ: 0
      })),
    []
  );

  const perCord = tier === "low" ? 200 : 320;
  const substeps = tier === "low" ? 2 : 3;

  const sim = useMemo(
    () =>
      new TangleSim({
        cords,
        particlesPerCord: perCord,
        radius: 0.04 * thickness,
        centre: CENTRE,
        floorY: 0,
        seed: seed.current
      }),
    [cords, perCord, thickness]
  );

  const tube = useMemo(() => new CordGeometry(sim), [sim]);
  useEffect(() => () => tube.dispose(), [tube]);

  useEffect(() => {
    tube.setColors(COLOURWAYS[colourway] ?? COLOURWAYS.ember);
  }, [tube, colourway]);

  useSettingAction("retangle", () => {
    seed.current += 1;
    sim.release();
    sim.scatter(seed.current);
    stirred.current = performance.now() + 3000;
  });

  useGrabbable({
    pick(ray) {
      const hit = sim.pick(ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, sim.radius * 2.2);
      if (!hit) return null;
      return { distance: hit.distance, point: ray.at(hit.distance, new THREE.Vector3()) };
    },
    grab(point) {
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < sim.count; i++) {
        const a = i * 3;
        const d = (sim.position[a] - point.x) ** 2 + (sim.position[a + 1] - point.y) ** 2 + (sim.position[a + 2] - point.z) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      sim.grab(best);
      held.value = Math.floor(best / sim.perCord);
      rope.current.last.copy(point);
      rope.current.pulled = 0;
      rope.current.creakedAt = rope.current.draggedAt = performance.now();
      rope.current.speed = 0;
    },
    drag(point) {
      sim.moveGrab(point.x, point.y, point.z);
      // The cord creaks per distance pulled, so a faster pull creaks more often, and higher.
      const pull = rope.current;
      stirred.current = performance.now() + 1200;
      const moved = pull.last.distanceTo(point);
      const now = performance.now();
      pull.pulled += moved;
      // The last few frames, not just the last one, because a hand often stops a moment before it lets go.
      pull.speed = Math.max(pull.speed * 0.8, moved / Math.max((now - pull.draggedAt) / 1000, 1 / 240));
      pull.draggedAt = now;
      pull.last.copy(point);
      if (pull.pulled > 0.3 && now - pull.creakedAt > 130) {
        const speed = pull.pulled / ((now - pull.creakedAt) / 1000);
        sound.play("creak", { gain: Math.min(1, 0.35 + speed * 0.12), pitch: 0.8 + Math.min(0.7, speed * 0.1), pan: point.x / 3 });
        pull.pulled = 0;
        pull.creakedAt = now;
      }
    },
    release() {
      sim.release();
      held.value = -1;
      stirred.current = performance.now() + 1500;
      const thrown = rope.current.speed;
      if (thrown > 3) sound.play("whoosh", { gain: Math.min(0.9, 0.25 + thrown * 0.05), pitch: 1.1, pan: rope.current.last.x / 3 });
    }
  });

  // Priority -1: the cords step before the rigid bodies read their impulses this frame.
  useFrame((_, delta) => {
    sim.tension = tension.current;
    sim.gravity = gravity.current;
    currentUniform.value = current.current;
    sim.step(delta, substeps, spheres);
    tube.update();

    // Knocks within the snarl are only heard while something is disturbing it. Left alone, it is quiet.
    const now = performance.now();
    const knock = Math.max(sim.landing, now < stirred.current ? sim.impact : 0);
    const pan = (knock === sim.landing ? sim.landingX : sim.impactX) / 3;
    if (knock > 0.7 && now >= rope.current.nextTick) {
      rope.current.nextTick = now + 70 + Math.random() * 90;
      sound.play("tick", { gain: Math.min(1, knock * 0.3), pitch: 0.8 + Math.random() * 0.6, pan });
    }
    if (knock > 1.8 && now >= rope.current.nextThud) {
      rope.current.nextThud = now + 240;
      sound.play("thud", { gain: Math.min(0.35, knock * 0.07), size: 0.15, pitch: 1.5, pan });
    }
    sim.impact = 0;
    sim.landing = 0;
  }, -1);

  return (
    <>
      <mesh geometry={tube.geometry} material={material} castShadow receiveShadow frustumCulled={false} />
      {BEADS.map((bead, index) => (
        <Bead key={index} index={index} position={bead.position} radius={bead.radius} spheres={spheres} stirred={stirred} />
      ))}
    </>
  );
}

function Scene() {
  const haze = useSetting<number>("haze");
  useLook({ haze });
  useBed("hum", 0.18);

  return (
    <>
      <StudioEnvironment
        ambient="#14161c"
        intensity={1}
        boxes={[
          { position: [0, 7, 0], scale: [5, 0.2, 5], color: "#fff1e0", intensity: 2.5 },
          { position: [-8, 2, 2], scale: [0.2, 7, 1.2], color: "#7fb4ff", intensity: 3 },
          { position: [8, 2.5, -3], scale: [0.2, 6, 1.5], color: "#ffb48a", intensity: 2.5 },
          { position: [0, 2, 9], scale: [3, 2, 0.2], color: "#ffffff", intensity: 0.25 }
        ]}
      />
      <KeyLight position={[3.4, 9, 2.6]} target={CENTRE} color="#ffe9d2" intensity={520} angle={0.3} penumbra={0.85} />
      <Haze size={[26, 14, 26]} position={[0, 6, 0]} density={1} />
      <StudioFloor background={BACKGROUND} color="#191b20" roughness={0.38} radius={15} />
      <Physics gravity={[0, 0, 0]}>
        <Cords />
        <CuboidCollider args={[40, 0.5, 40]} position={[0, -0.5, 0]} />
      </Physics>
    </>
  );
}

const tangle: DayDefinition = {
  camera: { position: [0, 1.95, 4.9], target: [0, 1.08, 0], fov: 36 },
  phonePills: ["colourway", "retangle"],
  extents: { centre: [0, 1.5, 0], radius: 11, floor: 0, color: "#ffc8a6" },
  look: {
    background: BACKGROUND,
    exposure: 1.45,
    bloom: 0.16,
    bloomThreshold: 0.95,
    gi: 3,
    ao: 1.1,
    aoRadius: 0.45,
    haze: 1,
    vignette: 0.42
  },
  settings: {
    colourway: {
      type: "choice",
      label: "Colourway",
      value: "ember",
      options: Object.entries(COLOURWAYS).map(([value, swatch]) => ({
        value,
        label: value[0].toUpperCase() + value.slice(1),
        swatch: swatch.slice(0, 3)
      }))
    },
    tension: { type: "range", label: "Tension", min: 0, max: 1, step: 0.01, value: 0.1 },
    gravity: { type: "range", label: "Gravity", min: 0, max: 1, step: 0.01, value: 0 },
    current: { type: "range", label: "Current", min: 0, max: 2, step: 0.01, value: 1 },
    haze: { type: "range", label: "Haze", min: 0, max: 2.5, step: 0.01, value: 1 },
    cords: { type: "range", label: "Cords", min: 3, max: 12, step: 1, value: 7 },
    thickness: { type: "range", label: "Thickness", min: 0.6, max: 1.6, step: 0.05, value: 1 },
    retangle: { type: "action", label: "Re-tangle" }
  },
  notes: "The cords run on a custom position-based solver with real self-collision, and the beads are Rapier rigid bodies pushing through them. On High it uses physically based materials with a shadow-mapped key light, screen-space global illumination and ambient occlusion, volumetric haze and temporal anti-aliasing.",
  hint: "Pull a cord. Throw a bead.",
  Scene
};

export default tangle;
