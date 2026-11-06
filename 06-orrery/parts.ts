import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { dayAngle, dayOfYear } from "./bands";
import { collarGeometry, gearGeometry } from "./gears";
import { bandedMaterial, barMaterial, brassMaterial, crateredMaterial, darkBrassMaterial, earthMaterial, metal, steelMaterial, sunMaterial } from "./materials";
import { MODULE, buildTrain, levelY, shaftAngle, type ShaftId, type Train } from "./train";

export type Collider =
  | { type: "cylinder"; half: number; radius: number; at?: [number, number, number] }
  | { type: "ball"; radius: number }
  | { type: "box"; size: [number, number, number]; at: [number, number, number] };

// One separate thing in the machine: it has a place at every turn of the crank, and it can come away as a rigid body.
export type Part = {
  id: string;
  kind: "gear" | "bar" | "ball" | "plate";
  mesh: THREE.Mesh;
  pose: (drive: number, position: THREE.Vector3, quaternion: THREE.Quaternion) => void;
  collider: Collider;
  // Turns in the machine, so a drag can turn it: what it turns round, and how fast for one turn of the crank.
  turn?: { x: number; y: number; speed: number };
  // Its own turning, to keep it spinning when it is no longer in the machine.
  spin: (drive: number) => number;
  // For a planet that has come loose, the distance from the Sun it wants.
  orbit?: number;
  size: number;
  // The long way along a bar, how long that is, and whether the mesh's origin is at the end rather than the middle.
  long?: { axis: "x" | "y"; length: number };
};

const UP = new THREE.Vector3(0, 1, 0);

export const SUN_RADIUS = 0.6;
export const SUN_HEIGHT = 4.72;
const BRIDGE_HEIGHT = 1.9;
const BRIDGE_RADIUS = 1.72;
const CRANK_LENGTH = 1.5;
const CRANK_HEIGHT = 2.03;
const MOON_ARM = 3.9;
const MOON_REACH = 0.44;

// Innermost first. The lowest wheel has the innermost tube and the highest arm.
const STACK: { id: ShaftId; wheel: string; tube: number; arm: number; reach: number; height: number; radius: number }[] = [
  { id: "earth", wheel: "earthWheel", tube: 0.07, arm: 3.3, reach: 0, height: 0, radius: 0 },
  { id: "mercury", wheel: "mercuryWheel", tube: 0.1, arm: 2.93, reach: 0.95, height: 3.14, radius: 0.09 },
  { id: "venus", wheel: "venusWheel", tube: 0.13, arm: 2.76, reach: 1.55, height: 3.02, radius: 0.15 },
  { id: "mars", wheel: "marsWheel", tube: 0.16, arm: 2.59, reach: 2.95, height: 3.5, radius: 0.13 },
  { id: "jupiter", wheel: "jupiterWheel", tube: 0.19, arm: 2.42, reach: 3.6, height: 3.72, radius: 0.34 },
  { id: "saturn", wheel: "saturnWheel", tube: 0.22, arm: 2.25, reach: 4.25, height: 3.42, radius: 0.25 }
];
const PLATE_HEIGHT = 0.2;

