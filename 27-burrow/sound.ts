// Burrow's sounds, all synthesised but the dig (recorded, where the file is present): the pick's strike and the rock breaking, pebbles trickling down, drips, a cavern
// opening, a lantern set down. Every one is sent both straight out and into a pair of reverbs, a short one for a
// tunnel and a long one for a cavern, mixed by how big the space round the listener is (measured each moment by rays
// through the rock), so a strike in a tight tunnel is dry and close and the same strike in a cavern rings on.

import { sound } from "../shared/engine/sound";

type Bus = { context: AudioContext; send: GainNode; small: GainNode; large: GainNode; dry: GainNode };
let bus: Bus | null = null;
// The space as last measured, kept until the bus exists.
const space = { enclosed: 0, size: 0 };

const noises = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(context: BaseAudioContext) {
  let buffer = noises.get(context);
  if (!buffer) {
    buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noises.set(context, buffer);
  }
  return buffer;
}

// A room's answer to a click: stereo noise dying away over `seconds`, darker as it goes (rock soaks up the highs).
function impulse(context: AudioContext, seconds: number, predelay: number) {
  const rate = context.sampleRate;
  const length = Math.floor(rate * (seconds + predelay));
  const buffer = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate - predelay;
      if (t < 0) continue;
      const fall = Math.exp((-6.9 * t) / seconds);
      // A one-pole low-pass that closes as the tail goes on.
      const k = 0.55 - 0.45 * Math.min(1, t / seconds);
      low += (Math.random() * 2 - 1 - low) * k;
      // A few early reflections off near walls, then the diffuse tail.
      const early = t < 0.09 && Math.random() < 0.004 ? (Math.random() * 2 - 1) * 3 : 0;
      data[i] = (low + early) * fall;
    }
  }
  return buffer;
}

// A cavern's long ring, made of feedback delays (a handful of combs, each darkened as it goes round, spread across the
// two ears) rather than a convolver, whose preparation of a long impulse held a frame for tens of milliseconds.
function longRoom(context: AudioContext, input: AudioNode, out: AudioNode, seconds: number) {
  const merger = context.createChannelMerger(2);
  const delays = [0.0297, 0.0371, 0.0411, 0.0437, 0.0533, 0.0619];
  delays.forEach((time, k) => {
    const delay = context.createDelay(0.1);
    delay.delayTime.value = time;
    const dark = context.createBiquadFilter();
    dark.type = "lowpass";
    dark.frequency.value = 2400 - k * 180;
    // No resonant bump at the cutoff (Web Audio's default Q lifts it by 1 dB): with it the loop gained more than it
    // lost at that pitch and the ring grew instead of dying, a howl of feedback. Flat (Butterworth) or below only.
    dark.Q.value = -3.01;
    const feedback = context.createGain();
    // And never quite unity, whatever the delay and the tail asked for.
    feedback.gain.value = Math.min(0.9, Math.pow(10, (-3 * time) / seconds));
    input.connect(delay);
    delay.connect(dark).connect(feedback).connect(delay);
    const tap = context.createGain();
    tap.gain.value = 0.22;
    dark.connect(tap).connect(merger, 0, k % 2);
  });
  merger.connect(out);
}

// The rooms, built on the first sound: a short convolver for a tunnel, and the combs above for a cavern.
function ensureBus(context: AudioContext, out: AudioNode) {
  if (bus && bus.context === context) return bus;
  const send = context.createGain();
  const dry = context.createGain();
  dry.connect(out);
  const small = context.createGain();
  const large = context.createGain();
  const shortRoom = context.createConvolver();
  shortRoom.buffer = impulse(context, 0.45, 0.004);
  send.connect(shortRoom);
  shortRoom.connect(small).connect(out);
  // Into the long room through a gentle low-pass, as rock swallows the highs of a distant echo.
  const soften = context.createBiquadFilter();
  soften.type = "lowpass";
  soften.frequency.value = 3200;
  send.connect(soften);
  longRoom(context, soften, large, 3.4);
  large.connect(out);
  bus = { context, send, small, large, dry };
  applySpace(0.01);
  return bus;
}

let bloomUntil = 0;

function applySpace(seconds: number) {
  if (!bus) return;
  const now = bus.context.currentTime;
  const { enclosed, size } = space;
  // Outside, the cliff gives a faint slap back; in a tunnel the short room; in a cavern the long one.
  bus.small.gain.setTargetAtTime(0.05 + enclosed * (1 - size) * 0.75, now, seconds);
  if (performance.now() > bloomUntil) bus.large.gain.setTargetAtTime(0.02 + enclosed * size * 0.85, now, seconds);
  bus.dry.gain.setTargetAtTime(1 - enclosed * size * 0.25, now, seconds);
}

