"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import type * as THREE from "three/webgpu";
import { focusBlur, focusDistance } from "../shared/engine/Post";
import { sound } from "../shared/engine/sound";
import { PANEL, panels, uiBlocks } from "./panels";
import { isTouch } from "./touch";

// The camera. P (or the camera button) raises it: the HUD goes, a viewfinder comes up over the view and you walk and look
// through it. Hold Shift to line up a shot: the lens zooms in (the wheel sets how far), hunts for focus on whatever is
// under the reticle and locks with a beep, and the depth of field goes shallow. Click or Space fires the shutter. What is
// kept is the clean 3D frame (the canvas holds no HUD), developed on a 2D canvas: a touch of film grade and grain and an
// orange date-back stamp burned into the corner. The roll lives in memory for the visit; "Save album" downloads every
// photo in one zip, built here in the browser (stored, not compressed: JPEGs do not shrink).

type Photo = { id: number; blob: Blob; url: string; thumb: string; at: number; width: number; height: number };

// Longest side of a saved photo, in pixels.
const LONGEST = 2560;
const THUMB = 420;
// The lens: a touch long when raised (you are looking through glass), and how far Shift may take it.
const RAISED = 1.12;
const ZOOM = { min: 1.5, max: 6, start: 2.5 };
// How long the lens hunts before it locks, and the least time between frames (a shutter and a film advance).
const HUNT = 0.32;
const RECYCLE = 0.38;

export const photos = {
  list: [] as Photo[],
  // A photo asked for, taken by `PhotoCapture` right after the next frame is drawn.
  wanted: false,
  // Which one is open large (-1 none).
  viewing: -1,
  next: 1,
  listeners: new Set<() => void>(),
  version: 0,
  changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  },
  // Keeps a developed photo: the full one and a small copy for the roll.
  async keep(canvas: HTMLCanvasElement, at: number) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) return;
    const small = document.createElement("canvas");
    small.width = THUMB;
    small.height = Math.max(1, Math.round((THUMB * canvas.height) / canvas.width));
    small.getContext("2d")?.drawImage(canvas, 0, 0, small.width, small.height);
    const thumbBlob = await new Promise<Blob | null>((resolve) => small.toBlob(resolve, "image/jpeg", 0.82));
    this.list = [
      ...this.list,
      {
        id: this.next++,
        blob,
        url: URL.createObjectURL(blob),
        thumb: URL.createObjectURL(thumbBlob ?? blob),
        at,
        width: canvas.width,
        height: canvas.height
      }
    ];
    this.changed();
  },
  remove(index: number) {
    const photo = this.list[index];
    if (!photo) return;
    URL.revokeObjectURL(photo.url);
    if (photo.thumb !== photo.url) URL.revokeObjectURL(photo.thumb);
    this.list = this.list.filter((_, k) => k !== index);
    if (this.viewing >= this.list.length) this.viewing = this.list.length - 1;
    this.changed();
  },
  view(index: number) {
    this.viewing = index;
    this.changed();
  }
};

export function usePhotos() {
  return useSyncExternalStore(
    (listener) => {
      photos.listeners.add(listener);
      return () => photos.listeners.delete(listener);
    },
    () => photos.version,
    () => 0
  );
}

// ---- The camera held up -------------------------------------------------------------------------------------------

// The viewfinder's live parts, written straight from the frame loop when they change (never re-rendered per frame).
type Readouts = { root: HTMLElement | null; zoom: HTMLElement | null; focus: HTMLElement | null; exposure: HTMLElement | null };