const flat = (geometry: THREE.BufferGeometry) => (geometry.index ? geometry.toNonIndexed() : geometry);
function merge(...geometries: THREE.BufferGeometry[]) {
  const pieces = geometries.map((geometry) => {
    const plain = flat(geometry);
    for (const name of Object.keys(plain.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") plain.deleteAttribute(name);
    return plain;
  });
  return mergeGeometries(pieces) as THREE.BufferGeometry;
}

// A tapered bar running out along +x from a hub on the axis, with a short tail behind it.
function armGeometry(reach: number, tube: number, thickness = 0.042) {
  const hub = tube + 0.055;
  const shape = new THREE.Shape();
  const tail = -Math.min(0.42, reach * 0.3);
  shape.moveTo(tail, -0.03);
  shape.lineTo(-hub * 0.4, -hub * 0.92);
  shape.lineTo(hub * 0.4, -hub * 0.92);
  shape.lineTo(reach, -0.035);
  shape.absarc(reach, 0, 0.055, -Math.PI / 2, Math.PI / 2, false);
  shape.lineTo(hub * 0.4, hub * 0.92);
  shape.lineTo(-hub * 0.4, hub * 0.92);
  shape.lineTo(tail, 0.03);
  shape.absarc(tail, 0, 0.03, Math.PI / 2, -Math.PI / 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, tube, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const bar = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelSize: 0.005, bevelThickness: 0.005, bevelSegments: 1, curveSegments: 10 });
  bar.translate(0, 0, -thickness / 2);
  bar.rotateX(-Math.PI / 2);
  const collar = collarGeometry(hub, tube, thickness * 2.6);
  return merge(bar, collar);
}

function shaftGeometry(radius: number, length: number, flange = false) {
  const pieces: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(radius, radius, length, 18, 1)];
  if (flange) {
    const foot = collarGeometry(radius + 0.045, 0.001, 0.05, 18);
    foot.translate(0, -length / 2 + 0.025, 0);
    pieces.push(foot);
  }
  return merge(...pieces);
}

// The lower plate, with a turned drop under the middle, now that nothing sits under it.
function lowerPlateGeometry() {
  const drop = new THREE.LatheGeometry(
    [[0.001, -0.62], [0.03, -0.6], [0.05, -0.52], [0.035, -0.45], [0.09, -0.36], [0.14, -0.26], [0.09, -0.17], [0.05, -0.12], [0.12, -0.07], [0.2, -0.03], [0.2, 0]].map(([x, y]) => new THREE.Vector2(x, y)),
    28
  );
  return merge(bridgeGeometry(), drop);
}

function bridgeGeometry() {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, BRIDGE_RADIUS, 0, Math.PI * 2, false);
  const centre = new THREE.Path();
  centre.absarc(0, 0, 0.25, 0, Math.PI * 2, true);
  shape.holes.push(centre);
  const windows = 6;
  for (let i = 0; i < windows; i++) {
    const a = (i / windows) * Math.PI * 2 + 0.08;
    const b = ((i + 1) / windows) * Math.PI * 2 - 0.08;
    const hole = new THREE.Path();
    hole.absarc(0, 0, BRIDGE_RADIUS - 0.42, b, a, true);
    hole.absarc(0, 0, 0.44, a, b, false);
    hole.closePath();
    shape.holes.push(hole);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 1, curveSegments: 48 });
  geometry.translate(0, 0, -0.02);
  geometry.rotateX(-Math.PI / 2);
  return merge(geometry);
}

function ringedGeometry(radius: number) {
  const ball = new THREE.SphereGeometry(radius, 36, 24);
  const bands = [[1.32, 1.5], [1.55, 1.9], [1.96, 2.12]];
  const rings = bands.map(([inner, outer]) =>
    new THREE.LatheGeometry(
      [
        new THREE.Vector2(inner * radius, -0.008),
        new THREE.Vector2(outer * radius, -0.008),
        new THREE.Vector2(outer * radius, 0.008),
        new THREE.Vector2(inner * radius, 0.008),
        new THREE.Vector2(inner * radius, -0.008)
      ],
      64
    )
  );
  const tilted = rings.map((ring) => ring.rotateX(0.42));
  return merge(ball, ...tilted);
}

function rodGeometry(length: number) {
  const rod = new THREE.CylinderGeometry(0.02, 0.024, length, 12, 1);
  const foot = collarGeometry(0.05, 0.001, 0.05, 14);
  foot.translate(0, -length / 2 + 0.025, 0);
  const cup = collarGeometry(0.04, 0.001, 0.03, 14);
  cup.translate(0, length / 2 - 0.015, 0);
  return merge(rod, foot, cup);
}

