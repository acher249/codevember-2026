import { useCallback, useEffect, useRef } from "react";
import { sound } from "../../shared/engine/sound";

// A recorded background (the street: traffic, voices, birds) looping under everything, through the engine's own output so
// the sound button turns it off with the rest. The recording's ends are crossfaded into each other so the loop has no
// seam. It starts, fading in, once the browser has let audio play (the first press), and fades out when the day goes.
const CROSSFADE = 1.5;
const FADE_IN = 2.5;

function seamless(context: AudioContext, raw: AudioBuffer) {
  const fade = Math.min(Math.floor(raw.sampleRate * CROSSFADE), Math.floor(raw.length / 3));
  const length = raw.length - fade;
  const out = context.createBuffer(raw.numberOfChannels, length, raw.sampleRate);
  for (let c = 0; c < raw.numberOfChannels; c++) {
    const from = raw.getChannelData(c);
    const to = out.getChannelData(c);
    to.set(from.subarray(0, length));
    // The tail laid over the head, equal power, so the join sounds like neither.
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      to[i] = from[i] * Math.sin((t * Math.PI) / 2) + from[length + i] * Math.cos((t * Math.PI) / 2);
    }
  }
  return out;
}

export function useLoop(url: string, level: number) {
  useEffect(() => {
    let gone = false;
    let started = false;
    let stop: (() => void) | null = null;
    let buffer: Promise<AudioBuffer | null> | null = null;

    const tryStart = () => {
      if (started || gone) return;
      sound.custom((context, out) => {
        if (started) return;
        started = true;
        buffer ??= fetch(url)
          .then((response) => response.arrayBuffer())
          .then((data) => context.decodeAudioData(data))
          .then((raw) => seamless(context, raw))
          .catch(() => null);
        void buffer.then((loop) => {
          if (!loop || gone) return;
          const source = context.createBufferSource();
          source.buffer = loop;
          source.loop = true;
          const gain = context.createGain();
          gain.gain.setValueAtTime(0.0001, context.currentTime);
          gain.gain.linearRampToValueAtTime(level, context.currentTime + FADE_IN);
          source.connect(gain);
          gain.connect(out);
          source.start();
          stop = () => {
            gain.gain.setTargetAtTime(0.0001, context.currentTime, 0.4);
            source.stop(context.currentTime + 2);
          };
        });
      });
    };

    // Audio wakes on a press; keep asking until it has (and while the sound is off).
    const timer = window.setInterval(tryStart, 500);
    tryStart();
    return () => {
      gone = true;
      window.clearInterval(timer);
      stop?.();
    };
  }, [url, level]);
}

// A recorded sound looped (seamlessly, as above) only while something is at work: the chalk scratching on, the eraser
// rubbing. `play(on)` each frame; it fades in when it starts and out when it stops, from where it left off.
export function useWhileLoop(url: string, level: number) {
  const state = useRef({ on: false, gain: null as GainNode | null, context: null as AudioContext | null, loading: false });
  useEffect(() => {
    const s = state.current;
    return () => {
      if (s.gain && s.context) s.gain.gain.setTargetAtTime(0, s.context.currentTime, 0.05);
    };
  }, []);
  return useCallback(
    (on: boolean) => {
      const s = state.current;
      const changed = on !== s.on;
      s.on = on;
      if (s.gain && s.context) {
        if (!changed) return;
        s.gain.gain.cancelScheduledValues(s.context.currentTime);
        s.gain.gain.setTargetAtTime(on ? level : 0, s.context.currentTime, on ? 0.04 : 0.12);
        return;
      }
      // (Asked again each frame it is wanted until audio has been woken by a press and the recording is in.)
      if (!on || s.loading) return;
      sound.custom((context, out) => {
        s.loading = true;
        void fetch(url)
          .then((response) => response.arrayBuffer())
          .then((data) => context.decodeAudioData(data))
          .then((raw) => {
            const source = context.createBufferSource();
            source.buffer = seamless(context, raw);
            source.loop = true;
            const gain = context.createGain();
            gain.gain.setValueAtTime(0, context.currentTime);
            gain.gain.setTargetAtTime(s.on ? level : 0, context.currentTime, 0.04);
            source.connect(gain);
            gain.connect(out);
            source.start();
            s.gain = gain;
            s.context = context;
          })
          .catch(() => (s.loading = false));
      });
    },
    [url, level]
  );
}
