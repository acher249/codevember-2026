"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { cameraTaken, orbitControls, orbitPoint } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { loadRetried, suspendRetried } from "../../shared/engine/retry";
import { useSettingAction } from "../../shared/engine/settings";
import { sound, useBed } from "../../shared/engine/sound";
import { StudioEnvironment } from "../../shared/engine/studio";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { buildGround } from "./ground";
import { buildPit, CENTRE, EYE } from "./pit";

// A chalk drawing of a pit on a paved square at night, under one street lamp: a ragged hole through the slabs, a
// ladder standing up out of it, a lantern glowing far down. Walk round it and it is a long flat smear of chalk. Tap
// it and the view sweeps through the one spot it was drawn for, where the chalk is the hole pixel for pixel, and on
// that frame the drawing is swapped for the real pit. The view sweeps on, drifting as before, and the hole stays a
// hole: walk round it and look down in. Tap again and it goes back to chalk the same way.
// Metres throughout; the ground at y = 0.

// The view to start from: up and off to the side, where the drawing is plainly a drawing.
const START = new THREE.Vector3(3.1, 4.6, 1.6);
const FOV = 40;
// The lamp post, off to the right of the drawing.
const POST = new THREE.Vector3(3.2, 0, -0.5);
const LAMP = new THREE.Vector3(2.75, 4.4, -0.5);
// Where the real pit waits while it is only a drawing: deep under the paving, out of sight but drawn, so nothing is
// built for the first time when it becomes real.
const PARKED = -40;
// A press that moves less than this (pixels) and lets go this soon (ms) is a tap.
const TAP = { move: 8, time: 450 };

const PAVING = ["/assets/18-pendulum/concrete_floor_worn_001_diff_2k.jpg", "/assets/18-pendulum/concrete_floor_worn_001_nor_gl_2k.jpg", "/assets/18-pendulum/concrete_floor_worn_001_rough_2k.jpg"];
const ROCK = ["/assets/17-kelp/low_tide_rocks_diff_2k.jpg", "/assets/17-kelp/low_tide_rocks_nor_gl_2k.jpg"];

function useScans() {
  const gl = useThree((state) => state.gl);
  const urls = [...PAVING, ...ROCK];
  const loaded = suspendRetried(() => Promise.all(urls.map((url) => loadRetried(new THREE.TextureLoader(), url))), ["anamorph-chalk", ...urls]);
  return useMemo(() => {
    const [colour, normal, rough, rock, rockNormal] = loaded;
    loaded.forEach((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = Math.min(8, (gl as any).getMaxAnisotropy?.() ?? 8);
      t.needsUpdate = true;
    });
    colour.colorSpace = rock.colorSpace = THREE.SRGBColorSpace;
    return { colour, normal, rough, rock, rockNormal };
  }, [loaded, gl]);
}

