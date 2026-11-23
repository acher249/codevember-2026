// The microwave behind the plate, on the wall counter: a charcoal body, its cavity lit warm with a glass turntable, the
// door left ajar, and a green display on the control panel that counts down while it cooks and blinks END once it has
// dinged. Generic, no brand. Its frame: x across (centred), y up from the counter, z = 0 at the door's face, the back at
// -depth. The display sits low on the panel so the start view, which sees only the microwave's lower third, shows it.

import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import * as THREE from "three/webgpu";
import { float, fract, mix, positionGeometry, smoothstep, texture, uniform, uv, vec2, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// When it began cooking and when it dinged (performance.now() ms), set from index.tsx's cook().
export const microwaveState = { cookingSince: 0, doneAt: 0, seconds: 1.8 };

export function buildMicrowave(size: { width: number; height: number; depth: number }, fine: boolean) {
  const { width: W, height: H, depth: D } = size;
  const L = -W / 2;
  // The cavity on the left, the control panel on the right.
  const split = L + W * 0.7;
  const wall = 0.06;
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const keep = <T extends THREE.Material>(m: T) => (materials.push(m), m);
  const seg = fine ? 4 : 2;
  const block = (material: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, r = 0.02, parent: THREE.Object3D = group) => {
    const g = new RoundedBoxGeometry(sx, sy, sz, seg, Math.min(r, sx / 2 - 0.001, sy / 2 - 0.001, sz / 2 - 0.001));
    geometries.push(g);
    const mesh = new THREE.Mesh(g, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // Painted charcoal metal, a faint orange-peel; the panel a glossier black.
  const paint = keep(new THREE.MeshStandardNodeMaterial({ metalness: 0.35, roughness: 0.42 }));
  paint.colorNode = vec3(0.075, 0.075, 0.08) as any;
  const panelBlack = keep(new THREE.MeshStandardNodeMaterial({ metalness: 0.1, roughness: 0.2 }));
  panelBlack.colorNode = vec3(0.025, 0.025, 0.028) as any;
  // The shell round the cavity, and the panel block.
  block(paint, split - L, wall * 1.6, D, (L + split) / 2, H - wall * 0.8, -D / 2);
  block(paint, split - L, 0.1, D, (L + split) / 2, 0.05 + 0.012, -D / 2);
  block(paint, wall, H, D, L + wall / 2, H / 2 + 0.006, -D / 2);
  block(paint, split - L, H, wall, (L + split) / 2, H / 2 + 0.006, -D + wall / 2);
  block(panelBlack, W - (split - L), H - 0.012, D, (split + W / 2) / 2, H / 2 + 0.006, -D / 2, 0.035);
  // Small rubber feet.
  for (const fx of [L + 0.12, W / 2 - 0.12]) for (const fz of [-0.12, -D + 0.12]) block(panelBlack, 0.1, 0.012, 0.1, fx, 0.006, fz, 0.004);

  // The cavity: closed on all five sides in pale grey enamel, lit by its lamp (as emission, so it glows through the gap
  // whatever the sun does); seen through the door's dark mesh only dimly.
  const lamp = uniform(1);
  const enamel = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 }));
  enamel.colorNode = vec3(0.8, 0.8, 0.78) as any;
  enamel.emissiveNode = vec3(1, 0.9, 0.72).mul(lamp).mul(0.32) as any;
  const inside = (w: number, h: number, x: number, y: number, z: number, rx: number, ry: number) => {
    const g = new THREE.PlaneGeometry(w, h);
    geometries.push(g);
    const m = new THREE.Mesh(g, enamel);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    m.receiveShadow = true;
    group.add(m);
  };
  const cx = (L + wall + split) / 2;
  const cw = split - L - wall;
  const y0 = 0.112;
  const y1 = H - wall * 1.6;
  const z1 = -D + wall;
  inside(cw, -z1, cx, y0 + 0.001, z1 / 2, -Math.PI / 2, 0);
  inside(cw, -z1, cx, y1 - 0.001, z1 / 2, Math.PI / 2, 0);
  inside(cw, y1 - y0, cx, (y0 + y1) / 2, z1 + 0.001, 0, 0);
  inside(-z1, y1 - y0, L + wall + 0.001, (y0 + y1) / 2, z1 / 2, 0, Math.PI / 2);
  inside(-z1, y1 - y0, split - 0.001, (y0 + y1) / 2, z1 / 2, 0, -Math.PI / 2);
  // The glass turntable on its roller ring.
  const plateGlass = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.08, metalness: 0, transparent: true, opacity: 0.55 }));
  plateGlass.colorNode = vec3(0.8, 0.86, 0.84) as any;
  const turntable = new THREE.CylinderGeometry(0.4, 0.4, 0.014, fine ? 64 : 32);
  geometries.push(turntable);
  const tt = new THREE.Mesh(turntable, plateGlass);
  tt.position.set(cx, y0 + 0.03, z1 / 2);
  group.add(tt);
  const lampLight = new THREE.PointLight("#ffc98a", 0.9, 3, 2);
  lampLight.position.set(cx, y1 - 0.15, z1 / 2 + 0.1);
  group.add(lampLight);

  // The door, hinged on its left edge and left a little open: a dark frame round smoked glass with the perforated
  // screen behind it, so the lit cavity shows through, and a pull bar at its free edge.
  const door = new THREE.Group();
  door.position.set(L, 0, 0.002);
  door.rotation.y = -0.22;
  group.add(door);
  const dw = split - L;
  const dh = H - 0.03;
  const frame = 0.1;
  block(paint, dw, frame, 0.05, dw / 2, dh - frame / 2 + 0.015, 0.025, 0.02, door);
  block(paint, dw, frame, 0.05, dw / 2, frame / 2 + 0.015, 0.025, 0.02, door);
  block(paint, frame, dh, 0.05, frame / 2, dh / 2 + 0.015, 0.025, 0.02, door);
  block(paint, frame * 1.3, dh, 0.05, dw - frame * 0.65, dh / 2 + 0.015, 0.025, 0.02, door);
  block(panelBlack, 0.035, dh * 0.6, 0.05, dw - 0.07, dh / 2 + 0.015, 0.075, 0.017, door);
  const smoked = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.06, metalness: 0, transparent: true, depthWrite: false }));
  // The screen: small holes on a 3 mm pitch, faded to an even tone where they would be finer than a pixel.
  const holes = smoothstep(
    0.25,
    0.4,
    vec2(fract(uv().x.mul(160)), fract(uv().y.mul(130)))
      .sub(0.5)
      .length()
  ) as any;
  smoked.colorNode = vec3(0.02, 0.02, 0.022) as any;
  smoked.opacityNode = mix(float(0.78), float(0.93), holes) as any;
  const pane = new THREE.PlaneGeometry(dw - frame * 2.3, dh - frame * 2);
  geometries.push(pane);
  const glassPane = new THREE.Mesh(pane, smoked);
  glassPane.position.set(dw / 2 - frame * 0.15, dh / 2 + 0.015, 0.03);
  door.add(glassPane);

  // The display: a small canvas redrawn only when what it shows changes, glowing green, low on the panel.
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  const screen = new THREE.CanvasTexture(canvas);
  screen.colorSpace = THREE.SRGBColorSpace;
  let shown = "";
  const draw = (text: string, lit: boolean) => {
    const key = text + lit;
    if (key === shown) return;
    shown = key;
    ctx.fillStyle = "#020403";
    ctx.fillRect(0, 0, 256, 96);
    ctx.font = `700 64px "DSEG7 Classic", "Courier New", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // The unlit segments, faint, as on a real display.
    ctx.fillStyle = "rgba(80, 255, 150, 0.06)";
    ctx.fillText("8:88", 128, 50);
    if (lit) {
      ctx.shadowColor = "rgba(80, 255, 150, 0.9)";
      ctx.shadowBlur = 14;
      ctx.fillStyle = "#6dffa6";
      ctx.fillText(text, 128, 50);
      ctx.shadowBlur = 0;
    }
    screen.needsUpdate = true;
  };
  draw("0:00", true);
  const display = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.15, metalness: 0 }));
  display.colorNode = vec3(0.01) as any;
  display.emissiveNode = texture(screen, uv()).rgb.mul(2.2) as any;
  const face = new THREE.PlaneGeometry(0.44, 0.165);
  geometries.push(face);
  const panelX = (split + W / 2) / 2;
  const disp = new THREE.Mesh(face, display);
  disp.position.set(panelX, 0.25, 0.0015);
  group.add(disp);
  // A keypad above it: soft-touch buttons in a grid.
  const keys = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0 }));
  keys.colorNode = mix(vec3(0.09, 0.09, 0.1), vec3(0.16, 0.16, 0.17), float(1).sub(smoothstep(0.0, 0.004, positionGeometry.z.abs()))) as any;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) block(keys, 0.12, 0.065, 0.016, panelX - 0.15 + c * 0.15, H * 0.4 + r * H * 0.085, 0.004, 0.012);
  block(keys, 0.42, 0.09, 0.016, panelX, H * 0.84, 0.004, 0.02);

  // Each frame: count down while cooking (0:02 → 0:00), then blink END, half a second on and half off.
  const update = (now: number) => {
    const s = microwaveState;
    if (s.cookingSince > s.doneAt) {
      const left = Math.max(0, s.seconds - (now - s.cookingSince) / 1000);
      draw(`0:0${Math.ceil(left)}`, true);
      lamp.value = 1;
      lampLight.intensity = 0.9;
    } else if (s.doneAt > 0) {
      draw("END", Math.floor((now - s.doneAt) / 500) % 2 === 0);
    } else draw("0:00", true);
  };
  return { group, geometries, materials, textures: [screen], update };
}
