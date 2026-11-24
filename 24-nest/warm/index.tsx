"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { cameraTaken, orbitControls, orbitPoint, useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { airAmount, airTint, focusBlur, focusDistance, postBypass } from "../../shared/engine/Post";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { loadRetried, suspendRetried } from "../../shared/engine/retry";
import { useSettingRef } from "../../shared/engine/settings";
import { sound, useBed, useMusic } from "../../shared/engine/sound";
import { StudioEnvironment } from "../../shared/engine/studio";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Air, PUFFS } from "./air";
import { Chick, CHICK, chickKit, type Mood } from "./chick";
import { lighting } from "./light";
import { buildNest, type Scans } from "./nest";
import { buildLeaves } from "./leaves";
import { buildSetting, FACING, MOUNT } from "./setting";
import { chirp, detent, pant, peep, plink } from "./sound";
import { buildThermostat, HIGH, LOW, RING, STEP_ANGLE } from "./thermostat";

// A cold nest on a snowy branch at dusk, three chicks huddled and shivering, and screwed to the trunk beside it a round
// smart thermostat reading 28°. Turn its dial and the whole scene warms with it: the snow melts and drips away, the frost
// goes, the light turns gold, and the chicks loosen, stretch, peep and doze. Turn it all the way up and they pant.
// Centimetres throughout; the nest's rim at the origin.

const START = new THREE.Vector3(5.7, 17, 47.8);
const TARGET = new THREE.Vector3(5.7, 1.5, 0);
const FOV = 30;
// The thermostat's face, in its own frame.
const FACE_Z = 0.35 + RING.depth;
// Where the dial says it is just right, and where the chicks start to suffer.
const COMFY: [number, number] = [64, 74];
// Flakes in the air by tier.
const FLAKES = { low: 700, medium: 1500, high: 2400 } as const;
// Pollen and dust in the warm air, by tier.
const MOTES = { low: 300, medium: 600, high: 900 } as const;
// The light from behind: dim moonlight in the cold, low gold sun once warm. And the air's colour in depth with them.
const MOON = new THREE.Color("#6f86c8").multiplyScalar(0.35);
const LOW_SUN = new THREE.Color("#ffb45a").multiplyScalar(1.6);
const MIST = { cold: new THREE.Color(0.025, 0.04, 0.085), warm: new THREE.Color(0.62, 0.4, 0.2) };
const AIR_TINT = new THREE.Color("#d8c8b4");

// The chicks' places in the cup when warm (spread out, facing the camera a little each their own way) and when cold
// (pressed together in the middle).
const SPOTS: [number, number, number][] = [
  [-3.3, 0.5, 0.35],
  [0.1, -1.4, 0.0],
  [3.3, 0.2, -0.4]
];
const HUDDLE = 0.72;

const ACCENT = { heating: new THREE.Color("#ff7a1a"), cooling: new THREE.Color("#3a9cff"), eco: new THREE.Color("#5ad27c") };
// Teeth chattering, played over and over while the chicks are cold.
const CHATTER = "/assets/24-nest/chatter.mp3";
// AWAY: after this many seconds untouched, and after blinking up for this long, the dial turns itself all the way
// down, taking a second and a half plus this long for each degree.
const AWAY = { after: 10, blink: 1.6, perDegree: 0.1 };
const GLOW = { heating: new THREE.Color("#ff7a1a").multiplyScalar(1.4), cooling: new THREE.Color("#5aa8ff").multiplyScalar(1.1), idle: new THREE.Color("#e8e4dc").multiplyScalar(0.45) };

