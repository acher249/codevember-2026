"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

// Every sound effect in Codevember is synthesised here. The only audio files are each day's background music, which
// streams, and does not start downloading until sound does. The tracks are paid for and are not in the open-source repo,
// so a day whose track is missing simply has no music. Browsers keep audio silent until the first press or key, so nothing starts before that: beds and
// one-shots asked for earlier wait quietly and join in once the context is running.

type BedKind = "wind" | "rain" | "river" | "hum" | "shimmer" | "crickets";

type ShotName =
  | "thud"
  | "crack"
  | "shatter"
  | "tinkle"
  | "chirp"
  | "caw"
  | "bleat"
  | "plop"
  | "drip"
  | "sizzle"
  | "fold"
  | "rustle"
  | "whoosh"
  | "tick"
  | "hoof"
  | "creak"
  | "click";

// size is roughly 0 to 1, how big the thing making the sound is. pan is -1 to 1.
type ShotOptions = { gain?: number; pitch?: number; pan?: number; size?: number };

type Bed = { level: (value: number, seconds?: number) => void; tone: (value: number, seconds?: number) => void; stop: () => void };

const STORE_KEY = "codevember-sound";
const MAX_VOICES = 48;
const MIN_GAP = 0.025;

type NoiseColour = "white" | "pink" | "brown";

class SoundEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noises = new Map<NoiseColour, AudioBuffer>();
  private beds = new Set<{ start: () => void; stop: () => void }>();
  private lastShot = new Map<string, number>();
  private voices = 0;
  private listeners = new Set<() => void>();
  muted = false;
  playing = false;
  private startedAt = -Infinity;
  // One element for every day: phones only let an element play once a press has started it, and after that it can change track.
  private musicElement: HTMLAudioElement | null = null;
  private musicGain: GainNode | null = null;
  private wantedMusic: { url: string; level: number } | null = null;
  private missingMusic = new Set<string>();

  constructor() {
    if (typeof window === "undefined") return;
    try {
      this.muted = window.localStorage.getItem(STORE_KEY) === "off";
    } catch {
      this.muted = false;
    }
    // Phones only allow audio to start as a tap ends, and desktops as a press begins, so this listens for both.
    const wake = () => this.wake();
    for (const event of ["pointerdown", "pointerup", "touchend", "click", "keydown"]) window.addEventListener(event, wake, { capture: true });
    document.addEventListener("visibilitychange", () => {
      if (!this.context) return;
      if (document.hidden) {
        void this.context.suspend();
        this.musicElement?.pause();
      } else {
        void this.context.resume();
        this.startMusic();
      }
    });
  }

  private wake() {
    if (this.context) {
      // Not only "suspended": iOS also has "interrupted", after a call or a trip to the home screen.
      if (this.context.state !== "running" && !document.hidden) void this.context.resume();
      // Any press is another chance, if the browser refused to start the music earlier.
      this.startMusic();
      return;
    }
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    this.context = new Context();
    this.context.onstatechange = () => this.changedState();
    void this.context.resume();
    this.changedState();
    this.master = this.context.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    // A gentle limiter, so that a pile of impacts at once never clips.
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.ratio.value = 8;
    this.master.connect(limiter);
    limiter.connect(this.context.destination);
    for (const bed of this.beds) bed.start();
    this.startMusic();
  }

  private startMusic() {
    const wanted = this.wantedMusic;
    if (!wanted || !this.context || !this.master || this.muted || document.hidden) return;
    const url = new URL(wanted.url, window.location.href).href;
    if (this.missingMusic.has(url)) return;
    if (!this.musicElement) {
      this.musicElement = new Audio();
      const created = this.musicElement;
      created.addEventListener("error", () => {
        if (created.src) this.missingMusic.add(created.src);
      });
      this.musicElement.loop = true;
      this.musicElement.preload = "auto";
      this.musicElement.setAttribute("playsinline", "");
      this.musicGain = this.context.createGain();
      this.musicGain.gain.value = 0;
      this.context.createMediaElementSource(this.musicElement).connect(this.musicGain);
      this.musicGain.connect(this.master);
    }
    const element = this.musicElement;
    if (element.src !== url) element.src = url;
    // Also when it is already playing: it may be on its way out, if the same track has just been asked for again.
    (this.musicGain as GainNode).gain.setTargetAtTime(wanted.level, this.context.currentTime, 0.8);
    if (!element.paused) return;
    element.play().catch(() => {
      // Refused or interrupted. The next press tries again.
    });
  }

  // Asks for a day's track, and returns what stops it again.
  music(url: string, level: number) {
    const wanted = { url, level };
    this.wantedMusic = wanted;
    this.startMusic();
    return () => {
      if (this.wantedMusic !== wanted) return;
      this.wantedMusic = null;
      if (this.context && this.musicGain) this.musicGain.gain.setTargetAtTime(0, this.context.currentTime, 0.15);
      window.setTimeout(() => {
        if (!this.wantedMusic) this.musicElement?.pause();
      }, 700);
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private changedState() {
    const playing = this.context?.state === "running";
    if (playing && !this.playing) this.startedAt = performance.now();
    this.playing = playing;
    for (const listener of this.listeners) listener();
  }

  // What the sound button means. Until the browser has let audio start, there is nothing to turn off, so a press there
  // only ever turns it on. That includes a press that has only just started it, in the moments before the click arrives.
  toggle() {
    const justStarted = performance.now() - this.startedAt < 350;
    this.setMuted(this.playing && !this.muted && !justStarted);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try {
      window.localStorage.setItem(STORE_KEY, muted ? "off" : "on");
    } catch {
      // Not remembered between visits, which is fine.
    }
    if (this.context && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 0.8, this.context.currentTime, 0.05);
    if (muted) this.musicElement?.pause();
    else this.startMusic();
    for (const listener of this.listeners) listener();
  }

  private noise(colour: NoiseColour) {
    const context = this.context as AudioContext;
    let buffer = this.noises.get(colour);
    if (buffer) return buffer;
    buffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      if (colour === "white") data[i] = white * 0.6;
      else if (colour === "pink") {
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.16;
      } else {
        brown = (brown + white * 0.02) / 1.02;
        data[i] = brown * 3.2;
      }
    }
    // Crossfade the ends, so that the loop has no click in it.
    const fade = Math.floor(context.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[i] = data[i] * t + data[data.length - fade + i] * (1 - t);
    }
    this.noises.set(colour, buffer);
    return buffer;
  }

  private output(pan = 0) {
    const context = this.context as AudioContext;
    if (!pan || !context.createStereoPanner) return this.master as GainNode;
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(this.master as GainNode);
    return panner;
  }

  // A burst of filtered noise with a sharp start and a falling tail.
  private burst(at: number, colour: NoiseColour, type: BiquadFilterType, frequency: number, q: number, attack: number, decay: number, gain: number, out: AudioNode, sweepTo?: number) {
    const context = this.context as AudioContext;
    const source = context.createBufferSource();
    source.buffer = this.noise(colour);
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(frequency, at);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, at + attack + decay);
    filter.Q.value = q;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(out);
    source.start(at, Math.random() * 3);
    source.stop(at + attack + decay + 0.02);
    this.count(source);
  }

  // A pitched note that slides from one frequency to another.
  private note(at: number, type: OscillatorType, from: number, to: number, attack: number, decay: number, gain: number, out: AudioNode, lowpass?: number) {
    const context = this.context as AudioContext;
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, at);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + attack + decay);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    if (lowpass) {
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = lowpass;
      oscillator.connect(filter);
      filter.connect(envelope);
    } else {
      oscillator.connect(envelope);
    }
    envelope.connect(out);
    oscillator.start(at);
    oscillator.stop(at + attack + decay + 0.02);
    this.count(oscillator);
  }

  private count(node: AudioScheduledSourceNode) {
    this.voices++;
    node.onended = () => {
      this.voices--;
    };
  }

  // Fire a one-shot. Quietly does nothing until audio has been woken by a press, or if too much is sounding.
  play(name: ShotName, options: ShotOptions = {}) {
    const context = this.context;
    if (!context || context.state !== "running" || this.muted || this.voices > MAX_VOICES) return;
    const now = context.currentTime;
    if (now - (this.lastShot.get(name) ?? -1) < MIN_GAP) return;
    this.lastShot.set(name, now);
    const gain = options.gain ?? 1;
    const pitch = (options.pitch ?? 1) * (0.94 + Math.random() * 0.12);
    const size = options.size ?? 0.5;
    const out = this.output(options.pan);
    const at = now + 0.002;
    const r = Math.random;

    switch (name) {
      case "thud":
        this.note(at, "sine", (130 - size * 70) * pitch, (52 - size * 18) * pitch, 0.004, 0.16 + size * 0.3, 0.75 * gain, out);
        this.burst(at, "brown", "lowpass", 900 - size * 500, 0.6, 0.002, 0.07 + size * 0.1, 0.8 * gain, out);
        this.burst(at, "white", "bandpass", 2400 * pitch, 1, 0.001, 0.025, 0.1 * gain, out);
        break;
      case "crack":
        this.burst(at, "white", "highpass", 2200 * pitch, 0.8, 0.001, 0.05, 0.55 * gain, out);
        this.note(at, "square", 2600 * pitch, 500, 0.001, 0.035, 0.09 * gain, out, 6000);
        this.note(at, "sine", 170, 70, 0.002, 0.11, 0.3 * gain, out);
        break;
      case "shatter":
        this.note(at, "sine", 150, 48, 0.003, 0.26, 0.6 * gain, out);
        this.burst(at, "white", "highpass", 1700, 0.7, 0.001, 0.2, 0.42 * gain, out);
        for (let i = 0; i < 16; i++) {
          const delay = Math.pow(r(), 1.8) * 0.55;
          const f = (2400 + r() * 6400) * pitch;
          this.note(at + delay, "sine", f, f * 0.985, 0.001, 0.05 + r() * 0.16, (0.05 + r() * 0.1) * gain, out);
        }
        break;
      case "tinkle":
        for (let i = 0; i < 3 + Math.floor(r() * 4); i++) {
          const f = (3000 + r() * 5200) * pitch;
          this.note(at + r() * 0.12, "sine", f, f * 0.99, 0.001, 0.07 + r() * 0.2, (0.03 + r() * 0.05) * gain, out);
        }
        break;
      case "chirp": {
        const base = (2600 + r() * 2200) * pitch;
        const count = 2 + Math.floor(r() * 4);
        const up = r() > 0.5;
        for (let i = 0; i < count; i++) {
          const start = at + i * (0.07 + r() * 0.05);
          const lift = 1 + (up ? i : count - i) * 0.05;
          this.note(start, "sine", base * lift, base * lift * (0.72 + r() * 0.6), 0.008, 0.05 + r() * 0.04, 0.12 * gain, out);
        }
        break;
      }
      case "caw":
        for (let i = 0; i < 1 + Math.floor(r() * 3); i++) {
          const start = at + i * 0.34;
          this.note(start, "sawtooth", 860 * pitch, 610 * pitch, 0.02, 0.2, 0.16 * gain, out, 2100);
          this.burst(start, "white", "bandpass", 1500 * pitch, 2.4, 0.015, 0.18, 0.1 * gain, out);
        }
        break;
      case "bleat": {
        const oscillator = context.createOscillator();
        oscillator.type = "sawtooth";
        const f = 340 * pitch;
        oscillator.frequency.setValueAtTime(f, at);
        oscillator.frequency.linearRampToValueAtTime(f * 1.1, at + 0.14);
        oscillator.frequency.linearRampToValueAtTime(f * 0.86, at + 0.72);
        const shake = context.createOscillator();
        shake.frequency.value = 7.5 + r() * 2;
        const depth = context.createGain();
        depth.gain.value = 0.5;
        const voice = context.createGain();
        voice.gain.value = 0.5;
        shake.connect(depth);
        depth.connect(voice.gain);
        const formant = context.createBiquadFilter();
        formant.type = "bandpass";
        formant.frequency.value = 1050 * pitch;
        formant.Q.value = 2.4;
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0.0001, at);
        envelope.gain.exponentialRampToValueAtTime(0.42 * gain, at + 0.05);
        envelope.gain.setValueAtTime(0.42 * gain, at + 0.5);
        envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.78);
        oscillator.connect(voice);
        voice.connect(formant);
        formant.connect(envelope);
        envelope.connect(out);
        oscillator.start(at);
        shake.start(at);
        oscillator.stop(at + 0.8);
        shake.stop(at + 0.8);
        this.count(oscillator);
        break;
      }
      case "plop":
        this.note(at, "sine", 260 * pitch, 980 * pitch, 0.012, 0.09, 0.4 * gain, out);
        this.burst(at, "pink", "bandpass", 900 * pitch, 1.2, 0.002, 0.05, 0.16 * gain, out);
        break;
      case "drip":
        this.note(at, "sine", 1000 * pitch, 2500 * pitch, 0.004, 0.05, 0.2 * gain, out);
        break;
      case "sizzle":
        for (let i = 0; i < 7; i++) this.burst(at + r() * 0.3, "white", "highpass", 5200 * pitch, 0.7, 0.002, 0.03 + r() * 0.07, (0.03 + r() * 0.07) * gain, out);
        break;
      case "fold":
        // Paper: a soft swell, with small crackles along the crease.
        this.burst(at, "pink", "bandpass", 2300 * pitch, 0.8, 0.05, 0.26, 0.2 * gain, out);
        for (let i = 0; i < 9; i++) this.burst(at + r() * 0.3, "white", "bandpass", (1800 + r() * 3600) * pitch, 2.2, 0.001, 0.008 + r() * 0.02, (0.06 + r() * 0.14) * gain, out);
        break;
      case "rustle":
        this.burst(at, "pink", "bandpass", 3300 * pitch, 0.7, 0.07, 0.3, 0.14 * gain, out);
        this.burst(at + 0.09, "white", "highpass", 4800 * pitch, 0.5, 0.05, 0.2, 0.05 * gain, out);
        break;
      case "whoosh":
        this.burst(at, "pink", "bandpass", 240 * pitch, 1.1, 0.14, 0.34, 0.4 * gain, out, 1300 * pitch);
        break;
      case "tick":
        this.note(at, "square", 1900 * pitch, 900 * pitch, 0.001, 0.016, 0.07 * gain, out, 5000);
        break;
      case "hoof":
        this.note(at, "sine", 240 * pitch, 110 * pitch, 0.002, 0.05, 0.2 * gain, out);
        this.burst(at, "white", "bandpass", 1500 * pitch, 1.4, 0.001, 0.025, 0.09 * gain, out);
        break;
      case "click":
        // A small detent: a sharp tick with a little wooden body under it.
        this.burst(at, "white", "bandpass", 4200 * pitch, 2.2, 0.0006, 0.009, 0.3 * gain, out);
        this.note(at, "sine", 2300 * pitch, 1300 * pitch, 0.0006, 0.014, 0.16 * gain, out);
        this.note(at, "sine", 380 * pitch, 240 * pitch, 0.001, 0.03, 0.2 * gain, out);
        break;
      case "creak": {
        const grains = 6 + Math.floor(r() * 7);
        const f = 300 * pitch * (0.8 + r() * 0.5);
        for (let i = 0; i < grains; i++) this.note(at + (i / grains) * 0.34, "sawtooth", f * (1 + i * 0.015), f * (1 + i * 0.015), 0.002, 0.018, 0.08 * gain, out, 1500);
        break;
      }
    }
  }

  // A continuous layer. Safe to ask for before audio is awake: it begins as soon as it can.
  bed(kind: BedKind, startLevel = 0.5): Bed {
    let gainNode: GainNode | null = null;
    let filterNode: BiquadFilterNode | null = null;
    let baseFrequency = 1000;
    let toneValue = 1;
    let levelValue = startLevel;
    const nodes: AudioScheduledSourceNode[] = [];

    const entry = {
      start: () => {
        const context = this.context;
        if (!context || gainNode) return;
        const gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(this.master as GainNode);
        gainNode = gain;
        const lfo = (rate: number, depth: number, target: AudioParam) => {
          const oscillator = context.createOscillator();
          oscillator.frequency.value = rate;
          const amount = context.createGain();
          amount.gain.value = depth;
          oscillator.connect(amount);
          amount.connect(target);
          oscillator.start();
          nodes.push(oscillator);
        };
        const loop = (colour: NoiseColour, type: BiquadFilterType, frequency: number, q: number, amount: number) => {
          const source = context.createBufferSource();
          source.buffer = this.noise(colour);
          source.loop = true;
          source.playbackRate.value = 0.92 + Math.random() * 0.16;
          const filter = context.createBiquadFilter();
          filter.type = type;
          filter.frequency.value = frequency;
          filter.Q.value = q;
          const part = context.createGain();
          part.gain.value = amount;
          source.connect(filter);
          filter.connect(part);
          part.connect(gain);
          source.start(0, Math.random() * 3);
          nodes.push(source);
          return { filter, part };
        };
        if (kind === "wind") {
          const low = loop("brown", "lowpass", 420, 0.7, 1.1);
          const air = loop("pink", "bandpass", 620, 0.8, 0.22);
          filterNode = low.filter;
          baseFrequency = 420;
          lfo(0.09, 190, low.filter.frequency);
          lfo(0.13, 0.42, low.part.gain);
          lfo(0.21, 240, air.filter.frequency);
          lfo(0.07, 0.12, air.part.gain);
        } else if (kind === "rain") {
          const body = loop("pink", "highpass", 1100, 0.5, 0.42);
          const hiss = loop("white", "highpass", 5200, 0.4, 0.13);
          loop("brown", "lowpass", 380, 0.5, 0.28);
          filterNode = body.filter;
          baseFrequency = 1100;
          lfo(0.17, 0.05, hiss.part.gain);
        } else if (kind === "river") {
          const body = loop("pink", "bandpass", 820, 0.5, 0.75);
          const bright = loop("white", "bandpass", 2600, 0.9, 0.09);
          filterNode = body.filter;
          baseFrequency = 820;
          lfo(0.31, 200, body.filter.frequency);
          lfo(1.3, 0.03, bright.part.gain);
        } else if (kind === "hum") {
          for (const [frequency, amount] of [
            [55, 0.32],
            [110.4, 0.14],
            [165.2, 0.05]
          ]) {
            const oscillator = context.createOscillator();
            oscillator.frequency.value = frequency;
            const part = context.createGain();
            part.gain.value = amount;
            oscillator.connect(part);
            part.connect(gain);
            oscillator.start();
            nodes.push(oscillator);
            lfo(0.07 + frequency * 0.0007, amount * 0.25, part.gain);
          }
          const room = loop("brown", "lowpass", 300, 0.5, 0.4);
          filterNode = room.filter;
          baseFrequency = 300;
        } else if (kind === "shimmer") {
          for (const frequency of [196, 293.7, 392.6, 587.8, 880.9]) {
            const oscillator = context.createOscillator();
            oscillator.frequency.value = frequency;
            const part = context.createGain();
            part.gain.value = 0.045;
            oscillator.connect(part);
            part.connect(gain);
            oscillator.start();
            nodes.push(oscillator);
            lfo(0.04 + Math.random() * 0.11, 0.035, part.gain);
          }
        } else if (kind === "crickets") {
          for (const [frequency, rate, gate] of [
            [4500, 27, 1.3],
            [5200, 31, 0.9],
            [3900, 24, 0.6]
          ]) {
            const oscillator = context.createOscillator();
            oscillator.frequency.value = frequency;
            const pulse = context.createGain();
            pulse.gain.value = 0.02;
            const chirping = context.createGain();
            chirping.gain.value = 0.5;
            oscillator.connect(pulse);
            pulse.connect(chirping);
            chirping.connect(gain);
            oscillator.start();
            nodes.push(oscillator);
            lfo(rate, 0.02, pulse.gain);
            lfo(gate, 0.5, chirping.gain);
          }
        }
        gain.gain.setTargetAtTime(levelValue, context.currentTime, 0.8);
        if (filterNode && toneValue !== 1) filterNode.frequency.value = baseFrequency * toneValue;
      },
      stop: () => {
        const context = this.context;
        if (context && gainNode) {
          gainNode.gain.setTargetAtTime(0, context.currentTime, 0.25);
          const ending = gainNode;
          for (const node of nodes) node.stop(context.currentTime + 1.5);
          window.setTimeout(() => ending.disconnect(), 1700);
        }
        this.beds.delete(entry);
      }
    };
    this.beds.add(entry);
    entry.start();

    return {
      level: (value, seconds = 0.6) => {
        levelValue = value;
        if (this.context && gainNode) gainNode.gain.setTargetAtTime(value, this.context.currentTime, seconds);
      },
      tone: (value, seconds = 0.6) => {
        toneValue = value;
        if (this.context && filterNode) filterNode.frequency.setTargetAtTime(baseFrequency * value, this.context.currentTime, seconds);
      },
      stop: entry.stop
    };
  }
}