// The cavern's long ring opening up at the breakthrough, before the listener has even stepped in, then settling
// back to whatever the space measures.
export function bloom() {
  if (!bus) return;
  const now = bus.context.currentTime;
  const gain = bus.large.gain;
  gain.cancelScheduledValues(now);
  gain.setTargetAtTime(1.15, now, 0.06);
  bloomUntil = performance.now() + 2600;
  window.setTimeout(() => applySpace(1.2), 2650);
}

// How shut in the listener is (0 in the open to 1 underground) and how big the space is (0 a tight tunnel, 1 a cavern).
export function setSpace(enclosed: number, size: number) {
  space.enclosed = enclosed;
  space.size = size;
  applySpace(0.25);
}

// A one-shot through the rooms: `make` connects its sound to the node it is given.
function shot(make: (context: AudioContext, out: AudioNode, at: number) => void) {
  sound.custom((context, master, at) => {
    const b = ensureBus(context, master);
    const into = context.createGain();
    into.connect(b.dry);
    into.connect(b.send);
    make(context, into, at);
  });
}

function burst(context: AudioContext, out: AudioNode, at: number, o: { freq: number; q: number; attack: number; decay: number; gain: number; type?: BiquadFilterType; sweep?: number }) {
  const source = context.createBufferSource();
  source.buffer = noise(context);
  source.loop = true;
  const filter = context.createBiquadFilter();
  filter.type = o.type ?? "bandpass";
  filter.frequency.setValueAtTime(o.freq, at);
  if (o.sweep) filter.frequency.exponentialRampToValueAtTime(o.sweep, at + o.attack + o.decay);
  filter.Q.value = o.q;
  const level = context.createGain();
  level.gain.setValueAtTime(0.0001, at);
  level.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), at + o.attack);
  level.gain.exponentialRampToValueAtTime(0.0001, at + o.attack + o.decay);
  source.connect(filter).connect(level).connect(out);
  source.start(at, Math.random() * 1.5);
  source.stop(at + o.attack + o.decay + 0.05);
}

function tone(context: AudioContext, out: AudioNode, at: number, type: OscillatorType, from: number, to: number, attack: number, decay: number, gain: number) {
  const osc = context.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + attack + decay);
  const level = context.createGain();
  level.gain.setValueAtTime(0.0001, at);
  level.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
  level.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  osc.connect(level).connect(out);
  osc.start(at);
  osc.stop(at + attack + decay + 0.05);
}

function panned(context: AudioContext, out: AudioNode, pan: number) {
  if (!pan || !context.createStereoPanner) return out;
  const p = context.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(out);
  return p;
}

// A recorded dig (ElevenLabs), licensed to this site only. Where the file is absent (the open-source copy has no audio)
// the strike falls back to the synthesised one below. Fetched at load and decoded once audio wakes, so the first strike
// plays on time; played through the same reverbs as everything else, so it rings on in a cavern. Decoded in a throwaway
// offline context (as the engine does its samples), since a live one may not exist yet; a buffer plays in any context.
const DIG = "/assets/27-burrow/dig.mp3";
// The clip opens on a fifth of a second of silence.
const DIG_ONSET = 0.2;
let digLoading = false;
let digBuffer: AudioBuffer | null = null;

export function preloadDig() {
  if (digLoading) return;
  digLoading = true;
  const Offline = window.OfflineAudioContext;
  void fetch(DIG)
    .then((answer) => (answer.ok ? answer.arrayBuffer() : null))
    .then((data) => (data && Offline ? new Offline(1, 1, 44100).decodeAudioData(data) : null))
    .then((buffer) => (digBuffer = buffer))
    .catch(() => undefined);
}

