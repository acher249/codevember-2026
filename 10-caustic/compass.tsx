"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { sound } from "../shared/engine/sound";

// Where the sun stands around the table, in degrees: the bearing the light comes from, 0 being from the front, where the
// camera starts, and turning the way the compass dial is dragged.
let bearing = -128;
const listeners = new Set<() => void>();
export const lightBearing = {
  get: () => bearing,
  set(next: number) {
    bearing = ((((next + 180) % 360) + 360) % 360) - 180;
    listeners.forEach((listener) => listener());
  }
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const SIZE = 220;
const TICKS = Array.from({ length: 72 }, (_, i) => i * 5);

// A dial for the light. Drag anywhere on it round to bring the sun in from another side. The table is seen from above,
// the far side at the top, so the sun on the dial sits where it stands over the table. Its face is a ring of fine ticks,
// longer every 30 degrees, that turns with the sun like a knob, clicking as it goes, and a beam of light from the sun in
// to the middle.
export function Compass() {
  const value = useSyncExternalStore(subscribe, lightBearing.get, lightBearing.get);
  const dial = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, lastTick: 0, lastClick: 0 });

  useEffect(() => {
    const element = dial.current;
    if (!element) return;
    const aim = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      if (Math.hypot(dx, dy) < 6) return;
      // Screen right is the table's +x and screen down is its +z, toward the camera.
      const next = (Math.atan2(dx, dy) * 180) / Math.PI;
      // A click for every tick that passes, as on a ratchet, but no more than one every 30 ms however fast it spins.
      const step = Math.round(next / 5);
      const now = performance.now();
      if (step !== drag.current.lastTick && now - drag.current.lastClick > 30) {
        drag.current.lastTick = step;
        drag.current.lastClick = now;
        sound.play("click", { gain: 0.38, pitch: 0.9 + Math.random() * 0.25 });
      }
      lightBearing.set(next);
    };
    const down = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      drag.current.active = true;
      element.setPointerCapture(event.pointerId);
      aim(event);
    };
    const move = (event: PointerEvent) => {
      if (drag.current.active) aim(event);
    };
    const up = () => {
      drag.current.active = false;
    };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
    };
  }, []);

  const r = SIZE / 2;
  const angle = (value * Math.PI) / 180;
  const ring = r - 16;
  const sx = r + Math.sin(angle) * ring;
  const sy = r + Math.cos(angle) * ring;
  const shown = Math.round(((value % 360) + 360) % 360);

  return (
    <div className="cv-caustic-compass">
      <style>{`
        .cv-caustic-compass { position: absolute; right: 88px; bottom: 120px; display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; z-index: 5; }
        .cv-caustic-compass .dial { pointer-events: auto; touch-action: none; cursor: grab; width: ${SIZE}px; height: ${SIZE}px; border-radius: 50%;
          background: radial-gradient(circle at 50% 38%, rgba(60, 46, 36, 0.62), rgba(14, 11, 9, 0.78) 70%);
          box-shadow: inset 0 0 0 1px rgba(255, 226, 190, 0.14), inset 0 10px 24px rgba(255, 210, 160, 0.06), 0 10px 30px rgba(0, 0, 0, 0.45);
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
        .cv-caustic-compass .dial:active { cursor: grabbing; }
        .cv-caustic-compass .label { font: 500 11px/1 inherit; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(243, 233, 221, 0.62); }
        @media (max-width: 720px) {
          .cv-caustic-compass { right: 24px; bottom: 104px; gap: 4px; }
          .cv-caustic-compass .dial { width: 112px; height: 112px; }
          .cv-caustic-compass .label { font-size: 10px; }
        }
      `}</style>
      <div ref={dial} className="dial" role="slider" aria-label="Direction of the light" aria-valuemin={0} aria-valuemax={359} aria-valuenow={shown}>
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" height="100%">
          <defs>
            <radialGradient id="cv-sun-glow">
              <stop offset="0" stopColor="#fff3dc" stopOpacity="1" />
              <stop offset="0.35" stopColor="#ffc98a" stopOpacity="0.85" />
              <stop offset="1" stopColor="#ff9a4a" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="cv-beam" x1={sx} y1={sy} x2={r} y2={r} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffd6a3" stopOpacity="0.55" />
              <stop offset="1" stopColor="#ffd6a3" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g transform={`rotate(${-value} ${r} ${r})`}>
          {TICKS.map((t) => {
            const a = (t * Math.PI) / 180;
            const major = t % 30 === 0;
            const outer = r - 5;
            const inner = outer - (major ? 10 : 5);
            return (
              <line
                key={t}
                x1={r + Math.sin(a) * inner}
                y1={r - Math.cos(a) * inner}
                x2={r + Math.sin(a) * outer}
                y2={r - Math.cos(a) * outer}
                stroke={major ? "rgba(255, 226, 190, 0.6)" : "rgba(255, 226, 190, 0.22)"}
                strokeWidth={major ? 1.6 : 1}
                strokeLinecap="round"
              />
            );
          })}
          </g>
          {/* The light falls from the sun across the table, toward the middle. */}
          <line x1={sx} y1={sy} x2={r} y2={r} stroke="url(#cv-beam)" strokeWidth="9" strokeLinecap="round" />
          <circle cx={r} cy={r} r="3" fill="rgba(255, 226, 190, 0.7)" />
          <circle cx={sx} cy={sy} r="20" fill="url(#cv-sun-glow)" />
          <circle cx={sx} cy={sy} r="6.5" fill="#fff6e6" />
        </svg>
      </div>
      <div className="label">Light {shown}°</div>
    </div>
  );
}
