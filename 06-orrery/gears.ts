import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MODULE, gearOutline } from "./train";

const circleHole = (radius: number) => {
  const hole = new THREE.Path();
  hole.absarc(0, 0, radius, 0, Math.PI * 2, true);
  return hole;
};

// Windows between the spokes, on anything with enough wheel to spare.
function spokeWindows(shape: THREE.Shape, inner: number, outer: number, count: number) {
  const spoke = 0.06 / ((inner + outer) / 2);
  const each = (Math.PI * 2) / count;
  for (let i = 0; i < count; i++) {
    const a = i * each + spoke;
    const b = (i + 1) * each - spoke;
    const hole = new THREE.Path();
    hole.absarc(0, 0, outer, b, a, true);
    hole.absarc(0, 0, inner, a, b, false);
    hole.closePath();
    shape.holes.push(hole);
  }
}

// Extruded flat, then turned so that the plan (x, y) lies in world (x, -z) with the axle up y: a turn of rotation.y by
// theta then carries the tooth at plan angle 0 to plan angle theta.
export function gearGeometry(teeth: number, thickness: number, bore: number, hubRadius: number, steps = 5) {
  const outline = gearOutline(teeth, steps);
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  shape.holes.push(circleHole(bore));
  const pitch = (MODULE * teeth) / 2;
  const rim = pitch - 1.25 * MODULE - 0.07;
  const hub = Math.max(hubRadius, bore + 0.05);
  if (rim - hub > 0.16) spokeWindows(shape, hub + 0.02, rim, teeth > 60 ? 6 : 5);
  const bevel = 0.007;
  const body = new THREE.ExtrudeGeometry(shape, { depth: thickness - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1, curveSegments: 18 });
  body.translate(0, 0, -(thickness - bevel * 2) / 2);
  body.rotateX(-Math.PI / 2);
  const collar = collarGeometry(hub, bore, thickness * 1.7);
  const merged = mergeGeometries([body.index ? body.toNonIndexed() : body, collar.index ? collar.toNonIndexed() : collar]) as THREE.BufferGeometry;
  body.dispose();
  collar.dispose();
  return merged;
}

// A turned ring with a closed top and bottom, centred on its own origin, axis up.
export function collarGeometry(outer: number, inner: number, height: number, segments = 28) {
  const half = height / 2;
  const chamfer = Math.min(0.012, (outer - inner) * 0.3);
  const profile = [
    [inner, -half],
    [outer - chamfer, -half],
    [outer, -half + chamfer],
    [outer, half - chamfer],
    [outer - chamfer, half],
    [inner, half],
    [inner, -half]
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, segments);
}
