"use client";

import { useEffect, useRef, useState } from "react";

// A small live graph of frame time, from the browser's own frame callbacks, so a stall anywhere (a shader compiling, a
// texture uploading, a long frame on the GPU) shows as a spike. The last few seconds are drawn as bars against lines at
// 60 and 30 fps, with the average rate, the average frame and the worst frame written above.
const SAMPLES = 240;
const WIDTH = 240;
const HEIGHT = 56;
// Milliseconds at the top of the graph; longer frames are drawn clipped, in red.
const CEILING = 50;

export function FrameGraph() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [text, setText] = useState("…");

  useEffect(() => {
    const times = new Float32Array(SAMPLES);
    let head = 0;
    let last = performance.now();
    let frame = 0;
    let shown = 0;
    const context = canvas.current?.getContext("2d");
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.current) {
      canvas.current.width = WIDTH * ratio;
      canvas.current.height = HEIGHT * ratio;
    }

    const tick = (now: number) => {
      times[head] = now - last;
      head = (head + 1) % SAMPLES;
      last = now;
      frame = requestAnimationFrame(tick);
      if (!context) return;

      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, WIDTH, HEIGHT);
      const y = (ms: number) => HEIGHT - (Math.min(ms, CEILING) / CEILING) * HEIGHT;
      context.fillStyle = "rgba(255,255,255,0.08)";
      context.fillRect(0, y(1000 / 60), WIDTH, 1);
      context.fillRect(0, y(1000 / 30), WIDTH, 1);
      const bar = WIDTH / SAMPLES;
      for (let i = 0; i < SAMPLES; i++) {
        const ms = times[(head + i) % SAMPLES];
        if (!ms) continue;
        context.fillStyle = ms > 1000 / 30 ? "#ff6b5a" : ms > 1000 / 55 ? "#f4c46b" : "#8fe3a8";
        const top = y(ms);
        context.fillRect(i * bar, top, Math.max(1, bar), HEIGHT - top);
      }

      // The words a few times a second, from the last second of frames.
      if (now - shown < 250) return;
      shown = now;
      let total = 0;
      let worst = 0;
      let count = 0;
      for (let i = 1; i <= 60; i++) {
        const ms = times[(head - i + SAMPLES) % SAMPLES];
        if (!ms) continue;
        total += ms;
        worst = Math.max(worst, ms);
        count++;
      }
      if (count) setText(`${Math.round((1000 * count) / total)} fps · ${(total / count).toFixed(1)} ms · worst ${worst.toFixed(0)} ms`);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="cv-frames">
      <span>{text}</span>
      <canvas ref={canvas} style={{ width: WIDTH, height: HEIGHT }} />
    </div>
  );
}