// Sticks of chalk dropped by the drawing's near end, some worn down, a couple snapped.
function chalkSticks() {
  const colours = ["#f2efe6", "#f2efe6", "#e9b3c2", "#f3d98a", "#9cc3e6", "#c98d5a", "#2a2a2e", "#a5d6a0", "#f2efe6", "#e58f6b"];
  const geometry = new THREE.CylinderGeometry(0.011, 0.011, 1, 10);
  const materials = colours.map((colour) => new THREE.MeshStandardNodeMaterial({ color: colour, roughness: 0.97 }));
  const group = new THREE.Group();
  colours.forEach((_, k) => {
    const mesh = new THREE.Mesh(geometry, materials[k]);
    const r = Math.sin(k * 12.9898) * 43758.5453;
    const f = r - Math.floor(r);
    mesh.scale.set(1, 0.035 + f * 0.045, 1);
    mesh.rotation.set(0, f * Math.PI * 2, Math.PI / 2);
    mesh.rotation.order = "YZX";
    mesh.position.set(0.95 + Math.cos(k * 2.4) * (0.08 + f * 0.25), 0.011, 1.75 + Math.sin(k * 2.4) * (0.06 + f * 0.2));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  return { group, geometries: [geometry], materials };
}

// The street lamp: a post, an arm and a hooded lamp, the bulb glowing.
function streetLamp() {
  const metal = new THREE.MeshStandardNodeMaterial({ color: "#20262a", roughness: 0.55, metalness: 0.7 });
  const bulbMaterial = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color("#ffd2a0").multiplyScalar(6) });
  const postGeometry = new THREE.CylinderGeometry(0.05, 0.08, 4.6, 16);
  const armGeometry = new THREE.BoxGeometry(0.55, 0.06, 0.06);
  const hoodGeometry = new THREE.CylinderGeometry(0.08, 0.24, 0.16, 20, 1, true);
  const bulbGeometry = new THREE.SphereGeometry(0.07, 16, 10);
  const group = new THREE.Group();
  const post = new THREE.Mesh(postGeometry, metal);
  post.position.set(POST.x, 2.3, POST.z);
  const arm = new THREE.Mesh(armGeometry, metal);
  arm.position.set((POST.x + LAMP.x) / 2, 4.55, POST.z);
  const hood = new THREE.Mesh(hoodGeometry, metal);
  hood.position.set(LAMP.x, LAMP.y + 0.1, LAMP.z);
  const bulb = new THREE.Mesh(bulbGeometry, bulbMaterial);
  bulb.position.copy(LAMP);
  [post, arm, hood].forEach((mesh) => (mesh.castShadow = true));
  group.add(post, arm, hood, bulb);
  return { group, geometries: [postGeometry, armGeometry, hoodGeometry, bulbGeometry], materials: [metal, bulbMaterial] };
}

// Lit windows and street lights of the town far behind, which the depth of field turns to soft discs.
function town(count: number) {
  const geometry = new THREE.SphereGeometry(1, 10, 6);
  const material = new THREE.MeshBasicNodeMaterial({ color: "#ffffff" });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const r = (n: number) => {
      const s = Math.sin(i * 91.7 + n * 13.1) * 43758.5453;
      return s - Math.floor(s);
    };
    const across = (r(1) - 0.5) * 70;
    const away = -22 - r(2) * 30;
    m.makeScale(0.12 + r(3) * 0.2, 0.12 + r(3) * 0.2, 0.12 + r(3) * 0.2).setPosition(across, 0.6 + Math.pow(r(4), 1.6) * 12, away + Math.abs(across) * 0.2);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.set(r(5) < 0.7 ? "#ffb36b" : r(5) < 0.9 ? "#ffe2b8" : "#9fc4ff").multiplyScalar(1.5 + r(6) * 3));
  }
  return { mesh, geometries: [geometry], materials: [material] };
}

// Dust and fine drizzle hanging in the lamp's light, drifting.
function motes(count: number) {
  const geometry = new THREE.SphereGeometry(1, 6, 4);
  const material = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color("#ffd9a8").multiplyScalar(1.4) });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const seeds = Array.from({ length: count }, (_, i) => {
    const r = (n: number) => {
      const s = Math.sin(i * 47.3 + n * 7.7) * 43758.5453;
      return s - Math.floor(s);
    };
    return { x: (r(1) - 0.5) * 5 + 1.6, y: 0.2 + r(2) * 4, z: (r(3) - 0.5) * 6 - 0.2, size: 0.003 + Math.pow(r(4), 3) * 0.008, phase: r(5) * 100 };
  });
  return { mesh, seeds, geometries: [geometry], materials: [material] };
}

// The sweep through the artist's spot: in from wherever the view is, past the spot sideways (so the hole's depth shows
// at once as the view moves on), and out the other side. Two curves that meet at the spot heading the same way, so
// the path bends smoothly everywhere. It is travelled by distance at a speed that eases in, slows right down through
// the spot (never stopping) and eases out to rest, the speed itself followed with damping so it never changes at once.
// The view turns from the point it was looking at to the drawing's middle, arriving exactly as it passes the spot.
type Sweep = { path: THREE.CurvePath<THREE.Vector3>; length: number; spot: number; travelled: number; speed: number; top: number; age: number; passed: boolean; toReal: boolean; lookFrom: THREE.Vector3; look: THREE.Vector3 };

