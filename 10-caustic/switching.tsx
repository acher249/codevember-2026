"use client";

import { useSyncExternalStore } from "react";

// Changing study builds a new set of glass and its light, and compiling those shaders holds up the page for a moment.
// While that happens a bar shows, so the pause reads as loading rather than a freeze.
let busy: string | null = null;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((listener) => listener());

export const switching = {
  start(label: string) {
    busy = label;
    tell();
  },
  done() {
    if (busy === null) return;
    busy = null;
    tell();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function SwitchingBar() {
  const label = useSyncExternalStore(subscribe, () => busy, () => null);
  return (
    <div
      aria-live="polite"
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        padding: "14px 18px 16px",
        minWidth: 200,
        borderRadius: 14,
        background: "rgba(20, 16, 13, 0.72)",
        backdropFilter: "blur(10px)",
        color: "#f3e9dd",
        font: "500 13px/1.3 inherit",
        letterSpacing: "0.02em",
        textAlign: "center",
        pointerEvents: "none",
        opacity: label ? 1 : 0,
        transition: "opacity 220ms ease"
      }}
    >
      <style>{"@keyframes cv-caustic-slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }"}</style>
      <div>Setting up {label ?? ""}</div>
      <div style={{ marginTop: 10, height: 3, borderRadius: 2, overflow: "hidden", background: "rgba(243, 233, 221, 0.16)" }}>
        <div style={{ width: "40%", height: "100%", borderRadius: 2, background: "#ffd6a3", animation: "cv-caustic-slide 1.1s ease-in-out infinite" }} />
      </div>
    </div>
  );
}
