"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cameraPosition, color, dot, float, floor, fract, length, mix, normalGeometry, output, positionGeometry, sin, smoothstep, vec3, vec4 } from "three/tsl";
import { type Air, fading, made, shape, SPAN, throughMist } from "./hedge-look";
import { hash4, wrap } from "./hedge-noise";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Loose stones and dropped leaves lying on the gravel round the camera, so that close to, the path has stones that stand up off it and catch
// the light rather than a picture of them. One to a square of a grid that repeats a whole number of times per copy of
// the maze; the squares are the ones round the camera, each stone sitting in its own square's own spot, so as the camera
// moves the far squares are handed back as the near ones are taken, and nothing on the ground seems to move.
const STEP = 0.12;
const PER_COPY = Math.round(SPAN / STEP);

// A pebble: an octahedron squashed and pulled about a little, so it lies flat and shows its facets.
function pebbleGeometry() {
  const geometry = new THREE.OctahedronGeometry(1, 0);
  geometry.deleteAttribute("uv");
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    position.setXYZ(i, x * (1.2 + 0.2 * Math.sign(z)), y * 0.55, z * (0.9 - 0.15 * Math.sign(x)));
  }
  geometry.computeVertexNormals();
  return geometry;
}

// A dropped leaf, curled up along its rib: a diamond folded into a shallow V.
function leafGeometry() {
  const geometry = new THREE.BufferGeometry();
  const positions = [0, 0, -1, 0, 0.02, 1, -0.42, 0.22, -0.1, 0.42, 0.18, 0.05];
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([0, 1, 2, 0, 3, 1]);
  geometry.computeVertexNormals();
  return geometry;
}

// One kind of thing scattered over the squares round the camera. `chance` of a square having one, between `smallest` and
// `largest` across, lifted by `lift` of its size, and coloured by `look` from four numbers of its own.
function scatter(air: Air, across: number, geometry: THREE.BufferGeometry, chance: number, smallest: number, largest: number, lift: number, salt: number, look: (own: any) => any) {
  const side = Math.round(across / STEP);
  const count = side * side;
  const offsets = new Float32Array(count * 2);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) offsets.set([i - side / 2, j - side / 2], (j * side + i) * 2);
  geometry.setAttribute("aCell", new THREE.InstancedBufferAttribute(offsets, 2));
  const material = made(new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide }));
  const cell = floor(cameraPosition.xz.div(STEP)).add(attribute("aCell", "vec2")) as any;
  const own = hash4(wrap(cell, PER_COPY).add(salt)) as any;
  const centre = cell.add(own.xy.mul(0.8).add(0.1)).mul(STEP) as any;
  // Most squares are bare: the drawn ground carries the rest. Bigger ones are fewer.
  const size = float(smallest)
    .add(own.z.mul(own.z).mul(largest - smallest))
    .mul(smoothstep(chance + 0.05, chance, own.w)) as any;
  const away = length(centre.sub(cameraPosition.xz)) as any;
  const near = smoothstep(across * 0.5, across * 0.36, away) as any;
  const turn = own.w.mul(40).add(own.x.mul(9)) as any;
  const c = sin(turn.add(1.5708)) as any;
  const s = sin(turn) as any;
  const local = positionGeometry.mul(size.mul(near)) as any;
  const turned = vec3(local.x.mul(c).sub(local.z.mul(s)), local.y, local.x.mul(s).add(local.z.mul(c))) as any;
  shape(material, vec3(centre.x, size.mul(lift), centre.y).add(turned));
  const facet = fract(sin(dot(normalGeometry, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;
  material.colorNode = fading(air, look(own).mul(facet.mul(0.2).add(0.85)));
  material.outputNode = vec4(throughMist(air, (output as any).rgb), 1) as any;
  const instanced = new THREE.InstancedMesh(geometry, material, count);
  const identity = new THREE.Matrix4();
  for (let i = 0; i < count; i++) instanced.setMatrixAt(i, identity);
  instanced.frustumCulled = false;
  instanced.receiveShadow = true;
  return instanced;
}

export function Gravel({ air, across }: { air: Air; across: number }) {
  const meshes = useMemo(
    () => [
      scatter(air, across, pebbleGeometry(), 0.4, 0.006, 0.028, 0.15, 0, (own) =>
        mix(mix(color("#8e7f66"), color("#d0bf9c"), fract(own.x.mul(7.3))), color("#5c554a"), smoothstep(0.85, 0.95, fract(own.y.mul(5.1))))
      ),
      scatter(air, across, leafGeometry(), 0.06, 0.018, 0.034, 0.1, 17, (own) =>
        mix(mix(color("#6b4a1f"), color("#a07e30"), fract(own.x.mul(17.3))), color("#3b2a17"), smoothstep(0.6, 1, fract(own.y.mul(5.9))))
      )
    ],
    [air, across]
  );
  useEffect(
    () => () => {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        mesh.dispose();
      }
    },
    [meshes]
  );
  return (
    <>
      {meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
    </>
  );
}
