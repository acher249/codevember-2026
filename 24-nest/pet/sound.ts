import { sound } from "../../shared/engine/sound";
import type { Sound } from "./pet";

// The toy's sounds, built on the engine's context and ending in its master. A button is a crunchy plastic click: a dry
// snap through a bright band, a hollow knock of the shell under it, and a softer one as it comes back up. The pet speaks
// through a piezo: square waves, thin and loud, ringing at the disc's resonance. And the room: a faint radio left on low,
// all hiss and a far-off tune.

let noise: AudioBuffer | null = null;
function grain(context: AudioContext) {
  if (noise && noise.sampleRate === context.sampleRate) return noise;
  noise = context.createBuffer(1, Math.floor(context.sampleRate * 1.2), context.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

const envelope = (context: AudioContext, into: AudioNode, at: number, level: number, attack: number, decay: number) => {
  const env = context.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  env.connect(into);
  return env;
};

const snap = (context: AudioContext, into: AudioNode, at: number, centre: number, q: number, level: number, decay: number) => {
  const src = context.createBufferSource();
  src.buffer = grain(context);
  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = centre;
  band.Q.value = q;
  src.connect(band);
  band.connect(envelope(context, into, at, level, 0.0006, decay));
  src.start(at, Math.random() * 1.1);
  src.stop(at + decay + 0.05);
};

const knock = (context: AudioContext, into: AudioNode, at: number, from: number, to: number, level: number, decay: number) => {
  const osc = context.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + decay);
  osc.connect(envelope(context, into, at, level, 0.001, decay));
  osc.start(at);
  osc.stop(at + decay + 0.05);
};

// A button going down (and, softer and higher, coming back up). `pan` -1 to 1 by which button.
export function click(down: boolean, pan: number) {
  sound.custom((context, out, at) => {
    const panner = context.createStereoPanner();
    panner.pan.value = pan * 0.35;
    panner.connect(out);
    const k = down ? 1 : 0.55;
    const pitch = down ? 1 : 1.25;
    // The dome switch's snap: two close crunches, then the shell's hollow knock.
    snap(context, panner, at, 3400 * pitch, 1.4, 0.75 * k, 0.012);
    snap(context, panner, at + 0.004, 6800 * pitch, 2, 0.35 * k, 0.008);
    snap(context, panner, at + 0.0015, 1500 * pitch, 3, 0.35 * k, 0.02);
    knock(context, panner, at, 520 * pitch, 260 * pitch, 0.3 * k, 0.04);
    window.setTimeout(() => panner.disconnect(), 400);
  });
}

// The piezo: a run of notes, each [frequency, seconds, gap after]. A frequency of 0 is a rest.
function piezo(notes: [number, number, number?][], level = 1) {
  sound.custom((context, out, at) => {
    // The disc rings at about 3.2 kHz: a peak there, thin below.
    const thin = context.createBiquadFilter();
    thin.type = "highpass";
    thin.frequency.value = 700;
    const ring = context.createBiquadFilter();
    ring.type = "peaking";
    ring.frequency.value = 3200;
    ring.Q.value = 3;
    ring.gain.value = 9;
    const soft = context.createBiquadFilter();
    soft.type = "lowpass";
    soft.frequency.value = 7000;
    const master = context.createGain();
    master.gain.value = 0.05 * level;
    thin.connect(ring);
    ring.connect(soft);
    soft.connect(master);
    master.connect(out);
    let t = at;
    for (const [f, length, gap = 0.02] of notes) {
      if (f > 0) {
        const osc = context.createOscillator();
        osc.type = "square";
        osc.frequency.value = f;
        const gate = context.createGain();
        gate.gain.setValueAtTime(0, t);
        gate.gain.linearRampToValueAtTime(1, t + 0.002);
        gate.gain.setValueAtTime(1, t + length - 0.004);
        gate.gain.linearRampToValueAtTime(0, t + length);
        osc.connect(gate);
        gate.connect(thin);
        osc.start(t);
        osc.stop(t + length + 0.01);
      }
      t += length + gap;
    }
    window.setTimeout(() => master.disconnect(), (t - context.currentTime + 0.3) * 1000);
  });
}

// Notes, by name, in the piezo's bright range.
const N = { C6: 1047, D6: 1175, E6: 1319, F6: 1397, G6: 1568, A6: 1760, B6: 1976, C7: 2093, D7: 2349, E7: 2637, G7: 3136, A5: 880, G5: 784, E5: 659, C5: 523 };

export function voice(kind: Sound) {
  switch (kind) {
    case "boot":
      return piezo([[N.C7, 0.5, 0.15], [N.E7, 0.06], [N.G7, 0.12]], 1);
    case "reset":
      return piezo([[N.G7, 0.04], [N.C7, 0.04], [N.G7, 0.04], [N.C7, 0.3]]);
    case "select":
      return piezo([[N.E7, 0.035]]);
    case "ok":
      return piezo([[N.C7, 0.04, 0.015], [N.G7, 0.05]]);
    case "cancel":
      return piezo([[N.G6, 0.05]]);
    case "error":
      return piezo([[N.C6 * 0.5, 0.12, 0.04], [N.C6 * 0.5, 0.12]]);
    case "light":
      return piezo([[N.A6, 0.05, 0.02], [N.D7, 0.05]]);
    case "crack":
      return piezo([[N.D7, 0.03, 0.02], [N.A6, 0.03]]);
    case "hatch":
      return piezo([[N.C7, 0.09], [N.E7, 0.09], [N.G7, 0.09], [N.C7, 0.09], [N.E7, 0.09], [N.G7, 0.25]]);
    case "twig":
      return piezo([[N.A6, 0.025, 0.04], [N.D7, 0.03]], 0.7);
    case "chomp":
      return piezo([[N.E6, 0.04, 0.03], [N.C6, 0.04]]);
    case "happy":
      return piezo([[N.G6, 0.06], [N.C7, 0.06], [N.E7, 0.12]]);
    case "full":
      return piezo([[N.E6, 0.08, 0.05], [N.C6, 0.16]]);
    case "turn":
      return piezo([[N.C7, 0.03, 0.05], [N.D7, 0.03, 0.05], [N.E7, 0.03]]);
    case "win":
      return piezo([[N.E7, 0.07], [N.G7, 0.07], [N.E7, 0.07], [N.G7, 0.18]]);
    case "lose":
      return piezo([[N.E6, 0.12], [N.D6, 0.12], [N.C6, 0.3]]);
    case "flush":
      return piezo(Array.from({ length: 12 }, (_, k) => [N.C6 + k * 150, 0.03, 0.01] as [number, number, number]), 0.7);
    case "plop":
      return piezo([[N.G5, 0.05, 0.03], [N.C5, 0.08]], 0.7);
    case "alert":
      return piezo([[N.G7, 0.08, 0.06], [N.G7, 0.08, 0.06], [N.G7, 0.08]], 1.1);
    case "leave":
      return piezo([[N.G6, 0.3, 0.05], [N.E6, 0.3, 0.05], [N.C6, 0.3, 0.05], [N.G5, 0.6]], 0.9);
    case "note":
      return piezo([[N.C6, 0.15, 0.1], [N.G5, 0.4]], 0.8);
  }
}

// The tab sliding out, a squeak of film on plastic, then the battery's contact snapping shut.
export function slide(amount: number) {
  sound.custom((context, out, at) => {
    snap(context, out, at, 2200 + amount * 2600, 6, 0.05, 0.03);
  });
}

// The room: a radio left on low across the room, mostly hiss, a far tune under it now and then. Runs for as long as it
// is wanted; returns its stop.
export function roomTone() {
  let stop: (() => void) | null = null;
  let cancelled = false;
  sound.custom((context, out, at) => {
    if (cancelled) return;
    const master = context.createGain();
    master.gain.setValueAtTime(0, at);
    master.gain.linearRampToValueAtTime(1, at + 2.5);
    master.connect(out);
    const hiss = context.createBufferSource();
    hiss.buffer = grain(context);
    hiss.loop = true;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 2400;
    band.Q.value = 0.5;
    const hissLevel = context.createGain();
    hissLevel.gain.value = 0.008;
    hiss.connect(band);
    band.connect(hissLevel);
    hissLevel.connect(master);
    // The tune: a slow chord pattern, muffled through a small speaker and a wall, wavering with the reception.
    const tune = context.createGain();
    tune.gain.value = 0.0045;
    const speaker = context.createBiquadFilter();
    speaker.type = "bandpass";
    speaker.frequency.value = 800;
    speaker.Q.value = 0.9;
    tune.connect(speaker);
    speaker.connect(master);
    const wobble = context.createOscillator();
    wobble.frequency.value = 0.13;
    const depth = context.createGain();
    depth.gain.value = 0.0025;
    wobble.connect(depth);
    depth.connect(tune.gain);
    wobble.start(at);
    const chords = [
      [220, 277, 330],
      [196, 247, 294],
      [175, 220, 262],
      [196, 247, 330]
    ];
    const oscs: OscillatorNode[] = [];
    for (let v = 0; v < 3; v++) {
      const osc = context.createOscillator();
      osc.type = "triangle";
      osc.connect(tune);
      osc.start(at);
      oscs.push(osc);
    }
    // The chords, a few bars at a time, so starting asks for next to nothing.
    let bar = 0;
    const ahead = () => {
      for (const end = bar + 4; bar < end; bar++) oscs.forEach((osc, v) => osc.frequency.setValueAtTime(chords[bar % 4][v], at + bar * 2.2));
    };
    ahead();
    const timer = window.setInterval(ahead, 8000);
    hiss.start(at);
    stop = () => {
      window.clearInterval(timer);
      const now = context.currentTime;
      master.gain.setTargetAtTime(0, now, 0.3);
      for (const node of [hiss, wobble, ...oscs]) node.stop(now + 1.5);
    };
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}
