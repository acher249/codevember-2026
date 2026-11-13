"use client";

import { useFrame } from "@react-three/fiber";
import { createContext, useContext, useRef, type RefObject } from "react";
import type { QualityTier, RenderPhase } from "./types";

export type QualityChoice = "auto" | QualityTier;

type QualityState = {
  tier: QualityTier;
  // Low tier here means the WebGL2 fallback or a phone. Scenes scale particle counts on it.
  isWebGPU: boolean;
};

// Where the current scene is in its load. Only one scene runs at a time.
export const scenePhase: { current: RenderPhase } = { current: "hold" };

const QualityContext = createContext<QualityState>({ tier: "medium", isWebGPU: true });
export const QualityProvider = QualityContext.Provider;
export const useQuality = () => useContext(QualityContext);

export const initialTier = (): QualityTier => {
  if (typeof window === "undefined") return "medium";
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  if (coarse && small) return "low";
  if (coarse) return "medium";
  return "high";
};

const LADDER: QualityTier[] = ["low", "medium", "high"];
export const DPR_STEPS = [1.5, 1.25, 1];
export const topDpr = () => Math.min(DPR_STEPS[0], globalThis.devicePixelRatio || 1);

// Until when, by the page's clock, the frame rate is not to be judged: a scene sets it over moments it knows are heavy
// and pass, such as a world being built up or bent into another shape.
const heldUntil = { at: 0 };
export const holdQuality = (ms: number) => {
  heldUntil.at = Math.max(heldUntil.at, performance.now() + ms);
};

// Holds the frame rate on Auto by stepping the tier down, which recompiles the post stack and so only ever goes one
// way. It restarts the temporal passes, which shows, so the rate is judged over two seconds at a time and has to be low
// twice running before anything changes. The resolution is left alone: lowered, it shows on every day as a blur.
export function AdaptiveQuality({
  choice,
  tier,
  phase,
  onDowngrade,
  onFps,
  floor = "low"
}: {
  choice: QualityChoice;
  tier: QualityTier;
  phase: RefObject<RenderPhase>;
  onDowngrade: (tier: QualityTier) => void;
  onFps: (fps: number) => void;
  floor?: QualityTier;
}) {
  const sample = useRef({ time: 0, frames: 0, shown: 0, shownFrames: 0, low: 0, settle: 1 });

  useFrame((_, delta) => {
    const meter = sample.current;
    // Shader compiles stall a scene's first frames. Start judging once it is on show.
    if (phase.current !== "live") {
      meter.time = meter.frames = meter.low = 0;
      meter.settle = 1;
      return;
    }
    meter.time += delta;
    meter.frames += 1;
    meter.shown += delta;
    meter.shownFrames += 1;
    if (meter.shown >= 1) {
      onFps(meter.shownFrames / meter.shown);
      meter.shown = meter.shownFrames = 0;
    }
    if (performance.now() < heldUntil.at) {
      meter.time = meter.frames = meter.low = 0;
      return;
    }
    if (meter.time < 2) return;

    const fps = meter.frames / meter.time;
    meter.time = meter.frames = 0;
    if (meter.settle > 0) {
      meter.settle -= 1;
      return;
    }
    meter.low = choice === "auto" && fps < 42 ? meter.low + 1 : 0;
    if (meter.low < 2) return;
    meter.low = 0;

    const rung = LADDER.indexOf(tier);
    if (rung > LADDER.indexOf(floor)) {
      onDowngrade(LADDER[rung - 1]);
      meter.settle = 2;
    }
  });

  return null;
}

// A phone-sized screen: the same test Stage uses for a phone's framing.
export const narrowScreen = () => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;