// The pick going in: the recorded dig, a little higher or lower each time so a run of strikes never repeats, and a low
// thump through the cliff. Without the recording, a synthesised chink of steel on stone and the rock crumbling away.
// `hollow` (0 to 1) is how near an unopened cavern is: the rock then booms.
export function strike(hollow: number, pan = 0) {
  shot((context, into, at) => {
    const out = panned(context, into, pan * 0.5);
    const r = Math.random;
    const p = 0.9 + r() * 0.2;
    const recorded = digBuffer;
    if (recorded) {
      const source = context.createBufferSource();
      source.buffer = recorded;
      source.playbackRate.value = 0.92 + r() * 0.16;
      const level = context.createGain();
      level.gain.value = 0.9;
      source.connect(level);
      level.connect(out);
      source.start(at, DIG_ONSET);
      tone(context, out, at, "sine", 120 * p, 52, 0.002, 0.16, 0.3);
      if (hollow > 0.02) boom(context, out, at, p, hollow);
      return;
    }
    // Steel on stone.
    burst(context, out, at, { freq: 3800 * p, q: 6, attack: 0.0008, decay: 0.05, gain: 0.32 });
    tone(context, out, at, "triangle", 2650 * p, 2500 * p, 0.0008, 0.09, 0.05);
    tone(context, out, at, "sine", 4100 * p, 3900 * p, 0.0008, 0.06, 0.025);
    // The crack and the crumble: a cluster of tiny grainy bursts over a fifth of a second.
    burst(context, out, at + 0.004, { freq: 1500 * p, q: 0.9, attack: 0.002, decay: 0.09, gain: 0.5, sweep: 600 });
    for (let i = 0; i < 18; i++) {
      const t = at + 0.01 + Math.pow(r(), 1.6) * 0.32;
      burst(context, out, t, { freq: (700 + r() * 3200) * p, q: 2.2, attack: 0.0006, decay: 0.006 + r() * 0.02, gain: (0.05 + r() * 0.14) * (1 - (t - at) * 2) });
    }
    // The thump.
    tone(context, out, at, "sine", 120 * p, 52, 0.002, 0.16, 0.55);
    burst(context, out, at, { freq: 260, q: 0.7, attack: 0.003, decay: 0.12, gain: 0.45, type: "lowpass" });
    if (hollow > 0.02) boom(context, out, at, p, hollow);
  });
}

// Close to a cavern, the rock is thin over a hollow and rings low.
function boom(context: AudioContext, out: AudioNode, at: number, p: number, hollow: number) {
  tone(context, out, at + 0.005, "sine", 175 * p, 150 * p, 0.004, 0.55, 0.35 * hollow);
  tone(context, out, at + 0.005, "triangle", 92 * p, 84 * p, 0.006, 0.7, 0.3 * hollow);
  burst(context, out, at + 0.01, { freq: 230, q: 6, attack: 0.01, decay: 0.5, gain: 0.18 * hollow });
}

// Pebbles landing: small knocks, then their echo.
export function pebble(size: number, pan = 0) {
  shot((context, into, at) => {
    const out = panned(context, into, pan * 0.6);
    const f = 1 / Math.max(0.3, size * 12);
    burst(context, out, at, { freq: (1900 + Math.random() * 1600) * f, q: 4, attack: 0.0005, decay: 0.02 + Math.random() * 0.02, gain: 0.07 + size * 1.2 });
    tone(context, out, at, "sine", 600 * f + 220, 400 * f + 150, 0.0005, 0.03, 0.05);
  });
}

// A drop of water falling into a pool: the plink of a bubble ringing at the surface.
export function drip(pan = 0, level = 1) {
  shot((context, into, at) => {
    const out = panned(context, into, pan);
    const f = 1100 + Math.random() * 1500;
    tone(context, out, at, "sine", f, f * 1.9, 0.002, 0.07, 0.11 * level);
    burst(context, out, at, { freq: 3000, q: 1.5, attack: 0.0005, decay: 0.008, gain: 0.03 * level });
  });
}