const scratch = {
  a: new THREE.Vector3(),
  b: new THREE.Vector3(),
  c: new THREE.Vector3(),
  inverse: new THREE.Matrix4(),
  ray: new THREE.Ray(),
  plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -FACE_Z),
  colour: new THREE.Color(),
  colour2: new THREE.Color(),
  caster: new THREE.Raycaster(),
  ndc: new THREE.Vector2()
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// Colour stops along the heat, for the lights.
const KEY: [number, string, number][] = [
  [0, "#7e98e4", 0.9],
  [0.35, "#b4b4d0", 1.6],
  [0.65, "#ffc58a", 3.1],
  [1, "#ff9448", 3.6]
];
const SKY: [number, string, number][] = [
  [0, "#24346a", 0.55],
  [0.35, "#4a4a6a", 0.8],
  [0.65, "#9a7660", 1.05],
  [1, "#a8643e", 1.1]
];
// The whole picture's exposure: a dim cold night brightening into a warm evening, with the light's own rise on top.
const EXPOSURE: [number, number][] = [
  [0, 0.68],
  [0.6, 1.15],
  [1, 1.25]
];
const GROUND: [number, string, number][] = [
  [0, "#1a2238", 0.6],
  [0.65, "#3a2a22", 0.6],
  [1, "#4a2a1a", 0.6]
];
function along(stops: [number, string, number][], h: number, out: THREE.Color) {
  let i = 0;
  while (i < stops.length - 2 && h > stops[i + 1][0]) i++;
  const [h0, c0, k0] = stops[i];
  const [h1, c1, k1] = stops[i + 1];
  const t = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
  out.set(c0).multiplyScalar(k0);
  return out.lerp(scratch.colour2.set(c1).multiplyScalar(k1), t);
}

function useScans(): Scans {
  const urls = ["bark_brown_02_diff_2k.jpg", "bark_brown_02_nor_gl_1k.jpg", "bark_brown_02_rough_1k.jpg", "bark_brown_02_disp_1k.jpg", "moss_diff_1k.jpg"].map((f) => `/assets/24-nest/${f}`);
  const [bark, barkNormal, barkRough, barkDisp, moss] = suspendRetried(() => Promise.all(urls.map((url) => loadRetried(new THREE.TextureLoader(), url))), ["nest-warm", ...urls]);
  for (const [t, colour] of [
    [bark, true],
    [barkNormal, false],
    [barkRough, false],
    [barkDisp, false],
    [moss, true]
  ] as [THREE.Texture, boolean][]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    t.needsUpdate = true;
  }
  return { bark, barkNormal, barkRough, barkDisp, moss };
}

