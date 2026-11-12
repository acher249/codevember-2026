"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";

// The air every study moves in. The cursor stirs it: moving it, without pressing, leaves puffs behind it that push
// whatever is near them the way it went, fading in a moment. Blowing into the microphone, once allowed, sends a gust in
// from the camera. Under it all a faint drift keeps things from ever quite settling.
type Puff = { at: THREE.Vector3; push: THREE.Vector3; age: number };

export const air = {
  puffs: [] as Puff[],
  gust: 0,
  gustDir: new THREE.Vector3(0, 0, -1),
  // How hard the cursor is moving, smoothed, in metres a second.
  stir: 0,
  time: 0
};

const REACH = 0.14;
const LIFE = 1.4;

export function windAt(p: THREE.Vector3, out: THREE.Vector3) {
  const t = air.time;
  out.set(Math.sin(p.y * 1.7 + t * 0.6) * 0.035, Math.sin(p.x * 1.1 + p.z * 0.9 + t * 0.4) * 0.02, Math.cos(p.x * 1.3 + t * 0.5) * 0.035);
  for (const puff of air.puffs) {
    const d2 = p.distanceToSquared(puff.at);
    if (d2 > 9 * REACH * REACH) continue;
    out.addScaledVector(puff.push, Math.exp(-d2 / (2 * REACH * REACH)) * Math.exp(-puff.age * 2.4));
  }
  if (air.gust > 0.01) out.addScaledVector(air.gustDir, air.gust);
  return out;
}

// Follows the cursor across a sheet facing the camera through `through`, and turns its movement into puffs. With
// `microphone` on, listens for breath.
export function useBreeze(through: THREE.Vector3, microphone: boolean, strength = 1) {
  const last = useRef<{ at: THREE.Vector3; pointer: THREE.Vector2 } | null>(null);
  const work = useMemo(() => ({ plane: new THREE.Plane(), hit: new THREE.Vector3(), normal: new THREE.Vector3() }), []);
  const breath = useRef(0);

  useEffect(() => {
    air.puffs.length = 0;
    air.gust = 0;
  }, []);

  useEffect(() => {
    if (!microphone || typeof navigator === "undefined" || !navigator.mediaDevices) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;
    navigator.mediaDevices
      // Echo cancellation keeps the day's own sound out of it; noise suppression would take out the breath itself.
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } })
      .then((granted) => {
        if (stopped) {
          granted.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = granted;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(granted).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const listen = () => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
          breath.current = Math.sqrt(sum / samples.length);
          frame = requestAnimationFrame(listen);
        };
        listen();
      })
      .catch((error) => console.warn("No microphone:", error));
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      context?.close();
      breath.current = 0;
    };
  }, [microphone]);

  useFrame(({ camera, pointer, raycaster }, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    air.time += delta;
    for (const puff of air.puffs) puff.age += delta;
    while (air.puffs.length && air.puffs[0].age > LIFE) air.puffs.shift();

    camera.getWorldDirection(work.normal);
    work.plane.setFromNormalAndCoplanarPoint(work.normal, through);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.ray.intersectPlane(work.plane, work.hit);
    let speed = 0;
    if (hit) {
      const previous = last.current;
      if (previous && !previous.pointer.equals(pointer) && delta > 0) {
        const push = hit.clone().sub(previous.at).divideScalar(delta);
        speed = push.length();
        if (speed > 5) push.multiplyScalar(5 / speed);
        if (speed > 0.05) air.puffs.push({ at: hit.clone(), push: push.multiplyScalar(0.9 * strength), age: 0 });
        if (air.puffs.length > 80) air.puffs.shift();
      }
      last.current = { at: hit.clone(), pointer: pointer.clone() };
    }
    air.stir += (speed - air.stir) * Math.min(1, delta * 6);

    // A breath is loud and broad; talking is quieter. Only the part above a floor counts.
    const blow = Math.max(0, breath.current - 0.035) * 14;
    air.gust += (Math.min(blow, 2.6) * strength - air.gust) * Math.min(1, delta * (blow > air.gust ? 10 : 2.5));
    air.gustDir.copy(work.normal).setY(work.normal.y + 0.3).normalize();
  });
}