// Breaking into a cavern: the wall giving way in a rumble and a rush of air as the pressure evens out, rubble falling
// in, and the cavern's own voice: shimmer for the glow-worms, glassy rings for the geode, lapping for the lake, a
// long creak of timber for the mine, a deep stone note for the fossils.
export function breakthrough(kind: string) {
  shot((context, out, at) => {
    const r = Math.random;
    tone(context, out, at, "sine", 70, 34, 0.02, 1.6, 0.7);
    burst(context, out, at, { freq: 180, q: 0.6, attack: 0.03, decay: 1.4, gain: 0.7, type: "lowpass", sweep: 60 });
    burst(context, out, at + 0.05, { freq: 900, q: 0.5, attack: 0.35, decay: 1.8, gain: 0.22, sweep: 260 });
    for (let i = 0; i < 26; i++) {
      const t = at + 0.1 + Math.pow(r(), 1.4) * 1.6;
      burst(context, out, t, { freq: 500 + r() * 2600, q: 3, attack: 0.0006, decay: 0.01 + r() * 0.03, gain: 0.05 + r() * 0.16 });
    }
    const later = at + 0.9;
    if (kind === "grotto") for (let i = 0; i < 9; i++) tone(context, out, later + i * 0.21 + r() * 0.1, "sine", 2093 * Math.pow(2, Math.floor(r() * 5) / 12), 2093, 0.08, 1.4, 0.025);
    if (kind === "geode") for (let i = 0; i < 7; i++) tone(context, out, later + i * 0.15 + r() * 0.08, "sine", 2637 * (1 + r() * 0.6), 2637, 0.002, 1.1, 0.05);
    if (kind === "lake") for (let i = 0; i < 6; i++) burst(context, out, later + i * 0.45 + r() * 0.2, { freq: 420 + r() * 300, q: 1.2, attack: 0.12, decay: 0.4, gain: 0.08 });
    if (kind === "mine") for (let i = 0; i < 14; i++) tone(context, out, later + 0.3 + i * 0.03, "sawtooth", 210 + i * 3, 205 + i * 3, 0.004, 0.03, 0.025);
    if (kind === "fossil") tone(context, out, later, "triangle", 98, 96, 0.4, 2.2, 0.12);
    // Glowing fungi: a soft shimmer of high, slow-swelling notes.
    if (kind === "mushrooms")
      for (let i = 0; i < 6; i++) tone(context, out, later + i * 0.3, "sine", 1568 * Math.pow(2, [0, 4, 7, 11, 14, 19][i] / 12), 1568 * Math.pow(2, [0, 4, 7, 11, 14, 19][i] / 12), 0.5, 2.4, 0.03);
    // Giant crystals: long glassy rings, like a finger on a wine glass.
    if (kind === "selenite") for (let i = 0; i < 4; i++) tone(context, out, later + i * 0.5, "sine", [880, 1318, 1760, 2637][i], [880, 1318, 1760, 2637][i] * 1.002, 0.3, 3.5, 0.05);
    // Bones: a hollow clatter settling.
    if (kind === "bones") for (let i = 0; i < 10; i++) burst(context, out, later + Math.pow(r(), 1.5) * 1.2, { freq: 900 + r() * 900, q: 5, attack: 0.001, decay: 0.05 + r() * 0.05, gain: 0.08 });
    // A camp: a tin cup knocked over, rolling, and the fire's soft whump as the air reaches it.
    if (kind === "camp") {
      for (let i = 0; i < 5; i++) tone(context, out, later + i * 0.12 + r() * 0.04, "triangle", 1700 - i * 60, 1650 - i * 60, 0.001, 0.15, 0.05 / (i + 1));
      burst(context, out, later + 0.2, { freq: 400, q: 0.6, attack: 0.08, decay: 0.6, gain: 0.12, type: "lowpass", sweep: 900 });
    }
    // A doorway: a deep stone groan and a breath of air out of the dark.
    if (kind === "temple") {
      tone(context, out, later, "sawtooth", 55, 48, 0.6, 2.6, 0.05);
      burst(context, out, later + 0.3, { freq: 300, q: 0.5, attack: 0.8, decay: 2.2, gain: 0.12, type: "lowpass" });
    }
    // Molten rock: a low roar and bubbling.
    if (kind === "lava") {
      burst(context, out, later, { freq: 120, q: 0.5, attack: 0.5, decay: 3, gain: 0.35, type: "lowpass" });
      for (let i = 0; i < 8; i++) tone(context, out, later + r() * 2, "sine", 60 + r() * 40, 120, 0.02, 0.12, 0.08);
    }
    // A dinosaur's tomb: a deep stone note swelling under a slow, dry rattle, like a heavy bone settling.
    if (kind === "dino") {
      tone(context, out, later, "triangle", 73, 70, 0.6, 3, 0.11);
      tone(context, out, later + 0.2, "sine", 110, 108, 0.8, 2.6, 0.05);
      for (let i = 0; i < 7; i++) burst(context, out, later + 0.5 + i * 0.16 + r() * 0.08, { freq: 700 + r() * 500, q: 6, attack: 0.001, decay: 0.06, gain: 0.05 });
    }
    // Giant ammonites: the fossil wall's stone note, and a softer one a fifth above.
    if (kind === "ammonites") {
      tone(context, out, later, "triangle", 98, 96, 0.4, 2.2, 0.1);
      tone(context, out, later + 0.4, "sine", 147, 146, 0.5, 2.4, 0.04);
    }
    // A crystal pool: drops falling into still water, each a soft plink ringing on.
    if (kind === "pool")
      for (let i = 0; i < 6; i++) {
        const f = 1300 + r() * 900;
        tone(context, out, later + i * 0.33 + r() * 0.12, "sine", f * 1.25, f, 0.002, 0.5, 0.035);
      }
    // Water: the roar arrives by itself (see rushing); a splash as the wall falls in.
    if (kind === "river") burst(context, out, later, { freq: 1200, q: 0.4, attack: 0.05, decay: 1.2, gain: 0.2 });
  });
}

