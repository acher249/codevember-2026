"use client";

import { Canvas, extend, useFrame, useThree, type ThreeToJSXElements } from "@react-three/fiber";
import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three/webgpu";
import { dayLoaders } from "@/shared/registry";
import { daySlug, type CodevemberDay } from "@/shared/days";
import { Hud } from "@/shared/ui/Hud";
import "@/shared/engine/instancing";
import { LOAD_ORDER, type LoadStep } from "@/shared/ui/Loader";
import { CameraRig, GrabProvider, useGrabRegistry } from "@/shared/engine/controls";
import { Post, postBypass, postPasses } from "@/shared/engine/Post";
import { Extents } from "@/shared/engine/extents";
import { Hover } from "@/shared/engine/hover";
import { withRetries } from "@/shared/engine/retry";
import { track } from "@/shared/engine/track";
import { explain, lost, NO_3D, reportFailure, type Failure } from "@/shared/engine/failure";
import { AdaptiveQuality, initialTier, topDpr, QualityProvider, scenePhase, type QualityChoice } from "@/shared/engine/quality";
import { SettingsProvider, useCreateSettings } from "@/shared/engine/settings";
// The days call the site Stage's useLook, so the hub has to provide that same context.
import { LookContext } from "@/shared/engine/Stage";
import { markLost, noteAdapter, scarce, startLow } from "./budget";
import { judged, keptUp, tooSlowAt } from "./judged";
import { HubFallback } from "./HubFallback";
import { setPrefaceFailed, usePreface } from "./preface";
import { ReturnRig } from "./ReturnRig";
import { loadSpace } from "./spaces/loaders";
import { SpaceHud } from "./spaces/SpaceHud";
import { DEFAULT_LOOK, type DayDefinition, type Look, type QualityTier, type RenderPhase } from "@/shared/engine/types";

declare module "@react-three/fiber" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

extend(THREE as never);

class SceneBoundary extends Component<{ onError: (failure: Failure) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error(error);
    this.props.onError(explain(error));
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// `day` is null for the hub, the 3D calendar, which is loaded like any day.
type LoadedDay = { id: number; day: CodevemberDay | null; definition: DayDefinition };

// Sits beside the scene inside its Suspense boundary, so it mounts once Rapier and any assets are in.
// The first drawn frame is what compiles the shaders; the scene is ready when the GPU has finished
// that work and frames have stopped stalling.
const TIER_RANK: Record<QualityTier, number> = { low: 0, medium: 1, high: 2 };

// While a day loads, every shader three builds for drawing is built in the background: the GPU compiles it off to the
// side, and whatever uses it is left out of the frame until it is ready. Built the usual way, on the spot, a frame waits
// for each one, and in Chrome so does everything else on screen, the loader included. Behind the loader nothing is
// missed by an object sitting out a frame or two. Returns a function that puts things back as they were.
type Pipelines = { getForRender: (renderObject: unknown, promises?: { push: (p: Promise<void>) => void } | null) => unknown; updateForRender: (renderObject: unknown) => void };

function buildInBackground(gl: THREE.WebGPURenderer, count: { pending: number; lastNewAt: number }) {
  const pipelines = (gl as unknown as { _pipelines?: Pipelines })._pipelines;
  if (!pipelines || !pipelines.getForRender) return () => {};
  const own = Object.prototype.hasOwnProperty.call(pipelines, "updateForRender");
  const before = pipelines.updateForRender;
  const tracker = {
    push(promise: Promise<void>) {
      count.pending += 1;
      count.lastNewAt = performance.now();
      const settle = () => {
        count.pending -= 1;
      };
      promise.then(settle, settle);
    }
  };
  pipelines.updateForRender = (renderObject) => {
    pipelines.getForRender(renderObject, tracker);
  };
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (own) pipelines.updateForRender = before;
    else delete (pipelines as Partial<Pipelines>).updateForRender;
  };
}

