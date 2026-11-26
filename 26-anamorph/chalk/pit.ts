import * as THREE from "three/webgpu";
import { clamp, exp, float, mix, normalMap, positionWorld, smoothstep, texture, uv, vec2, vec3 } from "three/tsl";

// The pit the artist drew: a ragged hole through the paving, soil under the slab, rock below, a ladder down its far
// wall with a lantern hung on it. It sits in the real scene, lit by the real lamp. While it is a drawing it is parked
// out of sight, brought up only to take the artist's picture of it each frame (index.tsx), which the ground shows
// (ground.ts); once it is real it stays.
// Metres throughout; the ground at y = 0.

// Where the artist stood (eye height) and what they looked at: the middle of the drawing, which the orbit turns about.
export const EYE = new THREE.Vector3(0, 1.65, 4);
export const CENTRE = new THREE.Vector3(0, 0, -1.2);
const DEPTH = 7;

// The view the hole's edge is laid out in: the artist's, wide.
export function artistView() {
  const camera = new THREE.PerspectiveCamera(64, 1, 0.05, 80);
  camera.position.copy(EYE);
  camera.lookAt(CENTRE);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

// A cheap smooth noise for building shapes on the processor.
const wobble = (a: number, b: number, c: number) => Math.sin(a * 1.7 + b * 2.3 + c) * 0.5 + Math.sin(a * 3.1 - b * 1.3 + c * 1.9) * 0.3 + Math.sin(a * 7.3 + b * 5.1 - c) * 0.2;

// The hole's edge: a ragged oval as the artist saw it, wider than tall, carried out along their sight lines to the
// ground. Seen from anywhere else it is a long, stretched shape running away from them.
// Its size on the artist's screen, across and up, and how far out the edge reaches at each angle round it. ground.ts
// works out the same edge per pixel to cut the hole, so the two always meet.
export const HOLE = { across: 0.44, up: 0.2 };
export const ragged = (a: number) => 1 + 0.06 * Math.sin(3 * a + 1) + 0.045 * Math.sin(7 * a + 2) + 0.02 * Math.sin(17 * a) + 0.012 * Math.sin(41 * a + 0.4);

export function outline(camera: THREE.PerspectiveCamera, count = 180) {
  const points: THREE.Vector3[] = [];
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2;
    const r = ragged(a);
    const sight = new THREE.Vector3(HOLE.across * Math.cos(a) * r, HOLE.up * Math.sin(a) * r, 0.5).unproject(camera).sub(EYE).normalize();
    points.push(EYE.clone().addScaledVector(sight, -EYE.y / sight.y));
  }
  return points;
}

// The walls, ring by ring down from the edge: straight down at first through the slab and soil, then rock that bulges
// and juts. Faces point into the hole.
function walls(edge: THREE.Vector3[]) {
  const middle = edge.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(edge.length);
  const n = edge.length;
  const depths: number[] = [];
  for (let j = 0; j <= 60; j++) depths.push(-DEPTH * Math.pow(j / 60, 1.6));
  const positions: number[] = [];
  const uvs: number[] = [];
  let around = 0;
  const lengths = edge.map((p, k) => {
    const at = around;
    around += p.distanceTo(edge[(k + 1) % n]);
    return at;
  });
  depths.forEach((y) => {
    for (let k = 0; k <= n; k++) {
      const p = edge[k % n];
      const out = new THREE.Vector3(p.x - middle.x, 0, p.z - middle.z).normalize();
      const rock = THREE.MathUtils.smoothstep(-y, 0.6, 1.4);
      const push = rock * (0.25 * wobble(p.x * 0.9, y * 0.8, p.z * 0.7) + 0.12 * wobble(p.z * 2.6, y * 2.2, p.x * 2.1) + 0.2 * Math.sin(-y * 0.5));
      positions.push(p.x + out.x * push, y, p.z + out.z * push);
      uvs.push((k === n ? around : lengths[k]) / 1.6, -y / 1.6);
    }
  });
  const index: number[] = [];
  const row = n + 1;
  for (let j = 0; j < depths.length - 1; j++)
    for (let k = 0; k < n; k++) {
      const a = j * row + k;
      index.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  // Faces into the hole: check one normal against the way in, and turn the winding if it points out.
  const normal = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute("normal") as THREE.BufferAttribute, row * 20 + 5);
  const p = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute("position") as THREE.BufferAttribute, row * 20 + 5);
  if (normal.dot(new THREE.Vector3(middle.x - p.x, 0, middle.z - p.z)) < 0) {
    for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
    geometry.setIndex(index);
    geometry.computeVertexNormals();
  }
  return geometry;
}

