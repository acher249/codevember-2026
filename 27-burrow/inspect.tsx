"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import * as THREE from "three/webgpu";
import { sound } from "../shared/engine/sound";
import { ABOUT, ITEMS, pack, studio, studioTarget, toImage, type ItemKind, type Rarity } from "./collectibles";
import { PANEL, panels } from "./panels";
import { isTouch } from "./touch";

// A find, held up to look at: a modal over the dimmed scene with the find alone in it, a finer model than the world's,
// turned by dragging and zoomed by the wheel or a pinch. It is drawn by the scene's own renderer into a target in the
// studio (see `makeStudio` in collectibles.tsx, with every piece of renderer state put back), read back and painted on
// a canvas here, one frame in flight at a time. The game takes no input while it is open.

export const inspect = {
  kind: null as ItemKind | null,
  listeners: new Set<() => void>(),
  version: 0,
  open(kind: ItemKind) {
    this.kind = kind;
    lift();
    this.changed();
  },
  close() {
    this.kind = null;
    this.changed();
  },
  changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
};

// Taking it out to look at: a soft knock and a little rising chime.
function lift() {
  sound.custom((context, out, at) => {
    for (const [delay, freq, gain] of [
      [0, 520, 0.05],
      [0.06, 780, 0.035]
    ]) {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const level = context.createGain();
      level.gain.setValueAtTime(0.0001, at + delay);
      level.gain.exponentialRampToValueAtTime(gain, at + delay + 0.008);
      level.gain.exponentialRampToValueAtTime(0.0001, at + delay + 0.35);
      osc.connect(level).connect(out);
      osc.start(at + delay);
      osc.stop(at + delay + 0.4);
    }
  });
}

function useInspect() {
  return useSyncExternalStore(
    (listener) => {
      inspect.listeners.add(listener);
      return () => inspect.listeners.delete(listener);
    },
    () => inspect.kind,
    () => null
  );
}

export function Inspect({ colours }: { colours: Record<Rarity, string> }) {
  const kind = useInspect();
  return kind ? <InspectView key={kind} kind={kind} colour={colours[ITEMS[kind].rarity]} /> : null;
}

// Opens well back (owner: the find filled the view, 27 Nov); the wheel brings it in close.
const OPEN_ZOOM = 1.75;
const ZOOM = { min: 0.45, max: 3.2 };

