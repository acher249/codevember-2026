/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { abs, atan, attribute, float, fract, length, max, mix, smoothstep, step, uv, vec3 } from "three/tsl";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model swizzles. */

// Bike racks along the curb side of the sidewalk, the city's inverted-U hoops of galvanised steel bolted down through
// a flange at each foot, and a few bikes locked to them, leaning in. Steel, frames, tyres and saddles are one merged
// draw (each part its colour on its vertices); the spokes, too fine for geometry, are drawn on a disc in each wheel,
// a second draw.

const STEEL = new THREE.Color("#7b7e80");
const RUBBER = new THREE.Color("#121212");
const SADDLE = new THREE.Color("#161514");
const ALLOY = new THREE.Color("#8a8c8e");
const FRAMES = ["#1c5a68", "#121314", "#8e1c1f", "#cfc9b8", "#2d4a33", "#3e4f7d", "#5b5f63"].map((c) => new THREE.Color(c));

class Solid {
  positions: number[] = [];
  normals: number[] = [];
  colours: number[] = [];
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, colour: THREE.Color) {
    const g = (geometry.index ? geometry.toNonIndexed() : geometry.clone()).applyMatrix4(matrix);
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    for (let i = 0; i < p.count; i++) {
      this.positions.push(p.getX(i), p.getY(i), p.getZ(i));
      this.normals.push(n.getX(i), n.getY(i), n.getZ(i));
      this.colours.push(colour.r, colour.g, colour.b);
    }
    g.dispose();
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute("tint", new THREE.Float32BufferAttribute(this.colours, 3));
    return g;
  }
}

// A rod from a to b of radius r, as a six-sided tube.
const ROD = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0);
function rod(solid: Solid, frame: THREE.Matrix4, a: THREE.Vector3, b: THREE.Vector3, r: number, colour: THREE.Color) {
  const d = b.clone().sub(a);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  solid.add(ROD, frame.clone().multiply(new THREE.Matrix4().compose(a, q, new THREE.Vector3(r, d.length(), r))), colour);
}
const v = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);

// A rack across z at (x, z): two legs into the sidewalk, round shoulders, a straight top.
function rack(solid: Solid, x: number, z: number) {
  const points: THREE.Vector3[] = [];
  const [half, height, shoulder] = [0.38, 0.92, 0.2];
  points.push(v(x, 0, z - half), v(x, height - shoulder, z - half));
  for (let k = 1; k < 6; k++) {
    const a = (k / 6) * (Math.PI / 2);
    points.push(v(x, height - shoulder + Math.sin(a) * shoulder, z - half + shoulder - Math.cos(a) * shoulder));
  }
  points.push(v(x, height, z - half + shoulder), v(x, height, z + half - shoulder));
  for (let k = 1; k < 6; k++) {
    const a = (k / 6) * (Math.PI / 2);
    points.push(v(x, height - shoulder + Math.cos(a) * shoulder, z + half - shoulder + Math.sin(a) * shoulder));
  }
  points.push(v(x, height - shoulder, z + half), v(x, 0, z + half));
  const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, false, "centripetal"), 40, 0.024, 8, false);
  solid.add(tube, new THREE.Matrix4(), STEEL);
  tube.dispose();
  // The flanges bolted to the flags.
  const flange = new THREE.CylinderGeometry(0.065, 0.07, 0.012, 10);
  [-half, half].forEach((s) => solid.add(flange, new THREE.Matrix4().makeTranslation(x, 0.006, z + s), STEEL.clone().multiplyScalar(0.8)));
  flange.dispose();
}