function Scene() {
  const { tier } = useQuality();
  // Counts are set by the tier the visit starts on, so a later step down never rebuilds the scene.
  // (In development, ?build=low builds the scene as a phone would, to measure it on a desktop.)
  const startTier = useRef(process.env.NODE_ENV !== "production" && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("build") === "low" ? "low" : tier).current;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const snowfall = useSettingRef<boolean>("snowfall");
  const scans = useScans();
  const l = useMemo(() => lighting(), []);
  const nest = useMemo(() => buildNest(l, scans, 101, startTier === "low" ? 0.6 : 1), [l, scans, startTier]);
  const setting = useMemo(() => buildSetting(l, scans, startTier), [l, scans, startTier]);
  const thermostat = useMemo(() => buildThermostat(l), [l]);
  const leaves = useMemo(
    () =>
      buildLeaves(
        l,
        [
          { twigs: setting.twigs, count: startTier === "low" ? 110 : 300, size: [2.4, 5] },
          // Round the nest, dense: it sits in a leafy pocket once warm.
          { twigs: setting.sprigTwigs, count: startTier === "low" ? 160 : 520, size: [1.8, 5.5] },
          // The wood's canopies: bigger, as they are only ever seen far off and soft.
          { twigs: setting.canopy, count: startTier === "low" ? 500 : 1500, size: [9, 20] }
        ],
        setting.perch,
        setting.perchRadius,
        55,
        // Nothing growing inside the cup, where the chicks sit.
        (p) => Math.hypot(p.x, p.z) < nest.shape.inner + 1.5 && p.y > -nest.shape.innerDepth - 1.5 && p.y < 4
      ),
    [l, setting, nest, startTier]
  );
  useDispose(leaves.geometry, leaves.material);
  const kit = useMemo(() => chickKit(CHICK, l, 300, startTier === "low" ? 0.5 : 1), [l, startTier]);
  useDispose(...nest.geometries, ...nest.materials, ...setting.geometries, ...setting.materials, ...setting.textures, ...thermostat.geometries, ...thermostat.materials, ...thermostat.textures, ...kit.geometries, ...kit.materials);

  const floor = -nest.shape.innerDepth * 0.3;
  const chicks = useMemo(
    () =>
      SPOTS.map(([x, z, yaw], k) => {
        // The middle one dozes off when it is just right; all of them put on shades when it is hot.
        const chick = new Chick(kit, k, 700 + k, k === 1, true);
        chick.group.position.set(x * HUDDLE, floor, z * HUDDLE);
        chick.group.rotation.y = yaw;
        chick.group.scale.setScalar(0.86 + k * 0.03);
        // Clear of the nest: above the rim, or not out through the wall (brushing into the soft lining is fine).
        chick.clear = (p) => p.y > 0.6 || Math.hypot(p.x, p.z) < nest.shape.inside(Math.min(1, Math.max(0, -p.y / nest.shape.innerDepth))).r + 0.3;
        return chick;
      }),
    [kit, floor, nest]
  );

  // The thermostat, flat on the trunk, facing the camera.
  useMemo(() => {
    const g = thermostat.group;
    g.position.copy(MOUNT);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), FACING);
    g.updateMatrixWorld(true);
    l.glowAt.value.copy(new THREE.Vector3(0, 0, FACE_Z + 0.6).applyMatrix4(g.matrixWorld));
  }, [thermostat, l]);

  // Lights: the evening's key from the front left, the sky and snow's fill, and the screen's glow on what is near it.
  const lights = useMemo(() => {
    const key = new THREE.DirectionalLight(0xffffff, 1);
    key.position.copy(l.toSun.value).multiplyScalar(80).add(TARGET);
    key.target.position.copy(TARGET);
    key.castShadow = startTier !== "low";
    key.shadow.mapSize.set(1024, 1024);
    const c = key.shadow.camera as THREE.OrthographicCamera;
    c.left = c.bottom = -26;
    c.right = c.top = 26;
    c.near = 30;
    c.far = 140;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.04;
    key.shadow.radius = 4;
    const fill = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    const glow = new THREE.PointLight(0xffffff, 0, 70, 2);
    // In front of the face and well above it, so the domed glass cannot mirror it back at the eye and it stays clear of
    // the nest, lighting it softly from the side.
    glow.position.copy(l.glowAt.value).addScaledVector(FACING, 3.5).add(new THREE.Vector3(0, 6, 0));
    return { key, fill, glow };
  }, [l, startTier]);
  useDispose(lights.key, lights.fill, lights.glow);

  // The breath puffs: four per chick, each its centre and age.
  const puffs = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  }, []);
  const breath = useMemo(() => ({ from: Array.from({ length: PUFFS }, () => new THREE.Vector3()), vel: Array.from({ length: PUFFS }, () => new THREE.Vector3()), age: new Float32Array(PUFFS).fill(1), next: 0 }), []);
  // How heavy the snowfall is, and how much breath shows.
  const u = useMemo(() => ({ fall: uniform(1), breath: uniform(1) }), []);

  const state = useRef({
    // The dial: where it is (degrees, fractional while turning), where it has clicked to, the room's temperature.
    value: LOW,
    clicked: LOW,
    room: LOW,
    dragging: false,
    lastAngle: 0,
    wheel: 0,
    time: 0,
    snow: 1,
    frost: 1,
    wet: 0,
    fall: 1,
    nextPlink: 0,
    nextPant: 0,
    earned: false,
    cooked: false,
    // Seconds since anyone did anything on the page; whether it has gone AWAY, for how long, and from what setting;
    // and how far the screen has faded into the word (0 to 1).
    idle: 0,
    gone: false,
    goneFor: 0,
    from: LOW,
    away: 0,
    nextChatter: 1
  });
  // Someone did something: back from AWAY, if it had gone, and the chicks pipe up about it.
  const wake = () => {
    const s = state.current;
    if (s.gone) chicks.forEach((chick, k) => chick.answer(0.05 + k * 0.12));
    s.gone = false;
    s.idle = 0;
  };

  // Turn the dial: what a ray lands on, in the thermostat's frame.
  const onFace = (ray: THREE.Ray, out: THREE.Vector3) => {
    scratch.inverse.copy(thermostat.group.matrixWorld).invert();
    const local = scratch.ray.copy(ray).applyMatrix4(scratch.inverse);
    return local.intersectPlane(scratch.plane, out);
  };
  const angleOf = (p: THREE.Vector3) => Math.atan2(p.y, p.x);
  const turnTo = (value: number) => {
    const s = state.current;
    s.value = THREE.MathUtils.clamp(value, LOW, HIGH);
  };

  useGrabbable({
    pick: (ray) => {
      const at = onFace(ray, scratch.a);
      if (!at || Math.hypot(at.x, at.y) > RING.radius * 1.12) return null;
      const point = at.clone().applyMatrix4(thermostat.group.matrixWorld);
      return { distance: ray.origin.distanceTo(point), point };
    },
    grab: (point) => {
      const s = state.current;
      const local = thermostat.group.worldToLocal(scratch.a.copy(point));
      s.lastAngle = angleOf(local);
      s.dragging = true;
      wake();
      dismissPrompt();
    },
    drag: (point) => {
      const s = state.current;
      // The rig's point lies on a plane facing the camera; cast from the eye through it onto the face itself.
      scratch.ray.origin.copy(camera.position);
      scratch.ray.direction.copy(point).sub(camera.position).normalize();
      const at = onFace(scratch.ray, scratch.b);
      if (!at || Math.hypot(at.x, at.y) < 0.6) return;
      const angle = angleOf(at);
      let delta = angle - s.lastAngle;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      s.lastAngle = angle;
      // Clockwise, as seen from the front, is warmer.
      turnTo(s.value - delta / STEP_ANGLE);
    },
    release: () => {
      state.current.dragging = false;
    },
    hover: (hovering) => {
      gl.domElement.style.cursor = hovering ? "grab" : "";
    }
  });

  // Scroll over the dial turns it a click at a time; scroll anywhere else zooms as usual.
  useEffect(() => {
    const dom = gl.domElement;
    const onWheel = (event: WheelEvent) => {
      if (event.target !== dom) return;
      const rect = dom.getBoundingClientRect();
      scratch.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      scratch.caster.setFromCamera(scratch.ndc, camera);
      const at = onFace(scratch.caster.ray, scratch.c);
      if (!at || Math.hypot(at.x, at.y) > RING.radius * 1.12) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const s = state.current;
      s.wheel += -event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      while (Math.abs(s.wheel) >= 50) {
        const step = Math.sign(s.wheel);
        s.wheel -= step * 50;
        turnTo(Math.round(s.value) + step);
      }
      wake();
      dismissPrompt();
    };
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  }, [gl, camera]);

  // Any sign of someone there (moving, pressing, scrolling, typing) puts off going AWAY.
  useEffect(() => {
    const events = ["pointermove", "pointerdown", "wheel", "keydown", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, wake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useMusic("/codevember/music/forest-serenity.mp3", 0.3);
  useEffect(() => sound.preload(CHATTER), []);
  // The cold: wind in the bare branches, dying away as it warms.
  const wind = useBed("wind", 0.14);

  // For testing in development: set the dial, put the eye somewhere, show normals as colour, count draws.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const normals = new THREE.MeshNormalNodeMaterial();
    Object.assign(globalThis, {
      __nest: { state: state.current, l, chicks, kit, lights, leaves, postBypass, thermostat, nest, setting, camera, scene, orbit: orbitControls, set: (t: number) => turnTo(t),
        // Draws and triangles over one whole frame, every pass included.
        draws: () =>
          new Promise((resolve) => {
            const info = (gl as unknown as { info: { autoReset: boolean; reset: () => void; render: { drawCalls: number; triangles: number } } }).info;
            info.autoReset = false;
            requestAnimationFrame(() => {
              info.reset();
              requestAnimationFrame(() => {
                resolve({ draws: info.render.drawCalls, triangles: info.render.triangles });
                info.autoReset = true;
              });
            });
          })
      },
      __view: (from: number[] | null, to?: number[]) => {
        if (!from || !to) {
          cameraTaken.current = false;
          return;
        }
        cameraTaken.current = true;
        camera.position.set(from[0], from[1], from[2]);
        orbitPoint.current?.set(to[0], to[1], to[2]);
        camera.lookAt(to[0], to[1], to[2]);
      },
      __normals: (on: boolean) => (scene.overrideMaterial = on ? normals : null)
    });
    return () => normals.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mood: Mood = useMemo(() => ({ cold: 1, happy: 0, hot: 0 }), []);

  useFrame((_, raw) => {
    const s = state.current;
    const dt = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1 / 20) : 0;
    s.time += dt;
    l.clock.value = s.time;

    // Left alone a while with the heat up, it goes AWAY: the word blinks up on the screen, then the dial turns itself
    // all the way down to save energy, smoothly, as a hand would turn it, clicking through its detents, the scene
    // cooling after it and the chicks glaring at it. Anything done on the page stops it where it is.
    if (!s.dragging) s.idle += dt;
    if (!s.gone && s.idle > AWAY.after && Math.round(s.value) > LOW + 2) {
      s.gone = true;
      s.goneFor = 0;
      s.from = s.value;
    }
    let turning = false;
    if (s.gone) {
      s.goneFor += dt;
      const t = (s.goneFor - AWAY.blink) / (1.5 + (s.from - LOW) * AWAY.perDegree);
      if (t > 0 && t < 1) {
        s.value = s.from + (LOW - s.from) * smooth(0, 1, t);
        turning = true;
      } else if (t >= 1) s.value = LOW;
    }
    s.away += ((s.gone && s.goneFor < AWAY.blink ? 1 : 0) - s.away) * (1 - Math.exp(-dt * 10));

    // The dial: between detents it is held by the spring catch, then jumps to the next with a click.
    if (!s.dragging && !turning) s.value += (Math.round(s.value) - s.value) * (1 - Math.exp(-dt * 14));
    const whole = Math.round(s.value);
    const f = s.value - whole;
    const caught = whole + Math.sign(f) * Math.pow(Math.abs(f) * 2, 3) * 0.5;
    if (whole !== s.clicked) {
      s.clicked = whole;
      detent((whole - LOW) / (HIGH - LOW), 0.45);
    }
    thermostat.ring.rotation.z = -(caught - LOW) * STEP_ANGLE;

    // The room follows the set temperature, quickly at first and then easing in.
    const gap = whole - s.room;
    s.room += Math.sign(gap) * Math.min(Math.abs(gap), Math.max(1.2, Math.abs(gap) * 1.1) * dt);
    const h = (s.room - LOW) / (HIGH - LOW);
    l.heat.value = h;

    // The screen.
    const status = s.away > 0.5 ? 0 : whole - s.room > 0.6 ? 1 : s.room - whole > 0.6 ? 2 : whole >= COMFY[0] && whole <= COMFY[1] ? 3 : 0;
    const tu = thermostat.u;
    tu.set.value = whole;
    tu.room.value = s.room;
    tu.status.value = status;
    tu.away.value = s.away;
    // The word blinks in bold a few times, then gives way to the number as the dial turns down.
    tu.awayInk.value = s.away * (Math.floor(s.goneFor / 0.27) % 2 === 1 ? 0.1 : 1);
    tu.accent.value.copy(status === 1 ? ACCENT.heating : status === 2 ? ACCENT.cooling : ACCENT.eco);
    // Its glow on the nest: orange while heating, a cool white otherwise.
    const glowTarget = status === 1 ? GLOW.heating : status === 2 ? GLOW.cooling : GLOW.idle;
    l.glow.value.lerp(glowTarget, 1 - Math.exp(-dt * 4));
    lights.glow.color.copy(l.glow.value);
    lights.glow.intensity = 140;

    // The weather follows the room: snow and frost melting off as it warms (and settling again, more slowly, as it
    // cools), the wood wet while the melt runs, the snowfall thinning.
    // Each settles all the way: once within a hair of where it is going it is there, so nothing lingers at a trace.
    const ease = (from: number, to: number, up: number, down: number) => {
      const next = from + (to - from) * (1 - Math.exp(-dt / (to > from ? up : down)));
      return Math.abs(next - to) < 0.004 ? to : next;
    };
    s.snow = ease(s.snow, 1 - smooth(0.22, 0.5, h), 7, 2.2 / (1 + h * 2));
    s.frost = ease(s.frost, 1 - smooth(0.12, 0.42, h), 5, 1.6);
    s.wet = ease(s.wet, smooth(0.22, 0.34, h) * (1 - smooth(0.44, 0.6, h)), 1.2, 3);
    s.fall = ease(s.fall, (1 - smooth(0.18, 0.5, h)) * (snowfall.current === false ? 0 : 1), 2, 1.5);
    l.snow.value = s.snow;
    l.frost.value = s.frost;
    l.wet.value = s.wet;
    u.fall.value = s.fall;
    u.breath.value = 1 - smooth(0.2, 0.45, h);
    wind.current?.level(0.04 + 0.16 * (1 - smooth(0.2, 0.6, h)), 0.4);

    // The light: cold blue dusk to golden.
    along(KEY, h, l.sun.value);
    along(SKY, h, l.sky.value);
    along(GROUND, h, l.ground.value);
    let e = EXPOSURE[0][1];
    for (let i = 1; i < EXPOSURE.length; i++) if (h > EXPOSURE[i - 1][0]) e = THREE.MathUtils.lerp(EXPOSURE[i - 1][1], EXPOSURE[i][1], smooth(EXPOSURE[i - 1][0], EXPOSURE[i][0], h));
    gl.toneMappingExposure = e;
    // The screen keeps its own brightness whatever the exposure.
    tu.bright.value = 1 / e;
    lights.key.color.copy(l.sun.value);
    const glow = smooth(0.35, 0.8, h);
    l.back.value.copy(MOON).lerp(LOW_SUN, glow);
    airTint.value.copy(MIST.cold).lerp(MIST.warm, glow);
    lights.fill.color.copy(l.sky.value);
    lights.fill.groundColor.copy(l.ground.value);

    // The chicks.
    mood.cold = 1 - smooth(0.18, 0.5, h);
    mood.happy = smooth(0.45, 0.58, h) * (1 - smooth(0.78, 0.86, h));
    mood.hot = smooth(0.84, 0.93, h);
    // Chattering with the cold: one clip after another while frozen, thinning out as they warm, gone once they are.
    s.nextChatter -= dt;
    if (s.nextChatter <= 0 && mood.cold > 0.3) {
      sound.sample(CHATTER, 0.15 + mood.cold * 0.45);
      s.nextChatter = 2.7 + (1 - mood.cold) * 5 + Math.random() * 1.5;
    }
    kit.fluff.value = THREE.MathUtils.lerp(1.02, 1.16, mood.cold) * THREE.MathUtils.lerp(1, 0.9, mood.hot);
    let peeps = 0;
    for (let k = 0; k < chicks.length; k++) {
      const chick = chicks[k];
      const [x, z] = SPOTS[k];
      const spread = THREE.MathUtils.lerp(1, HUDDLE, mood.cold);
      chick.group.position.set(x * spread, floor, z * spread);
      chick.step(dt, mood, s.gone && s.goneFor > AWAY.blink ? chick.group.worldToLocal(scratch.b.copy(l.glowAt.value)) : null);
      chick.sync();
      if (chick.peeps && peeps < 2) {
        peeps++;
        chick.group.getWorldPosition(scratch.a).project(camera);
        if (chick.chirp >= 0) {
          chirp(chick.chirp, chick.pitch, scratch.a.x * 0.8, 0.55 + Math.max(mood.happy, mood.hot) * 0.45);
          // The others may answer, a moment later.
          for (const other of chicks) if (other !== chick && !other.doze && Math.random() < 0.45) other.answer(0.12 + Math.random() * 0.4);
        } else peep(chick.pitch, scratch.a.x * 0.8, 0.35);
      }
      // Breath, out of the beak and up into the cold air.
      if (chick.breathed && u.breath.value > 0.02) {
        const i = breath.next;
        breath.next = (breath.next + 1) % PUFFS;
        chick.top.getWorldPosition(breath.from[i]);
        chick.head.getWorldDirection(breath.vel[i]);
        breath.vel[i].multiplyScalar(1.6).add(scratch.a.set(0, 0.9, 0));
        breath.from[i].addScaledVector(breath.vel[i], 0.25);
        breath.age[i] = 0;
      }
    }
    // The puffs' buffer goes up only while one is in the air.
    let live = false;
    for (let i = 0; i < PUFFS; i++) {
      if (breath.age[i] >= 1 && puffs.getW(i) === 0) continue;
      live = true;
      breath.age[i] = Math.min(1, breath.age[i] + dt / 1.8);
      const t = breath.age[i] * 1.8;
      const p = scratch.a.copy(breath.from[i]).addScaledVector(breath.vel[i], t * (1 - t * 0.2));
      puffs.setXYZW(i, p.x, p.y, p.z, breath.age[i] >= 1 ? 0 : breath.age[i]);
    }
    if (live) puffs.needsUpdate = true;
    leaves.update(dt, h);
    // Panting, and drips plinking below while the melt runs.
    if (mood.hot > 0.4 && s.time > s.nextPant) {
      s.nextPant = s.time + 0.22 + Math.random() * 0.25;
      pant(Math.random() * 0.6 - 0.3);
    }
    if (s.wet > 0.15 && s.time > s.nextPlink) {
      s.nextPlink = s.time + (0.25 + Math.random() * 0.9) / s.wet;
      plink(Math.random() * 1.4 - 0.7);
    }

    // The moments: just right, then too hot.
    if (!s.earned && status === 3 && Math.abs(whole - s.room) < 1) {
      s.earned = true;
      followPrompt.earn("warm");
      shareResult.set("I turned up the heat for three frozen chicks in Nest. Just right.");
    }
    if (!s.cooked && mood.hot > 0.5) {
      s.cooked = true;
      shareResult.set(`I cranked a bird's nest to ${HIGH}°. The chicks put on sunglasses.`);
    }

    // Focus between the nest and the dial.
    const focus = camera.position.distanceTo(scratch.a.set(8, 0, 0));
    focusDistance.value += (focus - focusDistance.value) * (1 - Math.exp(-dt * 4));
    focusBlur.value = 2.6;
  });

  useEffect(
    () => () => {
      focusBlur.value = 1;
      gl.toneMappingExposure = 1;
      airTint.value.copy(AIR_TINT);
      airAmount.value = 1;
    },
    [gl]
  );

  return (
    <>
      <StudioEnvironment
        ambient="#0a0c14"
        intensity={0.35}
        boxes={[
          { position: [-6, 3, 4], scale: [3, 2, 3], color: "#9ab0ff", intensity: 1.2 },
          { position: [5, 2, -6], scale: [4, 1.5, 1], color: "#ffb070", intensity: 1.2 },
          { position: [0, 8, 0], scale: [10, 0.5, 10], color: "#3a4060", intensity: 0.8 }
        ]}
      />
      <primitive object={lights.key} />
      <primitive object={lights.key.target} />
      <primitive object={lights.fill} />
      <primitive object={lights.glow} />
      <primitive object={setting.group} />
      <primitive object={nest.group} />
      {chicks.map((chick, k) => (
        <primitive key={k} object={chick.group} />
      ))}
      {kit.meshes.map((mesh, k) => (
        <primitive key={`m${k}`} object={mesh} />
      ))}
      <primitive object={thermostat.group} />
      <primitive object={leaves.mesh} />
      <Air l={l} count={FLAKES[startTier]} motes={MOTES[startTier]} fall={u.fall} puffs={puffs} breath={u.breath} cup={nest.shape.inner} />
    </>
  );
}

// On a phone the prompt would sit over the thermostat, in the middle of the screen: up at the top instead, clear of it.
// The Controls panel starts closed here, clear of the thermostat: the HUD opens it on wide screens as it mounts, so
// close it once, the first time it shows open.
function Overlay() {
  useEffect(() => {
    let frame = 0;
    const until = performance.now() + 2000;
    const close = () => {
      const head = document.querySelector<HTMLElement>(".cv-panel-head[aria-expanded='true']");
      if (head) head.click();
      else if (performance.now() < until) frame = requestAnimationFrame(close);
    };
    frame = requestAnimationFrame(close);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <style>{`@media (max-width: 720px), (max-height: 520px) and (pointer: coarse) { .cv-prompt.cv-prompt-high { place-content: start center; padding: calc(max(16px, env(safe-area-inset-top)) + 64px) 20px 0; } .cv-prompt.cv-prompt-high p { font-size: 34px; } }`}</style>;
}

const day: DayDefinition = {
  camera: {
    position: [START.x, START.y, START.z],
    target: [TARGET.x, TARGET.y, TARGET.z],
    fov: FOV,
    // On a phone held upright: further back and wider, so the nest and the thermostat both fit across it.
    phone: { position: [7, 19.8, 53.1], target: [7, 2.5, 0], fov: 62 },
    // Round to either side of the nest and well over the top; the engine's give stretches these, so they stay under 85.
    limits: { turn: { left: 80, right: 80, up: 38, down: 14 }, move: { left: 14, right: 14, down: 2, up: 2, nearer: 22, further: 14 } }
  },
  look: { background: "#000000", exposure: 1, bloom: 0.3, bloomThreshold: 0.85, gi: 0, ao: 0, vignette: 0.5, grain: 0.03, haze: 0 },
  // A little air in depth (its colour follows the dial), starting just short of the nest so the subject stays clear.
  passes: { haze: false, bounce: false, overlay: true, occlusion: false, depthOfField: { range: 14, air: 0.5, airRate: 0.006, airBehindFocus: 6 } },
  settings: {
    snowfall: { type: "toggle", label: "Snowfall", value: true }
  },
  prompt: { title: "Turn the dial", detail: "Warm the nest", high: true },
  hint: "Turn the dial to warm the nest: drag round the ring, or scroll over it. Drag anywhere else to look around.",
  notes: "A cold nest on a snowy branch at dusk, and a smart thermostat screwed to the tree. Turn it up and watch the snow melt and the chicks thaw out.",
  Overlay,
  Scene
};

export default day;