export const viewfinder = {
  up: false,
  // Shift held (or the touch slider past 1×): lining up a shot.
  aiming: false,
  touchZoom: 1,
  // How far Shift zooms, set with the wheel.
  zoom: ZOOM.start,
  // Eased: how far up, how far into a shot, the lens's magnification, and the focus it is set to.
  raise: 0,
  aim: 0,
  factor: 1,
  focus: 6,
  base: 62,
  bent: false,
  hunt: 0,
  locked: false,
  lockedAt: 0,
  time: 0,
  lastShot: -10,
  shotAt: 0,
  // The newest photo's id when the camera last came up: only later ones slide into the corner stack.
  seen: 0,
  camera: null as THREE.PerspectiveCamera | null,
  dom: { root: null, zoom: null, focus: null, exposure: null } as Readouts,
  shown: { state: -1, zoom: -1, focus: -2, exposure: -1 },
  listeners: new Set<() => void>(),
  version: 0,
  changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  },
  toggle() {
    if (this.up) this.lower();
    else this.lift();
  },
  lift() {
    if (this.up || panels.modal > 0) return;
    this.up = true;
    this.touchZoom = 1;
    this.seen = photos.next - 1;
    clack(true);
    this.changed();
  },
  lower() {
    if (!this.up) return;
    this.up = false;
    this.aiming = false;
    this.touchZoom = 1;
    clack(false);
    this.changed();
  },
  setAim(on: boolean) {
    if (on === this.aiming) return;
    this.aiming = on;
    if (on && this.up) whirr();
  },
  // The wheel: how far the lens reaches when lining up.
  wheel(deltaY: number) {
    const was = this.zoom;
    this.zoom = Math.min(ZOOM.max, Math.max(ZOOM.min, this.zoom * Math.exp(-deltaY * 0.0016)));
    if (Math.floor(was * 4) !== Math.floor(this.zoom * 4)) tick();
  },
  shoot() {
    if (!this.up || photos.wanted || panels.modal > 0 || this.time - this.lastShot < RECYCLE) return;
    this.lastShot = this.time;
    photos.wanted = true;
    this.shotAt = performance.now();
    shutter();
    this.changed();
  },
  // Called by the scene every frame after it has set the camera and the focus it wants: eases the lens in and out, and
  // while lining up hunts, locks and holds focus on what is under the reticle (`target`, in metres), shallow. `dark`
  // (0 outside, 1 deep in the rock) picks the exposure the readout shows.
  frame(camera: THREE.PerspectiveCamera, dt: number, target: number, dark: number) {
    this.camera = camera;
    this.time += dt;
    const ease = (rate: number) => 1 - Math.exp(-dt * rate);
    this.raise += ((this.up ? 1 : 0) - this.raise) * ease(8);
    const aiming = this.up && (this.aiming || this.touchZoom > 1.05);
    this.aim += ((aiming ? 1 : 0) - this.aim) * ease(7);
    const want = !this.up ? 1 : aiming ? (this.touchZoom > 1.05 ? this.touchZoom : this.zoom) : RAISED;
    this.factor += (want - this.factor) * ease(6);
    if (!this.up && Math.abs(this.factor - 1) < 0.002) this.factor = 1;

    // The lens: the scene's own field of view, narrowed by the magnification. At rest it is the scene's to set.
    if (this.factor === 1 && !this.up) {
      if (this.bent) {
        camera.fov = this.base;
        camera.updateProjectionMatrix();
        this.bent = false;
      } else this.base = camera.fov;
    } else {
      const fov = (2 * Math.atan(Math.tan((this.base * Math.PI) / 360) / this.factor) * 180) / Math.PI;
      if (Math.abs(camera.fov - fov) > 1e-3) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
        this.bent = true;
      }
    }

    // Focus: hunting swings either side of the subject, closing in, then locks; a locked lens follows slow changes and
    // hunts again if the subject jumps (panned onto something much nearer or further).
    if (aiming) {
      if (!this.locked) {
        this.hunt += dt;
        const k = Math.min(1, this.hunt / HUNT);
        this.focus = target * (1 + Math.sin(this.hunt * 40) * 0.4 * (1 - k));
        if (this.hunt >= HUNT) {
          this.locked = true;
          this.lockedAt = target;
          beep();
        }
      } else {
        this.focus += (target - this.focus) * ease(10);
        if (Math.abs(target - this.lockedAt) > Math.max(0.4, this.lockedAt * 0.3)) {
          this.locked = false;
          this.hunt = 0;
        } else this.lockedAt += (target - this.lockedAt) * ease(3);
      }
    } else {
      this.locked = false;
      this.hunt = 0;
      this.focus = focusDistance.value;
    }
    if (this.aim > 0.001) {
      const shallow = Math.min(11, Math.max(7, 6 + this.factor * 1.1));
      focusDistance.value += (this.focus - focusDistance.value) * this.aim;
      focusBlur.value += (shallow - focusBlur.value) * this.aim;
    }

    // The viewfinder's readouts, only when they change.
    const dom = this.dom;
    if (!dom.root || this.raise < 0.001) return;
    const shown = this.shown;
    const state = !this.up ? 0 : !aiming ? 1 : this.locked ? 3 : 2;
    if (state !== shown.state) {
      shown.state = state;
      dom.root.classList.toggle("aim", state >= 2);
      dom.root.classList.toggle("locked", state === 3);
    }
    const zoom = Math.round(this.factor * 10);
    if (zoom !== shown.zoom) {
      shown.zoom = zoom;
      if (dom.zoom) dom.zoom.textContent = `${(zoom / 10).toFixed(1)}×`;
      dom.root.style.setProperty("--burrow-zoom", String((this.factor - 1) / (ZOOM.max - 1)));
    }
    const focus = !aiming ? -1 : target > 30 ? 999 : Math.round(this.focus * 10);
    if (focus !== shown.focus && dom.focus) {
      shown.focus = focus;
      dom.focus.textContent = focus < 0 ? "AF" : focus === 999 ? "∞" : `${(focus / 10).toFixed(1)} m`;
    }
    const exposure = dark > 0.7 ? 2 : dark > 0.25 ? 1 : 0;
    if (exposure !== shown.exposure && dom.exposure) {
      shown.exposure = exposure;
      dom.exposure.textContent = ["1/500  f/4  ISO 100", "1/125  f/2.8  ISO 800", "1/30  f/1.8  ISO 3200"][exposure];
    }
  },
  // Leaving the day: down, and the scene's own lens back.
  reset() {
    this.up = false;
    this.aiming = false;
    this.touchZoom = 1;
    this.raise = 0;
    this.aim = 0;
    this.factor = 1;
    if (this.bent && this.camera) {
      this.camera.fov = this.base;
      this.camera.updateProjectionMatrix();
    }
    this.bent = false;
    this.camera = null;
  }
};

function useViewfinder() {
  return useSyncExternalStore(
    (listener) => {
      viewfinder.listeners.add(listener);
      return () => viewfinder.listeners.delete(listener);
    },
    () => viewfinder.version,
    () => 0
  );
}

// ---- Developing ---------------------------------------------------------------------------------------------------

// Film grain, made once: soft grey noise to lay over each photo.
let grainTile: HTMLCanvasElement | null = null;
function grain() {
  if (grainTile) return grainTile;
  grainTile = document.createElement("canvas");
  grainTile.width = grainTile.height = 160;
  const g = grainTile.getContext("2d") as CanvasRenderingContext2D;
  const image = g.createImageData(160, 160);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 90;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  g.putImageData(image, 0, 0);
  return grainTile;
}

// Which of a seven-segment digit's bars are lit: a b c d e f g as bits 0 to 6.
const DIGITS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];

// One bar with pointed ends, from (x0, y0) to (x1, y1), horizontal or vertical, t thick.
function bar(path: Path2D, x0: number, y0: number, x1: number, y1: number, t: number) {
  const h = t / 2;
  if (y0 === y1) {
    path.moveTo(x0, y0);
    path.lineTo(x0 + h, y0 - h);
    path.lineTo(x1 - h, y0 - h);
    path.lineTo(x1, y0);
    path.lineTo(x1 - h, y0 + h);
    path.lineTo(x0 + h, y0 + h);
  } else {
    path.moveTo(x0, y0);
    path.lineTo(x0 + h, y0 + h);
    path.lineTo(x0 + h, y1 - h);
    path.lineTo(x1, y1);
    path.lineTo(x0 - h, y1 - h);
    path.lineTo(x0 - h, y0 + h);
  }
  path.closePath();
}

