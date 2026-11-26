"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { useDispose } from "../../shared/engine/dispose";
import { useQuality } from "../../shared/engine/quality";
import { castStone, darkBronze, doorLeaf, glow, polishedFloor, soot } from "./materials";

// The citadel: one immense wall of cast stone across the end of a hall too big to see the roof of. In the middle of it
// a colossal ring stands proud of the wall, carved in mouldings with a band of deep slots running round it, sunk at its
// foot below the floor, and inside it a tall narrow door of dark planks bound in bronze. Two towers stand forward of
// the wall either side, each crowned with great stepped brackets, a deep beam spanning between them; low blocks of
// stone stand either side of the door, a globe lamp burning on the right one. Overhead, high in the dark, hangs a bronze
// thing like a great beetle. The floor is dark stone, polished, in big flags. Far up, a slot in the roof lets in the day.

export const WALL_Z = -13;
export const RING: [number, number, number] = [0, 7, WALL_Z];
export const LAMP: [number, number, number] = [4.7, 1.78, WALL_Z + 2.2];
export const SLOT: [number, number, number] = [9, 62, 15];
const ROOF = 62;
const RING_IN = 7.6;
const RING_OUT = 11.6;
const DOOR_W = 4.6;
const DOOR_H = 13.6;
const TOWER_X = 14.6;
const TOWER_W = 5.6;
const TOWER_D = 5;
const BEAM_Y = 21.5;

// The ring's section, from the back of its opening out to the wall, as [radius, how far it stands from the wall].
const PROFILE: [number, number][] = [
  [RING_IN, -0.85],
  [RING_IN, 1.15],
  [RING_IN + 0.16, 1.42],
  [RING_IN + 0.75, 1.45],
  [RING_IN + 0.86, 1.3],
  [RING_IN + 0.9, 1.1],
  [RING_IN + 1.15, 1.08],
  [RING_IN + 1.25, 0.96],
  [RING_IN + 1.35, 0.96],
  [RING_IN + 1.35, 0.3],
  [RING_IN + 2.45, 0.3],
  [RING_IN + 2.45, 0.96],
  [RING_IN + 2.6, 0.98],
  [RING_IN + 2.72, 1.14],
  [RING_IN + 2.9, 1.24],
  [RING_IN + 3.08, 1.14],
  [RING_IN + 3.2, 0.96],
  [RING_IN + 3.5, 0.9],
  [RING_IN + 3.62, 0.62],
  [RING_OUT, 0.55],
  [RING_OUT + 0.05, 0]
];
const SLOT_IN = RING_IN + 1.35;
const SLOT_OUT = RING_IN + 2.45;

// A bracket seen from the side: flat on top, its underside slanting back into the face it comes out of. Extruded across
// `width`, `reach` out from the face, `height` tall, the slant starting `foot` of the reach out.
function bracket(width: number, reach: number, height: number, foot = 0.25) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(0, height);
  s.lineTo(reach, height);
  s.lineTo(reach, height * 0.38);
  s.lineTo(reach * foot, 0);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: width, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, steps: 1 });
  // The shape is drawn in x (out) and y (up) and extruded along z: turn it so it comes out along +z, across x.
  g.rotateY(-Math.PI / 2);
  g.translate(width / 2, 0, 0);
  return g;
}

// The hanging thing: a long segmented body hung head down, plates closed round it like the wing cases of a beetle, on a
// rod up into the dark.
function beetle() {
  const parts: THREE.BufferGeometry[] = [];
  const body: THREE.Vector2[] = [];
  for (let k = 0; k <= 40; k++) {
    const t = k / 40;
    const r = Math.sin(Math.PI * Math.pow(t, 0.8)) * 1.25 * (1 + 0.08 * Math.cos(t * 44)) + 0.05;
    body.push(new THREE.Vector2(r, -t * 7));
  }
  parts.push(new THREE.LatheGeometry(body, 40));
  for (let k = 0; k < 8; k++) {
    const long = k % 2 ? 3.2 : 3.8;
    const shell = new THREE.SphereGeometry(1, 20, 16, 0, Math.PI * 0.8, 0.12, Math.PI * 0.74);
    shell.scale(1.3, long, 1.05);
    shell.translate(0, -3.3 - (k % 2) * 0.4, 0.5);
    shell.rotateX(0.16 + (k % 2) * 0.1);
    shell.rotateY((k / 8) * Math.PI * 2);
    parts.push(shell);
  }
  parts.push(new THREE.CylinderGeometry(0.18, 0.18, 40, 8).translate(0, 20, 0));
  parts.push(new THREE.CylinderGeometry(0.9, 0.5, 0.8, 16).translate(0, 0.2, 0));
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  parts.forEach((g) => g.dispose());
  return merged;
}

