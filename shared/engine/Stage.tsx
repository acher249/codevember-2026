"use client";

import { Canvas, extend, useFrame, useThree, type ThreeToJSXElements } from "@react-three/fiber";
import { Component, createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three/webgpu";
import { dayLoaders } from "../registry";
import { dayHref, days, type CodevemberDay } from "../days";
import { Hud } from "../ui/Hud";
import "./instancing";
import { LOAD_ORDER, type LoadStep } from "../ui/Loader";
import { CameraRig, GrabProvider, useGrabRegistry } from "./controls";
import { Post } from "./Post";
import { Extents } from "./extents";
import { withRetries } from "./retry";
import { AdaptiveQuality, DPR_STEPS, initialTier, QualityProvider, scenePhase, type QualityChoice } from "./quality";
import { SettingsProvider, useCreateSettings } from "./settings";
import { DEFAULT_LOOK, type DayDefinition, type Look, type QualityTier, type RenderPhase } from "./types";

declare module "@react-three/fiber" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

extend(THREE as never);

const LookContext = createContext<(patch: Partial<Look>) => void>(() => {});

// Lets a scene drive the shared stack from its own settings, e.g. a haze slider.
export function useLook(patch: Partial<Look>) {
  const set = useContext(LookContext);
  const key = JSON.stringify(patch);
  useEffect(() => {
    set(JSON.parse(key));
  }, [set, key]);
}

class SceneBoundary extends Component<{ onError: (message: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error(error);
    this.props.onError(error.message);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type LoadedDay = { id: number; day: CodevemberDay; definition: DayDefinition };

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

// Where the camera starts: a day's own view for phones, on a narrow screen, if it has one.
function startingView(camera: DayDefinition["camera"]) {
  const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;
  const view = narrow && camera.phone ? camera.phone : camera;
  return { position: view.position, target: view.target, fov: view.fov ?? camera.fov };
}

function SceneWarmup({ phase, onCompiling, onReady }: { phase: RefObject<RenderPhase>; onCompiling: () => void; onReady: () => void }) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const size = useThree((state) => state.size);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const run = useRef({ frames: 0, smooth: 0, gpuDone: false, gpuDoneAt: 0, finished: false, warmAt: 0 });
  const unhidden = useRef<THREE.Object3D[]>([]);
  const compiling = useRef({ pending: 0, lastNewAt: 0, release: () => {} });

  useEffect(() => {
    let cancelled = false;
    phase.current = "hold";
    onCompiling();
    const shaders = compiling.current;
    shaders.release = buildInBackground(gl, shaders);
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
          await Promise.race([gl.compileAsync(scene, camera), new Promise((resolve) => window.setTimeout(resolve, 15000))]);
        } catch (error) {
          // The first frame compiles whatever is left, as before.
          console.warn(error);
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
    if (overdue || state.smooth >= 4 || performance.now() - state.gpuDoneAt > 2500) {
      state.finished = true;
      shaders.release();
      phase.current = "live";
      onReady();
    }
  }, 2);

  return null;
}

// The renderer lives for the whole visit. Moving between days swaps the scene under a fade,
// so there is no new GPU device, canvas or page load between them.
export default function Stage({ day, onStep }: { day: CodevemberDay; onStep: (step: LoadStep) => void }) {
  const [loaded, setLoaded] = useState<LoadedDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<QualityChoice>("auto");
  const [autoTier, setAutoTier] = useState<QualityTier>(initialTier);
  const [isWebGPU, setIsWebGPU] = useState(true);
  const fpsRef = useRef<HTMLElement | null>(null);
  const phase = scenePhase;
  const loadId = useRef(0);
  const reached = useRef(0);
  const registry = useGrabRegistry();

  const definition = loaded?.definition;
  const start = definition?.autoStart;
  const tier = choice === "auto" ? (start && TIER_RANK[start] < TIER_RANK[autoTier] ? start : autoTier) : choice;
  const settings = useCreateSettings(definition?.settings);

  const [lookPatch, setLookPatch] = useState<Partial<Look>>({});
  const look = useMemo<Look>(() => ({ ...DEFAULT_LOOK, ...definition?.look, ...lookPatch }), [definition, lookPatch]);
  const applyLook = useMemo(() => (patch: Partial<Look>) => setLookPatch((current) => ({ ...current, ...patch })), []);

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
    if (loaded) advance("swap");
    const load = dayLoaders[`${String(day.day).padStart(2, "0")}-${day.word.toLowerCase()}`];
    if (!load) {
      setError("This day has not been built yet.");
      return;
    }
    const fade = new Promise((resolve) => window.setTimeout(resolve, loaded ? 320 : 0));
    Promise.all([withRetries(load), fade])
      .then(([module]) => {
        if (cancelled) return;
        phase.current = "hold";
        loadId.current += 1;
        setLookPatch({});
        setLoaded({ id: loadId.current, day, definition: module.default });
        advance("scene");
      })
      .catch((failure: Error) => {
        if (!cancelled) setError(failure.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  // An error message has to be readable, so it takes the loader down with it.
  useEffect(() => {
    if (error) advance("done");
  }, [error, advance]);

  useEffect(() => {
    if (!loaded) return;
    document.title = `${String(loaded.day.day).padStart(2, "0")} ${loaded.day.word} | Codevember`;
  }, [loaded]);

  return (
    <div className="cv-stage">
      <Canvas
        className="cv-canvas"
        // three r185 folded the soft filter into PCF, which softens by each light's shadow.radius.
        shadows="percentage"
        dpr={Math.min(DPR_STEPS[0], globalThis.devicePixelRatio || 1)}
        // Well past any sky dome plus the furthest the camera can get from it, or zooming out cuts a black hole in the sky.
        camera={{ fov: 36, near: 0.05, far: 400 }}
        gl={async (props) => {
          let renderer = new THREE.WebGPURenderer({ ...(props as object), antialias: false, alpha: false });
          try {
            await renderer.init();
          } catch (failure) {
            // Phones can refuse WebGPU when short of memory. The WebGL backend often still gets through.
            console.error(failure);
            renderer = new THREE.WebGPURenderer({ ...(props as object), antialias: false, alpha: false, forceWebGL: true });
            await renderer.init();
          }
          (renderer as unknown as { onDeviceLost: (info: { message: string }) => void }).onDeviceLost = (info) => {
            setError(`The GPU connection was lost (${info.message}). Reload to continue.`);
          };
          setIsWebGPU((renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true);
          return renderer as never;
        }}
        onCreated={() => advance("scene")}
      >
        <QualityProvider value={{ tier, isWebGPU }}>
          <SettingsProvider value={settings}>
            <GrabProvider value={registry}>
              <LookContext.Provider value={applyLook}>
                <Post look={look} quality={tier} hasHaze={definition?.passes?.haze !== false} bounce={definition?.passes?.bounce !== false} overlay={definition?.passes?.overlay === true} depthOfField={definition?.passes?.depthOfField} sideBlur={definition?.passes?.sideBlur} chromatic={definition?.passes?.chromatic} phase={phase} />
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
                {definition ? (
                  <>
                    <CameraRig key={`rig-${loaded.day.day}`} {...startingView(definition.camera)} limits={definition.camera.limits} registry={registry} />
                    {definition.extents ? <Extents key={`extents-${loaded.day.day}`} {...definition.extents} /> : null}
                    <SceneBoundary key={loaded.day.day} onError={setError}>
                      <Suspense fallback={null}>
                        <definition.Scene />
                        <SceneWarmup key={loaded.id} phase={phase} onCompiling={() => advance("shaders")} onReady={() => advance("done")} />
                      </Suspense>
                    </SceneBoundary>
                  </>
                ) : null}
              </LookContext.Provider>
            </GrabProvider>
          </SettingsProvider>
        </QualityProvider>
      </Canvas>

      {error ? (
        <div className="cv-error" role="alert">
          <p>{error}</p>
          <a href={dayHref(days[0]).replace(/[^/]+\/$/, "")}>All days</a>
        </div>
      ) : null}

      <Hud
        day={day}
        hint={loaded?.day.day === day.day ? definition?.hint : undefined}
        prompt={loaded?.day.day === day.day ? definition?.prompt : undefined}
        notes={loaded?.day.day === day.day ? definition?.notes : undefined}
        overview={loaded?.day.day === day.day ? definition?.overview : undefined}
        Overlay={loaded?.day.day === day.day ? definition?.Overlay : undefined}
        settings={loaded?.day.day === day.day ? settings : null}
        phonePills={loaded?.day.day === day.day ? definition?.phonePills : undefined}
        tier={tier}
        choice={choice}
        onChoice={setChoice}
        isWebGPU={isWebGPU}
        fpsRef={fpsRef}
      />
    </div>
  );
}
