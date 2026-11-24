"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { positionWorld, uniform } from "three/tsl";
import { cameraTaken } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { dismissPrompt } from "../../shared/engine/prompt";
import { scenePhase } from "../../shared/engine/quality";
import { loadRetried, suspendRetried } from "../../shared/engine/retry";
import { useSettingAction, useSettingRef } from "../../shared/engine/settings";
import { useBed, useEvery } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Air } from "./air";
import { Bird } from "./bird";
import { Chick, chickKit } from "./chick";
import { featherAtlas } from "./feather";
import { lighting, sunLight, type Lighting } from "./light";
import { buildNest, type Scans } from "./nest";
import { CARD, createPhoto, PICTURE } from "./photo";
import { buildSetting } from "./setting";
import { coo, dive as diveSound, drop as dropSound, flap, peep, song } from "./sound";
import { WORLDS, type World } from "./worlds";

// Nests all the way down. A nest on a branch, three chicks peeping; Mum flies in with an instant photo in her beak
// instead of a worm and drops it in. It develops: a nest with chicks. The camera dives into the picture and the picture
// becomes the next nest, alive, and Mum comes in with another photo. The picture is a live render of the next world
// from exactly where the camera will be once it gets there, so the hand-over has no cut: as the camera nears the
// picture it fills the screen, the paper's look falls away, and at the moment it covers the view the next world takes
// the screen from the same point. Then the camera is back at the start, one world further down.

// Where the eye starts in every world (the picture in each photo is taken from here), and how far on it settles once
// the dive has carried it in.
const START = new THREE.Vector3(-2.5, 15.5, 31);
const TARGET = new THREE.Vector3(0.5, 0.5, 0);
const FOV = 34;
const SETTLE = 0.84;
// The picture's render is this much wider than the view, so the card's white edge has left the screen before the
// hand-over, never during it.
const MARGIN = 1.3;
// Seconds, at speed 1.
const WAIT = 3.2;
const ARRIVE = 3.4;
const PERCH = 1.1;
const FALL = 0.55;
const DEVELOP = 6.5;
const DIVE = 4.6;
const LEAVE = 2.4;

type Level = {
  def: World;
  index: number;
  layer: number;
  l: Lighting;
  group: THREE.Group;
  chicks: Chick[];
  mum: Bird;
  // Where the photo comes to rest in this nest, and where Mum perches.
  rest: { position: THREE.Vector3; quaternion: THREE.Quaternion };
  perch: { position: THREE.Vector3; yaw: number };
  approach: THREE.CatmullRomCurve3;
  exit: THREE.CatmullRomCurve3;
  disposables: { dispose(): void }[];
};

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// One world, built whole: its setting, nest, chicks, Mum and lights, all on its own layer.
function buildLevel(def: World, index: number, scans: Scans, atlas: THREE.Texture): Level {
  const layer = index + 1;
  const l = lighting(def);
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const setting = buildSetting(def, l, scans);
  group.add(setting.group);
  disposables.push(...setting.geometries, ...setting.materials, ...setting.textures);
  const nest = buildNest(def, l, scans, 101 + index * 17);
  group.add(nest.group);
  disposables.push(...nest.geometries, ...nest.materials);

  // The chicks, crowded into the front of the cup; the photo will lean against the back rim behind them.
  const kit = chickKit(def.chick, l, 300 + index);
  disposables.push(...kit.geometries, ...kit.materials);
  const floor = -nest.shape.innerDepth * 0.55;
  const spots: [number, number, number][] =
    def.chicks === 2
      ? [
          [-1.9, 0.6, 0.25],
          [1.9, 0.9, -0.2]
        ]
      : [
          [-2.4, -0.1, 0.35],
          [2.3, -0.3, -0.3],
          [0.1, 2.2, 0.05]
        ];
  const chicks = spots.map(([x, z, yaw], k) => {
    const chick = new Chick(kit, 700 + index * 10 + k, k === 1 && def.key !== "city");
    chick.group.position.set(x, floor, z);
    // Facing out toward the front of the nest, each a little its own way.
    chick.group.rotation.y = yaw;
    const scale = 0.84 + ((k * 37) % 10) * 0.015;
    chick.group.scale.setScalar(scale);
    group.add(chick.group);
    return chick;
  });

  // Mum.
  const mum = new Bird(def.mum, atlas, 900 + index);
  disposables.push(...mum.geometries, ...mum.materials);
  mum.group.visible = false;
  group.add(mum.group);
  const R = def.nest.radius;
  // On the back right of the rim, facing in across the nest toward the front left.
  const perchAngle = -0.85;
  const perch = { position: v(Math.cos(perchAngle) * R * 0.9, 0.45, Math.sin(perchAngle) * R * 0.9), yaw: 0 };
  perch.yaw = Math.atan2(-perch.position.x - 0.5, -perch.position.z + 2);
  const approach = new THREE.CatmullRomCurve3([v(70, 42, -40), v(45, 30, -26), v(22, 15, -16), perch.position.clone().add(v(5, 5, -4)), perch.position.clone()], false, "centripetal");
  const exit = new THREE.CatmullRomCurve3([perch.position.clone(), perch.position.clone().add(v(-3, 6, -6)), v(-14, 22, -30), v(-50, 45, -70)], false, "centripetal");

  // The photo stands in the back of the cup behind the chicks, its foot on the lining, leaning back on the far rim.
  const tilt = 0.55;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-tilt, -0.07, 0.05, "YXZ"));
  const foot = v(0.6, floor + 0.6, -4.1);
  const centre = foot.clone().sub(v(0, CARD.bottom, 0).applyQuaternion(q));
  const rest = { position: centre, quaternion: q };

  // Light: the sun through the canopy, and the sky and ground.
  const sun = sunLight(l, positionWorld, 34);
  group.add(sun, sun.target);
  const sky = new THREE.HemisphereLight(def.sky, def.ground, 1);
  // The hemisphere's colours follow the world's fill.
  sky.color.copy(l.sky.value);
  sky.groundColor.copy(l.ground.value);
  sky.intensity = 1.1;
  group.add(sky);

  group.traverse((o) => o.layers.set(layer));
  return { def, index, layer, l, group, chicks, mum, rest, perch, approach, exit, disposables };
}

