// Magma's own sounds: the microwave's ding, the crunch of a bite (recorded where the file is present), the lava's sizzle
// and slow plops. Each is a one-shot through the engine (so it waits for audio to wake, and respects mute).

import { sound } from "../shared/engine/sound";

// A noise buffer per context, made once.
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

function burst(
  context: AudioContext,
  out: AudioNode,
  at: number,
  { freq, q, attack, decay, gain, type = "bandpass" as BiquadFilterType }: { freq: number; q: number; attack: number; decay: number; gain: number; type?: BiquadFilterType }
) {
  const source = context.createBufferSource();
  source.buffer = noise(context);
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const level = context.createGain();
  level.gain.setValueAtTime(0, at);
  level.gain.linearRampToValueAtTime(gain, at + attack);
  level.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  source.connect(filter).connect(level).connect(out);
  source.start(at, Math.random() * 1.5);
  source.stop(at + attack + decay + 0.05);
}

// The microwave's ding: a bell of two partials, struck three times like a microwave insisting it is done, the last
// left to ring out.
export function ding(strikes = 3, gap = 0.55) {
  sound.custom((context, out, at) => {
    for (let s = 0; s < strikes; s++) {
      const start = at + s * gap;
      const last = s === strikes - 1;
      for (const [freq, gain, decay] of [
        [1318, 0.16, 1.6],
        [2637, 0.05, 0.9],
        [3951, 0.025, 0.5]
      ]) {
        const ring = last ? decay : Math.min(decay, gap * 1.4);
        const tone = context.createOscillator();
        tone.frequency.value = freq;
        const level = context.createGain();
        level.gain.setValueAtTime(0, start);
        level.gain.linearRampToValueAtTime(gain, start + 0.004);
        level.gain.exponentialRampToValueAtTime(0.0001, start + ring);
        tone.connect(level).connect(out);
        tone.start(start);
        tone.stop(start + ring + 0.05);
      }
    }
  });
}

// A recorded bite (ElevenLabs), licensed to this site only. Where the file is absent (the open-source copy has no
// audio) the bite falls back to the synthesised crunch below.
const BITE = "/assets/23-magma/bite.mp3";
let recorded: boolean | undefined;

// Fetches the recorded bite at load, so the first bite plays on time, and notes whether it is there.
export function preloadBite() {
  if (recorded !== undefined) return;
  recorded = false;
  sound.preload(BITE);
  void fetch(BITE, { method: "HEAD" })
    .then((answer) => (recorded = answer.ok))
    .catch(() => undefined);
}

// A bite through crisp pastry.
export function crunch() {
  if (recorded) {
    sound.sample(BITE, 0.9);
    return;
  }
  synthCrunch();
}

// A dozen dry crackles over a sixth of a second, and a soft thud of the jaw.
function synthCrunch() {
  sound.custom((context, out, at) => {
    for (let i = 0; i < 14; i++) {
      const t = at + Math.pow(Math.random(), 1.3) * 0.17;
      burst(context, out, t, { freq: 1800 + Math.random() * 3500, q: 1.5 + Math.random() * 2, attack: 0.001, decay: 0.01 + Math.random() * 0.03, gain: 0.08 + Math.random() * 0.12 });
    }
    burst(context, out, at, { freq: 320, q: 0.8, attack: 0.004, decay: 0.12, gain: 0.25, type: "lowpass" });
  });
}

// The hiss of something wet and very hot: a short airy burst, brighter the hotter.
export function sizzle(strength: number) {
  // A gain of NaN throws inside Web Audio: only a finite strength makes a sound.
  if (!Number.isFinite(strength) || strength <= 0) return;
  strength = Math.min(1, strength);
  sound.custom((context, out, at) => {
    burst(context, out, at, { freq: 5200 + Math.random() * 2500, q: 0.6, attack: 0.03 + Math.random() * 0.05, decay: 0.3 + Math.random() * 0.4, gain: 0.05 * strength });
    // Little pops of steam in it.
    for (let i = 0; i < 4; i++) burst(context, out, at + Math.random() * 0.35, { freq: 2500 + Math.random() * 3000, q: 4, attack: 0.001, decay: 0.008, gain: 0.05 * strength });
  });
}

// A slow bubble bursting in thick lava: a low pitched-down plop.
export function plop(strength: number) {
  // A gain of NaN throws inside Web Audio: only a finite strength makes a sound.
  if (!Number.isFinite(strength) || strength <= 0) return;
  strength = Math.min(1, strength);
  sound.custom((context, out, at) => {
    const tone = context.createOscillator();
    tone.type = "sine";
    const f = 110 + Math.random() * 90;
    tone.frequency.setValueAtTime(f * 1.8, at);
    tone.frequency.exponentialRampToValueAtTime(f * 0.6, at + 0.12);
    const level = context.createGain();
    level.gain.setValueAtTime(0, at);
    level.gain.linearRampToValueAtTime(0.22 * strength, at + 0.008);
    level.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    tone.connect(level).connect(out);
    tone.start(at);
    tone.stop(at + 0.2);
    burst(context, out, at + 0.01, { freq: 900, q: 1, attack: 0.002, decay: 0.05, gain: 0.06 * strength });
  });
}

// A crumb catching: the soft rush of flame taking hold, and a few dry crackles as it bursts.
export function catchFire(strength: number) {
  if (!Number.isFinite(strength) || strength <= 0) return;
  strength = Math.min(1, strength);
  sound.custom((context, out, at) => {
    burst(context, out, at, { freq: 380 + Math.random() * 200, q: 0.7, attack: 0.05, decay: 0.35, gain: 0.12 * strength, type: "lowpass" });
    for (let i = 0; i < 5; i++) {
      const t = at + 0.02 + Math.pow(Math.random(), 1.5) * 0.3;
      burst(context, out, t, { freq: 1500 + Math.random() * 3500, q: 2 + Math.random() * 3, attack: 0.001, decay: 0.006 + Math.random() * 0.014, gain: (0.05 + Math.random() * 0.08) * strength });
    }
  });
}

// One pop of burning pastry: a sharp click with a little body.
export function crackle(strength: number) {
  if (!Number.isFinite(strength) || strength <= 0) return;
  strength = Math.min(1, strength);
  sound.custom((context, out, at) => {
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++)
      burst(context, out, at + i * (0.01 + Math.random() * 0.03), { freq: 1200 + Math.random() * 4000, q: 2 + Math.random() * 4, attack: 0.0008, decay: 0.004 + Math.random() * 0.012, gain: (0.04 + Math.random() * 0.07) * strength });
  });
}

// A pizza roll landing on the paper plate: a soft dull tap with a papery tick on top.
export function thud(strength: number) {
  if (!Number.isFinite(strength) || strength <= 0) return;
  strength = Math.min(1, strength);
  sound.custom((context, out, at) => {
    burst(context, out, at, { freq: 260 + Math.random() * 120, q: 0.9, attack: 0.002, decay: 0.07, gain: 0.3 * strength, type: "lowpass" });
    burst(context, out, at, { freq: 2200 + Math.random() * 1500, q: 1.5, attack: 0.001, decay: 0.012, gain: 0.06 * strength });
  });
}
