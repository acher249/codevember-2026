"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { use, useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, attribute, cameraPosition, color, dot, max, mix, mx_fractal_noise_float, normalize, positionGeometry, positionWorld, pow, sin, smoothstep, time, uniform, vec3, vec4, vertexStage } from "three/tsl";
import { orbitPoint } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { narrowScreen } from "../../shared/engine/quality";
import { StudioEnvironment } from "../../shared/engine/studio";
import type { DayDefinition, SettingsSchema } from "../../shared/engine/types";
import { lightDevice, type FigureData } from "../photo/figure";
import { GLITCH_SETTINGS, GlitchWatchers, useGlitch } from "../glitch";
import { useSetting } from "../../shared/engine/settings";
import { COLOURS } from "./looks";
import { useAir, Watchers, World, world, type Seat } from "../worlds/common";
import { sculpt, type Kind } from "./materials";
import { Tap } from "./tap";
import { breeze, breezeFor, useBreeze } from "../wind/Wind";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Veil before a world out of focus, as Tension's web hangs before its garden: the statues close, the eye right up at the
// first one's veiled face, and everything behind them gone to soft light: a sky painted as broad glows and blots of
// colour, out-of-focus lights drifting far back as discs, a dark floor melting into it. Each look is its own light.

export type Look = {
  // The sky: overhead, at the horizon, the light behind them (colour, strength, direction toward it), and the soft blots
  // of whatever is out there, darker toward the ground.
  zenith: string;
  horizon: string;
  light: string;
  power: number;
  toLight: [number, number, number];
  blots: [string, string, string];
  // Out-of-focus lights far back, and how many.
  bokeh: string[];
  count: number;
  // The light on the statues: a rim from behind (the sky's light), a fill from in front, the room's colour all round.
  rim: number;
  fill: string;
  fillPower: number;
  ambient: string;
  floor: string;
  exposure: number;
  bloom: number;
  notes: string;
};

const SEATS: Seat[] = [
  [0, 0, 0, true],
  [-0.72, -1.45, 0.18],
  [0.76, -1.35, -0.2]
];

// Where the sun is: the look's own direction, swung round them by the Sun slider (-1 to 1: up to 110° either way).
const sunDir = uniform(new THREE.Vector3(0, 0, -1));
function sunAt(look: Look, swing: number) {
  return new THREE.Vector3(...look.toLight).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), swing * THREE.MathUtils.degToRad(110));
}

