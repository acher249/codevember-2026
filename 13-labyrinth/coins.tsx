"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, abs, cameraPosition, color, dot, max, normalWorld, normalize, output, positionWorld, pow, reflect, vec3, vec4 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { worldShifted } from "../shared/engine/extents";
import { useQuality } from "../shared/engine/quality";
import { sound } from "../shared/engine/sound";
import { walking } from "../shared/engine/walk";
import { game } from "./game";
import { hedgesUp, liveHeights, SIZE } from "./hedge";
import { CELL, HEIGHT, made, sharedAir, tallness, throughMist } from "./hedge-look";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Game mode, laid out like the dots in a maze game: a row of coins down the middle of every path, through every gap
// between two cells, and along the top of every standing hedge, a little over half a metre apart, all about you as far
// as the mist. A coin taken stays gone for a while, so that a path walked down is left bare behind you, then comes
// back. As the maze rebuilds itself the coins go with it: those on a hedge that sinks go, and a gap that opens fills.
const RADIUS = 0.1;
// What counts as touching a coin: within this much of the body across, and between its feet and the top of its head.
const REACH = 0.85;
const BACK_AFTER = 45;
const CAPACITY = 4000;
// Up a major scale with each coin taken in quick succession, and back to the bottom after a pause.
const SCALE = [1, 1.122, 1.26, 1.335, 1.498, 1.682, 1.888, 2];

const slotOf = (cell: number) => ((cell % SIZE) + SIZE) % SIZE;
// Where each of a cell's coins sits, as a fraction of a cell from its corner, and which wall decides it: one in the
// middle; three each on the way east and south, through the gap to the next cell's middle, there only while the gap is
// open; and four each along the tops of the east and south walls, there only while the wall stands.
type Spot = { x: number; z: number; side: -1 | 0 | 1; on: boolean };
const SPOTS: Spot[] = [{ x: 0.5, z: 0.5, side: -1, on: false }];
for (const step of [0.75, 1, 1.25]) SPOTS.push({ x: step, z: 0.5, side: 0, on: false }, { x: 0.5, z: step, side: 1, on: false });
for (const step of [0.125, 0.375, 0.625, 0.875]) SPOTS.push({ x: 1, z: step, side: 0, on: true }, { x: step, z: 1, side: 1, on: true });

