"use client";

// The opening shot: the whole counter from high and well back, the plate low in the middle, the microwave behind it;
// a second after the loader has gone, the view eases in to the day's own starting view, close on the pocket. Only
// once a page load: a remount (a new tier, coming back to the day) starts where the view now is. Any touch of the
// controls (a drag, a scroll, a key) or a bite stops it at once and hands the view over; with reduced motion it cuts
// straight to the start. The "Take a bite" prompt waits until the view has settled.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three/webgpu";
import { cameraTaken, orbitPoint } from "../shared/engine/controls";
import { dismissPrompt, resetPrompt } from "../shared/engine/prompt";
import { scenePhase } from "../shared/engine/quality";

export const WIDE = { position: new THREE.Vector3(0.2, 1.7, 3.0), target: new THREE.Vector3(-0.14, 0.3, -0.6) };
// How long after the scene goes live the move starts (the loader's 0.32 s fade and a second's pause), and how long it
// takes.
const WAIT = 1.32;
const MOVE = 2.8;

let played = false;
// Set by the day when something (a bite) should end the move.
export const intro = { stop: () => {}, active: false };

export function Intro({ to }: { to: { position: [number, number, number]; target: [number, number, number] } }) {
  const camera = useThree((state) => state.camera);
  const dom = useThree((state) => state.gl.domElement);
  const run = useRef({ on: false, live: -1, from: new THREE.Vector3(), aim: new THREE.Vector3() });
  const end = useRef({ position: new THREE.Vector3(...to.position), target: new THREE.Vector3(...to.target) });

  useEffect(() => {
    const state = run.current;
    // Once a page load (marked when the move begins, so React's dev double mount doesn't use it up).
    if (played) return;
    state.on = true;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      state.on = false;
      return;
    }
    // The day's starting view, as the rig has just set it (the phone's own on a phone).
    end.current.position.copy(camera.position);
    if (orbitPoint.current) end.current.target.copy(orbitPoint.current);
    cameraTaken.current = true;
    intro.active = true;
    dismissPrompt();
    const stop = () => {
      if (!state.on) return;
      state.on = false;
      intro.active = false;
      // Hand over from wherever the view is now, aimed where it was looking.
      orbitPoint.current?.copy(state.aim);
      cameraTaken.current = false;
      resetPrompt();
    };
    intro.stop = stop;
    const keys = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) stop();
    };
    dom.addEventListener("pointerdown", stop);
    dom.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("keydown", keys);
    return () => {
      dom.removeEventListener("pointerdown", stop);
      dom.removeEventListener("wheel", stop);
      window.removeEventListener("keydown", keys);
      intro.stop = () => {};
      if (state.on) {
        state.on = false;
        intro.active = false;
        cameraTaken.current = false;
      }
    };
  }, [dom, camera]);

  useFrame((frame) => {
    const state = run.current;
    if (!state.on) return;
    const now = frame.clock.elapsedTime;
    if (scenePhase.current !== "live" || state.live < 0) {
      if (scenePhase.current === "live") {
        state.live = now;
        played = true;
      }
      state.from.copy(WIDE.position);
      state.aim.copy(WIDE.target);
    } else {
      // Smootherstep: starts and settles gently, never past the end.
      const x = Math.min(1, Math.max(0, (now - state.live - WAIT) / MOVE));
      const k = x * x * x * (x * (x * 6 - 15) + 10);
      state.from.lerpVectors(WIDE.position, end.current.position, k);
      state.aim.lerpVectors(WIDE.target, end.current.target, k);
      if (x >= 1) {
        camera.position.copy(end.current.position);
        camera.lookAt(end.current.target);
        orbitPoint.current?.copy(end.current.target);
        state.on = false;
        intro.active = false;
        cameraTaken.current = false;
        resetPrompt();
        return;
      }
    }
    camera.position.copy(state.from);
    camera.lookAt(state.aim);
    orbitPoint.current?.copy(state.aim);
  }, -5);

  return null;
}
