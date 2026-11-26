"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { sound } from "../../shared/engine/sound";

// A tiny soft tap on glass whenever a finger or the mouse goes down on the scene, to click or to drag it round, a little
// softer or louder each time.
const TAP = "/assets/25-veil/glass-tap.mp3";

export function Tap() {
  const canvas = useThree((state) => state.gl.domElement);
  useEffect(() => {
    sound.preload(TAP);
    // One tap per touch: a pinch's second finger, or fingers landing together, is not another; and a little softer from
    // a finger, which touches far more often than a mouse clicks.
    let last = 0;
    const down = (event: PointerEvent) => {
      const touch = event.pointerType === "touch";
      if (touch) {
        const now = performance.now();
        if (now - last < 250) return;
        last = now;
      }
      sound.sample(TAP, (touch ? 0.7 : 1) * (0.45 + Math.random() * 0.25));
    };
    canvas.addEventListener("pointerdown", down);
    return () => canvas.removeEventListener("pointerdown", down);
  }, [canvas]);
  return null;
}