export default function Coins() {
  const camera = useThree((state) => state.camera);
  const { tier } = useQuality();
  const reach = tier === "high" ? 24 : tier === "medium" ? 19 : 14;

  const { mesh, material } = useMemo(() => {
    const geometry = new THREE.CylinderGeometry(RADIUS, RADIUS, 0.014, 20, 1).rotateX(Math.PI / 2);
    const material = made(new THREE.MeshBasicNodeMaterial());
    material.name = "coin";
    const air = sharedAir.current;
    // Gold lit by the low sun: a warm face, a hard glint where it catches the light, and a bright rim.
    const lit = Fn(() => {
      const N = normalize(normalWorld) as any;
      const V = normalize(cameraPosition.sub(positionWorld)) as any;
      const sun = (air ? air.sun : vec3(-0.36, 0.11, -0.93).normalize()) as any;
      const gold = color("#e9b23a") as any;
      const face = max(dot(N, sun), 0).mul(0.7).add(0.45) as any;
      const glint = pow(max(dot(reflect(V.negate(), N), sun), 0), 30).mul(2.2) as any;
      const rim = pow(abs(dot(N, V)).oneMinus(), 3).mul(0.6) as any;
      return gold.mul(face.add(rim)).add(vec3(1, 0.93, 0.75).mul(glint)).mul(1.25);
    })();
    material.colorNode = lit as any;
    if (air) material.outputNode = vec4(throughMist(air, (output as any).rgb), 1) as any;
    const mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
    mesh.frustumCulled = false;
    mesh.count = 0;
    return { mesh, material };
  }, []);
  useDispose(mesh.geometry, material);

  // Coins taken, by the cell they were in counted from where the maze began, so that carrying the camera back a copy
  // of the maze does not bring them back; and when each was taken.
  const taken = useMemo(() => new Map<number, number>(), []);
  const scratch = useMemo(() => ({ matrix: new THREE.Matrix4(), quaternion: new THREE.Quaternion(), euler: new THREE.Euler(), position: new THREE.Vector3(), scale: new THREE.Vector3(), offset: { i: 0, j: 0 }, streak: 0, last: -Infinity }), []);

  useEffect(() => {
    const listener = (shift: THREE.Vector3) => {
      scratch.offset.i -= Math.round(shift.x / CELL);
      scratch.offset.j -= Math.round(shift.z / CELL);
    };
    worldShifted.add(listener);
    return () => {
      worldShifted.delete(listener);
    };
  }, [scratch]);

  useFrame(({ clock }) => {
    const heights = liveHeights.current;
    // Laid once the hedges have all risen.
    if (!heights || hedgesUp.at === Infinity) {
      mesh.count = 0;
      return;
    }
    const { matrix, quaternion, euler, position, scale, offset } = scratch;
    const t = clock.elapsedTime;
    const { x: cx, y: cy, z: cz } = camera.position;
    // The body: from the feet, an eye's height below the camera on foot, to just over its head. Flying, the reach goes
    // further down, so that skimming low over the hedges takes the coins on top of them.
    const feet = cy - (walking.on ? 1.75 : 1.8);
    const head = cy + 0.3;
    const ci = Math.floor(cx / CELL);
    const cj = Math.floor(cz / CELL);
    const span = Math.ceil(reach / CELL) + 1;
    let n = 0;
    let got = 0;
    for (let j = cj - span; j <= cj + span; j++) {
      for (let i = ci - span; i <= ci + span; i++) {
        const cell = slotOf(j) * SIZE + slotOf(i);
        for (let k = 0; k < SPOTS.length; k++) {
          const spot = SPOTS[k];
          const x = (i + spot.x) * CELL;
          const z = (j + spot.z) * CELL;
          const far = Math.hypot(x - cx, z - cz);
          if (far > reach) continue;
          let y = 0.34;
          if (spot.side >= 0) {
            const h = heights[cell * 2 + spot.side];
            if (spot.on) {
              if (h < 0.9) continue;
              y = HEIGHT * tallness(x, z) * h + 0.3;
            } else if (h > 0.05) continue;
          }
          const key = ((i + offset.i + 30000) * 65536 + (j + offset.j + 30000)) * 16 + k;
          const when = taken.get(key);
          if (when !== undefined) {
            if (t - when < BACK_AFTER) continue;
            taken.delete(key);
          }
          if (far < REACH && y > feet - 0.1 && y < head) {
            taken.set(key, t);
            got++;
            continue;
          }
          if (n >= CAPACITY) continue;
          const phase = (key * 0.61803) % (Math.PI * 2);
          euler.set(0, t * 2.2 + phase, 0);
          quaternion.setFromEuler(euler);
          position.set(x, y + Math.sin(t * 2 + phase) * 0.04, z);
          // Grows in at the edge of the mist rather than popping in.
          scale.setScalar(Math.min(1, (reach - far) / 3));
          mesh.setMatrixAt(n++, matrix.compose(position, quaternion, scale));
        }
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    for (let g = 0; g < got; g++) collect(t);
    if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __coins: { shown: n, taken, camera } });
  });

  // A bright ding that climbs the scale while the coins keep coming, a ping on every fifth, a run up a chord on every
  // tenth and a fanfare on every hundredth.
  const collect = (t: number) => {
    scratch.streak = t - scratch.last < 0.6 ? (scratch.streak + 1) % SCALE.length : 0;
    scratch.last = t;
    const passed = game.collect();
    sound.play("coin", { gain: 1.4, pitch: SCALE[scratch.streak] });
    if (passed === 5) sound.play("ping", { gain: 1.4 });
    if (passed === 10) sound.play("chime", { gain: 1.5 });
    if (passed === 100) sound.play("fanfare", { gain: 1.6 });
  };

  return <primitive object={mesh} />;
}