export function Citadel() {
  const parts = useMemo(() => {
    const wall = castStone([0.34, 0.32, 0.3], { u: "x", drips: [BEAM_Y, BEAM_Y + 13, RING[1] + RING_OUT + 0.6], course: 3.3, block: 8.4 });
    const tower = castStone([0.36, 0.335, 0.31], { u: "xz", drips: [25.4, 33.8], course: 3.3, block: 6.2 });
    const ring = castStone([0.38, 0.355, 0.33], { ring: RING, course: 12, block: 3.4, grime: 0.9 });
    const recess = castStone([0.2, 0.19, 0.18], { u: "x", course: 3.3, block: 4.2, grime: 0.8 });
    const trim = castStone([0.37, 0.345, 0.32], { u: "xz", course: 4.6, block: 5.2, grime: 0.8 });
    const door = doorLeaf([0, 0, WALL_Z], DOOR_W, DOOR_H);
    const bronze = darkBronze();
    const hollow = soot([0.06, 0.055, 0.05]);
    const globe = glow([9, 5.2, 2.4]);
    const day = glow([3.2, 3.1, 2.9]);
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, cast = true) => {
      geometries.push(g);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    const block = (w: number, h: number, d: number, r = 0.06) => new RoundedBoxGeometry(w, h, d, 2, r);

    // The wall itself, wider and higher than the eye can follow into the dark.
    const back = new THREE.Shape();
    back.moveTo(-80, 0);
    back.lineTo(80, 0);
    back.lineTo(80, ROOF);
    back.lineTo(-80, ROOF);
    back.closePath();
    const hole = new THREE.Path();
    hole.absarc(RING[0], RING[1], RING_IN + 0.02, 0, Math.PI * 2, true);
    back.holes.push(hole);
    const face = new THREE.ShapeGeometry(back, 96);
    add(face, wall, 0, 0, WALL_Z);

    // The ring: its mouldings turned round the centre, the slots between blocks set in the channel round it, and the
    // back of the opening set deep behind it.
    const ringGeometry = new THREE.LatheGeometry(
      PROFILE.map(([r, d]) => new THREE.Vector2(r, d)),
      256
    );
    ringGeometry.rotateX(Math.PI / 2);
    add(ringGeometry, ring, RING[0], RING[1], RING[2]);
    {
      const count = 64;
      const mid = (SLOT_IN + SLOT_OUT) / 2;
      const along = ((2 * Math.PI * mid) / count) * 0.62;
      const tooth = new RoundedBoxGeometry(along, SLOT_OUT - SLOT_IN, 0.62, 2, 0.07);
      const teeth: THREE.BufferGeometry[] = [];
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2;
        const g = tooth.clone();
        g.rotateZ(a - Math.PI / 2);
        g.translate(Math.cos(a) * mid, Math.sin(a) * mid, 0.3 + 0.31);
        teeth.push(g);
      }
      tooth.dispose();
      add(mergeGeometries(teeth), ring, RING[0], RING[1], RING[2]);
      teeth.forEach((g) => g.dispose());
      // The backs of the slots, dark.
      const channel = new THREE.RingGeometry(SLOT_IN, SLOT_OUT, 256, 1);
      add(channel, hollow, RING[0], RING[1], RING[2] + 0.31, false);
    }
    const disc = new THREE.CircleGeometry(RING_IN + 0.05, 128);
    add(disc, recess, RING[0], RING[1], WALL_Z - 0.84, false);
    // Its feet: great slanted blocks where it goes down into the floor, either side.
    for (const s of [-1, 1]) {
      // Drawn mirrored on the left; extruding puts a reversed outline the right way out again.
      const foot = new THREE.Shape([[0, 0], [4.2, 0], [3.4, 1.7], [0.6, 3.4], [0, 3.4]].map(([x, y]) => new THREE.Vector2(s * x, y)));
      const g = new THREE.ExtrudeGeometry(foot, { depth: 2.2, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2 });
      add(g, trim, s * 7.0, 0, WALL_Z - 0.1);
    }

    // The door: its leaf set back in the opening, stone jambs and a head round it, a boss for a handle, a low step.
    add(new THREE.BoxGeometry(DOOR_W, DOOR_H, 0.5), door, 0, DOOR_H / 2, WALL_Z - 0.6);
    for (const s of [-1, 1]) add(block(0.7, DOOR_H + 0.4, 1.4, 0.05), trim, s * (DOOR_W / 2 + 0.35), (DOOR_H + 0.4) / 2, WALL_Z - 0.3);
    add(block(DOOR_W + 1.4, 0.9, 1.4, 0.05), trim, 0, DOOR_H + 0.4 + 0.45 - 0.2, WALL_Z - 0.3);
    {
      const boss = new THREE.SphereGeometry(0.42, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
      boss.rotateX(Math.PI / 2);
      boss.scale(1, 1, 0.55);
      add(boss, bronze, 1.15, 5.6, WALL_Z - 0.35);
      add(new THREE.TorusGeometry(0.5, 0.06, 10, 40), bronze, 1.15, 5.6, WALL_Z - 0.33);
    }
    add(block(9, 0.22, 2.6, 0.04), trim, 0, 0.11, WALL_Z + 0.6, false);
    add(block(6.4, 0.42, 1.4, 0.04), trim, 0, 0.21, WALL_Z + 0.3, false);

    // The low blocks either side of the door, the lamp burning on the right one on a bronze stem.
    for (const s of [-1, 1]) add(block(2.6, 1.08, 1.7, 0.05), trim, s * 4.7, 0.54, WALL_Z + 2.2);
    add(new THREE.CylinderGeometry(0.05, 0.11, 0.42, 12), bronze, LAMP[0], 1.08 + 0.21, LAMP[2], false);
    add(new THREE.CylinderGeometry(0.22, 0.26, 0.08, 24), bronze, LAMP[0], 1.12, LAMP[2], false);
    add(new THREE.SphereGeometry(0.33, 48, 24), globe, LAMP[0], LAMP[1], LAMP[2], false);

    // The towers either side: a deep base, the shaft, and their crowns of brackets stepping out, one over the other.
    for (const s of [-1, 1]) {
      const x = s * TOWER_X;
      add(block(TOWER_W + 1.2, 2.6, TOWER_D + 1.0, 0.06), tower, x, 1.3, WALL_Z + (TOWER_D + 1.0) / 2);
      add(new THREE.BoxGeometry(TOWER_W, ROOF, TOWER_D), tower, x, ROOF / 2, WALL_Z + TOWER_D / 2);
      add(bracket(TOWER_W, 1.4, 2.6, 0.2), tower, x, 25.4, WALL_Z + TOWER_D);
      add(bracket(TOWER_W + 1.4, 2.6, 3.2, 0.3), tower, x, 28.0, WALL_Z + TOWER_D - 0.6);
      add(block(TOWER_W + 2.4, 1.3, TOWER_D + 3.6, 0.08), tower, x, 31.85, WALL_Z + (TOWER_D + 3.6) / 2 - 0.4);
      add(bracket(TOWER_W + 0.6, 1.9, 2.4, 0.25), tower, x, 32.5, WALL_Z + TOWER_D + 2.4);
      // Brackets out of the towers' inner faces, carrying the ends of the beam.
      const inner = bracket(TOWER_D + 0.6, 1.8, 2.8, 0.2);
      inner.rotateY(s > 0 ? -Math.PI / 2 : Math.PI / 2);
      add(inner, tower, x - s * (TOWER_W / 2), BEAM_Y - 2.8, WALL_Z + (TOWER_D + 0.6) / 2);
      // Further out, plainer piers, and walls coming forward at the sides into the dark.
      add(new THREE.BoxGeometry(3.2, ROOF, 1.8), tower, s * 27, ROOF / 2, WALL_Z + 0.9);
      // (They cast no shadow: the day comes in over them.)
      add(new THREE.BoxGeometry(2, ROOF, 90), wall, s * 36, ROOF / 2, WALL_Z + 45, false);
      for (let k = 0; k < 6; k++) add(new THREE.BoxGeometry(2.4, ROOF, 2.6), tower, s * 34.8, ROOF / 2, WALL_Z + 7 + k * 11, false);
    }
    // The beam spanning between the towers, deep and heavy, a second, shallower course under it.
    const span = 2 * (TOWER_X - TOWER_W / 2);
    add(block(span, 3.8, 2.6, 0.08), tower, 0, BEAM_Y + 1.9, WALL_Z + 1.3);
    add(block(span, 0.9, 1.7, 0.05), tower, 0, BEAM_Y - 0.45, WALL_Z + 0.85);
    add(block(span + 2, 1.2, 3.2, 0.06), tower, 0, BEAM_Y + 4.4, WALL_Z + 1.6);

    // The roof, far up, a long slot open in it to the day.
    const roofGeometry = new THREE.BoxGeometry(160, 3, 120);
    const roof = new THREE.Mesh(roofGeometry, recess);
    geometries.push(roofGeometry);
    roof.position.set(0, ROOF + 1.5, WALL_Z + 60);
    group.add(roof);
    const slot = add(new THREE.PlaneGeometry(2.2, 16), day, SLOT[0], ROOF - 0.05, SLOT[2], false);
    slot.rotation.x = Math.PI / 2;

    // The beetle, hung high over the figures.
    const thing = add(beetle(), bronze, 0, 24.5, -1.5);
    thing.rotation.y = 0.4;

    return { mats: [wall, tower, ring, recess, trim, door, bronze, hollow, globe, day], geometries, group };
  }, []);
  useDispose(...parts.mats, ...parts.geometries);
  return (
    <>
      <primitive object={parts.group} />
      <Floor />
    </>
  );
}

// The floor, on its own so that only it is rebuilt when the quality changes: its reflection is drawn smaller lower down.
function Floor() {
  const { tier } = useQuality();
  const parts = useMemo(() => {
    const { material, mirror } = polishedFloor({ wallZ: WALL_Z, mirrorScale: tier === "high" ? 0.3 : tier === "medium" ? 0.22 : 0.15 });
    const geometry = new THREE.BoxGeometry(160, 1, 120);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0, -0.5, WALL_Z + 50);
    mesh.receiveShadow = true;
    return { material, mirror, geometry, mesh };
  }, [tier]);
  useDispose(parts.material, parts.geometry);
  return (
    <>
      <primitive object={parts.mesh} />
      <primitive object={parts.mirror.target} />
    </>
  );
}