// A lantern set down and lit: a tin clank and the wick catching.
export function lantern() {
  shot((context, out, at) => {
    tone(context, out, at, "triangle", 1450, 1380, 0.001, 0.18, 0.08);
    tone(context, out, at, "triangle", 2210, 2150, 0.001, 0.12, 0.04);
    burst(context, out, at, { freq: 2600, q: 3, attack: 0.001, decay: 0.03, gain: 0.12 });
    burst(context, out, at + 0.12, { freq: 900, q: 0.6, attack: 0.06, decay: 0.35, gain: 0.12, sweep: 2200 });
  });
}

// The pick bouncing off rock too hard (or too far) to dig.
export function clink() {
  shot((context, out, at) => {
    burst(context, out, at, { freq: 4200, q: 8, attack: 0.0006, decay: 0.03, gain: 0.12 });
    tone(context, out, at, "triangle", 3100, 3000, 0.0006, 0.15, 0.03);
  });
}

// A footfall on grit, through the rooms.
export function footstep(pan = 0) {
  shot((context, into, at) => {
    const out = panned(context, into, pan);
    const r = Math.random;
    burst(context, out, at, { freq: 240, q: 0.8, attack: 0.006, decay: 0.09, gain: 0.5, type: "lowpass" });
    for (let i = 0; i < 9; i++) burst(context, out, at + 0.02 + r() * 0.1, { freq: 900 + r() * 2400, q: 2.5, attack: 0.0008, decay: 0.008 + r() * 0.012, gain: 0.05 + r() * 0.07 });
  });
}

// Bats: thin high squeaks, each a quick falling chirp, a few at a time.
export function squeaks(count: number, spread: number) {
  shot((context, out, at) => {
    for (let i = 0; i < count; i++) {
      const t = at + Math.random() * spread;
      const f = 5200 + Math.random() * 3600;
      const p = panned(context, out, Math.random() * 2 - 1);
      tone(context, p, t, "sine", f, f * 0.7, 0.002, 0.025 + Math.random() * 0.02, 0.035);
    }
  });
}

// Wings beating past close by: a soft papery flutter.
export function flutter(level: number, pan = 0) {
  shot((context, into, at) => {
    const out = panned(context, into, pan);
    for (let i = 0; i < 6; i++) burst(context, out, at + i * 0.045, { freq: 700 + Math.random() * 500, q: 0.9, attack: 0.008, decay: 0.03, gain: 0.12 * level });
  });
}

// A torch catching: the whoomph of pitch taking flame.
export function ignite() {
  shot((context, out, at) => {
    burst(context, out, at, { freq: 500, q: 0.6, attack: 0.04, decay: 0.5, gain: 0.3, type: "lowpass", sweep: 1800 });
    burst(context, out, at + 0.02, { freq: 2400, q: 0.8, attack: 0.02, decay: 0.25, gain: 0.08 });
    tone(context, out, at, "sine", 90, 60, 0.03, 0.3, 0.2);
  });
}

// A burning torch: pops and spits of resin, one at a time, `level` by how near it is.
export function crackle(level: number) {
  shot((context, out, at) => {
    const r = Math.random;
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) burst(context, out, at + r() * 0.05, { freq: 1800 + r() * 3500, q: 2, attack: 0.0005, decay: 0.004 + r() * 0.012, gain: (0.05 + r() * 0.12) * level });
    if (r() < 0.3) burst(context, out, at, { freq: 300, q: 0.7, attack: 0.02, decay: 0.15, gain: 0.05 * level, type: "lowpass" });
  });
}

// Running water heard through the rock and then in the open: a river's rush and a fall's roar, `level` from 0 (none
// near) to 1 (at its foot). Made on first use, then only its level changes.
let river: { gain: GainNode; context: AudioContext } | null = null;
export function rushing(level: number) {
  if (!river) {
    if (level <= 0.01) return;
    sound.custom((context, master, at) => {
      const b = ensureBus(context, master);
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(b.dry);
      gain.connect(b.send);
      for (const [freq, q, amount] of [
        [380, 0.6, 0.5],
        [1400, 0.7, 0.25],
        [5200, 0.9, 0.08]
      ]) {
        const source = context.createBufferSource();
        source.buffer = noise(context);
        source.loop = true;
        const filter = context.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = freq;
        filter.Q.value = q;
        const part = context.createGain();
        part.gain.value = amount;
        source.connect(filter).connect(part).connect(gain);
        source.start(at, Math.random());
      }
      river = { gain, context };
    });
    return;
  }
  river.gain.gain.setTargetAtTime(level * level * 0.45, river.context.currentTime, 0.3);
}

