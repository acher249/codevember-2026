"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { PANEL, panels } from "./panels";

// Burrow on a touch screen: a thumb stick low on the left to walk, drag anywhere else to look, tap rock to dig, and a
// press held still on the rock for what a right click does (take back a ladder, or mount a torch there). The buttons
// (torch, ladder, camera, pack) are in backpack.tsx. Everything here is for a coarse pointer only.

export const TOUCH_QUERY = "(pointer: coarse)";
export const isTouch = () => typeof window !== "undefined" && window.matchMedia(TOUCH_QUERY).matches;

export function useTouch() {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(TOUCH_QUERY);
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => window.matchMedia(TOUCH_QUERY).matches,
    () => false
  );
}

// How far the stick is pushed: x to the right, y forward, each -1 to 1, nothing inside the dead middle.
export const stick = { x: 0, y: 0 };
// What the buttons ask of the scene, set by it (index.tsx): a torch where the view points, the carried ladder down where
// its ghost stands.
export const touchActions = { torch: () => {}, placeLadder: () => {} };

// A press held on the scene, filling a ring under the finger until it acts.
export const holding = {
  at: null as null | { x: number; y: number; since: number },
  listeners: new Set<() => void>(),
  set(at: null | { x: number; y: number }) {
    this.at = at ? { ...at, since: performance.now() } : null;
    for (const listener of this.listeners) listener();
  }
};
export const HOLD_MS = 600;

// The stick's travel (px from the middle to full push) and the dead middle (a share of it).
const TRAVEL = 42;
const DEAD = 0.18;

// The low edge for Burrow's touch controls: over the month's ruler and the music credit, and higher while the follow
// toast sits along the bottom.
const CSS = `
.cv-hud { --burrow-low: calc(max(10px, env(safe-area-inset-bottom)) + 84px); }
.cv-hud:has(.cv-follow) { --burrow-low: calc(max(10px, env(safe-area-inset-bottom)) + 148px); }
.burrow-stick { display: none; }
@media ${TOUCH_QUERY} {
  /* The stick takes the bottom left corner, where the title stands on other days. */
  .cv-hud:has(.burrow-stick) .cv-title { display: none; }
  .cv-canvas, .cv-canvas canvas { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
  .burrow-stick { display: block; position: fixed; left: max(18px, env(safe-area-inset-left)); bottom: var(--burrow-low); z-index: 30; width: 124px; height: 124px; border-radius: 50%; pointer-events: auto; border: 1px solid rgba(255,255,255,0.18); background: radial-gradient(circle, rgba(22,19,16,0.18), rgba(22,19,16,0.42)); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); touch-action: none; user-select: none; -webkit-user-select: none; transition: bottom 0.3s ease, opacity 0.2s ease; }
  .burrow-stick::before { content: ""; position: absolute; inset: -22px; border-radius: 50%; }
  .burrow-stick::after { content: ""; position: absolute; inset: 10px; border-radius: 50%; border: 1px dashed rgba(255,255,255,0.12); pointer-events: none; }
  .burrow-stick-knob { position: absolute; left: 50%; top: 50%; width: 54px; height: 54px; margin: -27px 0 0 -27px; border-radius: 50%; background: rgba(244,234,216,0.82); box-shadow: 0 4px 16px rgba(0,0,0,0.45); pointer-events: none; transition: transform 0.18s cubic-bezier(0.3, 1.4, 0.5, 1); }
  .burrow-stick.on .burrow-stick-knob { transition: none; background: #fff6e6; }
  .burrow-stick small { position: absolute; left: 0; right: 0; top: calc(100% + 6px); text-align: center; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(244,234,216,0.7); text-shadow: 0 1px 6px rgba(0,0,0,0.8); pointer-events: none; transition: opacity 0.4s ease; }
  .burrow-stick.used small { opacity: 0; }
  .burrow-hold { position: fixed; left: 0; top: 0; z-index: 31; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%; pointer-events: none; background: conic-gradient(rgba(255,214,150,0.9) calc(var(--burrow-hold, 0) * 360deg), rgba(255,255,255,0.12) 0); -webkit-mask: radial-gradient(circle, transparent 25px, #000 26px); mask: radial-gradient(circle, transparent 25px, #000 26px); animation: burrow-hold-fill ${HOLD_MS}ms linear forwards; }
  @property --burrow-hold { syntax: "<number>"; inherits: false; initial-value: 0; }
  @keyframes burrow-hold-fill { 0% { --burrow-hold: 0; opacity: 0; } 35% { opacity: 0; } 100% { --burrow-hold: 1; opacity: 1; } }
}
`;

// The thumb stick: press it and push the way to walk; let go and it springs back.
export function Stick() {
  const root = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let id = -1;
    const set = (x: number, y: number) => {
      const r = el.getBoundingClientRect();
      let dx = x - (r.left + r.width / 2);
      let dy = y - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy);
      if (d > TRAVEL) {
        dx *= TRAVEL / d;
        dy *= TRAVEL / d;
      }
      if (knob.current) knob.current.style.transform = `translate(${dx}px, ${dy}px)`;
      // Each axis with its own dead middle, so a push straight ahead walks straight (and on a ladder, a push sideways is
      // only sideways), then rescaled to reach 1 at full push.
      const axis = (v: number) => {
        const a = Math.abs(v) / TRAVEL;
        return a < DEAD ? 0 : Math.sign(v) * Math.min(1, (a - DEAD) / (1 - DEAD));
      };
      stick.x = axis(dx);
      stick.y = -axis(dy);
    };
    const release = () => {
      id = -1;
      stick.x = stick.y = 0;
      el.classList.remove("on");
      if (knob.current) knob.current.style.transform = "";
    };
    const down = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (id !== -1 || panels.modal > 0) return;
      id = event.pointerId;
      el.setPointerCapture(id);
      el.classList.add("on", "used");
      set(event.clientX, event.clientY);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId === id) set(event.clientX, event.clientY);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId === id) release();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("lostpointercapture", up);
    window.addEventListener("blur", release);
    return () => {
      release();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("lostpointercapture", up);
      window.removeEventListener("blur", release);
    };
  }, []);
  return (
    <>
      <style>{CSS}</style>
      <div ref={root} className="burrow-stick" {...{ [PANEL]: "" }} aria-hidden="true" onContextMenu={(event) => event.preventDefault()}>
        <div ref={knob} className="burrow-stick-knob" />
        <small>Walk</small>
      </div>
      <Hold />
    </>
  );
}

// The ring under a held finger.
function Hold() {
  const at = useSyncExternalStore(
    (listener) => {
      holding.listeners.add(listener);
      return () => holding.listeners.delete(listener);
    },
    () => holding.at,
    () => null
  );
  return at ? <div key={at.since} className="burrow-hold" style={{ translate: `${at.x}px ${at.y}px` }} /> : null;
}
