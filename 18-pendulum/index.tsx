"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as THREE from "three/webgpu";
import { orbitPoint, useGrabbable } from "../shared/engine/controls";
import { dismissPrompt, resetPrompt } from "../shared/engine/prompt";
import { focusBlur, focusDistance } from "../shared/engine/Post";
import { scenePhase, useQuality } from "../shared/engine/quality";
import { useSetting, useSettingAction, useSettingsStore } from "../shared/engine/settings";
import { sound, useBed, useMusic } from "../shared/engine/sound";
import type { DayDefinition } from "../shared/engine/types";
import { followPrompt } from "../shared/ui/Follow";
import { shareResult } from "../shared/ui/Share";
import { Aim, Canvas, Turntable, canvasColours, canvasTurn } from "./canvas";
import { LANDINGS, createPaint } from "./paint";
import { FLOOR, Pendulum, VESSELS } from "./pendulum";
import { Rig } from "./rig";
import { prepareSave, savePainting } from "./save";
import { CAN_SPOTS, Cans, PAINTS } from "./studio";
import { Gallery } from "./studios";
import { WindowLight } from "./windowLight";
import { rgbToZuv } from "./zuv";
import { createOutletPaints } from "./brush-colors";

// How much paint has gone down this visit, for the follow card's moment.
const made = { seconds: 0, throws: 0, earned: false };

// Whether the swing has died down and the paint stopped, for the line that says so.
const done = {
  value: false,
  listeners: new Set<() => void>(),
  set(next: boolean) {
    if (next === this.value) return;
    this.value = next;
    this.listeners.forEach((l) => l());
  },
  subscribe(listener: () => void) {
    done.listeners.add(listener);
    return () => done.listeners.delete(listener);
  }
};