// A foot on slick wet rock: a soft slap, a squelch of grit, a drop flicked off.
export function wetStep(pan = 0) {
  shot((context, into, at) => {
    const out = panned(context, into, pan);
    burst(context, out, at, { freq: 320, q: 0.7, attack: 0.004, decay: 0.07, gain: 0.45, type: "lowpass" });
    burst(context, out, at + 0.01, { freq: 1600, q: 1.2, attack: 0.008, decay: 0.09, gain: 0.12, sweep: 700 });
    if (Math.random() < 0.5) tone(context, out, at + 0.08, "sine", 1400 + Math.random() * 600, 2400, 0.002, 0.05, 0.05);
  });
}

// Wading: water pushed aside and closing behind the foot.
export function splashStep(pan = 0) {
  shot((context, into, at) => {
    const out = panned(context, into, pan);
    burst(context, out, at, { freq: 900, q: 0.5, attack: 0.02, decay: 0.25, gain: 0.35, sweep: 400 });
    burst(context, out, at + 0.05, { freq: 2600, q: 0.8, attack: 0.01, decay: 0.15, gain: 0.12 });
    for (let i = 0; i < 4; i++) tone(context, out, at + 0.04 + Math.random() * 0.2, "sine", 900 + Math.random() * 900, 1800, 0.002, 0.04, 0.04);
  });
}

// Picking something up. Four layers, each landing with what is seen: the find in the hand (a clink of metal for gold
// and coins, a glassy ring for gems, a hollow knock for fossils and flint, a soft tock for amber), a chime that runs
// up further and brighter the rarer it is, a breath of air as it flies past into the pack, and for a rare one a
// fanfare. Picks in quick succession climb a major scale, a combo, like Labyrinth's coins.
type Matter = "metal" | "iron" | "crystal" | "stone" | "resin";
const MATTER: Record<string, Matter> = {
  nugget: "metal",
  coin: "metal",
  compass: "metal",
  watch: "metal",
  idol: "metal",
  meteorite: "iron",
  quartz: "crystal",
  emerald: "crystal",
  ruby: "crystal",
  amethyst: "crystal",
  sapphire: "crystal",
  diamond: "crystal",
  shard: "crystal",
  fossil: "stone",
  trilobite: "stone",
  tooth: "stone",
  arrowhead: "stone",
  amber: "resin"
};
// How high each rings: small things high, big and heavy ones lower.
const PITCH: Record<string, number> = { coin: 1.1, idol: 0.55, watch: 0.9, compass: 0.8, quartz: 0.85, amethyst: 0.65, diamond: 1.35, shard: 0.75, sapphire: 1.15, tooth: 1.2, arrowhead: 1.3, trilobite: 0.9 };
const TIERS: Record<string, number> = { Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Legendary: 4 };
const COMBO = [0, 2, 4, 5, 7, 9, 11, 12];
const ARPEGGIO = [0, 4, 7, 12, 16, 19, 24];
let streak = 0;
let lastPick = -1e9;
// Finds sit over the music (useMusic at 0.42, about 6 dB up on the 0.2 these were first voiced against): 1.65× is
// about 4.4 dB, which keeps a find clearly on top without the legendary fanfare slamming the limiter.
const FIND_LEVEL = 1.65;
function lifted(context: AudioContext, out: AudioNode) {
  const level = context.createGain();
  level.gain.value = FIND_LEVEL;
  level.connect(out);
  return level;
}
let bunch = 0;