// A bike, its frame in the x-y plane (front to +x), placed by `frame`: the wheels' centres, where the spokes go, back.
function bike(solid: Solid, frame: THREE.Matrix4, colour: THREE.Color) {
  const R = v(-0.52, 0.34);
  const F = v(0.5, 0.34);
  const bb = v(-0.06, 0.28);
  const seat = v(-0.2, 0.82);
  const head = v(0.36, 0.84);
  const headLow = v(0.41, 0.69);
  rod(solid, frame, bb, seat, 0.016, colour);
  rod(solid, frame, seat, head, 0.015, colour);
  rod(solid, frame, bb, headLow, 0.019, colour);
  rod(solid, frame, headLow, head.clone().add(v(-0.01, 0.06)), 0.021, colour);
  [-1, 1].forEach((s) => {
    rod(solid, frame, bb, R.clone().setZ(s * 0.06), 0.01, colour);
    rod(solid, frame, seat.clone().add(v(0, -0.03)), R.clone().setZ(s * 0.06), 0.009, colour);
    rod(solid, frame, headLow, F.clone().setZ(s * 0.05), 0.011, colour);
  });
  // Seatpost and saddle; stem and a flat bar with grips.
  const top = v(-0.235, 0.96);
  rod(solid, frame, seat, top, 0.013, ALLOY);
  // The saddle: a slim nose widening to a rounded back, its plan pushed up thin, then domed across and dipping to the
  // nose, and shaded smooth.
  const plan = new THREE.Shape();
  plan.moveTo(0.12, 0);
  [
    [0.1, 0.017],
    [0.0, 0.02],
    [-0.06, 0.045],
    [-0.1, 0.055],
    [-0.12, 0.035],
    [-0.125, 0],
    [-0.12, -0.035],
    [-0.1, -0.055],
    [-0.06, -0.045],
    [0.0, -0.02],
    [0.1, -0.017]
  ].forEach(([x, y]) => plan.lineTo(x, y));
  const slab = new THREE.ExtrudeGeometry(plan, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.006, bevelSegments: 2, curveSegments: 4 });
  slab.deleteAttribute("normal");
  slab.deleteAttribute("uv");
  const saddle = mergeVertices(slab);
  slab.dispose();
  saddle.rotateX(-Math.PI / 2);
  const sp = saddle.getAttribute("position");
  for (let i = 0; i < sp.count; i++) {
    const [x, y, z] = [sp.getX(i), sp.getY(i), sp.getZ(i)];
    sp.setY(i, y - (z / 0.055) ** 2 * 0.012 - Math.max(0, x - 0.02) * 0.12);
  }
  saddle.computeVertexNormals();
  solid.add(saddle, frame.clone().multiply(new THREE.Matrix4().makeScale(0.88, 0.88, 0.85).setPosition(top.x + 0.01, top.y + 0.012, 0)), SADDLE);
  saddle.dispose();
  const bar = v(0.33, 1.0);
  rod(solid, frame, head.clone().add(v(-0.01, 0.06)), bar, 0.014, ALLOY);
  rod(solid, frame, bar.clone().setZ(-0.29), bar.clone().setZ(0.29), 0.011, ALLOY);
  [-1, 1].forEach((s) => rod(solid, frame, bar.clone().setZ(s * 0.18), bar.clone().setZ(s * 0.3), 0.016, RUBBER));
  // The chainring and the cranks with their pedals.
  const ring = new THREE.CylinderGeometry(0.1, 0.1, 0.01, 18).rotateX(Math.PI / 2);
  solid.add(ring, frame.clone().multiply(new THREE.Matrix4().makeTranslation(bb.x, bb.y, 0.07)), ALLOY.clone().multiplyScalar(0.6));
  ring.dispose();
  [-1, 1].forEach((s) => {
    const foot = bb.clone().add(v(s * 0.12, s * -0.11, s * 0.09));
    rod(solid, frame, bb.clone().setZ(s * 0.08), foot, 0.011, ALLOY.clone().multiplyScalar(0.6));
    const pedal = new THREE.BoxGeometry(0.09, 0.02, 0.09);
    solid.add(pedal, frame.clone().multiply(new THREE.Matrix4().makeTranslation(foot.x, foot.y, foot.z + s * 0.05)), RUBBER);
    pedal.dispose();
  });
  // Tyres, rims and hubs.
  const tyre = new THREE.TorusGeometry(0.325, 0.019, 6, 30);
  const rim = new THREE.TorusGeometry(0.3, 0.008, 4, 30);
  const hub = new THREE.CylinderGeometry(0.025, 0.025, 0.1, 8).rotateX(Math.PI / 2);
  [R, F].forEach((at) => {
    const m = frame.clone().multiply(new THREE.Matrix4().makeTranslation(at.x, at.y, 0));
    solid.add(tyre, m, RUBBER);
    solid.add(rim, m, ALLOY);
    solid.add(hub, m, ALLOY);
  });
  tyre.dispose();
  rim.dispose();
  hub.dispose();
  return [R, F].map((at) => frame.clone().multiply(new THREE.Matrix4().makeTranslation(at.x, at.y, 0)));
}

// Racks at x along the curb at each z, and on some of them a bike or two (`bikes`: -1 curb side, 1 sidewalk side).
export function buildBikes(racks: { x: number; z: number; bikes: number[] }[]) {
  const solid = new Solid();
  const wheels: THREE.Matrix4[] = [];
  racks.forEach(({ x, z, bikes }, k) => {
    rack(solid, x, z);
    bikes.forEach((side, j) => {
      // Along the rack, a little forward of it, leaning in on it; each its own colour, some facing each way.
      const facing = (k + j) % 2 ? 1 : -1;
      const frame = new THREE.Matrix4().compose(
        v(x + side * 0.19, 0, z + facing * 0.12 + (j ? 0.08 : 0)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, facing > 0 ? -Math.PI / 2 : Math.PI / 2, 0, "YXZ")).multiply(new THREE.Quaternion().setFromAxisAngle(v(1, 0, 0), side * facing * 0.1)),
        v(1, 1, 1)
      );
      wheels.push(...bike(solid, frame, FRAMES[(k * 3 + j * 5) % FRAMES.length]));
    });
  });
  const geometry = solid.build();
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.35 });
  material.colorNode = attribute("tint", "vec3");
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = mesh.receiveShadow = true;

  // The spokes: 32 to a wheel, fine and grey, faint where they cross, on a disc that shows nothing else.
  const disc = new THREE.CircleGeometry(0.3, 24);
  const spokeMaterial = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.4, metalness: 0.6 });
  const at = uv().sub(0.5);
  const r = length(at).mul(2);
  const turn = atan(at.y, at.x).div(Math.PI * 2);
  // Spokes leave the hub at a tangent, crossing: two sets turning opposite ways as they go out.
  const set = (twist: number) => float(1).sub(smoothstep(0.0, float(0.004).div(r.max(0.08)), abs(fract(turn.add(r.mul(twist)).mul(16)).sub(0.5)).div(16)));
  const spokes = max(set(0.035), set(-0.035)).mul(step(0.09, r));
  spokeMaterial.colorNode = vec3(0.32, 0.33, 0.34);
  spokeMaterial.opacityNode = mix(spokes.mul(0.45), float(1), step(r, 0.09).mul(0.9));
  const spokesMesh = new THREE.InstancedMesh(disc, spokeMaterial, wheels.length);
  wheels.forEach((m, i) => spokesMesh.setMatrixAt(i, m));
  spokesMesh.computeBoundingSphere();
  const group = new THREE.Group();
  group.add(mesh, spokesMesh);
  return { group, geometries: [geometry, disc], materials: [material, spokeMaterial] };
}