function Sky({ look }: { look: Look }) {
  const parts = useMemo(() => {
    // On a phone the noise is worked out at the dome's points and blended between them, not at every pixel: cheaper, and
    // soft by construction, where the Low tier has no depth of field to soften it.
    const light = lightDevice();
    const at = (n: any) => (light ? vertexStage(n) : n) as any;
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const toLight = sunDir as any;
    material.colorNode = Fn(() => {
      const d = normalize(positionWorld.sub(cameraPosition)) as any;
      const up = smoothstep(0.0, 1.1, d.y) as any;
      let rgb = mix(mix(color(look.horizon), color(look.floor), smoothstep(0.0, -0.35, d.y)), color(look.zenith), up) as any;
      const toward = max(dot(d, toLight), 0) as any;
      rgb = rgb.add(color(look.light).mul(pow(toward, 6).mul(0.35).add(pow(toward, 40).mul(0.9)).add(pow(toward, 400).mul(2.5)).mul(look.power)));
      // Out there, out of focus: soft blots of colour, more of them low down, lit through toward the light.
      const n1 = at(mx_fractal_noise_float(d.mul(2.0), 3, 2, 0.5));
      const n2 = at(mx_fractal_noise_float(d.mul(3.3).add(vec3(5.1, 1.7, 3.3)), 3, 2, 0.5));
      const low = smoothstep(0.45, -0.3, d.y) as any;
      const cover = smoothstep(-0.15, 0.3, n1.add(low.mul(0.35))) as any;
      const [a, b, c] = look.blots.map((x) => color(x)) as any[];
      const blot = mix(mix(a, b, smoothstep(-0.2, 0.3, n2)), c, low) as any;
      const through = pow(toward, 2).mul(look.power).mul(0.7).add(0.45) as any;
      return mix(rgb, blot.mul(through), cover.mul(0.8));
    })() as any;
    const geometry = light ? new THREE.SphereGeometry(28, 128, 64) : new THREE.SphereGeometry(28, 48, 24);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -2;
    return { geometry, material, mesh };
  }, [look]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// Lights far behind, out of focus: each a soft disc with a brighter rim, as a lens draws them, twinkling a little,
// gathered toward the light.
function Bokeh({ look }: { look: Look }) {
  const parts = useMemo(() => {
    let s = 4049;
    const random = () => (s = (s * 16807) % 2147483647) / 2147483647;
    // Half as many on a phone: each is a large soft disc laid over the rest, and there they are small on screen anyway.
    const count = lightDevice() ? Math.ceil(look.count / 2) : look.count;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const at: number[] = [];
    const tint: number[] = [];
    const [lx, ly] = look.toLight;
    for (let i = 0; i < count; i++) {
      const pull = random();
      at.push((random() - 0.5) * 22 + lx * 6 * pull, 1.4 + (random() - 0.5) * 7 + ly * 4 * pull, -6 - random() * 16, 0.15 + random() ** 2 * 0.8);
      tint.push(Math.floor(random() * look.bokeh.length), random() * 100, 0.35 + random() * 0.65, 0);
    }
    geometry.setAttribute("aAt", new THREE.InstancedBufferAttribute(new Float32Array(at), 4));
    geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(new Float32Array(tint), 4));
    geometry.instanceCount = count;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const placed = attribute("aAt", "vec4") as any;
    const t = attribute("aTint", "vec4") as any;
    const centre = placed.xyz as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(vec3(toEye.z, 0, toEye.x.negate())) as any;
    const upward = normalize(toEye.cross(right).negate()) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(placed.w))).add(upward.mul(positionGeometry.y.mul(placed.w))) as any;
    const colours = look.bokeh.map((c) => color(c));
    const pick = colours.reduce((acc: any, c: any, i: number) => (i === 0 ? c : mix(acc, c, t.x.greaterThanEqual(i).select(1, 0))), colours[0]) as any;
    material.colorNode = Fn(() => {
      const r = positionGeometry.xy.length() as any;
      const disc = smoothstep(1, 0.92, r) as any;
      const rim = smoothstep(0.68, 0.97, r).mul(disc).mul(0.55) as any;
      const twinkle = sin(time.mul(0.6).add(t.y)).mul(0.2).add(0.8) as any;
      return vec4(pick.mul(disc.mul(0.5).add(rim)).mul(t.z).mul(twinkle).mul(0.9), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    return { geometry, material, mesh };
  }, [look]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// The floor they sit on, of the same stone (or glass) as they are, fading into the sky with distance; raised a little,
// so they sink into it and the cloth's last fall onto the ground is hidden under it.
const FLOOR_Y = 0.1;
function Floor({ look }: { look: Look }) {
  const kind = (useSetting<string>("material") as Material) ?? "glass";
  const parts = useMemo(() => {
    const geometry = new THREE.CircleGeometry(8, 96);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, FLOOR_Y, 0);
    const palette = { key: look.light, left: look.fill, right: look.bokeh[0], zenith: look.zenith, horizon: look.horizon };
    const material = sculpt(kind as Kind, palette) as THREE.NodeMaterial;
    material.transparent = true;
    material.depthWrite = false;
    // Gone well before it could meet the sky in a line.
    material.opacityNode = smoothstep(7, 2.5, (positionWorld as any).xz.length()) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return { geometry, material, mesh };
  }, [look, kind]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

function Light({ look }: { look: Look }) {
  const swing = useSetting<number>("sun") ?? 0;
  const parts = useMemo(() => {
    const rim = new THREE.DirectionalLight(look.light, look.rim);
    rim.target.position.set(0, 1, 0);
    rim.castShadow = true;
    rim.shadow.mapSize.setScalar(lightDevice() ? 1024 : 2048);
    const cam = rim.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -4;
    cam.right = cam.top = 4;
    cam.near = 1;
    cam.far = 25;
    rim.shadow.bias = -0.0004;
    rim.shadow.normalBias = 0.02;
    rim.shadow.radius = 6;
    // The key on her face: from in front, high and to the left, so the veil's folds over it read.
    const fill = new THREE.DirectionalLight(look.fill, look.fillPower);
    fill.position.set(-2.2, 3.2, 3.4);
    fill.target.position.set(0, 1.2, 0);
    const room = new THREE.HemisphereLight(look.zenith, look.floor, 0.35);
    return { rim, fill, room };
  }, [look]);
  // The rim light and the sky's glow go where the sun is.
  useEffect(() => {
    const dir = sunAt(look, swing);
    sunDir.value.copy(dir);
    parts.rim.position.copy(dir).multiplyScalar(10).add(new THREE.Vector3(0, 1, 0));
  }, [look, swing, parts]);
  return (
    <>
      <StudioEnvironment
        ambient={look.ambient}
        intensity={1}
        boxes={[
          { position: [look.toLight[0] * 6, 2 + look.toLight[1] * 6, look.toLight[2] * 6], scale: [5, 4, 0.2], color: look.light, intensity: 2.5 * look.power },
          { position: [-3, 3, 4], scale: [3, 3, 0.2], color: look.fill, intensity: 1.2 }
        ]}
      />
      <primitive object={parts.rim} />
      <primitive object={parts.rim.target} />
      <primitive object={parts.fill} />
      <primitive object={parts.fill.target} />
      <primitive object={parts.room} />
    </>
  );
}

// The lens stays on whatever the eye is turned about (her face, to start), so all behind goes soft.
function Focus() {
  const camera = useThree((state) => state.camera);
  useFrame(() => {
    if (orbitPoint.current) focusDistance.value = Math.max(0.4, camera.position.distanceTo(orbitPoint.current));
    focusBlur.value = 3.2;
  });
  return null;
}

// What they are made of: chosen in the panel, starting from ?m= in the address if given, else clear glass.
const MATERIALS = ["marble", "nero", "glass", "obsidian"] as const;
type Material = (typeof MATERIALS)[number];
function asked(): Material {
  const m = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("m");
  return m && (MATERIALS as readonly string[]).includes(m) ? (m as Material) : "glass";
}
const NAMES: Record<string, string> = { marble: "Carrara", nero: "Nero Marquina", calacatta: "Calacatta" };
// Shorter, for the chips along a phone's dock.
const SHORT: Record<string, string> = { nero: "Nero" };
const label = (s: string) => NAMES[s] ?? s[0].toUpperCase() + s.slice(1);

// On a phone, what they are made of and the world behind as rows of chips along the bottom, Glitch just above
// them under the thumb; the Sun stays in the panel.
const PHONE: Partial<DayDefinition> = { phoneDock: ["material", "background"], phoneDockPills: ["glitch"] };

const UPRIGHT = { position: [0.1, 1.25, 3.2] as [number, number, number], target: [0.01, 0.76, 0] as [number, number, number], fov: 40 };
const upright = () => typeof window !== "undefined" && window.innerHeight > window.innerWidth;

export function blurred(look: Look, name = "ember"): DayDefinition {
  // The world behind: the version's own colours, or one of the others from the panel.
  const useLook = () => {
    const chosen = useSetting<string>("background");
    return chosen && chosen in COLOURS ? COLOURS[chosen as keyof typeof COLOURS] : look;
  };
  // Glitching (from the settings) through every material, or held in the one chosen.
  function Statues({ data, look }: { data: FigureData; look: Look }) {
    const glitch = useGlitch();
    const kind = (useSetting<string>("material") as Material) ?? "glass";
    const keyDir = useMemo(() => new THREE.Vector3(...look.toLight).normalize(), [look]);
    const palette = useMemo(() => ({ key: look.light, left: look.fill, right: look.bokeh[0], zenith: look.zenith, horizon: look.horizon }), [look]);
    // The breeze (wind/Wind.tsx): every material moves them as it has it. Waited for behind the loader (fetched with the
    // page, bound in a worker), so the scene opens already moving.
    const wind = use(breezeFor(data));
    useBreeze(wind);
    const base = useMemo(() => () => breeze(wind), [wind]);
    const make = useMemo(
      () => () => {
        const material = sculpt(kind as Kind, palette) as THREE.NodeMaterial;
        material.positionNode = base();
        return material;
      },
      [kind, palette, base]
    );
    return glitch ? <GlitchWatchers data={data} seats={SEATS} keyDir={keyDir} palette={palette} style={glitch} base={base} /> : <Watchers data={data} seats={SEATS} keyDir={keyDir} make={make} />;
  }
  function Scene() {
    const look = useLook();
    useAir(look.horizon, 3, 16);
    // The world at once; the statues as soon as they are loaded, so the page is never an empty colour while they come.
    return (
      <>
        <Focus />
        <Tap />
        <Sky look={look} />
        <Bokeh look={look} />
        <Light look={look} />
        <Floor look={look} />
        <World>{(data) => <Statues data={data} look={look} />}</World>
      </>
    );
  }
  const settings: SettingsSchema = {
    sun: { type: "range", label: "Sun", min: -1, max: 1, step: 0.01, value: 0, reset: 0 },
    material: { type: "choice", label: "Material", value: asked(), options: MATERIALS.map((m) => ({ value: m, label: label(m), short: SHORT[m] })), when: { setting: "glitch", is: false } },
    background: {
      type: "choice",
      label: "Background",
      // Ash to start, whichever version: pale and smoky, the statues read best against it.
      value: "ash",
      options: [
        { value: "own", label: label(name), swatch: [look.light, look.horizon] },
        ...(Object.keys(COLOURS) as (keyof typeof COLOURS)[]).map((c) => ({ value: c, label: label(c), swatch: [COLOURS[c].light, COLOURS[c].horizon] }))
      ]
    }
  };
  const day = world(Scene, { background: look.horizon, exposure: look.exposure, bloom: look.bloom, bloomThreshold: 0.9, ao: 1, aoRadius: 0.12, vignette: 0.5, grain: 0.016, haze: 0 }, look.notes, {
    // Upright (a phone, or a tablet held upright, where the desktop's view showed only her shoulder): back far enough for
    // all three, the near one whole and focused on, above the dock; and room to pinch in to her veiled face from there
    // (the limits are measured from where the view starts).
    ...(upright() ? UPRIGHT : { position: [0, 1.15, 1.95], target: [0, 1.05, -0.2], fov: 30 }),
    phone: UPRIGHT,
    limits: { turn: { left: 80, right: 80, up: 35, down: 25 }, move: { left: 1.5, right: 1.5, down: 1, up: 1.5, nearer: upright() || narrowScreen() ? 1.9 : 0.35, further: upright() || narrowScreen() ? 3 : 6 } }
  });
  return { ...day, settings: { ...day.settings, ...settings, ...GLITCH_SETTINGS }, passes: { ...day.passes, haze: false, depthOfField: { range: 0.35 } }, ...PHONE } as DayDefinition;
}