export function pickup(kind: string, rarity: string) {
  const now = performance.now();
  // Several out of one strike at once go one after another, a beat apart, rather than in a heap.
  bunch = now - lastPick < 120 ? bunch + 1 : 0;
  streak = now - lastPick < 1400 ? Math.min(COMBO.length - 1, streak + 1) : 0;
  lastPick = now;
  const later = Math.min(bunch, 4) * 0.11;
  const climb = Math.pow(2, COMBO[streak] / 12);
  const tier = TIERS[rarity] ?? 0;
  const matter = MATTER[kind] ?? "stone";
  const heft = PITCH[kind] ?? 1;
  shot((context, into, now) => {
    const out = lifted(context, into);
    const r = Math.random;
    const at = now + later;
    held(context, out, at, matter, heft * (0.97 + r() * 0.06));
    // The chime: two notes for a common find up to six for a legendary one, from C6 (raised by the combo), a glockenspiel
    // for metal, glass for gems, a marimba for stone and amber.
    const root = 1046.5 * climb;
    const notes = 2 + tier;
    const gap = 0.05 + tier * 0.006;
    for (let i = 0; i < notes; i++) {
      const t = at + 0.035 + i * gap;
      const f = root * Math.pow(2, ARPEGGIO[i] / 12);
      const ring = 0.3 + i * 0.05 + tier * 0.08;
      if (matter === "stone" || matter === "resin") {
        tone(context, out, t, "sine", f, f, 0.002, 0.18, 0.09);
        tone(context, out, t, "sine", f * 4, f * 4, 0.001, 0.035, 0.018);
      } else if (matter === "crystal") {
        tone(context, out, t, "sine", f, f, 0.002, ring + 0.2, 0.075);
        tone(context, out, t, "sine", f * 1.004, f * 1.004, 0.002, ring + 0.2, 0.03);
        tone(context, out, t, "sine", f * 4, f * 4, 0.001, 0.14, 0.012);
      } else {
        tone(context, out, t, "triangle", f, f, 0.0015, ring, 0.08);
        tone(context, out, t, "sine", f * 2.76, f * 2.76, 0.001, 0.12, 0.016);
      }
      if (tier >= 1) tone(context, out, t, "triangle", f * 2, f * 2, 0.002, 0.12, 0.018);
      if (tier >= 2) tone(context, out, t, "sine", f * 3.002, f * 3.002, 0.002, 0.5, 0.01);
    }
    // A last high glint on top.
    const top = at + 0.035 + notes * gap;
    tone(context, out, top, "sine", root * 4, root * 4, 0.001, 0.22, 0.03);
    // Into the pack: air rising past the right ear as the find flies down past the corner of the view.
    burst(context, panned(context, out, 0.45), at + 0.1, { freq: 500, q: 1.1, attack: 0.22, decay: 0.24, gain: 0.07 + tier * 0.012, sweep: 2600 });
    if (tier >= 2) fanfare(context, out, at, root, tier);
  });
}

// The find itself in the hand, picked out of the rock.
function held(context: AudioContext, out: AudioNode, at: number, matter: Matter, p: number) {
  const r = Math.random;
  if (matter === "metal" || matter === "iron") {
    // A small bell's inharmonic partials, struck twice as it knocks against the pick (coin on coin).
    const f = (matter === "iron" ? 820 : 1850) * p;
    burst(context, out, at, { freq: 6500, q: 3, attack: 0.0005, decay: 0.012, gain: 0.12 });
    for (const [k, g] of [
      [0, 1],
      [0.045 + r() * 0.02, 0.45]
    ]) {
      const s = k ? 1.06 : 1;
      tone(context, out, at + k, "sine", f * s, f * s, 0.0012, matter === "iron" ? 1.1 : 0.9, 0.09 * g);
      tone(context, out, at + k, "sine", f * 2.76 * s, f * 2.76 * s, 0.001, 0.5, 0.05 * g);
      tone(context, out, at + k, "sine", f * 5.4 * s, f * 5.4 * s, 0.001, 0.3, 0.03 * g);
      tone(context, out, at + k, "sine", f * 8.93 * s, f * 8.93 * s, 0.001, 0.18, 0.015 * g);
    }
    if (matter === "iron") tone(context, out, at, "sine", 140, 70, 0.002, 0.18, 0.2);
  } else if (matter === "crystal") {
    // Glass: a clean ring with a slow beat between two near partials, after a tiny tick.
    const f = 2300 * p;
    burst(context, out, at, { freq: 8000, q: 5, attack: 0.0005, decay: 0.006, gain: 0.06 });
    tone(context, out, at, "sine", f, f, 0.0015, 1.6, 0.07);
    tone(context, out, at, "sine", f * 1.004, f * 1.004, 0.0015, 1.6, 0.05);
    tone(context, out, at, "sine", f * 2.32, f * 2.32, 0.0015, 1.1, 0.045);
    tone(context, out, at, "sine", f * 4.25, f * 4.25, 0.001, 0.6, 0.025);
  } else {
    // Stone and bone: a hollow knock, and a second as it rattles in the hand; amber is softer and warmer.
    const soft = matter === "resin";
    const f = (soft ? 360 : 520) * p;
    for (const [k, g] of [
      [0, 1],
      [0.065 + r() * 0.02, 0.55]
    ]) {
      const s = k ? 0.86 : 1;
      tone(context, out, at + k, "sine", f * s, f * s * 0.82, 0.001, soft ? 0.11 : 0.09, 0.22 * g);
      tone(context, out, at + k, "triangle", f * 2.27 * s, f * 2.1 * s, 0.001, 0.04, 0.06 * g);
      burst(context, out, at + k, { freq: (soft ? 600 : 900) * s, q: soft ? 2 : 5, attack: 0.001, decay: 0.05, gain: 0.16 * g });
    }
    if (p > 1.2) burst(context, out, at, { freq: 4200, q: 6, attack: 0.0005, decay: 0.02, gain: 0.1 });
    if (soft) tone(context, out, at + 0.02, "sine", 1568, 1568, 0.004, 0.5, 0.03);
  }
}