const scratch = {
  a: new THREE.Vector3(),
  b: new THREE.Vector3(),
  c: new THREE.Vector3(),
  d: new THREE.Vector3(),
  q: new THREE.Quaternion(),
  q2: new THREE.Quaternion(),
  m: new THREE.Matrix4(),
  ray: new THREE.Raycaster(),
  ndc: new THREE.Vector2(),
  plane: new THREE.Plane(),
  size: new THREE.Vector2(),
  e: new THREE.Euler()
};

function useScans(): Scans {
  const urls = ["bark_brown_02_diff_2k.jpg", "bark_brown_02_nor_gl_1k.jpg", "bark_brown_02_rough_1k.jpg", "moss_diff_1k.jpg"].map((f) => `/assets/24-nest/${f}`);
  const [bark, barkNormal, barkRough, moss] = suspendRetried(() => Promise.all(urls.map((url) => loadRetried(new THREE.TextureLoader(), url))), ["nest-polaroid", ...urls]);
  for (const [t, colour] of [
    [bark, true],
    [barkNormal, false],
    [barkRough, false],
    [moss, true]
  ] as [THREE.Texture, boolean][]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    t.needsUpdate = true;
  }
  return { bark, barkNormal, barkRough, moss };
}

// From the beak's frame to the card's: its top edge forward, the picture facing up.
const HELD = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, Math.PI, 0, "XYZ"));

const PAIRS = [
  [0, 1],
  [1, 2],
  [2, 0],
  [0, 2],
  [1, 0],
  [2, 1]
];