function InspectView({ kind, colour }: { kind: ItemKind; colour: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const item = ITEMS[kind];
  const count = pack.counts[kind] ?? 0;

  // Modal: Esc closes it, and no key reaches the game while it is open.
  useEffect(() => {
    panels.open();
    const key = (event: KeyboardEvent) => {
      if (event.type !== "keydown") return;
      event.stopPropagation();
      if (event.code === "Escape") inspect.close();
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      panels.close();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    // The turn (yaw, pitch), its coast after a drag, the zoom, and how long since the last touch (it turns slowly by
    // itself after a moment).
    const view = { yaw: 0, pitch: 0, zoom: OPEN_ZOOM, spinYaw: 0, spinPitch: 0, idle: 0, dragging: false };
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    let busy = false;
    let alive = true;
    let frame = 0;
    let last = performance.now();
    let target: THREE.RenderTarget | null = null;
    let image: ImageData | null = null;
    let shown = false;

    // Drawn at about 1.25 times the screen's pixels (the browser scales it down, smoothing the facets' edges), in
    // steps of 64 so each row reads back whole.
    const side = () => {
      const css = canvas.clientWidth || 480;
      return THREE.MathUtils.clamp(Math.round((css * Math.min(2, window.devicePixelRatio || 1) * 1.25) / 64) * 64, 256, 1024);
    };
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!view.dragging) {
        view.yaw += view.spinYaw * dt;
        view.pitch = THREE.MathUtils.clamp(view.pitch + view.spinPitch * dt, -1.35, 1.35);
        const fade = Math.exp(-dt * 3);
        view.spinYaw *= fade;
        view.spinPitch *= fade;
        view.idle += dt;
        if (view.idle > 2.5) view.yaw += dt * 0.35 * Math.min(1, (view.idle - 2.5) / 1.5);
      }
      const made = studio.current;
      if (!made || busy) return;
      const s = side();
      if (!target || target.width !== s) {
        target?.dispose();
        target = studioTarget(s, s);
        canvas.width = canvas.height = s;
        image = context.createImageData(s, s);
      }
      const drawn = target;
      const into = image as ImageData;
      made.draw(kind, made.shape(kind), drawn, view.yaw, view.pitch, view.zoom);
      busy = true;
      made.renderer
        .readRenderTargetPixelsAsync(drawn, 0, 0, s, s)
        .then((pixels) => {
          busy = false;
          if (!alive || drawn !== target) return;
          toImage(pixels as Uint16Array, into);
          context.putImageData(into, 0, 0);
          if (!shown) {
            shown = true;
            setReady(true);
          }
        })
        .catch((error) => {
          busy = false;
          console.warn("burrow inspect", error);
        });
    };
    frame = requestAnimationFrame(tick);

    const down = (event: PointerEvent) => {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      view.dragging = true;
      view.idle = 0;
      view.spinYaw = view.spinPitch = 0;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const move = (event: PointerEvent) => {
      const p = pointers.get(event.pointerId);
      if (!p) return;
      const dx = event.clientX - p.x;
      const dy = event.clientY - p.y;
      p.x = event.clientX;
      p.y = event.clientY;
      view.idle = 0;
      if (pointers.size === 1) {
        // Drag right and it turns right; drag down and its top comes toward you.
        view.yaw -= dx * 0.009;
        view.pitch = THREE.MathUtils.clamp(view.pitch + dy * 0.009, -1.35, 1.35);
        view.spinYaw = -dx * 0.55;
        view.spinPitch = dy * 0.55;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const apart = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && apart > 0) view.zoom = THREE.MathUtils.clamp((view.zoom * pinch) / apart, ZOOM.min, ZOOM.max);
        pinch = apart;
      }
    };
    const up = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (!pointers.size) view.dragging = false;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      view.idle = 0;
      view.zoom = THREE.MathUtils.clamp(view.zoom * Math.exp(event.deltaY * 0.0012), ZOOM.min, ZOOM.max);
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
      // Not while a read of it may still be in flight.
      const done = target;
      if (done) window.setTimeout(() => done.dispose(), 300);
    };
  }, [kind]);

  const stop = (event: SyntheticEvent) => event.stopPropagation();
  // Closed by a click on the dimmed backdrop, only one that also began there (not the end of a drag).
  const backdrop = useRef(false);
  return (
    <div
      {...{ [PANEL]: "" }}
      className="burrow-modal"
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      onPointerDown={(event) => {
        stop(event);
        backdrop.current = event.target === event.currentTarget;
      }}
      onPointerUp={stop}
      onClick={(event) => {
        if (backdrop.current && event.target === event.currentTarget) inspect.close();
      }}
    >
      <div className="burrow-modal-card burrow-inspect-card" onClick={stop} style={{ ["--rarity" as string]: colour }}>
        <button type="button" className="burrow-modal-close" onClick={() => inspect.close()} aria-label="Close">
          ✕
        </button>
        <div className="burrow-inspect-stage">
          {!ready && pack.icons[kind] ? (
            // eslint-disable-next-line @next/next/no-img-element -- painted at runtime, not a static asset.
            <img className="burrow-inspect-still" src={pack.icons[kind]} alt="" />
          ) : null}
          <canvas ref={canvasRef} className="burrow-inspect-canvas" style={{ opacity: ready ? 1 : 0 }} />
        </div>
        <div className="burrow-inspect-text">
          <em style={{ color: colour }}>{item.rarity}</em>
          <h3>{item.name}</h3>
          <p>{ABOUT[kind]}</p>
          <small>
            {count > 1 ? `${count} in your pack · ` : ""}
            {isTouch() ? "Drag to turn · pinch to zoom" : "Drag to turn · scroll or pinch to zoom · Esc to close"}
          </small>
        </div>
      </div>
    </div>
  );
}
