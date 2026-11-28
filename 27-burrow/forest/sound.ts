// The forest's sounds, all synthesised: birds singing in the trees round the clearing (a blackbird's fluted phrases, a
// chiffchaff's two notes, a wren's trill, a wood pigeon far off, now and then a woodpecker drumming), gusts going
// through the leaves, and footfalls on dry leaves and grass. Everything fades as the visitor goes underground.

import { sound } from "../../shared/engine/sound";

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

// A sung note: a sine gliding through the given pitches (in Hz, evenly over its length), with a little vibrato.
function note(context: AudioContext, out: AudioNode, at: number, pitches: number[], length: number, gain: number, vibrato = 0) {
  const osc = context.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(pitches[0], at);
  pitches.slice(1).forEach((f, i) => osc.frequency.exponentialRampToValueAtTime(f, at + (length * (i + 1)) / (pitches.length - 1)));
  if (vibrato) {
    const lfo = context.createOscillator();
    lfo.frequency.value = 28 + Math.random() * 10;
    const depth = context.createGain();
    depth.gain.value = pitches[0] * vibrato;
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(at);
    lfo.stop(at + length + 0.05);
  }
  const level = context.createGain();
  level.gain.setValueAtTime(0.0001, at);
  level.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.012, length * 0.25));
  level.gain.setValueAtTime(gain, at + length * 0.7);
  level.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(level).connect(out);
  osc.start(at);
  osc.stop(at + length + 0.05);
}

// Somewhere in the trees: panned, and softened by distance (quieter and duller further off).
function place(context: AudioContext, out: AudioNode, pan: number, far: number) {
  const p = context.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  const dull = context.createBiquadFilter();
  dull.type = "lowpass";
  dull.frequency.value = 9000 - far * 6000;
  const level = context.createGain();
  level.gain.value = 1 - far * 0.7;
  p.connect(dull).connect(level).connect(out);
  return p;
}

// How far out in the open the listener is (1 in the clearing, 0 underground), for everything here.
let open = 1;
export function setOutside(amount: number) {
  open = amount;
}

const r = Math.random;

// The birds, each a call of its own.
const SONGS: ((context: AudioContext, out: AudioNode, at: number) => number)[] = [
  // A blackbird: a few low fluted notes sliding about, then a quick twittering end.
  (context, out, at) => {
    let t = at;
    const base = 1500 + r() * 500;
    const notes = 3 + Math.floor(r() * 3);
    for (let i = 0; i < notes; i++) {
      const f = base * (0.8 + r() * 0.6);
      const length = 0.12 + r() * 0.2;
      note(context, out, t, [f, f * (0.9 + r() * 0.35), f * (0.85 + r() * 0.3)], length, 0.09, 0.012);
      t += length + 0.03 + r() * 0.06;
    }
    for (let i = 0; i < 4 + Math.floor(r() * 5); i++) {
      const f = 3200 + r() * 1800;
      note(context, out, t, [f, f * 1.25], 0.035, 0.04);
      t += 0.045;
    }
    return t - at;
  },
  // A chiffchaff: its name, over and over, a little uneven.
  (context, out, at) => {
    let t = at;
    const hi = 5200 + r() * 600;
    const lo = hi * 0.78;
    const count = 5 + Math.floor(r() * 6);
    for (let i = 0; i < count; i++) {
      const f = (i + Math.floor(r() * 2)) % 2 ? lo : hi;
      note(context, out, t, [f * 1.06, f * 0.94], 0.07, 0.05);
      t += 0.28 + r() * 0.08;
    }
    return t - at;
  },
  // A wren: a long loud rattle of tiny notes, rising and falling in runs.
  (context, out, at) => {
    let t = at;
    const runs = 3 + Math.floor(r() * 3);
    for (let k = 0; k < runs; k++) {
      const f = 4200 + r() * 2400;
      const n = 6 + Math.floor(r() * 10);
      const rise = r() > 0.5 ? 1.015 : 0.985;
      for (let i = 0; i < n; i++) {
        note(context, out, t, [f * rise ** i * 1.1, f * rise ** i * 0.85], 0.03, 0.035);
        t += 0.038;
      }
      t += 0.05;
    }
    return t - at;
  },
  // A wood pigeon, well off: five soft hoots, the middle one long.
  (context, out, at) => {
    const f = 380 + r() * 40;
    const lengths = [0.22, 0.5, 0.22, 0.22, 0.3];
    let t = at;
    for (const length of lengths) {
      note(context, out, t, [f * 0.94, f, f * 0.9], length, 0.06);
      t += length + 0.1;
    }
    return t - at;
  },
  // A woodpecker drumming on a dead limb somewhere off in the trees.
  (context, out, at) => {
    const n = 12 + Math.floor(r() * 10);
    for (let i = 0; i < n; i++) {
      const t = at + i * (0.045 + i * 0.0006);
      burst(context, out, t, { freq: 900 + r() * 200, q: 3, attack: 0.001, decay: 0.03, gain: 0.07 * (1 - i / n / 2) });
    }
    return n * 0.05;
  }
];
// How often each sings (the woodpecker rarely).
const WEIGHTS = [4, 3, 3, 1.5, 0.6];