// Something rare: a cascade of high sparkles; an epic find adds a brass sting over a low swell, and a legendary one a
// two-stroke fanfare (the dominant, then the tonic held) over a timpani.
function fanfare(context: AudioContext, out: AudioNode, at: number, root: number, tier: number) {
  const r = Math.random;
  const n = tier === 2 ? 6 : tier === 3 ? 10 : 14;
  const pent = [0, 2, 4, 7, 9];
  for (let i = 0; i < n; i++) {
    const step = pent[Math.floor(r() * 5)] + 12 * Math.floor(r() * 2);
    const f = root * 2 * Math.pow(2, step / 12);
    tone(context, panned(context, out, r() * 1.4 - 0.7), at + 0.28 + i * 0.045, "sine", f, f * 1.002, 0.002, 0.5 + tier * 0.15, 0.022);
  }
  tone(context, out, at, "sine", 220, 220, 0.08, 0.9, 0.05);
  if (tier < 3) return;
  const c = root / 4;
  tone(context, out, at + 0.2, "sine", 130, 65, 0.01, 0.6 + (tier - 3) * 0.5, 0.16);
  if (tier === 3) {
    for (const s of [0, 4, 7]) brass(context, out, at + 0.24, c * Math.pow(2, s / 12), 0.9, 0.04);
    return;
  }
  for (const s of [-5, -1, 2]) brass(context, out, at + 0.24, c * Math.pow(2, s / 12), 0.16, 0.04);
  for (const s of [0, 4, 7, 12]) brass(context, out, at + 0.44, c * Math.pow(2, s / 12), 1.6, 0.036);
  burst(context, out, at + 0.44, { freq: 140, q: 0.7, attack: 0.01, decay: 0.7, gain: 0.25, type: "lowpass" });
  tone(context, out, at + 0.44, "sine", 98, 60, 0.005, 0.9, 0.24);
  // A shimmer swelling over the held chord.
  for (const s of [24, 28, 31]) tone(context, out, at + 0.5, "sine", c * Math.pow(2, s / 12), c * Math.pow(2, s / 12) * 1.003, 0.45, 1.8, 0.018);
}

// A brass voice: two detuned saws through a low-pass that opens on the attack and settles, as a horn's tone does.
function brass(context: AudioContext, out: AudioNode, at: number, f: number, length: number, gain: number) {
  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(400, at);
  filter.frequency.exponentialRampToValueAtTime(2800, at + 0.05);
  filter.frequency.setTargetAtTime(1100, at + 0.08, length * 0.4);
  const level = context.createGain();
  level.gain.setValueAtTime(0.0001, at);
  level.gain.exponentialRampToValueAtTime(gain, at + 0.035);
  level.gain.setValueAtTime(gain, at + Math.max(0.04, length - 0.25));
  level.gain.exponentialRampToValueAtTime(0.0001, at + length);
  filter.connect(level).connect(out);
  for (const detune of [-7, 7]) {
    const osc = context.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = f;
    osc.detune.value = detune;
    osc.connect(filter);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }
}

// A find landing in the pack (its card reaching the button): a soft leather thump and a small tick.
export function stow(tier: number) {
  shot((context, into, at) => {
    const out = panned(context, lifted(context, into), 0.5);
    tone(context, out, at, "sine", 170, 90, 0.003, 0.1, 0.16);
    burst(context, out, at, { freq: 500, q: 0.8, attack: 0.002, decay: 0.07, gain: 0.1, type: "lowpass" });
    tone(context, out, at + 0.015, "sine", 2093 * (1 + tier * 0.06), 2093, 0.001, 0.06, 0.03);
  });
}
