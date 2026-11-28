import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, float, instancedArray, perspectiveDepthToViewZ, uniform, vec2 } from "three/tsl";
import { overlayLink } from "../../shared/engine/Post";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// How far off whatever is in the middle of the view stands, read from the finished frame's depth (Mirage's way): leaves,
// trunks, ferns and rock alike, which a ray against the rock alone passes through. Nine points round the middle, the
// median of them, so a single blade or leaf crossing it doesn't steal the focus. Read back a frame or two late, which
// the easing hides. `seen` is null until the first reading.
export function useFrameFocus() {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const probe = useMemo(() => ({ out: instancedArray(1, "float"), near: uniform(0.05), far: uniform(400), pass: null as any, seen: null as number | null, busy: false }), []);
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        probe.pass = Fn(() => {
          const taps = [-1, 0, 1].flatMap((y) =>
            [-1, 0, 1].map((x) => {
              const d = depth.sample(vec2(0.5 + x * 0.018, 0.5 + y * 0.03)).level(float(0)).r as any;
              return d.greaterThanEqual(0.99999).select(float(1000), (perspectiveDepthToViewZ(d, probe.near, probe.far) as any).negate()) as any;
            })
          );
          let median = float(0) as any;
          taps.forEach((d, i) => {
            const below = taps.reduce((n: any, e, j) => (j === i ? n : n.add((j < i ? e.lessThanEqual(d) : e.lessThan(d)).select(float(1), float(0)))), float(0)) as any;
            median = below.equal(4).select(d, median);
          });
          probe.out.element(0).assign(median);
        })().compute(1);
      }),
    [probe]
  );
  useFrame(() => {
    if (!probe.pass) return;
    probe.near.value = camera.near;
    probe.far.value = camera.far;
    gl.compute(probe.pass);
    if (probe.busy) return;
    probe.busy = true;
    (gl.getArrayBufferAsync(probe.out.value as any) as Promise<ArrayBuffer>)
      .then((buffer) => (probe.seen = new Float32Array(buffer)[0]))
      .catch(() => {})
      .finally(() => (probe.busy = false));
  });
  return probe;
}
