import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three/webgpu";
import { fract, sin } from "three/tsl";
import { orbitPoint } from "../shared/engine/controls";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model swizzles or every operator. */

export const hash = (x: any): any => fract(sin(x.mul(127.1).add(0.3)).mul(43758.5453));

// Each shape frames itself when it opens. The rig may not be up on the first frame, so this waits for it.
export function useView(position: [number, number, number], target: [number, number, number]) {
  const camera = useThree((state) => state.camera);
  const placed = useRef(false);
  useFrame(() => {
    if (placed.current || !orbitPoint.current) return;
    placed.current = true;
    // A tall screen sees less across, so it stands further back.
    const back = Math.max(1, 1.15 / (camera as THREE.PerspectiveCamera).aspect);
    camera.position.set(target[0] + (position[0] - target[0]) * back, target[1] + (position[1] - target[1]) * back, target[2] + (position[2] - target[2]) * back);
    orbitPoint.current.set(...target);
  });
}