const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function Scene() {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const speed = useSettingRef<number>("speed");
  const auto = useSettingRef<boolean>("auto");
  const scans = useScans();
  const atlas = useMemo(() => featherAtlas(), []);
  const levels = useMemo(() => WORLDS.map((w, i) => buildLevel(w, i, scans, atlas)), [scans, atlas]);
  useDispose(atlas, ...levels.flatMap((l) => l.disposables));
  const photo = useMemo(() => createPhoto(), []);
  useDispose(...photo.geometries, ...photo.materials);
  // The air's light follows whichever world is on screen.
  const airLight = useMemo(() => lighting(WORLDS[0]), []);
  const air = useMemo(() => ({ fade: uniform(0), amount: uniform(1) }), []);
  // The picture's render: one target the size of the screen, drawn into only as much of it as the picture needs.
  const target = useMemo(() => new THREE.RenderTarget(16, 16, { type: THREE.HalfFloatType, samples: 0, depthBuffer: true }), []);
  useDispose(target);
  const lens = useMemo(() => new THREE.PerspectiveCamera(FOV, 1, 0.05, 400), []);
  useEffect(() => photo.setTexture(target.texture), [photo, target]);

  const state = useRef({
    current: 0,
    next: 1,
    phase: "wait" as "wait" | "arrive" | "perch" | "drop" | "develop" | "dive",
    phaseTime: 0,
    mum: "away" as "away" | "in" | "perched" | "out",
    mumTime: 0,
    flapPhase: 0,
    photo: "hidden" as "hidden" | "held" | "falling" | "resting",
    fallTime: 0,
    fallFrom: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
    develop: 0,
    s: 0,
    rate: 0,
    dived: 0,
    // The relative speed of the dive at the hand-over, carried on into the new world and let die away.
    carry: 0,
    decay: 1,
    pushed: SETTLE,
    summon: false,
    hurry: false,
    snapshot: false,
    // Since the hand-over: the lens refocusing, the air coming back.
    since: 10,
    look: new THREE.Vector2(),
    lookVel: new THREE.Vector2(),
    dragging: false,
    time: 0,
    clocks: [0, 0, 0],
    warm: 0,
    started: false,
    from: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
    r0: 1,
    lastFlap: 0
  });

  // For testing in development: hold the eye somewhere, looking at a point (null lets go); show normals as colour.
  const debug = useRef<{ view: null | { from: THREE.Vector3; to: THREE.Vector3 } }>({ view: null });
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const normals = new THREE.MeshNormalNodeMaterial();
    Object.assign(globalThis, {
      __nest: { levels, photo, state: state.current, camera, target, lens },
      __view: (from: number[] | null, to?: number[]) => (debug.current.view = from && to ? { from: new THREE.Vector3(...from), to: new THREE.Vector3(...to) } : null),
      __normals: (on: boolean) => (scene.overrideMaterial = on ? normals : null)
    });
    return () => normals.dispose();
  }, [levels, photo, camera, target, lens, scene]);

  // Which world each camera sees: the view the one on screen, the picture's lens the next.
  const show = (current: number, next: number) => {
    camera.layers.mask = 1 | (1 << levels[current].layer);
    lens.layers.mask = 1 << levels[next].layer;
    photo.group.traverse((o) => o.layers.set(levels[current].layer));
    const l = levels[current].l;
    photo.u.toSun.value.copy(l.toSun.value);
    photo.u.sun.value.copy(l.sun.value);
    photo.u.sky.value.copy(l.sky.value);
    photo.u.ground.value.copy(l.ground.value);
    airLight.toSun.value.copy(l.toSun.value);
    airLight.sun.value.copy(l.sun.value);
    airLight.dapple.value = l.dapple.value;
    airLight.size.value = l.size.value;
    air.amount.value = levels[current].def.shafts;
  };

  useEffect(() => {
    const kept = camera.layers.mask;
    cameraTaken.current = true;
    return () => {
      camera.layers.mask = kept;
      cameraTaken.current = false;
      focusBlur.value = 1;
    };
  }, [camera]);

  // The ambience: a breeze always, crickets at dusk; birds calling round about.
  const breeze = useBed("breeze", 0.22);
  const crickets = useBed("crickets", 0);
  useEvery(2.5, 7, () => {
    const kind = levels[state.current.current].def.ambience;
    if (kind === "song") song(Math.random() * 1.6 - 0.8);
    else if (kind === "city") coo(Math.random() < 0.5 ? -0.7 : 0.7);
    else if (Math.random() < 0.3) song(Math.random() * 1.6 - 0.8);
  });

  // The pointer: drag to look about a little; tap a chick to set it peeping, Mum or the sky to have her come now, the
  // developed photo to dive in.
  useEffect(() => {
    const dom = gl.domElement;
    const press = { x: 0, y: 0, at: 0, id: -1, lastX: 0, lastY: 0 };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      press.x = press.lastX = e.clientX;
      press.y = press.lastY = e.clientY;
      press.at = performance.now();
      press.id = e.pointerId;
      state.current.dragging = true;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== press.id || !state.current.dragging) return;
      const s = state.current;
      const k = 1.6 / dom.clientHeight;
      s.look.x += (e.clientX - press.lastX) * k;
      s.look.y += (e.clientY - press.lastY) * k;
      s.look.x = THREE.MathUtils.clamp(s.look.x, -0.32, 0.32);
      s.look.y = THREE.MathUtils.clamp(s.look.y, -0.2, 0.2);
      press.lastX = e.clientX;
      press.lastY = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== press.id) return;
      press.id = -1;
      state.current.dragging = false;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6 || performance.now() - press.at > 600) return;
      const rect = dom.getBoundingClientRect();
      scratch.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      tap(scratch.ndc);
    };
    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerup", up);
    dom.addEventListener("pointercancel", up);
    return () => {
      dom.removeEventListener("pointerdown", down);
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerup", up);
      dom.removeEventListener("pointercancel", up);
    };
    // tap reads the latest state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl]);

  const tap = (ndc: THREE.Vector2) => {
    const s = state.current;
    const level = levels[s.current];
    scratch.ray.setFromCamera(ndc, camera);
    const ray = scratch.ray.ray;
    dismissPrompt();
    // A chick: its head or body.
    let best = Infinity;
    let hit: Chick | null = null;
    for (const chick of level.chicks) {
      for (const part of [chick.head, chick.body]) {
        part.getWorldPosition(scratch.a);
        const r = (part === chick.head ? 2.2 : 3) * chick.group.scale.x;
        if (ray.distanceSqToPoint(scratch.a) < r * r) {
          const d = ray.origin.distanceTo(scratch.a);
          if (d < best) {
            best = d;
            hit = chick;
          }
        }
      }
    }
    if (hit) {
      hit.tapped = 1.4 + Math.random() * 0.8;
      return;
    }
    // The photo, once it has come up enough to see: in we go.
    if (s.photo === "resting" && s.develop > 0.45 && s.phase === "develop") {
      photo.group.updateWorldMatrix(true, false);
      scratch.m.copy(photo.group.matrixWorld).invert();
      const local = ray.clone().applyMatrix4(scratch.m);
      const at = local.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), scratch.b);
      if (at && Math.abs(at.x) < CARD.w / 2 && at.y > CARD.bottom && at.y < CARD.top) {
        startDive();
        return;
      }
    }
    // Mum or the sky: she comes now.
    if (s.phase === "wait") s.summon = true;
  };

  const startDive = () => {
    const s = state.current;
    if (s.phase === "dive") return;
    s.phase = "dive";
    s.phaseTime = 0;
    s.s = 0;
    s.rate = 0;
    s.from.position.copy(camera.position);
    s.from.quaternion.copy(camera.quaternion);
    photo.group.updateWorldMatrix(true, false);
    s.r0 = camera.position.distanceTo(photo.group.getWorldPosition(scratch.a));
    diveSound(DIVE / Math.max(0.3, (speed.current ?? 1) * (s.hurry ? 3 : 1)));
  };

  useSettingAction("next", () => {
    const s = state.current;
    s.hurry = true;
    if (s.phase === "wait") s.summon = true;
    if (s.phase === "develop" && s.photo === "resting") startDive();
  });

  // The camera's horizontal field of view, from its vertical one and the screen's shape.
  const across = () => 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV) / 2) * camera.aspect);

  // Draw the next world into the picture: only the part of the picture on screen, at about the size it is shown.
  const renderPicture = (whole: boolean) => {
    gl.getDrawingBufferSize(scratch.size);
    const W = Math.max(16, Math.floor(scratch.size.x));
    const H = Math.max(16, Math.floor(scratch.size.y));
    if (target.width !== W || target.height !== H) target.setSize(W, H);
    let u0 = 0;
    let v0 = 0;
    let u1 = 1;
    let v1 = 1;
    let w = Math.min(W, 1024);
    let h = Math.min(H, 1024);
    photo.group.updateWorldMatrix(true, true);
    if (!whole) {
      // Where the screen's corners fall on the picture.
      scratch.m.copy(photo.group.matrixWorld).invert();
      const plane = scratch.plane.set(new THREE.Vector3(0, 0, 1), -0.004);
      let lo = new THREE.Vector2(Infinity, Infinity);
      let hi = new THREE.Vector2(-Infinity, -Infinity);
      let ok = true;
      for (const [x, y] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1]
      ]) {
        scratch.ray.setFromCamera(scratch.ndc.set(x, y), camera);
        const local = scratch.ray.ray.clone().applyMatrix4(scratch.m);
        const at = local.intersectPlane(plane, scratch.b);
        if (!at) {
          ok = false;
          break;
        }
        lo.min(new THREE.Vector2(at.x / PICTURE + 0.5, at.y / PICTURE + 0.5));
        hi.max(new THREE.Vector2(at.x / PICTURE + 0.5, at.y / PICTURE + 0.5));
      }
      if (!ok) {
        lo = new THREE.Vector2(0, 0);
        hi = new THREE.Vector2(1, 1);
      }
      u0 = clamp01(lo.x - 0.01);
      v0 = clamp01(lo.y - 0.01);
      u1 = clamp01(hi.x + 0.01);
      v1 = clamp01(hi.y + 0.01);
      if (u1 - u0 < 0.02 || v1 - v0 < 0.02) {
        u0 = v0 = 0;
        u1 = v1 = 1;
      }
      // How big that part is on screen, in pixels.
      let sx0 = Infinity;
      let sy0 = Infinity;
      let sx1 = -Infinity;
      let sy1 = -Infinity;
      for (const [a, b] of [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1]
      ]) {
        const p = scratch.c.set((a - 0.5) * PICTURE, (b - 0.5) * PICTURE, 0).applyMatrix4(photo.group.matrixWorld).project(camera);
        sx0 = Math.min(sx0, p.x);
        sx1 = Math.max(sx1, p.x);
        sy0 = Math.min(sy0, p.y);
        sy1 = Math.max(sy1, p.y);
      }
      w = Math.ceil(THREE.MathUtils.clamp(((Math.min(1, sx1) - Math.max(-1, sx0)) / 2) * W * 1.05, 64, W));
      h = Math.ceil(THREE.MathUtils.clamp(((Math.min(1, sy1) - Math.max(-1, sy0)) / 2) * H * 1.05, 64, H));
    }
    // The picture's lens: where the view will be, a little wider, and square.
    lens.position.copy(START);
    lens.lookAt(TARGET);
    lens.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(across() / 2) * MARGIN));
    lens.aspect = 1;
    const S = 4096;
    lens.setViewOffset(S, S, u0 * S, (1 - v1) * S, (u1 - u0) * S, (v1 - v0) * S);
    lens.updateProjectionMatrix();
    lens.updateMatrixWorld();
    target.viewport.set(0, 0, w, h);
    target.scissor.set(0, 0, w, h);
    photo.u.rect.value.set(u0, v0, u1, v1);
    photo.u.fill.value.set(w / W, h / H);
    const before = gl.getRenderTarget();
    const t0 = performance.now();
    gl.setRenderTarget(target);
    gl.render(scene, lens);
    gl.setRenderTarget(before);
    if (process.env.NODE_ENV !== "production" && performance.now() - t0 > 12) console.warn("nest: picture took", (performance.now() - t0).toFixed(1), "ms", whole, w, h);
  };

  // Hand over to the next world: it becomes the view, and a new next is chosen.
  const handOver = () => {
    const s = state.current;
    const old = levels[s.current];
    old.mum.group.visible = false;
    s.current = s.next;
    s.next = (s.current + 1) % levels.length;
    show(s.current, s.next);
    s.phase = "wait";
    s.phaseTime = 0;
    s.mum = "away";
    s.photo = "hidden";
    photo.group.visible = false;
    photo.u.alive.value = 0;
    photo.u.develop.value = 0;
    s.develop = 0;
    s.hurry = false;
    s.summon = false;
    s.snapshot = false;
    s.since = 0;
    s.dived += 1;
    s.look.set(0, 0);
    s.lookVel.set(0, 0);
    // The beds follow the world.
    const kind = levels[s.current].def.ambience;
    breeze.current?.level(kind === "dusk" ? 0.12 : 0.22, 1.5);
    crickets.current?.level(kind === "dusk" ? 0.18 : 0, 1.5);
    if (s.dived === 1) followPrompt.earn("dive");
    shareResult.set(s.dived === 1 ? "I fell into a photo of a nest in Nestception. It's nests all the way down" : `I fell ${s.dived} nests deep in Nestception. It's nests all the way down`);
  };

  useEffect(() => {
    show(0, 1);
    photo.group.visible = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame((_, raw) => {
    const s = state.current;
    const dt = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1 / 20) : 0;

    // Behind the loader, every world is shown both ways (as the view and in the picture) with Mum and the photo out, so
    // every shader is built before anything is seen.
    if (scenePhase.current !== "live") {
      const k = s.warm++;
      const [current, next] = PAIRS[k % PAIRS.length];
      show(current, next);
      for (const level of levels) {
        level.mum.group.visible = level.index === current;
        level.mum.group.position.copy(level.perch.position);
        level.mum.update();
      }
      photo.group.visible = true;
      photo.group.position.copy(levels[current].rest.position);
      photo.group.quaternion.copy(levels[current].rest.quaternion);
      photo.u.alive.value = 0.5;
      camera.position.copy(START);
      camera.lookAt(TARGET);
      renderPicture(k % 2 === 0);
      return;
    }
    if (!s.started) {
      s.started = true;
      show(s.current, s.next);
      for (const level of levels) level.mum.group.visible = false;
      photo.group.visible = false;
      photo.u.alive.value = 0;
      s.since = 10;
    }

    const pace = (speed.current ?? 1) * (s.hurry ? 3 : 1);
    const step = dt * pace;
    s.time += dt;
    s.phaseTime += step;
    s.since += dt;
    const level = levels[s.current];
    const nextLevel = levels[s.next];
    const mum = level.mum;

    // The story.
    if (s.phase === "wait") {
      if (s.summon || (auto.current !== false && s.phaseTime > WAIT) || s.hurry) {
        s.phase = "arrive";
        s.phaseTime = 0;
        s.mum = "in";
        s.mumTime = 0;
        s.photo = "held";
        s.summon = false;
        photo.group.visible = true;
        photo.u.develop.value = 0;
        photo.u.alive.value = 0;
        s.snapshot = false;
      }
    } else if (s.phase === "arrive" && s.mum === "perched" && s.mumTime > PERCH) {
      s.phase = "drop";
      s.phaseTime = 0;
      s.photo = "falling";
      s.fallTime = 0;
      photo.group.updateWorldMatrix(true, false);
      photo.group.matrixWorld.decompose(s.fallFrom.position, s.fallFrom.quaternion, scratch.a);
    } else if (s.phase === "drop" && s.photo === "resting") {
      s.phase = "develop";
      s.phaseTime = 0;
    } else if (s.phase === "develop") {
      s.develop = Math.min(1, s.develop + step / DEVELOP);
      if (s.develop >= 1 && (auto.current !== false || s.hurry) && s.phaseTime > DEVELOP + 0.8) startDive();
    }
    if (s.phase === "develop" || s.phase === "dive") photo.u.develop.value = smooth(s.develop);

    // Mum.
    s.mumTime += step;
    if (s.mum === "in") {
      const t = clamp01(s.mumTime / ARRIVE);
      // Fast and level at first, braking hard into the landing.
      const along = 1 - Math.pow(1 - t, 2.2);
      level.approach.getPointAt(along, mum.group.position);
      level.approach.getTangentAt(Math.min(0.999, along), scratch.a);
      mum.group.visible = true;
      const flare = smooth(clamp01((t - 0.72) / 0.28));
      const yaw = Math.atan2(scratch.a.x, scratch.a.z);
      const pitch = -Math.asin(THREE.MathUtils.clamp(scratch.a.y, -1, 1)) * 0.6;
      mum.group.rotation.set(THREE.MathUtils.lerp(pitch, -0.65, flare), THREE.MathUtils.lerp(yaw, level.perch.yaw, smooth(clamp01((t - 0.6) / 0.4))), 0, "YXZ");
      mum.spread = 1 - smooth(clamp01((t - 0.93) / 0.07)) * 0.2;
      mum.fan = 0.3 + flare * 0.7;
      mum.tailLift = flare * 0.5;
      mum.legsDown = flare;
      s.flapPhase += step * (11 - flare * 3);
      mum.beat = Math.sin(s.flapPhase) * (0.9 - flare * 0.25) + 0.1;
      if (t >= 1) {
        s.mum = "perched";
        s.mumTime = 0;
      }
    } else if (s.mum === "perched") {
      const t = s.mumTime;
      mum.group.position.copy(level.perch.position);
      // Settling: wings closing, a bob on landing, the tail flicking.
      const settle = smooth(clamp01(t / 0.6));
      mum.spread = 0.8 * (1 - settle);
      s.flapPhase += step * 9 * (1 - settle);
      mum.beat = Math.sin(s.flapPhase) * 0.6 * (1 - settle);
      mum.fan = 1 - settle * 0.85;
      mum.tailLift = (1 - settle) * 0.5 + Math.max(0, Math.sin(t * 7)) * 0.08 * Math.exp(-t);
      mum.legsDown = 1;
      const bob = Math.exp(-t * 5) * Math.sin(t * 18) * 0.5;
      mum.group.position.y += bob;
      mum.group.rotation.set(-0.08 * (1 - settle) + 0.02, level.perch.yaw, 0, "YXZ");
      if (s.phase === "develop" && s.phaseTime > 1.0) {
        s.mum = "out";
        s.mumTime = 0;
      }
    } else if (s.mum === "out") {
      const t = clamp01(s.mumTime / LEAVE);
      const along = Math.pow(t, 1.6);
      level.exit.getPointAt(along, mum.group.position);
      level.exit.getTangentAt(Math.max(0.001, along), scratch.a);
      const yaw = Math.atan2(scratch.a.x, scratch.a.z);
      mum.group.rotation.set(-Math.asin(THREE.MathUtils.clamp(scratch.a.y, -1, 1)) * 0.6, THREE.MathUtils.lerp(level.perch.yaw, yaw, smooth(clamp01(t * 4))), 0, "YXZ");
      mum.spread = smooth(clamp01(t * 6));
      s.flapPhase += step * 12;
      mum.beat = Math.sin(s.flapPhase) * 0.95 + 0.15;
      mum.fan = 0.4;
      mum.tailLift = 0.1;
      mum.legsDown = 1 - smooth(clamp01(t * 3));
      if (t >= 1) {
        s.mum = "away";
        mum.group.visible = false;
      }
    }
    // A wingbeat heard on each downstroke.
    if ((s.mum === "in" || s.mum === "out" || (s.mum === "perched" && mum.spread > 0.2)) && mum.group.visible) {
      const beat = Math.floor(s.flapPhase / (Math.PI * 2));
      if (beat !== s.lastFlap) {
        s.lastFlap = beat;
        mum.group.getWorldPosition(scratch.a).project(camera);
        flap(0.5 + mum.spread * 0.5, scratch.a.x);
      }
    }
    // Her head: turning about in quick steps while she perches, dipping to let the photo go.
    {
      const t = s.time;
      const dip = s.phase === "drop" ? Math.sin(clamp01(s.phaseTime / FALL) * Math.PI) : 0;
      const glance = s.mum === "perched" ? Math.round(Math.sin(t * 1.3) * 2) * 0.25 : 0;
      mum.head.rotation.set(0.15 + dip * 0.7, glance, Math.sin(t * 0.9) * 0.08 * (s.mum === "perched" ? 1 : 0), "YXZ");
      mum.gape = s.phase === "drop" ? 0.5 : 0.18;
    }
    mum.update();

    // The photo: in her beak, falling, then lying where it lands.
    if (s.photo === "held") {
      mum.group.updateWorldMatrix(true, true);
      mum.beakTip.getWorldPosition(scratch.a);
      mum.head.getWorldQuaternion(scratch.q);
      // Gripped by the deep strip at the bottom, held out in front of her like a leaf, picture up, flexing a little.
      const flex = Math.sin(s.time * 3.1) * 0.05;
      photo.group.quaternion.copy(scratch.q).multiply(HELD).multiply(scratch.q2.setFromEuler(scratch.e.set(flex - 0.12, 0, 0)));
      photo.group.position.copy(scratch.a).sub(scratch.b.set(0, CARD.bottom + 0.7, 0).applyQuaternion(photo.group.quaternion));
    } else if (s.photo === "falling") {
      s.fallTime += step;
      const t = clamp01(s.fallTime / FALL);
      photo.group.position.lerpVectors(s.fallFrom.position, level.rest.position, t * t);
      photo.group.position.y += Math.sin(t * Math.PI) * 0.6;
      photo.group.quaternion.slerpQuaternions(s.fallFrom.quaternion, level.rest.quaternion, smooth(t));
      if (t >= 1) {
        s.photo = "resting";
        s.fallTime = 0;
        dropSound();
      }
    } else if (s.photo === "resting") {
      s.fallTime += step;
      // A little settle after it lands.
      const wobble = Math.exp(-s.fallTime * 6) * Math.sin(s.fallTime * 24) * 0.05;
      photo.group.position.copy(level.rest.position);
      photo.group.quaternion.copy(level.rest.quaternion).multiply(scratch.q.setFromEuler(scratch.e.set(wobble, 0, wobble * 0.4)));
    }

    // The chicks: begging while Mum is here, watching the photo once it lands.
    const call = s.mum === "in" ? smooth(clamp01((s.mumTime / ARRIVE - 0.5) * 2)) : s.mum === "perched" ? 1 : s.mum === "out" ? Math.max(0, 1 - s.mumTime * 1.5) : 0;
    const clockRate = [0, 0, 0];
    clockRate[s.current] = 1;
    // The next world wakes as the camera dives into it: still as a photograph until then.
    const alive = s.phase === "dive" ? smooth(clamp01((s.s - 0.12) / 0.6)) : 0;
    clockRate[s.next] = Math.max(clockRate[s.next], alive);
    let peeps = 0;
    for (const lv of levels) {
      const rate = clockRate[lv.index];
      const ldt = dt * rate * (speed.current ?? 1);
      s.clocks[lv.index] += ldt;
      lv.l.clock.value = s.clocks[lv.index];
      if (ldt <= 0) continue;
      for (const chick of lv.chicks) {
        let lookAt: THREE.Vector3 | null = null;
        if (lv.index === s.current) {
          if (s.mum !== "away") lookAt = mum.head.getWorldPosition(scratch.c);
          else if (s.photo === "resting") lookAt = photo.group.getWorldPosition(scratch.c);
          if (lookAt) lookAt = chick.group.worldToLocal(scratch.d.copy(lookAt)).divideScalar(1);
        }
        chick.step(ldt, lv.index === s.current ? call : 0, lookAt);
        if (lv.index === s.current && chick.peeps && peeps < 2) {
          peeps++;
          chick.group.getWorldPosition(scratch.a).project(camera);
          peep(chick.pitch, scratch.a.x * 0.8, call > 0.5 ? 0.8 : 1);
        }
      }
    }

    // The camera.
    const hfov = across();
    const d = PICTURE / (2 * MARGIN) / Math.tan(hfov / 2);
    const back = START.distanceTo(TARGET);
    // Drag to look, springing back when let go.
    if (!s.dragging) {
      s.lookVel.x += (-s.look.x * 6 - s.lookVel.x * 4.5) * dt;
      s.lookVel.y += (-s.look.y * 6 - s.lookVel.y * 4.5) * dt;
      s.look.x += s.lookVel.x * dt;
      s.look.y += s.lookVel.y * dt;
    }
    // Where the eye rests: the start, carried on in by the dive and settling.
    if (s.carry > 0) {
      s.pushed *= Math.exp(-s.carry * dt);
      s.carry *= Math.exp(-dt * s.decay);
      if (s.carry < 0.002) s.carry = 0;
    }
    if (s.carry === 0) s.pushed += (SETTLE - s.pushed) * (1 - Math.exp(-dt * 1.5));
    const restAt = scratch.a.copy(START).lerp(TARGET, 1 - s.pushed);
    void back;
    // Breathing: a hand-held drift, fading in after the hand-over.
    const settleIn = smooth(clamp01(s.since / 2.5));
    const t = s.time;
    const drift = scratch.b.set(Math.sin(t * 0.31) * 0.35 + Math.sin(t * 0.73 + 1) * 0.12, Math.sin(t * 0.27 + 2) * 0.25, Math.sin(t * 0.19 + 4) * 0.2).multiplyScalar(settleIn);
    const restPos = scratch.c.copy(restAt).add(drift);
    // Look direction: at the target, turned by the drag.
    const restQ = scratch.q;
    scratch.m.lookAt(restPos, TARGET, THREE.Object3D.DEFAULT_UP);
    restQ.setFromRotationMatrix(scratch.m);
    // Dragging takes hold of the world: drag right and the view turns left.
    restQ.multiply(scratch.q2.setFromEuler(scratch.e.set(s.look.y * settleIn, s.look.x * settleIn, 0, "YXZ")));

    if (s.phase === "dive") {
      // The dive: in log-distance toward the picture at a steady relative speed, easing in from rest; turning square to
      // the picture by the time the frame leaves the screen.
      s.phaseTime = s.phaseTime;
      const ramp = smooth(clamp01(s.phaseTime / 1.4));
      const rate = (1 / DIVE) * 1.25 * ramp;
      s.s += rate * step;
      photo.group.updateWorldMatrix(true, false);
      const centre = photo.group.getWorldPosition(new THREE.Vector3());
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(photo.group.quaternion);
      const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(photo.group.quaternion);
      const sp = Math.min(1, s.s);
      const w = smooth(clamp01(sp / 0.8));
      const dir0 = s.from.position.clone().sub(centre).normalize();
      const dir = dir0.clone().lerp(n, w).normalize();
      const r = s.r0 * Math.pow(d / s.r0, sp);
      const pos = centre.clone().addScaledVector(dir, r);
      // Looking at the picture's middle, the up turning to the picture's own.
      const up = THREE.Object3D.DEFAULT_UP.clone().lerp(yAxis, w).normalize();
      scratch.m.lookAt(pos, pos.clone().sub(n.clone().lerp(dir, 1 - w).normalize()), up);
      const lookQ = new THREE.Quaternion().setFromRotationMatrix(scratch.m);
      // At first still turned as it was, then onto the picture.
      const turn = smooth(clamp01(sp / 0.3));
      camera.quaternion.slerpQuaternions(s.from.quaternion, lookQ, turn);
      camera.position.copy(pos);
      photo.u.alive.value = alive;
      // The lens on the picture, and the air thinning out.
      focusDistance.value = Math.max(1, r);
      air.fade.value = Math.max(0, air.fade.value - dt * 1.2);
      if (s.s >= 1) {
        // The picture fills the view: hand over, carrying the dive's speed into the new world.
        const relative = Math.log(s.r0 / d) * rate * pace;
        const over = (s.s - 1) * Math.log(s.r0 / d);
        handOver();
        s.carry = relative;
        // Dying away at the rate that leaves the eye where it rests.
        s.decay = relative / Math.log(1 / SETTLE);
        s.pushed = Math.exp(-over);
        const at = scratch.a.copy(START).lerp(TARGET, 1 - s.pushed);
        camera.position.copy(at);
        camera.lookAt(TARGET);
        focusBlur.value = 0;
      }
    } else {
      camera.position.copy(restPos);
      camera.quaternion.copy(restQ);
      focusDistance.value += (camera.position.distanceTo(scratch.d.set(0, -0.5, 0)) - focusDistance.value) * (1 - Math.exp(-dt * 4));
      air.fade.value = Math.min(1, air.fade.value + dt * 0.5);
    }
    if (debug.current.view) {
      camera.position.copy(debug.current.view.from);
      camera.lookAt(debug.current.view.to);
    }
    if (camera.fov !== FOV) {
      camera.fov = FOV;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    // The lens refocusing after the hand-over, from the photograph's flat sharpness to the scene's depth.
    focusBlur.value = 3.2 * smooth(clamp01(s.since / 1.8));

    // The picture: drawn once as a still when the photo appears; live, and only as much as is seen, during the dive.
    if (s.photo !== "hidden") {
      if (s.phase === "dive") renderPicture(false);
      else if (!s.snapshot) {
        renderPicture(true);
        s.snapshot = true;
      }
    }
    void nextLevel;
  });

  return (
    <>
      {levels.map((level) => (
        <primitive key={level.def.key} object={level.group} />
      ))}
      <primitive object={photo.group} />
      <Air l={airLight} fade={air.fade} amount={air.amount} />
    </>
  );
}

const day: DayDefinition = {
  camera: { position: [START.x, START.y, START.z], target: [TARGET.x, TARGET.y, TARGET.z], fov: FOV },
  look: { background: "#000000", exposure: 1, bloom: 0.22, bloomThreshold: 0.9, gi: 0, ao: 0, vignette: 0.42, grain: 0.03, haze: 0 },
  passes: { haze: false, bounce: false, overlay: true, occlusion: false, depthOfField: { range: 16 } },
  settings: {
    speed: { type: "range", label: "Speed", min: 0.5, max: 2, step: 0.05, value: 1, reset: 1 },
    auto: { type: "toggle", label: "Auto-play", value: true },
    next: { type: "action", label: "Next nest" }
  },
  prompt: { title: "Tap a chick", detail: "Or tap the sky to call Mum", low: true },
  hint: "Tap a chick to set it peeping, the sky to call Mum, the developed photo to dive in. Drag to look around.",
  notes: "A nest with three chicks. Mum brings a photo instead of a worm. It develops into a nest with chicks, and the camera falls into it. It's nests all the way down.",
  Scene
};

export default day;