const two = (n: number) => String(n).padStart(2, "0");
// The stamp's words: day, month, 'year, then the time, as an old date-back prints them.
const stampText = (d: Date) => `${two(d.getDate())} ${two(d.getMonth() + 1)} '${two(d.getFullYear() % 100)}  ${two(d.getHours())}:${two(d.getMinutes())}`;

// The date-back's stamp, burned into the lower right: orange-red seven-segment figures, leaning a little, with the
// soft bloom of light printed through the film's back.
function stamp(g: CanvasRenderingContext2D, w: number, h: number, date: Date) {
  const text = stampText(date);
  const ch = Math.max(13, Math.round(h * 0.036));
  const cw = ch * 0.5;
  const t = ch * 0.15;
  const gap = t * 0.42;
  const advance = (c: string) => (c === " " ? cw * 0.6 : c === "'" ? cw * 0.5 : c === ":" ? cw * 0.62 : cw + ch * 0.22);
  let x = w - Math.round(w * 0.045) - [...text].reduce((sum, c) => sum + advance(c), 0);
  const top = h - Math.round(h * 0.06) - ch;
  const path = new Path2D();
  for (const c of text) {
    if (c >= "0" && c <= "9") {
      const on = DIGITS[c.charCodeAt(0) - 48];
      const l = x;
      const r = x + cw;
      const m = top + ch / 2;
      const b = top + ch;
      if (on & 1) bar(path, l + gap, top, r - gap, top, t);
      if (on & 2) bar(path, r, top + gap, r, m - gap, t);
      if (on & 4) bar(path, r, m + gap, r, b - gap, t);
      if (on & 8) bar(path, l + gap, b, r - gap, b, t);
      if (on & 16) bar(path, l, m + gap, l, b - gap, t);
      if (on & 32) bar(path, l, top + gap, l, m - gap, t);
      if (on & 64) bar(path, l + gap, m, r - gap, m, t);
    } else if (c === "'") bar(path, x + cw * 0.2, top - t * 0.2, x + cw * 0.2, top + ch * 0.3, t * 0.9);
    else if (c === ":") {
      path.rect(x + cw * 0.12, top + ch * 0.28 - t / 2, t, t);
      path.rect(x + cw * 0.12, top + ch * 0.72 - t / 2, t, t);
    }
    x += advance(c);
  }
  g.save();
  // Lean the figures, about their baseline.
  g.translate(0, top + ch);
  g.transform(1, 0, -0.11, 1, 0, 0);
  g.translate(0, -(top + ch));
  g.shadowColor = "rgba(255, 64, 12, 0.9)";
  g.shadowBlur = ch * 0.5;
  g.fillStyle = "rgba(255, 104, 34, 0.94)";
  g.fill(path);
  g.globalCompositeOperation = "screen";
  g.shadowBlur = ch * 0.12;
  g.shadowColor = "rgba(255, 120, 40, 0.8)";
  g.fillStyle = "rgba(255, 178, 96, 0.75)";
  g.fill(path);
  g.restore();
}

// The frame as kept: the canvas scaled down to size, a gentle film grade, a vignette, grain and the stamp.
function develop(source: HTMLCanvasElement, date: Date) {
  const k = Math.min(1, LONGEST / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  const w = (canvas.width = Math.round(source.width * k));
  const h = (canvas.height = Math.round(source.height * k));
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.filter = "contrast(1.05) saturate(1.08) sepia(0.06)";
  g.drawImage(source, 0, 0, w, h);
  g.filter = "none";
  const vignette = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.38, w / 2, h / 2, Math.hypot(w, h) / 2);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.34)");
  g.fillStyle = vignette;
  g.fillRect(0, 0, w, h);
  const pattern = g.createPattern(grain(), "repeat");
  if (pattern) {
    g.globalCompositeOperation = "overlay";
    g.globalAlpha = 0.09;
    g.fillStyle = pattern;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
  }
  stamp(g, w, h, date);
  return canvas;
}

// In the scene: copies the canvas straight after the frame is drawn (the engine draws at priority 1), in the same task,
// while WebGPU's current texture still holds it, and develops it.
export function PhotoCapture() {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  useFrame(() => {
    if (!photos.wanted) return;
    photos.wanted = false;
    const source = gl.domElement;
    if (!source.width || !source.height) return;
    const at = Date.now();
    const canvas = develop(source, new Date(at));
    if (canvas) void photos.keep(canvas, at).catch((error) => console.warn("burrow photo", error));
  }, 2);
  useEffect(
    () => () => {
      photos.wanted = false;
      viewfinder.reset();
    },
    []
  );
  return null;
}

// ---- Sound --------------------------------------------------------------------------------------------------------

const noises = new WeakMap<AudioContext, AudioBuffer>();
function noise(context: AudioContext) {
  let buffer = noises.get(context);
  if (!buffer) {
    buffer = context.createBuffer(1, Math.floor(context.sampleRate * 0.5), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noises.set(context, buffer);
  }
  return buffer;
}

// A short burst of filtered noise: a click, a slap, a breath.
function burst(context: AudioContext, out: AudioNode, at: number, type: BiquadFilterType, freq: number, q: number, gain: number, decay: number) {
  const source = context.createBufferSource();
  source.buffer = noise(context);
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const level = context.createGain();
  level.gain.setValueAtTime(0.0001, at);
  level.gain.exponentialRampToValueAtTime(gain, at + 0.0015);
  level.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  source.connect(filter).connect(level).connect(out);
  source.start(at, Math.random() * 0.3);
  source.stop(at + decay + 0.02);
}

// A tone gliding from one pitch to another: a thump, a motor, a pip.
function tone(context: AudioContext, out: AudioNode, at: number, type: OscillatorType, from: number, to: number, gain: number, length: number, band = 0) {
  const osc = context.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + length);
  const level = context.createGain();
  level.gain.setValueAtTime(0.0001, at);
  level.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.01, length * 0.2));
  level.gain.setValueAtTime(gain, at + length * 0.7);
  level.gain.exponentialRampToValueAtTime(0.0001, at + length);
  if (band) {
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = band;
    filter.Q.value = 1.1;
    osc.connect(filter).connect(level).connect(out);
  } else osc.connect(level).connect(out);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

