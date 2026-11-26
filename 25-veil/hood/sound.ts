import { sound } from "../../shared/engine/sound";

// Her breath, made here: a slow, soft exhale through the lips, close, then a faint draw in.

let pink: { context: AudioContext; buffer: AudioBuffer } | null = null;

function noise(context: AudioContext) {
  if (pink && pink.context === context) return pink.buffer;
  const buffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.997 * b0 + w * 0.029591;
    b1 = 0.985 * b1 + w * 0.032534;
    b2 = 0.95 * b2 + w * 0.048056;
    data[i] = (b0 + b1 + b2 + w * 0.05) * 1.8;
  }
  pink = { context, buffer };
  return buffer;
}

export function breath(gain = 1) {
  sound.custom((context, out, at) => {
    const shape = (from: number, rise: number, hold: number, fall: number, level: number, centre: number) => {
      const source = context.createBufferSource();
      source.buffer = noise(context);
      const band = context.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.setValueAtTime(centre, from);
      band.frequency.linearRampToValueAtTime(centre * 0.7, from + rise + hold + fall);
      band.Q.value = 0.9;
      const env = context.createGain();
      env.gain.setValueAtTime(0.0001, from);
      env.gain.linearRampToValueAtTime(level * gain, from + rise);
      env.gain.setValueAtTime(level * gain, from + rise + hold);
      env.gain.exponentialRampToValueAtTime(0.0001, from + rise + hold + fall);
      source.connect(band);
      band.connect(env);
      env.connect(out);
      source.start(from, Math.random() * 2);
      source.stop(from + rise + hold + fall + 0.1);
    };
    // Out, through barely parted lips; in, fainter and higher, a couple of seconds later.
    shape(at, 0.35, 0.6, 1.1, 0.05, 900);
    shape(at + 2.4, 0.5, 0.4, 0.9, 0.022, 1400);
  });
}