export type Materials = ReturnType<typeof makeMaterials>;

export function makeMaterials() {
  return {
    brass: brassMaterial(),
    dark: darkBrassMaterial(),
    steel: steelMaterial(),
    bar: barMaterial(),
    handle: metal({ color: "#4f2c17", shade: "#2c170b", roughness: 0.42, sheen: 0, bump: 0.0004 }),
    sun: sunMaterial(SUN_RADIUS),
    earth: earthMaterial(0.21),
    mercury: crateredMaterial(0.09, "#c8cbcd", "#6e7276", 7, 0.46),
    venus: bandedMaterial(0.15, ["#e6c37e", "#b48a45", "#f2dca2"], 13, 0.36),
    mars: crateredMaterial(0.13, "#c5683c", "#6c2b18", 6, 0.5, 0.65),
    jupiter: bandedMaterial(0.34, ["#c4935a", "#6e4426", "#e8cf9c"], 13, 0.4, 0.8),
    saturn: bandedMaterial(0.25, ["#dcbc7c", "#a07e49", "#ecd7a6"], 19, 0.36, 0.24),
    moon: crateredMaterial(0.062, "#d7d7d2", "#797a7a", 8, 0.42, 0.85)
  };
}

// The planets start where they are today, with the Earth's arm on today's date.
export function buildParts(materials: Materials, steps: number) {
  const train: Train = buildTrain(Date.now(), dayAngle(dayOfYear(new Date())));
  const shaft = (id: ShaftId) => train.shafts.get(id)!;
  const earth = shaft("earth");
  const parts: Part[] = [];
  const add = (part: Omit<Part, "spin"> & { spin?: Part["spin"] }) => {
    part.mesh.castShadow = part.mesh.receiveShadow = true;
    part.mesh.name = part.id;
    parts.push({ spin: () => 0, ...part });
    return part;
  };
  const axis = new THREE.Vector3();

  // Sitting on a shaft, at a height, carried round by the Earth's arm if the shaft is.
  const onShaft = (id: ShaftId, height: number, offset = 0): Part["pose"] => {
    const s = shaft(id);
    return (drive, position, quaternion) => {
      const carrier = s.carried ? earth.start + earth.speed * drive : 0;
      position.set(s.x * Math.cos(carrier) - s.y * Math.sin(carrier), height, -(s.x * Math.sin(carrier) + s.y * Math.cos(carrier)));
      quaternion.setFromAxisAngle(UP, shaftAngle(train, id, drive) + offset);
    };
  };
  const fixed = (x: number, height: number, z: number): Part["pose"] => (_, position, quaternion) => {
    position.set(x, height, z);
    quaternion.identity();
  };
  // Out on an arm, a way along from the axis.
  const outOn = (id: ShaftId, reach: number, height: number): Part["pose"] => (drive, position, quaternion) => {
    const angle = shaftAngle(train, id, drive);
    position.set(reach * Math.cos(angle), height, -reach * Math.sin(angle));
    quaternion.setFromAxisAngle(UP, angle);
  };
  const turnOf = (id: ShaftId) => {
    const s = shaft(id);
    // Everything out on the Earth's arm drags the arm, because that is the way a hand would move it.
    if (s.carried) return { x: 0, y: 0, speed: earth.speed };
    return { x: s.x, y: s.y, speed: s.speed };
  };
  const spinOf = (id: ShaftId, offset = 0) => (drive: number) => shaftAngle(train, id, drive) + offset;

  // Gears.
  const tubeOf = new Map(STACK.map((entry) => [entry.wheel, entry.tube]));
  for (const gear of train.gears.values()) {
    const small = gear.level > 12;
    const thickness = small ? 0.08 : 0.09;
    const bore = tubeOf.get(gear.id) ?? (gear.shaft === "sun" ? 0.04 : gear.shaft === "moonC" ? 0.06 : gear.shaft === "earthSpin" ? 0.03 : 0.045);
    const radius = (MODULE * gear.teeth) / 2;
    const geometry = gearGeometry(gear.teeth, thickness, bore, Math.max(bore + 0.05, Math.min(0.16, radius * 0.45)), steps);
    const material = gear.teeth >= 36 ? materials.brass : materials.dark;
    const fixedWheel = gear.shaft === "sun";
    add({
      id: gear.id,
      kind: "gear",
      mesh: new THREE.Mesh(geometry, material),
      pose: onShaft(gear.shaft, levelY(gear.level), gear.offset),
      collider: { type: "cylinder", half: thickness / 2 + 0.005, radius: radius - MODULE * 0.6 },
      turn: fixedWheel ? undefined : turnOf(gear.shaft),
      spin: spinOf(gear.shaft, gear.offset),
      size: radius
    });
  }

  // The shafts between the plates.
  const between = (id: ShaftId, name: string, radius: number, bottom: number, top: number, material: THREE.Material, flange = false) => {
    const length = top - bottom;
    const s = shaft(id);
    add({
      id: name,
      kind: "bar",
      mesh: new THREE.Mesh(shaftGeometry(radius, length, flange), material),
      pose: onShaft(id, (top + bottom) / 2),
      collider: { type: "cylinder", half: length / 2, radius },
      turn: id === "sun" ? undefined : turnOf(id),
      spin: spinOf(id),
      size: length / 2,
      long: { axis: "y", length }
    });
    return s;
  };
  between("lay", "layShaft", 0.042, PLATE_HEIGHT, BRIDGE_HEIGHT, materials.steel);
  between("counter", "counterShaft", 0.042, PLATE_HEIGHT, BRIDGE_HEIGHT, materials.steel);
  between("slow", "slowShaft", 0.042, PLATE_HEIGHT, BRIDGE_HEIGHT, materials.steel);
  between("crank", "crankShaft", 0.05, PLATE_HEIGHT, CRANK_HEIGHT + 0.04, materials.steel);
  between("sun", "sunShaft", 0.038, PLATE_HEIGHT, SUN_HEIGHT - SUN_RADIUS + 0.04, materials.steel, true);

  // The tubes at the centre, and an arm and a rod for each planet.
  for (const entry of STACK) {
    const wheel = train.gears.get(entry.wheel)!;
    const bottom = levelY(wheel.level) - 0.02;
    const length = entry.arm - bottom;
    add({
      id: `${entry.id}Tube`,
      kind: "bar",
      mesh: new THREE.Mesh(collarGeometry(entry.tube, entry.tube - 0.02, length, 24), materials.steel),
      pose: onShaft(entry.id, (entry.arm + bottom) / 2),
      collider: { type: "cylinder", half: length / 2, radius: entry.tube },
      turn: turnOf(entry.id),
      spin: spinOf(entry.id),
      size: length / 2,
      long: { axis: "y", length }
    });
    const reach = entry.id === "earth" ? train.moonC : entry.reach;
    add({
      id: `${entry.id}Arm`,
      kind: "bar",
      mesh: new THREE.Mesh(armGeometry(reach, entry.tube), materials.bar),
      pose: onShaft(entry.id, entry.arm),
      collider: { type: "box", size: [(reach + 0.2) / 2, 0.03, 0.06], at: [(reach - 0.2) / 2, 0, 0] },
      turn: turnOf(entry.id),
      spin: spinOf(entry.id),
      size: reach,
      long: { axis: "x", length: reach }
    });
    if (entry.id === "earth") continue;
    const rodBottom = entry.arm + 0.02;
    const rodTop = entry.height - entry.radius * 0.8;
    const rodLength = rodTop - rodBottom;
    add({
      id: `${entry.id}Rod`,
      kind: "bar",
      mesh: new THREE.Mesh(rodGeometry(rodLength), materials.brass),
      pose: outOn(entry.id, entry.reach, (rodTop + rodBottom) / 2),
      collider: { type: "cylinder", half: rodLength / 2, radius: 0.024 },
      turn: turnOf(entry.id),
      spin: spinOf(entry.id),
      size: rodLength / 2,
      long: { axis: "y", length: rodLength }
    });
    const geometry = entry.id === "saturn" ? ringedGeometry(entry.radius) : new THREE.SphereGeometry(entry.radius, 40, 28);
    add({
      id: entry.id,
      kind: "ball",
      mesh: new THREE.Mesh(geometry, materials[entry.id as "mercury" | "venus" | "mars" | "jupiter" | "saturn"]),
      pose: outOn(entry.id, entry.reach, entry.height),
      collider: { type: "ball", radius: entry.radius },
      turn: turnOf(entry.id),
      spin: spinOf(entry.id),
      orbit: 1.5 + entry.reach * 0.85,
      size: entry.radius
    });
  }

  // The Earth, the Moon and the little train on the Earth's arm.
  const armTop = 3.34;
  between("moonA", "moonAShaft", 0.03, armTop - 0.02, levelY(train.gears.get("moonAOut")!.level) + 0.06, materials.steel);
  between("moonB", "moonBShaft", 0.03, armTop - 0.02, levelY(train.gears.get("moonBOut")!.level) + 0.06, materials.steel);
  const moonHeight = levelY(train.gears.get("moonCIn")!.level);
  const earthHeight = 4.2;
  const earthRadius = 0.21;
  between("earthSpin", "earthShaft", 0.028, armTop - 0.02, earthHeight - earthRadius + 0.02, materials.steel);
  between("moonC", "moonTube", 0.058, moonHeight - 0.04, MOON_ARM + 0.03, materials.brass);
  add({
    id: "earth",
    kind: "ball",
    mesh: new THREE.Mesh(new THREE.SphereGeometry(earthRadius, 48, 32).rotateX(0.41), materials.earth),
    pose: onShaft("earthSpin", earthHeight),
    collider: { type: "ball", radius: earthRadius },
    turn: { x: 0, y: 0, speed: earth.speed },
    spin: spinOf("earthSpin"),
    orbit: 1.5 + train.moonC * 0.85,
    size: earthRadius
  });
  add({
    id: "moonArm",
    kind: "bar",
    mesh: new THREE.Mesh(armGeometry(MOON_REACH, 0.058, 0.024), materials.bar),
    pose: onShaft("moonC", MOON_ARM),
    collider: { type: "box", size: [(MOON_REACH + 0.1) / 2, 0.02, 0.05], at: [(MOON_REACH - 0.1) / 2, 0, 0] },
    turn: { x: 0, y: 0, speed: earth.speed },
    spin: spinOf("moonC"),
    size: MOON_REACH,
    long: { axis: "x", length: MOON_REACH }
  });
  // The Moon's own rod and ball run on the end of that little arm, which is itself carried round.
  const moonOut = (height: number): Part["pose"] => {
    const onMoonShaft = onShaft("moonC", height);
    return (drive, position, quaternion) => {
      onMoonShaft(drive, position, quaternion);
      axis.set(MOON_REACH, 0, 0).applyQuaternion(quaternion);
      position.add(axis);
    };
  };
  const moonRodLength = earthHeight - MOON_ARM - 0.06;
  add({
    id: "moonRod",
    kind: "bar",
    mesh: new THREE.Mesh(rodGeometry(moonRodLength), materials.brass),
    pose: moonOut(MOON_ARM + moonRodLength / 2 + 0.01),
    collider: { type: "cylinder", half: moonRodLength / 2, radius: 0.02 },
    turn: { x: 0, y: 0, speed: earth.speed },
    spin: spinOf("moonC"),
    size: moonRodLength / 2,
    long: { axis: "y", length: moonRodLength }
  });
  add({
    id: "moon",
    kind: "ball",
    mesh: new THREE.Mesh(new THREE.SphereGeometry(0.062, 28, 20), materials.moon),
    pose: moonOut(earthHeight),
    collider: { type: "ball", radius: 0.062 },
    turn: { x: 0, y: 0, speed: earth.speed },
    spin: spinOf("moonC"),
    size: 0.062
  });

  // The Sun, fixed to the centre shaft.
  add({
    id: "sun",
    kind: "ball",
    mesh: new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 64, 44), materials.sun),
    pose: fixed(0, SUN_HEIGHT, 0),
    collider: { type: "ball", radius: SUN_RADIUS },
    size: SUN_RADIUS
  });

  // The frame.
  add({
    id: "bridge",
    kind: "plate",
    mesh: new THREE.Mesh(bridgeGeometry(), materials.brass),
    pose: fixed(0, BRIDGE_HEIGHT + 0.02, 0),
    collider: { type: "cylinder", half: 0.03, radius: BRIDGE_RADIUS },
    size: BRIDGE_RADIUS
  });
  add({
    id: "lowerPlate",
    kind: "plate",
    mesh: new THREE.Mesh(lowerPlateGeometry(), materials.brass),
    pose: fixed(0, PLATE_HEIGHT - 0.02, 0),
    collider: { type: "cylinder", half: 0.03, radius: BRIDGE_RADIUS },
    size: BRIDGE_RADIUS
  });

  // The crank.
  const crank = shaft("crank");
  // With no base to stand on, the crank's shaft is held by a bracket out from the lower plate.
  const bracketLength = Math.hypot(crank.x, crank.y);
  const bracketAngle = Math.atan2(crank.y, crank.x);
  add({
    id: "crankBracket",
    kind: "bar",
    mesh: new THREE.Mesh(armGeometry(bracketLength, 0.038, 0.05), materials.bar),
    pose: (_, position, quaternion) => {
      position.set(0, PLATE_HEIGHT - 0.02, 0);
      quaternion.setFromAxisAngle(UP, bracketAngle);
    },
    collider: { type: "box", size: [bracketLength / 2, 0.03, 0.06], at: [bracketLength / 2, 0, 0] },
    size: bracketLength,
    long: { axis: "x", length: bracketLength }
  });
  const crankArm = new THREE.Mesh(armGeometry(CRANK_LENGTH, 0.05, 0.05), materials.bar);
  add({
    id: "crankArm",
    kind: "bar",
    mesh: crankArm,
    pose: onShaft("crank", CRANK_HEIGHT),
    collider: { type: "box", size: [(CRANK_LENGTH + 0.2) / 2, 0.03, 0.06], at: [(CRANK_LENGTH - 0.2) / 2, 0, 0] },
    turn: turnOf("crank"),
    spin: spinOf("crank"),
    size: CRANK_LENGTH,
    long: { axis: "x", length: CRANK_LENGTH }
  });
  const knob = new THREE.LatheGeometry(
    [[0.001, 0], [0.04, 0], [0.04, 0.03], [0.055, 0.06], [0.062, 0.12], [0.048, 0.17], [0.03, 0.195], [0.001, 0.2]].map(([x, y]) => new THREE.Vector2(x, y)),
    18
  );
  add({
    id: "crankKnob",
    kind: "ball",
    mesh: new THREE.Mesh(knob, materials.handle),
    pose: (drive, position, quaternion) => {
      const angle = shaftAngle(train, "crank", drive);
      position.set(crank.x + CRANK_LENGTH * Math.cos(angle), CRANK_HEIGHT + 0.03, -(crank.y + CRANK_LENGTH * Math.sin(angle)));
      quaternion.setFromAxisAngle(UP, angle);
    },
    collider: { type: "cylinder", half: 0.1, radius: 0.06, at: [0, 0.1, 0] },
    turn: turnOf("crank"),
    spin: spinOf("crank"),
    size: 0.1
  });

  return { parts, train };
}