// Builds the scene's shaders as the frames will draw it: through the pass that draws the scene (Post.tsx), into its own
// render target with its extra outputs, since a shader built for the bare screen is a different shader and the first
// frame would build every one again. Straight to the screen where a scene draws there. The passes that draw only a layer
// or two (haze, the overlay's light in the air) hold a few things, and build them in the first frames as before. The build
// pauses for a frame now and then with the pass's target and outputs still set on the renderer, so the scene's own
// frames are held meanwhile (SceneWarmup): anything a scene draws for itself would be drawn into them, and built wrong.
const passesToBuild = () => (postBypass.current ? [] : postPasses.current.filter((pass) => !pass._layers));
async function precompile(gl: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const passes = passesToBuild();
  if (!passes.length) return gl.compileAsync(scene, camera);
  for (const pass of passes) await pass.compileAsync(gl);
}

// Where the camera starts: a day's own view for phones, on a narrow screen, if it has one.
function startingView(camera: DayDefinition["camera"]) {
  const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;
  const view = narrow && camera.phone ? camera.phone : camera;
  return { position: view.position, target: view.target, fov: view.fov ?? camera.fov };
}

// Before the scene is shown, while the loader still covers it, the frame rate is judged once: a scene too slow for its
// tier on Auto steps down here, unseen, rather than a few seconds after it appears, where rebuilding its passes (and
// often the scene) shows as a stall and a flash. A day this device kept up with before is not timed again (judged.ts).
const PROBE = 800;
// With room to spare: once shown, the page has a little more to draw, and a step down then is what this is here to avoid.
const SLOW = 48;
type Judge = { stepDown: (() => void) | null; skip: boolean; verdict: (keeps: boolean) => void };

