// The toy itself, assembled once at load: two candy-plastic halves and the seam between them, the screen in its window,
// three buttons, the keyring loop with a split ring and a ball chain running up out of view, and the pull-tab through the
// battery door. The plastic: a deep-to-bright candy tone marbled with paler swirls and a fleck of glitter, glowing a
// little through itself on the side away from the lamp (its translucence), under a clear gloss that the hands have been
// at: smudges, two fingerprints, fine scratches.

import * as THREE from "three/webgpu";
import {
  abs,
  bumpMap,
  clamp,
  dot,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  mix,
  mx_fractal_noise_float,
  normalize,
  normalView,
  normalWorld,
  positionLocal,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { createScreen, SCREEN } from "./lcd";
import { backPrint, frontPrint, PRINT, tabPrint } from "./print";
import { BUTTONS, buttonCap, HALF_H, outline, seam, SCREEN_Z, shellHalf, SOCKET_Z, TAB, TAB_SIZE, tabStrip } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Shell colours: the plastic, its deep tone, its swirl, and the buttons.
export const SHELLS: Record<string, { candy: string; deep: string; swirl: string; button: string }> = {
  grape: { candy: "#8b5cf6", deep: "#3b1a8a", swirl: "#d9c6ff", button: "#ff4f9a" },
  bubblegum: { candy: "#ff6fb0", deep: "#a3195b", swirl: "#ffe0ef", button: "#5de0e6" },
  tangerine: { candy: "#ff8a2a", deep: "#a83a06", swirl: "#ffe2b8", button: "#fff3c4" },
  mint: { candy: "#3fd6a8", deep: "#0b6b58", swirl: "#e2fff4", button: "#9a6bff" }
};

// Up the chain to where it hangs from, out of view above.
export const CHAIN_TOP = 34;
const LOOP_Y = HALF_H + 0.12;

const hash = (p: any) => fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;

export function createEgg() {
  const colours = {
    candy: uniform(new THREE.Color(SHELLS.grape.candy)),
    deep: uniform(new THREE.Color(SHELLS.grape.deep)),
    swirl: uniform(new THREE.Color(SHELLS.grape.swirl)),
    button: uniform(new THREE.Color(SHELLS.grape.button))
  };
  // Toward the lamp, in the world, for the glow through the plastic.
  const lampDir = uniform(new THREE.Vector3(-0.8, 0.4, 0.5).normalize());
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const keep = <T extends THREE.BufferGeometry>(g: T) => (geometries.push(g), g);

  const front = frontPrint();
  const back = backPrint();
  const tabInk = tabPrint();
  textures.push(front, back.ink, back.relief, tabInk);

  // The candy plastic. `side` 1 front, -1 back: which print, and fingerprints only on the front.
  const plastic = (side: 1 | -1) => {
    const m = new THREE.MeshPhysicalNodeMaterial({ clearcoat: 1 });
    const p = positionLocal as any;
    const warp = mx_fractal_noise_float(p.mul(0.42), 3, 2, 0.5) as any;
    const swirl = sin(p.x.mul(0.9).add(p.y.mul(0.7)).add(p.z.mul(0.5)).add(warp.mul(5.5))).mul(0.5).add(0.5) as any;
    const ribbons = smoothstep(0.72, 0.98, swirl) as any;
    let base = mix(colours.deep, colours.candy, smoothstep(-0.9, 0.9, p.y.mul(0.22).add(warp.mul(1.6)).add(0.25))) as any;
    base = mix(base, colours.swirl, ribbons.mul(0.3)) as any;

    // Glitter: a few flakes in every square centimetre, each a tiny mirror at its own tilt.
    const g = p.mul(24) as any;
    const cell = floor(g) as any;
    const jitter = vec3(hash(cell.add(1.3)), hash(cell.add(7.1)), hash(cell.add(3.7))) as any;
    const spot = length(fract(g).sub(0.5).sub(jitter.sub(0.5).mul(0.5))) as any;
    // The print: white ink straight on, over the glitter.
    const printUv = vec2(p.x.mul(side).div(PRINT.w).add(0.5), p.y.div(PRINT.h).add(0.5)) as any;
    const ink = texture(side === 1 ? front : back.ink, printUv) as any;
    const flake = step(hash(cell), 0.06).mul(float(1).sub(smoothstep(0.1, 0.18, spot))).mul(float(1).sub(ink.a)) as any;
    m.colorNode = vec4(mix(mix(base, colours.swirl, flake.mul(0.6)), ink.rgb, ink.a), 1) as any;
    m.roughnessNode = mix(float(0.38), float(0.16), flake).add(ink.a.mul(0.2)) as any;
    m.metalnessNode = flake.mul(0.5) as any;
    const flaked = normalize(normalView.add(jitter.sub(0.5).mul(1.4).mul(flake))) as any;
    if (side === 1) m.normalNode = flaked;
    else {
      // The back's moulding: the name, the door's groove, the screw and the pin hole, pressed in.
      // Given the texture node itself, so the bump can step its coordinates a pixel each way.
      const bumped = bumpMap(texture(back.relief, printUv), float(3)) as any;
      m.normalNode = normalize(bumped.add(jitter.sub(0.5).mul(1.4).mul(flake))) as any;
      m.clearcoatNormalNode = bumped;
    }

    // The gloss, handled: broad soft smudges, a fingerprint or two, and fine scratches every which way.
    const smudge = smoothstep(0.05, 0.55, mx_fractal_noise_float(p.mul(0.55).add(4.2), 3, 2, 0.5)) as any;
    let print: any = float(0);
    const prints = side === 1 ? [[1.55, -0.45, 0.35], [-0.7, -2.15, 0.4]] : [[-0.6, 0.9, 0.42], [0.9, -1.9, 0.36]];
    const whorl = mx_fractal_noise_float(p.mul(3), 2, 2, 0.5).mul(3) as any;
    for (const [fx, fy, size] of prints) {
      const d = length(p.xy.sub(vec2(fx, fy)).mul(vec2(1, 1.3))) as any;
      const ridges = sin(d.mul(95).add(whorl)).mul(0.5).add(0.5) as any;
      print = print.add(ridges.mul(float(1).sub(smoothstep(size * 0.6, size, d))));
    }
    const scratch = (scale: number, chance: number) => {
      const s = p.xy.add(p.z.mul(0.3)).mul(scale) as any;
      const c = floor(s) as any;
      const angle = hash(vec3(c, 1)).mul(Math.PI) as any;
      const dir = vec2(angle.cos(), angle.sin()) as any;
      const f = fract(s).sub(0.5).sub(vec2(hash(vec3(c, 2)), hash(vec3(c, 3))).sub(0.5).mul(0.4)) as any;
      const across = abs(dot(f, vec2(dir.y.negate(), dir.x))) as any;
      const along = abs(dot(f, dir)) as any;
      const width = max(fwidth(across), 0.008) as any;
      return float(1).sub(smoothstep(0, width, across)).mul(step(along, hash(vec3(c, 4)).mul(0.35).add(0.12))).mul(step(hash(vec3(c, 5)), chance)) as any;
    };
    const scratches = scratch(2.2, 0.3).add(scratch(5.5, 0.22).mul(0.7)).min(1) as any;
    m.clearcoatRoughnessNode = float(0.025).add(smudge.mul(0.22)).add(print.mul(0.32)).add(scratches.mul(0.3)).min(0.6) as any;
    m.clearcoatNode = float(1).sub(print.mul(0.25)) as any;

    // Translucence: light through the plastic glows out on the side away from the lamp, most where it is thin (round
    // the seam).
    const away = clamp(dot(normalWorld, lampDir).negate().mul(0.55).add(0.45), 0, 1) as any;
    const thin = float(1).sub(smoothstep(0.1, 1.2, abs(p.z))) as any;
    m.emissiveNode = colours.candy.mul(away.mul(away).mul(0.16).add(0.025)).mul(thin.mul(0.9).add(0.35)).mul(float(1).sub(ink.a)) as any;
    materials.push(m);
    return m;
  };

  const frontPlastic = plastic(1);
  const backPlastic = plastic(-1);

  const body = new THREE.Group();
  const frontHalf = new THREE.Mesh(keep(shellHalf(true)), frontPlastic);
  const backHalf = new THREE.Mesh(keep(shellHalf(false)), backPlastic);
  const seamMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
  seamMaterial.colorNode = colours.deep.mul(0.18) as any;
  materials.push(seamMaterial);
  const seamBand = new THREE.Mesh(keep(seam()), seamMaterial);
  for (const mesh of [frontHalf, backHalf, seamBand]) {
    mesh.castShadow = mesh.receiveShadow = true;
    body.add(mesh);
  }

  // The screen, on the window's floor.
  const screen = createScreen();
  materials.push(screen.material);
  textures.push(screen.texture);
  const lcd = new THREE.Mesh(keep(new THREE.PlaneGeometry(SCREEN.w, SCREEN.h)), screen.material);
  lcd.position.set(0, SCREEN.y, SCREEN_Z + 0.004);
  lcd.receiveShadow = true;
  body.add(lcd);

  // Buttons: chunky, glossy, solid colour. Each rides in its own group so it can travel in.
  const buttonMaterial = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.12 });
  {
    const p = positionLocal as any;
    const wear = smoothstep(0.1, 0.6, mx_fractal_noise_float(p.mul(4), 2, 2, 0.5)) as any;
    buttonMaterial.colorNode = mix(colours.button, colours.button.mul(1.08), wear.mul(0.4)) as any;
    buttonMaterial.clearcoatRoughnessNode = float(0.08).add(wear.mul(0.25)) as any;
  }
  materials.push(buttonMaterial);
  const cap = keep(buttonCap());
  const buttons = BUTTONS.map((b, k) => {
    const mesh = new THREE.Mesh(cap, buttonMaterial);
    mesh.position.set(b.x, b.y, SOCKET_Z[k]);
    mesh.castShadow = mesh.receiveShadow = true;
    body.add(mesh);
    return mesh;
  });

  // The keyring loop, moulded on top, and a split ring through it.
  const loop = new THREE.Mesh(keep(new THREE.TorusGeometry(0.34, 0.13, 20, 48)), frontPlastic);
  loop.position.set(0, LOOP_Y, 0);
  loop.castShadow = true;
  body.add(loop);
  const metal = new THREE.MeshStandardNodeMaterial({ color: "#d6d6dc", metalness: 1, roughness: 0.2 });
  materials.push(metal);
  const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(0.42, 0.035, 12, 64)), metal);
  ring.rotation.y = Math.PI / 2;
  ring.position.set(0, LOOP_Y + 0.42, 0);
  ring.castShadow = true;
  body.add(ring);

  // The ball chain: little beads on short links, straight up out of view.
  const BEAD = 0.075;
  const SPACING = 0.2;
  const from = LOOP_Y + 0.84;
  const count = Math.ceil((CHAIN_TOP + 1 - from) / SPACING);
  const beads = new THREE.InstancedMesh(keep(new THREE.SphereGeometry(BEAD, 14, 10)), metal, count);
  const links = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(0.022, 0.022, SPACING, 6)), metal, count);
  const mat = new THREE.Matrix4();
  for (let k = 0; k < count; k++) {
    mat.makeTranslation(0, from + k * SPACING, 0);
    beads.setMatrixAt(k, mat);
    mat.makeTranslation(0, from + (k + 0.5) * SPACING, 0);
    links.setMatrixAt(k, mat);
  }
  beads.castShadow = links.castShadow = true;
  // The first link joins the ring's top to the first bead.
  body.add(beads, links);

  // The pull-tab, out through the seam low on the right, from the battery behind, so it shows from the front.
  const tabMaterial = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.1 });
  {
    const p = positionLocal as any;
    const tuv = vec2(p.x.div(TAB_SIZE.w).add(0.5), p.y.add(TAB_SIZE.inside).div(TAB_SIZE.out + TAB_SIZE.inside)) as any;
    tabMaterial.colorNode = texture(tabInk, tuv) as any;
  }
  materials.push(tabMaterial);
  const tab = new THREE.Mesh(keep(tabStrip()), tabMaterial);
  tab.castShadow = true;
  const tabHome = new THREE.Group();
  const out = outline(TAB.angle);
  tabHome.position.set(out.x, out.y, TAB.z);
  // Its length straight out of the outline, its free end curling a little toward the viewer.
  tabHome.rotation.set(0.3, 0, Math.atan2(-out.nx, out.ny), "ZXY");
  tabHome.add(tab);
  body.add(tabHome);

  // The hang: a pivot up at the chain's top that the whole toy swings from, and the toy turning on the chain.
  const pivot = new THREE.Group();
  pivot.position.set(0, CHAIN_TOP, 0);
  const twist = new THREE.Group();
  twist.position.set(0, -CHAIN_TOP, 0);
  pivot.add(twist);
  twist.add(body);

  const setShell = (name: string) => {
    const s = SHELLS[name] ?? SHELLS.grape;
    colours.candy.value.set(s.candy);
    colours.deep.value.set(s.deep);
    colours.swirl.value.set(s.swirl);
    colours.button.value.set(s.button);
  };

  return {
    pivot,
    twist,
    body,
    lcd,
    screen,
    buttons,
    tab,
    tabHome,
    lampDir,
    setShell,
    halves: [frontHalf, backHalf] as THREE.Mesh[],
    dispose: () => {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
    }
  };
}

export type Egg = ReturnType<typeof createEgg>;
