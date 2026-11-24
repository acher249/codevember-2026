import { sound } from "../../shared/engine/sound";

// The nest's sounds, synthesised on the engine's context. Chicks peep: thin, rising-then-falling whistles. The dial's
// detents: a crisp little click with a ring of steel in it. Meltwater dripping: a soft plink. Panting: quick breaths.

let noise: AudioBuffer | null = null;
function grain(context: AudioContext) {
  if (noise && noise.sampleRate === context.sampleRate) return noise;
  noise = context.createBuffer(1, Math.floor(context.sampleRate * 1.5), context.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

const panned = (context: AudioContext, out: AudioNode, pan: number) => {
  const p = context.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(out);
  window.setTimeout(() => p.disconnect(), 3000);
  return p;
};

const whistle = (context: AudioContext, into: AudioNode, at: number, f0: number, f1: number, f2: number, length: number, level: number) => {
  const osc = context.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(f0, at);
  osc.frequency.linearRampToValueAtTime(f1, at + length * 0.35);
  osc.frequency.exponentialRampToValueAtTime(f2, at + length);
  // A little buzz of the second harmonic, as a real chick's voice has.
  const shape = context.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2 - 1;
    curve[i] = Math.tanh(x * 1.6);
  }
  shape.curve = curve;
  const env = context.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + 0.008);
  env.gain.setValueAtTime(level, at + length * 0.6);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(shape);
  shape.connect(env);
  env.connect(into);
  osc.start(at);
  osc.stop(at + length + 0.02);
};

// One peep from a chick; `pitch` is the chick's own voice, `pan` where it sits.
export function peep(pitch: number, pan: number, level = 1) {
  sound.custom((context, out, at) => {
    const into = panned(context, out, pan);
    const f = 3400 * pitch * (0.94 + Math.random() * 0.12);
    const length = 0.07 + Math.random() * 0.06;
    whistle(context, into, at, f * 0.9, f * 1.12, f * 0.78, length, 0.16 * level);
  });
}

// One detent of the dial: a crisp tick of a spring catch, a touch higher as it is turned warmer.
export function detent(warmth: number, pan: number) {
  sound.custom((context, out, at) => {
    const into = panned(context, out, pan);
    const src = context.createBufferSource();
    src.buffer = grain(context);
    const high = context.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 3800;
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.5, at + 0.0015);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.018);
    src.connect(high);
    high.connect(env);
    env.connect(into);
    src.start(at, Math.random());
    src.stop(at + 0.03);
    // The ring of the steel.
    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 2300 + warmth * 500;
    const ring = context.createGain();
    ring.gain.setValueAtTime(0, at);
    ring.gain.linearRampToValueAtTime(0.06, at + 0.002);
    ring.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(ring);
    ring.connect(into);
    osc.start(at);
    osc.stop(at + 0.06);
  });
}

// A drop of meltwater landing far below: a short falling plink.
export function plink(pan: number) {
  sound.custom((context, out, at) => {
    const into = panned(context, out, pan);
    const osc = context.createOscillator();
    osc.type = "sine";
    const f = 1300 + Math.random() * 900;
    osc.frequency.setValueAtTime(f, at);
    osc.frequency.exponentialRampToValueAtTime(f * 1.6, at + 0.03);
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.05, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
    osc.connect(env);
    env.connect(into);
    osc.start(at);
    osc.stop(at + 0.1);
  });
}

// One quick pant: a short breathy huff.
export function pant(pan: number) {
  sound.custom((context, out, at) => {
    const into = panned(context, out, pan);
    const src = context.createBufferSource();
    src.buffer = grain(context);
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 2600 + Math.random() * 600;
    band.Q.value = 1.4;
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.07, at + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
    src.connect(band);
    band.connect(env);
    env.connect(into);
    src.start(at, Math.random());
    src.stop(at + 0.13);
  });
}

// A cheerful chirp from a warm chick: one bright rising note, a quick pair, or a little trill, as the beak shows it
// (kind 0, 1, 2; lengths as CHIRP_LENGTH in chick.ts). Rounder than the cold peep: a sine with a touch of its octave,
// softened, each note sliding up then down.
const CHIRP_NOTES = [
  [[0, 0.16, 1]],
  [
    [0, 0.13, 1],
    [0.17, 0.15, 1.12]
  ],
  [
    [0, 0.06, 1],
    [0.07, 0.06, 1.06],
    [0.14, 0.06, 1.02],
    [0.21, 0.06, 1.1],
    [0.28, 0.06, 1.04],
    [0.35, 0.07, 1.14]
  ]
];
export function chirp(kind: number, pitch: number, pan: number, level = 1) {
  sound.custom((context, out, at) => {
    const into = panned(context, out, pan);
    const soft = context.createBiquadFilter();
    soft.type = "lowpass";
    soft.frequency.value = 6500;
    soft.connect(into);
    const base = 2400 * pitch * (0.92 + Math.random() * 0.16);
    for (const [t, length, step] of CHIRP_NOTES[kind] ?? CHIRP_NOTES[0]) {
      const f = base * step * (0.97 + Math.random() * 0.06);
      const when = at + t;
      for (const [mult, gain] of [
        [1, 0.07],
        [2, 0.012]
      ]) {
        const osc = context.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(f * mult * 0.82, when);
        osc.frequency.exponentialRampToValueAtTime(f * mult * 1.18, when + length * 0.45);
        osc.frequency.exponentialRampToValueAtTime(f * mult * 0.95, when + length);
        const env = context.createGain();
        env.gain.setValueAtTime(0, when);
        env.gain.linearRampToValueAtTime(gain * level, when + 0.012);
        env.gain.setValueAtTime(gain * level, when + length * 0.55);
        env.gain.exponentialRampToValueAtTime(0.0001, when + length);
        osc.connect(env);
        env.connect(soft);
        osc.start(when);
        osc.stop(when + length + 0.02);
      }
    }
  });
}