// The shutter: the mirror slaps up, two blades cross, the mirror drops back, and the motor winds the film on in a
// ratchet of little clicks.
function shutter() {
  sound.custom((context, out, at) => {
    tone(context, out, at, "sine", 120, 48, 0.55, 0.07);
    burst(context, out, at, "lowpass", 700, 0.7, 0.4, 0.05);
    burst(context, out, at + 0.012, "bandpass", 4400, 2.2, 0.6, 0.028);
    burst(context, out, at + 0.058, "bandpass", 2700, 1.8, 0.5, 0.034);
    tone(context, out, at + 0.085, "sine", 95, 50, 0.32, 0.05);
    burst(context, out, at + 0.088, "bandpass", 1500, 1.4, 0.22, 0.04);
    const wind = at + 0.15;
    tone(context, out, wind, "sawtooth", 150, 240, 0.05, 0.24, 950);
    for (let k = 0; k < 8; k++) burst(context, out, wind + k * 0.028, "bandpass", 1900 + k * 60, 3, 0.11, 0.014);
  });
}

// Raising (a plastic clack and the lens coming out) or lowering (the lens going back, a softer clack).
function clack(up: boolean) {
  sound.custom((context, out, at) => {
    burst(context, out, at, "bandpass", up ? 1700 : 1200, 3, up ? 0.3 : 0.22, 0.035);
    tone(context, out, at + 0.03, "sawtooth", up ? 280 : 520, up ? 520 : 260, 0.035, 0.2, 1200);
  });
}

// The lens motor as a shot is lined up.
function whirr() {
  sound.custom((context, out, at) => tone(context, out, at, "sawtooth", 340, 610, 0.03, 0.22, 1400));
}

// Focus locked: two quick pips.
function beep() {
  sound.custom((context, out, at) => {
    tone(context, out, at, "sine", 2950, 2950, 0.06, 0.04);
    tone(context, out, at + 0.075, "sine", 2950, 2950, 0.06, 0.04);
  });
}

// A detent on the zoom ring.
function tick() {
  sound.custom((context, out, at) => burst(context, out, at, "bandpass", 3200, 3, 0.07, 0.012));
}

// ---- Saving --------------------------------------------------------------------------------------------------------

