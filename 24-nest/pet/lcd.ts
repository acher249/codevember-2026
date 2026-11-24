// The egg's screen: a reflective dot-matrix LCD under a glass window. The pet writes what each dot should be; here the
// dots ease toward it (dark quickly, fading slowly, so the last frame lingers as a ghost) in a tiny texture, and the shader
// draws every dot as a rounded square on the pale green-grey ground, the unlit ones faintly there, each casting a soft
// shadow on the reflector below that slides as the eye moves (the glass has depth), with a printed frame round it all.

import * as THREE from "three/webgpu";
import { abs, cameraPosition, clamp, color, exp, float, floor, fract, fwidth, length, max, min, mix, normalize, positionWorld, smoothstep, texture, uniform, uv, vec2, vec3, vec4 } from "three/tsl";
import { COLS, ICON, ICONS, Pet, ROWS } from "./pet";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The window's size in the shell (cm), and the dots' active area inside its printed frame.
export const SCREEN = { w: 2.76, h: 2.3, y: 0.45, corner: 0.36 };
const ACTIVE = { w: 2.4, h: 1.96 };
const PITCH = 0.0725;
const MAIN = { x: (ACTIVE.w - COLS * PITCH) / 2, y: 0.4 };
const BAND = 0.36;
const ICON_SIZE = 0.3;
// The data texture: the main matrix in rows 0 to 15, then the icons side by side in rows 16 to 27.
const TW = ICON * ICONS;
const TH = ROWS + ICON;

