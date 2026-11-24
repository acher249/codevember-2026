/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { abs, atan, attribute, color, dFdx, dFdy, float, floor, fract, max, mix, mx_noise_float, positionLocal, select, smoothstep, step, texture, uniform, vec2, vec3 } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { snowCap, type Lighting } from "./light";

// A round smart thermostat screwed to the trunk: a brushed steel ring that turns, a domed black glass face with the
// display behind it, on a pale trim plate held by two screws. Centimetres; the face looks down +z.
//
// The display is drawn by its shader from a sheet of glyphs painted once at load (the digits, the degree sign, two
// words and a leaf), so turning the dial only changes uniforms: the set temperature in big digits, a ring of ticks with
// the span between the room's temperature and the set one lit, and HEATING, COOLING or the leaf under it; or, when
// nobody has been near it a while, AWAY, dimmed.

export const RING = { radius: 4.1, depth: 2.2, lens: 3.5 };
// The dial's range, and how far the ring turns for each degree.
export const LOW = 28;
export const HIGH = 92;
export const STEP_ANGLE = THREE.MathUtils.degToRad(5);
// The ticks run round 300 degrees of the face, a gap at the bottom.
const SWEEP = (300 / 360) * Math.PI * 2;

// The glyph sheet: digits along the top half, the words and the leaf and degree sign along the bottom.
function glyphs() {
  const W = 1024;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "300 210px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  for (let d = 0; d < 10; d++) g.fillText(String(d), (d + 0.5) * (W / 10), H * 0.25 + 8);
  g.font = "500 74px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  g.fillText("HEATING", W * 0.25, H * 0.625);
  g.fillText("COOLING", W * 0.75, H * 0.625);
  // AWAY, shown in place of the number when nobody has touched the dial in a while.
  g.font = "700 104px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  g.fillText("AWAY", W * 0.75, H * 0.875 + 4);
  // The degree sign, a thin ring.
  g.strokeStyle = "#fff";
  g.lineWidth = 9;
  g.beginPath();
  g.arc(192, 448 - 18, 22, 0, Math.PI * 2);
  g.stroke();
  // The leaf: a pointed oval with a midrib cut through it, tipped to the upper right.
  g.save();
  g.translate(64, 448);
  g.rotate(-0.75);
  g.beginPath();
  g.moveTo(-46, 0);
  g.quadraticCurveTo(0, -40, 46, 0);
  g.quadraticCurveTo(0, 40, -46, 0);
  g.fill();
  g.globalCompositeOperation = "destination-out";
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(-40, 0);
  g.lineTo(38, 0);
  g.stroke();
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

export function buildThermostat(l: Lighting) {
  const group = new THREE.Group();
  // The part that turns.
  const ring = new THREE.Group();
  ring.position.z = 0.35;
  group.add(ring);
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];

  // The ring: a short steel tube with softly rounded edges, its front lip turning in to hold the glass. Points run from
  // the back inside, round the back edge, along the outside and over the front lip, so the lathe faces out.
  const R = RING.radius;
  const D = RING.depth;
  const e = 0.28;
  const profile: THREE.Vector2[] = [];
  profile.push(new THREE.Vector2(R - 0.6, 0));
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
    profile.push(new THREE.Vector2(R - e + Math.cos(a) * e, e + Math.sin(a) * e));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    profile.push(new THREE.Vector2(R - e + Math.cos(a) * e, D - e + Math.sin(a) * e));
  }
  profile.push(new THREE.Vector2(RING.lens + 0.12, D), new THREE.Vector2(RING.lens, D - 0.12));
  // The lathe turns about y: stand the ring up so its axis is z.
  // Its y is flipped to lie along z below, which mirrors it: the points go in reverse so the faces still face out.
  const ringGeometry = new THREE.LatheGeometry(profile.map((p) => new THREE.Vector2(p.x, -p.y)).reverse(), 128);
  ringGeometry.rotateX(-Math.PI / 2);
  ringGeometry.deleteAttribute("uv");
  const steel = new THREE.MeshPhysicalNodeMaterial({ metalness: 1, roughness: 0.3 });
  {
    const p = positionLocal as any;
    const around = atan(p.y, p.x) as any;
    // Brushed: fine streaks running round the ring, a few faint marks that turn with it so the turning shows.
    const streaks = mx_noise_float(vec3(p.z.mul(40), around.mul(2), 0)).mul(0.5).add(0.5) as any;
    const marks = mx_noise_float(vec3(around.mul(5), p.z.mul(2), 3)).mul(0.5).add(0.5) as any;
    steel.colorNode = mix(color("#a9adb2"), color("#dfe2e6"), streaks.mul(0.6).add(marks.mul(0.4))) as any;
    steel.roughnessNode = float(0.3).add(streaks.mul(0.12)) as any;
  }
  const ringMesh = new THREE.Mesh(ringGeometry, steel);
  ringMesh.castShadow = true;
  ringMesh.receiveShadow = true;
  ring.add(ringMesh);
  // A little snow on its top in the cold, staying on top however the ring is turned.
  // Only over the top of the ring: the inside of its lip faces up at the bottom too.
  const cap = snowCap(
    l,
    () => float(0.3),
    (p: any) => smoothstep((l.glowAt as any).y.add(1.5), (l.glowAt as any).y.add(3), p.y)
  );
  const capMesh = new THREE.Mesh(ringGeometry, cap);
  ring.add(capMesh);
  geometries.push(ringGeometry);
  materials.push(steel, cap);

  // The body behind the ring, and the trim plate and its screws: pale plastic, still.
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.CylinderGeometry(R - 0.35, R - 0.2, 0.7, 64, 1);
  body.rotateX(Math.PI / 2);
  body.translate(0, 0, 0.35);
  parts.push(body);
  const plateShape = new THREE.Shape();
  const pw = 2.4;
  const ph = 5.6;
  const pr = 1.2;
  plateShape.moveTo(-pw + pr, -ph);
  plateShape.lineTo(pw - pr, -ph);
  plateShape.quadraticCurveTo(pw, -ph, pw, -ph + pr);
  plateShape.lineTo(pw, ph - pr);
  plateShape.quadraticCurveTo(pw, ph, pw - pr, ph);
  plateShape.lineTo(-pw + pr, ph);
  plateShape.quadraticCurveTo(-pw, ph, -pw, ph - pr);
  plateShape.lineTo(-pw, -ph + pr);
  plateShape.quadraticCurveTo(-pw, -ph, -pw + pr, -ph);
  const plate = new THREE.ExtrudeGeometry(plateShape, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, curveSegments: 10 });
  plate.translate(0, 0, -0.3);
  parts.push(plate);
  for (const y of [-ph + 0.85, ph - 0.85]) {
    const head = new THREE.SphereGeometry(0.42, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    head.scale(1, 0.45, 1);
    head.rotateX(Math.PI / 2);
    head.translate(0, y, 0.06);
    parts.push(head);
  }
  const merged = mergeGeometries(parts.map((g) => {
    const plain = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(plain.attributes)) if (name !== "position" && name !== "normal") plain.deleteAttribute(name);
    return plain;
  }));
  for (const g of parts) g.dispose();
  const plastic = new THREE.MeshStandardNodeMaterial({ roughness: 0.55 });
  {
    const p = positionLocal as any;
    // The screw heads, steel with a cross slot; the rest a weathered off-white.
    const screw = step(0.04, p.z) as any;
    const dy = abs(p.y).sub(ph - 0.85) as any;
    const slot = max(smoothstep(0.08, 0.04, abs(p.x)), smoothstep(0.08, 0.04, abs(dy))).mul(smoothstep(0.34, 0.3, vec2(p.x, dy).length())) as any;
    const plasticColour = mix(color("#a9a69e"), color("#c8c4ba"), mx_noise_float(p.mul(1.3)).mul(0.5).add(0.5)) as any;
    plastic.colorNode = mix(plasticColour, color("#8d9095").mul(float(1).sub(slot.mul(0.7))), screw) as any;
    plastic.metalnessNode = screw.mul(0.9) as any;
  }
  const still = new THREE.Mesh(merged, plastic);
  still.castShadow = true;
  still.receiveShadow = true;
  group.add(still);
  geometries.push(merged);
  materials.push(plastic);

  // The face: a shallow dome of black glass over the display.
  const lens = new THREE.SphereGeometry(1, 96, 12, 0, Math.PI * 2, 0, 0.42);
  // A spherical cap of the lens's radius, flattened to a gentle dome, facing +z.
  const capR = RING.lens / Math.sin(0.42);
  lens.scale(capR, capR * 0.25, capR);
  lens.rotateX(Math.PI / 2);
  lens.translate(0, 0, -Math.cos(0.42) * capR * 0.25 + D - 0.1);
  lens.deleteAttribute("uv");
  geometries.push(lens);
  const atlas = glyphs();
  textures.push(atlas);
  const u = {
    // Set and room temperatures in degrees; what the screen says under the number (0 nothing, 1 heating, 2 cooling,
    // 3 the leaf); and how bright it is.
    set: uniform(LOW),
    room: uniform(LOW),
    status: uniform(0),
    bright: uniform(1),
    // How far into AWAY it is, 0 to 1, and how bright the word is (it blinks).
    away: uniform(0),
    awayInk: uniform(0),
    accent: uniform(new THREE.Color("#ff7a1a"))
  };
  const glass = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.18, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.1 });
  glass.colorNode = color("#050506") as any;
  {
    const p = (attribute("position", "vec3") as any).xy.div(RING.lens) as any;
    const r = p.length() as any;
    const a = atan(p.x, p.y) as any;
    const toAngle = (t: any) => t.sub(LOW).div(HIGH - LOW).sub(0.5).mul(SWEEP) as any;
    const aSet = toAngle(u.set);
    const aRoom = toAngle(u.room);
    // Ticks every 2.5 degrees round the sweep.
    const pitch = SWEEP / 120;
    const cell = a.div(pitch).add(0.5) as any;
    const tickA = floor(cell).mul(pitch) as any;
    const inSweep = step(abs(a), SWEEP / 2 + 0.01) as any;
    const thin = smoothstep(0.16, 0.08, abs(fract(cell).sub(0.5))) as any;
    const band = smoothstep(0.765, 0.775, r).mul(smoothstep(0.905, 0.895, r)) as any;
    const tick = thin.mul(band).mul(inSweep) as any;
    // Lit between the room's temperature and the set one.
    const lo = aSet.min(aRoom) as any;
    const hi = aSet.max(aRoom) as any;
    const lit = step(lo.sub(0.01), tickA).mul(step(tickA, hi.add(0.01))) as any;
    // The set point: a longer, bright tick.
    const atSet = smoothstep(0.045, 0.02, abs(a.sub(aSet))).mul(smoothstep(0.7, 0.71, r)).mul(smoothstep(0.94, 0.93, r)) as any;
    let ink: any = vec3(0.32, 0.32, 0.34).mul(tick);
    ink = mix(ink, (u.accent as any).mul(1.6).mul(tick), lit.mul(step(0.5, u.status)).mul(step(u.status, 2.5)));
    ink = ink.add(vec3(1.6, 1.6, 1.6).mul(atSet));
    // The big number: two digit cells side by side, a little left of middle to leave room for the degree sign.
    const set = floor((u.set as any).add(0.5)) as any;
    const tens = floor(set.div(10)) as any;
    const ones = set.sub(tens.mul(10)) as any;
    const dh = 0.62;
    const dw = dh * 0.4;
    const x0 = -0.04;
    const yc = 0.06;
    const dx = p.x.sub(x0) as any;
    const left = dx.lessThan(0) as any;
    const cu = select(left, dx.add(dw).div(dw), dx.div(dw)) as any;
    const cv = p.y.sub(yc - dh / 2).div(dh) as any;
    const digit = select(left, tens, ones) as any;
    const inDigits = step(0, cu).mul(step(cu, 1)).mul(step(0, cv)).mul(step(cv, 1)) as any;
    // Sampled with the gradients of the smooth position on the face, not of the cell coordinates: those jump by a whole
    // cell where the two digits meet, which picked the blurriest mip level along that line and drew a faint seam
    // down the middle of the number.
    const smoothUv = vec2(p.x.div(dw * 10), p.y.div(dh * 2)) as any;
    const big = (texture(atlas, vec2(digit.add(cu.clamp(0, 1)).div(10), cv.clamp(0, 1).mul(0.5).add(0.5))) as any).grad(dFdx(smoothUv), dFdy(smoothUv)).a.mul(inDigits) as any;
    // The degree sign, up by the top of the digits.
    const gu = p.x.sub(x0 + dw - 0.02).div(0.14) as any;
    const gv = p.y.sub(yc + dh / 2 - 0.2).div(0.14) as any;
    const inDegree = step(0, gu).mul(step(gu, 1)).mul(step(0, gv)).mul(step(gv, 1)) as any;
    const degree = (texture(atlas, vec2(gu.clamp(0, 1).mul(0.125).add(0.125), gv.clamp(0, 1).mul(0.25))) as any).a.mul(inDegree) as any;
    const home = float(1).sub(u.away) as any;
    ink = ink.add(vec3(1.5, 1.5, 1.5).mul(big.add(degree)).mul(home));
    // AWAY, where the number was.
    const au = p.x.add(0.5).div(1.0) as any;
    const av = p.y.sub(yc - 0.125).div(0.25) as any;
    const inAway = step(0, au).mul(step(au, 1)).mul(step(0, av)).mul(step(av, 1)) as any;
    const awayWord = (texture(atlas, vec2(au.clamp(0, 1).mul(0.5).add(0.5), av.clamp(0, 1).mul(0.25))) as any).a.mul(inAway) as any;
    ink = ink.add(vec3(1.5, 1.5, 1.5).mul(awayWord).mul(u.awayInk));
    // Under it: the word, or the leaf.
    const wu = p.x.add(0.3).div(0.6) as any;
    const wv = p.y.add(0.49).div(0.15) as any;
    const inWord = step(0, wu).mul(step(wu, 1)).mul(step(0, wv)).mul(step(wv, 1)) as any;
    const which = select((u.status as any).greaterThan(1.5), float(0.5), float(0)) as any;
    const word = (texture(atlas, vec2(wu.clamp(0, 1).mul(0.5).add(which), wv.clamp(0, 1).mul(0.25).add(0.25))) as any).a.mul(inWord) as any;
    const showWord = step(0.5, u.status).mul(step(u.status, 2.5)) as any;
    const lu = p.x.add(0.13).div(0.26) as any;
    const lv = p.y.add(0.6).div(0.26) as any;
    const inLeaf = step(0, lu).mul(step(lu, 1)).mul(step(0, lv)).mul(step(lv, 1)) as any;
    const leaf = (texture(atlas, vec2(lu.clamp(0, 1).mul(0.125), lv.clamp(0, 1).mul(0.25))) as any).a.mul(inLeaf).mul(step(2.5, u.status)) as any;
    ink = ink.add((u.accent as any).mul(1.4).mul(word.mul(showWord).add(leaf)));
    // The panel's own faint glow toward the middle, and the black edge where the ring's lip hides it.
    const panel = vec3(0.012, 0.013, 0.016).mul(smoothstep(1.0, 0.2, r)) as any;
    glass.emissiveNode = ink.add(panel).mul(u.bright).mul(mix(float(1), float(0.45), u.away)).mul(smoothstep(0.985, 0.95, r)) as any;
  }
  const face = new THREE.Mesh(lens, glass);
  face.position.z = 0.35;
  group.add(face);
  materials.push(glass);

  return { group, ring, face, u, geometries, materials, textures };
}

export type Thermostat = ReturnType<typeof buildThermostat>;
