import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { screenSize, screenUV, uniform, vec2 } from "three/tsl";
import { useSettingRef } from "../shared/engine/settings";
import { sound, useBed } from "../shared/engine/sound";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

type BedKind = Parameters<typeof useBed>[0];

// A speed slider at 33 is the pace everything was tuned at.
export const SPEED_UNIT = 0.03;

// What a pure shader gets from the outside world: a clock, the pointer and how hard it is moving. Everything else is maths on the GPU.
// Moving through the shader also moves the ambient sound.
export function usePulse(kind: BedKind, level: number, speedKey: string) {
  const speed = useSettingRef<number>(speedKey);
  const inputs = useMemo(() => ({ time: uniform(0) as any, pointer: uniform(new THREE.Vector2()) as any, stir: uniform(0) as any }), []);
  const aim = useRef({ x: 0, y: 0, moved: 0, quiet: 0 });
  const bed = useBed(kind, level);

  useEffect(() => {
    // Only a drag that starts on the scene plays with the shape, and only the first finger of a pinch.
    let dragging: number | null = null;
    let lastX = 0;
    let lastY = 0;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== dragging) return;
      const aspect = window.innerWidth / window.innerHeight;
      const x = ((event.clientX - lastX) / window.innerWidth) * 2;
      const y = -((event.clientY - lastY) / window.innerHeight) * 2;
      lastX = event.clientX;
      lastY = event.clientY;
      aim.current.moved += Math.hypot(x, y);
      aim.current.x = Math.max(-aspect, Math.min(aspect, aim.current.x + x * aspect));
      aim.current.y = Math.max(-1, Math.min(1, aim.current.y + y));
    };
    const press = (event: PointerEvent) => {
      if (dragging !== null || !(event.target instanceof HTMLCanvasElement)) return;
      dragging = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      sound.play("click", { gain: 0.3, pitch: 0.6 + Math.random() * 0.4 });
    };
    const lift = (event: PointerEvent) => {
      if (event.pointerId === dragging) dragging = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerdown", press);
    window.addEventListener("pointerup", lift);
    window.addEventListener("pointercancel", lift);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", lift);
      window.removeEventListener("pointercancel", lift);
    };
  }, []);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    const state = aim.current;
    inputs.time.value += delta * speed.current * SPEED_UNIT;
    const ease = 1 - Math.exp(-delta * 7);
    inputs.pointer.value.x += (state.x - inputs.pointer.value.x) * ease;
    inputs.pointer.value.y += (state.y - inputs.pointer.value.y) * ease;
    const target = Math.min(1, state.moved * 9);
    state.moved = 0;
    inputs.stir.value += (target - inputs.stir.value) * (target > inputs.stir.value ? 0.3 : 1 - Math.exp(-delta * 1.6));
    bed.current?.level(level * (1 + inputs.stir.value * 1.4));
    bed.current?.tone(0.75 + inputs.stir.value * 0.6);
    state.quiet = Math.max(0, state.quiet - delta);
    if (inputs.stir.value > 0.75 && state.quiet === 0) {
      state.quiet = 1.4;
      sound.play("whoosh", { gain: 0.22, pitch: 0.7 + Math.random() * 0.5 });
    }
  });

  return inputs;
}

// The pixel's place on screen: y up, height running from -1 to 1, and square whatever the screen's shape.
export const screenPoint = () => vec2((screenUV as any).x.sub(0.5).mul(2).mul((screenSize as any).x.div((screenSize as any).y)), (screenUV as any).y.oneMinus().sub(0.5).mul(2));
