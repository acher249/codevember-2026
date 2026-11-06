"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CodevemberDay } from "../days";

export const LOAD_ORDER = ["swap", "engine", "scene", "shaders", "done"] as const;
export type LoadStep = (typeof LOAD_ORDER)[number];

// Each step aims the bar at a point and eases towards it. Shader compiles block the main thread,
// so the bar moves as a CSS transform transition, which the compositor keeps running through them.
const STEPS: Record<LoadStep, { to: number; seconds: number; label: string }> = {
  swap: { to: 0, seconds: 0, label: "Loading" },
  engine: { to: 0.3, seconds: 6, label: "Starting the renderer" },
  scene: { to: 0.55, seconds: 5, label: "Loading the scene" },
  shaders: { to: 0.94, seconds: 14, label: "Compiling shaders" },
  done: { to: 1, seconds: 0.3, label: "Ready" }
};

export function Loader({ day, step }: { day: CodevemberDay; step: LoadStep }) {
  const [armed, setArmed] = useState(false);

  // One frame at zero first, otherwise the opening step has nothing to transition from.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const { to, seconds, label } = STEPS[step];

  return (
    <div className={`cv-loader ${step === "done" ? "cv-loader-done" : ""}`} aria-hidden={step === "done"}>
      <header className="cv-bar">
        <Link className="cv-mark" href="/" prefetch={false}>
          Codevember
        </Link>
      </header>
      <p className="cv-title-day">Day {String(day.day).padStart(2, "0")}</p>
      <p className="cv-loader-word">{day.word}</p>
      <div className="cv-loader-track" role="progressbar" aria-label={label}>
        <span style={{ transform: `scaleX(${armed ? to : 0})`, transitionDuration: `${seconds}s` }} />
      </div>
      <p className="cv-loader-label">
        <i className="cv-spinner" aria-hidden="true" />
        {label}
      </p>
    </div>
  );
}