// One bird singing somewhere round the clearing, now and then. Call often; it waits its own time between songs.
let nextSong = 0;
export function birds(now: number) {
  if (now < nextSong || open < 0.05) return;
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  let pick = r() * total;
  let k = 0;
  while (pick > WEIGHTS[k]) pick -= WEIGHTS[k++];
  let length = 1;
  sound.custom((context, master, at) => {
    const far = k === 3 ? 0.6 + r() * 0.3 : r() * 0.8;
    const level = context.createGain();
    level.gain.value = open * 0.9;
    level.connect(master);
    length = SONGS[k](context, place(context, level, r() * 2 - 1, far), at);
  });
  nextSong = now + length + 0.8 + r() * 3.2;
}

// A gust going through the leaves overhead: a soft swell of rustling that comes and goes over a few seconds.
let nextGust = 3;
export function gusts(now: number) {
  if (now < nextGust || open < 0.05) return;
  nextGust = now + 5 + r() * 9;
  sound.custom((context, master, at) => {
    const out = place(context, master, r() * 1.6 - 0.8, 0.2);
    const length = 2.5 + r() * 3;
    burst(context, out, at, { freq: 2600 + r() * 1200, q: 0.5, attack: length * 0.45, decay: length * 0.55, gain: 0.045 * open });
    burst(context, out, at + 0.2, { freq: 900, q: 0.7, attack: length * 0.5, decay: length * 0.5, gain: 0.025 * open });
    // Leaves ticking against each other at the height of it.
    for (let i = 0; i < 30; i++) burst(context, out, at + length * (0.25 + r() * 0.5), { freq: 3000 + r() * 4000, q: 3, attack: 0.002, decay: 0.01 + r() * 0.02, gain: 0.008 * open });
  });
}

// A footfall in the clearing: dry leaves crushed underfoot (many tiny crackles, brightest at the heel), the soft thump
// of the forest floor, and a swish through grass. `leafy` (0 to 1) is how much of it is dry leaves.
export function leafStep(pan = 0, leafy = 1) {
  sound.custom((context, master, at) => {
    const out = context.createStereoPanner();
    out.pan.value = pan;
    out.connect(master);
    burst(context, out, at, { freq: 180, q: 0.7, attack: 0.008, decay: 0.1, gain: 0.55, type: "lowpass" });
    const crackles = Math.round(10 + leafy * 22);
    for (let i = 0; i < crackles; i++) {
      const t = at + 0.005 + Math.pow(r(), 1.6) * 0.16;
      burst(context, out, t, { freq: 1800 + r() * 5200, q: 1.8 + r() * 2, attack: 0.0006, decay: 0.004 + r() * 0.014, gain: (0.06 + r() * 0.12) * (0.5 + leafy * 0.6) });
    }
    burst(context, out, at + 0.01, { freq: 3800, q: 0.6, attack: 0.02, decay: 0.12, gain: 0.08 * (1.2 - leafy), sweep: 2200 });
  });
}
