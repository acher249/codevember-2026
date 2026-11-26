"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { orbitPoint, useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting } from "../../shared/engine/settings";
import { sound, useBed } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { createCloth, type Cloth } from "./cloth";
import { Backdrop, Face, Hood, Lights, Veil } from "./figure";
import { breath } from "./sound";

// Veil: a figure in a deep black hood, close, in the dark. Inside the hood is only shadow; whoever is there cannot be
// seen, only the veil lying over a shape. The candle below reaches no higher than the hem. A sheer black veil hangs across the opening; it moves when she breathes. Take
// hold of it and lift it, draw it aside; let go and it falls back.

// Her breath: one in this many seconds, and the share of it spent breathing out.
const BREATH = 5.4;
const OUT = 0.38;

// Run the cloth on by one frame, in substeps.
function step(gl: THREE.WebGPURenderer, cloth: Cloth, delta: number, substeps: number, pairs: number, time: number) {
  cloth.u.dt.value = delta / substeps;
  for (let k = 1; k <= substeps; k++) {
    cloth.u.time.value = time - (delta * (substeps - k)) / substeps;
    const passes: unknown[] = [cloth.integrate];
    for (let n = 0; n < pairs; n++) passes.push(cloth.forth, cloth.back);
    gl.compute(passes as any);
  }
}

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const cloth = useMemo(() => (startTier === "low" ? createCloth(32, 40) : createCloth(44, 56)), [startTier]);
  const substeps = 3;
  const pairs = startTier === "low" ? 5 : 8;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  const draught = useSetting<number>("draught");

  const st = useRef({
    seconds: 0,
    data: null as Float32Array | null,
    reading: false,
    readAt: 0,
    picked: -1,
    holding: false,
    lastBreath: -1,
    lifted: 0,
    earned: false,
    settled: false
  });

  // Settled before it is seen: a few seconds of hanging under its own weight, against her face and the cloak.
  useEffect(() => {
    gl.compute(cloth.reset as any);
    for (let n = 0; n < 240; n++) step(gl, cloth, 1 / 60, 3, pairs, n / 60);
    st.current.settled = true;
  }, [gl, cloth, pairs]);

  useGrabbable({
    pick(ray) {
      const s = st.current;
      s.picked = -1;
      const data = s.data;
      if (!data) return null;
      let best = Infinity;
      const o = ray.origin;
      const d = ray.direction;
      for (let k = cloth.COLS; k < cloth.N; k++) {
        const x = data[k * 4] - o.x;
        const y = data[k * 4 + 1] - o.y;
        const z = data[k * 4 + 2] - o.z;
        const t = x * d.x + y * d.y + z * d.z;
        if (t <= 0 || t >= best) continue;
        const off = x * x + y * y + z * z - t * t;
        const r = Math.max(0.008, t * 0.012);
        if (off < r * r) {
          best = t;
          s.picked = k;
        }
      }
      return s.picked >= 0 ? { distance: best, point: ray.at(best, new THREE.Vector3()) } : null;
    },
    grab(point) {
      const s = st.current;
      if (s.picked < 0) return;
      dismissPrompt();
      const u = cloth.u;
      u.gi.value = s.picked % cloth.COLS;
      u.gj.value = Math.floor(s.picked / cloth.COLS);
      u.target.value.copy(point);
      gl.compute(cloth.takeHold as any);
      u.holding.value = 1;
      s.holding = true;
      sound.play("peel", { variant: "silk", gain: 0.35, pitch: 0.8 + Math.random() * 0.15 });
    },
    drag(point) {
      cloth.u.target.value.copy(point);
    },
    release(velocity) {
      const s = st.current;
      cloth.u.holding.value = 0;
      s.holding = false;
      const fast = velocity.length();
      if (fast > 0.4) sound.play("whoosh", { gain: Math.min(0.35, 0.08 + fast * 0.1), pitch: 1.4 });
      sound.play("rustle", { gain: 0.12, pitch: 1.3 });
    }
  });

  // A low hum in the dark, and a draught.
  useBed("drone", 0.05);
  useBed("wind", 0.012 + draught * 0.02);

  if (process.env.NODE_ENV !== "production")
    Object.assign(globalThis, {
      __hood: { st, cloth, scene },
      // For testing in development: put the eye somewhere from the console.
      __view: (from: number[], to: number[]) => {
        camera.position.set(from[0], from[1], from[2]);
        orbitPoint.current?.set(to[0], to[1], to[2]);
        camera.lookAt(to[0], to[1], to[2]);
      }
    });

  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 30);
    if (delta <= 0 || !st.current.settled) return;
    const s = st.current;
    s.seconds += delta;
    const u = cloth.u;
    u.breeze.value = 0.4 + draught;

    // Her breath: out, slow and soft, stirring the veil in front of her lips; then in, drawing it a little back.
    const phase = (s.seconds % BREATH) / BREATH;
    const out = phase < OUT ? Math.sin((phase / OUT) * Math.PI) : -0.25 * Math.sin(((phase - OUT) / (1 - OUT)) * Math.PI);
    u.breath.value = out;
    const n = Math.floor(s.seconds / BREATH);
    if (n !== s.lastBreath) {
      s.lastBreath = n;
      breath(0.5);
    }

    step(gl, cloth, delta, substeps, pairs, s.seconds);

    // Read the cloth back a few times a second, for the hand to land on.
    if (!s.reading && s.seconds - s.readAt > 0.1) {
      s.reading = true;
      const askedAt = s.seconds;
      (gl.getArrayBufferAsync(cloth.A.value) as Promise<ArrayBuffer>)
        .then((buffer) => {
          s.data = new Float32Array(buffer);
          s.readAt = askedAt;
          // How far the veil is lifted off her face: the hem's rise.
          let rise = 0;
          for (let i = 0; i < cloth.COLS; i++) rise = Math.max(rise, s.data[((cloth.ROWS - 1) * cloth.COLS + i) * 4 + 1]);
          s.lifted = rise;
          if (!s.earned && rise > 1.56) {
            s.earned = true;
            followPrompt.earn("veil");
            shareResult.set("Lifted the veil");
          }
        })
        .catch(() => {})
        .finally(() => (s.reading = false));
    }
  });

  return (
    <>
      <Lights />
      <Backdrop />
      <Hood />
      <Face />
      <Veil cloth={cloth} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.0, 1.6, 0.74],
    target: [0, 1.57, 0.05],
    fov: 30,
    limits: { turn: { left: 40, right: 40, up: 20, down: 20 }, move: { left: 0.1, right: 0.1, down: 0.1, up: 0.1, nearer: 0.25, further: 0.4 } }
  },
  hover: true,
  look: { background: "#000000", exposure: 1.0, bloom: 0.35, bloomThreshold: 0.9, gi: 0, ao: 0.9, vignette: 0.75, grain: 0.045, haze: 0 },
  passes: { bounce: false, haze: false, depthOfField: { range: 0.35 } },
  settings: {
    draught: { type: "range", label: "Draught", min: 0, max: 2, step: 0.01, value: 0.6, reset: 0.6 }
  },
  phoneDock: ["draught"],
  prompt: { title: "Lift the veil", detail: "Take hold of it and draw it aside", low: true },
  hint: "Take hold of the veil and lift it or draw it aside; let go and it falls back. It stirs as she breathes.",
  notes: "A figure in a deep black hood, close, in the dark: nothing inside the hood but shadow, behind a sheer black veil that stirs as she breathes.",
  Scene
};

export default day;