export const sound = new SoundEngine();

// Whether sound can actually be heard right now. Browsers hold it back until the first press.
export function useSoundOn() {
  return useSyncExternalStore(
    sound.subscribe,
    () => sound.playing && !sound.muted,
    () => false
  );
}

// A bed that lasts as long as the component. Passing a new level glides to it.
export function useBed(kind: BedKind, level: number) {
  const bed = useRef<Bed | null>(null);
  useEffect(() => {
    const started = sound.bed(kind, level);
    bed.current = started;
    return () => started.stop();
    // The level is followed by the effect below, without restarting the sound.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  useEffect(() => {
    bed.current?.level(level);
  }, [level]);
  return bed;
}

// A day's background music, for as long as the component lasts.
export function useMusic(url: string, level: number) {
  useEffect(() => sound.music(url, level), [url, level]);
}

// Something that happens now and then, at random, such as a bird calling. The callback may change between renders.
export function useEvery(minSeconds: number, maxSeconds: number, action: () => void, enabled = true) {
  const latest = useRef(action);
  latest.current = action;
  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const next = () => {
      timer = window.setTimeout(
        () => {
          if (!document.hidden) latest.current();
          next();
        },
        (minSeconds + Math.random() * (maxSeconds - minSeconds)) * 1000
      );
    };
    next();
    return () => window.clearTimeout(timer);
  }, [minSeconds, maxSeconds, enabled]);
}