function Scene() {
  const { tier } = useQuality();
  // The grid is set by the tier the visit starts on: a later step down must not wipe the painting.
  const startTier = useRef(tier).current;
  const N = startTier === "high" ? 640 : startTier === "medium" ? 448 : 288;
  const paint = useMemo(() => createPaint(N), [N]);
  // The floor round it, coarser over its much larger square (about a centimetre a column on High).
  const spilt = useMemo(() => createPaint(Math.round(N * 0.75), FLOOR), [N]);
  // Swaying gently when the studio comes up, waiting to be thrown: nothing pours until the visitor gives it a toss.
  const pendulum = useMemo(() => {
    const p = new Pendulum();
    p.vessel = VESSELS.divided;
    p.rest();
    return p;
  }, []);
  const store = useSettingsStore();
  const paintColour = useSetting<string>("colour");
  const secondColour = useSetting<string>("colourB");
  const mixing = useSetting<string>("mixing");
  // A parcel keeps the color it left with, including after its bucket changes color.
  const colourCache = useRef(new Map<string, { linear: THREE.Color; zuv: THREE.Vector3 }>());
  const ground = useSetting<keyof typeof canvasColours>("canvas");
  const zVariation = useSetting<number>("zVariation");
  const outletPaints = useMemo(() => [createOutletPaints(paintColour, zVariation), createOutletPaints(secondColour, zVariation)], [paintColour, secondColour, zVariation]);
  const spinSpeed = useSetting<number>("spinSpeed");
  const turntable = useSetting<number>("turntable");
  const paused = useSetting<boolean>("paused");
  const canvasGroup = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((state) => state.scene);
  const rig = useRef<THREE.Group>(null);
  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __pendulum: pendulum, __paint: paint, __camera: camera, __store: store, __scene: scene });

  // For testing in development: put the eye somewhere from the console.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (globalThis as Record<string, unknown>).__view = (from: number[], to: number[]) => {
      camera.position.set(from[0], from[1], from[2]);
      orbitPoint.current?.set(to[0], to[1], to[2]);
      camera.lookAt(to[0], to[1], to[2]);
    };
  }, [camera]);

  // Every compute pass run once now, behind the loader, rather than first at the first toss.
  useEffect(() => {
    paint.warm(gl);
    spilt.warm(gl);
  }, [paint, spilt, gl]);
  // The save, once the whole studio is up and drawing behind the loader: its first press then costs no more than any.
  const savePrepared = useRef(false);

  // A new colour is a fresh can (the tinkle at most twice a second, as the colour pad is dragged).
  const lastColour = useRef({ colours: [paintColour, secondColour], at: 0 });
  useEffect(() => {
    const colours = [paintColour, secondColour];
    const changed = colours.some((colour, i) => lastColour.current.colours[i] !== colour);
    pendulum.colour = paintColour;
    pendulum.secondaryColour = secondColour;
    if (!changed) return;
    pendulum.level = 1;
    lastColour.current.colours = colours;
    const now = performance.now();
    if (now - lastColour.current.at < 500) return;
    lastColour.current.at = now;
    sound.play("tinkle", { gain: 0.5, pitch: 1.2 });
  }, [paintColour, secondColour, pendulum]);

  useSettingAction("start", () => {
    store.set("paused", false);
    pendulum.launch(0.30, 0, 0, 0.70);
    made.throws++;
    dismissPrompt();
    sound.play("whoosh", { gain: 0.5, pitch: 0.7 });
  });

  useSettingAction("fresh", () => {
    paint.u.wipe.value = 1;
    pendulum.level = 1;
    pendulum.rest();
    // A fresh canvas waits for its first toss again.
    resetPrompt();
    sound.play("rustle", { gain: 0.6, pitch: 0.8 });
  });
  useSettingAction("save", () => {
    sound.play("click", { gain: 0.5 });
    shareResult.set("Just made a pendulum painting with a swinging can of paint");
    if (saving.value.state === "busy") return;
    saving.set({ state: "busy", done: 0 });
    savePainting(gl, scene, rig.current ? [rig.current] : [], canvasGroup.current, (done) => saving.set({ state: "busy", done }))
      .then(() => {
        saving.set({ state: "saved", done: 1 });
        window.setTimeout(() => saving.value.state === "saved" && saving.set({ state: "idle", done: 0 }), 1800);
      })
      .catch(() => {
        saving.set({ state: "failed", done: 0 });
        window.setTimeout(() => saving.set({ state: "idle", done: 0 }), 2400);
      });
  });

  // Grab the hanging can to pull it back and throw it; press one of the open cans on the floor to paint with it.
  const picked = useRef<{ kind: "swing"; height: number; offset: THREE.Vector3 } | { kind: "can"; colour: string } | null>(null);
  const hit = useMemo(() => ({ centre: new THREE.Vector3(), point: new THREE.Vector3() }), []);
  useGrabbable({
    pick: (ray) => {
      // The hanging vessel: a sphere about its middle, as wide as it is when it hangs nearly still, growing the faster it
      // swings (to about twice that at a brisk swing) so a moving can is easy to catch; and round the bail and knot.
      const v = pendulum.vessel;
      const up = hit.centre.subVectors(pendulum.pivot, pendulum.end).normalize();
      hit.centre.copy(pendulum.end).addScaledVector(up, -(v.bail + v.height / 2));
      const moving = THREE.MathUtils.smoothstep(pendulum.speed, 0.2, 1.4);
      const grab = Math.max(0.13, v.top + 0.04) + moving * 0.12;
      const top = 0.05 + moving * 0.09;
      const near = ray.distanceSqToPoint(hit.centre) < grab * grab || ray.distanceSqToPoint(pendulum.end) < top * top;
      const swing = near ? ray.origin.distanceTo(hit.centre) : Infinity;
      let best: { d: number; colour: string } | null = null;
      CAN_SPOTS.forEach((spot, k) => {
        const centre = hit.point.copy(spot).setY(0.1);
        if (ray.distanceSqToPoint(centre) < 0.12 * 0.12) {
          const d = ray.origin.distanceTo(centre);
          if (!best || d < best.d) best = { d, colour: PAINTS[k].colour };
        }
      });
      const can = best as { d: number; colour: string } | null;
      if (swing === Infinity && !can) return null;
      if (can && can.d < swing) {
        picked.current = { kind: "can", colour: can.colour };
        return { distance: can.d, point: ray.at(can.d, new THREE.Vector3()) };
      }
      // Held on a level plane through its middle, by the spot taken hold of, so it stays under the hand.
      const height = hit.centre.y;
      const t = Math.abs(ray.direction.y) > 1e-4 ? (height - ray.origin.y) / ray.direction.y : swing;
      const onPlane = ray.at(t > 0 ? t : swing, new THREE.Vector3());
      picked.current = { kind: "swing", height, offset: hit.centre.clone().sub(onPlane).setY(0) };
      return { distance: swing, point: ray.at(swing, new THREE.Vector3()) };
    },
    grab: () => {
      const p = picked.current;
      if (!p) return;
      if (p.kind === "can") {
        store.set("colour", p.colour);
        return;
      }
      pendulum.grab();
      // The prompt has done its work once the can is in hand: it fades away.
      dismissPrompt();
      // Held, a thumb is over the hole anyway; taking hold also lifts a pause, so the next toss pours.
      if (store.get("paused")) store.set("paused", false);
      sound.play("creak", { gain: 0.45, pitch: 1.3 });
    },
    drag: (point) => {
      const p = picked.current;
      if (p?.kind !== "swing") return;
      // Cast from the eye through the pointer onto the level plane it was taken hold on, keep the spot under the hand,
      // and draw the can's middle there; the swing hangs it on the rope's sphere along that line from the pivot.
      const ray = aim.ray.set(camera.position, aim.dir.subVectors(point, camera.position).normalize());
      if (Math.abs(ray.direction.y) < 1e-3) return;
      const t = (p.height - ray.origin.y) / ray.direction.y;
      if (t <= 0 || t > 12) return;
      pendulum.hold(ray.at(t, aim.hit).add(p.offset));
    },
    release: () => {
      if (picked.current?.kind !== "swing") return;
      if (!pendulum.release()) return;
      made.throws++;
      sound.play("whoosh", { gain: 0.3 + Math.min(0.5, pendulum.speed * 0.25), pitch: 0.7 });
    }
  });

  // Sound: music, a soft breeze at the windows, and the paint: a thin pouring that follows the flow, and drops.
  useBed("breeze", 0.035);
  useMusic("/codevember/music/ceremony-interrupted.mp3", 0.21);
  const pour = useBed("river", 0);
  const sinceDrop = useRef(0);

  useFrame((_, raw) => {
    if (!savePrepared.current && scenePhase.current === "warm") {
      savePrepared.current = true;
      prepareSave(gl, scene);
    }
    const delta = Math.min(raw, 1 / 20);
    // Enamel thick enough to stand in a rounded ridge, and quick drying: a line goes tacky in a second or two and dry in a
    // few, so the next pass of the swing, or another colour, lies over it crisply instead of bleeding in. Drying is set
    // per second, shared over however many flow steps the tier runs.
    const flows = startTier === "low" ? 2 : 3;
    paint.u.yieldStep.value = 0.00038;
    paint.u.mobility.value = 0.155;
    paint.u.drying.value = DRYING / (60 * flows);
    // Spinning, from the middle of each slider: right turns it clockwise seen from above, left anticlockwise. The vessel
    // turns about the rope up to a little over a turn a second; the canvas on its turntable up to a turn in 2.5 seconds.
    // Eased to a new speed rather than jumping to it, so a reset spins down quickly but smoothly.
    const toward = 1 - Math.exp(-delta * 6);
    const spinTo = -spinSpeed * Math.PI * 2 * 1.2;
    pendulum.canvasSpin += (-turntable * Math.PI * 2 * 0.4 - pendulum.canvasSpin) * toward;
    pendulum.hole = 8.8e-6;
    pendulum.paused = paused;
    pendulum.colour = paintColour;
    pendulum.secondaryColour = secondColour;
    pendulum.outletPaints = outletPaints;
    pendulum.spin += (spinTo - pendulum.spin) * toward;
    pendulum.update(delta);
    paint.u.colouredLandings.value = 1;
    paint.u.mixing.value = mixing === "zuv" ? 1 : 0;
    spilt.u.yieldStep.value = paint.u.yieldStep.value;
    spilt.u.mobility.value = paint.u.mobility.value;
    spilt.u.drying.value = DRYING / (60 * (startTier === "low" ? 1 : 2));
    spilt.u.colouredLandings.value = 1;
    spilt.u.mixing.value = paint.u.mixing.value;

    // This frame's landings into the simulations: the canvas's, and the floor's for what missed it.
    let onCanvas = 0;
    let onFloor = 0;
    // Rare compressed arrival bursts flush a batch instead of dropping paint.
    for (const l of pendulum.landings) {
      const into = l.floor ? spilt : paint;
      let k = l.floor ? onFloor : onCanvas;
      if (k === LANDINGS) {
        into.u.count.value = k;
        into.step(gl, 0);
        if (l.floor) onFloor = 0; else onCanvas = 0;
        k = 0;
      }
      // The stream's radius as it lands: its paint spread over the length it falls in a step (about 1.2 cm at 3 m/s).
      const r = Math.sqrt(l.volume / (Math.PI * 0.012));
      (into.u.landings.array as THREE.Vector4[])[k].set(l.x, l.z, l.volume, r);
      (into.u.moving.array as THREE.Vector4[])[k].set(l.vx, l.vz, l.ax, l.az);
      if (l.paint) {
        // Brush variants are already real, gamut-safe paint colors. Retain their full-precision ZUV values.
        (into.u.colours.array as THREE.Vector3[])[k].fromArray(l.paint.linear);
        (into.u.zuvColours.array as THREE.Vector3[])[k].fromArray(l.paint.zuv);
      } else {
        let colour = colourCache.current.get(l.colour);
        if (!colour) {
          const hex = Number.parseInt(l.colour.slice(1), 16);
          const encoded: [number, number, number] = [(hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255];
          colour = { linear: new THREE.Color(l.colour), zuv: new THREE.Vector3().fromArray(rgbToZuv(encoded)) };
          // Continuous color-pad drags should not grow this cache for the lifetime of the scene.
          if (colourCache.current.size >= 256) colourCache.current.clear();
          colourCache.current.set(l.colour, colour);
        }
        (into.u.colours.array as THREE.Vector3[])[k].set(colour.linear.r, colour.linear.g, colour.linear.b);
        (into.u.zuvColours.array as THREE.Vector3[])[k].copy(colour.zuv);
      }
      if (l.floor) onFloor++;
      else onCanvas++;
    }
    paint.u.count.value = onCanvas;
    spilt.u.count.value = onFloor;
    if (canvasGroup.current) canvasGroup.current.rotation.y = pendulum.canvasTurn;
    canvasTurn.value = pendulum.canvasTurn;
    paint.step(gl, paint.u.wipe.value > 0 ? 1 : flows);
    paint.u.wipe.value = 0;
    spilt.step(gl, startTier === "low" ? 1 : 2);

    // Sound of the pour, and a drop now and then.
    const flowing = !pendulum.held && !pendulum.waiting && !pendulum.finished && !pendulum.paused && pendulum.level > 0 ? 1 : 0;
    done.set(pendulum.finished);
    if (store.get("pouring") !== (flowing === 1)) store.set("pouring", flowing === 1);
    pour.current?.level(flowing * (0.05 + Math.min(0.06, pendulum.speed * 0.03)), 0.2);
    sinceDrop.current += delta;
    if (flowing && sinceDrop.current > 0.35 + Math.random() * 0.6) {
      sinceDrop.current = 0;
      sound.play("drip", { gain: 0.08, pitch: 0.7 + Math.random() * 0.5 });
    }

    // The follow card's moment: a painting well under way.
    if (flowing) made.seconds += delta;
    if (!made.earned && made.seconds > 25 && made.throws > 0) {
      made.earned = true;
      followPrompt.earn("painting");
      shareResult.set("Just made a pendulum painting with a swinging can of paint");
    }

    // Focus on whatever the view turns about.
    const focus = Math.max(0.6, camera.position.distanceTo(orbitPoint.current ?? pendulum.end));
    focusDistance.value = focus;
    focusBlur.value = 1.4 * THREE.MathUtils.clamp(3 / focus, 0.6, 1.3);
  });

  return (
    <>
      <Suspense fallback={null}>
        <Gallery />
        <WindowLight dust={startTier === "high" ? 3200 : startTier === "medium" ? 2000 : 900} />
      </Suspense>
      <Turntable />
      <group ref={canvasGroup}>
        <Canvas paint={paint} ground={canvasColours[ground] ?? canvasColours.black} />
      </group>
      <Canvas paint={spilt} ground={canvasColours.black} floor />
      <Aim pendulum={pendulum} />
      <Cans />
      <group ref={rig}>
        <Rig pendulum={pendulum} paintColour={paintColour} secondColour={secondColour} />
      </group>
    </>
  );
}