const name = (photo: Photo, index: number) => {
  const d = new Date(photo.at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `burrow-${String(index + 1).padStart(2, "0")}-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.jpg`;
};

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A zip of the given files, each stored as is (no compression), with a central directory: what every unzip reads.
async function zip(files: { name: string; blob: Blob; at: number }[]) {
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const file of files) {
    const data = new Uint8Array(await file.blob.arrayBuffer()) as Uint8Array<ArrayBuffer>;
    const fileName = encoder.encode(file.name) as Uint8Array<ArrayBuffer>;
    const crc = crc32(data);
    const d = new Date(file.at);
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, fileName.length, true);
    local.setUint16(28, 0, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, fileName.length, true);
    entry.setUint32(42, offset, true);
    const header = new Uint8Array(46 + fileName.length);
    header.set(new Uint8Array(entry.buffer), 0);
    header.set(fileName, 46);
    central.push(header);
    parts.push(local.buffer, fileName, data);
    offset += 30 + fileName.length + data.length;
  }
  const size = central.reduce((sum, c) => sum + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

export async function saveAlbum() {
  if (!photos.list.length) return;
  const files = photos.list.map((photo, k) => ({ name: name(photo, k), blob: photo.blob, at: photo.at }));
  download(await zip(files), "burrow-photo-album.zip");
}

// ---- The viewfinder -----------------------------------------------------------------------------------------------

const STYLE = `
  .burrow-cam-up .cv-hud > :not(.burrow-cam):not(style) { opacity: 0 !important; transition: opacity 0.3s ease !important; }
  .burrow-cam-up .cv-hud > :not(.burrow-cam), .burrow-cam-up .cv-hud > :not(.burrow-cam) * { pointer-events: none !important; }
  .burrow-cam { position: fixed; inset: 0; z-index: 35; pointer-events: none; opacity: 0; visibility: hidden; transition: opacity 0.25s ease, visibility 0s linear 0.25s; color: #f5f2ea; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; letter-spacing: 0.08em; text-shadow: 0 1px 4px rgba(0,0,0,0.75); --burrow-ink: rgba(255,255,255,0.92); --burrow-inset: max(5vmin, 26px); }
  .burrow-cam.up { opacity: 1; visibility: visible; transition: opacity 0.25s ease; }
  .burrow-cam.up::before { content: ""; position: absolute; inset: 0; background: #000; animation: burrow-cam-iris 0.55s ease-out forwards; }
  @keyframes burrow-cam-iris { 0% { opacity: 0.92; } 100% { opacity: 0; } }
  .burrow-cam-vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(0,0,0,0.5) 100%); }
  .burrow-cam-frame { position: absolute; inset: var(--burrow-inset); transform: scale(1.07); transition: transform 0.55s cubic-bezier(0.2, 0.85, 0.2, 1); }
  .burrow-cam.up .burrow-cam-frame { transform: none; }
  .burrow-cam-corner { position: absolute; width: 38px; height: 38px; border: 0 solid var(--burrow-ink); filter: drop-shadow(0 0 2px rgba(0,0,0,0.7)); }
  .burrow-cam-corner.tl { left: 0; top: 0; border-left-width: 2px; border-top-width: 2px; }
  .burrow-cam-corner.tr { right: 0; top: 0; border-right-width: 2px; border-top-width: 2px; }
  .burrow-cam-corner.bl { left: 0; bottom: 0; border-left-width: 2px; border-bottom-width: 2px; }
  .burrow-cam-corner.br { right: 0; bottom: 0; border-right-width: 2px; border-bottom-width: 2px; }
  .burrow-cam-thirds { position: absolute; inset: 0; opacity: 0.75; transition: opacity 0.3s ease;
    background:
      linear-gradient(to right, transparent calc(33.333% - 0.5px), rgba(255,255,255,0.24) 0 calc(33.333% + 0.5px), transparent 0 calc(66.667% - 0.5px), rgba(255,255,255,0.24) 0 calc(66.667% + 0.5px), transparent 0),
      linear-gradient(to bottom, transparent calc(33.333% - 0.5px), rgba(255,255,255,0.24) 0 calc(33.333% + 0.5px), transparent 0 calc(66.667% - 0.5px), rgba(255,255,255,0.24) 0 calc(66.667% + 0.5px), transparent 0); }
  .burrow-cam.aim .burrow-cam-thirds { opacity: 0.3; }
  .burrow-cam-reticle { position: absolute; left: 50%; top: 50%; width: 132px; height: 92px; margin: -46px 0 0 -66px; --burrow-ink: rgba(255,255,255,0.92); transition: transform 0.28s cubic-bezier(0.3, 1.5, 0.5, 1); }
  .burrow-cam-reticle i { position: absolute; width: 18px; height: 18px; border: 0 solid var(--burrow-ink); transition: border-color 0.15s ease; filter: drop-shadow(0 0 2px rgba(0,0,0,0.7)); }
  .burrow-cam-reticle i:nth-child(1) { left: 0; top: 0; border-left-width: 2px; border-top-width: 2px; }
  .burrow-cam-reticle i:nth-child(2) { right: 0; top: 0; border-right-width: 2px; border-top-width: 2px; }
  .burrow-cam-reticle i:nth-child(3) { left: 0; bottom: 0; border-left-width: 2px; border-bottom-width: 2px; }
  .burrow-cam-reticle i:nth-child(4) { right: 0; bottom: 0; border-right-width: 2px; border-bottom-width: 2px; }
  .burrow-cam-reticle b { position: absolute; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; background: linear-gradient(var(--burrow-ink), var(--burrow-ink)) center / 100% 1.5px no-repeat, linear-gradient(var(--burrow-ink), var(--burrow-ink)) center / 1.5px 100% no-repeat; opacity: 0.8; }
  .burrow-cam.aim .burrow-cam-reticle { transform: scale(0.6); animation: burrow-cam-hunt 0.32s ease-in-out; }
  @keyframes burrow-cam-hunt { 0% { transform: scale(1); } 30% { transform: scale(0.5); } 60% { transform: scale(0.7); } 85% { transform: scale(0.57); } 100% { transform: scale(0.6); } }
  .burrow-cam.locked .burrow-cam-reticle { --burrow-ink: #8dffb2; }
  .burrow-cam.locked .burrow-cam-reticle::after { content: ""; position: absolute; inset: -12px; border: 2px solid #8dffb2; border-radius: 6px; animation: burrow-cam-lock 0.42s ease-out forwards; }
  @keyframes burrow-cam-lock { from { opacity: 1; transform: scale(1.3); } to { opacity: 0; transform: scale(1); } }
  .burrow-cam-top, .burrow-cam-bottom { position: absolute; left: 50px; right: 50px; display: flex; align-items: center; gap: 16px; white-space: nowrap; }
  .burrow-cam-top { top: 12px; }
  .burrow-cam-bottom { bottom: 12px; justify-content: center; gap: 22px; }
  .burrow-cam-mode { padding: 1px 6px; border: 1.5px solid var(--burrow-ink); border-radius: 3px; font-weight: 700; }
  .burrow-cam-battery { position: relative; width: 26px; height: 12px; border: 1.5px solid var(--burrow-ink); border-radius: 2px; background: linear-gradient(to right, var(--burrow-ink) 0 26%, transparent 0 37%, var(--burrow-ink) 0 63%, transparent 0 74%, var(--burrow-ink) 0) content-box; padding: 1.5px; box-sizing: border-box; }
  .burrow-cam-battery::after { content: ""; position: absolute; right: -4.5px; top: 2.5px; width: 2.5px; height: 4px; background: var(--burrow-ink); border-radius: 0 1px 1px 0; }
  .burrow-cam-rec { display: flex; align-items: center; gap: 6px; }
  .burrow-cam-rec::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #ff4b3a; box-shadow: 0 0 8px #ff4b3a; animation: burrow-cam-blink 1.2s steps(2, jump-none) infinite; }
  @keyframes burrow-cam-blink { 0% { opacity: 1; } 100% { opacity: 0.15; } }
  .burrow-cam-clock { margin-left: auto; color: #ff8c42; font-weight: 600; letter-spacing: 0.12em; text-shadow: 0 0 8px rgba(255,70,20,0.7), 0 1px 3px rgba(0,0,0,0.8); }
  .burrow-cam-focus { min-width: 5.5em; text-align: center; padding: 1px 8px; border-radius: 3px; border: 1.5px solid rgba(255,255,255,0.5); transition: border-color 0.15s ease, color 0.15s ease; }
  .burrow-cam.locked .burrow-cam-focus { border-color: #8dffb2; color: #8dffb2; }
  .burrow-cam-zoom { position: absolute; right: 10px; top: 50%; height: 36%; width: 10px; transform: translateY(-50%); background: repeating-linear-gradient(to top, rgba(255,255,255,0.6) 0 1.5px, transparent 1.5px 10%) right / 10px 100% no-repeat; }
  .burrow-cam-zoom::before { content: "W"; position: absolute; right: 0; bottom: -20px; font-size: 10px; opacity: 0.7; }
  .burrow-cam-zoom::after { content: "T"; position: absolute; right: 0; top: -20px; font-size: 10px; opacity: 0.7; }
  .burrow-cam-zoom span { position: absolute; right: 16px; bottom: calc(var(--burrow-zoom, 0) * 100%); transform: translateY(50%); padding: 2px 6px; border-radius: 3px; background: rgba(0,0,0,0.45); font-weight: 700; color: #ffd27a; }
  .burrow-cam-zoom span::after { content: ""; position: absolute; right: -9px; top: 50%; margin-top: -4px; border: 4px solid transparent; border-left: 6px solid #ffd27a; }
  .burrow-cam-keys { position: absolute; left: 50%; bottom: calc(var(--burrow-inset) + 40px); transform: translateX(-50%); display: flex; gap: 16px; font-size: 11px; letter-spacing: 0.05em; opacity: 0.85; white-space: nowrap; }
  .burrow-cam-keys kbd { margin-right: 5px; padding: 1px 6px; border: 1px solid rgba(255,255,255,0.55); border-radius: 4px; font: inherit; background: rgba(0,0,0,0.25); }
  .burrow-cam.aim .burrow-cam-keys { opacity: 0.35; }
  .burrow-cam-strip { position: absolute; left: calc(var(--burrow-inset) + 16px); bottom: calc(var(--burrow-inset) + 40px); width: 104px; height: 68px; }
  .burrow-cam-strip img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border: 3px solid #f4efe4; border-bottom-width: 9px; border-radius: 2px; box-shadow: 0 8px 22px rgba(0,0,0,0.55); transform: var(--rest); }
  .burrow-cam-strip img.fresh { animation: burrow-cam-slide 0.75s cubic-bezier(0.2, 0.9, 0.25, 1) both; }
  @keyframes burrow-cam-slide { 0% { opacity: 0; transform: translate(calc(50vw - var(--burrow-inset) - 68px), calc(-50vh + var(--burrow-inset) + 74px)) scale(5) rotate(0deg); } 12% { opacity: 1; } 100% { opacity: 1; transform: var(--rest); } }
  .burrow-cam-flash { position: absolute; inset: 0; animation: burrow-cam-flash 0.55s ease-out forwards; }
  @keyframes burrow-cam-flash { 0% { background: #000; opacity: 0.85; } 9% { background: #fff; opacity: 0.95; } 100% { background: #fff; opacity: 0; } }
  .burrow-cam-touch { position: absolute; left: 0; right: 0; bottom: calc(env(safe-area-inset-bottom, 0px) + 24px); display: none; justify-content: center; align-items: center; gap: 40px; pointer-events: auto; }
  .burrow-cam-shoot { width: 78px; height: 78px; border-radius: 50%; border: 4px solid #fff; background: radial-gradient(circle, #fff 0 56%, rgba(255,255,255,0.2) 58%); box-shadow: 0 4px 24px rgba(0,0,0,0.45); cursor: pointer; transition: transform 0.1s ease; }
  .burrow-cam-shoot:active { transform: scale(0.88); }
  .burrow-cam-lower { width: 48px; height: 48px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.45); background: rgba(0,0,0,0.45); color: #fff; font: inherit; font-size: 16px; cursor: pointer; }
  .burrow-cam-slider { position: absolute; right: 14px; top: 50%; height: 40vh; transform: translateY(-50%); display: none; flex-direction: column; align-items: center; gap: 8px; pointer-events: auto; color: #ffd27a; font-weight: 700; }
  .burrow-cam-slider input { flex: 1; width: 34px; writing-mode: vertical-lr; direction: rtl; accent-color: #ff8c42; }
  .burrow-cam.touch .burrow-cam-touch, .burrow-cam.touch .burrow-cam-slider { display: flex; }
  .burrow-cam.touch .burrow-cam-keys, .burrow-cam.touch .burrow-cam-zoom { display: none; }
  .burrow-cam.touch .burrow-cam-strip { left: calc(50% + 39px + 40px); bottom: calc(env(safe-area-inset-bottom, 0px) + 36px); width: 74px; height: 50px; }
  .burrow-cam.touch .burrow-cam-bottom { bottom: 118px; }
  /* A phone's notch and home bar: the frame, the readouts and the controls stay inside the safe area; the slider's
     thumb is a finger wide. */
  .burrow-cam.touch .burrow-cam-frame { inset: max(var(--burrow-inset), env(safe-area-inset-top)) max(var(--burrow-inset), env(safe-area-inset-right)) max(var(--burrow-inset), env(safe-area-inset-bottom)) max(var(--burrow-inset), env(safe-area-inset-left)); }
  .burrow-cam.touch .burrow-cam-slider { right: max(10px, env(safe-area-inset-right)); }
  .burrow-cam.touch .burrow-cam-slider input { width: 44px; }
  @media (max-width: 720px) {
    .burrow-cam-top, .burrow-cam-bottom { left: 14px; right: 14px; gap: 10px; font-size: 11px; }
    .burrow-cam-exposure { display: none; }
    .burrow-cam-keys { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .burrow-cam-strip img.fresh, .burrow-cam.aim .burrow-cam-reticle { animation: none; } }

  .burrow-roll-head { display: flex; align-items: baseline; gap: 8px; margin: 2px 0 4px; }
  .burrow-roll-head strong { font-size: 15px; font-weight: 600; }
  .burrow-roll-head span { font-size: 12px; opacity: 0.6; }
  .burrow-roll { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; border-radius: 12px; overflow: hidden; background: rgba(0,0,0,0.35); }
  .burrow-roll-item { position: relative; padding: 0; border: 0; background: #000; cursor: zoom-in; overflow: hidden; }
  .burrow-roll-item img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.25s ease, filter 0.25s ease; }
  .burrow-roll-item:hover img { transform: scale(1.05); filter: brightness(1.08); }
  .burrow-roll-item time { position: absolute; left: 5px; top: 4px; font-size: 10px; font-family: ui-monospace, Menlo, monospace; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.9); opacity: 0; transition: opacity 0.2s ease; }
  .burrow-roll-item:hover time { opacity: 1; }
  .burrow-roll-save { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; margin-top: 10px; padding: 10px 12px; border-radius: 12px; border: 0; background: #f4efe4; color: #1a1612; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  .burrow-roll-save:hover { background: #fff; }
  .burrow-photo-card { max-width: min(1180px, 100%); padding: 14px; background: rgba(10,9,8,0.86); }
  .burrow-photo-meta { display: flex; align-items: baseline; gap: 10px; margin: 0 44px 10px 4px; font-size: 13px; }
  .burrow-photo-meta strong { font-weight: 600; }
  .burrow-photo-meta span { opacity: 0.55; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .burrow-photo-meta em { margin-left: auto; font-style: normal; opacity: 0.55; font-size: 12px; }
  .burrow-photo-large { display: block; max-width: 100%; max-height: calc(100vh - 170px); margin: 0 auto; border-radius: 6px; box-shadow: 0 12px 40px rgba(0,0,0,0.6); }
  .burrow-photo-bar { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 13px; }
  .burrow-photo-bar i { flex: 1; }
  .burrow-photo-bar button { padding: 7px 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
  .burrow-photo-bar button:hover:not(:disabled) { background: rgba(255,255,255,0.13); }
  .burrow-photo-bar button:disabled { opacity: 0.3; cursor: default; }
  .burrow-photo-bar .burrow-photo-arrow { width: 36px; height: 36px; padding: 0; font-size: 18px; }
  .burrow-photo-bar .burrow-photo-primary { border: 0; background: #f4efe4; color: #1a1612; font-weight: 600; }
  .burrow-photo-bar .burrow-photo-primary:hover:not(:disabled) { background: #fff; }
  .burrow-photo-bar .burrow-danger { border-color: rgba(255,120,90,0.35); color: #ffb3a0; }
  @media (max-width: 720px) { .burrow-photo-bar { flex-wrap: wrap; } }
  @media (pointer: coarse) { .burrow-photo-bar button { min-height: 44px; } .burrow-photo-bar .burrow-photo-arrow { width: 44px; height: 44px; } .burrow-photo-large { max-height: calc(100dvh - 210px); } }
`;

const clockText = (d: Date) => `${two(d.getDate())}.${two(d.getMonth() + 1)}.'${two(d.getFullYear() % 100)}  ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
// How the last few photos lie in the corner stack, newest on top.
const STACK = ["rotate(-3deg)", "translate(7px, -5px) rotate(5deg)", "translate(-5px, -8px) rotate(-9deg)"];

// The camera held up: frame corners, thirds, the focus reticle, the readouts, the stack of photos taken, and on touch a
// shutter, a zoom slider and a button to lower it. Also takes P, Shift, Space, Esc and the wheel for the camera, and
// hides the rest of the HUD while it is up.
export function Viewfinder() {
  useViewfinder();
  usePhotos();
  const up = viewfinder.up;
  const [touch, setTouch] = useState(false);
  const [clock, setClock] = useState("");
  const [, redraw] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const zoom = useRef<HTMLSpanElement>(null);
  const focus = useRef<HTMLSpanElement>(null);
  const exposure = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setTouch(window.matchMedia("(pointer: coarse)").matches);
    const dom = viewfinder.dom;
    dom.root = root.current;
    dom.zoom = zoom.current;
    dom.focus = focus.current;
    dom.exposure = exposure.current;
    viewfinder.shown.state = viewfinder.shown.zoom = viewfinder.shown.focus = viewfinder.shown.exposure = -1;
    return () => {
      dom.root = dom.zoom = dom.focus = dom.exposure = null;
    };
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const element = event.target as HTMLElement | null;
      if (element?.tagName === "INPUT" && (element as HTMLInputElement).type !== "range") return;
      if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
        viewfinder.setAim(event.type === "keydown" && !uiBlocks());
        return;
      }
      // (While a modal view is open its own handler takes every key first; see inspect.tsx and PhotoViewer.)
      if (event.type !== "keydown" || event.repeat || uiBlocks()) return;
      if (event.code === "KeyP") viewfinder.toggle();
      else if (viewfinder.up && event.code === "Space") {
        event.preventDefault();
        viewfinder.shoot();
      } else if (viewfinder.up && event.code === "Escape") viewfinder.lower();
    };
    const wheel = (event: WheelEvent) => {
      if (viewfinder.up && !uiBlocks(event)) viewfinder.wheel(event.deltaY);
    };
    const blur = () => viewfinder.setAim(false);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("wheel", wheel, { passive: true });
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Up: the rest of the HUD fades away, and the clock runs.
  useEffect(() => {
    if (!up) return;
    const html = document.documentElement;
    html.classList.add("burrow-cam-up");
    const now = () => setClock(clockText(new Date()));
    now();
    const timer = window.setInterval(now, 1000);
    return () => {
      html.classList.remove("burrow-cam-up");
      window.clearInterval(timer);
    };
  }, [up]);

  // The last few, oldest first so the newest lies on top.
  const stack = photos.list.slice(-STACK.length);
  const block = { [PANEL]: "", onPointerDown: stopEvent, onPointerUp: stopEvent, onContextMenu: (event: SyntheticEvent) => event.preventDefault() };

  return (
    <div ref={root} className={`burrow-cam ${up ? "up" : ""} ${touch ? "touch" : ""}`} aria-hidden={!up}>
      <style>{STYLE}</style>
      <div className="burrow-cam-vignette" />
      <div className="burrow-cam-frame">
        <i className="burrow-cam-corner tl" />
        <i className="burrow-cam-corner tr" />
        <i className="burrow-cam-corner bl" />
        <i className="burrow-cam-corner br" />
        <div className="burrow-cam-thirds" />
        <div className="burrow-cam-top">
          <span className="burrow-cam-mode">P</span>
          <span className="burrow-cam-battery" aria-hidden="true" />
          <span className="burrow-cam-rec">[{String(Math.max(0, 999 - (photos.next - 1))).padStart(3, "0")}]</span>
          <span className="burrow-cam-clock">{clock}</span>
        </div>
        <div className="burrow-cam-bottom">
          <span ref={exposure} className="burrow-cam-exposure" />
          <span ref={focus} className="burrow-cam-focus">
            AF
          </span>
          <span>AWB</span>
        </div>
        <div className="burrow-cam-zoom">
          <span ref={zoom}>1.0×</span>
        </div>
      </div>
      <div className="burrow-cam-reticle">
        <i />
        <i />
        <i />
        <i />
        <b />
      </div>
      <div className="burrow-cam-keys">
        <span>
          <kbd>Shift</kbd>line up
        </span>
        <span>
          <kbd>Wheel</kbd>zoom
        </span>
        <span>
          <kbd>Click</kbd>or <kbd>Space</kbd>shoot
        </span>
        <span>
          <kbd>J</kbd>jump
        </span>
        <span>
          <kbd>P</kbd>or <kbd>Esc</kbd>lower
        </span>
      </div>
      <div className="burrow-cam-strip">
        {stack.map((photo, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- taken at runtime, not a static asset.
          <img key={photo.id} src={photo.thumb} alt="" className={photo.id > viewfinder.seen ? "fresh" : undefined} style={{ ["--rest" as string]: STACK[stack.length - 1 - i] }} />
        ))}
      </div>
      <div className="burrow-cam-slider" {...block}>
        <span>T</span>
        <input
          type="range"
          min={1}
          max={ZOOM.max}
          step={0.05}
          value={viewfinder.touchZoom}
          aria-label="Zoom"
          onChange={(event) => {
            viewfinder.touchZoom = Number(event.target.value);
            redraw((n) => n + 1);
          }}
        />
        <span>W</span>
      </div>
      <div className="burrow-cam-touch" {...block}>
        <button type="button" className="burrow-cam-lower" onClick={() => viewfinder.lower()} aria-label="Lower the camera">
          ✕
        </button>
        <button type="button" className="burrow-cam-shoot" onClick={() => viewfinder.shoot()} aria-label="Take a photo" />
        <i style={{ width: 48 }} />
      </div>
      {viewfinder.shotAt ? <div key={viewfinder.shotAt} className="burrow-cam-flash" /> : null}
    </div>
  );
}

const stopEvent = (event: SyntheticEvent) => event.stopPropagation();

// ---- The roll and the viewer ---------------------------------------------------------------------------------------

const shortTime = (at: number) => {
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

// The roll, inside the backpack's panel: the camera roll, newest first, each with its stamp, each opening large.
export function PhotoRoll() {
  usePhotos();
  const list = photos.list;
  return (
    <>
      <div className="burrow-roll-head">
        <strong>Camera roll</strong>
        <span>
          {list.length} photo{list.length === 1 ? "" : "s"}
        </span>
      </div>
      <p>P raises the camera. Hold Shift to line up a shot, click or Space to take it.</p>
      {list.length ? (
        <>
          <div className="burrow-roll">
            {list
              .map((photo, k) => ({ photo, k }))
              .reverse()
              .map(({ photo, k }) => (
                <button key={photo.id} type="button" className="burrow-roll-item" style={{ aspectRatio: `${photo.width} / ${photo.height}` }} onClick={() => photos.view(k)} aria-label={`Photo ${k + 1}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- taken at runtime, not a static asset. */}
                  <img src={photo.thumb} alt="" />
                  <time>{shortTime(photo.at)}</time>
                </button>
              ))}
          </div>
          <button type="button" className="burrow-roll-save" onClick={() => void saveAlbum()}>
            Save album ({list.length}) as .zip
          </button>
        </>
      ) : (
        <div className="burrow-pack-empty">{isTouch() ? "No photos yet. Tap Camera to raise the camera." : "No photos yet. Press P, or the camera button, to raise the camera."}</div>
      )}
    </>
  );
}