export function createScreen() {
  const data = new Uint8Array(TW * TH * 4);
  const shown = new Float32Array(TW * TH);
  const tex = new THREE.DataTexture(data, TW, TH, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  const art = Pet.iconArt();

  // The screen's frame in the world, so the shadow can shift with the eye.
  const right = uniform(new THREE.Vector3(1, 0, 0));
  const up = uniform(new THREE.Vector3(0, 1, 0));
  const out = uniform(new THREE.Vector3(0, 0, 1));
  // Dark, as when the battery is out; and how much the whole thing is lit from within its frame (always 0: a real LCD
  // has no backlight). Kept for the dev view.
  const material = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.5, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.035 });

  const q = uv().sub(0.5).mul(vec2(SCREEN.w, SCREEN.h)) as any;
  // Down from the active area's top left corner.
  const a = vec2(q.x.add(ACTIVE.w / 2), float(ACTIVE.h / 2).sub(q.y)) as any;

  // How dark the dots are at a point of the active area, and the dot's shape there.
  const sample = (p: any) => {
    const inMain = p.y.greaterThan(MAIN.y).and(p.y.lessThan(MAIN.y + ROWS * PITCH)) as any;
    const m = p.sub(vec2(MAIN.x, MAIN.y)).div(PITCH) as any;
    // Icons: four to a band, the top band 0 to 3, the bottom 4 to 7.
    const bottom = p.y.greaterThan(ACTIVE.h / 2) as any;
    const slot = clamp(floor(p.x.div(ACTIVE.w / 4)), 0, 3) as any;
    const centreX = slot.add(0.5).mul(ACTIVE.w / 4) as any;
    const bandTop = bottom.select(float(ACTIVE.h - BAND), float(0)) as any;
    const i = p.sub(vec2(centreX.sub(ICON_SIZE / 2), bandTop.add((BAND - ICON_SIZE) / 2))).div(ICON_SIZE / ICON) as any;
    const cell = inMain.select(m, i) as any;
    const c = floor(cell) as any;
    const n = inMain.select(float(COLS), float(ICON)) as any;
    const rows = inMain.select(float(ROWS), float(ICON)) as any;
    const inside = c.x.greaterThanEqual(0).and(c.x.lessThan(n)).and(c.y.greaterThanEqual(0)).and(c.y.lessThan(rows)) as any;
    const tx = inMain.select(c.x, slot.add(bottom.select(float(4), float(0))).mul(ICON).add(c.x)) as any;
    const ty = inMain.select(c.y, c.y.add(ROWS)) as any;
    const value = texture(tex, vec2(tx.add(0.5).div(TW), ty.add(0.5).div(TH))).r as any;
    // A rounded square filling most of its cell.
    const f = fract(cell).sub(0.5) as any;
    const corner = length(max(abs(f).sub(0.3), 0)) as any;
    const edge = max(fwidth(corner), 0.02) as any;
    const shape = float(1).sub(smoothstep(float(0.13).sub(edge), float(0.13).add(edge), corner)) as any;
    // Unlit dots of the main matrix still show, just: the faint grid of a real one.
    const level = inMain.select(value.mul(0.93).add(0.055), value) as any;
    return inside.select(level.mul(shape), float(0)) as any;
  };

  const eye = normalize(cameraPosition.sub(positionWorld)) as any;
  const local = vec3(eye.dot(right), eye.dot(up), eye.dot(out)) as any;
  const dark = sample(a) as any;
  // The reflector sits under the glass: the dots' shadows on it land offset along the view, softened.
  const depth = 0.05;
  const shift = vec2(local.x.negate(), local.y).div(max(local.z, 0.25)).mul(depth) as any;
  const shadow = sample(a.add(shift)).mul(0.5).add(sample(a.add(shift.mul(1.35))).mul(0.3)) as any;
  const activeEdge = min(min(a.x, float(ACTIVE.w).sub(a.x)), min(a.y, float(ACTIVE.h).sub(a.y))) as any;
  const inActive = smoothstep(0, 0.006, activeEdge) as any;
  // The ground: pale, faintly greener at the middle, dimming toward the frame as the polariser sees it at a slant.
  const ground = mix(color("#84a091"), color("#a9c7b6"), smoothstep(0, 0.35, activeEdge)).mul(float(1).sub(shadow.mul(0.32))) as any;
  const lcd = mix(ground, color("#161b18"), dark.mul(0.9)) as any;
  // The printed frame round the dots: soft black ink with a fine pale rule a little outside them.
  const rule = float(1).sub(smoothstep(0.004, 0.012, abs(activeEdge.add(0.05)))) as any;
  const frame = mix(color("#1c1a22"), color("#8a86a0"), rule.mul(0.6)) as any;
  material.colorNode = vec4(mix(frame, lcd, inActive) as any, 1) as any;
  // The window's glare: a soft diagonal band that slides as the eye moves.
  const band = q.x.mul(0.6).add(q.y).sub(0.55).add(local.x.mul(1.2)) as any;
  material.emissiveNode = vec3(1, 0.97, 0.92).mul(exp(band.mul(band).div(-0.03)).mul(0.035)) as any;

  const update = (pet: Pet, dt: number) => {
    // Dots darken in a few hundredths of a second and fade over a tenth or so, the ghost of the last frame.
    const on = 1 - Math.exp(-dt / 0.03);
    const off = 1 - Math.exp(-dt / 0.12);
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++) {
        const k = y * TW + x;
        const target = pet.dots[y * COLS + x];
        shown[k] += (target - shown[k]) * (target > shown[k] ? on : off);
      }
    for (let n = 0; n < ICONS; n++) {
      // An icon's segments: faintly there when unlit, dark when lit.
      const level = Math.max(0.15, pet.icons[n]);
      const bits = art[n];
      for (let y = 0; y < ICON; y++)
        for (let x = 0; x < ICON; x++) {
          const k = (ROWS + y) * TW + n * ICON + x;
          const target = bits[y * ICON + x] * level;
          shown[k] += (target - shown[k]) * (target > shown[k] ? on : off);
        }
    }
    for (let k = 0; k < TW * TH; k++) data[k * 4] = Math.round(Math.min(1, Math.max(0, shown[k])) * 255);
    tex.needsUpdate = true;
  };

  // Each frame, the screen's frame in the world (from the mesh it is on).
  const place = (mesh: THREE.Object3D) => {
    const e = mesh.matrixWorld.elements;
    right.value.set(e[0], e[1], e[2]).normalize();
    up.value.set(e[4], e[5], e[6]).normalize();
    out.value.set(e[8], e[9], e[10]).normalize();
  };

  return { material, texture: tex, update, place };
}