// Saving the painting: whether it is under way, done or failed, and how far it has got, for the card that says so.
type Saving = { state: "idle" | "busy" | "saved" | "failed"; done: number };
const saving = {
  value: { state: "idle", done: 0 } as Saving,
  listeners: new Set<() => void>(),
  set(next: Saving) {
    this.value = next;
    this.listeners.forEach((l) => l());
  },
  subscribe(listener: () => void) {
    saving.listeners.add(listener);
    return () => saving.listeners.delete(listener);
  }
};

// A card in the middle while the painting is saved: a spinner, a bar filling as it goes, then a tick once it is in the
// downloads.
function SaveCard() {
  const { state, done } = useSyncExternalStore(saving.subscribe, () => saving.value, () => saving.value);
  const open = state !== "idle";
  const label = state === "saved" ? "Saved to your downloads" : state === "failed" ? "Could not save your painting" : "Saving your painting";
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        placeItems: "center",
        pointerEvents: open ? "auto" : "none",
        background: open ? "rgba(8, 9, 12, 0.35)" : "rgba(8, 9, 12, 0)",
        transition: "background 0.3s ease",
        zIndex: 40
      }}
    >
      <div
        style={{
          width: 280,
          padding: "22px 24px 20px",
          borderRadius: 18,
          background: "rgba(16, 16, 18, 0.72)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          boxShadow: "0 18px 50px rgba(0, 0, 0, 0.4)",
          color: "rgba(255, 255, 255, 0.9)",
          opacity: open ? 1 : 0,
          transform: `translateY(${open ? 0 : 10}px) scale(${open ? 1 : 0.98})`,
          transition: "opacity 0.3s ease, transform 0.3s ease",
          textAlign: "center"
        }}
      >
        <div style={{ height: 30, display: "grid", placeItems: "center", marginBottom: 12 }}>
          {state === "busy" ? <span className="cv-save-spinner" /> : <span style={{ fontSize: 22, lineHeight: 1 }}>{state === "saved" ? "✓" : "!"}</span>}
        </div>
        <div style={{ fontSize: 14, letterSpacing: 0.1, marginBottom: 14 }}>{label}</div>
        <div style={{ height: 4, borderRadius: 4, background: "rgba(255, 255, 255, 0.12)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.round(done * 100)}%`, background: "rgba(255, 255, 255, 0.85)", borderRadius: 4, transition: "width 0.2s ease" }} />
        </div>
        <style>{`.cv-save-spinner { width: 24px; height: 24px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.15); border-top-color: rgba(255,255,255,0.9); animation: cv-save-spin 0.8s linear infinite; } @keyframes cv-save-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

function Overlays() {
  return (
    <>
      <Finished />
      <SaveCard />
    </>
  );
}

// A quiet line once the swing has died down and the paint has stopped.
function Finished() {
  const finished = useSyncExternalStore(done.subscribe, () => done.value, () => false);
  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 104,
        transform: `translate(-50%, ${finished ? 0 : 8}px)`,
        opacity: finished ? 1 : 0,
        transition: "opacity 0.6s ease, transform 0.6s ease",
        pointerEvents: "none",
        padding: "8px 16px",
        borderRadius: 999,
        background: "rgba(16, 16, 18, 0.62)",
        backdropFilter: "blur(10px)",
        color: "rgba(255, 255, 255, 0.86)",
        fontSize: 13,
        letterSpacing: 0.1,
        whiteSpace: "nowrap"
      }}
    >
      Finished. Grab a bucket or start again.
    </div>
  );
}

// How much of its wetness paint at the reference thickness (1.5 mm) loses a second: dry in about four seconds, thin
// paint sooner and a pool later.
const DRYING = 0.13;

const aim = { ray: new THREE.Ray(), dir: new THREE.Vector3(), to: new THREE.Vector3(), hit: new THREE.Vector3() };

const pendulum: DayDefinition = {
  camera: {
    // Standing at the canvas's edge, looking down over it with the can swinging through the view.
    position: [-0.45, 1.45, -1.7],
    target: [0.05, 0.2, 0.2],
    fov: 44,
    // On a phone the eye and what it looks at are both a little lower, so the canvas rides up clear of the dock.
    phone: { position: [-0.55, 1.83, -2.35], target: [0.05, -0.07, 0.25], fov: 58 }
  },
  hover: true,
  // Black behind: the overlay pass (window light) is added over the whole frame on top of the background's colour.
  look: { background: "#000000", exposure: 0.95, bloom: 0.18, bloomThreshold: 0.92, gi: 0, ao: 0.75, aoRadius: 0.4, vignette: 0.22, grain: 0.02, haze: 0 },
  // A little air: a warm haze builds with distance, so the far room sits back behind the canvas.
  passes: { haze: false, bounce: false, overlay: true, depthOfField: { range: 2.5, air: 0.16, airRate: 0.06 } },
  settings: {
    start: { type: "action", label: "Start painting" },
    mixing: {
      type: "choice",
      label: "Color mixing",
      options: [
        { value: "rgb", label: "RGB" },
        { value: "zuv", label: "ZUV artistic" }
      ],
      value: "zuv"
    },
    zVariation: { type: "range", label: "Z variation", min: 0, max: 0.3, step: 0.01, value: 0.15, reset: 0.15 },
    colour: { type: "colour", label: "Color A", value: "#0000ff", presets: [{ label: "Blue", colour: "#0000ff" }, ...PAINTS.map((p) => ({ label: p.label, colour: p.colour }))] },
    colourB: { type: "colour", label: "Color B", value: "#ffff00", presets: [{ label: "Yellow", colour: "#ffff00" }, ...PAINTS.map((p) => ({ label: p.label, colour: p.colour }))] },
    canvas: {
      type: "choice",
      label: "Canvas",
      options: [
        { value: "black", label: "Black", swatch: [canvasColours.black] },
        { value: "white", label: "White", swatch: [canvasColours.white] },
        { value: "linen", label: "Linen", swatch: [canvasColours.linen] }
      ],
      value: "white"
    },
    spinSpeed: { type: "range", label: "Bucket spin speed", short: "Bucket spin", min: -1, max: 1, step: 0.01, value: 0, reset: 0 },
    turntable: { type: "range", label: "Canvas spin speed", short: "Canvas spin", min: -1, max: 1, step: 0.01, value: 0, reset: 0 },
    paused: { type: "toggle", label: "Pause paint", value: false, icon: "pause", showWhile: "pouring" },
    // Whether paint is running from the vessel now, for the phone's pause button to follow.
    pouring: { type: "toggle", label: "Pouring", value: false, hidden: true },
    fresh: { type: "action", label: "New canvas" },
    save: { type: "action", label: "Save painting" }
  },
  phonePills: ["start", "fresh", "save"],
  phoneDock: ["mixing", "zVariation", "colour", "colourB", "spinSpeed", "turntable"],
  phoneDockPills: ["paused"],
  prompt: { title: "Start painting", detail: "Use the controls, or grab the bucket and throw it", low: true },
  hint: "Choose the two compartment colors, then start painting or throw the bucket by hand. Compare RGB / ZUV on the same painting.",
  Overlay: Overlays,
  notes: "One partitioned bucket, two colors. Its neighboring outlets bring the wet paint together. Compare RGB and ZUV mixing on the same painting.",
  overview: [
    {
      title: "The swing",
      points: [
        "The can is a spherical pendulum stepped 240 times a second, its slowly turning, decaying ellipse drawing the spirograph.",
        "Grab and throw the can up to 55 degrees out; a dotted line previews the next six seconds by running the pendulum ahead.",
        "Two neighboring outlets pour the compartment colors together; the bucket and canvas can spin, and paint stops before it heaps."
      ]
    },
    {
      title: "The paint",
      points: [
        "Paint leaves the hole by Torricelli's law as free-falling parcels, drawn as a tube that thins and breaks into beads.",
        "A GPU thin film on up to 640 by 640 columns flows past its yield stress and dries in seconds, so later lines lie crisply over earlier ones.",
        "Paint that misses the canvas lands on a second, coarser film over five metres of concrete floor.",
        "Switch between linear RGB and artistic ZUV mixing on the same painting: both follow the same deposits, flow and drying."
      ]
    },
    {
      title: "Rendering",
      points: [
        "The canvas mesh is displaced straight from the sim, glossy while wet and satin when dry.",
        "A white loft with a cyclorama and softboxes; walls are built round real window openings, so the sun draws the bars on the floor.",
        "Save painting draws the canvas from overhead at 2048 pixels, its pipelines prebuilt and pixels converted between frames, so nothing stalls."
      ]
    }
  ],
  Scene
};

export default pendulum;