// One photo large, over a dimmed scene: back and forth, download, delete. Blocks the game while open.
export function PhotoViewer() {
  usePhotos();
  const index = photos.viewing;
  const photo = photos.list[index];
  const open = !!photo;
  // Closed by a click on the dimmed backdrop, only one that also began there.
  const backdrop = useRef(false);
  useEffect(() => {
    if (!open) return;
    panels.open();
    const key = (event: KeyboardEvent) => {
      if (event.type !== "keydown") return;
      event.stopPropagation();
      if (event.code === "Escape") photos.view(-1);
      else if (event.code === "ArrowLeft") photos.view(Math.max(0, photos.viewing - 1));
      else if (event.code === "ArrowRight") photos.view(Math.min(photos.list.length - 1, photos.viewing + 1));
      else if (event.code === "Delete" || event.code === "Backspace") photos.remove(photos.viewing);
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      panels.close();
    };
  }, [open]);
  if (!photo) return null;
  const stop = (event: SyntheticEvent) => event.stopPropagation();
  const date = new Date(photo.at);
  return (
    <div
      {...{ [PANEL]: "" }}
      className="burrow-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Photo"
      onPointerDown={(event) => {
        stop(event);
        backdrop.current = event.target === event.currentTarget;
      }}
      onPointerUp={stop}
      onClick={(event) => {
        if (backdrop.current && event.target === event.currentTarget) photos.view(-1);
      }}
    >
      <div className="burrow-modal-card burrow-photo-card" onClick={stop}>
        <button type="button" className="burrow-modal-close" onClick={() => photos.view(-1)} aria-label="Close">
          ✕
        </button>
        <div className="burrow-photo-meta">
          <strong>{date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" })}</strong>
          <span>{date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
          <em>
            {photo.width} × {photo.height}
          </em>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- taken at runtime, not a static asset. */}
        <img className="burrow-photo-large" src={photo.url} alt={`Photo ${index + 1}`} />
        <div className="burrow-photo-bar">
          <button type="button" className="burrow-photo-arrow" disabled={index <= 0} onClick={() => photos.view(index - 1)} aria-label="Previous">
            ‹
          </button>
          <span>
            {index + 1} of {photos.list.length}
          </span>
          <button type="button" className="burrow-photo-arrow" disabled={index >= photos.list.length - 1} onClick={() => photos.view(index + 1)} aria-label="Next">
            ›
          </button>
          <i />
          <button type="button" className="burrow-danger" onClick={() => photos.remove(index)}>
            Delete
          </button>
          <button type="button" onClick={() => download(photo.blob, name(photo, index))}>
            Download
          </button>
          <button type="button" className="burrow-photo-primary" onClick={() => void saveAlbum()}>
            Save album
          </button>
        </div>
      </div>
    </div>
  );
}
