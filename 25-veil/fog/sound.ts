import { sound } from "../../shared/engine/sound";

// The coast's sounds, made here: the foghorn's long low two-tone call, the sea washing in on the rocks and shingle, the
// buoy's bell, and the hush of fog swept aside.

let brown: { context: AudioContext; buffer: AudioBuffer } | null = null;

function noise(context: AudioContext) {
  if (brown && brown.context === context) return brown.buffer;
  const buffer = context.createBuffer(1, context.sampleRate * 8, context.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    last = (last + (Math.random() * 2 - 1) * 0.02) / 1.02;
    data[i] = last * 3.4;
  }
  brown = { context, buffer };
  return buffer;
}

function panned(context: AudioContext, out: AudioNode, pan: number) {
  if (!context.createStereoPanner) return out;
  const p = context.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(out);
  return p;
}

// The foghorn: a diaphone's long, reedy groan, then the drop to its lower grunt, from across the cove, softened by the
// fog and with the cliffs answering.
export function foghorn(gain = 1, pan = -0.4) {
  sound.custom((context, out, at) => {
    const dest = panned(context, out, pan);
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 520;
    tone.Q.value = 0.7;
    const body = context.createGain();
    body.gain.value = 0;
    tone.connect(body);
    body.connect(dest);
    // The echo off the headland, late and dull.
    const echo = context.createDelay(2);
    echo.delayTime.value = 0.9;
    const echoGain = context.createGain();
    echoGain.gain.value = 0.28;
    const echoTone = context.createBiquadFilter();
    echoTone.type = "lowpass";
    echoTone.frequency.value = 300;
    body.connect(echo);
    echo.connect(echoTone);
    echoTone.connect(echoGain);
    echoGain.connect(dest);

    const call = (from: number, length: number, pitch: number, level: number) => {
      for (const [ratio, type, share] of [
        [1, "sawtooth", 0.5],
        [1.004, "sawtooth", 0.35],
        [0.5, "square", 0.25]
      ] as [number, OscillatorType, number][]) {
        const osc = context.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(pitch * ratio * 0.97, from);
        osc.frequency.linearRampToValueAtTime(pitch * ratio, from + 0.25);
        const g = context.createGain();
        g.gain.value = share;
        osc.connect(g);
        g.connect(tone);
        osc.start(from);
        osc.stop(from + length + 0.6);
      }
      body.gain.setValueAtTime(0.0001, from);
      body.gain.linearRampToValueAtTime(level * gain, from + 0.35);
      body.gain.setValueAtTime(level * gain, from + length - 0.25);
      body.gain.linearRampToValueAtTime(0.0001, from + length + 0.15);
    };
    call(at, 2.4, 148, 0.16);
    call(at + 2.45, 0.9, 98, 0.13);
  });
}

// A wave washing in: a swell of low noise, a hiss as it runs up, the drag back down the shingle.
export function wash(gain = 1, pan = 0) {
  sound.custom((context, out, at) => {
    const dest = panned(context, out, pan);
    const source = context.createBufferSource();
    source.buffer = noise(context);
    const low = context.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.setValueAtTime(300, at);
    low.frequency.linearRampToValueAtTime(1600, at + 1.4);
    low.frequency.linearRampToValueAtTime(700, at + 3.6);
    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(0.22 * gain, at + 1.3);
    env.gain.linearRampToValueAtTime(0.1 * gain, at + 2.2);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 4.6);
    source.connect(low);
    low.connect(env);
    env.connect(dest);
    source.start(at, Math.random() * 3);
    source.stop(at + 4.8);
  });
}

// The buoy's bell, struck as it rocks: a few inharmonic partials ringing down.
export function bell(gain = 1, pan = 0.3) {
  sound.custom((context, out, at) => {
    const dest = panned(context, out, pan);
    for (const [ratio, level, decay] of [
      [1, 0.5, 3.2],
      [2.76, 0.25, 1.6],
      [5.4, 0.12, 0.8],
      [0.5, 0.2, 2.6]
    ]) {
      const osc = context.createOscillator();
      osc.frequency.value = 620 * ratio;
      const g = context.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(level * 0.05 * gain, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      osc.connect(g);
      g.connect(dest);
      osc.start(at);
      osc.stop(at + decay + 0.1);
    }
  });
}

// The fog swept aside: a soft hush, as strong as the sweep is quick.
export function hush(strength: number, pan = 0) {
  sound.custom((context, out, at) => {
    const dest = panned(context, out, pan);
    const source = context.createBufferSource();
    source.buffer = noise(context);
    source.playbackRate.value = 1.6;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 700 + strength * 900;
    band.Q.value = 0.6;
    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(0.09 * strength, at + 0.12);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
    source.connect(band);
    band.connect(env);
    env.connect(dest);
    source.start(at, Math.random() * 4);
    source.stop(at + 0.8);
  });
}