function sweepFrom(from: THREE.Vector3, lookFrom: THREE.Vector3, toReal: boolean): Sweep {
  const side = new THREE.Vector3(from.x >= EYE.x ? 1 : -1, 0, 0);
  // The way through the spot: sideways, drifting a little forward and down.
  const through = side.clone().negate().add(new THREE.Vector3(0, -0.12, -0.25)).normalize();
  const end = EYE.clone().addScaledVector(through, 1.9);
  const inward = new THREE.CubicBezierCurve3(from.clone(), from.clone().lerp(EYE, 0.35).add(new THREE.Vector3(0, 0.2, 0)), EYE.clone().addScaledVector(through, -1.6), EYE.clone());
  const outward = new THREE.CubicBezierCurve3(EYE.clone(), EYE.clone().addScaledVector(through, 0.9), end.clone().addScaledVector(through, -0.4), end);
  inward.arcLengthDivisions = outward.arcLengthDivisions = 400;
  const path = new THREE.CurvePath<THREE.Vector3>();
  path.add(inward);
  path.add(outward);
  const spot = inward.getLength();
  const length = spot + outward.getLength();
  return { path, length, spot, travelled: 0, speed: 0, top: THREE.MathUtils.clamp(length / 3.4, 1.1, 2.4), age: 0, passed: false, toReal, lookFrom: lookFrom.clone(), look: new THREE.Vector3() };
}

// The speed wanted at a point along the sweep (metres a second): up to `top`, down to about a quarter through the spot,
// and at the end braking evenly (as a thing slowing under constant friction) to rest exactly on the end.
function pace(run: Sweep) {
  const near = Math.exp(-Math.pow((run.travelled - run.spot) / 0.75, 2));
  return Math.min(run.top * (1 - 0.75 * near), Math.sqrt(2 * 0.45 * Math.max(0, run.length - run.travelled)));
}