function SceneWarmup({ phase, onCompiling, onReady, judge, hold }: { phase: RefObject<RenderPhase>; onCompiling: () => void; onReady: () => void; judge: RefObject<Judge>; hold: (held: boolean) => void }) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const size = useThree((state) => state.size);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const run = useRef({ frames: 0, smooth: 0, gpuDone: false, gpuDoneAt: 0, finished: false, warmAt: 0, probeAt: 0, probeFrames: 0, steps: 0 });
  const unhidden = useRef<THREE.Object3D[]>([]);
  const compiling = useRef({ pending: 0, lastNewAt: 0, release: () => {} });

  useEffect(() => {
    let cancelled = false;
    phase.current = "hold";
    onCompiling();
    const shaders = compiling.current;
    shaders.release = buildInBackground(gl, shaders);
    // The scene's frames held while its shaders are built through the scene pass (precompile), from before the first.
    const held = passesToBuild().length > 0;
    if (held) hold(true);
    // Let the loader paint its new step before starting.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(async () => {
        // Shaders are compiled ahead of the first frame, hidden things too, in small pieces between which the page gets
        // to draw, with the GPU building its pipelines off to the side. Compiled on the first draw instead, they would
        // all be done in one go, holding up the whole screen, the loader included, until they were.
        const hidden: THREE.Object3D[] = [];
        scene.traverse((object) => {
          if (object.visible) return;
          object.visible = true;
          hidden.push(object);
        });
        try {
          // A phone's driver can leave a compile hanging. Give up waiting after a while; the first frames build the rest.
          await Promise.race([precompile(gl, scene, camera), new Promise((resolve) => window.setTimeout(resolve, 15000))]);
        } catch (error) {
          // The first frame compiles whatever is left, as before.
          console.warn(error);
        } finally {
          if (held) hold(false);
        }
        for (const object of hidden) object.visible = false;
        if (cancelled) return;
        // The backend caches the canvas depth buffer, and on some loads it holds one from before the
        // canvas had its real size, which invalidates every frame. Setting the size clears that cache.
        gl.setSize(size.width, size.height, false);
        phase.current = "warm";
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      shaders.release();
      if (held) hold(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A shader compiles the first time something using it is drawn. So everything hidden for now is drawn for the first
  // few frames behind the loader, or it would stall the scene whenever it first appeared.
  useFrame(() => {
    if (phase.current !== "warm" || run.current.frames >= 3) return;
    scene.traverse((object) => {
      if (object.visible) return;
      object.visible = true;
      unhidden.current.push(object);
    });
  }, 0.5);

  useFrame((_, delta) => {
    const state = run.current;
    for (const object of unhidden.current) object.visible = false;
    unhidden.current.length = 0;
    if (phase.current !== "warm" || state.finished) return;
    state.frames += 1;
    if (state.frames === 1) {
      state.warmAt = performance.now();
      const markDone = () => {
        state.gpuDone = true;
        state.gpuDoneAt = performance.now();
      };
      const device = (gl.backend as unknown as { device?: { queue: { onSubmittedWorkDone: () => Promise<void> } } }).device;
      if (device) device.queue.onSubmittedWorkDone().then(markDone, markDone);
      else markDone();
      return;
    }
    // Not until every shader asked for so far is built, and a few frames have gone by without a new one.
    const shaders = compiling.current;
    // Nor forever: a pipeline a phone never finishes building must not leave the loader stuck. Past this the scene shows,
    // and anything still building joins it when it is ready.
    const overdue = performance.now() - state.warmAt > 12000;
    if (!overdue && (!state.gpuDone || shaders.pending > 0 || performance.now() - shaders.lastNewAt < 150)) return;
    state.smooth = delta < 1 / 12 ? state.smooth + 1 : 0;
    // A slow machine may never run smoothly. Don't keep it waiting for that.
    if (!state.probeAt && !(overdue || state.smooth >= 4 || performance.now() - state.gpuDoneAt > 2500)) return;
    // Ready to show. On Auto, a moment's frames first, to see whether this tier keeps up.
    const stepDown = judge.current.stepDown;
    if (!overdue && stepDown && !judge.current.skip && state.steps < 2) {
      const now = performance.now();
      if (!state.probeAt) {
        state.probeAt = now;
        state.probeFrames = 0;
        return;
      }
      state.probeFrames += 1;
      if (now - state.probeAt < PROBE) return;
      const fps = (state.probeFrames * 1000) / (now - state.probeAt);
      state.probeAt = 0;
      judge.current.verdict(fps >= SLOW);
      if (fps < SLOW) {
        // A tier down, and back to waiting for whatever that has to build.
        state.steps += 1;
        state.smooth = 0;
        state.gpuDoneAt = now;
        shaders.lastNewAt = now;
        stepDown();
        return;
      }
    }
    state.finished = true;
    shaders.release();
    phase.current = "live";
    onReady();
  }, 2);

  return null;
}

// The lens kept to the shape of the canvas. R3F makes its camera with no shape (an aspect of 0) and gives it one only when
// it sees the canvas change size; with the renderer made asynchronously, the canvas can already have its final size
// before the camera exists, and then the camera never gets one. Every frame is then drawn through a lens that sees nothing:
// the draws all run, but only the background colour reaches the screen. Nothing is touched while the two agree.
function LensShape() {
  useFrame((state) => {
    const lens = state.camera as THREE.PerspectiveCamera;
    if (!lens.isPerspectiveCamera || !state.size.height) return;
    const aspect = state.size.width / state.size.height;
    if (Math.abs(lens.aspect - aspect) < 1e-4) return;
    lens.aspect = aspect;
    lens.updateProjectionMatrix();
  });
  return null;
}

// The site's Stage, with the hub as one more module: with no day, it shows the hub. The renderer lives for the whole visit,
// the hub included, so there is no new GPU device, canvas or page load between the calendar and a day.
export default function HubStage({ day, onStep }: { day: CodevemberDay | null; onStep: (step: LoadStep) => void }) {
  const [loaded, setLoaded] = useState<LoadedDay | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const making = useRef<Promise<never> | null>(null);
  const [choice, setChoice] = useState<QualityChoice>("auto");
  // Short of memory (budget.ts), or back after the graphics device was lost in this tab: the lowest tier from the start.
  const [autoTier, setAutoTier] = useState<QualityTier>(() => (startLow() ? "low" : initialTier()));
  const [isWebGPU, setIsWebGPU] = useState(true);
  // Held here, not set on the renderer, because the canvas puts its dpr prop back whenever this component renders.
  const [dpr, setDpr] = useState(topDpr);
  // The scene's frames, held while the warm-up builds its shaders through the passes.
  const [held, setHeld] = useState(false);
  const fpsRef = useRef<HTMLElement | null>(null);
  const phase = scenePhase;
  const loadId = useRef(0);
  const reached = useRef(0);
  const registry = useGrabRegistry();

  const definition = loaded?.definition;
  const start = definition?.autoStart;
  const tier = choice === "auto" ? (start && TIER_RANK[start] < TIER_RANK[autoTier] ? start : autoTier) : choice;
  // What the warm-up may do about a slow scene: step Auto down a tier, if there is one above the day's floor. Not for the hub,
  // which has none of the passes the tiers are for (no bounce light, shading in creases or haze; on the lowest only its lens
  // blur goes), so a second of timing it behind the loader only kept the visitor waiting. Auto still steps down later if
  // the calendar turns out far too slow.
  const floor = definition?.autoFloor ?? "low";
  const judge = useRef<Judge>({ stepDown: null, skip: false, verdict: () => {} });
  const judgedDay = loaded?.day?.day;
  judge.current.stepDown =
    choice === "auto" && isWebGPU && !!loaded?.day && TIER_RANK[tier] > TIER_RANK[floor] ? () => setAutoTier(tier === "high" ? "medium" : "low") : null;
  judge.current.skip = judgedDay !== undefined && keptUp(judgedDay, tier);
  judge.current.verdict = (keeps) => {
    if (judgedDay !== undefined) judged(judgedDay, tier, keeps);
  };
  // For a day that was too slow at this tier before: where Auto stands now, read when the day arrives.
  const autoNow = useRef({ choice, autoTier, isWebGPU });
  autoNow.current = { choice, autoTier, isWebGPU };
  const settings = useCreateSettings(definition?.settings);

  const [lookPatch, setLookPatch] = useState<Partial<Look>>({});
  const look = useMemo<Look>(() => ({ ...DEFAULT_LOOK, ...definition?.look, ...lookPatch }), [definition, lookPatch]);
  // A key patched to undefined goes back to the day's own value.
  const applyLook = useMemo(
    () => (patch: Partial<Look>) =>
      setLookPatch((current) => {
        const next: Partial<Look> = { ...current, ...patch };
        for (const key of Object.keys(next) as (keyof Look)[]) if (next[key] === undefined) delete next[key];
        return next;
      }),
    []
  );

  // Steps only move forward, except for the reset at the start of a move to another day.
  const advance = useCallback(
    (step: LoadStep) => {
      const rank = LOAD_ORDER.indexOf(step);
      if (step !== "swap" && rank < reached.current) return;
      reached.current = rank;
      onStep(step);
    },
    [onStep]
  );

  useEffect(() => {
    let cancelled = false;
    if (loaded && day) advance("swap");
    // A new day starts clean, unless the failure was the renderer's own, which a new day cannot mend.
    setError((shown) => (shown && (shown.kind === "no-3d" || shown.kind === "memory") ? shown : null));
    const load = day ? dayLoaders[`${String(day.day).padStart(2, "0")}-${day.word.toLowerCase()}`] : loadSpace;
    if (!load) {
      setError({ kind: "missing", message: "This day has not been built yet.", detail: "" });
      return;
    }
    // The hub covers its own way out by flying into the day's tile, so there is no fade to wait for after it.
    const fade = new Promise((resolve) => window.setTimeout(resolve, loaded && loaded.day ? 320 : 0));
    Promise.all([withRetries(load), fade])
      .then(([module]) => {
        if (cancelled) return;
        phase.current = "hold";
        loadId.current += 1;
        setLookPatch({});
        // Too slow at this tier before: a tier down from the start, so its shaders are the only ones built.
        const slow = day ? tooSlowAt(day.day) : null;
        const now = autoNow.current;
        const dayFloor = module.default.autoFloor ?? "low";
        if (slow && now.choice === "auto" && now.isWebGPU && TIER_RANK[slow] <= TIER_RANK[now.autoTier] && TIER_RANK[slow] > TIER_RANK[dayFloor]) {
          setAutoTier(slow === "high" ? "medium" : "low");
        }
        setLoaded({ id: loadId.current, day, definition: module.default });
        advance("scene");
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(explain(failure));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  // An error message has to be readable, so it takes the loader down with it. And it is counted, by kind. On the calendar
  // the plain page stays up, its way into 3D closed.
  const preface = usePreface();
  useEffect(() => setPrefaceFailed(!!error && !day), [error, day]);
  useEffect(() => {
    if (!error) return;
    advance("done");
    reportFailure(error);
  }, [error, advance]);

  // Full resolution again for a new day, or a tier chosen by hand. The hub itself, a page as much as a world, is drawn at the
  // screen's own density, up to 2, to be as sharp as a page; the same on the page and in the calendar, so that nothing
  // changes as one becomes the other.
  // And again when the screen's density changes, as it does when the browser is zoomed or the window moved to another
  // screen: the page as HTML (spaces/mirror.ts) is drawn at the new one, and the GPU's copy must be too.
  const maxDpr = definition?.maxDpr;
  const hub = !!loaded && !loaded.day;
  const [ratio, setRatio] = useState(() => globalThis.devicePixelRatio || 1);
  useEffect(() => {
    const changed = () => setRatio(globalThis.devicePixelRatio || 1);
    window.addEventListener("resize", changed);
    return () => window.removeEventListener("resize", changed);
  }, []);
  // Where memory is scarce (budget.ts), the hub too stops at 1.5: its full-screen passes then take half the memory.
  useEffect(() => setDpr(Math.min(hub ? Math.min(ratio, scarce() ? 1.5 : 2) : topDpr(), maxDpr ?? Infinity)), [choice, loaded?.id, maxDpr, hub, ratio]);

  useEffect(() => {
    if (!loaded) return;
    document.title = loaded.day ? `${String(loaded.day.day).padStart(2, "0")} ${loaded.day.word} | Codevember` : "Codevember | Adam Chernick";
  }, [loaded]);

  const shown = loaded && loaded.day && day && loaded.day.day === day.day;

  return (
    <div className="cv-stage">
      <Canvas
        className="cv-canvas"
        // three r185 folded the soft filter into PCF, which softens by each light's shadow.radius.
        shadows="percentage"
        dpr={dpr}
        frameloop={held ? "never" : "always"}
        // Well past any sky dome plus the furthest the camera can get from it, or zooming out cuts a black hole in the sky.
        camera={{ fov: 36, near: 0.05, far: 400 }}
        // One at a time: R3F asks again on every render until the renderer is ready, and each ask would start another GPU
        // device on the same canvas (or, with none to be had, fail and re-render again, without end). Once one is made it
        // asks no more, so the next ask, after a remount, makes a new one.
        gl={(props) =>
          (making.current ??= (async () => {
            let renderer = new THREE.WebGPURenderer({ ...(props as object), antialias: false, alpha: false });
            try {
              await renderer.init();
            } catch (failure) {
              // Phones can refuse WebGPU when short of memory. The WebGL backend often still gets through.
              console.error(failure);
              track("webgpu-refused");
              noteAdapter({ fellBack: true });
              renderer = new THREE.WebGPURenderer({ ...(props as object), antialias: false, alpha: false, forceWebGL: true });
              try {
                await renderer.init();
              } catch (again) {
                // No WebGL 2 either: nothing can be drawn, so say so rather than leave a black page.
                console.error(again);
                setError((shown) => shown ?? { ...NO_3D, detail: explain(again).detail });
                return new Promise<never>(() => {});
              }
            }
            // A phone's adapter, by its limits, keeps the hub light (budget.ts). Asked before the posters load, which is after this.
            const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<{ limits: { maxTextureDimension2D: number } } | null> } }).gpu;
            if (gpu && (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
              const adapter = await gpu.requestAdapter().catch(() => null);
              if (adapter) noteAdapter({ fellBack: false, maxTexture: adapter.limits.maxTextureDimension2D });
            }
            (renderer as unknown as { onDeviceLost: (info: { message: string }) => void }).onDeviceLost = (info) => {
              // Remembered for this tab, so that the next load, a reload or a day opened from the plain page, starts light.
              markLost();
              setError(lost(info.message));
            };
            const webgpu = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
            setIsWebGPU(webgpu);
            // How many visits draw with WebGL instead, for the admin portal beside the failures.
            if (!webgpu) track("renderer-webgl");
            making.current = null;
            return renderer as never;
          })())
        }
        onCreated={() => advance("scene")}
      >
        <QualityProvider value={{ tier, isWebGPU }}>
          <SettingsProvider value={settings}>
            <GrabProvider value={registry}>
              <LookContext.Provider value={applyLook}>
                <Post look={look} quality={tier} hasHaze={definition?.passes?.haze !== false} bounce={definition?.passes?.bounce !== false} halfBounce={definition?.passes?.halfBounce === true} overlay={definition?.passes?.overlay === true} veil={definition?.passes?.veil === true} depthOfField={definition?.passes?.depthOfField} sideBlur={definition?.passes?.sideBlur} chromatic={definition?.passes?.chromatic} rush={definition?.passes?.rush ?? definition?.explore === true} toneMapping={definition?.passes?.toneMapping} temporal={definition?.passes?.temporal} occlusion={definition?.passes?.occlusion} phase={phase} />
                <AdaptiveQuality
                  choice={choice}
                  floor={definition?.autoFloor}
                  tier={tier}
                  phase={phase}
                  onDowngrade={setAutoTier}
                  onFps={(fps) => {
                    if (fpsRef.current) fpsRef.current.textContent = `${Math.round(fps)} fps`;
                  }}
                />
                <LensShape />
                {definition && loaded ? (
                  <>
                    {loaded.day ? null : <CameraRig key="rig-hub" {...startingView(definition.camera)} sprintFov={definition.camera.sprintFov ?? 0} limits={definition.camera.limits} registry={registry} />}
                    {loaded.day ? (
                      <>
                    <CameraRig key={`rig-${loaded.day.day}`} {...startingView(definition.camera)} sprintFov={definition.camera.sprintFov ?? (definition.explore ? 0.2 : 0)} limits={definition.camera.limits} registry={registry} />
                    {definition.hover ?? definition.explore ? <Hover key={`hover-${loaded.day.day}`} /> : null}
                    {definition.extents ? <Extents key={`extents-${loaded.day.day}`} {...definition.extents} /> : null}
                    {shown ? <ReturnRig key={`return-${loaded.day.day}`} slug={daySlug(loaded.day)} definition={definition} /> : null}
                      </>
                    ) : null}
                    <SceneBoundary key={loaded.day?.day ?? 0} onError={setError}>
                      <Suspense fallback={null}>
                        <definition.Scene />
                        <SceneWarmup key={loaded.id} phase={phase} onCompiling={() => advance("shaders")} onReady={() => advance("done")} judge={judge} hold={setHeld} />
                      </Suspense>
                    </SceneBoundary>
                  </>
                ) : null}
              </LookContext.Provider>
            </GrabProvider>
          </SettingsProvider>
        </QualityProvider>
      </Canvas>

      {/* On the hub, a failure leaves the month as a plain page rather than an error screen. */}
      {error && !day ? (
        preface.up ? null : <HubFallback failure={error} />
      ) : error ? (
        <div className="cv-error" role="alert">
          <p>{error.message}</p>
          {error.detail ? <p className="cv-error-detail">{error.detail}</p> : null}
          <button type="button" className="cv-pill" onClick={() => window.location.reload()}>
            Reload
          </button>
          <a href={"/"}>All days</a>
        </div>
      ) : null}

      {day ? (
        <Hud
          day={day}
          hint={shown ? definition?.hint : undefined}
          prompt={shown ? definition?.prompt : undefined}
          notes={shown ? definition?.notes : undefined}
          overview={shown ? definition?.overview : undefined}
          Overlay={shown ? definition?.Overlay : undefined}
          settings={shown ? settings : null}
          phonePills={shown ? definition?.phonePills : undefined}
          phoneDock={shown ? definition?.phoneDock : undefined}
          phoneDockPills={shown ? definition?.phoneDockPills : undefined}
          tier={tier}
          choice={choice}
          onChoice={setChoice}
          isWebGPU={isWebGPU}
          fpsRef={fpsRef}
        />
      ) : loaded && !loaded.day ? (
        <SpaceHud />
      ) : null}
    </div>
  );
}
