"use client";

import { Canvas, extend, useFrame, useThree, type ThreeToJSXElements } from "@react-three/fiber";
import { Component, createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three/webgpu";
import { dayLoaders } from "../registry";
import { dayHref, days, type CodevemberDay } from "../days";
import { Hud } from "../ui/Hud";
import { LOAD_ORDER, type LoadStep } from "../ui/Loader";
import { CameraRig, GrabProvider, useGrabRegistry } from "./controls";
import { Post } from "./Post";
import { Extents } from "./extents";
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

function SceneWarmup({ phase, onCompiling, onReady }: { phase: RefObject<RenderPhase>; onCompiling: () => void; onReady: () => void }) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const size = useThree((state) => state.size);
  const scene = useThree((state) => state.scene);
  const run = useRef({ frames: 0, smooth: 0, gpuDone: false, gpuDoneAt: 0, finished: false });
  const unhidden = useRef<THREE.Object3D[]>([]);

  useEffect(() => {
    phase.current = "hold";
    onCompiling();
    // Compiling blocks the main thread, so let the loader paint its new step before starting.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        // The backend caches the canvas depth buffer, and on some loads it holds one from before the
        // canvas had its real size, which invalidates every frame. Setting the size clears that cache.
        gl.setSize(size.width, size.height, false);
        phase.current = "warm";
      });
    });
    return () => cancelAnimationFrame(frame);
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
      const markDone = () => {
        state.gpuDone = true;
        state.gpuDoneAt = performance.now();
      };
      const device = (gl.backend as unknown as { device?: { queue: { onSubmittedWorkDone: () => Promise<void> } } }).device;
      if (device) device.queue.onSubmittedWorkDone().then(markDone, markDone);
      else markDone();
      return;
    }
    if (!state.gpuDone) return;
    state.smooth = delta < 1 / 12 ? state.smooth + 1 : 0;
    // A slow machine may never run smoothly. Don't keep it waiting for that.
    if (state.smooth >= 4 || performance.now() - state.gpuDoneAt > 2500) {
      state.finished = true;
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
    Promise.all([load(), fade])
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
        shadows="soft"
        dpr={Math.min(DPR_STEPS[0], globalThis.devicePixelRatio || 1)}
        camera={{ fov: 36, near: 0.05, far: 120 }}
        gl={async (props) => {
          const renderer = new THREE.WebGPURenderer({ ...(props as object), antialias: false, alpha: false });
          await renderer.init();
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
                <Post look={look} quality={tier} hasHaze={definition?.passes?.haze !== false} bounce={definition?.passes?.bounce !== false} overlay={definition?.passes?.overlay === true} depthOfField={definition?.passes?.depthOfField} phase={phase} />
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
                    <CameraRig key={`rig-${loaded.day.day}`} position={definition.camera.position} target={definition.camera.target} fov={definition.camera.fov} registry={registry} />
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
        settings={loaded?.day.day === day.day ? settings : null}
        tier={tier}
        choice={choice}
        onChoice={setChoice}
        isWebGPU={isWebGPU}
        fpsRef={fpsRef}
      />
    </div>
  );
}