function inside(x: number, z: number, edge: THREE.Vector3[]) {
  let hit = false;
  for (let i = 0, j = edge.length - 1; i < edge.length; j = i++) {
    const a = edge[i];
    const b = edge[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

function Scene() {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const scans = useScans();

  // The artist's picture of the pit: sized to the view's own pixels each frame (with a margin round them), so that
  // from the spot each pixel of the drawing is exactly one pixel of the picture.
  const picture = useMemo(() => new THREE.RenderTarget(4, 4, { type: THREE.HalfFloatType }), []);
  const shot = useMemo(() => new THREE.PerspectiveCamera(), []);
  const pit = useMemo(() => buildPit({ rock: scans.rock, rockNormal: scans.rockNormal, slab: scans.colour }), [scans]);
  const ground = useMemo(() => buildGround({ colour: scans.colour, normal: scans.normal, rough: scans.rough }, picture.texture, pit.artist), [scans, picture, pit]);
  // How far out from the middle of the view (as tangents) the drawing reaches: the hole, and the ladder over it.
  const reach = useMemo(() => {
    const unit = new THREE.PerspectiveCamera(90, 1, 0.05, 100);
    unit.position.copy(EYE);
    unit.lookAt(CENTRE);
    unit.updateMatrixWorld();
    const out = { x: 0, y: 0 };
    const top = pit.ladderTop;
    [...pit.edge, top.clone().setX(top.x - 0.4), top.clone().setX(top.x + 0.4)].forEach((p) => {
      const q = p.clone().project(unit);
      out.x = Math.max(out.x, Math.abs(q.x) * 1.08);
      out.y = Math.max(out.y, Math.abs(q.y) * 1.08 + 0.02);
    });
    return out;
  }, [pit]);
  // Parked out of sight, the real pit would be left out of the view as off-screen, and built for it only on the frame it
  // turns real: a stall at exactly the moment that must be seamless. Always drawn instead, hidden under the paving.
  useMemo(() => pit.real.traverse((object) => (object.frustumCulled = false)), [pit]);
  const sticks = useMemo(() => chalkSticks(), []);
  const lamp = useMemo(() => streetLamp(), []);
  const lights = useMemo(() => town(startTier === "low" ? 60 : 120), [startTier]);
  const dust = useMemo(() => motes(startTier === "low" ? 120 : 260), [startTier]);
  const light = useMemo(() => {
    const spot = new THREE.SpotLight("#ffc68a", 95, 0, 0.95, 0.65, 2);
    spot.position.copy(LAMP);
    spot.target.position.copy(CENTRE).add(new THREE.Vector3(-0.6, 0, 1.2));
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.bias = -0.0002;
    const sky = new THREE.HemisphereLight("#2b3550", "#060606", 0.4);
    return { spot, sky };
  }, []);
  useDispose(picture, ...pit.geometries, ...pit.materials, ...ground.geometries, ...ground.materials, ...sticks.geometries, ...sticks.materials, ...lamp.geometries, ...lamp.materials, ...lights.geometries, ...lights.materials, ...dust.geometries, ...dust.materials);

  useBed("wind", 0.07);
  const state = useRef({ time: 0, still: false, real: false, sweep: null as Sweep | null, clear: new THREE.Color(), size: new THREE.Vector2(), hidden: [] as THREE.Object3D[], madeReal: false });
  const scratch = useMemo(() => ({ m: new THREE.Matrix4(), ray: new THREE.Raycaster(), ndc: new THREE.Vector2(), hit: new THREE.Vector3(), floor: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0) }), []);

  // The orbit's own leftover motion (its damping carries on a drag after the press ends): cleared when the sweep takes
  // the view and again when it gives it back.
  const settle = () => {
    const orbit = orbitControls.current as any;
    orbit?._sphericalDelta?.set(0, 0, 0);
    orbit?._panOffset?.set(0, 0, 0);
    if (orbit && "_scale" in orbit) orbit._scale = 1;
  };

  const sweep = (toReal: boolean) => {
    const s = state.current;
    if (s.sweep) return;
    // From exactly where the view is and what it is looking at (the float moves both), with any turn the press left
    // in the orbit dropped, so nothing jumps as the sweep takes over or hands back.
    const looking = orbitPoint.current?.clone() ?? camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(camera.position.distanceTo(CENTRE)).add(camera.position);
    s.sweep = sweepFrom(camera.position, looking, toReal);
    settle();
    cameraTaken.current = true;
    sound.play("whoosh", { gain: 0.35, size: 1.5 });
    dismissPrompt();
  };

  // Tap the drawing (or the hole, once real) to sweep through the spot and swap.
  useEffect(() => {
    const dom = gl.domElement;
    let down: { x: number; y: number; at: number } | null = null;
    const press = (event: PointerEvent) => (down = { x: event.clientX, y: event.clientY, at: performance.now() });
    const release = (event: PointerEvent) => {
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > TAP.move || performance.now() - down.at > TAP.time) return;
      down = null;
      const rect = dom.getBoundingClientRect();
      scratch.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      scratch.ray.setFromCamera(scratch.ndc, camera);
      if (!scratch.ray.ray.intersectPlane(scratch.floor, scratch.hit)) return;
      if (inside(scratch.hit.x, scratch.hit.z, pit.edge)) sweep(!state.current.real);
    };
    dom.addEventListener("pointerdown", press);
    dom.addEventListener("pointerup", release);
    return () => {
      dom.removeEventListener("pointerdown", press);
      dom.removeEventListener("pointerup", release);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, camera, pit, scratch]);

  useSettingAction("redraw", () => state.current.real && sweep(false));

  useEffect(() => () => void (cameraTaken.current = false), []);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    Object.assign(window, { __anamorph: { pit, ground, picture, camera, shot, state: state.current, eye: EYE, sweep, hold: (on: boolean) => (cameraTaken.current = on) } });
  });

  // Everything but the pit, put out of the artist's picture while it is taken.
  const hide = (object: THREE.Object3D, hidden: THREE.Object3D[]) => {
    if (object === pit.real || object === pit.shade) return;
    if ((object as THREE.Mesh).isMesh || (object as THREE.Points).isPoints || (object as THREE.Sprite).isSprite || (object as THREE.Line).isLine) {
      if (object.visible) {
        object.visible = false;
        hidden.push(object);
      }
      return;
    }
    object.children.forEach((child) => hide(child, hidden));
  };

  useFrame((_, raw) => {
    const dt = Math.min(raw, 0.05);
    const s = state.current;
    // (`still`, in development only, holds the lantern's flicker for comparing frames.)
    if (!s.still) s.time += dt;

    // The lantern flickers a little.
    pit.flame.intensity = 6 * (0.88 + 0.08 * Math.sin(s.time * 7.3) + 0.05 * Math.sin(s.time * 17.9 + 1.3));

    // The sweep, and the swap on the frame it passes the spot.
    const run = s.sweep;
    if (run) {
      run.age += dt;
      // Damped toward the speed wanted here, from rest, gathering over the first second.
      const wanted = pace(run) * THREE.MathUtils.smoothstep(run.age, 0, 1.2);
      run.speed += (wanted - run.speed) * (1 - Math.exp(-dt * 3.5));
      // In the last few frames before the spot, the steps are evened out to land on it exactly, so the frame that lands
      // there is no shorter than the ones round it.
      let step = run.speed * dt;
      const toSpot = run.spot - run.travelled;
      if (!run.passed && toSpot > 0 && toSpot < step * 4) step = toSpot / Math.max(1, Math.round(toSpot / step));
      let travelled = Math.min(run.length, run.travelled + step);
      if (run.length - travelled < 0.002 && run.speed < 0.05) travelled = run.length;
      if (!run.passed && travelled >= run.spot) {
        // This frame lands on the spot exactly, and the drawing is swapped for the real pit.
        travelled = run.spot;
        run.passed = true;
        s.real = run.toReal;
        if (s.real && !s.madeReal) {
          s.madeReal = true;
          followPrompt.earn("real");
          shareResult.set("I walked past a chalk drawing of a hole and it turned into a real one. Anamorph.");
        }
      }
      run.travelled = travelled;
      if (travelled === run.spot) camera.position.copy(EYE);
      else camera.position.copy(run.path.getPoint(travelled / run.length));
      const turned = THREE.MathUtils.smootherstep(travelled, 0, run.spot);
      run.look.lerpVectors(run.lookFrom, CENTRE, run.passed ? 1 : turned);
      camera.lookAt(run.look);
      camera.updateMatrixWorld();
      orbitPoint.current?.copy(run.look);
      if (travelled >= run.length) {
        s.sweep = null;
        settle();
        cameraTaken.current = false;
      }
    }
    ground.real.value = s.real ? 1 : 0;

    // Near the spot nothing is blurred and the drawing is the picture exactly; away from it, it is chalk.
    const off = camera.position.distanceTo(EYE);
    ground.chalky.value = THREE.MathUtils.smoothstep(off, 0.05, 1.5);
    focusBlur.value = THREE.MathUtils.smoothstep(off, 0.1, 2);
    focusDistance.value = camera.position.distanceTo(CENTRE);

    // The artist's picture: the real scene with only the pit in it, from the spot, through the view's own lens, a
    // margin of whole pixels added round the view's pixels so the drawing is complete from wherever it is seen.
    if (!s.real) {
      gl.getDrawingBufferSize(s.size);
      const [w, h] = [s.size.x, s.size.y];
      const focal = h / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const margin = Math.min(2400, Math.max(0, Math.ceil(reach.x * focal - w / 2), Math.ceil(reach.y * focal - h / 2))) + 2;
      const [pw, ph] = [w + margin * 2, h + margin * 2];
      if (picture.width !== pw || picture.height !== ph) picture.setSize(pw, ph);
      shot.fov = THREE.MathUtils.radToDeg(2 * Math.atan(ph / 2 / focal));
      shot.aspect = pw / ph;
      shot.near = camera.near;
      shot.far = camera.far;
      shot.position.copy(EYE);
      shot.up.copy(camera.up);
      shot.lookAt(CENTRE);
      shot.updateMatrixWorld();
      shot.updateProjectionMatrix();
      ground.sweet.value.multiplyMatrices(shot.projectionMatrix, shot.matrixWorldInverse);

      s.hidden.length = 0;
      hide(scene, s.hidden);
      pit.real.position.y = 0;
      pit.real.updateMatrixWorld(true);
      (pit.shade.material as THREE.Material).depthWrite = true;
      const background = scene.background;
      const backgroundNode = (scene as any).backgroundNode;
      scene.background = null;
      (scene as any).backgroundNode = null;
      const before = gl.getRenderTarget();
      gl.getClearColor(s.clear);
      const alpha = gl.getClearAlpha();
      gl.setRenderTarget(picture);
      gl.setClearColor(0x000000, 0);
      gl.clear();
      gl.render(scene, shot);
      gl.setRenderTarget(before);
      gl.setClearColor(s.clear, alpha);
      scene.background = background;
      (scene as any).backgroundNode = backgroundNode;
      (pit.shade.material as THREE.Material).depthWrite = false;
      s.hidden.forEach((object) => (object.visible = true));
    }
    pit.real.position.y = s.real ? 0 : PARKED;
    pit.real.updateMatrixWorld(true);

    // The dust drifts in the lamplight.
    dust.seeds.forEach((seed, i) => {
      const t = s.time * 0.12 + seed.phase;
      scratch.m.makeScale(seed.size, seed.size, seed.size).setPosition(seed.x + Math.sin(t * 1.3) * 0.4, seed.y + Math.sin(t * 0.7) * 0.3, seed.z + Math.cos(t) * 0.4);
      dust.mesh.setMatrixAt(i, scratch.m);
    });
    dust.mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <StudioEnvironment
        ambient="#05060a"
        intensity={0.25}
        boxes={[
          { position: [3, 5, 0], scale: [1, 0.5, 1], color: "#ffc68a", intensity: 3 },
          { position: [0, 10, 0], scale: [20, 0.5, 20], color: "#1a2032", intensity: 0.6 }
        ]}
      />
      <primitive object={light.spot} />
      <primitive object={light.spot.target} />
      <primitive object={light.sky} />
      <primitive object={ground.mesh} />
      <primitive object={pit.real} />
      <primitive object={pit.shade} />
      <primitive object={sticks.group} />
      <primitive object={lamp.group} />
      <primitive object={lights.mesh} />
      <primitive object={dust.mesh} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [START.x, START.y, START.z],
    target: [CENTRE.x, CENTRE.y, CENTRE.z],
    fov: FOV,
    // From the start: round past the front each way, and down near the ground.
    limits: { turn: { left: 70, right: 75, up: 40, down: 30 }, move: { left: 1.5, right: 1.5, down: 0.5, up: 0.5, nearer: 3, further: 4 } }
  },
  hover: true,
  // No ambient occlusion or depth haze: both would see the flat drawing and the real hole differently, and the two
  // must match on the frame they swap. Depth of field fades out near the spot for the same reason.
  look: { background: "#000000", exposure: 1, bloom: 0.35, bloomThreshold: 0.85, gi: 0, ao: 0, vignette: 0.55, grain: 0.035, haze: 0 },
  passes: { haze: false, bounce: false, overlay: false, occlusion: false, depthOfField: { range: 9, air: 0, airRate: 0, airBehindFocus: 4 } },
  settings: {
    redraw: { type: "action", label: "Back to chalk" }
  },
  prompt: { title: "Walk around the chalk drawing", detail: "Then tap it", high: true },
  hint: "Drag to walk round the chalk drawing and scroll to step in or back. Tap the drawing and it becomes real; tap the hole to turn it back to chalk.",
  notes: "A chalk drawing of a pit on a paved square at night. Walk round it, then tap it: the view sweeps through the one spot it was drawn for and, there, it becomes a real hole.",
  Scene
};

export default day;
