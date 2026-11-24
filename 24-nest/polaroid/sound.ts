import { sound } from "../../shared/engine/sound";

// The nest's sounds, synthesised on the engine's context. Chicks peep: thin, rising-then-falling whistles, ragged when
// they all beg at once. Mum's wings: a soft whump of air on each downstroke. The photograph landing: a light papery
// tap and a little slide. And far off, birds singing in the spring tree, pigeons cooing round the building, an owl at
// dusk.

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

// A wingbeat: a short, low rush of air.
export function flap(level: number, pan: number) {
  sound.custom((context, out, at) => {
    const into = panned(context, out, pan);
    const src = context.createBufferSource();
    src.buffer = grain(context);
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(380, at);
    band.frequency.exponentialRampToValueAtTime(900, at + 0.05);
    band.frequency.exponentialRampToValueAtTime(260, at + 0.14);
    band.Q.value = 0.8;
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.55 * level, at + 0.025);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    src.connect(band);
    band.connect(env);
    env.connect(into);
    src.start(at, Math.random());
    src.stop(at + 0.2);
  });
}

// The photograph landing in the nest: a light tap, then a soft slide of card on grass.
export function drop() {
  sound.custom((context, out, at) => {
    const tap = (when: number, centre: number, level: number, decay: number) => {
      const src = context.createBufferSource();
      src.buffer = grain(context);
      const band = context.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = centre;
      band.Q.value = 1.2;
      const env = context.createGain();
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(level, when + 0.003);
      env.gain.exponentialRampToValueAtTime(0.0001, when + decay);
      src.connect(band);
      band.connect(env);
      env.connect(out);
      src.start(when, Math.random());
      src.stop(when + decay + 0.05);
    };
    tap(at, 1800, 0.5, 0.05);
    tap(at + 0.004, 600, 0.35, 0.08);
    tap(at + 0.09, 1300, 0.18, 0.04);
    // The slide.
    const src = context.createBufferSource();
    src.buffer = grain(context);
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 3200;
    band.Q.value = 0.6;
    const env = context.createGain();
    env.gain.setValueAtTime(0, at + 0.05);
    env.gain.linearRampToValueAtTime(0.08, at + 0.12);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
    src.connect(band);
    band.connect(env);
    env.connect(out);
    src.start(at + 0.05, Math.random());
    src.stop(at + 0.5);
  });
}

// The dive: a soft rising breath of air, as if falling into the picture.
export function dive(seconds: number) {
  sound.custom((context, out, at) => {
    const src = context.createBufferSource();
    src.buffer = grain(context);
    src.loop = true;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 0.7;
    band.frequency.setValueAtTime(300, at);
    band.frequency.exponentialRampToValueAtTime(1600, at + seconds);
    band.frequency.exponentialRampToValueAtTime(500, at + seconds + 1.2);
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.12, at + seconds * 0.8);
    env.gain.linearRampToValueAtTime(0.16, at + seconds);
    env.gain.exponentialRampToValueAtTime(0.0001, at + seconds + 1.4);
    src.connect(band);
    band.connect(env);
    env.connect(out);
    src.start(at);
    src.stop(at + seconds + 1.5);
  });
}

// Far-off birdsong in the spring tree: a phrase of quick whistled notes.
export function song(pan: number) {
  sound.custom((context, out, at) => {
    const into = panned(context, out, pan);
    const base = 2200 + Math.random() * 1800;
    const notes = 3 + Math.floor(Math.random() * 6);
    let t = at;
    for (let i = 0; i < notes; i++) {
      const f = base * (0.8 + Math.random() * 0.5);
      const length = 0.05 + Math.random() * 0.12;
      whistle(context, into, t, f, f * (1 + (Math.random() - 0.4) * 0.5), f * (0.7 + Math.random() * 0.5), length, 0.035);
      t += length + 0.02 + Math.random() * 0.06;
    }
  });
}

// A pigeon's coo, round the corner of the building: a low throaty roll.
export function coo(pan: number) {
  sound.custom((context, out, at) => {
    const into = panned(context, out, pan);
    const osc = context.createOscillator();
    osc.type = "triangle";
    const f = 210 + Math.random() * 40;
    osc.frequency.setValueAtTime(f, at);
    osc.frequency.linearRampToValueAtTime(f * 1.25, at + 0.25);
    osc.frequency.linearRampToValueAtTime(f * 0.9, at + 0.6);
    osc.frequency.linearRampToValueAtTime(f * 1.1, at + 0.75);
    osc.frequency.linearRampToValueAtTime(f * 0.85, at + 1.1);
    const trem = context.createOscillator();
    trem.frequency.value = 22;
    const depth = context.createGain();
    depth.gain.value = 0.35;
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.06, at + 0.08);
    env.gain.setValueAtTime(0.06, at + 0.9);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 1.2);
    const lp = context.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700;
    trem.connect(depth);
    depth.connect(env.gain);
    osc.connect(lp);
    lp.connect(env);
    env.connect(into);
    osc.start(at);
    trem.start(at);
    osc.stop(at + 1.25);
    trem.stop(at + 1.25);
  });
}