// The ground round the hole, drawn into depth only: it hides everything under the paving that the hole doesn't show,
// and casts the shadow that keeps the street lamp's light to the top of the far wall.
function cover(edge: THREE.Vector3[]) {
  const shape = new THREE.Shape([new THREE.Vector2(-40, -40), new THREE.Vector2(40, -40), new THREE.Vector2(40, 40), new THREE.Vector2(-40, 40)]);
  shape.holes.push(new THREE.Path(edge.map((p) => new THREE.Vector2(p.x, -p.z))));
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

// A wooden ladder, from its foot to its top, with rungs every 30 cm.
function ladder(foot: THREE.Vector3, top: THREE.Vector3, material: THREE.Material) {
  const group = new THREE.Group();
  const along = top.clone().sub(foot);
  const length = along.length();
  const rail = new THREE.BoxGeometry(0.05, length, 0.07);
  const rung = new THREE.CylinderGeometry(0.018, 0.018, 0.5, 8);
  rung.rotateZ(Math.PI / 2);
  const frame = new THREE.Group();
  [-0.27, 0.27].forEach((x) => {
    const mesh = new THREE.Mesh(rail, material);
    mesh.position.set(x, length / 2, 0);
    mesh.castShadow = true;
    frame.add(mesh);
  });
  for (let y = 0.3; y < length - 0.1; y += 0.3) {
    const mesh = new THREE.Mesh(rung, material);
    mesh.position.set(0, y, 0);
    mesh.castShadow = true;
    frame.add(mesh);
  }
  frame.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.normalize());
  frame.position.copy(foot);
  group.add(frame);
  return { group, geometries: [rail, rung] };
}

export type Scans = { rock: THREE.Texture; rockNormal: THREE.Texture; slab: THREE.Texture };

export function buildPit(scans: Scans) {
  const camera = artistView();
  const edge = outline(camera);

  // The walls: the paving slab's cut edge, then dark soil, then rock fading into the dark with depth.
  const y = positionWorld.y;
  const rockColour = texture(scans.rock, uv()).rgb.mul(0.75);
  const slabColour = texture(scans.slab, uv().mul(vec2(1, 3))).rgb.mul(0.9);
  const soil = vec3(0.09, 0.065, 0.045).mul(texture(scans.rock, uv().mul(2.3)).r.mul(0.8).add(0.6));
  const band = smoothstep(-0.2, -0.16, y);
  const earthy = mix(rockColour, soil, smoothstep(-1.4, -0.6, y));
  const wallMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  wallMaterial.colorNode = mix(earthy, slabColour, band).mul(mix(float(0.04), float(1), clamp(exp(y.mul(0.75)), 0, 1)));
  wallMaterial.normalNode = normalMap(texture(scans.rockNormal, uv()), vec2(1.2));
  const wallGeometry = walls(edge);
  const wall = new THREE.Mesh(wallGeometry, wallMaterial);
  wall.receiveShadow = true;
  wall.castShadow = true;
  const real = new THREE.Group();
  real.add(wall);

  // The bottom, never quite seen: black.
  const floorGeometry = new THREE.CircleGeometry(12, 24);
  floorGeometry.rotateX(-Math.PI / 2);
  const floorMaterial = new THREE.MeshBasicNodeMaterial({ color: "#020203" });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.position.y = -DEPTH + 0.3;
  real.add(floor);

  // The paving round the hole as a shadow, so the lamp lights only the top of the far wall. Invisible in the view;
  // for the artist's picture it also hides everything under the paving (index.tsx turns its depth on for that).
  // A hair under the paving, so it never shades the paving itself.
  const coverGeometry = cover(edge);
  const coverMaterial = new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false });
  const shade = new THREE.Mesh(coverGeometry, coverMaterial);
  shade.castShadow = true;
  shade.renderOrder = -1;
  shade.position.y = -0.005;

  // The ladder against the far wall, its top standing up out of the hole: the oldest trick in the book.
  const far = edge.reduce((best, p) => (p.z < best.z ? p : best), edge[0]);
  const wood = new THREE.MeshStandardNodeMaterial({ color: "#7a5a3c", roughness: 0.85 });
  const top = new THREE.Vector3(far.x + 0.1, 1.5, far.z + 0.25);
  const foot = new THREE.Vector3(far.x + 0.1, -5.5, far.z + 1.6);
  const steps = ladder(foot, top, wood);
  real.add(steps.group);

  // A lantern hung from a rung a couple of metres down, the only warm light in the hole.
  const hang = foot.clone().lerp(top, 0.62).add(new THREE.Vector3(0.3, -0.25, 0.08));
  const caseGeometry = new THREE.BoxGeometry(0.16, 0.24, 0.16);
  const caseMaterial = new THREE.MeshStandardNodeMaterial({ color: "#1c1a18", roughness: 0.5, metalness: 0.6, wireframe: false });
  const glassGeometry = new THREE.BoxGeometry(0.12, 0.17, 0.12);
  const glassMaterial = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color("#ffc27a").multiplyScalar(3) });
  const lantern = new THREE.Group();
  const shell = new THREE.Mesh(caseGeometry, caseMaterial);
  shell.scale.set(1, 0.25, 1);
  shell.position.y = 0.11;
  lantern.add(shell, new THREE.Mesh(glassGeometry, glassMaterial));
  lantern.position.copy(hang);
  real.add(lantern);
  const flame = new THREE.PointLight("#ffb066", 6, 0, 2);
  flame.position.copy(hang);
  real.add(flame);

  return {
    artist: camera,
    edge,
    ladderTop: top,
    real,
    shade,
    flame,
    geometries: [wallGeometry, floorGeometry, coverGeometry, caseGeometry, glassGeometry, ...steps.geometries],
    materials: [wallMaterial, floorMaterial, coverMaterial, wood, caseMaterial, glassMaterial]
  };
}
